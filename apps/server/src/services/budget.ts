import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { BudgetStatusDto } from '@mac/protocol';
import { db } from '../db/client.js';
import { runUsage } from '../db/schema.js';
import { currentNightWindow, type CutoffConfig } from '../domain/overnight.js';
import { getSettings, toCutoffConfig, type Settings } from './settings.js';

/**
 * Budget accounting (spec §25).
 *
 * Sprint 1 has no provider-cost integration, so `run_usage` is empty and every
 * figure below is zero. That is deliberate and honest: the spec is explicit
 * that an estimate must never be presented as exact provider usage, so rather
 * than inventing a number we report `providerUsageAvailable: false` and the UI
 * says "Provider usage unavailable".
 *
 * What is real today is the plumbing: the accounting window, the summation, and
 * the dispatch guardrail that reads it. Recording actual usage later is an
 * insert into a table that already exists, not a redesign.
 */

/**
 * The HARD budget: only `exact` monetary cost is counted.
 *
 * Sprint 2 §17 makes this distinction explicit. An estimate — including the
 * list-price equivalent the Claude Code CLI reports under subscription access —
 * must never silently become the basis for stopping, or for continuing, real
 * work. `source = 'exact'` is the filter, and `is_exact` is kept in step with
 * it so no Sprint 1 query changed meaning.
 */
export async function recordedSpendForWindow(
  cutoff: CutoffConfig,
  now: Date,
): Promise<{ recordedSpendCents: number; windowStart: Date; windowEnd: Date }> {
  const { start, end } = currentNightWindow(now, cutoff);

  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${runUsage.costCents}), 0)::int` })
    .from(runUsage)
    .where(and(eq(runUsage.source, 'exact'), gte(runUsage.recordedAt, start), lt(runUsage.recordedAt, end)));

  return { recordedSpendCents: row?.total ?? 0, windowStart: start, windowEnd: end };
}

/**
 * Budget status, separating what is enforceable from what is merely observed.
 *
 * The UI renders `costEnforceable` next to the figures, so it can never imply a
 * dollar limit is being enforced when the only usage available is a
 * subscription estimate.
 */
export async function getBudgetStatus(settings?: Settings, now = new Date()): Promise<BudgetStatusDto> {
  const s = settings ?? (await getSettings());
  const { recordedSpendCents, windowStart, windowEnd } = await recordedSpendForWindow(toCutoffConfig(s), now);

  const { hasRecordedUsage, softUsageForWindow } = await import('./usage.js');
  const window = { start: windowStart, end: windowEnd };
  const [any, soft] = await Promise.all([hasRecordedUsage(window), softUsageForWindow(window)]);

  const softLimitCents = Math.round((s.nightlyBudgetCents * s.softUsageThresholdPct) / 100);
  const softWarning =
    (soft.observedPct !== null && soft.observedPct >= s.softUsageThresholdPct) ||
    (s.nightlyBudgetCents > 0 && soft.estimatedSpendCents >= softLimitCents);

  return {
    currency: s.currency,
    nightlyBudgetCents: s.nightlyBudgetCents,
    recordedSpendCents,
    warningThresholdCents: Math.round((s.nightlyBudgetCents * s.budgetWarningPct) / 100),
    stopThresholdCents: Math.round((s.nightlyBudgetCents * s.budgetStopPct) / 100),
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    providerUsageAvailable: any,
    // A dollar budget is enforceable only against exact money. Under
    // subscription access it is not, and the UI must say so.
    costEnforceable: recordedSpendCents > 0,
    usageSource: any ? soft.source : 'unavailable',
    softUsage: {
      thresholdPct: s.softUsageThresholdPct,
      observedPct: soft.observedPct,
      estimatedSpendCents: soft.estimatedSpendCents,
      warning: softWarning,
      note: any
        ? soft.source === 'exact'
          ? 'Usage for this window is exact provider-reported cost.'
          : `Usage for this window is ${soft.source}. It is a signal, not an enforceable monetary limit.`
        : 'Provider usage unavailable for this window.',
    },
  };
}
