import type { FastifyInstance } from 'fastify';
import { createArtefactRequestSchema, renderArtefactMarkdown } from '@mac/protocol';
import { createArtefact, getArtefact, listArtefacts } from '../../services/artefacts.js';
import { currentActor, requireAuth, requireRole } from '../auth-plugin.js';

/**
 * Artefacts — the results of non-coding work (Sprint 3.3 §17, §26).
 *
 * Reading is open to anyone who may read runs; creating requires `operator`.
 * The write route exists for day-mode work a human asks Mac to record, and it
 * goes through exactly the same `createArtefact` as the research loop — so the
 * confidence cap on ungrounded findings applies to a hand-posted artefact too,
 * rather than only to the path somebody remembered to guard.
 */
export async function artefactRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/artefacts', { preHandler: requireAuth }, async (request, reply) => {
    const { taskId, runId, projectId } = request.query as {
      taskId?: string;
      runId?: string;
      projectId?: string;
    };
    return reply.send({
      artefacts: await listArtefacts({
        ...(taskId ? { taskId } : {}),
        ...(runId ? { runId } : {}),
        ...(projectId ? { projectId } : {}),
      }),
    });
  });

  app.get('/api/artefacts/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const artefact = await getArtefact(id);
    return reply.send({
      artefact,
      /*
       * The rendered form, alongside the structured one.
       *
       * Findings are grouped by evidence class after the body, so a reader who
       * skims the prose still meets the distinction between what Mac
       * established and what he concluded before acting on either.
       */
      markdown: renderArtefactMarkdown(artefact),
    });
  });

  app.post('/api/artefacts', { preHandler: requireRole('operator') }, async (request, reply) => {
    const body = createArtefactRequestSchema.parse(request.body);
    const artefact = await createArtefact(
      {
        taskId: body.taskId,
        runId: body.runId ?? null,
        content: body.content,
      },
      currentActor(request),
    );
    return reply.status(201).send({ artefact });
  });
}
