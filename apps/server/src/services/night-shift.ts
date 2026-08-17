import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  handoffBriefContentSchema,
  type NightCandidateDto,
  type NightDecisionDto,
  type NightShiftDto,
  type NightShiftStatus,
  type NightStopReason,
  type SchedulingRationale,
} from '@mac/protocol';
import { db, type DbHandle } from '../db/client.js';
import {
  approvals,
  handoffBriefs,
  mondayBoards,
  mondayItems,
  nightDecisions,
  nightShifts,
  projects,
  repositories,
  runBlockers,
  runs,
  tasks,
  workers,
} from '../db/schema.js';
import type { NightDecisionRow, NightShiftRow } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { parseConfidence } from '../domain/confidence.js';
import { evaluateEligibility, type EligibilityInput } from '../domain/eligibility.js';
import { estimateEffort, safeToStart } from '../domain/effort.js';
import {
  decideNextAction,
  type NightCandidate,
  type NightDecision,
  type NightState,
  type UsageState,
} from '../domain/night-scheduler.js';
import { nextCutoffAfter } from '../domain/overnight.js';
import { getSettings, toCutoffConfig, type Settings } from './settings.js';
import { recordedSpendForWindow } from './budget.js';
import { record, SYSTEM_ACTOR, type Actor } from './audit.js';
import { isWorkerLive } from './workers.js';
import { transition } from './runs.js';
import { appendSystemLog } from './logs.js';
import { nightEligibleBoards } from './monday/boards.js';
import { syncAllApprovedBoards } from './monday/sync.js';
import { queueAssignToMac, queueBlocker, queueStatus, queueUpdate } from './monday/outbox.js';
import { deliverOvernightReport } from './overnight-report.js';

/**
 * The night shift (Sprint 3 §8).
 *
 * ---------------------------------------------------------------------------
 * WHERE THE LOOP LIVES, AND WHY IT IS A SETINTERVAL
 *
 * A third sweeper, next to the two Sprint 1 already runs, for the same reasons
 * those are there: the tick is idempotent, cheap, and safe to miss. No queue, no
 * Redis, no workflow engine. Spec §31 warns against premature distributed
 * architecture and a scheduler that fires every thirty seconds is not evidence
 * against it.
 *
 * All the judgement lives in `domain/night-scheduler.ts` and
 * `domain/eligibility.ts`, both pure. This file is the part that talks to the
 * database — it gathers state, asks for a decision, and carries it out.
 * ---------------------------------------------------------------------------
 */

const ACTIVE_RUN_STATUSES = ['draft', 'ready_for_approval', 'approved', 'queued', 'running', 'blocked', 'self_review'] as const;

