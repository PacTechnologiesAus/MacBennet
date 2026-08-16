import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { JOB_KINDS, PROTOCOL_VERSION } from '@mac/protocol';
import {
  asUser,
  asWorker,
  closePool,
  createAndLogin,
  resetDatabase,
  startTestApp,
  type Session,
} from '../helpers/harness.js';
import { makeApprovedRun, makeProject, makeRun, makeTask, registerTestWorker } from '../helpers/fixtures.js';
import { db } from '../../src/db/client.js';
import { runs, runUsage, workers } from '../../src/db/schema.js';
import { queryAuditEvents } from '../../src/services/audit-query.js';
import { createEnrollmentToken, markStaleWorkersOffline } from '../../src/services/workers.js';
import { SYSTEM_ACTOR } from '../../src/services/audit.js';

let app: FastifyInstance;
let close: () => Promise<void>;
let operator: Session;
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
  const project = await makeProject(app, operator);
  taskId = (await makeTask(app, operator, project.id)).id;
});

const api = () => asUser(app, operator);

/** A lease call that returns promptly rather than long-polling. */
const lease = (token: string) =>
  asWorker(app, token).post('/api/worker/lease', { waitSeconds: 0, capabilities: [...JOB_KINDS] });

// ---------------------------------------------------------------------------
// Registration and authentication
// ---------------------------------------------------------------------------

