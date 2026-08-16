import type {
  EffortEstimate,
  EligibilityVerdict,
  NightStopReason,
  SafeStartVerdict,
  SchedulingRationale,
  SkipReason,
  UsageSource,
} from '@mac/protocol';
import { safeToStart, type SafeStartPolicy } from './effort.js';

/**
 * The night scheduling decision (Sprint 3 §8, brief §10).
 *
 * Pure. It takes the state of the night and returns one decision plus the
 * rationale for it, and the caller is responsible for both persisting that
 * rationale and acting on the decision.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER, AND WHY IT IS THAT ORDER
 *
 * Spec §8 gives the preference order and this implements it verbatim:
 *
 *   1. the explicitly assigned or human-approved current task;
 *   2. other eligible work IN THE SAME PROJECT, by monday.com priority;
 *   3. eligible work in other approved projects, by the same ordering.
 *
 * Same-project-first is not arbitrary. The repository is already fetched, the
 * worktree tooling is warm, and the project memory is the one Mac has been
 * reasoning with for the last hour. Switching projects costs real context, so
 * it happens when the current project is exhausted — not merely because another
 * board has a bigger number on it.
 * ---------------------------------------------------------------------------
 */

export interface NightCandidate {
  taskId: string | null;
  mondayItemId: string | null;
  title: string;
  projectId: string;
  projectName: string;
  eligibility: EligibilityVerdict;
  effort: EffortEstimate;
}

export interface CurrentWork {
  runId: string;
  taskId: string;
  projectId: string;
  /** Terminal states are handled by the caller; this is Mac's own lifecycle. */
  status: 'running' | 'blocked' | 'self_review' | 'ready_for_human_review' | 'completed' | 'failed' | 'stopped';
  /** True when the run has produced progress recently rather than stalling. */
  productive: boolean;
}

export interface UsageState {
  source: UsageSource;
  /** Exact money only. Null when nothing enforceable is known. */
  recordedSpendCents: number | null;
  nightlyBudgetCents: number;
  budgetStopPct: number;
  /** Non-exact signal, 0–100, when the provider exposes one. */
  observedPct: number | null;
  softThresholdPct: number;
  softStopsExecution: boolean;
}

export interface NightState {
  now: Date;
  cutoffAt: Date;
  current: CurrentWork | null;
  /**
   * The project Mac worked in most recently, which survives the run that ended.
   *
   * Without it, "prefer the same project" would only hold while a run was in
   * flight — and the moment it matters is the moment one finishes.
   */
  lastProjectId: string | null;
  candidates: NightCandidate[];
  usage: UsageState;
  workerAvailable: boolean;
  /** True when a guardrail already stopped the shift. */
  guardrailStopped: boolean;
  policy: SafeStartPolicy;
  /** Set when an operator asked the shift to end. */
  stopRequested: boolean;
}

export type NightDecision =
  | { action: 'continue'; rationale: SchedulingRationale }
  | { action: 'finalise'; runId: string; rationale: SchedulingRationale }
  | { action: 'record_blocker'; runId: string; rationale: SchedulingRationale }
  | { action: 'start'; candidate: NightCandidate; safeStart: SafeStartVerdict; rationale: SchedulingRationale }
  | { action: 'idle'; rationale: SchedulingRationale }
  | { action: 'stop'; stopReason: NightStopReason; rationale: SchedulingRationale };

interface SkipRecord {
  taskId: string | null;
  mondayItemId: string | null;
  title: string;
  reason: SkipReason;
  detail: string;
}