export const toNightShiftDto = (row: NightShiftRow, now = new Date()): NightShiftDto => ({
  id: row.id,
  status: row.status as NightShiftStatus,
  startedAt: row.startedAt.toISOString(),
  endedAt: row.endedAt?.toISOString() ?? null,
  cutoffAt: row.cutoffAt.toISOString(),
  stopReason: (row.stopReason as NightStopReason | null) ?? null,
  tasksAttempted: row.tasksAttempted,
  tasksCompleted: row.tasksCompleted,
  tasksBlocked: row.tasksBlocked,
  minutesRemaining: Math.max(0, Math.floor((row.cutoffAt.getTime() - now.getTime()) / 60_000)),
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function getActiveShift(handle: DbHandle = db): Promise<NightShiftRow | null> {
  const [row] = await handle.select().from(nightShifts).where(eq(nightShifts.status, 'running')).limit(1);
  return row ?? null;
}

export async function startNightShift(
  input: { cutoffAt?: string; notes?: string },
  actor: Actor,
): Promise<NightShiftDto> {
  return db.transaction(async (tx) => {
    const existing = await getActiveShift(tx);
    if (existing) throw AppError.conflict('NIGHT_SHIFT_RUNNING', 'A night shift is already running.');

    const settings = await getSettings(tx);
    const cutoffAt = input.cutoffAt ? new Date(input.cutoffAt) : nextCutoffAfter(new Date(), toCutoffConfig(settings));
    if (Number.isNaN(cutoffAt.getTime())) {
      throw AppError.badRequest('INVALID_CUTOFF', 'That cutoff is not a valid instant.');
    }

    const [row] = await tx
      .insert(nightShifts)
      .values({
        status: 'running',
        cutoffAt,
        startedBy: actor.id,
        /*
         * The policy this shift actually ran under.
         *
         * Reading a morning report next to the thresholds as they are NOW is
         * misleading if somebody changed them at 06:00.
         */
        settingsSnapshot: {
          timezone: settings.timezone,
          overnightCutoff: settings.overnightCutoff,
          minExecutionConfidence: settings.minExecutionConfidence,
          defaultConfidenceThreshold: settings.defaultConfidenceThreshold,
          nightlyBudgetCents: settings.nightlyBudgetCents,
          budgetStopPct: settings.budgetStopPct,
          softUsageThresholdPct: settings.softUsageThresholdPct,
          softUsageStopsExecution: settings.softUsageStopsExecution,
          safetyFactor: settings.nightShiftSafetyFactor,
          wrapUpMinutes: settings.nightShiftWrapUpMinutes,
          minStartMinutes: settings.nightShiftMinStartMinutes,
          largeTaskMinMinutes: settings.nightShiftLargeTaskMinMinutes,
          requireSandbox: settings.requireSandbox,
        },
      })
      .returning();
    if (!row) throw new AppError(500, 'NIGHT_SHIFT_START_FAILED', 'Could not start the night shift.');

    await record(tx, {
      actor,
      eventType: 'night_shift.started',
      metadata: { nightShiftId: row.id, cutoffAt: cutoffAt.toISOString(), notes: input.notes ?? null },
    });

    return toNightShiftDto(row);
  });
}

export async function stopNightShift(
  input: { reason?: string; stopReason?: NightStopReason; skipReport?: boolean },
  actor: Actor,
): Promise<NightShiftDto | null> {
  const ended = await db.transaction(async (tx) => {
    const shift = await getActiveShift(tx);
    if (!shift) return null;

    const stopReason = input.stopReason ?? 'stopped_by_user';
    const [row] = await tx
      .update(nightShifts)
      .set({
        status: stopReason === 'cutoff_reached' || stopReason === 'no_eligible_work' ? 'completed' : 'stopped',
        endedAt: new Date(),
        stopReason,
      })
      .where(eq(nightShifts.id, shift.id))
      .returning();

    await record(tx, {
      actor,
      eventType: 'night_shift.ended',
      metadata: {
        nightShiftId: shift.id,
        stopReason,
        reason: input.reason ?? null,
        tasksAttempted: shift.tasksAttempted,
        tasksCompleted: shift.tasksCompleted,
        tasksBlocked: shift.tasksBlocked,
      },
    });

    return toNightShiftDto(row ?? shift);
  });

  if (!ended) return null;

  /*
   * The morning report is queued as the shift ends — AFTER the transaction
   * commits, not inside it.
   *
   * Inside, the report builder would read the shift as still running and
   * summarise a night that had not finished. Outside, it sees the committed
   * end state. Delivery itself is the outbox's job, so a mail provider that is
   * down does not prevent the shift from ending cleanly.
   */
  if (!input.skipReport) {
    await deliverOvernightReport(ended.id, actor).catch(() => undefined);
  }

  return ended;
}

// ---------------------------------------------------------------------------
// Candidate collection
// ---------------------------------------------------------------------------

export interface CandidateContext {
  candidate: NightCandidate;
  input: EligibilityInput;
  taskId: string | null;
  boardRowId: string;
  mondayItemUrl: string | null;
  confidence: number | null;
}

/**
 * Everything Mac could conceivably start, with a verdict on each.
 *
 * Deliberately returns candidates that are NOT eligible as well: the Night
 * Queue screen shows why something was skipped, and a collection that filtered
 * them out could not.
 */
export async function collectCandidates(
  settings: Settings,
  nightShiftId: string | null,
  handle: DbHandle = db,
): Promise<CandidateContext[]> {
  const boards = await nightEligibleBoards(handle);
  if (boards.length === 0) return [];

  const boardIds = boards.map((b) => b.board.id);
  const items = await handle
    .select()
    .from(mondayItems)
    .where(inArray(mondayItems.boardRowId, boardIds));

  // Every item's status, so a dependency can be resolved without N queries.
  const statusByItemId = new Map(items.map((i) => [i.itemId, i.status]));

  const projectRows = await handle
    .select()
    .from(projects)
    .where(inArray(projects.id, boards.map((b) => b.board.projectId)));
  const projectById = new Map(projectRows.map((p) => [p.id, p]));

  const approvedRepoProjects = new Set(
    (
      await handle
        .select({ projectId: repositories.projectId })
        .from(repositories)
        .where(eq(repositories.isApproved, true))
    ).map((r) => r.projectId),
  );

  const taskIds = items.map((i) => i.taskId).filter((id): id is string => Boolean(id));

  const briefs = taskIds.length
    ? await handle
        .select()
        .from(handoffBriefs)
        .where(inArray(handoffBriefs.taskId, taskIds))
        .orderBy(desc(handoffBriefs.version))
    : [];
  // Highest version wins; the query is ordered so the first seen is the latest.
  const briefByTask = new Map<string, (typeof briefs)[number]>();
  for (const brief of briefs) if (!briefByTask.has(brief.taskId)) briefByTask.set(brief.taskId, brief);

  const activeRuns = taskIds.length
    ? await handle
        .select({ taskId: runs.taskId })
        .from(runs)
        .where(and(inArray(runs.taskId, taskIds), inArray(runs.status, [...ACTIVE_RUN_STATUSES])))
    : [];
  const activeTaskIds = new Set(activeRuns.map((r) => r.taskId));

  /*
   * Tasks for which a HUMAN already approved a narrower scope.
   *
   * This is the exact artefact Sprint 2's 60–79% band produces: an approval
   * carrying `thresholdOverridden`, made by a person, against a run for this
   * task. Nothing else counts — an inference that "the brief looks scoped"
   * would be Mac granting himself the permission the band exists to withhold.
   */
  const scopeApproved = new Set<string>();
  if (taskIds.length) {
    const rows = await handle
      .select({ taskId: runs.taskId })
      .from(approvals)
      .innerJoin(runs, eq(runs.id, approvals.runId))
      .where(
        and(
          inArray(runs.taskId, taskIds),
          eq(approvals.action, 'approve'),
          eq(approvals.source, 'human'),
          eq(approvals.thresholdOverridden, true),
        ),
      );
    for (const row of rows) scopeApproved.add(row.taskId);
  }

  /*
   * Tasks that blocked earlier in THIS shift.
   *
   * Scoped to the shift rather than to all time: a task blocked last week may
   * well have been unblocked since, and refusing it forever would make one bad
   * night permanent.
   */
  const blockedTaskIds = new Set<string>();
  if (nightShiftId && taskIds.length) {
    const blocked = await handle
      .select({ taskId: runs.taskId })
      .from(runBlockers)
      .innerJoin(runs, eq(runs.id, runBlockers.runId))
      .where(and(eq(runs.nightShiftId, nightShiftId), eq(runBlockers.resolved, false)));
    for (const row of blocked) blockedTaskIds.add(row.taskId);
  }

  const contexts: CandidateContext[] = [];

  items.forEach((item, index) => {
    const boardEntry = boards.find((b) => b.board.id === item.boardRowId);
    if (!boardEntry) return;
    const project = projectById.get(boardEntry.board.projectId);
    if (!project) return;

    const brief = item.taskId ? briefByTask.get(item.taskId) : undefined;
    const confidence = brief ? parseConfidence(brief.confidence) : null;
    const dependsOn = Array.isArray(item.dependsOn) ? (item.dependsOn as string[]) : [];

    const input: EligibilityInput = {
      project: { nightShiftApproved: project.nightShiftApproved, isActive: project.isActive },
      board: {
        isApproved: boardEntry.board.isApproved,
        nightShiftEligible: boardEntry.board.nightShiftEligible,
        requireItemFlag: boardEntry.board.requireItemFlag,
        startableStatuses: asStrings(boardEntry.board.startableStatuses),
        completedStatuses: asStrings(boardEntry.board.completedStatuses),
        allowedItemTypes: asStrings(boardEntry.board.allowedItemTypes),
        macUserId: boardEntry.board.macUserId,
      },
      item: {
        id: item.itemId,
        name: item.name,
        status: item.status,
        priority: item.priority,
        assigneeIds: asStrings(item.assigneeIds),
        nightShiftFlag: item.nightShiftFlag,
        dependsOn,
        itemType: item.itemType,
        dueDate: item.dueDate,
      },
      dependencyStatuses: Object.fromEntries(dependsOn.map((id) => [id, statusByItemId.get(id) ?? null])),
      mac: {
        briefConfidence: confidence,
        hasApprovedLimitedScope: Boolean(item.taskId && scopeApproved.has(item.taskId)),
        repositoryApproved: approvedRepoProjects.has(project.id),
        hasActiveRun: Boolean(item.taskId && activeTaskIds.has(item.taskId)),
        blockedEarlierTonight: Boolean(item.taskId && blockedTaskIds.has(item.taskId)),
      },
      policy: {
        minExecutionConfidence: settings.minExecutionConfidence,
        defaultConfidenceThreshold: settings.defaultConfidenceThreshold,
      },
      boardOrder: index,
    };

    const verdict = evaluateEligibility(input);
    const effort = estimateEffort({
      brief: brief ? handoffBriefContentSchema.parse(brief.content) : null,
      sizeLabel: item.sizeLabel,
      scopeKind: 'full',
    });

    contexts.push({
      candidate: {
        taskId: item.taskId,
        mondayItemId: item.itemId,
        title: item.name,
        projectId: project.id,
        projectName: project.name,
        eligibility: verdict,
        effort,
      },
      input,
      taskId: item.taskId,
      boardRowId: boardEntry.board.id,
      mondayItemUrl: item.url,
      confidence,
    });
  });

  return contexts;
}

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export interface TickResult {
  shiftId: string | null;
  decision: NightDecision['action'] | 'no_shift';
  runId?: string | null;
  taskId?: string | null;
  rationale?: SchedulingRationale;
}

/**
 * One turn of the loop (Sprint 3 §8.1, brief §10).
 *
 * Gathers state, asks the pure scheduler for a decision, records the decision
 * and its rationale, then carries it out. Nothing here decides anything: if a
 * behaviour looks wrong, the argument is with `night-scheduler.ts`, which is
 * where it can be tested without a database.
 */
export async function nightShiftTick(now = new Date()): Promise<TickResult> {
  const shift = await getActiveShift();
  if (!shift) return { shiftId: null, decision: 'no_shift' };

  const settings = await getSettings();

  // Refresh the cache first, so the decision is made on what the boards say
  // now rather than on what they said when the shift started.
  await syncAllApprovedBoards().catch(() => undefined);

  const current = await loadCurrentWork(shift.id);
  const contexts = await collectCandidates(settings, shift.id);
  const usage = await loadUsageState(settings);
  const workerAvailable = await hasLiveIdleWorker(settings);
  const lastProjectId = current?.projectId ?? (await lastWorkedProject(shift.id));

  const state: NightState = {
    now,
    cutoffAt: shift.cutoffAt,
    current,
    lastProjectId,
    candidates: contexts.map((c) => c.candidate),
    usage,
    workerAvailable,
    guardrailStopped: false,
    policy: {
      safetyFactor: settings.nightShiftSafetyFactor,
      wrapUpMinutes: settings.nightShiftWrapUpMinutes,
      minStartMinutes: settings.nightShiftMinStartMinutes,
      largeTaskMinMinutes: settings.nightShiftLargeTaskMinMinutes,
    },
    stopRequested: false,
  };

  const decision = decideNextAction(state);
  await recordDecision(shift.id, decision, contexts);

  switch (decision.action) {
    case 'continue':
    case 'idle':
      return { shiftId: shift.id, decision: decision.action, rationale: decision.rationale };

    case 'finalise':
      await finaliseRun(shift.id, decision.runId);
      return { shiftId: shift.id, decision: 'finalise', runId: decision.runId, rationale: decision.rationale };

    case 'record_blocker':
      await recordRunBlocked(shift.id, decision.runId);
      return { shiftId: shift.id, decision: 'record_blocker', runId: decision.runId, rationale: decision.rationale };

    case 'start': {
      const context = contexts.find((c) => c.candidate.mondayItemId === decision.candidate.mondayItemId);
      if (!context?.taskId) {
        return { shiftId: shift.id, decision: 'idle', rationale: decision.rationale };
      }
      const runId = await startSelectedTask(shift, context, decision.rationale);
      return { shiftId: shift.id, decision: 'start', runId, taskId: context.taskId, rationale: decision.rationale };
    }

    case 'stop':
      await stopNightShift({ stopReason: decision.stopReason, reason: decision.rationale.reason }, SYSTEM_ACTOR);
      return { shiftId: shift.id, decision: 'stop', rationale: decision.rationale };
  }
}

// ---------------------------------------------------------------------------
// Carrying out a decision
// ---------------------------------------------------------------------------

/**
 * Creates and approves a run for the selected task.
 *
 * ---------------------------------------------------------------------------
 * THE APPROVAL AUTHORITY
 *
 * Sprints 1 and 2 required a human to approve every run. A multi-task night
 * cannot ask. The resolution is that approval moved UP a level, not away: a
 * human approved the project for night shift, approved the board, and (by
 * default) flagged the item. The eligibility predicate then found it startable.
 *
 * That is a real authority with a real trail — and a DIFFERENT authority from a
 * person clicking approve, which is why `approvals.source` records it as
 * `night_shift_policy` and the audit event is `run.auto_approved` rather than
 * `run.approved`. A machine approval must never be readable as a human one.
 * ---------------------------------------------------------------------------
 */
async function startSelectedTask(
  shift: NightShiftRow,
  context: CandidateContext,
  rationale: SchedulingRationale,
): Promise<string | null> {
  const taskId = context.taskId!;

  return db.transaction(async (tx) => {
    const settings = await getSettings(tx);

    const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!task) return null;

    const [repository] = await tx
      .select()
      .from(repositories)
      .where(and(eq(repositories.projectId, task.projectId), eq(repositories.isApproved, true)))
      .limit(1);
    if (!repository) return null;

    const [brief] = await tx
      .select()
      .from(handoffBriefs)
      .where(eq(handoffBriefs.taskId, taskId))
      .orderBy(desc(handoffBriefs.version))
      .limit(1);
    if (!brief) return null;

    const confidence = parseConfidence(brief.confidence) ?? 0;

    const [run] = await tx
      .insert(runs)
      .values({
        taskId,
        status: 'draft',
        // Approved on creation under the night-shift policy, and recorded as
        // such below. It is queued in the same transaction.
        approvalState: 'approved',
        confidence: confidence.toFixed(3),
        jobKind: 'claude_code',
        jobParams: {
          repositoryId: repository.id,
          briefId: brief.id,
          provider: 'claude_code',
          maxMinutes: settings.maxAgentMinutes,
          openPullRequest: true,
        },
        executionMode: 'overnight',
        repositoryId: repository.id,
        handoffBriefId: brief.id,
        scopeKind: confidence >= settings.defaultConfidenceThreshold ? 'full' : 'limited',
        nightShiftId: shift.id,
        mondayItemId: context.candidate.mondayItemId,
        selectedBy: 'night_shift',
        overnightDeadlineAt: shift.cutoffAt,
      })
      .returning();
    if (!run) return null;

    await tx.insert(approvals).values({
      runId: run.id,
      action: 'approve',
      // No approver user: this was policy, not a person, and pretending
      // otherwise would put someone's name against a decision they did not make.
      approverUserId: null,
      notes: 'Approved by night-shift policy.',
      confidenceAtDecision: confidence.toFixed(3),
      thresholdAtDecision: settings.defaultConfidenceThreshold.toFixed(3),
      thresholdOverridden: false,
      source: 'night_shift_policy',
      policyBasis: {
        nightShiftId: shift.id,
        mondayItemId: context.candidate.mondayItemId,
        boardRowId: context.boardRowId,
        eligibility: context.candidate.eligibility,
        effort: context.candidate.effort,
        rationale,
      },
    });

    await record(tx, {
      actor: SYSTEM_ACTOR,
      eventType: 'run.auto_approved',
      context: { runId: run.id, taskId, projectId: task.projectId },
      metadata: {
        nightShiftId: shift.id,
        mondayItemId: context.candidate.mondayItemId,
        confidence,
        effort: context.candidate.effort.sizeClass,
        basis: 'project approved + board approved + item flagged + eligibility predicate',
      },
    });

    await record(tx, {
      actor: SYSTEM_ACTOR,
      eventType: 'night_shift.task_selected',
      context: { runId: run.id, taskId, projectId: task.projectId },
      metadata: { nightShiftId: shift.id, title: task.title, rationale: rationale.reason },
    });

    await transition(tx, {
      runId: run.id,
      to: 'ready_for_approval',
      actor: SYSTEM_ACTOR,
      eventType: 'run.submitted_for_approval',
      metadata: { selectedBy: 'night_shift' },
    });
    await transition(tx, {
      runId: run.id,
      to: 'approved',
      actor: SYSTEM_ACTOR,
      eventType: 'run.approved',
      metadata: { source: 'night_shift_policy' },
    });
    await transition(tx, {
      runId: run.id,
      to: 'queued',
      actor: SYSTEM_ACTOR,
      eventType: 'run.queued',
      metadata: { overnightDeadlineAt: shift.cutoffAt.toISOString() },
    });

    await appendSystemLog(
      tx,
      run.id,
      `Selected autonomously during the night shift. ${rationale.reason}`,
    );

    // monday.com: assign to Mac, set In Progress, say what he is doing.
    await queueAssignToMac(tx, taskId, run.id);
    await queueStatus(tx, taskId, run.id, 'in_progress');
    await queueUpdate(
      tx,
      taskId,
      run.id,
      `**Mac has started this.**\n\n${rationale.reason}\n\nUnderstanding confidence ${(confidence * 100).toFixed(0)}%. ` +
        'He will post again when it is ready for review, or if he gets blocked.',
    );

    await tx
      .update(nightShifts)
      .set({ tasksAttempted: shift.tasksAttempted + 1 })
      .where(eq(nightShifts.id, shift.id));

    return run.id;
  });
}

/**
 * A run has reached a terminal state; report it and update the board.
 *
 * The status Mac sets is Ready for Review, not Done — the board decides whether
 * he may ever set Done, and it defaults to no.
 */
async function finaliseRun(shiftId: string, runId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1);
    if (!run) return;

    const succeeded = run.status === 'completed';
    const [shift] = await tx.select().from(nightShifts).where(eq(nightShifts.id, shiftId)).limit(1);
    if (shift) {
      await tx
        .update(nightShifts)
        .set({ tasksCompleted: shift.tasksCompleted + (succeeded ? 1 : 0) })
        .where(eq(nightShifts.id, shiftId));
    }

    if (succeeded) {
      await queueStatus(tx, run.taskId, run.id, 'ready_for_review');
      await queueUpdate(
        tx,
        run.taskId,
        run.id,
        `**Ready for review.** ${run.summary ?? 'Mac finished this piece of work.'}`,
      );
    } else {
      await queueUpdate(
        tx,
        run.taskId,
        run.id,
        `Mac stopped work on this: ${run.stopReason ?? run.status}. ${run.summary ?? ''}`.trim(),
      );
    }

    await record(tx, {
      actor: SYSTEM_ACTOR,
      eventType: 'night_shift.task_switched',
      context: { runId: run.id, taskId: run.taskId },
      metadata: { nightShiftId: shiftId, finalStatus: run.status, stopReason: run.stopReason },
    });
  });
}

