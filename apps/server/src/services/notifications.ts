import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  buildApprovalCard,
  buildQuestionCard,
  AUTHORITY_REFUSALS,
  isConversationallyApprovable,
  type AuthorityClass,
  type ConversationChannel,
} from '@mac/protocol';
import { db } from '../db/client.js';
import { approvalRequests, conversationMessages, conversations, projects, tasks } from '../db/schema.js';
import { decideNotification, type NotificationTrigger } from '../domain/notification-policy.js';
import { record, SYSTEM_ACTOR, type Actor } from './audit.js';
import { appendMessage, recordDelivery } from './conversations.js';
import { noteDelivered } from './approval-requests.js';
import { deliverToTeams } from './teams/inbound.js';
import { getSettings } from './settings.js';

/**
 * Reaching a person (Phase 4 Part B §7, Part G §27).
 *
 * ---------------------------------------------------------------------------
 * THE POLICY DECIDES; THIS MODULE DELIVERS
 *
 * `domain/notification-policy.ts` holds the single answer to "may Mac interrupt
 * somebody about this?", and nothing here second-guesses it. That separation is
 * what stops the list growing: adding a notification means adding a row to a
 * table somebody reviews, not an `if` at a call site nobody revisits.
 *
 * A suppressed notification is AUDITED. "Mac did not tell me" and "Mac was
 * never asked to tell me" look identical from the outside, and the second is
 * what somebody will assume when they missed something.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface NotifyInput {
  trigger: NotificationTrigger;
  /** Which conversation to speak in. Without one there is nobody to tell. */
  conversationId?: string | null;
  taskId?: string | null;
  projectId?: string | null;
  text: string;
  approvalRequestId?: string | null;
  highPriority?: boolean;
  actor?: Actor;
}

export interface NotifyResult {
  sent: boolean;
  reason: string;
  messageId: string | null;
}

/**
 * Sends a proactive message, if policy and settings both permit it.
 *
 * Returns rather than throws when it declines, because declining is the normal
 * case for most triggers and an exception would make every call site handle a
 * routine outcome as an error.
 */
export async function notify(input: NotifyInput): Promise<NotifyResult> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const settings = await getSettings();

  const settingEnabled =
    input.trigger === 'blocker_raised'
      ? settings.teamsNotifyBlockers
      : input.trigger === 'approval_required' || input.trigger === 'question_required'
        ? settings.teamsNotifyApprovals
        : input.trigger === 'morning_report'
          ? settings.teamsNotifyReports
          : true;

  const decision = decideNotification({
    trigger: input.trigger,
    settingEnabled,
    ...(input.highPriority !== undefined ? { highPriority: input.highPriority } : {}),
  });

  if (!decision.send) {
    await suppressed(input, decision.rationale, actor);
    return { sent: false, reason: decision.rationale, messageId: null };
  }

  const conversationId = input.conversationId ?? (await conversationForTask(input.taskId ?? null));
  if (!conversationId) {
    const reason = 'There is no conversation to send this to.';
    await suppressed(input, reason, actor);
    return { sent: false, reason, messageId: null };
  }

  const [conversation] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  if (!conversation) {
    return { sent: false, reason: 'The conversation no longer exists.', messageId: null };
  }

  const channel = conversation.channel as ConversationChannel;

  const { message } = await appendMessage(
    {
      conversationId,
      direction: 'outbound',
      channel,
      authorKind: 'mac',
      authorName: 'Mac Bennett',
      body: input.text,
      outboundKind: decision.outboundKind,
      // Only pushing channels queue. A web conversation is delivered by the
      // reader asking for it, so marking it pending would leave the sweeper a
      // backlog it can never clear.
      deliveryState: channel === 'teams' ? 'pending' : 'not_required',
      approvalRequestId: input.approvalRequestId ?? null,
    },
    actor,
  );

  if (channel === 'teams') {
    await deliverOne(message.id, conversationId, input.text, input.approvalRequestId ?? null, actor);
  }

  if (input.approvalRequestId) await noteDelivered(input.approvalRequestId, channel);

  await db.transaction(async (tx) => {
    await record(tx, {
      actor,
      eventType: input.trigger === 'blocker_raised' ? 'blocker.notified' : 'conversation.message_sent',
      context: { taskId: input.taskId ?? null, projectId: input.projectId ?? null },
      metadata: { trigger: input.trigger, channel, conversationId, messageId: message.id },
    });
  });

  return { sent: true, reason: decision.rationale, messageId: message.id };
}

