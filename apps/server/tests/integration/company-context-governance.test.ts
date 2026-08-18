import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { spawnSync } from 'node:child_process';
import { eq, sql } from 'drizzle-orm';
import { asUser, closePool, createAndLogin, resetDatabase, startTestApp, type Session } from '../helpers/harness.js';
import { makeProject, makeTask } from '../helpers/fixtures.js';
import { createCompanyRepo, type CompanyRepoFixture } from '../helpers/company-repo.js';
import { db } from '../../src/db/client.js';
import { companyContextProposals, companyContextRevisions, settings } from '../../src/db/schema.js';
import { GitCompanyContextProvider } from '../../src/services/company-context/git-provider.js';
import { setCompanyContextProvider } from '../../src/services/company-context/provider.js';
import {
  refreshCompanyContext,
  resetCompanyContextCache,
  documentsForRevision,
} from '../../src/services/company-context/service.js';
import { createProposal, updateProposalStatus } from '../../src/services/company-context/proposals.js';
import { createMemory, promoteToProjectMemory } from '../../src/services/memory.js';
import { describeActor, isPacAgent } from '../../src/domain/agent-registry.js';
import { queryAuditEvents } from '../../src/services/audit-query.js';
import { SYSTEM_ACTOR } from '../../src/services/audit.js';

/**
 * The governance boundary (Sprint 3.2 §16, §17, §22).
 *
 * The claim: **Mac may propose. Only a human may approve. Mac can never write.**
 *
 * These tests attack that from three directions — the provider surface, the
 * repository on disk, and the proposal status machine — because "an AI approved
 * its own change to the company's authority document" is not a failure anybody
 * should discover from an audit six months later.
 */

let app: FastifyInstance;
let close: () => Promise<void>;
let repo: CompanyRepoFixture;
let admin: Session;

const useRepo = (fixture: CompanyRepoFixture) => {
  setCompanyContextProvider(
    new GitCompanyContextProvider({
      repositoryUrl: fixture.url,
      ref: 'main',
      cacheDir: fixture.cacheDir,
      timeoutMs: 30_000,
    }),
  );
};

/** Every ref in the authoritative repository, as a comparable snapshot. */
const refsOf = (dir: string): string => {
  const result = spawnSync('git', ['show-ref'], { cwd: dir, encoding: 'utf8' });
  return (result.stdout ?? '').trim();
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
  await db
    .update(settings)
    .set({ companyContextEnabled: true, companyContextMinRefreshSeconds: 0 })
    .where(eq(settings.id, 1));
  await refreshCompanyContext({ reason: 'test-setup' });
  admin = await createAndLogin(app, { email: 'admin@pac.test', name: 'Admin', role: 'admin' });
});

afterEach(() => {
  setCompanyContextProvider(null);
  resetCompanyContextCache();
  repo.cleanup();
});

// ---------------------------------------------------------------------------
// Mac cannot write
// ---------------------------------------------------------------------------