/**
 * A run blocked. Record it, post it, keep the worktree, and move on.
 *
 * Spec §7: a blocker must not stop the shift. The distinction between blocked
 * and failed is preserved all the way to the board — a blocked task is waiting
 * for a person, and a failed one went wrong.
 */
async function recordRunBlocked(shiftId: string, runId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1);
    if (!run) return;

    const blockers = await tx.select().from(runBlockers).where(eq(runBlockers.runId, runId));
    const blocked = blockers.map((b) => b.description).join('; ') || 'Mac could not proceed safely.';
    const needs = blockers.map((b) => b.reason).join('; ') || 'A decision from a human.';

    const [shift] = await tx.select().from(nightShifts).where(eq(nightShifts.id, shiftId)).limit(1);
    if (shift) {
      await tx.update(nightShifts).set({ tasksBlocked: shift.tasksBlocked + 1 }).where(eq(nightShifts.id, shiftId));
    }

    await queueStatus(tx, run.taskId, run.id, 'blocked');
    await queueBlocker(tx, run.taskId, run.id, { blocked, needs, continuing: true });

    await record(tx, {
      actor: SYSTEM_ACTOR,
      eventType: 'night_shift.blocker_recorded',
      context: { runId: run.id, taskId: run.taskId },
      metadata: { nightShiftId: shiftId, blockers: blockers.length, blocked: blocked.slice(0, 500) },
    });

    await appendSystemLog(
      tx,
      run.id,
      'Blocked. The worktree and any commits are preserved, monday.com has been told, and Mac has moved on ' +
        'to other eligible work.',
    );
  });
}

