import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { JOB_KINDS } from '@mac/protocol';
import {
  asUser,
  asWorker,
  closePool,
  createAndLogin,
  resetDatabase,
  startTestApp,
  type Session,
} from '../helpers/harness.js';
import { makeApprovedRun, makeProject, makeTask, registerTestWorker } from '../helpers/fixtures.js';
import { db } from '../../src/db/client.js';
import { runs } from '../../src/db/schema.js';
import { queryAuditEvents } from '../../src/services/audit-query.js';
import { stopRunsPastOvernightCutoff } from '../../src/services/runs.js';
import { getSettings } from '../../src/services/settings.js';

let app: FastifyInstance;
let close: () => Promise<void>;
let admin: Session;
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
  admin = await createAndLogin(app, { email: 'admin@pac.test', name: 'Ada Min', role: 'admin' });
  const project = await makeProject(app, admin);
  taskId = (await makeTask(app, admin, project.id)).id;
});

const api = () => asUser(app, admin);
const lease = (token: string) =>
  asWorker(app, token).post('/api/worker/lease', { waitSeconds: 0, capabilities: [...JOB_KINDS] });

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('settings', () => {
  it('exposes the documented Sprint 1 defaults', async () => {
    const settings = (await api().get('/api/settings')).json().settings;
    expect(settings.timezone).toBe('Australia/Sydney');
    expect(settings.overnightCutoff).toBe('08:00');
    expect(settings.minExecutionConfidence).toBe(0.6);
    expect(settings.defaultConfidenceThreshold).toBe(0.8);
    expect(settings.nightlyBudgetCents).toBe(5000);
    expect(settings.currency).toBe('AUD');
  });

  it('accepts a valid change and audits exactly what moved', async () => {
    const response = await api().patch('/api/settings', {
      timezone: 'Australia/Perth',
      overnightCutoff: '06:30',
      nightlyBudgetCents: 12_000,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().settings.overnightCutoff).toBe('06:30');

    const events = await queryAuditEvents({ eventType: 'settings.updated', limit: 5, offset: 0 });
    const changes = events[0]!.metadata.changes as Record<string, { from: unknown; to: unknown }>;
    expect(changes.overnightCutoff).toEqual({ from: '08:00', to: '06:30' });
    expect(changes.nightlyBudgetCents).toEqual({ from: 5000, to: 12_000 });
  });

  it('rejects a malformed cutoff', async () => {
    for (const overnightCutoff of ['8:00', '24:00', '08:60', 'morning']) {
      const response = await api().patch('/api/settings', { overnightCutoff });
      expect(response.statusCode, overnightCutoff).toBe(400);
    }
  });

  it('rejects an unknown timezone', async () => {
    const response = await api().patch('/api/settings', { timezone: 'Mars/Olympus_Mons' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_TIMEZONE');
  });

  it('rejects a confidence policy where the floor exceeds the threshold', async () => {
    const response = await api().patch('/api/settings', {
      minExecutionConfidence: 0.95,
      defaultConfidenceThreshold: 0.7,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_CONFIDENCE_POLICY');
  });

  it('rejects unknown settings keys rather than silently ignoring them', async () => {
    const response = await api().patch('/api/settings', { autoMergeToMain: true });
    expect(response.statusCode).toBe(400);
  });

  it('makes the confidence thresholds genuinely configurable', async () => {
    // Spec §5 requires these to be configurable; prove that reconfiguring them
    // actually changes what the approval guardrail permits.
    await api().patch('/api/settings', { minExecutionConfidence: 0.3, defaultConfidenceThreshold: 0.4 });

    const create = await api().post('/api/runs', { taskId, jobKind: 'noop', jobParams: {}, confidence: 0.5 });
    const runId = create.json().run.id;
    await api().post(`/api/runs/${runId}/submit`);

    // 0.5 would have been below the default 0.6 floor; under the new policy it
    // is above the threshold and approves without ceremony.
    const approved = await api().post(`/api/runs/${runId}/approve`, {});
    expect(approved.statusCode).toBe(200);
    expect(approved.json().run.status).toBe('queued');
  });
});

// ---------------------------------------------------------------------------
// Overnight cutoff
// ---------------------------------------------------------------------------

describe('overnight cutoff', () => {
  it('gives an overnight run a resolved deadline when it is queued', async () => {
    const run = await makeApprovedRun(app, admin, taskId, { executionMode: 'overnight' });
    const detail = (await api().get(`/api/runs/${run.id}`)).json().run;

    expect(detail.executionMode).toBe('overnight');
    expect(detail.overnightDeadlineAt).not.toBeNull();

    // The deadline must be the next 08:00 Sydney, i.e. within 24 hours.
    const deadline = new Date(detail.overnightDeadlineAt).getTime();
    expect(deadline).toBeGreaterThan(Date.now());
    expect(deadline - Date.now()).toBeLessThanOrEqual(25 * 60 * 60 * 1000);

    const sydneyHour = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Australia/Sydney',
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(deadline));
    expect(sydneyHour).toBe('08:00');
  });

  it('leaves an interactive run with no deadline', async () => {
    // Spec §3 permits explicitly authorised daytime execution; applying the
    // overnight cutoff to it would forbid exactly that.
    const run = await makeApprovedRun(app, admin, taskId, { executionMode: 'interactive' });
    const detail = (await api().get(`/api/runs/${run.id}`)).json().run;
    expect(detail.overnightDeadlineAt).toBeNull();
  });

  it('refuses to dispatch an overnight run whose cutoff has passed', async () => {
    const worker = await registerTestWorker(app);
    const run = await makeApprovedRun(app, admin, taskId, { executionMode: 'overnight' });

    await db
      .update(runs)
      .set({ overnightDeadlineAt: new Date(Date.now() - 60_000) })
      .where(eq(runs.id, run.id));

    expect((await lease(worker.token)).json().assignment).toBeNull();
  });

  it('stops a running overnight run when the cutoff passes', async () => {
    const worker = await registerTestWorker(app);
    const run = await makeApprovedRun(app, admin, taskId, {
      jobKind: 'sleep',
      jobParams: { seconds: 120 },
      executionMode: 'overnight',
    });
    await lease(worker.token);

    await db
      .update(runs)
      .set({ overnightDeadlineAt: new Date(Date.now() - 1000) })
      .where(eq(runs.id, run.id));

    const stopped = await stopRunsPastOvernightCutoff(new Date());
    expect(stopped).toEqual([run.id]);

    // The stop is propagated, not applied unilaterally: the worker is told.
    const control = (await asWorker(app, worker.token).post('/api/worker/heartbeat', {
      status: 'busy',
      currentRunId: run.id,
    })).json().control;
    expect(control.cancelRequested).toBe(true);
    expect(control.cancelReason).toBe('overnight_cutoff');

    const completed = await asWorker(app, worker.token).post(`/api/worker/runs/${run.id}/complete`, {
      outcome: 'cancelled',
    });
    // A guardrail stop is NOT an ordinary cancellation: the worker reports
    // "cancelled" but the control plane knows why and records it accordingly.
    expect(completed.json().runStatus).toBe('stopped_by_guardrail');

    const detail = (await api().get(`/api/runs/${run.id}`)).json().run;
    expect(detail.status).toBe('stopped_by_guardrail');
    expect(detail.stopReason).toBe('overnight_cutoff');

    const events = await queryAuditEvents({ runId: run.id, eventType: 'run.stopped_by_guardrail', limit: 5, offset: 0 });
    expect(events).toHaveLength(1);
  });

  it('leaves an interactive run alone when the sweeper runs', async () => {
    const worker = await registerTestWorker(app);
    const run = await makeApprovedRun(app, admin, taskId, { jobKind: 'sleep', jobParams: { seconds: 120 } });
    await lease(worker.token);

    expect(await stopRunsPastOvernightCutoff(new Date())).toEqual([]);
    expect((await api().get(`/api/runs/${run.id}`)).json().run.status).toBe('running');
  });

  it('recomputes the deadline from the configured timezone', async () => {
    await api().patch('/api/settings', { timezone: 'UTC', overnightCutoff: '23:00' });
    const run = await makeApprovedRun(app, admin, taskId, { executionMode: 'overnight' });
    const detail = (await api().get(`/api/runs/${run.id}`)).json().run;

    const utcTime = new Date(detail.overnightDeadlineAt).toISOString().slice(11, 16);
    expect(utcTime).toBe('23:00');
  });
});

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

describe('budget', () => {
  it('reports the configured budget and admits it has no provider usage', async () => {
    const budget = (await api().get('/api/budget')).json().budget;

    expect(budget.nightlyBudgetCents).toBe(5000);
    expect(budget.currency).toBe('AUD');
    expect(budget.warningThresholdCents).toBe(4000);
    expect(budget.stopThresholdCents).toBe(5000);
    expect(budget.recordedSpendCents).toBe(0);
    // Spec §25: never present an estimate as exact provider usage.
    expect(budget.providerUsageAvailable).toBe(false);
  });

  it('reports a night window aligned to the configured cutoff', async () => {
    const settings = await getSettings();
    const budget = (await api().get('/api/budget')).json().budget;

    const start = new Date(budget.windowStart);
    const end = new Date(budget.windowEnd);
    expect(start.getTime()).toBeLessThanOrEqual(Date.now());
    expect(end.getTime()).toBeGreaterThan(Date.now());

    const startWallClock = new Intl.DateTimeFormat('en-GB', {
      timeZone: settings.timezone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).format(start);
    expect(startWallClock).toBe(settings.overnightCutoff);
  });
});

// ---------------------------------------------------------------------------
// Schema parity — a guard against the hand-written SQL drifting from the code
// ---------------------------------------------------------------------------

describe('schema parity', () => {
  it('keeps every enum CHECK constraint in step with @mac/protocol', async () => {
    // The migrations are hand-written SQL, so the enum lists are duplicated
    // between the schema and the protocol package by necessity. This test is
    // what makes that duplication safe: add a value to one and it fails here.
    const { ENUM_CHECKS } = await import('../../src/db/schema.js');

    const { rows } = (await db.execute(sql`
      SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE contype = 'c'
    `)) as unknown as { rows: Array<{ conname: string; definition: string }> };

    for (const { table, column, values } of ENUM_CHECKS) {
      const constraint = rows.find((r) => r.conname === `${table}_${column}_check`);
      expect(constraint, `missing CHECK constraint ${table}_${column}_check`).toBeDefined();

      for (const value of values) {
        expect(
          constraint!.definition.includes(`'${value}'`),
          `${table}.${column} CHECK is missing '${value}' — the migration and @mac/protocol have drifted`,
        ).toBe(true);
      }
    }
  });

  it('keeps the audit-immutability triggers installed', async () => {
    const { rows } = (await db.execute(sql`
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'audit_events'::regclass AND NOT tgisinternal
    `)) as unknown as { rows: Array<{ tgname: string }> };

    const names = rows.map((r) => r.tgname);
    expect(names).toContain('audit_events_no_update_or_delete');
    expect(names).toContain('audit_events_no_truncate');
  });
});
