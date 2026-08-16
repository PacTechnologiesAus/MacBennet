import { and, desc, eq, sql } from 'drizzle-orm';
import {
  DEFAULT_MONDAY_STATUS_LABELS,
  mondayStatusLabelsSchema,
  type CreateMondayBoardRequest,
  type MondayBoardDto,
  type MondayItemDto,
  type MondayStatusLabels,
  type UpdateMondayBoardRequest,
} from '@mac/protocol';
import { db, type DbHandle } from '../../db/client.js';
import { mondayBoards, mondayItems, projects } from '../../db/schema.js';
import type { MondayBoardRow, MondayItemRow } from '../../db/schema.js';
import { AppError } from '../../http/errors.js';
import { record, type Actor } from '../audit.js';

/**
 * Board mapping and approval (Sprint 3 §5.3).
 *
 * Two gates guard autonomous work selection, and this file owns one of them:
 * a board must be MAPPED to a project and separately APPROVED before Mac may
 * read work from it. `projects.night_shift_approved` is the other.
 *
 * Both must be open. That is deliberately more ceremony than one flag: mapping
 * a board is a technical act (which column is status?) and approving it is a
 * decision about whether a machine may take work from it, and collapsing the
 * two would mean configuring the integration silently authorised it.
 *
 * Note also what this scoping buys: Mac reads only from boards in this table,
 * so he cannot roam every board the connected account can see. The restriction
 * is in the query, not in the token's permissions.
 */

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

