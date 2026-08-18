import { eq } from 'drizzle-orm';
import path from 'node:path';
import type {
  CompanyContextRef,
  CompanyContextStatusDto,
  CompanyContextStatusKind,
  CompanyDocumentRecord,
} from '@mac/protocol';
import { shortSha, USABLE_COMPANY_CONTEXT_STATUSES } from '@mac/protocol';
import { config } from '../../config.js';
import { db, type DbHandle } from '../../db/client.js';
import { companyContextStatus } from '../../db/schema.js';
import type { CompanyContextRevisionRow, CompanyContextStatusRow } from '../../db/schema.js';
import { AppError } from '../../http/errors.js';
import { record, SYSTEM_ACTOR, type Actor } from '../audit.js';
import { getSettings } from '../settings.js';
import { GitCompanyContextProvider, sanitiseRepositoryUrl } from './git-provider.js';
import { loadRevision, revisionById, revisionDto } from './loader.js';
import {
  getCompanyContextProviderOverride,
  type CompanyContextProvider,
} from './provider.js';

/**
 * The company context service: refresh policy, cache policy, and binding
 * (Sprint 3.2 §9, §10).
 *
 * ---------------------------------------------------------------------------
 * THREE RULES THIS FILE ENFORCES
 *
 *  1. **Nothing runs on empty company context while claiming to be grounded.**
 *     When the feature is enabled and there is no valid revision,
 *     `requireActiveRevision` throws. It does not return null and hope a caller
 *     checks.
 *
 *  2. **Cached is never presented as fresh.** A revision Mac could not confirm
 *     against the remote keeps its exact SHA and is reported as `cached` or
 *     `stale`, and it is only used at all when an operator has permitted it.
 *
 *  3. **A run's revision never moves.** Nothing here updates a binding. The
 *     database enforces that too (0007's trigger), because this rule is the one
 *     a future refactor is most likely to break by accident.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Provider and in-process document cache
// ---------------------------------------------------------------------------

let gitProvider: GitCompanyContextProvider | null = null;

export function currentProvider(): CompanyContextProvider {
  const override = getCompanyContextProviderOverride();
  if (override) return override;
  gitProvider ??= new GitCompanyContextProvider({
    repositoryUrl: config.companyContext.repositoryUrl,
    ref: config.companyContext.ref,
    cacheDir: config.companyContext.cacheDir,
    token: config.companyContext.token,
    timeoutMs: config.companyContext.timeoutMs,
  });
  return gitProvider;
}

/**
 * Document text for the active revision, held in memory.
 *
 * Keyed by revision id so a refresh replaces it wholesale rather than mixing two
 * revisions' documents — a mixed cache would produce a selection that no single
 * commit ever contained, which is the kind of bug that is invisible until an
 * audit.
 */
const documentCache = new Map<string, Map<string, string>>();

/** When the remote was last CONTACTED, successfully or not. Rate-limits fetches. */
let lastRemoteCheckMs = 0;

/** Test seam: clears in-process state so one test cannot leak into the next. */
export function resetCompanyContextCache(): void {
  documentCache.clear();
  lastRemoteCheckMs = 0;
  gitProvider = null;
}

// ---------------------------------------------------------------------------
// Status row
// ---------------------------------------------------------------------------

async function statusRow(handle: DbHandle = db): Promise<CompanyContextStatusRow> {
  const [row] = await handle.select().from(companyContextStatus).where(eq(companyContextStatus.id, 1)).limit(1);
  if (!row) {
    throw new AppError(
      500,
      'COMPANY_CONTEXT_STATUS_MISSING',
      'The company context status row is missing. Has the database been migrated?',
    );
  }
  return row;
}

async function writeStatus(
  handle: DbHandle,
  patch: Partial<{
    activeRevisionId: string | null;
    status: CompanyContextStatusKind;
    lastCheckAt: Date;
    lastSuccessfulRefreshAt: Date;
    lastError: string | null;
    consecutiveFailures: number;
  }>,
): Promise<void> {
  await handle
    .update(companyContextStatus)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(companyContextStatus.id, 1));
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

export interface RefreshResult {
  status: CompanyContextStatusKind;
  revision: CompanyContextRevisionRow | null;
  changed: boolean;
  error: string | null;
}

/**
 * Fetch, validate, load, record.
 *
 * `reason` is carried into the audit trail so a refresh at 02:00 can be told
 * apart from one an operator triggered from the UI.
 */
