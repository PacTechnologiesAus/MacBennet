import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { JobKind, JobSpec, RunAssignment } from '@mac/protocol';
import type { ControlPlaneClient } from '../client.js';

/**
 * The job handlers.
 *
 * Read this file as a security boundary, not just a feature list.
 *
 * The Sprint 1 handlers below spawn nothing at all: no `child_process`, no
 * `exec`, no `eval`, no dynamic `import()`, and no filesystem write outside the
 * configured workspace.
 *
 * Sprint 2 adds two handlers that DO execute processes — `claude_code` and
 * `repo_inspect` — and they are the reason to read the parameter schemas in
 * `@mac/protocol/jobs.ts` carefully. Neither takes a command, a script, a path
 * or an argument list. They take identifiers, which the control plane resolves
 * against its own database into a repository and a brief. The commands actually
 * run are fixed by worker code (git, the coding agent) or by admin-configured
 * argv on the repository row (the project's own test command).
 *
 * So the protocol still has no field in which a shell command could be
 * expressed, and adding a coding agent did not turn the worker into a remote
 * shell.
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
  /**
   * The full assignment and a control-plane client, supplied only for the
   * repository job kinds. The Sprint 1 handlers neither receive nor need them,
   * which keeps their "no I/O beyond the workspace" property intact.
   */
  assignment?: RunAssignment;
  client?: ControlPlaneClient;
  /** Test seams for the coding job: a mock agent, a recording PR gateway. */
  codingOverrides?: Record<string, unknown>;
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

  /**
   * Sprint 2's coding job. Imported lazily so the Sprint 1 handlers — and the
   * tests that cover them — never pull in git, process spawning or the coding
   * adapters at all.
   */
  async claude_code(_params, ctx) {
    const { assignment, client } = requireRepositoryContext(ctx, 'claude_code');
    const { runCodingJob } = await import('./claude-code.js');
    return runCodingJob(assignment, ctx, {
      client,
      ...(ctx.codingOverrides as Record<string, never> | undefined),
    });
  },

  async repo_inspect(_params, ctx) {
    const { assignment, client } = requireRepositoryContext(ctx, 'repo_inspect');
    const { runRepoInspectJob } = await import('./repo-inspect.js');
    return runRepoInspectJob(assignment, ctx, { client });
  },
};

/**
 * The repository jobs cannot run without the resolved assignment the control
 * plane builds at lease time. Failing loudly here beats improvising a
 * repository path from somewhere less trustworthy.
 */
function requireRepositoryContext(
  ctx: JobContext,
  kind: string,
): { assignment: RunAssignment; client: ControlPlaneClient } {
  if (!ctx.assignment || !ctx.client) {
    throw new Error(`The "${kind}" job requires a run assignment and a control-plane client.`);
  }
  if (!ctx.assignment.coding) {
    throw new Error(`The "${kind}" job requires an approved repository, and none was resolved for this run.`);
  }
  return { assignment: ctx.assignment, client: ctx.client };
}

export function getHandler(kind: string): JobHandler | null {
  return Object.prototype.hasOwnProperty.call(handlers, kind) ? handlers[kind as JobKind] : null;
}

export const SUPPORTED_JOB_KINDS = Object.keys(handlers) as JobKind[];

export type { JobSpec };
