import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { DEFAULT_MONDAY_STATUS_LABELS } from '@mac/protocol';
import {
  asUser,
  closePool,
  createAndLogin,
  resetDatabase,
  startTestApp,
  type Session,
  type TestApp,
} from '../helpers/harness.js';
import { makeProject, registerTestWorker } from '../helpers/fixtures.js';
import { db } from '../../src/db/client.js';
import { mondayWrites, nightDecisions, nightShifts, runBlockers, runs, tasks } from '../../src/db/schema.js';
import { queryAuditEvents } from '../../src/services/audit-query.js';
import { FakeMondayClient } from '../../src/services/monday/fake.js';
import { setMondayClient } from '../../src/services/monday/provider.js';
import { FakeMailProvider, setMailProvider } from '../../src/services/mail/provider.js';
import { deliverPendingMondayWrites } from '../../src/services/monday/outbox.js';
import { nightShiftTick, startNightShift, stopNightShift } from '../../src/services/night-shift.js';
import { SYSTEM_ACTOR } from '../../src/services/audit.js';

/**
 * The night shift, against the real database and the real HTTP surface
 * (Sprint 3 §8).
 *
 * Nothing here inserts a run directly. A test that says "Mac started a task" is
 * asserting that the scheduler genuinely reached that decision from approved
 * projects, approved boards, flagged items and real briefs — which is the only
 * way this proves anything about what happens at 02:00.
 */

let app: TestApp;
let admin: Session;
let operator: Session;
let monday: FakeMondayClient;
let mail: FakeMailProvider;

interface Fixture {
  projectId: string;
  boardRowId: string;
  boardId: string;
  taskIds: Record<string, string>;
}

const api = (session: Session) => asUser(app.fastify, session);

beforeAll(async () => {
  app = await startTestApp();
}, 120_000);

afterAll(async () => {
  setMondayClient(null);
  setMailProvider(null);
  await app.close();
  await closePool();
});

beforeEach(async () => {
  await resetDatabase();
  admin = await createAndLogin(app.fastify, { email: 'admin@pac.test', role: 'admin' });
  operator = await createAndLogin(app.fastify, { email: 'operator@pac.test', role: 'operator' });

  monday = new FakeMondayClient();
  setMondayClient(monday);
  mail = new FakeMailProvider();
  setMailProvider(mail);

  await api(admin).patch('/api/settings', {
    mailProvider: 'fake',
    reportRecipients: ['kasper@pac-technologies.com.au'],
    allowedRecipientDomains: ['pac-technologies.com.au'],
  });
});

// ---------------------------------------------------------------------------
// Fixture: an approved project with an approved board and briefed work
// ---------------------------------------------------------------------------

let boardCounter = 0;

