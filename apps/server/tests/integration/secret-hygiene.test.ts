import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { DEFAULT_MONDAY_STATUS_LABELS } from '@mac/protocol';
import { asUser, closePool, createAndLogin, resetDatabase, startTestApp, type Session } from '../helpers/harness.js';
import { makeProject } from '../helpers/fixtures.js';
import { db } from '../../src/db/client.js';
import { mondayWrites } from '../../src/db/schema.js';
import { queryAuditEvents } from '../../src/services/audit-query.js';
import { MondayGraphqlClient } from '../../src/services/monday/graphql.js';
import { setMondayClient } from '../../src/services/monday/provider.js';
import { GraphMailProvider, setMailProvider } from '../../src/services/mail/provider.js';
import { deliverPendingMondayWrites } from '../../src/services/monday/outbox.js';
import { boardByMondayId } from '../../src/services/monday/boards.js';

/**
 * Secrets stay where they were put (Sprint 3.1 §14).
 *
 * Commissioning asked a plain question — "can any credential reach a log?" — and
 * the honest answer at the time was "probably not". These tests turn that into
 * "no, and here is what fails if that changes".
 *
 * Distinctive sentinel values are used throughout, because the assertion is a
 * substring search over everything the system wrote down, and a realistic-looking
 * token would produce a test that passes by coincidence.
 *
 * This runs in the STANDARD suite. It needs no external service: the failures
 * are injected through the providers' own `fetchImpl` seam.
 */

const MONDAY_TOKEN = 'sentinel-monday-token-fb0c1d2e3f4a5b6c7d8e9f00';
const GRAPH_SECRET = 'sentinel-graph-secret-a1b2c3d4e5f60718293a4b5c';

let app: FastifyInstance;
let close: () => Promise<void>;
let admin: Session;

beforeAll(async () => {
  ({ fastify: app, close } = await startTestApp());
});

afterAll(async () => {
  setMondayClient(null);
  setMailProvider(null);
  await close();
  await closePool();
});

beforeEach(async () => {
  await resetDatabase();
  admin = await createAndLogin(app, { email: 'admin@pac.test', name: 'Admin', role: 'admin' });
});

afterEach(() => {
  setMondayClient(null);
  setMailProvider(null);
});

// ---------------------------------------------------------------------------
// The objects themselves
// ---------------------------------------------------------------------------

describe('a provider does not carry its credential in a readable field', () => {
  it('monday: the token is absent from keys, spreads and JSON', () => {
    const client = new MondayGraphqlClient({ token: MONDAY_TOKEN });

    expect(Object.keys(client)).not.toContain('options');
    expect(JSON.stringify(client)).not.toContain(MONDAY_TOKEN);
    expect(JSON.stringify({ ...client })).not.toContain(MONDAY_TOKEN);
    expect(JSON.stringify(Object.entries(client))).not.toContain(MONDAY_TOKEN);
    // The shape most likely to appear in a hurried log line.
    expect(`${JSON.stringify({ client, note: 'debug' })}`).not.toContain(MONDAY_TOKEN);
  });

  it('graph: the client secret and the bearer token are absent from the same places', async () => {
    const provider = new GraphMailProvider({
      tenantId: 'tenant',
      clientId: 'client',
      clientSecret: GRAPH_SECRET,
      from: 'mac@pac-technologies.com.au',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ access_token: 'sentinel-bearer-token', expires_in: 3600 }), {
          status: 200,
        })) as unknown as typeof fetch,
    });

    // Obtain a token first, so the cached bearer is present when we look.
    await provider.isAvailable();

    expect(Object.keys(provider)).not.toContain('options');
    expect(Object.keys(provider)).not.toContain('token');
    expect(JSON.stringify(provider)).not.toContain(GRAPH_SECRET);
    expect(JSON.stringify(provider)).not.toContain('sentinel-bearer-token');
    expect(JSON.stringify({ ...provider })).not.toContain(GRAPH_SECRET);
  });

  it('graph still exposes the mailbox it sends from, which is not a secret', () => {
    const provider = new GraphMailProvider({
      tenantId: 't',
      clientId: 'c',
      clientSecret: GRAPH_SECRET,
      from: 'mac@pac-technologies.com.au',
    });
    // Useful in a log line, and the one thing that should be readable.
    expect(provider.from).toBe('mac@pac-technologies.com.au');
  });
});

