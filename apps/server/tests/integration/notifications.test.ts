import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { approvalRequests, auditEvents, conversationMessages, conversations } from '../../src/db/schema.js';
import { asUser, createAndLogin, resetDatabase, startTestApp, type Session, type TestApp } from '../helpers/harness.js';
import { makeProject, makeTask } from '../helpers/fixtures.js';
import { FakeTeamsProvider, setTeamsProvider } from '../../src/services/teams/provider.js';
import {
  deliverApprovalRequest,
  deliverQuestion,
  deliverUndeliveredApprovals,
  notify,
} from '../../src/services/notifications.js';
import {
  createApprovalRequest,
  decideApprovalRequest,
  expireStaleRequests,
} from '../../src/services/approval-requests.js';
import { startConversation } from '../../src/services/conversations.js';
import { updateSettings } from '../../src/services/settings.js';
import { SYSTEM_ACTOR } from '../../src/services/audit.js';

/**
 * Reaching a person, and refusing to (Phase 4 Part B §6–§8, Part G §27).
 */

let app: TestApp;
let admin: Session;
let teams: FakeTeamsProvider;

const api = (session: Session) => asUser(app.fastify, session);

beforeAll(async () => {
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDatabase();
  admin = await createAndLogin(app.fastify, { email: 'admin@pac.test', role: 'admin' });
  teams = new FakeTeamsProvider();
  setTeamsProvider(teams);
  await updateSettings({ teamsEnabled: true }, { type: 'user', id: admin.user.id, label: admin.user.name });
});

afterEach(() => setTeamsProvider(null));

/** A Teams-shaped conversation about a task, so there is somewhere to speak. */
async function teamsThread(taskId: string, projectId: string) {
  return startConversation(
    {
      channel: 'teams',
      taskId,
      projectId,
      externalRef: `a:thread-${taskId}`,
      serviceUrl: 'https://smba.trafficmanager.net/au/',
      title: 'Thread',
    },
    SYSTEM_ACTOR,
  );
}

// ---------------------------------------------------------------------------

describe('what Mac may interrupt somebody about', () => {
  it('delivers a blocker', async () => {
    const project = await makeProject(app.fastify, admin, { repoUrl: null });
    const task = await makeTask(app.fastify, admin, project.id);
    await teamsThread(task.id, project.id);

    const result = await notify({
      trigger: 'blocker_raised',
      taskId: task.id,
      projectId: project.id,
      text: 'I am blocked on which vendor the existing panel is.',
    });

    expect(result.sent).toBe(true);
    expect(teams.sent).toHaveLength(1);
    expect(teams.sent[0]!.text).toMatch(/blocked on which vendor/);
  });

  it('delivers a question carrying everything §6 requires', async () => {
    const project = await makeProject(app.fastify, admin, { name: 'Question Site', repoUrl: null });
    const task = await makeTask(app.fastify, admin, project.id, { title: 'Scope the upgrade' });
    await teamsThread(task.id, project.id);

    const result = await deliverQuestion({
      taskId: task.id,
      projectId: project.id,
      question: 'Which vendor is the existing panel?',
      why: 'It decides whether a migration path exists at all.',
      options: ['Siemens', 'Rockwell', 'Something else'],
      recommendation: 'I would assume Siemens from the drawings, but I would rather be told.',
      confidence: 0.62,
      questionId: 'gap-architecture',
    });

    expect(result.sent).toBe(true);

    // §6: project/task, the question, why Mac needs it, options, his current
    // recommendation and his confidence. A question missing those is one
    // somebody has to go and look something up to answer.
    const card = JSON.stringify(teams.sent.at(-1)!.attachments ?? []);
    expect(card).toContain('Which vendor is the existing panel?');
    expect(card).toContain('It decides whether a migration path exists');
    expect(card).toContain('Rockwell');
    expect(card).toContain('62%');
    expect(card).toContain('Question Site');
  });

  it('does NOT deliver routine progress, and records that it did not', async () => {
    const project = await makeProject(app.fastify, admin, { repoUrl: null });
    const task = await makeTask(app.fastify, admin, project.id);
    await teamsThread(task.id, project.id);

    for (const trigger of ['run_started', 'run_progress', 'run_completed', 'artefact_created'] as const) {
      const result = await notify({ trigger, taskId: task.id, projectId: project.id, text: 'something happened' });
      expect(result.sent, trigger).toBe(false);
    }

    expect(teams.sent).toHaveLength(0);

    /*
     * A suppression is audited. "Mac did not tell me" and "Mac was never asked
     * to tell me" look identical from outside, and the second is what somebody
     * assumes when they missed something.
     */
    const suppressions = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.taskId, task.id), eq(auditEvents.eventType, 'notification.suppressed')));
    expect(suppressions).toHaveLength(4);
  });

  it('honours the deployment switching a permitted class off', async () => {
    const project = await makeProject(app.fastify, admin, { repoUrl: null });
    const task = await makeTask(app.fastify, admin, project.id);
    await teamsThread(task.id, project.id);

    await updateSettings(
      { teamsNotifyBlockers: false },
      { type: 'user', id: admin.user.id, label: admin.user.name },
    );

    const result = await notify({
      trigger: 'blocker_raised',
      taskId: task.id,
      projectId: project.id,
      text: 'blocked',
    });

    expect(result.sent).toBe(false);
    expect(teams.sent).toHaveLength(0);
  });

  it('says so rather than throwing when there is nobody to tell', async () => {
    const project = await makeProject(app.fastify, admin, { repoUrl: null });
    const task = await makeTask(app.fastify, admin, project.id);

    // No conversation exists about this task.
    const result = await notify({
      trigger: 'blocker_raised',
      taskId: task.id,
      projectId: project.id,
      text: 'blocked',
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/no conversation/i);
  });
});

