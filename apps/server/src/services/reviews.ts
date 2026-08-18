import { eq } from 'drizzle-orm';
import {
  handoffBriefContentSchema,
  reviewEvidenceSchema,
  type PullRequestDto,
  type PullRequestReportRequest,
  type ReviewEvidence,
  type ReviewVerdict,
  type ReviewVerdictResponse,
  type RiskLevel,
  type RunReviewDto,
} from '@mac/protocol';
import { db, type DbHandle } from '../db/client.js';
import { handoffBriefs, projects, pullRequests, repositories, runReviews, runs, tasks } from '../db/schema.js';
import type { RunReviewRow } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { parseConfidence } from '../domain/confidence.js';
import { reviewRun as computeReview } from '../domain/review.js';
import { buildPullRequestBody, buildPullRequestTitle, buildUsageSummary } from '../domain/report.js';
import { getSettings } from './settings.js';
import { transition } from './runs.js';
import { countGitViolations, listAssumptions, listBlockers, listQuestions, countUnansweredQuestions } from './coding-sessions.js';
import { usageSummaryForRun } from './usage.js';
import { appendSystemLog } from './logs.js';
import { record, type Actor } from './audit.js';

/**
 * Mac's self-review (Sprint 2 §12) and pull-request decision (§13).
 *
 * The division of labour is deliberate and is the reason this lives in the
 * control plane rather than the worker:
 *
 *   the worker gathers FACTS from the repository — diff, tests, commits;
 *   Mac draws the CONCLUSION — does this satisfy the brief, is a PR warranted;
 *   the worker then EXECUTES the decision — pushes and calls `gh`.
 *
 * So the judgement is made where the brief, the confidence, the questions and
 * the audit trail are, and it is persisted before any pull request exists.
 */

export const toReviewDto = (row: RunReviewRow): RunReviewDto => ({
  id: row.id,
  runId: row.runId,
  verdict: row.verdict as ReviewVerdict,
  riskLevel: row.riskLevel as RiskLevel,
  satisfiesBrief: row.satisfiesBrief,
  acceptanceCriteriaMet: row.acceptanceCriteriaMet,
  unexpectedScope: row.unexpectedScope,
  humanAttentionRequired: row.humanAttentionRequired,
  prRecommended: row.prRecommended,
  prDeclineReason: row.prDeclineReason,
  anomalies: Array.isArray(row.anomalies) ? (row.anomalies as string[]) : [],
  evidence: (row.evidence ?? {}) as Record<string, unknown>,
  createdAt: row.createdAt.toISOString(),
});

export async function getReview(runId: string, handle: DbHandle = db): Promise<RunReviewDto | null> {
  const [row] = await handle.select().from(runReviews).where(eq(runReviews.runId, runId)).limit(1);
  return row ? toReviewDto(row) : null;
}

/**
 * Performs the self-review and returns both the verdict and — when Mac decides
 * a pull request is warranted — the exact title, body and base to open it with.
 *
 * The run enters the `self_review` lifecycle state here, so the phase is
 * visible in the UI and in the audit trail rather than being an invisible step
 * between "running" and "done".
 */
