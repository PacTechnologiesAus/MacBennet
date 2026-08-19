import { RUN_STATUSES, isTerminalRunStatus, type RunStatus } from '@mac/protocol';

/**
 * The run lifecycle state machine (spec §24).
 *
 * This table is the ONLY place run status may change shape. Every service that
 * moves a run calls `assertTransition` first, so an invalid transition is a
 * rejected request plus an audit event rather than a corrupt row.
 *
 * Terminal states have no outgoing edges at all: once a run is completed,
 * cancelled, stopped by a guardrail or failed, it stays that way. A rerun is a
 * new run, which keeps the audit trail of the original intact.
 */

export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = Object.freeze({
  draft: ['discovery', 'ready_for_approval', 'cancelled'],
  discovery: ['ready_for_approval', 'blocked', 'draft', 'cancelled'],
  // A rejected run returns to draft so it can be revised and resubmitted.
  ready_for_approval: ['approved', 'draft', 'cancelled'],
  approved: ['queued', 'cancelled', 'stopped_by_guardrail'],
  queued: ['running', 'cancelled', 'stopped_by_guardrail'],
  running: [
    'blocked',
    'self_review',
    'ready_for_human_review',
    'completed',
    'completed_with_gaps',
    'failed',
    'cancelled',
    'stopped_by_guardrail',
  ],
  blocked: ['running', 'cancelled', 'stopped_by_guardrail', 'failed'],
  self_review: ['ready_for_human_review', 'running', 'completed', 'completed_with_gaps', 'failed', 'cancelled'],
  ready_for_human_review: ['completed', 'completed_with_gaps', 'running', 'cancelled'],

  // Terminal.
  completed: [],
  /**
   * Phase 4: terminal, exactly like `completed`.
   *
   * A run that fell short of its acceptance criteria is not resumed. Remediation
   * happens BEFORE completion, while the worker still holds the lease and the
   * night still has time in it; once the run is closed, the honest way to
   * produce the missing deliverable is a new run against the same brief, which
   * leaves the record of the shortfall intact.
   */
  completed_with_gaps: [],
  stopped_by_guardrail: [],
  cancelled: [],
  failed: [],
});

export class InvalidTransitionError extends Error {
  readonly code = 'INVALID_TRANSITION';
  constructor(
    readonly from: RunStatus,
    readonly to: RunStatus,
  ) {
    super(
      isTerminalRunStatus(from)
        ? `Run is already in terminal state '${from}' and cannot move to '${to}'.`
        : `Cannot move a run from '${from}' to '${to}'.`,
    );
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return (RUN_TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** Statuses in which a run is occupying a worker or waiting to. */
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'running',
  'blocked',
  'self_review',
  'ready_for_human_review',
];

/** Statuses from which a cancel can be honoured immediately, with no worker involved. */
export const IMMEDIATELY_CANCELLABLE: readonly RunStatus[] = [
  'draft',
  'discovery',
  'ready_for_approval',
  'approved',
  'queued',
];

/** Statuses where a cancel must be propagated to a worker and acknowledged. */
export const REQUIRES_WORKER_CANCEL: readonly RunStatus[] = ['running', 'blocked', 'self_review'];

/**
 * Sanity check performed once at module load: every status in the protocol has
 * an entry, and every target is a real status. Cheap insurance against a typo
 * in the table above silently disabling a transition.
 */
for (const status of RUN_STATUSES) {
  const targets = RUN_TRANSITIONS[status];
  if (!targets) throw new Error(`Run lifecycle table is missing an entry for '${status}'`);
  for (const target of targets) {
    if (!RUN_STATUSES.includes(target)) {
      throw new Error(`Run lifecycle table has unknown target '${target}' from '${status}'`);
    }
  }
}
