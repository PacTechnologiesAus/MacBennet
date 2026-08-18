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
  /*
   * Authorization-style headers: redact to END OF LINE, not just the next word.
   *
   * A narrower pattern that consumed one token was tried first and was wrong:
   * given `Authorization: Bearer <secret>` it removed the word "Bearer" and left
   * the secret sitting in the output. The scheme name is never the secret, so
   * there is nothing after the colon worth keeping.
   */
  out = out.replace(/\b(authorization|proxy-authorization)\b\s*[:=].*/gi, '$1: [redacted]');
  // Bare credential assignments, should one ever reach stderr.
  out = out.replace(/\b(bearer|token|password|passwd|secret|api[-_]?key)\b\s*[:=]\s*\S+/gi, '$1: [redacted]');
  // `Bearer <token>` with no key/value separator at all.
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g, 'Bearer [redacted]');
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

  /**
   * The bare mirror lives in a SUBDIRECTORY of the configured cache directory.
   *
   * It did not, at first, and that was a real bug: the askpass helper is written
   * into the cache directory, so `git clone --mirror <remote> <cacheDir>` found a
   * non-empty destination and refused. Every authenticated first-time clone
   * failed - which is to say, every correctly configured PAC deployment, while
   * the token-less local tests passed happily.
   *
   * Separating the two means the cache directory holds Mac's own scaffolding and
   * the mirror holds nothing but the repository.
   */
  get #mirrorDir(): string {
    return path.join(this.#cacheDir, 'mirror.git');
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
    /*
     * Built from a named allowlist rather than by spreading process.env: the
     * control plane's environment holds the database URL, the monday token and
     * the mailbox secret, and git needs none of them.
     *
     * The list is longer than it first looks because git on Windows genuinely
     * needs it. An earlier, tighter version omitted the proxy and profile
     * variables and it worked — until it did not, on a host behind a proxy.
     */
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      // Windows: git resolves its own installation, the user's config and the
      // certificate store through these.
      USERPROFILE: process.env.USERPROFILE,
      APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      ProgramData: process.env.ProgramData,
      ProgramFiles: process.env.ProgramFiles,
      SystemRoot: process.env.SystemRoot,
      SYSTEMDRIVE: process.env.SYSTEMDRIVE,
      WINDIR: process.env.WINDIR,
      COMSPEC: process.env.COMSPEC,
      PATHEXT: process.env.PATHEXT,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      // A control plane behind a corporate proxy has to be able to say so.
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      NO_PROXY: process.env.NO_PROXY,
      // Custom CA bundles, for a host that terminates TLS internally.
      GIT_SSL_CAINFO: process.env.GIT_SSL_CAINFO,
      SSL_CERT_FILE: process.env.SSL_CERT_FILE,
      SSL_CERT_DIR: process.env.SSL_CERT_DIR,
      // An unattended fetch must fail rather than block on a credential prompt.
      GIT_TERMINAL_PROMPT: '0',
      // Deterministic output, whatever the host's locale.
      LC_ALL: 'C',
    };

    /*
     * `GIT_CONFIG_NOSYSTEM` is deliberately NOT set.
     *
     * It was, in the first version of this file, on the reasoning that ambient
     * configuration is a surprise waiting to happen. The live test against
     * github.com then failed on Windows with
     * `schannel: CRYPT_E_NO_REVOCATION_CHECK`, and a controlled probe confirmed
     * that flag was the only cause: the system gitconfig is exactly where the
     * platform's TLS backend is configured, and discarding it breaks HTTPS.
     *
     * The system gitconfig is administrator-controlled and trusted. Excluding it
     * bought very little — every argv in this file is fixed, so no configuration
     * could turn a read into a write — and it cost the ability to fetch at all.
     * The one ambient behaviour genuinely worth suppressing is an interactive
     * credential helper, and that is handled per-invocation below.
     */
    for (const key of Object.keys(env)) {
      if (env[key] === undefined) delete env[key];
    }

    if (this.#token) {
      env[ASKPASS_ENV_VAR] = this.#token;
      env.GIT_ASKPASS = await this.#ensureAskpass();
    }

    return env;
  }

  async #git(args: string[], cwd?: string): Promise<GitResult> {
    /*
     * Clear the credential helper chain for this invocation.
     *
     * The host's git may be configured with an interactive helper — Git
     * Credential Manager is the default on Windows — which can raise a GUI
     * dialog and block a control-plane refresh until the timeout fires.
     * `GIT_TERMINAL_PROMPT=0` stops console prompting but not that.
     *
     * An empty value RESETS the helper list, so the only credential source left
     * is the askpass helper above, which is the one Mac actually owns.
     */
    const result = await this.#runGit(['-c', 'credential.helper=', ...args], {
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
      await fs.access(path.join(this.#mirrorDir, 'HEAD'));
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
        await this.#git(['remote', 'update', '--prune'], this.#mirrorDir)
      : await this.#git(['clone', '--mirror', '--quiet', remote, this.#mirrorDir]);

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
    const sha = await this.#git(['rev-parse', `refs/heads/${this.#ref}`], this.#mirrorDir);
    if (sha.code !== 0) return null;

    const commitSha = sha.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(commitSha)) return null;

    const date = await this.#git(['show', '-s', '--format=%cI', commitSha], this.#mirrorDir);
    const committedAt = date.code === 0 ? date.stdout.trim() || null : null;

    return { commitSha, ref: this.#ref, committedAt };
  }

  async listFiles(commitSha: string): Promise<string[]> {
    assertSha(commitSha);
    const result = await this.#git(['ls-tree', '-r', '--name-only', commitSha], this.#mirrorDir);
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
    const result = await this.#git(['show', `${commitSha}:${relativePath}`], this.#mirrorDir);
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
