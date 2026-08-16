import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { execFile } from 'node:child_process';
import type {
  AgentEvent,
  AgentEventDraft,
  AgentSessionResult,
  CodingAgent,
  CodingAgentContext,
  CodingSessionHandle,
  CodingTask,
  UsageSnapshot,
} from '@mac/protocol';

/**
 * The Claude Code adapter (Sprint 2 §3).
 *
 * Mac is the manager; Claude Code is the implementation worker. This file is
 * the only place in the system that knows Claude Code exists — everything above
 * it speaks the neutral `CodingAgent` vocabulary, so replacing this with a
 * Codex adapter later is an additive change, not a refactor.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS VERIFIED, RATHER THAN ASSUMED (Claude Code 2.1.233)
 *
 *   * `claude -p --output-format stream-json --verbose` emits newline-delimited
 *     JSON: `system/init` (carries `session_id`), `assistant` messages whose
 *     content blocks include `tool_use`, `user` messages carrying
 *     `tool_result`, `rate_limit_event`, and a terminal `result`.
 *   * The terminal `result` carries `usage` (input/output/cache tokens) and
 *     `total_cost_usd`, plus `modelUsage` per model.
 *   * `--input-format stream-json` keeps stdin open, so an answer can be
 *     delivered as a further user message without restarting the session. That
 *     is how Mac answers a question mid-implementation.
 *   * `--session-id` and `--resume` exist, so the provider session id is
 *     recorded and a dropped session can be re-attached.
 *   * There is NO usage subcommand and no subscription percentage anywhere.
 *     `claude auth status` reports the plan type but not consumption.
 *
 * Everything the adapter reports about usage follows from that; see
 * `usageSnapshot` for why the dollar figure is `estimated` and not `exact`.
 * ---------------------------------------------------------------------------
 */

export interface ClaudeCodeAdapterOptions {
  /** Executable to run. Overridden in tests by a fake CLI. */
  command?: string;
  /**
   * A script for `command` to execute, prepended to every argv.
   *
   * The single test seam in this class: it lets the suite run
   * `node fake-claude.mjs <the adapter's real flags>` so that the argv, the
   * stdin protocol, the stream parsing and the process lifecycle under test are
   * exactly the ones production uses. Unset in production, where `command` is
   * the `claude` binary itself.
   */
  scriptPath?: string;
  /** Extra argv appended after the adapter's own fixed arguments. */
  extraArgs?: string[];
  /** Directory placed FIRST on the agent's PATH — the git shim. */
  shimBinDir?: string;
  model?: string | undefined;
  /** How long to wait after SIGTERM before SIGKILL. */
  killGraceMs?: number;
  /** Milliseconds of silence after which a session is considered stalled. */
  idleTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * Sprint 3: how the agent process is started.
   *
   * Defaults to `node:child_process.spawn`. When a sandbox is open, the session
   * supplies a spawner that wraps the same argv in `bwrap` or `docker run`, so
   * the agent runs inside the containment boundary without this adapter knowing
   * anything about it. The seam is one function because that is all it needs to
   * be — the argv, the stdin protocol and the stream parsing are unchanged.
   */
  spawner?: (executable: string, args: readonly string[], options: import('node:child_process').SpawnOptions) => ChildProcessWithoutNullStreams;
  /**
   * The agent's working directory, when it differs from the host worktree path.
   *
   * Under a container the worktree is mounted somewhere else, and `cwd` has to
   * be the path the sandboxed process will see.
   */
  workdir?: string;
}

interface PendingSession {
  child: ChildProcessWithoutNullStreams;
  providerSessionId: string | null;
}

const REFUSAL_EXIT_CODE = 77;

export class ClaudeCodeAdapter implements CodingAgent {
  readonly provider = 'claude_code' as const;
  private sessions = new Map<string, PendingSession>();
  /** Kept from the last completed session so `usageSnapshot('after')` is real. */
  private lastResultUsage: Record<string, unknown> | null = null;
  private lastRateLimit: Record<string, unknown> | null = null;
  private authInfo: { subscriptionType?: string; authMethod?: string } | null = null;
  /** Cached result of `resolveExecutable`. */
  private resolvedCommand: string | null = null;

