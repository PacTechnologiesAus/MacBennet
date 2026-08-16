import { eq } from 'drizzle-orm';
import {
  buildTaskBranchName,
  handoffBriefContentSchema,
  isSafeBranchName,
  renderBriefMarkdown,
  type CodingAssignment,
  type CodingRunDetailDto,
  type CreateCodingRunRequest,
  type RunDto,
} from '@mac/protocol';
import { db, type DbHandle } from '../db/client.js';
import { handoffBriefs, repositories, runs, tasks } from '../db/schema.js';
import type { RunRow } from '../db/schema.js';
import { AppError, GuardrailError } from '../http/errors.js';
import { adviseExecution, parseConfidence } from '../domain/confidence.js';
import { getSettings, toConfidencePolicy } from './settings.js';
import { assertRepositoryApproved, getRepository, requireRepositoryRow } from './repositories.js';
import { briefDto, requireBriefRow } from './briefs.js';
import { toRunDto } from './runs.js';
import {
  getAgentSession,
  getWorktreeDto,
  listAssumptions,
  listBlockers,
  listGitViolations,
  listQuestions,
} from './coding-sessions.js';
import { getPullRequest, getReview } from './reviews.js';
import { usageSummaryForRun } from './usage.js';
import { record, type Actor } from './audit.js';

/**
 * Creating and describing coding runs (Sprint 2 §3).
 *
 * A coding run is an ordinary Sprint 1 run with `job_kind = 'claude_code'`. It
 * therefore inherits, without any new code, every guardrail Sprint 1 built: it
 * cannot be dispatched unapproved (the SQL predicate), it obeys the overnight
 * cutoff, it can be cancelled, and every status change is audited.
 *
 * What this module adds is the resolution of ids into a working environment —
 * repository, branch and brief — and it does that SERVER-SIDE at lease time, so
 * no path, remote or branch name ever arrives from a client.
 */

export async function createCodingRun(input: CreateCodingRunRequest, actor: Actor): Promise<RunDto> {
  return db.transaction(async (tx) => {
    const settings = await getSettings(tx);
    if (!settings.codingAgentEnabled) {
      throw new GuardrailError('CODING_AGENT_DISABLED', 'Delegating work to a coding agent is currently disabled in settings.');
    }

    const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId)).limit(1);
    if (!task) throw AppError.notFound('Task');

    const repository = await requireRepositoryRow(input.repositoryId, tx);
    // Approval check 1 of 3. The other two are the dispatch predicate and the
    // assignment build, for the same reason the job allowlist is checked thrice.
    assertRepositoryApproved(repository);
    if (repository.projectId !== task.projectId) {
      throw AppError.badRequest('REPOSITORY_PROJECT_MISMATCH', 'That repository does not belong to the task\'s project.');
    }

    const brief = await requireBriefRow(input.briefId, tx);
    if (brief.taskId !== input.taskId) {
      throw AppError.badRequest('BRIEF_TASK_MISMATCH', 'That handoff brief belongs to a different task.');
    }

    const confidence = parseConfidence(brief.confidence) ?? 0;
    const advice = adviseExecution(confidence, toConfidencePolicy(settings));

    /*
     * The hard floor, enforced at creation as well as at approval.
     *
     * Below 0.60 a run may not even be created, so there is no artefact sitting
     * in the queue waiting for someone to approve it. The floor is stated by
     * the specification as a prohibition, and there is no parameter here that
     * relaxes it.
     */
    if (!advice.executionPermitted) {
      throw new GuardrailError('CONFIDENCE_BELOW_FLOOR', advice.message);
    }

    const branch = buildTaskBranchName({ taskRef: shortRef(task.id), title: task.title });
    if (!isSafeBranchName(branch)) {
      throw new AppError(500, 'UNSAFE_BRANCH_NAME', `Generated an unsafe branch name (${branch}); refusing to proceed.`);
    }

    const [row] = await tx
      .insert(runs)
      .values({
        taskId: input.taskId,
        status: 'draft',
        approvalState: 'pending',
        confidence: confidence.toFixed(3),
        jobKind: 'claude_code',
        jobParams: {
          repositoryId: input.repositoryId,
          briefId: input.briefId,
          provider: input.provider,
          maxMinutes: Math.min(input.maxMinutes, settings.maxAgentMinutes),
          openPullRequest: input.openPullRequest,
        },
        executionMode: input.executionMode,
        repositoryId: input.repositoryId,
        handoffBriefId: input.briefId,
        scopeKind: advice.scopeKind,
        // In the limited band this records what Mac proposes to actually do, so
        // the human approves a scope rather than a vague intention.
        approvedScope: advice.scopeKind === 'limited' ? handoffBriefContentSchema.parse(brief.content).proposedScope : null,
        createdBy: actor.id,
      })
      .returning();
    if (!row) throw new AppError(500, 'RUN_CREATE_FAILED', 'Could not create the coding run.');

    await record(tx, {
      actor,
      eventType: 'run.created',
      context: { runId: row.id, taskId: row.taskId, projectId: task.projectId },
      metadata: {
        jobKind: 'claude_code',
        repositoryId: input.repositoryId,
        briefId: input.briefId,
        provider: input.provider,
        branch,
        confidence,
        band: advice.band,
        scopeKind: advice.scopeKind,
        executionMode: input.executionMode,
      },
    });

    return toRunDto(row, { taskTitle: task.title, projectId: task.projectId });
  });
}

