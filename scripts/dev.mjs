// Runs the control plane and the web UI together for local development.
// The worker is started separately (`npm run dev:worker`) because it is meant
// to live on its own VM — keeping it a separate command keeps that boundary
// obvious rather than making it feel like part of the monolith.
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const targets = [
  { name: 'server', colour: '\x1b[36m', args: ['run', 'dev', '-w', '@mac/server'] },
  { name: 'web   ', colour: '\x1b[35m', args: ['run', 'dev', '-w', '@mac/web'] },
];

const children = targets.map(({ name, colour, args }) => {
  const child = spawn(npm, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const prefix = `${colour}[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  return child;
});

const shutdown = () => { for (const c of children) c.kill(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
