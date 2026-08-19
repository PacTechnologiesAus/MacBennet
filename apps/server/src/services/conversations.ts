import { and, desc, eq, gt, sql } from 'drizzle-orm';
import {
  conversationSummaryContentSchema,
  CONVERSATION_TAIL_MESSAGES,
  emptyMessageEvidence,
  messageEvidenceSchema,
  type ConversationChannel,
  type ConversationContext,
  type ConversationDto,
  type ConversationMessageDto,
  type ConversationParticipantDto,
  type ConversationStatus,
  type ConversationSummaryContent,
  type ConversationSummaryDto,
  type DeliveryState,
  type MessageDirection,
  type MessageEvidence,
  type MessageIntent,
  type OutboundKind,
  type ParticipantKind,
} from '@mac/protocol';
import { db, type DbHandle } from '../db/client.js';
import {
  conversationMessages,
  conversationParticipants,
  conversations,
  conversationSummaries,
  projects,
  tasks,
  type ConversationMessageRow,
  type ConversationRow,
} from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { record, SYSTEM_ACTOR, type Actor } from './audit.js';
import { emit } from './events.js';
import { contextRefFor } from './company-context/service.js';

/**
 * Persistent conversations (Phase 4 Part C).
 *
 * ---------------------------------------------------------------------------
 * ONE MAC
 *
 * Every channel writes here. Teams does not get a message store; the web UI
 * does not get a different one. A thread begun in Teams and continued in the
 * web UI is one row with messages carrying different `channel` values, which is
 * what makes "if the user discusses Task X in Teams and opens Task X in the web
 * UI later, the important conversation should be available" true by
 * construction rather than by a synchronisation job.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No model call. This module records and retrieves; deciding what a message
 * MEANS is `domain/message-intent.ts`, and deciding what to DO about it is
 * `conversation-turns.ts`. Keeping persistence free of judgement is what lets
 * the Teams handler, the web handler and the Forja handler share one path
 * without any of them being able to change what gets stored.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

const asEvidence = (value: unknown): MessageEvidence => {
  const parsed = messageEvidenceSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : emptyMessageEvidence();
};

export const toMessageDto = (row: ConversationMessageRow): ConversationMessageDto => ({
  id: row.id,
  conversationId: row.conversationId,
  seq: row.seq,
  direction: row.direction as MessageDirection,
  channel: row.channel as ConversationChannel,
  authorKind: row.authorKind as ParticipantKind,
  authorUserId: row.authorUserId,
  authorName: row.authorName,
  body: row.body,
  intent: (row.intent as MessageIntent | null) ?? null,
  intentConfidence: row.intentConfidence === null ? null : Number(row.intentConfidence),
  outboundKind: (row.outboundKind as OutboundKind | null) ?? null,
  deliveryState: row.deliveryState as DeliveryState,
  deliveryAttempts: row.deliveryAttempts,
  deliveryError: row.deliveryError,
  externalMessageId: row.externalMessageId,
  inReplyToMessageId: row.inReplyToMessageId,
  approvalRequestId: row.approvalRequestId,
  evidence: asEvidence(row.evidence),
  createdAt: row.createdAt.toISOString(),
});

export async function toConversationDto(row: ConversationRow, handle: DbHandle = db): Promise<ConversationDto> {
  const [names] = await handle
    .select({ projectName: projects.name, taskTitle: tasks.title })
    .from(conversations)
    .leftJoin(projects, eq(projects.id, conversations.projectId))
    .leftJoin(tasks, eq(tasks.id, conversations.taskId))
    .where(eq(conversations.id, row.id))
    .limit(1);

  const participants = await handle
    .select()
    .from(conversationParticipants)
    .where(eq(conversationParticipants.conversationId, row.id));

  return {
    id: row.id,
    channel: row.channel as ConversationChannel,
    status: row.status as ConversationStatus,
    title: row.title,
    projectId: row.projectId,
    projectName: names?.projectName ?? null,
    taskId: row.taskId,
    taskTitle: names?.taskTitle ?? null,
    externalRef: row.externalRef,
    companyContext: await contextRefFor(row.companyContextRevisionId, handle),
    participants: participants.map(
      (p): ConversationParticipantDto => ({
        id: p.id,
        kind: p.kind as ParticipantKind,
        userId: p.userId,
        externalId: p.externalId,
        displayName: p.displayName,
        firstSeenAt: p.firstSeenAt.toISOString(),
        lastSeenAt: p.lastSeenAt.toISOString(),
      }),
    ),
    messageCount: row.messageCount,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Starting and finding
// ---------------------------------------------------------------------------

export interface StartConversationInput {
  channel: ConversationChannel;
  projectId?: string | null;
  taskId?: string | null;
  title?: string;
  externalRef?: string | null;
  serviceUrl?: string | null;
  tenantId?: string | null;
  companyContextRevisionId?: string | null;
}

export async function startConversation(
  input: StartConversationInput,
  actor: Actor,
  handle?: DbHandle,
): Promise<ConversationRow> {
  const run = async (tx: DbHandle): Promise<ConversationRow> => {
    const [row] = await tx
      .insert(conversations)
      .values({
        channel: input.channel,
        projectId: input.projectId ?? null,
        taskId: input.taskId ?? null,
        title: (input.title ?? '').slice(0, 200),
        externalRef: input.externalRef ?? null,
        serviceUrl: input.serviceUrl ?? null,
        tenantId: input.tenantId ?? null,
        companyContextRevisionId: input.companyContextRevisionId ?? null,
        createdBy: actor.type === 'user' ? actor.id : null,
      })
      .returning();
    if (!row) throw new AppError(500, 'CONVERSATION_NOT_CREATED', 'The conversation could not be created.');

    await record(tx, {
      actor,
      eventType: 'conversation.started',
      context: { projectId: input.projectId ?? null, taskId: input.taskId ?? null },
      metadata: { conversationId: row.id, channel: input.channel, externalRef: input.externalRef ?? null },
    });

    return row;
  };

  return handle ? run(handle) : db.transaction(run);
}

/**
 * Finds the conversation a channel's own thread id belongs to, or starts one.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS UPSERT-SHAPED AND NOT read-then-write
 *
 * Teams delivers activities concurrently. Two messages arriving in the same
 * thread within a few milliseconds would both find no conversation and both
 * create one, and the thread would split in half — with the second half missing
 * everything said in the first.
 *
 * The unique index on `(channel, external_ref)` is what actually prevents that;
 * `onConflictDoNothing` plus a re-read is how this function survives losing the
 * race rather than throwing.
 * ---------------------------------------------------------------------------
 */