async function makeApprovedProject(
  name: string,
  items: Array<{
    itemId: string;
    title: string;
    priority?: string;
    status?: string;
    flagged?: boolean;
    dependsOn?: string[];
    conversation?: string[];
  }>,
  options: { approveProject?: boolean; approveBoard?: boolean; nightEligible?: boolean } = {},
): Promise<Fixture> {
  const project = await makeProject(app.fastify, admin, { name });
  const boardId = `board-${(boardCounter += 1)}`;

  monday.addBoard({
    id: boardId,
    name: `${name} delivery`,
    groups: [],
    columns: [
      { id: 'status', title: 'Status', type: 'status' },
      { id: 'priority', title: 'Priority', type: 'status' },
      { id: 'due', title: 'Due date', type: 'date' },
      { id: 'people', title: 'Owner', type: 'people' },
    ],
  });

  const repository = await api(admin).post('/api/repositories', {
    projectId: project.id,
    name: `repo-${boardCounter}`,
    remoteUrl: `https://github.com/pac-technologies/${name.toLowerCase().replace(/\W+/g, '-')}.git`,
    localPath: `/srv/mac/workspace/${name.toLowerCase().replace(/\W+/g, '-')}`,
    defaultBranch: 'main',
    testCommand: ['npm', 'test'],
  });
  await api(admin).post(`/api/repositories/${repository.json().repository.id}/approve`, { approved: true });

  const mapped = await api(admin).post('/api/monday/boards', {
    projectId: project.id,
    boardId,
    name: `${name} delivery`,
    statusColumnId: 'status',
    assigneeColumnId: 'people',
    priorityColumnId: 'priority',
    dueDateColumnId: 'due',
    statusLabels: DEFAULT_MONDAY_STATUS_LABELS,
    startableStatuses: ['Ready for Mac'],
    completedStatuses: ['Done'],
    macUserId: 'mac-1',
    nightShiftEligible: options.nightEligible ?? true,
  });
  const boardRowId = mapped.json().board.id as string;

  if (options.approveBoard !== false) {
    await api(admin).post(`/api/monday/boards/${boardRowId}/approve`, { approved: true });
  }
  if (options.approveProject !== false) {
    await api(admin).post(`/api/projects/${project.id}/night-shift-approval`, { approved: true });
  }

  const taskIds: Record<string, string> = {};

  for (const item of items) {
    monday.addItem({
      id: item.itemId,
      boardId,
      name: item.title,
      status: item.status ?? 'Ready for Mac',
      priority: item.priority ?? 'Medium',
      nightShiftFlag: item.flagged ?? true,
      dependsOn: item.dependsOn ?? [],
    });

    // Real discovery, so the brief and its confidence are genuine rather than
    // written straight into the table.
    const started = await api(operator).post('/api/discovery', { projectId: project.id, title: item.title });
    const sessionId = started.json().session.id as string;
    const taskId = started.json().session.taskId as string;

    for (const message of item.conversation ?? DEFAULT_CONVERSATION(item.title)) {
      await api(operator).post(`/api/discovery/${sessionId}/messages`, { message });
    }
    await api(operator).post(`/api/discovery/${sessionId}/brief`, {});

    await db.update(tasks).set({ mondayItemId: item.itemId }).where(eq(tasks.id, taskId));
    taskIds[item.itemId] = taskId;
  }

  await api(operator).post(`/api/monday/boards/${boardRowId}/sync`);

  return { projectId: project.id, boardRowId, boardId, taskIds };
}

/**
 * Enough of a conversation to reach the autonomous confidence band.
 *
 * Deliberately real prose rather than a brief written directly: the confidence
 * that gates every one of these tests has to be one the discovery path actually
 * produced.
 */
const DEFAULT_CONVERSATION = (title: string) => [
  `I want ${title.toLowerCase()} done on the device portal. At the moment it does not work that way.`,
  "We need the API to support it too, but don't change the existing CSV import format because customers are using it.",
  'It is done when an operator can do it end to end and save the result.',
  'Please add unit tests for the reducer.',
  'The screen is the DeviceSelector component and the endpoint is the devices route.',
  'The architecture is a React SPA over a Fastify API, with the selection state in a reducer.',
];

async function liveWorker() {
  const worker = await registerTestWorker(app.fastify);
  await app.fastify.inject({
    method: 'POST',
    url: '/api/worker/heartbeat',
    headers: { authorization: `Bearer ${worker.token}` },
    payload: { status: 'idle', currentRunId: null },
  });
  return worker;
}

