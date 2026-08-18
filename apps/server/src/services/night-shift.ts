import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  capabilityForTaskKind,
  handoffBriefContentSchema,
  resolveJobKind,
  taskKindsForCapability,
  type NightCandidateDto,
  type NightDecisionDto,
  type NightShiftDto,
  type NightShiftStatus,
  type NightStopReason,
  type ProjectCapability,
  type SchedulingRationale,
  type TaskKind,
  type TaskPriority,
  type WorkCapability,
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
import { AppError, GuardrailError } from '../http/errors.js';
import { parseConfidence } from '../domain/confidence.js';
import { candidateSourceOf, evaluateEligibility, type EligibilityInput } from '../domain/eligibility.js';
import { evaluateTaskRequirements } from '../domain/task-requirements.js';
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
import { requireActiveRevision } from './company-context/service.js';
import { reasoningProviderAvailable } from './model/provider.js';
import { recordContextBinding } from './company-context/bindings.js';
import { isWorkerLive } from './workers.js';
import { transition } from './runs.js';
import { appendSystemLog } from './logs.js';
import { nightEligibleBoards, readableBoards } from './monday/boards.js';
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

    /*
     * The master switch, and a real guardrail rather than a label.
     *
     * An administrator who wants Mac to stop working nights entirely — a
     * release week, an incident, a change of mind — should not have to revoke
     * approval from every project and board one at a time and then remember to
     * put them all back.
     */
    if (!settings.nightShiftEnabled) {
      throw new GuardrailError(
        'NIGHT_SHIFT_DISABLED',
        'Autonomous night work is switched off in settings. Nothing will be started until an administrator ' +
          'turns it back on.',
      );
    }

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
  /** Empty for a direct task, which has no board. */
  boardRowId: string;
  mondayItemUrl: string | null;
  confidence: number | null;
  /** Sprint 3.3: what kind of work, so the job kind can be resolved at start. */
  taskKind: TaskKind;
}

/**
 * Facts that are the same for every candidate this tick.
 *
 * Gathered once rather than per candidate: `reasoningProviderAvailable()` reads
 * settings and may construct a provider, and doing that inside a loop over
 * forty monday items would be forty pointless round trips.
 */
interface ShiftCapabilities {
  reasoningModelAvailable: boolean;
  /** Which work capabilities a live, idle, sandbox-ready worker advertises. */
  workerCapabilities: Set<WorkCapability>;
}

async function shiftCapabilities(settings: Settings, handle: DbHandle = db): Promise<ShiftCapabilities> {
  const rows = await handle.select().from(workers);
  const live = rows.filter(
    (w) =>
      isWorkerLive(w, settings.heartbeatIntervalSeconds, settings.heartbeatGraceSeconds) &&
      w.status !== 'busy' &&
      w.status !== 'disabled',
  );

  const capabilities = new Set<WorkCapability>();
  for (const worker of live) {
    const advertised = Array.isArray(worker.capabilities) ? (worker.capabilities as string[]) : [];
    /*
     * The sandbox rule, applied where it belongs.
     *
     * Sprint 3 requires containment for CODING work, because a coding agent
     * executes processes against a checkout. General work runs no process on the
     * worker at all — the reasoning happens in the control plane — so a worker
     * without a sandbox can still do research, and refusing it would be a rule
     * enforced for its own sake rather than for the risk it addresses.
     */
    if (advertised.includes('claude_code') && (!settings.requireSandbox || worker.sandboxReady)) {
      capabilities.add('coding');
    }
    if (advertised.includes('general_task')) capabilities.add('general');
  }

  return {
    reasoningModelAvailable: settings.generalWorkEnabled ? await reasoningProviderAvailable() : false,
    workerCapabilities: capabilities,
  };
}

const asCapabilityList = (value: unknown): ProjectCapability[] =>
  Array.isArray(value) ? (value.filter((v) => typeof v === 'string') as ProjectCapability[]) : [];

