import os from 'node:os';
import {
  PROTOCOL_VERSION,
  parseJobSpec,
  type ControlEnvelope,
  type RunAssignment,
  type RunOutcome,
  type StopReason,
} from '@mac/protocol';
import { ControlPlaneClient, ControlPlaneError } from './client.js';
import { LogBuffer } from './log-buffer.js';
import { getHandler, JobCancelledError, SUPPORTED_JOB_KINDS, type JobContext } from './jobs/index.js';
import { readState, writeState, type WorkerState } from './state.js';
import { createLogger, type Logger } from './logger.js';
import { attestSandbox, resolveSandbox } from './sandbox/index.js';
import type { WorkerConfig } from './config.js';

/**
 * The worker agent.
 *
 * Shape of the loop:
 *
 *   register (once) → [ heartbeat ‖ lease → execute → report ] forever
 *
 * Everything is worker-initiated over outbound HTTPS. The heartbeat runs on its
 * own timer, independent of job execution, so a long job never looks dead. The
 * lease long-polls, so dispatch is near-instant without a persistent
 * connection to resurrect after a network drop.
 *
 * Cancellation arrives through the `control` envelope on ANY response, which
 * is why the log flush interval (~1s) rather than the heartbeat interval
 * (~10s) bounds how quickly a stop is noticed.
 */

export interface WorkerHandle {
  /** Resolves once the loop has fully stopped. */
  stop: () => Promise<void>;
  /** Exposed for tests and for the completion report. */
  state: WorkerState;
}

export interface RunWorkerOptions {
  config: WorkerConfig;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  /** Test hook: stop after this many completed runs instead of running forever. */
  maxRuns?: number;
  retryBaseMs?: number;
  /**
   * How long each lease poll is held open. 20s in production keeps dispatch
   * near-instant with almost no request volume; tests shorten it so that
   * stopping the worker does not wait out a poll.
   */
  leaseWaitSeconds?: number;
  /**
   * Test seam for the coding job: injects a mock coding agent and a recording
   * pull-request gateway so the whole autonomous loop can be exercised without
   * a paid model or a GitHub account.
   */
  codingOverrides?: Record<string, unknown>;
}

const LOG_FLUSH_MS = 1000;

