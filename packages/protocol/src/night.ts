import { z } from 'zod';

/**
 * Task eligibility and night scheduling (Sprint 3 §7, §8; spec §8, §26).
 *
 * Two rules govern everything in this file.
 *
 * **The eligibility question has a correct answer, so it is answered in code.**
 * "May Mac autonomously start this item now?" is a conjunction of approval
 * states, statuses, confidence thresholds and dependency facts. A model asked
 * that question would be fluent, occasionally wrong, and unable to explain
 * itself in a way a reviewer could disagree with a specific clause of. The
 * Sprint 3 brief forbids delegating it, and it would be the wrong tool anyway.
 *
 * **Every check is reported, not only the failing ones.** The Night Queue
 * screen has to show why a task IS eligible as well as why one was skipped, and
 * a verdict carrying only failures cannot do that.
 */

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export const ELIGIBILITY_CODES = [
  'project_approved',
  'board_approved',
  'board_night_eligible',
  'item_flagged',
  'status_startable',
  'not_assigned_elsewhere',
  'dependencies_clear',
  'brief_exists',
  'confidence_above_floor',
  'confidence_permits_autonomy',
  'repository_approved',
  'no_active_run',
  'not_previously_blocked',
  'task_type_allowed',
] as const;
export const eligibilityCodeSchema = z.enum(ELIGIBILITY_CODES);
export type EligibilityCode = z.infer<typeof eligibilityCodeSchema>;

export const eligibilityCheckSchema = z.object({
  code: eligibilityCodeSchema,
  ok: z.boolean(),
  detail: z.string().max(500),
});
export type EligibilityCheck = z.infer<typeof eligibilityCheckSchema>;

export const eligibilityVerdictSchema = z.object({
  eligible: z.boolean(),
  /** ALL checks, passing and failing, in a stable order. */
  checks: z.array(eligibilityCheckSchema),
  /** Codes whose check failed. Empty exactly when `eligible` is true. */
  blockingCodes: z.array(eligibilityCodeSchema),
  /** Lower sorts first: monday priority, then due date, then item order. */
  priorityRank: z.number(),
  /** Human-readable one-liner for the queue screen. */
  summary: z.string().max(500),
});
export type EligibilityVerdict = z.infer<typeof eligibilityVerdictSchema>;

/** Human-readable text for a failed check, used by the UI and the report. */
export const ELIGIBILITY_LABELS: Record<EligibilityCode, string> = {
  project_approved: 'Project approved for night shift',
  board_approved: 'monday board mapped and approved',
  board_night_eligible: 'Board marked eligible for night-shift work',
  item_flagged: 'Item explicitly flagged for Mac',
  status_startable: 'Item status is one Mac may start from',
  not_assigned_elsewhere: 'Not assigned to another person',
  dependencies_clear: 'No unfinished dependency',
  brief_exists: 'A handoff brief exists',
  confidence_above_floor: 'Understanding confidence above the execution floor',
  confidence_permits_autonomy: 'Confidence permits unsupervised selection',
  repository_approved: 'Repository approved',
  no_active_run: 'Not already in flight or attempted tonight',
  not_previously_blocked: 'Not blocked earlier tonight',
  task_type_allowed: 'Task type is within the configured allowlist',
};

// ---------------------------------------------------------------------------
// Effort and safe start
// ---------------------------------------------------------------------------

export const EFFORT_SIZE_CLASSES = ['small', 'medium', 'large'] as const;
export const effortSizeClassSchema = z.enum(EFFORT_SIZE_CLASSES);
export type EffortSizeClass = z.infer<typeof effortSizeClassSchema>;

/**
 * An effort estimate, and an explicit statement of how much to trust it.
 *
 * `basis` is not decoration. The requirement is to avoid obviously bad
 * scheduling, not to predict durations, and an estimate whose derivation is
 * invisible cannot be tuned against what actually happened.
 */
