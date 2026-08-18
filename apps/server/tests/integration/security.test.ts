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
import { workerTokens, workers } from '../../src/db/schema.js';
import { queryAuditEvents } from '../../src/services/audit-query.js';
import { requestRotationForAgedTokens } from '../../src/services/worker-credentials.js';

/**
 * Worker credential rotation and the sandbox dispatch guardrail (Sprint 3 §4, §3.4).
 *
 * These are the two security debts Sprint 3 exists to repay. Sprint 1 recorded
 * non-rotating worker tokens as R-1; Sprint 2 deferred it as R-2 on the grounds
 * that worker authority had not widened. It has now — the worker runs coding
 * agents — so both are tested here rather than described.
 */

let app: FastifyInstance;
let close: () => Promise<void>;
let admin: Session;
let operator: Session;

beforeAll(async () => {
  ({ fastify: app, close } = await startTestApp());
});

afterAll(async () => {
  await close();
  await closePool();
});

beforeEach(async () => {
  await resetDatabase();
  admin = await createAndLogin(app, { email: 'admin@pac.test', name: 'Admin', role: 'admin' });
  operator = await createAndLogin(app, { email: 'op@pac.test', name: 'Op', role: 'operator' });
});

const asAdmin = () => asUser(app, admin);
const heartbeat = (token: string, extra: Record<string, unknown> = {}) =>
  asWorker(app, token).post('/api/worker/heartbeat', { status: 'idle', currentRunId: null, ...extra });

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