// ---------------------------------------------------------------------------

describe('approval delivery', () => {
  const raise = (taskId: string, over: Partial<Parameters<typeof createApprovalRequest>[0]> = {}) =>
    createApprovalRequest(
      {
        taskId,
        subjectKind: 'brief',
        subjectVersion: 1,
        title: 'Accept the brief',
        detail: 'Detail.',
        recommendation: 'Proceed.',
        risk: 'medium',
        authority: 'accept_brief',
        ...over,
      },
      SYSTEM_ACTOR,
    );

  it('sends a card carrying the request id on its buttons', async () => {
    const project = await makeProject(app.fastify, admin, { repoUrl: null });
    const task = await makeTask(app.fastify, admin, project.id);
    await teamsThread(task.id, project.id);

    const request = await raise(task.id);
    const result = await deliverApprovalRequest(request.id);

    expect(result.sent).toBe(true);
    const card = JSON.stringify(teams.sent.at(-1)!.attachments ?? []);
    // The id on the button is what makes a card action bind by construction.
    expect(card).toContain(request.id);
    expect(card).toContain(request.code);
  });

  it('offers no buttons for an authority no message may grant', async () => {
    const project = await makeProject(app.fastify, admin, { repoUrl: null });
    const task = await makeTask(app.fastify, admin, project.id);
    await teamsThread(task.id, project.id);

    const request = await raise(task.id, { authority: 'deploy_live_system', subjectKind: 'action', risk: 'high' });
    await deliverApprovalRequest(request.id);

    const attachment = teams.sent.at(-1)!.attachments![0]!;
    expect(attachment.content.actions).toEqual([]);
    expect(JSON.stringify(attachment.content)).toMatch(/hard V1 prohibition/i);
  });

  it('is swept rather than fired inline, so a crash cannot lose it', async () => {
    const project = await makeProject(app.fastify, admin, { repoUrl: null });
    const task = await makeTask(app.fastify, admin, project.id);
    await teamsThread(task.id, project.id);

    // Created, and nothing has been told about it yet.
    const request = await raise(task.id);
    const [before] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, request.id));
    expect(before!.deliveredChannels).toEqual([]);

    const delivered = await deliverUndeliveredApprovals();
    expect(delivered).toBe(1);

    const [after] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, request.id));
    expect(after!.deliveredChannels).toEqual(['teams']);

    // And a second sweep does not send it again.
    expect(await deliverUndeliveredApprovals()).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('approvals that are no longer live', () => {
  it('expires a request past its deadline, and refuses to decide it', async () => {
    const project = await makeProject(app.fastify, admin, { repoUrl: null });
    const task = await makeTask(app.fastify, admin, project.id);

    const request = await createApprovalRequest(
      {
        taskId: task.id,
        subjectKind: 'brief',
        subjectVersion: 1,
        title: 'Accept the brief',
        detail: '',
        recommendation: '',
        risk: 'medium',
        authority: 'accept_brief',
        expiresInHours: 1,
      },
      SYSTEM_ACTOR,
    );

    // Move the deadline into the past, as an hour would.
    await db
      .update(approvalRequests)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(approvalRequests.id, request.id));

    const expired = await expireStaleRequests(new Date());
    expect(expired).toBe(1);

    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, request.id));
    expect(row!.state).toBe('expired');

    await expect(
      decideApprovalRequest(request.id, { decision: 'approve', channel: 'web' }, {
        type: 'user',
        id: admin.user.id,
        label: admin.user.name,
      }),
    ).rejects.toThrow(/already expired/i);
  });

  it('refuses to decide a superseded request, and says why', async () => {
    const project = await makeProject(app.fastify, admin, { repoUrl: null });
    const task = await makeTask(app.fastify, admin, project.id);

    const first = await createApprovalRequest(
      {
        taskId: task.id,
        subjectKind: 'brief',
        subjectVersion: 1,
        title: 'Version one',
        detail: '',
        recommendation: '',
        risk: 'medium',
        authority: 'accept_brief',
      },
      SYSTEM_ACTOR,
    );
    await createApprovalRequest(
      {
        taskId: task.id,
        subjectKind: 'brief',
        subjectVersion: 2,
        title: 'Version two',
        detail: '',
        recommendation: '',
        risk: 'medium',
        authority: 'accept_brief',
      },
      SYSTEM_ACTOR,
    );

    await expect(
      decideApprovalRequest(first.id, { decision: 'approve', channel: 'web' }, {
        type: 'user',
        id: admin.user.id,
        label: admin.user.name,
      }),
    ).rejects.toThrow(/replaced by a newer version/i);
  });

  it('preserves the audit record of every decision and every refusal', async () => {
    const project = await makeProject(app.fastify, admin, { repoUrl: null });
    const task = await makeTask(app.fastify, admin, project.id);

    const request = await createApprovalRequest(
      {
        taskId: task.id,
        subjectKind: 'action',
        subjectVersion: 0,
        title: 'Merge to main',
        detail: '',
        recommendation: '',
        risk: 'high',
        authority: 'merge_protected_branch',
      },
      SYSTEM_ACTOR,
    );

    await expect(
      decideApprovalRequest(request.id, { decision: 'approve', channel: 'teams' }, {
        type: 'user',
        id: admin.user.id,
        label: admin.user.name,
      }),
    ).rejects.toThrow();

    /*
     * The refusal outlives the failed transaction, exactly as a blocked
     * approval does. Somebody trying to authorise a merge to main by message is
     * a security signal, and a signal that rolls back with the attempt is no
     * signal at all.
     */
    const refusals = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.taskId, task.id), eq(auditEvents.eventType, 'approval_request.authority_refused')),
      );

    expect(refusals).toHaveLength(1);
    expect((refusals[0]!.metadata as { authority: string }).authority).toBe('merge_protected_branch');
  });
});