  constructor(private readonly options: ClaudeCodeAdapterOptions = {}) {}

  private get command(): string {
    return this.options.command ?? 'claude';
  }

  /** Prepends the test script, when one is configured. */
  private argvFor(argv: string[]): string[] {
    return this.options.scriptPath ? [this.options.scriptPath, ...argv] : argv;
  }

  /**
   * Resolves `claude` to something that can actually be spawned.
   *
   * Necessary because npm installs the CLI as a pair of shims — a POSIX `sh`
   * script and a `.cmd` batch file — and neither is spawnable with
   * `shell: false`: Node refuses `.cmd` outright (CVE-2024-27980), and the sh
   * script is not executable by Windows. Underneath both sits a real binary.
   *
   * Using `shell: true` would make it work in one line and is exactly what must
   * not be done here: this adapter spawns a process with an argv the agent's
   * brief contributes to, and introducing a shell would introduce a quoting
   * surface with it. So the real executable is located instead.
   *
   * Resolution order:
   *   1. an explicit override, for unusual installations;
   *   2. a directly spawnable candidate from `where`/`which`;
   *   3. the target inside an npm shim, read out of the shim itself.
   */
  private async resolveExecutable(): Promise<string> {
    if (this.options.command) return this.options.command;
    if (this.resolvedCommand) return this.resolvedCommand;

    const override = process.env.MAC_CLAUDE_CLI_PATH;
    if (override) {
      this.resolvedCommand = override;
      return override;
    }

    const candidates = await which('claude');

    if (process.platform !== 'win32') {
      this.resolvedCommand = candidates[0] ?? 'claude';
      return this.resolvedCommand;
    }

    const direct = candidates.find((c) => /\.exe$/i.test(c));
    if (direct) {
      this.resolvedCommand = direct;
      return direct;
    }

    for (const shim of candidates) {
      const target = await readShimTarget(shim);
      if (target) {
        this.resolvedCommand = target;
        return target;
      }
    }

    this.resolvedCommand = candidates[0] ?? 'claude';
    return this.resolvedCommand;
  }

  async isAvailable(): Promise<{ available: boolean; reason?: string; version?: string }> {
    try {
      const version = await this.exec([`--version`]);
      const auth = await this.exec(['auth', 'status']).catch(() => '');
      if (auth) {
        try {
          this.authInfo = JSON.parse(auth) as { subscriptionType?: string; authMethod?: string };
        } catch {
          // `auth status` output format is not a contract; a parse failure only
          // costs the usage note some precision.
        }
      }
      const loggedIn = !auth || !/loggedIn"?\s*:\s*false/.test(auth);
      if (!loggedIn) {
        return { available: false, reason: 'The Claude Code CLI is installed but not authenticated on this worker.' };
      }
      return { available: true, version: version.trim().split('\n')[0] ?? 'unknown' };
    } catch (err) {
      return { available: false, reason: `The Claude Code CLI is not available on this worker: ${(err as Error).message}` };
    }
  }

