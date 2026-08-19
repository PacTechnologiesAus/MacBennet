import { randomInt } from 'node:crypto';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  APPROVAL_CODE_ALPHABET,
  APPROVAL_CODE_LENGTH,
  APPROVAL_CODE_PREFIX,
  AUTHORITY_REFUSALS,
  bindApprovalDecision,
  isConversationallyApprovable,
  type ApprovalBinding,
  type ApprovalRequestDto,
  type ApprovalRequestState,
  type ApprovalSubjectKind,
  type AuthorityClass,
  type ConversationChannel,
  type CreateApprovalRequest,
} from '@mac/protocol';
import { db, type DbHandle } from '../db/client.js';
import { approvalRequests, handoffBriefs, projects, tasks, type ApprovalRequestRow } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { record, recordRejection, SYSTEM_ACTOR, type Actor } from './audit.js';
import { emit } from './events.js';
import { approveRun, rejectRun } from './runs.js';

/**
 * Approval requests (Phase 4 Part B §8, §9).
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT A SECOND APPROVAL SYSTEM
 *
 * `approvals` (Sprint 1) remains the record of an authorisation against a run,
 * with the confidence and threshold in force at the moment of the decision.
 * This module produces the REQUEST that precedes it and, when a human answers,
 * calls straight into `approveRun` — the same function the web UI has always
 * called, with the same confidence floor, the same band check and the same
 * guardrail refusals.
 *
 * A Teams approval is therefore not a different kind of approval. It is the
 * same approval, arriving through a different door.
 *
 * ---------------------------------------------------------------------------
 * WHY IT NEEDS TO BE A ROW
 *
 * The binding problem. "Sounds good" must not approve the wrong action, and a
 * pending approval that exists only as `runs.approval_state = 'pending'` has no
 * identity for a reply to bind to — so any affirmation in the vicinity is as
 * good as any other. An addressable object with a code a human can quote back
 * is the minimum thing that makes the rule enforceable rather than aspirational.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

/**
 * Generates an unused code.
 *
 * `randomInt` rather than `Math.random`: not because guessing a code grants
 * anything — deciding an approval requires an authenticated, authorised
 * identity regardless — but because a predictable code makes it easy to
 * ADDRESS somebody else's outstanding approval in a shared channel, and a
 * social-engineering step that does not need to guess is a step worth removing.
 */
async function allocateCode(handle: DbHandle): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    let body = '';
    for (let i = 0; i < APPROVAL_CODE_LENGTH; i += 1) {
      body += APPROVAL_CODE_ALPHABET[randomInt(APPROVAL_CODE_ALPHABET.length)];
    }
    const code = `${APPROVAL_CODE_PREFIX}${body}`;

    const [clash] = await handle
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.code, code), eq(approvalRequests.state, 'pending')))
      .limit(1);

    if (!clash) return code;
  }
  // ~1M codes and a handful outstanding: twelve collisions in a row means
  // something is wrong that a thirteenth attempt will not fix.
  throw new AppError(500, 'APPROVAL_CODE_EXHAUSTED', 'Could not allocate an unused approval code.');
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

export const toApprovalRequestDto = (
  row: ApprovalRequestRow,
  extra: { projectName?: string; taskTitle?: string; decidedByName?: string | null } = {},
): ApprovalRequestDto => ({
  id: row.id,
  code: row.code,
  state: row.state as ApprovalRequestState,
  subjectKind: row.subjectKind as ApprovalSubjectKind,
  subjectVersion: row.subjectVersion,
  projectId: row.projectId,
  projectName: extra.projectName ?? '',
  taskId: row.taskId,
  taskTitle: extra.taskTitle ?? '',
  runId: row.runId,
  briefId: row.briefId,
  title: row.title,
  detail: row.detail,
  recommendation: row.recommendation,
  risk: row.risk as 'low' | 'medium' | 'high',
  authority: row.authority as AuthorityClass,
  confidence: row.confidence === null ? null : Number(row.confidence),
  requestedAt: row.requestedAt.toISOString(),
  expiresAt: row.expiresAt?.toISOString() ?? null,
  deliveredChannels: Array.isArray(row.deliveredChannels) ? (row.deliveredChannels as string[]) : [],
  decidedAt: row.decidedAt?.toISOString() ?? null,
  decidedByUserId: row.decidedByUserId,
  decidedByName: extra.decidedByName ?? null,
  decidedViaChannel: row.decidedViaChannel,
  decisionNotes: row.decisionNotes,
  supersededByRequestId: row.supersededByRequestId,
  createdAt: row.createdAt.toISOString(),
});

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