/** Short, stable, human-recognisable reference used in the branch name. */
export const shortRef = (uuid: string): string => uuid.replace(/-/g, '').slice(0, 8);

/**
 * Builds the coding assignment at lease time.
 *
 * Everything here is read from the database — the remote, the local clone path,
 * the default branch, the brief. Nothing is taken from the run request beyond
 * ids. This is what allows the worker to run a coding session without the
 * protocol ever carrying a filesystem path or a command from a user.
 */
export async function buildCodingAssignment(tx: DbHandle, run: RunRow): Promise<CodingAssignment | null> {
  if (run.jobKind !== 'claude_code' && run.jobKind !== 'repo_inspect') return null;

  const params = (run.jobParams ?? {}) as {
    repositoryId?: string;
    briefId?: string;
    provider?: 'claude_code' | 'mock';
    maxMinutes?: number;
    openPullRequest?: boolean;
  };

  const repositoryId = params.repositoryId ?? run.repositoryId;
  if (!repositoryId) return null;

  const [repository] = await tx.select().from(repositories).where(eq(repositories.id, repositoryId)).limit(1);
  if (!repository) throw AppError.notFound('Repository');

  // Approval check 3 of 3, against the row actually being dispatched. Approval
  // withdrawn between queueing and dispatch stops the run here.
  assertRepositoryApproved(repository);

  const [task] = await tx.select().from(tasks).where(eq(tasks.id, run.taskId)).limit(1);
  if (!task) throw AppError.notFound('Task');

  const settings = await getSettings(tx);

  const briefId = params.briefId ?? run.handoffBriefId;
  const [briefRow] = briefId ? await tx.select().from(handoffBriefs).where(eq(handoffBriefs.id, briefId)).limit(1) : [undefined];

  const content = briefRow
    ? handoffBriefContentSchema.parse(briefRow.content)
    : handoffBriefContentSchema.parse({ title: task.title, userObjective: task.title });

  const branch = buildTaskBranchName({ taskRef: shortRef(task.id), title: task.title });
  if (!isSafeBranchName(branch)) {
    throw new AppError(500, 'UNSAFE_BRANCH_NAME', `Refusing to dispatch with unsafe branch name "${branch}".`);
  }

  const confidence = parseConfidence(run.confidence);

  return {
    repositoryId: repository.id,
    repositoryName: repository.name,
    remoteUrl: repository.remoteUrl,
    remoteName: repository.remoteName,
    localPath: repository.localPath,
    defaultBranch: repository.defaultBranch,
    branch,
    provider: params.provider ?? 'claude_code',
    task: {
      brief: content,
      briefMarkdown: renderBriefMarkdown(content, { confidence: confidence ?? 0 }),
      testCommand: Array.isArray(repository.testCommand) ? (repository.testCommand as string[]) : [],
      buildCommand: Array.isArray(repository.buildCommand) ? (repository.buildCommand as string[]) : [],
      limits: {
        maxMinutes: Math.min(params.maxMinutes ?? settings.maxAgentMinutes, settings.maxAgentMinutes),
        maxQuestions: settings.maxQuestionsPerRun,
        // A dollar cap is only passed to the agent when money is genuinely
        // enforceable. Under subscription access it is not, so it stays null
        // rather than becoming a limit that cannot be enforced.
        maxBudgetUsd: null,
      },
    },
    openPullRequest: params.openPullRequest !== false,
    pullRequestBase: repository.defaultBranch,
  };
}

/** Everything the Coding Run screen needs, in one query set. */
export async function getCodingRunDetail(runId: string): Promise<CodingRunDetailDto> {
  const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!row) throw AppError.notFound('Run');

  const [task] = await db.select().from(tasks).where(eq(tasks.id, row.taskId)).limit(1);

  const [repository, worktree, session, questions, assumptions, blockers, violations, review, pullRequest, usage] =
    await Promise.all([
      row.repositoryId ? getRepository(row.repositoryId).catch(() => null) : Promise.resolve(null),
      getWorktreeDto(runId),
      getAgentSession(runId),
      listQuestions(runId),
      listAssumptions(runId),
      listBlockers(runId),
      listGitViolations(runId),
      getReview(runId),
      getPullRequest(runId),
      usageSummaryForRun(runId),
    ]);

  const brief = row.handoffBriefId
    ? await requireBriefRow(row.handoffBriefId).then((b) => briefDto(b)).catch(() => null)
    : null;

  return {
    run: toRunDto(row, { taskTitle: task?.title ?? '', projectId: task?.projectId ?? '' }),
    repository,
    worktree,
    brief,
    session,
    questions,
    assumptions,
    blockers,
    violations,
    review,
    pullRequest,
    usage,
  };
}