export const toMondayBoardDto = (
  row: MondayBoardRow,
  extra: { projectName: string; itemCount: number },
): MondayBoardDto => ({
  id: row.id,
  projectId: row.projectId,
  projectName: extra.projectName,
  boardId: row.boardId,
  name: row.name,
  groupIds: asStrings(row.groupIds),
  statusColumnId: row.statusColumnId,
  assigneeColumnId: row.assigneeColumnId,
  priorityColumnId: row.priorityColumnId,
  dueDateColumnId: row.dueDateColumnId,
  pullRequestColumnId: row.pullRequestColumnId,
  dependencyColumnId: row.dependencyColumnId,
  nightShiftFlagColumnId: row.nightShiftFlagColumnId,
  itemTypeColumnId: row.itemTypeColumnId,
  sizeColumnId: row.sizeColumnId,
  statusLabels: mondayStatusLabelsSchema.parse(row.statusLabels),
  startableStatuses: asStrings(row.startableStatuses),
  completedStatuses: asStrings(row.completedStatuses),
  allowedItemTypes: asStrings(row.allowedItemTypes),
  mayComplete: row.mayComplete,
  nightShiftEligible: row.nightShiftEligible,
  requireItemFlag: row.requireItemFlag,
  macUserId: row.macUserId,
  isApproved: row.isApproved,
  approvedAt: row.approvedAt?.toISOString() ?? null,
  lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
  itemCount: extra.itemCount,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const toMondayItemDto = (row: MondayItemRow): MondayItemDto => ({
  id: row.id,
  boardRowId: row.boardRowId,
  projectId: row.projectId,
  taskId: row.taskId,
  itemId: row.itemId,
  name: row.name,
  url: row.url,
  status: row.status,
  priority: row.priority,
  assigneeIds: asStrings(row.assigneeIds),
  dueDate: row.dueDate,
  description: row.description,
  dependsOn: asStrings(row.dependsOn),
  nightShiftFlag: row.nightShiftFlag,
  itemType: row.itemType,
  sizeLabel: row.sizeLabel,
  lastSyncedAt: row.lastSyncedAt.toISOString(),
});

export async function requireBoardRow(id: string, handle: DbHandle = db): Promise<MondayBoardRow> {
  const [row] = await handle.select().from(mondayBoards).where(eq(mondayBoards.id, id)).limit(1);
  if (!row) throw AppError.notFound('monday board mapping');
  return row;
}

export async function boardForProject(projectId: string, handle: DbHandle = db): Promise<MondayBoardRow | null> {
  const [row] = await handle.select().from(mondayBoards).where(eq(mondayBoards.projectId, projectId)).limit(1);
  return row ?? null;
}

export async function boardByMondayId(boardId: string, handle: DbHandle = db): Promise<MondayBoardRow | null> {
  const [row] = await handle.select().from(mondayBoards).where(eq(mondayBoards.boardId, boardId)).limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

export async function createMondayBoard(input: CreateMondayBoardRequest, actor: Actor): Promise<MondayBoardDto> {
  return db.transaction(async (tx) => {
    const [project] = await tx.select().from(projects).where(eq(projects.id, input.projectId)).limit(1);
    if (!project) throw AppError.notFound('Project');

    const labels: MondayStatusLabels = mondayStatusLabelsSchema.parse(
      input.statusLabels ?? DEFAULT_MONDAY_STATUS_LABELS,
    );

    const [row] = await tx
      .insert(mondayBoards)
      .values({
        projectId: input.projectId,
        boardId: input.boardId,
        name: input.name,
        groupIds: input.groupIds,
        statusColumnId: input.statusColumnId,
        assigneeColumnId: input.assigneeColumnId,
        priorityColumnId: input.priorityColumnId,
        dueDateColumnId: input.dueDateColumnId,
        pullRequestColumnId: input.pullRequestColumnId,
        dependencyColumnId: input.dependencyColumnId,
        nightShiftFlagColumnId: input.nightShiftFlagColumnId,
        itemTypeColumnId: input.itemTypeColumnId,
        sizeColumnId: input.sizeColumnId,
        statusLabels: labels,
        startableStatuses: input.startableStatuses,
        completedStatuses: input.completedStatuses,
        allowedItemTypes: input.allowedItemTypes,
        mayComplete: input.mayComplete,
        nightShiftEligible: input.nightShiftEligible,
        requireItemFlag: input.requireItemFlag,
        macUserId: input.macUserId,
        // Never approved at creation. Approval is a separate, audited act.
        isApproved: false,
        createdBy: actor.id,
      })
      .returning();
    if (!row) throw new AppError(500, 'MONDAY_BOARD_CREATE_FAILED', 'Could not map the board.');

    await record(tx, {
      actor,
      eventType: 'monday.board_mapped',
      context: { projectId: input.projectId },
      metadata: {
        boardId: row.boardId,
        name: row.name,
        statusColumnId: row.statusColumnId,
        mayComplete: row.mayComplete,
        requireItemFlag: row.requireItemFlag,
      },
    });

    return toMondayBoardDto(row, { projectName: project.name, itemCount: 0 });
  });
}

export async function updateMondayBoard(
  id: string,
  patch: UpdateMondayBoardRequest,
  actor: Actor,
): Promise<MondayBoardDto> {
  return db.transaction(async (tx) => {
    const existing = await requireBoardRow(id, tx);

    const [row] = await tx
      .update(mondayBoards)
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.groupIds !== undefined && { groupIds: patch.groupIds }),
        ...(patch.statusColumnId !== undefined && { statusColumnId: patch.statusColumnId }),
        ...(patch.assigneeColumnId !== undefined && { assigneeColumnId: patch.assigneeColumnId }),
        ...(patch.priorityColumnId !== undefined && { priorityColumnId: patch.priorityColumnId }),
        ...(patch.dueDateColumnId !== undefined && { dueDateColumnId: patch.dueDateColumnId }),
        ...(patch.pullRequestColumnId !== undefined && { pullRequestColumnId: patch.pullRequestColumnId }),
        ...(patch.dependencyColumnId !== undefined && { dependencyColumnId: patch.dependencyColumnId }),
        ...(patch.nightShiftFlagColumnId !== undefined && { nightShiftFlagColumnId: patch.nightShiftFlagColumnId }),
        ...(patch.itemTypeColumnId !== undefined && { itemTypeColumnId: patch.itemTypeColumnId }),
        ...(patch.sizeColumnId !== undefined && { sizeColumnId: patch.sizeColumnId }),
        ...(patch.statusLabels !== undefined && { statusLabels: mondayStatusLabelsSchema.parse(patch.statusLabels) }),
        ...(patch.startableStatuses !== undefined && { startableStatuses: patch.startableStatuses }),
        ...(patch.completedStatuses !== undefined && { completedStatuses: patch.completedStatuses }),
        ...(patch.allowedItemTypes !== undefined && { allowedItemTypes: patch.allowedItemTypes }),
        ...(patch.mayComplete !== undefined && { mayComplete: patch.mayComplete }),
        ...(patch.nightShiftEligible !== undefined && { nightShiftEligible: patch.nightShiftEligible }),
        ...(patch.requireItemFlag !== undefined && { requireItemFlag: patch.requireItemFlag }),
        ...(patch.macUserId !== undefined && { macUserId: patch.macUserId }),
        updatedAt: new Date(),
      })
      .where(eq(mondayBoards.id, id))
      .returning();
    if (!row) throw AppError.notFound('monday board mapping');

    await record(tx, {
      actor,
      eventType: 'monday.board_mapped',
      context: { projectId: existing.projectId },
      metadata: { boardId: row.boardId, changed: Object.keys(patch) },
    });

    const [project] = await tx.select().from(projects).where(eq(projects.id, row.projectId)).limit(1);
    return toMondayBoardDto(row, { projectName: project?.name ?? '', itemCount: await countItems(row.id, tx) });
  });
}

