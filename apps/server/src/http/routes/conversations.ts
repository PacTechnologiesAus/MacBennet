import type { FastifyInstance } from 'fastify';
import {
  postConversationMessageRequestSchema,
  startConversationRequestSchema,
  type ConversationChannel,
} from '@mac/protocol';
import {
  getConversation,
  listConversations,
  listMessages,
  listSummaries,
  startConversation,
  toConversationDto,
} from '../../services/conversations.js';
import { handleInboundTurn } from '../../services/conversation-turns.js';
import { currentActor, currentUser, requireAuth, requireRole } from '../auth-plugin.js';

/**
 * Conversations in the web UI (Phase 4 Part C, Part J).
 *
 * ---------------------------------------------------------------------------
 * THE SAME HANDLER AS TEAMS
 *
 * `POST /api/conversations/:id/messages` calls `handleInboundTurn`, which is
 * the identical function the Teams webhook calls. The differences between the
 * two channels are authentication and how the reply is delivered; the
 * behaviour is one code path.
 *
 * That is what makes cross-channel continuity structural. If the web UI had its
 * own routing, "Mac knows what you told him in Teams" would depend on somebody
 * remembering to implement each behaviour twice, and the second implementation
 * would drift within a sprint.
 *
 * ---------------------------------------------------------------------------
 * AUTHORISATION
 *
 * A web session that reached `requireRole('operator')` is by definition
 * authorised to instruct Mac — that is what the role means, and it is the same
 * gate the Tasks and Runs pages use. Viewers may read conversations and may not
 * post to them.
 * ---------------------------------------------------------------------------
 */
export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/conversations', { preHandler: requireAuth }, async (request, reply) => {
    const { taskId, projectId, channel } = request.query as {
      taskId?: string;
      projectId?: string;
      channel?: ConversationChannel;
    };
    return reply.send({
      conversations: await listConversations({
        ...(taskId ? { taskId } : {}),
        ...(projectId ? { projectId } : {}),
        ...(channel ? { channel } : {}),
      }),
    });
  });

  app.get('/api/conversations/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [conversation, messages, summaries] = await Promise.all([
      getConversation(id),
      listMessages(id),
      listSummaries(id),
    ]);
    /*
     * Summaries are returned ALONGSIDE the messages, never instead of them.
     *
     * §11: a generated summary must not overwrite source messages, and source
     * history stays traceable. A reader who wants to check what a summary
     * claims has both in the same response.
     */
    return reply.send({ conversation, messages, summaries });
  });

  app.post('/api/conversations', { preHandler: requireRole('operator') }, async (request, reply) => {
    const body = startConversationRequestSchema.parse(request.body ?? {});
    const actor = currentActor(request);

    const conversation = await startConversation(
      {
        // A conversation started through this route is a web conversation
        // whatever the body says: the channel is a fact about how the message
        // arrived, not a field a client gets to assert.
        channel: 'web',
        projectId: body.projectId ?? null,
        taskId: body.taskId ?? null,
        ...(body.title ? { title: body.title } : {}),
      },
      actor,
    );

    if (!body.message) {
      return reply.status(201).send({ conversation: await toConversationDto(conversation), turn: null });
    }

    const user = currentUser(request);
    const turn = await handleInboundTurn({
      conversationId: conversation.id,
      channel: 'web',
      body: body.message,
      author: { kind: 'human', userId: user.id, displayName: user.name },
      authorised: true,
      actor,
    });

    return reply.status(201).send({ conversation: turn.conversation, turn });
  });

  app.post('/api/conversations/:id/messages', { preHandler: requireRole('operator') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = postConversationMessageRequestSchema.parse(request.body);
    const user = currentUser(request);

    const turn = await handleInboundTurn({
      conversationId: id,
      channel: 'web',
      body: body.message,
      author: { kind: 'human', userId: user.id, displayName: user.name },
      authorised: true,
      actor: currentActor(request),
    });

    return reply.status(201).send({ turn });
  });
}
