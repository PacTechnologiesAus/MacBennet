import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { asUser, closePool, createAndLogin, resetDatabase, startTestApp, type Session } from '../helpers/harness.js';
import { makeProject, makeRun, makeTask } from '../helpers/fixtures.js';
import { createCompanyRepo, type CompanyRepoFixture } from '../helpers/company-repo.js';
import { db } from '../../src/db/client.js';
import { agentQuestions, discoverySessions, handoffBriefs, runs, settings } from '../../src/db/schema.js';
import { GitCompanyContextProvider } from '../../src/services/company-context/git-provider.js';
import { setCompanyContextProvider } from '../../src/services/company-context/provider.js';
import {
  refreshCompanyContext,
  resetCompanyContextCache,
} from '../../src/services/company-context/service.js';
import { queryAuditEvents } from '../../src/services/audit-query.js';

/**
 * Provenance: which company context governed which work (Sprint 3.2 §8, §22).
 *
 * The claim under test is the one that makes this sprint worth doing. It is not
 * "the SHA is stored" — it is that a run performed under one revision of PAC
 * policy STAYS attributable to that revision after the policy moves on, and
 * that nothing, including a bug written next year, can quietly re-point it.
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

describe('discovery', () => {
  it('binds the company context revision when a session starts', async () => {
    const project = await makeProject(app, admin);
    const response = await asUser(app, admin).post('/api/discovery', {
      projectId: project.id,
      title: 'Add a status column to the batch screen',
    });

    expect(response.statusCode).toBe(201);
    const session = response.json().session;

    expect(session.companyContext).not.toBeNull();
    expect(session.companyContext.commitSha).toBe(repo.head());
    expect(session.companyContext.contextVersion).toBe('0.1.0');
    expect(session.companyContext.shortSha).toBe(repo.head().slice(0, 7));

    const [row] = await db.select().from(discoverySessions).where(eq(discoverySessions.id, session.id));
    expect(row!.companyContextRevisionId).not.toBeNull();
  });

  it('audits the binding with the sha', async () => {
    const project = await makeProject(app, admin);
    await asUser(app, admin).post('/api/discovery', { projectId: project.id, title: 'A task' });

    const events = await queryAuditEvents({ limit: 100, offset: 0 });
    const bound = events.find((e) => e.eventType === 'company_context.bound_to_discovery');
    expect(bound).toBeDefined();
    expect((bound!.metadata as { commitSha: string }).commitSha).toBe(repo.head());
  });
});

describe('runs', () => {
  it('binds the revision at creation and reports it on the DTO', async () => {
    const project = await makeProject(app, admin);
    const task = await makeTask(app, admin, project.id);
    const run = await makeRun(app, admin, task.id);

    const detail = await asUser(app, admin).get(`/api/runs/${run.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().run.companyContext.commitSha).toBe(repo.head());
  });

  it('audits the binding', async () => {
    const project = await makeProject(app, admin);
    const task = await makeTask(app, admin, project.id);
    await makeRun(app, admin, task.id);

    const events = await queryAuditEvents({ limit: 100, offset: 0 });
    expect(events.map((e) => e.eventType)).toContain('company_context.bound_to_run');
  });
});

describe('a run keeps the context it was created under', () => {
  it('retains its ORIGINAL sha after the Company repository advances', async () => {
    const project = await makeProject(app, admin);
    const task = await makeTask(app, admin, project.id);
    const run = await makeRun(app, admin, task.id);
    const originalSha = repo.head();

    // PAC revises its authority document overnight.
    const newSha = repo.commit(
      { 'AUTHORITY.md': '# Authority\n\n## Financial Authority\n\nRevised.\n' },
      'Revise authority',
    );
    const refreshed = await refreshCompanyContext({ reason: 'after-change' });
    expect(refreshed.revision!.commitSha).toBe(newSha);

    // The old run is unmoved.
    const detail = await asUser(app, admin).get(`/api/runs/${run.id}`);
    expect(detail.json().run.companyContext.commitSha).toBe(originalSha);
    expect(detail.json().run.companyContext.commitSha).not.toBe(newSha);

    // A NEW run picks up the new policy.
    const later = await makeRun(app, admin, task.id);
    const laterDetail = await asUser(app, admin).get(`/api/runs/${later.id}`);
    expect(laterDetail.json().run.companyContext.commitSha).toBe(newSha);
  });

  it('cannot be re-pointed by a direct UPDATE, because the database refuses', async () => {
    // Application code does not try to move a binding. This proves it CANNOT be
    // moved, including through a code path nobody has written yet.
    const project = await makeProject(app, admin);
    const task = await makeTask(app, admin, project.id);
    const run = await makeRun(app, admin, task.id);

    repo.commit({ 'README.md': 'changed\n' }, 'Move on');
    const second = await refreshCompanyContext({ reason: 'after-change' });

    await expect(
      db
        .update(runs)
        .set({ companyContextRevisionId: second.revision!.id })
        .where(eq(runs.id, run.id)),
    ).rejects.toThrow(/immutable/i);
  });

  it('refuses to have its binding nulled', async () => {
    const project = await makeProject(app, admin);
    const task = await makeTask(app, admin, project.id);
    const run = await makeRun(app, admin, task.id);

    await expect(
      db.update(runs).set({ companyContextRevisionId: null }).where(eq(runs.id, run.id)),
    ).rejects.toThrow(/immutable/i);
  });

  it('still allows ordinary updates to the run', async () => {
    // The trigger must not be so blunt that it breaks the control loop.
    const project = await makeProject(app, admin);
    const task = await makeTask(app, admin, project.id);
    const run = await makeRun(app, admin, task.id);

    const submitted = await asUser(app, admin).post(`/api/runs/${run.id}/submit`);
    expect(submitted.statusCode).toBe(200);
    const approved = await asUser(app, admin).post(`/api/runs/${run.id}/approve`, { notes: 'ok' });
    expect(approved.statusCode).toBe(200);
  });
});

describe('the handoff brief', () => {
  it('records the revision and names it in the rendered markdown', async () => {
    const project = await makeProject(app, admin);
    const start = await asUser(app, admin).post('/api/discovery', {
      projectId: project.id,
      title: 'Add a CSV export to the batch report',
    });
    const session = start.json().session;

    await asUser(app, admin).post(`/api/discovery/${session.id}/messages`, {
      message:
        'At the moment the batch report only shows on screen. It should be exportable to CSV so the ' +
        'production team can open it in Excel. Done when the file downloads with the same columns.',
    });

    const generated = await asUser(app, admin).post(`/api/discovery/${session.id}/brief`);
    expect(generated.statusCode).toBe(201);

    const brief = generated.json().brief;
    expect(brief.companyContext.commitSha).toBe(repo.head());
    // The artefact itself identifies its governing revision, so a brief pasted
    // into a pull request stays attributable.
    expect(brief.markdown).toContain(`PAC company context: ${repo.head().slice(0, 7)}`);
    expect(brief.markdown).toContain('context version 0.1.0');

    const [row] = await db.select().from(handoffBriefs).where(eq(handoffBriefs.id, brief.id));
    expect(row!.companyContextRevisionId).not.toBeNull();
  });

  it('keeps the discovery session and its brief on the SAME revision', async () => {
    const project = await makeProject(app, admin);
    const start = await asUser(app, admin).post('/api/discovery', { projectId: project.id, title: 'A task' });
    const session = start.json().session;

    await asUser(app, admin).post(`/api/discovery/${session.id}/messages`, {
      message: 'We need a button that exports the table. Done when the file downloads.',
    });

    // Company context moves between the conversation and the structuring.
    repo.commit({ 'README.md': 'moved on\n' }, 'Move on');
    await refreshCompanyContext({ reason: 'mid-discovery' });

    const generated = await asUser(app, admin).post(`/api/discovery/${session.id}/brief`);
    const brief = generated.json().brief;

    // The brief belongs to the discovery that produced it.
    expect(brief.companyContext.commitSha).toBe(session.companyContext.commitSha);
  });
});

describe('supervised answers', () => {
  it('bind the RUN\'s revision, not whatever became active afterwards', async () => {
    const project = await makeProject(app, admin);
    const task = await makeTask(app, admin, project.id);
    const run = await makeRun(app, admin, task.id);
    const originalSha = repo.head();

    // Give the run a brief so supervision has a basis to answer from.
    const [brief] = await db
      .insert(handoffBriefs)
      .values({
        taskId: task.id,
        projectId: project.id,
        version: 1,
        status: 'ready',
        content: {
          title: task.title,
          userObjective: 'Export the batch report to CSV.',
          currentBehaviour: '',
          desiredBehaviour: 'A CSV download button on the batch report.',
          relevantArchitecture: '',
          constraints: ['Keep the existing column order.'],
          mustNotChange: [],
          likelyAffectedComponents: [],
          acceptanceCriteria: ['The file downloads.'],
          testingExpectations: [],
          implementationConsiderations: [],
          risks: [],
          assumptions: [],
          openQuestions: [],
          proposedScope: 'Add the export.',
          outOfScope: [],
        },
        confidence: '0.900',
        sourceConversation: 'x',
      })
      .returning();
    await db.update(runs).set({ handoffBriefId: brief!.id }).where(eq(runs.id, run.id));

    // Company context moves AFTER the run was created.
    const newSha = repo.commit({ 'README.md': 'later\n' }, 'Later commit');
    await refreshCompanyContext({ reason: 'mid-run' });
    expect(newSha).not.toBe(originalSha);

    const { answerAgentQuestion } = await import('../../src/services/supervision.js');
    const outcome = await answerAgentQuestion(
      run.id,
      { questionId: 'q-1', question: 'Should the CSV keep the existing column order?' },
      { type: 'system', id: null, label: 'test' },
    );

    expect(outcome.answer.companyContext).not.toBeNull();
    // The decision was made under the policy the run started with.
    expect(outcome.answer.companyContext!.commitSha).toBe(originalSha);

    const [questionRow] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, outcome.questionId));
    expect(questionRow!.companyContextRevisionId).not.toBeNull();

    const [runRow] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect(questionRow!.companyContextRevisionId).toBe(runRow!.companyContextRevisionId);
  });
});

describe('a historical revision can still be read', () => {
  it('serves the document as it was at the bound sha', async () => {
    const originalSha = repo.head();
    const revisions = await asUser(app, admin).get('/api/company-context/revisions');
    const original = revisions.json().revisions.find((r: { commitSha: string }) => r.commitSha === originalSha);

    repo.commit(
      { 'AUTHORITY.md': '# Authority\n\n## Financial Authority\n\nTotally rewritten.\n' },
      'Rewrite',
    );
    await refreshCompanyContext({ reason: 'after' });

    const document = await asUser(app, admin).get(
      `/api/company-context/revisions/${original.id}/document?path=AUTHORITY.md`,
    );

    expect(document.statusCode).toBe(200);
    expect(document.json().content).toContain('Agents prepare. Humans release.');
    expect(document.json().content).not.toContain('Totally rewritten');
  });
});