export async function refreshCompanyContext(
  input: { reason: string; force?: boolean; actor?: Actor } = { reason: 'manual' },
): Promise<RefreshResult> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const settings = await getSettings();

  if (!settings.companyContextEnabled) {
    await db.transaction(async (tx) => writeStatus(tx, { status: 'disabled' }));
    return { status: 'disabled', revision: null, changed: false, error: null };
  }

  const provider = currentProvider();
  const description = provider.describe();

  assertCacheOutsideWorkspaces(description.cacheDir);

  const previous = await statusRow();

  await db.transaction(async (tx) => {
    await record(tx, {
      actor,
      eventType: 'company_context.refresh_started',
      metadata: { reason: input.reason, repositoryUrl: description.repositoryUrl, ref: description.ref },
    });
  });

  lastRemoteCheckMs = Date.now();
  const outcome = await provider.refresh();

  if (!outcome.ok) {
    return handleRefreshFailure({ actor, previous, error: outcome.error, settings, description });
  }

  const head = await provider.headRevision();
  if (!head) {
    return handleRefreshFailure({
      actor,
      previous,
      error: `No ref "${description.ref}" in the company context repository.`,
      settings,
      description,
    });
  }

  /*
   * An unchanged remote costs one fetch and no re-validation.
   *
   * Re-reading and re-hashing seven documents to reach the same conclusion is
   * pure waste on a night shift that creates a run every few minutes, and the
   * SHA is a complete answer to "has anything changed".
   */
  const active = previous.activeRevisionId ? await revisionById(previous.activeRevisionId) : null;
  if (
    active &&
    active.commitSha === head.commitSha &&
    active.validationState === 'valid' &&
    documentCache.has(active.id)
  ) {
    await db.transaction(async (tx) => {
      await writeStatus(tx, {
        status: 'fresh',
        lastCheckAt: new Date(),
        lastSuccessfulRefreshAt: new Date(),
        lastError: null,
        consecutiveFailures: 0,
      });
      await record(tx, {
        actor,
        eventType: 'company_context.refresh_succeeded',
        metadata: { reason: input.reason, commitSha: head.commitSha, changed: false },
      });
    });
    return { status: 'fresh', revision: active, changed: false, error: null };
  }

  const loaded = await loadRevision(provider, {
    commitSha: head.commitSha,
    committedAt: head.committedAt,
    source: 'remote',
  });

  if (!loaded.ok) {
    await db.transaction(async (tx) => {
      await record(tx, {
        actor,
        eventType: 'company_context.validation_failed',
        metadata: {
          commitSha: head.commitSha,
          code: loaded.code,
          // Error strings, not document content.
          errors: loaded.errors.slice(0, 20),
        },
      });
      /*
       * The previously validated revision stays active.
       *
       * A bad commit landing on `main` must not disarm Mac's company context
       * entirely — the last KNOWN-GOOD policy is a better basis than none, and
       * the status says plainly that the current commit is invalid.
       */
      await writeStatus(tx, {
        status: active && active.validationState === 'valid' ? 'invalid' : 'unavailable',
        lastCheckAt: new Date(),
        lastError: `Commit ${shortSha(head.commitSha)} failed validation: ${loaded.errors[0] ?? loaded.code}`,
        consecutiveFailures: previous.consecutiveFailures + 1,
      });
    });

    const status: CompanyContextStatusKind =
      active && active.validationState === 'valid' ? 'invalid' : 'unavailable';
    return { status, revision: active, changed: false, error: loaded.errors[0] ?? loaded.code };
  }

  documentCache.clear();
  documentCache.set(loaded.revision.row.id, loaded.revision.documents);

  await db.transaction(async (tx) => {
    await writeStatus(tx, {
      activeRevisionId: loaded.revision.row.id,
      status: 'fresh',
      lastCheckAt: new Date(),
      lastSuccessfulRefreshAt: new Date(),
      lastError: null,
      consecutiveFailures: 0,
    });
    await record(tx, {
      actor,
      eventType: 'company_context.refresh_succeeded',
      metadata: {
        reason: input.reason,
        commitSha: loaded.revision.row.commitSha,
        changed: outcome.changed,
      },
    });
    await record(tx, {
      actor,
      eventType: 'company_context.loaded',
      metadata: {
        commitSha: loaded.revision.row.commitSha,
        contextVersion: loaded.revision.row.contextVersion,
        // Names and counts. Never content (Sprint 3.2 §20).
        documents: (loaded.revision.row.documents as CompanyDocumentRecord[]).map((d) => d.path),
        documentCount: loaded.revision.documents.size,
        source: 'remote',
      },
    });
  });

  return { status: 'fresh', revision: loaded.revision.row, changed: outcome.changed, error: null };
}

