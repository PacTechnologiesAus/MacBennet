import { desc, eq, inArray } from 'drizzle-orm';
import type { EmailDeliveryDto, OvernightEmailContent } from '@mac/protocol';
import { db } from '../db/client.js';
import {
  nightShifts,
  projects,
  pullRequests,
  runAssumptions,
  runBlockers,
  runReports,
  runReviews,
  runs,
  tasks,
} from '../db/schema.js';
import { config } from '../config.js';
import { parseConfidence } from '../domain/confidence.js';
import { getSettings } from './settings.js';
import { usageSummaryForRun } from './usage.js';
import { generateRunReport } from './reports.js';
import { mondayActivitySince } from './monday/outbox.js';
import { queueOvernightEmail } from './mail/delivery.js';
import { record, SYSTEM_ACTOR, type Actor } from './audit.js';

/**
 * Assembling the night's report (Sprint 3 §9.4).
 *
 * Built by aggregating the per-run `MorningReportDto`s Sprint 2 already
 * produces, so there is ONE report generator rather than two that could
 * disagree about what happened. This file adds the cross-run view: what
 * finished, what is stuck, what needs a person, and one link back to the UI for
 * everything else.
 */

export async function buildOvernightContent(nightShiftId: string): Promise<OvernightEmailContent> {
  const [shift] = await db.select().from(nightShifts).where(eq(nightShifts.id, nightShiftId)).limit(1);
  if (!shift) throw new Error(`No such night shift: ${nightShiftId}`);

  const settings = await getSettings();

  const shiftRuns = await db
    .select({ run: runs, taskTitle: tasks.title, projectName: projects.name })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(runs.nightShiftId, nightShiftId))
    .orderBy(desc(runs.createdAt));

  const runIds = shiftRuns.map((r) => r.run.id);

  const [assumptions, blockers, prs, reviews, reports] = await Promise.all([
    runIds.length ? db.select().from(runAssumptions).where(inArray(runAssumptions.runId, runIds)) : [],
    runIds.length ? db.select().from(runBlockers).where(inArray(runBlockers.runId, runIds)) : [],
    runIds.length ? db.select().from(pullRequests).where(inArray(pullRequests.runId, runIds)) : [],
    runIds.length ? db.select().from(runReviews).where(inArray(runReviews.runId, runIds)) : [],
    runIds.length ? db.select().from(runReports).where(inArray(runReports.runId, runIds)) : [],
  ]);

  const reportByRun = new Map(reports.map((r) => [r.runId, r.content as Record<string, unknown>]));
  const reviewByRun = new Map(reviews.map((r) => [r.runId, r]));

  const completed: OvernightEmailContent['completed'] = [];
  const inProgress: OvernightEmailContent['inProgress'] = [];
  const blocked: OvernightEmailContent['blocked'] = [];
  const whatChanged: string[] = [];
  const decisionsNeeded: string[] = [];
  const exceptions: string[] = [];
  const byTask: Array<{ task: string; hours: number }> = [];
  let totalHours = 0;

  for (const { run, taskTitle, projectName } of shiftRuns) {
    const report = reportByRun.get(run.id);
    const review = reviewByRun.get(run.id);
    const runBlocker = blockers.filter((b) => b.runId === run.id);

    if (runBlocker.length > 0) {
      blocked.push({
        task: taskTitle,
        project: projectName,
        blocker: runBlocker.map((b) => b.description).join('; ').slice(0, 300),
        needs: runBlocker.map((b) => b.reason).join('; ').slice(0, 300),
        runId: run.id,
      });
    }

    if (run.status === 'completed') {
      completed.push({
        task: taskTitle,
        project: projectName,
        summary: (run.summary ?? 'Completed.').slice(0, 300),
        runId: run.id,
      });
      // One line per task. The whole point of §28.
      if (report?.whatChanged) whatChanged.push(`${taskTitle}: ${String(report.whatChanged).slice(0, 240)}`);
    } else if (['queued', 'running', 'blocked', 'self_review', 'ready_for_human_review'].includes(run.status)) {
      inProgress.push({
        task: taskTitle,
        project: projectName,
        stage: run.progressStage ?? run.status,
        runId: run.id,
      });
    } else {
      exceptions.push(`${taskTitle} ended as ${run.status}${run.stopReason ? ` (${run.stopReason})` : ''}.`);
    }

    if (report?.decisionsNeeded) {
      for (const decision of report.decisionsNeeded as string[]) decisionsNeeded.push(`${taskTitle}: ${decision}`);
    }
    if (report?.exceptions) {
      for (const exception of report.exceptions as string[]) exceptions.push(`${taskTitle}: ${exception}`);
    }
    if (review?.humanAttentionRequired) {
      decisionsNeeded.push(`${taskTitle}: Mac flagged this for human attention.`);
    }

    const hours = typeof report?.estimatedHumanHours === 'number' ? report.estimatedHumanHours : 0;
    if (hours > 0) {
      byTask.push({ task: taskTitle, hours });
      totalHours += hours;
    }
  }

  /*
   * Usage across the night, at the WEAKEST source among the runs.
   *
   * Never upgraded. A night containing one exact reading and three unavailable
   * ones is not an exact night, and reporting it as one would be exactly the
   * conflation spec §25 forbids.
   */
  const usageSummaries = await Promise.all(runIds.map((id) => usageSummaryForRun(id)));
  const usage = summariseNightUsage(usageSummaries);

  const monday = await mondayActivitySince(shift.startedAt);

  return {
    nightShiftId,
    generatedAt: new Date().toISOString(),
    windowStart: shift.startedAt.toISOString(),
    windowEnd: (shift.endedAt ?? shift.cutoffAt).toISOString(),
    completed,
    inProgress,
    blocked,
    whatChanged,
    pullRequests: prs.map((pr) => ({
      url: pr.url,
      title: pr.title,
      summary:
        shiftRuns.find((r) => r.run.id === pr.runId)?.run.summary?.slice(0, 200) ?? 'Ready for review.',
    })),
    decisionsNeeded,
    exceptions,
    lowConfidenceAssumptions: assumptions
      .filter((a) => a.flagged)
      .slice(0, 20)
      .map((a) => ({
        statement: a.statement,
        confidence: parseConfidence(a.confidence) ?? 0,
        task: shiftRuns.find((r) => r.run.id === a.runId)?.taskTitle ?? '',
      })),
    estimatedHumanHours: { total: Math.round(totalHours * 4) / 4, byTask },
    usage,
    monday,
    dashboardUrl: `${config.appUrl}/night-shift`,
  };
}

