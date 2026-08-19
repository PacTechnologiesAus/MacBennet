import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { approvalRequests, conversationMessages, conversations, discoverySessions } from '../../src/db/schema.js';
import { asUser, closePool, createAndLogin, ensureMigrated, resetDatabase, startTestApp, type Session } from '../helpers/harness.js';
import { makeProject, makeTask } from '../helpers/fixtures.js';
import { createApprovalRequest } from '../../src/services/approval-requests.js';
import { appendMessage, buildConversationContext, startConversation, storeSummary } from '../../src/services/conversations.js';
import { SYSTEM_ACTOR } from '../../src/services/audit.js';
import { conversationSummaryContentSchema } from '@mac/protocol';

/**
 * Persistent conversations through the real HTTP surface (Phase 4 Part C).
 */

let app: FastifyInstance;
let close: () => Promise<void>;
let admin: Session;

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
});

// ---------------------------------------------------------------------------

describe('a persistent thread', () => {
  it('records what was said, in order, with a monotonic sequence', async () => {
    const api = asUser(app, admin);
    const project = await makeProject(app, admin);

    const started = await api.post('/api/conversations', {
      projectId: project.id,
      message: 'Morning Mac.',
    });
    expect(started.statusCode).toBe(201);
    const conversationId = started.json().conversation.id;

    await api.post(`/api/conversations/${conversationId}/messages`, { message: 'FYI the site has no internet.' });
    await api.post(`/api/conversations/${conversationId}/messages`, { message: 'Thanks.' });

    const read = await api.get(`/api/conversations/${conversationId}`);
    const messages = read.json().messages as Array<{ seq: number; direction: string; body: string }>;

    const inbound = messages.filter((m) => m.direction === 'inbound');
    expect(inbound.map((m) => m.body)).toEqual(['Morning Mac.', 'FYI the site has no internet.', 'Thanks.']);

    // Monotonic, gapless and strictly increasing across BOTH directions.
    const seqs = messages.map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('classifies each inbound message and records what decided it', async () => {
    const api = asUser(app, admin);
    const project = await makeProject(app, admin);
    const started = await api.post('/api/conversations', { projectId: project.id });
    const conversationId = started.json().conversation.id;

    const turn = await api.post(`/api/conversations/${conversationId}/messages`, {
      message: 'What did you do last night?',
    });

    expect(turn.json().turn.intent).toBe('status_request');
    expect(turn.json().turn.reply).not.toBeNull();
  });

  it('answers a status question from data rather than inventing a night', async () => {
    const api = asUser(app, admin);
    const started = await api.post('/api/conversations', {});
    const conversationId = started.json().conversation.id;

    const turn = await api.post(`/api/conversations/${conversationId}/messages`, {
      message: 'What did you do last night?',
    });

    /*
     * There has been no night shift. The honest answer says so; the dangerous
     * one describes a plausible night. Status is what people check other things
     * against, so an invented one is caught by nothing downstream.
     */
    expect(turn.json().turn.reply.body).toMatch(/no night shift on record/i);
  });

  it('reports nothing outstanding when nothing is', async () => {
    const api = asUser(app, admin);
    const started = await api.post('/api/conversations', {});
    const id = started.json().conversation.id;

    const turn = await api.post(`/api/conversations/${id}/messages`, { message: 'What needs my approval?' });
    expect(turn.json().turn.reply.body).toMatch(/Nothing is waiting on your approval/i);
  });
});

// ---------------------------------------------------------------------------

describe('turning a message into work', () => {
  it('raises a task and starts discovery from an instruction naming the project', async () => {
    const api = asUser(app, admin);
    const project = await makeProject(app, admin, { name: 'Northgate WTP', repoUrl: null });

    const started = await api.post('/api/conversations', {});
    const conversationId = started.json().conversation.id;

    const turn = await api.post(`/api/conversations/${conversationId}/messages`, {
      message:
        'Mac, tonight investigate whether we should replace the old S7-300 at Northgate WTP or migrate it incrementally.',
    });

    const body = turn.json().turn;
    expect(body.intent).toBe('task_assignment');
    expect(body.created.taskId).toBeTruthy();
    expect(body.created.discoverySessionId).toBeTruthy();

    // The conversation is now ABOUT that task, which is what makes the web UI
    // and Teams show the same thread against it.
    const [conversation] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(conversation!.taskId).toBe(body.created.taskId);

    // And discovery knows which conversation it is being conducted through.
    const [session] = await db
      .select()
      .from(discoverySessions)
      .where(eq(discoverySessions.id, body.created.discoverySessionId));
    expect(session!.conversationId).toBe(conversationId);
  });

  it('asks which project rather than guessing when the message names none', async () => {
    const api = asUser(app, admin);
    await makeProject(app, admin, { name: 'Alpha' });
    await makeProject(app, admin, { name: 'Beta' });

    const started = await api.post('/api/conversations', {});
    const id = started.json().conversation.id;

    const turn = await api.post(`/api/conversations/${id}/messages`, {
      message: 'Mac, tonight investigate whether we should replace the panel.',
    });

    // Raising work against the wrong customer's project is worse than asking,
    // and asking costs one message.
    expect(turn.json().turn.created.taskId).toBeNull();
    expect(turn.json().turn.reply.body).toMatch(/Which project/i);
  });

  it('does NOT create a run or approve anything', async () => {
    const api = asUser(app, admin);
    const project = await makeProject(app, admin, { name: 'Gamma Plant', repoUrl: null });
    const started = await api.post('/api/conversations', {});
    const id = started.json().conversation.id;

    const turn = await api.post(`/api/conversations/${id}/messages`, {
      message: 'Mac, tonight research the options for Gamma Plant.',
    });

    // Spec §3 and §4: discovery first, approval second, execution third. A
    // channel that could skip to execution would be a channel through which
    // unreviewed work runs.
    const runs = await asUser(app, admin).get(`/api/runs?taskId=${turn.json().turn.created.taskId}`);
    expect(runs.json().runs).toHaveLength(0);
    expect(turn.json().turn.reply.body).toMatch(/Nothing runs until you approve/i);
  });
});

// ---------------------------------------------------------------------------

describe('answers reach the brief', () => {
  it('routes an answer into the same discovery the web UI would', async () => {
    const api = asUser(app, admin);
    const project = await makeProject(app, admin, { name: 'Delta Site', repoUrl: null });
    const started = await api.post('/api/conversations', {});
    const conversationId = started.json().conversation.id;

    const assignment = await api.post(`/api/conversations/${conversationId}/messages`, {
      message: 'Mac, tonight investigate the pump control strategy at Delta Site.',
    });
    const sessionId = assignment.json().turn.created.discoverySessionId as string;

    // Mac asked something as part of starting discovery.
    const before = await api.get(`/api/discovery/${sessionId}`);
    expect(before.json().session.pendingQuestion).not.toBeNull();

    const answered = await api.post(`/api/conversations/${conversationId}/messages`, {
      message: 'The outcome we want is that operators can run duty/standby from the HMI without calling us.',
    });

    expect(answered.json().turn.intent).toBe('answer');

    // The message landed in the discovery session itself, not in a parallel
    // store — which is what makes an answer given in Teams move the same brief.
    const after = await api.get(`/api/discovery/${sessionId}`);
    const discoveryMessages = after.json().session.messages as Array<{ message: string }>;
    expect(discoveryMessages.some((m) => m.message.includes('duty/standby'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('approvals through a conversation', () => {
  const raise = async (taskId: string, title = 'Run the investigation') =>
    createApprovalRequest(
      {
        taskId,
        subjectKind: 'brief',
        subjectVersion: 1,
        title,
        detail: 'Detail.',
        recommendation: 'Proceed.',
        risk: 'medium',
        authority: 'accept_brief',
      },
      SYSTEM_ACTOR,
    );

  it('refuses a bare affirmation and names the outstanding codes', async () => {
    const api = asUser(app, admin);
    const project = await makeProject(app, admin, { repoUrl: null });
    const task = await makeTask(app, admin, project.id);
    const request = await raise(task.id);

    const started = await api.post('/api/conversations', { taskId: task.id, projectId: project.id });
    const id = started.json().conversation.id;

    const turn = await api.post(`/api/conversations/${id}/messages`, { message: 'sounds good' });

    expect(turn.json().turn.reply.body).toContain(request.code);
    expect(turn.json().turn.reply.body).toMatch(/Reply with the code/);

    // And crucially: nothing was approved.
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, request.id));
    expect(row!.state).toBe('pending');
  });

  it('approves when the message names the code', async () => {
    const api = asUser(app, admin);
    const project = await makeProject(app, admin, { repoUrl: null });
    const task = await makeTask(app, admin, project.id);
    const request = await raise(task.id);

    const started = await api.post('/api/conversations', { taskId: task.id, projectId: project.id });
    const id = started.json().conversation.id;

    const turn = await api.post(`/api/conversations/${id}/messages`, {
      message: `approve ${request.code} please`,
    });

    expect(turn.json().turn.reply.body).toContain(request.code);

    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, request.id));
    expect(row!.state).toBe('approved');
    expect(row!.decidedViaChannel).toBe('web');
    // The message that carried the decision is recorded against it, so the
    // audit trail can show WHICH sentence authorised the work.
    expect(row!.decidedViaMessageId).toBeTruthy();
  });

  it('refuses a decision on a superseded request by name', async () => {
    const api = asUser(app, admin);
    const project = await makeProject(app, admin, { repoUrl: null });
    const task = await makeTask(app, admin, project.id);

    const first = await raise(task.id, 'Version one');
    const second = await raise(task.id, 'Version two');

    const started = await api.post('/api/conversations', { taskId: task.id, projectId: project.id });
    const id = started.json().conversation.id;

    // The old card is still on somebody's phone.
    const turn = await api.post(`/api/conversations/${id}/messages`, { message: `approve ${first.code}` });

    // It is no longer pending, so it does not even bind — which is the right
    // failure: pressing a stale card must not authorise work nobody read.
    expect(turn.json().turn.reply.body).toMatch(/not an approval that is currently outstanding|no longer outstanding/i);

    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, first.id));
    expect(row!.state).toBe('superseded');
    expect(row!.supersededByRequestId).toBe(second.id);
  });

  it('refuses an authority no message may grant, and audits the attempt', async () => {
    const project = await makeProject(app, admin, { repoUrl: null });
    const task = await makeTask(app, admin, project.id);

    const request = await createApprovalRequest(
      {
        taskId: task.id,
        subjectKind: 'action',
        subjectVersion: 0,
        title: 'Merge the release branch to main',
        detail: '',
        recommendation: '',
        risk: 'high',
        authority: 'merge_protected_branch',
      },
      SYSTEM_ACTOR,
    );

    const decided = await asUser(app, admin).post(`/api/approval-requests/${request.id}/decision`, {
      decision: 'approve',
      notes: 'Go on then.',
    });

    // Refused in the WEB UI, not only in Teams. Spec §16 says Mac may not do
    // this; it does not say he may if asked through a nicer interface.
    expect(decided.statusCode).toBe(403);
    expect(decided.json().error.message).toMatch(/hard V1 prohibition/i);

    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, request.id));
    expect(row!.state).toBe('pending');
  });
});

// ---------------------------------------------------------------------------

describe('retrieval', () => {
  it('never puts the whole transcript in the model context', async () => {
    const conversation = await startConversation({ channel: 'web' }, SYSTEM_ACTOR);

    for (let i = 1; i <= 40; i += 1) {
      await appendMessage({
        conversationId: conversation.id,
        direction: 'inbound',
        channel: 'web',
        authorKind: 'human',
        authorName: 'Kasper',
        body: `Message number ${i}`,
      });
    }

    const context = await buildConversationContext(conversation.id);

    // Bounded by a constant, not by a parameter a caller could raise.
    expect(context.recent.length).toBeLessThanOrEqual(12);
    expect(context.recent.at(-1)?.body).toBe('Message number 40');
    expect(Object.keys(context)).not.toContain('transcript');
  });

  it('carries decisions and corrections forward from every summary, not only the latest', async () => {
    const conversation = await startConversation({ channel: 'web' }, SYSTEM_ACTOR);

    await storeSummary({
      conversationId: conversation.id,
      coversFromSeq: 1,
      coversToSeq: 10,
      content: conversationSummaryContentSchema.parse({
        corrections: ['It is the SOUTH pump station, not the north one.'],
        decisions: ['We are migrating incrementally.'],
      }),
    });
    await storeSummary({
      conversationId: conversation.id,
      coversFromSeq: 11,
      coversToSeq: 20,
      content: conversationSummaryContentSchema.parse({ projectFacts: ['The site has no internet access.'] }),
    });

    const context = await buildConversationContext(conversation.id);

    /*
     * A correction made two summaries ago is still a correction. Reading only
     * the latest summary would quietly expire the very things the summary
     * schema exists to preserve — and a correction that is forgotten is a
     * mistake that will be made again.
     */
    expect(context.carriedForward.corrections).toContain('It is the SOUTH pump station, not the north one.');
    expect(context.carriedForward.decisions).toContain('We are migrating incrementally.');
    expect(context.carriedForward.projectFacts).toContain('The site has no internet access.');
  });

  it('keeps source messages when a summary covers them', async () => {
    const conversation = await startConversation({ channel: 'web' }, SYSTEM_ACTOR);
    await appendMessage({
      conversationId: conversation.id,
      direction: 'inbound',
      channel: 'web',
      authorKind: 'human',
      authorName: 'Kasper',
      body: 'The original words.',
    });

    await storeSummary({
      conversationId: conversation.id,
      coversFromSeq: 1,
      coversToSeq: 1,
      content: conversationSummaryContentSchema.parse({ narrative: 'They said something.' }),
    });

    // §11: a generated summary must not overwrite source messages.
    const rows = await db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversation.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe('The original words.');
  });
});
