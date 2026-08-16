import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type {
  ApprovalDto,
  CreateRunRequest,
  RunAssignment,
  RunDto,
  RunOutcome,
  RunStatus,
  StopReason,
} from '@mac/protocol';
import { PRIORITY_RANK, isTerminalRunStatus } from '@mac/protocol';
import { db, type DbHandle } from '../db/client.js';
import { approvals, projects, runs, tasks, users, workers } from '../db/schema.js';
import type { RunRow } from '../db/schema.js';
import { AppError, GuardrailError } from '../http/errors.js';
import { assertTransition, IMMEDIATELY_CANCELLABLE, REQUIRES_WORKER_CANCEL } from '../domain/run-lifecycle.js';
import { checkApprovalConfidence, parseConfidence } from '../domain/confidence.js';
import { checkJobAllowed, checkWorkerCapability } from '../domain/guardrails.js';
import { nextCutoffAfter } from '../domain/overnight.js';
import { getSettings, toConfidencePolicy, toCutoffConfig } from './settings.js';
import { recordedSpendForWindow } from './budget.js';
import { record, recordRejection, recordRunTransition, SYSTEM_ACTOR, type Actor } from './audit.js';
import { requireTaskWithProject } from './tasks.js';
import { appendSystemLog } from './logs.js';

/**
 * The run service owns the control loop.
 *
 * Every status change goes through `transition`, which validates against the
 * lifecycle table and writes an audit event in the same transaction. There is
 * no other way to move a run, so "lifecycle transitions must be validated" and
 * "audit events must be written" are structural properties rather than things
 * each call site has to remember.
 */

/** How long a worker holds a run before the lease is considered stale. */
const LEASE_SECONDS = 120;