// ---------------------------------------------------------------------------
// State gathering
// ---------------------------------------------------------------------------

async function loadCurrentWork(shiftId: string): Promise<NightState['current']> {
  const [row] = await db
    .select({ run: runs, projectId: tasks.projectId })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(and(eq(runs.nightShiftId, shiftId), inArray(runs.status, [...ACTIVE_RUN_STATUSES, 'completed', 'failed', 'stopped_by_guardrail', 'cancelled', 'ready_for_human_review'])))
    .orderBy(desc(runs.createdAt))
    .limit(1);

  if (!row) return null;

  const status = row.run.status;
  // A run that has already been reported on is not "current" any more.
  if (row.run.completedAt && row.run.summary === null && status === 'cancelled') return null;

  const mapped: NonNullable<NightState['current']>['status'] =
    status === 'running' || status === 'self_review'
      ? (status as 'running' | 'self_review')
      : status === 'blocked'
        ? 'blocked'
        : status === 'completed'
          ? 'completed'
          : status === 'failed'
            ? 'failed'
            : status === 'ready_for_human_review'
              ? 'ready_for_human_review'
              : status === 'stopped_by_guardrail' || status === 'cancelled'
                ? 'stopped'
                : 'running';

  // A terminal run that already produced a decision record is finished with.
  if (['completed', 'failed', 'stopped'].includes(mapped)) {
    const [alreadyReported] = await db
      .select({ id: nightDecisions.id })
      .from(nightDecisions)
      .where(and(eq(nightDecisions.runId, row.run.id), eq(nightDecisions.decision, 'finalise')))
      .limit(1);
    if (alreadyReported) return null;
  }

  if (mapped === 'blocked') {
    const [alreadyRecorded] = await db
      .select({ id: nightDecisions.id })
      .from(nightDecisions)
      .where(and(eq(nightDecisions.runId, row.run.id), eq(nightDecisions.decision, 'record_blocker')))
      .limit(1);
    if (alreadyRecorded) return null;
  }

  return {
    runId: row.run.id,
    taskId: row.run.taskId,
    projectId: row.projectId,
    status: mapped,
    productive: row.run.updatedAt.getTime() > Date.now() - 10 * 60_000,
  };
}