async function suppressed(input: NotifyInput, reason: string, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    await record(tx, {
      actor,
      eventType: 'notification.suppressed',
      context: { taskId: input.taskId ?? null, projectId: input.projectId ?? null },
      metadata: { trigger: input.trigger, reason },
    });
  });
}

/**
 * The conversation a task's notifications belong in.
 *
 * The most recent one about that task, whatever channel it is on. Mac replies
 * where the conversation is rather than starting a new thread for every
 * notification — which is the difference between a colleague and a robot.
 */
async function conversationForTask(taskId: string | null): Promise<string | null> {
  if (!taskId) return null;
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.taskId, taskId), eq(conversations.status, 'open')))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1);
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// Approval delivery
// ---------------------------------------------------------------------------

/**
 * Delivers an approval request as a card.
 *
 * The card carries the request id on its buttons, which is what makes a card
 * action bind by construction rather than by inference — and it shows the code
 * anyway, because somebody reading this on a phone may reply by text.
 */
export async function deliverApprovalRequest(requestId: string, actor: Actor = SYSTEM_ACTOR): Promise<NotifyResult> {
  const [row] = await db
    .select({ request: approvalRequests, projectName: projects.name, taskTitle: tasks.title })
    .from(approvalRequests)
    .innerJoin(projects, eq(projects.id, approvalRequests.projectId))
    .innerJoin(tasks, eq(tasks.id, approvalRequests.taskId))
    .where(eq(approvalRequests.id, requestId))
    .limit(1);

  if (!row) return { sent: false, reason: 'No such approval request.', messageId: null };

  const authority = row.request.authority as AuthorityClass;
  const decidable = isConversationallyApprovable(authority);

  const card = buildApprovalCard({
    code: row.request.code,
    title: row.request.title,
    detail: row.request.detail,
    recommendation: row.request.recommendation,
    risk: row.request.risk,
    authority,
    project: row.projectName,
    task: row.taskTitle,
    confidence: row.request.confidence === null ? null : Number(row.request.confidence),
    expiresAt: row.request.expiresAt?.toISOString() ?? null,
    requestId: row.request.id,
    decidable,
    refusal: decidable ? null : (AUTHORITY_REFUSALS[authority] ?? null),
  });

  const result = await notify({
    trigger: 'approval_required',
    taskId: row.request.taskId,
    projectId: row.request.projectId,
    approvalRequestId: row.request.id,
    text:
      `**${row.request.title}** (${row.request.code})\n\n${row.request.detail}` +
      (decidable ? `\n\nApprove with the buttons, or reply "approve ${row.request.code}".` : ''),
    actor,
  });

  if (result.sent && result.messageId) await attachCard(result.messageId, card, actor);
  return result;
}

/** Delivers a discovery question with everything §6 requires it to carry. */
export async function deliverQuestion(input: {
  taskId: string;
  projectId: string;
  question: string;
  why: string;
  options?: readonly string[];
  recommendation?: string;
  confidence: number | null;
  questionId: string;
  actor?: Actor;
}): Promise<NotifyResult> {
  const [names] = await db
    .select({ projectName: projects.name, taskTitle: tasks.title })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, input.taskId))
    .limit(1);

  const card = buildQuestionCard({
    question: input.question,
    why: input.why,
    project: names?.projectName ?? '',
    task: names?.taskTitle ?? '',
    options: input.options ?? [],
    recommendation: input.recommendation ?? '',
    confidence: input.confidence,
    questionId: input.questionId,
  });

  const result = await notify({
    trigger: 'question_required',
    taskId: input.taskId,
    projectId: input.projectId,
    text: `${input.question}${input.why ? `\n\n_${input.why}_` : ''}`,
    ...(input.actor ? { actor: input.actor } : {}),
  });

  if (result.sent && result.messageId) await attachCard(result.messageId, card, input.actor ?? SYSTEM_ACTOR);
  return result;
}

/**
 * Re-sends the message with its card attached.
 *
 * Two steps rather than one because `notify` is the policy gate and knows
 * nothing about cards, and a card that bypassed the gate would be a
 * notification nobody had decided to send.
 */
async function attachCard(
  messageId: string,
  card: ReturnType<typeof buildApprovalCard>,
  actor: Actor,
): Promise<void> {
  const [message] = await db
    .select({ message: conversationMessages, serviceUrl: conversations.serviceUrl, externalRef: conversations.externalRef })
    .from(conversationMessages)
    .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
    .where(eq(conversationMessages.id, messageId))
    .limit(1);

  if (!message || message.message.channel !== 'teams' || !message.externalRef) return;

  await deliverToTeams({
    messageId,
    serviceUrl: message.serviceUrl,
    conversationRef: message.externalRef,
    text: message.message.body,
    attachments: [card],
    actor,
  });
}