const asTaskKindList = (value: unknown): TaskKind[] =>
  Array.isArray(value) ? (value.filter((v) => typeof v === 'string') as TaskKind[]) : [];

/**
 * Everything Mac could conceivably start, with a verdict on each.
 *
 * Deliberately returns candidates that are NOT eligible as well: the Night
 * Queue screen shows why something was skipped, and a collection that filtered
 * them out could not.
 */
/**
 * Everything Mac could conceivably start tonight, from BOTH queues.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE TWO COLLECTORS AND ONE SCHEDULER
 *
 * Before Sprint 3.3 this function began `const boards = await readableBoards();
 * if (boards.length === 0) return [];` — so a task with no monday board was not
 * merely ineligible, it was INVISIBLE. Spec section 8 ranks direct instructions
 * highest, and the one class of work ranked first was the one class the
 * scheduler could not enumerate (reconciliation drift D-3).
 *
 * The fix is a second collector, not a second scheduler. Both produce the same
 * `CandidateContext`, both are ordered by the same comparator, and the same
 * `decideNextAction` chooses between them. Sprint 3.3 section 5 is explicit that
 * fake monday rows are not an acceptable way to reuse the existing path, and
 * they would also have been a lie in the database.
 *
 * SELECTION PRECEDENCE, in `orderCandidates`:
 *   1. the project Mac is already working in;
 *   2. priority rank (monday priority and task priority share one 0-3 scale);
 *   3. DIRECT before monday on a tie — a direct task is one a human handed Mac
 *      personally, and spec section 8 puts that first;
 *   4. stable id comparison, so two ticks on the same data agree.
 * ---------------------------------------------------------------------------
 */
export async function collectCandidates(
  settings: Settings,
  nightShiftId: string | null,
  handle: DbHandle = db,
): Promise<CandidateContext[]> {
  const capabilities = await shiftCapabilities(settings, handle);
  const [monday, direct] = await Promise.all([
    collectMondayCandidates(settings, nightShiftId, capabilities, handle),
    collectDirectCandidates(settings, nightShiftId, capabilities, handle),
  ]);
  return [...direct, ...monday];
}

async function collectMondayCandidates(
  settings: Settings,
  nightShiftId: string | null,
  capabilities: ShiftCapabilities,
  handle: DbHandle = db,
): Promise<CandidateContext[]> {
  // Everything Mac may READ. Whether he may take work from it is the
  // eligibility predicate's job, and collecting an ineligible item is what lets
  // the Night Queue explain the refusal instead of showing an empty list.
  const boards = await readableBoards(handle);
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

  // Sprint 3.3: a monday-backed task still has a KIND, and a board may perfectly
  // well track research. Nothing about coming from monday makes work coding work.
  const taskKindById = new Map<string, string>();
  if (taskIds.length) {
    const rows = await handle
      .select({ id: tasks.id, taskKind: tasks.taskKind })
      .from(tasks)
      .where(inArray(tasks.id, taskIds));
    for (const row of rows) taskKindById.set(row.id, row.taskKind);
  }

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
   * Tasks Mac has already run during THIS shift, whatever the outcome.
   *
   * The dangerous case is the finished one. A completed run leaves no active
   * run, and if monday.com has not been updated yet — a failed write, a board
   * that is down — the item is still sitting in a startable status. Without
   * this, Mac would do the same piece of work twice and open two pull requests
   * for it.
   */
  const attemptedThisShift = new Set<string>();
  if (nightShiftId && taskIds.length) {
    const rows = await handle
      .select({ taskId: runs.taskId })
      .from(runs)
      .where(and(inArray(runs.taskId, taskIds), eq(runs.nightShiftId, nightShiftId)));
    for (const row of rows) attemptedThisShift.add(row.taskId);
  }

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

    const taskKind = (taskKindById.get(item.taskId ?? '') ?? 'coding') as TaskKind;
    const projectCapabilities = asCapabilityList(project.capabilities);
    const allowedTaskKinds = asTaskKindList(project.allowedTaskKinds);

    const requirements = evaluateTaskRequirements({
      taskKind,
      origin: 'monday',
      facts: {
        hasApprovedRepository: approvedRepoProjects.has(project.id),
        hasApprovedBoard: true,
        hasMondayItem: true,
        hasBrief: Boolean(brief),
        hasReasoningModel: capabilities.reasoningModelAvailable,
        hasCompanyContext: true,
        codingAgentEnabled: settings.codingAgentEnabled,
        projectCapabilities,
        allowedTaskKinds,
      },
    });

    const input: EligibilityInput = {
      project: {
        nightShiftApproved: project.nightShiftApproved,
        isActive: project.isActive,
        capabilities: projectCapabilities,
        allowedTaskKinds,
      },
      work: {
        taskKind,
        origin: 'monday',
        title: item.name,
        priority: 'normal',
      },
      capability: {
        workerAvailable: capabilities.workerCapabilities.has(capabilityForTaskKind(taskKind)),
        reasoningModelAvailable: capabilities.reasoningModelAvailable,
        unmetRequirements: requirements.unmet,
      },
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
        attemptedThisShift: Boolean(item.taskId && attemptedThisShift.has(item.taskId)),
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
        source: 'monday',
        taskKind,
      },
      input,
      taskId: item.taskId,
      boardRowId: boardEntry.board.id,
      mondayItemUrl: item.url,
      confidence,
      taskKind,
    });
  });

  return contexts;
}