export async function findOrStartByExternalRef(
  input: StartConversationInput & { externalRef: string },
  actor: Actor,
  handle: DbHandle = db,
): Promise<{ conversation: ConversationRow; created: boolean }> {
  const existing = await byExternalRef(input.channel, input.externalRef, handle);
  if (existing) return { conversation: existing, created: false };

  const [row] = await handle
    .insert(conversations)
    .values({
      channel: input.channel,
      projectId: input.projectId ?? null,
      taskId: input.taskId ?? null,
      title: (input.title ?? '').slice(0, 200),
      externalRef: input.externalRef,
      serviceUrl: input.serviceUrl ?? null,
      tenantId: input.tenantId ?? null,
      companyContextRevisionId: input.companyContextRevisionId ?? null,
      createdBy: actor.type === 'user' ? actor.id : null,
    })
    .onConflictDoNothing()
    .returning();

  if (!row) {
    // Lost the race. The other insert won, and its row is the thread.
    const found = await byExternalRef(input.channel, input.externalRef, handle);
    if (!found) throw new AppError(500, 'CONVERSATION_NOT_CREATED', 'The conversation could not be created.');
    return { conversation: found, created: false };
  }

  await record(handle, {
    actor,
    eventType: 'conversation.started',
    context: { projectId: input.projectId ?? null, taskId: input.taskId ?? null },
    metadata: { conversationId: row.id, channel: input.channel, externalRef: input.externalRef },
  });

  return { conversation: row, created: true };
}

