import type { FastifyInstance } from 'fastify';
import {
  approveRepositoryRequestSchema,
  createMemoryRequestSchema,
  createRepositoryRequestSchema,
  memoryScopeSchema,
  updateRepositoryRequestSchema,
} from '@mac/protocol';
import {
  createRepository,
  getRepository,
  listRepositories,
  setRepositoryApproval,
  updateRepository,
} from '../../services/repositories.js';
import { createMemory, listMemory, promoteToProjectMemory } from '../../services/memory.js';
import { getSettings } from '../../services/settings.js';
import { currentActor, requireAuth, requireRole } from '../auth-plugin.js';

/**
 * Repositories and memory.
 *
 * Note the role gates. Creating or editing a repository is admin-only because
 * `localPath`, `testCommand` and `buildCommand` decide what the worker executes
 * and where — the narrowest sensible authority for the one configurable command
 * in the system. Approving a repository is separately admin-only, because it is
 * the gate that lets Mac write code there at all.
 */
export async function repositoryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/repositories', { preHandler: requireAuth }, async (request, reply) => {
    const { projectId } = request.query as { projectId?: string };
    return reply.send({ repositories: await listRepositories(projectId ? { projectId } : {}) });
  });

  app.get('/api/repositories/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ repository: await getRepository(id) });
  });

  app.post('/api/repositories', { preHandler: requireRole('admin') }, async (request, reply) => {
    const body = createRepositoryRequestSchema.parse(request.body);
    const repository = await createRepository(body, currentActor(request));
    return reply.status(201).send({ repository });
  });

  app.patch('/api/repositories/:id', { preHandler: requireRole('admin') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateRepositoryRequestSchema.parse(request.body);
    return reply.send({ repository: await updateRepository(id, body, currentActor(request)) });
  });

  /**
   * Approval is a deliberate, separate act with its own audit event — never a
   * side effect of creating the row.
   */
  app.post('/api/repositories/:id/approve', { preHandler: requireRole('admin') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = approveRepositoryRequestSchema.parse(request.body);
    return reply.send({ repository: await setRepositoryApproval(id, body, currentActor(request)) });
  });

  // --- Memory (spec §9) ----------------------------------------------------

  app.get('/api/memory', { preHandler: requireAuth }, async (request, reply) => {
    const { projectId, taskId, scope } = request.query as { projectId?: string; taskId?: string; scope?: string };
    return reply.send({
      memory: await listMemory({
        ...(projectId ? { projectId } : {}),
        ...(taskId ? { taskId } : {}),
        ...(scope ? { scope: memoryScopeSchema.parse(scope) } : {}),
      }),
    });
  });

  app.post('/api/memory', { preHandler: requireRole('operator') }, async (request, reply) => {
    const body = createMemoryRequestSchema.parse(request.body);
    return reply.status(201).send({ memory: await createMemory(body, currentActor(request)) });
  });

  /**
   * Promotion uses the configured autonomy threshold as its validation bar, so
   * "an assumption does not become a project fact" is tied to the same number
   * that governs autonomous execution rather than to a second magic constant.
   */
  app.post('/api/memory/:id/promote', { preHandler: requireRole('operator') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { projectId } = request.body as { projectId: string };
    const settings = await getSettings();
    return reply.send({
      memory: await promoteToProjectMemory(
        id,
        { projectId, minConfidence: settings.defaultConfidenceThreshold },
        currentActor(request),
      ),
    });
  });
}