async function lastWorkedProject(shiftId: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: tasks.projectId })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(eq(runs.nightShiftId, shiftId))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  return row?.projectId ?? null;
}

async function loadUsageState(settings: Settings): Promise<UsageState> {
  const spend = await recordedSpendForWindow(toCutoffConfig(settings), new Date());
  return {
    source: spend.recordedSpendCents > 0 ? 'exact' : 'unavailable',
    recordedSpendCents: spend.recordedSpendCents,
    nightlyBudgetCents: settings.nightlyBudgetCents,
    budgetStopPct: settings.budgetStopPct,
    // The Claude Code CLI exposes no subscription percentage, so this is null
    // rather than invented. See Sprint 2 §10.2.
    observedPct: null,
    softThresholdPct: settings.softUsageThresholdPct,
    softStopsExecution: settings.softUsageStopsExecution,
  };
}

async function hasLiveIdleWorker(settings: Settings): Promise<boolean> {
  const rows = await db.select().from(workers);
  return rows.some(
    (w) =>
      isWorkerLive(w, settings.heartbeatIntervalSeconds, settings.heartbeatGraceSeconds) &&
      w.status !== 'busy' &&
      w.status !== 'disabled' &&
      (!settings.requireSandbox || w.sandboxReady),
  );
}

// ---------------------------------------------------------------------------
// Decision records
// ---------------------------------------------------------------------------