export async function submitReview(
  runId: string,
  evidenceInput: ReviewEvidence,
  actor: Actor,
): Promise<ReviewVerdictResponse['verdict'] extends never ? never : Omit<ReviewVerdictResponse, 'control'>> {
  const evidence = reviewEvidenceSchema.parse(evidenceInput);

  return db.transaction(async (tx) => {
    const context = await loadReviewContext(tx, runId);
    const settings = await getSettings(tx);

    // Enter self_review. A run that is already past `running` (cancelled, say)
    // will fail this transition, which is the correct outcome — a cancelled run
    // must not quietly acquire a pull request.
    await transition(tx, {
      runId,
      to: 'self_review',
      actor,
      eventType: 'run.self_review',
      metadata: {
        filesChanged: evidence.filesChanged.length,
        commits: evidence.commits.length,
        testsRan: evidence.tests?.ran ?? false,
        testsPassed: evidence.tests?.passed ?? null,
      },
    });

    const [questions, assumptions, blockers, violations, unanswered] = await Promise.all([
      listQuestions(runId, tx),
      listAssumptions(runId, tx),
      listBlockers(runId, tx),
      countGitViolations(runId, tx),
      countUnansweredQuestions(runId, tx),
    ]);

    const outcome = computeReview({
      evidence,
      brief: context.brief,
      confidence: context.confidence,
      confidenceThreshold: settings.defaultConfidenceThreshold,
      scopeKind: context.scopeKind,
      blockers: blockers.filter((b) => !b.resolved).map((b) => ({ description: b.description, risk: b.risk })),
      flaggedAssumptions: assumptions.filter((a) => a.flagged).map((a) => ({ statement: a.statement, confidence: a.confidence })),
      unansweredQuestions: unanswered,
      gitViolations: violations,
    });

    await tx
      .insert(runReviews)
      .values({
        runId,
        verdict: outcome.verdict,
        riskLevel: outcome.riskLevel,
        satisfiesBrief: outcome.satisfiesBrief,
        acceptanceCriteriaMet: outcome.acceptanceCriteriaMet,
        unexpectedScope: outcome.unexpectedScope,
        humanAttentionRequired: outcome.humanAttentionRequired,
        prRecommended: outcome.prRecommended,
        prDeclineReason: outcome.prDeclineReason,
        anomalies: outcome.anomalies,
        evidence,
      })
      .onConflictDoUpdate({
        target: runReviews.runId,
        set: {
          verdict: outcome.verdict,
          riskLevel: outcome.riskLevel,
          satisfiesBrief: outcome.satisfiesBrief,
          acceptanceCriteriaMet: outcome.acceptanceCriteriaMet,
          unexpectedScope: outcome.unexpectedScope,
          humanAttentionRequired: outcome.humanAttentionRequired,
          prRecommended: outcome.prRecommended,
          prDeclineReason: outcome.prDeclineReason,
          anomalies: outcome.anomalies,
          evidence,
        },
      });

    await record(tx, {
      actor,
      eventType: 'run.review_completed',
      context: { runId, taskId: context.taskId, projectId: context.projectId },
      metadata: {
        verdict: outcome.verdict,
        risk: outcome.riskLevel,
        satisfiesBrief: outcome.satisfiesBrief,
        acceptanceCriteriaMet: outcome.acceptanceCriteriaMet,
        unexpectedScope: outcome.unexpectedScope,
        anomalies: outcome.anomalies,
        prRecommended: outcome.prRecommended,
        prDeclineReason: outcome.prDeclineReason,
      },
    });

    if (evidence.tests?.ran) {
      await record(tx, {
        actor,
        eventType: evidence.tests.passed ? 'test.run' : 'test.failed',
        context: { runId, taskId: context.taskId, projectId: context.projectId },
        metadata: {
          command: evidence.tests.command,
          exitCode: evidence.tests.exitCode,
          passed: evidence.tests.passed,
          durationMs: evidence.tests.durationMs,
        },
      });
    }

    await appendSystemLog(
      tx,
      runId,
      `Self-review: ${outcome.verdict}, risk ${outcome.riskLevel}. ` +
        (outcome.prRecommended ? 'A pull request will be opened.' : `No pull request: ${outcome.prDeclineReason}`),
    );

    // --- The pull-request directive ----------------------------------------

    if (!outcome.prRecommended || !context.openPullRequest) {
      const reason = outcome.prDeclineReason ?? 'Pull-request creation was not requested for this run.';
      await record(tx, {
        actor,
        eventType: 'pull_request.declined',
        context: { runId, taskId: context.taskId, projectId: context.projectId },
        metadata: { reason },
      });

      return {
        verdict: outcome.verdict,
        riskLevel: outcome.riskLevel,
        satisfiesBrief: outcome.satisfiesBrief,
        acceptanceCriteriaMet: outcome.acceptanceCriteriaMet,
        unexpectedScope: outcome.unexpectedScope,
        humanAttentionRequired: outcome.humanAttentionRequired,
        anomalies: outcome.anomalies,
        pullRequest: { shouldOpen: false as const, reason },
      };
    }

    const usage = await usageSummaryForRun(runId, tx).catch(() => buildUsageSummary(null, null, null));

    const body = buildPullRequestBody({
      runId,
      taskTitle: context.taskTitle,
      projectName: context.projectName,
      brief: context.brief,
      evidence,
      review: outcome,
      questions: questions.map((q) => ({ question: q.question, answer: q.answer, confidence: q.confidence, decision: q.decision })),
      assumptions: assumptions.map((a) => ({ statement: a.statement, confidence: a.confidence, flagged: a.flagged })),
      blockers: blockers.map((b) => ({ description: b.description, reason: b.reason, risk: b.risk })),
      usage,
      outcome: 'completed',
      stopReason: null,
      pullRequest: null,
      answerConfidenceThreshold: settings.answerConfidenceThreshold,
      generatedAt: new Date(),
    });

    return {
      verdict: outcome.verdict,
      riskLevel: outcome.riskLevel,
      satisfiesBrief: outcome.satisfiesBrief,
      acceptanceCriteriaMet: outcome.acceptanceCriteriaMet,
      unexpectedScope: outcome.unexpectedScope,
      humanAttentionRequired: outcome.humanAttentionRequired,
      anomalies: outcome.anomalies,
      pullRequest: {
        shouldOpen: true as const,
        title: buildPullRequestTitle(context.brief),
        body,
        // Always the default branch — and Mac has no capability to merge it.
        base: context.defaultBranch,
      },
    };
  });
}