describe('worker credential rotation', () => {
  it('issues a new working token and keeps the old one alive for the overlap window', async () => {
    const worker = await registerTestWorker(app);

    const rotated = await asWorker(app, worker.token).post('/api/worker/rotate-token', { reason: 'worker_initiated' });
    expect(rotated.statusCode).toBe(200);

    const body = rotated.json();
    const next = body.workerToken as string;
    expect(next).not.toBe(worker.token);
    expect(next.startsWith('mac_wk_')).toBe(true);
    expect(body.previousTokenValidForSeconds).toBe(300);

    // The new one works.
    expect((await heartbeat(next)).statusCode).toBe(200);
    /*
     * And so does the old one, for now. That is the entire point of the
     * overlap: a request already in flight when the rotation happened must not
     * fail. It is deliberately short, and the next test proves it ends.
     */
    expect((await heartbeat(worker.token)).statusCode).toBe(200);
  });

  it('stops accepting the old token once the overlap window has passed', async () => {
    const worker = await registerTestWorker(app);
    const next = (await asWorker(app, worker.token).post('/api/worker/rotate-token', {})).json().workerToken as string;

    // Age the superseded token past its window rather than sleeping for it.
    await db.execute(sql`UPDATE worker_tokens SET expires_at = now() - interval '1 second' WHERE status = 'superseded'`);

    expect((await heartbeat(worker.token)).statusCode).toBe(401);
    expect((await heartbeat(next)).statusCode).toBe(200);
  });

  it('audits a rotation, and audits a rejected token as the security signal it is', async () => {
    const worker = await registerTestWorker(app);
    await asWorker(app, worker.token).post('/api/worker/rotate-token', {});
    await db.execute(sql`UPDATE worker_tokens SET expires_at = now() - interval '1 second' WHERE status = 'superseded'`);
    await heartbeat(worker.token);

    const events = await queryAuditEvents({ workerId: worker.workerId, limit: 50, offset: 0 });
    const types = events.map((e) => e.eventType);
    expect(types).toContain('worker.token_rotated');
    expect(types).toContain('worker.token_rejected');

    const rejected = events.find((e) => e.eventType === 'worker.token_rejected')!;
    expect(rejected.metadata.reason).toBe('overlap_window_expired');
  });

  it('rotation over rotation leaves exactly one active token', async () => {
    const worker = await registerTestWorker(app);
    const second = (await asWorker(app, worker.token).post('/api/worker/rotate-token', {})).json().workerToken as string;
    const third = (await asWorker(app, second).post('/api/worker/rotate-token', {})).json().workerToken as string;

    const rows = await db.select().from(workerTokens).where(eq(workerTokens.workerId, worker.workerId));
    expect(rows.filter((r) => r.status === 'active')).toHaveLength(1);
    expect((await heartbeat(third)).statusCode).toBe(200);
  });

  it('never stores a token in plaintext, before or after rotation', async () => {
    const worker = await registerTestWorker(app);
    const next = (await asWorker(app, worker.token).post('/api/worker/rotate-token', {})).json().workerToken as string;

    const rows = await db.select().from(workerTokens).where(eq(workerTokens.workerId, worker.workerId));
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain(worker.token);
    expect(serialised).not.toContain(next);
    for (const row of rows) expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Server-initiated rotation — the "no VM rebuild" requirement
// ---------------------------------------------------------------------------

describe('server-initiated rotation', () => {
  it('asks the worker to rotate through the control envelope, touching nothing on the VM', async () => {
    const worker = await registerTestWorker(app);

    const before = await heartbeat(worker.token);
    expect(before.json().control.rotateTokenRequested).toBe(false);

    const requested = await asAdmin().post(`/api/workers/${worker.workerId}/rotate`, { reason: 'quarterly' });
    expect(requested.statusCode).toBe(200);

    // The existing credential still works: asking for a rotation must not lock
    // out a worker that has not performed it yet.
    const after = await heartbeat(worker.token);
    expect(after.statusCode).toBe(200);
    expect(after.json().control.rotateTokenRequested).toBe(true);

    // The worker obliges, and the flag clears.
    const next = (await asWorker(app, worker.token).post('/api/worker/rotate-token', { reason: 'server_requested' }))
      .json().workerToken as string;
    expect((await heartbeat(next)).json().control.rotateTokenRequested).toBe(false);

    const events = await queryAuditEvents({ workerId: worker.workerId, limit: 50, offset: 0 });
    expect(events.map((e) => e.eventType)).toContain('worker.token_rotation_requested');
  });

  it('flags a credential that has aged past the configured maximum', async () => {
    const worker = await registerTestWorker(app);
    await db.execute(sql`UPDATE worker_tokens SET issued_at = now() - interval '400 hours' WHERE status = 'active'`);

    const flagged = await requestRotationForAgedTokens();
    expect(flagged).toContain(worker.workerId);
    expect((await heartbeat(worker.token)).json().control.rotateTokenRequested).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

describe('revocation', () => {
  it('kills every token immediately, with no grace period', async () => {
    const worker = await registerTestWorker(app);
    const second = (await asWorker(app, worker.token).post('/api/worker/rotate-token', {})).json().workerToken as string;

    const response = await asAdmin().post(`/api/workers/${worker.workerId}/revoke-tokens`, {
      reason: 'Suspected credential leak.',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().revoked).toBeGreaterThanOrEqual(2);

    // Both the current token and the one still inside its overlap window.
    expect((await heartbeat(second)).statusCode).toBe(401);
    expect((await heartbeat(worker.token)).statusCode).toBe(401);
  });

  it('audits the presentation of a revoked token — a leaked credential in use', async () => {
    const worker = await registerTestWorker(app);
    await asAdmin().post(`/api/workers/${worker.workerId}/revoke-tokens`, { reason: 'test' });
    await heartbeat(worker.token);

    const events = await queryAuditEvents({ workerId: worker.workerId, limit: 50, offset: 0 });
    const rejected = events.find((e) => e.eventType === 'worker.token_rejected');
    expect(rejected).toBeDefined();
    expect(rejected!.metadata.reason).toBe('revoked');
  });

  it('lets a revoked worker re-enroll and reconnect', async () => {
    const worker = await registerTestWorker(app, { name: 'vm-rebuild' });
    await asAdmin().post(`/api/workers/${worker.workerId}/revoke-tokens`, { reason: 'rebuild' });
    expect((await heartbeat(worker.token)).statusCode).toBe(401);

    const reissued = await registerTestWorker(app, { name: 'vm-rebuild' });
    expect(reissued.workerId).toBe(worker.workerId);
    expect((await heartbeat(reissued.token)).statusCode).toBe(200);

    // The old credential stays dead: re-enrolment must not resurrect it.
    expect((await heartbeat(worker.token)).statusCode).toBe(401);
  });

  it('is admin-only', async () => {
    const worker = await registerTestWorker(app);
    const asOperator = asUser(app, operator);
    expect((await asOperator.post(`/api/workers/${worker.workerId}/revoke-tokens`, { reason: 'x' })).statusCode).toBe(403);
    expect((await asOperator.post(`/api/workers/${worker.workerId}/rotate`, {})).statusCode).toBe(403);
    expect((await asOperator.get('/api/security')).statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Sandbox attestation and the dispatch guardrail
// ---------------------------------------------------------------------------

describe('sandbox attestation', () => {
  it('records what a worker attests, and audits a change rather than every beat', async () => {
    const worker = await registerTestWorker(app);

    await heartbeat(worker.token, {
      sandbox: { kind: 'bubblewrap', available: true, version: 'bubblewrap 0.8.0', detail: null },
    });
    await heartbeat(worker.token, {
      sandbox: { kind: 'bubblewrap', available: true, version: 'bubblewrap 0.8.0', detail: null },
    });

    const [row] = await db.select().from(workers).where(eq(workers.id, worker.workerId)).limit(1);
    expect(row!.sandboxKind).toBe('bubblewrap');
    expect(row!.sandboxReady).toBe(true);

    const attestations = (await queryAuditEvents({ workerId: worker.workerId, limit: 50, offset: 0 })).filter(
      (e) => e.eventType === 'sandbox.attested',
    );
    // Registration attested once; the second identical heartbeat added nothing.
    expect(attestations.length).toBeLessThanOrEqual(2);
  });

  it('notices within one heartbeat when a sandbox stops working', async () => {
    const worker = await registerTestWorker(app);
    await heartbeat(worker.token, { sandbox: { kind: 'docker', available: true, version: 'docker 27', detail: null } });
    await heartbeat(worker.token, {
      sandbox: { kind: 'docker', available: false, version: null, detail: 'daemon unreachable' },
    });

    const security = (await asAdmin().get('/api/security')).json().security;
    const entry = security.workers.find((w: { workerId: string }) => w.workerId === worker.workerId);
    expect(entry.sandboxReady).toBe(false);
    expect(entry.sandboxDetail).toContain('daemon unreachable');
    expect(entry.codingWorkWithheld).toBe(true);
  });

  it('treats a worker that attests nothing as having no sandbox', async () => {
    const worker = await registerTestWorker(app, { sandbox: null });
    const [row] = await db.select().from(workers).where(eq(workers.id, worker.workerId)).limit(1);
    // Not "unknown, assume fine" — absence of an attestation is an absence of
    // containment, and an older worker must not inherit a better-informed one.
    expect(row!.sandboxReady).toBe(false);
    expect(row!.sandboxKind).toBe('none');
  });
});

describe('the sandbox dispatch guardrail', () => {
  it('withholds coding work from a worker that has not attested containment', async () => {
    const project = await makeProject(app, operator, { name: 'Sandboxed' });
    const task = await makeTask(app, operator, project.id);
    // A plain (non-coding) run, so the rest of the loop is unaffected.
    await makeApprovedRun(app, operator, task.id, { jobKind: 'noop' });

    const worker = await registerTestWorker(app);
    await heartbeat(worker.token, { sandbox: { kind: 'none', available: false, version: null, detail: 'disabled' } });

    // Non-coding work still flows: containment is required for coding sessions,
    // not for everything.
    const lease = await asWorker(app, worker.token).post('/api/worker/lease', {
      waitSeconds: 0,
      capabilities: [...JOB_KINDS],
    });
    expect(lease.statusCode).toBe(200);
    expect(lease.json().assignment).not.toBeNull();
    expect(lease.json().assignment.jobKind).toBe('noop');

    const refusals = (await queryAuditEvents({ workerId: worker.workerId, limit: 50, offset: 0 })).filter(
      (e) => e.eventType === 'sandbox.refused',
    );
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals[0]!.metadata.guardrail).toBe('sandbox');
  });

  it('stops withholding once the sandbox is attested, without touching the run', async () => {
    const project = await makeProject(app, operator, { name: 'Sandboxed 2' });
    const task = await makeTask(app, operator, project.id);
    await makeApprovedRun(app, operator, task.id, { jobKind: 'noop' });

    const worker = await registerTestWorker(app);
    await heartbeat(worker.token, { sandbox: { kind: 'none', available: false, version: null, detail: 'x' } });
    await heartbeat(worker.token, { sandbox: { kind: 'docker', available: true, version: 'docker 27', detail: null } });

    const security = (await asAdmin().get('/api/security')).json().security;
    const entry = security.workers.find((w: { workerId: string }) => w.workerId === worker.workerId);
    expect(entry.codingWorkWithheld).toBe(false);
  });

  it('does not withhold anything when an administrator has turned the requirement off', async () => {
    await asAdmin().patch('/api/settings', { requireSandbox: false });
    const worker = await registerTestWorker(app);
    await heartbeat(worker.token, { sandbox: { kind: 'none', available: false, version: null, detail: 'x' } });

    const security = (await asAdmin().get('/api/security')).json().security;
    const entry = security.workers.find((w: { workerId: string }) => w.workerId === worker.workerId);
    expect(entry.codingWorkWithheld).toBe(false);
    expect(security.requireSandbox).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The Security screen
// ---------------------------------------------------------------------------

describe('the security overview', () => {
  it('shows credential age, status and sandbox state per worker', async () => {
    const worker = await registerTestWorker(app, { name: 'vm-security' });
    await asWorker(app, worker.token).post('/api/worker/rotate-token', {});

    const security = (await asAdmin().get('/api/security')).json().security;
    const entry = security.workers.find((w: { workerId: string }) => w.workerId === worker.workerId);

    expect(entry.workerName).toBe('vm-security');
    expect(entry.activeToken).not.toBeNull();
    expect(entry.activeToken.status).toBe('active');
    expect(entry.activeToken.issuedVia).toBe('rotation');
    expect(entry.activeToken.ageHours).toBeGreaterThanOrEqual(0);
    expect(entry.lastRotatedAt).not.toBeNull();
    expect(entry.tokens.length).toBeGreaterThanOrEqual(2);

    // No plaintext anywhere on the screen.
    expect(JSON.stringify(security)).not.toContain(worker.token);
  });
});
