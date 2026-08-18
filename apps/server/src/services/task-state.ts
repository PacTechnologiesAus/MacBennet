import { and, desc, eq } from 'drizzle-orm';
import {
  deriveExecutionRequirements,
  EXECUTION_REQUIREMENT_LABELS,
  type ProjectCapability,
  type TaskExecutionStateDto,
  type TaskKind,
  type TaskOrigin,
} from '@mac/protocol';
import { db, type DbHandle } from '../db/client.js';
import {
  discoverySessions,
  handoffBriefs,
  mondayBoards,
  projects,
  repositories,
  runs,
  tasks,
  workers,
} from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { parseConfidence } from '../domain/confidence.js';
import { evaluateEligibility } from '../domain/eligibility.js';
import { evaluateTaskRequirements, primaryBlocker } from '../domain/task-requirements.js';
import { capabilityForTaskKind } from '@mac/protocol';
import { getSettings } from './settings.js';
import { isWorkerLive } from './workers.js';
import { reasoningProviderAvailable } from './model/provider.js';
import { countArtefactsForTask } from './artefacts.js';

/**
 * Everything the Task Detail screen needs to explain itself (Sprint 3.3 §26).
 *
 * ---------------------------------------------------------------------------
 * ONE ANSWER TO "WHY WILL THIS NOT RUN?"
 *
 * The failure that started this sprint was a user creating a perfectly good task
 * and getting no answer at all — the screen offered "New run" as though
 * everything were fine, and the real reasons lived in three different modules
 * that each assumed a repository.
 *
 * So this function assembles the answer server-side, from the SAME domain
 * functions the night scheduler uses. `evaluateTaskRequirements` and
 * `evaluateEligibility` are not re-implemented here in a UI-friendly form; they
 * are called. A screen that disagreed with the scheduler about whether a task
 * can run would be worse than a screen that said nothing.
 * ---------------------------------------------------------------------------
 */
