import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SandboxPlan } from '@mac/protocol';
import { makePathMapper, nodeSpawner, type ExecutionSandbox, type SandboxSession, type Spawner } from './index.js';

const execFileAsync = promisify(execFile);

/**
 * Bubblewrap (Sprint 3 §3.2) — the production provider.
 *
 * Chosen for the Linux VM over a container runtime for four reasons that all
 * matter at 02:00:
 *
 *   * **No daemon.** Nothing to be running, nothing to talk to, no socket whose
 *     access is itself a privilege escalation.
 *   * **Identity paths.** The path inside the sandbox IS the path outside it, so
 *     nothing has to be rewritten and a stack trace from inside names a file a
 *     human can open.
 *   * **~10ms.** A sandbox nobody notices is a sandbox nobody disables.
 *   * **Ordinary process semantics.** `--die-with-parent` plus signal forwarding
 *     means the existing `AbortSignal` cancellation path works untouched, which
 *     is exactly what a cancellation guarantee should not have to be rewritten
 *     for.
 *
 * It is unavailable on Windows and on hosts without user namespaces, which is
 * why `DockerSandbox` exists alongside it. Both translate the SAME plan.
 */
export class BubblewrapSandbox implements ExecutionSandbox {
  readonly kind = 'bubblewrap' as const;

  constructor(private readonly binary = 'bwrap') {}

  async probe(): Promise<{ available: boolean; reason?: string; version?: string }> {
    if (process.platform !== 'linux') {
      return { available: false, reason: `bubblewrap is Linux-only; this host is ${process.platform}.` };
    }
    try {
      const { stdout } = await execFileAsync(this.binary, ['--version'], { timeout: 10_000 });
      return { available: true, version: stdout.trim() };
    } catch (err) {
      return {
        available: false,
        reason: `Could not run "${this.binary} --version": ${(err as Error).message}. Install bubblewrap, or configure MAC_SANDBOX_PROVIDER=docker.`,
      };
    }
  }

  async open(plan: SandboxPlan): Promise<SandboxSession> {
    const argv = buildBwrapArgv(plan);
    const pathFor = makePathMapper(plan);

    const spawner: Spawner = (executable, args, options) => {
      /*
       * `env` and `cwd` come from the PLAN, not from the caller.
       *
       * A caller that passed its own environment would be handing the agent
       * whatever the worker process holds, which is the thing the plan's
       * built-from-empty environment exists to prevent. Discarding them here
       * means a call site cannot reintroduce the problem by accident.
       */
      return nodeSpawner(
        this.binary,
        [...argv, '--', executable, ...args],
        {
          ...options,
          cwd: undefined,
          env: plan.env,
          shell: false,
          windowsHide: true,
        },
      );
    };

    return {
      kind: this.kind,
      pathFor,
      spawner,
      close: async () => {
        // Nothing to tear down: bwrap is a process, not a resource. It exits
        // with the child, and `--die-with-parent` covers the case where the
        // worker itself is killed.
      },
    };
  }
}

/**
 * Read-only system paths the toolchain needs.
 *
 * An allowlist rather than "everything except the secrets", for the same reason
 * the environment is built from empty: a new directory of secrets added to the
 * host later is excluded by default instead of being included until someone
 * remembers to exclude it.
 */
const SYSTEM_RO_PATHS = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/etc/alternatives',
  '/etc/ssl',
  '/etc/ca-certificates',
  '/etc/resolv.conf',
  '/etc/hosts',
  '/etc/nsswitch.conf',
  '/opt',
];

export function buildBwrapArgv(plan: SandboxPlan): string[] {
  const argv: string[] = [
    // Everything unshared, then network selectively shared back. The default
    // direction is deny.
    '--unshare-all',
    ...(plan.network === 'egress' ? ['--share-net'] : []),
    // The sandbox must not outlive the worker that owns it.
    '--die-with-parent',
    // A new session so the child cannot reach the worker's controlling terminal.
    '--new-session',
    '--proc', '/proc',
    '--dev', '/dev',
    '--clearenv',
  ];

  for (const systemPath of SYSTEM_RO_PATHS) {
    // `--ro-bind-try` rather than `--ro-bind`: distributions differ about which
    // of these exist, and a missing /lib64 must not make the sandbox unusable.
    argv.push('--ro-bind-try', systemPath, systemPath);
  }

  for (const tmp of plan.tmpfs) argv.push('--tmpfs', tmp);

  // A writable HOME on tmpfs. Tools that insist on writing a dotfile get one
  // that vanishes with the sandbox, rather than reaching the real home.
  const home = plan.env.HOME;
  if (home) argv.push('--dir', home);

  for (const mount of plan.mounts) {
    argv.push(mount.mode === 'ro' ? '--ro-bind' : '--bind', mount.hostPath, mount.sandboxPath);
  }

  for (const [key, value] of Object.entries(plan.env)) argv.push('--setenv', key, value);

  if (plan.user) {
    argv.push('--unshare-user', '--uid', String(plan.user.uid), '--gid', String(plan.user.gid));
  }

  argv.push('--chdir', plan.workdir);

  return argv;
}
