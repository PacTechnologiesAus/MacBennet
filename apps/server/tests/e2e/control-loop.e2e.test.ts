import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { startWorker, type WorkerHandle } from '@mac/worker';
import type { WorkerConfig } from '@mac/worker/config';
import { silentLogger } from '@mac/worker/logger';
import {
  asUser,
  closePool,
  createAndLogin,
  resetDatabase,
  startTestApp,
  type Session,
} from '../helpers/harness.js';
import { makeProject, makeTask } from '../helpers/fixtures.js';
import { createEnrollmentToken } from '../../src/services/workers.js';
import { SYSTEM_ACTOR } from '../../src/services/audit.js';
import { auditTrailForRun } from '../../src/services/audit-query.js';

/**
 * END-TO-END: the Sprint 1 control loop.
 *
 * This is the test the sprint exists to pass (spec §32). Nothing is mocked:
 * a real Fastify server on a real TCP port, the real worker process loop
 * talking to it over real HTTP with a real issued credential, executing a real
 * (harmless) job, against a real PostgreSQL database.
 *
 *   human creates project → creates task → creates run → approves
 *     → worker registers → heartbeats → receives the job → executes it
 *     → streams logs → reports progress → completes
 *     → audit trail proves the whole lifecycle
 */

let app: FastifyInstance;
let close: () => Promise<void>;
let baseUrl: string;
let operator: Session;
let taskId: string;
let stateDir: string;
const workers: WorkerHandle[] = [];

beforeAll(async () => {
  ({ fastify: app, close } = await startTestApp());
  // Port 0 = let the OS choose, so the suite never collides with a dev server.
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Could not determine test server port.');
  baseUrl = `http://127.0.0.1:${address.port}`;
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mac-worker-e2e-'));
});

afterAll(async () => {
  await Promise.all(workers.map((w) => w.stop().catch(() => undefined)));
  await close();
  await closePool();
  await fs.rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
});

beforeEach(async () => {
  await resetDatabase();
  operator = await createAndLogin(app, { email: 'engineer@pac.test', name: 'Kasper S', role: 'admin' });
  const project = await makeProject(app, operator, { name: 'Sprint 1 Proof' });
  taskId = (await makeTask(app, operator, project.id, { title: 'Prove the control loop end to end' })).id;
});

const api = () => asUser(app, operator);

async function launchWorker(overrides: Partial<WorkerConfig> & { maxRuns?: number } = {}): Promise<WorkerHandle> {
  const enrollment = await createEnrollmentToken({ label: 'e2e', expiresInHours: 1 }, SYSTEM_ACTOR);

  const config: WorkerConfig = {
    controlPlaneUrl: baseUrl,
    enrollmentToken: enrollment.token!,
    name: overrides.name ?? `e2e-worker-${Math.floor(Math.random() * 1e9)}`,
    stateFile: path.join(stateDir, `${Math.random().toString(36).slice(2)}.json`),
    workspace: path.join(stateDir, 'workspace'),
    heartbeatSeconds: 1,
    logLevel: 'silent',
  };

  const handle = await startWorker({
    config,
    logger: silentLogger,
    leaseWaitSeconds: 2,
    retryBaseMs: 50,
    ...(overrides.maxRuns !== undefined ? { maxRuns: overrides.maxRuns } : {}),
  });
  workers.push(handle);
  return handle;
}

