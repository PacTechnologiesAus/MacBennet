import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_MONDAY_STATUS_LABELS } from '@mac/protocol';
import type { MondayBoard, MondayItem } from '@mac/protocol';
import { MondayGraphqlClient } from '../../src/services/monday/graphql.js';
import { assertColumnWritable, statusLabelFor, MondayWriteRefused } from '../../src/services/monday/guard.js';
import type { MondayBoardRow } from '../../src/db/schema.js';

/**
 * monday.com COMMISSIONING — the real API, on a dedicated board.
 *
 * Sprint 3.1 §3, §4, §5 and §6. Opt-in, and skipped by default: it talks to a
 * live third party and writes to a real board.
 *
 *   MONDAY_API_TOKEN=...              (repository-root .env is fine)
 *   MAC_MONDAY_LIVE_TEST=1
 *   MAC_MONDAY_TEST_BOARD_ID=...      a board created FOR THIS
 *   MAC_MONDAY_UNAPPROVED_BOARD_ID=.. a second board deliberately not mapped
 *
 * Columns are resolved BY TITLE from the live board rather than assumed, which
 * is the point of §6: monday generates ids like `color_mm6axkch`, and any test
 * that hardcodes `status` is testing a board that does not exist. The one
 * assumption made here is the set of column TITLES, which is the board's own
 * documented shape and is asserted rather than hoped for.
 *
 * What is deliberately NOT attempted: any prohibited operation. "Mac cannot
 * change a due date" is proven by the absence of a method — asserted below
 * against the client's own shape — and by the guard refusing the column id by
 * name. Firing a destructive mutation at a real board to watch it fail would
 * prove something about the board's permissions, not about Mac.
 */

const ENABLED = process.env.MAC_MONDAY_LIVE_TEST === '1';
const TOKEN = process.env.MONDAY_API_TOKEN ?? '';
const BOARD_ID = process.env.MAC_MONDAY_TEST_BOARD_ID ?? '';
const UNAPPROVED_BOARD_ID = process.env.MAC_MONDAY_UNAPPROVED_BOARD_ID ?? '';

const runnable = ENABLED && Boolean(TOKEN && BOARD_ID);

if (ENABLED && !runnable) {
  // eslint-disable-next-line no-console
  console.warn(
    '\n*** MAC_MONDAY_LIVE_TEST=1 but monday.com commissioning cannot run ***\n' +
      'Set MONDAY_API_TOKEN and MAC_MONDAY_TEST_BOARD_ID.\n',
  );
}

/** Column titles this commissioning board is documented to carry. */
const TITLES = {
  status: 'Status',
  priority: 'Priority',
  assignee: 'Owner',
  dueDate: 'Due date',
  pullRequest: 'Pull Request',
  nightShiftFlag: 'Night Shift',
  itemType: 'Item Type',
  size: 'Size',
  dependency: 'Depends On',
} as const;

type ColumnKey = keyof typeof TITLES;

let client: MondayGraphqlClient;
let board: MondayBoard;
let columnIds: Record<ColumnKey, string>;
let mapped: MondayGraphqlClient;
let items: MondayItem[];
/** The monday user the configured token actually acts as. */
let actingUser: { id: string; name: string };
let accountUsers: Array<{ id: string; name: string }>;
/** The item commissioning writes to — Task A by convention. */
let subject: MondayItem;

/** A direct call, for facts the client deliberately has no method for. */
async function raw<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: TOKEN, 'API-Version': '2024-10' },
    body: JSON.stringify({ query, variables }),
  });
  const parsed = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (parsed.errors?.length) throw new Error(parsed.errors.map((e) => e.message).join('; '));
  return parsed.data as T;
}

/**
 * A board row shaped exactly as the mapping layer would store this board.
 *
 * The guard takes a row, not a live board, so this is what lets the structural
 * refusals be exercised against REAL column ids rather than invented ones.
 */
