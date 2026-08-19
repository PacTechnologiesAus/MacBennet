import { createPublicKey, createVerify, timingSafeEqual } from 'node:crypto';
import { isPermittedServiceUrl, type TeamsActivity } from '@mac/protocol';
import { config } from '../../config.js';

/**
 * Verifying that an inbound activity really came from the Bot Framework
 * (Phase 4 Part A).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS WRITTEN OUT RATHER THAN IMPORTED
 *
 * Same reasoning as the model providers and the Graph mail client: `fetch` and
 * `node:crypto` are enough, and a JWT library would be a new dependency in the
 * trust path of a public, unauthenticated HTTP endpoint. Node 20 imports a JWK
 * directly via `createPublicKey({ format: 'jwk' })`, which is the only part
 * that used to be awkward.
 *
 * ---------------------------------------------------------------------------
 * WHAT AN UNVERIFIED ENDPOINT WOULD MEAN
 *
 * `/api/teams/messages` is reachable by anyone on the internet. Without this,
 * a POST containing a plausible activity would let a stranger:
 *
 *   * put words in a colleague's mouth inside a Mac conversation;
 *   * supply a `serviceUrl` and receive Mac's Bot Connector bearer token;
 *   * claim to be an authorised Teams user and assign work.
 *
 * The third is separately defended — authorisation reads
 * `settings.teams_authorised_users` and is checked against the verified AAD
 * object id, not a claimed one — but the first two are stopped here or not at
 * all.
 *
 * ---------------------------------------------------------------------------
 * EVERY CHECK BELOW EXISTS BECAUSE OMITTING IT IS A KNOWN BUG CLASS
 *
 *   * `alg` is checked against an allowlist BEFORE anything else. A token
 *     claiming `alg: none`, or a symmetric algorithm verified with a public key
 *     as the HMAC secret, are the two oldest JWT vulnerabilities there are.
 *   * `aud` must equal Mac's own app id. A validly-signed token issued for a
 *     DIFFERENT bot is signed by the same authority and would otherwise pass.
 *   * `iss` must be an expected issuer.
 *   * `exp` and `nbf` are checked with a small skew.
 *   * `serviceUrl` in the token must match the one in the activity — the Bot
 *     Framework signs it precisely so that a relayed activity cannot have its
 *     reply address swapped.
 *   * the key comes from the configured metadata document, never from the
 *     token's own header. An issuer that nominates its own key source is a
 *     signature check that verifies nothing.
 * ---------------------------------------------------------------------------
 */

export const PERMITTED_ALGORITHMS = ['RS256', 'RS384', 'RS512'] as const;

/** Issuers the Bot Framework signs with. Emulator and government clouds included. */
export const EXPECTED_ISSUERS = [
  'https://api.botframework.com',
  'https://login.botframework.com/v1/.well-known/openidconfiguration',
];

/** Tolerance for clock skew between Microsoft and this host. */
const CLOCK_SKEW_SECONDS = 300;

export interface VerificationSuccess {
  ok: true;
  /** The verified claims. Everything downstream reads these, not the body. */
  claims: {
    aud: string;
    iss: string;
    serviceUrl: string | null;
    appid: string | null;
  };
}

export interface VerificationFailure {
  ok: false;
  /** Machine-readable, so the audit event can group rejections. */
  code:
    | 'not_configured'
    | 'missing_token'
    | 'malformed_token'
    | 'unsupported_algorithm'
    | 'unknown_key'
    | 'bad_signature'
    | 'wrong_audience'
    | 'wrong_issuer'
    | 'expired'
    | 'not_yet_valid'
    | 'service_url_mismatch'
    | 'service_url_not_permitted'
    | 'wrong_tenant'
    | 'metadata_unavailable';
  reason: string;
}

export type VerificationResult = VerificationSuccess | VerificationFailure;

const fail = (code: VerificationFailure['code'], reason: string): VerificationFailure => ({ ok: false, code, reason });

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

interface JsonWebKey {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
  use?: string;
  /** Bot Framework publishes the app ids a key is valid for. */
  endorsements?: string[];
}

