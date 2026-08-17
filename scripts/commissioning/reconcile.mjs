#!/usr/bin/env node
/**
 * Commissioning reconciliation (Sprint 3.1 §13).
 *
 * Mac's audit trail is only worth having if it agrees with the systems it
 * claims to describe. This walks one night shift and lines up five independent
 * records side by side:
 *
 *   1. Mac's own audit events        the control-plane database
 *   2. monday.com activity           the board's own activity log, over the API
 *   3. git history                   branches and commits in the repository
 *   4. pull requests                 GitHub, via `gh`
 *   5. email deliveries              the delivery table and its provider state
 *
 * It deliberately does NOT require timestamps to match across providers. Clocks
 * differ, monday's activity log is eventually consistent, and Graph answers 202
 * without a message id. What it requires is that the CAUSAL SEQUENCE is
 * reconcilable: Mac cannot claim to have set a status the board never held, or
 * to have opened a pull request GitHub has never heard of.
 *
 * Usage:
 *   node scripts/commissioning/reconcile.mjs --night <night-shift-id> \
 *        [--board <monday-board-id>] [--repo <owner/name>] [--clone <path>]
 *
 * With no --night it reconciles the most recent shift.
 *
 * Reads DATABASE_URL (or TEST_DATABASE_URL with --test-db) and MONDAY_API_TOKEN
 * from the repository-root .env.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { config as loadDotenv } from 'dotenv';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
loadDotenv({ path: path.join(repoRoot, '.env') });

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const NIGHT_ID = arg('night');
const BOARD_ID = arg('board', process.env.MAC_MONDAY_TEST_BOARD_ID ?? null);
const REPO = arg('repo');
const CLONE = arg('clone');
const CONNECTION = flag('test-db') ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;

if (!CONNECTION) {
  console.error('No DATABASE_URL (or TEST_DATABASE_URL with --test-db) in the environment.');
  process.exit(2);
}

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const head = (s) => `\n\x1b[1m${s}\x1b[0m\n${'─'.repeat(s.length)}`;

/** Problems worth a human's attention. Printed together at the end. */
const discrepancies = [];
const note = (message) => discrepancies.push(message);

// ---------------------------------------------------------------------------
// 1. Mac's own record
// ---------------------------------------------------------------------------

const client = new pg.Client({ connectionString: CONNECTION });
await client.connect();

const shiftRow = NIGHT_ID
  ? await client.query('select * from night_shifts where id = $1', [NIGHT_ID])
  : await client.query('select * from night_shifts order by started_at desc limit 1');

if (shiftRow.rowCount === 0) {
  console.error(NIGHT_ID ? `No night shift ${NIGHT_ID}.` : 'No night shifts have ever run.');
  await client.end();
  process.exit(1);
}

const shift = shiftRow.rows[0];

console.log(head('Night shift'));
console.log(`  id          ${shift.id}`);
console.log(`  status      ${shift.status}`);
console.log(`  started     ${shift.started_at?.toISOString?.() ?? shift.started_at}`);
console.log(`  ended       ${shift.ended_at?.toISOString?.() ?? shift.ended_at ?? dim('(still running)')}`);
console.log(`  cutoff      ${shift.cutoff_at?.toISOString?.() ?? shift.cutoff_at}`);

const runRows = await client.query(
  `select r.id, r.status, r.monday_item_id, r.selected_by, r.created_at, t.title
     from runs r left join tasks t on t.id = r.task_id
    where r.night_shift_id = $1
    order by r.created_at`,
  [shift.id],
);

console.log(head(`Runs (${runRows.rowCount})`));
for (const run of runRows.rows) {
  console.log(`  ${run.status.padEnd(12)} item ${String(run.monday_item_id ?? '—').padEnd(12)} ${run.title ?? ''}`);
  if (run.selected_by !== 'night_shift') {
    note(`Run ${run.id} was not selected by the night shift (selected_by=${run.selected_by}).`);
  }
}

const eventRows = await client.query(
  `select seq, event_type, metadata, created_at
     from audit_events
    where created_at >= $1
    order by seq`,
  [shift.started_at],
);