async function recordDecision(
  shiftId: string,
  decision: NightDecision,
  contexts: CandidateContext[],
): Promise<void> {
  await db.transaction(async (tx) => {
    const [{ next } = { next: 0 }] = await tx
      .select({ next: sql<number>`coalesce(max(${nightDecisions.sequence}), -1) + 1` })
      .from(nightDecisions)
      .where(eq(nightDecisions.nightShiftId, shiftId));

    const selected = decision.action === 'start' ? decision.candidate : null;
    const context = selected ? contexts.find((c) => c.candidate.mondayItemId === selected.mondayItemId) : null;

    await tx.insert(nightDecisions).values({
      nightShiftId: shiftId,
      sequence: next,
      decision: decision.action,
      runId: 'runId' in decision ? decision.runId : null,
      taskId: context?.taskId ?? null,
      mondayItemId: selected?.mondayItemId ?? null,
      rationale: decision.rationale,
      eligibility: selected?.eligibility ?? null,
      effort: selected?.effort ?? null,
    });

    /*
     * Skips are audited as well as recorded.
     *
     * The decision table is the operational record; the audit trail is the one
     * a reviewer reads afterwards, and "Mac considered this and did not take
     * it" belongs in both.
     */
    for (const skip of decision.rationale.skipped.slice(0, 20)) {
      await record(tx, {
        actor: SYSTEM_ACTOR,
        eventType: 'night_shift.task_skipped',
        context: { taskId: skip.taskId },
        metadata: {
          nightShiftId: shiftId,
          mondayItemId: skip.mondayItemId,
          title: skip.title,
          reason: skip.reason,
          detail: skip.detail,
        },
      });
    }

    await record(tx, {
      actor: SYSTEM_ACTOR,
      eventType: decision.action === 'idle' ? 'night_shift.idle' : 'night_shift.scheduling_decision',
      metadata: {
        nightShiftId: shiftId,
        sequence: next,
        decision: decision.action,
        reason: decision.rationale.reason,
        remainingMinutes: decision.rationale.remainingMinutes,
        budgetBasis: decision.rationale.budgetBasis,
        candidatesConsidered: decision.rationale.candidatesConsidered,
      },
    });
  });
}

