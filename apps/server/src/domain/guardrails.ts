import { parseJobSpec, type JobSpec, type RunStatus, type ApprovalState } from '@mac/protocol';
import { isPastDeadline } from './overnight.js';

/**
 * Guardrails, expressed as pure predicates.
 *
 * Spec Step 7 requires these to live in the backend rather than in prompts.
 * Keeping them here — with no database or HTTP dependency — means each one is
 * directly unit-testable, and means the services layer cannot accidentally
 * express the rule slightly differently in two places.
 *
 * The approval guardrail is additionally enforced as a SQL predicate in the
 * dispatch statement (see services/runs.ts), so an unapproved run is not merely
 * rejected by application code but is unselectable.
 */

export type GuardrailCode =
  | 'RUN_NOT_APPROVED'
  | 'RUN_NOT_DISPATCHABLE'
  | 'JOB_NOT_ALLOWED'
  | 'CANCEL_PENDING'
  | 'OVERNIGHT_CUTOFF_PASSED'
  | 'BUDGET_EXHAUSTED'
  | 'WORKER_NOT_CAPABLE';

export type GuardrailResult = { ok: true } | { ok: false; code: GuardrailCode; message: string };

const OK: GuardrailResult = { ok: true };

/**
 * GUARDRAIL 1 — an unapproved run can never execute.
 * This is the single most important rule in Sprint 1.
 */
export function checkRunApproved(run: { status: RunStatus; approvalState: ApprovalState }): GuardrailResult {
  if (run.approvalState !== 'approved') {
    return {
      ok: false,
      code: 'RUN_NOT_APPROVED',
      message: `Run has approval state '${run.approvalState}' and may not execute. Human approval is required.`,
    };
  }
  return OK;
}

/** GUARDRAIL 2 — only a queued run may be picked up by a worker. */
export function checkRunDispatchable(run: { status: RunStatus }): GuardrailResult {
  if (run.status !== 'queued') {
    return {
      ok: false,
      code: 'RUN_NOT_DISPATCHABLE',
      message: `Run is '${run.status}'; only a queued run may be dispatched.`,
    };
  }
  return OK;
}

/**
 * GUARDRAIL 3 — the worker may only execute an allowlisted operation.
 * Applied at run creation, again at dispatch, and again inside the worker.
 */
export function checkJobAllowed(
  jobKind: unknown,
  jobParams: unknown,
): { ok: true; job: JobSpec } | { ok: false; code: 'JOB_NOT_ALLOWED'; message: string } {
  const parsed = parseJobSpec(jobKind, jobParams);
  if (!parsed.ok) {
    return { ok: false, code: 'JOB_NOT_ALLOWED', message: `Job rejected by the Sprint 1 allowlist: ${parsed.error}` };
  }
  return { ok: true, job: parsed.job };
}

/** GUARDRAIL 4 — a run with a pending stop must not be handed out. */
export function checkNoCancelPending(run: { cancelRequestedAt: Date | null }): GuardrailResult {
  if (run.cancelRequestedAt) {
    return { ok: false, code: 'CANCEL_PENDING', message: 'A stop has been requested for this run.' };
  }
  return OK;
}

/** GUARDRAIL 5 — the overnight cutoff (spec §26). */
export function checkOvernightCutoff(
  run: { overnightDeadlineAt: Date | null },
  now: Date,
): GuardrailResult {
  if (isPastDeadline(now, run.overnightDeadlineAt)) {
    return {
      ok: false,
      code: 'OVERNIGHT_CUTOFF_PASSED',
      message: `Overnight cutoff (${run.overnightDeadlineAt!.toISOString()}) has passed.`,
    };
  }
  return OK;
}

/**
 * GUARDRAIL 6 — the nightly budget (spec §25).
 *
 * Sums only *exact* recorded provider cost. Sprint 1 has no cost integration,
 * so this currently sums zero rows and always passes — but it is a real code
 * path over a real table, not a stub, and it is covered by a test that inserts
 * usage and asserts dispatch is blocked.
 */
export function checkBudget(params: {
  recordedSpendCents: number;
  nightlyBudgetCents: number;
  budgetStopPct: number;
}): GuardrailResult {
  if (params.nightlyBudgetCents <= 0) return OK; // 0 means "no budget configured"
  const stopAt = Math.round((params.nightlyBudgetCents * params.budgetStopPct) / 100);
  if (params.recordedSpendCents >= stopAt) {
    return {
      ok: false,
      code: 'BUDGET_EXHAUSTED',
      message: `Recorded spend ${params.recordedSpendCents}c has reached the stop threshold of ${stopAt}c.`,
    };
  }
  return OK;
}

/** GUARDRAIL 7 — the worker must advertise the capability it is being asked for. */
export function checkWorkerCapability(capabilities: readonly string[], jobKind: string): GuardrailResult {
  if (!capabilities.includes(jobKind)) {
    return {
      ok: false,
      code: 'WORKER_NOT_CAPABLE',
      message: `Worker does not advertise capability '${jobKind}'.`,
    };
  }
  return OK;
}

/** Runs every dispatch-time guardrail in order and returns the first failure. */
export function checkDispatch(params: {
  run: {
    status: RunStatus;
    approvalState: ApprovalState;
    cancelRequestedAt: Date | null;
    overnightDeadlineAt: Date | null;
    jobKind: string;
    jobParams: unknown;
  };
  workerCapabilities: readonly string[];
  budget: { recordedSpendCents: number; nightlyBudgetCents: number; budgetStopPct: number };
  now: Date;
}): GuardrailResult {
  const checks: GuardrailResult[] = [
    checkRunApproved(params.run),
    checkRunDispatchable(params.run),
    checkNoCancelPending(params.run),
    checkOvernightCutoff(params.run, params.now),
    checkBudget(params.budget),
    checkWorkerCapability(params.workerCapabilities, params.run.jobKind),
  ];
  for (const result of checks) if (!result.ok) return result;

  const job = checkJobAllowed(params.run.jobKind, params.run.jobParams);
  if (!job.ok) return { ok: false, code: job.code, message: job.message };

  return OK;
}
