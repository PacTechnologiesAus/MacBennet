import type { FastifyInstance } from 'fastify';
import {
  approveMondayBoardRequestSchema,
  approveProjectNightShiftRequestSchema,
  createMondayBoardRequestSchema,
  startNightShiftRequestSchema,
  stopNightShiftRequestSchema,
  updateMondayBoardRequestSchema,
} from '@mac/protocol';
import { currentActor, requireAuth, requireRole } from '../auth-plugin.js';
import {
  approveMondayBoard,
  approveProjectForNightShift,
  createMondayBoard,
  getMondayBoard,
  listMondayBoards,
  listMondayItems,
  updateMondayBoard,
} from '../../services/monday/boards.js';
import { syncBoard } from '../../services/monday/sync.js';
import { deliverPendingMondayWrites, listMondayWrites } from '../../services/monday/outbox.js';
import {
  buildNightQueue,
  getNightShiftSummary,
  listNightDecisions,
  nightShiftTick,
  startNightShift,
  stopNightShift,
} from '../../services/night-shift.js';
import { buildNightShiftDashboard } from '../../services/night-dashboard.js';
import { listInvestigations } from '../../services/investigation.js';

/**
 * monday.com mapping and the night shift (Sprint 3 §13).
 *
 * The role split follows the one Sprint 1 established: an `operator` runs the
 * work, an `admin` changes what Mac is permitted to do. Mapping a board and
 * approving it are both admin actions, because between them they decide which
 * external system Mac may write to and which work he may take without asking.
 */
export async function nightShiftRoutes(app: FastifyInstance): Promise<void> {
  // --- monday.com mapping --------------------------------------------------

  app.get('/api/monday/boards', { preHandler: requireAuth }, async (_request, reply) =>
    reply.send({ boards: await listMondayBoards() }),
  );

  app.get('/api/monday/boards/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ board: await getMondayBoard(id) });
  });

  app.post('/api/monday/boards', { preHandler: requireRole('admin') }, async (request, reply) => {
    const body = createMondayBoardRequestSchema.parse(request.body);
    const board = await createMondayBoard(body, currentActor(request));
    return reply.status(201).send({ board });
  });

  app.patch('/api/monday/boards/:id', { preHandler: requireRole('admin') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateMondayBoardRequestSchema.parse(request.body);
    return reply.send({ board: await updateMondayBoard(id, body, currentActor(request)) });
  });

  /**
   * Approval, separate from mapping.
   *
   * Mapping a board is technical (which column is status?); approving it is a
   * decision about whether a machine may take work from it. Collapsing the two
   * would mean configuring the integration silently authorised it.
   */
  app.post('/api/monday/boards/:id/approve', { preHandler: requireRole('admin') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = approveMondayBoardRequestSchema.parse(request.body);
    return reply.send({ board: await approveMondayBoard(id, body, currentActor(request)) });
  });

  app.post('/api/monday/boards/:id/sync', { preHandler: requireRole('operator') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ result: await syncBoard(id, currentActor(request)) });
  });

  app.get('/api/monday/items', { preHandler: requireAuth }, async (request, reply) => {
    const query = request.query as { projectId?: string; boardRowId?: string };
    return reply.send({ items: await listMondayItems(query) });
  });

  app.get('/api/monday/writes', { preHandler: requireAuth }, async (request, reply) => {
    const query = request.query as { runId?: string; taskId?: string };
    return reply.send({ writes: await listMondayWrites(query) });
  });

  /** Drains the outbox on demand. Normally the sweeper's job. */
  app.post('/api/monday/deliver', { preHandler: requireRole('admin') }, async (_request, reply) =>
    reply.send({ result: await deliverPendingMondayWrites() }),
  );

  // --- Project night-shift approval — the second gate ----------------------

  app.post('/api/projects/:id/night-shift-approval', { preHandler: requireRole('admin') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = approveProjectNightShiftRequestSchema.parse(request.body);
    return reply.send({ result: await approveProjectForNightShift(id, body, currentActor(request)) });
  });

  // --- The night shift -----------------------------------------------------

  app.get('/api/night-shift', { preHandler: requireAuth }, async (_request, reply) =>
    reply.send({ dashboard: await buildNightShiftDashboard() }),
  );

  app.get('/api/night-shift/queue', { preHandler: requireAuth }, async (_request, reply) =>
    reply.send({ queue: await buildNightQueue() }),
  );

  app.get('/api/night-shift/summary', { preHandler: requireAuth }, async (_request, reply) =>
    reply.send({ shift: await getNightShiftSummary() }),
  );

  app.get('/api/night-shift/:id/decisions', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ decisions: await listNightDecisions(id) });
  });

  app.post('/api/night-shift/start', { preHandler: requireRole('operator') }, async (request, reply) => {
    const body = startNightShiftRequestSchema.parse(request.body ?? {});
    const shift = await startNightShift(body, currentActor(request));
    return reply.status(201).send({ shift });
  });

  app.post('/api/night-shift/stop', { preHandler: requireRole('operator') }, async (request, reply) => {
    const body = stopNightShiftRequestSchema.parse(request.body ?? {});
    const shift = await stopNightShift(body, currentActor(request));
    return reply.send({ shift });
  });

  /**
   * Drives one turn of the loop.
   *
   * Exists so the scheduler can be exercised deterministically — by a test, or
   * by an operator who wants to see what Mac would decide right now — rather
   * than only by waiting for a timer. The tick is idempotent, so calling it is
   * safe.
   */
  app.post('/api/night-shift/tick', { preHandler: requireRole('admin') }, async (_request, reply) =>
    reply.send({ result: await nightShiftTick() }),
  );

  /**
   * What Mac checked before asking a human (Sprint 3 §6).
   *
   * The escalation receipt, exposed so a reviewer can confirm that a question
   * Mac asked was genuinely one he could not answer from his own sources.
   */
  app.get('/api/investigations', { preHandler: requireAuth }, async (request, reply) => {
    const query = request.query as { taskId?: string; runId?: string };
    return reply.send({ investigations: await listInvestigations(query) });
  });
}