function boardRow(overrides: Partial<MondayBoardRow> = {}): MondayBoardRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    projectId: '00000000-0000-0000-0000-000000000002',
    boardId: BOARD_ID,
    name: board.name,
    groupIds: [],
    statusColumnId: columnIds.status,
    assigneeColumnId: columnIds.assignee,
    priorityColumnId: columnIds.priority,
    dueDateColumnId: columnIds.dueDate,
    pullRequestColumnId: columnIds.pullRequest,
    dependencyColumnId: columnIds.dependency,
    nightShiftFlagColumnId: columnIds.nightShiftFlag,
    itemTypeColumnId: columnIds.itemType,
    sizeColumnId: columnIds.size,
    statusLabels: { ...DEFAULT_MONDAY_STATUS_LABELS },
    startableStatuses: ['Ready for Mac'],
    completedStatuses: ['Done'],
    allowedItemTypes: [],
    mayComplete: false,
    nightShiftEligible: true,
    requireItemFlag: true,
    macUserId: null,
    isApproved: true,
    approvedBy: null,
    approvedAt: new Date(),
    lastSyncedAt: null,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as MondayBoardRow;
}

beforeAll(async () => {
  if (!runnable) return;

  client = new MondayGraphqlClient({ token: TOKEN });

  const fetched = await client.getBoard(BOARD_ID);
  if (!fetched) throw new Error(`Board ${BOARD_ID} was not readable.`);
  board = fetched;

  const byTitle = new Map(board.columns.map((c) => [c.title, c.id]));
  const missing = Object.entries(TITLES).filter(([, title]) => !byTitle.has(title));
  if (missing.length) {
    throw new Error(
      `Board "${board.name}" is missing commissioning columns: ${missing.map(([, t]) => t).join(', ')}`,
    );
  }
  columnIds = Object.fromEntries(
    Object.entries(TITLES).map(([key, title]) => [key, byTitle.get(title)!]),
  ) as Record<ColumnKey, string>;

  mapped = client.withColumnMap(columnIds);
  items = await mapped.listItems(BOARD_ID, { limit: 100 });

  const me = await raw<{ me: { id: string; name: string } }>('query { me { id name } }');
  actingUser = { id: String(me.me.id), name: me.me.name };

  const users = await raw<{ users: Array<{ id: string; name: string }> }>('query { users { id name } }');
  accountUsers = users.users.map((u) => ({ id: String(u.id), name: u.name }));

  const found = items.find((i) => i.name.startsWith('Task A'));
  if (!found) throw new Error('Task A is not on the commissioning board.');
  subject = found;
}, 120_000);

// ---------------------------------------------------------------------------
// §3.1 and §5 — authentication and identity
// ---------------------------------------------------------------------------

describe.skipIf(!runnable)('monday.com commissioning — authentication and identity', () => {
  it('authenticates against the real API and resolves to a user', async () => {
    const availability = await client.isAvailable();
    expect(availability.available, availability.reason).toBe(true);
  });

  it('records WHICH monday user Mac acts as, because it is not Mac', () => {
    expect(actingUser.id).toBeTruthy();
    // eslint-disable-next-line no-console
    console.info(`\n[identity] Mac's writes are attributed to: ${actingUser.name} (id ${actingUser.id})\n`);

    // The finding, asserted rather than left as prose: the account has no user
    // called Mac Bennett, so there is no identity for him to act as and no
    // person column value that could display him as the assignee. Making this
    // an assertion means the day a real Mac seat is created, this test fails
    // and somebody has to come and update the claim.
    const macSeat = accountUsers.find((u) => /mac\s*bennett/i.test(u.name));
    expect(
      macSeat,
      `A monday user matching "Mac Bennett" now exists (${macSeat?.id}). ` +
        'Mac can be given his own identity: re-run commissioning §5 and update the report.',
    ).toBeUndefined();
  });

  it('cannot manufacture an identity it does not have', () => {
    // There is no client method that creates or alters a user, so "make Mac a
    // user" is not something the integration could do even by mistake.
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(client));
    expect(surface).not.toContain('createUser');
    expect(surface).not.toContain('updateUser');
    expect(surface).not.toContain('inviteUser');
  });
});

// ---------------------------------------------------------------------------
// §3.2–3.9 and §6 — reads and mapping
// ---------------------------------------------------------------------------

