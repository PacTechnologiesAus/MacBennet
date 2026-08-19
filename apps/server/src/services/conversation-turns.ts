import { and, desc, eq, ne } from 'drizzle-orm';
import {
  MAC_TEAMS_IDENTITY,
  renderBindingClarification,
  type ConversationChannel,
  type ConversationMessageDto,
  type ConversationTurnDto,
  type MessageIntent,
  type ParticipantKind,
} from '@mac/protocol';
import { db } from '../db/client.js';
import { conversationMessages, discoverySessions, projects } from '../db/schema.js';
import { classifyMessageIntent, isConsequentialIntent } from '../domain/message-intent.js';
import { record, type Actor } from './audit.js';
import { emit } from './events.js';
import {
  appendMessage,
  linkConversationToTask,
  noteParticipant,
  requireConversation,
  toConversationDto,
} from './conversations.js';
import { bindMessageToApproval, createApprovalRequest, decideApprovalRequest } from './approval-requests.js';
import { answerStatusQuery } from './status-queries.js';
import { addDiscoveryMessage, generateBrief, startDiscovery } from './discovery.js';
import { createTask } from './tasks.js';
import { getSettings } from './settings.js';

/**
 * What Mac does about an inbound message (Phase 4 Parts A, B, G).
 *
 * ---------------------------------------------------------------------------
 * ONE ROUTER, THREE DOORS
 *
 * Teams, the web UI and Forja all arrive here. They differ in authentication,
 * in how a message is delivered back, and in nothing else — which is what makes
 * "the same persistent Mac" a property of the code rather than a claim in a
 * document. A behaviour that existed only on the Teams path would be a second
 * Mac with extra steps.
 *
 * ---------------------------------------------------------------------------
 * CLASSIFICATION SELECTS A HANDLER. AUTHORISATION DECIDES WHAT IT MAY DO.
 *
 * These are separate on purpose and the separation is the security posture of
 * the whole channel. `classifyMessageIntent` reads attacker-controllable text
 * and returns an intent; `authorised` reads the database and returns a
 * permission. A message asserting new authority is classified perfectly happily
 * as an instruction and then refused, because no classifier in this system
 * returns a permission and there is no field in which one could.
 * ---------------------------------------------------------------------------
 */

export interface InboundTurn {
  conversationId: string;
  channel: ConversationChannel;
  body: string;
  author: {
    kind: ParticipantKind;
    userId?: string | null;
    externalId?: string | null;
    displayName: string;
  };
  /** The channel's own message id, for idempotency. */
  externalMessageId?: string | null;
  /** Set when the message came from an interactive approval control. */
  cardAction?: { decision: 'approve' | 'reject'; requestId: string } | null;
  /**
   * Whether this sender may cause Mac to change something.
   *
   * Supplied by the channel, which is the layer that knows how identity works
   * there. Never inferred from the message.
   */
  authorised: boolean;
  actor: Actor;
}

/**
 * Records the message, classifies it, and does whatever it warrants.
 *
 * Returns what was created so a caller need not poll to find out — which
 * matters for Forja, whose whole interface is request/response.
 */
