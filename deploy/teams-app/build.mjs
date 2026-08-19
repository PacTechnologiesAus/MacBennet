import { crc32 } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds the Teams app package Mac is installed from.
 *
 *   node deploy/teams-app/build.mjs <bot-app-id> [teams-app-id]
 *
 * ---------------------------------------------------------------------------
 * WHY THE PACKAGE IS BUILT AND NOT COMMITTED
 *
 * The manifest's `botId` is the Azure Bot's application id, which does not
 * exist until a person creates the Azure Bot resource in the PAC tenant. A
 * committed zip would either contain a placeholder that silently installs a
 * broken app, or a real id that nobody can review inside a binary.
 *
 * So the template is committed, the id is an argument, and the package is a
 * build artefact. The app id is NOT a secret — it is the public identity of the
 * bot, quoted in every activity Teams sends — so passing it on the command line
 * is fine, unlike the client secret, which this script never touches.
 *
 * `teams-app-id` defaults to the bot app id. They are allowed to be the same
 * value and are different things: one identifies the Teams application, the
 * other identifies the bot inside it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ZIP IS WRITTEN BY HAND
 *
 * Node ships no zip writer and this repository adds no dependency it does not
 * need. A three-entry archive stored without compression is a local file header
 * per entry, a central directory and an end-of-central-directory record — and
 * `zlib.crc32` supplies the only checksum involved.
 * ---------------------------------------------------------------------------
 */

const here = dirname(fileURLToPath(import.meta.url));

const [botAppId, teamsAppIdArg] = process.argv.slice(2);

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!botAppId || !GUID.test(botAppId)) {
  console.error('Usage: node deploy/teams-app/build.mjs <bot-app-id> [teams-app-id]');
  console.error('       Both are GUIDs. The bot app id is the Azure Bot resource\'s application (client) id.');
  process.exit(1);
}
const teamsAppId = teamsAppIdArg ?? botAppId;
if (!GUID.test(teamsAppId)) {
  console.error(`"${teamsAppId}" is not a GUID.`);
  process.exit(1);
}

const manifest = readFileSync(join(here, 'manifest.template.json'), 'utf8')
  .replace('__BOT_APP_ID__', botAppId)
  .replace('__TEAMS_APP_ID__', teamsAppId);

// Parse it before shipping it: an unreadable manifest fails at upload time with
// a message that does not say which character was wrong.
JSON.parse(manifest);

const entries = [
  { name: 'manifest.json', data: Buffer.from(manifest, 'utf8') },
  { name: 'color.png', data: readFileSync(join(here, 'color.png')) },
  { name: 'outline.png', data: readFileSync(join(here, 'outline.png')) },
];

/*
 * A fixed DOS timestamp — 1 January 1980, the epoch of the zip format itself.
 *
 * The alternative is the clock, which would make two builds of identical inputs
 * produce different bytes and make "is the installed package the reviewed one?"
 * unanswerable by comparing hashes.
 */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const local = [];
const central = [];
let offset = 0;

for (const entry of entries) {
  const name = Buffer.from(entry.name, 'ascii');
  const crc = crc32(entry.data) >>> 0;

  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); // local file header signature
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0, 6); // flags
  header.writeUInt16LE(0, 8); // method: stored
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(entry.data.length, 18); // compressed size
  header.writeUInt32LE(entry.data.length, 22); // uncompressed size
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28); // extra length

  local.push(header, name, entry.data);

  const record = Buffer.alloc(46);
  record.writeUInt32LE(0x02014b50, 0); // central directory signature
  record.writeUInt16LE(20, 4); // version made by
  record.writeUInt16LE(20, 6); // version needed
  record.writeUInt16LE(0, 8);
  record.writeUInt16LE(0, 10);
  record.writeUInt16LE(DOS_TIME, 12);
  record.writeUInt16LE(DOS_DATE, 14);
  record.writeUInt32LE(crc, 16);
  record.writeUInt32LE(entry.data.length, 20);
  record.writeUInt32LE(entry.data.length, 24);
  record.writeUInt16LE(name.length, 28);
  record.writeUInt16LE(0, 30); // extra
  record.writeUInt16LE(0, 32); // comment
  record.writeUInt16LE(0, 34); // disk number
  record.writeUInt16LE(0, 36); // internal attributes
  record.writeUInt32LE(0, 38); // external attributes
  record.writeUInt32LE(offset, 42);

  central.push(record, name);
  offset += header.length + name.length + entry.data.length;
}

const centralBuffer = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralBuffer.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20); // comment length

const zip = Buffer.concat([...local, centralBuffer, end]);
const out = join(here, 'mac-bennett-teams.zip');
writeFileSync(out, zip);

console.log(`Wrote ${out} (${zip.length} bytes)`);
console.log(`  bot app id   ${botAppId}`);
console.log(`  teams app id ${teamsAppId}`);
