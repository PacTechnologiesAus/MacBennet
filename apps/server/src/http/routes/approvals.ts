import type { FastifyInstance } from 'fastify';
import {
  createApprovalRequestSchema,
  decideApprovalRequestSchema,
  type ApprovalRequestState,
} from '@mac/protocol';
import {
  createApprovalRequest,
  decideApprovalRequest,
  listApprovalRequests,
  requireApprovalRequest,
  toApprovalRequestDto,
} from '../../services/approval-requests.js';
import { currentActor, requireAuth, requireRole } from '../auth-plugin.js';

/**
 * The approval inbox (Phase 4 Part B, Part J §33).
 *
 * ---------------------------------------------------------------------------
 * THE WEB UI IS NOT A PRIVILEGED CHANNEL
 *
 * `decideApprovalRequest` is the same function the Teams card action calls, and
 * it applies the same authority-class deny list regardless of where the
 * decision came from. A merge to a protected branch is refused here exactly as
 * it is refused in Teams — spec §16 says Mac may not do these things, not that
 * he may do them if asked through a nicer interface.
 *
 * What the web route adds is `acceptBelowThreshold`, which is passed straight
 * through to `approveRun`. That flag exists so approving in the 60–79% band is
 * a deliberate act rather than a side effect, and a conversational approval
 * cannot set it — a card has two buttons and neither of them is "and I accept
 * that Mac is not confident about this".
 * ---------------------------------------------------------------------------
 */
export async function approvalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/approval-requests', { preHandler: requireAuth }, async (request, reply) => {
    const { state, taskId, projectId } = request.query as {
      state?: ApprovalRequestState;
      taskId?: string;
      projectId?: string;
    };
    return reply.send({
      requests: await listApprovalRequests({
        ...(state ? { state } : {}),
        ...(taskId ? { taskId } : {}),
        ...(projectId ? { projectId } : {}),
      }),
    });
  });

  app.get('/api/approval-requests/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ request: toApprovalRequestDto(await requireApprovalRequest(id)) });
  });

  app.post('/api/approval-requests', { preHandler: requireRole('operator') }, async (request, reply) => {
    const body = createApprovalRequestSchema.parse(request.body);
    return reply.status(201).send({ request: await createApprovalRequest(body, currentActor(request)) });
  });

  app.post('/api/approval-requests/:id/decision', { preHandler: requireRole('operator') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = decideApprovalRequestSchema.parse(request.body);

    const decided = await decideApprovalRequest(
      id,
      {
        decision: body.decision,
        notes: body.notes,
        acceptBelowThreshold: body.acceptBelowThreshold,
        channel: 'web',
      },
      currentActor(request),
    );

    return reply.send({ request: decided });
  });
}