/**
 * The night's usage line.
 *
 * Sums only what is comparable, and labels the result with the weakest source
 * present. There is no arithmetic here that could turn four estimates into one
 * exact figure.
 */
function summariseNightUsage(
  summaries: Array<{ source: string; label: string; delta: { inputTokens: number | null; outputTokens: number | null; costCents: number | null } }>,
): OvernightEmailContent['usage'] {
  if (summaries.length === 0) {
    return { label: 'Provider usage unavailable', source: 'unavailable', note: 'No runs executed.' };
  }

  const rank: Record<string, number> = { exact: 0, observed: 1, estimated: 2, unavailable: 3 };
  const weakest = summaries.reduce(
    (worst, s) => ((rank[s.source] ?? 3) > (rank[worst] ?? 3) ? s.source : worst),
    'exact',
  );

  if (weakest === 'unavailable') {
    return {
      label: 'Provider usage unavailable',
      source: 'unavailable',
      note: `${summaries.length} run(s); at least one reported nothing usable.`,
    };
  }

  const totals = summaries.reduce(
    (acc, s) => ({
      input: acc.input + (s.delta.inputTokens ?? 0),
      output: acc.output + (s.delta.outputTokens ?? 0),
      cost: acc.cost + (s.delta.costCents ?? 0),
    }),
    { input: 0, output: 0, cost: 0 },
  );

  const money =
    totals.cost > 0
      ? weakest === 'exact'
        ? ` · $${(totals.cost / 100).toFixed(2)} billed`
        : ` · $${(totals.cost / 100).toFixed(2)} equivalent API list price (not billed — subscription access)`
      : '';

  return {
    label:
      `${totals.input.toLocaleString()} in / ${totals.output.toLocaleString()} out tokens across ` +
      `${summaries.length} run(s)${money}. Source: ${weakest}.`,
    source: weakest,
    note: weakest === 'exact' ? null : 'This is not an enforceable dollar figure.',
  };
}

// ---------------------------------------------------------------------------

/**
 * Generates the per-run reports, assembles the night's email, and queues it.
 *
 * Idempotent at every level: `generateRunReport` upserts, and the email's key
 * is the shift id, so calling this twice produces one email.
 */
export async function deliverOvernightReport(
  nightShiftId: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<EmailDeliveryDto> {
  const shiftRuns = await db
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(eq(runs.nightShiftId, nightShiftId));

  for (const run of shiftRuns) {
    // Per-run reports first: the night's email is an aggregation of them, and
    // a missing one would silently shrink the summary.
    await generateRunReport(run.id, actor).catch(() => undefined);
  }

  const content = await buildOvernightContent(nightShiftId);
  const delivery = await queueOvernightEmail(nightShiftId, content, actor);

  await db.transaction(async (tx) => {
    await record(tx, {
      actor,
      eventType: 'report.generated',
      metadata: {
        nightShiftId,
        deliveryId: delivery.id,
        completed: content.completed.length,
        blocked: content.blocked.length,
        pullRequests: content.pullRequests.length,
        decisionsNeeded: content.decisionsNeeded.length,
      },
    });
  });

  return delivery;
}
