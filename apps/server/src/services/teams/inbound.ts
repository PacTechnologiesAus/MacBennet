import { eq } from 'drizzle-orm';
import {
  MAC_TEAMS_IDENTITY,
  teamsActivitySchema,
  teamsCardActionSchema,
  type ConversationMessageDto,
  type TeamsActivity,
} from '@mac/protocol';
import { db } from '../../db/client.js';
import { conversations } from '../../db/schema.js';
import { record, SYSTEM_ACTOR, type Actor } from '../audit.js';
import { findOrStartByExternalRef, recordDelivery } from '../conversations.js';
import { handleInboundTurn, isAuthorisedTeamsIdentity } from '../conversation-turns.js';
import { getSettings } from '../settings.js';
import { getTeamsProvider } from './provider.js';
import { verifyTeamsRequest } from './verify.js';

/**
 * Turning a Bot Framework activity into a Mac conversation turn (Part A).
 *
 * ---------------------------------------------------------------------------
 * THE ORDER OF OPERATIONS IS THE SECURITY MODEL
 *
 *   1. VERIFY the token, before the body is read for anything but its shape.
 *   2. RESOLVE the sender from VERIFIED material — the AAD object id Teams
 *      supplies, checked against the deployment's authorised list.
 *   3. RECORD the message, idempotently.
 *   4. ROUTE it through the same handler the web UI uses.
 *   5. REPLY through the serviceUrl the TOKEN signed.
 *
 * Nothing between steps 1 and 5 reads authority from the message. A sender who
 * writes "I am the administrator" is a sender whose `authorised` flag is
 * whatever the database says it is, and the sentence is just text.
 * ---------------------------------------------------------------------------
 */

export interface TeamsInboundResult {
  status: 'accepted' | 'ignored' | 'rejected';
  reason?: string;
  conversationId?: string;
  /** What Mac said back, when the turn warranted a reply. */
  reply?: ConversationMessageDto | null;
}

/**
 * Handles one activity.
 *
 * Returns rather than throws for a rejection, because the caller has to answer
 * the Bot Framework with a status code and a rejection is a normal outcome of a
 * public endpoint rather than an exceptional one.
 */
