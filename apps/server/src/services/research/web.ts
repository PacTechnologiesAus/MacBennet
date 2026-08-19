import {
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_TEXT_CHARS,
  WEB_SEARCH_PROVIDER_REQUIREMENTS,
  WebResearchError,
  webSearchResultSchema,
  type WebDocument,
  type WebSearchProvider,
  type WebSearchProviderClient,
  type WebSearchResult,
} from '@mac/protocol';
import { config } from '../../config.js';

/**
 * External web search providers (Phase 4 Part E §16).
 *
 * ---------------------------------------------------------------------------
 * NOTHING HAS BEEN PURCHASED AND NO ACCOUNT HAS BEEN CREATED
 *
 * §16 is explicit: if choosing a provider needs a paid account or a financial
 * decision, stop there and document the exact requirement rather than buying
 * anything. So all three are implemented against their real APIs, none is
 * configured, and what each needs from a human is recorded as typed data in
 * `WEB_SEARCH_PROVIDER_REQUIREMENTS` — which is what lets the settings page
 * name the specific missing thing instead of saying "search is not configured".
 *
 * ---------------------------------------------------------------------------
 * WHY THREE AND NOT ONE
 *
 * The same argument Sprint 3.3 made when it added a second reasoning provider:
 * an interface with one implementation is an assumption rather than an
 * abstraction. These three differ in the ways that make an abstraction worth
 * having — a header key, a query-string key and no key at all; three different
 * response envelopes; three different error shapes.
 *
 * SearXNG is the one PAC can actually run. It needs no account with anybody,
 * which makes it a deployment decision for a person rather than a purchase.
 * ---------------------------------------------------------------------------
 */

const timeout = () => AbortSignal.timeout(config.search.timeoutMs);

/** Configured but with nowhere to search. Refuses, rather than returning nothing. */
export class NullWebSearchProvider implements WebSearchProviderClient {
  readonly name = 'none' as const;
  async search(): Promise<WebSearchResult[]> {
    /*
     * The refusal Sprint 3.3 wrote, kept word for word.
     *
     * An empty result set is not the same answer as "no provider is
     * configured", and a model reading zero results will write down that the
     * web contains nothing about the subject. It has to fail rather than
     * return.
     */
    throw new WebResearchError(
      'not_configured',
      'No web-search provider is configured. Mac will not guess at search results, and an empty result here ' +
        'would read as "the web says nothing about this".',
    );
  }
}

/**
 * SearXNG — a metasearch instance PAC hosts.
 *
 * No credential at all, which is why it is the provider a deployment can adopt
 * without a commercial conversation. Pointing it at a public community instance
 * would send PAC's research queries to a stranger's server, so the setting is
 * documented as requiring an instance PAC controls.
 */
export class SearxngProvider implements WebSearchProviderClient {
  readonly name = 'searxng' as const;
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async search(query: string, options: { limit: number; signal?: AbortSignal }): Promise<WebSearchResult[]> {
    const url = new URL(`${this.#baseUrl}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('safesearch', '1');

    const response = await this.#fetch(url, options.signal);
    const payload = (await response.json().catch(() => null)) as {
      results?: Array<{ url?: string; title?: string; content?: string; publishedDate?: string }>;
    } | null;

    if (!payload || !Array.isArray(payload.results)) {
      throw new WebResearchError('malformed_response', 'SearXNG returned something that is not a result list.');
    }

    return payload.results
      .slice(0, options.limit)
      .map((item) =>
        webSearchResultSchema.safeParse({
          url: item.url ?? '',
          title: item.title ?? '',
          snippet: item.content ?? '',
          publishedAt: item.publishedDate ?? null,
        }),
      )
      .filter((parsed) => parsed.success)
      .map((parsed) => parsed.data!);
  }

  async #fetch(url: URL, signal?: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, { signal: signal ?? timeout(), headers: { accept: 'application/json' } });
    } catch (err) {
      throw new WebResearchError(
        (err as Error).name === 'TimeoutError' ? 'timeout' : 'unreachable',
        `SearXNG at ${this.#baseUrl} could not be reached: ${(err as Error).message}`,
      );
    }
    if (response.status === 429) throw new WebResearchError('rate_limited', 'SearXNG rate-limited the request.');
    if (!response.ok) {
      throw new WebResearchError('unreachable', `SearXNG returned ${response.status}.`);
    }
    return response;
  }
}

