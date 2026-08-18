import { eq } from 'drizzle-orm';
import type { MondayItem } from '@mac/protocol';
import { db, type DbHandle } from '../../db/client.js';
import { mondayItems, tasks } from '../../db/schema.js';
import type { MondayBoardRow, MondayItemRow } from '../../db/schema.js';
import { record, SYSTEM_ACTOR, type Actor } from '../audit.js';
import { requireBoardRow } from './boards.js';
import { clientForBoard } from './provider.js';

/**
 * Pulling monday.com into the cache (Sprint 3 §5.1).
 *
 * The cache is a CACHE. A status change on a board does not start, approve or
 * stop a run; it changes what the eligibility predicate sees the next time it
 * looks. That direction is the whole design: monday.com is the visible source
 * of truth for work in progress, and Mac's own lifecycle is the source of truth
 * for what he is doing about it.
 *
 * Reading is pull-based on the night tick rather than webhook-driven, which
 * keeps the "no inbound surface" property Sprint 1 established and Sprint 2
 * kept. A board polled every thirty seconds is fresh enough for work that takes
 * an hour.
 */

export interface SyncResult {
  boardId: string;
  itemsSeen: number;
  itemsLinked: number;
  /** True when the provider could not be reached and the cache is stale. */
  stale: boolean;
  error: string | null;
}

export async function syncBoard(boardRowId: string, actor: Actor = SYSTEM_ACTOR): Promise<SyncResult> {
  const board = await requireBoardRow(boardRowId);
  const client = await clientForBoard(board);

  let fetched: MondayItem[];
  try {
    fetched = await client.listItems(board.boardId, {
      groupIds: Array.isArray(board.groupIds) ? (board.groupIds as string[]) : [],
      limit: 200,
    });
  } catch (err) {
    /*
     * A failed read is not a failed night.
     *
     * The scheduler carries on with whatever the cache holds and records that
     * the data is stale, because a board being unreachable at 02:00 is a reason
     * to be careful, not a reason to stop working.
     */
    return { boardId: board.boardId, itemsSeen: 0, itemsLinked: 0, stale: true, error: (err as Error).message };
  }

  let linked = 0;

  await db.transaction(async (tx) => {
    for (const item of fetched) {
      const linkedTaskId = await upsertItem(tx, board, item);
      if (linkedTaskId) linked += 1;
    }

    await tx
      .update((await import('../../db/schema.js')).mondayBoards)
      .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq((await import('../../db/schema.js')).mondayBoards.id, board.id));

    await record(tx, {
      actor,
      eventType: 'monday.read',
      context: { projectId: board.projectId },
      metadata: { boardId: board.boardId, itemsSeen: fetched.length, itemsLinked: linked },
    });
  });

  return { boardId: board.boardId, itemsSeen: fetched.length, itemsLinked: linked, stale: false, error: null };
}

/**
 * Writes one item into the cache and links it to a Mac task.
 *
 * The link is created lazily and only once: a monday item becomes a task the
 * first time Mac sees it, and the task then carries all of Mac's own state.
 * Creating tasks eagerly for every item on a board would fill the system with
 * work nobody asked Mac to do.
 */
async function upsertItem(tx: DbHandle, board: MondayBoardRow, item: MondayItem): Promise<string | null> {
  const [existing] = await tx.select().from(mondayItems).where(eq(mondayItems.itemId, item.id)).limit(1);

  const values = {
    boardRowId: board.id,
    projectId: board.projectId,
    itemId: item.id,
    groupId: item.groupId,
    name: item.name,
    url: item.url,
    status: item.status,
    priority: item.priority,
    assigneeIds: item.assigneeIds,
    dueDate: item.dueDate,
    description: item.description,
    dependsOn: item.dependsOn,
    nightShiftFlag: item.nightShiftFlag,
    itemType: item.itemType,
    sizeLabel: item.sizeLabel,
    raw: item as unknown as Record<string, unknown>,
    lastSyncedAt: new Date(),
    updatedAt: new Date(),
  };

  /*
   * Link to a task somebody already prepared for this item.
   *
   * This is the normal path, and it is what makes the night shift work: an
   * engineer does discovery during the day, producing a task and a brief
   * carrying an understanding confidence, and records the monday item id on it.
   * Mac then finds that work waiting for him at 22:00 with the confidence
   * already established.
   *
   * The alternative — Mac inventing a brief for an item he has never discussed
   * — would put a number on his understanding that nothing supports, which is
   * precisely what the confidence model exists to prevent.
   */
  const [preparedTask] = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.mondayItemId, item.id)).limit(1);

  if (existing) {
    await tx
      .update(mondayItems)
      .set({ ...values, ...(existing.taskId ? {} : { taskId: preparedTask?.id ?? null }) })
      .where(eq(mondayItems.id, existing.id));
    return existing.taskId ?? preparedTask?.id ?? null;
  }

  const [row] = await tx
    .insert(mondayItems)
    .values({ ...values, taskId: preparedTask?.id ?? null })
    .returning();
  return row?.taskId ?? null;
}

