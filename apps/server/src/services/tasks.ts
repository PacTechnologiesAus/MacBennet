import { desc, eq, inArray, sql } from 'drizzle-orm';
import type { CreateTaskRequest, TaskDto, TaskKind, TaskOrigin, UpdateTaskRequest } from '@mac/protocol';
import { db, type DbHandle } from '../db/client.js';
import { handoffBriefs, projects, tasks } from '../db/schema.js';
import type { TaskRow } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { parseConfidence } from '../domain/confidence.js';
import { record, type Actor } from './audit.js';
import { emit } from './events.js';

export const toTaskDto = (
  row: TaskRow,
  projectName?: string,
  understandingConfidence: number | null = null,
): TaskDto => ({
  id: row.id,
  projectId: row.projectId,
  ...(projectName !== undefined && { projectName }),
  title: row.title,
  description: row.description,
  status: row.status as TaskDto['status'],
  priority: row.priority as TaskDto['priority'],
  taskKind: row.taskKind as TaskKind,
  origin: row.origin as TaskOrigin,
  /*
   * Sprint 3.3: two confidences, and they are not interchangeable.
   *
   * `userInitialConfidence` is what the REQUESTER typed. `understandingConfidence`
   * is what MAC derived through discovery, read from the latest handoff brief,
   * and is the only one any execution gate consults. Sharing one word for both
   * is reconciliation drift D-7; sharing one field would have been worse.
   */
  userInitialConfidence: parseConfidence(row.userInitialConfidence),
  understandingConfidence,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** The latest brief confidence for many tasks at once. */
async function latestBriefConfidences(
  taskIds: string[],
  handle: DbHandle = db,
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (taskIds.length === 0) return out;

  /*
   * Drizzle's query builder rather than raw SQL.
   *
   * The first version of this used `handle.execute(sql\`SELECT DISTINCT ON …\`)`
   * and iterated the result directly, which throws: node-postgres returns a
   * result OBJECT with a `.rows` array, not an iterable. It slipped through
   * because every test either had no tasks — the early return above — or fetched
   * one task by id rather than listing.
   *
   * Ordering by (taskId, version) and keeping the first row per task gives the
   * same answer as DISTINCT ON, in one query, with the types checked.
   */
  const rows = await handle
    .select({ taskId: handoffBriefs.taskId, version: handoffBriefs.version, confidence: handoffBriefs.confidence })
    .from(handoffBriefs)
    .where(inArray(handoffBriefs.taskId, taskIds))
    .orderBy(handoffBriefs.taskId, desc(handoffBriefs.version));

  for (const row of rows) {
    if (!out.has(row.taskId)) out.set(row.taskId, parseConfidence(row.confidence));
  }
  return out;
}

/** Mac's derived understanding confidence, from the latest brief version. */
export async function understandingConfidenceFor(
  taskId: string,
  handle: DbHandle = db,
): Promise<number | null> {
  const [brief] = await handle
    .select({ confidence: handoffBriefs.confidence })
    .from(handoffBriefs)
    .where(eq(handoffBriefs.taskId, taskId))
    .orderBy(desc(handoffBriefs.version))
    .limit(1);
  return brief ? parseConfidence(brief.confidence) : null;
}

export async function listTasks(filter: { projectId?: string } = {}): Promise<TaskDto[]> {
  const rows = await db
    .select({ task: tasks, projectName: projects.name })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(filter.projectId ? eq(tasks.projectId, filter.projectId) : undefined)
    .orderBy(desc(tasks.createdAt));
  /*
   * One query for every task's understanding confidence, not one per task.
   *
   * DISTINCT ON gives the highest brief version per task in a single pass;
   * looping `understandingConfidenceFor` here would be an N+1 on the list view
   * that grows with the backlog.
   */
  const confidences = await latestBriefConfidences(rows.map((r) => r.task.id));
  return rows.map((r) => toTaskDto(r.task, r.projectName, confidences.get(r.task.id) ?? null));
}

export async function getTask(id: string): Promise<TaskDto> {
  const [row] = await db
    .select({ task: tasks, projectName: projects.name })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, id))
    .limit(1);
  if (!row) throw AppError.notFound('Task');
  return toTaskDto(row.task, row.projectName, await understandingConfidenceFor(id));
}

