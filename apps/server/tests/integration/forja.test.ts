import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { FORJA_CONTRACT_VERSION, FORJA_KEY_PREFIX, type ForjaScope } from '@mac/protocol';
import { db } from '../../src/db/client.js';
import { approvalRequests, forjaClients, macEvents } from '../../src/db/schema.js';
import { PAC_ACTORS } from '../../src/domain/agent-registry.js';
import { createForjaClient, signWebhook, verifyWebhookSignature } from '../../src/services/forja.js';
import { updateSettings } from '../../src/services/settings.js';
import { SYSTEM_ACTOR } from '../../src/services/audit.js';
import { asUser, closePool, createAndLogin, ensureMigrated, resetDatabase, startTestApp, type Session } from '../helpers/harness.js';
import { makeProject } from '../helpers/fixtures.js';

/**
 * The Forja orchestration contract (Phase 4 Part D, Acceptance Case 4).
 *
 * Driven by a TEST CLIENT through the real HTTP surface, which is what the
 * phase brief asks for: Forja → task creation → discovery → approval →
 * execution status → artefact retrieval, without building Forja.
 */

let app: FastifyInstance;
let close: () => Promise<void>;
let admin: Session;
let apiKey: string;
let webhookSecret: string;

beforeAll(async () => {
  await ensureMigrated();
  const started = await startTestApp();
  app = started.fastify;
  close = started.close;
});

afterAll(async () => {
  await close();
  await closePool();
});

beforeEach(async () => {
  await resetDatabase();
  admin = await createAndLogin(app, { email: 'admin@pac.test', role: 'admin' });
  await updateSettings({ forjaEnabled: true }, { type: 'user', id: admin.user.id, label: admin.user.name });

  const issued = await createForjaClient(
    { name: 'Forja (test)', scopes: ['read', 'write', 'approve', 'events'] },
    SYSTEM_ACTOR,
  );
  apiKey = issued.apiKey;
  webhookSecret = issued.webhookSecret;
});

/** The test client. Nothing here knows anything about Mac's internals. */
const forja = (key = apiKey) => ({
  get: (url: string) => app.inject({ method: 'GET', url, headers: { 'x-forja-key': key } }),
  post: (url: string, payload?: unknown) =>
    app.inject({ method: 'POST', url, headers: { 'x-forja-key': key }, payload: payload as never }),
});

// ---------------------------------------------------------------------------

