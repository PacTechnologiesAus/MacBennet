import { z } from 'zod';

/**
 * The usage model (Sprint 2 §15, spec §25).
 *
 * The whole point of this file is that three genuinely different things are
 * never allowed to look like the same thing:
 *
 *   exact        the provider told us the number.
 *   observed     the provider exposes a samplable state; before/after gives a delta.
 *   estimated    Mac worked it out himself.
 *   unavailable  nothing reliable was obtainable — say so, do not invent it.
 *
 * `source` is persisted alongside every figure and rendered next to it in the
 * UI. There is deliberately no function anywhere that promotes an estimate to
 * exact, and no default value: a caller must state which of the four it has.
 */

export const USAGE_SOURCES = ['exact', 'observed', 'estimated', 'unavailable'] as const;
export const usageSourceSchema = z.enum(USAGE_SOURCES);
export type UsageSource = z.infer<typeof usageSourceSchema>;

/** Exactly the wording spec §25 requires when nothing is obtainable. */
export const PROVIDER_USAGE_UNAVAILABLE = 'Provider usage unavailable';

export const USAGE_SNAPSHOT_PHASES = ['before', 'after'] as const;
export const usageSnapshotPhaseSchema = z.enum(USAGE_SNAPSHOT_PHASES);
export type UsageSnapshotPhase = z.infer<typeof usageSnapshotPhaseSchema>;

/**
 * A point-in-time reading of a provider's usage state.
 *
 * Every numeric field is optional because a provider that supplies none of them
 * is a normal, expected case — that is what `source: 'unavailable'` means.
 */
export const usageSnapshotSchema = z.object({
  provider: z.string().min(1).max(60),
  phase: usageSnapshotPhaseSchema,
  source: usageSourceSchema,
  capturedAt: z.string(),
  /** Token counts, when the provider reports them. */
  inputTokens: z.number().int().nonnegative().nullable().optional(),
  outputTokens: z.number().int().nonnegative().nullable().optional(),
  cacheReadTokens: z.number().int().nonnegative().nullable().optional(),
  cacheCreationTokens: z.number().int().nonnegative().nullable().optional(),
  /** Monetary cost in cents, when — and only when — it is real money. */
  costCents: z.number().int().nullable().optional(),
  /**
   * A percentage of a subscription allowance, 0–100, when the provider exposes
   * one. Claude Code does not; the field exists because the model must support
   * providers that do, and its absence is itself information.
   */
  percentUsed: z.number().min(0).max(100).nullable().optional(),
  /** Free-form provider state, e.g. a rate-limit status. Never parsed for numbers. */
  state: z.string().max(200).nullable().optional(),
  /** e.g. "five_hour", "monthly" — the window the reading applies to. */
  reportingPeriod: z.string().max(120).nullable().optional(),
  /** Everything the provider said, kept verbatim so a later reading can be re-derived. */
  raw: z.record(z.unknown()).optional(),
  /** Why this source classification was chosen. Shown in the UI on hover. */
  note: z.string().max(500).nullable().optional(),
});
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>;

/**
 * The difference between two snapshots, and — critically — whether that
 * difference means anything.
 */
export interface UsageDelta {
  source: UsageSource;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  costCents: number | null;
  percentUsedDelta: number | null;
  /** False when the two readings are not comparable; the UI then shows no delta. */
  meaningful: boolean;
  note: string | null;
}

const sub = (after: number | null | undefined, before: number | null | undefined): number | null => {
  if (typeof after !== 'number') return null;
  if (typeof before !== 'number') return after;
  return after - before;
};

/**
 * Computes a delta, refusing to produce one when the two readings do not
 * describe the same thing.
 *
 * A delta between an `exact` reading and an `estimated` one is not an exact
 * delta, and presenting it as a number without saying so is precisely the
 * failure mode spec §25 forbids. So: mixed sources degrade to the weaker of the
 * two, and anything involving `unavailable` produces no delta at all.
 */
export function computeUsageDelta(before: UsageSnapshot | null, after: UsageSnapshot | null): UsageDelta {
  const empty: UsageDelta = {
    source: 'unavailable',
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    costCents: null,
    percentUsedDelta: null,
    meaningful: false,
    note: PROVIDER_USAGE_UNAVAILABLE,
  };

  if (!after || after.source === 'unavailable') return empty;

  // An `after` reading with no `before` is still useful when the provider
  // reports per-session totals rather than a running counter — which is exactly
  // how the Claude Code CLI reports.
  if (!before || before.source === 'unavailable') {
    return {
      source: after.source,
      inputTokens: after.inputTokens ?? null,
      outputTokens: after.outputTokens ?? null,
      cacheReadTokens: after.cacheReadTokens ?? null,
      cacheCreationTokens: after.cacheCreationTokens ?? null,
      costCents: after.costCents ?? null,
      percentUsedDelta: null,
      meaningful: true,
      note: before ? null : 'No baseline reading; figures are session totals reported by the provider.',
    };
  }

  const source = weakerSource(before.source, after.source);

  return {
    source,
    inputTokens: sub(after.inputTokens, before.inputTokens),
    outputTokens: sub(after.outputTokens, before.outputTokens),
    cacheReadTokens: sub(after.cacheReadTokens, before.cacheReadTokens),
    cacheCreationTokens: sub(after.cacheCreationTokens, before.cacheCreationTokens),
    costCents: sub(after.costCents, before.costCents),
    percentUsedDelta: sub(after.percentUsed, before.percentUsed),
    meaningful: true,
    note:
      before.source === after.source
        ? null
        : `Readings have different sources (${before.source} → ${after.source}); the delta is reported as ${source}.`,
  };
}

const SOURCE_STRENGTH: Record<UsageSource, number> = {
  exact: 3,
  observed: 2,
  estimated: 1,
  unavailable: 0,
};

export function weakerSource(a: UsageSource, b: UsageSource): UsageSource {
  return SOURCE_STRENGTH[a] <= SOURCE_STRENGTH[b] ? a : b;
}

/**
 * Whether a monetary figure from this source may be enforced as a budget.
 *
 * Only `exact` money is enforceable. Everything else is a soft signal, and the
 * distinction is surfaced to the user rather than hidden — spec §17: "Where only
 * subscription usage is available, do not pretend that a dollar budget is
 * enforceable."
 */
export const isEnforceableCost = (source: UsageSource): boolean => source === 'exact';

/** Human-readable label for a usage figure, always carrying its provenance. */
export function describeUsageSource(source: UsageSource): string {
  switch (source) {
    case 'exact':
      return 'Exact — reported by the provider';
    case 'observed':
      return 'Observed — sampled provider state, before and after';
    case 'estimated':
      return 'Estimated — calculated by Mac, not reported by the provider';
    case 'unavailable':
      return PROVIDER_USAGE_UNAVAILABLE;
  }
}
