import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { MondayStatusIntent, MondayWriteDto, MondayWriteKind } from '@mac/protocol';
import { db, type DbHandle } from '../../db/client.js';
import { mondayBoards, mondayItems, mondayWrites, tasks } from '../../db/schema.js';
import type { MondayBoardRow, MondayWriteRow } from '../../db/schema.js';
import { record, recordRejection, SYSTEM_ACTOR, type Actor } from '../audit.js';
import { MondayApiError } from './client.js';
import { assertColumnWritable, MondayWriteRefused, statusLabelFor } from './guard.js';
import { clientForBoard, macUserIdFor } from './provider.js';

/**
 * The monday.com write outbox (Sprint 3 §5.1).
 *
 * ---------------------------------------------------------------------------
 * WHY AN OUTBOX RATHER THAN CALLING monday.com INLINE
 *
 * A run must not fail because a third party is down, and monday.com must not be
 * updated by a transaction that then rolls back. Writing the intent in the same
 * transaction as the state change that justified it gives exactly-once INTENT
 * with at-least-once DELIVERY — which is the correct trade for a status board,
 * where a duplicated "In Progress" is harmless and a missed "Ready for Review"
 * is not.
 *
 * This is the same reasoning that already governs audit events, applied to a
 * second durable side effect.
 * ---------------------------------------------------------------------------
 */

const MAX_ATTEMPTS = 5;
const BACKOFF_SECONDS = [15, 60, 300, 900];

export const toMondayWriteDto = (row: MondayWriteRow): MondayWriteDto => ({
  id: row.id,
  itemId: row.mondayItemId,
  runId: row.runId,
  kind: row.kind as MondayWriteKind,
  status: row.status as MondayWriteDto['status'],
  attempts: row.attempts,
  providerMessageId: row.providerMessageId,
  lastError: row.lastError,
  createdAt: row.createdAt.toISOString(),
  deliveredAt: row.deliveredAt?.toISOString() ?? null,
});

// ---------------------------------------------------------------------------
// Enqueueing
// ---------------------------------------------------------------------------

export interface EnqueueInput {
  taskId: string;
  runId?: string | null;
  kind: MondayWriteKind;
  payload: Record<string, unknown>;
}

/**
 * Queues a write, inside the caller's transaction.
 *
 * Silently does nothing when the task has no monday item or its board is not
 * approved — which is the correct behaviour rather than an oversight: a project
 * that does not use monday.com must be able to run the whole night shift
 * without every status transition raising.
 */
