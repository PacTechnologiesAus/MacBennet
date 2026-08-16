import type { FastifyInstance } from 'fastify';
import {
  completeRequestSchema,
  heartbeatRequestSchema,
  leaseRequestSchema,
  logBatchRequestSchema,
  progressRequestSchema,
  registerRequestSchema,
  ENROLLMENT_TOKEN_PREFIX,
  PROTOCOL_VERSION,
} from '@mac/protocol';
import { AppError } from '../errors.js';
import { bearerToken, currentWorker, requireWorkerAuth } from '../worker-auth.js';
import { buildControlEnvelope, recordHeartbeat, registerWorker } from '../../services/workers.js';
import { completeRun, leaseNextRun, recordProgress } from '../../services/runs.js';
import { appendWorkerLogs } from '../../services/logs.js';
import { record } from '../../services/audit.js';
import { db } from '../../db/client.js';
import { runs } from '../../db/schema.js';
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

      const result = await registerWorker(token, body);
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
      });
      const control = await buildControlEnvelope(worker.id);
      return reply.send({ control, workerStatus });
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
        const assignment = await leaseNextRun({ id: worker.id, name: worker.name, capabilities });
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

      await recordProgress(runId, worker.id, {
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

      const runStatus = await completeRun(runId, worker.id, {
        outcome: body.outcome,
        stopReason: body.stopReason ?? null,
        ...(body.summary !== undefined ? { summary: body.summary } : {}),
        confidence: body.confidence ?? null,
      });

      const control = await buildControlEnvelope(worker.id);
      return reply.send({ control, runStatus });
    });
  });
}

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
