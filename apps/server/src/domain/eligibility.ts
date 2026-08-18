import {
  ELIGIBILITY_LABELS,
  mondayPriorityRank,
  type EligibilityCheck,
  type EligibilityCode,
  type EligibilityVerdict,
} from '@mac/protocol';
import { toScaled } from './confidence.js';

/**
 * May Mac autonomously start this item now? (Sprint 3 §7, brief §8)
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS CODE AND NOT A MODEL
 *
 * The question has a correct answer. It is a conjunction of approval states,
 * statuses, confidence thresholds and dependency facts, every one of which is
 * already recorded somewhere. A model asked it would be fluent, occasionally
 * wrong, and — worse — unable to be disagreed with on a specific clause. The
 * Sprint 3 brief forbids delegating this, and it would be the wrong tool anyway.
 *
 * This module has no I/O at all.
 * ---------------------------------------------------------------------------
 *
 * Every check is reported whether it passed or failed. The Night Queue screen
 * has to answer "why is this eligible?" as readily as "why was this skipped?",
 * and a verdict carrying only failures cannot do that.
 */

export interface EligibilityInput {
  project: {
    nightShiftApproved: boolean;
    isActive: boolean;
  };
  board: {
    isApproved: boolean;
    nightShiftEligible: boolean;
    requireItemFlag: boolean;
    startableStatuses: string[];
    completedStatuses: string[];
    allowedItemTypes: string[];
    macUserId: string | null;
  };
  item: {
    id: string;
    name: string;
    status: string | null;
    priority: string | null;
    assigneeIds: string[];
    nightShiftFlag: boolean;
    dependsOn: string[];
    itemType: string | null;
    dueDate: string | null;
  };
  /** Statuses of the items this one depends on, keyed by monday item id. */
  dependencyStatuses: Record<string, string | null>;
  /** Mac's own side of the question. */
  mac: {
    /** Null when no handoff brief exists for the linked task. */
    briefConfidence: number | null;
    /** True when a human pre-approved a narrower scope for this task. */
    hasApprovedLimitedScope: boolean;
    repositoryApproved: boolean;
    hasActiveRun: boolean;
    /**
     * Mac already ran this task during THIS shift, whatever the outcome.
     *
     * Separate from `hasActiveRun` because the dangerous case is the finished
     * one: a completed run leaves no active run, and if monday.com has not yet
     * been updated — a failed write, a board that is down — the item is still
     * sitting in a startable status. Without this, Mac would cheerfully do the
     * same piece of work twice.
     */
    attemptedThisShift: boolean;
    blockedEarlierTonight: boolean;
  };
  policy: {
    minExecutionConfidence: number;
    defaultConfidenceThreshold: number;
  };
  /** Position on the board, used only to break ties deterministically. */
  boardOrder?: number;
}

const check = (code: EligibilityCode, ok: boolean, detail: string): EligibilityCheck => ({ code, ok, detail });