/**
 * Approval, as a separate act from mapping.
 *
 * Follows `repositories.is_approved` exactly, including the important part:
 * REVOKING it stops future work without any call site remembering to check,
 * because eligibility reads this column.
 */
export async function approveMondayBoard(
  id: string,
  input: { approved: boolean; notes?: string },
  actor: Actor,
): Promise<MondayBoardDto> {
  return db.transaction(async (tx) => {
    const existing = await requireBoardRow(id, tx);

    const [row] = await tx
      .update(mondayBoards)
      .set({
        isApproved: input.approved,
        approvedBy: input.approved ? actor.id : null,
        approvedAt: input.approved ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(mondayBoards.id, id))
      .returning();
    if (!row) throw AppError.notFound('monday board mapping');

    await record(tx, {
      actor,
      eventType: input.approved ? 'monday.board_approved' : 'monday.board_approval_revoked',
      context: { projectId: existing.projectId },
      metadata: { boardId: row.boardId, name: row.name, notes: input.notes ?? null },
    });

    const [project] = await tx.select().from(projects).where(eq(projects.id, row.projectId)).limit(1);
    return toMondayBoardDto(row, { projectName: project?.name ?? '', itemCount: await countItems(row.id, tx) });
  });
}

// ---------------------------------------------------------------------------
// Project night-shift approval — the second gate
// ---------------------------------------------------------------------------

export async function approveProjectForNightShift(
  projectId: string,
  input: { approved: boolean; notes?: string },
  actor: Actor,
): Promise<{ projectId: string; approved: boolean }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(projects)
      .set({
        nightShiftApproved: input.approved,
        nightShiftApprovedBy: input.approved ? actor.id : null,
        nightShiftApprovedAt: input.approved ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId))
      .returning();
    if (!row) throw AppError.notFound('Project');

    await record(tx, {
      actor,
      eventType: input.approved ? 'project.night_shift_approved' : 'project.night_shift_approval_revoked',
      context: { projectId },
      metadata: { name: row.name, notes: input.notes ?? null },
    });

    return { projectId, approved: input.approved };
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

async function countItems(boardRowId: string, handle: DbHandle = db): Promise<number> {
  const [row] = await handle
    .select({ count: sql<number>`count(*)::int` })
    .from(mondayItems)
    .where(eq(mondayItems.boardRowId, boardRowId));
  return row?.count ?? 0;
}

export async function listMondayBoards(): Promise<MondayBoardDto[]> {
  const rows = await db
    .select({ board: mondayBoards, projectName: projects.name })
    .from(mondayBoards)
    .innerJoin(projects, eq(projects.id, mondayBoards.projectId))
    .orderBy(desc(mondayBoards.createdAt));

  return Promise.all(
    rows.map(async (r) =>
      toMondayBoardDto(r.board, { projectName: r.projectName, itemCount: await countItems(r.board.id) }),
    ),
  );
}

export async function getMondayBoard(id: string): Promise<MondayBoardDto> {
  const row = await requireBoardRow(id);
  const [project] = await db.select().from(projects).where(eq(projects.id, row.projectId)).limit(1);
  return toMondayBoardDto(row, { projectName: project?.name ?? '', itemCount: await countItems(row.id) });
}

export async function listMondayItems(filter: { projectId?: string; boardRowId?: string } = {}): Promise<MondayItemDto[]> {
  const conditions = [];
  if (filter.projectId) conditions.push(eq(mondayItems.projectId, filter.projectId));
  if (filter.boardRowId) conditions.push(eq(mondayItems.boardRowId, filter.boardRowId));

  const rows = await db
    .select()
    .from(mondayItems)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(mondayItems.lastSyncedAt))
    .limit(500);

  return rows.map(toMondayItemDto);
}

/**
 * Boards Mac may take autonomous work from RIGHT NOW.
 *
 * Both gates in one predicate, so no caller can accidentally check only one.
 */
export async function nightEligibleBoards(handle: DbHandle = db): Promise<Array<{ board: MondayBoardRow; projectName: string }>> {
  const rows = await handle
    .select({ board: mondayBoards, projectName: projects.name })
    .from(mondayBoards)
    .innerJoin(projects, eq(projects.id, mondayBoards.projectId))
    .where(
      and(
        eq(mondayBoards.isApproved, true),
        eq(mondayBoards.nightShiftEligible, true),
        eq(projects.nightShiftApproved, true),
        eq(projects.isActive, true),
      ),
    );
  return rows;
}
