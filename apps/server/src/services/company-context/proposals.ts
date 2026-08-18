import { and, desc, eq } from 'drizzle-orm';
import type {
  CompanyProposalDto,
  CompanyProposalStatus,
  CreateCompanyProposalRequest,
} from '@mac/protocol';
import { HUMAN_ONLY_PROPOSAL_STATUSES } from '@mac/protocol';
import { db, type DbHandle } from '../../db/client.js';
import { companyContextProposals } from '../../db/schema.js';
import type { CompanyContextProposalRow } from '../../db/schema.js';
import { AppError } from '../../http/errors.js';
import { record, recordRejection, type Actor } from '../audit.js';
import { contextRefFor } from './service.js';

/**
 * Proposing a change to PAC company context (Sprint 3.2 §16).
 *
 * ---------------------------------------------------------------------------
 * THE GOVERNANCE BOUNDARY, IN THREE INDEPENDENT PIECES
 *
 * Mac may notice that PAC's company context is wrong or incomplete. He may not
 * decide that it is. Three separate things enforce that, and any one of them
 * alone would be sufficient:
 *
 *   1. The provider has no write verb (see provider.ts). There is no method to
 *      call, so no amount of application logic can reach the repository.
 *   2. Accepting a proposal does not produce a commit. It records that a human
 *      agreed. Making the change is that person's act, outside this system.
 *   3. `accepted` and `rejected` require a USER actor. A system actor — which is
 *      what every autonomous path runs as — is refused here, and the refusal is
 *      audited on its own connection so it outlives the rolled-back transaction.
 *
 * Belt, braces, and a second pair of braces, because "an AI approved its own
 * change to the company's authority document" is not a failure anyone should
 * have to discover from an audit six months later.
 * ---------------------------------------------------------------------------
 *
 * Note also what does NOT exist in this file or anywhere else: an automatic
 * caller. Nothing in discovery, supervision or the night shift creates a
 * proposal by itself. Sprint 3.2 §17 is explicit that project knowledge must not
 * become company policy on its own, and the way to guarantee that is for the
 * only code path into this table to be one a person deliberately invoked.
 */

/**
 * Shapes that look like a credential.
 *
 * Company context is business policy, read by everyone at PAC. A proposal is
 * free text Mac composed from evidence, and evidence comes from repositories and
 * task descriptions — which is exactly where a stray token ends up. Refusing
 * here is cheaper than discovering a secret in the company's own documentation.
 */
const SECRET_SHAPES: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/, what: 'a GitHub token' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/, what: 'a GitHub fine-grained token' },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/, what: 'an API key' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, what: 'a Slack token' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, what: 'an AWS access key id' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'a private key' },
  { pattern: /\b(postgres(ql)?|mysql|mongodb(\+srv)?):\/\/[^\s:]+:[^\s@]+@/i, what: 'a database URL with a password' },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, what: 'a JWT' },
];

export function findSecretShape(text: string): string | null {
  for (const { pattern, what } of SECRET_SHAPES) {
    if (pattern.test(text)) return what;
  }
  return null;
}

export async function createProposal(
  input: CreateCompanyProposalRequest & { baseRevisionId?: string | null; agent?: string },
  actor: Actor,
): Promise<CompanyProposalDto> {
  const suspect =
    findSecretShape(input.proposedChange) ??
    findSecretShape(input.reason) ??
    (input.potentialImpact ? findSecretShape(input.potentialImpact) : null);

  if (suspect) {
    throw AppError.badRequest(
      'COMPANY_PROPOSAL_SECRET_SUSPECTED',
      `This proposal appears to contain ${suspect}. Company context is business policy that everyone ` +
        'at PAC can read; secrets must never be written into it. Remove the credential and describe ' +
        'the policy change instead.',
    );
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(companyContextProposals)
      .values({
        targetDocument: input.targetDocument,
        targetSection: input.targetSection,
        proposedChange: input.proposedChange,
        reason: input.reason,
        evidence: input.evidence,
        potentialImpact: input.potentialImpact,
        projectId: input.projectId,
        taskId: input.taskId,
        runId: input.runId,
        discoverySessionId: input.discoverySessionId,
        agent: input.agent ?? 'mac',
        baseRevisionId: input.baseRevisionId ?? null,
        // The ONLY status a creation may produce. Everything past this is human.
        status: 'proposed',
        createdBy: actor.id,
      })
      .returning();
    if (!row) throw new AppError(500, 'COMPANY_PROPOSAL_CREATE_FAILED', 'Could not record the proposal.');

    await record(tx, {
      actor,
      eventType: 'company_context.proposal_created',
      context: { projectId: row.projectId, taskId: row.taskId, runId: row.runId },
      metadata: {
        proposalId: row.id,
        targetDocument: row.targetDocument,
        targetSection: row.targetSection,
        baseRevisionId: row.baseRevisionId,
        agent: row.agent,
        // The reason, not the proposed text: the trail records that Mac asked,
        // and the row itself holds what he asked for.
        reason: row.reason.slice(0, 500),
        evidence: (input.evidence ?? []).map((e) => e.ref),
      },
    });

    return proposalDto(row, tx);
  });
}