console.log(head(`Mac's audit events since the shift began (${eventRows.rowCount})`));
const counts = new Map();
for (const event of eventRows.rows) counts.set(event.event_type, (counts.get(event.event_type) ?? 0) + 1);
for (const [type, count] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${type}`);
}

// A machine approval must never be recorded as a human one.
if (counts.has('run.approved')) {
  note("A `run.approved` event exists during a night shift. Autonomous approvals must be `run.auto_approved`.");
}

// ---------------------------------------------------------------------------
// 2. What Mac says he told monday, and what monday says happened
// ---------------------------------------------------------------------------

const mondayWrites = await client.query(
  `select kind, status, attempts, last_error, payload, created_at
     from monday_writes
    where created_at >= $1
    order by created_at`,
  [shift.started_at],
);

console.log(head(`monday writes Mac queued (${mondayWrites.rowCount})`));
const byStatus = new Map();
for (const write of mondayWrites.rows) byStatus.set(write.status, (byStatus.get(write.status) ?? 0) + 1);
for (const [status, count] of byStatus) console.log(`  ${String(count).padStart(4)}  ${status}`);
for (const write of mondayWrites.rows.filter((w) => w.status === 'dead' || w.status === 'refused')) {
  note(`A monday write was ${write.status}: ${write.kind} — ${write.last_error ?? 'no reason recorded'}`);
}

if (BOARD_ID && process.env.MONDAY_API_TOKEN) {
  const from = new Date(shift.started_at).toISOString();
  const response = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: process.env.MONDAY_API_TOKEN,
      'API-Version': '2024-10',
    },
    body: JSON.stringify({
      query: `query ($ids: [ID!], $from: ISO8601DateTime!) {
                boards (ids: $ids) {
                  activity_logs (from: $from, limit: 200) { id event created_at user_id }
                }
              }`,
      variables: { ids: [BOARD_ID], from },
    }),
  });
  const parsed = await response.json();
  const logs = parsed?.data?.boards?.[0]?.activity_logs ?? [];

  console.log(head(`monday's OWN activity log since the shift began (${logs.length})`));
  const events = new Map();
  for (const entry of logs) events.set(entry.event, (events.get(entry.event) ?? 0) + 1);
  for (const [event, count] of [...events].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${event}`);
  }

  /*
   * The reconciliation that matters, and it is deliberately one-directional.
   *
   * Every write Mac says he DELIVERED must have left a trace on the board.
   * The reverse is not required: a human may well have touched the board during
   * the night, and Mac claiming fewer changes than monday recorded is not a
   * discrepancy — it is a colleague.
   */
  const delivered = mondayWrites.rows.filter((w) => w.status === 'sent').length;
  if (delivered > 0 && logs.length === 0) {
    note(
      `Mac recorded ${delivered} delivered monday write(s), but the board's activity log shows nothing ` +
        'since the shift began. Either the writes went to a different board or the log is lagging.',
    );
  } else {
    console.log(`\n  ${ok('✓')} ${delivered} delivered write(s); the board's own log is non-empty.`);
  }
} else {
  console.log(head('monday activity log'));
  console.log(dim('  Skipped: pass --board and set MONDAY_API_TOKEN to reconcile against monday itself.'));
}

// ---------------------------------------------------------------------------
// 3. Git, and 4. pull requests
// ---------------------------------------------------------------------------

const prRows = await client.query(
  `select p.number, p.url, p.branch, p.base_branch, p.created_at
     from pull_requests p join runs r on r.id = p.run_id
    where r.night_shift_id = $1
    order by p.created_at`,
  [shift.id],
);

console.log(head(`Pull requests Mac recorded (${prRows.rowCount})`));
for (const pr of prRows.rows) {
  console.log(`  #${pr.number}  ${pr.branch} → ${pr.base_branch}  ${pr.url}`);
}

if (CLONE) {
  const git = async (args) => {
    try {
      const { stdout } = await exec('git', args, { cwd: CLONE, windowsHide: true });
      return stdout.trim();
    } catch (err) {
      return `ERROR: ${err.message}`;
    }
  };

  await git(['fetch', 'origin', '--prune']);
  const defaultBranch = await git(['rev-parse', 'origin/main']);
  const mainCount = await git(['rev-list', '--count', 'origin/main']);
  const branches = (await git(['branch', '-r', '--format=%(refname:short)']))
    .split('\n')
    .map((b) => b.trim())
    .filter((b) => b && !b.startsWith('origin/HEAD'));

  console.log(head('Git'));
  console.log(`  origin/main   ${defaultBranch}  (${mainCount} commit(s))`);
  console.log(`  branches      ${branches.length}`);
  for (const branch of branches) {
    const mine = branch.startsWith('origin/mac/');
    console.log(`    ${mine ? ok('mac') : dim(' — ')}  ${branch}`);
    if (!mine && branch !== 'origin/main') {
      note(`Branch ${branch} is neither the default branch nor in Mac's namespace.`);
    }
  }

  // Every pull request Mac recorded must correspond to a branch that exists.
  for (const pr of prRows.rows) {
    if (!branches.includes(`origin/${pr.branch}`)) {
      note(`Mac recorded pull request #${pr.number} on branch "${pr.branch}", which is not on the remote.`);
    }
  }

  // The hard V1 rule.
  const mainMoved = mainCount !== '1' && !flag('main-may-move');
  console.log(
    `\n  ${mainMoved ? bad('?') : ok('✓')} default branch: ${mainCount} commit(s)` +
      (mainMoved ? '  — expected 1 for a freshly seeded commissioning repository' : ''),
  );
  if (mainMoved) {
    note(
      `origin/main has ${mainCount} commits. If the fixture was seeded with one, something merged during ` +
        'the night, which is the one thing Mac must never do.',
    );
  }
} else {
  console.log(head('Git'));
  console.log(dim('  Skipped: pass --clone <path to a clone> to reconcile against the repository.'));
}

