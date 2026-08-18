import type { FastifyInstance } from 'fastify';
import {
  agentEventBatchRequestSchema,
  askQuestionRequestSchema,
  completeRequestSchema,
  contextSnapshotRequestSchema,
  gitViolationReportRequestSchema,
  heartbeatRequestSchema,
  leaseRequestSchema,
  logBatchRequestSchema,
  progressRequestSchema,
  pullRequestReportRequestSchema,
  registerRequestSchema,
  rotateTokenRequestSchema,
  runSandboxReportRequestSchema,
  sandboxAttestationRequestSchema,
  submitReviewRequestSchema,
  usageSnapshotRequestSchema,
  worktreeReportRequestSchema,
  ENROLLMENT_TOKEN_PREFIX,
  PROTOCOL_VERSION,
  researchStepRequestSchema,
} from '@mac/protocol';
import { AppError } from '../errors.js';
import { bearerToken, currentWorker, requireWorkerAuth } from '../worker-auth.js';
import {
  buildControlEnvelope,
  recordHeartbeat,
  recordSandboxAttestation,
  registerWorker,
} from '../../services/workers.js';
import { rotateWorkerToken } from '../../services/worker-credentials.js';
import { completeRun, leaseNextRun, recordProgress } from '../../services/runs.js';
import { appendWorkerLogs } from '../../services/logs.js';
import {
  ingestAgentEvents,
  recordGitViolation,
  recordRunSandbox,
  recordWorktree,
  startAgentSession,
} from '../../services/coding-sessions.js';
import { answerAgentQuestion } from '../../services/supervision.js';
import { recordPullRequest, submitReview } from '../../services/reviews.js';
import { recordUsageSnapshot } from '../../services/usage.js';
import { recordContextSnapshot } from '../../services/discovery.js';
import { ensureGeneralPlan } from '../../services/general-runs.js';
import { performResearchStep } from '../../services/research/runner.js';
import { recordFetch } from '../../services/repositories.js';
import { record } from '../../services/audit.js';
import { db } from '../../db/client.js';
import { discoverySessions, runs } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * The worker plane.
 *
 * Everything here is initiated by the worker over outbound HTTPS; the control
 * plane never dials a worker. That means the worker VM needs no inbound port,
 * no public address and no certificate, which is a materially smaller attack
 * surface for a machine that will eventually run coding agents.
 *
 * Every response carries the control envelope, so a cancellation reaches the
 * worker on whichever call happens next rather than only on the heartbeat.
 */

/** Long-poll bounds. 25s sits below the common 30/60s proxy idle timeouts. */
const MAX_LEASE_WAIT_MS = 25_000;
const LEASE_POLL_INTERVAL_MS = 500;

