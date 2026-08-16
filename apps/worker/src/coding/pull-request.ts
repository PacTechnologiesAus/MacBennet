import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Opening a pull request (Sprint 2 §13).
 *
 * The most important thing about this file is what it does NOT contain: there
 * is no merge function, no approve function, and no call that could close or
 * land a pull request. "Mac must never merge the PR" is therefore not a rule
 * the code has to remember — it is a capability that does not exist.
 *
 * The gateway is an interface so the test suite can prove the whole flow
 * without a network or a GitHub account, and so a GitLab or Azure DevOps
 * implementation is an addition rather than a rewrite.
 */

export interface PullRequestRequest {
  worktreePath: string;
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface PullRequestResult {
  url: string;
  number: number | null;
}

export interface PullRequestGateway {
  readonly provider: string;
  isAvailable(): Promise<{ available: boolean; reason?: string }>;
  create(request: PullRequestRequest): Promise<PullRequestResult>;
}

/**
 * Opens a pull request with the `gh` CLI.
 *
 * argv only, `shell: false`, and the body is written to a temporary FILE rather
 * than passed as an argument — a PR body contains arbitrary diff text, and
 * putting that on a command line is how quoting bugs become command execution.
 */
export class GhPullRequestGateway implements PullRequestGateway {
  readonly provider = 'github';

  constructor(private readonly options: { command?: string; env?: NodeJS.ProcessEnv } = {}) {}

  private get command(): string {
    return this.options.command ?? 'gh';
  }

  async isAvailable(): Promise<{ available: boolean; reason?: string }> {
    try {
      await this.exec(['auth', 'status'], process.cwd());
      return { available: true };
    } catch (err) {
      return { available: false, reason: `The GitHub CLI is unavailable or unauthenticated: ${(err as Error).message}` };
    }
  }

  async create(request: PullRequestRequest): Promise<PullRequestResult> {
    if (request.head === request.base) {
      // Defence in depth. A pull request from the default branch to itself is
      // what a merge-to-main would look like if everything else had failed.
      throw new Error(`Refusing to open a pull request whose head and base are both "${request.base}".`);
    }

    const bodyFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'mac-pr-')), 'body.md');
    await fs.writeFile(bodyFile, request.body, 'utf8');

    try {
      const stdout = await this.exec(
        [
          'pr',
          'create',
          '--base', request.base,
          '--head', request.head,
          '--title', request.title,
          '--body-file', bodyFile,
        ],
        request.worktreePath,
      );

      const url = stdout.split(/\s+/).find((token) => token.startsWith('http')) ?? stdout.trim();
      const numberMatch = url.match(/\/pull\/(\d+)/);

      return { url, number: numberMatch ? Number.parseInt(numberMatch[1]!, 10) : null };
    } finally {
      await fs.rm(path.dirname(bodyFile), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private exec(argv: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.command,
        argv,
        { cwd, shell: false, windowsHide: true, timeout: 120_000, env: { ...(this.options.env ?? process.env), GH_PROMPT_DISABLED: '1' } },
        (error, stdout, stderr) => {
          if (error) reject(new Error(String(stderr || error.message).slice(0, 1000)));
          else resolve(String(stdout));
        },
      );
    });
  }
}

/** Used by the test suite and by dry runs. Records, never calls out. */
export class RecordingPullRequestGateway implements PullRequestGateway {
  readonly provider = 'mock';
  readonly created: PullRequestRequest[] = [];

  constructor(private readonly result: PullRequestResult = { url: 'https://example.invalid/pull/1', number: 1 }) {}

  async isAvailable(): Promise<{ available: boolean }> {
    return { available: true };
  }

  async create(request: PullRequestRequest): Promise<PullRequestResult> {
    if (request.head === request.base) {
      throw new Error(`Refusing to open a pull request whose head and base are both "${request.base}".`);
    }
    this.created.push(request);
    return this.result;
  }
}