export const toRunDto = (
  row: RunRow,
  extra: { taskTitle?: string; projectId?: string; projectName?: string; workerName?: string | null } = {},
): RunDto => ({
  id: row.id,
  taskId: row.taskId,
  ...(extra.taskTitle !== undefined && { taskTitle: extra.taskTitle }),
  ...(extra.projectId !== undefined && { projectId: extra.projectId }),
  ...(extra.projectName !== undefined && { projectName: extra.projectName }),
  status: row.status as RunStatus,
  workerId: row.workerId,
  ...(extra.workerName !== undefined && { workerName: extra.workerName }),
  approvalState: row.approvalState as RunDto['approvalState'],
  confidence: parseConfidence(row.confidence),
  jobKind: row.jobKind,
  jobParams: (row.jobParams ?? {}) as Record<string, unknown>,
  executionMode: row.executionMode as RunDto['executionMode'],
  overnightDeadlineAt: row.overnightDeadlineAt?.toISOString() ?? null,
  progressPercent: row.progressPercent,
  progressStage: row.progressStage,
  summary: row.summary,
  cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
  stopReason: (row.stopReason as StopReason | null) ?? null,
  startedAt: row.startedAt?.toISOString() ?? null,
  completedAt: row.completedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const runSelect = {
  run: runs,
  taskTitle: tasks.title,
  projectId: projects.id,
  projectName: projects.name,
  workerName: workers.name,
};

const runQuery = (handle: DbHandle = db) =>
  handle
    .select(runSelect)
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .leftJoin(workers, eq(workers.id, runs.workerId));

const mapRunRow = (r: {
  run: RunRow;
  taskTitle: string;
  projectId: string;
  projectName: string;
  workerName: string | null;
}) => toRunDto(r.run, { taskTitle: r.taskTitle, projectId: r.projectId, projectName: r.projectName, workerName: r.workerName });

// ---------------------------------------------------------------------------
// Core transition primitive
// ---------------------------------------------------------------------------

/**
 * The single choke point for run status changes.
 *
 * Reads the current row FOR UPDATE, validates the transition, applies it, and
 * records an audit event — all inside the caller's transaction. An invalid
 * transition throws and additionally leaves a `run.transition_rejected` trail,
 * because a rejected attempt is itself information worth keeping when the
 * caller may later be an autonomous agent.
 */
export async function transition(
  tx: DbHandle,
  params: {
    runId: string;
    to: RunStatus;
    actor: Actor;
    eventType: Parameters<typeof recordRunTransition>[1]['eventType'];
    patch?: Partial<typeof runs.$inferInsert>;
    metadata?: Record<string, unknown>;
  },
): Promise<RunRow> {
  const [current] = await tx.select().from(runs).where(eq(runs.id, params.runId)).for('update').limit(1);
  if (!current) throw AppError.notFound('Run');

  const from = current.status as RunStatus;

  try {
    assertTransition(from, params.to);
  } catch (err) {
    const [ctx] = await tx.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, current.taskId)).limit(1);
    // Out of band: this transaction is about to roll back, and the record that
    // an invalid transition was attempted must survive that rollback.
    await recordRejection(db, {
      actor: params.actor,
      eventType: 'run.transition_rejected',
      context: { runId: current.id, taskId: current.taskId, projectId: ctx?.projectId ?? null },
      metadata: { from, to: params.to, reason: (err as Error).message },
    });
    throw err;
  }

  const [updated] = await tx
    .update(runs)
    .set({ ...params.patch, status: params.to, updatedAt: new Date() })
    .where(eq(runs.id, params.runId))
    .returning();
  if (!updated) throw AppError.notFound('Run');

  const [ctx] = await tx.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, updated.taskId)).limit(1);

  await recordRunTransition(tx, {
    actor: params.actor,
    eventType: params.eventType,
    from,
    to: params.to,
    context: {
      runId: updated.id,
      taskId: updated.taskId,
      projectId: ctx?.projectId ?? null,
      workerId: updated.workerId,
    },
    ...(params.metadata ? { metadata: params.metadata } : {}),
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listRuns(filter: { taskId?: string; status?: RunStatus[] } = {}): Promise<RunDto[]> {
  const conditions = [];
  if (filter.taskId) conditions.push(eq(runs.taskId, filter.taskId));
  if (filter.status?.length) conditions.push(inArray(runs.status, filter.status));

  const rows = await runQuery()
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(runs.createdAt))
    .limit(200);
  return rows.map(mapRunRow);
}

export async function getRun(id: string): Promise<RunDto> {
  const [row] = await runQuery().where(eq(runs.id, id)).limit(1);
  if (!row) throw AppError.notFound('Run');
  return mapRunRow(row);
}

export async function listApprovals(runId: string): Promise<ApprovalDto[]> {
  const rows = await db
    .select({ approval: approvals, approverName: users.name })
    .from(approvals)
    .leftJoin(users, eq(users.id, approvals.approverUserId))
    .where(eq(approvals.runId, runId))
    .orderBy(desc(approvals.createdAt));

  return rows.map((r) => ({
    id: r.approval.id,
    runId: r.approval.runId,
    action: r.approval.action as ApprovalDto['action'],
    approverUserId: r.approval.approverUserId,
    approverName: r.approverName,
    notes: r.approval.notes,
    confidenceAtDecision: parseConfidence(r.approval.confidenceAtDecision),
    thresholdAtDecision: parseConfidence(r.approval.thresholdAtDecision),
    thresholdOverridden: r.approval.thresholdOverridden,
    createdAt: r.approval.createdAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Creation and approval
// ---------------------------------------------------------------------------

export async function createRun(input: CreateRunRequest, actor: Actor): Promise<RunDto> {
  // Validation point 1 of 3 for the job allowlist.
  const job = checkJobAllowed(input.jobKind, input.jobParams);
  if (!job.ok) throw new GuardrailError(job.code, job.message);

  return db.transaction(async (tx) => {
    const { task, projectId, projectName, projectActive } = await requireTaskWithProject(tx, input.taskId);
    if (!projectActive) {
      throw AppError.conflict('PROJECT_INACTIVE', 'Cannot create a run on an inactive project.');
    }

    const [row] = await tx
      .insert(runs)
      .values({
        taskId: input.taskId,
        status: 'draft',
        approvalState: 'pending',
        confidence: input.confidence.toFixed(3),
        jobKind: job.job.kind,
        jobParams: job.job.params as Record<string, unknown>,
        executionMode: input.executionMode,
        createdBy: actor.id,
      })
      .returning();
    if (!row) throw new AppError(500, 'RUN_CREATE_FAILED', 'Could not create run.');

    await record(tx, {
      actor,
      eventType: 'run.created',
      context: { runId: row.id, taskId: row.taskId, projectId },
      metadata: {
        jobKind: row.jobKind,
        jobParams: row.jobParams,
        confidence: parseConfidence(row.confidence),
        executionMode: row.executionMode,
      },
    });

    return toRunDto(row, { taskTitle: task.title, projectId, projectName });
  });
}

/** draft → ready_for_approval. Makes the run visible in the approvals queue. */
export async function submitForApproval(runId: string, actor: Actor): Promise<RunDto> {
  await db.transaction(async (tx) => {
    await transition(tx, {
      runId,
      to: 'ready_for_approval',
      actor,
      eventType: 'run.submitted_for_approval',
      patch: { approvalState: 'pending' },
    });
  });
  return getRun(runId);
}

/**
 * Approve, then immediately queue.
 *
 * Approval and queueing are separate lifecycle states (spec §24) but a single
 * human decision, so they happen in one transaction and produce two audit
 * events. The confidence guardrail is applied here, before anything becomes
 * dispatchable.
 */
export async function approveRun(
  runId: string,
  input: { notes?: string; acknowledgeBelowThreshold: boolean },
  actor: Actor,
): Promise<RunDto> {
  await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(runs).where(eq(runs.id, runId)).for('update').limit(1);
    if (!existing) throw AppError.notFound('Run');

    const settings = await getSettings(tx);
    const policy = toConfidencePolicy(settings);
    const confidence = parseConfidence(existing.confidence);

    const verdict = checkApprovalConfidence(confidence, policy, {
      acknowledgeBelowThreshold: input.acknowledgeBelowThreshold,
      hasNotes: Boolean(input.notes?.trim()),
    });

    if (!verdict.ok) {
      const [ctx] = await tx
        .select({ projectId: tasks.projectId })
        .from(tasks)
        .where(eq(tasks.id, existing.taskId))
        .limit(1);
      // Out of band, for the same reason as above: the approval is about to be
      // refused and this transaction discarded, but a blocked approval is
      // precisely the sort of thing a reviewer needs to be able to find later.
      await recordRejection(db, {
        actor,
        eventType: 'guardrail.blocked',
        context: { runId, taskId: existing.taskId, projectId: ctx?.projectId ?? null },
        metadata: {
          guardrail: 'confidence',
          code: verdict.code,
          confidence,
          floor: policy.minExecutionConfidence,
          threshold: policy.defaultConfidenceThreshold,
        },
      });
      throw new GuardrailError(verdict.code, verdict.message);
    }

    // Validation point 2 of 3: re-check the job before it becomes dispatchable,
    // in case the allowlist has been tightened since the run was created.
    const job = checkJobAllowed(existing.jobKind, existing.jobParams);
    if (!job.ok) throw new GuardrailError(job.code, job.message);

    await transition(tx, {
      runId,
      to: 'approved',
      actor,
      eventType: 'run.approved',
      patch: { approvalState: 'approved' },
      metadata: {
        confidence,
        threshold: policy.defaultConfidenceThreshold,
        band: verdict.band,
        thresholdOverridden: verdict.thresholdOverridden,
        notes: input.notes ?? null,
      },
    });

    await tx.insert(approvals).values({
      runId,
      action: 'approve',
      approverUserId: actor.id,
      notes: input.notes?.trim() || null,
      confidenceAtDecision: confidence === null ? null : confidence.toFixed(3),
      thresholdAtDecision: policy.defaultConfidenceThreshold.toFixed(3),
      thresholdOverridden: verdict.thresholdOverridden,
    });

    // An overnight run's deadline is resolved once, now, and stored — so it is
    // stable and inspectable and does not shift if settings change mid-run.
    const overnightDeadlineAt =
      existing.executionMode === 'overnight' ? nextCutoffAfter(new Date(), toCutoffConfig(settings)) : null;

    await transition(tx, {
      runId,
      to: 'queued',
      actor,
      eventType: 'run.queued',
      patch: { overnightDeadlineAt },
      metadata: { overnightDeadlineAt: overnightDeadlineAt?.toISOString() ?? null },
    });

    await appendSystemLog(tx, runId, `Run approved by ${actor.label} and queued for dispatch.`);
  });

  return getRun(runId);
}

/** Rejection returns the run to draft so it can be revised and resubmitted. */
export async function rejectRun(runId: string, input: { notes: string }, actor: Actor): Promise<RunDto> {
  await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(runs).where(eq(runs.id, runId)).for('update').limit(1);
    if (!existing) throw AppError.notFound('Run');

    await transition(tx, {
      runId,
      to: 'draft',
      actor,
      eventType: 'run.rejected',
      patch: { approvalState: 'rejected' },
      metadata: { notes: input.notes },
    });

    await tx.insert(approvals).values({
      runId,
      action: 'reject',
      approverUserId: actor.id,
      notes: input.notes.trim(),
      confidenceAtDecision: existing.confidence,
    });

    await appendSystemLog(tx, runId, `Run rejected by ${actor.label}: ${input.notes.trim()}`);
  });

  return getRun(runId);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Atomically leases the next eligible run to a worker.
 *
 * The approval guardrail lives in the WHERE clause, not in an `if`: an
 * unapproved run is not merely rejected by application code, it is
 * unselectable. `FOR UPDATE SKIP LOCKED` makes this correct for any number of
 * concurrent workers even though Sprint 1 runs one.
 */
export async function leaseNextRun(
  worker: { id: string; name: string; capabilities: string[] },
): Promise<RunAssignment | null> {
  const settings = await getSettings();
  const spend = await recordedSpendForWindow(toCutoffConfig(settings), new Date());

  // Budget guardrail, evaluated before any run is touched.
  const stopAt = Math.round((settings.nightlyBudgetCents * settings.budgetStopPct) / 100);
  if (settings.nightlyBudgetCents > 0 && spend.recordedSpendCents >= stopAt) {
    await db.transaction(async (tx) => {
      await record(tx, {
        actor: SYSTEM_ACTOR,
        eventType: 'guardrail.blocked',
        context: { workerId: worker.id },
        metadata: { guardrail: 'budget', recordedSpendCents: spend.recordedSpendCents, stopAtCents: stopAt },
      });
    });
    return null;
  }

  const capabilities = worker.capabilities.filter((c) => typeof c === 'string');
  if (capabilities.length === 0) return null;

  return db.transaction(async (tx) => {
    const now = new Date();
    const priorityCase = sql`CASE ${tasks.priority}
        WHEN 'urgent' THEN ${PRIORITY_RANK.urgent}
        WHEN 'high' THEN ${PRIORITY_RANK.high}
        WHEN 'normal' THEN ${PRIORITY_RANK.normal}
        ELSE ${PRIORITY_RANK.low} END`;

    const candidates = await tx
      .select({ run: runs })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .where(
        and(
          eq(runs.status, 'queued'),
          // The guardrail, as a SQL predicate.
          eq(runs.approvalState, 'approved'),
          sql`${runs.cancelRequestedAt} IS NULL`,
          sql`(${runs.overnightDeadlineAt} IS NULL OR ${runs.overnightDeadlineAt} > ${now})`,
          inArray(runs.jobKind, capabilities),
        ),
      )
      .orderBy(priorityCase, runs.createdAt)
      .limit(1)
      .for('update', { of: runs, skipLocked: true });

    const candidate = candidates[0]?.run;
    if (!candidate) return null;

    // Validation point 3 of 3 on the server side (the worker checks again).
    const job = checkJobAllowed(candidate.jobKind, candidate.jobParams);
    if (!job.ok) {
      await transition(tx, {
        runId: candidate.id,
        to: 'failed',
        actor: SYSTEM_ACTOR,
        eventType: 'run.failed',
        patch: { stopReason: 'unsupported_job_kind', completedAt: new Date() },
        metadata: { reason: job.message },
      });
      return null;
    }

    const capability = checkWorkerCapability(capabilities, candidate.jobKind);
    if (!capability.ok) return null;

    const leaseExpiresAt = new Date(now.getTime() + LEASE_SECONDS * 1000);
    const updated = await transition(tx, {
      runId: candidate.id,
      to: 'running',
      actor: { type: 'worker', id: worker.id, label: worker.name },
      eventType: 'run.dispatched',
      patch: {
        workerId: worker.id,
        startedAt: candidate.startedAt ?? now,
        leaseExpiresAt,
        attempt: candidate.attempt + 1,
        progressStage: 'dispatched',
        progressPercent: 0,
      },
      metadata: { workerName: worker.name, jobKind: candidate.jobKind, attempt: candidate.attempt + 1 },
    });

    await tx
      .update(workers)
      .set({ status: 'busy', currentRunId: updated.id, updatedAt: now })
      .where(eq(workers.id, worker.id));

    await tx
      .update(tasks)
      .set({ status: 'in_progress', updatedAt: now })
      .where(and(eq(tasks.id, updated.taskId), inArray(tasks.status, ['draft', 'ready'])));

    await appendSystemLog(tx, updated.id, `Dispatched to worker "${worker.name}" (attempt ${updated.attempt}).`);

    const [context] = await tx
      .select({ taskTitle: tasks.title, projectId: projects.id, projectName: projects.name })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(eq(tasks.id, updated.taskId))
      .limit(1);

    return {
      runId: updated.id,
      taskId: updated.taskId,
      projectId: context?.projectId ?? '',
      taskTitle: context?.taskTitle ?? '',
      projectName: context?.projectName ?? '',
      jobKind: job.job.kind,
      jobParams: job.job.params as Record<string, unknown>,
      deadlineAt: updated.overnightDeadlineAt?.toISOString() ?? null,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
      attempt: updated.attempt,
    } satisfies RunAssignment;
  });
}

// ---------------------------------------------------------------------------
// Progress and completion
// ---------------------------------------------------------------------------

export async function recordProgress(
  runId: string,
  worker: { id: string; name: string },
  input: { stage: string; percent?: number | null; message?: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for('update').limit(1);
    if (!run) throw AppError.notFound('Run');
    assertRunOwnedBy(run, worker.id);

    if (run.status !== 'running') {
      throw AppError.conflict('RUN_NOT_RUNNING', `Cannot report progress for a run that is '${run.status}'.`);
    }

    const stageChanged = run.progressStage !== input.stage;

    await tx
      .update(runs)
      .set({
        progressStage: input.stage,
        ...(input.percent !== undefined && input.percent !== null && { progressPercent: input.percent }),
        // Any sign of life from the worker extends the lease.
        leaseExpiresAt: new Date(Date.now() + LEASE_SECONDS * 1000),
        updatedAt: new Date(),
      })
      .where(eq(runs.id, runId));

    // Only stage changes are audited. Percentage ticks belong in the run log,
    // not in a trail that a human has to read.
    if (stageChanged) {
      const [ctx] = await tx.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, run.taskId)).limit(1);
      await record(tx, {
        actor: { type: 'worker', id: worker.id, label: worker.name },
        eventType: 'run.progress_stage_changed',
        context: { runId, taskId: run.taskId, projectId: ctx?.projectId ?? null, workerId: worker.id },
        // Deliberately `fromStage`/`toStage`, not `from`/`to`: those keys mean
        // a lifecycle status transition everywhere else in the trail, and
        // reusing them here made a stage change look like a status change.
        metadata: { fromStage: run.progressStage, toStage: input.stage, percent: input.percent ?? null },
      });
    }
  });
}