export async function createTask(input: CreateTaskRequest, actor: Actor): Promise<TaskDto> {
  const title = input.title.trim();
  if (!title) throw AppError.badRequest('INVALID_TITLE', 'Task title cannot be blank.');

  return db.transaction(async (tx) => {
    const [project] = await tx.select().from(projects).where(eq(projects.id, input.projectId)).limit(1);
    if (!project) throw AppError.notFound('Project');
    if (!project.isActive) {
      // An inactive project is the operator's signal that Mac should not be
      // working on it. Refusing here keeps that signal meaningful.
      throw AppError.conflict('PROJECT_INACTIVE', 'Cannot create a task on an inactive project.');
    }

    const [row] = await tx
      .insert(tasks)
      .values({
        projectId: input.projectId,
        title,
        description: input.description?.trim() || null,
        priority: input.priority,
        /*
         * Unclassified tasks default to `coding` at the column level only for
         * schema compatibility. When the requester did not choose a kind, that
         * is recorded honestly and discovery proposes one — a silent default of
         * `coding` is how research work came to need a repository.
         */
        ...(input.taskKind ? { taskKind: input.taskKind } : {}),
        /** Direct: created in Mac's own UI. monday-mirrored tasks set this themselves. */
        origin: 'direct',
        userInitialConfidence:
          input.userInitialConfidence === null || input.userInitialConfidence === undefined
            ? null
            : input.userInitialConfidence.toFixed(3),
        createdBy: actor.id,
      })
      .returning();
    if (!row) throw new AppError(500, 'TASK_CREATE_FAILED', 'Could not create task.');

    await emit(tx, {
      type: 'task_created',
      projectId: input.projectId,
      taskId: row.id,
      data: { title: row.title, taskKind: row.taskKind, priority: row.priority, origin: row.origin },
    });

    await record(tx, {
      actor,
      eventType: 'task.created',
      context: { projectId: input.projectId, taskId: row.id },
      metadata: {
        title: row.title,
        priority: row.priority,
        taskKind: row.taskKind,
        origin: row.origin,
        userInitialConfidence: parseConfidence(row.userInitialConfidence),
      },
    });

    return toTaskDto(row, project.name);
  });
}

export async function updateTask(id: string, patch: UpdateTaskRequest, actor: Actor): Promise<TaskDto> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!before) throw AppError.notFound('Task');

    const [row] = await tx
      .update(tasks)
      .set({
        ...(patch.title !== undefined && { title: patch.title.trim() }),
        ...(patch.description !== undefined && { description: patch.description.trim() || null }),
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.priority !== undefined && { priority: patch.priority }),
        ...(patch.taskKind !== undefined && { taskKind: patch.taskKind }),
        ...(patch.userInitialConfidence !== undefined && {
          userInitialConfidence:
            patch.userInitialConfidence === null ? null : patch.userInitialConfidence.toFixed(3),
        }),
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, id))
      .returning();
    if (!row) throw AppError.notFound('Task');

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of ['title', 'description', 'status', 'priority', 'taskKind', 'userInitialConfidence'] as const) {
      if (before[key] !== row[key]) changes[key] = { from: before[key], to: row[key] };
    }

    await record(tx, {
      actor,
      eventType: 'task.updated',
      context: { projectId: row.projectId, taskId: row.id },
      metadata: { changes },
    });

    return toTaskDto(row);
  });
}

/** Used by the run service; kept here so task existence checks live in one place. */
export async function requireTaskWithProject(
  tx: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
  taskId: string,
): Promise<{ task: TaskRow; projectId: string; projectName: string; projectActive: boolean }> {
  const [row] = await tx
    .select({ task: tasks, projectName: projects.name, projectActive: projects.isActive })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!row) throw AppError.notFound('Task');
  return {
    task: row.task,
    projectId: row.task.projectId,
    projectName: row.projectName,
    projectActive: row.projectActive,
  };
}

export async function countTasks(): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(tasks);
  return row?.count ?? 0;
}