export async function startWorker(options: RunWorkerOptions): Promise<WorkerHandle> {
  const { config } = options;
  const logger = options.logger ?? createLogger(config.logLevel, config.name);

  const client = new ControlPlaneClient({
    baseUrl: config.controlPlaneUrl,
    token: null,
    logger,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.retryBaseMs !== undefined ? { retryBaseMs: options.retryBaseMs } : {}),
  });

  /*
   * Containment is MEASURED before anything else happens.
   *
   * The worker does not attest a sandbox because its `.env` claims one; it
   * attests because `probe()` ran and succeeded. The attestation is sent at
   * registration and repeated on every heartbeat, so a sandbox that breaks at
   * 02:00 stops coding work within one beat rather than persisting as a stale
   * claim on a dashboard.
   */
  const sandbox = await resolveSandbox({
    provider: config.sandbox.provider,
    image: config.sandbox.image,
  });
  const attestation = attestSandbox(sandbox);

  if (attestation.available) {
    logger.info(`Execution sandbox: ${attestation.kind}${attestation.version ? ` (${attestation.version})` : ''}.`);
  } else {
    logger.warn(
      `No execution sandbox is available (${attestation.kind}). ${attestation.detail ?? ''} ` +
        'The control plane will withhold coding work from this worker while it requires containment.',
    );
  }

  const state = await ensureRegistered(config, client, logger, attestation);
  client.setToken(state.workerToken);
  logger.info(`Registered as "${state.name}" (${state.workerId}).`);

  let running = true;
  let rotating = false;
  let currentRunId: string | null = null;
  let completedRuns = 0;
  let heartbeatMs = config.heartbeatSeconds * 1000;
  let stopResolve: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    stopResolve = resolve;
  });

  // --- Heartbeat, on its own cadence so a long job never looks dead ---------

  const beat = async () => {
    if (!running) return;
    try {
      const response = await client.heartbeat({
        status: currentRunId ? 'busy' : 'idle',
        currentRunId,
        metrics: {
          uptimeSeconds: Math.round(process.uptime()),
          freeMemoryBytes: os.freemem(),
        },
        sandbox: attestation,
      });
      // The server owns the cadence, so it can be tuned centrally.
      heartbeatMs = response.control.heartbeatIntervalSeconds * 1000;
      await maybeRotate(response.control.rotateTokenRequested);
    } catch (err) {
      // A missed heartbeat is expected during a network partition. The control
      // plane will mark this worker offline and a human will see it; the worker
      // keeps working and recovers on its own.
      logger.warn(`Heartbeat failed: ${(err as Error).message}`);
    }
  };

  /**
   * Replaces this worker's credential when the control plane asks.
   *
   * The request arrives on the control envelope, which is on every response, so
   * no inbound connection to the VM is needed and nobody has to log into it —
   * which was the whole requirement.
   *
   * Order matters and is the reason this is not three lines: the new token is
   * PERSISTED BEFORE it is adopted. A crash between the two leaves the state
   * file holding a token the server considers active and the client holding one
   * inside its overlap window, and both work. Doing it the other way round
   * leaves a rebooted VM with a credential nobody recorded.
   */
  const maybeRotate = async (requested: boolean): Promise<void> => {
    if (!requested || rotating) return;
    rotating = true;
    try {
      const response = await client.rotateToken({ reason: 'server_requested' });
      const next: WorkerState = { ...state, workerToken: response.workerToken, rotatedAt: new Date().toISOString() };
      await writeState(config.stateFile, next);
      state.workerToken = response.workerToken;
      client.setToken(response.workerToken);
      logger.info(
        `Worker credential rotated. The previous token remains valid for ${response.previousTokenValidForSeconds}s.`,
      );
    } catch (err) {
      // The old credential still works — that is what the overlap window is
      // for — so a failed rotation is retried on the next beat rather than
      // bricking the worker.
      logger.warn(`Credential rotation failed, keeping the current token: ${(err as Error).message}`);
    } finally {
      rotating = false;
    }
  };

  const heartbeatTimer = setInterval(() => void beat(), heartbeatMs);
  heartbeatTimer.unref();
  await beat();

  // --- Main lease/execute loop ---------------------------------------------

  const loop = async () => {
    while (running) {
      try {
        const response = await client.lease({
          waitSeconds: options.leaseWaitSeconds ?? 20,
          capabilities: SUPPORTED_JOB_KINDS,
        });
        if (!running) break;

        const assignment = response.assignment;
        if (!assignment) continue;

        currentRunId = assignment.runId;
        logger.info(`Received run ${assignment.runId} (${assignment.jobKind}) for task "${assignment.taskTitle}".`);
        await executeAssignment(assignment);
        currentRunId = null;
        completedRuns += 1;

        if (options.maxRuns !== undefined && completedRuns >= options.maxRuns) {
          running = false;
          break;
        }
      } catch (err) {
        currentRunId = null;
        if (!running) break;
        if (err instanceof ControlPlaneError && err.isPermanent) {
          logger.error(`Control plane rejected the lease: ${err.code} — ${err.message}`);
        } else {
          logger.warn(`Lease failed: ${(err as Error).message}`);
        }
        // Backoff before retrying, so a control plane that is down does not get
        // hammered by a tight loop.
        await sleep(options.retryBaseMs ?? 2000);
      }
    }
    clearInterval(heartbeatTimer);
    stopResolve?.();
  };

  // --- Executing one assignment --------------------------------------------

  async function executeAssignment(assignment: RunAssignment): Promise<void> {
    const buffer = new LogBuffer();
    const controller = new AbortController();
    let cancelReason: StopReason | null = null;

    const noticeCancellation = (control: ControlEnvelope | null) => {
      if (!control?.cancelRequested) return;
      if (control.cancelRunId && control.cancelRunId !== assignment.runId) return;
      if (!controller.signal.aborted) {
        cancelReason = control.cancelReason ?? 'cancelled_by_user';
        logger.info(`Stop requested for run ${assignment.runId} (${cancelReason}). Aborting.`);
        buffer.append(`Stop requested by the control plane (${cancelReason}).`, 'system');
        controller.abort();
      }
    };

    const flush = async () => {
      try {
        await buffer.flush(async (entries) => {
          await client.sendLogs(assignment.runId, entries);
          // Cancellation piggybacks on the log upload, which is why a stop is
          // seen within about a second rather than within a heartbeat.
          noticeCancellation(client.lastControl);
        });
      } catch (err) {
        // Lines stay buffered and go out on the next flush.
        logger.warn(`Log upload failed, ${buffer.pendingCount} line(s) still buffered: ${(err as Error).message}`);
      }
    };

    const flushTimer = setInterval(() => void flush(), LOG_FLUSH_MS);
    flushTimer.unref();

    const ctx: JobContext = {
      log: (message, stream = 'stdout') => buffer.append(message, stream),
      progress: async (stage, percent) => {
        try {
          const response = await client.progress(assignment.runId, {
            stage,
            percent: percent ?? null,
          });
          noticeCancellation(response.control);
        } catch (err) {
          // Progress is advisory. Losing a stage update must not fail a job.
          logger.warn(`Progress update failed: ${(err as Error).message}`);
        }
      },
      signal: controller.signal,
      workspace: config.workspace,
      // Supplied for the repository jobs; the Sprint 1 handlers ignore them.
      assignment,
      client,
      sandboxOptions: {
        provider: config.sandbox.provider,
        image: config.sandbox.image,
        toolingMounts: config.sandbox.toolingMounts,
        credentialMounts: config.sandbox.credentialMounts,
        agentEnv: config.sandbox.agentEnv,
        nodePath: config.sandbox.nodePath,
        gitPath: config.sandbox.gitPath,
        ...(config.sandbox.uid !== undefined ? { uid: config.sandbox.uid } : {}),
        ...(config.sandbox.gid !== undefined ? { gid: config.sandbox.gid } : {}),
        // Named so the plan builder can REFUSE to mount it, rather than merely
        // happening not to.
        workerStateFile: config.stateFile,
      },
      ...(options.codingOverrides ? { codingOverrides: options.codingOverrides } : {}),
    };

    let outcome: RunOutcome = 'failed';
    let stopReason: StopReason | null = null;
    let summary = '';

    try {
      /*
       * Validation point three: the worker independently re-checks the job
       * against the shared allowlist. The control plane already validated it
       * twice, but a worker that trusts whatever it is handed is a worker that
       * executes whatever a compromised control plane sends.
       */
      const parsed = parseJobSpec(assignment.jobKind, assignment.jobParams);
      const handler = getHandler(assignment.jobKind);

      if (!parsed.ok || !handler) {
        buffer.append(
          `Refusing job "${assignment.jobKind}": not in this worker's allowlist (${parsed.ok ? 'no handler' : parsed.error}).`,
          'stderr',
        );
        outcome = 'failed';
        stopReason = 'unsupported_job_kind';
        summary = `Unsupported job kind "${assignment.jobKind}".`;
      } else {
        buffer.append(`Starting ${assignment.jobKind} for task "${assignment.taskTitle}".`, 'system');
        await ctx.progress('starting', 0);

        const result = await handler(parsed.job.params as Record<string, unknown>, ctx);
        outcome = 'succeeded';
        stopReason = 'completed';
        summary = result.summary;
        buffer.append(`Finished: ${summary}`, 'system');
      }
    } catch (err) {
      if (err instanceof JobCancelledError || controller.signal.aborted) {
        outcome = 'cancelled';
        stopReason = cancelReason ?? 'cancelled_by_user';
        summary = 'Cancelled at the control plane\'s request.';
        buffer.append('Job aborted.', 'system');
      } else {
        outcome = 'failed';
        stopReason = 'failed';
        summary = (err as Error).message;
        buffer.append(`Job failed: ${summary}`, 'stderr');
        logger.error(`Run ${assignment.runId} failed: ${summary}`);
      }
    } finally {
      clearInterval(flushTimer);
    }

    // Flush before reporting so the log is complete by the time an operator
    // sees the terminal status.
    await flush();

    try {
      const response = await client.complete(assignment.runId, {
        outcome,
        stopReason,
        summary,
        finalSeq: buffer.highestSeq,
      });
      logger.info(`Run ${assignment.runId} reported as ${outcome} → ${response.runStatus}.`);
    } catch (err) {
      // Retried ten times inside the client already. If it still fails, the run
      // is left visibly stuck for a human rather than silently forgotten.
      logger.error(
        `Could not report completion of run ${assignment.runId}: ${(err as Error).message}. ` +
          'An operator will need to force-cancel it.',
      );
    }

    if (buffer.pendingCount > 0) await flush();
  }

  void loop();

  return {
    state,
    stop: async () => {
      running = false;
      clearInterval(heartbeatTimer);
      await Promise.race([stopped, sleep(40_000)]);
    },
  };
}