  /**
   * Usage, reported honestly.
   *
   * Read the source classification carefully, because it is the whole point of
   * spec §25:
   *
   *   * TOKEN COUNTS are `exact` — the CLI reports them directly.
   *   * The DOLLAR FIGURE under subscription auth is `estimated`, not `exact`.
   *     `total_cost_usd` is the list-price equivalent of the tokens consumed;
   *     the account is billed by subscription, so reporting it as money spent
   *     would be a fabrication. Only under API-key auth is it real money.
   *   * SUBSCRIPTION PERCENTAGE is unavailable. The CLI exposes none, so none
   *     is reported — no estimate is dressed up as a measurement.
   *   * RATE-LIMIT STATE is `observed`: a genuine samplable provider state,
   *     recorded as a state rather than converted into a number it is not.
   */
  async usageSnapshot(phase: 'before' | 'after'): Promise<UsageSnapshot> {
    const capturedAt = new Date().toISOString();

    if (phase === 'before') {
      // There is nothing to sample before a session: the CLI reports per-session
      // totals, not a running counter. Saying so is better than inventing a zero
      // baseline that would make the delta look like a measurement.
      const state = this.lastRateLimit?.status ? String(this.lastRateLimit.status) : null;
      return {
        provider: 'claude_code',
        phase,
        source: state ? 'observed' : 'unavailable',
        capturedAt,
        ...(state ? { state } : {}),
        ...(this.lastRateLimit?.rateLimitType ? { reportingPeriod: String(this.lastRateLimit.rateLimitType) } : {}),
        note:
          'The Claude Code CLI reports usage per session rather than as a running total, and exposes no ' +
          'subscription percentage. There is no meaningful baseline to sample before a run.',
      };
    }

    if (!this.lastResultUsage) {
      return {
        provider: 'claude_code',
        phase,
        source: 'unavailable',
        capturedAt,
        note: 'The session produced no usage report.',
      };
    }

    const usage = (this.lastResultUsage.usage ?? {}) as Record<string, number | undefined>;
    const costUsd = typeof this.lastResultUsage.total_cost_usd === 'number' ? this.lastResultUsage.total_cost_usd : null;
    const subscription = this.authInfo?.authMethod !== 'apiKey';

    return {
      provider: 'claude_code',
      phase,
      // Token counts are exact; the source label describes the figures as a
      // whole, and the note says precisely what the money figure is.
      source: subscription ? 'estimated' : 'exact',
      capturedAt,
      inputTokens: usage.input_tokens ?? null,
      outputTokens: usage.output_tokens ?? null,
      cacheReadTokens: usage.cache_read_input_tokens ?? null,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? null,
      costCents: costUsd === null ? null : Math.round(costUsd * 100),
      // Not exposed by this provider. Reported as absent, never as zero.
      percentUsed: null,
      state: this.lastRateLimit?.status ? String(this.lastRateLimit.status) : null,
      reportingPeriod: this.lastRateLimit?.rateLimitType ? String(this.lastRateLimit.rateLimitType) : null,
      raw: { usage: this.lastResultUsage, rateLimit: this.lastRateLimit },
      note: subscription
        ? 'Token counts are exact, as reported by the CLI. The dollar figure is the equivalent API list price ' +
          'for those tokens — this account uses subscription access, so it is NOT money billed.'
        : 'Exact token counts and billed cost, as reported by the CLI under API-key access.',
    };
  }

