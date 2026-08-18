import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { closePool, resetDatabase, startTestApp } from '../helpers/harness.js';
import { createCompanyRepo, manifestWith, type CompanyRepoFixture } from '../helpers/company-repo.js';
import { db } from '../../src/db/client.js';
import { companyContextRevisions, settings } from '../../src/db/schema.js';
import { GitCompanyContextProvider, redactGitError, sanitiseRepositoryUrl, buildRemoteUrl } from '../../src/services/company-context/git-provider.js';
import { setCompanyContextProvider } from '../../src/services/company-context/provider.js';
import {
  getCompanyContextStatus,
  refreshCompanyContext,
  requireActiveRevision,
  resetCompanyContextCache,
  readCompanyDocument,
} from '../../src/services/company-context/service.js';
import { queryAuditEvents } from '../../src/services/audit-query.js';

/**
 * The Git company-context provider, against real local repositories
 * (Sprint 3.2 §22).
 *
 * These use actual `git`, not a mock, because almost everything worth asserting
 * here IS git: that a mirror clone works, that `remote update` sees a new
 * commit, that an unreachable remote fails the way an unreachable remote really
 * fails, and — the one that matters most — that a document is still readable at
 * an OLD sha after the branch has moved on. A fake would pass all of these
 * while proving none of them.
 */

let app: FastifyInstance;
let close: () => Promise<void>;
let repo: CompanyRepoFixture;

const useRepo = (fixture: CompanyRepoFixture, token?: string) => {
  setCompanyContextProvider(
    new GitCompanyContextProvider({
      repositoryUrl: fixture.url,
      ref: 'main',
      cacheDir: fixture.cacheDir,
      ...(token ? { token } : {}),
      timeoutMs: 30_000,
    }),
  );
};

const enableCompanyContext = async (patch: Record<string, unknown> = {}) => {
  await db
    .update(settings)
    .set({ companyContextEnabled: true, companyContextMinRefreshSeconds: 0, ...patch })
    .where(eq(settings.id, 1));
};

beforeAll(async () => {
  ({ fastify: app, close } = await startTestApp());
});

afterAll(async () => {
  setCompanyContextProvider(null);
  await close();
  await closePool();
});

beforeEach(async () => {
  await resetDatabase();
  repo = createCompanyRepo();
  useRepo(repo);
});

afterEach(() => {
  setCompanyContextProvider(null);
  resetCompanyContextCache();
  repo.cleanup();
});

// ---------------------------------------------------------------------------
// First load
// ---------------------------------------------------------------------------

describe('the first load', () => {
  it('clones, validates and records the revision', async () => {
    await enableCompanyContext();

    const result = await refreshCompanyContext({ reason: 'test' });

    expect(result.status).toBe('fresh');
    expect(result.revision).not.toBeNull();
    expect(result.revision!.commitSha).toBe(repo.head());
    expect(result.revision!.contextVersion).toBe('0.1.0');
    expect(result.revision!.schemaVersion).toBe(1);
    expect(result.revision!.validationState).toBe('valid');
  });

  it('records every mandatory document with its size and hash, and no content', async () => {
    await enableCompanyContext();
    await refreshCompanyContext({ reason: 'test' });

    const [row] = await db.select().from(companyContextRevisions).limit(1);
    const documents = row!.documents as Array<{ path: string; bytes: number; sha256: string }>;

    expect(documents.map((d) => d.path).sort()).toEqual(
      ['AGENTS.md', 'AUTHORITY.md', 'COMPANY.md', 'GLOSSARY.md', 'OPERATING_MODEL.md', 'SYSTEMS.md', 'VALUES.md'],
    );
    for (const doc of documents) {
      expect(doc.bytes).toBeGreaterThan(0);
      expect(doc.sha256).toHaveLength(64);
    }

    // Policy text lives in the repository the humans govern. A second copy in
    // Postgres would be an un-governed one.
    expect(JSON.stringify(row)).not.toContain('Agents prepare. Humans release.');
  });

  it('does not require README.md, which the manifest does not declare', async () => {
    await enableCompanyContext();
    await refreshCompanyContext({ reason: 'test' });

    const status = await getCompanyContextStatus();
    expect(status.mandatoryDocuments.map((d) => d.path)).not.toContain('README.md');
    expect(status.mandatoryDocuments.every((d) => d.loaded)).toBe(true);
  });

  it('audits the refresh and the load without writing document text', async () => {
    await enableCompanyContext();
    await refreshCompanyContext({ reason: 'test' });

    const events = await queryAuditEvents({ limit: 100, offset: 0 });
    const types = events.map((e) => e.eventType);
    expect(types).toContain('company_context.refresh_started');
    expect(types).toContain('company_context.refresh_succeeded');
    expect(types).toContain('company_context.loaded');

    const loaded = events.find((e) => e.eventType === 'company_context.loaded')!;
    expect((loaded.metadata as { documents: string[] }).documents).toContain('AUTHORITY.md');
    expect(JSON.stringify(loaded.metadata)).not.toContain('Agents prepare');
  });
});

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

