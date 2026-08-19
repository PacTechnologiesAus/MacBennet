import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { MAC_EVENT_TYPES, type MacEventDto, type MacEventType } from '@mac/protocol';
import { db, type DbHandle } from '../db/client.js';
import { eventDeliveries, forjaClients, macEvents } from '../db/schema.js';

/**
 * The event log (Phase 4 Part D §14).
 *
 * ---------------------------------------------------------------------------
 * WHY A TABLE AND NOT A MESSAGE BROKER
 *
 * The phase brief says not to introduce Kafka or similar "unless clearly
 * required. It probably is not." It is not, and the reason is worth stating so
 * that a later reader does not assume this was laziness.
 *
 * What Forja needs is: a durable ordered log, at-least-once delivery, and the
 * ability to resume from where it stopped. Postgres already gives all three —
 * `bigserial` for the ordering, an append-only table for durability, and a
 * cursor for resumption — and the deployment already runs it, backs it up and
 * monitors it. A broker would add an operational dependency to a system whose
 * event volume is measured in dozens per night.
 *
 * ---------------------------------------------------------------------------
 * `seq` IS THE ONLY CURSOR
 *
 * Not `at`. Two events written in the same millisecond have no order between
 * them, and a consumer paging by timestamp will eventually process one and skip
 * the other. `bigserial` is monotonic and gapless enough for the purpose, and
 * the query below reads `> after` rather than `>= after` so a resumed consumer
 * cannot receive its last event twice.
 *
 * ---------------------------------------------------------------------------
 * AN EVENT CANNOT EXIST WITHOUT THE THING IT DESCRIBES
 *
 * `emit` takes a DbHandle, exactly as `record` does in `audit.ts`, and callers
 * pass their transaction. An event therefore commits with the state change it
 * announces, or rolls back with it. A separate connection would let Forja learn
 * that a run started which then did not.
 * ---------------------------------------------------------------------------
 */

export interface EmitInput {
  type: MacEventType;
  projectId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  conversationId?: string | null;
  approvalRequestId?: string | null;
  artefactId?: string | null;
  /**
   * A small, stable payload.
   *
   * Deliberately not "the DTO of whatever changed". An event says THAT
   * something happened and gives the identifiers to go and read it; embedding a
   * full object would make every DTO change a breaking contract change, which
   * is the coupling Part D §13 asks us to avoid.
   */
  data?: Record<string, unknown>;
}

/**
 * Writes one event, and queues it for every client that wants webhooks.
 *
 * Queuing happens in the same transaction for the same reason the event does:
 * a delivery row that exists without its event, or an event that no client is
 * ever told about because the insert after it failed, are both worse than
 * either operation failing outright.
 */
export async function emit(tx: DbHandle, input: EmitInput): Promise<number> {
  const [row] = await tx
    .insert(macEvents)
    .values({
      type: input.type,
      projectId: input.projectId ?? null,
      taskId: input.taskId ?? null,
      runId: input.runId ?? null,
      conversationId: input.conversationId ?? null,
      approvalRequestId: input.approvalRequestId ?? null,
      artefactId: input.artefactId ?? null,
      data: input.data ?? {},
    })
    .returning({ seq: macEvents.seq });

  const seq = row?.seq ?? 0;
  if (!seq) return 0;

  const subscribers = await tx
    .select({ id: forjaClients.id })
    .from(forjaClients)
    .where(and(eq(forjaClients.isActive, true), sql`${forjaClients.webhookUrl} IS NOT NULL`));

  if (subscribers.length) {
    await tx
      .insert(eventDeliveries)
      .values(subscribers.map((client) => ({ clientId: client.id, eventSeq: seq })))
      // The unique index is the real guard; this stops a retry of the enclosing
      // operation from failing on it.
      .onConflictDoNothing();
  }

  return seq;
}

/**
 * Emits on its own connection, for callers that have no transaction to join.
 *
 * Used only where the state change has already committed — the notification
 * sweeper, for instance. Preferring `emit` is the rule; this is the exception,
 * and it is named so that using it is a visible decision.
 */
export async function emitStandalone(input: EmitInput): Promise<number> {
  return db.transaction((tx) => emit(tx, input));
}

const toDto = (row: typeof macEvents.$inferSelect): MacEventDto => ({
  seq: Number(row.seq),
  type: row.type as MacEventType,
  at: row.at.toISOString(),
  projectId: row.projectId,
  taskId: row.taskId,
  runId: row.runId,
  conversationId: row.conversationId,
  approvalRequestId: row.approvalRequestId,
  artefactId: row.artefactId,
  data: (row.data ?? {}) as Record<string, unknown>,
});

/**
 * Reads events after a cursor.
 *
 * `types` filters server-side rather than making a consumer fetch everything
 * and discard most of it — which matters because a filtered consumer would
 * otherwise have to advance its cursor past events it never saw, and would then
 * have no way to widen its filter later without replaying from zero.
 */
export async function readEvents(input: {
  after: number;
  limit: number;
  types?: readonly MacEventType[];
}): Promise<MacEventDto[]> {
  const wanted = (input.types ?? []).filter((t) => (MAC_EVENT_TYPES as readonly string[]).includes(t));

  const rows = await db
    .select()
    .from(macEvents)
    .where(
      wanted.length
        ? and(gt(macEvents.seq, input.after), inArray(macEvents.type, wanted as string[]))
        : gt(macEvents.seq, input.after),
    )
    .orderBy(asc(macEvents.seq))
    .limit(Math.min(input.limit, 500));

  return rows.map(toDto);
}

/**
 * Long-polls for events after a cursor.
 *
 * The same shape as the worker's run lease, which this deployment's nginx
 * already proxies happily at a 300s read timeout. Bounded at 50 seconds so a
 * hung consumer releases the connection well before anything upstream decides
 * to.
 *
 * Polls rather than listening on a Postgres channel: LISTEN/NOTIFY would need a
 * dedicated connection held open per consumer, and at this event volume a
 * one-second poll costs an index scan that returns nothing.
 */
export async function waitForEvents(input: {
  after: number;
  limit: number;
  waitSeconds: number;
  types?: readonly MacEventType[];
  signal?: AbortSignal;
}): Promise<MacEventDto[]> {
  const deadline = Date.now() + Math.min(input.waitSeconds, 50) * 1000;

  for (;;) {
    const events = await readEvents(input);
    if (events.length > 0) return events;
    if (Date.now() >= deadline || input.signal?.aborted) return [];
    await sleep(1000, input.signal);
  }
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

/** The highest sequence written. What a new consumer starts from. */
export async function latestEventSeq(handle: DbHandle = db): Promise<number> {
  const [row] = await handle
    .select({ seq: sql<number>`COALESCE(MAX(${macEvents.seq}), 0)` })
    .from(macEvents);
  return Number(row?.seq ?? 0);
}