async function byExternalRef(
  channel: ConversationChannel,
  externalRef: string,
  handle: DbHandle,
): Promise<ConversationRow | null> {
  const [row] = await handle
    .select()
    .from(conversations)
    .where(and(eq(conversations.channel, channel), eq(conversations.externalRef, externalRef)))
    .limit(1);
  return row ?? null;
}

export async function requireConversation(id: string, handle: DbHandle = db): Promise<ConversationRow> {
  const [row] = await handle.select().from(conversations).where(eq(conversations.id, id)).limit(1);
  if (!row) throw AppError.notFound('Conversation');
  return row;
}

export async function getConversation(id: string): Promise<ConversationDto> {
  return toConversationDto(await requireConversation(id));
}

export async function listConversations(
  filter: { taskId?: string; projectId?: string; channel?: ConversationChannel; limit?: number } = {},
): Promise<ConversationDto[]> {
  const conditions = [
    filter.taskId ? eq(conversations.taskId, filter.taskId) : undefined,
    filter.projectId ? eq(conversations.projectId, filter.projectId) : undefined,
    filter.channel ? eq(conversations.channel, filter.channel) : undefined,
  ].filter(Boolean);

  const rows = await db
    .select()
    .from(conversations)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.createdAt))
    .limit(Math.min(filter.limit ?? 50, 200));

  return Promise.all(rows.map((row) => toConversationDto(row)));
}

export async function listMessages(
  conversationId: string,
  options: { afterSeq?: number; limit?: number } = {},
): Promise<ConversationMessageDto[]> {
  const rows = await db
    .select()
    .from(conversationMessages)
    .where(
      options.afterSeq
        ? and(eq(conversationMessages.conversationId, conversationId), gt(conversationMessages.seq, options.afterSeq))
        : eq(conversationMessages.conversationId, conversationId),
    )
    .orderBy(conversationMessages.seq)
    .limit(Math.min(options.limit ?? 200, 500));

  return rows.map(toMessageDto);
}

/**
 * Associates a conversation with a task.
 *
 * One-way and one-time: a conversation that has been about a task stays about
 * it. Re-pointing a thread at different work would silently move everything
 * said in it, and the honest way to talk about different work is a different
 * thread.
 */
export async function linkConversationToTask(
  conversationId: string,
  input: { taskId: string; projectId: string },
  actor: Actor,
  handle: DbHandle = db,
): Promise<void> {
  const conversation = await requireConversation(conversationId, handle);
  if (conversation.taskId === input.taskId) return;
  if (conversation.taskId) {
    throw AppError.conflict(
      'CONVERSATION_ALREADY_LINKED',
      'This conversation is already about another task. Start a new one for different work.',
    );
  }

  await handle
    .update(conversations)
    .set({ taskId: input.taskId, projectId: input.projectId, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));

  await record(handle, {
    actor,
    eventType: 'conversation.linked_to_task',
    context: { projectId: input.projectId, taskId: input.taskId },
    metadata: { conversationId },
  });
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

export async function noteParticipant(
  conversationId: string,
  participant: { kind: ParticipantKind; userId?: string | null; externalId?: string | null; displayName: string },
  handle: DbHandle = db,
): Promise<void> {
  const key = participant.userId ?? participant.externalId ?? participant.displayName;

  const existing = await handle
    .select({ id: conversationParticipants.id })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        sql`COALESCE(${conversationParticipants.userId}::text, ${conversationParticipants.externalId}, ${conversationParticipants.displayName}) = ${key}`,
      ),
    )
    .limit(1);

  if (existing.length) {
    await handle
      .update(conversationParticipants)
      .set({ lastSeenAt: new Date() })
      .where(eq(conversationParticipants.id, existing[0]!.id));
    return;
  }

  await handle
    .insert(conversationParticipants)
    .values({
      conversationId,
      kind: participant.kind,
      userId: participant.userId ?? null,
      externalId: participant.externalId ?? null,
      displayName: participant.displayName.slice(0, 200),
    })
    .onConflictDoNothing();
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface AppendMessageInput {
  conversationId: string;
  direction: MessageDirection;
  channel: ConversationChannel;
  authorKind: ParticipantKind;
  authorUserId?: string | null;
  authorName: string;
  body: string;
  intent?: MessageIntent | null;
  intentConfidence?: number | null;
  outboundKind?: OutboundKind | null;
  deliveryState?: DeliveryState;
  /** The channel's own message id. Present, this is the idempotency key. */
  externalMessageId?: string | null;
  inReplyToMessageId?: string | null;
  approvalRequestId?: string | null;
  evidence?: MessageEvidence;
}

