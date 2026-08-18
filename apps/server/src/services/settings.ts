import { eq } from 'drizzle-orm';
import type {
  MailProviderName,
  ModelProviderName,
  SettingsDto,
  UpdateSettingsRequest,
} from '@mac/protocol';
import { emailAddressSchema } from '@mac/protocol';
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
  // --- Sprint 3 ---
  requireSandbox: boolean;
  workerTokenMaxAgeHours: number;
  workerTokenOverlapSeconds: number;
  nightShiftEnabled: boolean;
  nightShiftSafetyFactor: number;
  nightShiftWrapUpMinutes: number;
  nightShiftMinStartMinutes: number;
  nightShiftLargeTaskMinMinutes: number;
  reportRecipients: string[];
  allowedRecipientDomains: string[];
  mailProvider: MailProviderName;
  modelAssistEnabled: boolean;
  modelProvider: ModelProviderName;
  // --- Sprint 3.2 ---
  companyContextEnabled: boolean;
  companyContextAllowCached: boolean;
  companyContextMinRefreshSeconds: number;
  companyContextMaxStaleHours: number;
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
    requireSandbox: row.requireSandbox,
    workerTokenMaxAgeHours: row.workerTokenMaxAgeHours,
    workerTokenOverlapSeconds: row.workerTokenOverlapSeconds,
    nightShiftEnabled: row.nightShiftEnabled,
    nightShiftSafetyFactor: Number(row.nightShiftSafetyFactor),
    nightShiftWrapUpMinutes: row.nightShiftWrapUpMinutes,
    nightShiftMinStartMinutes: row.nightShiftMinStartMinutes,
    nightShiftLargeTaskMinMinutes: row.nightShiftLargeTaskMinMinutes,
    reportRecipients: asStringArray(row.reportRecipients),
    allowedRecipientDomains: asStringArray(row.allowedRecipientDomains),
    mailProvider: row.mailProvider as MailProviderName,
    modelAssistEnabled: row.modelAssistEnabled,
    modelProvider: row.modelProvider as ModelProviderName,
    companyContextEnabled: row.companyContextEnabled,
    companyContextAllowCached: row.companyContextAllowCached,
    companyContextMinRefreshSeconds: row.companyContextMinRefreshSeconds,
    companyContextMaxStaleHours: row.companyContextMaxStaleHours,
    updatedAt: row.updatedAt,
  };
}

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

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
  requireSandbox: s.requireSandbox,
  workerTokenMaxAgeHours: s.workerTokenMaxAgeHours,
  workerTokenOverlapSeconds: s.workerTokenOverlapSeconds,
  nightShiftEnabled: s.nightShiftEnabled,
  nightShiftSafetyFactor: s.nightShiftSafetyFactor,
  nightShiftWrapUpMinutes: s.nightShiftWrapUpMinutes,
  nightShiftMinStartMinutes: s.nightShiftMinStartMinutes,
  nightShiftLargeTaskMinMinutes: s.nightShiftLargeTaskMinMinutes,
  reportRecipients: s.reportRecipients,
  allowedRecipientDomains: s.allowedRecipientDomains,
  mailProvider: s.mailProvider,
  modelAssistEnabled: s.modelAssistEnabled,
  modelProvider: s.modelProvider,
  companyContextEnabled: s.companyContextEnabled,
  companyContextAllowCached: s.companyContextAllowCached,
  companyContextMinRefreshSeconds: s.companyContextMinRefreshSeconds,
  companyContextMaxStaleHours: s.companyContextMaxStaleHours,
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

    /*
     * Recipients must sit inside the domain allowlist.
     *
     * Checked here, at the only place a recipient can be configured, so the
     * send path never has to decide whether an address is acceptable — by the
     * time it reads settings, every address there has already been vetted.
     */
    const recipients = patch.reportRecipients ?? before.reportRecipients;
    const domains = (patch.allowedRecipientDomains ?? before.allowedRecipientDomains).map((d) =>
      d.trim().toLowerCase(),
    );
    if (domains.length > 0) {
      const outside = recipients.filter((address) => {
        const domain = address.split('@')[1]?.toLowerCase() ?? '';
        return !domains.includes(domain);
      });
      if (outside.length > 0) {
        throw AppError.badRequest(
          'RECIPIENT_DOMAIN_NOT_ALLOWED',
          `These report recipients are outside the allowed domains (${domains.join(', ')}): ${outside.join(', ')}.`,
        );
      }
    }
    for (const address of patch.reportRecipients ?? []) {
      if (!emailAddressSchema.safeParse(address).success) {
        throw AppError.badRequest('INVALID_RECIPIENT', `"${address}" is not an email address.`);
      }
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
        // --- Sprint 3 ---
        ...(patch.requireSandbox !== undefined && { requireSandbox: patch.requireSandbox }),
        ...(patch.workerTokenMaxAgeHours !== undefined && { workerTokenMaxAgeHours: patch.workerTokenMaxAgeHours }),
        ...(patch.workerTokenOverlapSeconds !== undefined && {
          workerTokenOverlapSeconds: patch.workerTokenOverlapSeconds,
        }),
        ...(patch.nightShiftEnabled !== undefined && { nightShiftEnabled: patch.nightShiftEnabled }),
        ...(patch.nightShiftSafetyFactor !== undefined && {
          nightShiftSafetyFactor: patch.nightShiftSafetyFactor.toFixed(2),
        }),
        ...(patch.nightShiftWrapUpMinutes !== undefined && { nightShiftWrapUpMinutes: patch.nightShiftWrapUpMinutes }),
        ...(patch.nightShiftMinStartMinutes !== undefined && {
          nightShiftMinStartMinutes: patch.nightShiftMinStartMinutes,
        }),
        ...(patch.nightShiftLargeTaskMinMinutes !== undefined && {
          nightShiftLargeTaskMinMinutes: patch.nightShiftLargeTaskMinMinutes,
        }),
        ...(patch.reportRecipients !== undefined && { reportRecipients: patch.reportRecipients }),
        ...(patch.allowedRecipientDomains !== undefined && {
          allowedRecipientDomains: patch.allowedRecipientDomains.map((d) => d.trim().toLowerCase()),
        }),
        ...(patch.mailProvider !== undefined && { mailProvider: patch.mailProvider }),
        ...(patch.modelAssistEnabled !== undefined && { modelAssistEnabled: patch.modelAssistEnabled }),
        ...(patch.modelProvider !== undefined && { modelProvider: patch.modelProvider }),
        ...(patch.companyContextEnabled !== undefined && { companyContextEnabled: patch.companyContextEnabled }),
        ...(patch.companyContextAllowCached !== undefined && {
          companyContextAllowCached: patch.companyContextAllowCached,
        }),
        ...(patch.companyContextMinRefreshSeconds !== undefined && {
          companyContextMinRefreshSeconds: patch.companyContextMinRefreshSeconds,
        }),
        ...(patch.companyContextMaxStaleHours !== undefined && {
          companyContextMaxStaleHours: patch.companyContextMaxStaleHours,
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
      // Arrays compare by reference, so a list-valued setting would otherwise
      // report a change on every write whether or not anything moved.
      const differs =
        Array.isArray(beforeFields[key]) || Array.isArray(afterFields[key])
          ? JSON.stringify(beforeFields[key]) !== JSON.stringify(afterFields[key])
          : beforeFields[key] !== afterFields[key];
      if (differs) changes[key] = { from: beforeFields[key], to: afterFields[key] };
    }

    await record(tx, { actor, eventType: 'settings.updated', metadata: { changes } });

    return after;
  });
}
