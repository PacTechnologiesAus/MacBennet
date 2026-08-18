import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JOB_KINDS } from '@mac/protocol';
import { getHandler, JobCancelledError, SUPPORTED_JOB_KINDS, type JobContext } from '../src/jobs/index.js';

function makeContext(overrides: Partial<JobContext> = {}): JobContext & { lines: string[] } {
  const lines: string[] = [];
  const controller = new AbortController();
  return {
    lines,
    log: (message: string) => void lines.push(message),
    progress: vi.fn().mockResolvedValue(undefined),
    signal: controller.signal,
    workspace: path.join(os.tmpdir(), `mac-jobs-${Math.random().toString(36).slice(2)}`),
    ...overrides,
  } as JobContext & { lines: string[] };
}

describe('job allowlist', () => {
  it('implements exactly the catalogue the protocol declares — no more, no less', () => {
    // If these ever diverge, either the control plane offers a job no worker
    // can run, or a worker can run something the control plane never vetted.
    expect([...SUPPORTED_JOB_KINDS].sort()).toEqual([...JOB_KINDS].sort());
  });

  it('has no handler for anything resembling command execution', () => {
    for (const kind of ['shell', 'exec', 'bash', 'sh', 'run', 'command', 'eval', 'spawn', 'deploy']) {
      expect(getHandler(kind), kind).toBeNull();
    }
  });

  it('is not fooled by prototype-chain lookups', () => {
    expect(getHandler('toString')).toBeNull();
    expect(getHandler('constructor')).toBeNull();
    expect(getHandler('__proto__')).toBeNull();
  });
});

describe('noop and echo', () => {
  it('completes a noop', async () => {
    const ctx = makeContext();
    const result = await getHandler('noop')!({}, ctx);
    expect(result.summary).toContain('No-op');
    expect(ctx.progress).toHaveBeenCalledWith('complete', 100);
  });

  it('writes the echoed message to the run log', async () => {
    const ctx = makeContext();
    const result = await getHandler('echo')!({ message: 'hello engineer' }, ctx);
    expect(ctx.lines.some((l) => l.includes('hello engineer'))).toBe(true);
    expect(result.summary).toContain('14');
  });
});

describe('sleep', () => {
  it('reports progress as it goes', async () => {
    const ctx = makeContext();
    await getHandler('sleep')!({ seconds: 1 }, ctx);

    const calls = (ctx.progress as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]).toEqual(['sleeping', 0]);
    expect(calls[calls.length - 1]).toEqual(['complete', 100]);
    expect(calls.length).toBeGreaterThan(2);
  });

  it('aborts promptly rather than running to term', async () => {
    const controller = new AbortController();
    const ctx = makeContext({ signal: controller.signal });

    const started = Date.now();
    const promise = getHandler('sleep')!({ seconds: 60 }, ctx);
    setTimeout(() => controller.abort(), 300);

    await expect(promise).rejects.toBeInstanceOf(JobCancelledError);
    // A 60-second job that stopped in under two seconds is the whole point:
    // remote cancellation has to be real, not advisory.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses to start if already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = makeContext({ signal: controller.signal });

    await expect(getHandler('sleep')!({ seconds: 5 }, ctx)).rejects.toBeInstanceOf(JobCancelledError);
  });
});

describe('system_info', () => {
  it('reports platform facts', async () => {
    const ctx = makeContext();
    const result = await getHandler('system_info')!({}, ctx);
    expect(result.summary).toContain(os.platform());
    expect(ctx.lines.some((l) => l.startsWith('nodeVersion:'))).toBe(true);
  });

  it('discloses nothing sensitive about the host', async () => {
    const ctx = makeContext();
    await getHandler('system_info')!({}, ctx);
    const output = ctx.lines.join('\n').toLowerCase();

    // This job runs on a VM that will hold repository credentials. It reports
    // capability, not identity.
    expect(output).not.toContain(os.hostname().toLowerCase());
    expect(output).not.toContain('token');
    expect(output).not.toContain('password');
    expect(output).not.toContain(os.homedir().toLowerCase());
  });
});

describe('workspace_check', () => {
  it('creates the workspace, verifies it is writable, and leaves no probe behind', async () => {
    const workspace = path.join(os.tmpdir(), `mac-ws-${Math.random().toString(36).slice(2)}`);
    const ctx = makeContext({ workspace });

    try {
      const result = await getHandler('workspace_check')!({}, ctx);
      expect(result.summary).toContain('writable');

      const stats = await fs.stat(workspace);
      expect(stats.isDirectory()).toBe(true);

      const remaining = await fs.readdir(workspace);
      expect(remaining.filter((f) => f.includes('write-probe'))).toEqual([]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it('ignores any path supplied in the job parameters', async () => {
    const workspace = path.join(os.tmpdir(), `mac-ws-${Math.random().toString(36).slice(2)}`);
    const ctx = makeContext({ workspace });

    try {
      // There is no path parameter in the schema, but prove that passing one
      // has no effect on where the job writes.
      await getHandler('workspace_check')!({ path: '/etc', workspace: '/root' }, ctx);
      expect(ctx.lines.some((l) => l.includes(path.resolve(workspace)))).toBe(true);
      expect(ctx.lines.some((l) => l.includes('/etc') || l.includes('/root'))).toBe(false);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

describe('fail', () => {
  it('throws with the supplied message so the failure path is exercisable', async () => {
    const ctx = makeContext();
    await expect(getHandler('fail')!({ message: 'boom' }, ctx)).rejects.toThrow('boom');
  });

  it('throws a default message when none is supplied', async () => {
    const ctx = makeContext();
    await expect(getHandler('fail')!({}, ctx)).rejects.toThrow(/Deliberate failure/);
  });
});