const OUTCOME_TO_STATUS: Record<RunOutcome, RunStatus> = {
  succeeded: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

const OUTCOME_TO_EVENT = {
  succeeded: 'run.completed',
  failed: 'run.failed',
  cancelled: 'run.cancelled',
} as const;

export async function completeRun(
  runId: string,
  worker: { id: string; name: string },
  input: { outcome: RunOutcome; stopReason?: StopReason | null; summary?: string; confidence?: number | null },
): Promise<RunStatus> {
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for('update').limit(1);
    if (!run) throw AppError.notFound('Run');
    assertRunOwnedBy(run, worker.id);

    if (isTerminalRunStatus(run.status as RunStatus)) {
      // A retried completion after a network blip is not an error; the worker
      // is entitled to keep asking until it gets an answer.
      return run.status as RunStatus;
    }

    // A guardrail-initiated stop lands in `stopped_by_guardrail` even though
    // the worker reports it as an ordinary cancellation — the worker does not
    // decide why it was stopped.
    const guardrailStop =
      input.outcome === 'cancelled' &&
      (run.stopReason === 'overnight_cutoff' || run.stopReason === 'budget_exhausted');

    const target: RunStatus = guardrailStop ? 'stopped_by_guardrail' : OUTCOME_TO_STATUS[input.outcome];
    const eventType = guardrailStop ? ('run.stopped_by_guardrail' as const) : OUTCOME_TO_EVENT[input.outcome];

    // A stop reason already on the row was set by the control plane (an
    // operator cancel or a guardrail) and outranks whatever the worker reports.
    const stopReason: StopReason =
      (run.stopReason as StopReason | null) ??
      input.stopReason ??
      (input.outcome === 'succeeded' ? 'completed' : input.outcome === 'failed' ? 'failed' : 'cancelled_by_user');

    await transition(tx, {
      runId,
      to: target,
      actor: { type: 'worker', id: worker.id, label: worker.name },
      eventType,
      patch: {
        completedAt: new Date(),
        stopReason,
        summary: input.summary?.slice(0, 2000) ?? null,
        progressPercent: input.outcome === 'succeeded' ? 100 : run.progressPercent,
        progressStage: input.outcome === 'succeeded' ? 'completed' : (run.progressStage ?? 'stopped'),
        ...(input.confidence !== undefined && input.confidence !== null
          ? { confidence: input.confidence.toFixed(3) }
          : {}),
        leaseExpiresAt: null,
      },
      metadata: { outcome: input.outcome, stopReason, summary: input.summary ?? null },
    });

    await tx
      .update(workers)
      .set({ status: 'idle', currentRunId: null, updatedAt: new Date() })
      .where(eq(workers.id, worker.id));

    await tx
      .update(tasks)
      .set({ status: input.outcome === 'succeeded' ? 'done' : 'blocked', updatedAt: new Date() })
      .where(eq(tasks.id, run.taskId));

    return target;
  });
}

