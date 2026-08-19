import { and, eq, sql } from 'drizzle-orm';
import {
  isPrimarySource,
  MAX_SOURCE_EXCERPT_CHARS,
  SOURCE_CLASSES,
  type ResearchSource,
  type ResearchSourceDto,
  type ResearchToolResult,
  type SourceClass,
} from '@mac/protocol';
import { db, type DbHandle } from '../../db/client.js';
import { researchSources } from '../../db/schema.js';
import { record, SYSTEM_ACTOR, type Actor } from '../audit.js';
import { scanForInjection } from '../../domain/injection.js';

/**
 * Research provenance, persisted (Phase 4 Part E §17).
 *
 * ---------------------------------------------------------------------------
 * WHY A TABLE RATHER THAN THE RUN-STATE BLOB
 *
 * Part F §23 requires that a run which used no external sources cannot be
 * marked fully complete when its brief asked for external research. That is a
 * question a predicate should be able to answer:
 *
 *   SELECT count(*) FROM research_sources WHERE run_id = $1 AND external
 *
 * It cannot be answered about a JSON document inside another column without
 * parsing the document — which means the check would live in application code
 * that could be skipped, rather than in a query the acceptance review runs
 * unconditionally.
 *
 * The blob stays too. It is what the model is shown between steps, and it is
 * bounded and shaped for that. This is the record.
 * ---------------------------------------------------------------------------
 */

const asSourceClass = (value: string): SourceClass =>
  (SOURCE_CLASSES as readonly string[]).includes(value) ? (value as SourceClass) : 'unknown';

/**
 * Records the sources one tool call produced.
 *
 * `onConflictDoNothing` against `(run_id, ref)`: the same document retrieved
 * twice in one run is one source with one retrieval timestamp, not two. A run
 * that re-fetched a page after a failed step should not read, afterwards, as a
 * run that found twice as much.
 */