export function evaluateEligibility(input: EligibilityInput): EligibilityVerdict {
  const { project, board, item, mac, policy } = input;
  const checks: EligibilityCheck[] = [];

  checks.push(
    check(
      'project_approved',
      project.nightShiftApproved && project.isActive,
      project.nightShiftApproved
        ? project.isActive
          ? 'Approved for night-shift work.'
          : 'The project is inactive.'
        : 'Nobody has approved this project for night-shift work.',
    ),
  );

  checks.push(
    check(
      'board_approved',
      board.isApproved,
      board.isApproved ? 'Board mapping is approved.' : 'The board mapping has not been approved.',
    ),
  );

  checks.push(
    check(
      'board_night_eligible',
      board.nightShiftEligible,
      board.nightShiftEligible
        ? 'Board is marked eligible for night-shift work.'
        : 'The board is approved for reading but not marked eligible for autonomous work.',
    ),
  );

  /*
   * The per-item flag, on by default.
   *
   * An item Mac picks up at 02:00 should have been marked deliberately. A board
   * may turn this off, in which case any item in a startable status is fair
   * game — a deliberate choice a human makes once, per board, with the
   * consequence visible on this screen.
   */
  checks.push(
    check(
      'item_flagged',
      !board.requireItemFlag || item.nightShiftFlag,
      board.requireItemFlag
        ? item.nightShiftFlag
          ? 'Explicitly marked for Mac.'
          : 'This board requires an explicit per-item flag, and this item has none.'
        : 'This board does not require a per-item flag.',
    ),
  );

  const startable = board.startableStatuses.map(normalise);
  const status = normalise(item.status ?? '');
  checks.push(
    check(
      'status_startable',
      startable.includes(status),
      startable.includes(status)
        ? `Status "${item.status}" is one Mac may start from.`
        : `Status "${item.status ?? 'none'}" is not startable (expected one of: ${board.startableStatuses.join(', ') || 'none configured'}).`,
    ),
  );

  /*
   * Assignment.
   *
   * Unassigned is fine — that is work waiting for someone. Assigned to Mac is
   * fine. Assigned to a PERSON is not: taking work off a colleague's plate
   * overnight is the sort of helpful act that causes an argument in the morning.
   */
  const assignedElsewhere =
    item.assigneeIds.length > 0 && !(board.macUserId !== null && item.assigneeIds.includes(board.macUserId));
  checks.push(
    check(
      'not_assigned_elsewhere',
      !assignedElsewhere,
      assignedElsewhere
        ? `Assigned to someone else (${item.assigneeIds.join(', ')}).`
        : item.assigneeIds.length === 0
          ? 'Unassigned.'
          : 'Assigned to Mac.',
    ),
  );

  const completed = board.completedStatuses.map(normalise);
  const unfinished = item.dependsOn.filter((id) => {
    const dependencyStatus = input.dependencyStatuses[id];
    // An unknown dependency counts as unfinished. A dependency Mac cannot see
    // is not a dependency he may assume is done.
    return !dependencyStatus || !completed.includes(normalise(dependencyStatus));
  });
  checks.push(
    check(
      'dependencies_clear',
      unfinished.length === 0,
      unfinished.length === 0
        ? item.dependsOn.length === 0
          ? 'No dependencies.'
          : 'All dependencies are complete.'
        : `Waiting on ${unfinished.length} unfinished dependency/dependencies: ${unfinished.join(', ')}.`,
    ),
  );

  const allowedTypes = board.allowedItemTypes.map(normalise);
  const typeAllowed = allowedTypes.length === 0 || allowedTypes.includes(normalise(item.itemType ?? ''));
  checks.push(
    check(
      'task_type_allowed',
      typeAllowed,
      allowedTypes.length === 0
        ? 'This board restricts no task types.'
        : typeAllowed
          ? `Type "${item.itemType}" is allowed.`
          : `Type "${item.itemType ?? 'none'}" is outside the configured allowlist.`,
    ),
  );

  checks.push(
    check(
      'brief_exists',
      mac.briefConfidence !== null,
      mac.briefConfidence !== null
        ? 'A handoff brief exists.'
        : 'No handoff brief. Mac needs a structured understanding before he may implement anything.',
    ),
  );

  const confidence = mac.briefConfidence ?? 0;
  const aboveFloor = mac.briefConfidence !== null && toScaled(confidence) >= toScaled(policy.minExecutionConfidence);
  checks.push(
    check(
      'confidence_above_floor',
      aboveFloor,
      aboveFloor
        ? `Understanding confidence ${(confidence * 100).toFixed(0)}% is above the ${(policy.minExecutionConfidence * 100).toFixed(0)}% floor.`
        : `Understanding confidence ${(confidence * 100).toFixed(0)}% is below the non-overridable execution floor.`,
    ),
  );

  /*
   * The band rule, and the reason it is stricter overnight than by day.
   *
   * Spec §5 permits the 60–79% band to proceed ONLY with an explicit human
   * decision on a narrower scope. Nobody is awake at 02:00 to make that
   * decision, so autonomous SELECTION requires the autonomous band — unless a
   * human already pre-approved a limited scope for this specific task during
   * the day, which is recorded and honoured.
   *
   * This is the rule that stops "keep Mac busy" from quietly eroding the
   * confidence model.
   */
  const autonomous = aboveFloor && toScaled(confidence) >= toScaled(policy.defaultConfidenceThreshold);
  const permitted = autonomous || (aboveFloor && mac.hasApprovedLimitedScope);
  checks.push(
    check(
      'confidence_permits_autonomy',
      permitted,
      autonomous
        ? `Confidence ${(confidence * 100).toFixed(0)}% is in the autonomous band.`
        : mac.hasApprovedLimitedScope
          ? 'Below the autonomy threshold, but a human pre-approved a limited scope for this task.'
          : `Confidence ${(confidence * 100).toFixed(0)}% needs an explicit human decision on scope, and nobody is awake to give one.`,
    ),
  );

  checks.push(
    check(
      'repository_approved',
      mac.repositoryApproved,
      mac.repositoryApproved ? 'Repository is approved.' : 'The project has no approved repository.',
    ),
  );

  checks.push(
    check(
      'no_active_run',
      !mac.hasActiveRun && !mac.attemptedThisShift,
      mac.hasActiveRun
        ? 'A run for this task is already in flight.'
        : mac.attemptedThisShift
          ? 'Mac already worked on this task tonight.'
          : 'No run in flight, and not attempted tonight.',
    ),
  );

  checks.push(
    check(
      'not_previously_blocked',
      !mac.blockedEarlierTonight,
      mac.blockedEarlierTonight
        ? 'This task blocked earlier tonight and the blocker is unresolved; retrying it would just block again.'
        : 'Not blocked earlier tonight.',
    ),
  );

  const blockingCodes = checks.filter((c) => !c.ok).map((c) => c.code);
  const eligible = blockingCodes.length === 0;

  return {
    eligible,
    checks,
    blockingCodes,
    priorityRank: computePriorityRank(input),
    summary: eligible
      ? `Eligible: ${item.name}`
      : `Not eligible — ${blockingCodes.map((c) => ELIGIBILITY_LABELS[c]).join('; ')}`,
  };
}

/**
 * Ordering, lower first: monday priority, then due date, then board position.
 *
 * Composed into one number so the caller sorts on a single key and cannot
 * accidentally apply the tiebreakers in a different order somewhere else.
 *
 * Due date contributes a bounded amount — at most one priority band's worth —
 * so an urgent item due next month still outranks a low-priority one due
 * tomorrow. Commercial priority is a human's judgement about importance and
 * must not be silently overridden by a date.
 */
export function computePriorityRank(input: EligibilityInput): number {
  const priority = mondayPriorityRank(input.item.priority);

  const dueMs = input.item.dueDate ? Date.parse(input.item.dueDate) : Number.NaN;
  const daysAway = Number.isNaN(dueMs) ? null : (dueMs - Date.now()) / 86_400_000;
  // 0 when overdue or due today, approaching 1 as the date recedes past 30 days.
  const urgency = daysAway === null ? 0.5 : Math.max(0, Math.min(1, daysAway / 30));

  const order = Math.min(input.boardOrder ?? 0, 999) / 1000;

  return priority + urgency * 0.9 + order * 0.09;
}

/** Case- and whitespace-insensitive, because board labels are typed by humans. */
const normalise = (value: string): string => value.trim().toLowerCase();
