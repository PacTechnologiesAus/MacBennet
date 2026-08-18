import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { LogEntry, RunLogDto } from '@mac/protocol';
import { MAX_LOG_MESSAGE_CHARS } from '@mac/protocol';
import { db, type DbHandle } from '../db/client.js';
import { runLogs } from '../db/schema.js';

/**
 * Run logs (spec §32 "streamed or polled logs").
 *
 * Append-only, with a monotonic per-run sequence. The unique index on
 * (run_id, seq) plus ON CONFLICT DO NOTHING makes a retried batch idempotent,
 * which is what allows the worker to buffer aggressively and re-send after a
 * network failure without duplicating a single line.
 *
 * Note that these are *run* logs — the operator-facing record of what the
 * worker did. The server's own application logging is a different thing in a
 * different place (pino, stdout), deliberately not mixed in here.
 */

/** Server-side truncation: the worker is a semi-trusted client. */
function clamp(message: string): string {
  if (message.length <= MAX_LOG_MESSAGE_CHARS) return message;
  return `${message.slice(0, MAX_LOG_MESSAGE_CHARS - 15)}… [truncated]`;
}

export async function appendWorkerLogs(
  runId: string,
  entries: LogEntry[],
  handle: DbHandle = db,
): Promise<{ accepted: number; highestSeq: number }> {
  if (entries.length === 0) {
    return { accepted: 0, highestSeq: await highestSeqFor(runId, handle) };
  }

  const values = entries.map((e) => ({
    runId,
    seq: e.seq,
    ts: new Date(e.ts),
    stream: e.stream,
    message: clamp(e.message),
  }));

  const inserted = await handle
    .insert(runLogs)
    .values(values)
    .onConflictDoNothing({ target: [runLogs.runId, runLogs.seq] })
    .returning({ seq: runLogs.seq });

  return { accepted: inserted.length, highestSeq: await highestSeqFor(runId, handle) };
}

async function highestSeqFor(runId: string, handle: DbHandle): Promise<number> {
  const [row] = await handle
    .select({ max: sql<number | null>`max(${runLogs.seq})` })
    .from(runLogs)
    .where(eq(runLogs.runId, runId));
  return row?.max ?? -1;
}

/**
 * Control-plane commentary on a run, written in the server's own voice.
 *
 * Negative sequence numbers keep these out of the worker's sequence space
 * entirely, so a system note can never collide with a worker line or disturb
 * the worker's idempotency guarantee.
 */
export async function appendSystemLog(handle: DbHandle, runId: string, message: string): Promise<void> {
  const [row] = await handle
    .select({ min: sql<number | null>`min(${runLogs.seq})` })
    .from(runLogs)
    .where(and(eq(runLogs.runId, runId), sql`${runLogs.seq} < 0`));
  const nextSeq = (row?.min ?? 0) - 1;

  await handle
    .insert(runLogs)
    .values({ runId, seq: nextSeq, ts: new Date(), stream: 'system', message: clamp(message) })
    .onConflictDoNothing({ target: [runLogs.runId, runLogs.seq] });
}

/**
 * Reads logs for the UI, using the insertion-ordered row id as the poll cursor.
 *
 * The cursor deliberately is NOT `seq`: worker lines occupy ascending
 * non-negative sequences and control-plane notes occupy descending negative
 * ones, so no single `seq` watermark advances over both. The row id does, and
 * insertion order is also the order an operator wants to read.
 */
export async function getRunLogs(
  runId: string,
  opts: { afterId?: number; limit?: number } = {},
): Promise<RunLogDto[]> {
  const limit = Math.min(opts.limit ?? 500, 2000);

  const rows = await db
    .select()
    .from(runLogs)
    .where(
      opts.afterId === undefined
        ? eq(runLogs.runId, runId)
        : and(eq(runLogs.runId, runId), gt(runLogs.id, opts.afterId)),
    )
    .orderBy(asc(runLogs.id))
    .limit(limit);

  return rows.map((r) => ({
    id: Number(r.id),
    seq: r.seq,
    ts: r.ts.toISOString(),
    stream: r.stream as RunLogDto['stream'],
    message: r.message,
  }));
}
