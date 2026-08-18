import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  ApproveRepositoryRequest,
  CreateRepositoryRequest,
  RepositoryDto,
  UpdateRepositoryRequest,
  WorktreeDto,
  WorktreeStatus,
} from '@mac/protocol';
import { db, type DbHandle } from '../db/client.js';
import { projects, repositories, worktrees } from '../db/schema.js';
import type { RepositoryRow, WorktreeRow } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { record, type Actor } from './audit.js';

/**
 * Approved repositories (Sprint 2 §1).
 *
 * `isApproved` is the gate for every repository operation. It is checked in
 * three places for the same reason Sprint 1 checks the job allowlist three
 * times: at run creation, in the dispatch SQL predicate, and again when the
 * assignment is built. Withdrawing approval therefore stops future dispatch
 * without any application code having to remember to look.
 */

export const toWorktreeDto = (row: WorktreeRow): WorktreeDto => ({
  id: row.id,
  runId: row.runId,
  repositoryId: row.repositoryId,
  path: row.path,
  branch: row.branch,
  baseBranch: row.baseBranch,
  baseSha: row.baseSha,
  headSha: row.headSha,
  commitCount: row.commitCount,
  status: row.status as WorktreeStatus,
  createdAt: row.createdAt.toISOString(),
  releasedAt: row.releasedAt?.toISOString() ?? null,
  removedAt: row.removedAt?.toISOString() ?? null,
});

const asArgv = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