function assertRunOwnedBy(run: RunRow, workerId: string): void {
  if (run.workerId !== workerId) {
    // Deliberately 403 rather than 404: the worker authenticated successfully,
    // it simply has no business with this run.
    throw AppError.forbidden('This run is not assigned to you.');
  }
}

// ---------------------------------------------------------------------------
// Stop / cancel
// ---------------------------------------------------------------------------

/**
 * Cancellation is request → propagate → acknowledge.
 *
 * A run that has not been dispatched is cancelled outright. A run in flight
 * gets a cancellation flag; the worker learns of it on its next call of any
 * kind (see the control envelope), aborts, and reports back. Only then does
 * the run become terminal — so the audit trail records that the worker
 * actually stopped, not merely that someone asked it to.
 */
export async function requestCancel(
  runId: string,
  input: { reason?: string },
  actor: Actor,
  opts: { stopReason?: StopReason } = {},
): Promise<RunDto> {
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for('update').limit(1);
    if (!run) throw AppError.notFound('Run');

    const status = run.status as RunStatus;
    if (isTerminalRunStatus(status)) {
      throw AppError.conflict('RUN_ALREADY_FINISHED', `Run is already '${status}'.`);
    }

    const stopReason = opts.stopReason ?? 'cancelled_by_user';

    if (IMMEDIATELY_CANCELLABLE.includes(status)) {
      const target: RunStatus = stopReason === 'cancelled_by_user' ? 'cancelled' : 'stopped_by_guardrail';
      await transition(tx, {
        runId,
        to: target,
        actor,
        eventType: target === 'cancelled' ? 'run.cancelled' : 'run.stopped_by_guardrail',
        patch: {
          cancelRequestedAt: new Date(),
          cancelRequestedBy: actor.id,
          stopReason,
          completedAt: new Date(),
        },
        metadata: { reason: input.reason ?? null, propagated: false },
      });
      await appendSystemLog(tx, runId, `Run stopped before dispatch (${stopReason}).`);
      return;
    }

    if (!REQUIRES_WORKER_CANCEL.includes(status)) {
      throw AppError.conflict('RUN_NOT_CANCELLABLE', `A run in '${status}' cannot be cancelled.`);
    }

    if (run.cancelRequestedAt) {
      // Idempotent: asking twice is not an error, it just does not re-audit.
      return;
    }

    await tx
      .update(runs)
      .set({ cancelRequestedAt: new Date(), cancelRequestedBy: actor.id, stopReason, updatedAt: new Date() })
      .where(eq(runs.id, runId));

    const [ctx] = await tx.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, run.taskId)).limit(1);
    await record(tx, {
      actor,
      eventType: 'run.cancel_requested',
      context: { runId, taskId: run.taskId, projectId: ctx?.projectId ?? null, workerId: run.workerId },
      metadata: { reason: input.reason ?? null, stopReason, status },
    });

    await appendSystemLog(tx, runId, `Stop requested by ${actor.label}. Awaiting worker acknowledgement.`);
  });

  return getRun(runId);
}

