import { desc, eq, sql } from 'drizzle-orm';
import type { CreateProjectRequest, ProjectDto, UpdateProjectRequest } from '@mac/protocol';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import type { ProjectRow } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { record, type Actor } from './audit.js';

export const toProjectDto = (row: ProjectRow): ProjectDto => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  description: row.description,
  repoUrl: row.repoUrl,
  repoDefaultBranch: row.repoDefaultBranch,
  isActive: row.isActive,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'project';
}

/**
 * Repository references are stored, not fetched. Sprint 1 does not clone
 * anything, but validating the shape now means a later sprint inherits clean
 * data rather than a column full of typos and pasted UI fragments.
 */
function normaliseRepoUrl(input: string | undefined): string | null {
  if (input === undefined) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const looksLikeUrl = /^https?:\/\/\S+$/i.test(trimmed);
  const looksLikeScp = /^[\w.-]+@[\w.-]+:\S+$/.test(trimmed); // git@github.com:org/repo.git
  if (!looksLikeUrl && !looksLikeScp) {
    throw AppError.badRequest(
      'INVALID_REPO_URL',
      'Repository reference must be an http(s) URL or an SSH reference such as git@github.com:org/repo.git.',
    );
  }
  return trimmed;
}

export async function listProjects(includeInactive = true): Promise<ProjectDto[]> {
  const rows = await db
    .select()
    .from(projects)
    .where(includeInactive ? undefined : eq(projects.isActive, true))
    .orderBy(desc(projects.createdAt));
  return rows.map(toProjectDto);
}

export async function getProject(id: string): Promise<ProjectDto> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!row) throw AppError.notFound('Project');
  return toProjectDto(row);
}

export async function createProject(input: CreateProjectRequest, actor: Actor): Promise<ProjectDto> {
  const name = input.name.trim();
  if (!name) throw AppError.badRequest('INVALID_NAME', 'Project name cannot be blank.');
  const repoUrl = normaliseRepoUrl(input.repoUrl);

  return db.transaction(async (tx) => {
    // Slug collisions are resolved by suffixing rather than rejecting, so a
    // second "Forger" project does not fail with an opaque conflict.
    const base = slugify(name);
    const [existing] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(projects)
      .where(sql`${projects.slug} = ${base} OR ${projects.slug} LIKE ${base + '-%'}`);
    const count = existing?.count ?? 0;
    const slug = count > 0 ? `${base}-${count + 1}` : base;

    const [row] = await tx
      .insert(projects)
      .values({
        name,
        slug,
        description: input.description?.trim() || null,
        repoUrl,
        repoDefaultBranch: input.repoDefaultBranch?.trim() || 'main',
        createdBy: actor.id,
      })
      .returning();
    if (!row) throw new AppError(500, 'PROJECT_CREATE_FAILED', 'Could not create project.');

    await record(tx, {
      actor,
      eventType: 'project.created',
      context: { projectId: row.id },
      metadata: { name: row.name, slug: row.slug, repoUrl: row.repoUrl },
    });

    return toProjectDto(row);
  });
}

export async function updateProject(
  id: string,
  patch: UpdateProjectRequest,
  actor: Actor,
): Promise<ProjectDto> {
  const repoUrl = patch.repoUrl !== undefined ? normaliseRepoUrl(patch.repoUrl) : undefined;

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!before) throw AppError.notFound('Project');

    const [row] = await tx
      .update(projects)
      .set({
        ...(patch.name !== undefined && { name: patch.name.trim() }),
        ...(patch.description !== undefined && { description: patch.description.trim() || null }),
        ...(repoUrl !== undefined && { repoUrl }),
        ...(patch.repoDefaultBranch !== undefined && { repoDefaultBranch: patch.repoDefaultBranch.trim() || 'main' }),
        ...(patch.isActive !== undefined && { isActive: patch.isActive }),
        updatedAt: new Date(),
      })
      .where(eq(projects.id, id))
      .returning();
    if (!row) throw AppError.notFound('Project');

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of ['name', 'description', 'repoUrl', 'repoDefaultBranch', 'isActive'] as const) {
      if (before[key] !== row[key]) changes[key] = { from: before[key], to: row[key] };
    }

    await record(tx, {
      actor,
      eventType: 'project.updated',
      context: { projectId: id },
      metadata: { changes },
    });

    return toProjectDto(row);
  });
}