export async function workerRoutes(
  app: FastifyInstance,
  opts: { registerRateLimitMax?: number } = {},
): Promise<void> {
  // --- Registration (enrollment token, not worker token) -------------------

  app.post('/api/worker/register', {
    config: { rateLimit: { max: opts.registerRateLimitMax ?? 10, timeWindow: '5 minutes' } },
    handler: async (request, reply) => {
      const token = bearerToken(request);
      if (!token || !token.startsWith(ENROLLMENT_TOKEN_PREFIX)) {
        throw AppError.unauthorized('A worker enrollment token is required.');
      }

      const body = registerRequestSchema.parse(request.body);
      if (body.protocolVersion !== PROTOCOL_VERSION) {
        throw AppError.badRequest(
          'PROTOCOL_VERSION_MISMATCH',
          `This control plane speaks worker protocol v${PROTOCOL_VERSION}; the worker offered v${body.protocolVersion}.`,
        );
      }

      const result = await registerWorker(token, { ...body, sandbox: body.sandbox });
      const control = await buildControlEnvelope(result.workerId);
      return reply.status(201).send({ control, ...result });
    },
  });

  // --- Everything below requires a worker token ---------------------------

  app.register(async (scope) => {
    scope.addHook('preHandler', requireWorkerAuth);

    scope.post('/api/worker/heartbeat', async (request, reply) => {
      const worker = currentWorker(request);
      const body = heartbeatRequestSchema.parse(request.body);
      const workerStatus = await recordHeartbeat(worker, {
        status: body.status,
        currentRunId: body.currentRunId,
        sandbox: body.sandbox,
      });
      const control = await buildControlEnvelope(worker.id);
      return reply.send({ control, workerStatus });
    });

    /**
     * The worker replaces its own credential (Sprint 3 §4).
     *
     * Authenticated with the token being replaced, so possession of the current
     * credential is what authorises its replacement — the same property that
     * makes the two-stage enrollment safe. The new token is returned exactly
     * once and exists in plaintext nowhere else.
     *
     * Rate-limited harder than the rest of the plane: repeated rotation is
     * either a bug or someone probing, and neither should be cheap.
     */
    scope.post('/api/worker/rotate-token', {
      config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
      handler: async (request, reply) => {
        const worker = currentWorker(request);
        const body = rotateTokenRequestSchema.parse(request.body ?? {});
        const result = await rotateWorkerToken(worker, body);
        const control = await buildControlEnvelope(worker.id);
        return reply.send({
          control,
          workerToken: result.token,
          previousTokenValidForSeconds: result.previousTokenValidForSeconds,
          issuedAt: result.issuedAt,
        });
      },
    });

    /** Out-of-band containment attestation. Normally rides the heartbeat. */
    scope.post('/api/worker/sandbox-attestation', async (request, reply) => {
      const worker = currentWorker(request);
      const body = sandboxAttestationRequestSchema.parse(request.body);
      const result = await recordSandboxAttestation(worker, body.sandbox);
      const control = await buildControlEnvelope(worker.id);
      return reply.send({ control, accepted: true, codingWorkWithheld: result.codingWorkWithheld });
    });

    /**
     * Long-polls for an approved, queued run.
     *
     * Polling in-process rather than using LISTEN/NOTIFY keeps the whole
     * dispatch path in one transaction-shaped piece of code. At Sprint 1 scale
     * (one worker, human-initiated runs) a 500 ms tick is free; if worker
     * count grows this is the obvious place to add NOTIFY.
     */
    scope.post('/api/worker/lease', async (request, reply) => {
      const worker = currentWorker(request);
      const body = leaseRequestSchema.parse(request.body ?? {});
      const deadline = Date.now() + Math.min(body.waitSeconds * 1000, MAX_LEASE_WAIT_MS);

      const capabilities = Array.isArray(worker.capabilities) ? (worker.capabilities as string[]) : [];

      for (;;) {
        const assignment = await leaseNextRun({
          id: worker.id,
          name: worker.name,
          capabilities,
          sandboxReady: worker.sandboxReady,
        });
        if (assignment) {
          const control = await buildControlEnvelope(worker.id);
          return reply.send({ control, assignment });
        }
        if (Date.now() >= deadline) break;
        // Abandon the poll if the worker hangs up, so a restarting worker does
        // not leave the control plane holding a doomed connection.
        if (request.socket.destroyed) return reply;
        await sleep(Math.min(LEASE_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
      }

      const control = await buildControlEnvelope(worker.id);
      return reply.send({ control, assignment: null });
    });

    scope.post('/api/worker/runs/:runId/progress', async (request, reply) => {
      const worker = currentWorker(request);
      const { runId } = request.params as { runId: string };
      const body = progressRequestSchema.parse(request.body);
      await assertRunBelongsToWorker(runId, worker.id, worker.name);

      await recordProgress(runId, { id: worker.id, name: worker.name }, {
        stage: body.stage,
        percent: body.percent ?? null,
        ...(body.message !== undefined ? { message: body.message } : {}),
      });

      const control = await buildControlEnvelope(worker.id);
      return reply.send({ control, accepted: true });
    });

    scope.post('/api/worker/runs/:runId/logs', async (request, reply) => {
      const worker = currentWorker(request);
      const { runId } = request.params as { runId: string };
      const body = logBatchRequestSchema.parse(request.body);
      await assertRunBelongsToWorker(runId, worker.id, worker.name);

      const result = await appendWorkerLogs(runId, body.entries);
      const control = await buildControlEnvelope(worker.id);
      return reply.send({ control, ...result });
    });

    scope.post('/api/worker/runs/:runId/complete', async (request, reply) => {
      const worker = currentWorker(request);
      const { runId } = request.params as { runId: string };
      const body = completeRequestSchema.parse(request.body);
      await assertRunBelongsToWorker(runId, worker.id, worker.name);

      const runStatus = await completeRun(runId, { id: worker.id, name: worker.name }, {
        outcome: body.outcome,
        stopReason: body.stopReason ?? null,
        ...(body.summary !== undefined ? { summary: body.summary } : {}),
        confidence: body.confidence ?? null,
      });

      const control = await buildControlEnvelope(worker.id);
      return reply.send({ control, runStatus });
    });

    // -----------------------------------------------------------------------
    // Sprint 2 — coding sessions
    //
    // Every route below carries the same two properties as the Sprint 1 ones:
    // it is initiated by the worker over outbound HTTPS, and it is scoped to a
    // run assigned to that worker. Nothing here opens an inbound path to the
    // VM, and nothing here accepts a command.
    // -----------------------------------------------------------------------

    /** The worker reports the isolated worktree it created for this run. */
    scope.post('/api/worker/runs/:runId/worktree', async (request, reply) => {
      const worker = currentWorker(request);
      const { runId } = request.params as { runId: string };
      const body = worktreeReportRequestSchema.parse(request.body);
      await assertRunBelongsToWorker(runId, worker.id, worker.name);

      const [run] = await db.select({ repositoryId: runs.repositoryId }).from(runs).where(eq(runs.id, runId)).limit(1);
      if (!run?.repositoryId) {
        throw AppError.conflict('NOT_A_REPOSITORY_RUN', 'This run has no repository, so it cannot have a worktree.');
      }

      const result = await recordWorktree(runId, run.repositoryId, body, workerActor(worker));
      if (body.status === 'active') await recordFetch(run.repositoryId, body.baseSha);

      const control = await buildControlEnvelope(worker.id);
      return reply.send({ control, ...result });
    });

    scope.post('/api/worker/runs/:runId/agent-session', async (request, reply) => {
      const worker = currentWorker(request);
      const { runId } = request.params as { runId: string };
      const body = request.body as {
        provider: 'claude_code' | 'mock';
        providerSessionId?: string | null;
        providerVersion?: string | null;
        model?: string | null;
      };
      await assertRunBelongsToWorker(runId, worker.id, worker.name);

      const session = await startAgentSession(runId, body, workerActor(worker));
      const control = await buildControlEnvelope(worker.id);
      return reply.send({ control, session });
    });

    scope.post('/api/worker/runs/:runId/agent-events', async (request, reply) => {
      const worker = currentWorker(request);
      const { runId } = request.params as { runId: string };
      const body = agentEventBatchRequestSchema.parse(request.body);
      await assertRunBelongsToWorker(runId, worker.id, worker.name);

      const result = await ingestAgentEvents(runId, body, workerActor(worker));
      const control = await buildControlEnvelope(worker.id);
      return reply.send({ control, ...result });
    });

    /**
     * The supervision endpoint.
     *
     * The worker asks; MAC answers. The worker has no answering logic of its
     * own, which is what keeps every decision made during an autonomous run in
     * the control plane where it is persisted, audited and reviewable.
     */
    scope.post('/api/worker/runs/:runId/questions', async (request, reply) => {
      const worker = currentWorker(request);
      const { runId } = request.params as { runId: string };
      const body = askQuestionRequestSchema.parse(request.body);
      await assertRunBelongsToWorker(runId, worker.id, worker.name);

      const outcome = await answerAgentQuestion(runId, body, workerActor(worker));
      const control = await buildControlEnvelope(worker.id);
      return reply.send({ control, answer: outcome.answer });
    });

    /**
     * A refused git operation. Separate from the log endpoint because this is a
     * security event: it must be countable, queryable, and impossible to lose
     * in log volume — and its presence blocks pull-request creation.
     */
    scope.post('/api/worker/runs/:runId/git-violation', async (request, reply) => {
      const worker = currentWorker(request);
      const { runId } = request.params as { runId: string };
      const body = gitViolationReportRequestSchema.parse(request.body);
      await assertRunBelongsToWorker(runId, worker.id, worker.name);

      await recordGitViolation(runId, body, workerActor(worker));
      const control = await buildControlEnvelope(worker.id);
      return reply.send({ control, accepted: true });
    });

    /**
     * The containment established for THIS run.
     *
     * Reported by the worker at the moment the sandbox opens — or fails to —
     * so "was this diff produced inside a boundary?" is a queryable fact rather
     * than something a reviewer has to infer from a log line.
     */
    scope.post('/api/worker/runs/:runId/sandbox', async (request, reply) => {
      const worker = currentWorker(request);
      const { runId } = request.params as { runId: string };
      const body = runSandboxReportRequestSchema.parse(request.body);
      await assertRunBelongsToWorker(runId, worker.id, worker.name);

      await recordRunSandbox(runId, body.sandbox, workerActor(worker));
      const control = await buildControlEnvelope(worker.id);
      return reply.send({ control, accepted: true });
    });

    scope.post('/api/worker/runs/:runId/usage', async (request, reply) => {
      const worker = currentWorker(request);
      const { runId } = request.params as { runId: string };
      const body = usageSnapshotRequestSchema.parse(request.body);
      await assertRunBelongsToWorker(runId, worker.id, worker.name);

      await recordUsageSnapshot(runId, body.snapshot, workerActor(worker));
      const control = await buildControlEnvelope(worker.id);
      return reply.send({ control, accepted: true });
    });

    /**
     * The worker submits FACTS; Mac returns the verdict and, when he decides one
     * is warranted, the exact pull request to open. The worker never decides
     * whether a pull request should exist.
     */
    scope.post('/api/worker/runs/:runId/review', async (request, reply) => {
      const worker = currentWorker(request);
      const { runId } = request.params as { runId: string };
      const body = submitReviewRequestSchema.parse(request.body);
      await assertRunBelongsToWorker(runId, worker.id, worker.name);

      const verdict = await submitReview(runId, body.evidence, workerActor(worker));
      const control = await buildControlEnvelope(worker.id);
      return reply.send({ control, ...verdict });
    });

    scope.post('/api/worker/runs/:runId/pull-request', async (request, reply) => {
      const worker = currentWorker(request);
      const { runId } = request.params as { runId: string };
      const body = pullRequestReportRequestSchema.parse(request.body);
      await assertRunBelongsToWorker(runId, worker.id, worker.name);

      const result = await recordPullRequest(runId, body, workerActor(worker));
      const control = await buildControlEnvelope(worker.id);
      return reply.send({ control, ...result });
    });

    /** Discovery Phase A: the read-only repository inspection result. */
    scope.post('/api/worker/runs/:runId/context-snapshot', async (request, reply) => {
      const worker = currentWorker(request);
      const { runId } = request.params as { runId: string };
      const body = contextSnapshotRequestSchema.parse(request.body);
      await assertRunBelongsToWorker(runId, worker.id, worker.name);

      const [run] = await db.select({ taskId: runs.taskId }).from(runs).where(eq(runs.id, runId)).limit(1);
      if (!run) throw AppError.notFound('Run');

      const [session] = await db
        .select({ id: discoverySessions.id })
        .from(discoverySessions)
        .where(eq(discoverySessions.taskId, run.taskId))
        .limit(1);

      if (session) {
        await recordContextSnapshot(session.id, body.snapshot, workerActor(worker));
      }
      await recordFetch(body.snapshot.repositoryId, body.snapshot.headSha);

      const control = await buildControlEnvelope(worker.id);
      return reply.send({ control, accepted: true });
    });

    /**
     * Sprint 3.3: perform one reasoning step of a general run.
     *
     * The whole of general work's model access lives behind this endpoint. The
     * worker supplies nothing but its own identity and the run id — no prompt,
     * no tool, no provider, no scope — and everything the step touches is
     * resolved here from the run row.
     *
     * `assertRunBelongsToWorker` is what makes that safe: a worker cannot ask
     * for a step of somebody else's run, so it cannot use this endpoint to reach
     * a project it was never assigned.
     */
    scope.post('/api/worker/runs/:runId/research-step', async (request, reply) => {
      const worker = currentWorker(request);
      const { runId } = request.params as { runId: string };
      researchStepRequestSchema.parse(request.body ?? {});
      await assertRunBelongsToWorker(runId, worker.id, worker.name);

      // Idempotent, and here as well as at dispatch so a worker that reconnects
      // mid-run does not find itself planless.
      await ensureGeneralPlan(runId);

      const result = await performResearchStep(runId, {}, workerActor(worker));

      const control = await buildControlEnvelope(worker.id);
      return reply.send({ control, ...result });
    });
  });
}

/** Worker-authored audit events carry the worker's NAME, not its uuid. */
const workerActor = (worker: { id: string; name: string }) =>
  ({ type: 'worker' as const, id: worker.id, label: worker.name });

/**
 * Authorisation, distinct from authentication: an authenticated worker may act
 * only on runs assigned to it. A breach here is worth auditing, because it
 * means either a bug or a compromised token.
 */
async function assertRunBelongsToWorker(runId: string, workerId: string, workerName: string): Promise<void> {
  const [run] = await db.select({ workerId: runs.workerId, taskId: runs.taskId }).from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) throw AppError.notFound('Run');
  if (run.workerId !== workerId) {
    await db.transaction(async (tx) => {
      await record(tx, {
        actor: { type: 'worker', id: workerId, label: workerName },
        eventType: 'worker.unauthorized_run_access',
        context: { runId, taskId: run.taskId, workerId },
        metadata: { assignedWorkerId: run.workerId },
      });
    });
    throw AppError.forbidden('This run is not assigned to you.');
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