  async start(task: CodingTask, context: CodingAgentContext): Promise<CodingSessionHandle> {
    const sessionId = `claude-${task.runId}`;
    let seq = 0;
    let providerSessionId: string | null = null;

    const emit = async (event: AgentEventDraft) => {
      await context.onEvent({ ...event, seq: seq++, at: new Date().toISOString() } as AgentEvent);
    };

    /*
     * Fixed argv. The brief is NOT an argument — it goes in on stdin, so no
     * brief content can ever be read as a flag, however it is worded.
     *
     * `--permission-mode acceptEdits` plus `--disallowedTools` are defence in
     * depth only. The control on git is the shim on PATH, which binds whatever
     * the CLI's own permission model does.
     */
    const argv = [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      // Mac pushes; the agent never does. Also blocks the obvious routes to a
      // network write even if the shim were somehow bypassed.
      '--disallowedTools', 'WebFetch',
      ...(this.options.model ? ['--model', this.options.model] : []),
      ...(task.limits.maxBudgetUsd !== null ? ['--max-budget-usd', String(task.limits.maxBudgetUsd)] : []),
      ...(this.options.extraArgs ?? []),
    ];

    const executable = await this.resolveExecutable();
    const launch = this.options.spawner ?? ((exe, args, options) => spawn(exe, [...args], options) as ChildProcessWithoutNullStreams);

    const child = launch(executable, this.argvFor(argv), {
      cwd: this.options.workdir ?? task.worktreePath,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.childEnvironment(),
    }) as ChildProcessWithoutNullStreams;

    this.sessions.set(sessionId, { child, providerSessionId: null });

    const finished = new Promise<AgentSessionResult>((resolve) => {
      let settled = false;
      let summary = '';
      const filesTouched = new Set<string>();
      let failure: string | null = null;
      let lastActivityAt = Date.now();

      const settle = async (result: AgentSessionResult) => {
        if (settled) return;
        settled = true;
        clearInterval(idleTimer);
        this.sessions.delete(sessionId);
        resolve(result);
      };

      const idleTimer = setInterval(() => {
        const idleMs = this.options.idleTimeoutMs ?? 15 * 60_000;
        if (Date.now() - lastActivityAt > idleMs) {
          void emit({ type: 'failed', error: `The coding agent produced no output for ${Math.round(idleMs / 60000)} minutes.`, recoverable: true });
          this.terminate(child);
          void settle({ state: 'failed', summary, error: 'Coding-agent session stalled.', filesTouched: [...filesTouched], usage: null });
        }
      }, 30_000);
      idleTimer.unref();

      const onLine = async (line: string) => {
        lastActivityAt = Date.now();
        const message = parseJsonLine(line);

        if (!message) {
          // Non-JSON output is not a crash. It is surfaced verbatim, because a
          // CLI that prints a warning has told us something worth keeping.
          if (line.trim()) await emit({ type: 'output', stream: 'stdout', message: line.slice(0, 4000) });
          return;
        }

        const handled = await this.handleMessage(message, {
          emit,
          context,
          onProviderSession: (id) => {
            providerSessionId = id;
            const session = this.sessions.get(sessionId);
            if (session) session.providerSessionId = id;
          },
          onFile: (file) => filesTouched.add(file),
          onAnswer: (text) => this.sendUserMessage(child, text),
        });

        if (handled.summary) summary = handled.summary;
        if (handled.failure) failure = handled.failure;
      };

      readLines(child.stdout, (line) => void onLine(line));

      child.stderr.on('data', (chunk: Buffer) => {
        lastActivityAt = Date.now();
        const text = chunk.toString('utf8');
        if (text.trim()) void emit({ type: 'output', stream: 'stderr', message: text.slice(0, 4000) });
      });

      child.on('error', (err) => {
        void emit({ type: 'failed', error: `Could not start the Claude Code CLI: ${err.message}`, recoverable: false });
        void settle({ state: 'failed', summary: '', error: err.message, filesTouched: [...filesTouched], usage: null });
      });

      child.on('close', async (code) => {
        const usage = await this.usageSnapshot('after').catch(() => null);

        if (context.signal.aborted) {
          await emit({ type: 'cancelled', reason: 'Cancelled by the control plane.' });
          await settle({ state: 'cancelled', summary: summary || 'Cancelled part-way through.', filesTouched: [...filesTouched], usage });
          return;
        }

        if (code === 0 && !failure) {
          if (!summary) summary = 'The coding agent finished without producing a summary.';
          await emit({ type: 'completed', summary, filesTouched: [...filesTouched] });
          await settle({ state: 'completed', summary, filesTouched: [...filesTouched], usage });
          return;
        }

        const error =
          failure ??
          (code === REFUSAL_EXIT_CODE
            ? 'The coding agent attempted a prohibited git operation and was refused.'
            : `The Claude Code CLI exited with code ${code}.`);
        await emit({ type: 'failed', error, recoverable: false });
        await settle({ state: 'failed', summary, error, filesTouched: [...filesTouched], usage });
      });

      // Kick the session off with the structured brief. Not the raw human
      // conversation — spec §12 is explicit about that.
      this.sendUserMessage(child, buildInitialPrompt(task));
    });

    // The handle exposes the provider session id lazily, because `system/init`
    // arrives after `start()` returns.
    const handle: CodingSessionHandle = {
      sessionId,
      provider: 'claude_code',
      get providerSessionId() {
        return providerSessionId;
      },
      set providerSessionId(value: string | null) {
        providerSessionId = value;
      },
      finished,
    };

    return handle;
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.terminate(session.child);
  }