export async function persistToolSources(
  input: { runId: string; taskId: string; result: ResearchToolResult },
  actor: Actor = SYSTEM_ACTOR,
  handle: DbHandle = db,
): Promise<void> {
  if (!input.result.performed || input.result.sources.length === 0) return;

  const rows = input.result.sources.map((source) => ({
    runId: input.runId,
    taskId: input.taskId,
    query: input.result.argument.slice(0, 1000),
    tool: input.result.tool,
    ref: source.ref.slice(0, 500),
    url: source.url ?? (source.external ? source.ref.slice(0, 2000) : null),
    title: (source.label || source.ref).slice(0, 500),
    sourceClass: asSourceClass(source.sourceClass),
    external: source.external,
    excerpt: source.excerpt.slice(0, MAX_SOURCE_EXCERPT_CHARS),
    publishedAt: source.publishedAt,
    retrievedAt: new Date(source.retrievedAt),
    injectionSuspected: source.injectionSuspected,
    injectionDetail: source.injectionSuspected ? scanForInjection(source.excerpt).summary : null,
  }));

  await handle.insert(researchSources).values(rows).onConflictDoNothing();

  /*
   * An injection match is audited SEPARATELY from the retrieval.
   *
   * It is an operational signal about a source — somebody published a page
   * addressed to an AI system — and it belongs where a security reviewer
   * looks, not only in a column on a research table nobody greps.
   */
  for (const source of input.result.sources.filter((s) => s.injectionSuspected)) {
    const scan = scanForInjection(source.excerpt);
    await record(handle, {
      actor,
      eventType: 'research.injection_suspected',
      context: { runId: input.runId, taskId: input.taskId },
      metadata: {
        ref: source.ref.slice(0, 500),
        tool: input.result.tool,
        shapes: scan.findings.map((f) => f.kind),
        // The matched span, so a reviewer can see what triggered it without
        // going and fetching the page themselves.
        excerpt: scan.findings[0]?.excerpt ?? null,
        // Stated in the event, because "we flagged it" reads like "we blocked
        // it" and it deliberately is not that.
        action: 'content kept and flagged; Mac cannot act on instructions in retrieved text',
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface SourceTally {
  total: number;
  external: number;
  primary: number;
  injectionSuspected: number;
  byClass: Record<string, number>;
}

/** The counts acceptance verification checks against. One query. */
export async function tallySources(runId: string, handle: DbHandle = db): Promise<SourceTally> {
  const rows = await handle
    .select({
      sourceClass: researchSources.sourceClass,
      external: researchSources.external,
      injectionSuspected: researchSources.injectionSuspected,
      count: sql<number>`COUNT(*)`,
    })
    .from(researchSources)
    .where(eq(researchSources.runId, runId))
    .groupBy(researchSources.sourceClass, researchSources.external, researchSources.injectionSuspected);

  const tally: SourceTally = { total: 0, external: 0, primary: 0, injectionSuspected: 0, byClass: {} };

  for (const row of rows) {
    const n = Number(row.count);
    tally.total += n;
    if (row.external) tally.external += n;
    if (row.injectionSuspected) tally.injectionSuspected += n;
    if (isPrimarySource(asSourceClass(row.sourceClass))) tally.primary += n;
    tally.byClass[row.sourceClass] = (tally.byClass[row.sourceClass] ?? 0) + n;
  }

  return tally;
}

/** The class and externality of every source, for the acceptance evaluator. */
export async function sourceClassesFor(
  runId: string,
  handle: DbHandle = db,
): Promise<Array<{ sourceClass: SourceClass; external: boolean }>> {
  const rows = await handle
    .select({ sourceClass: researchSources.sourceClass, external: researchSources.external })
    .from(researchSources)
    .where(eq(researchSources.runId, runId));

  return rows.map((row) => ({ sourceClass: asSourceClass(row.sourceClass), external: row.external }));
}

export async function listResearchSources(
  filter: { runId?: string; taskId?: string; externalOnly?: boolean },
  handle: DbHandle = db,
): Promise<ResearchSourceDto[]> {
  const conditions = [
    filter.runId ? eq(researchSources.runId, filter.runId) : undefined,
    filter.taskId ? eq(researchSources.taskId, filter.taskId) : undefined,
    filter.externalOnly ? eq(researchSources.external, true) : undefined,
  ].filter(Boolean);

  const rows = await handle
    .select()
    .from(researchSources)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(researchSources.retrievedAt)
    .limit(400);

  return rows.map((row) => ({
    id: row.id,
    runId: row.runId,
    taskId: row.taskId,
    query: row.query,
    tool: row.tool,
    ref: row.ref,
    url: row.url,
    title: row.title,
    sourceClass: asSourceClass(row.sourceClass),
    external: row.external,
    excerpt: row.excerpt,
    publishedAt: row.publishedAt,
    retrievedAt: row.retrievedAt.toISOString(),
    injectionSuspected: row.injectionSuspected,
    injectionDetail: row.injectionDetail,
  }));
}

/** Hosts this run has seen in its own search results. */
export async function searchResultHostsFor(runId: string, handle: DbHandle = db): Promise<string[]> {
  const rows = await handle
    .select({ url: researchSources.url })
    .from(researchSources)
    .where(and(eq(researchSources.runId, runId), eq(researchSources.tool, 'public_web_search')));

  const hosts = new Set<string>();
  for (const row of rows) {
    if (!row.url) continue;
    try {
      hosts.add(new URL(row.url).hostname.toLowerCase());
    } catch {
      // A provider that returned something unparseable contributes no host,
      // which is the safe direction: it cannot widen what may be fetched.
    }
  }
  return Array.from(hosts);
}

/** A source-mix sentence for the run page and the artefact. */
export async function describeRunSources(runId: string, handle: DbHandle = db): Promise<string> {
  const tally = await tallySources(runId, handle);
  if (tally.external === 0) {
    return tally.total === 0
      ? 'No sources were retrieved.'
      : `${tally.total} internal source(s) and no external ones.`;
  }
  return (
    `${tally.total} source(s), ${tally.external} of them external. ` +
    (tally.primary === 0
      ? 'None is a primary source, so technical conclusions drawn from them are second-hand.'
      : `${tally.primary} ${tally.primary === 1 ? 'is a primary source' : 'are primary sources'}.`) +
    (tally.injectionSuspected > 0
      ? ` ${tally.injectionSuspected} contained text shaped like instructions to an AI system; it was kept and flagged.`
      : '')
  );
}

/** Converted for the model's own view of what it has retrieved. */
export const toModelSource = (dto: ResearchSourceDto): ResearchSource => ({
  ref: dto.ref,
  label: dto.title,
  excerpt: dto.excerpt,
  retrievedAt: dto.retrievedAt,
  external: dto.external,
  sourceClass: dto.sourceClass,
  url: dto.url,
  publishedAt: dto.publishedAt,
  injectionSuspected: dto.injectionSuspected,
});
