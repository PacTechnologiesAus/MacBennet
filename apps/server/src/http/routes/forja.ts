import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  createForjaClientRequestSchema,
  forjaCreateTaskRequestSchema,
  forjaDecideApprovalRequestSchema,
  forjaEventQuerySchema,
  forjaRequestApprovalRequestSchema,
  forjaSendMessageRequestSchema,
  forjaStartConversationRequestSchema,
  FORJA_CONTRACT_VERSION,
  type ForjaScope,
  type MacEventType,
} from '@mac/protocol';
import { AppError } from '../errors.js';
import { currentActor, requireRole } from '../auth-plugin.js';
import {
  authenticateForja,
  createForjaClient,
  forjaHealth,
  getForjaBrief,
  getForjaDiscovery,
  getForjaRun,
  getForjaTask,
  listAgents,
  listForjaArtefacts,
  listForjaBlockers,
  listForjaClients,
  listForjaProjects,
  listForjaRuns,
  recordForjaRequest,
  resolveOnBehalfOf,
  revokeForjaClient,
  type AuthenticatedForjaClient,
} from '../../services/forja.js';
import { latestEventSeq, waitForEvents } from '../../services/events.js';
import { createTask } from '../../services/tasks.js';
import { startDiscovery } from '../../services/discovery.js';
import { startConversation, toConversationDto } from '../../services/conversations.js';
import { handleInboundTurn } from '../../services/conversation-turns.js';
import {
  createApprovalRequest,
  decideApprovalRequest,
  listApprovalRequests,
} from '../../services/approval-requests.js';
import { getSettings } from '../../services/settings.js';
import { record, SYSTEM_ACTOR } from '../../services/audit.js';
import { db } from '../../db/client.js';

/**
 * The Forja plane (Phase 4 Part D).
 *
 * ---------------------------------------------------------------------------
 * A FOURTH AUTHENTICATION PLANE, AND WHY IT IS SEPARATE
 *
 * Human sessions, worker tokens, the Teams JWT, and now a Forja API key. Each
 * is registered in its own Fastify scope with its own hook and a
 * non-overlapping prefix, so "a Forja key cannot authenticate a human call"
 * holds because of how the routes are mounted rather than because somebody
 * remembered to check.
 *
 * ---------------------------------------------------------------------------
 * EVERY WRITE NAMES A PERSON
 *
 * `onBehalfOf` is mandatory on every mutating request and is resolved against
 * `users` — an unknown address is refused rather than degraded to a system
 * actor. "Forja approved it" is not an answer to "who approved this?", and an
 * integration that cannot name its user has not been finished.
 *
 * ---------------------------------------------------------------------------
 * THE PROJECTIONS ARE NARROWER THAN THE INTERNAL DTOs
 *
 * Deliberately. The human API is shaped by what the web UI happens to need this
 * month; this is a published contract that an external platform compiles
 * against. A field added because a page wanted it should not be a breaking
 * change for Forja, and the only way to guarantee that is for the two not to
 * share a type.
 * ---------------------------------------------------------------------------
 */

declare module 'fastify' {
  interface FastifyRequest {
    forja?: AuthenticatedForjaClient;
  }
}

const FORJA_HEADER = 'x-forja-key';

function client(request: FastifyRequest): AuthenticatedForjaClient {
  if (!request.forja) throw AppError.unauthorized('A Forja API key is required.');
  return request.forja;
}

/**
 * ASYNC, and it matters.
 *
 * A Fastify hook declared with fewer than three parameters is expected to
 * return a promise; a synchronous one returning `undefined` never signals
 * completion and the request hangs until the client gives up. Every hook in
 * this codebase is async for that reason — `requireAuth` and `requireRole` both
 * are — and the first version of this one was not, which showed up as ten
 * tests timing out at exactly thirty seconds.
 */