  /**
   * Closes stdin first, then SIGTERM, then SIGKILL after a grace period.
   *
   * Closing stdin lets a well-behaved CLI finish its current turn and flush,
   * which is how a cancelled run keeps the partial work it had already
   * committed rather than losing the last few seconds of it.
   */
  private terminate(child: ChildProcessWithoutNullStreams): void {
    try {
      child.stdin.end();
    } catch {
      // Already closed.
    }
    child.kill('SIGTERM');
    const grace = this.options.killGraceMs ?? 10_000;
    const timer = setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, grace);
    timer.unref();
  }

  /**
   * The child's environment.
   *
   * The shim goes FIRST on PATH — that is the entire mechanism by which the
   * agent's `git` becomes policy-checked. Control-plane credentials are removed
   * outright: a coding agent has no business holding the worker's token or the
   * database URL, and the cheapest way to guarantee that is not to pass them.
   */
  private childEnvironment(): NodeJS.ProcessEnv {
    const base = { ...(this.options.env ?? process.env) };

    for (const key of Object.keys(base)) {
      if (/^(MAC_|DATABASE_URL|TEST_DATABASE_URL|SESSION_|SEED_ADMIN)/.test(key)) delete base[key];
    }

    const pathKey = Object.keys(base).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    if (this.options.shimBinDir) {
      base[pathKey] = `${this.options.shimBinDir}${pathDelimiter()}${base[pathKey] ?? ''}`;
    }

    // Interactive prompts would hang an unattended session indefinitely.
    base.GIT_TERMINAL_PROMPT = '0';
    base.CI = '1';

    return base;
  }

  /** Delivers a user message into the live session over stdin. */
  private sendUserMessage(child: ChildProcessWithoutNullStreams, text: string): void {
    const message = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // A closed stdin means the session is already finishing.
    }
  }

  /**
   * Maps one CLI message onto neutral events.
   *
   * Unknown message types are ignored rather than treated as errors: the CLI's
   * stream is not a frozen contract, and a new event type appearing in a future
   * version must not fail a night's work.
   */
  private async handleMessage(
    message: Record<string, unknown>,
    handlers: {
      emit: (event: AgentEventDraft) => Promise<void>;
      context: CodingAgentContext;
      onProviderSession: (id: string) => void;
      onFile: (file: string) => void;
      onAnswer: (text: string) => void;
    },
  ): Promise<{ summary?: string; failure?: string }> {
    const type = String(message.type ?? '');

    if (type === 'system' && message.subtype === 'init') {
      const sessionId = typeof message.session_id === 'string' ? message.session_id : null;
      if (sessionId) handlers.onProviderSession(sessionId);
      await handlers.emit({
        type: 'session_started',
        providerSessionId: sessionId,
        model: typeof message.model === 'string' ? message.model : null,
        providerVersion: typeof message.version === 'string' ? message.version : null,
      });
      return {};
    }

    if (type === 'rate_limit_event') {
      // A genuine samplable provider state. Recorded as a STATE — it is not a
      // percentage and is never converted into one.
      this.lastRateLimit = (message.rate_limit_info ?? null) as Record<string, unknown> | null;
      return {};
    }

    if (type === 'assistant') {
      const content = extractContent(message);
      let sawTool = false;
      let text = '';

      for (const block of content) {
        if (block.type === 'tool_use') {
          sawTool = true;
          const tool = String(block.name ?? 'tool');
          const detail = describeToolUse(tool, block.input as Record<string, unknown> | undefined);
          if (detail.file) handlers.onFile(detail.file);
          await handlers.emit({ type: 'activity', tool: neutralToolName(tool), detail: detail.text });
        } else if (block.type === 'text' && typeof block.text === 'string') {
          text += block.text;
        }
      }

      /*
       * Question detection.
       *
       * The CLI has no explicit "I am asking you something" event, so this is a
       * heuristic and is treated as one: a turn that ended with no tool call and
       * whose text reads as a question is put to Mac. Getting it wrong in one
       * direction costs a redundant recorded Q&A; in the other, the agent
       * proceeds on its own assumption, which the self-review still inspects.
       */
      if (!sawTool && looksLikeQuestion(text)) {
        const questionId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await handlers.emit({ type: 'question', questionId, question: text.slice(0, 4000) });
        const answer = await handlers.context.onQuestion({ questionId, question: text.slice(0, 4000) });
        handlers.onAnswer(formatAnswerForAgent(answer.answer, answer.decision));
      } else if (text.trim()) {
        await handlers.emit({ type: 'progress', stage: 'working', message: text.slice(0, 2000) });
      }

      return {};
    }

    if (type === 'result') {
      this.lastResultUsage = message;
      const isError = message.is_error === true;
      const text = typeof message.result === 'string' ? message.result : '';
      if (isError) {
        return { failure: text || String(message.subtype ?? 'The coding agent reported an error.') };
      }
      return { summary: text };
    }

    return {};
  }

  private async exec(argv: string[]): Promise<string> {
    const executable = await this.resolveExecutable();
    return new Promise((resolve, reject) => {
      execFile(
        executable,
        this.argvFor(argv),
        { shell: false, windowsHide: true, timeout: 60_000, env: this.options.env ?? process.env },
        (error, stdout, stderr) => {
          if (error) reject(new Error(String(stderr || error.message).slice(0, 500)));
          else resolve(String(stdout));
        },
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const pathDelimiter = (): string => (process.platform === 'win32' ? ';' : ':');

/** All matches for a name on PATH, most preferred first. */
async function which(name: string): Promise<string[]> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(finder, [name], { shell: false, windowsHide: true, timeout: 20_000 }, (error, stdout) => {
      if (error) return resolve([]);
      resolve(
        String(stdout)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      );
    });
  });
}

/**
 * Extracts the real target from an npm shim.
 *
 * Both the `.cmd` and the `sh` shim end by invoking an absolute path to the
 * actual binary; the first quoted path in them that exists on disk is it.
 */
async function readShimTarget(shimPath: string): Promise<string | null> {
  const { readFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { dirname, resolve: resolvePath } = await import('node:path');

  for (const candidatePath of [shimPath, `${shimPath}.cmd`]) {
    const contents = await readFile(candidatePath, 'utf8').catch(() => null);
    if (!contents) continue;

    const base = dirname(candidatePath);

    for (const match of contents.matchAll(/"([^"]+)"/g)) {
      const raw = match[1]!;
      if (!/\.(exe|js|cjs|mjs)$/i.test(raw)) continue;

      // `%dp0%` (cmd) and `$basedir` (sh) both mean "the directory this shim
      // lives in"; substituting them turns the shim's reference into a path.
      const expanded = raw
        .replace(/%~?dp0%?/gi, `${base}/`)
        .replace(/\$basedir/g, base)
        .split('\\')
        .join('/');

      const absolute = resolvePath(expanded);
      if (existsSync(absolute)) return absolute;
    }
  }
  return null;
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Splits a stream into lines, tolerating chunks that break mid-line. */
export function readLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buffer = '';
  stream.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      onLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
    // A single line longer than this is not a line; drop it rather than growing
    // the buffer without bound on a misbehaving child.
    if (buffer.length > 4 * 1024 * 1024) buffer = '';
  });
  stream.on('end', () => {
    if (buffer.trim()) onLine(buffer);
    buffer = '';
  });
}

