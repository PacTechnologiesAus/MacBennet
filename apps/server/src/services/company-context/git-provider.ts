import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CompanyContextProviderKind } from '@mac/protocol';
import {
  CompanyDocumentMissing,
  type CompanyContextProvider,
  type ProviderDescription,
  type ProviderRevision,
  type RefreshOutcome,
} from './provider.js';

/**
 * The Git provider: a bare MIRROR of the PAC company context repository
 * (Sprint 3.2 §3.2).
 *
 * ---------------------------------------------------------------------------
 * WHY A MIRROR AND NOT A CHECKOUT
 *
 * Four reasons, in the order they mattered when this was decided:
 *
 *  1. **Historical attribution actually works.** A run bound to commit `abc1234`
 *     must stay attributable to it. With a mirror, that commit's documents remain
 *     READABLE, so "show me the AUTHORITY.md this run worked under" is a question
 *     with an answer, not just a SHA in a column.
 *  2. **There is no working tree to tamper with.** A checkout puts AUTHORITY.md
 *     on disk as an editable file. A stray process, a mis-scoped script or a
 *     future mistake could then change what Mac reads as company policy. A mirror
 *     has no such file.
 *  3. **Reads are pinned by construction.** `git show <sha>:<path>` cannot
 *     accidentally read a different revision. There is no checked-out branch to
 *     drift underneath a reader.
 *  4. **Refresh is atomic from a reader's point of view.** `remote update` moves
 *     refs; readers already hold SHAs.
 * ---------------------------------------------------------------------------
 *
 * Every git invocation here uses a FIXED argv built in this file. No caller
 * supplies a subcommand, a flag, or a ref. The only mutating operations the
 * process can perform are `clone --mirror` and `remote update` against Mac's own
 * cache directory.
 */

export interface GitProviderOptions {
  repositoryUrl: string;
  ref: string;
  cacheDir: string;
  /** Read-only. Never placed in argv or in the remote URL. */
  token?: string | undefined;
  timeoutMs?: number;
  /** Injectable for tests; defaults to spawning the real `git`. */
  runGit?: GitRunner;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<GitResult>;

/** The env var the askpass helper reads. Never written to disk itself. */
const ASKPASS_ENV_VAR = 'MAC_COMPANY_CONTEXT_ASKPASS_TOKEN';

/**
 * Removes anything credential-shaped from text that is about to be logged,
 * persisted or returned to a caller (Sprint 3.2 §4.2, §21).
 *
 * ONE funnel, called on every git failure path in this file, rather than a rule
 * each call site has to remember. `token` is passed when known so the exact
 * value is removed even if it appears in a form the generic patterns miss.
 */
export function redactGitError(text: string, token?: string | undefined): string {
  let out = text;
  if (token && token.length >= 8) out = out.split(token).join('[redacted]');
  // https://user:pass@host and https://token@host alike.
  out = out.replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[redacted]@');
  // Bare bearer/token headers, should one ever reach stderr.
  out = out.replace(/\b(authorization|bearer|token|password)\b\s*[:=]\s*\S+/gi, '$1: [redacted]');
  // GitHub credential shapes, belt and braces.
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '[redacted]');
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted]');
  return out.trim().slice(0, 2000);
}

/**
 * Strips credentials out of a URL so it is safe to persist and display.
 *
 * `repository_url` is written to every revision row and shown in the UI, so this
 * runs before anything is stored — not as a display-time nicety, which would
 * leave the secret in the database.
 */
export function sanitiseRepositoryUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url.replace(/(https?:\/\/)[^\s/@]+@/i, '$1');
  }
}

/**
 * The URL git is actually handed.
 *
 * A USERNAME is injected when a token is configured, because GitHub's HTTPS flow
 * asks for a username first and an unattended git with `GIT_TERMINAL_PROMPT=0`
 * would otherwise fail before ever reaching the askpass helper. `x-access-token`
 * is a well-known public sentinel, not a secret, so it is safe in `ps` output.
 * The token itself never appears here.
 */
export function buildRemoteUrl(url: string, hasToken: boolean): string {
  if (!hasToken) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return url;
    if (parsed.username) return url;
    parsed.username = 'x-access-token';
    return parsed.toString();
  } catch {
    return url;
  }
}

