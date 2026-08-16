import type { FastifyInstance } from 'fastify';
import { createTaskRequestSchema, updateTaskRequestSchema } from '@mac/protocol';
import { createTask, getTask, listTasks, updateTask } from '../../services/tasks.js';
import { listRuns } from '../../services/runs.js';
import { currentActor, requireAuth, requireRole } from '../auth-plugin.js';

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/tasks', { preHandler: requireAuth }, async (request, reply) => {
    const { projectId } = request.query as { projectId?: string };
    return reply.send({ tasks: await listTasks(projectId ? { projectId } : {}) });
  });

  app.get('/api/tasks/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [task, runs] = await Promise.all([getTask(id), listRuns({ taskId: id })]);
    return reply.send({ task, runs });
  });

  app.post('/api/tasks', { preHandler: requireRole('operator') }, async (request, reply) => {
    const body = createTaskRequestSchema.parse(request.body);
    const task = await createTask(body, currentActor(request));
    return reply.status(201).send({ task });
  });

  app.patch('/api/tasks/:id', { preHandler: requireRole('operator') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateTaskRequestSchema.parse(request.body);
    return reply.send({ task: await updateTask(id, body, currentActor(request)) });
  });
}
