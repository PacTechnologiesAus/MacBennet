import { and, count, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  MAC_TEAMS_IDENTITY,
  TEAMS_SETUP_REQUIREMENTS,
  type TeamsConnectionState,
  type TeamsStatusDto,
} from '@mac/protocol';
import { db } from '../../db/client.js';
import { conversationMessages, conversations } from '../../db/schema.js';
import { handleTeamsActivity } from '../../services/teams/inbound.js';
import { getTeamsProvider, missingTeamsConfiguration } from '../../services/teams/provider.js';
import { getSettings } from '../../services/settings.js';
import { requireAuth } from '../auth-plugin.js';

/**
 * The Teams channel's HTTP surface (Phase 4 Part A).
 *
 * ---------------------------------------------------------------------------
 * A THIRD AUTHENTICATION PLANE
 *
 * `/api/teams/messages` is registered in its own Fastify scope with NO session
 * hook and NO worker-token hook. It authenticates one way — a Bot Framework
 * JWT, verified against Microsoft's published signing keys — and it is the only
 * route in the application that does.
 *
 * That mirrors what Sprint 1 did for the worker plane, and for the same reason:
 * "a session cookie cannot authenticate a Teams call, and a Teams token cannot
 * authenticate a human call" should be true because of how the routes are
 * mounted, not because of a convention somebody has to remember.
 *
 * ---------------------------------------------------------------------------
 * WHY IT ALWAYS ANSWERS 200 OR 401 AND NEVER 500
 *
 * The Bot Framework retries on a 5xx. A handler that throws on a bad activity
 * would therefore be re-sent the same bad activity, repeatedly, and a bug in
 * Mac would become a loop between Microsoft and this endpoint. Rejections are
 * reported as themselves and recorded in the audit trail.
 * ---------------------------------------------------------------------------
 */
export async function teamsRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    scope.post('/api/teams/messages', async (request, reply) => {
      const result = await handleTeamsActivity({
        authorizationHeader: request.headers.authorization,
        body: request.body,
      });

      if (result.status === 'rejected') {
        /*
         * 401, not 400.
         *
         * The Bot Framework treats 401 as "stop and re-authenticate" and 4xx
         * generally as "do not retry", which is what we want for a request that
         * did not verify. A 500 here would be an invitation to keep sending it.
         */
        return reply.status(401).send({ error: { code: 'TEAMS_REJECTED', message: result.reason ?? 'Rejected.' } });
      }

      // The Bot Framework wants a prompt 200 and does not read the body. The
      // reply Mac composed has already been delivered through the Connector.
      return reply.status(200).send({ status: result.status });
    });
  });

  /** Connection status, for the Settings page. Human plane. */
  app.get('/api/teams/status', { preHandler: requireAuth }, async (_request, reply) => {
    return reply.send({ status: await teamsStatus() });
  });
}

async function teamsStatus(): Promise<TeamsStatusDto> {
  const settings = await getSettings();
  const missing = missingTeamsConfiguration();
  const provider = getTeamsProvider();
  const availability = await provider.isAvailable();

  const state: TeamsConnectionState = !settings.teamsEnabled
    ? 'disabled'
    : missing.length > 0
      ? 'unconfigured'
      : availability.available
        ? 'ready'
        : 'error';

  const [threads] = await db
    .select({ value: count() })
    .from(conversations)
    .where(eq(conversations.channel, 'teams'));

  const [lastInbound] = await db
    .select({ at: conversationMessages.createdAt })
    .from(conversationMessages)
    .where(and(eq(conversationMessages.channel, 'teams'), eq(conversationMessages.direction, 'inbound')))
    .orderBy(desc(conversationMessages.createdAt))
    .limit(1);

  const [lastOutbound] = await db
    .select({ at: conversationMessages.createdAt })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.channel, 'teams'),
        eq(conversationMessages.direction, 'outbound'),
        eq(conversationMessages.deliveryState, 'sent'),
      ),
    )
    .orderBy(desc(conversationMessages.createdAt))
    .limit(1);

  const [pending] = await db
    .select({ value: count() })
    .from(conversationMessages)
    .where(and(eq(conversationMessages.channel, 'teams'), eq(conversationMessages.deliveryState, 'pending')));

  const [failed] = await db
    .select({ value: count() })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.channel, 'teams'),
        sql`${conversationMessages.deliveryState} IN ('failed', 'dead')`,
      ),
    );

  const [lastError] = await db
    .select({ error: conversationMessages.deliveryError })
    .from(conversationMessages)
    .where(and(eq(conversationMessages.channel, 'teams'), sql`${conversationMessages.deliveryError} IS NOT NULL`))
    .orderBy(desc(conversationMessages.createdAt))
    .limit(1);

  return {
    state,
    enabled: settings.teamsEnabled,
    /*
     * Which specific things are missing, by key.
     *
     * "Teams is not configured" is a message that leaves somebody guessing
     * between six possibilities at the exact moment they are least able to
     * guess well. `TEAMS_SETUP_REQUIREMENTS` names all six, and this names the
     * ones that are actually absent.
     */
    missing: missing.length ? missing : availability.missing ?? [],
    identity: {
      displayName: MAC_TEAMS_IDENTITY.displayName,
      jobTitle: MAC_TEAMS_IDENTITY.jobTitle,
      signature: MAC_TEAMS_IDENTITY.signature,
      // Surfaced in the UI rather than buried in a document, so nobody is
      // surprised later to learn Mac appears as an application.
      limitation: MAC_TEAMS_IDENTITY.limitation,
    },
    conversations: Number(threads?.value ?? 0),
    lastInboundAt: lastInbound?.at?.toISOString() ?? null,
    lastOutboundAt: lastOutbound?.at?.toISOString() ?? null,
    pendingDeliveries: Number(pending?.value ?? 0),
    failedDeliveries: Number(failed?.value ?? 0),
    lastError: lastError?.error ?? null,
  };
}

/** The setup checklist, for the Settings page and the completion report. */
export const teamsSetupRequirements = TEAMS_SETUP_REQUIREMENTS;
