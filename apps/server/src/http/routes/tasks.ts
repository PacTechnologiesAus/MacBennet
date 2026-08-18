import type { FastifyInstance } from 'fastify';
import { createTaskRequestSchema, updateTaskRequestSchema } from '@mac/protocol';
import { createTask, getTask, listTasks, updateTask } from '../../services/tasks.js';
import { listRuns } from '../../services/runs.js';
import { taskExecutionState } from '../../services/task-state.js';
import { listArtefacts } from '../../services/artefacts.js';
import { listDiscoverySessions, startDiscovery } from '../../services/discovery.js';
import { record } from '../../services/audit.js';
import { db } from '../../db/client.js';
import { currentActor, requireAuth, requireRole } from '../auth-plugin.js';

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/tasks', { preHandler: requireAuth }, async (request, reply) => {
    const { projectId } = request.query as { projectId?: string };
    return reply.send({ tasks: await listTasks(projectId ? { projectId } : {}) });
  });

  /**
   * Everything the Task Detail screen needs, in one call.
   *
   * Sprint 3.3 §26: task type, origin, discovery state, derived confidence,
   * project capabilities, execution requirements, eligibility and the blocker
   * reason. Assembled server-side so the screen and the night scheduler cannot
   * disagree about whether a task can run.
   */
  app.get('/api/tasks/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [task, runs, execution, artefacts, discovery] = await Promise.all([
      getTask(id),
      listRuns({ taskId: id }),
      taskExecutionState(id),
      listArtefacts({ taskId: id }),
      listDiscoverySessions({ taskId: id }),
    ]);
    return reply.send({ task, runs, execution, artefacts, discovery });
  });

  /**
   * Start Discovery on an existing task (Sprint 3.3 §7).
   *
   * The action that was missing. A draft task previously had no route into the
   * lifecycle at all unless the user already understood discovery sessions,
   * briefs and statuses — which is the UX half of the failure this sprint
   * exists to fix (reconciliation drift D-5).
   */
  app.post('/api/tasks/:id/discovery', { preHandler: requireRole('operator') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const actor = currentActor(request);
    const task = await getTask(id);

    const existing = await listDiscoverySessions({ taskId: id });
    // Idempotent: pressing the button twice returns the session that exists
    // rather than starting a second conversation about the same task.
    const open = existing.find((s) => s.status !== 'closed');
    if (open) return reply.send({ discovery: open, created: false });

    await db.transaction(async (tx) => {
      await record(tx, {
        actor,
        eventType: 'task.discovery_requested',
        context: { taskId: id, projectId: task.projectId },
        metadata: { taskKind: task.taskKind, origin: task.origin },
      });
    });

    const discovery = await startDiscovery({ projectId: task.projectId, taskId: id }, actor);
    return reply.status(201).send({ discovery, created: true });
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