function extractContent(message: Record<string, unknown>): Array<Record<string, unknown>> {
  const inner = message.message as { content?: unknown } | undefined;
  const content = inner?.content;
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
}

/** Maps a provider tool name onto Mac's vocabulary, so the UI stays neutral. */
export function neutralToolName(tool: string): string {
  const lower = tool.toLowerCase();
  if (lower === 'edit' || lower === 'write' || lower === 'notebookedit') return 'edit';
  if (lower === 'read' || lower === 'notebookread') return 'read';
  if (lower === 'bash' || lower === 'powershell') return 'command';
  if (lower === 'grep' || lower === 'glob' || lower === 'search') return 'search';
  if (lower === 'task' || lower === 'agent') return 'subagent';
  if (lower.startsWith('web')) return 'web';
  return 'tool';
}

function describeToolUse(tool: string, input: Record<string, unknown> | undefined): { text: string; file?: string } {
  if (!input) return { text: tool };
  const file = typeof input.file_path === 'string' ? input.file_path : undefined;
  if (file) return { text: `${tool}: ${file}`, file };
  if (typeof input.command === 'string') return { text: `${tool}: ${input.command.slice(0, 300)}` };
  if (typeof input.pattern === 'string') return { text: `${tool}: ${input.pattern.slice(0, 200)}` };
  return { text: tool };
}