if (REPO) {
  try {
    const { stdout } = await exec(
      'gh',
      ['pr', 'list', '--repo', REPO, '--state', 'all', '--json', 'number,title,headRefName,baseRefName,state,mergedAt'],
      { windowsHide: true },
    );
    const prs = JSON.parse(stdout);
    console.log(head(`Pull requests GitHub actually has (${prs.length})`));
    for (const pr of prs) {
      console.log(`  #${pr.number}  ${pr.state.padEnd(6)}  ${pr.headRefName} → ${pr.baseRefName}  ${pr.title}`);
      if (pr.mergedAt) {
        note(`Pull request #${pr.number} has been MERGED. Mac must never merge; confirm a human did this.`);
      }
    }

    const recorded = new Set(prRows.rows.map((p) => Number(p.number)));
    for (const pr of prs.filter((p) => !recorded.has(p.number))) {
      note(`GitHub has pull request #${pr.number} that Mac's audit trail does not record.`);
    }
    for (const number of recorded) {
      if (!prs.some((p) => p.number === number)) {
        note(`Mac recorded pull request #${number}, and GitHub has never heard of it.`);
      }
    }
    if (prs.length === recorded.size && prs.length > 0) {
      console.log(`\n  ${ok('✓')} every pull request reconciles in both directions.`);
    }
  } catch (err) {
    console.log(head('GitHub'));
    console.log(dim(`  Could not reach gh: ${err.message}`));
  }
} else {
  console.log(head('GitHub'));
  console.log(dim('  Skipped: pass --repo <owner/name> to reconcile against GitHub.'));
}

// ---------------------------------------------------------------------------
// 5. The morning email
// ---------------------------------------------------------------------------

const emails = await client.query(
  `select id, kind, status, attempts, recipients, subject, provider, provider_message_id, sent_at, last_error,
          idempotency_key
     from email_deliveries
    where night_shift_id = $1`,
  [shift.id],
);

console.log(head(`Email deliveries for this shift (${emails.rowCount})`));
for (const email of emails.rows) {
  console.log(`  ${email.status.padEnd(8)} ${email.attempts} attempt(s)  → ${(email.recipients ?? []).join(', ')}`);
  console.log(`           ${email.subject}`);
  console.log(
    dim(
      `           provider=${email.provider} id=${email.provider_message_id ?? 'null (Graph returns none)'} ` +
        `key=${email.idempotency_key}`,
    ),
  );
  if (email.last_error) console.log(dim(`           last error: ${email.last_error}`));
}

if (emails.rowCount === 0) {
  note('The night shift produced NO morning report.');
} else if (emails.rowCount > 1) {
  note(`The night shift produced ${emails.rowCount} morning reports. Exactly one is the requirement.`);
} else {
  console.log(`\n  ${ok('✓')} exactly one morning report.`);
}

// ---------------------------------------------------------------------------

await client.end();

console.log(head('Reconciliation'));
if (discrepancies.length === 0) {
  console.log(`  ${ok('✓ Nothing to explain.')} Mac's record agrees with every external system checked.\n`);
  process.exit(0);
}

console.log(`  ${bad(`${discrepancies.length} thing(s) a human should look at:`)}\n`);
for (const [index, message] of discrepancies.entries()) console.log(`  ${index + 1}. ${message}`);
console.log('');
// A discrepancy is a finding, not a crash: exit 1 so a pipeline notices, and
// print everything above regardless so the finding can be understood.
process.exit(1);