/**
 * Reuses a persisted identity when one exists, otherwise enrolls.
 *
 * Restarting a worker must not require a human to mint a new enrollment token,
 * so the happy path after the first start touches no credential at all.
 */
async function ensureRegistered(
  config: WorkerConfig,
  client: ControlPlaneClient,
  logger: Logger,
  sandbox: import('@mac/protocol').SandboxAttestation,
): Promise<WorkerState> {
  const existing = await readState(config.stateFile);
  if (existing && existing.controlPlaneUrl === config.controlPlaneUrl) {
    logger.info(`Reusing stored identity from ${config.stateFile}.`);
    return existing;
  }
  if (existing) {
    logger.warn(
      `Stored identity is for ${existing.controlPlaneUrl} but this worker is configured for ` +
        `${config.controlPlaneUrl}. Re-enrolling.`,
    );
  }

  if (!config.enrollmentToken) {
    throw new Error(
      'No stored worker identity and no MAC_ENROLLMENT_TOKEN.\n' +
        'Create one in the UI under Workers → New enrollment token, then set it in the worker .env.',
    );
  }

  const response = await client.register(config.enrollmentToken, {
    name: config.name,
    capabilities: SUPPORTED_JOB_KINDS,
    version: '0.1.0',
    platform: `${os.platform()}-${os.arch()}-node${process.versions.node}`,
    protocolVersion: PROTOCOL_VERSION,
    sandbox,
  });

  const state: WorkerState = {
    workerId: response.workerId,
    workerToken: response.workerToken,
    name: config.name,
    controlPlaneUrl: config.controlPlaneUrl,
    registeredAt: new Date().toISOString(),
  };

  await writeState(config.stateFile, state);
  logger.info(`Enrolled. Worker token stored in ${config.stateFile} (mode 0600).`);
  return state;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