describe.skipIf(!runnable)('monday.com commissioning — reads', () => {
  it('reads the approved board', () => {
    expect(board.id).toBe(BOARD_ID);
    expect(board.name.length).toBeGreaterThan(0);
  });

  it('reads groups', () => {
    expect(board.groups.length).toBeGreaterThan(0);
    for (const group of board.groups) {
      expect(group.id).toBeTruthy();
      expect(group.title).toBeTruthy();
    }
  });

  it('reads items', () => {
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.name.length).toBeGreaterThan(0);
  });

  it('resolves REAL generated column ids rather than assuming canonical ones', () => {
    // The §6 point stated as an assertion: on a real board these are generated,
    // and any mapping that assumed "status" would have read nothing.
    expect(columnIds.status).not.toBe('status');
    expect(columnIds.assignee).not.toBe('person');
    for (const id of Object.values(columnIds)) expect(id).toBeTruthy();
  });

  it('reads relevant column values through Mac’s vocabulary', () => {
    expect(subject.columns.length).toBeGreaterThan(0);
    // Every mapped column id is actually present on the item payload.
    const present = new Set(subject.columns.map((c) => c.id));
    for (const [key, id] of Object.entries(columnIds)) {
      expect(present.has(id), `mapped column ${key} (${id}) was not on the item`).toBe(true);
    }
  });

  it('identifies priority', () => {
    expect(subject.priority).toBeTruthy();
  });

  it('identifies status', () => {
    expect(subject.status).toBeTruthy();
  });

  it('identifies assignee', async () => {
    // Read the shape rather than a particular person: assignment is exercised
    // by the write test below, and this asserts the parse round-trips.
    const reread = await mapped.getItem(subject.id);
    expect(Array.isArray(reread!.assigneeIds)).toBe(true);
  });

  it('identifies the night-shift flag, item type and size a human set', () => {
    expect(subject.nightShiftFlag).toBe(true);
    expect(subject.itemType).toBeTruthy();
    expect(subject.sizeLabel).toBeTruthy();
  });

  it('identifies the due date WITHOUT modifying it', async () => {
    const before = (await mapped.getItem(subject.id))!.dueDate;
    expect(before).toBeTruthy();

    // Everything Mac does in a night, short of the writes tested below.
    await mapped.listItems(BOARD_ID, { limit: 100 });
    await mapped.listUpdates(subject.id, 5);
    await mapped.getItem(subject.id);

    const after = (await mapped.getItem(subject.id))!.dueDate;
    expect(after).toBe(before);
  }, 60_000);

  it('reads the item’s update feed — where the engineer’s 16:00 caveat lives', async () => {
    const updates = await mapped.listUpdates(subject.id, 20);
    expect(Array.isArray(updates)).toBe(true);
    for (const update of updates) {
      expect(update.id).toBeTruthy();
      expect(typeof update.body).toBe('string');
    }
  });

  it('filters by group, so an unmapped group is not work Mac can see', async () => {
    const approvedGroup = board.groups.find((g) => /night shift/i.test(g.title)) ?? board.groups[0]!;
    const scoped = await mapped.listItems(BOARD_ID, { groupIds: [approvedGroup.id], limit: 100 });

    expect(scoped.length).toBeGreaterThan(0);
    for (const item of scoped) expect(item.groupId).toBe(approvedGroup.id);
    // The control item lives in the other group and must not appear.
    expect(scoped.some((i) => i.name.startsWith('Task D'))).toBe(false);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// §3.10–3.16 — the five writes, against the real API
// ---------------------------------------------------------------------------

describe.skipIf(!runnable)('monday.com commissioning — the writes Mac is allowed', () => {
  it('assigns an eligible item to Mac’s configured monday user', async () => {
    // The identity is the token's own user, which IS the finding: Mac has no
    // seat, so "assign to Mac" resolves to whoever the integration authenticates
    // as. The mechanism is what is under test here.
    await client.assignToMac({
      itemId: subject.id,
      boardId: BOARD_ID,
      columnId: columnIds.assignee,
      macUserId: actingUser.id,
    });

    const after = await mapped.getItem(subject.id);
    expect(after!.assigneeIds).toContain(actingUser.id);
  }, 60_000);

  it('changes the status to In Progress', async () => {
    const label = statusLabelFor(boardRow(), 'in_progress');
    await client.setStatus({ itemId: subject.id, boardId: BOARD_ID, columnId: columnIds.status, label });

    const after = await mapped.getItem(subject.id);
    expect(after!.status).toBe(label);
  }, 60_000);

  it('posts a meaningful internal update', async () => {
    const marker = `commissioning-update-${Date.now()}`;
    const body =
      `Mac Bennett — Sprint 3.1 commissioning.\n\n` +
      `Started work on this item. Branch: mac/commissioning-task-a. Marker: ${marker}`;

    const posted = await client.postUpdate({ itemId: subject.id, body });
    expect(posted.updateId).toBeTruthy();

    const updates = await client.listUpdates(subject.id, 10);
    expect(updates.some((u) => u.body.includes(marker))).toBe(true);
  }, 60_000);

  it('posts a blocker', async () => {
    const marker = `commissioning-blocker-${Date.now()}`;
    const body =
      `Mac Bennett — blocked.\n\n` +
      `I need a decision I cannot make safely on my own. Marker: ${marker}\n` +
      `Work so far is preserved on the branch; I have moved to the next eligible item.`;

    const posted = await client.postUpdate({ itemId: subject.id, body });
    expect(posted.updateId).toBeTruthy();

    const updates = await client.listUpdates(subject.id, 10);
    expect(updates.some((u) => u.body.includes(marker))).toBe(true);
  }, 60_000);

  it('attaches a pull-request link, and the board holds the URL', async () => {
    const url = 'https://github.com/example/commissioning/pull/1';
    await client.setPullRequestLink({
      itemId: subject.id,
      boardId: BOARD_ID,
      columnId: columnIds.pullRequest,
      url,
      title: 'Task A — add a --json flag',
    });

    const after = await mapped.getItem(subject.id);
    const column = after!.columns.find((c) => c.id === columnIds.pullRequest);
    expect(column?.value ?? '').toContain('/pull/1');
  }, 60_000);

  it('moves the item to Ready for Review', async () => {
    const label = statusLabelFor(boardRow(), 'ready_for_review');
    await client.setStatus({ itemId: subject.id, boardId: BOARD_ID, columnId: columnIds.status, label });

    const after = await mapped.getItem(subject.id);
    expect(after!.status).toBe(label);
  }, 60_000);

  it('marks Complete ONLY where the board explicitly permits it', async () => {
    // Default: refused, by the guard, before any request is built.
    expect(() => statusLabelFor(boardRow({ mayComplete: false }), 'done')).toThrow(MondayWriteRefused);
    try {
      statusLabelFor(boardRow({ mayComplete: false }), 'done');
    } catch (err) {
      expect((err as MondayWriteRefused).refusal).toBe('completion_not_permitted');
    }

    // Opted in per board: allowed, and it really lands on the real board.
    const label = statusLabelFor(boardRow({ mayComplete: true }), 'done');
    await client.setStatus({ itemId: subject.id, boardId: BOARD_ID, columnId: columnIds.status, label });
    const after = await mapped.getItem(subject.id);
    expect(after!.status).toBe(label);

    // Leave the board where the commissioning night expects to find it.
    await client.setStatus({
      itemId: subject.id,
      boardId: BOARD_ID,
      columnId: columnIds.status,
      label: 'Ready for Mac',
    });
  }, 90_000);
});

// ---------------------------------------------------------------------------
// §4 — what Mac structurally cannot do
// ---------------------------------------------------------------------------

describe.skipIf(!runnable)('monday.com commissioning — prohibited operations are absent', () => {
  const surface = () => Object.getOwnPropertyNames(Object.getPrototypeOf(client));

  it('has no method that could change a due date or a commercial priority', () => {
    for (const forbidden of ['setDueDate', 'setPriority', 'changeDueDate', 'changePriority']) {
      expect(surface()).not.toContain(forbidden);
    }
  });

  it('has no method that could delete an item or a board', () => {
    for (const forbidden of ['deleteItem', 'deleteBoard', 'archiveItem', 'archiveBoard']) {
      expect(surface()).not.toContain(forbidden);
    }
  });

  it('has no method that could restructure a board or move an item', () => {
    for (const forbidden of ['createBoard', 'createColumn', 'deleteColumn', 'moveItem', 'createGroup', 'deleteGroup']) {
      expect(surface()).not.toContain(forbidden);
    }
  });

  it('has no method that could modify a user', () => {
    for (const forbidden of ['updateUser', 'createUser', 'deactivateUser', 'inviteUser']) {
      expect(surface()).not.toContain(forbidden);
    }
  });

  it('exposes no generic column mutation through which any of those could be reached', () => {
    // monday's own API is exactly one generic mutation, so this is the property
    // that makes every absence above hold rather than being a naming convention.
    //
    // Commissioning defect #2: this was `private async changeColumn`, which
    // TypeScript erases. A cast reached it, and through it every prohibition
    // above. It is now a `#` field, which the runtime enforces.
    expect(surface()).not.toContain('changeColumn');
    expect(surface()).not.toContain('changeColumnValue');

    const escaped = client as unknown as Record<string, unknown>;
    expect(escaped.changeColumn).toBeUndefined();
    // The raw GraphQL escape hatch is the same category and is closed too:
    // reaching it would mean arbitrary mutations, not merely arbitrary columns.
    expect(surface()).not.toContain('query');
    expect(escaped.query).toBeUndefined();

    const publicWrites = surface().filter((name) =>
      /^(assign|set|post|create|update|delete|change|move|archive)/i.test(name),
    );
    expect(publicWrites.sort()).toEqual(['assignToMac', 'postUpdate', 'setPullRequestLink', 'setStatus'].sort());
  });

  it('does not hand the API token to anything that can reach the object', () => {
    // The token is a `#` field, so it is absent from the object's own keys,
    // from a spread, and from anything that serialises a client into a log.
    const escaped = client as unknown as Record<string, unknown>;
    expect(escaped.options).toBeUndefined();
    expect(Object.keys(client)).not.toContain('options');
    expect(JSON.stringify(client)).not.toContain(TOKEN);
    expect(JSON.stringify({ ...client })).not.toContain(TOKEN);
  });

  it('refuses the due-date and priority columns BY NAME, using this board’s real ids', () => {
    const row = boardRow();

    expect(() => assertColumnWritable(row, columnIds.dueDate)).toThrow(MondayWriteRefused);
    try {
      assertColumnWritable(row, columnIds.dueDate);
    } catch (err) {
      expect((err as MondayWriteRefused).refusal).toBe('column_is_due_date');
      expect((err as MondayWriteRefused).columnId).toBe(columnIds.dueDate);
    }

    try {
      assertColumnWritable(row, columnIds.priority);
    } catch (err) {
      expect((err as MondayWriteRefused).refusal).toBe('column_is_priority');
      expect((err as MondayWriteRefused).columnId).toBe(columnIds.priority);
    }
  });

  it('refuses every other column on this real board too', () => {
    const row = boardRow();
    const writable = new Set([columnIds.status, columnIds.assignee, columnIds.pullRequest]);

    for (const column of board.columns) {
      if (writable.has(column.id) || column.id === 'name') continue;
      expect(() => assertColumnWritable(row, column.id), `column ${column.title} (${column.id})`).toThrow(
        MondayWriteRefused,
      );
    }
  });

  it('refuses every write to a board nobody approved', () => {
    const row = boardRow({ isApproved: false });
    for (const columnId of [columnIds.status, columnIds.assignee, columnIds.pullRequest]) {
      try {
        assertColumnWritable(row, columnId);
        throw new Error(`expected a refusal for ${columnId}`);
      } catch (err) {
        expect((err as MondayWriteRefused).refusal).toBe('board_not_approved');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §4 — board scoping, stated honestly
// ---------------------------------------------------------------------------

describe.skipIf(!runnable && !UNAPPROVED_BOARD_ID)('monday.com commissioning — unapproved board scoping', () => {
  it('the TOKEN can see the unapproved board — the restriction is not in its permissions', async () => {
    // Recorded deliberately. Sprint 3 claims the scoping lives in the query
    // rather than in the token, and a commissioning report that implied the
    // token was scoped would be claiming something untrue.
    const other = await client.getBoard(UNAPPROVED_BOARD_ID);
    expect(other, 'the unapproved board should be visible to the raw token').not.toBeNull();
  }, 60_000);

  it('but every write to it is refused, because it is not an approved mapping', () => {
    const row = boardRow({ boardId: UNAPPROVED_BOARD_ID, isApproved: false, name: 'Unapproved' });
    try {
      assertColumnWritable(row, columnIds.status);
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as MondayWriteRefused).refusal).toBe('board_not_approved');
    }
  });
});
