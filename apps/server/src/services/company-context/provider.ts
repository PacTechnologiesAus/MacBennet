import type { CompanyContextProviderKind } from '@mac/protocol';

/**
 * The seam between "where company context comes from" and everything Mac does
 * with it (Sprint 3.2 §3).
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT ON THIS INTERFACE, AND WHY THAT IS THE POINT
 *
 * There is no `write`, `commit`, `push`, `checkout` or `apply`. Not a guarded
 * one, not a privileged one, not one that checks a flag first — none at all.
 *
 * Sprint 3.2 §20 requires that coding-agent-generated text can never mutate the
 * authoritative Company checkout. A permission check would satisfy that
 * requirement conditionally: correct until somebody adds a caller that passes
 * the check. Removing the verb satisfies it unconditionally. Mac cannot write
 * PAC policy for the same reason he cannot fly — there is no method.
 *
 * If a future sprint genuinely needs Mac to open a pull request against the
 * Company repository, that belongs in a SEPARATE, explicitly-authorised
 * component with its own credential, not as a method here.
 * ---------------------------------------------------------------------------
 */

export interface ProviderDescription {
  /** With any credential already stripped. Safe to persist, log and display. */
  repositoryUrl: string;
  ref: string;
  cacheDir: string;
}

export interface ProviderRevision {
  commitSha: string;
  ref: string;
  /** ISO-8601, or null when the provider cannot supply one. */
  committedAt: string | null;
}

export type RefreshOutcome =
  | { ok: true; commitSha: string; changed: boolean; fetchedFromRemote: boolean }
  /** `error` is ALREADY redacted. Nothing downstream needs to redact it again. */
  | { ok: false; error: string; cachedCommitSha: string | null };

export interface CompanyContextProvider {
  readonly kind: CompanyContextProviderKind;
  describe(): ProviderDescription;
  /** Bring the local cache up to date with the remote. Never throws for a network failure. */
  refresh(): Promise<RefreshOutcome>;
  /** What the configured ref points at IN THE LOCAL CACHE. Null when there is no cache. */
  headRevision(): Promise<ProviderRevision | null>;
  listFiles(commitSha: string): Promise<string[]>;
  /** Throws `CompanyDocumentMissing` when the path does not exist at that commit. */
  readFile(commitSha: string, relativePath: string): Promise<string>;
}

export class CompanyDocumentMissing extends Error {
  override readonly name = 'CompanyDocumentMissing';
  constructor(
    readonly path: string,
    readonly commitSha: string,
  ) {
    super(`"${path}" does not exist at company context commit ${commitSha.slice(0, 7)}.`);
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

let override: CompanyContextProvider | null = null;

/**
 * Replaces the provider, for tests.
 *
 * Follows the same shape as `setMondayClient` and `setMailProvider`: the seam is
 * explicit and lives in one place, rather than tests reaching into module
 * internals. Passing `null` restores the real Git provider.
 */
export function setCompanyContextProvider(provider: CompanyContextProvider | null): void {
  override = provider;
}

export function getCompanyContextProviderOverride(): CompanyContextProvider | null {
  return override;
}
