import { desc, eq, gte } from 'drizzle-orm';
import {
  handoffBriefContentSchema,
  isGeneralJobKind,
  reviewEvidenceSchema,
  type MorningReportDto,
  type StopReason,
  type TaskKind,
} from '@mac/protocol';
import { db, type DbHandle } from '../db/client.js';
import { handoffBriefs, projects, runReports, runReviews, runs, tasks } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { buildMorningReport, type ReportInputs } from '../domain/report.js';
import type { ReviewOutcome } from '../domain/review.js';
import { getSettings } from './settings.js';
import { listArtefacts } from './artefacts.js';
import { getGeneralRunState } from './research/runner.js';
import { contextRefFor } from './company-context/service.js';
import { listAssumptions, listBlockers, listQuestions } from './coding-sessions.js';
import { getPullRequest } from './reviews.js';
import { usageSummaryForRun } from './usage.js';
import { record, type Actor } from './audit.js';

/**
 * The morning report (Sprint 2 §14, spec §28).
 *
 * Generated from records that already exist — the review, the questions, the
 * assumptions, the blockers, the usage snapshots — so the report cannot say
 * anything the audit trail does not already contain. It is a rendering of the
 * night's evidence, not a separate account of it.
 *
 * Generation is idempotent: regenerating produces the same document from the
 * same facts, which matters because a report a human has already read must not
 * change underneath them.
 */

/**
 * The findings, deliverables and source counts of a general run.
 *
 * Returns null for a coding run, which is what keeps every Sprint 3 report
 * identical: `buildMorningReport` branches on this being present, not on a flag
 * somebody might set inconsistently.
 */
async function generalReportBlock(
  jobKind: string,
  runId: string,
  tx: DbHandle,
): Promise<ReportInputs['general']> {
  if (!isGeneralJobKind(jobKind)) return null;

  const [state, artefacts] = await Promise.all([
    getGeneralRunState(runId, tx),
    listArtefacts({ runId }, tx),
  ]);

  return {
    findings: state?.state.findings ?? [],
    unknowns: state?.state.unknowns ?? [],
    artefacts: artefacts.map((a) => ({
      id: a.id,
      type: a.type,
      title: a.title,
      summary: a.summary || a.body.slice(0, 200),
    })),
    sourcesConsulted: state?.state.sources.length ?? 0,
    // Counted separately because a claim resting on the public internet is a
    // different kind of claim from one resting on PAC's own records, and a
    // reader deciding how much to trust the report should see the split.
    externalSourcesUsed: (state?.state.sources ?? []).filter((source) => source.external).length,
  };
}

