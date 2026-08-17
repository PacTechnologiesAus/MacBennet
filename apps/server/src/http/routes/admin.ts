import type { FastifyInstance } from 'fastify';
import {
  auditQuerySchema,
  createEnrollmentTokenRequestSchema,
  revokeWorkerTokensRequestSchema,
  updateSettingsRequestSchema,
} from '@mac/protocol';
import {
  listWorkerTokens,
  requestRotation,
  revokeWorkerTokens,
} from '../../services/worker-credentials.js';
import { getSecurityOverview } from '../../services/security.js';
import {
  deliverPendingEmails,
  listEmailDeliveries,
  retryEmailDelivery,
} from '../../services/mail/delivery.js';
import { getSettings, toSettingsDto, updateSettings } from '../../services/settings.js';
import { getBudgetStatus } from '../../services/budget.js';
import { queryAuditEvents } from '../../services/audit-query.js';
import {
  createEnrollmentToken,
  getWorker,
  listEnrollmentTokens,
  listWorkers,
  setWorkerEnabled,
} from '../../services/workers.js';
import { listRuns } from '../../services/runs.js';
import { listProjects } from '../../services/projects.js';
import { countTasks } from '../../services/tasks.js';
import { currentActor, requireAuth, requireRole } from '../auth-plugin.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // --- Settings ------------------------------------------------------------

  app.get('/api/settings', { preHandler: requireAuth }, async (_request, reply) =>
    reply.send({ settings: toSettingsDto(await getSettings()) }),
  );

  // Settings govern the guardrails, so changing them is an admin action.
  app.patch('/api/settings', { preHandler: requireRole('admin') }, async (request, reply) => {
    const body = updateSettingsRequestSchema.parse(request.body);
    const updated = await updateSettings(body, currentActor(request));
    return reply.send({ settings: toSettingsDto(updated) });
  });

  // --- Budget --------------------------------------------------------------

  app.get('/api/budget', { preHandler: requireAuth }, async (_request, reply) =>
    reply.send({ budget: await getBudgetStatus() }),
  );

  // --- Workers -------------------------------------------------------------

  app.get('/api/workers', { preHandler: requireAuth }, async (_request, reply) =>
    reply.send({ workers: await listWorkers() }),
  );

  app.get('/api/workers/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ worker: await getWorker(id) });
  });

  app.post('/api/workers/:id/enabled', { preHandler: requireRole('admin') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { enabled } = request.body as { enabled: boolean };
    return reply.send({ worker: await setWorkerEnabled(id, Boolean(enabled), currentActor(request)) });
  });

  // --- Worker credentials (Sprint 3 §4) -------------------------------------

  /**
   * Asks a worker to replace its credential.
   *
   * This does NOT invalidate anything. The request rides the control envelope,
   * so it reaches the worker on whichever call happens next and the worker
   * rotates itself — which is what makes rotation possible without anyone
   * logging into the VM. Revocation, below, is the immediate one.
   */
  app.post('/api/workers/:id/rotate', { preHandler: requireRole('admin') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { reason } = (request.body ?? {}) as { reason?: string };
    await requestRotation(id, currentActor(request), reason?.slice(0, 500) ?? 'Requested by an administrator.');
    return reply.send({ worker: await getWorker(id), rotationRequested: true });
  });

  /**
   * Kills every credential a worker holds, immediately and with no grace.
   *
   * The worker fails its next call and must re-enroll. That is the correct
   * outcome when a credential is believed compromised, and it is why revocation
   * offers no overlap window while rotation does.
   */
  app.post('/api/workers/:id/revoke-tokens', { preHandler: requireRole('admin') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = revokeWorkerTokensRequestSchema.parse(request.body);
    const result = await revokeWorkerTokens(id, body, currentActor(request));
    return reply.send({ ...result, worker: await getWorker(id) });
  });

  app.get('/api/workers/:id/tokens', { preHandler: requireRole('admin') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ tokens: await listWorkerTokens(id) });
  });

  /** Everything the Security screen shows: credential state and containment. */
  app.get('/api/security', { preHandler: requireRole('admin') }, async (_request, reply) =>
    reply.send({ security: await getSecurityOverview() }),
  );

  app.get('/api/worker-enrollment-tokens', { preHandler: requireRole('admin') }, async (_request, reply) =>
    reply.send({ tokens: await listEnrollmentTokens() }),
  );

  /**
   * Minting a credential that lets a machine join the control plane is the
   * most sensitive routine action in the system, so it is admin-only and the
   * plaintext is returned exactly once, here, and never again.
   */
  app.post('/api/worker-enrollment-tokens', { preHandler: requireRole('admin') }, async (request, reply) => {
    const body = createEnrollmentTokenRequestSchema.parse(request.body);
    const token = await createEnrollmentToken(body, currentActor(request));
    return reply.status(201).send({ token });
  });

  // --- Report delivery (Sprint 3 §9) ---------------------------------------

  app.get('/api/reports/deliveries', { preHandler: requireAuth }, async (_request, reply) =>
    reply.send({ deliveries: await listEmailDeliveries() }),
  );

  /**
   * Puts a dead delivery back in the queue.
   *
   * Recipients are re-resolved, so fixing the configuration and pressing retry
   * works without anyone editing a row by hand. A delivery already `sent` is
   * refused rather than duplicated.
   */
  app.post('/api/reports/deliveries/:id/retry', { preHandler: requireRole('operator') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ delivery: await retryEmailDelivery(id, currentActor(request)) });
  });

  /** Drains the mail outbox on demand. Normally the sweeper's job. */
  app.post('/api/reports/deliver', { preHandler: requireRole('admin') }, async (_request, reply) =>
    reply.send({ result: await deliverPendingEmails() }),
  );

  // --- Audit ---------------------------------------------------------------

  app.get('/api/audit', { preHandler: requireAuth }, async (request, reply) => {
    const query = auditQuerySchema.parse(request.query ?? {});
    return reply.send({ events: await queryAuditEvents(query) });
  });

  // --- Dashboard -----------------------------------------------------------

  app.get('/api/dashboard', { preHandler: requireAuth }, async (_request, reply) => {
    const settings = await getSettings();
    const [workers, activeRuns, pendingApprovals, recentlyCompleted, projects, taskCount, budget] = await Promise.all([
      listWorkers(),
      listRuns({ status: ['queued', 'running', 'blocked', 'self_review', 'ready_for_human_review'] }),
      listRuns({ status: ['ready_for_approval'] }),
      listRuns({ status: ['completed', 'failed', 'cancelled', 'stopped_by_guardrail'] }),
      listProjects(),
      countTasks(),
      getBudgetStatus(settings),
    ]);

    const since = Date.now() - 24 * 60 * 60 * 1000;
    const allRuns = [...activeRuns, ...pendingApprovals, ...recentlyCompleted];

    return reply.send({
      workers,
      activeRuns,
      pendingApprovals,
      recentlyCompleted: recentlyCompleted.slice(0, 10),
      counts: {
        projects: projects.length,
        tasks: taskCount,
        runsToday: allRuns.filter((r) => new Date(r.createdAt).getTime() >= since).length,
        liveWorkers: workers.filter((w) => w.isLive).length,
      },
      budget,
      settings: toSettingsDto(settings),
    });
  });
}
