import { and, eq, gte, lt, sql } from 'drizzle-orm';
import {
  usageSnapshotSchema,
  type RunUsageSummaryDto,
  type UsageSnapshot,
  type UsageSnapshotDto,
  type UsageSource,
} from '@mac/protocol';
import { db, type DbHandle } from '../db/client.js';
import { runUsage, runs, tasks, usageSnapshots } from '../db/schema.js';
import type { UsageSnapshotRow } from '../db/schema.js';
import { buildUsageSummary } from '../domain/report.js';
import { record, type Actor } from './audit.js';

/**
 * Provider usage (Sprint 2 §15, §16, spec §25).
 *
 * The one invariant this file exists to protect: **a figure is never separated
 * from what kind of figure it is.** `source` is written with every row, carried
 * through every DTO, and rendered next to every number. There is no function
 * here that upgrades an estimate to exact, and no default value for `source` —
 * a caller must state which of the four it has.
 */

const toNumber = (value: string | number | null): number | null => {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
};

export const toUsageSnapshotDto = (row: UsageSnapshotRow): UsageSnapshotDto => ({
  id: row.id,
  runId: row.runId,
  provider: row.provider,
  phase: row.phase as 'before' | 'after',
  source: row.source as UsageSource,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  cacheReadTokens: row.cacheReadTokens,
  cacheCreationTokens: row.cacheCreationTokens,
  costCents: row.costCents,
  percentUsed: toNumber(row.percentUsed),
  state: row.state,
  reportingPeriod: row.reportingPeriod,
  note: row.note,
  capturedAt: row.capturedAt.toISOString(),
});

/**
 * Records a before/after usage reading.
 *
 * Also writes a `run_usage` row when the snapshot carries a monetary figure, so
 * the budget accounting Sprint 1 built has something real to sum — but only
 * `exact` rows count toward a hard budget, which `recordedSpendForWindow`
 * enforces by filtering on `source`.
 */
export async function recordUsageSnapshot(
  runId: string,
  input: UsageSnapshot,
  actor: Actor,
): Promise<UsageSnapshotDto> {
  const snapshot = usageSnapshotSchema.parse(input);

  return db.transaction(async (tx) => {
    const [ctx] = await tx
      .select({ taskId: runs.taskId, projectId: tasks.projectId })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .where(eq(runs.id, runId))
      .limit(1);

    const values = {
      runId,
      provider: snapshot.provider,
      phase: snapshot.phase,
      source: snapshot.source,
      inputTokens: snapshot.inputTokens ?? null,
      outputTokens: snapshot.outputTokens ?? null,
      cacheReadTokens: snapshot.cacheReadTokens ?? null,
      cacheCreationTokens: snapshot.cacheCreationTokens ?? null,
      costCents: snapshot.costCents ?? null,
      percentUsed: snapshot.percentUsed === null || snapshot.percentUsed === undefined ? null : snapshot.percentUsed.toFixed(3),
      state: snapshot.state ?? null,
      reportingPeriod: snapshot.reportingPeriod ?? null,
      note: snapshot.note ?? null,
      raw: snapshot.raw ?? {},
      capturedAt: new Date(snapshot.capturedAt),
    };

    const [row] = await tx
      .insert(usageSnapshots)
      .values(values)
      // A retried upload of the same phase overwrites rather than duplicating.
      .onConflictDoUpdate({ target: [usageSnapshots.runId, usageSnapshots.provider, usageSnapshots.phase], set: values })
      .returning();

    if (snapshot.phase === 'after' && snapshot.source !== 'unavailable') {
      await tx.insert(runUsage).values({
        runId,
        provider: snapshot.provider,
        kind: 'coding_agent_session',
        quantity: snapshot.outputTokens !== null && snapshot.outputTokens !== undefined ? String(snapshot.outputTokens) : null,
        unit: 'output_tokens',
        costCents: snapshot.costCents ?? null,
        // Kept consistent with `source` so no Sprint 1 query changes meaning.
        isExact: snapshot.source === 'exact',
        source: snapshot.source,
        metadata: { note: snapshot.note ?? null, reportingPeriod: snapshot.reportingPeriod ?? null },
      });
    }

    await record(tx, {
      actor,
      eventType: 'usage.snapshot',
      context: { runId, taskId: ctx?.taskId ?? null, projectId: ctx?.projectId ?? null },
      metadata: {
        provider: snapshot.provider,
        phase: snapshot.phase,
        source: snapshot.source,
        inputTokens: snapshot.inputTokens ?? null,
        outputTokens: snapshot.outputTokens ?? null,
        costCents: snapshot.costCents ?? null,
        percentUsed: snapshot.percentUsed ?? null,
        state: snapshot.state ?? null,
        note: snapshot.note ?? null,
      },
    });

    return toUsageSnapshotDto(row!);
  });
}

export async function listUsageSnapshots(runId: string, handle: DbHandle = db): Promise<UsageSnapshotDto[]> {
  const rows = await handle.select().from(usageSnapshots).where(eq(usageSnapshots.runId, runId));
  return rows.map(toUsageSnapshotDto);
}

export async function usageSummaryForRun(runId: string, handle: DbHandle = db): Promise<RunUsageSummaryDto> {
  const snapshots = await listUsageSnapshots(runId, handle);
  const before = snapshots.find((s) => s.phase === 'before') ?? null;
  const after = snapshots.find((s) => s.phase === 'after') ?? null;
  return buildUsageSummary(after?.provider ?? before?.provider ?? null, before, after);
}

/**
 * Non-exact usage recorded in a window.
 *
 * Kept strictly separate from `recordedSpendForWindow`, which sums only exact
 * money. Sprint 2 §17: a soft threshold may warn and may stop if configured,
 * but its uncertainty must remain visible — so the two numbers never merge into
 * one "spend" figure.
 */
export async function softUsageForWindow(
  window: { start: Date; end: Date },
  handle: DbHandle = db,
): Promise<{ estimatedSpendCents: number; observedPct: number | null; source: UsageSource; hasAny: boolean }> {
  const rows = await handle
    .select({ source: runUsage.source, costCents: runUsage.costCents })
    .from(runUsage)
    .where(and(gte(runUsage.recordedAt, window.start), lt(runUsage.recordedAt, window.end)));

  if (rows.length === 0) {
    return { estimatedSpendCents: 0, observedPct: null, source: 'unavailable', hasAny: false };
  }

  const nonExact = rows.filter((r) => r.source !== 'exact');
  const estimatedSpendCents = nonExact.reduce((sum, r) => sum + (r.costCents ?? 0), 0);

  const [pct] = await handle
    .select({ max: sql<string | null>`max(${usageSnapshots.percentUsed})` })
    .from(usageSnapshots)
    .where(and(gte(usageSnapshots.capturedAt, window.start), lt(usageSnapshots.capturedAt, window.end)));

  const sources = new Set(rows.map((r) => r.source as UsageSource));
  const source: UsageSource = sources.has('estimated')
    ? 'estimated'
    : sources.has('observed')
      ? 'observed'
      : sources.has('exact')
        ? 'exact'
        : 'unavailable';

  return { estimatedSpendCents, observedPct: toNumber(pct?.max ?? null), source, hasAny: true };
}

/** Whether any usage at all has been recorded in a window. */
export async function hasRecordedUsage(window: { start: Date; end: Date }, handle: DbHandle = db): Promise<boolean> {
  const [row] = await handle
    .select({ count: sql<number>`count(*)::int` })
    .from(runUsage)
    .where(and(gte(runUsage.recordedAt, window.start), lt(runUsage.recordedAt, window.end)));
  return (row?.count ?? 0) > 0;
}