// ---------------------------------------------------------------------------

describe('outbound message hygiene', () => {
  it('records only the length of a message in the audit trail, not its text', async () => {
    const project = await makeProject(app.fastify, admin, { repoUrl: null });
    const task = await makeTask(app.fastify, admin, project.id);
    await teamsThread(task.id, project.id);

    const secretish = 'The wet well level transmitter is a Vega VEGAPULS 61, serial 12345.';
    await notify({ trigger: 'blocker_raised', taskId: task.id, projectId: project.id, text: secretish });

    const events = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.taskId, task.id), eq(auditEvents.eventType, 'conversation.message_sent')));

    // Part I §32: avoid recording unnecessary full message payloads in
    // high-volume audit tables. The message itself is one join away.
    expect(JSON.stringify(events.map((e) => e.metadata))).not.toContain('VEGAPULS');

    const [message] = await db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.direction, 'outbound'));
    expect(message!.body).toContain('VEGAPULS');
  });

  it('does not queue a web reply for delivery', async () => {
    // A web conversation is delivered by the reader asking for it. Marking one
    // pending would leave the sweeper a backlog it can never clear.
    const project = await makeProject(app.fastify, admin, { repoUrl: null });
    const task = await makeTask(app.fastify, admin, project.id);

    const conversation = await startConversation(
      { channel: 'web', taskId: task.id, projectId: project.id },
      SYSTEM_ACTOR,
    );

    await notify({
      trigger: 'blocker_raised',
      conversationId: conversation.id,
      taskId: task.id,
      projectId: project.id,
      text: 'blocked',
    });

    const [message] = await db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversation.id));
    expect(message!.deliveryState).toBe('not_required');
  });
});