describe('refresh', () => {
  it('creates no second revision when the remote has not moved', async () => {
    await enableCompanyContext();
    await refreshCompanyContext({ reason: 'first' });
    const second = await refreshCompanyContext({ reason: 'second' });

    expect(second.changed).toBe(false);
    expect(second.status).toBe('fresh');

    const revisionRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(companyContextRevisions);
    expect(revisionRows[0]!.count).toBe(1);
  });

  it('detects and loads a new remote commit', async () => {
    await enableCompanyContext();
    const first = await refreshCompanyContext({ reason: 'first' });

    const newSha = repo.commit(
      { 'AUTHORITY.md': '# Authority\n\n## Financial Authority\n\nRevised policy text.\n' },
      'Revise authority',
    );

    const second = await refreshCompanyContext({ reason: 'second' });

    expect(second.changed).toBe(true);
    expect(second.revision!.commitSha).toBe(newSha);
    expect(second.revision!.commitSha).not.toBe(first.revision!.commitSha);

    const revisionRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(companyContextRevisions);
    expect(revisionRows[0]!.count).toBe(2);
  });

  it('creates no revision when the commit changed nothing Mac reads', async () => {
    // A README-only commit moves the sha but not the policy. Both revisions
    // exist, and their document-set hashes are identical, so the UI can say
    // "nothing Mac reads actually changed" rather than alarming an operator.
    await enableCompanyContext();
    const first = await refreshCompanyContext({ reason: 'first' });
    repo.commit({ 'README.md': '# PAC Agent Context\n\nEdited.\n' }, 'README only');
    const second = await refreshCompanyContext({ reason: 'second' });

    expect(second.revision!.commitSha).not.toBe(first.revision!.commitSha);
    expect(second.revision!.documentSetSha256).toBe(first.revision!.documentSetSha256);
  });
});

// ---------------------------------------------------------------------------
// Historical attribution
// ---------------------------------------------------------------------------

describe('reading a historical revision', () => {
  it('still returns the OLD document after the branch has moved on', async () => {
    // This is the property that makes attribution real rather than nominal: a
    // run bound to a sha can have the exact policy it worked under produced,
    // not merely its identifier recorded.
    await enableCompanyContext();
    const first = await refreshCompanyContext({ reason: 'first' });
    const oldRevision = first.revision!;

    repo.commit(
      { 'AUTHORITY.md': '# Authority\n\n## Financial Authority\n\nCompletely rewritten.\n' },
      'Rewrite authority',
    );
    await refreshCompanyContext({ reason: 'second' });

    const historical = await readCompanyDocument(oldRevision, 'AUTHORITY.md');
    expect(historical).toContain('Agents prepare. Humans release.');
    expect(historical).not.toContain('Completely rewritten');
  });
});

// ---------------------------------------------------------------------------
// Failure and cache
// ---------------------------------------------------------------------------

