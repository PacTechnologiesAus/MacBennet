import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { JobKind, JobSpec } from '@mac/protocol';

/**
 * The Sprint 1 job handlers.
 *
 * Read this file as a security boundary, not just a feature list. There is no
 * `child_process` import, no `exec`, no `eval`, no dynamic `import()`, and no
 * filesystem write outside the configured workspace. The protocol has no field
 * in which a command could be expressed, so there is nothing here to smuggle
 * one into.
 *
 * Every handler receives an AbortSignal and is expected to honour it promptly —
 * that is what makes remote cancellation real rather than advisory.
 */

export interface JobContext {
  /** Writes a line to the run log, which the operator sees in the UI. */
  log: (message: string, stream?: 'stdout' | 'stderr' | 'system') => void;
  /** Reports a named stage and optional percentage to the control plane. */
  progress: (stage: string, percent?: number) => Promise<void>;
  /** Aborted when the control plane requests a stop. */
  signal: AbortSignal;
  /** The worker's persistent workspace root. */
  workspace: string;
}

export interface JobResult {
  summary: string;
}

export class JobCancelledError extends Error {
  constructor() {
    super('Job cancelled.');
    this.name = 'JobCancelledError';
  }
}

export type JobHandler = (params: Record<string, unknown>, ctx: JobContext) => Promise<JobResult>;

/** Cancellable sleep: rejects promptly on abort rather than running to term. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new JobCancelledError());
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new JobCancelledError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const handlers: Record<JobKind, JobHandler> = {
  async noop(_params, ctx) {
    ctx.log('noop: nothing to do.');
    await ctx.progress('complete', 100);
    return { summary: 'No-op completed.' };
  },

  async echo(params, ctx) {
    const message = String(params.message ?? '');
    ctx.log(`echo: ${message}`);
    await ctx.progress('complete', 100);
    return { summary: `Echoed ${message.length} character(s).` };
  },

  /**
   * Sleeps in short slices so cancellation is observed within ~250ms rather
   * than at the end of the requested duration. This job exists specifically so
   * that dispatch, progress and cancellation of in-flight work can be
   * exercised for real.
   */
  async sleep(params, ctx) {
    const seconds = Number(params.seconds ?? 1);
    const sliceMs = 250;
    const slices = Math.ceil((seconds * 1000) / sliceMs);

    ctx.log(`sleep: sleeping for ${seconds}s.`);
    await ctx.progress('sleeping', 0);

    let lastReported = -1;
    for (let i = 0; i < slices; i += 1) {
      await delay(sliceMs, ctx.signal);
      const percent = Math.min(99, Math.floor(((i + 1) / slices) * 100));
      // Report at most once per 10%, so a long sleep does not spam the server.
      if (percent - lastReported >= 10) {
        lastReported = percent;
        await ctx.progress('sleeping', percent);
        ctx.log(`sleep: ${percent}% elapsed.`);
      }
    }

    await ctx.progress('complete', 100);
    return { summary: `Slept for ${seconds}s.` };
  },

  async system_info(_params, ctx) {
    // Deliberately non-sensitive: no hostname, no network interfaces, no
    // environment variables, no user information.
    const info = {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      cpus: os.cpus().length,
      totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
      freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
      nodeVersion: process.version,
      uptimeSeconds: Math.round(os.uptime()),
    };

    for (const [key, value] of Object.entries(info)) ctx.log(`${key}: ${value}`);
    await ctx.progress('complete', 100);
    return { summary: `${info.platform}/${info.arch}, ${info.cpus} CPU(s), Node ${info.nodeVersion}.` };
  },

  /**
   * Verifies the workspace root exists and is writable.
   *
   * The probe file is written inside the configured workspace and removed
   * immediately; no path from the job parameters is involved, so there is no
   * traversal surface.
   */
  async workspace_check(_params, ctx) {
    const root = path.resolve(ctx.workspace);
    ctx.log(`workspace: ${root}`);

    await ctx.progress('checking', 25);
    await fs.mkdir(root, { recursive: true });

    const stats = await fs.stat(root);
    if (!stats.isDirectory()) throw new Error(`${root} exists but is not a directory.`);
    ctx.log('workspace: directory present.');

    await ctx.progress('checking', 60);
    const probe = path.join(root, `.mac-write-probe-${process.pid}`);
    await fs.writeFile(probe, 'ok', { encoding: 'utf8' });
    await fs.rm(probe, { force: true });
    ctx.log('workspace: writable.');

    await ctx.progress('complete', 100);
    return { summary: `Workspace ${root} exists and is writable.` };
  },

  async fail(params, ctx) {
    const message = String(params.message ?? 'Deliberate failure for testing the failure path.');
    ctx.log(`fail: ${message}`, 'stderr');
    throw new Error(message);
  },
};

export function getHandler(kind: string): JobHandler | null {
  return Object.prototype.hasOwnProperty.call(handlers, kind) ? handlers[kind as JobKind] : null;
}

export const SUPPORTED_JOB_KINDS = Object.keys(handlers) as JobKind[];

export type { JobSpec };