// ---------------------------------------------------------------------------
// What gets written down when something goes wrong
// ---------------------------------------------------------------------------

describe('a failed monday write records the failure without the credential', () => {
  it('keeps the token out of the outbox row and out of the audit trail', async () => {
    /*
     * The realistic leak. An API returns an error, the client puts the response
     * body into an exception, the outbox stores that message and audits it —
     * and if the credential had ever been on that path it is now in two
     * durable, queryable places.
     *
     * The injected response deliberately ECHOES THE TOKEN BACK, which is the
     * worst case a badly behaved provider could produce.
     */
    const client = new MondayGraphqlClient({
      token: MONDAY_TOKEN,
      fetchImpl: (async () =>
        new Response(`{"error":"unauthorised","presented":"${MONDAY_TOKEN}"}`, { status: 401 })) as unknown as typeof fetch,
    });
    setMondayClient(client);

    const project = await makeProject(app, admin, { name: 'Hygiene' });

    const mapped = await asUser(app, admin).post('/api/monday/boards', {
      projectId: project.id,
      boardId: 'board-hygiene',
      name: 'Hygiene board',
      statusColumnId: 'status',
      statusLabels: DEFAULT_MONDAY_STATUS_LABELS,
      startableStatuses: ['Ready for Mac'],
      macUserId: 'mac-1',
    });
    const boardRowId = mapped.json().board.id as string;
    await asUser(app, admin).post(`/api/monday/boards/${boardRowId}/approve`, { approved: true });

    // Queued directly. The enqueue helpers require a synced item linked to a
    // task, and none of that scaffolding is what is under test here — the code
    // path that matters starts at the provider call and ends at the row.
    const board = await boardByMondayId('board-hygiene');
    await db.insert(mondayWrites).values({
      boardRowId: board!.id,
      mondayItemId: 'item-1',
      kind: 'set_status',
      payload: { intent: 'in_progress' },
      status: 'pending',
      nextAttemptAt: new Date(),
    });

    await deliverPendingMondayWrites();

    const [row] = await db.select().from(mondayWrites).where(eq(mondayWrites.mondayItemId, 'item-1'));
    expect(row, 'the write was never queued').toBeDefined();
    expect(row!.status).not.toBe('sent');

    // The error IS recorded — losing it would be its own defect — and the
    // token is not in it.
    expect(row!.lastError, 'the failure was not recorded at all').toBeTruthy();
    expect(row!.lastError).not.toContain(MONDAY_TOKEN);

    const events = await queryAuditEvents({ limit: 200, offset: 0 });
    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain(MONDAY_TOKEN);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// What leaves over HTTP
// ---------------------------------------------------------------------------

describe('no credential leaves the control plane over the API', () => {
  it('the settings response describes the mail provider without the secret', async () => {
    await asUser(app, admin).patch('/api/settings', { mailProvider: 'graph' });
    const response = await asUser(app, admin).get('/api/settings');
    const body = response.body;

    expect(response.statusCode).toBe(200);
    expect(body).toContain('graph');
    for (const forbidden of ['clientSecret', 'client_secret', 'tenantId', 'tenant_id', 'apiToken', 'api_token']) {
      expect(body, `settings exposed ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('the monday board mapping carries column ids, never a credential', async () => {
    const project = await makeProject(app, admin, { name: 'Hygiene 2' });
    const mapped = await asUser(app, admin).post('/api/monday/boards', {
      projectId: project.id,
      boardId: 'board-hygiene-2',
      name: 'Hygiene board 2',
      statusColumnId: 'status',
      statusLabels: DEFAULT_MONDAY_STATUS_LABELS,
    });

    const body = mapped.body;
    expect(body).toContain('statusColumnId');
    for (const forbidden of ['token', 'secret', 'password', 'credential']) {
      expect(body.toLowerCase(), `the board mapping exposed "${forbidden}"`).not.toContain(forbidden);
    }
  });
});