export function decideNextAction(state: NightState): NightDecision {
  const remainingMinutes = Math.floor((state.cutoffAt.getTime() - state.now.getTime()) / 60_000);
  const budget = classifyBudget(state.usage);

  const rationale = (
    decision: SchedulingRationale['decision'],
    reason: string,
    skipped: SkipRecord[] = [],
  ): SchedulingRationale => ({
    decision,
    reason,
    remainingMinutes,
    candidatesConsidered: state.candidates.length,
    budgetBasis: budget.basis,
    usageSourceAtDecision: state.usage.source,
    skipped,
  });

  // --- 1. Deal with the current task first --------------------------------
  //
  // Ordered before the stop conditions on purpose: a run that has just finished
  // or just blocked must be finalised and reported even if the cutoff has
  // passed, or the night ends with an unreported result.

  if (state.current) {
    switch (state.current.status) {
      case 'completed':
      case 'failed':
      case 'stopped':
      case 'ready_for_human_review':
        return {
          action: 'finalise',
          runId: state.current.runId,
          rationale: rationale('finalise', `Run ${state.current.runId} reached ${state.current.status}; reporting it.`),
        };

      case 'blocked':
        return {
          action: 'record_blocker',
          runId: state.current.runId,
          rationale: rationale(
            'record_blocker',
            'The current task is blocked. Recording it, posting to monday.com, preserving the worktree, ' +
              'and looking for independent work.',
          ),
        };

      case 'running':
      case 'self_review':
        return {
          action: 'continue',
          rationale: rationale(
            'continue',
            state.current.productive
              ? 'The current task is making progress; leaving it alone.'
              : 'The current task is in flight. Nothing to decide until it finishes or blocks.',
          ),
        };
    }
  }

  // --- 2. Stop conditions -------------------------------------------------

  if (state.stopRequested) {
    return { action: 'stop', stopReason: 'stopped_by_user', rationale: rationale('stop', 'An operator ended the shift.') };
  }

  if (state.guardrailStopped) {
    return {
      action: 'stop',
      stopReason: 'guardrail_stop',
      rationale: rationale('stop', 'A guardrail stopped this shift; no further work will be started.'),
    };
  }

  if (remainingMinutes <= 0) {
    return {
      action: 'stop',
      stopReason: 'cutoff_reached',
      rationale: rationale('stop', 'The overnight cutoff has been reached.'),
    };
  }

  if (budget.stop) {
    return {
      action: 'stop',
      stopReason: budget.basis === 'exact_hard_budget' ? 'budget_exhausted' : 'usage_threshold',
      rationale: rationale('stop', budget.reason),
    };
  }

  if (!state.workerAvailable) {
    return {
      action: 'idle',
      rationale: rationale('idle', 'No worker is available to execute anything right now.'),
    };
  }

  // --- 3. Choose the next task --------------------------------------------

  const skipped: SkipRecord[] = [];
  const eligible: NightCandidate[] = [];

  for (const candidate of state.candidates) {
    if (!candidate.eligibility.eligible) {
      skipped.push({
        taskId: candidate.taskId,
        mondayItemId: candidate.mondayItemId,
        title: candidate.title,
        reason: 'not_eligible',
        detail: candidate.eligibility.summary,
      });
      continue;
    }
    eligible.push(candidate);
  }

  if (eligible.length === 0) {
    return {
      action: 'idle',
      rationale: rationale(
        'idle',
        skipped.length > 0
          ? `No eligible work. ${skipped.length} candidate(s) were considered and none qualified.`
          : 'No candidate work at all on the approved boards.',
        skipped,
      ),
    };
  }

  const ordered = orderCandidates(eligible, currentProjectOf(state));

  for (const candidate of ordered) {
    const verdict = safeToStart(state.now, state.cutoffAt, candidate.effort, state.policy);
    if (!verdict.safe) {
      /*
       * Eligible but not now.
       *
       * Recorded as `insufficient_time` rather than `not_eligible`, because
       * conflating "you may not" with "not yet" would make the queue screen lie
       * to whoever reads it in the morning.
       */
      skipped.push({
        taskId: candidate.taskId,
        mondayItemId: candidate.mondayItemId,
        title: candidate.title,
        reason: 'insufficient_time',
        detail: verdict.reason,
      });
      continue;
    }

    // Everything ordered after the winner is skipped for the honest reason.
    for (const rest of ordered) {
      if (rest === candidate || skipped.some((s) => s.title === rest.title)) continue;
      skipped.push({
        taskId: rest.taskId,
        mondayItemId: rest.mondayItemId,
        title: rest.title,
        reason: 'lower_priority',
        detail: `Ranked below "${candidate.title}".`,
      });
    }

    return {
      action: 'start',
      candidate,
      safeStart: verdict,
      rationale: rationale(
        'start',
        `Selected "${candidate.title}" (${candidate.projectName}). ${verdict.reason} ` +
          `Effort: ${candidate.effort.sizeClass}. Eligibility: all ${candidate.eligibility.checks.length} checks passed.`,
        skipped,
      ),
    };
  }

  return {
    action: 'idle',
    rationale: rationale(
      'idle',
      `${eligible.length} task(s) are eligible but none can be safely started with ${remainingMinutes} minute(s) left.`,
      skipped,
    ),
  };
}