export const toNightDecisionDto = (row: NightDecisionRow, taskTitle: string | null): NightDecisionDto => ({
  id: row.id,
  nightShiftId: row.nightShiftId,
  at: row.at.toISOString(),
  sequence: row.sequence,
  decision: row.decision as NightDecisionDto['decision'],
  runId: row.runId,
  taskId: row.taskId,
  taskTitle,
  mondayItemId: row.mondayItemId,
  rationale: row.rationale as SchedulingRationale,
  eligibility: (row.eligibility as NightDecisionDto['eligibility']) ?? null,
  effort: (row.effort as NightDecisionDto['effort']) ?? null,
});

export async function listNightDecisions(shiftId: string, limit = 100): Promise<NightDecisionDto[]> {
  const rows = await db
    .select({ decision: nightDecisions, taskTitle: tasks.title })
    .from(nightDecisions)
    .leftJoin(tasks, eq(tasks.id, nightDecisions.taskId))
    .where(eq(nightDecisions.nightShiftId, shiftId))
    .orderBy(desc(nightDecisions.sequence))
    .limit(limit);

  return rows.map((r) => toNightDecisionDto(r.decision, r.taskTitle));
}

// ---------------------------------------------------------------------------
// The queue, for the UI
// ---------------------------------------------------------------------------