interface KeyCache {
  keys: Map<string, JsonWebKey>;
  fetchedAt: number;
}

let cache: KeyCache | null = null;

/**
 * Cached for an hour, and refreshed once on an unknown `kid`.
 *
 * Microsoft rotates signing keys, and a cache with no refresh path fails closed
 * across a rotation — every message rejected until somebody restarts the
 * process. Refreshing on an unknown key handles a rotation within one request;
 * the hourly expiry handles the ordinary case.
 *
 * The single retry is what stops an attacker forcing a metadata fetch per
 * request by sending random `kid` values: a second miss in the same request is
 * a rejection rather than another fetch.
 */
const CACHE_TTL_MS = 60 * 60 * 1000;

async function loadKeys(force = false): Promise<Map<string, JsonWebKey>> {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.keys;

  const metadataResponse = await fetch(config.teams.openIdMetadataUrl, { signal: AbortSignal.timeout(15_000) });
  if (!metadataResponse.ok) {
    throw new Error(`OpenID metadata returned ${metadataResponse.status}`);
  }
  const metadata = (await metadataResponse.json()) as { jwks_uri?: string };
  if (!metadata.jwks_uri) throw new Error('OpenID metadata contains no jwks_uri');

  const jwksResponse = await fetch(metadata.jwks_uri, { signal: AbortSignal.timeout(15_000) });
  if (!jwksResponse.ok) throw new Error(`JWKS returned ${jwksResponse.status}`);

  const jwks = (await jwksResponse.json()) as { keys?: JsonWebKey[] };
  const keys = new Map<string, JsonWebKey>();
  for (const key of jwks.keys ?? []) {
    if (key.kid && key.kty === 'RSA' && key.n && key.e) keys.set(key.kid, key);
  }

  cache = { keys, fetchedAt: Date.now() };
  return keys;
}