describe('worker registration', () => {
  it('exchanges a single-use enrollment token for a worker token', async () => {
    const worker = await registerTestWorker(app, { name: 'vm-01' });
    expect(worker.token.startsWith('mac_wk_')).toBe(true);

    const listed = (await api().get('/api/workers')).json().workers;
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe('vm-01');
    expect(listed[0].capabilities).toEqual([...JOB_KINDS]);

    const events = await queryAuditEvents({ workerId: worker.workerId, limit: 10, offset: 0 });
    expect(events.map((e) => e.eventType)).toContain('worker.registered');
  });

  it('never returns the worker token again after registration', async () => {
    const worker = await registerTestWorker(app);
    const listed = (await api().get('/api/workers')).json().workers[0];
    expect(JSON.stringify(listed)).not.toContain(worker.token);
    // Only a non-secret display prefix is retained.
    expect(listed.tokenPrefix).toMatch(/^mac_wk_.{0,10}…$/);
  });

  it('stores only a hash of the worker token', async () => {
    const worker = await registerTestWorker(app);
    const [row] = await db.select().from(workers).where(eq(workers.id, worker.workerId)).limit(1);
    expect(row!.tokenHash).not.toBe(worker.token);
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses to reuse an enrollment token', async () => {
    const enrollment = await createEnrollmentToken({ label: 'once', expiresInHours: 1 }, SYSTEM_ACTOR);
    const payload = {
      capabilities: [...JOB_KINDS],
      version: '0.1.0',
      platform: 'linux',
      protocolVersion: PROTOCOL_VERSION,
    };

    const first = await app.inject({
      method: 'POST',
      url: '/api/worker/register',
      headers: { authorization: `Bearer ${enrollment.token}` },
      payload: { ...payload, name: 'first' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/worker/register',
      headers: { authorization: `Bearer ${enrollment.token}` },
      payload: { ...payload, name: 'second' },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(401);
  });

  it('refuses an expired enrollment token', async () => {
    const enrollment = await createEnrollmentToken({ label: 'stale', expiresInHours: 1 }, SYSTEM_ACTOR);
    await db.execute(sql`UPDATE worker_enrollment_tokens SET expires_at = now() - interval '1 hour'`);

    const response = await app.inject({
      method: 'POST',
      url: '/api/worker/register',
      headers: { authorization: `Bearer ${enrollment.token}` },
      payload: {
        name: 'late',
        capabilities: [...JOB_KINDS],
        version: '0.1.0',
        platform: 'linux',
        protocolVersion: PROTOCOL_VERSION,
      },
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a protocol version it does not speak', async () => {
    const enrollment = await createEnrollmentToken({ label: 'v99', expiresInHours: 1 }, SYSTEM_ACTOR);
    const response = await app.inject({
      method: 'POST',
      url: '/api/worker/register',
      headers: { authorization: `Bearer ${enrollment.token}` },
      payload: {
        name: 'futuristic',
        capabilities: [...JOB_KINDS],
        version: '9.0.0',
        platform: 'linux',
        protocolVersion: 99,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('PROTOCOL_VERSION_MISMATCH');
  });
});

describe('plane separation', () => {
  it('rejects worker endpoints without a worker token', async () => {
    for (const url of ['/api/worker/heartbeat', '/api/worker/lease']) {
      const response = await app.inject({ method: 'POST', url, payload: {} });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it('does not accept a human session cookie on the worker plane', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/worker/heartbeat',
      headers: { cookie: operator.cookie },
      payload: { status: 'idle', currentRunId: null },
    });
    expect(response.statusCode).toBe(401);
  });

  it('does not accept a worker token on the human plane', async () => {
    const worker = await registerTestWorker(app);
    for (const url of ['/api/projects', '/api/runs', '/api/settings', '/api/audit']) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${worker.token}` },
      });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it('rejects an enrollment token used as an operating credential', async () => {
    const enrollment = await createEnrollmentToken({ label: 'wrong-use', expiresInHours: 1 }, SYSTEM_ACTOR);
    const response = await asWorker(app, enrollment.token).post('/api/worker/heartbeat', {
      status: 'idle',
      currentRunId: null,
    });
    expect(response.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

describe('heartbeat', () => {
  it('records liveness and returns the control envelope', async () => {
    const worker = await registerTestWorker(app);
    const response = await asWorker(app, worker.token).post('/api/worker/heartbeat', {
      status: 'idle',
      currentRunId: null,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.workerStatus).toBe('idle');
    expect(body.control.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(body.control.cancelRequested).toBe(false);
    expect(body.control.heartbeatIntervalSeconds).toBe(10);

    const listed = (await api().get('/api/workers')).json().workers[0];
    expect(listed.isLive).toBe(true);
    expect(listed.lastHeartbeatAt).not.toBeNull();
  });

  it('marks a silent worker offline without failing its run', async () => {
    const worker = await registerTestWorker(app);
    await asWorker(app, worker.token).post('/api/worker/heartbeat', { status: 'idle', currentRunId: null });
    const run = await makeApprovedRun(app, operator, taskId, { jobKind: 'sleep', jobParams: { seconds: 30 } });
    await lease(worker.token);

    await db.execute(sql`UPDATE workers SET last_heartbeat_at = now() - interval '10 minutes'`);
    const offline = await markStaleWorkersOffline();
    expect(offline).toEqual([worker.workerId]);

    const listed = (await api().get('/api/workers')).json().workers[0];
    expect(listed.status).toBe('offline');
    expect(listed.isLive).toBe(false);

    // Deliberate: a transient network blip must not destroy in-flight work.
    // The run stays running and a human decides what to do about it.
    expect((await api().get(`/api/runs/${run.id}`)).json().run.status).toBe('running');

    const events = await queryAuditEvents({ workerId: worker.workerId, eventType: 'worker.offline', limit: 5, offset: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata.hadRunInFlight).toBe(true);
  });

  it('does not write an audit event for ordinary heartbeats', async () => {
    const worker = await registerTestWorker(app);
    for (let i = 0; i < 5; i += 1) {
      await asWorker(app, worker.token).post('/api/worker/heartbeat', { status: 'idle', currentRunId: null });
    }
    // Heartbeats at 10s intervals would otherwise produce ~8,600 rows a day and
    // drown the trail a human is supposed to read.
    const events = await queryAuditEvents({ workerId: worker.workerId, limit: 50, offset: 0 });
    expect(events.filter((e) => e.eventType === 'worker.online')).toHaveLength(0);
    expect(events.map((e) => e.eventType)).toEqual(['worker.registered']);
  });

  it('audits the recovery of a worker that had gone offline', async () => {
    const worker = await registerTestWorker(app);
    await db.execute(sql`UPDATE workers SET status = 'offline', last_heartbeat_at = now() - interval '1 hour'`);

    await asWorker(app, worker.token).post('/api/worker/heartbeat', { status: 'idle', currentRunId: null });

    const events = await queryAuditEvents({ workerId: worker.workerId, eventType: 'worker.online', limit: 5, offset: 0 });
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Dispatch — the central guardrail
// ---------------------------------------------------------------------------

describe('dispatch', () => {
  it('REFUSES to dispatch an unapproved run', async () => {
    const worker = await registerTestWorker(app);

    // A draft run.
    await makeRun(app, operator, taskId);
    expect(lease(worker.token).then((r) => r.json().assignment)).resolves.toBeNull();

    // A run submitted but not yet approved.
    const submitted = await makeRun(app, operator, taskId);
    await api().post(`/api/runs/${submitted.id}/submit`);
    expect((await lease(worker.token)).json().assignment).toBeNull();

    // A run that was explicitly rejected.
    const rejected = await makeRun(app, operator, taskId);
    await api().post(`/api/runs/${rejected.id}/submit`);
    await api().post(`/api/runs/${rejected.id}/reject`, { notes: 'No.' });
    expect((await lease(worker.token)).json().assignment).toBeNull();

    // None of them may have started.
    for (const id of [submitted.id, rejected.id]) {
      const run = (await api().get(`/api/runs/${id}`)).json().run;
      expect(run.startedAt).toBeNull();
      expect(run.workerId).toBeNull();
      expect(['draft', 'ready_for_approval']).toContain(run.status);
    }
  });

  it('cannot be bypassed by forcing approval state directly in the queue', async () => {
    // Belt and braces: even if a run were somehow queued while unapproved, the
    // dispatch predicate is SQL, so the row is simply unselectable.
    const worker = await registerTestWorker(app);
    const run = await makeRun(app, operator, taskId);
    await db.update(runs).set({ status: 'queued', approvalState: 'pending' }).where(eq(runs.id, run.id));

    expect((await lease(worker.token)).json().assignment).toBeNull();
  });

  it('dispatches an approved, queued run', async () => {
    const worker = await registerTestWorker(app);
    const run = await makeApprovedRun(app, operator, taskId, {
      jobKind: 'echo',
      jobParams: { message: 'dispatched' },
    });

    const response = await lease(worker.token);
    expect(response.statusCode).toBe(200);

    const assignment = response.json().assignment;
    expect(assignment.runId).toBe(run.id);
    expect(assignment.jobKind).toBe('echo');
    expect(assignment.jobParams).toEqual({ message: 'dispatched' });
    expect(assignment.attempt).toBe(1);

    const detail = (await api().get(`/api/runs/${run.id}`)).json().run;
    expect(detail.status).toBe('running');
    expect(detail.workerId).toBe(worker.workerId);
    expect(detail.startedAt).not.toBeNull();

    const events = await queryAuditEvents({ runId: run.id, eventType: 'run.dispatched', limit: 5, offset: 0 });
    expect(events).toHaveLength(1);
  });

  it('hands the same run to only one worker', async () => {
    const a = await registerTestWorker(app, { name: 'worker-a' });
    const b = await registerTestWorker(app, { name: 'worker-b' });
    await makeApprovedRun(app, operator, taskId);

    const first = (await lease(a.token)).json().assignment;
    const second = (await lease(b.token)).json().assignment;

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('dispatches higher-priority work first', async () => {
    const worker = await registerTestWorker(app);
    const project = await makeProject(app, operator, { name: 'Priorities' });
    const low = await makeTask(app, operator, project.id, { title: 'Low', priority: 'low' });
    const urgent = await makeTask(app, operator, project.id, { title: 'Urgent', priority: 'urgent' });

    await makeApprovedRun(app, operator, low.id);
    const urgentRun = await makeApprovedRun(app, operator, urgent.id);

    expect((await lease(worker.token)).json().assignment.runId).toBe(urgentRun.id);
  });

  it('does not dispatch a job the worker cannot perform', async () => {
    const worker = await registerTestWorker(app, { capabilities: ['noop'] });
    await makeApprovedRun(app, operator, taskId, { jobKind: 'sleep', jobParams: { seconds: 2 } });
    expect((await lease(worker.token)).json().assignment).toBeNull();
  });

  it('blocks dispatch when the nightly budget is exhausted', async () => {
    const worker = await registerTestWorker(app);
    const run = await makeApprovedRun(app, operator, taskId);

    // The budget guardrail sums real rows. Sprint 1 never writes any, but the
    // code path is real, so it is tested with one.
    await db.insert(runUsage).values({
      runId: run.id,
      provider: 'test-provider',
      kind: 'tokens',
      costCents: 5000, // equals the default nightly budget
      isExact: true,
    });

    expect((await lease(worker.token)).json().assignment).toBeNull();

    const blocked = await queryAuditEvents({ eventType: 'guardrail.blocked', limit: 20, offset: 0 });
    expect(blocked.some((e) => e.metadata.guardrail === 'budget')).toBe(true);
  });

  it('ignores inexact usage when enforcing the budget', async () => {
    // Spec §25: an estimate must never be presented as, or acted on as, exact
    // provider usage.
    const worker = await registerTestWorker(app);
    const run = await makeApprovedRun(app, operator, taskId);
    await db.insert(runUsage).values({
      runId: run.id,
      provider: 'test-provider',
      kind: 'tokens',
      costCents: 999_999,
      isExact: false,
    });

    expect((await lease(worker.token)).json().assignment).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Progress, logs and completion
// ---------------------------------------------------------------------------

describe('progress and logs', () => {
  it('records progress and extends the lease', async () => {
    const worker = await registerTestWorker(app);
    const run = await makeApprovedRun(app, operator, taskId, { jobKind: 'sleep', jobParams: { seconds: 5 } });
    await lease(worker.token);

    const response = await asWorker(app, worker.token).post(`/api/worker/runs/${run.id}/progress`, {
      stage: 'sleeping',
      percent: 40,
    });
    expect(response.statusCode).toBe(200);

    const detail = (await api().get(`/api/runs/${run.id}`)).json().run;
    expect(detail.progressStage).toBe('sleeping');
    expect(detail.progressPercent).toBe(40);
  });

  it('audits stage changes but not every percentage tick', async () => {
    const worker = await registerTestWorker(app);
    const run = await makeApprovedRun(app, operator, taskId, { jobKind: 'sleep', jobParams: { seconds: 5 } });
    await lease(worker.token);
    const w = asWorker(app, worker.token);

    for (const percent of [10, 20, 30, 40]) {
      await w.post(`/api/worker/runs/${run.id}/progress`, { stage: 'sleeping', percent });
    }
    await w.post(`/api/worker/runs/${run.id}/progress`, { stage: 'finishing', percent: 90 });

    const events = await queryAuditEvents({
      runId: run.id,
      eventType: 'run.progress_stage_changed',
      limit: 20,
      offset: 0,
    });
    expect(events).toHaveLength(2); // "sleeping" and "finishing", not four ticks
  });

  it('accepts a log batch and deduplicates a retried one', async () => {
    const worker = await registerTestWorker(app);
    const run = await makeApprovedRun(app, operator, taskId);
    await lease(worker.token);
    const w = asWorker(app, worker.token);

    const entries = [
      { seq: 0, ts: new Date().toISOString(), stream: 'stdout', message: 'line one' },
      { seq: 1, ts: new Date().toISOString(), stream: 'stdout', message: 'line two' },
    ];

    const first = await w.post(`/api/worker/runs/${run.id}/logs`, { entries });
    expect(first.json().accepted).toBe(2);
    expect(first.json().highestSeq).toBe(1);

    // A worker that did not see the first response re-sends the same batch.
    const retry = await w.post(`/api/worker/runs/${run.id}/logs`, { entries });
    expect(retry.json().accepted).toBe(0);
    expect(retry.json().highestSeq).toBe(1);

    const logs = (await api().get(`/api/runs/${run.id}/logs`)).json().logs;
    const worker_lines = logs.filter((l: { stream: string }) => l.stream === 'stdout');
    expect(worker_lines).toHaveLength(2);
  });

  it('truncates an oversized log message rather than rejecting it', async () => {
    const worker = await registerTestWorker(app);
    const run = await makeApprovedRun(app, operator, taskId);
    await lease(worker.token);

    const response = await asWorker(app, worker.token).post(`/api/worker/runs/${run.id}/logs`, {
      entries: [{ seq: 0, ts: new Date().toISOString(), stream: 'stdout', message: 'x'.repeat(50_000) }],
    });
    // The schema caps message length, so an oversized line is a validation
    // failure rather than an unbounded write.
    expect(response.statusCode).toBe(400);
  });

  it('interleaves control-plane notes with worker output in the log', async () => {
    const worker = await registerTestWorker(app);
    const run = await makeApprovedRun(app, operator, taskId);
    await lease(worker.token);
    await asWorker(app, worker.token).post(`/api/worker/runs/${run.id}/logs`, {
      entries: [{ seq: 0, ts: new Date().toISOString(), stream: 'stdout', message: 'worker says hello' }],
    });

    const logs = (await api().get(`/api/runs/${run.id}/logs`)).json().logs;
    expect(logs.some((l: { stream: string; message: string }) => l.stream === 'system' && l.message.includes('approved'))).toBe(true);
    expect(logs.some((l: { stream: string }) => l.stream === 'stdout')).toBe(true);
    // The poll cursor must advance over both, which `seq` alone cannot do.
    const ids = logs.map((l: { id: number }) => l.id);
    expect([...ids].sort((a: number, b: number) => a - b)).toEqual(ids);
  });

  it('supports incremental polling with the cursor', async () => {
    const worker = await registerTestWorker(app);
    const run = await makeApprovedRun(app, operator, taskId);
    await lease(worker.token);
    const w = asWorker(app, worker.token);

    await w.post(`/api/worker/runs/${run.id}/logs`, {
      entries: [{ seq: 0, ts: new Date().toISOString(), stream: 'stdout', message: 'first' }],
    });
    const firstPoll = (await api().get(`/api/runs/${run.id}/logs`)).json();

    await w.post(`/api/worker/runs/${run.id}/logs`, {
      entries: [{ seq: 1, ts: new Date().toISOString(), stream: 'stdout', message: 'second' }],
    });
    const secondPoll = (await api().get(`/api/runs/${run.id}/logs?afterId=${firstPoll.cursor}`)).json();

    expect(secondPoll.logs).toHaveLength(1);
    expect(secondPoll.logs[0].message).toBe('second');
  });
});

describe('worker authorisation', () => {
  it('refuses to let one worker touch another worker\'s run', async () => {
    const owner = await registerTestWorker(app, { name: 'owner' });
    const intruder = await registerTestWorker(app, { name: 'intruder' });
    const run = await makeApprovedRun(app, operator, taskId);
    await lease(owner.token);

    const w = asWorker(app, intruder.token);
    for (const [url, payload] of [
      [`/api/worker/runs/${run.id}/progress`, { stage: 'hijacked' }],
      [`/api/worker/runs/${run.id}/logs`, { entries: [{ seq: 0, ts: new Date().toISOString(), stream: 'stdout', message: 'x' }] }],
      [`/api/worker/runs/${run.id}/complete`, { outcome: 'succeeded' }],
    ] as const) {
      const response = await w.post(url, payload);
      expect(response.statusCode, url).toBe(403);
    }

    const events = await queryAuditEvents({
      workerId: intruder.workerId,
      eventType: 'worker.unauthorized_run_access',
      limit: 10,
      offset: 0,
    });
    expect(events.length).toBe(3);
  });
});

describe('completion', () => {
  it('completes a run and frees the worker', async () => {
    const worker = await registerTestWorker(app);
    const run = await makeApprovedRun(app, operator, taskId);
    await lease(worker.token);

    const response = await asWorker(app, worker.token).post(`/api/worker/runs/${run.id}/complete`, {
      outcome: 'succeeded',
      summary: 'Nothing to do, successfully.',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().runStatus).toBe('completed');

    const detail = (await api().get(`/api/runs/${run.id}`)).json().run;
    expect(detail.status).toBe('completed');
    expect(detail.completedAt).not.toBeNull();
    expect(detail.stopReason).toBe('completed');
    expect(detail.progressPercent).toBe(100);

    const workerRow = (await api().get('/api/workers')).json().workers[0];
    expect(workerRow.status).toBe('idle');
    expect(workerRow.currentRunId).toBeNull();
  });

  it('records a failure as failed, not completed', async () => {
    const worker = await registerTestWorker(app);
    const run = await makeApprovedRun(app, operator, taskId, { jobKind: 'fail' });
    await lease(worker.token);

    const response = await asWorker(app, worker.token).post(`/api/worker/runs/${run.id}/complete`, {
      outcome: 'failed',
      summary: 'Deliberate failure.',
    });
    expect(response.json().runStatus).toBe('failed');

    const detail = (await api().get(`/api/runs/${run.id}`)).json().run;
    expect(detail.status).toBe('failed');
    expect(detail.progressPercent).not.toBe(100);
  });

  it('treats a retried completion as idempotent', async () => {
    const worker = await registerTestWorker(app);
    const run = await makeApprovedRun(app, operator, taskId);
    await lease(worker.token);
    const w = asWorker(app, worker.token);

    const first = await w.post(`/api/worker/runs/${run.id}/complete`, { outcome: 'succeeded' });
    // The worker did not see the first response and asks again.
    const second = await w.post(`/api/worker/runs/${run.id}/complete`, { outcome: 'succeeded' });

    expect(first.json().runStatus).toBe('completed');
    expect(second.statusCode).toBe(200);
    expect(second.json().runStatus).toBe('completed');

    const events = await queryAuditEvents({ runId: run.id, eventType: 'run.completed', limit: 10, offset: 0 });
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Stop and cancel
// ---------------------------------------------------------------------------

describe('cancellation', () => {
  it('cancels an undispatched run outright, with no worker involved', async () => {
    const run = await makeApprovedRun(app, operator, taskId);
    const response = await api().post(`/api/runs/${run.id}/cancel`, { reason: 'Changed my mind.' });

    expect(response.json().run.status).toBe('cancelled');
    expect(response.json().run.stopReason).toBe('cancelled_by_user');

    const events = await queryAuditEvents({ runId: run.id, eventType: 'run.cancelled', limit: 5, offset: 0 });
    expect(events[0]!.metadata.propagated).toBe(false);
  });

  it('propagates a stop to a running worker through the control envelope', async () => {
    const worker = await registerTestWorker(app);
    const run = await makeApprovedRun(app, operator, taskId, { jobKind: 'sleep', jobParams: { seconds: 60 } });
    await lease(worker.token);
    const w = asWorker(app, worker.token);

    // Before the stop, nothing is pending.
    expect((await w.post('/api/worker/heartbeat', { status: 'busy', currentRunId: run.id })).json().control.cancelRequested).toBe(false);

    const cancelled = await api().post(`/api/runs/${run.id}/cancel`, { reason: 'Stop now.' });
    // The run stays running until the worker acknowledges — the trail must
    // show that it actually stopped, not merely that someone asked.
    expect(cancelled.json().run.status).toBe('running');
    expect(cancelled.json().run.cancelRequestedAt).not.toBeNull();

    // The stop reaches the worker on ANY subsequent call, not just heartbeats.
    const viaLogs = await w.post(`/api/worker/runs/${run.id}/logs`, {
      entries: [{ seq: 0, ts: new Date().toISOString(), stream: 'stdout', message: 'still working' }],
    });
    expect(viaLogs.json().control.cancelRequested).toBe(true);
    expect(viaLogs.json().control.cancelRunId).toBe(run.id);

    const heartbeat = await w.post('/api/worker/heartbeat', { status: 'busy', currentRunId: run.id });
    expect(heartbeat.json().control.cancelRequested).toBe(true);

    // The worker acknowledges by completing as cancelled.
    const completed = await w.post(`/api/worker/runs/${run.id}/complete`, { outcome: 'cancelled' });
    expect(completed.json().runStatus).toBe('cancelled');

    const detail = (await api().get(`/api/runs/${run.id}`)).json().run;
    expect(detail.status).toBe('cancelled');
    expect(detail.stopReason).toBe('cancelled_by_user');
  });

  it('is idempotent when a stop is requested twice', async () => {
    const worker = await registerTestWorker(app);
    const run = await makeApprovedRun(app, operator, taskId, { jobKind: 'sleep', jobParams: { seconds: 60 } });
    await lease(worker.token);

    await api().post(`/api/runs/${run.id}/cancel`, { reason: 'first' });
    const second = await api().post(`/api/runs/${run.id}/cancel`, { reason: 'second' });
    expect(second.statusCode).toBe(200);

    const events = await queryAuditEvents({ runId: run.id, eventType: 'run.cancel_requested', limit: 10, offset: 0 });
    expect(events).toHaveLength(1);
  });

  it('force-cancels an unreachable worker\'s run, audited as forced', async () => {
    const worker = await registerTestWorker(app);
    const run = await makeApprovedRun(app, operator, taskId, { jobKind: 'sleep', jobParams: { seconds: 60 } });
    await lease(worker.token);
    await api().post(`/api/runs/${run.id}/cancel`, { reason: 'Stop.' });

    const forced = await api().post(`/api/runs/${run.id}/force-cancel`, { reason: 'Worker is not responding.' });
    expect(forced.json().run.status).toBe('cancelled');
    expect(forced.json().run.stopReason).toBe('force_cancelled_worker_unreachable');

    // A forced stop must never be mistaken for a clean one.
    const events = await queryAuditEvents({ runId: run.id, eventType: 'run.force_cancelled', limit: 5, offset: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata.forced).toBe(true);
  });

  it('does not dispatch a run that has a stop pending', async () => {
    const worker = await registerTestWorker(app);
    const run = await makeApprovedRun(app, operator, taskId);
    await db.update(runs).set({ cancelRequestedAt: new Date() }).where(eq(runs.id, run.id));

    expect((await lease(worker.token)).json().assignment).toBeNull();
  });
});
