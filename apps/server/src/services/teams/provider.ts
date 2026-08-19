import {
  ADAPTIVE_CARD_CONTENT_TYPE,
  isPermittedServiceUrl,
  MAC_TEAMS_IDENTITY,
  TEAMS_SETUP_REQUIREMENTS,
  type AdaptiveCardAttachment,
} from '@mac/protocol';
import { config } from '../../config.js';

/**
 * Sending as Mac in Teams (Phase 4 Part A).
 *
 * ---------------------------------------------------------------------------
 * MAC IS A BOT, AND THAT IS THE HONEST ANSWER
 *
 * Teams provides no mechanism for a third-party application to post as a human
 * user account. Mac therefore appears as an application identity named
 * "Mac Bennett", and every substantive message carries
 * "Mac Bennett · Automation Engineer · PAC Technologies".
 *
 * That is also the right outcome rather than merely the available one. A
 * message that looks like it came from a colleague and did not is a lie told by
 * the system, and a reader must be able to tell that Mac is an agent.
 * ---------------------------------------------------------------------------
 */

export interface OutboundTeamsMessage {
  /** The Bot Connector endpoint, taken from a VERIFIED activity. */
  serviceUrl: string;
  conversationId: string;
  text: string;
  attachments?: AdaptiveCardAttachment[];
  /** Reply in-thread where the channel supports it. */
  replyToId?: string | null;
}

export interface TeamsSendResult {
  accepted: boolean;
  providerMessageId: string | null;
  error: string | null;
  /** False for a permanent rejection: retrying a 403 forever helps nobody. */
  retryable: boolean;
}

export interface TeamsProvider {
  readonly name: 'graph' | 'fake' | 'none';
  isAvailable(): Promise<{ available: boolean; reason?: string; missing?: string[] }>;
  send(message: OutboundTeamsMessage): Promise<TeamsSendResult>;
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Records everything, fails on demand. The whole standard suite uses this. */
export class FakeTeamsProvider implements TeamsProvider {
  readonly name = 'fake' as const;
  readonly sent: OutboundTeamsMessage[] = [];
  failNext = 0;
  failPermanently = false;
  available = true;

  async isAvailable() {
    return this.available ? { available: true } : { available: false, reason: 'Fake Teams provider disabled.' };
  }

  async send(message: OutboundTeamsMessage): Promise<TeamsSendResult> {
    if (!this.available) {
      return { accepted: false, providerMessageId: null, error: 'Provider disabled.', retryable: true };
    }
    if (this.failNext > 0) {
      this.failNext -= 1;
      return {
        accepted: false,
        providerMessageId: null,
        error: this.failPermanently ? 'Rejected permanently.' : 'Temporary failure.',
        retryable: !this.failPermanently,
      };
    }
    this.sent.push(message);
    return { accepted: true, providerMessageId: `fake-teams-${this.sent.length}`, error: null, retryable: false };
  }
}

/** Configured but with nowhere to send. Says so, rather than pretending. */
export class NullTeamsProvider implements TeamsProvider {
  readonly name = 'none' as const;
  async isAvailable() {
    return {
      available: false,
      reason: 'Teams is not configured.',
      missing: TEAMS_SETUP_REQUIREMENTS.map((r) => r.key),
    };
  }
  async send(): Promise<TeamsSendResult> {
    return { accepted: false, providerMessageId: null, error: 'Teams is not configured.', retryable: false };
  }
}

// ---------------------------------------------------------------------------
// The real one
// ---------------------------------------------------------------------------

/**
 * The Bot Connector REST API, client-credentials flow.
 *
 * Every field holding a secret is an ECMAScript `#` member rather than a
 * TypeScript `private` one — the same rule the Graph mail client follows, and
 * for the reason commissioning found on the monday client: TypeScript erases
 * `private`, so as an ordinary field a client secret and a live bearer token
 * appear in `Object.keys`, in a spread, and in anything that `JSON.stringify`s
 * a provider into a log line.
 */
export class BotFrameworkTeamsProvider implements TeamsProvider {
  readonly name = 'graph' as const;

  readonly #appId: string;
  readonly #appPassword: string;
  #token: { value: string; expiresAt: number } | null = null;

  constructor(appId: string, appPassword: string) {
    this.#appId = appId;
    this.#appPassword = appPassword;
  }