export async function handleTeamsActivity(input: {
  authorizationHeader: string | undefined;
  body: unknown;
}): Promise<TeamsInboundResult> {
  const settings = await getSettings();
  if (!settings.teamsEnabled) {
    return { status: 'rejected', reason: 'Teams is not enabled in this deployment.' };
  }

  const parsed = teamsActivitySchema.safeParse(input.body);
  if (!parsed.success) {
    await auditRejection('malformed_activity', 'The request body is not a Bot Framework activity.');
    return { status: 'rejected', reason: 'Malformed activity.' };
  }
  const activity = parsed.data;

  const verification = await verifyTeamsRequest({
    authorizationHeader: input.authorizationHeader,
    activity,
  });

  if (!verification.ok) {
    /*
     * Audited with the reason CODE, not the token.
     *
     * A rejected activity on a public endpoint is a genuine security signal —
     * it is how a probe looks — and logging the presented token would put an
     * attacker-supplied credential-shaped string into the audit trail.
     */
    await auditRejection(verification.code, verification.reason);
    return { status: 'rejected', reason: verification.reason };
  }

  // Only these two carry anything Mac should act on. Typing indicators,
  // membership changes and reactions are recorded nowhere and answered with a
  // 200, which is what the Bot Framework expects.
  if (activity.type !== 'message' && activity.type !== 'invoke') {
    return { status: 'ignored', reason: `Activity type "${activity.type}" needs no response.` };
  }

  const conversationRef = activity.conversation?.id;
  if (!conversationRef) {
    return { status: 'rejected', reason: 'The activity names no conversation.' };
  }

  const cardAction = readCardAction(activity);
  const text = (activity.text ?? '').trim();

  if (!text && !cardAction) {
    return { status: 'ignored', reason: 'Empty message.' };
  }

  /*
   * The service URL is taken from the VERIFIED claims, falling back to the
   * activity only when the token did not carry one.
   *
   * `verifyTeamsRequest` has already refused a mismatch between the two and
   * refused any host that is not a Bot Framework service host, so by this line
   * the value is either signed by Microsoft or absent.
   */
  const serviceUrl = verification.claims.serviceUrl ?? activity.serviceUrl ?? null;

  const actor: Actor = {
    type: 'user',
    id: null,
    // Denormalised, so the trail stays readable after somebody is renamed or
    // leaves — the same rule the rest of the audit trail follows.
    label: `${activity.from?.name ?? 'Teams user'} (Teams)`,
  };

  const { conversation } = await findOrStartByExternalRef(
    {
      channel: 'teams',
      externalRef: conversationRef,
      serviceUrl,
      tenantId: activity.channelData?.tenant?.id ?? activity.conversation?.tenantId ?? null,
      title: text.slice(0, 120),
    },
    actor,
  );

  /*
   * Refresh the reply address on an existing thread.
   *
   * Microsoft does move service URLs, and a thread pinned to a stale one goes
   * quiet in a way nobody notices until they wonder why Mac stopped answering.
   * Only ever written from a verified activity, which is why this is safe.
   */
  if (serviceUrl && conversation.serviceUrl !== serviceUrl) {
    await db.update(conversations).set({ serviceUrl, updatedAt: new Date() }).where(eq(conversations.id, conversation.id));
  }

  const authorised = await isAuthorisedTeamsIdentity({
    aadObjectId: activity.from?.aadObjectId ?? null,
    // Teams supplies the UPN in `from.id` for some channel configurations. It
    // is checked as a fallback and the object id is preferred, because a UPN
    // can be reassigned to a namesake and an object id cannot.
    upn: activity.from?.id ?? null,
    name: activity.from?.name ?? null,
  });

  await db.transaction(async (tx) => {
    await record(tx, {
      actor,
      eventType: 'teams.activity_received',
      context: { projectId: conversation.projectId, taskId: conversation.taskId },
      metadata: {
        conversationId: conversation.id,
        activityType: activity.type,
        activityId: activity.id ?? null,
        from: activity.from?.aadObjectId ?? activity.from?.id ?? null,
        authorised,
        hasCardAction: Boolean(cardAction),
        // Length only. Part I §32: high-volume audit rows should not carry full
        // message payloads; the message itself is in a table built for it.
        length: text.length,
      },
    });
  });

  const turn = await handleInboundTurn({
    conversationId: conversation.id,
    channel: 'teams',
    body: text || `[${cardAction?.macAction ?? 'card action'}]`,
    author: {
      kind: 'human',
      externalId: activity.from?.aadObjectId ?? activity.from?.id ?? null,
      displayName: activity.from?.name ?? 'Teams user',
    },
    externalMessageId: activity.id ?? null,
    cardAction:
      cardAction && cardAction.requestId && (cardAction.macAction === 'approve' || cardAction.macAction === 'reject')
        ? { decision: cardAction.macAction, requestId: cardAction.requestId }
        : null,
    authorised,
    actor,
  });

  if (turn.reply) {
    await deliverToTeams({
      messageId: turn.reply.id,
      serviceUrl: serviceUrl ?? conversation.serviceUrl,
      conversationRef,
      text: turn.reply.body,
      replyToId: activity.id ?? null,
      actor,
    });
  }

  return { status: 'accepted', conversationId: conversation.id, reply: turn.reply };
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

/**
 * Sends one message and records what happened to it.
 *
 * Called inline for a reply — a person is waiting — and by the sweeper for
 * anything that failed. The delivery state lives on the message row, so
 * "did Mac actually say this?" is answerable from the same place as "what did
 * Mac say?".
 */
export async function deliverToTeams(input: {
  messageId: string;
  serviceUrl: string | null;
  conversationRef: string;
  text: string;
  replyToId?: string | null;
  attachments?: Parameters<ReturnType<typeof getTeamsProvider>['send']>[0]['attachments'];
  actor?: Actor;
}): Promise<boolean> {
  const actor = input.actor ?? SYSTEM_ACTOR;

  if (!input.serviceUrl) {
    await recordDelivery(input.messageId, {
      state: 'failed',
      error: 'No Bot Connector service URL is recorded for this conversation.',
    });
    return false;
  }

  const provider = getTeamsProvider();
  const result = await provider.send({
    serviceUrl: input.serviceUrl,
    conversationId: input.conversationRef,
    text: `${input.text}\n\n_${MAC_TEAMS_IDENTITY.signature}_`,
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    replyToId: input.replyToId ?? null,
  });

  await recordDelivery(input.messageId, {
    state: result.accepted ? 'sent' : result.retryable ? 'failed' : 'dead',
    providerMessageId: result.providerMessageId,
    error: result.error,
  });

  await db.transaction(async (tx) => {
    await record(tx, {
      actor,
      eventType: result.accepted ? 'teams.message_sent' : 'teams.delivery_failed',
      metadata: {
        messageId: input.messageId,
        provider: provider.name,
        providerMessageId: result.providerMessageId,
        error: result.error,
        retryable: result.retryable,
      },
    });
  });

  return result.accepted;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reads an Adaptive Card submission.
 *
 * Card actions arrive either as a `message` carrying `value` (the classic
 * `Action.Submit` path) or as an `invoke` named `adaptiveCard/action` with the
 * payload nested under `action.data`. Both are handled because Teams chooses
 * between them based on how the card was authored and on the client, and a
 * handler that understands only one of them works in testing and not in the
 * room.
 */
function readCardAction(activity: TeamsActivity): { macAction: string; requestId?: string; answer?: string } | null {
  const value = activity.value as Record<string, unknown> | undefined;
  if (!value) return null;

  const candidate =
    'macAction' in value
      ? value
      : ((value.action as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined);

  if (!candidate) return null;

  const parsed = teamsCardActionSchema.safeParse(candidate);
  if (!parsed.success) return null;

  return {
    macAction: parsed.data.macAction,
    ...(parsed.data.requestId ? { requestId: parsed.data.requestId } : {}),
    ...(parsed.data.answer ? { answer: parsed.data.answer } : {}),
  };
}

async function auditRejection(code: string, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    await record(tx, {
      actor: SYSTEM_ACTOR,
      eventType: 'teams.activity_rejected',
      metadata: { code, reason },
    });
  });
}