// ---------------------------------------------------------------------------

describe('a channel is not an authority (Part H §29)', () => {
  it('cannot approve a run below the confidence threshold, however it arrives', async () => {
    /*
     * Part H §29: "Teams/Forja availability should not change the execution
     * authority model."
     *
     * The web UI can approve in the 60–79% band, but only by setting
     * `acceptBelowThreshold` — a deliberate, separate act. A card has two
     * buttons and neither of them is "and I accept that Mac is not confident
     * about this", so a conversational approval simply cannot reach that branch.
     */
    const project = await makeProject(app.fastify, admin, { repoUrl: null });
    const task = await makeTask(app.fastify, admin, project.id);

    const run = await api(admin).post('/api/runs', {
      taskId: task.id,
      jobKind: 'noop',
      jobParams: {},
      // Inside the limited band: above the 0.60 floor, below the 0.80 threshold.
      confidence: 0.7,
    });
    const runId = run.json().run.id as string;
    await api(admin).post(`/api/runs/${runId}/submit`);

    const request = await createApprovalRequest(
      {
        taskId: task.id,
        runId,
        subjectKind: 'run',
        subjectVersion: 0,
        title: 'Run it',
        detail: '',
        recommendation: '',
        risk: 'medium',
        authority: 'execute_run',
        confidence: 0.7,
      },
      SYSTEM_ACTOR,
    );

    // The conversational path, which cannot set the acknowledgement.
    await expect(
      decideApprovalRequest(request.id, { decision: 'approve', channel: 'teams' }, {
        type: 'user',
        id: admin.user.id,
        label: admin.user.name,
      }),
    ).rejects.toThrow();

    const [stillPending] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, request.id));
    expect(stillPending!.state).toBe('pending');

    // The same decision, with the acknowledgement a person makes explicitly,
    // is accepted — by exactly the same function.
    const decided = await decideApprovalRequest(
      request.id,
      { decision: 'approve', channel: 'web', acceptBelowThreshold: true, notes: 'Understood.' },
      { type: 'user', id: admin.user.id, label: admin.user.name },
    );
    expect(decided.state).toBe('approved');
  });

  it('does not change what is eligible because Teams is switched on', async () => {
    const project = await makeProject(app.fastify, admin, { repoUrl: null });
    const task = await makeTask(app.fastify, admin, project.id, { taskKind: 'research' });

    const withTeams = (await api(admin).get(`/api/tasks/${task.id}`)).json().execution;

    await updateSettings({ teamsEnabled: false }, { type: 'user', id: admin.user.id, label: admin.user.name });
    const withoutTeams = (await api(admin).get(`/api/tasks/${task.id}`)).json().execution;

    // The execution requirements and the eligibility verdict are facts about
    // the WORK. A communication channel is not one of them.
    expect(withoutTeams.requirements).toEqual(withTeams.requirements);
    expect(withoutTeams.blockerSummary).toEqual(withTeams.blockerSummary);
  });
});