// ---------------------------------------------------------------------------
// The sweeper
// ---------------------------------------------------------------------------

/** Attempts before a message is dead-lettered. Mirrors the mail outbox. */
const MAX_DELIVERY_ATTEMPTS = 6;

/**
 * Retries outbound messages that failed.
 *
 * Idempotent and safe to miss a tick, like every other sweeper here. The unique
 * constraint on the message row is what makes a concurrent second sweeper
 * harmless — Sprint 3.1 defect 24 was two sweepers double-sending mail, and the
 * fix generalises.
 */
export async function deliverPendingMessages(): Promise<{
  sent: number;
  failed: number;
  dead: number;
  approvals: number;
}> {
  const settings = await getSettings();
  if (!settings.teamsEnabled) return { sent: 0, failed: 0, dead: 0, approvals: 0 };

  const approvals = await deliverUndeliveredApprovals();

  const pending = await db
    .select({
      message: conversationMessages,
      serviceUrl: conversations.serviceUrl,
      externalRef: conversations.externalRef,
    })
    .from(conversationMessages)
    .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
    .where(
      and(
        eq(conversationMessages.direction, 'outbound'),
        eq(conversationMessages.channel, 'teams'),
        inArray(conversationMessages.deliveryState, ['pending', 'failed']),
        lt(conversationMessages.deliveryAttempts, MAX_DELIVERY_ATTEMPTS),
      ),
    )
    .orderBy(conversationMessages.createdAt)
    .limit(25);

  let sent = 0;
  let failed = 0;

  for (const row of pending) {
    if (!row.externalRef) {
      await recordDelivery(row.message.id, { state: 'dead', error: 'The conversation has no Teams thread id.' });
      continue;
    }
    const ok = await deliverToTeams({
      messageId: row.message.id,
      serviceUrl: row.serviceUrl,
      conversationRef: row.externalRef,
      text: row.message.body,
    });
    if (ok) sent += 1;
    else failed += 1;
  }

  // Anything past its attempt ceiling stops being retried and starts being
  // visible. A message retried forever is a message nobody investigates.
  const deadened = await db
    .update(conversationMessages)
    .set({ deliveryState: 'dead' })
    .where(
      and(
        eq(conversationMessages.deliveryState, 'failed'),
        sql`${conversationMessages.deliveryAttempts} >= ${MAX_DELIVERY_ATTEMPTS}`,
      ),
    )
    .returning({ id: conversationMessages.id });

  return { sent, failed, dead: deadened.length, approvals };
}

/**
 * Delivers approval requests that have not reached anybody yet.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SWEEP AND NOT A CALL INSIDE `createApprovalRequest`
 *
 * Two reasons, and the second is the one that decided it.
 *
 * Notifying inside the creating transaction would make `approval-requests.ts`
 * import `notifications.ts`, which imports it back for `noteDelivered` — a
 * cycle, and cycles between services are how a module ends up half-initialised
 * in a way that only shows up under a specific import order.
 *
 * More importantly: a notification fired inline is lost if the process dies
 * between the commit and the send. An approval nobody was told about is an
 * approval nobody decides, and the run waits all night for a message that was
 * never sent. Sweeping from persisted state means a restart picks it up.
 * ---------------------------------------------------------------------------
 */
export async function deliverUndeliveredApprovals(): Promise<number> {
  const pending = await db
    .select({ id: approvalRequests.id, taskId: approvalRequests.taskId })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.state, 'pending'),
        // Never delivered anywhere. `delivered_channels` is appended to on
        // every successful send, so this is the "nobody has been told" set.
        sql`jsonb_array_length(${approvalRequests.deliveredChannels}) = 0`,
      ),
    )
    .orderBy(approvalRequests.requestedAt)
    .limit(20);

  let delivered = 0;
  for (const row of pending) {
    const result = await deliverApprovalRequest(row.id);
    if (result.sent) delivered += 1;
  }
  return delivered;
}

async function deliverOne(
  messageId: string,
  conversationId: string,
  text: string,
  _approvalRequestId: string | null,
  actor: Actor,
): Promise<void> {
  const [conversation] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  if (!conversation?.externalRef) {
    await recordDelivery(messageId, { state: 'failed', error: 'The conversation has no Teams thread id.' });
    return;
  }

  await deliverToTeams({
    messageId,
    serviceUrl: conversation.serviceUrl,
    conversationRef: conversation.externalRef,
    text,
    actor,
  });
}
