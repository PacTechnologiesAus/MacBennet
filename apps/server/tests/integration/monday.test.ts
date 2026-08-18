import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { DEFAULT_MONDAY_STATUS_LABELS } from '@mac/protocol';
import {
  asUser,
  closePool,
  createAndLogin,
  resetDatabase,
  startTestApp,
  type Session,
} from '../helpers/harness.js';
import { makeProject, makeTask } from '../helpers/fixtures.js';
import { db } from '../../src/db/client.js';
import { mondayItems, mondayWrites, tasks } from '../../src/db/schema.js';
import { queryAuditEvents } from '../../src/services/audit-query.js';
import { FakeMondayClient } from '../../src/services/monday/fake.js';
import { setMondayClient } from '../../src/services/monday/provider.js';
import { syncBoard } from '../../src/services/monday/sync.js';
import {
  deliverPendingMondayWrites,
  queueBlocker,
  queuePullRequest,
  queueStatus,
  queueAssignToMac,
  queueUpdate,
} from '../../src/services/monday/outbox.js';
import { assertColumnWritable, statusLabelFor, MondayWriteRefused } from '../../src/services/monday/guard.js';
import { requireBoardRow } from '../../src/services/monday/boards.js';
import { SYSTEM_ACTOR } from '../../src/services/audit.js';

/**
 * monday.com (Sprint 3 §5).
 *
 * Everything here runs against the in-memory provider, which holds real state
 * and applies real writes — so a test can set a status and read it back, rather
 * than asserting that a mock was called. The opt-in live test against a
 * dedicated board is in `monday-live.test.ts` and is never part of `npm test`.
 */

let app: FastifyInstance;
let close: () => Promise<void>;
let admin: Session;
let operator: Session;
let monday: FakeMondayClient;
let projectId: string;
let boardRowId: string;

const BOARD_ID = '9001';

beforeAll(async () => {
  ({ fastify: app, close } = await startTestApp());
});

afterAll(async () => {
  setMondayClient(null);
  await close();
  await closePool();
});

beforeEach(async () => {
  await resetDatabase();
  admin = await createAndLogin(app, { email: 'admin@pac.test', name: 'Admin', role: 'admin' });
  operator = await createAndLogin(app, { email: 'op@pac.test', name: 'Op', role: 'operator' });

  monday = new FakeMondayClient();
  monday.addBoard({
    id: BOARD_ID,
    name: 'Device Portal Delivery',
    groups: [{ id: 'topics', title: 'Sprint' }],
    columns: [
      { id: 'status', title: 'Status', type: 'status' },
      { id: 'priority', title: 'Priority', type: 'status' },
      { id: 'due', title: 'Due date', type: 'date' },
      { id: 'people', title: 'Owner', type: 'people' },
      { id: 'pr', title: 'Pull request', type: 'link' },
    ],
  });
  setMondayClient(monday);

  const project = await makeProject(app, operator, { name: 'Device Portal' });
  projectId = project.id;
  boardRowId = (await mapBoard()).id;
});

const asAdmin = () => asUser(app, admin);

async function mapBoard(overrides: Record<string, unknown> = {}) {
  const response = await asAdmin().post('/api/monday/boards', {
    projectId,
    boardId: BOARD_ID,
    name: 'Device Portal Delivery',
    groupIds: [],
    statusColumnId: 'status',
    assigneeColumnId: 'people',
    priorityColumnId: 'priority',
    dueDateColumnId: 'due',
    pullRequestColumnId: 'pr',
    statusLabels: DEFAULT_MONDAY_STATUS_LABELS,
    startableStatuses: ['Ready for Mac'],
    completedStatuses: ['Done'],
    macUserId: 'mac-1',
    nightShiftEligible: true,
    ...overrides,
  });
  if (response.statusCode !== 201) throw new Error(`mapBoard failed: ${response.body}`);
  return response.json().board as { id: string; isApproved: boolean };
}