export async function enqueueMondayWrite(tx: DbHandle, input: EnqueueInput): Promise<string | null> {
  const [linked] = await tx
    .select({ item: mondayItems, board: mondayBoards })
    .from(mondayItems)
    .innerJoin(mondayBoards, eq(mondayBoards.id, mondayItems.boardRowId))
    .where(eq(mondayItems.taskId, input.taskId))
    .limit(1);

  if (!linked || !linked.board.isApproved) return null;

  const [row] = await tx
    .insert(mondayWrites)
    .values({
      boardRowId: linked.board.id,
      mondayItemId: linked.item.itemId,
      runId: input.runId ?? null,
      taskId: input.taskId,
      kind: input.kind,
      payload: input.payload,
      status: 'pending',
      nextAttemptAt: new Date(),
    })
    .returning();

  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// The five writes, expressed in Mac's vocabulary
// ---------------------------------------------------------------------------

export async function queueAssignToMac(tx: DbHandle, taskId: string, runId: string | null): Promise<void> {
  await enqueueMondayWrite(tx, { taskId, runId, kind: 'assign_to_mac', payload: {} });
}

export async function queueStatus(
  tx: DbHandle,
  taskId: string,
  runId: string | null,
  intent: MondayStatusIntent,
): Promise<void> {
  await enqueueMondayWrite(tx, { taskId, runId, kind: 'set_status', payload: { intent } });
}

export async function queueUpdate(
  tx: DbHandle,
  taskId: string,
  runId: string | null,
  body: string,
): Promise<void> {
  await enqueueMondayWrite(tx, { taskId, runId, kind: 'post_update', payload: { body: body.slice(0, 8000) } });
}

export async function queueBlocker(
  tx: DbHandle,
  taskId: string,
  runId: string | null,
  input: { blocked: string; needs: string; continuing: boolean },
): Promise<void> {
  await enqueueMondayWrite(tx, { taskId, runId, kind: 'post_blocker', payload: { ...input } });
}

export async function queuePullRequest(
  tx: DbHandle,
  taskId: string,
  runId: string | null,
  input: { url: string; title: string; summary: string },
): Promise<void> {
  await enqueueMondayWrite(tx, { taskId, runId, kind: 'attach_pull_request', payload: { ...input } });
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export interface DeliveryOutcome {
  delivered: number;
  failed: number;
  refused: number;
  dead: number;
}

/**
 * Drains the outbox.
 *
 * Run by the sweeper and callable directly from a test, so delivery is a step
 * that can be driven deterministically rather than raced.
 */
export async function deliverPendingMondayWrites(
  now = new Date(),
  actor: Actor = SYSTEM_ACTOR,
): Promise<DeliveryOutcome> {
  const due = await db
    .select({ write: mondayWrites, board: mondayBoards })
    .from(mondayWrites)
    .innerJoin(mondayBoards, eq(mondayBoards.id, mondayWrites.boardRowId))
    .where(
      and(
        sql`${mondayWrites.status} IN ('pending', 'failed')`,
        lte(mondayWrites.nextAttemptAt, now),
        sql`${mondayWrites.attempts} < ${MAX_ATTEMPTS}`,
      ),
    )
    .orderBy(asc(mondayWrites.createdAt))
    .limit(50);

  const outcome: DeliveryOutcome = { delivered: 0, failed: 0, refused: 0, dead: 0 };

  for (const { write, board } of due) {
    const result = await deliverOne(write, board, actor, now);
    outcome[result] += 1;
  }

  return outcome;
}

async function deliverOne(
  write: MondayWriteRow,
  board: MondayBoardRow,
  actor: Actor,
  now: Date,
): Promise<keyof DeliveryOutcome> {
  const attempts = write.attempts + 1;

  // Claimed before the call, so a process that dies mid-delivery leaves a row
  // that says so rather than an ambiguous `pending`.
  await db
    .update(mondayWrites)
    .set({ status: 'sending', attempts })
    .where(eq(mondayWrites.id, write.id));

  try {
    const providerMessageId = await performWrite(write, board);

    await db.transaction(async (tx) => {
      await tx
        .update(mondayWrites)
        .set({ status: 'delivered', deliveredAt: new Date(), providerMessageId, lastError: null })
        .where(eq(mondayWrites.id, write.id));

      await record(tx, {
        actor,
        eventType: auditEventFor(write.kind as MondayWriteKind),
        context: { projectId: board.projectId, taskId: write.taskId, runId: write.runId },
        metadata: {
          itemId: write.mondayItemId,
          boardId: board.boardId,
          kind: write.kind,
          payload: write.payload,
          attempts,
        },
      });
    });

    return 'delivered';
  } catch (err) {
    /*
     * A refusal is terminal and is NOT a failure.
     *
     * The guard refused because the write was one Mac may not make — a due
     * date, a priority, an unapproved board. Retrying that would be retrying a
     * decision, so it is recorded as `refused` and audited as a prohibited
     * operation rather than a delivery problem.
     */
    if (err instanceof MondayWriteRefused) {
      await db
        .update(mondayWrites)
        .set({ status: 'refused', lastError: `${err.refusal}: ${err.message}` })
        .where(eq(mondayWrites.id, write.id));

      await recordRejection(db, {
        actor,
        eventType: 'monday.write_refused',
        context: { projectId: board.projectId, taskId: write.taskId, runId: write.runId },
        metadata: {
          itemId: write.mondayItemId,
          boardId: board.boardId,
          kind: write.kind,
          refusal: err.refusal,
          columnId: err.columnId,
          reason: err.message,
        },
      });
      return 'refused';
    }

    const retryable = err instanceof MondayApiError ? err.retryable : true;
    const exhausted = !retryable || attempts >= MAX_ATTEMPTS;
    const delay = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)]!;

    await db
      .update(mondayWrites)
      .set({
        status: exhausted ? 'dead' : 'failed',
        lastError: (err as Error).message.slice(0, 2000),
        nextAttemptAt: new Date(now.getTime() + delay * 1000),
      })
      .where(eq(mondayWrites.id, write.id));

    if (exhausted) {
      // Dead-lettered, surfaced in the UI and listed under Exceptions in the
      // morning email — rather than retried forever where nobody sees it.
      await recordRejection(db, {
        actor,
        eventType: 'monday.write_failed',
        context: { projectId: board.projectId, taskId: write.taskId, runId: write.runId },
        metadata: {
          itemId: write.mondayItemId,
          boardId: board.boardId,
          kind: write.kind,
          attempts,
          reason: (err as Error).message.slice(0, 500),
        },
      });
    }

    return exhausted ? 'dead' : 'failed';
  }
}

/**
 * Turns one queued intent into one provider call.
 *
 * The column guard runs HERE, immediately before the call, rather than at
 * enqueue time — so a board whose approval was revoked, or whose column mapping
 * changed, between queueing and delivery is caught by the state as it is now.
 */
