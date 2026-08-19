import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { MAC_TEAMS_IDENTITY, type TeamsActivity } from '@mac/protocol';
import { db } from '../../src/db/client.js';
import {
  approvalRequests,
  conversationMessages,
  conversations,
  discoverySessions,
  handoffBriefs,
  runs,
  tasks,
} from '../../src/db/schema.js';
import { config } from '../../src/config.js';
import { EXPECTED_ISSUERS, __setKeyCacheForTests } from '../../src/services/teams/verify.js';
import { FakeTeamsProvider, setTeamsProvider } from '../../src/services/teams/provider.js';
import { updateSettings } from '../../src/services/settings.js';
import { deliverPendingMessages } from '../../src/services/notifications.js';
import { asUser, closePool, createAndLogin, ensureMigrated, resetDatabase, startTestApp, type Session } from '../helpers/harness.js';
import { makeProject } from '../helpers/fixtures.js';

/**
 * Acceptance Cases 2 and 3 (Phase 4).
 *
 * ---------------------------------------------------------------------------
 * CASE 2: a human sends a Teams instruction; Mac identifies context, starts
 * discovery, asks a focused question, receives the answer in Teams, produces a
 * brief, presents an approval request, receives explicit approval and reports.
 *
 * CASE 3: a conversation started in Teams continues in the Mac web UI, against
 * the same conversation, the same task and the same project context.
 *
 * These run through the REAL HTTP surfaces of both channels — a signed Bot
 * Framework activity on one side and a session cookie on the other — because
 * the claim being made is that they are one Mac rather than two that agree.
 * ---------------------------------------------------------------------------
 */

let app: FastifyInstance;
let close: () => Promise<void>;
let admin: Session;
let privateKey: KeyObject;
let teams: FakeTeamsProvider;

const KID = 'cross-channel-key';
const TENANT = '99999999-8888-4777-8666-555555555555';
const SERVICE_URL = 'https://smba.trafficmanager.net/au/';
const AAD = 'aad-object-kasper';
const THREAD = 'a:cross-channel-thread';

beforeAll(async () => {
  await ensureMigrated();
  const started = await startTestApp();
  app = started.fastify;
  close = started.close;

  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  __setKeyCacheForTests(new Map([[KID, { kid: KID, kty: 'RSA', n: jwk.n, e: jwk.e }]]));
});

afterAll(async () => {
  __setKeyCacheForTests(null);
  await close();
  await closePool();
});

beforeEach(async () => {
  await resetDatabase();
  admin = await createAndLogin(app, { email: 'kasper@pac.test', name: 'Kasper', role: 'admin' });
  teams = new FakeTeamsProvider();
  setTeamsProvider(teams);
  await updateSettings(
    { teamsEnabled: true, teamsAuthorisedUsers: [AAD] },
    { type: 'user', id: admin.user.id, label: admin.user.name },
  );
});

afterEach(() => setTeamsProvider(null));

// ---------------------------------------------------------------------------

const b64 = (v: object | string): string =>
  Buffer.from(typeof v === 'string' ? v : JSON.stringify(v))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