export interface AppendResult {
  message: ConversationMessageDto;
  /** False when this exact external message had already been recorded. */
  created: boolean;
}

/**
 * Appends a message.
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENCY IS A DATABASE CONSTRAINT, NOT A CHECK IN A HANDLER
 *
 * Teams retries. So does any webhook worth trusting. A handler that reads "have
 * I seen this id?" and then inserts has a window between the two in which a
 * concurrent redelivery does the same thing, and the message is recorded twice
 * — which, for an inbound message that creates a task, means two tasks.
 *
 * The unique index on `(channel, external_message_id)` closes that window.
 * `onConflictDoNothing` plus a re-read is how this survives losing the race,
 * and `created: false` is what tells the caller not to act on it a second time.
 *
 * ---------------------------------------------------------------------------
 * SEQUENCE ALLOCATION
 *
 * `seq` is allocated under a row lock on the conversation. Two messages
 * arriving at once would otherwise compute the same `max(seq) + 1` and one
 * insert would fail on the unique index — correct, but a lost message rather
 * than a retried one. Locking the parent makes the allocation serial and the
 * insert always succeed.
 */
export async function appendMessage(input: AppendMessageInput, actor: Actor = SYSTEM_ACTOR): Promise<AppendResult> {
  return db.transaction(async (tx) => {
    // Existing external message: return it, and say it is not new.
    if (input.externalMessageId) {
      const [seen] = await tx
        .select()
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.channel, input.channel),
            eq(conversationMessages.externalMessageId, input.externalMessageId),
          ),
        )
        .limit(1);
      if (seen) return { message: toMessageDto(seen), created: false };
    }

    // Serialises seq allocation for this conversation.
    const [conversation] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, input.conversationId))
      .for('update')
      .limit(1);
    if (!conversation) throw AppError.notFound('Conversation');

    const [highest] = await tx
      .select({ seq: sql<number>`COALESCE(MAX(${conversationMessages.seq}), 0)` })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, input.conversationId));

    const seq = Number(highest?.seq ?? 0) + 1;

    const [row] = await tx
      .insert(conversationMessages)
      .values({
        conversationId: input.conversationId,
        seq,
        direction: input.direction,
        channel: input.channel,
        authorKind: input.authorKind,
        authorUserId: input.authorUserId ?? null,
        authorName: input.authorName.slice(0, 200),
        body: input.body,
        intent: input.intent ?? null,
        intentConfidence: input.intentConfidence === null || input.intentConfidence === undefined
          ? null
          : input.intentConfidence.toFixed(3),
        outboundKind: input.outboundKind ?? null,
        deliveryState: input.deliveryState ?? (input.direction === 'inbound' ? 'not_required' : 'not_required'),
        externalMessageId: input.externalMessageId ?? null,
        inReplyToMessageId: input.inReplyToMessageId ?? null,
        approvalRequestId: input.approvalRequestId ?? null,
        evidence: input.evidence ?? emptyMessageEvidence(),
      })
      .onConflictDoNothing()
      .returning();

    if (!row) {
      // Lost the idempotency race; the other insert holds the message.
      const [seen] = await tx
        .select()
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.channel, input.channel),
            eq(conversationMessages.externalMessageId, input.externalMessageId ?? ''),
          ),
        )
        .limit(1);
      if (seen) return { message: toMessageDto(seen), created: false };
      throw new AppError(500, 'MESSAGE_NOT_RECORDED', 'The message could not be recorded.');
    }

    await tx
      .update(conversations)
      .set({
        messageCount: conversation.messageCount + 1,
        lastMessageAt: row.createdAt,
        updatedAt: new Date(),
        // The first substantive message names the thread, so a conversation
        // list is readable without opening anything.
        ...(conversation.title ? {} : { title: input.body.slice(0, 120) }),
      })
      .where(eq(conversations.id, input.conversationId));

    await record(tx, {
      actor,
      eventType: input.direction === 'inbound' ? 'conversation.message_received' : 'conversation.message_sent',
      context: { projectId: conversation.projectId, taskId: conversation.taskId },
      metadata: {
        conversationId: input.conversationId,
        messageId: row.id,
        channel: input.channel,
        seq,
        // The LENGTH, not the body. Part I §32: avoid recording unnecessary
        // full message payloads in high-volume audit tables. The message itself
        // is one join away in a table built for it.
        length: input.body.length,
        intent: input.intent ?? null,
        outboundKind: input.outboundKind ?? null,
      },
    });

    await emit(tx, {
      type: 'conversation_message',
      conversationId: input.conversationId,
      projectId: conversation.projectId,
      taskId: conversation.taskId,
      data: { direction: input.direction, channel: input.channel, seq, intent: input.intent ?? null },
    });

    return { message: toMessageDto(row), created: true };
  });
}