/**
 * Creates the Mac task that mirrors a monday item, if one does not exist.
 *
 * Separate from the sync on purpose: syncing is a read and must stay one, while
 * creating a task is a change to Mac's own state. The scheduler calls this when
 * it decides to work on an item, so a board with two hundred items does not
 * produce two hundred tasks nobody looks at.
 */
export async function ensureTaskForItem(
  tx: DbHandle,
  item: MondayItemRow,
  board: MondayBoardRow,
  actor: Actor,
): Promise<string> {
  if (item.taskId) return item.taskId;

  const [task] = await tx
    .insert(tasks)
    .values({
      projectId: board.projectId,
      title: item.name.slice(0, 200),
      description: item.description,
      status: 'ready',
      priority: mapPriority(item.priority),
      mondayItemId: item.itemId,
      /*
       * Sprint 3.3: this task did NOT originate in Mac's UI.
       *
       * Load-bearing. `origin` decides which queue the night scheduler collects
       * a task from, and a mirrored item defaulting to `direct` would appear in
       * both — so the same work would be considered twice, ordered against
       * itself, and could be started as a direct task with no board update.
       */
      origin: 'monday',
    })
    .returning();
  if (!task) throw new Error('Could not create a task for the monday item.');

  await tx.update(mondayItems).set({ taskId: task.id, updatedAt: new Date() }).where(eq(mondayItems.id, item.id));

  await record(tx, {
    actor,
    eventType: 'monday.item_linked',
    context: { projectId: board.projectId, taskId: task.id },
    metadata: { itemId: item.itemId, itemName: item.name, boardId: board.boardId },
  });

  await record(tx, {
    actor,
    eventType: 'task.created',
    context: { projectId: board.projectId, taskId: task.id },
    metadata: { title: task.title, via: 'monday', mondayItemId: item.itemId },
  });

  return task.id;
}

/**
 * monday.com priority text onto Mac's own four-value priority.
 *
 * Only for display and for Mac's internal ordering — the authoritative ordering
 * for night-shift selection reads the monday label directly, because that is
 * the commercial judgement and squeezing it through a four-value enum first
 * would lose information Mac is not entitled to discard.
 */
function mapPriority(label: string | null): 'low' | 'normal' | 'high' | 'urgent' {
  const key = (label ?? '').trim().toLowerCase();
  if (['critical', 'urgent', 'highest'].includes(key)) return 'urgent';
  if (key === 'high') return 'high';
  if (['low', 'lowest'].includes(key)) return 'low';
  return 'normal';
}

/** Syncs every board Mac is allowed to read. Used by the night tick. */
export async function syncAllApprovedBoards(actor: Actor = SYSTEM_ACTOR): Promise<SyncResult[]> {
  // Every board Mac may read, not only the ones he may work from: a project
  // awaiting night-shift approval should still show a populated queue.
  const { readableBoards } = await import('./boards.js');
  const boards = await readableBoards();
  const results: SyncResult[] = [];
  for (const { board } of boards) {
    results.push(await syncBoard(board.id, actor).catch((err: Error) => ({
      boardId: board.boardId,
      itemsSeen: 0,
      itemsLinked: 0,
      stale: true,
      error: err.message,
    })));
  }
  return results;
}