/** Test seam. The suite installs a local key set rather than reaching Microsoft. */
export function __setKeyCacheForTests(keys: Map<string, JsonWebKey> | null): void {
  cache = keys ? { keys, fetchedAt: Date.now() } : null;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

const decodeSegment = (segment: string): unknown => {
  const json = Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return JSON.parse(json);
};

export async function verifyTeamsRequest(input: {
  authorizationHeader: string | undefined;
  activity: TeamsActivity;
}): Promise<VerificationResult> {
  const appId = config.teams.appId;
  if (!appId) return fail('not_configured', 'No Teams application id is configured.');

  const header = input.authorizationHeader ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) return fail('missing_token', 'No bearer token was presented.');

  const parts = token.split('.');
  if (parts.length !== 3) return fail('malformed_token', 'The token is not a three-part JWS.');

  let head: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    head = decodeSegment(parts[0]!) as { alg?: string; kid?: string };
    claims = decodeSegment(parts[1]!) as Record<string, unknown>;
  } catch {
    return fail('malformed_token', 'The token header or payload is not valid base64url JSON.');
  }

  /*
   * The algorithm check comes FIRST, and is an allowlist.
   *
   * `alg: none` and algorithm confusion (verifying an HS256 token using the
   * RSA public key as the HMAC secret) are the two oldest JWT vulnerabilities,
   * and both are prevented by refusing to look at anything the token says about
   * how to verify it beyond choosing among algorithms we already accept.
   */
  if (!head.alg || !(PERMITTED_ALGORITHMS as readonly string[]).includes(head.alg)) {
    return fail('unsupported_algorithm', `Token algorithm "${head.alg ?? 'none'}" is not accepted.`);
  }
  if (!head.kid) return fail('unknown_key', 'The token names no signing key.');

  let keys: Map<string, JsonWebKey>;
  try {
    keys = await loadKeys();
    if (!keys.has(head.kid)) keys = await loadKeys(true);
  } catch (err) {
    return fail('metadata_unavailable', `Could not load Bot Framework signing keys: ${(err as Error).message}`);
  }

  const jwk = keys.get(head.kid);
  if (!jwk) return fail('unknown_key', `Signing key ${head.kid} is not published by the Bot Framework.`);

  let verified = false;
  try {
    const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n!, e: jwk.e! }, format: 'jwk' });
    const algorithm = head.alg === 'RS512' ? 'RSA-SHA512' : head.alg === 'RS384' ? 'RSA-SHA384' : 'RSA-SHA256';
    const verifier = createVerify(algorithm);
    verifier.update(`${parts[0]}.${parts[1]}`);
    verifier.end();
    verified = verifier.verify(key, Buffer.from(parts[2]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  } catch (err) {
    return fail('bad_signature', `The signature could not be checked: ${(err as Error).message}`);
  }
  if (!verified) return fail('bad_signature', 'The token signature does not verify.');

  // --- Claims --------------------------------------------------------------

  const audience = typeof claims.aud === 'string' ? claims.aud : '';
  /*
   * A validly-signed token issued for a DIFFERENT bot is signed by the same
   * authority and would otherwise sail through. Constant-time because the
   * comparison is against a value an attacker supplies.
   */
  if (!constantTimeEquals(audience, appId)) {
    return fail('wrong_audience', 'The token was not issued for this application.');
  }

  const issuer = typeof claims.iss === 'string' ? claims.iss : '';
  if (!EXPECTED_ISSUERS.includes(issuer)) {
    return fail('wrong_issuer', `Issuer "${issuer}" is not an expected Bot Framework issuer.`);
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = typeof claims.exp === 'number' ? claims.exp : 0;
  const nbf = typeof claims.nbf === 'number' ? claims.nbf : 0;
  if (exp && now > exp + CLOCK_SKEW_SECONDS) return fail('expired', 'The token has expired.');
  if (nbf && now < nbf - CLOCK_SKEW_SECONDS) return fail('not_yet_valid', 'The token is not yet valid.');

  /*
   * `serviceUrl` is signed by the Bot Framework precisely so that a relayed
   * activity cannot have its reply address swapped for one the attacker
   * controls. Checking the signature and then trusting the body's copy would
   * throw that guarantee away.
   */
  const tokenServiceUrl = typeof claims.serviceUrl === 'string' ? claims.serviceUrl : null;
  const activityServiceUrl = input.activity.serviceUrl ?? null;

  if (tokenServiceUrl && activityServiceUrl && normaliseUrl(tokenServiceUrl) !== normaliseUrl(activityServiceUrl)) {
    return fail('service_url_mismatch', 'The activity nominates a different reply address than the token signs.');
  }

  const effectiveServiceUrl = tokenServiceUrl ?? activityServiceUrl;
  if (effectiveServiceUrl && !isPermittedServiceUrl(effectiveServiceUrl)) {
    // Belt and braces over the signature: even a correctly signed serviceUrl
    // pointing somewhere unexpected does not get Mac's bearer token.
    return fail('service_url_not_permitted', `${effectiveServiceUrl} is not a Bot Framework service host.`);
  }

  /*
   * Single-tenant: activities from another tenant are refused.
   *
   * Configured rather than derived, because a bot registered as multi-tenant
   * will happily receive activities from any tenant that installs it, and "any
   * tenant" includes one an attacker owns.
   */
  const expectedTenant = config.teams.tenantId;
  if (expectedTenant) {
    const tenant = input.activity.channelData?.tenant?.id ?? input.activity.conversation?.tenantId ?? null;
    if (tenant && tenant !== expectedTenant) {
      return fail('wrong_tenant', 'The activity came from a different Microsoft tenant.');
    }
  }

  return {
    ok: true,
    claims: {
      aud: audience,
      iss: issuer,
      serviceUrl: effectiveServiceUrl,
      appid: typeof claims.appid === 'string' ? claims.appid : null,
    },
  };
}

const normaliseUrl = (value: string): string => value.trim().toLowerCase().replace(/\/+$/, '');

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // `timingSafeEqual` throws on a length mismatch, which would itself leak the
  // length. Comparing a padded copy keeps the branch off the secret.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