/**
 * Brave Search.
 *
 * Header-authenticated, and a different envelope again. Brave requires an
 * account and a subscription plan with a payment method on file even for the
 * free tier, which makes adopting it a commercial decision for a person at PAC.
 */
export class BraveSearchProvider implements WebSearchProviderClient {
  readonly name = 'brave' as const;
  readonly #apiKey: string;

  constructor(apiKey: string) {
    this.#apiKey = apiKey;
  }

  async search(query: string, options: { limit: number; signal?: AbortSignal }): Promise<WebSearchResult[]> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(Math.min(options.limit, 20)));

    let response: Response;
    try {
      response = await fetch(url, {
        signal: options.signal ?? timeout(),
        headers: { accept: 'application/json', 'x-subscription-token': this.#apiKey },
      });
    } catch (err) {
      throw new WebResearchError(
        (err as Error).name === 'TimeoutError' ? 'timeout' : 'unreachable',
        `Brave Search could not be reached: ${(err as Error).message}`,
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new WebResearchError('unauthorised', 'Brave Search rejected the subscription token.');
    }
    if (response.status === 429) throw new WebResearchError('rate_limited', 'Brave Search rate-limited the request.');
    if (!response.ok) throw new WebResearchError('unreachable', `Brave Search returned ${response.status}.`);

    const payload = (await response.json().catch(() => null)) as {
      web?: { results?: Array<{ url?: string; title?: string; description?: string; age?: string }> };
    } | null;

    const results = payload?.web?.results;
    if (!Array.isArray(results)) {
      throw new WebResearchError('malformed_response', 'Brave Search returned no web result list.');
    }

    return results
      .slice(0, options.limit)
      .map((item) =>
        webSearchResultSchema.safeParse({
          url: item.url ?? '',
          title: item.title ?? '',
          snippet: stripTags(item.description ?? ''),
          publishedAt: item.age ?? null,
        }),
      )
      .filter((parsed) => parsed.success)
      .map((parsed) => parsed.data!);
  }
}

/**
 * Google Programmable Search.
 *
 * Query-string authenticated, a third envelope, and it needs a Cloud project
 * plus a Programmable Search Engine id. Queries above the free daily allowance
 * are billed, which again makes it a decision for a person.
 */
export class GoogleCseProvider implements WebSearchProviderClient {
  readonly name = 'google_cse' as const;
  readonly #apiKey: string;
  readonly #engineId: string;

  constructor(apiKey: string, engineId: string) {
    this.#apiKey = apiKey;
    this.#engineId = engineId;
  }

