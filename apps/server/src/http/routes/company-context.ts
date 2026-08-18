import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  companyProposalStatusSchema,
  createCompanyProposalSchema,
  updateCompanyProposalSchema,
} from '@mac/protocol';
import { currentActor, requireAuth, requireRole } from '../auth-plugin.js';
import { AppError } from '../errors.js';
import {
  getCompanyContextStatus,
  readCompanyDocument,
  refreshCompanyContext,
  requireActiveRevision,
} from '../../services/company-context/service.js';
import { recentRevisions, revisionById, revisionDto } from '../../services/company-context/loader.js';
import { selectCompanyContext } from '../../services/company-context/selection.js';
import {
  createProposal,
  getProposal,
  listProposals,
  updateProposalStatus,
} from '../../services/company-context/proposals.js';

/**
 * PAC company context (Sprint 3.2 §18).
 *
 * The role split follows the one Sprint 1 established. Reading status, history
 * and proposals is `viewer`; forcing a refresh and creating or deciding a
 * proposal is `operator`.
 *
 * Note what has NO route at all: writing a company document. There is no
 * endpoint, no service function, and no provider method — the absence is the
 * governance boundary (Sprint 3.2 §16.2).
 */
export async function companyContextRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/company-context/status', { preHandler: requireAuth }, async (_request, reply) =>
    reply.send({ status: await getCompanyContextStatus() }),
  );

  app.post('/api/company-context/refresh', { preHandler: requireRole('operator') }, async (request, reply) => {
    const result = await refreshCompanyContext({
      reason: 'operator.manual',
      force: true,
      actor: currentActor(request),
    });
    return reply.send({
      status: await getCompanyContextStatus(),
      changed: result.changed,
      error: result.error,
    });
  });

  app.get('/api/company-context/revisions', { preHandler: requireAuth }, async (_request, reply) => {
    const rows = await recentRevisions(50);
    return reply.send({ revisions: rows.map(revisionDto) });
  });

  app.get('/api/company-context/revisions/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await revisionById(id);
    if (!row) throw AppError.notFound('Company context revision');
    return reply.send({ revision: revisionDto(row) });
  });

  /**
   * Reads a document AT A HISTORICAL REVISION.
   *
   * This is the endpoint that makes attribution real rather than nominal: given
   * a run from three months ago, an operator can read the exact AUTHORITY.md
   * that governed it, not today's.
   */
  app.get('/api/company-context/revisions/:id/document', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { path } = z.object({ path: z.string().min(1).max(200) }).parse(request.query);

    const row = await revisionById(id);
    if (!row) throw AppError.notFound('Company context revision');

    return reply.send({
      revision: revisionDto(row),
      path,
      content: await readCompanyDocument(row, path),
    });
  });

  /**
   * Previews what Mac would put in front of himself for a given piece of work.
   *
   * Operator-only because it renders company policy text in full, and because
   * its real use is an engineer checking that the selection layer is picking
   * sensibly before trusting it on a night shift.
   */
  app.post('/api/company-context/selection', { preHandler: requireRole('operator') }, async (request, reply) => {
    const body = z
      .object({ text: z.string().max(20_000).default(''), budget: z.number().int().min(0).max(100_000).optional() })
      .parse(request.body ?? {});

    const revision = await requireActiveRevision('selection.preview');
    if (!revision) {
      throw AppError.conflict(
        'COMPANY_CONTEXT_DISABLED',
        'Company context is not enabled for this deployment, so there is nothing to select.',
      );
    }

    return reply.send({
      selection: await selectCompanyContext(revision, {
        text: body.text,
        ...(body.budget !== undefined ? { budget: body.budget } : {}),
      }),
    });
  });

  // --- Proposals -----------------------------------------------------------

  app.get('/api/company-context/proposals', { preHandler: requireAuth }, async (request, reply) => {
    const query = z
      .object({ status: companyProposalStatusSchema.optional(), taskId: z.string().uuid().optional() })
      .parse(request.query ?? {});
    return reply.send({ proposals: await listProposals(query) });
  });

  app.get('/api/company-context/proposals/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ proposal: await getProposal(id) });
  });

  app.post('/api/company-context/proposals', { preHandler: requireRole('operator') }, async (request, reply) => {
    const body = createCompanyProposalSchema.parse(request.body);

    /*
     * The proposal is stamped with the revision it was written against, so a
     * reviewer can see what the document actually said when the change was
     * suggested. Resolved leniently: a deployment without company context can
     * still record that somebody thinks a PAC document should change.
     */
    const revision = await requireActiveRevision('proposal.create').catch(() => null);

    const proposal = await createProposal(
      { ...body, baseRevisionId: revision?.id ?? null },
      currentActor(request),
    );
    return reply.status(201).send({ proposal });
  });

  app.patch('/api/company-context/proposals/:id', { preHandler: requireRole('operator') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateCompanyProposalSchema.parse(request.body);
    const proposal = await updateProposalStatus(id, body, currentActor(request));
    return reply.send({ proposal });
  });
}
