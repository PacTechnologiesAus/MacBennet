import type { MailProvider, MailSendResult, OutboundMail } from '@mac/protocol';
import { config } from '../../config.js';
import { getSettings } from '../settings.js';

/**
 * Mail providers (Sprint 3 §9.1).
 *
 * Microsoft Graph, because spec §2 and §19 already say Mac has a genuine PAC
 * Technologies mailbox and a Microsoft identity — so this is the mailbox he is
 * supposed to be sending from rather than a parallel one bolted on for the
 * purpose. It also needs no new npm dependency: `fetch` is enough.
 *
 * SMTP is a drop-in later. The interface is three methods wide.
 */

/** Records everything, fails on demand. The whole standard suite uses this. */
export class FakeMailProvider implements MailProvider {
  readonly name = 'fake' as const;
  readonly sent: OutboundMail[] = [];
  /** Fails the next N sends, so retry and dead-lettering are testable. */
  failNext = 0;
  failPermanently = false;
  available = true;

  async isAvailable() {
    return this.available ? { available: true } : { available: false, reason: 'Fake provider disabled.' };
  }

  async send(message: OutboundMail): Promise<MailSendResult> {
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
    return { accepted: true, providerMessageId: `fake-${this.sent.length}`, retryable: false };
  }
}

/** Configured but with nowhere to send. Reports that, rather than pretending. */
export class NullMailProvider implements MailProvider {
  readonly name = 'none' as const;
  async isAvailable() {
    return { available: false, reason: 'No mail provider is configured.' };
  }
  async send(): Promise<MailSendResult> {
    return { accepted: false, providerMessageId: null, error: 'No mail provider is configured.', retryable: false };
  }
}

/**
 * Microsoft Graph, client-credentials flow.
 *
 * Every field holding a secret is an ECMAScript `#` member rather than a
 * TypeScript `private` one. TypeScript erases `private`: it is a rule the
 * compiler enforces on code that agrees to be compiled, and this object holds
 * the mailbox's client secret and a live bearer token. As ordinary fields they
 * would appear in `Object.keys`, in a spread, and in anything that
 * `JSON.stringify`s a provider into a log line — which is exactly the leak
 * Sprint 3.1 §14 asks to be sure does not exist. Found on the monday client
 * during commissioning and fixed in the same shape here.
 */
export class GraphMailProvider implements MailProvider {
  readonly name = 'graph' as const;
  #token: { value: string; expiresAt: number } | null = null;

  readonly #options: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    from: string;
    fetchImpl?: typeof fetch;
  };

  constructor(options: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    from: string;
    fetchImpl?: typeof fetch;
  }) {
    this.#options = options;
  }

  /** The mailbox Mac sends from. Deliberately the only thing readable. */
  get from(): string {
    return this.#options.from;
  }

  async isAvailable() {
    const { tenantId, clientId, clientSecret, from } = this.#options;
    if (!tenantId || !clientId || !clientSecret || !from) {
      return { available: false, reason: 'Graph mail is not fully configured.' };
    }
    try {
      await this.#accessToken();
      return { available: true };
    } catch (err) {
      return { available: false, reason: (err as Error).message };
    }
  }

  async send(message: OutboundMail): Promise<MailSendResult> {
    const fetchImpl = this.#options.fetchImpl ?? fetch;

    try {
      const token = await this.#accessToken();
      const response = await fetchImpl(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.#options.from)}/sendMail`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({
            message: {
              subject: message.subject,
              body: message.html
                ? { contentType: 'HTML', content: message.html }
                : { contentType: 'Text', content: message.text },
              toRecipients: message.to.map((address) => ({ emailAddress: { address } })),
              // Carried so a human can correlate a message in the mailbox with
              // the delivery row that produced it.
              internetMessageHeaders: [{ name: 'x-mac-idempotency-key', value: message.idempotencyKey.slice(0, 120) }],
            },
            saveToSentItems: true,
          }),
        },
      );

      if (response.status === 202) {
        /*
         * Graph's `sendMail` returns 202 with an empty body and no message id.
         *
         * Reported honestly as null rather than invented: a fabricated
         * provider id would look like proof of delivery in the very table that
         * exists to record whether delivery happened.
         */
        return { accepted: true, providerMessageId: null, retryable: false };
      }

      const body = await response.text();
      // 4xx will be rejected again; 429 and 5xx are worth retrying.
      const retryable = response.status === 429 || response.status >= 500;
      return {
        accepted: false,
        providerMessageId: null,
        error: `Graph returned ${response.status}: ${body.slice(0, 300)}`,
        retryable,
      };
    } catch (err) {
      return { accepted: false, providerMessageId: null, error: (err as Error).message, retryable: true };
    }
  }

  async #accessToken(): Promise<string> {
    if (this.#token && this.#token.expiresAt > Date.now() + 60_000) return this.#token.value;

    const fetchImpl = this.#options.fetchImpl ?? fetch;
    const response = await fetchImpl(
      `https://login.microsoftonline.com/${this.#options.tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.#options.clientId,
          client_secret: this.#options.clientSecret,
          scope: 'https://graph.microsoft.com/.default',
          grant_type: 'client_credentials',
        }).toString(),
      },
    );

    const text = await response.text();
    if (!response.ok) throw new Error(`Could not obtain a Graph token: ${response.status} ${text.slice(0, 200)}`);

    const parsed = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) throw new Error('Graph returned no access token.');

    this.#token = {
      value: parsed.access_token,
      expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000,
    };
    return this.#token.value;
  }
}

let override: MailProvider | null = null;

/** Test seam. */
export function setMailProvider(provider: MailProvider | null): void {
  override = provider;
}

export async function getMailProvider(): Promise<MailProvider> {
  if (override) return override;

  const settings = await getSettings();
  if (settings.mailProvider === 'fake') return new FakeMailProvider();
  if (settings.mailProvider === 'graph') {
    const { tenantId, clientId, clientSecret, from } = config.mail;
    if (tenantId && clientId && clientSecret && from) {
      return new GraphMailProvider({ tenantId, clientId, clientSecret, from });
    }
  }
  return new NullMailProvider();
}