export async function buildNightQueue(): Promise<NightCandidateDto[]> {
  const settings = await getSettings();
  const shift = await getActiveShift();
  const contexts = await collectCandidates(settings, shift?.id ?? null);

  const cutoffAt = shift?.cutoffAt ?? nextCutoffAfter(new Date(), toCutoffConfig(settings));
  const now = new Date();

  return contexts
    .map((c) => {
      // The queue screen uses exactly the scheduler's own check, so what it
      // shows and what Mac does cannot disagree.
      const verdict = safeToStart(now, cutoffAt, c.candidate.effort, {
        safetyFactor: settings.nightShiftSafetyFactor,
        wrapUpMinutes: settings.nightShiftWrapUpMinutes,
        minStartMinutes: settings.nightShiftMinStartMinutes,
        largeTaskMinMinutes: settings.nightShiftLargeTaskMinMinutes,
      });

      return {
        taskId: c.taskId,
        taskTitle: c.candidate.title,
        projectId: c.candidate.projectId,
        projectName: c.candidate.projectName,
        mondayItemId: c.candidate.mondayItemId,
        mondayItemUrl: c.mondayItemUrl,
        priority: c.input.item.priority,
        priorityRank: c.candidate.eligibility.priorityRank,
        confidence: c.confidence,
        eligibility: c.candidate.eligibility,
        effort: c.candidate.effort,
        skipReason: !c.candidate.eligibility.eligible
          ? c.candidate.eligibility.summary
          : verdict.safe
            ? null
            : verdict.reason,
      } satisfies NightCandidateDto;
    })
    .sort((a, b) => a.priorityRank - b.priorityRank);
}

export async function getNightShiftSummary(): Promise<NightShiftDto | null> {
  const shift = await getActiveShift();
  if (shift) return toNightShiftDto(shift);

  const [last] = await db.select().from(nightShifts).orderBy(desc(nightShifts.startedAt)).limit(1);
  return last ? toNightShiftDto(last) : null;
}

/** Boards Mac is currently allowed to take work from. Used by the dashboard. */
export async function countNightEligibleBoards(): Promise<number> {
  return (await nightEligibleBoards()).length;
}

/** Exposed for the dashboard: which board mapping a project has. */
export async function projectBoardIds(): Promise<Map<string, string>> {
  const rows = await db.select({ projectId: mondayBoards.projectId, boardId: mondayBoards.boardId }).from(mondayBoards);
  return new Map(rows.map((r) => [r.projectId, r.boardId]));
}