const addItem = (overrides: Record<string, unknown> = {}) =>
  monday.addItem({
    id: '8891',
    boardId: BOARD_ID,
    name: 'Multi-device selection',
    status: 'Ready for Mac',
    priority: 'High',
    nightShiftFlag: true,
    ...overrides,
  });

// ---------------------------------------------------------------------------
// Mapping and approval
// ---------------------------------------------------------------------------

describe('board mapping', () => {
  it('is never approved at creation', async () => {
    const board = await asAdmin().get(`/api/monday/boards/${boardRowId}`);
    expect(board.json().board.isApproved).toBe(false);
  });

  it('requires an admin to map or approve', async () => {
    const asOperator = asUser(app, operator);
    expect((await asOperator.post('/api/monday/boards', { projectId, boardId: '1' })).statusCode).toBe(403);
    expect((await asOperator.post(`/api/monday/boards/${boardRowId}/approve`, { approved: true })).statusCode).toBe(403);
  });

  it('audits mapping and approval as separate acts', async () => {
    await asAdmin().post(`/api/monday/boards/${boardRowId}/approve`, { approved: true });
    const events = (await queryAuditEvents({ projectId, limit: 50, offset: 0 })).map((e) => e.eventType);
    expect(events).toContain('monday.board_mapped');
    expect(events).toContain('monday.board_approved');
  });

  it('stops future work when approval is revoked', async () => {
    await asAdmin().post(`/api/monday/boards/${boardRowId}/approve`, { approved: true });
    await asAdmin().post(`/api/monday/boards/${boardRowId}/approve`, { approved: false });

    const board = await requireBoardRow(boardRowId);
    expect(board.isApproved).toBe(false);
    const events = (await queryAuditEvents({ projectId, limit: 50, offset: 0 })).map((e) => e.eventType);
    expect(events).toContain('monday.board_approval_revoked');
  });
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

describe('reading a board', () => {
  it('caches items and reports what it saw', async () => {
    addItem();
    addItem({ id: '8892', name: 'CSV import fix', priority: 'Low' });

    const result = await syncBoard(boardRowId, SYSTEM_ACTOR);
    expect(result.itemsSeen).toBe(2);
    expect(result.stale).toBe(false);

    const cached = await db.select().from(mondayItems).where(eq(mondayItems.projectId, projectId));
    expect(cached).toHaveLength(2);
    expect(cached.map((c) => c.name).sort()).toEqual(['CSV import fix', 'Multi-device selection']);
  });

  it('reads priority, status, assignee, due date and the night-shift flag', async () => {
    addItem({
      priority: 'Critical',
      assigneeIds: ['someone'],
      dueDate: '2026-09-01',
      nightShiftFlag: true,
      itemType: 'Feature',
    });
    await syncBoard(boardRowId, SYSTEM_ACTOR);

    const [cached] = await db.select().from(mondayItems).where(eq(mondayItems.itemId, '8891'));
    expect(cached!.priority).toBe('Critical');
    expect(cached!.status).toBe('Ready for Mac');
    expect(cached!.assigneeIds).toEqual(['someone']);
    expect(cached!.dueDate).toBe('2026-09-01');
    expect(cached!.nightShiftFlag).toBe(true);
    expect(cached!.itemType).toBe('Feature');
  });

  it('links an item to the task a human already prepared for it', async () => {
    const task = await makeTask(app, operator, projectId, { title: 'Multi-device selection' });
    await db.update(tasks).set({ mondayItemId: '8891' }).where(eq(tasks.id, task.id));

    addItem();
    const result = await syncBoard(boardRowId, SYSTEM_ACTOR);

    expect(result.itemsLinked).toBe(1);
    const [cached] = await db.select().from(mondayItems).where(eq(mondayItems.itemId, '8891'));
    expect(cached!.taskId).toBe(task.id);
  });

  it('degrades to the cache rather than failing when the board is unreachable', async () => {
    addItem();
    await syncBoard(boardRowId, SYSTEM_ACTOR);

    monday.available = false;
    monday.unavailableReason = 'monday.com is down';
    const result = await syncBoard(boardRowId, SYSTEM_ACTOR);

    // A board being unreachable at 02:00 is a reason to be careful, not a
    // reason for the night to fail.
    expect(result.stale).toBe(true);
    expect(result.error).toContain('down');
    const cached = await db.select().from(mondayItems).where(eq(mondayItems.projectId, projectId));
    expect(cached).toHaveLength(1);
  });

  it('audits the read', async () => {
    addItem();
    await syncBoard(boardRowId, SYSTEM_ACTOR);
    const events = (await queryAuditEvents({ projectId, limit: 50, offset: 0 })).map((e) => e.eventType);
    expect(events).toContain('monday.read');
  });
});

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

describe('writing to a board', () => {
  let taskId: string;

  beforeEach(async () => {
    await asAdmin().post(`/api/monday/boards/${boardRowId}/approve`, { approved: true });
    const task = await makeTask(app, operator, projectId, { title: 'Multi-device selection' });
    taskId = task.id;
    await db.update(tasks).set({ mondayItemId: '8891' }).where(eq(tasks.id, taskId));
    addItem();
    await syncBoard(boardRowId, SYSTEM_ACTOR);
  });

  it('assigns the item to Mac', async () => {
    await db.transaction(async (tx) => queueAssignToMac(tx, taskId, null));
    await deliverPendingMondayWrites();

    expect(monday.writes.some((w) => w.kind === 'assign_to_mac')).toBe(true);
    expect(monday.snapshot('8891')!.assigneeIds).toEqual(['mac-1']);
  });

  it('sets In Progress using the board’s own label', async () => {
    await db.transaction(async (tx) => queueStatus(tx, taskId, null, 'in_progress'));
    await deliverPendingMondayWrites();
    expect(monday.snapshot('8891')!.status).toBe('Working on it');
  });

  it('posts a progress update', async () => {
    await db.transaction(async (tx) => queueUpdate(tx, taskId, null, 'Halfway through the reducer.'));
    await deliverPendingMondayWrites();
    const updates = await monday.listUpdates('8891');
    expect(updates.at(-1)!.body).toContain('Halfway through the reducer');
  });

  it('posts a blocker saying what is blocked, what Mac needs, and whether he continues', async () => {
    await db.transaction(async (tx) =>
      queueBlocker(tx, taskId, null, {
        blocked: 'The import format is ambiguous.',
        needs: 'Confirmation that the v1 CSV header must stay.',
        continuing: true,
      }),
    );
    await deliverPendingMondayWrites();

    const body = (await monday.listUpdates('8891')).at(-1)!.body;
    expect(body).toContain('The import format is ambiguous');
    expect(body).toContain('What Mac needs');
    expect(body).toContain('moved on to other eligible work');
  });

  it('marks work Ready for Review and attaches the pull request', async () => {
    await db.transaction(async (tx) => {
      await queueStatus(tx, taskId, null, 'ready_for_review');
      await queuePullRequest(tx, taskId, null, {
        url: 'https://github.com/pac/device-portal/pull/42',
        title: 'Multi-device selection',
        summary: 'Adds multi-select to the device screen.',
      });
    });
    await deliverPendingMondayWrites();

    expect(monday.snapshot('8891')!.status).toBe('Awaiting Testing');
    expect(monday.writes.some((w) => w.kind === 'attach_pull_request')).toBe(true);
    expect((await monday.listUpdates('8891')).at(-1)!.body).toContain('pull/42');
  });

  it('audits every delivered write with its own event type', async () => {
    await db.transaction(async (tx) => {
      await queueAssignToMac(tx, taskId, null);
      await queueStatus(tx, taskId, null, 'in_progress');
      await queueUpdate(tx, taskId, null, 'Working.');
    });
    await deliverPendingMondayWrites();

    const events = (await queryAuditEvents({ projectId, limit: 100, offset: 0 })).map((e) => e.eventType);
    expect(events).toContain('monday.assigned');
    expect(events).toContain('monday.status_changed');
    expect(events).toContain('monday.update_posted');
  });
});

// ---------------------------------------------------------------------------
// What Mac may NOT do
// ---------------------------------------------------------------------------

describe('prohibited operations', () => {
  it('has no method that could change a due date or a priority', async () => {
    // Spec §17's prohibitions are not rules enforced somewhere below; they are
    // capabilities that do not exist on the interface.
    const client = monday as unknown as Record<string, unknown>;
    for (const forbidden of [
      'setDueDate',
      'setPriority',
      'deleteItem',
      'deleteBoard',
      'createBoard',
      'createGroup',
      'moveItem',
      'updateUser',
      'changeColumnValue',
    ]) {
      expect(typeof client[forbidden], forbidden).toBe('undefined');
    }
  });

  it('refuses a write aimed at the due-date column, by name', async () => {
    await asAdmin().post(`/api/monday/boards/${boardRowId}/approve`, { approved: true });
    const board = await requireBoardRow(boardRowId);

    try {
      assertColumnWritable(board, 'due');
      expect.unreachable('a due-date write must be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(MondayWriteRefused);
      expect((err as MondayWriteRefused).refusal).toBe('column_is_due_date');
      expect((err as MondayWriteRefused).message).toContain('deadlines');
    }
  });

  it('refuses a write aimed at the priority column, by name', async () => {
    await asAdmin().post(`/api/monday/boards/${boardRowId}/approve`, { approved: true });
    const board = await requireBoardRow(boardRowId);
    expect(() => assertColumnWritable(board, 'priority')).toThrow(MondayWriteRefused);
    try {
      assertColumnWritable(board, 'priority');
    } catch (err) {
      expect((err as MondayWriteRefused).refusal).toBe('column_is_priority');
    }
  });

  it('refuses any column that is not one of the three Mac may write', async () => {
    await asAdmin().post(`/api/monday/boards/${boardRowId}/approve`, { approved: true });
    const board = await requireBoardRow(boardRowId);
    try {
      assertColumnWritable(board, 'some_other_column');
    } catch (err) {
      expect((err as MondayWriteRefused).refusal).toBe('column_not_writable');
    }
  });

  it('refuses every write to an unapproved board', async () => {
    const board = await requireBoardRow(boardRowId); // never approved in this test
    try {
      assertColumnWritable(board, 'status');
    } catch (err) {
      expect((err as MondayWriteRefused).refusal).toBe('board_not_approved');
    }
  });

  it('refuses to mark work Done unless the board explicitly permits it', async () => {
    await asAdmin().post(`/api/monday/boards/${boardRowId}/approve`, { approved: true });
    const board = await requireBoardRow(boardRowId);

    // Ready for Review is Mac's terminal state by default.
    expect(statusLabelFor(board, 'ready_for_review')).toBe('Awaiting Testing');
    try {
      statusLabelFor(board, 'done');
      expect.unreachable('completion must be refused by default');
    } catch (err) {
      expect((err as MondayWriteRefused).refusal).toBe('completion_not_permitted');
    }

    await asAdmin().patch(`/api/monday/boards/${boardRowId}`, { mayComplete: true });
    const permitted = await requireBoardRow(boardRowId);
    expect(statusLabelFor(permitted, 'done')).toBe('Done');
  });

  it('records a refused write as a refusal, not as a delivery failure, and does not retry it', async () => {
    await asAdmin().post(`/api/monday/boards/${boardRowId}/approve`, { approved: true });
    const task = await makeTask(app, operator, projectId, { title: 'Something' });
    await db.update(tasks).set({ mondayItemId: '8891' }).where(eq(tasks.id, task.id));
    addItem();
    await syncBoard(boardRowId, SYSTEM_ACTOR);

    // A board with no assignee column cannot be assigned to.
    await asAdmin().patch(`/api/monday/boards/${boardRowId}`, { assigneeColumnId: null });
    await db.transaction(async (tx) => queueAssignToMac(tx, task.id, null));

    const first = await deliverPendingMondayWrites();
    expect(first.refused).toBe(1);

    // Retrying a refusal would be retrying a decision.
    const second = await deliverPendingMondayWrites();
    expect(second.refused).toBe(0);
    expect(second.delivered).toBe(0);

    const events = (await queryAuditEvents({ projectId, limit: 100, offset: 0 })).map((e) => e.eventType);
    expect(events).toContain('monday.write_refused');
  });
});

// ---------------------------------------------------------------------------
// Scoping
// ---------------------------------------------------------------------------

describe('project scoping', () => {
  it('does not queue a write for a task with no monday item', async () => {
    await asAdmin().post(`/api/monday/boards/${boardRowId}/approve`, { approved: true });
    const orphan = await makeTask(app, operator, projectId, { title: 'Not on the board' });

    await db.transaction(async (tx) => queueStatus(tx, orphan.id, null, 'in_progress'));
    const queued = await db.select().from(mondayWrites);
    expect(queued).toHaveLength(0);
  });

  it('does not queue a write for an unapproved board', async () => {
    const task = await makeTask(app, operator, projectId, { title: 'On an unapproved board' });
    await db.update(tasks).set({ mondayItemId: '8891' }).where(eq(tasks.id, task.id));
    addItem();
    await syncBoard(boardRowId, SYSTEM_ACTOR);

    await db.transaction(async (tx) => queueStatus(tx, task.id, null, 'in_progress'));
    expect(await db.select().from(mondayWrites)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Retry and dead-lettering
// ---------------------------------------------------------------------------

describe('the outbox', () => {
  let taskId: string;

  beforeEach(async () => {
    await asAdmin().post(`/api/monday/boards/${boardRowId}/approve`, { approved: true });
    const task = await makeTask(app, operator, projectId, { title: 'Retryable' });
    taskId = task.id;
    await db.update(tasks).set({ mondayItemId: '8891' }).where(eq(tasks.id, taskId));
    addItem();
    await syncBoard(boardRowId, SYSTEM_ACTOR);
  });

  it('retries a transient failure and eventually delivers', async () => {
    monday.failNextWrites = 1;
    await db.transaction(async (tx) => queueUpdate(tx, taskId, null, 'First attempt.'));

    const first = await deliverPendingMondayWrites();
    expect(first.failed).toBe(1);
    expect(first.delivered).toBe(0);

    // The backoff has not elapsed yet, so nothing is attempted.
    expect((await deliverPendingMondayWrites()).delivered).toBe(0);

    const later = new Date(Date.now() + 60_000);
    expect((await deliverPendingMondayWrites(later)).delivered).toBe(1);
    expect((await monday.listUpdates('8891')).at(-1)!.body).toContain('First attempt');
  });

  it('dead-letters a permanently rejected write rather than retrying forever', async () => {
    monday.failNextWrites = 10;
    monday.failPermanently = true;
    await db.transaction(async (tx) => queueUpdate(tx, taskId, null, 'Doomed.'));

    const result = await deliverPendingMondayWrites();
    expect(result.dead).toBe(1);

    const [row] = await db.select().from(mondayWrites);
    expect(row!.status).toBe('dead');

    const events = (await queryAuditEvents({ projectId, limit: 100, offset: 0 })).map((e) => e.eventType);
    expect(events).toContain('monday.write_failed');
  });

  it('does not deliver the same write twice', async () => {
    await db.transaction(async (tx) => queueUpdate(tx, taskId, null, 'Once only.'));
    await deliverPendingMondayWrites();
    await deliverPendingMondayWrites();

    const posted = (await monday.listUpdates('8891')).filter((u) => u.body.includes('Once only'));
    expect(posted).toHaveLength(1);
  });
});