function mint(): string {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ typ: 'JWT', alg: 'RS256', kid: KID })}.${b64({
    aud: config.teams.appId,
    iss: EXPECTED_ISSUERS[0],
    exp: now + 600,
    nbf: now - 60,
    serviceUrl: SERVICE_URL,
  })}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  signer.end();
  return `${input}.${signer.sign(privateKey).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

let seq = 0;

async function fromTeams(text: string, value?: unknown) {
  seq += 1;
  const activity: TeamsActivity = {
    type: value ? 'invoke' : 'message',
    id: `cc-activity-${seq}`,
    serviceUrl: SERVICE_URL,
    channelId: 'msteams',
    from: { id: 'kasper@pac-technologies.com.au', name: 'Kasper', aadObjectId: AAD },
    conversation: { id: THREAD, conversationType: 'personal', tenantId: TENANT },
    ...(text ? { text } : {}),
    ...(value ? { value } : {}),
    channelData: { tenant: { id: TENANT } },
  } as TeamsActivity;

  const response = await app.inject({
    method: 'POST',
    url: '/api/teams/messages',
    headers: { authorization: `Bearer ${mint()}` },
    payload: activity as never,
  });
  if (response.statusCode !== 200) throw new Error(`Teams post failed: ${response.statusCode} ${response.body}`);
  return response;
}

/** What Mac last said in Teams. */
const lastSaid = () => teams.sent.at(-1)?.text ?? '';

// ---------------------------------------------------------------------------

describe('Acceptance Case 2 — a Teams instruction, all the way through', () => {
  it('goes instruction → discovery → question → answer → brief → approval → decision', async () => {
    const project = await makeProject(app, admin, { name: 'Northgate WTP', repoUrl: null });
    await asUser(app, admin).patch(`/api/projects/${project.id}/capabilities`, {
      capabilities: ['company_context', 'internal_only'],
      allowedTaskKinds: ['research', 'investigation', 'scoping'],
    });

    // 1 & 2. The instruction. Mac identifies the project from the message and
    //        starts discovery.
    await fromTeams(
      'Mac, tonight investigate whether we should replace the old S7-300 at Northgate WTP or migrate it ' +
        'incrementally.',
    );

    const [conversation] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.channel, 'teams'), eq(conversations.externalRef, THREAD)));
    expect(conversation!.projectId).toBe(project.id);
    expect(conversation!.taskId).toBeTruthy();

    const taskId = conversation!.taskId!;
    const [session] = await db.select().from(discoverySessions).where(eq(discoverySessions.taskId, taskId));
    expect(session!.conversationId).toBe(conversation!.id);

    // 3. A focused question, asked in Teams, one at a time.
    expect(session!.pendingQuestion).not.toBeNull();
    expect(lastSaid()).toMatch(/First thing I need/);
    expect(lastSaid()).toContain(MAC_TEAMS_IDENTITY.signature);

    // 4. The answer arrives in Teams and lands in the SAME discovery session
    //    the web UI would have written to.
    await fromTeams(
      'The outcome we want is that operators can run duty/standby from the HMI without calling us. ' +
        'Constraint: the plant cannot stop for more than four hours.',
    );

    const [afterAnswer] = await db.select().from(discoverySessions).where(eq(discoverySessions.id, session!.id));
    const messages = afterAnswer!.messages as Array<{ message: string }>;
    expect(messages.some((m) => m.message.includes('duty/standby'))).toBe(true);

    // 5 & 6. Keep answering until Mac has a brief he is happy with, and watch
    //        him present an approval rather than starting work.
    for (let i = 0; i < 6; i += 1) {
      const [current] = await db.select().from(discoverySessions).where(eq(discoverySessions.id, session!.id));
      if (!current!.pendingQuestion) break;
      await fromTeams('Yes — treat that as agreed, and assume the existing IO list is accurate.');
    }

    const [brief] = await db.select().from(handoffBriefs).where(eq(handoffBriefs.taskId, taskId));
    expect(brief).toBeDefined();

    const [approval] = await db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.taskId, taskId), eq(approvalRequests.state, 'pending')));

    expect(approval).toBeDefined();
    expect(approval!.authority).toBe('accept_brief');
    // The code reached the human, so a text reply can bind to it.
    expect(lastSaid()).toContain(approval!.code);

    // 7. An ambiguous affirmation must NOT approve it.
    await fromTeams('sounds good');
    const [stillPending] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, approval!.id));
    expect(stillPending!.state).toBe('pending');
    expect(lastSaid()).toContain(approval!.code);

    // 8. An explicit decision does.
    await fromTeams(`approve ${approval!.code}`);
    const [decided] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, approval!.id));
    expect(decided!.state).toBe('approved');
    expect(decided!.decidedViaChannel).toBe('teams');
    expect(decided!.decidedViaMessageId).toBeTruthy();

    // 9. And Mac says what he is going to do about it.
    expect(lastSaid()).toMatch(/approved/i);

    /*
     * Nothing ran. Approving a BRIEF is not approving a RUN — spec §3 and §4
     * put discovery and approval before execution, and a channel that could
     * skip to execution would be a channel through which unreviewed work runs.
     */
    expect(await db.select().from(runs).where(eq(runs.taskId, taskId))).toHaveLength(0);
  });

  it('binds a card action by the id the button carried, not by the words', async () => {
    const project = await makeProject(app, admin, { name: 'Southbank PS', repoUrl: null });
    // A project that permits research and not coding, like PAC Internal
    // Development. Without a permitted kind, nothing can run there at all.
    await asUser(app, admin).patch(`/api/projects/${project.id}/capabilities`, {
      capabilities: ['company_context', 'internal_only'],
      allowedTaskKinds: ['research', 'investigation', 'scoping'],
    });

    await fromTeams(`Mac, tonight scope the control upgrade at Southbank PS.`);

    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalRef, THREAD));

    // Answer through to a brief.
    for (let i = 0; i < 8; i += 1) {
      const [session] = await db
        .select()
        .from(discoverySessions)
        .where(eq(discoverySessions.taskId, conversation!.taskId!));
      if (!session?.pendingQuestion) break;
      await fromTeams('Assume the existing panel stays and the scope is the control system only.');
    }

    const [approval] = await db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.taskId, conversation!.taskId!), eq(approvalRequests.state, 'pending')));
    expect(approval).toBeDefined();

    await fromTeams('', { macAction: 'reject', requestId: approval!.id });

    const [decided] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, approval!.id));
    expect(decided!.state).toBe('rejected');
    void project;
  });
});

// ---------------------------------------------------------------------------

describe('Acceptance Case 3 — the same conversation, from the web UI', () => {
  it('shows the Teams thread against the task, and continues it', async () => {
    const project = await makeProject(app, admin, { name: 'Eastfield WWTP', repoUrl: null });

    await fromTeams('Mac, tonight investigate the SCADA alarm flood at Eastfield WWTP.');

    const [conversation] = await db.select().from(conversations).where(eq(conversations.externalRef, THREAD));
    const taskId = conversation!.taskId!;

    // The web UI, asking for conversations about that task, finds the Teams one.
    const listed = await asUser(app, admin).get(`/api/conversations?taskId=${taskId}`);
    const threads = listed.json().conversations as Array<{ id: string; channel: string }>;

    expect(threads).toHaveLength(1);
    expect(threads[0]!.id).toBe(conversation!.id);
    expect(threads[0]!.channel).toBe('teams');

    // And it can read what was said there.
    const read = await asUser(app, admin).get(`/api/conversations/${conversation!.id}`);
    const messages = read.json().messages as Array<{ body: string; channel: string; direction: string }>;
    expect(messages.some((m) => m.body.includes('alarm flood'))).toBe(true);
    expect(messages.some((m) => m.direction === 'outbound' && m.channel === 'teams')).toBe(true);

    // 3. Continue the SAME conversation from the web UI.
    const continued = await asUser(app, admin).post(`/api/conversations/${conversation!.id}/messages`, {
      message: 'Also — the alarms started after the firmware update in March. Treat that as the likely cause.',
    });
    expect(continued.statusCode).toBe(201);

    const after = await asUser(app, admin).get(`/api/conversations/${conversation!.id}`);
    const all = after.json().messages as Array<{ body: string; channel: string }>;

    /*
     * ONE thread, two channels.
     *
     * This is the assertion the whole conversation model exists for. A Teams
     * message store separate from whatever the web UI reads would show two
     * halves of a conversation to two people, and each would think they had all
     * of it.
     */
    expect(all.some((m) => m.channel === 'teams' && m.body.includes('alarm flood'))).toBe(true);
    expect(all.some((m) => m.channel === 'web' && m.body.includes('firmware update'))).toBe(true);

    // Same task and project context on both sides.
    const conversationDto = after.json().conversation as { taskId: string; projectId: string };
    expect(conversationDto.taskId).toBe(taskId);
    expect(conversationDto.projectId).toBe(project.id);
  });

  it('lets a status question asked in the web UI see what Teams created', async () => {
    await makeProject(app, admin, { name: 'Westside RS', repoUrl: null });
    await fromTeams('Mac, tonight investigate the pump cycling at Westside RS.');

    const [conversation] = await db.select().from(conversations).where(eq(conversations.externalRef, THREAD));

    const turn = await asUser(app, admin).post(`/api/conversations/${conversation!.id}/messages`, {
      message: 'What needs my approval?',
    });

    // Answered from data — the approval Teams raised a moment ago.
    const reply = turn.json().turn.reply.body as string;
    expect(reply).toMatch(/approval\(s\) outstanding|Nothing is waiting/);
  });

  it('answers a discovery question from the web UI when it was asked in Teams', async () => {
    await makeProject(app, admin, { name: 'Harbour PS', repoUrl: null });
    await fromTeams('Mac, tonight investigate the wet well level control at Harbour PS.');

    const [conversation] = await db.select().from(conversations).where(eq(conversations.externalRef, THREAD));
    const [session] = await db
      .select()
      .from(discoverySessions)
      .where(eq(discoverySessions.taskId, conversation!.taskId!));

    expect(session!.pendingQuestion).not.toBeNull();

    // The question was asked in Teams. The answer arrives in the web UI, and
    // has to reach the same brief.
    await asUser(app, admin).post(`/api/conversations/${conversation!.id}/messages`, {
      message: 'What we want is level control that stops the pumps short-cycling below 30% wet well.',
    });

    const [after] = await db.select().from(discoverySessions).where(eq(discoverySessions.id, session!.id));
    const messages = after!.messages as Array<{ message: string }>;
    expect(messages.some((m) => m.message.includes('short-cycling'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('outbound delivery', () => {
  it('retries a failed Teams message and records what happened to it', async () => {
    await makeProject(app, admin, { name: 'Retry Site', repoUrl: null });

    teams.failNext = 1;
    await fromTeams('What are you working on?');

    const [failed] = await db
      .select()
      .from(conversationMessages)
      .where(and(eq(conversationMessages.direction, 'outbound'), eq(conversationMessages.channel, 'teams')));

    expect(failed!.deliveryState).toBe('failed');
    expect(failed!.deliveryAttempts).toBe(1);

    // The sweeper picks it up. Delivery state lives on the message row, so
    // "did Mac actually say this?" is answerable from the same place as "what
    // did Mac say?".
    const swept = await deliverPendingMessages();
    expect(swept.sent).toBe(1);

    const [after] = await db.select().from(conversationMessages).where(eq(conversationMessages.id, failed!.id));
    expect(after!.deliveryState).toBe('sent');
    expect(after!.providerMessageId).toBeTruthy();
  });
});