/**
 * Moves a proposal through review.
 *
 * The human check is the point of the function. `accepted` and `rejected` are
 * decisions about PAC policy, and a decision about PAC policy made by a `system`
 * actor is exactly the thing this sprint exists to prevent.
 */
export async function updateProposalStatus(
  id: string,
  input: { status: CompanyProposalStatus; reviewNotes?: string | null },
  actor: Actor,
): Promise<CompanyProposalDto> {
  if (HUMAN_ONLY_PROPOSAL_STATUSES.includes(input.status) && actor.type !== 'user') {
    await recordRejection(db, {
      actor,
      eventType: 'company_context.proposal_status_changed',
      metadata: {
        proposalId: id,
        refused: true,
        attemptedStatus: input.status,
        reason: 'non-human actor',
      },
    });
    throw new AppError(
      403,
      'COMPANY_PROPOSAL_HUMAN_REQUIRED',
      `Only a person may mark a company-context proposal "${input.status}". ` +
        'Mac may propose a change to PAC company context; he may never accept or reject one, ' +
        'including his own.',
    );
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(companyContextProposals)
      .where(eq(companyContextProposals.id, id))
      .limit(1);
    if (!existing) throw AppError.notFound('Company context proposal');

    if (existing.status === input.status) return proposalDto(existing, tx);

    // A decided proposal is final. Re-opening it would make "accepted" mean
    // "accepted for now", which is not a useful thing for a governance record.
    if (existing.status === 'accepted' || existing.status === 'rejected') {
      throw AppError.conflict(
        'COMPANY_PROPOSAL_DECIDED',
        `This proposal is already ${existing.status}. Raise a new proposal rather than reopening a decided one.`,
      );
    }

    const decided = HUMAN_ONLY_PROPOSAL_STATUSES.includes(input.status);

    const [row] = await tx
      .update(companyContextProposals)
      .set({
        status: input.status,
        reviewNotes: input.reviewNotes ?? existing.reviewNotes,
        ...(decided ? { reviewedBy: actor.id, reviewedAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(companyContextProposals.id, id))
      .returning();
    if (!row) throw AppError.notFound('Company context proposal');

    await record(tx, {
      actor,
      eventType: 'company_context.proposal_status_changed',
      context: { projectId: row.projectId, taskId: row.taskId, runId: row.runId },
      metadata: {
        proposalId: row.id,
        from: existing.status,
        to: row.status,
        targetDocument: row.targetDocument,
        // Accepting records agreement. It does not, and cannot, write the
        // repository — that remains a human act outside this system.
        appliedToRepository: false,
      },
    });

    return proposalDto(row, tx);
  });
}

export async function listProposals(
  filter: { status?: CompanyProposalStatus; taskId?: string } = {},
): Promise<CompanyProposalDto[]> {
  const conditions = [];
  if (filter.status) conditions.push(eq(companyContextProposals.status, filter.status));
  if (filter.taskId) conditions.push(eq(companyContextProposals.taskId, filter.taskId));

  const rows = await db
    .select()
    .from(companyContextProposals)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(companyContextProposals.createdAt))
    .limit(200);

  return Promise.all(rows.map((row) => proposalDto(row)));
}

export async function getProposal(id: string): Promise<CompanyProposalDto> {
  const [row] = await db
    .select()
    .from(companyContextProposals)
    .where(eq(companyContextProposals.id, id))
    .limit(1);
  if (!row) throw AppError.notFound('Company context proposal');
  return proposalDto(row);
}

export async function proposalDto(
  row: CompanyContextProposalRow,
  handle: DbHandle = db,
): Promise<CompanyProposalDto> {
  return {
    id: row.id,
    targetDocument: row.targetDocument,
    targetSection: row.targetSection,
    proposedChange: row.proposedChange,
    reason: row.reason,
    evidence: (row.evidence as unknown[]) ?? [],
    potentialImpact: row.potentialImpact,
    projectId: row.projectId,
    taskId: row.taskId,
    runId: row.runId,
    discoverySessionId: row.discoverySessionId,
    agent: row.agent,
    baseRevision: await contextRefFor(row.baseRevisionId, handle),
    status: row.status as CompanyProposalStatus,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewNotes: row.reviewNotes,
  };
}