/** Polls the run until it reaches a terminal state or the deadline passes. */
async function waitForRunStatus(
  runId: string,
  predicate: (run: { status: string; [k: string]: unknown }) => boolean,
  timeoutMs = 20_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const response = await api().get(`/api/runs/${runId}`);
    last = response.json().run;
    if (predicate(last as { status: string })) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Run ${runId} never satisfied the condition. Last seen: ${JSON.stringify(last)}`);
}

describe('Sprint 1 control loop, end to end', () => {
  it('carries a task from creation to a completed, fully audited run', async () => {
    // 1–3. A human creates the run. It starts unapproved and unable to execute.
    const created = await api().post('/api/runs', {
      taskId,
      jobKind: 'echo',
      jobParams: { message: 'Mac Bennett reporting for duty.' },
      confidence: 0.92,
      executionMode: 'interactive',
    });
    expect(created.statusCode).toBe(201);
    const runId = created.json().run.id;

    await api().post(`/api/runs/${runId}/submit`);

    // 5. A worker connects and heartbeats. It must NOT receive the run yet:
    //    approval has not happened.
    const worker = await launchWorker({ maxRuns: 1 });
    await new Promise((r) => setTimeout(r, 1500));

    const beforeApproval = (await api().get(`/api/runs/${runId}`)).json().run;
    expect(beforeApproval.status).toBe('ready_for_approval');
    expect(beforeApproval.workerId).toBeNull();
    expect(beforeApproval.startedAt).toBeNull();

    const liveWorkers = (await api().get('/api/workers')).json().workers;
    expect(liveWorkers).toHaveLength(1);
    expect(liveWorkers[0].isLive).toBe(true);

    // 4. The human approves.
    const approved = await api().post(`/api/runs/${runId}/approve`, { notes: 'Go ahead.' });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().run.status).toBe('queued');

    // 6–10. The worker picks it up, executes, logs and completes.
    const final = await waitForRunStatus(runId, (run) => run.status === 'completed');

    expect(final.status).toBe('completed');
    expect(final.stopReason).toBe('completed');
    expect(final.progressPercent).toBe(100);
    expect(final.workerId).toBe(worker.state.workerId);
    expect(final.startedAt).not.toBeNull();
    expect(final.completedAt).not.toBeNull();
    expect(final.summary).toContain('Echoed');

    // 8. Logs were captured, including the job's own output.
    const logs = (await api().get(`/api/runs/${runId}/logs`)).json().logs;
    const messages = logs.map((l: { message: string }) => l.message);
    expect(messages.some((m: string) => m.includes('Mac Bennett reporting for duty.'))).toBe(true);
    expect(messages.some((m: string) => m.includes('Run approved by'))).toBe(true);
    expect(messages.some((m: string) => m.includes('Dispatched to worker'))).toBe(true);
    // The poll cursor must be monotonic across worker output and system notes.
    const ids = logs.map((l: { id: number }) => l.id);
    expect([...ids].sort((a: number, b: number) => a - b)).toEqual(ids);

    // 11. The audit trail shows the entire lifecycle, in order.
    const trail = await auditTrailForRun(runId);
    const types = trail.map((e) => e.eventType);

    expect(types).toEqual([
      'run.created',
      'run.submitted_for_approval',
      'run.approved',
      'run.queued',
      'run.dispatched',
      'run.progress_stage_changed', // starting
      'run.progress_stage_changed', // complete
      'run.completed',
    ]);

    // The trail must attribute the human decision to the human and the
    // execution to the machine — that separation is the point of the trail.
    const approvedEvent = trail.find((e) => e.eventType === 'run.approved')!;
    expect(approvedEvent.actorType).toBe('user');
    expect(approvedEvent.actorLabel).toContain('Kasper S');
    expect(approvedEvent.metadata.confidence).toBe(0.92);

    const dispatchedEvent = trail.find((e) => e.eventType === 'run.dispatched')!;
    expect(dispatchedEvent.actorType).toBe('worker');
    expect(dispatchedEvent.actorId).toBe(worker.state.workerId);

    const completedEvent = trail.find((e) => e.eventType === 'run.completed')!;
    expect(completedEvent.actorType).toBe('worker');
    expect(completedEvent.metadata.outcome).toBe('succeeded');

    // Every transition records both ends, so the lifecycle can be replayed.
    const transitions = trail
      .filter((e) => typeof e.metadata.from === 'string')
      .map((e) => `${e.metadata.from}→${e.metadata.to}`);
    expect(transitions).toEqual([
      'draft→ready_for_approval',
      'ready_for_approval→approved',
      'approved→queued',
      'queued→running',
      'running→completed',
    ]);

    // The task moved with it.
    expect((await api().get(`/api/tasks/${taskId}`)).json().task.status).toBe('done');
  }, 60_000);

  it('stops a running job remotely and records that the worker acknowledged it', async () => {
    await launchWorker({ maxRuns: 1 });

    const created = await api().post('/api/runs', {
      taskId,
      jobKind: 'sleep',
      jobParams: { seconds: 60 },
      confidence: 0.95,
    });
    const runId = created.json().run.id;
    await api().post(`/api/runs/${runId}/submit`);
    await api().post(`/api/runs/${runId}/approve`, { notes: 'Start it.' });

    // Wait until the job is genuinely in flight, not merely dispatched.
    await waitForRunStatus(runId, (run) => run.status === 'running' && run.progressStage === 'sleeping');

    const cancelled = await api().post(`/api/runs/${runId}/cancel`, { reason: 'Operator changed their mind.' });
    // The run is not terminal yet: the trail must show the worker actually
    // stopped, not merely that a stop was requested.
    expect(cancelled.json().run.status).toBe('running');
    expect(cancelled.json().run.cancelRequestedAt).not.toBeNull();

    const final = await waitForRunStatus(runId, (run) => run.status === 'cancelled');
    expect(final.stopReason).toBe('cancelled_by_user');
    // A 60s sleep that stopped in seconds proves the abort actually propagated.
    const elapsed = new Date(final.completedAt as string).getTime() - new Date(final.startedAt as string).getTime();
    expect(elapsed).toBeLessThan(30_000);

    const logs = (await api().get(`/api/runs/${runId}/logs`)).json().logs;
    const messages = logs.map((l: { message: string }) => l.message);
    expect(messages.some((m: string) => m.includes('Stop requested'))).toBe(true);
    expect(messages.some((m: string) => m.includes('Job aborted'))).toBe(true);

    const types = (await auditTrailForRun(runId)).map((e) => e.eventType);
    expect(types).toContain('run.cancel_requested');
    expect(types).toContain('run.cancelled');
    expect(types).not.toContain('run.completed');
  }, 60_000);

  it('records a failing job as failed, with its output preserved', async () => {
    await launchWorker({ maxRuns: 1 });

    const created = await api().post('/api/runs', {
      taskId,
      jobKind: 'fail',
      jobParams: { message: 'simulated build failure' },
      confidence: 0.9,
    });
    const runId = created.json().run.id;
    await api().post(`/api/runs/${runId}/submit`);
    await api().post(`/api/runs/${runId}/approve`, { notes: 'Testing the failure path.' });

    const final = await waitForRunStatus(runId, (run) => run.status === 'failed');
    expect(final.stopReason).toBe('failed');
    expect(final.summary).toContain('simulated build failure');

    const logs = (await api().get(`/api/runs/${runId}/logs`)).json().logs;
    expect(logs.some((l: { stream: string }) => l.stream === 'stderr')).toBe(true);

    // A failure must be recorded as a failure, never dressed up as completion.
    const types = (await auditTrailForRun(runId)).map((e) => e.eventType);
    expect(types).toContain('run.failed');
    expect(types).not.toContain('run.completed');

    expect((await api().get(`/api/tasks/${taskId}`)).json().task.status).toBe('blocked');
  }, 60_000);

  it('reuses its stored identity across a restart instead of re-enrolling', async () => {
    const first = await launchWorker();
    const stateFile = path.join(stateDir, 'persistent-worker.json');

    await first.stop();

    // Restarting with no enrollment token at all: it must work purely from the
    // persisted credential, because a VM reboot must not need a human.
    const enrollment = await createEnrollmentToken({ label: 'persist', expiresInHours: 1 }, SYSTEM_ACTOR);
    const config: WorkerConfig = {
      controlPlaneUrl: baseUrl,
      enrollmentToken: enrollment.token!,
      name: 'persistent-worker',
      stateFile,
      workspace: path.join(stateDir, 'workspace'),
      heartbeatSeconds: 1,
      logLevel: 'silent',
    };

    const initial = await startWorker({ config, logger: silentLogger, leaseWaitSeconds: 1, retryBaseMs: 50 });
    workers.push(initial);
    const originalId = initial.state.workerId;
    await initial.stop();

    const restarted = await startWorker({
      config: { ...config, enrollmentToken: undefined },
      logger: silentLogger,
      leaseWaitSeconds: 1,
      retryBaseMs: 50,
    });
    workers.push(restarted);

    expect(restarted.state.workerId).toBe(originalId);
    expect(restarted.state.workerToken).toBe(initial.state.workerToken);
    await restarted.stop();
  }, 60_000);

  it('executes the workspace check against the real filesystem', async () => {
    await launchWorker({ maxRuns: 1 });

    const created = await api().post('/api/runs', {
      taskId,
      jobKind: 'workspace_check',
      jobParams: {},
      confidence: 0.99,
    });
    const runId = created.json().run.id;
    await api().post(`/api/runs/${runId}/submit`);
    await api().post(`/api/runs/${runId}/approve`, { notes: 'Check the VM workspace.' });

    const final = await waitForRunStatus(runId, (run) => run.status === 'completed');
    expect(final.summary).toContain('writable');

    const logs = (await api().get(`/api/runs/${runId}/logs`)).json().logs;
    expect(logs.some((l: { message: string }) => l.message.includes('workspace: writable.'))).toBe(true);

    // And the directory really was created on disk.
    const stats = await fs.stat(path.join(stateDir, 'workspace'));
    expect(stats.isDirectory()).toBe(true);
  }, 60_000);
});