async function handleRefreshFailure(input: {
  actor: Actor;
  previous: CompanyContextStatusRow;
  error: string;
  settings: Awaited<ReturnType<typeof getSettings>>;
  description: { repositoryUrl: string; ref: string };
}): Promise<RefreshResult> {
  const active = input.previous.activeRevisionId ? await revisionById(input.previous.activeRevisionId) : null;
  const usableCache = active?.validationState === 'valid' && input.settings.companyContextAllowCached;

  let status: CompanyContextStatusKind = 'unavailable';
  if (usableCache && active) status = isStale(active, input.settings.companyContextMaxStaleHours) ? 'stale' : 'cached';

  await db.transaction(async (tx) => {
    await record(tx, {
      actor: input.actor,
      eventType: 'company_context.refresh_failed',
      metadata: {
        repositoryUrl: input.description.repositoryUrl,
        ref: input.description.ref,
        // Already redacted by the provider. Never carries a credential.
        error: input.error,
        usingCache: usableCache,
      },
    });

    if (usableCache && active) {
      /*
       * Audited once per REFRESH ATTEMPT, not once per read.
       *
       * A night shift reading company context forty times while GitHub is down
       * should produce one honest "Mac is running on cached policy" event, not
       * forty rows that bury everything else in the trail.
       */
      await record(tx, {
        actor: input.actor,
        eventType: 'company_context.cached_used',
        metadata: {
          commitSha: active.commitSha,
          contextVersion: active.contextVersion,
          stale: status === 'stale',
          lastSuccessfulRefreshAt: input.previous.lastSuccessfulRefreshAt?.toISOString() ?? null,
        },
      });
    }

    await writeStatus(tx, {
      status,
      lastCheckAt: new Date(),
      lastError: input.error,
      consecutiveFailures: input.previous.consecutiveFailures + 1,
      ...(usableCache ? {} : { activeRevisionId: null }),
    });
  });

  if (!usableCache) documentCache.clear();

  return { status, revision: usableCache ? active : null, changed: false, error: input.error };
}

const isStale = (revision: CompanyContextRevisionRow, maxStaleHours: number): boolean => {
  if (maxStaleHours <= 0) return false;
  return Date.now() - revision.loadedAt.getTime() > maxStaleHours * 3_600_000;
};

/**
 * Refuses a cache directory inside a coding workspace (Sprint 3.2 §5).
 *
 * The sandbox already prevents an agent reaching unmounted paths, so this is
 * defence in depth — but it is the cheap kind: a misconfiguration that put PAC
 * policy inside a directory worktrees are created in would be very easy to make
 * and very hard to notice.
 */
