import type { FastifyInstance } from 'fastify';
import { createProjectRequestSchema, updateProjectRequestSchema } from '@mac/protocol';
import { createProject, getProject, listProjects, updateProject } from '../../services/projects.js';
import { listTasks } from '../../services/tasks.js';
import { currentActor, requireAuth, requireRole } from '../auth-plugin.js';

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/projects', { preHandler: requireAuth }, async (request, reply) => {
    const includeInactive = (request.query as { includeInactive?: string }).includeInactive !== 'false';
    return reply.send({ projects: await listProjects(includeInactive) });
  });

  app.get('/api/projects/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [project, tasks] = await Promise.all([getProject(id), listTasks({ projectId: id })]);
    return reply.send({ project, tasks });
  });

  // Creating and editing projects is operator work; viewers are read-only.
  app.post('/api/projects', { preHandler: requireRole('operator') }, async (request, reply) => {
    const body = createProjectRequestSchema.parse(request.body);
    const project = await createProject(body, currentActor(request));
    return reply.status(201).send({ project });
  });

  app.patch('/api/projects/:id', { preHandler: requireRole('operator') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateProjectRequestSchema.parse(request.body);
    return reply.send({ project: await updateProject(id, body, currentActor(request)) });
  });
}
