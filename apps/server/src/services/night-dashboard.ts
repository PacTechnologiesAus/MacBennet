import { and, desc, eq, inArray } from 'drizzle-orm';
import type { NightShiftDashboardDto } from '@mac/protocol';
import { db } from '../db/client.js';
import { nightShifts, projects, pullRequests, runBlockers, runs, tasks } from '../db/schema.js';
import { getSettings, toCutoffConfig } from './settings.js';
import { nextCutoffAfter } from '../domain/overnight.js';
import { getBudgetStatus } from './budget.js';
import { listWorkers } from './workers.js';
import { toRunDto } from './runs.js';
import {
  buildNightQueue,
  getActiveShift,
  listNightDecisions,
  toNightShiftDto,
} from './night-shift.js';

/**
 * The Night Shift dashboard (Sprint 3 §14).
 *
 * One query set rather than eight endpoints. The question a human asks at 08:00
 * is a single one — "what happened, and is anything waiting for me?" — and
 * answering it from eight screens is how the answer becomes "I'll look later".
 *
 * `macState` is derived here rather than stored, so the dashboard cannot show a
 * state the runs table disagrees with.
 */
export async function buildNightShiftDashboard(now = new Date()): Promise<NightShiftDashboardDto> {
  const settings = await getSettings();
  const shift = await getActiveShift();

  const cutoffAt = shift?.cutoffAt ?? nextCutoffAfter(now, toCutoffConfig(settings));

  const [activeRunRow] = shift
    ? await db
        .select({ run: runs, projectName: projects.name, taskTitle: tasks.title, projectId: projects.id })
        .from(runs)
        .innerJoin(tasks, eq(tasks.id, runs.taskId))
        .innerJoin(projects, eq(projects.id, tasks.projectId))
        .where(
          and(
            eq(runs.nightShiftId, shift.id),
            inArray(runs.status, ['queued', 'running', 'blocked', 'self_review']),
          ),
        )
        .orderBy(desc(runs.createdAt))
        .limit(1)
    : [];

  const shiftRuns = shift
    ? await db
        .select({ run: runs, projectName: projects.name, taskTitle: tasks.title })
        .from(runs)
        .innerJoin(tasks, eq(tasks.id, runs.taskId))
        .innerJoin(projects, eq(projects.id, tasks.projectId))
        .where(eq(runs.nightShiftId, shift.id))
        .orderBy(desc(runs.createdAt))
        .limit(100)
    : [];

  const runIds = shiftRuns.map((r) => r.run.id);

  const blockers = runIds.length
    ? await db.select().from(runBlockers).where(inArray(runBlockers.runId, runIds))
    : [];

  const prs = runIds.length ? await db.select().from(pullRequests).where(inArray(pullRequests.runId, runIds)) : [];
  const prByRun = new Map(prs.map((p) => [p.runId, p]));

  const [queue, workers, budget, decisions] = await Promise.all([
    buildNightQueue(),
    listWorkers(now),
    getBudgetStatus(settings),
    shift ? listNightDecisions(shift.id, 20) : Promise.resolve([]),
  ]);

  const activeRun = activeRunRow
    ? toRunDto(activeRunRow.run, {
        taskTitle: activeRunRow.taskTitle,
        projectId: activeRunRow.projectId,
        projectName: activeRunRow.projectName,
      })
    : null;

  /*
   * Mac's state, derived rather than stored.
   *
   * `day_mode` is the default and is what the spec calls assist mode: no shift
   * is running, so Mac answers questions and does not start work.
   */
  const macState: NightShiftDashboardDto['macState'] = !shift
    ? 'day_mode'
    : shift.status !== 'running'
      ? 'stopped'
      : activeRun
        ? activeRun.status === 'blocked'
          ? 'blocked'
          : 'working'
        : 'idle';

  return {
    shift: shift ? toNightShiftDto(shift, now) : null,
    macState,
    activeRun,
    activeProjectName: activeRunRow?.projectName ?? null,
    queue,
    blocked: blockers.map((b) => {
      const owner = shiftRuns.find((r) => r.run.id === b.runId);
      return {
        runId: b.runId,
        taskTitle: owner?.taskTitle ?? '',
        projectName: owner?.projectName ?? '',
        blocker: b.description,
        at: b.createdAt.toISOString(),
      };
    }),
    completedTonight: shiftRuns
      .filter((r) => r.run.status === 'completed')
      .map((r) => ({
        runId: r.run.id,
        taskTitle: r.taskTitle,
        projectName: r.projectName,
        pullRequestUrl: prByRun.get(r.run.id)?.url ?? null,
      })),
    minutesUntilCutoff: Math.max(0, Math.floor((cutoffAt.getTime() - now.getTime()) / 60_000)),
    budget,
    workers,
    sandboxReadyWorkers: workers.filter((w) => w.sandboxReady && w.isLive).length,
    recentDecisions: decisions,
  };
}

/** The most recent completed shift, for the morning report. */
export async function lastCompletedShift() {
  const [row] = await db
    .select()
    .from(nightShifts)
    .where(inArray(nightShifts.status, ['completed', 'stopped']))
    .orderBy(desc(nightShifts.endedAt))
    .limit(1);
  return row ?? null;
}