async function performWrite(write: MondayWriteRow, board: MondayBoardRow): Promise<string | null> {
  const client = await clientForBoard(board);
  const payload = (write.payload ?? {}) as Record<string, unknown>;
  const itemId = write.mondayItemId;

  switch (write.kind as MondayWriteKind) {
    case 'assign_to_mac': {
      if (!board.assigneeColumnId) {
        throw new MondayWriteRefused('no_assignee_column', 'This board has no assignee column mapped.');
      }
      const macUserId = macUserIdFor(board);
      if (!macUserId) {
        throw new MondayWriteRefused(
          'no_mac_identity',
          'Mac has no monday.com user id configured, so he cannot assign work to himself.',
        );
      }
      assertColumnWritable(board, board.assigneeColumnId);
      await client.assignToMac({ itemId, boardId: board.boardId, columnId: board.assigneeColumnId, macUserId });
      return null;
    }

    case 'set_status': {
      const intent = String(payload.intent ?? '') as MondayStatusIntent;
      const label = statusLabelFor(board, intent);
      assertColumnWritable(board, board.statusColumnId);
      await client.setStatus({ itemId, boardId: board.boardId, columnId: board.statusColumnId, label });
      return null;
    }

    case 'post_update': {
      const result = await client.postUpdate({ itemId, body: String(payload.body ?? '') });
      return result.updateId;
    }

    case 'post_blocker': {
      const body = renderBlocker(payload);
      const result = await client.postUpdate({ itemId, body });
      return result.updateId;
    }

    case 'attach_pull_request': {
      const url = String(payload.url ?? '');
      const title = String(payload.title ?? 'Pull request');
      // The update always happens; the link column is a bonus when mapped, so a
      // board without one still gets the PR recorded where a human will see it.
      const result = await client.postUpdate({
        itemId,
        body: `**Ready for review** — ${title}\n\n${url}\n\n${String(payload.summary ?? '')}`.slice(0, 8000),
      });
      if (board.pullRequestColumnId) {
        assertColumnWritable(board, board.pullRequestColumnId);
        await client.setPullRequestLink({
          itemId,
          boardId: board.boardId,
          columnId: board.pullRequestColumnId,
          url,
          title,
        });
      }
      return result.updateId;
    }
  }
}

/**
 * A blocker, written the way an engineer would write one.
 *
 * Three things, because those are the three a colleague reading the board at
 * 08:00 actually needs: what stopped, what would unstop it, and whether Mac is
 * still working on something else.
 */
function renderBlocker(payload: Record<string, unknown>): string {
  const continuing = payload.continuing === true;
  return [
    '**Blocked**',
    '',
    String(payload.blocked ?? 'Something is blocked.'),
    '',
    `**What Mac needs:** ${String(payload.needs ?? 'A decision from a human.')}`,
    '',
    continuing
      ? '_Mac has moved on to other eligible work and will not touch this again tonight._'
      : '_This was the last eligible work; Mac is idle until someone unblocks it._',
  ].join('\n');
}

/** One audit event type per write kind, so the trail names what happened. */
const AUDIT_EVENT_BY_KIND = {
  assign_to_mac: 'monday.assigned',
  set_status: 'monday.status_changed',
  post_update: 'monday.update_posted',
  post_blocker: 'monday.blocker_posted',
  attach_pull_request: 'monday.pull_request_attached',
} as const;

const auditEventFor = (kind: MondayWriteKind) => AUDIT_EVENT_BY_KIND[kind];

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listMondayWrites(filter: { runId?: string; taskId?: string } = {}): Promise<MondayWriteDto[]> {
  const conditions = [];
  if (filter.runId) conditions.push(eq(mondayWrites.runId, filter.runId));
  if (filter.taskId) conditions.push(eq(mondayWrites.taskId, filter.taskId));

  const rows = await db
    .select()
    .from(mondayWrites)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(mondayWrites.createdAt))
    .limit(500);

  return rows.map(toMondayWriteDto);
}

/** Counts for the morning email's monday.com section. */
export async function mondayActivitySince(since: Date): Promise<{
  itemsUpdated: number;
  statusChanges: number;
  updatesPosted: number;
  failures: number;
}> {
  const rows = await db
    .select({ kind: mondayWrites.kind, status: mondayWrites.status, itemId: mondayWrites.mondayItemId })
    .from(mondayWrites)
    .where(sql`${mondayWrites.createdAt} >= ${since}`);

  const delivered = rows.filter((r) => r.status === 'delivered');
  return {
    itemsUpdated: new Set(delivered.map((r) => r.itemId)).size,
    statusChanges: delivered.filter((r) => r.kind === 'set_status').length,
    updatesPosted: delivered.filter((r) => r.kind === 'post_update' || r.kind === 'post_blocker').length,
    failures: rows.filter((r) => r.status === 'dead' || r.status === 'refused').length,
  };
}

/** Resolves a task's monday item, for callers that need to know there is one. */
export async function mondayItemForTask(
  taskId: string,
  handle: DbHandle = db,
): Promise<{ item: typeof mondayItems.$inferSelect; board: MondayBoardRow } | null> {
  const [row] = await handle
    .select({ item: mondayItems, board: mondayBoards })
    .from(mondayItems)
    .innerJoin(mondayBoards, eq(mondayBoards.id, mondayItems.boardRowId))
    .where(eq(mondayItems.taskId, taskId))
    .limit(1);
  return row ?? null;
}

/** Used by the night scheduler when it needs the task behind an item. */
export async function taskForMondayItem(itemId: string, handle: DbHandle = db): Promise<string | null> {
  const [row] = await handle
    .select({ taskId: tasks.id })
    .from(tasks)
    .where(eq(tasks.mondayItemId, itemId))
    .limit(1);
  return row?.taskId ?? null;
}
