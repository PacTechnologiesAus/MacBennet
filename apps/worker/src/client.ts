import type {
  CompleteRequest,
  CompleteResponse,
  ControlEnvelope,
  HeartbeatRequest,
  HeartbeatResponse,
  LeaseResponse,
  LogEntry,
  LogBatchResponse,
  ProgressRequest,
  ProgressResponse,
  RegisterRequest,
  RegisterResponse,
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
    opts: { token?: string; timeoutMs?: number; retry?: boolean; attempts?: number } = {},
  ): Promise<T> {
    const token = opts.token ?? this.token;
    if (!token) throw new Error('No credential available for the control plane.');

    const attempts = opts.retry === false ? 1 : (opts.attempts ?? this.maxAttempts);
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      // The lease long-polls for up to 25s; other calls should fail fast.
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);

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
    return this.request<CompleteResponse>(`/api/worker/runs/${runId}/complete`, body, { attempts: 10 });
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function describe(err: unknown): string {
  if (err instanceof ControlPlaneError) return `${err.status} ${err.code}`;
  if (err instanceof Error) return err.name === 'AbortError' ? 'timed out' : err.message;
  return String(err);
}
