import path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import type { SandboxAttestation, SandboxKind, SandboxPlan } from '@mac/protocol';

/**
 * The execution sandbox (Sprint 3 §3).
 *
 * Sprint 2 set `cwd` to the worktree and inspected the damage afterwards. Its
 * own risk register said so: R-4, "not fully preventable without OS sandboxing;
 * noted for Sprint 3". This is that.
 *
 * ---------------------------------------------------------------------------
 * THE TRUSTED / UNTRUSTED LINE
 *
 * Inside the sandbox: the coding agent, and the project's own test and build
 * command. The second is the non-obvious one and arguably the more important —
 * `npm test` executes code the agent just wrote, so sandboxing the agent but
 * not its test run would leave the widest hole open while claiming it closed.
 *
 * Outside: Mac's own git (a closed, policy-checked API), evidence collection,
 * and everything that touches the control-plane credential. Those execute Mac's
 * intent, not the agent's, and the credential must never be inside the boundary
 * with something that runs agent-authored code.
 * ---------------------------------------------------------------------------
 */

/** Drop-in for `node:child_process.spawn`, so callers need no restructuring. */
export type Spawner = (executable: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export const nodeSpawner: Spawner = (executable, args, options) => spawn(executable, [...args], options);

export interface SandboxSession {
  readonly kind: SandboxKind;
  /** Translates a host path into the path the sandboxed process will see. */
  pathFor(hostPath: string): string;
  /** Spawns inside the sandbox. Signals, pipes and exit codes behave normally. */
  readonly spawner: Spawner;
  close(): Promise<void>;
}

export interface ExecutionSandbox {
  readonly kind: SandboxKind;
  probe(): Promise<{ available: boolean; reason?: string; version?: string }>;
  open(plan: SandboxPlan): Promise<SandboxSession>;
}

/**
 * Thrown when no usable sandbox exists.
 *
 * The coding job catches this and FAILS the run rather than falling back to
 * unconfined execution. There is deliberately no code path that degrades
 * gracefully here: a sandbox that silently turns itself off is worse than one
 * that was never claimed.
 */
export class SandboxUnavailable extends Error {
  override readonly name = 'SandboxUnavailable';
  constructor(
    readonly kind: SandboxKind,
    message: string,
  ) {
    super(message);
  }
}

/** Maps host paths onto sandbox paths using a plan's mount table. */
export function makePathMapper(plan: SandboxPlan): (hostPath: string) => string {
  // Longest host path first, so a nested mount wins over its parent.
  const ordered = [...plan.mounts].sort((a, b) => b.hostPath.length - a.hostPath.length);

  return (hostPath: string): string => {
    const resolved = path.resolve(hostPath);
    for (const mount of ordered) {
      if (resolved === mount.hostPath) return mount.sandboxPath;
      const rel = path.relative(mount.hostPath, resolved);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        return `${mount.sandboxPath}/${rel.split(path.sep).join('/')}`;
      }
    }
    // Unmapped means unreachable. Returning the host path unchanged would
    // produce a path the sandboxed process cannot open, which is the correct
    // and visible failure rather than a silent escape.
    return resolved;
  };
}

export { BubblewrapSandbox } from './bubblewrap.js';
export { DockerSandbox } from './docker.js';
export { buildSandboxPlan, SandboxPlanError, CONTAINER_PATHS, looksLikeCredentialStore } from './plan.js';
export type { SandboxPlanInput } from './plan.js';
export { resolveSandbox, attestSandbox } from './resolve.js';
export type { SandboxResolution } from './resolve.js';
export type { SandboxAttestation };