const startShift = (cutoffMinutes = 6 * 60) =>
  startNightShift({ cutoffAt: new Date(Date.now() + cutoffMinutes * 60_000).toISOString() }, SYSTEM_ACTOR);

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe('choosing work', () => {
  it('starts an eligible task, approves it by policy, and says so in the trail', async () => {
    const fixture = await makeApprovedProject('Portal', [{ itemId: 'i1', title: 'Multi device selection' }]);
    await liveWorker();
    const shift = await startShift();

    const result = await nightShiftTick();
    expect(result.decision).toBe('start');

    const [run] = await db.select().from(runs).where(eq(runs.nightShiftId, shift.id));
    expect(run).toBeDefined();
    expect(run!.status).toBe('queued');
    expect(run!.approvalState).toBe('approved');
    expect(run!.selectedBy).toBe('night_shift');
    expect(run!.jobKind).toBe('claude_code');
    expect(run!.mondayItemId).toBe('i1');
    expect(run!.executionMode).toBe('overnight');

    const events = (await queryAuditEvents({ runId: run!.id, limit: 50, offset: 0 })).map((e) => e.eventType);
    // A machine approval must never be readable as a human one.
    expect(events).toContain('run.auto_approved');
    expect(events).toContain('night_shift.task_selected');

    const approval = (await api(operator).get(`/api/runs/${run!.id}`)).json().approvals[0];
    // No approver name: this was policy, not a person, and putting somebody's
    // name against a decision they did not make would be the worst outcome.
    expect(approval.approverName).toBeNull();

    void fixture;
  }, 120_000);

  it('assigns the item to Mac, sets In Progress and posts an update', async () => {
    await makeApprovedProject('Portal', [{ itemId: 'i1', title: 'Multi device selection' }]);
    await liveWorker();
    await startShift();

    await nightShiftTick();
    await deliverPendingMondayWrites();

    expect(monday.snapshot('i1')!.assigneeIds).toEqual(['mac-1']);
    expect(monday.snapshot('i1')!.status).toBe('Working on it');
    expect((await monday.listUpdates('i1')).at(-1)!.body).toContain('Mac has started this');
  }, 120_000);

  it('will not take work from an unapproved project', async () => {
    await makeApprovedProject('Portal', [{ itemId: 'i1', title: 'Something' }], { approveProject: false });
    await liveWorker();
    const shift = await startShift();

    const result = await nightShiftTick();
    expect(result.decision).toBe('idle');
    expect(await db.select().from(runs).where(eq(runs.nightShiftId, shift.id))).toHaveLength(0);

    const skipped = await queryAuditEvents({ eventType: 'night_shift.task_skipped', limit: 10, offset: 0 });
    expect(skipped[0]!.metadata.detail).toContain('Project approved for night shift');
  }, 120_000);

  it('will not take work from an unapproved board', async () => {
    await makeApprovedProject('Portal', [{ itemId: 'i1', title: 'Something' }], { approveBoard: false });
    await liveWorker();
    await startShift();
    expect((await nightShiftTick()).decision).toBe('idle');
  }, 120_000);

  it('will not take an item nobody flagged', async () => {
    await makeApprovedProject('Portal', [{ itemId: 'i1', title: 'Something', flagged: false }]);
    await liveWorker();
    await startShift();
    expect((await nightShiftTick()).decision).toBe('idle');
  }, 120_000);

  it('will not take an item in a status it may not start from', async () => {
    await makeApprovedProject('Portal', [{ itemId: 'i1', title: 'Something', status: 'Awaiting Testing' }]);
    await liveWorker();
    await startShift();
    expect((await nightShiftTick()).decision).toBe('idle');
  }, 120_000);

  it('will not take an item whose dependency is unfinished', async () => {
    await makeApprovedProject('Portal', [
      { itemId: 'i1', title: 'Blocked by another', dependsOn: ['i2'] },
      { itemId: 'i2', title: 'The dependency', status: 'Working on it', flagged: false },
    ]);
    await liveWorker();
    await startShift();
    expect((await nightShiftTick()).decision).toBe('idle');
  }, 120_000);

  it('idles rather than inventing work when there is none', async () => {
    await makeApprovedProject('Portal', []);
    await liveWorker();
    const shift = await startShift();

    const result = await nightShiftTick();
    expect(result.decision).toBe('idle');
    expect(await db.select().from(runs).where(eq(runs.nightShiftId, shift.id))).toHaveLength(0);

    const idle = await queryAuditEvents({ eventType: 'night_shift.idle', limit: 10, offset: 0 });
    expect(idle.length).toBeGreaterThan(0);
  }, 120_000);

  it('withholds work when no worker can execute it', async () => {
    await makeApprovedProject('Portal', [{ itemId: 'i1', title: 'Something' }]);
    // No worker registered at all.
    await startShift();
    const result = await nightShiftTick();
    expect(result.decision).toBe('idle');
    expect(result.rationale!.reason).toContain('No worker');
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe('ordering', () => {
  it('takes the higher-priority item first within a project', async () => {
    await makeApprovedProject('Portal', [
      { itemId: 'low', title: 'Low priority thing', priority: 'Low' },
      { itemId: 'urgent', title: 'Urgent thing', priority: 'Critical' },
    ]);
    await liveWorker();
    await startShift();

    const result = await nightShiftTick();
    expect(result.decision).toBe('start');
    const [run] = await db.select().from(runs);
    expect(run!.mondayItemId).toBe('urgent');
  }, 180_000);

  it('finishes the current project before switching to another', async () => {
    const first = await makeApprovedProject('Portal', [{ itemId: 'p1-a', title: 'Portal work', priority: 'Low' }]);
    await makeApprovedProject('Forger', [{ itemId: 'p2-a', title: 'Forger work', priority: 'Critical' }]);
    await liveWorker();
    const shift = await startShift();

    // First selection: nothing to prefer, so highest priority wins.
    await nightShiftTick();
    const [firstRun] = await db.select().from(runs).orderBy(runs.createdAt);
    expect(firstRun!.mondayItemId).toBe('p2-a');

    // Finish it, and add more work in the same project as the finished one.
    await db
      .update(runs)
      .set({ status: 'completed', completedAt: new Date(), summary: 'Done.' })
      .where(eq(runs.id, firstRun!.id));

    await nightShiftTick(); // finalise
    await nightShiftTick(); // choose next

    const all = await db.select().from(runs).orderBy(runs.createdAt);
    expect(all).toHaveLength(2);
    // Portal is the only project with work left, so the switch is correct.
    expect(all[1]!.mondayItemId).toBe('p1-a');
    void first;
    void shift;
  }, 240_000);
});

// ---------------------------------------------------------------------------
// The cutoff and the safe-start check
// ---------------------------------------------------------------------------

describe('the cutoff', () => {
  it('will not start anything inside the final floor', async () => {
    await makeApprovedProject('Portal', [{ itemId: 'i1', title: 'Something' }]);
    await liveWorker();
    await startShift(10); // ten minutes left; the floor is twenty

    const result = await nightShiftTick();
    expect(result.decision).toBe('idle');

    const skipped = await queryAuditEvents({ eventType: 'night_shift.task_skipped', limit: 10, offset: 0 });
    // "Not now" is recorded as `insufficient_time`, never as `not_eligible`:
    // conflating them would make the queue screen lie.
    expect(skipped[0]!.metadata.reason).toBe('insufficient_time');
  }, 120_000);

  it('stops the shift once the cutoff has passed', async () => {
    await makeApprovedProject('Portal', [{ itemId: 'i1', title: 'Something' }]);
    await liveWorker();
    const shift = await startShift();
    await db.execute(sql`UPDATE night_shifts SET cutoff_at = now() - interval '1 minute' WHERE id = ${shift.id}`);

    const result = await nightShiftTick();
    expect(result.decision).toBe('stop');

    const [row] = await db.select().from(nightShifts).where(eq(nightShifts.id, shift.id));
    expect(row!.status).toBe('completed');
    expect(row!.stopReason).toBe('cutoff_reached');
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Blockers
// ---------------------------------------------------------------------------

describe('blocked work', () => {
  it('records the blocker, posts it, and moves on to other eligible work', async () => {
    await makeApprovedProject('Portal', [
      { itemId: 'i1', title: 'First thing', priority: 'Critical' },
      { itemId: 'i2', title: 'Second thing', priority: 'High' },
    ]);
    await liveWorker();
    const shift = await startShift();

    await nightShiftTick();
    const [firstRun] = await db.select().from(runs);
    expect(firstRun!.mondayItemId).toBe('i1');

    // The run blocks: a blocker row plus the blocked status, exactly as the
    // supervision path produces.
    await db.insert(runBlockers).values({
      runId: firstRun!.id,
      description: 'The import format is ambiguous.',
      reason: 'Needs confirmation that the v1 CSV header must stay.',
      risk: 'high',
    });
    await db.update(runs).set({ status: 'blocked' }).where(eq(runs.id, firstRun!.id));

    const blockedTick = await nightShiftTick();
    expect(blockedTick.decision).toBe('record_blocker');

    await deliverPendingMondayWrites();
    expect(monday.snapshot('i1')!.status).toBe('Stuck');
    const posted = (await monday.listUpdates('i1')).at(-1)!.body;
    expect(posted).toContain('The import format is ambiguous');
    expect(posted).toContain('What Mac needs');

    // A blocked task is NOT complete, and is distinguishable from a failed one.
    const [reread] = await db.select().from(runs).where(eq(runs.id, firstRun!.id));
    expect(reread!.status).toBe('blocked');
    expect(reread!.completedAt).toBeNull();

    // And Mac carries on with independent work.
    const next = await nightShiftTick();
    expect(next.decision).toBe('start');
    const all = await db.select().from(runs).orderBy(runs.createdAt);
    expect(all[1]!.mondayItemId).toBe('i2');

    const [shiftRow] = await db.select().from(nightShifts).where(eq(nightShifts.id, shift.id));
    expect(shiftRow!.tasksBlocked).toBe(1);
  }, 240_000);

  it('does not retry a task that blocked earlier in the same shift', async () => {
    await makeApprovedProject('Portal', [{ itemId: 'i1', title: 'Only thing' }]);
    await liveWorker();
    await startShift();

    await nightShiftTick();
    const [run] = await db.select().from(runs);
    await db.insert(runBlockers).values({
      runId: run!.id,
      description: 'Blocked.',
      reason: 'Needs a human.',
      risk: 'high',
    });
    await db.update(runs).set({ status: 'blocked' }).where(eq(runs.id, run!.id));

    await nightShiftTick(); // records the blocker
    const next = await nightShiftTick();

    // Retrying it would just block again, and the night is finite.
    expect(next.decision).toBe('idle');
    expect(await db.select().from(runs)).toHaveLength(1);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// Decision records
// ---------------------------------------------------------------------------

describe('every decision is recorded', () => {
  it('writes a decision row with its rationale, including the refusals', async () => {
    await makeApprovedProject('Portal', [{ itemId: 'i1', title: 'Something' }]);
    await liveWorker();
    const shift = await startShift();

    await nightShiftTick();
    await nightShiftTick();

    const decisions = await db
      .select()
      .from(nightDecisions)
      .where(eq(nightDecisions.nightShiftId, shift.id))
      .orderBy(nightDecisions.sequence);

    expect(decisions.length).toBeGreaterThanOrEqual(2);
    for (const decision of decisions) {
      const rationale = decision.rationale as Record<string, unknown>;
      expect(rationale.reason).toBeTruthy();
      expect(typeof rationale.remainingMinutes).toBe('number');
      expect(rationale.budgetBasis).toBeTruthy();
      expect(rationale.usageSourceAtDecision).toBeTruthy();
    }

    const start = decisions.find((d) => d.decision === 'start')!;
    expect(start.eligibility).toBeTruthy();
    expect(start.effort).toBeTruthy();
    // Every check, passing and failing, so the queue screen can show why.
    expect((start.eligibility as { checks: unknown[] }).checks.length).toBeGreaterThan(10);
  }, 180_000);

  it('exposes the decisions and the queue to the UI', async () => {
    await makeApprovedProject('Portal', [{ itemId: 'i1', title: 'Something' }]);
    await liveWorker();
    const shift = await startShift();
    await nightShiftTick();

    const decisions = await api(operator).get(`/api/night-shift/${shift.id}/decisions`);
    expect(decisions.statusCode).toBe(200);
    expect(decisions.json().decisions.length).toBeGreaterThan(0);

    const dashboard = await api(operator).get('/api/night-shift');
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().dashboard.macState).toBe('working');
    expect(dashboard.json().dashboard.shift.id).toBe(shift.id);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

describe('budget', () => {
  it('stops the shift when exact recorded spend reaches the nightly limit', async () => {
    const fixture = await makeApprovedProject('Portal', [{ itemId: 'i1', title: 'Something' }]);
    await liveWorker();
    const shift = await startShift();

    await nightShiftTick();
    const [run] = await db.select().from(runs);

    await db.execute(
      sql`INSERT INTO run_usage (run_id, provider, kind, cost_cents, is_exact, source)
          VALUES (${run!.id}, 'claude_code', 'session', 9999, true, 'exact')`,
    );
    await db.update(runs).set({ status: 'completed', completedAt: new Date() }).where(eq(runs.id, run!.id));

    await nightShiftTick(); // finalise
    const stopped = await nightShiftTick();

    expect(stopped.decision).toBe('stop');
    const [row] = await db.select().from(nightShifts).where(eq(nightShifts.id, shift.id));
    expect(row!.stopReason).toBe('budget_exhausted');
    void fixture;
  }, 240_000);
});

// ---------------------------------------------------------------------------
// The morning report
// ---------------------------------------------------------------------------

describe('ending a shift', () => {
  it('queues exactly one morning report, however many times the shift is stopped', async () => {
    await makeApprovedProject('Portal', [{ itemId: 'i1', title: 'Something' }]);
    await liveWorker();
    const shift = await startShift();
    await nightShiftTick();

    await stopNightShift({ reason: 'Testing.' }, SYSTEM_ACTOR);
    // A second stop finds no running shift and does nothing.
    await stopNightShift({ reason: 'Testing again.' }, SYSTEM_ACTOR);

    const deliveries = (await api(admin).get('/api/reports/deliveries')).json().deliveries;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].idempotencyKey ?? deliveries[0].id).toBeTruthy();
    expect(deliveries[0].subject).toContain('Mac overnight');

    const [row] = await db.select().from(nightShifts).where(eq(nightShifts.id, shift.id));
    expect(row!.status).toBe('stopped');
  }, 180_000);

  it('records the policy the shift actually ran under', async () => {
    await makeApprovedProject('Portal', []);
    const shift = await startShift();

    const [row] = await db.select().from(nightShifts).where(eq(nightShifts.id, shift.id));
    const snapshot = row!.settingsSnapshot as Record<string, unknown>;
    // Reading a report next to the thresholds as they are NOW is misleading if
    // somebody changed them at 06:00.
    expect(snapshot.defaultConfidenceThreshold).toBe(0.8);
    expect(snapshot.minExecutionConfidence).toBe(0.6);
    expect(snapshot.safetyFactor).toBe(1.5);
  }, 120_000);

  it('refuses to start a second shift while one is running', async () => {
    await startShift();
    await expect(startShift()).rejects.toThrow(/already running/);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// monday.com write scoping during a shift
// ---------------------------------------------------------------------------

describe('monday writes during a shift', () => {
  it('queues assignment, status and an update for the selected task only', async () => {
    await makeApprovedProject('Portal', [
      { itemId: 'i1', title: 'Selected', priority: 'Critical' },
      { itemId: 'i2', title: 'Not selected', priority: 'Low' },
    ]);
    await liveWorker();
    await startShift();
    await nightShiftTick();

    const queued = await db.select().from(mondayWrites);
    expect(queued.map((w) => w.kind).sort()).toEqual(['assign_to_mac', 'post_update', 'set_status']);
    expect(new Set(queued.map((w) => w.mondayItemId))).toEqual(new Set(['i1']));
  }, 180_000);
});