/**
 * Raises an approval request, superseding any earlier one for the same subject.
 *
 * ---------------------------------------------------------------------------
 * SUPERSESSION IS THE POINT OF `subjectVersion`
 *
 * A brief at version 3 and a brief at version 4 are different contracts.
 * Somebody who received a card for version 3, went to lunch while Mac revised
 * the brief, and came back and pressed Approve would be authorising work they
 * had not read.
 *
 * So raising a request for a subject marks every earlier pending request for
 * that subject `superseded`, with a pointer to the one that replaced it. The
 * old card's buttons then bind to a request that is no longer pending, and
 * `decide` refuses it by name rather than by silence.
 * ---------------------------------------------------------------------------
 */
export async function createApprovalRequest(
  input: CreateApprovalRequest,
  actor: Actor = SYSTEM_ACTOR,
): Promise<ApprovalRequestDto> {
  return db.transaction(async (tx) => {
    const [context] = await tx
      .select({ projectId: tasks.projectId, taskTitle: tasks.title, projectName: projects.name })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(eq(tasks.id, input.taskId))
      .limit(1);
    if (!context) throw AppError.notFound('Task');

    // Everything pending for the same subject is now out of date.
    const superseded = await tx
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.taskId, input.taskId),
          eq(approvalRequests.subjectKind, input.subjectKind),
          eq(approvalRequests.state, 'pending'),
        ),
      );

    const code = await allocateCode(tx);

    const [row] = await tx
      .insert(approvalRequests)
      .values({
        code,
        state: 'pending',
        subjectKind: input.subjectKind,
        subjectVersion: input.subjectVersion,
        projectId: context.projectId,
        taskId: input.taskId,
        runId: input.runId ?? null,
        briefId: input.briefId ?? null,
        title: input.title.slice(0, 300),
        detail: input.detail.slice(0, 8000),
        recommendation: input.recommendation.slice(0, 4000),
        risk: input.risk,
        authority: input.authority,
        confidence: input.confidence === null || input.confidence === undefined ? null : input.confidence.toFixed(3),
        expiresAt: input.expiresInHours ? new Date(Date.now() + input.expiresInHours * 3_600_000) : null,
      })
      .returning();
    if (!row) throw new AppError(500, 'APPROVAL_NOT_CREATED', 'The approval request could not be created.');

    if (superseded.length) {
      await tx
        .update(approvalRequests)
        .set({ state: 'superseded', supersededByRequestId: row.id, updatedAt: new Date() })
        .where(inArray(approvalRequests.id, superseded.map((s) => s.id)));

      await record(tx, {
        actor,
        eventType: 'approval_request.superseded',
        context: { projectId: context.projectId, taskId: input.taskId },
        metadata: { supersededIds: superseded.map((s) => s.id), replacedBy: row.id, code },
      });
    }

    await record(tx, {
      actor,
      eventType: 'approval_request.created',
      context: { projectId: context.projectId, taskId: input.taskId, runId: input.runId ?? null },
      metadata: {
        approvalRequestId: row.id,
        code,
        authority: input.authority,
        risk: input.risk,
        subjectKind: input.subjectKind,
        subjectVersion: input.subjectVersion,
        conversationallyApprovable: isConversationallyApprovable(input.authority),
      },
    });

    await emit(tx, {
      type: 'approval_required',
      projectId: context.projectId,
      taskId: input.taskId,
      runId: input.runId ?? null,
      approvalRequestId: row.id,
      data: { code, title: row.title, risk: row.risk, authority: row.authority },
    });

    return toApprovalRequestDto(row, { projectName: context.projectName, taskTitle: context.taskTitle });
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listApprovalRequests(
  filter: { state?: ApprovalRequestState; taskId?: string; projectId?: string; limit?: number } = {},
): Promise<ApprovalRequestDto[]> {
  const conditions = [
    filter.state ? eq(approvalRequests.state, filter.state) : undefined,
    filter.taskId ? eq(approvalRequests.taskId, filter.taskId) : undefined,
    filter.projectId ? eq(approvalRequests.projectId, filter.projectId) : undefined,
  ].filter(Boolean);

  const rows = await db
    .select({ request: approvalRequests, projectName: projects.name, taskTitle: tasks.title })
    .from(approvalRequests)
    .innerJoin(projects, eq(projects.id, approvalRequests.projectId))
    .innerJoin(tasks, eq(tasks.id, approvalRequests.taskId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(approvalRequests.requestedAt))
    .limit(Math.min(filter.limit ?? 100, 200));

  return rows.map((row) =>
    toApprovalRequestDto(row.request, { projectName: row.projectName, taskTitle: row.taskTitle }),
  );
}

/**
 * The approvals a conversation may be answering.
 *
 * Scoped to the conversation's task where it has one, and otherwise to
 * everything pending. That widening is deliberate: a Teams thread with no task
 * is exactly where somebody says "approve AP-4F2K" about work they were told
 * about elsewhere, and refusing to look outside the thread would make the code
 * they were given useless.
 *
 * It is safe because the code is the binding and the AUTHORISATION is checked
 * separately — being able to name a request is not being permitted to decide it.
 */
export async function pendingForConversation(input: {
  taskId?: string | null;
}): Promise<Array<{ id: string; code: string; title: string }>> {
  const rows = await db
    .select({ id: approvalRequests.id, code: approvalRequests.code, title: approvalRequests.title })
    .from(approvalRequests)
    .where(
      input.taskId
        ? and(eq(approvalRequests.state, 'pending'), eq(approvalRequests.taskId, input.taskId))
        : eq(approvalRequests.state, 'pending'),
    )
    .orderBy(desc(approvalRequests.requestedAt))
    .limit(20);

  return rows;
}

export async function requireApprovalRequest(id: string, handle: DbHandle = db): Promise<ApprovalRequestRow> {
  const [row] = await handle.select().from(approvalRequests).where(eq(approvalRequests.id, id)).limit(1);
  if (!row) throw AppError.notFound('Approval request');
  return row;
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

export interface DecideInput {
  decision: 'approve' | 'reject';
  notes?: string;
  acceptBelowThreshold?: boolean;
  /** Where the decision came from, for the record. */
  channel: ConversationChannel;
  conversationMessageId?: string | null;
}

/**
 * Records a decision, and applies it.
 *
 * ---------------------------------------------------------------------------
 * THE AUTHORITY CHECK RUNS HERE, AT DECISION TIME
 *
 * Not only when the request was raised. Between the two, a policy could change,
 * a request could be edited by a future feature, or an old card could be
 * pressed weeks later — and a check that ran once, earlier, would have been
 * satisfied by whatever was true then.
 *
 * Part B §9: "Do not use conversational approval to weaken existing technical
 * gates." The classes on the deny list are spec §16's hard V1 prohibitions, and
 * there is no branch here that reaches `approveRun` for one of them. The
 * refusal is audited with its own event type, because somebody trying to
 * authorise a production deployment by message is a security signal and not a
 * validation error.
 * ---------------------------------------------------------------------------
 */
export async function decideApprovalRequest(
  requestId: string,
  input: DecideInput,
  actor: Actor,
): Promise<ApprovalRequestDto> {
  const request = await requireApprovalRequest(requestId);

  if (request.state !== 'pending') {
    throw AppError.conflict(
      'APPROVAL_NOT_PENDING',
      request.state === 'superseded'
        ? `${request.code} was replaced by a newer version of the same request, so approving it would authorise ` +
          'something nobody has read. Decide the current one instead.'
        : `${request.code} is already ${request.state}.`,
    );
  }

  if (request.expiresAt && request.expiresAt.getTime() <= Date.now()) {
    await expireRequests([request.id]);
    throw AppError.conflict('APPROVAL_EXPIRED', `${request.code} expired on ${request.expiresAt.toISOString()}.`);
  }

  const authority = request.authority as AuthorityClass;

  if (input.decision === 'approve' && !isConversationallyApprovable(authority)) {
    /*
     * Refused for EVERY channel, not only conversational ones.
     *
     * The web UI is not a safer place to authorise a merge to main than Teams
     * is. Spec §16 says Mac may not do these things; it does not say he may do
     * them if asked through a nicer interface. A person with the authority
     * performs the action themselves.
     */
    await recordRejection(db, {
      actor,
      eventType: 'approval_request.authority_refused',
      context: { projectId: request.projectId, taskId: request.taskId, runId: request.runId },
      metadata: { approvalRequestId: request.id, code: request.code, authority, channel: input.channel },
    });
    throw AppError.forbidden(AUTHORITY_REFUSALS[authority] ?? 'That authority cannot be granted to Mac.');
  }

  /*
   * The underlying gate runs FIRST, outside the state update.
   *
   * `approveRun` owns the confidence floor, the band check and the job
   * allowlist, and it throws when they refuse. Marking the request approved and
   * then discovering the run cannot be approved would leave a record saying a
   * human authorised work that never became authorised.
   */
  if (input.decision === 'approve' && request.runId) {
    await approveRun(
      request.runId,
      { notes: input.notes ?? `Approved via ${input.channel} (${request.code}).`, acknowledgeBelowThreshold: input.acceptBelowThreshold ?? false },
      actor,
    );
  }
  if (input.decision === 'reject' && request.runId) {
    await rejectRun(request.runId, { notes: input.notes || `Rejected via ${input.channel} (${request.code}).` }, actor);
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(approvalRequests)
      .set({
        state: input.decision === 'approve' ? 'approved' : 'rejected',
        decidedAt: new Date(),
        decidedByUserId: actor.id,
        decidedViaChannel: input.channel,
        decidedViaMessageId: input.conversationMessageId ?? null,
        decisionNotes: input.notes?.slice(0, 4000) ?? null,
        updatedAt: new Date(),
      })
      // Re-checked in the UPDATE itself, so two people pressing Approve on the
      // same card at once cannot both succeed.
      .where(and(eq(approvalRequests.id, requestId), eq(approvalRequests.state, 'pending')))
      .returning();

    if (!row) {
      throw AppError.conflict('APPROVAL_NOT_PENDING', `${request.code} was decided by somebody else first.`);
    }

    await record(tx, {
      actor,
      eventType: 'approval_request.decided',
      context: { projectId: row.projectId, taskId: row.taskId, runId: row.runId },
      metadata: {
        approvalRequestId: row.id,
        code: row.code,
        decision: input.decision,
        channel: input.channel,
        authority,
        // Recorded so an audit reader can tell a decision made on a card from
        // one made in the web UI without inferring it from the actor.
        viaMessageId: input.conversationMessageId ?? null,
        acceptBelowThreshold: input.acceptBelowThreshold ?? false,
      },
    });

    await emit(tx, {
      type: 'approval_decided',
      projectId: row.projectId,
      taskId: row.taskId,
      runId: row.runId,
      approvalRequestId: row.id,
      data: { code: row.code, decision: input.decision, channel: input.channel },
    });

    const [names] = await tx
      .select({ projectName: projects.name, taskTitle: tasks.title })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(eq(tasks.id, row.taskId))
      .limit(1);

    return toApprovalRequestDto(row, {
      projectName: names?.projectName ?? '',
      taskTitle: names?.taskTitle ?? '',
      decidedByName: actor.label,
    });
  });
}

/**
 * Works out which approval a conversational message is answering.
 *
 * The binding rules themselves are pure and live in the protocol, so they can be
 * tested without a database and cannot differ between the Teams path and the
 * web path. This wraps them with the lookup and the audit record.
 */
export async function bindMessageToApproval(input: {
  text: string;
  taskId?: string | null;
  explicitRequestId?: string | null;
  explicitDecision?: 'approve' | 'reject' | null;
  actor: Actor;
  channel: ConversationChannel;
}): Promise<ApprovalBinding> {
  const pending = await pendingForConversation({ taskId: input.taskId ?? null });

  const binding = bindApprovalDecision({
    text: input.text,
    pending,
    explicitRequestId: input.explicitRequestId ?? null,
    explicitDecision: input.explicitDecision ?? null,
  });

  if (binding.outcome === 'ambiguous' || binding.outcome === 'unknown_code') {
    /*
     * A refusal to bind is worth an audit event of its own.
     *
     * It is the mechanism the phase brief specifically asks for, and the only
     * way to know afterwards that it fired is for it to have left a record. A
     * silent refusal looks identical to nobody having tried.
     */
    await db.transaction(async (tx) => {
      await record(tx, {
        actor: input.actor,
        eventType: 'approval_request.ambiguous_reply_refused',
        context: { taskId: input.taskId ?? null },
        metadata: {
          outcome: binding.outcome,
          reason: binding.reason,
          channel: input.channel,
          pendingCount: pending.length,
          pendingCodes: pending.map((p) => p.code),
        },
      });
    });
  }

  return binding;
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

/** Marks expired requests, so an old card cannot be pressed into effect. */
export async function expireStaleRequests(now = new Date()): Promise<number> {
  const stale = await db
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.state, 'pending'), lt(approvalRequests.expiresAt, now)))
    .limit(200);

  if (!stale.length) return 0;
  await expireRequests(stale.map((s) => s.id));
  return stale.length;
}