  async isAvailable(): Promise<{ available: boolean; reason?: string; missing?: string[] }> {
    const missing = missingTeamsConfiguration();
    if (missing.length) {
      return { available: false, reason: `Teams configuration is incomplete.`, missing };
    }
    try {
      await this.#accessToken();
      return { available: true };
    } catch (err) {
      return { available: false, reason: (err as Error).message };
    }
  }

  async send(message: OutboundTeamsMessage): Promise<TeamsSendResult> {
    /*
     * The service URL is re-validated at the point of use.
     *
     * It was already checked against the signed token when the activity
     * arrived, and it is checked again here because this is the line that
     * attaches Mac's bearer token to an outbound request. A value that reached
     * the database through some future path that forgot to validate would
     * otherwise become a credential disclosure, and the cost of checking twice
     * is one string comparison.
     */
    if (!isPermittedServiceUrl(message.serviceUrl)) {
      return {
        accepted: false,
        providerMessageId: null,
        error: `Refusing to send to ${message.serviceUrl}: not a Bot Framework service host.`,
        retryable: false,
      };
    }

    let token: string;
    try {
      token = await this.#accessToken();
    } catch (err) {
      return { accepted: false, providerMessageId: null, error: (err as Error).message, retryable: true };
    }

    const base = message.serviceUrl.replace(/\/+$/, '');
    const path = message.replyToId
      ? `/v3/conversations/${encodeURIComponent(message.conversationId)}/activities/${encodeURIComponent(message.replyToId)}`
      : `/v3/conversations/${encodeURIComponent(message.conversationId)}/activities`;

    const body = {
      type: 'message',
      from: { id: this.#appId, name: MAC_TEAMS_IDENTITY.displayName },
      textFormat: 'markdown',
      text: message.text,
      ...(message.attachments?.length
        ? {
            attachments: message.attachments.map((attachment) => ({
              contentType: ADAPTIVE_CARD_CONTENT_TYPE,
              content: attachment.content,
            })),
          }
        : {}),
    };

    try {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        return {
          accepted: false,
          providerMessageId: null,
          error: `Bot Connector returned ${response.status}: ${detail}`,
          // 4xx other than 429 will not succeed on a retry.
          retryable: response.status === 429 || response.status >= 500,
        };
      }

      const result = (await response.json().catch(() => ({}))) as { id?: string };
      return { accepted: true, providerMessageId: result.id ?? null, error: null, retryable: false };
    } catch (err) {
      return { accepted: false, providerMessageId: null, error: (err as Error).message, retryable: true };
    }
  }

  /** Cached until shortly before expiry, so a send is one request not two. */
  async #accessToken(): Promise<string> {
    if (this.#token && this.#token.expiresAt > Date.now() + 60_000) return this.#token.value;

    const response = await fetch(`${config.teams.loginUrl}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.#appId,
        client_secret: this.#appPassword,
        scope: 'https://api.botframework.com/.default',
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      // The body of a failed token request can echo the secret back in an error
      // description, so it is deliberately not included here.
      throw new Error(`Could not obtain a Bot Connector token (HTTP ${response.status}).`);
    }

    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) throw new Error('The token endpoint returned no access token.');

    this.#token = {
      value: payload.access_token,
      expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
    };
    return this.#token.value;
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function missingTeamsConfiguration(): string[] {
  const missing: string[] = [];
  if (!config.teams.appId) missing.push('MAC_TEAMS_APP_ID');
  if (!config.teams.appPassword) missing.push('MAC_TEAMS_APP_PASSWORD');
  if (!config.teams.tenantId) missing.push('MAC_TEAMS_TENANT_ID');
  return missing;
}

let override: TeamsProvider | null = null;

/**
 * Test seam.
 *
 * The same shape the monday, mail and company-context providers use, so a test
 * installs a fake the same way everywhere and nobody has to remember three
 * mechanisms.
 */
export function setTeamsProvider(provider: TeamsProvider | null): void {
  override = provider;
}

export function getTeamsProvider(): TeamsProvider {
  if (override) return override;
  if (missingTeamsConfiguration().length > 0) return new NullTeamsProvider();
  return new BotFrameworkTeamsProvider(config.teams.appId!, config.teams.appPassword!);
}
