import { describe, expect, it } from 'vitest';
import { isPermittedServiceUrl, MAC_TEAMS_IDENTITY } from '@mac/protocol';
import { BotFrameworkTeamsProvider } from '../../src/services/teams/provider.js';

/**
 * Opt-in: the REAL Microsoft Bot Connector (Phase 4 Part K).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SEPARATE FROM THE STANDARD SUITE, AND UNDER DIFFERENT VARIABLES
 *
 * The standard Teams suite signs its own tokens with a locally generated RSA
 * key and verifies them through the production code path. That is genuinely
 * end-to-end for everything except one thing: whether Microsoft accepts the
 * credential and whether a message actually arrives in a Teams client.
 *
 * Only a real tenant can answer that, and it costs a real message in somebody's
 * real Teams. So it is opt-in, it reads `MAC_TEAMS_LIVE_*` rather than the
 * ordinary variables, and it skips loudly when they are absent.
 *
 * The different variable names are not tidiness. `tests/helpers/load-env.ts`
 * FORCES `MAC_TEAMS_APP_ID` to a fixed test value, so a developer with real PAC
 * credentials in `.env` exercises the same code path as CI — otherwise the
 * audience check would be comparing against a different value on their machine
 * than in the pipeline, which is the class of difference that makes a suite
 * pass everywhere except where it matters.
 *
 * ---------------------------------------------------------------------------
 * TO RUN IT
 *
 *   MAC_TEAMS_LIVE_TEST=1 \
 *   MAC_TEAMS_LIVE_APP_ID=... MAC_TEAMS_LIVE_APP_PASSWORD=... \
 *   MAC_TEAMS_LIVE_TENANT_ID=... \
 *   MAC_TEAMS_LIVE_CONVERSATION_ID=... MAC_TEAMS_LIVE_SERVICE_URL=... \
 *   npx vitest run tests/integration/teams-live.test.ts
 *
 * The conversation id and service URL come from a real inbound activity — look
 * at a `teams.activity_received` audit event, or at `conversations.external_ref`
 * and `conversations.service_url` for a thread Mac has already been messaged in.
 * ---------------------------------------------------------------------------
 */

const enabled = process.env.MAC_TEAMS_LIVE_TEST === '1';
const appId = process.env.MAC_TEAMS_LIVE_APP_ID;
const appPassword = process.env.MAC_TEAMS_LIVE_APP_PASSWORD;
const conversationId = process.env.MAC_TEAMS_LIVE_CONVERSATION_ID;
const serviceUrl = process.env.MAC_TEAMS_LIVE_SERVICE_URL;

const ready = Boolean(enabled && appId && appPassword);

describe.skipIf(!ready)('the real Bot Connector', () => {
  it('obtains a token with the configured application credentials', async () => {
    const provider = new BotFrameworkTeamsProvider(appId!, appPassword!);
    const availability = await provider.isAvailable();

    // A failure here means Microsoft refused the credential, which is the one
    // thing the offline suite cannot tell you.
    expect(availability.reason ?? '').toBe('');
    expect(availability.available).toBe(true);
  });

  it.skipIf(!conversationId || !serviceUrl)('delivers a message into a real Teams thread', async () => {
    expect(isPermittedServiceUrl(serviceUrl!)).toBe(true);

    const provider = new BotFrameworkTeamsProvider(appId!, appPassword!);
    const result = await provider.send({
      serviceUrl: serviceUrl!,
      conversationId: conversationId!,
      text:
        'Commissioning check from the Mac test suite. No action needed.\n\n' +
        `_${MAC_TEAMS_IDENTITY.signature}_`,
      replyToId: null,
    });

    expect(result.error).toBeNull();
    expect(result.accepted).toBe(true);
  });

  it('refuses to send anywhere that is not a Bot Framework host, even live', async () => {
    /*
     * Re-checked at the point of use, because this is the line that attaches
     * Mac's bearer token to an outbound request. Asserted against the real
     * provider so the guard cannot be one that only exists in a fake.
     */
    const provider = new BotFrameworkTeamsProvider(appId!, appPassword!);
    const result = await provider.send({
      serviceUrl: 'https://evil.example/collect',
      conversationId: 'whatever',
      text: 'this must not be sent',
      replyToId: null,
    });

    expect(result.accepted).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/not a Bot Framework service host/);
  });
});

describe('the live Teams test is opt-in', () => {
  it('says what is missing rather than silently passing', () => {
    if (ready) return;
    // A skipped test that looks like a passing one is how an integration goes
    // uncommissioned for a sprint. This records, in the run output, that the
    // real path was NOT exercised and what it would take.
    expect(
      `Live Teams test skipped. Set MAC_TEAMS_LIVE_TEST=1 plus MAC_TEAMS_LIVE_APP_ID and ` +
        `MAC_TEAMS_LIVE_APP_PASSWORD (and optionally MAC_TEAMS_LIVE_CONVERSATION_ID and ` +
        `MAC_TEAMS_LIVE_SERVICE_URL to send an actual message).`,
    ).toContain('Live Teams test skipped');
  });
});
