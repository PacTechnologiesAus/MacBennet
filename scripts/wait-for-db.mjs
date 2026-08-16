// Blocks until the development database accepts connections, so that
// `npm run setup` can chain `db:up` straight into `migrate` without a
// hand-timed sleep.
import net from 'node:net';

const url = new URL(process.env.DATABASE_URL ?? 'postgres://mac:mac_dev_password@localhost:5433/mac_bennett');
const host = url.hostname;
const port = Number(url.port || 5432);
const deadline = Date.now() + 60_000;

const probe = () =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  });

process.stdout.write(`Waiting for database at ${host}:${port} `);
while (Date.now() < deadline) {
  if (await probe()) {
    process.stdout.write(' ready\n');
    process.exit(0);
  }
  process.stdout.write('.');
  await new Promise((r) => setTimeout(r, 1000));
}
process.stdout.write('\n');
console.error(`Database at ${host}:${port} did not become ready within 60s. Is \`npm run db:up\` running?`);
process.exit(1);