/**
 * Whether an assistant turn reads as a question to the human.
 *
 * Requires a question mark AND an interrogative opening, because plenty of
 * ordinary narration contains a rhetorical "?" and treating each one as a
 * blocking question would stall the session.
 */
export function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || !trimmed.includes('?')) return false;
  if (trimmed.length > 4000) return false;
  return /(^|\n)\s*(should|shall|do you|would you|could you|can you|which|what|where|is it|are you|may i|do i|am i|please confirm|let me know)\b/i.test(
    trimmed,
  );
}

/** Frames Mac's answer so the agent knows it is an instruction, not chatter. */
export function formatAnswerForAgent(answer: string, decision: string): string {
  const prefix =
    decision === 'blocked'
      ? 'Mac (your manager) has decided this is out of scope for this run:'
      : decision === 'assumed'
        ? 'Mac (your manager) is not fully certain, but instructs the following:'
        : 'Mac (your manager) answers:';
  return `${prefix}\n\n${answer}\n\nContinue with the work on that basis. Do not ask this again.`;
}

/**
 * The opening prompt.
 *
 * The STRUCTURED brief, plus the standing rules the agent works under. Note
 * that the git rules appear here as well as in the shim — not because the
 * prompt enforces them (it does not, and cannot), but because an agent told
 * what it may not do wastes less time attempting it.
 */
export function buildInitialPrompt(task: CodingTask): string {
  const lines: string[] = [];

  lines.push(
    'You are implementing a task on behalf of Mac Bennett, an automation engineer at PAC Technologies.',
    'Mac has already done discovery with the human and produced the brief below. Work from the brief.',
    '',
    '## Standing rules',
    '',
    `- You are in an isolated git worktree on branch \`${task.branch}\`, based on \`${task.baseBranch}\`.`,
    '- Commit your work as you go. Anything left uncommitted is not part of the result.',
    `- You may NEVER merge into \`${task.baseBranch}\`, push to it, force-push, or delete it. These are enforced`,
    '  outside this session and attempts will be refused and reported.',
    '- Do not push at all. Mac pushes the branch himself after reviewing your work.',
    '- If you need a decision Mac has not covered, ask a direct question and wait. Mac will answer.',
    '',
    '## Engineering discipline expected',
    '',
    '1. Understand the brief and inspect the relevant code before changing anything.',
    '2. Plan the change.',
    '3. Implement a small slice.',
    '4. Run the tests and read the output.',
    '5. Debug and iterate until they pass.',
    '6. Self-review your own diff before declaring completion.',
    '7. Run the full test suite once more at the end.',
    '',
  );

  if (task.testCommand.length) {
    lines.push(`Tests for this repository are run with: \`${task.testCommand.join(' ')}\``, '');
  }
  if (task.buildCommand.length) {
    lines.push(`The build/typecheck command is: \`${task.buildCommand.join(' ')}\``, '');
  }

  lines.push('---', '', task.briefMarkdown, '', '---', '', 'Begin.');

  return lines.join('\n');
}