/**
 * Spec §8's order, as a comparator.
 *
 * The current project sorts ahead of everything else regardless of priority;
 * within a project it is monday.com priority, then due date, then board
 * position, all folded into `priorityRank` so there is one sort key.
 */
export function orderCandidates(candidates: NightCandidate[], currentProjectId: string | null): NightCandidate[] {
  return [...candidates].sort((a, b) => {
    if (currentProjectId) {
      const aCurrent = a.projectId === currentProjectId ? 0 : 1;
      const bCurrent = b.projectId === currentProjectId ? 0 : 1;
      if (aCurrent !== bCurrent) return aCurrent - bCurrent;
    }
    if (a.eligibility.priorityRank !== b.eligibility.priorityRank) {
      return a.eligibility.priorityRank - b.eligibility.priorityRank;
    }
    // Stable and deterministic: two runs of the scheduler on the same data must
    // pick the same task, or the decision record means nothing.
    return (a.mondayItemId ?? a.title).localeCompare(b.mondayItemId ?? b.title);
  });
}

/**
 * Which project Mac is "in".
 *
 * Read before the current run is cleared, so that finishing a task does not
 * instantly forget which project Mac was working in — which is what makes
 * same-project-first hold across a task boundary rather than only during one.
 */
const currentProjectOf = (state: NightState): string | null => state.lastProjectId ?? null;

/**
 * Budget, with the distinction the usage model exists to preserve.
 *
 * A hard stop happens only on EXACT money. A non-exact signal warns, and stops
 * only when an administrator has explicitly said it should — and the decision
 * record says which of the two applied, so a soft threshold is never reported
 * as though it were a dollar cap.
 */
export function classifyBudget(usage: UsageState): {
  stop: boolean;
  basis: SchedulingRationale['budgetBasis'];
  reason: string;
} {
  if (usage.source === 'exact' && usage.recordedSpendCents !== null && usage.nightlyBudgetCents > 0) {
    const stopAt = Math.round((usage.nightlyBudgetCents * usage.budgetStopPct) / 100);
    if (usage.recordedSpendCents >= stopAt) {
      return {
        stop: true,
        basis: 'exact_hard_budget',
        reason: `Exact recorded spend ${(usage.recordedSpendCents / 100).toFixed(2)} has reached the enforceable nightly limit of ${(stopAt / 100).toFixed(2)}.`,
      };
    }
    return {
      stop: false,
      basis: 'exact_hard_budget',
      reason: `Exact recorded spend is ${(usage.recordedSpendCents / 100).toFixed(2)} of ${(stopAt / 100).toFixed(2)}.`,
    };
  }

  if (usage.observedPct !== null) {
    const past = usage.observedPct >= usage.softThresholdPct;
    return {
      stop: past && usage.softStopsExecution,
      basis: 'soft_threshold',
      reason: past
        ? `Observed usage is ${usage.observedPct.toFixed(1)}%, past the ${usage.softThresholdPct}% soft threshold. ` +
          (usage.softStopsExecution
            ? 'The soft threshold is configured to stop execution.'
            : 'This is an uncertain signal and is not an enforceable limit, so work continues.')
        : `Observed usage is ${usage.observedPct.toFixed(1)}%, below the ${usage.softThresholdPct}% soft threshold.`,
    };
  }

  return {
    stop: false,
    basis: 'no_budget_data',
    reason: 'No usage figure is available for this window, so no budget rule can be applied.',
  };
}