export const toRepositoryDto = (row: RepositoryRow, activeWorktrees: WorktreeRow[] = []): RepositoryDto => ({
  id: row.id,
  projectId: row.projectId,
  name: row.name,
  remoteUrl: row.remoteUrl,
  localPath: row.localPath,
  defaultBranch: row.defaultBranch,
  remoteName: row.remoteName,
  isApproved: row.isApproved,
  approvedBy: row.approvedBy,
  approvedAt: row.approvedAt?.toISOString() ?? null,
  lastFetchedAt: row.lastFetchedAt?.toISOString() ?? null,
  lastKnownDefaultSha: row.lastKnownDefaultSha,
  testCommand: asArgv(row.testCommand),
  buildCommand: asArgv(row.buildCommand),
  activeWorktrees: activeWorktrees.map(toWorktreeDto),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export async function listRepositories(filter: { projectId?: string } = {}): Promise<RepositoryDto[]> {
  const rows = await db
    .select()
    .from(repositories)
    .where(filter.projectId ? eq(repositories.projectId, filter.projectId) : undefined)
    .orderBy(desc(repositories.createdAt));

  if (rows.length === 0) return [];

  // Worktrees Mac still holds. `removed` ones are history, not state.
  const trees = await db
    .select()
    .from(worktrees)
    .where(
      and(
        inArray(worktrees.repositoryId, rows.map((r) => r.id)),
        inArray(worktrees.status, ['active', 'preserved']),
      ),
    );

  return rows.map((row) => toRepositoryDto(row, trees.filter((t) => t.repositoryId === row.id)));
}

export async function getRepository(id: string, handle: DbHandle = db): Promise<RepositoryDto> {
  const row = await requireRepositoryRow(id, handle);
  const trees = await handle
    .select()
    .from(worktrees)
    .where(and(eq(worktrees.repositoryId, id), inArray(worktrees.status, ['active', 'preserved'])));
  return toRepositoryDto(row, trees);
}

export async function requireRepositoryRow(id: string, handle: DbHandle = db): Promise<RepositoryRow> {
  const [row] = await handle.select().from(repositories).where(eq(repositories.id, id)).limit(1);
  if (!row) throw AppError.notFound('Repository');
  return row;
}

/**
 * The approval check, in one place so it reads the same everywhere it is used.
 * Sprint 2 §1: "Mac must operate only on approved repositories."
 */
export function assertRepositoryApproved(row: RepositoryRow): void {
  if (!row.isApproved) {
    throw AppError.conflict(
      'REPOSITORY_NOT_APPROVED',
      `Repository "${row.name}" is not approved for Mac to work in. An administrator must approve it first.`,
    );
  }
}

export async function createRepository(input: CreateRepositoryRequest, actor: Actor): Promise<RepositoryDto> {
  return db.transaction(async (tx) => {
    const [project] = await tx.select().from(projects).where(eq(projects.id, input.projectId)).limit(1);
    if (!project) throw AppError.notFound('Project');

    const [row] = await tx
      .insert(repositories)
      .values({
        projectId: input.projectId,
        name: input.name,
        remoteUrl: input.remoteUrl,
        localPath: input.localPath,
        defaultBranch: input.defaultBranch,
        remoteName: input.remoteName,
        testCommand: input.testCommand,
        buildCommand: input.buildCommand,
        // A repository is NEVER approved at creation. Approval is a separate,
        // deliberate, admin-only act with its own audit event.
        isApproved: false,
        createdBy: actor.id,
      })
      .returning();
    if (!row) throw new AppError(500, 'REPOSITORY_CREATE_FAILED', 'Could not create repository.');

    await record(tx, {
      actor,
      eventType: 'repository.created',
      context: { projectId: input.projectId },
      metadata: {
        repositoryId: row.id,
        name: row.name,
        remoteUrl: row.remoteUrl,
        defaultBranch: row.defaultBranch,
        localPath: row.localPath,
      },
    });

    return toRepositoryDto(row);
  });
}

export async function updateRepository(
  id: string,
  patch: UpdateRepositoryRequest,
  actor: Actor,
): Promise<RepositoryDto> {
  return db.transaction(async (tx) => {
    const before = await requireRepositoryRow(id, tx);

    const [row] = await tx
      .update(repositories)
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.remoteUrl !== undefined && { remoteUrl: patch.remoteUrl }),
        ...(patch.localPath !== undefined && { localPath: patch.localPath }),
        ...(patch.defaultBranch !== undefined && { defaultBranch: patch.defaultBranch }),
        ...(patch.remoteName !== undefined && { remoteName: patch.remoteName }),
        ...(patch.testCommand !== undefined && { testCommand: patch.testCommand }),
        ...(patch.buildCommand !== undefined && { buildCommand: patch.buildCommand }),
        updatedAt: new Date(),
      })
      .where(eq(repositories.id, id))
      .returning();
    if (!row) throw AppError.notFound('Repository');

    /*
     * Changing the test or build command changes what the worker executes, so
     * it is recorded with both the old and new argv. This is the single place a
     * project-specific command can enter the system, and the audit trail is how
     * that stays reviewable.
     */
    await record(tx, {
      actor,
      eventType: 'repository.updated',
      context: { projectId: row.projectId },
      metadata: {
        repositoryId: row.id,
        changed: Object.keys(patch),
        ...(patch.testCommand !== undefined
          ? { testCommand: { from: asArgv(before.testCommand), to: asArgv(row.testCommand) } }
          : {}),
        ...(patch.buildCommand !== undefined
          ? { buildCommand: { from: asArgv(before.buildCommand), to: asArgv(row.buildCommand) } }
          : {}),
        ...(patch.defaultBranch !== undefined
          ? { defaultBranch: { from: before.defaultBranch, to: row.defaultBranch } }
          : {}),
      },
    });

    return toRepositoryDto(row);
  });
}

export async function setRepositoryApproval(
  id: string,
  input: ApproveRepositoryRequest,
  actor: Actor,
): Promise<RepositoryDto> {
  return db.transaction(async (tx) => {
    const before = await requireRepositoryRow(id, tx);

    const [row] = await tx
      .update(repositories)
      .set({
        isApproved: input.approved,
        approvedBy: input.approved ? actor.id : null,
        approvedAt: input.approved ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(repositories.id, id))
      .returning();
    if (!row) throw AppError.notFound('Repository');

    await record(tx, {
      actor,
      eventType: input.approved ? 'repository.approved' : 'repository.approval_revoked',
      context: { projectId: row.projectId },
      metadata: {
        repositoryId: row.id,
        name: row.name,
        previouslyApproved: before.isApproved,
        notes: input.notes ?? null,
      },
    });

    return toRepositoryDto(row);
  });
}

/** Called by the worker after a fetch, so the UI can show repository freshness. */
export async function recordFetch(
  repositoryId: string,
  defaultSha: string,
  handle: DbHandle = db,
): Promise<void> {
  await handle
    .update(repositories)
    .set({ lastFetchedAt: new Date(), lastKnownDefaultSha: defaultSha, updatedAt: new Date() })
    .where(eq(repositories.id, repositoryId));
}