const defaultRunner: GitRunner = (args, options) =>
  new Promise<GitResult>((resolve) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ code: 124, stdout, stderr: `${stderr}\ngit timed out after ${options.timeoutMs}ms` });
    }, options.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      // Bounded: a corrupted repository could otherwise stream indefinitely.
      if (stdout.length < 8 * 1024 * 1024) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 256 * 1024) stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}\n${err.message}` });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

export class GitCompanyContextProvider implements CompanyContextProvider {
  readonly kind: CompanyContextProviderKind = 'git';

  readonly #repositoryUrl: string;
  readonly #ref: string;
  readonly #cacheDir: string;
  readonly #timeoutMs: number;
  readonly #runGit: GitRunner;

  /*
   * Held in a private field and never assigned to an enumerable property.
   *
   * The same treatment the monday and Graph clients get, and for the same
   * reason: `JSON.stringify(provider)` appearing in a hurried log line must not
   * be the way a company credential escapes.
   */
  readonly #token: string | undefined;

  constructor(options: GitProviderOptions) {
    this.#repositoryUrl = options.repositoryUrl;
    this.#ref = options.ref;
    this.#cacheDir = options.cacheDir;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#runGit = options.runGit ?? defaultRunner;
    this.#token = options.token;
  }

  describe(): ProviderDescription {
    return {
      repositoryUrl: sanitiseRepositoryUrl(this.#repositoryUrl),
      ref: this.#ref,
      cacheDir: this.#cacheDir,
    };
  }

  // -------------------------------------------------------------------------
  // Credential plumbing
  // -------------------------------------------------------------------------

  /**
   * Writes the askpass helper, whose entire body echoes an ENVIRONMENT VARIABLE.
   *
   * The script contains the variable's NAME, never its value, so the token is
   * not written to disk. It reaches git only through the child process
   * environment, which keeps it out of argv (visible in `ps`), out of the remote
   * URL (visible in `git remote -v`, the reflog and error text), and out of any
   * on-disk credential store.
   */
  async #ensureAskpass(): Promise<string> {
    const isWindows = process.platform === 'win32';
    const file = path.join(this.#cacheDir, isWindows ? 'askpass.cmd' : 'askpass.sh');
    const body = isWindows
      ? `@echo off\r\necho %${ASKPASS_ENV_VAR}%\r\n`
      : `#!/bin/sh\nprintf '%s' "$${ASKPASS_ENV_VAR}"\n`;

    await fs.mkdir(this.#cacheDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(file, body, { mode: 0o700 });
    if (!isWindows) await fs.chmod(file, 0o700).catch(() => undefined);
    return file;
  }

  async #env(): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = {
      // Built from a minimal base rather than spreading process.env: the control
      // plane's environment holds the database URL, the monday token and the
      // mailbox secret, and git needs none of them.
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      // An unattended fetch must fail rather than block on a credential prompt.
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      // Deterministic output, whatever the host's locale.
      LC_ALL: 'C',
    };

    if (this.#token) {
      env[ASKPASS_ENV_VAR] = this.#token;
      env.GIT_ASKPASS = await this.#ensureAskpass();
    }

    return env;
  }

  async #git(args: string[], cwd?: string): Promise<GitResult> {
    const result = await this.#runGit(args, {
      ...(cwd ? { cwd } : {}),
      env: await this.#env(),
      timeoutMs: this.#timeoutMs,
    });
    return { ...result, stderr: redactGitError(result.stderr, this.#token) };
  }

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  async #cacheExists(): Promise<boolean> {
    try {
      // A mirror is a bare repository: HEAD at the top level, no .git directory.
      await fs.access(path.join(this.#cacheDir, 'HEAD'));
      return true;
    } catch {
      return false;
    }
  }

  async refresh(): Promise<RefreshOutcome> {
    const before = await this.headRevision().catch(() => null);
    const remote = buildRemoteUrl(this.#repositoryUrl, Boolean(this.#token));

    try {
      await fs.mkdir(this.#cacheDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      return {
        ok: false,
        error: redactGitError(`Could not create the company context cache: ${(err as Error).message}`, this.#token),
        cachedCommitSha: before?.commitSha ?? null,
      };
    }

    const exists = await this.#cacheExists();

    const result = exists
      ? // `remote update --prune` rather than `fetch`: a mirror's refspec already
        // covers every ref, and --prune makes a deleted or rewritten remote branch
        // observable rather than leaving a stale local ref behind.
        await this.#git(['remote', 'update', '--prune'], this.#cacheDir)
      : await this.#git(['clone', '--mirror', '--quiet', remote, this.#cacheDir]);

    if (result.code !== 0) {
      return {
        ok: false,
        error: result.stderr || `git exited ${result.code}`,
        cachedCommitSha: before?.commitSha ?? null,
      };
    }

    const after = await this.headRevision();
    if (!after) {
      return {
        ok: false,
        error: `The company context repository has no ref "${this.#ref}".`,
        cachedCommitSha: before?.commitSha ?? null,
      };
    }

    return {
      ok: true,
      commitSha: after.commitSha,
      changed: before?.commitSha !== after.commitSha,
      fetchedFromRemote: true,
    };
  }

  async headRevision(): Promise<ProviderRevision | null> {
    if (!(await this.#cacheExists())) return null;

    // In a mirror, remote branches land on refs/heads/*.
    const sha = await this.#git(['rev-parse', `refs/heads/${this.#ref}`], this.#cacheDir);
    if (sha.code !== 0) return null;

    const commitSha = sha.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(commitSha)) return null;

    const date = await this.#git(['show', '-s', '--format=%cI', commitSha], this.#cacheDir);
    const committedAt = date.code === 0 ? date.stdout.trim() || null : null;

    return { commitSha, ref: this.#ref, committedAt };
  }

  async listFiles(commitSha: string): Promise<string[]> {
    assertSha(commitSha);
    const result = await this.#git(['ls-tree', '-r', '--name-only', commitSha], this.#cacheDir);
    if (result.code !== 0) throw new Error(`Could not list company context files: ${result.stderr}`);
    return result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  async readFile(commitSha: string, relativePath: string): Promise<string> {
    assertSha(commitSha);
    assertSafePath(relativePath);

    /*
     * `--` before the pathspec, and the path glued to the sha with `:`.
     *
     * The path comes from a manifest, which is validated upstream, but this is
     * the boundary where a string becomes a git argument and it costs nothing to
     * make an argument that starts with `-` impossible to interpret as a flag.
     */
    const result = await this.#git(['show', `${commitSha}:${relativePath}`], this.#cacheDir);
    if (result.code !== 0) throw new CompanyDocumentMissing(relativePath, commitSha);
    return result.stdout;
  }
}

const assertSha = (sha: string): void => {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    throw new Error(`Refusing to read company context at "${sha}": not a commit SHA.`);
  }
};

const assertSafePath = (p: string): void => {
  if (!p || p.startsWith('-') || p.startsWith('/') || p.includes('..') || p.includes('\0') || p.includes('\\')) {
    throw new Error(`Refusing to read company context path "${p}".`);
  }
};
