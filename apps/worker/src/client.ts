import {
  MAX_COMPLETION_SUMMARY_CHARS,
  type CompleteRequest,
  type CompleteResponse,
  type ControlEnvelope,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type LeaseResponse,
  type LogEntry,
  type LogBatchResponse,
  type ProgressRequest,
  type ProgressResponse,
  type RegisterRequest,
  type RegisterResponse,
  type AgentEventBatchRequest,
  type AgentEventBatchResponse,
  type AskQuestionRequest,
  type AskQuestionResponse,
  type ContextSnapshotRequest,
  type ContextSnapshotResponse,
  type ResearchStepResponse,
  type GitViolationReportRequest,
  type GitViolationReportResponse,
  type PullRequestReportRequest,
  type PullRequestReportResponse,
  type ReviewVerdictResponse,
  type RotateTokenRequest,
  type RotateTokenResponse,
  type RunSandboxReportRequest,
  type RunSandboxReportResponse,
  type SandboxAttestationRequest,
  type SandboxAttestationResponse,
  type SubmitReviewRequest,
  type UsageSnapshotRequest,
  type UsageSnapshotResponse,
  type WorktreeReportRequest,
  type WorktreeReportResponse,
} from '@mac/protocol';
import type { Logger } from './logger.js';

/**
 * HTTP client for the control plane.
 *
 * Every call is treated as retryable, because the alternative — losing a
 * completion report because a router rebooted — is the failure mode that makes
 * an autonomous worker untrustworthy. Retries use full-jitter exponential
 * backoff so a control plane coming back up is not stampeded.
 *
 * The one deliberate exception is 4xx: a rejected request will be rejected
 * again, so retrying it is pointless and hides the real problem.
 */

export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ControlPlaneError';
  }

  /** 4xx means "you asked wrongly"; retrying cannot help. */
  get isPermanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

export interface ClientOptions {
  baseUrl: string;
  token: string | null;
  logger: Logger;
  /** Overridable so tests do not wait real seconds. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
}

export class ControlPlaneClient {
  private token: string | null;
  private readonly baseUrl: string;
  private readonly logger: Logger;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;

  /** Last control envelope seen on any response — how cancellation arrives. */
  lastControl: ControlEnvelope | null = null;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.logger = options.logger;
    this.retryBaseMs = options.retryBaseMs ?? 1000;
    this.retryMaxMs = options.retryMaxMs ?? 30_000;
    this.maxAttempts = options.maxAttempts ?? 6;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  setToken(token: string): void {
    this.token = token;
  }

  private async request<T>(
    path: string,
    body: unknown,
    opts: { token?: string; timeoutMs?: number; retry?: boolean; attempts?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const token = opts.token ?? this.token;
    if (!token) throw new Error('No credential available for the control plane.');

    const attempts = opts.retry === false ? 1 : (opts.attempts ?? this.maxAttempts);
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      // The lease long-polls for up to 25s; other calls should fail fast.
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
      /*
       * Sprint 3.3: a cancelled run must abort the request in flight.
       *
       * A research step can run for minutes, and without this an operator's stop
       * would be honoured only after the step returned — which is indefinitely,
       * from their point of view.
       */
      const onAbort = () => controller.abort();
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(body ?? {}),
          signal: controller.signal,
        });