describe('authentication', () => {
  it('refuses a request with no key', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/forja/agents' });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a key that is not recognised', async () => {
    const response = await forja(`${FORJA_KEY_PREFIX}definitely-not-a-real-key`).get('/api/forja/agents');
    expect(response.statusCode).toBe(401);
  });

  it('refuses a revoked key', async () => {
    await db.update(forjaClients).set({ isActive: false }).where(eq(forjaClients.name, 'Forja (test)'));
    expect((await forja().get('/api/forja/agents')).statusCode).toBe(401);
  });

  it('refuses everything when the integration is switched off', async () => {
    await updateSettings({ forjaEnabled: false }, { type: 'user', id: admin.user.id, label: admin.user.name });
    expect((await forja().get('/api/forja/agents')).statusCode).toBe(403);
  });

  it('enforces scopes', async () => {
    const readOnly = await createForjaClient({ name: 'Read only', scopes: ['read'] }, SYSTEM_ACTOR);

    const project = await makeProject(app, admin, { repoUrl: null });
    const response = await forja(readOnly.apiKey).post('/api/forja/tasks', {
      onBehalfOf: 'admin@pac.test',
      projectId: project.id,
      title: 'Something',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toMatch(/does not hold the "write" scope/);
  });

  it('cannot be used on the human plane', async () => {
    // The planes do not overlap: a Forja key is not a session cookie.
    const response = await app.inject({ method: 'GET', url: '/api/tasks', headers: { 'x-forja-key': apiKey } });
    expect(response.statusCode).toBe(401);
  });

  it('stores only the hash of a key', async () => {
    const [row] = await db.select().from(forjaClients).where(eq(forjaClients.name, 'Forja (test)'));
    expect(row!.keyHash).not.toBe(apiKey);
    expect(row!.keyHash).toHaveLength(64);
    // The display prefix is enough to identify it and useless as a credential.
    expect(apiKey.startsWith(row!.keyPrefix)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('Forja is a platform, not an agent', () => {
  it('never appears in the agents it orchestrates', async () => {
    const response = await forja().get('/api/forja/agents');
    const agents = response.json().agents as Array<{ key: string; name: string }>;

    expect(agents.map((a) => a.key)).toContain('mac');
    // The assertion this whole file exists to hold. A platform enumerating the
    // agents it orchestrates should not find itself among them.
    expect(agents.map((a) => a.key)).not.toContain('forja');
  });

  it('is typed as a platform in the registry, and is not assignable', async () => {
    const forjaActor = PAC_ACTORS.find((a) => a.key === 'forja');

    expect(forjaActor?.kind).toBe('platform');
    expect(forjaActor?.assignable).toBe(false);
    expect(forjaActor?.summary).toMatch(/Not an agent, not an employee/i);
  });
});

// ---------------------------------------------------------------------------

describe('every write names a person', () => {
  it('refuses a write for somebody Mac does not recognise', async () => {
    const project = await makeProject(app, admin, { repoUrl: null });

    const response = await forja().post('/api/forja/tasks', {
      onBehalfOf: 'a.stranger@example.com',
      projectId: project.id,
      title: 'Investigate something',
    });

    // Not degraded to a system actor: "Forja did it" is not an answer to "who
    // approved this?", and an integration that cannot name its user has not
    // been finished.
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toMatch(/not an active Mac user/);
  });

  it('records the person, not the platform, on an approval', async () => {
    const project = await makeProject(app, admin, { repoUrl: null });

    const created = await forja().post('/api/forja/tasks', {
      onBehalfOf: 'admin@pac.test',
      projectId: project.id,
      title: 'Investigate the aeration control strategy',
      description: 'Work out whether to replace or migrate.',
      taskKind: 'investigation',
      startDiscovery: false,
    });
    const taskId = created.json().task.id;

    const approval = await forja().post('/api/forja/approvals', {
      onBehalfOf: 'admin@pac.test',
      taskId,
      title: 'Accept the brief',
      detail: 'Detail.',
    });
    const approvalId = approval.json().approval.id;

    const decided = await forja().post(`/api/forja/approvals/${approvalId}/decision`, {
      onBehalfOf: 'admin@pac.test',
      decision: 'approve',
      notes: 'Go ahead.',
    });

    expect(decided.statusCode).toBe(200);

    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, approvalId));
    expect(row!.state).toBe('approved');
    expect(row!.decidedViaChannel).toBe('forja');
    // The human's own id, not a placeholder.
    expect(row!.decidedByUserId).toBe(admin.user.id);
  });

  it('applies the same authority deny list as every other channel', async () => {
    const project = await makeProject(app, admin, { repoUrl: null });
    const created = await forja().post('/api/forja/tasks', {
      onBehalfOf: 'admin@pac.test',
      projectId: project.id,
      title: 'Release',
      startDiscovery: false,
    });

    const { createApprovalRequest } = await import('../../src/services/approval-requests.js');
    const request = await createApprovalRequest(
      {
        taskId: created.json().task.id,
        subjectKind: 'action',
        subjectVersion: 0,
        title: 'Deploy to the customer SCADA',
        detail: '',
        recommendation: '',
        risk: 'high',
        authority: 'deploy_live_system',
      },
      SYSTEM_ACTOR,
    );

    const decided = await forja().post(`/api/forja/approvals/${request.id}/decision`, {
      onBehalfOf: 'admin@pac.test',
      decision: 'approve',
    });

    // Spec §16 is not a property of the web UI. It is a property of Mac.
    expect(decided.statusCode).toBe(403);
    expect(decided.json().error.message).toMatch(/hard V1 prohibition/i);
  });
});

// ---------------------------------------------------------------------------

describe('Acceptance Case 4 — the full contract', () => {
  it('drives task creation, discovery, brief, approval, run status and artefacts', async () => {
    const project = await makeProject(app, admin, { name: 'Forja Pilot', repoUrl: null });

    // 1. Forja creates a task and starts discovery.
    const created = await forja().post('/api/forja/tasks', {
      onBehalfOf: 'admin@pac.test',
      projectId: project.id,
      title: 'Investigate whether to replace or migrate the S7-300',
      description: 'We need a recommendation with a rough cost.',
      taskKind: 'investigation',
      startDiscovery: true,
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().contractVersion).toBe(FORJA_CONTRACT_VERSION);
    const taskId = created.json().task.id as string;
    expect(created.json().discoverySessionId).toBeTruthy();

    // 2. Forja reads the discovery state.
    const discovery = await forja().get(`/api/forja/tasks/${taskId}/discovery`);
    expect(discovery.json().discovery.sessionId).toBeTruthy();

    // 3. Forja answers into discovery, and Mac produces a brief.
    const answered = await forja().post(`/api/forja/tasks/${taskId}/discovery`, {
      onBehalfOf: 'admin@pac.test',
      message:
        'The outcome we want is a costed recommendation covering replacement and incremental migration, ' +
        'with the risks of each. Constraint: the plant cannot be stopped for more than four hours.',
    });

    expect(answered.statusCode).toBe(200);
    const briefId = answered.json().brief.id as string;
    expect(answered.json().brief.confidence).toBeGreaterThan(0);

    // 4. The brief exposes machine-checkable criteria, which is what completion
    //    will be judged against.
    const brief = await forja().get(`/api/forja/briefs/${briefId}`);
    expect(Array.isArray(brief.json().brief.structuredAcceptance)).toBe(true);
    expect(brief.json().brief.structuredAcceptance.length).toBeGreaterThan(0);

    // 5. Forja requests an approval and decides it, on behalf of a person.
    const approval = await forja().post('/api/forja/approvals', {
      onBehalfOf: 'admin@pac.test',
      taskId,
      briefId,
      title: 'Accept the brief and proceed',
      detail: 'The brief is complete enough.',
    });
    const approvalId = approval.json().approval.id as string;
    expect(approval.json().approval.code).toMatch(/^AP-/);

    const decided = await forja().post(`/api/forja/approvals/${approvalId}/decision`, {
      onBehalfOf: 'admin@pac.test',
      decision: 'approve',
    });
    expect(decided.json().approval.state).toBe('approved');

    // 6. Run status and artefacts are readable. Both are empty here — no worker
    //    is running — and an empty list is the honest answer rather than an error.
    expect((await forja().get(`/api/forja/tasks/${taskId}/runs`)).json().runs).toEqual([]);
    expect((await forja().get(`/api/forja/artefacts?taskId=${taskId}`)).json().artefacts).toEqual([]);

    // 7. Blockers.
    expect((await forja().get('/api/forja/blockers')).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------

describe('the event stream', () => {
  it('reports events after a cursor, in sequence order', async () => {
    const head = (await forja().get('/api/forja/events/head')).json().cursor as number;

    const project = await makeProject(app, admin, { repoUrl: null });
    await forja().post('/api/forja/tasks', {
      onBehalfOf: 'admin@pac.test',
      projectId: project.id,
      title: 'Something to emit an event about',
      startDiscovery: false,
    });

    const page = await forja().get(`/api/forja/events?after=${head}&limit=50`);
    const events = page.json().events as Array<{ seq: number; type: string }>;

    expect(events.length).toBeGreaterThan(0);
    expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => a - b));
    expect(page.json().cursor).toBe(events[events.length - 1]!.seq);
  });

  it('filters by type server-side', async () => {
    const head = (await forja().get('/api/forja/events/head')).json().cursor as number;

    const project = await makeProject(app, admin, { repoUrl: null });
    const created = await forja().post('/api/forja/tasks', {
      onBehalfOf: 'admin@pac.test',
      projectId: project.id,
      title: 'Emit some events',
      startDiscovery: false,
    });

    await forja().post('/api/forja/approvals', {
      onBehalfOf: 'admin@pac.test',
      taskId: created.json().task.id,
      title: 'Decide something',
      detail: '',
    });

    const filtered = await forja().get(`/api/forja/events?after=${head}&types=approval_required`);
    const events = filtered.json().events as Array<{ type: string }>;

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.type === 'approval_required')).toBe(true);
  });

  it('does not move the cursor when nothing arrived', async () => {
    // A long poll that times out has to be safely repeatable with the same
    // value, or a consumer skips whatever lands next.
    const head = (await forja().get('/api/forja/events/head')).json().cursor as number;
    const page = await forja().get(`/api/forja/events?after=${head}`);

    expect(page.json().events).toEqual([]);
    expect(page.json().cursor).toBe(head);
  });

  it('keeps the log append-only', async () => {
    const project = await makeProject(app, admin, { repoUrl: null });
    await forja().post('/api/forja/tasks', {
      onBehalfOf: 'admin@pac.test',
      projectId: project.id,
      title: 'One event please',
      startDiscovery: false,
    });

    // An event stream a consumer can be caught up on is only useful if nothing
    // rewrites history behind them.
    await expect(db.update(macEvents).set({ type: 'run_completed' })).rejects.toThrow(/append-only/i);
  });
});

// ---------------------------------------------------------------------------

describe('webhook signatures', () => {
  it('signs the timestamp together with the body', () => {
    const body = JSON.stringify({ seq: 1, type: 'task_created' });
    const timestamp = '2026-08-19T10:00:00.000Z';
    const signature = signWebhook(webhookSecret, timestamp, body);

    expect(verifyWebhookSignature({ secret: webhookSecret, timestamp, body, signature })).toBe(true);

    /*
     * The timestamp is INSIDE the signed material, so a captured delivery
     * cannot be replayed later against a receiver that only checks the
     * signature. Changing it must invalidate the signature.
     */
    expect(
      verifyWebhookSignature({
        secret: webhookSecret,
        timestamp: '2026-08-26T10:00:00.000Z',
        body,
        signature,
      }),
    ).toBe(false);

    expect(verifyWebhookSignature({ secret: 'wrong-secret', timestamp, body, signature })).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('the published contract is narrower than the internal one', () => {
  it('never exposes the requester’s own confidence estimate', async () => {
    const project = await makeProject(app, admin, { repoUrl: null });
    const created = await forja().post('/api/forja/tasks', {
      onBehalfOf: 'admin@pac.test',
      projectId: project.id,
      title: 'Check the projection',
      startDiscovery: false,
    });

    /*
     * `tasks.user_initial_confidence` exists and is deliberately absent here.
     * Two numbers under one word is how the second quietly becomes the first,
     * and a published contract is the worst place for that to happen.
     */
    const task = created.json().task as Record<string, unknown>;
    expect(task).not.toHaveProperty('userInitialConfidence');
    expect(task).toHaveProperty('understandingConfidence');
  });

  it('stamps every response with the contract version', async () => {
    for (const url of ['/api/forja/agents', '/api/forja/projects', '/api/forja/blockers']) {
      expect((await forja().get(url)).json().contractVersion, url).toBe(FORJA_CONTRACT_VERSION);
    }
  });
});
