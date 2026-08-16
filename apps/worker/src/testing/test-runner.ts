import { spawn } from 'node:child_process';

/**
 * Runs a repository's own test or build command.
 *
 * This is the only project-specific command in the system, and every property
 * that keeps it safe is visible here:
 *
 *   * it is an argv ARRAY, taken from the repository row, which only an admin
 *     can set and whose changes are audited;
 *   * `shell: false`, so there is no pipeline, redirect or metacharacter
 *     interpretation — a `;` in an argument is a literal semicolon;
 *   * it is validated again before spawning, so a value written directly to the
 *     database still cannot express shell syntax;
 *   * it runs in the run's worktree and nowhere else;
 *   * it is bounded by a timeout and killed as a process group, because a test
 *     suite that hangs must become a reported failure rather than a hung night.
 */

export interface CommandResult {
  ran: boolean;
  command: string[];
  exitCode: number | null;
  passed: boolean | null;
  durationMs: number | null;
  output: string;
}

export const NOT_RUN: CommandResult = {
  ran: false,
  command: [],
  exitCode: null,
  passed: null,
  durationMs: null,
  output: '',
};

const SHELL_METACHARACTERS = /[;&|`$><\n\r]/;

/**
 * Executables that ARE a shell.
 *
 * Blocking metacharacters is not sufficient on its own: `sh -c "rm -rf /"`
 * contains none, because the shell syntax is inside a single argument. Since
 * the whole point of `shell: false` is that no shell interprets these
 * arguments, invoking one explicitly defeats it — so the interpreter itself is
 * refused.
 */
const SHELL_EXECUTABLES = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'ash',
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
  // `env` and `xargs` can launch anything, which is the same problem.
  'env', 'xargs', 'nohup', 'timeout',
]);

/**
 * Interpreters that will execute a program supplied on the command line.
 *
 * `node script.mjs` is a perfectly ordinary test command; `node -e "..."` is
 * arbitrary code in a configuration field. Only the inline-program flags are
 * refused.
 */
const INLINE_PROGRAM_FLAGS: Record<string, string[]> = {
  node: ['-e', '--eval', '-p', '--print'],
  python: ['-c'],
  python3: ['-c'],
  ruby: ['-e'],
  perl: ['-e'],
  php: ['-r'],
};

const basename = (executable: string): string => executable.split(/[\\/]/).pop()?.toLowerCase() ?? '';

/** Rejects anything that looks like shell syntax rather than an argv element. */
export function validateCommandArgv(argv: readonly string[]): { ok: true } | { ok: false; reason: string } {
  if (argv.length === 0) return { ok: false, reason: 'No command configured.' };

  const executable = basename(argv[0]!);

  if (SHELL_EXECUTABLES.has(executable)) {
    return {
      ok: false,
      reason:
        `"${argv[0]}" is a shell or a process launcher. Commands are executed as an argv array with no shell, ` +
        'and invoking one explicitly would defeat that. Configure the test command directly.',
    };
  }

  const inlineFlags = INLINE_PROGRAM_FLAGS[executable] ?? INLINE_PROGRAM_FLAGS[executable.replace(/\.exe$/, '')];
  if (inlineFlags?.some((flag) => argv.includes(flag))) {
    return {
      ok: false,
      reason: `"${argv[0]}" is being asked to execute an inline program. Point it at a file in the repository instead.`,
    };
  }

  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.length === 0) {
      return { ok: false, reason: 'Command arguments must be non-empty strings.' };
    }
    if (arg.length > 300) return { ok: false, reason: 'Command argument is unreasonably long.' };
    if (SHELL_METACHARACTERS.test(arg)) {
      return {
        ok: false,
        reason: `Command argument "${arg}" contains shell metacharacters. This is an argv array, not a shell command.`,
      };
    }
  }
  return { ok: true };
}

export interface RunCommandOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputChars?: number;
  env?: NodeJS.ProcessEnv;
  onOutput?: (chunk: string) => void;
  /**
   * Sprint 3: how the command is started.
   *
   * Defaults to `node:child_process.spawn`. A coding run supplies the sandbox
   * session's spawner, because `npm test` executes code the agent has just
   * written — sandboxing the agent but not its test run would leave the widest
   * hole open while claiming it was closed.
   */
  spawner?: (
    executable: string,
    args: readonly string[],
    options: import('node:child_process').SpawnOptions,
  ) => import('node:child_process').ChildProcess;
}

export async function runProjectCommand(
  argv: readonly string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  const validation = validateCommandArgv(argv);
  if (!validation.ok) {
    return {
      ran: false,
      command: [...argv],
      exitCode: null,
      passed: null,
      durationMs: null,
      output: `Refused to run the configured command: ${validation.reason}`,
    };
  }

  const [executable, ...args] = argv as string[];
  const startedAt = Date.now();
  const maxChars = options.maxOutputChars ?? 60_000;

  const launch = options.spawner ?? ((exe, argvArgs, spawnOptions) => spawn(exe, [...argvArgs], spawnOptions));

  return new Promise<CommandResult>((resolve) => {
    const child = launch(executable!, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      // A new process group, so a timeout kills the whole tree rather than
      // leaving orphaned test workers holding the worktree open.
      detached: process.platform !== 'win32',
      env: { ...(options.env ?? process.env), CI: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let settled = false;
    let timedOut = false;

    const append = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      options.onOutput?.(text);
      if (output.length < maxChars) {
        output += text;
        if (output.length >= maxChars) output = `${output.slice(0, maxChars)}\n… [output truncated]`;
      }
    };

    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const kill = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs ?? 20 * 60_000);
    timer.unref();

    const onAbort = () => kill();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const settle = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);

      resolve({
        ran: true,
        command: [...argv],
        exitCode,
        // A timeout is a failure, not an unknown: leaving `passed: null` would
        // let the review treat a hung suite as "no result" rather than a problem.
        passed: timedOut ? false : exitCode === 0,
        durationMs: Date.now() - startedAt,
        output: timedOut ? `${output}\n\n[The command was killed after exceeding its time limit.]` : output,
      });
    };

    child.on('error', (err) => {
      output += `\nFailed to start "${executable}": ${err.message}`;
      settle(null);
    });
    child.on('close', (code) => settle(code));
  });
}