describe('when the remote cannot be reached', () => {
  it('falls back to the cached revision, keeps its exact sha, and says it is cached', async () => {
    await enableCompanyContext();
    const first = await refreshCompanyContext({ reason: 'first' });
    const sha = first.revision!.commitSha;

    // The remote genuinely disappears.
    repo.cleanup();

    const second = await refreshCompanyContext({ reason: 'offline' });

    expect(second.status).toBe('cached');
    expect(second.revision!.commitSha).toBe(sha);

    const status = await getCompanyContextStatus();
    expect(status.cached).toBe(true);
    expect(status.lastSuccessfulRefreshAt).not.toBeNull();
    expect(status.lastError).not.toBeNull();
  });

  it('audits the cached use once per refresh attempt, not once per read', async () => {
    // A real quiet window, unlike the rest of this file: the claim is precisely
    // that reads INSIDE the window reuse the active revision instead of
    // re-fetching, so a night shift reading company context forty times while
    // GitHub is down produces one honest event rather than forty.
    await enableCompanyContext({ companyContextMinRefreshSeconds: 300 });
    await refreshCompanyContext({ reason: 'first' });
    repo.cleanup();

    // `audit_events` is append-only by design and survives resetDatabase, so
    // the assertion is on the DELTA this refresh produced rather than on the
    // table's total.
    const before = (await queryAuditEvents({ limit: 500, offset: 0 })).filter(
      (e) => e.eventType === 'company_context.cached_used',
    ).length;

    await refreshCompanyContext({ reason: 'offline' });

    // Several reads follow one failed refresh; only the refresh is audited.
    await requireActiveRevision('test');
    await getCompanyContextStatus();

    const after = (await queryAuditEvents({ limit: 500, offset: 0 })).filter(
      (e) => e.eventType === 'company_context.cached_used',
    ).length;

    expect(after - before).toBe(1);
    expect((await queryAuditEvents({ limit: 100, offset: 0 })).map((e) => e.eventType)).toContain(
      'company_context.refresh_failed',
    );
  });

  it('still grounds work on the cached revision', async () => {
    await enableCompanyContext();
    const first = await refreshCompanyContext({ reason: 'first' });
    repo.cleanup();
    await refreshCompanyContext({ reason: 'offline' });

    const revision = await requireActiveRevision('test');
    expect(revision!.commitSha).toBe(first.revision!.commitSha);
  });

  it('REFUSES to use the cache when the operator has not permitted it', async () => {
    await enableCompanyContext({ companyContextAllowCached: false });
    await refreshCompanyContext({ reason: 'first' });
    repo.cleanup();

    const second = await refreshCompanyContext({ reason: 'offline' });
    expect(second.status).toBe('unavailable');
    expect(second.revision).toBeNull();

    await expect(requireActiveRevision('test')).rejects.toThrow(/COMPANY_CONTEXT_UNAVAILABLE|not available/);
  });

  it('marks a long-cached revision as stale rather than merely cached', async () => {
    await enableCompanyContext({ companyContextMaxStaleHours: 1 });
    await refreshCompanyContext({ reason: 'first' });

    // Age the revision past the staleness horizon.
    await db
      .update(companyContextRevisions)
      .set({ loadedAt: new Date(Date.now() - 5 * 3_600_000) });
    resetCompanyContextCache();
    useRepo(repo);
    repo.cleanup();

    const result = await refreshCompanyContext({ reason: 'offline' });
    expect(result.status).toBe('stale');
    expect((await getCompanyContextStatus()).stale).toBe(true);
  });

  it('fails when there is no cache at all', async () => {
    await enableCompanyContext();
    repo.cleanup();

    const result = await refreshCompanyContext({ reason: 'first' });
    expect(result.status).toBe('unavailable');
    expect(result.revision).toBeNull();

    await expect(requireActiveRevision('test')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Validation failures
// ---------------------------------------------------------------------------

describe('a commit that does not validate', () => {
  it('is recorded as invalid, with its errors, and is never made active', async () => {
    await enableCompanyContext();
    await refreshCompanyContext({ reason: 'first' });
    const good = repo.head();

    repo.commit({ 'AUTHORITY.md': null }, 'Delete authority');
    const result = await refreshCompanyContext({ reason: 'second' });

    // The last KNOWN-GOOD revision stays active; a bad commit landing on main
    // must not disarm Mac's company context entirely.
    expect(result.status).toBe('invalid');
    expect(result.revision!.commitSha).toBe(good);

    const rows = await db.select().from(companyContextRevisions);
    const bad = rows.find((r) => r.commitSha !== good)!;
    expect(bad.validationState).toBe('invalid');
    expect((bad.validationErrors as string[]).join(' ')).toContain('AUTHORITY.md');
  });

  it('rejects a present-but-empty mandatory document', async () => {
    await enableCompanyContext();
    repo.commit({ 'AUTHORITY.md': '   \n\n' }, 'Empty authority');

    const result = await refreshCompanyContext({ reason: 'test' });
    expect(result.status).toBe('unavailable');

    const [row] = await db.select().from(companyContextRevisions);
    expect(row!.validationState).toBe('invalid');
    expect((row!.validationErrors as string[]).join(' ')).toContain('empty');
  });

  it('rejects an unsupported manifest schema version rather than guessing', async () => {
    await enableCompanyContext();
    repo.commit(
      { 'context.yaml': manifestWith([['schema_version: 1', 'schema_version: 99']]) },
      'Future manifest',
    );

    const result = await refreshCompanyContext({ reason: 'test' });
    expect(result.status).toBe('unavailable');

    const [row] = await db.select().from(companyContextRevisions);
    expect((row!.validationErrors as string[]).join(' ')).toContain('schema_version 99');
  });

  it('rejects a malformed manifest', async () => {
    await enableCompanyContext();
    repo.commit({ 'context.yaml': 'schema_version: 1\n  bad:\n   - [unclosed\n' }, 'Broken manifest');

    const result = await refreshCompanyContext({ reason: 'test' });
    expect(result.status).toBe('unavailable');
    expect((await getCompanyContextStatus()).lastError).not.toBeNull();
  });

  it('audits a validation failure so an operator can see why Mac refused', async () => {
    await enableCompanyContext();
    repo.commit({ 'AUTHORITY.md': null }, 'Delete authority');
    await refreshCompanyContext({ reason: 'test' });

    const events = await queryAuditEvents({ limit: 100, offset: 0 });
    expect(events.map((e) => e.eventType)).toContain('company_context.validation_failed');
  });
});

// ---------------------------------------------------------------------------
// Disabled
// ---------------------------------------------------------------------------

describe('when company context is not part of this deployment', () => {
  it('reports disabled and binds nothing, without failing anything', async () => {
    const result = await refreshCompanyContext({ reason: 'test' });

    expect(result.status).toBe('disabled');
    expect(await requireActiveRevision('test')).toBeNull();
    expect((await getCompanyContextStatus()).enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Credential hygiene
// ---------------------------------------------------------------------------

describe('credentials', () => {
  const TOKEN = 'ghp_sentinelcompanytoken0123456789abcd';

  it('clones successfully on the FIRST attempt when a token is configured', async () => {
    /*
     * Regression: the askpass helper is written into the cache directory, and
     * the mirror used to be cloned into that same directory — so git found a
     * non-empty destination and refused. Every authenticated first-time clone
     * failed, which is to say every correctly configured PAC deployment, while
     * the token-less tests above passed happily.
     *
     * A local remote needs no credential, but configuring a token is what causes
     * the helper to be written, which is the whole point.
     */
    await enableCompanyContext();
    useRepo(repo, TOKEN);

    const result = await refreshCompanyContext({ reason: 'first-with-token' });

    expect(result.status).toBe('fresh');
    expect(result.revision!.commitSha).toBe(repo.head());

    // And a second refresh over the same cache still works.
    const second = await refreshCompanyContext({ reason: 'second-with-token' });
    expect(second.status).toBe('fresh');
  });

  it('never appears in the persisted repository URL', async () => {
    await enableCompanyContext();
    setCompanyContextProvider(
      new GitCompanyContextProvider({
        repositoryUrl: `https://x-access-token:${TOKEN}@example.invalid/PacTechnologiesAus/Company.git`,
        ref: 'main',
        cacheDir: repo.cacheDir,
        token: TOKEN,
        timeoutMs: 5_000,
      }),
    );

    await refreshCompanyContext({ reason: 'test' });

    const status = await getCompanyContextStatus();
    expect(status.repositoryUrl).not.toContain(TOKEN);
    expect(status.lastError ?? '').not.toContain(TOKEN);

    const events = await queryAuditEvents({ limit: 100, offset: 0 });
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });

  it('strips userinfo when sanitising a URL', () => {
    expect(sanitiseRepositoryUrl(`https://user:${TOKEN}@github.com/a/b.git`)).toBe('https://github.com/a/b.git');
  });

  it('puts a username, never the token, into the URL git is handed', () => {
    const url = buildRemoteUrl('https://github.com/PacTechnologiesAus/Company.git', true);
    expect(url).toContain('x-access-token@');
    expect(url).not.toContain(TOKEN);
  });

  it('redacts token shapes and userinfo out of git error text', () => {
    expect(redactGitError(`fatal: could not read Password for 'https://x:${TOKEN}@github.com'`, TOKEN)).not.toContain(TOKEN);
    expect(redactGitError('remote: Invalid username or password for https://bob:hunter2@github.com')).not.toContain('hunter2');
    expect(redactGitError('Authorization: Bearer abcdef0123456789')).not.toContain('abcdef0123456789');
  });
});