/** Marks an outbound message as delivered, or as having failed. */
export async function recordDelivery(
  messageId: string,
  outcome: { state: DeliveryState; providerMessageId?: string | null; error?: string | null },
  handle: DbHandle = db,
): Promise<void> {
  await handle
    .update(conversationMessages)
    .set({
      deliveryState: outcome.state,
      deliveryAttempts: sql`${conversationMessages.deliveryAttempts} + 1`,
      providerMessageId: outcome.providerMessageId ?? null,
      deliveryError: outcome.error?.slice(0, 1000) ?? null,
    })
    .where(eq(conversationMessages.id, messageId));
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/**
 * What a model is given about a conversation (Phase 4 §10).
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO CODE PATH THAT PUTS THE WHOLE TRANSCRIPT IN A PROMPT
 *
 * The brief: "Do not rely on entire raw conversation history being stuffed into
 * every model prompt. Use structured context/retrieval."
 *
 * That is enforced by shape rather than by discipline. `ConversationContext`
 * has no `transcript` field, so there is nowhere for the full history to go —
 * and the tail is bounded by a constant rather than by a parameter a caller
 * could raise to "all of it" on a busy afternoon.
 *
 * What survives from before the tail is the structured summary plus the durable
 * items carried forward: decisions, corrections, project facts and unresolved
 * questions. Those are the four a conversation cannot afford to forget — a
 * correction that gets compressed away is a mistake that will be made again.
 * ---------------------------------------------------------------------------
 */
export async function buildConversationContext(
  conversationId: string,
  handle: DbHandle = db,
): Promise<ConversationContext> {
  const conversation = await requireConversation(conversationId, handle);

  const [summaryRow] = await handle
    .select()
    .from(conversationSummaries)
    .where(eq(conversationSummaries.conversationId, conversationId))
    .orderBy(desc(conversationSummaries.coversToSeq))
    .limit(1);

  const summary = summaryRow ? parseSummary(summaryRow.content) : null;

  const tail = await handle
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, conversationId))
    .orderBy(desc(conversationMessages.seq))
    .limit(CONVERSATION_TAIL_MESSAGES);

  /*
   * Durable items pulled forward from EVERY summary, not only the latest.
   *
   * A correction made two summaries ago is still a correction. Reading only the
   * most recent summary would quietly expire the very things the summary schema
   * exists to preserve.
   */
  const allSummaries = await handle
    .select({ content: conversationSummaries.content })
    .from(conversationSummaries)
    .where(eq(conversationSummaries.conversationId, conversationId))
    .orderBy(conversationSummaries.coversFromSeq);

  const carried = { decisions: [] as string[], corrections: [] as string[], projectFacts: [] as string[], unresolvedQuestions: [] as string[] };
  for (const row of allSummaries) {
    const parsed = parseSummary(row.content);
    carried.decisions.push(...parsed.decisions);
    carried.corrections.push(...parsed.corrections);
    carried.projectFacts.push(...parsed.projectFacts);
    carried.unresolvedQuestions.push(...parsed.unresolvedQuestions);
  }

  return {
    conversationId,
    channel: conversation.channel as ConversationChannel,
    projectId: conversation.projectId,
    taskId: conversation.taskId,
    summary,
    recent: tail
      .reverse()
      .map((row) => ({
        author: row.authorKind === 'mac' ? 'Mac' : row.authorName || 'User',
        body: row.body,
        at: row.createdAt.toISOString(),
        intent: (row.intent as MessageIntent | null) ?? null,
      })),
    carriedForward: {
      decisions: dedupe(carried.decisions),
      corrections: dedupe(carried.corrections),
      projectFacts: dedupe(carried.projectFacts),
      unresolvedQuestions: dedupe(carried.unresolvedQuestions),
    },
  };
}