/**
 * Terminates a run without waiting for the worker.
 *
 * Needed because §27 promises an operator can stop a run, and a wedged or
 * unreachable worker must not make that promise unkeepable. It is audited as a
 * distinct event so a forced stop can never be mistaken for a clean one.
 */
export async function forceCancel(runId: string, input: { reason?: string }, actor: Actor): Promise<RunDto> {
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for('update').limit(1);
    if (!run) throw AppError.notFound('Run');
    if (isTerminalRunStatus(run.status as RunStatus)) {
      throw AppError.conflict('RUN_ALREADY_FINISHED', `Run is already '${run.status}'.`);
    }

    await transition(tx, {
      runId,
      to: 'cancelled',
      actor,
      eventType: 'run.force_cancelled',
      patch: {
        cancelRequestedAt: run.cancelRequestedAt ?? new Date(),
        cancelRequestedBy: actor.id,
        stopReason: 'force_cancelled_worker_unreachable',
        completedAt: new Date(),
        leaseExpiresAt: null,
      },
      metadata: { reason: input.reason ?? null, forced: true, previousStatus: run.status },
    });

    if (run.workerId) {
      await tx
        .update(workers)
        .set({ currentRunId: null, updatedAt: new Date() })
        .where(eq(workers.id, run.workerId));
    }

    await appendSystemLog(
      tx,
      runId,
      `Run force-cancelled by ${actor.label} without worker acknowledgement. The worker may still be executing.`,
    );
  });

  return getRun(runId);
}

/** Used by the cutoff sweeper. Returns run ids that were stopped. */
export async function stopRunsPastOvernightCutoff(now: Date): Promise<string[]> {
  const candidates = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        inArray(runs.status, ['queued', 'running', 'blocked']),
        eq(runs.executionMode, 'overnight'),
        sql`${runs.overnightDeadlineAt} IS NOT NULL`,
        sql`${runs.overnightDeadlineAt} <= ${now}`,
        sql`${runs.cancelRequestedAt} IS NULL`,
      ),
    );

  const stopped: string[] = [];
  for (const { id } of candidates) {
    try {
      await requestCancel(
        id,
        { reason: 'Overnight cutoff reached.' },
        SYSTEM_ACTOR,
        { stopReason: 'overnight_cutoff' },
      );
      stopped.push(id);
    } catch {
      // A run that finished between the query and the update is not an error.
    }
  }
  return stopped;
}
