import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { CreateMemoryRequest, MemoryEntryDto, MemoryScope } from '@mac/protocol';
import { db, type DbHandle } from '../db/client.js';
import { memoryEntries } from '../db/schema.js';
import type { MemoryEntryRow } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { parseConfidence } from '../domain/confidence.js';
import { record, type Actor } from './audit.js';

/**
 * Memory (spec §9), in three layers.
 *
 * The rule that shapes this file: **task memory must not contaminate unrelated
 * tasks.** That is enforced structurally rather than by convention — a
 * task-scoped row must carry a `task_id` (a CHECK constraint requires it), and
 * `memoryForTask` filters on exactly that id. There is no query in the system
 * that returns one task's memory while answering a question about another.
 *
 * The second rule: assumptions do not become project facts. Promotion is a
 * separate, explicit operation that refuses low-confidence entries.
 */

export const toMemoryDto = (row: MemoryEntryRow): MemoryEntryDto => ({
  id: row.id,
  scope: row.scope as MemoryScope,
  projectId: row.projectId,
  taskId: row.taskId,
  key: row.key,
  value: row.value,
  confidence: parseConfidence(row.confidence) ?? 1,
  source: row.source,
  promoted: row.promoted,
  createdAt: row.createdAt.toISOString(),
});

export async function createMemory(input: CreateMemoryRequest, actor: Actor): Promise<MemoryEntryDto> {
  // The database CHECK enforces this too; failing here gives a better message
  // than a constraint violation would.
  if (input.scope === 'project' && !input.projectId) {
    throw AppError.badRequest('MEMORY_SCOPE_MISMATCH', 'Project-scoped memory requires a projectId.');
  }
  if (input.scope === 'task' && !input.taskId) {
    throw AppError.badRequest('MEMORY_SCOPE_MISMATCH', 'Task-scoped memory requires a taskId.');
  }
  if (input.scope === 'global' && (input.projectId || input.taskId)) {
    throw AppError.badRequest('MEMORY_SCOPE_MISMATCH', 'Global memory must not be tied to a project or task.');
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(memoryEntries)
      .values({
        scope: input.scope,
        projectId: input.projectId ?? null,
        taskId: input.taskId ?? null,
        key: input.key,
        value: input.value,
        confidence: input.confidence.toFixed(3),
        source: input.source ?? null,
        createdBy: actor.id,
      })
      .returning();
    if (!row) throw new AppError(500, 'MEMORY_CREATE_FAILED', 'Could not record memory.');

    await record(tx, {
      actor,
      eventType: 'memory.recorded',
      context: { projectId: row.projectId, taskId: row.taskId },
      metadata: { scope: row.scope, key: row.key, confidence: parseConfidence(row.confidence) },
    });

    return toMemoryDto(row);
  });
}

/**
 * Everything Mac may legitimately consult while answering a question about
 * THIS task: global rules, this project's knowledge, and this task's own notes.
 *
 * Note what cannot appear in the result: another task's memory. The `taskId`
 * predicate is an equality, not a join through the project, so a sibling task's
 * assumptions are unreachable from here.
 */
export async function memoryForTask(
  params: { projectId: string; taskId: string },
  handle: DbHandle = db,
): Promise<MemoryEntryDto[]> {
  const rows = await handle
    .select()
    .from(memoryEntries)
    .where(
      or(
        and(eq(memoryEntries.scope, 'global'), isNull(memoryEntries.projectId)),
        and(eq(memoryEntries.scope, 'project'), eq(memoryEntries.projectId, params.projectId)),
        and(eq(memoryEntries.scope, 'task'), eq(memoryEntries.taskId, params.taskId)),
      ),
    )
    .orderBy(desc(memoryEntries.createdAt))
    .limit(500);

  return rows.map(toMemoryDto);
}

export async function listMemory(filter: { projectId?: string; taskId?: string; scope?: MemoryScope }): Promise<MemoryEntryDto[]> {
  const conditions = [];
  if (filter.projectId) conditions.push(eq(memoryEntries.projectId, filter.projectId));
  if (filter.taskId) conditions.push(eq(memoryEntries.taskId, filter.taskId));
  if (filter.scope) conditions.push(eq(memoryEntries.scope, filter.scope));

  const rows = await db
    .select()
    .from(memoryEntries)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(memoryEntries.createdAt))
    .limit(500);

  return rows.map(toMemoryDto);
}

/**
 * Promotes a validated task fact into project memory (spec §9).
 *
 * Refuses anything below the supplied threshold, because the spec is explicit:
 * "Assumptions should not become project facts unless validated." A promoted
 * entry is a NEW project-scoped row rather than a mutation of the task row, so
 * the task's own history stays intact and the promotion is visible.
 */
export async function promoteToProjectMemory(
  memoryId: string,
  params: { projectId: string; minConfidence: number },
  actor: Actor,
): Promise<MemoryEntryDto> {
  return db.transaction(async (tx) => {
    const [source] = await tx.select().from(memoryEntries).where(eq(memoryEntries.id, memoryId)).limit(1);
    if (!source) throw AppError.notFound('Memory entry');

    const confidence = parseConfidence(source.confidence) ?? 0;
    if (confidence < params.minConfidence) {
      throw AppError.conflict(
        'MEMORY_NOT_VALIDATED',
        `Memory "${source.key}" has confidence ${confidence} and cannot be promoted to project memory. ` +
          'Assumptions do not become project facts until they are validated.',
      );
    }

    const [row] = await tx
      .insert(memoryEntries)
      .values({
        scope: 'project',
        projectId: params.projectId,
        taskId: null,
        key: source.key,
        value: source.value,
        confidence: source.confidence,
        source: `promoted from task memory ${source.id}`,
        promoted: true,
        createdBy: actor.id,
      })
      .returning();
    if (!row) throw new AppError(500, 'MEMORY_PROMOTE_FAILED', 'Could not promote memory.');

    await record(tx, {
      actor,
      eventType: 'memory.promoted',
      context: { projectId: params.projectId, taskId: source.taskId },
      metadata: { key: row.key, fromMemoryId: source.id, confidence },
    });

    return toMemoryDto(row);
  });
}

/** Convenience for services that record a fact as a side effect of their work. */
export async function rememberInTransaction(
  tx: DbHandle,
  params: {
    scope: MemoryScope;
    projectId?: string | null;
    taskId?: string | null;
    key: string;
    value: string;
    confidence: number;
    source: string;
    actor: Actor;
  },
): Promise<void> {
  await tx.insert(memoryEntries).values({
    scope: params.scope,
    projectId: params.projectId ?? null,
    taskId: params.taskId ?? null,
    key: params.key,
    value: params.value.slice(0, 8000),
    confidence: params.confidence.toFixed(3),
    source: params.source,
    createdBy: params.actor.id,
  });

  await record(tx, {
    actor: params.actor,
    eventType: 'memory.recorded',
    context: { projectId: params.projectId ?? null, taskId: params.taskId ?? null },
    metadata: { scope: params.scope, key: params.key, confidence: params.confidence, source: params.source },
  });
}

/** Used by the dashboard and tests. */
export async function countMemory(): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(memoryEntries);
  return row?.count ?? 0;
}
