import type { FastifyInstance } from 'fastify';
import {
  answerBriefQuestionRequestSchema,
  createCodingRunRequestSchema,
  discoveryMessageRequestSchema,
  generateBriefRequestSchema,
  startDiscoveryRequestSchema,
  updateBriefRequestSchema,
} from '@mac/protocol';
import {
  addDiscoveryMessage,
  closeDiscovery,
  generateBrief,
  getDiscoverySession,
  listDiscoverySessions,
  startDiscovery,
} from '../../services/discovery.js';
import { answerBriefQuestion, getBrief, latestBriefForTask, updateBrief } from '../../services/briefs.js';
import { createCodingRun, getCodingRunDetail } from '../../services/coding-runs.js';
import { listQuestions } from '../../services/coding-sessions.js';
import { getReview } from '../../services/reviews.js';
import { generateRunReport, getRunReport, listReports } from '../../services/reports.js';
import { usageSummaryForRun, listUsageSnapshots } from '../../services/usage.js';
import { currentActor, requireAuth, requireRole } from '../auth-plugin.js';

/**
 * Discovery, briefs, coding runs, review, usage and reports.
 *
 * These are all human-plane routes: a worker token reaches none of them, and a
 * session cookie is the only accepted credential — the Sprint 1 separation is
 * unchanged.
 */
export async function discoveryRoutes(app: FastifyInstance): Promise<void> {
  // --- Discovery -----------------------------------------------------------

  app.get('/api/discovery', { preHandler: requireAuth }, async (request, reply) => {
    const { projectId, taskId } = request.query as { projectId?: string; taskId?: string };
    return reply.send({
      sessions: await listDiscoverySessions({ ...(projectId ? { projectId } : {}), ...(taskId ? { taskId } : {}) }),
    });
  });

  app.get('/api/discovery/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ session: await getDiscoverySession(id) });
  });

  /** Step A — the human explicitly selects the project. Mac never infers it. */
  app.post('/api/discovery', { preHandler: requireRole('operator') }, async (request, reply) => {
    const body = startDiscoveryRequestSchema.parse(request.body);
    const session = await startDiscovery(body, currentActor(request));
    return reply.status(201).send({ session });
  });

  /** Step C — the human talks freely; Mac records and does not interrogate. */
  app.post('/api/discovery/:id/messages', { preHandler: requireRole('operator') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = discoveryMessageRequestSchema.parse(request.body);
    return reply.send({ session: await addDiscoveryMessage(id, body, currentActor(request)) });
  });

  /** Steps D and E — structure the conversation, then ask the ONE next question. */
  app.post('/api/discovery/:id/brief', { preHandler: requireRole('operator') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = generateBriefRequestSchema.parse(request.body ?? {});
    const result = await generateBrief(id, body, currentActor(request));
    return reply.status(201).send(result);
  });

  app.post('/api/discovery/:id/close', { preHandler: requireRole('operator') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ session: await closeDiscovery(id, currentActor(request)) });
  });

  // --- Briefs --------------------------------------------------------------

  app.get('/api/briefs/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ brief: await getBrief(id) });
  });

  app.get('/api/tasks/:id/brief', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ brief: await latestBriefForTask(id) });
  });

  /**
   * Content is patchable; confidence is not. It is recomputed from the brief on
   * every write, so nobody can raise it by asserting it.
   */
  app.patch('/api/briefs/:id', { preHandler: requireRole('operator') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateBriefRequestSchema.parse(request.body);
    return reply.send({ brief: await updateBrief(id, body.content, currentActor(request)) });
  });

  app.post('/api/briefs/:id/answer', { preHandler: requireRole('operator') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = answerBriefQuestionRequestSchema.parse(request.body);
    return reply.send({ brief: await answerBriefQuestion(id, body, currentActor(request)) });
  });

  // --- Coding runs ---------------------------------------------------------

  app.post('/api/coding-runs', { preHandler: requireRole('operator') }, async (request, reply) => {
    const body = createCodingRunRequestSchema.parse(request.body);
    const run = await createCodingRun(body, currentActor(request));
    return reply.status(201).send({ run });
  });

  app.get('/api/runs/:id/coding', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ detail: await getCodingRunDetail(id) });
  });

  /**
   * The detailed Q&A log lives here rather than in the morning report, which is
   * exactly why the report can stay short.
   */
  app.get('/api/runs/:id/questions', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ questions: await listQuestions(id) });
  });

  app.get('/api/runs/:id/review', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ review: await getReview(id) });
  });

  app.get('/api/runs/:id/usage', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [usage, snapshots] = await Promise.all([usageSummaryForRun(id), listUsageSnapshots(id)]);
    return reply.send({ usage, snapshots });
  });

  // --- Reports -------------------------------------------------------------

  app.get('/api/runs/:id/report', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await getRunReport(id);
    return reply.send({ report: existing ?? (await generateRunReport(id, currentActor(request))) });
  });

  app.post('/api/runs/:id/report', { preHandler: requireRole('operator') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ report: await generateRunReport(id, currentActor(request)) });
  });

  app.get('/api/reports', { preHandler: requireAuth }, async (request, reply) => {
    const { since } = request.query as { since?: string };
    return reply.send({ reports: await listReports(since ? new Date(since) : undefined) });
  });
}