export async function generateRunReport(runId: string, actor: Actor, handle?: DbHandle): Promise<MorningReportDto> {
  const run = async (tx: DbHandle) => {
    const [row] = await tx
      .select({
        runId: runs.id,
        taskId: runs.taskId,
        projectId: tasks.projectId,
        taskTitle: tasks.title,
        projectName: projects.name,
        status: runs.status,
        stopReason: runs.stopReason,
        briefId: runs.handoffBriefId,
        jobKind: runs.jobKind,
        taskKind: tasks.taskKind,
        companyContextRevisionId: runs.companyContextRevisionId,
      })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(eq(runs.id, runId))
      .limit(1);

    if (!row) throw AppError.notFound('Run');

    const settings = await getSettings(tx);

    const [briefRow] = row.briefId
      ? await tx.select().from(handoffBriefs).where(eq(handoffBriefs.id, row.briefId)).limit(1)
      : [undefined];

    const brief = briefRow
      ? handoffBriefContentSchema.parse(briefRow.content)
      : handoffBriefContentSchema.parse({ title: row.taskTitle, userObjective: row.taskTitle });

    const [reviewRow] = await tx.select().from(runReviews).where(eq(runReviews.runId, runId)).limit(1);

    const [questions, assumptions, blockers, pullRequest, usage] = await Promise.all([
      listQuestions(runId, tx),
      listAssumptions(runId, tx),
      listBlockers(runId, tx),
      getPullRequest(runId, tx),
      usageSummaryForRun(runId, tx),
    ]);

    const review: ReviewOutcome | null = reviewRow
      ? {
          verdict: reviewRow.verdict as ReviewOutcome['verdict'],
          riskLevel: reviewRow.riskLevel as ReviewOutcome['riskLevel'],
          satisfiesBrief: reviewRow.satisfiesBrief,
          acceptanceCriteriaMet: reviewRow.acceptanceCriteriaMet,
          unexpectedScope: reviewRow.unexpectedScope,
          humanAttentionRequired: reviewRow.humanAttentionRequired,
          anomalies: Array.isArray(reviewRow.anomalies) ? (reviewRow.anomalies as string[]) : [],
          prRecommended: reviewRow.prRecommended,
          prDeclineReason: reviewRow.prDeclineReason,
        }
      : null;

    const evidence = reviewRow?.evidence ? reviewEvidenceSchema.safeParse(reviewRow.evidence) : null;

    const report = buildMorningReport({
      runId,
      taskTitle: row.taskTitle,
      projectName: row.projectName,
      brief,
      evidence: evidence?.success ? evidence.data : null,
      review,
      questions: questions.map((q) => ({ question: q.question, answer: q.answer, confidence: q.confidence, decision: q.decision })),
      assumptions: assumptions.map((a) => ({ statement: a.statement, confidence: a.confidence, flagged: a.flagged })),
      blockers: blockers.filter((b) => !b.resolved).map((b) => ({ description: b.description, reason: b.reason, risk: b.risk })),
      usage,
      outcome: row.status,
      stopReason: (row.stopReason as StopReason | null) ?? null,
      pullRequest: pullRequest ? { url: pullRequest.url, number: pullRequest.number } : null,
      answerConfidenceThreshold: settings.answerConfidenceThreshold,
      generatedAt: new Date(),
      taskKind: row.taskKind as TaskKind,
      /*
       * Sprint 3.3: the general-work block, present only for a general run.
       *
       * Its presence is what switches the report from "what changed" to "what
       * Mac found" and drops the pull-request section — so a coding run gets
       * byte-identical output to Sprint 3, and a research run gets a report
       * shaped like its own work.
       */
      general: await generalReportBlock(row.jobKind, runId, tx),
      companyContext: await contextRefFor(row.companyContextRevisionId, tx),
    });

    await tx
      .insert(runReports)
      .values({ runId, content: report, markdown: report.markdown })
      .onConflictDoUpdate({
        target: runReports.runId,
        set: { content: report, markdown: report.markdown, generatedAt: new Date() },
      });

    await record(tx, {
      actor,
      eventType: 'report.generated',
      context: { runId, taskId: row.taskId, projectId: row.projectId },
      metadata: {
        outcome: row.status,
        risk: report.risk,
        questionsAnswered: report.questionsAnswered,
        lowConfidenceAnswers: report.lowConfidenceAnswers,
        flaggedAssumptions: report.flaggedAssumptions.length,
        decisionsNeeded: report.decisionsNeeded.length,
        pullRequestUrl: report.pullRequestUrl,
        estimatedHumanHours: report.estimatedHumanHours,
        usageSource: usage.source,
      },
    });

    return report;
  };

  return handle ? run(handle) : db.transaction(run);
}

export async function getRunReport(runId: string): Promise<MorningReportDto | null> {
  const [row] = await db.select().from(runReports).where(eq(runReports.runId, runId)).limit(1);
  return row ? (row.content as MorningReportDto) : null;
}

/**
 * The morning's reading: every report generated since a given instant.
 *
 * A daily digest is this query, not a scheduler — which keeps the sprint free
 * of a background job whose only purpose would be to assemble something the
 * database can already produce on demand.
 */
export async function listReports(since?: Date): Promise<MorningReportDto[]> {
  const rows = await db
    .select()
    .from(runReports)
    .where(since ? gte(runReports.generatedAt, since) : undefined)
    .orderBy(desc(runReports.generatedAt))
    .limit(100);

  return rows.map((r) => r.content as MorningReportDto);
}