const dedupe = (items: string[]): string[] => Array.from(new Set(items)).slice(0, 40);

const parseSummary = (value: unknown): ConversationSummaryContent => {
  const parsed = conversationSummaryContentSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : conversationSummaryContentSchema.parse({});
};

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export async function listSummaries(conversationId: string, handle: DbHandle = db): Promise<ConversationSummaryDto[]> {
  const rows = await handle
    .select()
    .from(conversationSummaries)
    .where(eq(conversationSummaries.conversationId, conversationId))
    .orderBy(conversationSummaries.coversFromSeq);

  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversationId,
    coversFromSeq: row.coversFromSeq,
    coversToSeq: row.coversToSeq,
    content: parseSummary(row.content),
    modelProvider: row.modelProvider,
    modelName: row.modelName,
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * Stores a summary.
 *
 * Insert only. There is no update path and no delete path, here or anywhere:
 * §11 requires that a generated summary must not overwrite source messages, and
 * the cheapest way to guarantee that is for the module that writes summaries to
 * contain no statement that could modify a message.
 */
export async function storeSummary(
  input: {
    conversationId: string;
    coversFromSeq: number;
    coversToSeq: number;
    content: ConversationSummaryContent;
    modelProvider?: string | null;
    modelName?: string | null;
  },
  actor: Actor = SYSTEM_ACTOR,
  handle: DbHandle = db,
): Promise<void> {
  await handle.insert(conversationSummaries).values({
    conversationId: input.conversationId,
    coversFromSeq: input.coversFromSeq,
    coversToSeq: input.coversToSeq,
    content: input.content,
    modelProvider: input.modelProvider ?? null,
    modelName: input.modelName ?? null,
  });

  await record(handle, {
    actor,
    eventType: 'conversation.summarised',
    metadata: {
      conversationId: input.conversationId,
      coversFromSeq: input.coversFromSeq,
      coversToSeq: input.coversToSeq,
      decisions: input.content.decisions.length,
      corrections: input.content.corrections.length,
    },
  });
}

/** The highest sequence any summary already covers. */
export async function summarisedThrough(conversationId: string, handle: DbHandle = db): Promise<number> {
  const [row] = await handle
    .select({ seq: sql<number>`COALESCE(MAX(${conversationSummaries.coversToSeq}), 0)` })
    .from(conversationSummaries)
    .where(eq(conversationSummaries.conversationId, conversationId));
  return Number(row?.seq ?? 0);
}
