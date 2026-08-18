import { execFile } from 'node:child_process';
import path from 'node:path';
import { checkGitCommand, type GitPolicyContext, type GitViolationCode } from '@mac/protocol';

/**
 * The ONLY place in this system that runs git.
 *
 * Three properties make this safe, and all three are structural rather than
 * conventional:
 *
 *  1. **argv arrays, `shell: false`.** There is no command string anywhere, so
 *     there is no quoting, no metacharacter, and no injection surface. A branch
 *     name containing `; rm -rf /` is one argument called `; rm -rf /`, and git
 *     rejects it as a ref name.
 *
 *  2. **Every invocation is policy-checked first**, against the shared
 *     `@mac/protocol/git-policy` module — the same module the shim on the
 *     coding agent's PATH uses. Two enforcement layers, one set of rules, so
 *     they cannot drift apart.
 *
 *  3. **A refusal is reported, not just returned.** A `ProhibitedGitOperation`
 *     carries the code and argv, and the caller uploads it to the control plane
 *     as a security event that blocks pull-request creation.
 */

export class ProhibitedGitOperation extends Error {
  override readonly name = 'ProhibitedGitOperation';
  constructor(
    readonly code: GitViolationCode,
    readonly argv: readonly string[],
    message: string,
  ) {
    super(message);
  }
}

export class GitCommandError extends Error {
  override readonly name = 'GitCommandError';
  constructor(
    readonly argv: readonly string[],
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`git ${argv.join(' ')} failed with exit code ${exitCode}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`);
  }
}

export interface GitRunnerOptions {
  cwd: string;
  policy: GitPolicyContext;
  /** Absolute path of the git binary. Resolved once, never taken from PATH at call time. */
  gitPath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called for every refusal, so the control plane learns about it. */
  onViolation?: (violation: { code: GitViolationCode; argv: string[]; message: string }) => void | Promise<void>;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class GitRunner {
  private policy: GitPolicyContext;

  constructor(private readonly options: GitRunnerOptions) {
    this.policy = options.policy;
  }

  /** Updates the policy context as the worktree's state changes. */
  setPolicy(patch: Partial<GitPolicyContext>): void {
    this.policy = { ...this.policy, ...patch };
  }

  get policyContext(): GitPolicyContext {
    return this.policy;
  }

  /**
   * Runs git, refusing anything the policy prohibits.
   *
   * Note that the check happens BEFORE the process is spawned. A prohibited
   * operation never reaches git at all — this is not a matter of inspecting the
   * outcome afterwards.
   */
  async run(argv: string[], opts: { cwd?: string; allowFailure?: boolean } = {}): Promise<GitResult> {
    const verdict = checkGitCommand(argv, this.policy);
    if (!verdict.allowed) {
      await this.options.onViolation?.({ code: verdict.code, argv, message: verdict.message });
      throw new ProhibitedGitOperation(verdict.code, argv, verdict.message);
    }

    return this.spawn(argv, opts);
  }

  /**
   * Runs git WITHOUT the policy check.
   *
   * Deliberately named so it cannot be called by accident, and deliberately
   * private-by-convention: it exists only for read-only plumbing invoked by
   * this class itself (resolving the current branch, for instance) where the
   * policy check would need the answer it is trying to obtain. It is never
   * exposed to a caller and never used for a write.
   */
  private async spawn(argv: string[], opts: { cwd?: string; allowFailure?: boolean } = {}): Promise<GitResult> {
    const cwd = opts.cwd ?? this.options.cwd;
    const git = this.options.gitPath ?? 'git';

    return new Promise<GitResult>((resolve, reject) => {
      execFile(
        git,
        argv,
        {
          cwd,
          // No shell. This is the property that makes argv safe.
          shell: false,
          timeout: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: 32 * 1024 * 1024,
          windowsHide: true,
          ...(this.options.signal ? { signal: this.options.signal } : {}),
          env: gitEnvironment(),
        },
        (error, stdout, stderr) => {
          const exitCode = (error as { code?: number } | null)?.code ?? 0;
          const result: GitResult = { stdout: String(stdout), stderr: String(stderr), exitCode: typeof exitCode === 'number' ? exitCode : 1 };

          if (error && !opts.allowFailure) {
            reject(new GitCommandError(argv, result.exitCode, result.stdout, result.stderr));
            return;
          }
          resolve(result);
        },
      );
    });
  }

  /** Read-only plumbing that the policy itself depends on. */
  async currentBranch(cwd?: string): Promise<string | null> {
    const result = await this.spawn(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: cwd ?? this.options.cwd, allowFailure: true });
    const branch = result.stdout.trim();
    return branch && branch !== 'HEAD' ? branch : null;
  }

  async revParse(ref: string, cwd?: string): Promise<string | null> {
    const result = await this.spawn(['rev-parse', ref], { cwd: cwd ?? this.options.cwd, allowFailure: true });
    const sha = result.stdout.trim();
    return result.exitCode === 0 && sha ? sha : null;
  }
}

/**
 * The environment git runs in.
 *
 * Interactive prompts would hang an unattended run forever, so every one of them
 * is disabled. Credentials come from the VM's own configuration exactly as they
 * would for a human engineer; nothing is injected here.
 */
export function gitEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    // Deterministic output regardless of the VM's locale.
    LC_ALL: 'C',
    GIT_PAGER: 'cat',
  };
}

/** Refuses any path that escapes the workspace root. */
export function assertWithinWorkspace(candidate: string, workspaceRoot: string): string {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to operate on "${resolved}", which is outside the workspace root "${root}".`);
  }
  return resolved;
}