function requireScope(scope: ForjaScope) {
  return async function scopeGate(request: FastifyRequest): Promise<void> {
    if (!client(request).scopes.includes(scope)) {
      throw AppError.forbidden(`This Forja client does not hold the "${scope}" scope.`);
    }
  };
}

export async function forjaRoutes(app: FastifyInstance): Promise<void> {
  // --- The Forja plane ------------------------------------------------------

  await app.register(async (scope) => {
    scope.addHook('preHandler', async (request) => {
      const settings = await getSettings();
      if (!settings.forjaEnabled) {
        throw AppError.forbidden('The Forja integration is not enabled in this deployment.');
      }

      const key = request.headers[FORJA_HEADER];
      const authenticated = await authenticateForja(typeof key === 'string' ? key : undefined);

      if (!authenticated) {
        /*
         * A rejected key is audited on its own connection.
         *
         * This endpoint is reachable from wherever Forja is deployed, and a
         * stream of rejections is how a probe looks. Recording the key itself
         * would put an attacker-supplied credential into the trail, so only the
         * fact and the path are kept.
         */
        await db.transaction(async (tx) => {
          await record(tx, {
            actor: SYSTEM_ACTOR,
            eventType: 'forja.unauthorized',
            metadata: { path: request.url, method: request.method, presented: typeof key === 'string' },
          });
        });
        throw AppError.unauthorized('That Forja API key is not recognised.');
      }

      request.forja = authenticated;
    });

    // --- Read ---------------------------------------------------------------

    scope.get('/api/forja/agents', { preHandler: requireScope('read') }, async (request, reply) => {
      await recordForjaRequest(client(request), { method: 'GET', path: '/agents' });
      return reply.send({ contractVersion: FORJA_CONTRACT_VERSION, agents: await listAgents() });
    });

    scope.get('/api/forja/projects', { preHandler: requireScope('read') }, async (_request, reply) =>
      reply.send({ contractVersion: FORJA_CONTRACT_VERSION, projects: await listForjaProjects() }),
    );

    scope.get('/api/forja/tasks/:id', { preHandler: requireScope('read') }, async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send({ contractVersion: FORJA_CONTRACT_VERSION, task: await getForjaTask(id) });
    });

    scope.get('/api/forja/tasks/:id/discovery', { preHandler: requireScope('read') }, async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send({ contractVersion: FORJA_CONTRACT_VERSION, discovery: await getForjaDiscovery(id) });
    });

    scope.get('/api/forja/briefs/:id', { preHandler: requireScope('read') }, async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send({ contractVersion: FORJA_CONTRACT_VERSION, brief: await getForjaBrief(id) });
    });

    scope.get('/api/forja/runs/:id', { preHandler: requireScope('read') }, async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send({ contractVersion: FORJA_CONTRACT_VERSION, run: await getForjaRun(id) });
    });

    scope.get('/api/forja/tasks/:id/runs', { preHandler: requireScope('read') }, async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send({ contractVersion: FORJA_CONTRACT_VERSION, runs: await listForjaRuns(id) });
    });

    scope.get('/api/forja/blockers', { preHandler: requireScope('read') }, async (request, reply) => {
      const { projectId } = request.query as { projectId?: string };
      return reply.send({
        contractVersion: FORJA_CONTRACT_VERSION,
        blockers: await listForjaBlockers(projectId ? { projectId } : {}),
      });
    });

    scope.get('/api/forja/artefacts', { preHandler: requireScope('read') }, async (request, reply) => {
      const { taskId, runId } = request.query as { taskId?: string; runId?: string };
      return reply.send({
        contractVersion: FORJA_CONTRACT_VERSION,
        artefacts: await listForjaArtefacts({ ...(taskId ? { taskId } : {}), ...(runId ? { runId } : {}) }),
      });
    });

    scope.get('/api/forja/approvals', { preHandler: requireScope('read') }, async (_request, reply) =>
      reply.send({
        contractVersion: FORJA_CONTRACT_VERSION,
        approvals: await listApprovalRequests({ state: 'pending' }),
      }),
    );

    // --- Events -------------------------------------------------------------

    /**
     * Cursor-read, optionally long-polling.
     *
     * `seq` is the ONLY cursor. Two events written in the same millisecond have
     * no order between them, so a consumer paging by timestamp will eventually
     * skip one — which for an at-least-once stream is the failure that is
     * hardest to notice and worst to have.
     */
    scope.get('/api/forja/events', { preHandler: requireScope('events') }, async (request, reply) => {
      const query = forjaEventQuerySchema.parse(request.query ?? {});
      const types = query.types
        ? (query.types.split(',').map((t) => t.trim()) as MacEventType[])
        : undefined;

      const events = await waitForEvents({
        after: query.after,
        limit: query.limit,
        waitSeconds: query.wait,
        ...(types ? { types } : {}),
      });

      return reply.send({
        contractVersion: FORJA_CONTRACT_VERSION,
        events,
        // The cursor does not move when nothing arrived, so a long poll that
        // times out is safely repeatable with the same value.
        cursor: events.length ? events[events.length - 1]!.seq : query.after,
      });
    });

    /** Where a new consumer starts, so it does not have to replay history. */
    scope.get('/api/forja/events/head', { preHandler: requireScope('events') }, async (_request, reply) =>
      reply.send({ contractVersion: FORJA_CONTRACT_VERSION, cursor: await latestEventSeq() }),
    );

    // --- Write --------------------------------------------------------------

    scope.post('/api/forja/tasks', { preHandler: requireScope('write') }, async (request, reply) => {
      const body = forjaCreateTaskRequestSchema.parse(request.body);
      const actor = await resolveOnBehalfOf(body.onBehalfOf);
      await recordForjaRequest(client(request), { method: 'POST', path: '/tasks', onBehalfOf: body.onBehalfOf });

      const task = await createTask(
        {
          projectId: body.projectId,
          ...(body.description ? { description: body.description } : {}),
          title: body.title,
          priority: body.priority,
          ...(body.taskKind ? { taskKind: body.taskKind as never } : {}),
        },
        actor,
      );

      const discovery = body.startDiscovery
        ? await startDiscovery({ projectId: body.projectId, taskId: task.id }, actor)
        : null;

      return reply.status(201).send({
        contractVersion: FORJA_CONTRACT_VERSION,
        task: await getForjaTask(task.id),
        discoverySessionId: discovery?.id ?? null,
      });
    });

    scope.post('/api/forja/tasks/:id/discovery', { preHandler: requireScope('write') }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = forjaSendMessageRequestSchema.parse(request.body);
      const actor = await resolveOnBehalfOf(body.onBehalfOf);

      const task = await getForjaTask(id);
      const existing = await getForjaDiscovery(id);
      const session = existing ?? (await startDiscovery({ projectId: task.projectId, taskId: id }, actor));

      const { addDiscoveryMessage, generateBrief } = await import('../../services/discovery.js');
      const sessionId = 'sessionId' in session ? session.sessionId : session.id;

      await addDiscoveryMessage(sessionId, { message: body.message }, actor);
      const { brief } = await generateBrief(sessionId, {}, actor);

      return reply.send({
        contractVersion: FORJA_CONTRACT_VERSION,
        discovery: await getForjaDiscovery(id),
        brief: await getForjaBrief(brief.id),
      });
    });

    scope.post('/api/forja/conversations', { preHandler: requireScope('write') }, async (request, reply) => {
      const body = forjaStartConversationRequestSchema.parse(request.body);
      const actor = await resolveOnBehalfOf(body.onBehalfOf);

      const conversation = await startConversation(
        {
          channel: 'forja',
          projectId: body.projectId ?? null,
          taskId: body.taskId ?? null,
          ...(body.title ? { title: body.title } : {}),
        },
        actor,
      );

      if (!body.message) {
        return reply
          .status(201)
          .send({ contractVersion: FORJA_CONTRACT_VERSION, conversation: await toConversationDto(conversation), turn: null });
      }

      const turn = await handleInboundTurn({
        conversationId: conversation.id,
        channel: 'forja',
        body: body.message,
        author: { kind: 'human', userId: actor.id, displayName: actor.label },
        /*
         * A named, active Mac user acting through Forja is authorised.
         *
         * The authorisation is the PERSON, not the platform: `resolveOnBehalfOf`
         * has already refused an address Mac does not recognise, so by this line
         * there is a real user behind the request.
         */
        authorised: true,
        actor,
      });

      return reply.status(201).send({ contractVersion: FORJA_CONTRACT_VERSION, conversation: turn.conversation, turn });
    });

    scope.post('/api/forja/conversations/:id/messages', { preHandler: requireScope('write') }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = forjaSendMessageRequestSchema.parse(request.body);
      const actor = await resolveOnBehalfOf(body.onBehalfOf);

      const turn = await handleInboundTurn({
        conversationId: id,
        channel: 'forja',
        body: body.message,
        author: { kind: 'human', userId: actor.id, displayName: actor.label },
        authorised: true,
        actor,
      });

      return reply.status(201).send({ contractVersion: FORJA_CONTRACT_VERSION, turn });
    });

    scope.post('/api/forja/approvals', { preHandler: requireScope('write') }, async (request, reply) => {
      const body = forjaRequestApprovalRequestSchema.parse(request.body);
      const actor = await resolveOnBehalfOf(body.onBehalfOf);

      const created = await createApprovalRequest(
        {
          taskId: body.taskId,
          runId: body.runId ?? null,
          briefId: body.briefId ?? null,
          subjectKind: body.runId ? 'run' : 'brief',
          subjectVersion: 0,
          title: body.title,
          detail: body.detail,
          recommendation: '',
          risk: 'medium',
          authority: body.runId ? 'execute_run' : 'accept_brief',
        },
        actor,
      );

      return reply.status(201).send({ contractVersion: FORJA_CONTRACT_VERSION, approval: created });
    });

    /**
     * A decision, on behalf of a named person.
     *
     * Routes into exactly the same `decideApprovalRequest` the web UI and the
     * Teams card use — same confidence floor, same authority deny list, same
     * refusal for spec §16's hard prohibitions. Forja is a convenient front end
     * to the gate and holds no gate of its own.
     */
    scope.post('/api/forja/approvals/:id/decision', { preHandler: requireScope('approve') }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = forjaDecideApprovalRequestSchema.parse(request.body);
      const actor = await resolveOnBehalfOf(body.onBehalfOf);

      await recordForjaRequest(client(request), {
        method: 'POST',
        path: '/approvals/decision',
        onBehalfOf: body.onBehalfOf,
      });

      const decided = await decideApprovalRequest(
        id,
        {
          decision: body.decision,
          notes: body.notes,
          acceptBelowThreshold: body.acceptBelowThreshold,
          channel: 'forja',
        },
        actor,
      );

      return reply.send({ contractVersion: FORJA_CONTRACT_VERSION, approval: decided });
    });
  });

  // --- Administration (human plane) ----------------------------------------

  app.get('/api/forja/clients', { preHandler: requireRole('admin') }, async (_request, reply) =>
    reply.send({ clients: await listForjaClients(), health: await forjaHealth() }),
  );

  app.post('/api/forja/clients', { preHandler: requireRole('admin') }, async (request, reply) => {
    const body = createForjaClientRequestSchema.parse(request.body);
    const issued = await createForjaClient(
      { name: body.name, scopes: body.scopes, webhookUrl: body.webhookUrl ?? null },
      currentActor(request),
    );
    // The key and the webhook secret appear here and nowhere else, ever.
    return reply.status(201).send(issued);
  });

  app.post('/api/forja/clients/:id/revoke', { preHandler: requireRole('admin') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await revokeForjaClient(id, currentActor(request));
    return reply.send({ revoked: true });
  });
}
