import { eq } from 'drizzle-orm';
import type { SettingsDto, UpdateSettingsRequest } from '@mac/protocol';
import { db, type DbHandle } from '../db/client.js';
import { settings } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { isValidTimezone, parseCutoff, type CutoffConfig } from '../domain/overnight.js';
import type { ConfidencePolicy } from '../domain/confidence.js';
import { record, type Actor } from './audit.js';

/**
 * Settings are a single row (id = 1), enforced by a CHECK constraint.
 * A singleton table rather than a key/value store because every setting here is
 * typed, validated and small in number; a KV store would trade all of that away
 * for flexibility nothing needs.
 */

export interface Settings {
  timezone: string;
  overnightCutoff: string;
  defaultConfidenceThreshold: number;
  minExecutionConfidence: number;
  nightlyBudgetCents: number;
  currency: string;
  budgetWarningPct: number;
  budgetStopPct: number;
  heartbeatIntervalSeconds: number;
  heartbeatGraceSeconds: number;
  softUsageThresholdPct: number;
  softUsageStopsExecution: boolean;
  codingAgentEnabled: boolean;
  maxAgentMinutes: number;
  maxQuestionsPerRun: number;
  answerConfidenceThreshold: number;
  updatedAt: Date;
}

export async function getSettings(handle: DbHandle = db): Promise<Settings> {
  const [row] = await handle.select().from(settings).where(eq(settings.id, 1)).limit(1);
  if (!row) {
    // The initial migration inserts this row, so its absence means the database
    // was tampered with or only partially migrated. Failing loudly beats
    // silently inventing defaults for guardrail thresholds.
    throw new AppError(500, 'SETTINGS_MISSING', 'Settings row is missing. Has the database been migrated?');
  }
  return {
    timezone: row.timezone,
    overnightCutoff: row.overnightCutoff,
    defaultConfidenceThreshold: Number(row.defaultConfidenceThreshold),
    minExecutionConfidence: Number(row.minExecutionConfidence),
    nightlyBudgetCents: row.nightlyBudgetCents,
    currency: row.currency,
    budgetWarningPct: row.budgetWarningPct,
    budgetStopPct: row.budgetStopPct,
    heartbeatIntervalSeconds: row.heartbeatIntervalSeconds,
    heartbeatGraceSeconds: row.heartbeatGraceSeconds,
    softUsageThresholdPct: row.softUsageThresholdPct,
    softUsageStopsExecution: row.softUsageStopsExecution,
    codingAgentEnabled: row.codingAgentEnabled,
    maxAgentMinutes: row.maxAgentMinutes,
    maxQuestionsPerRun: row.maxQuestionsPerRun,
    answerConfidenceThreshold: Number(row.answerConfidenceThreshold),
    updatedAt: row.updatedAt,
  };
}

export const toCutoffConfig = (s: Settings): CutoffConfig => ({
  timezone: s.timezone,
  overnightCutoff: s.overnightCutoff,
});

export const toConfidencePolicy = (s: Settings): ConfidencePolicy => ({
  minExecutionConfidence: s.minExecutionConfidence,
  defaultConfidenceThreshold: s.defaultConfidenceThreshold,
});

export const toSettingsDto = (s: Settings): SettingsDto => ({
  timezone: s.timezone,
  overnightCutoff: s.overnightCutoff,
  defaultConfidenceThreshold: s.defaultConfidenceThreshold,
  minExecutionConfidence: s.minExecutionConfidence,
  nightlyBudgetCents: s.nightlyBudgetCents,
  currency: s.currency,
  budgetWarningPct: s.budgetWarningPct,
  budgetStopPct: s.budgetStopPct,
  heartbeatIntervalSeconds: s.heartbeatIntervalSeconds,
  heartbeatGraceSeconds: s.heartbeatGraceSeconds,
  softUsageThresholdPct: s.softUsageThresholdPct,
  softUsageStopsExecution: s.softUsageStopsExecution,
  codingAgentEnabled: s.codingAgentEnabled,
  maxAgentMinutes: s.maxAgentMinutes,
  maxQuestionsPerRun: s.maxQuestionsPerRun,
  answerConfidenceThreshold: s.answerConfidenceThreshold,
  updatedAt: s.updatedAt.toISOString(),
});