/**
 * The direct-task queue (Sprint 3.3 §5).
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES A DIRECT TASK ELIGIBLE, AND WHAT DOES NOT
 *
 * Deliberately NOT a relaxed version of the monday rules. A direct task passes
 * the same authority gates — approved project, handoff brief, understanding
 * confidence in the autonomous band, no run already in flight, not blocked
 * earlier tonight — plus two the board used to cover implicitly:
 *
 *   * `task_kind_permitted`: a human allowed THIS KIND of work on THIS project.
 *     The board's `allowedItemTypes` did this job for monday work; a direct task
 *     has no board, so the permission moved onto the project where it belongs.
 *
 *   * `worker_capability_available`: an online worker advertises the capability.
 *     Sprint 3.3 §22 — a run must not disappear into `queued` because nothing
 *     can execute it.
 *
 * What it does NOT require is a repository (unless the work is coding) or a
 * monday item (ever). Those two lines are the sprint.
 * ---------------------------------------------------------------------------
 */
async function collectDirectCandidates(
  settings: Settings,
  nightShiftId: string | null,
  capabilities: ShiftCapabilities,
  handle: DbHandle = db,
): Promise<CandidateContext[]> {
  const rows = await handle
    .select({ task: tasks, project: projects })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(
      and(
        eq(tasks.origin, 'direct'),
        /*
         * Belt AND braces: origin says where it came from, `monday_item_id`
         * says what it is linked to now, and this queue wants tasks for which
         * both agree. A task that is linked to a board is that board's work
         * whatever its origin column says, and collecting it here as well would
         * let the scheduler consider one piece of work twice.
         */
        isNull(tasks.mondayItemId),
        // `draft` and `ready` are the two states that mean "not yet done and not
        // in flight". A task someone cancelled or completed is not work.
        inArray(tasks.status, ['draft', 'ready']),
        eq(projects.isActive, true),
      ),
    )
    .orderBy(desc(tasks.createdAt))
    .limit(200);

  if (rows.length === 0) return [];

  const taskIds = rows.map((r) => r.task.id);

  const briefRows = await handle
    .select()
    .from(handoffBriefs)
    .where(inArray(handoffBriefs.taskId, taskIds))
    .orderBy(desc(handoffBriefs.version));
  const briefByTask = new Map<string, (typeof briefRows)[number]>();
  for (const brief of briefRows) if (!briefByTask.has(brief.taskId)) briefByTask.set(brief.taskId, brief);

  const approvedRepoProjects = new Set(
    (
      await handle
        .select({ projectId: repositories.projectId })
        .from(repositories)
        .where(eq(repositories.isApproved, true))
    ).map((r) => r.projectId),
  );

  const activeTaskIds = new Set(
    (
      await handle
        .select({ taskId: runs.taskId })
        .from(runs)
        .where(and(inArray(runs.taskId, taskIds), inArray(runs.status, [...ACTIVE_RUN_STATUSES])))
    ).map((r) => r.taskId),
  );

  // Attempted during THIS shift, whatever the outcome. Same reasoning as the
  // monday path: a completed run leaves no active run, and without this Mac
  // would happily do the same investigation twice and write two reports.
  const attemptedThisShift = new Set<string>();
  if (nightShiftId) {
    const attempted = await handle
      .select({ taskId: runs.taskId })
      .from(runs)
      .where(and(inArray(runs.taskId, taskIds), eq(runs.nightShiftId, nightShiftId)));
    for (const row of attempted) attemptedThisShift.add(row.taskId);
  }

  const blockedTaskIds = new Set<string>();
  if (nightShiftId) {
    const blocked = await handle
      .select({ taskId: runs.taskId })
      .from(runBlockers)
      .innerJoin(runs, eq(runs.id, runBlockers.runId))
      .where(and(eq(runs.nightShiftId, nightShiftId), eq(runBlockers.resolved, false)));
    for (const row of blocked) blockedTaskIds.add(row.taskId);
  }

  /*
   * A human pre-approved a narrower scope for this task.
   *
   * Identical to the monday path and identically strict: only a real approval
   * row, made by a person, carrying `thresholdOverridden`. Inferring it from a
   * brief that "looks scoped" would be Mac granting himself the permission the
   * 60-79% band exists to withhold.
   */
  const scopeApproved = new Set<string>();
  const approvedRows = await handle
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
  for (const row of approvedRows) scopeApproved.add(row.taskId);

  const contexts: CandidateContext[] = [];

  rows.forEach((row, index) => {
    const { task, project } = row;
    const taskKind = task.taskKind as TaskKind;
    const brief = briefByTask.get(task.id);
    const confidence = brief ? parseConfidence(brief.confidence) : null;

    const projectCapabilities = asCapabilityList(project.capabilities);
    const allowedTaskKinds = asTaskKindList(project.allowedTaskKinds);

    const requirements = evaluateTaskRequirements({
      taskKind,
      origin: 'direct',
      facts: {
        hasApprovedRepository: approvedRepoProjects.has(project.id),
        hasApprovedBoard: false,
        // A direct task needs no monday item, so this is true by construction
        // rather than by luck: `deriveExecutionRequirements` never asks for one.
        hasMondayItem: false,
        hasBrief: Boolean(brief),
        hasReasoningModel: capabilities.reasoningModelAvailable,
        hasCompanyContext: true,
        codingAgentEnabled: settings.codingAgentEnabled,
        projectCapabilities,
        allowedTaskKinds,
      },
    });

    const input: EligibilityInput = {
      project: {
        nightShiftApproved: project.nightShiftApproved,
        isActive: project.isActive,
        capabilities: projectCapabilities,
        allowedTaskKinds,
      },
      work: {
        taskKind,
        origin: 'direct',
        title: task.title,
        priority: task.priority as TaskPriority,
      },
      // No board and no item. Every board check is skipped rather than failed.
      board: null,
      item: null,
      dependencyStatuses: {},
      capability: {
        workerAvailable: capabilities.workerCapabilities.has(capabilityForTaskKind(taskKind)),
        reasoningModelAvailable: capabilities.reasoningModelAvailable,
        unmetRequirements: requirements.unmet,
      },
      mac: {
        briefConfidence: confidence,
        hasApprovedLimitedScope: scopeApproved.has(task.id),
        repositoryApproved: approvedRepoProjects.has(project.id),
        hasActiveRun: activeTaskIds.has(task.id),
        attemptedThisShift: attemptedThisShift.has(task.id),
        blockedEarlierTonight: blockedTaskIds.has(task.id),
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
      sizeLabel: null,
      scopeKind: 'full',
    });

    contexts.push({
      candidate: {
        taskId: task.id,
        mondayItemId: null,
        title: task.title,
        projectId: project.id,
        projectName: project.name,
        eligibility: verdict,
        effort,
        source: candidateSourceOf(input),
        taskKind,
      },
      input,
      taskId: task.id,
      boardRowId: '',
      mondayItemUrl: null,
      confidence,
      taskKind,
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
      /*
       * Matching by task id first, and by monday item id only as a fallback.
       *
       * The Sprint 3 line matched on `mondayItemId`, which for a direct task is
       * null on BOTH sides — so `null === null` matched the first direct
       * candidate in the list rather than the chosen one. Task id is the
       * identity that exists for every candidate from either queue.
       */
      const context =
        contexts.find((c) => decision.candidate.taskId !== null && c.taskId === decision.candidate.taskId) ??
        contexts.find(
          (c) =>
            decision.candidate.mondayItemId !== null &&
            c.candidate.mondayItemId === decision.candidate.mondayItemId,
        );
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

  /*
   * Sprint 3.2: the company context this night's run is governed by.
   *
   * Checked before EVERY task the shift starts, not once per shift, because a
   * PAC policy change at 03:00 should reach the 03:30 task. What it must never
   * do is reach a task already running - each run pins its own revision, and
   * the database refuses to move a pin once set.
   *
   * A refusal here means the whole task is skipped rather than run ungrounded.
   */
  const companyContext = await requireActiveRevision('night_shift.task_start').catch(() => {
    throw new Error('COMPANY_CONTEXT_UNAVAILABLE');
  });

  return db.transaction(async (tx) => {
    const settings = await getSettings(tx);

    const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!task) return null;

    /*
     * Sprint 3.3: what kind of work this is decides how it is performed.
     *
     * Before this sprint the next twenty lines demanded an approved repository
     * and then wrote `jobKind: 'claude_code'` unconditionally — so a research
     * task that somehow reached here would either be dropped (no repository) or
     * handed to a coding agent (reconciliation drift D-4). Spec section 3 says
     * Mac delegates coding "where appropriate"; this is where "appropriate" is
     * decided.
     */
    const taskKind = task.taskKind as TaskKind;
    const jobKind = resolveJobKind(taskKind);
    const needsRepository = jobKind === 'claude_code';

    const [repository] = await tx
      .select()
      .from(repositories)
      .where(and(eq(repositories.projectId, task.projectId), eq(repositories.isApproved, true)))
      .limit(1);
    // Only coding work is refused for want of a repository. Research in a
    // project that happens to have one may read it, and does not need it.
    if (needsRepository && !repository) return null;

    const [brief] = await tx
      .select()
      .from(handoffBriefs)
      .where(eq(handoffBriefs.taskId, taskId))
      .orderBy(desc(handoffBriefs.version))
      .limit(1);
    if (!brief) return null;

    const confidence = parseConfidence(brief.confidence) ?? 0;

    const jobParams = needsRepository
      ? {
          repositoryId: repository!.id,
          briefId: brief.id,
          provider: 'claude_code',
          maxMinutes: settings.maxAgentMinutes,
          openPullRequest: true,
        }
      : {
          briefId: brief.id,
          taskKind,
          maxMinutes: settings.maxAgentMinutes,
          maxSteps: settings.maxResearchSteps,
        };

    const [run] = await tx
      .insert(runs)
      .values({
        taskId,
        status: 'draft',
        // Approved on creation under the night-shift policy, and recorded as
        // such below. It is queued in the same transaction.
        approvalState: 'approved',
        confidence: confidence.toFixed(3),
        jobKind,
        jobParams,
        executionMode: 'overnight',
        repositoryId: needsRepository ? repository!.id : null,
        handoffBriefId: brief.id,
        scopeKind: confidence >= settings.defaultConfidenceThreshold ? 'full' : 'limited',
        nightShiftId: shift.id,
        mondayItemId: context.candidate.mondayItemId,
        selectedBy: 'night_shift',
        overnightDeadlineAt: shift.cutoffAt,
        companyContextRevisionId: companyContext?.id ?? null,
      })
      .returning();
    if (!run) return null;

    await recordContextBinding(tx, {
      actor: SYSTEM_ACTOR,
      runId: run.id,
      taskId,
      projectId: task.projectId,
      revision: companyContext,
    });

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
        boardRowId: context.boardRowId || null,
        // Sprint 3.3: the two facts that decide which authority applied.
        source: context.candidate.source ?? 'monday',
        taskKind: context.taskKind,
        eligibility: context.candidate.eligibility,
        effort: context.candidate.effort,
        rationale,
      },
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
      eventType: 'run.auto_approved',
      metadata: {
        source: 'night_shift_policy',
        nightShiftId: shift.id,
        mondayItemId: context.candidate.mondayItemId,
        taskKind: context.taskKind,
        jobKind,
        confidence,
        effort: context.candidate.effort.sizeClass,
        /*
         * The authority chain, stated differently for the two queues because it
         * genuinely IS different. A machine approval must be readable back to
         * the human decisions that permit it, and "board approved + item
         * flagged" is not true of a task that has no board.
         */
        basis:
          (context.candidate.source ?? 'monday') === 'direct'
            ? 'project approved for night shift + project permits this task kind + eligibility predicate'
            : 'project approved + board approved + item flagged + eligibility predicate',
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

    /*
     * monday.com, for work that came from monday.com.
     *
     * A direct task has no item to assign, no status to set and no update feed
     * to post to. Writing to one anyway would mean inventing a board row, which
     * Sprint 3.3 section 5 forbids and which would also put a fabricated task on
     * a board humans read.
     */
    if (context.candidate.mondayItemId) {
      await queueAssignToMac(tx, taskId, run.id);
      await queueStatus(tx, taskId, run.id, 'in_progress');
      await queueUpdate(
        tx,
        taskId,
        run.id,
        `**Mac has started this.**\n\n${rationale.reason}\n\nUnderstanding confidence ${(confidence * 100).toFixed(0)}%. ` +
          'He will post again when it is ready for review, or if he gets blocked.',
      );
    }

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

  /*
   * A run that finished but left an unresolved blocker is a BLOCKED task, not a
   * clean completion.
   *
   * Sprint 2's design is that a blocked subtask does not stop the run: the
   * independent work carries on and the blocked portion is left unimplemented.
   * That is right for the run, and wrong for the board — marking the item Ready
   * for Review would tell a human the work is finished when part of it was
   * deliberately not attempted.
   *
   * So the lifecycle status stays `completed` (it did complete, and the stop
   * reason says `completed_with_blockers`), while the SCHEDULER treats the task
   * as blocked: it posts the blocker, does not set Ready for Review, and moves
   * on to other work.
   */
  const terminal = ['completed', 'failed', 'stopped_by_guardrail', 'cancelled'].includes(status);
  const unresolvedBlockers = terminal || status === 'blocked' ? await countUnresolvedBlockers(row.run.id) : 0;

  const mapped: NonNullable<NightState['current']>['status'] =
    status === 'running' || status === 'self_review'
      ? (status as 'running' | 'self_review')
      : status === 'blocked' || unresolvedBlockers > 0
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

async function countUnresolvedBlockers(runId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(runBlockers)
    .where(and(eq(runBlockers.runId, runId), eq(runBlockers.resolved, false)));
  return row?.count ?? 0;
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
        priority: c.input.item?.priority ?? null,
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