async function expireRequests(ids: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(approvalRequests)
      .set({ state: 'expired', updatedAt: new Date() })
      .where(and(inArray(approvalRequests.id, ids), eq(approvalRequests.state, 'pending')));

    await record(tx, {
      actor: SYSTEM_ACTOR,
      eventType: 'approval_request.expired',
      metadata: { approvalRequestIds: ids },
    });
  });
}

/**
 * Cancels pending requests for a run that is no longer going anywhere.
 *
 * Called when a run is cancelled or fails. An approval card for a run that
 * stopped an hour ago is a decision somebody can still press, and pressing it
 * would produce a confusing error rather than a clear "that is no longer live".
 */
export async function cancelRequestsForRun(runId: string, handle: DbHandle = db): Promise<void> {
  await handle
    .update(approvalRequests)
    .set({ state: 'cancelled', updatedAt: new Date() })
    .where(and(eq(approvalRequests.runId, runId), eq(approvalRequests.state, 'pending')));
}

/** Marks a channel as having received this request, so it is not re-sent. */
export async function noteDelivered(
  requestId: string,
  channel: ConversationChannel,
  handle: DbHandle = db,
): Promise<void> {
  await handle
    .update(approvalRequests)
    .set({
      deliveredChannels: sql`(
        SELECT jsonb_agg(DISTINCT value)
        FROM jsonb_array_elements(${approvalRequests.deliveredChannels} || ${JSON.stringify([channel])}::jsonb)
      )`,
      updatedAt: new Date(),
    })
    .where(eq(approvalRequests.id, requestId));
}

/** Whether a brief has moved on since a request was raised against it. */
export async function briefVersionFor(briefId: string, handle: DbHandle = db): Promise<number> {
  const [row] = await handle
    .select({ version: handoffBriefs.version })
    .from(handoffBriefs)
    .where(eq(handoffBriefs.id, briefId))
    .limit(1);
  return row?.version ?? 0;
}

/** The run a request is about, for callers that need it without a second query. */
export const runIdFor = (row: ApprovalRequestRow): string | null => row.runId;