interface ReviewContext {
  taskId: string;
  projectId: string;
  taskTitle: string;
  projectName: string;
  brief: ReturnType<typeof handoffBriefContentSchema.parse>;
  confidence: number | null;
  scopeKind: 'full' | 'limited';
  defaultBranch: string;
  openPullRequest: boolean;
}

async function loadReviewContext(tx: DbHandle, runId: string): Promise<ReviewContext> {
  const [row] = await tx
    .select({
      taskId: runs.taskId,
      projectId: tasks.projectId,
      taskTitle: tasks.title,
      projectName: projects.name,
      briefId: runs.handoffBriefId,
      confidence: runs.confidence,
      scopeKind: runs.scopeKind,
      jobParams: runs.jobParams,
      repositoryId: runs.repositoryId,
    })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(runs.id, runId))
    .limit(1);

  if (!row) throw AppError.notFound('Run');
  if (!row.briefId) throw AppError.conflict('NO_BRIEF', 'This run has no handoff brief to review the work against.');

  const [briefRow] = await tx.select().from(handoffBriefs).where(eq(handoffBriefs.id, row.briefId)).limit(1);
  if (!briefRow) throw AppError.notFound('Handoff brief');

  let defaultBranch = 'main';
  if (row.repositoryId) {
    const [repo] = await tx.select({ defaultBranch: repositories.defaultBranch }).from(repositories).where(eq(repositories.id, row.repositoryId)).limit(1);
    if (repo) defaultBranch = repo.defaultBranch;
  }

  const params = (row.jobParams ?? {}) as { openPullRequest?: boolean };

  return {
    taskId: row.taskId,
    projectId: row.projectId,
    taskTitle: row.taskTitle,
    projectName: row.projectName,
    brief: handoffBriefContentSchema.parse(briefRow.content),
    confidence: parseConfidence(row.confidence),
    scopeKind: (row.scopeKind as 'full' | 'limited') ?? 'full',
    defaultBranch,
    openPullRequest: params.openPullRequest !== false,
  };
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

/**
 * Records a pull request the worker opened.
 *
 * There is no `mergePullRequest` here, and there is no column to record a merge
 * in. "Mac must never merge the PR" is therefore not a rule the code has to
 * remember — it is a capability that does not exist.
 */
export async function recordPullRequest(
  runId: string,
  input: PullRequestReportRequest,
  actor: Actor,
): Promise<{ pullRequestId: string }> {
  return db.transaction(async (tx) => {
    const [ctx] = await tx
      .select({ taskId: runs.taskId, projectId: tasks.projectId })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .where(eq(runs.id, runId))
      .limit(1);
    if (!ctx) throw AppError.notFound('Run');

    // Defence in depth: a pull request whose head is the default branch would
    // be a merge of main into main. Refused here as well as in the git policy.
    if (input.branch === input.baseBranch) {
      throw AppError.conflict(
        'PR_HEAD_IS_BASE',
        'A pull request cannot have the default branch as its head. Mac never proposes changes from the default branch.',
      );
    }

    const [review] = await tx.select().from(runReviews).where(eq(runReviews.runId, runId)).limit(1);
    if (!review?.prRecommended) {
      throw AppError.conflict(
        'PR_NOT_APPROVED_BY_REVIEW',
        'Mac\'s self-review did not recommend a pull request for this run, so one may not be recorded.',
      );
    }

    const [row] = await tx
      .insert(pullRequests)
      .values({
        runId,
        provider: input.provider,
        number: input.number,
        url: input.url,
        title: input.title,
        branch: input.branch,
        baseBranch: input.baseBranch,
      })
      .onConflictDoUpdate({
        target: pullRequests.runId,
        set: { number: input.number, url: input.url, title: input.title },
      })
      .returning();
    if (!row) throw new AppError(500, 'PR_RECORD_FAILED', 'Could not record the pull request.');

    await record(tx, {
      actor,
      eventType: 'pull_request.created',
      context: { runId, taskId: ctx.taskId, projectId: ctx.projectId },
      metadata: { url: input.url, number: input.number, branch: input.branch, baseBranch: input.baseBranch },
    });

    await appendSystemLog(tx, runId, `Pull request opened: ${input.url} (${input.branch} → ${input.baseBranch}). Mac will not merge it.`);

    return { pullRequestId: row.id };
  });
}

export async function getPullRequest(runId: string, handle: DbHandle = db): Promise<PullRequestDto | null> {
  const [row] = await handle.select().from(pullRequests).where(eq(pullRequests.runId, runId)).limit(1);
  if (!row) return null;
  return {
    id: row.id,
    runId: row.runId,
    provider: row.provider,
    number: row.number,
    url: row.url,
    title: row.title,
    branch: row.branch,
    baseBranch: row.baseBranch,
    createdAt: row.createdAt.toISOString(),
  };
}