export async function handleInboundTurn(input: InboundTurn): Promise<ConversationTurnDto> {
  const conversation = await requireConversation(input.conversationId);

  const pendingQuestion = await outstandingQuestionFor(conversation.taskId);
  const pendingApprovals = await hasPendingApproval(conversation.taskId);

  const classification = input.cardAction
    ? { intent: 'approval_response' as MessageIntent, confidence: 1, signals: ['approval control'] }
    : classifyMessageIntent(input.body, {
        hasPendingQuestion: Boolean(pendingQuestion),
        hasPendingApproval: pendingApprovals,
      });

  await noteParticipant(input.conversationId, {
    kind: input.author.kind,
    userId: input.author.userId ?? null,
    externalId: input.author.externalId ?? null,
    displayName: input.author.displayName,
  });

  const appended = await appendMessage(
    {
      conversationId: input.conversationId,
      direction: 'inbound',
      channel: input.channel,
      authorKind: input.author.kind,
      authorUserId: input.author.userId ?? null,
      authorName: input.author.displayName,
      body: input.body,
      intent: classification.intent,
      intentConfidence: classification.confidence,
      externalMessageId: input.externalMessageId ?? null,
    },
    input.actor,
  );

  /*
   * A redelivered message is recorded once and ACTED ON once.
   *
   * Teams retries. Without this, a retried "tonight investigate X" would create
   * a second task, and a retried approval would be applied twice. The unique
   * index guarantees the first half; returning early here is the second.
   */
  if (!appended.created) {
    await db.transaction(async (tx) => {
      await record(tx, {
        actor: input.actor,
        eventType: 'conversation.message_duplicate_ignored',
        context: { projectId: conversation.projectId, taskId: conversation.taskId },
        metadata: {
          conversationId: input.conversationId,
          channel: input.channel,
          externalMessageId: input.externalMessageId ?? null,
        },
      });
    });

    return {
      conversation: await toConversationDto(await requireConversation(input.conversationId)),
      message: appended.message,
      intent: appended.message.intent ?? 'conversation',
      intentConfidence: Number(appended.message.intentConfidence ?? 0),
      reply: null,
      created: { taskId: null, discoverySessionId: null, approvalRequestId: null },
    };
  }

  await db.transaction(async (tx) => {
    await record(tx, {
      actor: input.actor,
      eventType: 'conversation.intent_classified',
      context: { projectId: conversation.projectId, taskId: conversation.taskId },
      metadata: {
        conversationId: input.conversationId,
        messageId: appended.message.id,
        intent: classification.intent,
        confidence: classification.confidence,
        signals: classification.signals,
        consequential: isConsequentialIntent(classification.intent),
        authorised: input.authorised,
      },
    });
  });

  const outcome = await route({
    input,
    intent: classification.intent,
    inbound: appended.message,
    pendingQuestionSessionId: pendingQuestion,
  });

  return {
    conversation: await toConversationDto(await requireConversation(input.conversationId)),
    message: appended.message,
    intent: classification.intent,
    intentConfidence: classification.confidence,
    reply: outcome.reply,
    created: outcome.created,
  };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

interface RouteOutcome {
  reply: ConversationMessageDto | null;
  created: { taskId: string | null; discoverySessionId: string | null; approvalRequestId: string | null };
}

const nothingCreated = () => ({ taskId: null, discoverySessionId: null, approvalRequestId: null });

async function route(args: {
  input: InboundTurn;
  intent: MessageIntent;
  inbound: ConversationMessageDto;
  pendingQuestionSessionId: string | null;
}): Promise<RouteOutcome> {
  const { input, intent } = args;

  /*
   * The authorisation gate, in ONE place.
   *
   * Not repeated per handler, because the fifth handler added is the one that
   * would forget. An unauthorised sender may talk to Mac and ask for status —
   * both of which are read-only — and may not create work, answer into a brief,
   * correct the record or approve anything.
   */
  if (isConsequentialIntent(intent) && !input.authorised) {
    const reply = await say(
      input,
      'I can talk and give you status, but I am not able to take instructions or approvals from this ' +
        'account. An administrator adds authorised Teams identities in Mac settings.',
    );
    return { reply, created: nothingCreated() };
  }

  switch (intent) {
    case 'status_request':
      return status(args);
    case 'approval_response':
      return approval(args);
    case 'answer':
      return answer(args);
    case 'task_assignment':
      return assignment(args);
    case 'correction':
    case 'project_context':
      return noted(args);
    case 'question':
      return question(args);
    case 'instruction':
      return instruction(args);
    case 'conversation':
      return { reply: null, created: nothingCreated() };
  }
}

// --- Handlers --------------------------------------------------------------

async function status(args: { input: InboundTurn; inbound: ConversationMessageDto }): Promise<RouteOutcome> {
  const conversation = await requireConversation(args.input.conversationId);

  const answered = await answerStatusQuery(
    args.input.body,
    { taskId: conversation.taskId, projectId: conversation.projectId },
    args.input.actor,
  );

  const reply = await say(args.input, answered.text, {
    inReplyToMessageId: args.inbound.id,
    outboundKind: 'status',
    evidence: answered.evidence,
  });

  return { reply, created: nothingCreated() };
}

async function approval(args: {
  input: InboundTurn;
  inbound: ConversationMessageDto;
}): Promise<RouteOutcome> {
  const conversation = await requireConversation(args.input.conversationId);

  const binding = await bindMessageToApproval({
    text: args.input.body,
    taskId: conversation.taskId,
    explicitRequestId: args.input.cardAction?.requestId ?? null,
    explicitDecision: args.input.cardAction?.decision ?? null,
    actor: args.input.actor,
    channel: args.input.channel,
  });

  if (binding.outcome !== 'bound' || !binding.requestId || !binding.decision) {
    /*
     * The refusal is a REPLY, not a silence.
     *
     * Somebody who typed "sounds good" and heard nothing back would reasonably
     * conclude they had approved it. Naming the outstanding codes is what turns
     * a refusal into something they can act on in one more message.
     */
    const reply = await say(args.input, renderBindingClarification(binding), {
      inReplyToMessageId: args.inbound.id,
      outboundKind: 'reply',
    });
    return { reply, created: nothingCreated() };
  }

  try {
    const decided = await decideApprovalRequest(
      binding.requestId,
      {
        decision: binding.decision,
        notes: `${binding.decision === 'approve' ? 'Approved' : 'Rejected'} via ${args.input.channel} by ${args.input.author.displayName}.`,
        channel: args.input.channel,
        conversationMessageId: args.inbound.id,
      },
      args.input.actor,
    );

    const reply = await say(
      args.input,
      binding.decision === 'approve'
        ? `${decided.code} approved — "${decided.title}". I will get on with it.`
        : `${decided.code} rejected — "${decided.title}". I will not proceed.`,
      { inReplyToMessageId: args.inbound.id, outboundKind: 'reply', approvalRequestId: decided.id },
    );

    return { reply, created: { ...nothingCreated(), approvalRequestId: decided.id } };
  } catch (err) {
    // A refused approval — expired, superseded, or beyond Mac's authority —
    // comes back as a sentence rather than a 500, because the person on the
    // other end is holding a phone and not a stack trace.
    const reply = await say(args.input, (err as Error).message, {
      inReplyToMessageId: args.inbound.id,
      outboundKind: 'reply',
    });
    return { reply, created: nothingCreated() };
  }
}

/**
 * An answer to something Mac asked.
 *
 * Routed into `addDiscoveryMessage`, which is the SAME function the web UI
 * calls — so an answer given in Teams moves the brief and its confidence
 * exactly as one typed into the discovery page would. That is cross-channel
 * continuity being real rather than being synchronised afterwards.
 */
async function answer(args: {
  input: InboundTurn;
  inbound: ConversationMessageDto;
  pendingQuestionSessionId: string | null;
}): Promise<RouteOutcome> {
  if (!args.pendingQuestionSessionId) {
    const reply = await say(args.input, 'Noted — though I do not have an outstanding question on this thread.', {
      inReplyToMessageId: args.inbound.id,
    });
    return { reply, created: nothingCreated() };
  }

  await addDiscoveryMessage(args.pendingQuestionSessionId, { message: args.input.body }, args.input.actor);

  const session = await sessionById(args.pendingQuestionSessionId);
  const next = session?.pendingQuestion as { question?: string } | null;

  const reply = await say(
    args.input,
    next?.question
      ? `Thanks. Next: ${next.question}`
      : 'Thanks — that fills the gap I had. I will put a brief together and come back for approval.',
    { inReplyToMessageId: args.inbound.id, outboundKind: next?.question ? 'question' : 'reply' },
  );

  return { reply, created: { ...nothingCreated(), discoverySessionId: args.pendingQuestionSessionId } };
}

/**
 * A piece of work.
 *
 * Creates the task and starts discovery, which is the Sprint 3.3 lifecycle
 * entered from a different door. It does NOT create a run and does not approve
 * anything: spec §3 Day Mode and §4 both require discovery first, and a channel
 * that could skip it would be a channel through which unreviewed work runs.
 */
async function assignment(args: { input: InboundTurn; inbound: ConversationMessageDto }): Promise<RouteOutcome> {
  const conversation = await requireConversation(args.input.conversationId);

  const projectId = conversation.projectId ?? (await guessProject(args.input.body));

  if (!projectId) {
    const options = await db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.isActive, true))
      .orderBy(projects.name)
      .limit(12);

    const reply = await say(
      args.input,
      'Which project is that for? ' +
        (options.length ? `I have: ${options.map((o) => o.name).join(', ')}.` : 'I have no active projects on record.'),
      { inReplyToMessageId: args.inbound.id, outboundKind: 'question' },
    );
    return { reply, created: nothingCreated() };
  }

  const task = await createTask(
    {
      projectId,
      title: titleFrom(args.input.body),
      description: args.input.body,
      priority: 'normal',
    },
    args.input.actor,
  );

  const discovery = await startDiscovery({ projectId, taskId: task.id }, args.input.actor);

  /*
   * The request itself IS the free-flow conversation.
   *
   * Part A §5 lists the whole sequence a Teams instruction is supposed to
   * trigger: identify the project, load context, begin discovery, STRUCTURE THE
   * REQUEST, ask clarification where genuinely required, create the brief,
   * derive confidence, present an approval request.
   *
   * Starting a session and stopping there completes only the first three, and
   * leaves the thread waiting on Mac while Mac waits on the human — which is
   * how this was found: the test asserted Mac had a question and he had none,
   * because nothing had turned the message into a brief.
   *
   * So the message is recorded as discovery's opening statement and a brief is
   * derived from it, exactly as it would be if somebody had typed it into the
   * discovery page.
   */
  await addDiscoveryMessage(discovery.id, { message: args.input.body }, args.input.actor);
  const { session, brief } = await generateBrief(discovery.id, {}, args.input.actor);

  if (!conversation.taskId) {
    await linkConversationToTask(args.input.conversationId, { taskId: task.id, projectId }, args.input.actor);
  }

  await db.transaction(async (tx) => {
    await tx
      .update(discoverySessions)
      .set({ conversationId: args.input.conversationId })
      .where(eq(discoverySessions.id, discovery.id));

    await record(tx, {
      actor: args.input.actor,
      eventType: 'teams.task_created_from_message',
      context: { projectId, taskId: task.id },
      metadata: {
        conversationId: args.input.conversationId,
        channel: args.input.channel,
        discoverySessionId: discovery.id,
        taskKind: task.taskKind,
      },
    });

    await emit(tx, {
      type: 'discovery_started',
      projectId,
      taskId: task.id,
      conversationId: args.input.conversationId,
      data: { discoverySessionId: discovery.id, via: args.input.channel },
    });
  });

  const pending = session.pendingQuestion?.question;

  /*
   * With nothing left to ask, the next thing a human needs is a decision.
   *
   * Part A §5 ends at "present an approval request", and stopping one step
   * short would leave a fully-understood brief sitting in a web page nobody has
   * open. The request binds to the BRIEF and its VERSION, so a later revision
   * supersedes it rather than leaving a stale card that still approves.
   *
   * It requests `accept_brief` and not `execute_run`: what exists at this point
   * is a contract, not a run, and approving a run that has not been created
   * would be approving something with no shape.
   */
  const approval = pending
    ? null
    : await createApprovalRequest(
        {
          taskId: task.id,
          briefId: brief.id,
          subjectKind: 'brief',
          subjectVersion: brief.version,
          title: `Accept the brief for "${task.title}"`,
          detail: brief.content.userObjective.slice(0, 8000),
          recommendation: brief.content.proposedScope || 'Proceed as the brief describes.',
          risk: 'medium',
          authority: 'accept_brief',
          confidence: brief.confidence,
        },
        args.input.actor,
      );

  const reply = await say(
    args.input,
    [
      `Got it — I have raised "${task.title}" on ${task.projectName} and worked it into a brief.`,
      pending
        ? `First thing I need: ${pending}`
        : approval
          ? `I understand it at ${(brief.confidence * 100).toFixed(0)}%. Approve ${approval.code} and I will get on with it.`
          : 'I will come back with anything I still need.',
      'Nothing runs until you approve a brief.',
    ].join(' '),
    {
      inReplyToMessageId: args.inbound.id,
      outboundKind: pending ? 'question' : approval ? 'approval_request' : 'reply',
      ...(approval ? { approvalRequestId: approval.id } : {}),
    },
  );

  return {
    reply,
    created: {
      taskId: task.id,
      discoverySessionId: discovery.id,
      approvalRequestId: approval?.id ?? null,
    },
  };
}