export function assertCacheOutsideWorkspaces(cacheDir: string): void {
  const resolved = path.resolve(cacheDir);
  const forbidden = [
    path.resolve(config.repoRoot, 'workspace'),
    path.resolve(process.env.MAC_WORKER_WORKSPACE ?? path.join(config.repoRoot, 'workspace')),
  ];

  for (const dir of forbidden) {
    const relative = path.relative(dir, resolved);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      throw new AppError(
        500,
        'COMPANY_CONTEXT_CACHE_UNSAFE',
        `The company context cache (${resolved}) is inside a coding workspace (${dir}). ` +
          'PAC company policy must live outside every directory a coding agent works in.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Freshness before new work
// ---------------------------------------------------------------------------

/**
 * Called before a new discovery session or a new run (Sprint 3.2 §9.2).
 *
 * Deliberately NOT called from the supervision path: a run must not pick up a
 * newer revision partway through answering a question.
 */
export async function ensureCurrentRevision(input: {
  reason: string;
  actor?: Actor;
}): Promise<CompanyContextRevisionRow | null> {
  const settings = await getSettings();
  if (!settings.companyContextEnabled) return null;

  const status = await statusRow();
  const active = status.activeRevisionId ? await revisionById(status.activeRevisionId) : null;

  const withinQuietWindow =
    Date.now() - lastRemoteCheckMs < settings.companyContextMinRefreshSeconds * 1000;

  if (
    active &&
    active.validationState === 'valid' &&
    documentCache.has(active.id) &&
    withinQuietWindow &&
    USABLE_COMPANY_CONTEXT_STATUSES.includes(status.status as CompanyContextStatusKind)
  ) {
    return active;
  }

  const result = await refreshCompanyContext({
    reason: input.reason,
    ...(input.actor ? { actor: input.actor } : {}),
  });
  return result.revision;
}

/**
 * The revision Mac must be grounded on, or a clear refusal.
 *
 * Returns null ONLY when the feature is switched off, which is the "company
 * context is not part of this deployment" case. Every other absence is an error,
 * because a run that silently proceeded without PAC policy while the operator
 * believed it had PAC policy is the exact failure Sprint 3.2 §10 forbids.
 */
export async function requireActiveRevision(reason: string): Promise<CompanyContextRevisionRow | null> {
  const settings = await getSettings();
  if (!settings.companyContextEnabled) return null;

  const revision = await ensureCurrentRevision({ reason });
  if (revision && revision.validationState === 'valid') return revision;

  const status = await statusRow();
  throw new AppError(
    409,
    'COMPANY_CONTEXT_UNAVAILABLE',
    'PAC company context is required but not available, so Mac will not start this work. ' +
      `Status: ${status.status}.${status.lastError ? ` Last error: ${status.lastError}` : ''}`,
  );
}

/**
 * Whether company context is a BLOCKER for starting work right now.
 *
 * Three-way, and the middle case is the one that matters:
 *
 *   * disabled for this deployment  -> not a blocker. Sprint 3.2 is optional,
 *     and a deployment that never adopted it must not find every research task
 *     refused for want of a document set it does not have.
 *   * enabled and usable            -> not a blocker.
 *   * enabled and NOT usable        -> a blocker. This is the Sprint 3.2 rule:
 *     if PAC policy is supposed to govern the work and cannot be read, Mac does
 *     not work ungrounded.
 *
 * Reads the cached status row rather than refreshing, because this is called on
 * page loads and on every scheduling tick. `requireActiveRevision` remains the
 * authority at the moment work actually starts.
 */
export async function companyContextSatisfied(): Promise<boolean> {
  const settings = await getSettings();
  if (!settings.companyContextEnabled) return true;
  const row = await statusRow();
  return (USABLE_COMPANY_CONTEXT_STATUSES as readonly string[]).includes(row.status);
}

/** The compact reference embedded in DTOs. */
export const toContextRef = (row: CompanyContextRevisionRow): CompanyContextRef => ({
  revisionId: row.id,
  commitSha: row.commitSha,
  shortSha: shortSha(row.commitSha),
  contextVersion: row.contextVersion,
  ref: row.ref,
});

export async function contextRefFor(
  revisionId: string | null,
  handle: DbHandle = db,
): Promise<CompanyContextRef | null> {
  if (!revisionId) return null;
  const row = await revisionById(revisionId, handle);
  return row ? toContextRef(row) : null;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * Document text for a revision, loading it from the provider on a cache miss.
 *
 * A cache miss is normal after a restart, and it is also how a HISTORICAL
 * revision is read — which is what makes "show me the AUTHORITY.md this run was
 * bound to" answerable rather than merely recorded (Sprint 3.2 §3.2).
 */
export async function documentsForRevision(
  revision: CompanyContextRevisionRow,
): Promise<Map<string, string>> {
  const cached = documentCache.get(revision.id);
  if (cached) return cached;

  const provider = currentProvider();
  const documents = new Map<string, string>();

  for (const doc of (revision.documents as CompanyDocumentRecord[]) ?? []) {
    try {
      documents.set(doc.path, await provider.readFile(revision.commitSha, doc.path));
    } catch {
      // A document the mirror can no longer produce is omitted rather than
      // faked. Selection asserts AUTHORITY.md is present, so a genuinely
      // damaged cache surfaces there as a refusal rather than as thin context.
    }
  }

  documentCache.set(revision.id, documents);
  return documents;
}

export async function readCompanyDocument(
  revision: CompanyContextRevisionRow,
  documentPath: string,
): Promise<string> {
  const documents = await documentsForRevision(revision);
  const text = documents.get(documentPath);
  if (text === undefined) {
    throw AppError.notFound(`Company document "${documentPath}" at ${shortSha(revision.commitSha)}`);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Status DTO
// ---------------------------------------------------------------------------

export async function getCompanyContextStatus(): Promise<CompanyContextStatusDto> {
  const settings = await getSettings();
  const row = await statusRow();
  const active = row.activeRevisionId ? await revisionById(row.activeRevisionId) : null;
  const provider = currentProvider();
  const description = provider.describe();

  const status = (settings.companyContextEnabled ? row.status : 'disabled') as CompanyContextStatusKind;
  const documents = ((active?.documents as CompanyDocumentRecord[]) ?? []).map((d) => ({
    path: d.path,
    loaded: true,
    bytes: d.bytes,
  }));

  // Anything the manifest declares mandatory but the revision did not load.
  const manifest = active?.manifest as { documents?: { mandatory?: string[] } } | undefined;
  for (const declared of manifest?.documents?.mandatory ?? []) {
    if (!documents.some((d) => d.path === declared)) {
      documents.push({ path: declared, loaded: false, bytes: null as unknown as number });
    }
  }

  return {
    enabled: settings.companyContextEnabled,
    status,
    repositoryUrl: sanitiseRepositoryUrl(description.repositoryUrl),
    ref: description.ref,
    providerKind: provider.kind,
    cached: status === 'cached' || status === 'stale',
    stale: status === 'stale',
    allowCached: settings.companyContextAllowCached,
    lastCheckAt: row.lastCheckAt?.toISOString() ?? null,
    lastSuccessfulRefreshAt: row.lastSuccessfulRefreshAt?.toISOString() ?? null,
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
    revision: active ? revisionDto(active) : null,
    mandatoryDocuments: documents.map((d) => ({
      path: d.path,
      loaded: d.loaded,
      bytes: d.loaded ? d.bytes : null,
    })),
  };
}
