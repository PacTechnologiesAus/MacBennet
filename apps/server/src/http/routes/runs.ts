import type { FastifyInstance } from 'fastify';
import {
  approveRunRequestSchema,
  cancelRunRequestSchema,
  createRunRequestSchema,
  rejectRunRequestSchema,
  JOB_CATALOGUE,
  type RunStatus,
} from '@mac/protocol';
import {
  approveRun,
  createRun,
  forceCancel,
  getRun,
  listApprovals,
  listRuns,
  rejectRun,
  requestCancel,
  submitForApproval,
} from '../../services/runs.js';
import { getRunLogs } from '../../services/logs.js';
import { auditTrailForRun } from '../../services/audit-query.js';
import { currentActor, requireAuth, requireRole } from '../auth-plugin.js';

export async function runRoutes(app: FastifyInstance): Promise<void> {
  /** The allowlist, exposed so the UI can only offer operations that exist. */
  app.get('/api/job-catalogue', { preHandler: requireAuth }, async (_request, reply) =>
    reply.send({ jobs: JOB_CATALOGUE }),
  );

  app.get('/api/runs', { preHandler: requireAuth }, async (request, reply) => {
    const { taskId, status } = request.query as { taskId?: string; status?: string };
    return reply.send({
      runs: await listRuns({
        ...(taskId ? { taskId } : {}),
        ...(status ? { status: status.split(',') as RunStatus[] } : {}),
      }),
    });
  });

  app.get('/api/runs/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [run, approvals, auditEvents] = await Promise.all([
      getRun(id),
      listApprovals(id),
      auditTrailForRun(id),
    ]);
    return reply.send({ run, approvals, auditEvents });
  });

  /** Polled by the Run Detail screen. `afterId` is the monotonic cursor. */
  app.get('/api/runs/:id/logs', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { afterId, limit } = request.query as { afterId?: string; limit?: string };
    const logs = await getRunLogs(id, {
      ...(afterId !== undefined ? { afterId: Number(afterId) } : {}),
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
    });
    return reply.send({ logs, cursor: logs.length ? logs[logs.length - 1]!.id : (afterId ? Number(afterId) : null) });
  });

  app.post('/api/runs', { preHandler: requireRole('operator') }, async (request, reply) => {
    const body = createRunRequestSchema.parse(request.body);
    const run = await createRun(body, currentActor(request));
    return reply.status(201).send({ run });
  });

  app.post('/api/runs/:id/submit', { preHandler: requireRole('operator') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ run: await submitForApproval(id, currentActor(request)) });
  });

  // Approval is the human decision the whole sprint exists to prove.
  app.post('/api/runs/:id/approve', { preHandler: requireRole('operator') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = approveRunRequestSchema.parse(request.body ?? {});
    return reply.send({ run: await approveRun(id, body, currentActor(request)) });
  });

  app.post('/api/runs/:id/reject', { preHandler: requireRole('operator') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = rejectRunRequestSchema.parse(request.body);
    return reply.send({ run: await rejectRun(id, body, currentActor(request)) });
  });

  app.post('/api/runs/:id/cancel', { preHandler: requireRole('operator') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = cancelRunRequestSchema.parse(request.body ?? {});
    return reply.send({ run: await requestCancel(id, body, currentActor(request)) });
  });

  /**
   * Escape hatch for an unreachable worker. Separate route, separate audit
   * event — a forced stop must never look like a clean one.
   */
  app.post('/api/runs/:id/force-cancel', { preHandler: requireRole('operator') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = cancelRunRequestSchema.parse(request.body ?? {});
    return reply.send({ run: await forceCancel(id, body, currentActor(request)) });
  });
}