export const effortEstimateSchema = z.object({
  sizeClass: effortSizeClassSchema,
  minutes: z.number().int().min(1).max(1440),
  basis: z.string().max(600),
  /** Is a half-finished version of this worth having in the morning? */
  partialUseful: z.boolean(),
  /** Can the work be left mid-flight without damage? Worktrees make this usually true. */
  preservable: z.boolean(),
});
export type EffortEstimate = z.infer<typeof effortEstimateSchema>;

export const safeStartVerdictSchema = z.object({
  safe: z.boolean(),
  reason: z.string().max(600),
  remainingMinutes: z.number().int(),
  requiredMinutes: z.number().int(),
});
export type SafeStartVerdict = z.infer<typeof safeStartVerdictSchema>;

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export const NIGHT_DECISION_KINDS = [
  'continue',
  'finalise',
  'record_blocker',
  'start',
  'skip',
  'idle',
  'stop',
] as const;
export const nightDecisionKindSchema = z.enum(NIGHT_DECISION_KINDS);
export type NightDecisionKind = z.infer<typeof nightDecisionKindSchema>;

export const NIGHT_SHIFT_STATUSES = ['running', 'completed', 'stopped'] as const;
export const nightShiftStatusSchema = z.enum(NIGHT_SHIFT_STATUSES);
export type NightShiftStatus = z.infer<typeof nightShiftStatusSchema>;

/** Why a shift stopped starting new work. Machine-readable, so it can be grouped. */
export const NIGHT_STOP_REASONS = [
  'cutoff_reached',
  'budget_exhausted',
  'usage_threshold',
  'no_eligible_work',
  'guardrail_stop',
  'stopped_by_user',
  'worker_unavailable',
  'sandbox_unavailable',
] as const;
export const nightStopReasonSchema = z.enum(NIGHT_STOP_REASONS);
export type NightStopReason = z.infer<typeof nightStopReasonSchema>;

/**
 * Why a candidate was not chosen.
 *
 * Distinct from `EligibilityCode`: a task can be perfectly eligible and still
 * not started because there is not enough of the night left, and conflating
 * "you may not" with "not now" would make the queue screen lie.
 */
export const SKIP_REASONS = [
  'not_eligible',
  'insufficient_time',
  'lower_priority',
  'worker_busy',
  'budget',
  'usage_threshold',
] as const;
export const skipReasonSchema = z.enum(SKIP_REASONS);
export type SkipReason = z.infer<typeof skipReasonSchema>;

export const schedulingRationaleSchema = z.object({
  decision: nightDecisionKindSchema,
  reason: z.string().max(1000),
  remainingMinutes: z.number().int(),
  candidatesConsidered: z.number().int().min(0),
  /** Whether the budget signal that applied was enforceable money or a soft signal. */
  budgetBasis: z.enum(['exact_hard_budget', 'soft_threshold', 'no_budget_data']),
  usageSourceAtDecision: z.string().max(40),
  skipped: z
    .array(
      z.object({
        taskId: z.string().max(60).nullable(),
        mondayItemId: z.string().max(60).nullable(),
        title: z.string().max(300),
        reason: skipReasonSchema,
        detail: z.string().max(600),
      }),
    )
    .max(100)
    .default([]),
});
export type SchedulingRationale = z.infer<typeof schedulingRationaleSchema>;

/** How a run came to exist. Never conflate a machine selection with a human one. */
export const RUN_SELECTION_SOURCES = ['human', 'night_shift'] as const;
export const runSelectionSourceSchema = z.enum(RUN_SELECTION_SOURCES);
export type RunSelectionSource = z.infer<typeof runSelectionSourceSchema>;

/**
 * Who authorised a run.
 *
 * `night_shift_policy` means a human pre-approved the project, the board and
 * the item, and the eligibility predicate then found the item startable. It is
 * a real authority with a real audit trail — and it is a DIFFERENT authority
 * from a person clicking approve, so the two are never stored in one field.
 */
export const APPROVAL_SOURCES = ['human', 'night_shift_policy'] as const;
export const approvalSourceSchema = z.enum(APPROVAL_SOURCES);
export type ApprovalSource = z.infer<typeof approvalSourceSchema>;
