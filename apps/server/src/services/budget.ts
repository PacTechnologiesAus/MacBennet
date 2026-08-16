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
 * Only rows flagged `is_exact` are counted. An inexact estimate must never
 * silently become the basis for stopping — or for continuing — real work.
 */
export async function recordedSpendForWindow(
  cutoff: CutoffConfig,
  now: Date,
): Promise<{ recordedSpendCents: number; windowStart: Date; windowEnd: Date }> {
  const { start, end } = currentNightWindow(now, cutoff);

  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${runUsage.costCents}), 0)::int` })
    .from(runUsage)
    .where(and(eq(runUsage.isExact, true), gte(runUsage.recordedAt, start), lt(runUsage.recordedAt, end)));

  return { recordedSpendCents: row?.total ?? 0, windowStart: start, windowEnd: end };
}

export async function getBudgetStatus(settings?: Settings, now = new Date()): Promise<BudgetStatusDto> {
  const s = settings ?? (await getSettings());
  const { recordedSpendCents, windowStart, windowEnd } = await recordedSpendForWindow(toCutoffConfig(s), now);

  return {
    currency: s.currency,
    nightlyBudgetCents: s.nightlyBudgetCents,
    recordedSpendCents,
    warningThresholdCents: Math.round((s.nightlyBudgetCents * s.budgetWarningPct) / 100),
    stopThresholdCents: Math.round((s.nightlyBudgetCents * s.budgetStopPct) / 100),
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    // Flips to true only when a provider integration begins writing exact costs.
    providerUsageAvailable: false,
  };
}
