import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import type { SandboxPlan } from '@mac/protocol';
import { makePathMapper, nodeSpawner, type ExecutionSandbox, type SandboxSession, type Spawner } from './index.js';

const execFileAsync = promisify(execFile);

/**
 * Docker (Sprint 3 §3.2) — the portable provider.
 *
 * Not the production default: a daemon whose socket confers root is a real
 * trust boundary, and bubblewrap avoids it entirely. Docker exists here for two
 * concrete reasons.
 *
 * First, most deployments already have it, and a worker VM that cannot get
 * bubblewrap should still be able to run coding work safely rather than not at
 * all.
 *
 * Second — and this is the one that decided it — it is available on the machine
 * this sprint was written on, where bubblewrap is not. Without it, every
 * containment claim in Sprint 3 would rest on tests that skipped. A boundary
 * whose enforcement has never been observed is a boundary nobody should trust,
 * including its author.
 *
 * Both providers translate the SAME plan, so this is a second back-end, not a
 * second policy.
 */
export class DockerSandbox implements ExecutionSandbox {
  readonly kind = 'docker' as const;

  constructor(
    private readonly binary = 'docker',
    private readonly defaultImage = 'alpine:3.20',
  ) {}

  async probe(): Promise<{ available: boolean; reason?: string; version?: string }> {
    try {
      // `info` rather than `--version`: the client can be installed while the
      // daemon is down, and a client alone cannot contain anything.
      const { stdout } = await execFileAsync(
        this.binary,
        ['info', '--format', '{{.ServerVersion}}/{{.OSType}}'],
        { timeout: 30_000 },
      );
      const [version, osType] = stdout.trim().split('/');
      if (osType && osType !== 'linux') {
        return { available: false, reason: `Docker is running ${osType} containers; Linux containers are required.` };
      }
      return { available: true, version: `docker ${version}` };
    } catch (err) {
      return {
        available: false,
        reason: `Could not reach the Docker daemon: ${(err as Error).message}.`,
      };
    }
  }

  async open(plan: SandboxPlan): Promise<SandboxSession> {
    const image = plan.image ?? this.defaultImage;
    const pathFor = makePathMapper(plan);
    const containers = new Set<string>();

    const spawner: Spawner = (executable, args, options) => {
      const name = `mac-sbx-${randomBytes(6).toString('hex')}`;
      containers.add(name);

      const argv = buildDockerArgv(plan, { image, name });
      const child = nodeSpawner(this.binary, [...argv, executable, ...args], {
        ...options,
        cwd: undefined,
        // The docker CLI itself needs an environment (DOCKER_HOST, PATH); the
        // SANDBOXED process gets `plan.env` via `-e`, which is what matters.
        env: process.env,
        shell: false,
        windowsHide: true,
      });

      /*
       * Signal proxying through the daemon is best-effort, and a night shift
       * must not depend on best-effort. Killing the container by name is the
       * part that definitely works, so cancellation does both.
       */
      const abort = options.signal;
      if (abort) {
        const onAbort = () => {
          void execFileAsync(this.binary, ['kill', name], { timeout: 30_000 }).catch(() => undefined);
        };
        if (abort.aborted) onAbort();
        else abort.addEventListener('abort', onAbort, { once: true });
      }

      child.once('close', () => containers.delete(name));
      return child;
    };

    return {
      kind: this.kind,
      pathFor,
      spawner,
      close: async () => {
        /*
         * `rm --force`, not `kill`.
         *
         * Anything still running when the session closes is orphaned work with
         * nobody left to read its output, and `--rm` reaps a container once it
         * STOPS. But a container that never started — a mount the daemon
         * rejected, a `docker run` aborted before the container ran — sits in
         * `Created` forever: `--rm` has nothing to reap and `docker kill`
         * refuses, with the failure swallowed by the `catch` below.
         *
         * Sprint 3.1 commissioning found nineteen of them on a development
         * machine after a day's work, at which point the daemon had slowed
         * enough to time the conformance suite out. On a VM taking a task a
         * night this grows without bound. `rm --force` removes a container in
         * any state, which is what "close this session" was always meant to do.
         */
        await Promise.all(
          [...containers].map((name) =>
            execFileAsync(this.binary, ['rm', '--force', name], { timeout: 30_000 }).catch(() => undefined),
          ),
        );
        containers.clear();
      },
    };
  }
}

export function buildDockerArgv(plan: SandboxPlan, options: { image: string; name: string }): string[] {
  const argv: string[] = [
    'run',
    '--rm',
    '-i',
    '--name', options.name,
    // Whatever the image might have wanted to do at start-up is not this
    // process's business.
    '--entrypoint', '',
    // A container that can add capabilities is a container that can escape one.
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--network', plan.network === 'egress' ? 'bridge' : 'none',
    // Bounded, so a runaway agent cannot take the host down with it.
    '--pids-limit', '512',
  ];

  if (plan.user) argv.push('--user', `${plan.user.uid}:${plan.user.gid}`);

  for (const tmp of plan.tmpfs) argv.push('--tmpfs', `${tmp}:rw,exec,nosuid,size=1g`);

  for (const mount of plan.mounts) {
    argv.push('-v', `${toDockerHostPath(mount.hostPath)}:${mount.sandboxPath}:${mount.mode}`);
  }

  for (const [key, value] of Object.entries(plan.env)) argv.push('-e', `${key}=${value}`);

  argv.push('-w', plan.workdir);
  argv.push(options.image);

  return argv;
}

/**
 * Docker Desktop on Windows accepts `C:\path` in a `-v` argument, but the
 * forward-slash form is unambiguous and is what the daemon normalises to
 * anyway. Doing it here keeps the plan itself platform-neutral.
 */
function toDockerHostPath(hostPath: string): string {
  return hostPath.replace(/\\/g, '/');
}