export async function taskExecutionState(
  taskId: string,
  handle: DbHandle = db,
): Promise<TaskExecutionStateDto> {
  const [row] = await handle
    .select({ task: tasks, project: projects })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!row) throw AppError.notFound('Task');

  const { task, project } = row;
  const taskKind = task.taskKind as TaskKind;
  const origin = task.origin as TaskOrigin;
  const settings = await getSettings(handle);

  const capabilities = (Array.isArray(project.capabilities) ? project.capabilities : []) as ProjectCapability[];
  const allowedTaskKinds = (Array.isArray(project.allowedTaskKinds) ? project.allowedTaskKinds : []) as TaskKind[];

  const [repository] = await handle
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.projectId, project.id), eq(repositories.isApproved, true)))
    .limit(1);

  const [board] = await handle
    .select({ id: mondayBoards.id })
    .from(mondayBoards)
    .where(and(eq(mondayBoards.projectId, project.id), eq(mondayBoards.isApproved, true)))
    .limit(1);

  const [brief] = await handle
    .select()
    .from(handoffBriefs)
    .where(eq(handoffBriefs.taskId, taskId))
    .orderBy(desc(handoffBriefs.version))
    .limit(1);

  const [session] = await handle
    .select()
    .from(discoverySessions)
    .where(eq(discoverySessions.taskId, taskId))
    .orderBy(desc(discoverySessions.createdAt))
    .limit(1);

  const understandingConfidence = brief ? parseConfidence(brief.confidence) : null;
  const reasoningModelAvailable = settings.generalWorkEnabled ? await reasoningProviderAvailable() : false;

  const requirements = evaluateTaskRequirements({
    taskKind,
    origin,
    facts: {
      hasApprovedRepository: Boolean(repository),
      hasApprovedBoard: Boolean(board),
      hasMondayItem: Boolean(task.mondayItemId),
      hasBrief: Boolean(brief),
      hasReasoningModel: reasoningModelAvailable,
      hasCompanyContext: settings.companyContextEnabled,
      codingAgentEnabled: settings.codingAgentEnabled,
      projectCapabilities: capabilities,
      allowedTaskKinds,
    },
  });

  const workerAvailable = await hasCapableWorker(capabilityForTaskKind(taskKind), handle);

  /*
   * The eligibility verdict, computed only once there is something to judge.
   *
   * Before a brief exists the answer would be "no" for a reason the requirement
   * list already states more clearly, and a screen showing thirteen red crosses
   * to somebody who has simply not pressed Start Discovery yet is noise, not
   * information.
   */
  const eligibility = brief
    ? evaluateEligibility({
        project: {
          nightShiftApproved: project.nightShiftApproved,
          isActive: project.isActive,
          capabilities,
          allowedTaskKinds,
        },
        work: {
          taskKind,
          origin,
          title: task.title,
          priority: task.priority as never,
        },
        // The Task Detail screen answers "could Mac start this tonight?", and
        // for monday work the board facts belong to the Night Queue screen,
        // which has the item in hand. Here the board checks are omitted rather
        // than guessed at.
        board: null,
        item: null,
        dependencyStatuses: {},
        capability: {
          workerAvailable,
          reasoningModelAvailable,
          unmetRequirements: requirements.unmet,
        },
        mac: {
          briefConfidence: understandingConfidence,
          hasApprovedLimitedScope: false,
          repositoryApproved: Boolean(repository),
          hasActiveRun: await hasActiveRun(taskId, handle),
          attemptedThisShift: false,
          blockedEarlierTonight: false,
        },
        policy: {
          minExecutionConfidence: settings.minExecutionConfidence,
          defaultConfidenceThreshold: settings.defaultConfidenceThreshold,
        },
      })
    : null;

  const effectiveAllowed = allowedTaskKinds.length ? allowedTaskKinds : (['coding'] as TaskKind[]);

  return {
    taskKind,
    origin,
    requirements: requirements.checks.map((c) => ({
      requirement: c.requirement,
      label: EXECUTION_REQUIREMENT_LABELS[c.requirement],
      satisfied: c.satisfied,
      detail: c.detail,
    })),
    projectCapabilities: capabilities,
    allowedTaskKinds,
    discovery: {
      sessionId: session?.id ?? null,
      status: session?.status ?? null,
      briefId: brief?.id ?? null,
      // The action the screen offers. There is deliberately no state a user has
      // to understand to know whether they may press it.
      canStart: !session && project.isActive,
    },
    understandingConfidence,
    eligibility,
    blockerSummary: primaryBlocker({
      requirements,
      hasBrief: Boolean(brief),
      hasDiscoverySession: Boolean(session),
      taskKindPermitted: effectiveAllowed.includes(taskKind),
      understandingConfidence,
      minExecutionConfidence: settings.minExecutionConfidence,
    }),
    artefactCount: await countArtefactsForTask(taskId, handle),
  };
}

/** Whether a live, idle worker advertises the capability this work needs. */
async function hasCapableWorker(capability: 'coding' | 'general', handle: DbHandle): Promise<boolean> {
  const settings = await getSettings(handle);
  const rows = await handle.select().from(workers);
  const needed = capability === 'coding' ? 'claude_code' : 'general_task';

  return rows.some((w) => {
    if (!isWorkerLive(w, settings.heartbeatIntervalSeconds, settings.heartbeatGraceSeconds)) return false;
    if (w.status === 'disabled') return false;
    const advertised = Array.isArray(w.capabilities) ? (w.capabilities as string[]) : [];
    if (!advertised.includes(needed)) return false;
    // Containment is a coding requirement: general work runs no process here.
    return capability !== 'coding' || !settings.requireSandbox || w.sandboxReady;
  });
}

async function hasActiveRun(taskId: string, handle: DbHandle): Promise<boolean> {
  const [row] = await handle
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  if (!row) return false;

  const [current] = await handle
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.id, row.id))
    .limit(1);
  return ['draft', 'ready_for_approval', 'approved', 'queued', 'running', 'blocked', 'self_review'].includes(
    current?.status ?? '',
  );
}
