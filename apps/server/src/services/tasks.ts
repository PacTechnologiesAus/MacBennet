import { desc, eq, sql } from 'drizzle-orm';
import type { CreateTaskRequest, TaskDto, UpdateTaskRequest } from '@mac/protocol';
import { db } from '../db/client.js';
import { projects, tasks } from '../db/schema.js';
import type { TaskRow } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { parseConfidence } from '../domain/confidence.js';
import { record, type Actor } from './audit.js';

export const toTaskDto = (row: TaskRow, projectName?: string): TaskDto => ({
  id: row.id,
  projectId: row.projectId,
  ...(projectName !== undefined && { projectName }),
  title: row.title,
  description: row.description,
  status: row.status as TaskDto['status'],
  priority: row.priority as TaskDto['priority'],
  confidence: parseConfidence(row.confidence),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export async function listTasks(filter: { projectId?: string } = {}): Promise<TaskDto[]> {
  const rows = await db
    .select({ task: tasks, projectName: projects.name })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(filter.projectId ? eq(tasks.projectId, filter.projectId) : undefined)
    .orderBy(desc(tasks.createdAt));
  return rows.map((r) => toTaskDto(r.task, r.projectName));
}

export async function getTask(id: string): Promise<TaskDto> {
  const [row] = await db
    .select({ task: tasks, projectName: projects.name })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, id))
    .limit(1);
  if (!row) throw AppError.notFound('Task');
  return toTaskDto(row.task, row.projectName);
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
        confidence: input.confidence === null || input.confidence === undefined ? null : input.confidence.toFixed(3),
        createdBy: actor.id,
      })
      .returning();
    if (!row) throw new AppError(500, 'TASK_CREATE_FAILED', 'Could not create task.');

    await record(tx, {
      actor,
      eventType: 'task.created',
      context: { projectId: input.projectId, taskId: row.id },
      metadata: { title: row.title, priority: row.priority, confidence: parseConfidence(row.confidence) },
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
        ...(patch.confidence !== undefined && {
          confidence: patch.confidence === null ? null : patch.confidence.toFixed(3),
        }),
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, id))
      .returning();
    if (!row) throw AppError.notFound('Task');

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of ['title', 'description', 'status', 'priority', 'confidence'] as const) {
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
