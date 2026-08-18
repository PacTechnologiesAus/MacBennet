import { and, desc, eq } from 'drizzle-orm';
import {
  capabilityForTaskKind,
  describeTaskKind,
  handoffBriefContentSchema,
  MODEL_PROVIDER_REQUIRED,
  permitsTaskKind,
  resolveJobKind,
  type GeneralAssignment,
  type TaskKind,
} from '@mac/protocol';
import type { DbHandle } from '../db/client.js';
import { db } from '../db/client.js';
import { handoffBriefs, projects, runs, tasks } from '../db/schema.js';
import type { RunRow } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { getSettings } from './settings.js';
import { requireReasoningProvider } from './model/provider.js';
import { beginGeneralRun } from './research/runner.js';

/**
 * Turning an approved general run into a worker assignment (Sprint 3.3 §13).
 *
 * The mirror of `coding-runs.ts#buildCodingAssignment`, and deliberately the
 * same shape: everything is resolved SERVER-SIDE from rows a human approved,
 * and the worker receives identifiers and limits rather than capabilities.
 *
 * What it resolves is different, because what general work needs is different:
 * no remote, no clone path, no branch, no base branch. A brief, an objective and
 * two ceilings.
 */
export async function buildGeneralAssignment(handle: DbHandle, run: RunRow): Promise<GeneralAssignment> {
  const settings = await getSettings(handle);

  if (!settings.generalWorkEnabled) {
    throw AppError.conflict('GENERAL_WORK_DISABLED', 'General (non-coding) work is switched off in settings.');
  }

  /*
   * The refusal, at the last moment before a worker is given the run.
   *
   * Eligibility already checked this when the scheduler selected the task, but
   * settings can change between selection and dispatch, and a run that reached a
   * worker with no model behind it would produce an empty artefact set that
   * reads, in the morning report, exactly like a completed investigation.
   */
  await requireReasoningProvider('This general run');

  const [context] = await handle
    .select({
      taskId: tasks.id,
      taskTitle: tasks.title,
      taskKind: tasks.taskKind,
      projectId: tasks.projectId,
      allowedTaskKinds: projects.allowedTaskKinds,
      projectName: projects.name,
    })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, run.taskId))
    .limit(1);
  if (!context) throw AppError.notFound('Task');

  const taskKind = context.taskKind as TaskKind;

  if (capabilityForTaskKind(taskKind) !== 'general') {
    throw AppError.conflict(
      'TASK_KIND_MISMATCH',
      `This run is a general job but its task is ${taskKind} work, which is performed by ${resolveJobKind(taskKind)}.`,
    );
  }

  const allowed = Array.isArray(context.allowedTaskKinds) ? (context.allowedTaskKinds as TaskKind[]) : [];
  if (!permitsTaskKind({ capabilities: [], allowedTaskKinds: allowed }, taskKind)) {
    throw AppError.conflict(
      'TASK_KIND_NOT_PERMITTED',
      `${context.projectName} has not been approved for ${taskKind} work. ` +
        'An administrator allows a task kind explicitly; Mac does not grant himself one.',
    );
  }

  const params = (run.jobParams ?? {}) as { briefId?: string; maxSteps?: number; maxMinutes?: number };
  const briefId = params.briefId ?? run.handoffBriefId;
  if (!briefId) {
    throw AppError.conflict('BRIEF_REQUIRED', 'A general run needs a handoff brief; this one has none.');
  }

  const [brief] = await handle
    .select()
    .from(handoffBriefs)
    .where(and(eq(handoffBriefs.id, briefId), eq(handoffBriefs.taskId, run.taskId)))
    .orderBy(desc(handoffBriefs.version))
    .limit(1);
  if (!brief) throw AppError.notFound('Handoff brief');

  const content = handoffBriefContentSchema.parse(brief.content);
  const descriptor = describeTaskKind(taskKind);

  return {
    taskKind: taskKind as GeneralAssignment['taskKind'],
    maxSteps: Math.min(params.maxSteps ?? 8, settings.maxResearchSteps),
    maxMinutes: Math.min(params.maxMinutes ?? settings.maxAgentMinutes, 720),
    objective: content.userObjective.slice(0, 4000) || content.title,
    /*
     * Deliverables come from the brief's acceptance criteria when it has them.
     *
     * Sent to the worker only so the run log says what Mac was asked to produce.
     * The authoritative copy is the plan, which is built and pinned server-side —
     * a worker cannot widen its own objective by editing a string it was handed.
     */
    deliverables: (content.acceptanceCriteria.length
      ? content.acceptanceCriteria
      : descriptor.expectedArtefactTypes.map((t) => t.replace(/_/g, ' '))
    ).slice(0, 20),
  };
}

/**
 * Ensures the run's plan exists before the worker asks for its first step.
 *
 * Idempotent: called at dispatch and again defensively by the step endpoint, so
 * a worker that reconnects mid-run does not find itself planless.
 */
export async function ensureGeneralPlan(runId: string): Promise<void> {
  await beginGeneralRun(runId).catch((err) => {
    // A missing provider must surface as itself, not as a generic dispatch
    // failure — an operator reading `MODEL_PROVIDER_REQUIRED` knows what to do.
    if ((err as { code?: string }).code === MODEL_PROVIDER_REQUIRED) throw err;
    throw err;
  });
}

/** The job kind a task of this kind executes as. One lookup, one place. */
export async function jobKindForTask(taskId: string, handle: DbHandle = db): Promise<'claude_code' | 'general_task'> {
  const [row] = await handle.select({ taskKind: tasks.taskKind }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!row) throw AppError.notFound('Task');
  return resolveJobKind(row.taskKind as TaskKind);
}

/** Whether this run is general work. Used by the report and the UI. */
export async function isGeneralRun(runId: string, handle: DbHandle = db): Promise<boolean> {
  const [row] = await handle.select({ jobKind: runs.jobKind }).from(runs).where(eq(runs.id, runId)).limit(1);
  return row?.jobKind === 'general_task';
}
