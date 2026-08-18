import { and, desc, eq, sql } from 'drizzle-orm';
import {
  artefactContentSchema,
  capFindingConfidence,
  shortSha,
  type ArtefactContent,
  type ArtefactDto,
  type ArtefactFormat,
  type ArtefactType,
  type Finding,
} from '@mac/protocol';
import { db, type DbHandle } from '../db/client.js';
import { companyContextRevisions, runArtefacts, runs, tasks } from '../db/schema.js';
import type { RunArtefactRow } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { record, type Actor } from './audit.js';

/**
 * Artefacts — the results of work that is not code (Sprint 3.3 §17).
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES THIS DIFFERENT FROM "SAVING A MARKDOWN FILE"
 *
 * Three things, and each is here because of a specific way an autonomous
 * researcher's output goes wrong:
 *
 *   1. FINDINGS ARE CAPPED ON THE WAY IN. `capFindingConfidence` runs at
 *      persistence, not at display, so there is no path that stores a
 *      0.95-confidence inference and no reader who can be misled by one.
 *
 *   2. PROVENANCE IS PINNED. The company-context revision is taken from the RUN,
 *      not from whatever is active now, and a database trigger refuses to move
 *      it afterwards. A document a human read last Tuesday still says which PAC
 *      policy governed it.
 *
 *   3. COST TRAVELS WITH THE RESULT. A recommendation that cost eleven model
 *      calls is a different object from one that cost two, and an operator
 *      reconciling a budget should not have to join four tables to find out.
 * ---------------------------------------------------------------------------
 */

export const toArtefactDto = (
  row: RunArtefactRow,
  companyContext: { revisionId: string; commitSha: string; shortSha: string } | null = null,
): ArtefactDto => ({
  id: row.id,
  runId: row.runId,
  taskId: row.taskId,
  projectId: row.projectId,
  type: row.artefactType as ArtefactType,
  title: row.title,
  format: row.format as ArtefactFormat,
  summary: row.summary,
  body: row.body,
  findings: (row.findings as Finding[]) ?? [],
  companyContext,
  usage: row.modelProvider
    ? {
        provider: row.modelProvider,
        model: row.modelName,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
      }
    : null,
  createdAt: row.createdAt.toISOString(),
});

export interface CreateArtefactInput {
  taskId: string;
  runId?: string | null;
  content: ArtefactContent;
  usage?: {
    provider: string;
    model: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
  } | null;
  /**
   * Explicit, and taken from the run rather than resolved here.
   *
   * Sprint 3.2's rule, applied to a new artefact type: a company commit that
   * lands mid-run must not appear to have governed a result produced before it
   * existed.
   */
  companyContextRevisionId?: string | null;
}

