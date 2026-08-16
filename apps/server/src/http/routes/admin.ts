import type { FastifyInstance } from 'fastify';
import {
  auditQuerySchema,
  createEnrollmentTokenRequestSchema,
  updateSettingsRequestSchema,
} from '@mac/protocol';
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