/**
 * A correction or a piece of offered context.
 *
 * Recorded and acknowledged, and NOT folded into a brief automatically. A
 * correction is often about something Mac already wrote down, and quietly
 * rewriting a brief from a chat message would change an approved contract
 * without anybody approving the change. It surfaces at the next brief revision,
 * where a human sees it.
 */
async function noted(args: { input: InboundTurn; inbound: ConversationMessageDto; intent: MessageIntent }): Promise<RouteOutcome> {
  const reply = await say(
    args.input,
    args.intent === 'correction'
      ? 'Noted, and recorded against this thread — I will carry that correction forward and not repeat it.'
      : 'Noted — I have recorded that as project context for this thread.',
    { inReplyToMessageId: args.inbound.id },
  );
  return { reply, created: nothingCreated() };
}

/**
 * A question Mac has to think about.
 *
 * Answered from the conversation context and whatever status data applies —
 * deliberately NOT by a free model call in this phase. A conversational
 * reasoning surface is a real piece of work (spec §23.2, "Talk to Mac") and
 * pretending to have built it by wiring a chat model to a Teams webhook would
 * be the fabricated capability this project has refused at every step.
 */
async function question(args: { input: InboundTurn; inbound: ConversationMessageDto }): Promise<RouteOutcome> {
  const conversation = await requireConversation(args.input.conversationId);

  const status = await answerStatusQuery(
    args.input.body,
    { taskId: conversation.taskId, projectId: conversation.projectId },
    args.input.actor,
  );

  const reply = await say(
    args.input,
    [
      status.text,
      '',
      'If you want me to actually go and work that out, say so and name the project — I will raise it as a ' +
        'task, do discovery, and come back for approval. I do not answer technical questions off the top of ' +
        'my head, because an answer I have not checked reads exactly like one I have.',
    ].join('\n'),
    { inReplyToMessageId: args.inbound.id, outboundKind: 'reply', evidence: status.evidence },
  );

  return { reply, created: nothingCreated() };
}