        const text = await response.text();
        const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};

        if (!response.ok) {
          const error = (parsed.error ?? {}) as { code?: string; message?: string };
          const err = new ControlPlaneError(
            response.status,
            error.code ?? 'UNKNOWN',
            error.message ?? `Control plane returned ${response.status}`,
          );
          if (err.isPermanent) throw err;
          lastError = err;
        } else {
          if (parsed.control) this.lastControl = parsed.control as ControlEnvelope;
          return parsed as T;
        }
      } catch (err) {
        if (err instanceof ControlPlaneError && err.isPermanent) throw err;
        lastError = err;
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      }

      if (attempt < attempts) {
        const delay = this.backoffMs(attempt);
        this.logger.warn(
          `${path} failed (attempt ${attempt}/${attempts}): ${describe(lastError)}. Retrying in ${Math.round(delay)}ms.`,
        );
        await sleep(delay);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** Full jitter: spreads a fleet's reconnects instead of synchronising them. */
  private backoffMs(attempt: number): number {
    const ceiling = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (attempt - 1));
    return Math.random() * ceiling;
  }

  // --- Protocol calls ------------------------------------------------------

  register(enrollmentToken: string, body: RegisterRequest): Promise<RegisterResponse> {
    // Not retried on rejection: a used or expired enrollment token will not
    // become valid, and hammering it is exactly what the rate limiter is for.
    return this.request<RegisterResponse>('/api/worker/register', body, { token: enrollmentToken });
  }

  heartbeat(body: HeartbeatRequest): Promise<HeartbeatResponse> {
    return this.request<HeartbeatResponse>('/api/worker/heartbeat', body, { timeoutMs: 10_000 });
  }

  lease(body: { waitSeconds: number; capabilities: string[] }): Promise<LeaseResponse> {
    // Timeout comfortably exceeds the server's 25s poll cap.
    return this.request<LeaseResponse>('/api/worker/lease', body, { timeoutMs: 35_000, retry: false });
  }

  progress(runId: string, body: ProgressRequest): Promise<ProgressResponse> {
    return this.request<ProgressResponse>(`/api/worker/runs/${runId}/progress`, body);
  }

  sendLogs(runId: string, entries: LogEntry[]): Promise<LogBatchResponse> {
    return this.request<LogBatchResponse>(`/api/worker/runs/${runId}/logs`, { entries });
  }

  complete(runId: string, body: CompleteRequest): Promise<CompleteResponse> {
    // Retried hard: a completion that never lands leaves a run stuck
    // "running" forever, which is the worst state for an operator to inherit.
    const request =
      body.summary && body.summary.length > MAX_COMPLETION_SUMMARY_CHARS
        ? { ...body, summary: body.summary.slice(0, MAX_COMPLETION_SUMMARY_CHARS) }
        : body;
    return this.request<CompleteResponse>(`/api/worker/runs/${runId}/complete`, request, { attempts: 10 });
  }

  // --- Sprint 2: coding sessions -------------------------------------------

  reportWorktree(runId: string, body: WorktreeReportRequest): Promise<WorktreeReportResponse> {
    return this.request<WorktreeReportResponse>(`/api/worker/runs/${runId}/worktree`, body);
  }

  startAgentSession(
    runId: string,
    body: { provider: string; providerSessionId?: string | null; providerVersion?: string | null; model?: string | null },
  ): Promise<{ control: ControlEnvelope; session: { id: string } }> {
    return this.request(`/api/worker/runs/${runId}/agent-session`, body);
  }

  sendAgentEvents(runId: string, body: AgentEventBatchRequest): Promise<AgentEventBatchResponse> {
    return this.request<AgentEventBatchResponse>(`/api/worker/runs/${runId}/agent-events`, body);
  }

  /**
   * Asks Mac a question on the coding agent's behalf.
   *
   * Retried harder than an ordinary call and with a long timeout, because the
   * coding session is blocked waiting for the answer: giving up here would
   * strand a live agent rather than merely losing a status update.
   */
  askQuestion(runId: string, body: AskQuestionRequest): Promise<AskQuestionResponse> {
    return this.request<AskQuestionResponse>(`/api/worker/runs/${runId}/questions`, body, {
      attempts: 8,
      timeoutMs: 30_000,
    });
  }

  reportGitViolation(runId: string, body: GitViolationReportRequest): Promise<GitViolationReportResponse> {
    return this.request<GitViolationReportResponse>(`/api/worker/runs/${runId}/git-violation`, body);
  }

  reportUsage(runId: string, body: UsageSnapshotRequest): Promise<UsageSnapshotResponse> {
    return this.request<UsageSnapshotResponse>(`/api/worker/runs/${runId}/usage`, body);
  }

  submitReview(runId: string, body: SubmitReviewRequest): Promise<ReviewVerdictResponse> {
    return this.request<ReviewVerdictResponse>(`/api/worker/runs/${runId}/review`, body, {
      attempts: 8,
      timeoutMs: 30_000,
    });
  }

  reportPullRequest(runId: string, body: PullRequestReportRequest): Promise<PullRequestReportResponse> {
    return this.request<PullRequestReportResponse>(`/api/worker/runs/${runId}/pull-request`, body);
  }

  /**
   * Replaces this worker's own credential.
   *
   * Not retried hard: the current token still works for the length of the
   * overlap window, so a failed rotation is retried on the next heartbeat
   * rather than hammered here. Hammering a credential endpoint is exactly the
   * shape of traffic that should look suspicious.
   */
  rotateToken(body: RotateTokenRequest): Promise<RotateTokenResponse> {
    return this.request<RotateTokenResponse>('/api/worker/rotate-token', body, { attempts: 2, timeoutMs: 15_000 });
  }

  /** The containment established for one run, or the refusal to run without it. */
  reportRunSandbox(runId: string, body: RunSandboxReportRequest): Promise<RunSandboxReportResponse> {
    return this.request<RunSandboxReportResponse>(`/api/worker/runs/${runId}/sandbox`, body);
  }

  reportSandboxAttestation(body: SandboxAttestationRequest): Promise<SandboxAttestationResponse> {
    return this.request<SandboxAttestationResponse>('/api/worker/sandbox-attestation', body);
  }

  reportContextSnapshot(runId: string, body: ContextSnapshotRequest): Promise<ContextSnapshotResponse> {
    return this.request<ContextSnapshotResponse>(`/api/worker/runs/${runId}/context-snapshot`, body, {
      timeoutMs: 30_000,
    });
  }

  /**
   * Sprint 3.3: ask the control plane to perform one reasoning step.
   *
   * The generous timeout is the point of the method. A research step is a model
   * call plus up to six source lookups, so it is minutes rather than seconds —
   * and the worker keeps heartbeating throughout, which is what stops a long but
   * healthy step being mistaken for a stalled run.
   */
  performResearchStep(runId: string, signal?: AbortSignal): Promise<ResearchStepResponse> {
    return this.request<ResearchStepResponse>(
      `/api/worker/runs/${runId}/research-step`,
      {},
      { timeoutMs: 300_000, ...(signal ? { signal } : {}) },
    );
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function describe(err: unknown): string {
  if (err instanceof ControlPlaneError) return `${err.status} ${err.code}`;
  if (err instanceof Error) return err.name === 'AbortError' ? 'timed out' : err.message;
  return String(err);
}