describe('Mac cannot write authoritative company context', () => {
  it('the provider exposes no verb that could', () => {
    const provider = new GitCompanyContextProvider({
      repositoryUrl: repo.url,
      ref: 'main',
      cacheDir: repo.cacheDir,
    });

    // Not "the write method is guarded". There is no write method.
    for (const verb of ['write', 'writeFile', 'commit', 'push', 'checkout', 'apply', 'update', 'delete']) {
      expect((provider as unknown as Record<string, unknown>)[verb]).toBeUndefined();
    }

    const surface = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(provider)),
      ...Object.getOwnPropertyNames(provider),
    ];
    expect(surface.sort()).toEqual(
      ['constructor', 'describe', 'headRevision', 'kind', 'listFiles', 'readFile', 'refresh'].sort(),
    );
  });

  it('leaves the authoritative repository byte-identical after a full cycle of work', async () => {
    const before = refsOf(repo.dir);
    const beforeAuthority = await documentsForRevision((await refreshCompanyContext({ reason: 'x' })).revision!);

    // A realistic slice of Mac's work: discovery, a brief, a run, a proposal.
    const project = await makeProject(app, admin);
    const start = await asUser(app, admin).post('/api/discovery', {
      projectId: project.id,
      title: 'Record simulation evidence',
    });
    const session = start.json().session;
    await asUser(app, admin).post(`/api/discovery/${session.id}/messages`, {
      message: 'The harness should store evidence. Done when a file is written. Tests should cover it.',
    });
    await asUser(app, admin).post(`/api/discovery/${session.id}/brief`);

    await asUser(app, admin).post('/api/company-context/proposals', {
      targetDocument: 'SYSTEMS.md',
      targetSection: 'Forja',
      proposedChange: 'Note that Forja does not hold simulation evidence; the project record does.',
      reason: 'Two projects assumed otherwise during discovery.',
      evidence: [],
    });

    const after = refsOf(repo.dir);
    const afterAuthority = await documentsForRevision((await refreshCompanyContext({ reason: 'y' })).revision!);

    expect(after).toBe(before);
    expect(afterAuthority.get('AUTHORITY.md')).toBe(beforeAuthority.get('AUTHORITY.md'));
    expect(afterAuthority.get('SYSTEMS.md')).toBe(beforeAuthority.get('SYSTEMS.md'));
  });

  it('has no HTTP route that writes a company document', async () => {
    for (const [method, url] of [
      ['POST', '/api/company-context/documents'],
      ['PUT', '/api/company-context/revisions/AUTHORITY.md'],
      ['PATCH', '/api/company-context/documents/AUTHORITY.md'],
    ] as const) {
      const response = await app.inject({ method, url, headers: { cookie: admin.cookie } });
      expect(response.statusCode).toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

describe('proposing a change', () => {
  it('records the full proposal with its provenance', async () => {
    const project = await makeProject(app, admin);
    const task = await makeTask(app, admin, project.id);

    const response = await asUser(app, admin).post('/api/company-context/proposals', {
      targetDocument: 'SYSTEMS.md',
      targetSection: 'monday.com',
      proposedChange: 'State explicitly that monday item descriptions are authoritative task context.',
      reason: 'Mac repeatedly found decisive constraints in item updates that no other source carried.',
      evidence: [
        { kind: 'monday_item', ref: 'monday:item/8891', excerpt: 'The CSV header must stay as it is.' },
      ],
      potentialImpact: 'Agents would treat item updates as project context by default.',
      projectId: project.id,
      taskId: task.id,
    });

    expect(response.statusCode).toBe(201);
    const proposal = response.json().proposal;

    expect(proposal.status).toBe('proposed');
    expect(proposal.agent).toBe('mac');
    expect(proposal.targetDocument).toBe('SYSTEMS.md');
    expect(proposal.targetSection).toBe('monday.com');
    expect(proposal.reason.length).toBeGreaterThan(0);
    expect(proposal.evidence).toHaveLength(1);
    expect(proposal.projectId).toBe(project.id);
    expect(proposal.taskId).toBe(task.id);
    // Stamped with the revision it was written against, so a reviewer can see
    // what the document said when the change was suggested.
    expect(proposal.baseRevision.commitSha).toBe(repo.head());
  });

  it('audits the creation', async () => {
    await asUser(app, admin).post('/api/company-context/proposals', {
      targetDocument: 'VALUES.md',
      proposedChange: 'Add a note about evidence retention.',
      reason: 'Came up twice.',
    });

    const events = await queryAuditEvents({ limit: 100, offset: 0 });
    expect(events.map((e) => e.eventType)).toContain('company_context.proposal_created');
  });

  it('refuses a proposal that appears to contain a secret', async () => {
    // Company context is business policy everyone at PAC reads. A stray token
    // arriving via evidence must not be written into it.
    const response = await asUser(app, admin).post('/api/company-context/proposals', {
      targetDocument: 'SYSTEMS.md',
      proposedChange: 'Use the deploy token ghp_abcdefghijklmnopqrstuvwxyz0123456789 for the runner.',
      reason: 'Documenting the runner setup.',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('COMPANY_PROPOSAL_SECRET_SUSPECTED');

    const proposalRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(companyContextProposals);
    expect(proposalRows[0]!.count).toBe(0);
  });
});

describe('deciding a proposal', () => {
  const propose = async () =>
    (
      await asUser(app, admin).post('/api/company-context/proposals', {
        targetDocument: 'VALUES.md',
        proposedChange: 'Add a principle about recording simulation evidence.',
        reason: 'Two projects needed it.',
      })
    ).json().proposal;

  it('lets a human accept it, and records who', async () => {
    const proposal = await propose();

    const response = await asUser(app, admin).patch(`/api/company-context/proposals/${proposal.id}`, {
      status: 'accepted',
      reviewNotes: 'Agreed; I will make the change.',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().proposal.status).toBe('accepted');
    expect(response.json().proposal.reviewedBy).not.toBeNull();
    expect(response.json().proposal.reviewedAt).not.toBeNull();
  });

  it('does NOT turn acceptance into a repository change', async () => {
    // Accepting records that a human agreed. Making the change is that human's
    // act, outside this system.
    const before = refsOf(repo.dir);
    const proposal = await propose();
    await asUser(app, admin).patch(`/api/company-context/proposals/${proposal.id}`, { status: 'accepted' });

    expect(refsOf(repo.dir)).toBe(before);

    const events = await queryAuditEvents({ limit: 100, offset: 0 });
    const changed = events.find((e) => e.eventType === 'company_context.proposal_status_changed')!;
    expect((changed.metadata as { appliedToRepository: boolean }).appliedToRepository).toBe(false);
  });

  it('REFUSES a non-human actor accepting a proposal', async () => {
    const proposal = await createProposal(
      {
        targetDocument: 'VALUES.md',
        targetSection: null,
        proposedChange: 'Something Mac believes.',
        reason: 'Because.',
        evidence: [],
        potentialImpact: null,
        projectId: null,
        taskId: null,
        runId: null,
        discoverySessionId: null,
      },
      SYSTEM_ACTOR,
    );

    await expect(
      updateProposalStatus(proposal.id, { status: 'accepted' }, SYSTEM_ACTOR),
    ).rejects.toThrow(/COMPANY_PROPOSAL_HUMAN_REQUIRED|Only a person/);

    const [row] = await db
      .select()
      .from(companyContextProposals)
      .where(eq(companyContextProposals.id, proposal.id));
    expect(row!.status).toBe('proposed');
    expect(row!.reviewedBy).toBeNull();
  });

  it('REFUSES a non-human actor rejecting one either', async () => {
    const proposal = await createProposal(
      {
        targetDocument: 'VALUES.md',
        targetSection: null,
        proposedChange: 'Something.',
        reason: 'Because.',
        evidence: [],
        potentialImpact: null,
        projectId: null,
        taskId: null,
        runId: null,
        discoverySessionId: null,
      },
      SYSTEM_ACTOR,
    );

    await expect(
      updateProposalStatus(proposal.id, { status: 'rejected' }, SYSTEM_ACTOR),
    ).rejects.toThrow(/Only a person/);
  });

  it('audits the refusal, so an attempt outlives the rolled-back transaction', async () => {
    const proposal = await createProposal(
      {
        targetDocument: 'VALUES.md',
        targetSection: null,
        proposedChange: 'Something.',
        reason: 'Because.',
        evidence: [],
        potentialImpact: null,
        projectId: null,
        taskId: null,
        runId: null,
        discoverySessionId: null,
      },
      SYSTEM_ACTOR,
    );
    await updateProposalStatus(proposal.id, { status: 'accepted' }, SYSTEM_ACTOR).catch(() => undefined);

    const events = await queryAuditEvents({ limit: 100, offset: 0 });
    const refusal = events.find(
      (e) =>
        e.eventType === 'company_context.proposal_status_changed' &&
        (e.metadata as { refused?: boolean }).refused === true,
    );
    expect(refusal).toBeDefined();
  });

  it('lets a machine move a proposal to under_review, which decides nothing', async () => {
    const proposal = await createProposal(
      {
        targetDocument: 'VALUES.md',
        targetSection: null,
        proposedChange: 'Something.',
        reason: 'Because.',
        evidence: [],
        potentialImpact: null,
        projectId: null,
        taskId: null,
        runId: null,
        discoverySessionId: null,
      },
      SYSTEM_ACTOR,
    );

    const updated = await updateProposalStatus(proposal.id, { status: 'under_review' }, SYSTEM_ACTOR);
    expect(updated.status).toBe('under_review');
    expect(updated.reviewedBy).toBeNull();
  });

  it('will not reopen a decided proposal', async () => {
    const proposal = await propose();
    await asUser(app, admin).patch(`/api/company-context/proposals/${proposal.id}`, { status: 'accepted' });

    const reopened = await asUser(app, admin).patch(`/api/company-context/proposals/${proposal.id}`, {
      status: 'under_review',
    });
    expect(reopened.statusCode).toBe(409);
    expect(reopened.json().error.code).toBe('COMPANY_PROPOSAL_DECIDED');
  });
});

// ---------------------------------------------------------------------------
// Project knowledge does not become company policy
// ---------------------------------------------------------------------------

describe('project knowledge stays project knowledge', () => {
  it('does not become a proposal or a company revision on its own', async () => {
    // Sprint 3.2 §17's example: Mac learns that a specific VSD firmware has a
    // fault. That is a project fact. It is not PAC-wide truth.
    const project = await makeProject(app, admin);
    const task = await makeTask(app, admin, project.id);

    const revisionsBefore = (
      await db.select({ count: sql<number>`count(*)::int` }).from(companyContextRevisions)
    )[0]!.count;

    const learned = await createMemory(
      {
        scope: 'task',
        taskId: task.id,
        projectId: project.id,
        key: 'vsd-firmware-3.14-fault',
        value: 'VSD firmware 3.14 drops the Modbus link after a warm restart. Downgrade to 3.12.',
        confidence: 0.95,
        source: 'observed on site',
      },
      { type: 'user', id: null, label: 'engineer' },
    );

    const promoted = await promoteToProjectMemory(
      learned.id,
      { projectId: project.id, minConfidence: 0.8 },
      { type: 'user', id: null, label: 'engineer' },
    );

    // It reached PROJECT memory. That is as far as promotion goes.
    expect(promoted.scope).toBe('project');

    const proposalRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(companyContextProposals);
    expect(proposalRows[0]!.count).toBe(0);

    const revisionRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(companyContextRevisions);
    expect(revisionRows[0]!.count).toBe(revisionsBefore);

    expect(refsOf(repo.dir)).toBe(refsOf(repo.dir));
  });

  it('offers no promotion path from project memory to company context', async () => {
    const memory = await import('../../src/services/memory.js');
    expect((memory as Record<string, unknown>).promoteToCompanyContext).toBeUndefined();
    expect(Object.keys(memory).filter((k) => /company/i.test(k))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Forja
// ---------------------------------------------------------------------------

describe('Forja, as the loaded company context describes it', () => {
  it('is described by AGENTS.md as a platform, and Mac\'s registry agrees', async () => {
    const revision = (await refreshCompanyContext({ reason: 'test' })).revision!;
    const documents = await documentsForRevision(revision);
    const agentsDoc = documents.get('AGENTS.md')!;

    // The authoritative document says it.
    expect(agentsDoc).toContain('Forja is not itself one of the specialist staff agents');
    expect(agentsDoc).toContain('orchestration platform');

    // Mac's own domain model says the same thing, in executable data.
    expect(isPacAgent('forja')).toBe(false);
    expect(describeActor('forja')!.kind).toBe('platform');
    expect(describeActor('forja')!.assignable).toBe(false);

    // And the registry's heading actually exists in the document, so a future
    // divergence between the two is caught here rather than discovered.
    expect(agentsDoc).toContain(describeActor('forja')!.agentsDocumentHeading);
    expect(agentsDoc).toContain(describeActor('mac')!.agentsDocumentHeading);
  });
});