  async search(query: string, options: { limit: number; signal?: AbortSignal }): Promise<WebSearchResult[]> {
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('q', query);
    url.searchParams.set('key', this.#apiKey);
    url.searchParams.set('cx', this.#engineId);
    url.searchParams.set('num', String(Math.min(options.limit, 10)));

    let response: Response;
    try {
      response = await fetch(url, { signal: options.signal ?? timeout(), headers: { accept: 'application/json' } });
    } catch (err) {
      throw new WebResearchError(
        (err as Error).name === 'TimeoutError' ? 'timeout' : 'unreachable',
        `Google Programmable Search could not be reached: ${(err as Error).message}`,
      );
    }

    if (response.status === 403) {
      // Google returns 403 for both a bad key and an exhausted quota, and the
      // difference matters to whoever has to fix it.
      const detail = (await response.text()).slice(0, 300);
      throw new WebResearchError(
        /quota|limit/i.test(detail) ? 'rate_limited' : 'unauthorised',
        `Google Programmable Search refused the request: ${detail}`,
      );
    }
    if (response.status === 429) throw new WebResearchError('rate_limited', 'Google rate-limited the request.');
    if (!response.ok) throw new WebResearchError('unreachable', `Google returned ${response.status}.`);

    const payload = (await response.json().catch(() => null)) as {
      items?: Array<{ link?: string; title?: string; snippet?: string }>;
    } | null;

    // An empty Google response omits `items` entirely, which is genuinely "no
    // results" rather than a malformed reply — so it is not an error.
    if (!payload) throw new WebResearchError('malformed_response', 'Google returned an unreadable body.');
    if (!payload.items) return [];

    return payload.items
      .slice(0, options.limit)
      .map((item) =>
        webSearchResultSchema.safeParse({
          url: item.link ?? '',
          title: item.title ?? '',
          snippet: item.snippet ?? '',
          publishedAt: null,
        }),
      )
      .filter((parsed) => parsed.success)
      .map((parsed) => parsed.data!);
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

let override: WebSearchProviderClient | null = null;

/** Test seam, the same shape every other provider in this system uses. */
export function setWebSearchProvider(provider: WebSearchProviderClient | null): void {
  override = provider;
}

/**
 * The configured provider, or one that refuses.
 *
 * A provider named in settings but missing its credential returns the null
 * provider rather than a half-built one — so the failure is "not configured",
 * which is actionable, instead of an authentication error at 02:00.
 */
export function getWebSearchProvider(name: WebSearchProvider): WebSearchProviderClient {
  if (override) return override;

  switch (name) {
    case 'searxng':
      return config.search.baseUrl ? new SearxngProvider(config.search.baseUrl) : new NullWebSearchProvider();
    case 'brave':
      return config.search.apiKey ? new BraveSearchProvider(config.search.apiKey) : new NullWebSearchProvider();
    case 'google_cse':
      return config.search.apiKey && config.search.engineId
        ? new GoogleCseProvider(config.search.apiKey, config.search.engineId)
        : new NullWebSearchProvider();
    case 'none':
      return new NullWebSearchProvider();
  }
}

/** What is still missing before the named provider would work. */
export function missingSearchConfiguration(name: WebSearchProvider): string[] {
  const required = WEB_SEARCH_PROVIDER_REQUIREMENTS[name].envKeys;
  const present: Record<string, boolean> = {
    MAC_SEARCH_API_KEY: Boolean(config.search.apiKey),
    MAC_SEARCH_ENGINE_ID: Boolean(config.search.engineId),
    MAC_SEARCH_BASE_URL: Boolean(config.search.baseUrl),
  };
  return required.filter((key) => !present[key]);
}

// ---------------------------------------------------------------------------
// Document retrieval
// ---------------------------------------------------------------------------

/**
 * Fetches one document.
 *
 * The gates are unchanged from Sprint 3.3 — HTTPS only, host on the
 * administrator's allowlist, no redirect following, bounded response — and are
 * applied by the caller, which is where the allowlist lives. What this adds is
 * a byte ceiling enforced while STREAMING rather than after: a caller that
 * reads a 4GB response into memory and then truncates it has already lost.
 */
export async function fetchDocument(url: URL, signal?: AbortSignal): Promise<WebDocument> {
  const response = await fetch(url, {
    redirect: 'manual',
    signal: signal ?? timeout(),
    headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8' },
  });

  if (response.status >= 300 && response.status < 400) {
    throw new WebResearchError(
      'refused',
      `${url.hostname} redirected, and a redirect could leave the allowlist. Not followed.`,
    );
  }
  if (!response.ok) throw new WebResearchError('unreachable', `${url.hostname} returned ${response.status}.`);

  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';

  const { text, bytes, truncated } = await readBounded(response);

  return {
    url: url.toString(),
    title: extractTitle(text) || url.hostname + url.pathname,
    text: (/html/i.test(contentType) ? stripTags(text) : text).slice(0, MAX_DOCUMENT_TEXT_CHARS),
    contentType,
    retrievedAt: new Date().toISOString(),
    bytes,
    truncated,
  };
}

/** Reads at most `MAX_DOCUMENT_BYTES`, and stops the transfer once past it. */
async function readBounded(response: Response): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: '', bytes: 0, truncated: false };

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength;
    chunks.push(value);
    if (bytes >= MAX_DOCUMENT_BYTES) {
      truncated = true;
      // Stop pulling. A hostile or merely enormous document must not be able to
      // occupy this process for as long as it feels like sending.
      await reader.cancel().catch(() => undefined);
      break;
    }
  }

  return { text: Buffer.concat(chunks).toString('utf8'), bytes, truncated };
}

const stripTags = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

const extractTitle = (html: string): string => {
  const match = /<title[^>]*>([\s\S]{1,300}?)<\/title>/i.exec(html);
  return match ? stripTags(match[1]!).slice(0, 300) : '';
};