export async function createArtefact(
  input: CreateArtefactInput,
  actor: Actor,
  handle?: DbHandle,
): Promise<ArtefactDto> {
  const run = async (tx: DbHandle): Promise<ArtefactDto> => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId)).limit(1);
    if (!task) throw AppError.notFound('Task');

    const content = artefactContentSchema.parse(input.content);

    /*
     * Every finding is re-capped here even though the research domain already
     * capped them.
     *
     * Not redundancy for its own sake: this function is also reachable from the
     * HTTP layer, where the caller is a person or a worker rather than the
     * research loop, and a cap applied only inside the loop would be a cap the
     * API route does not have.
     */
    const findings = content.findings.map(capFindingConfidence);

    const revisionId = input.companyContextRevisionId ?? (await revisionForRun(tx, input.runId ?? null));

    const [row] = await tx
      .insert(runArtefacts)
      .values({
        runId: input.runId ?? null,
        taskId: input.taskId,
        projectId: task.projectId,
        artefactType: content.type,
        title: content.title,
        format: content.format,
        summary: content.summary,
        body: content.body,
        findings,
        companyContextRevisionId: revisionId,
        modelProvider: input.usage?.provider ?? null,
        modelName: input.usage?.model ?? null,
        inputTokens: input.usage?.inputTokens ?? null,
        outputTokens: input.usage?.outputTokens ?? null,
        createdBy: actor.type === 'user' ? actor.id : null,
      })
      .returning();
    if (!row) throw new AppError(500, 'ARTEFACT_CREATE_FAILED', 'Could not store the artefact.');

    await record(tx, {
      actor,
      eventType: 'artefact.created',
      context: { taskId: input.taskId, projectId: task.projectId, runId: input.runId ?? null },
      metadata: {
        artefactId: row.id,
        type: content.type,
        title: content.title,
        bodyChars: content.body.length,
        findings: findings.length,
        // The two counts worth watching: how much of this is established, and
        // how much is Mac's own reasoning presented alongside it.
        establishedFindings: findings.filter((f) =>
          ['pac_fact', 'project_fact', 'external_fact', 'user_approved_decision'].includes(f.evidenceClass),
        ).length,
        sourcesCited: new Set(findings.flatMap((f) => f.sources)).size,
        companyContextRevisionId: revisionId,
      },
    });

    return toArtefactDto(row, await contextRef(tx, revisionId));
  };

  return handle ? run(handle) : db.transaction(run);
}

async function revisionForRun(handle: DbHandle, runId: string | null): Promise<string | null> {
  if (!runId) return null;
  const [row] = await handle
    .select({ revisionId: runs.companyContextRevisionId })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  return row?.revisionId ?? null;
}

async function contextRef(
  handle: DbHandle,
  revisionId: string | null,
): Promise<{ revisionId: string; commitSha: string; shortSha: string } | null> {
  if (!revisionId) return null;
  const [row] = await handle
    .select({ id: companyContextRevisions.id, commitSha: companyContextRevisions.commitSha })
    .from(companyContextRevisions)
    .where(eq(companyContextRevisions.id, revisionId))
    .limit(1);
  return row ? { revisionId: row.id, commitSha: row.commitSha, shortSha: shortSha(row.commitSha) } : null;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listArtefacts(
  filter: { taskId?: string; runId?: string; projectId?: string },
  handle: DbHandle = db,
): Promise<ArtefactDto[]> {
  const conditions = [];
  if (filter.taskId) conditions.push(eq(runArtefacts.taskId, filter.taskId));
  if (filter.runId) conditions.push(eq(runArtefacts.runId, filter.runId));
  if (filter.projectId) conditions.push(eq(runArtefacts.projectId, filter.projectId));

  const rows = await handle
    .select()
    .from(runArtefacts)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(runArtefacts.createdAt))
    .limit(200);

  // One lookup per distinct revision rather than per artefact: a run's worth of
  // artefacts all share a revision, and N+1 on a list view is a real cost.
  const revisionIds = Array.from(new Set(rows.map((r) => r.companyContextRevisionId).filter(Boolean))) as string[];
  const refs = new Map<string, { revisionId: string; commitSha: string; shortSha: string }>();
  for (const id of revisionIds) {
    const ref = await contextRef(handle, id);
    if (ref) refs.set(id, ref);
  }

  return rows.map((row) => toArtefactDto(row, row.companyContextRevisionId ? refs.get(row.companyContextRevisionId) ?? null : null));
}

export async function getArtefact(id: string, handle: DbHandle = db): Promise<ArtefactDto> {
  const [row] = await handle.select().from(runArtefacts).where(eq(runArtefacts.id, id)).limit(1);
  if (!row) throw AppError.notFound('Artefact');
  return toArtefactDto(row, await contextRef(handle, row.companyContextRevisionId));
}

export async function countArtefactsForTask(taskId: string, handle: DbHandle = db): Promise<number> {
  const [row] = await handle
    .select({ count: sql<number>`count(*)::int` })
    .from(runArtefacts)
    .where(eq(runArtefacts.taskId, taskId));
  return row?.count ?? 0;
}