export async function updateSettings(
  patch: UpdateSettingsRequest,
  actor: Actor,
): Promise<Settings> {
  if (patch.timezone !== undefined && !isValidTimezone(patch.timezone)) {
    throw AppError.badRequest('INVALID_TIMEZONE', `"${patch.timezone}" is not a recognised IANA timezone.`);
  }
  if (patch.overnightCutoff !== undefined) {
    parseCutoff(patch.overnightCutoff); // throws on a malformed value
  }

  return db.transaction(async (tx) => {
    const before = await getSettings(tx);

    const floor = patch.minExecutionConfidence ?? before.minExecutionConfidence;
    const threshold = patch.defaultConfidenceThreshold ?? before.defaultConfidenceThreshold;
    if (floor > threshold) {
      // Otherwise the "limited scope" band would be inverted and approvals in
      // it would be silently unreachable.
      throw AppError.badRequest(
        'INVALID_CONFIDENCE_POLICY',
        `Minimum execution confidence (${floor}) cannot exceed the autonomy threshold (${threshold}).`,
      );
    }

    // The answering threshold governs when Mac stops answering outright and
    // starts recording flagged assumptions. Below the execution floor it would
    // mean "answer confidently on no evidence", which is exactly backwards.
    const answerAt = patch.answerConfidenceThreshold ?? before.answerConfidenceThreshold;
    if (answerAt < floor) {
      throw AppError.badRequest(
        'INVALID_CONFIDENCE_POLICY',
        `The answering threshold (${answerAt}) cannot be below the minimum execution confidence (${floor}).`,
      );
    }

    const warn = patch.budgetWarningPct ?? before.budgetWarningPct;
    const stop = patch.budgetStopPct ?? before.budgetStopPct;
    if (warn > stop) {
      throw AppError.badRequest(
        'INVALID_BUDGET_POLICY',
        `Budget warning threshold (${warn}%) cannot exceed the stop threshold (${stop}%).`,
      );
    }

    await tx
      .update(settings)
      .set({
        ...(patch.timezone !== undefined && { timezone: patch.timezone }),
        ...(patch.overnightCutoff !== undefined && { overnightCutoff: patch.overnightCutoff }),
        ...(patch.defaultConfidenceThreshold !== undefined && {
          defaultConfidenceThreshold: patch.defaultConfidenceThreshold.toFixed(3),
        }),
        ...(patch.minExecutionConfidence !== undefined && {
          minExecutionConfidence: patch.minExecutionConfidence.toFixed(3),
        }),
        ...(patch.nightlyBudgetCents !== undefined && { nightlyBudgetCents: patch.nightlyBudgetCents }),
        ...(patch.currency !== undefined && { currency: patch.currency.toUpperCase() }),
        ...(patch.budgetWarningPct !== undefined && { budgetWarningPct: patch.budgetWarningPct }),
        ...(patch.budgetStopPct !== undefined && { budgetStopPct: patch.budgetStopPct }),
        ...(patch.heartbeatIntervalSeconds !== undefined && {
          heartbeatIntervalSeconds: patch.heartbeatIntervalSeconds,
        }),
        ...(patch.heartbeatGraceSeconds !== undefined && { heartbeatGraceSeconds: patch.heartbeatGraceSeconds }),
        ...(patch.softUsageThresholdPct !== undefined && { softUsageThresholdPct: patch.softUsageThresholdPct }),
        ...(patch.softUsageStopsExecution !== undefined && { softUsageStopsExecution: patch.softUsageStopsExecution }),
        ...(patch.codingAgentEnabled !== undefined && { codingAgentEnabled: patch.codingAgentEnabled }),
        ...(patch.maxAgentMinutes !== undefined && { maxAgentMinutes: patch.maxAgentMinutes }),
        ...(patch.maxQuestionsPerRun !== undefined && { maxQuestionsPerRun: patch.maxQuestionsPerRun }),
        ...(patch.answerConfidenceThreshold !== undefined && {
          answerConfidenceThreshold: patch.answerConfidenceThreshold.toFixed(3),
        }),
        updatedAt: new Date(),
        updatedBy: actor.id,
      })
      .where(eq(settings.id, 1));

    const after = await getSettings(tx);

    // Record what actually changed, not the whole patch — a settings change on
    // a system that governs autonomous execution deserves a precise record.
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const beforeFields: Record<string, unknown> = { ...before };
    const afterFields: Record<string, unknown> = { ...after };
    for (const key of Object.keys(patch)) {
      if (beforeFields[key] !== afterFields[key]) {
        changes[key] = { from: beforeFields[key], to: afterFields[key] };
      }
    }

    await record(tx, { actor, eventType: 'settings.updated', metadata: { changes } });

    return after;
  });
}