/**
 * An instruction that is not a unit of work.
 *
 * The only branch that matters here is the refusal: an instruction purporting to
 * grant authority is answered with a plain no. Authority lives in settings, in
 * the role gate and in the authority-class deny list, and there is no code path
 * from this function to any of them.
 */
async function instruction(args: { input: InboundTurn; inbound: ConversationMessageDto }): Promise<RouteOutcome> {
  const AUTHORITY_CLAIM = /\b(you (are )?(now )?(allowed|authorised|authorized|permitted)|I (hereby )?(authorise|authorize|allow|permit) you|admin(istrator)? (access|rights)|full (access|permissions?))\b/i;

  if (AUTHORITY_CLAIM.test(args.input.body)) {
    const reply = await say(
      args.input,
      'No. What I am allowed to do is held in Mac settings and in the approval rules, and a message cannot ' +
        'change it — mine or anybody else\'s. If something needs wider authority, an administrator grants it ' +
        'in the Mac web interface, where it is audited.',
      { inReplyToMessageId: args.inbound.id },
    );
    return { reply, created: nothingCreated() };
  }

  const reply = await say(
    args.input,
    'I have recorded that. For anything I should actually go and do, describe the work and name the project — ' +
      'I will raise it, do discovery and come back for approval.',
    { inReplyToMessageId: args.inbound.id },
  );
  return { reply, created: nothingCreated() };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Records an outbound message. Delivery is a separate concern. */
export async function say(
  input: Pick<InboundTurn, 'conversationId' | 'channel' | 'actor'>,
  body: string,
  options: {
    inReplyToMessageId?: string | null;
    outboundKind?: ConversationMessageDto['outboundKind'];
    approvalRequestId?: string | null;
    evidence?: ConversationMessageDto['evidence'];
  } = {},
): Promise<ConversationMessageDto> {
  const { message } = await appendMessage(
    {
      conversationId: input.conversationId,
      direction: 'outbound',
      channel: input.channel,
      authorKind: 'mac',
      authorName: MAC_TEAMS_IDENTITY.displayName,
      body,
      outboundKind: options.outboundKind ?? 'reply',
      /*
       * Channels that PULL are delivered by the reader asking for them; only
       * channels Mac must actively push to get queued. Marking a web reply
       * `pending` would leave the sweeper with a backlog it can never clear.
       */
      deliveryState: input.channel === 'teams' ? 'pending' : 'not_required',
      inReplyToMessageId: options.inReplyToMessageId ?? null,
      approvalRequestId: options.approvalRequestId ?? null,
      ...(options.evidence ? { evidence: options.evidence } : {}),
    },
    input.actor,
  );
  return message;
}

async function outstandingQuestionFor(taskId: string | null): Promise<string | null> {
  if (!taskId) return null;
  const [session] = await db
    .select({ id: discoverySessions.id, pendingQuestion: discoverySessions.pendingQuestion })
    .from(discoverySessions)
    /*
     * Not closed — rather than `status = 'open'`.
     *
     * A session moves to `brief_drafted` the moment a brief exists, which is
     * exactly when Mac starts having questions to ask. Filtering on `open`
     * meant every answer to every question Mac actually asked was classified as
     * small talk and dropped on the floor, because the pending-question context
     * was never true when it mattered. Found by the test that answers one.
     */
    .where(and(eq(discoverySessions.taskId, taskId), ne(discoverySessions.status, 'closed')))
    .orderBy(desc(discoverySessions.createdAt))
    .limit(1);
  return session?.pendingQuestion ? session.id : null;
}

async function sessionById(id: string) {
  const [row] = await db.select().from(discoverySessions).where(eq(discoverySessions.id, id)).limit(1);
  return row ?? null;
}

async function hasPendingApproval(taskId: string | null): Promise<boolean> {
  const { pendingForConversation } = await import('./approval-requests.js');
  const pending = await pendingForConversation({ taskId });
  return pending.length > 0;
}

/**
 * Finds the project a message names.
 *
 * Exact-ish matching on name and slug only. A fuzzy match would occasionally
 * raise work against the wrong customer's project, which is a worse outcome
 * than asking — and asking costs one message.
 */
async function guessProject(text: string): Promise<string | null> {
  const rows = await db
    .select({ id: projects.id, name: projects.name, slug: projects.slug })
    .from(projects)
    .where(eq(projects.isActive, true))
    .limit(200);

  const lower = (text ?? '').toLowerCase();
  const matches = rows.filter(
    (row) => lower.includes(row.name.toLowerCase()) || lower.includes(row.slug.toLowerCase()),
  );

  // Exactly one, or nothing. Two candidates is a question, not a coin toss.
  return matches.length === 1 ? matches[0]!.id : null;
}

/** A title from the first sentence, trimmed of the vocative and the schedule. */
function titleFrom(body: string): string {
  const first = (body.split(/[.?!\n]/)[0] ?? body).trim();
  const cleaned = first
    .replace(/^(hi |hey |hello )?mac[,:]?\s*/i, '')
    .replace(/^(tonight|overnight|this evening|tomorrow)[,:]?\s*/i, '')
    .replace(/^(please|can you|could you|would you|i(?:'d| would) like you to|i need you to)\s+/i, '')
    .trim();

  const title = cleaned || first || 'Work requested in conversation';
  return title.charAt(0).toUpperCase() + title.slice(1, 200);
}

/** Whether this deployment lets a given Teams identity change anything. */
export async function isAuthorisedTeamsIdentity(identity: {
  aadObjectId?: string | null;
  upn?: string | null;
  name?: string | null;
}): Promise<boolean> {
  const settings = await getSettings();
  if (settings.teamsAuthorisedUsers.length === 0) return false;

  const allowed = new Set(settings.teamsAuthorisedUsers.map((entry) => entry.trim().toLowerCase()));

  /*
   * The AAD object id is checked first and is the one that matters.
   *
   * A UPN can be reassigned when somebody leaves and a namesake joins; an
   * object id cannot. Names are deliberately NOT accepted — a display name is
   * chosen by its owner, and an authorisation list keyed on a value the subject
   * controls is not an authorisation list.
   */
  for (const candidate of [identity.aadObjectId, identity.upn]) {
    if (candidate && allowed.has(candidate.trim().toLowerCase())) return true;
  }
  return false;
}

/** Messages awaiting delivery on a pushing channel. Read by the sweeper. */
export async function pendingDeliveries(limit = 50) {
  return db
    .select()
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.direction, 'outbound'),
        eq(conversationMessages.deliveryState, 'pending'),
      ),
    )
    .orderBy(conversationMessages.createdAt)
    .limit(limit);
}
