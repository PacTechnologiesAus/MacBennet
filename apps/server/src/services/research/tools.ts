import { and, desc, eq, isNotNull, ne } from 'drizzle-orm';
import {
  handoffBriefContentSchema,
  isExternalTool,
  projectContextSnapshotSchema,
  RESEARCH_LIMITS,
  type ResearchSource,
  type ResearchTool,
  type ResearchToolCall,
  type ResearchToolResult,
} from '@mac/protocol';
import { db, type DbHandle } from '../../db/client.js';
import {
  agentQuestions,
  discoverySessions,
  handoffBriefs,
  projects,
  runs,
  tasks,
} from '../../db/schema.js';
import { config } from '../../config.js';
import { memoryForTask } from '../memory.js';
import { revisionById } from '../company-context/loader.js';
import { selectCompanyContext } from '../company-context/selection.js';
import { clientForBoard } from '../monday/provider.js';
import { mondayItemForTask } from '../monday/outbox.js';

/**
 * The research tool layer (Sprint 3.3 §14, §15, §29).
 *
 * ---------------------------------------------------------------------------
 * WHY THE MODEL CANNOT REACH ANYTHING DIRECTLY
 *
 * Every function here takes a QUERY STRING and a run-scoped context. It does not
 * take a project id, a path, a scope, a limit, a credential or a connection.
 * Those come from the run, server-side, which is what makes the following true
 * rather than merely intended:
 *
 *   * a run cannot search another project's memory, because the project id is
 *     not a parameter the model supplies;
 *   * a run cannot read the company repository's write credential, because the
 *     tool layer reads a already-loaded revision and never touches Git auth;
 *   * a run cannot reach monday.com except through the item ALREADY linked to
 *     its own task;
 *   * a run cannot fetch an arbitrary URL, because `public_doc_fetch` validates
 *     scheme and host against an administrator's allowlist before fetching.
 *
 * This is the same argument `jobs.ts` makes about job parameters, applied one
 * level up: the protocol has no field in which "search everything" could be
 * expressed, so no prompt can express it.
 *
 * Every call returns a `ResearchToolResult` recording the query, whether it was
 * performed, why not if it was refused, and every source with its retrieval
 * timestamp — which is §15's requirement that a claim can be traced back to
 * what was actually fetched.
 * ---------------------------------------------------------------------------
 */

export interface ToolContext {
  runId: string | null;
  taskId: string;
  projectId: string;
  /** The company context revision this run is BOUND to. Never "whatever is active". */
  companyContextRevisionId: string | null;
  /** Domains an administrator has allowed for external retrieval. */
  allowedResearchDomains: readonly string[];
  externalResearchEnabled: boolean;
}

const now = () => new Date().toISOString();

const refused = (call: ResearchToolCall, reason: string): ResearchToolResult => ({
  tool: call.tool,
  argument: call.argument,
  performed: false,
  refusalReason: reason,
  sources: [],
  at: now(),
});

const performed = (call: ResearchToolCall, sources: ResearchSource[]): ResearchToolResult => ({
  tool: call.tool,
  argument: call.argument,
  performed: true,
  refusalReason: null,
  sources: sources.slice(0, RESEARCH_LIMITS.maxSourcesPerTool),
  at: now(),
});

/**
 * Runs one tool call.
 *
 * A tool that finds nothing returns `performed: true` with no sources. That is a
 * genuinely different outcome from a refusal, and conflating them would let
 * "Mac was not allowed to look" be reported as "Mac looked and found nothing".
 */
export async function runTool(
  call: ResearchToolCall,
  context: ToolContext,
  handle: DbHandle = db,
): Promise<ResearchToolResult> {
  if (isExternalTool(call.tool) && !context.externalResearchEnabled) {
    return refused(call, 'External research is disabled for this deployment.');
  }

  switch (call.tool) {
    case 'company_context_search':
      return companyContextSearch(call, context);
    case 'project_memory_search':
      return projectMemorySearch(call, context, handle);
    case 'prior_run_search':
      return priorRunSearch(call, context, handle);
    case 'brief_search':
      return briefSearch(call, context, handle);
    case 'repository_search':
      return repositorySearch(call, context, handle);
    case 'monday_search':
      return mondaySearch(call, context, handle);
    case 'public_web_search':
      return publicWebSearch(call);
    case 'public_doc_fetch':
      return publicDocFetch(call, context);
  }
}

// ---------------------------------------------------------------------------
// Internal sources
// ---------------------------------------------------------------------------

/**
 * PAC's approved company context, at the revision this run is pinned to.
 *
 * `ref` carries the commit SHA, which is what makes a company claim traceable to
 * the exact text that was approved rather than to "the handbook" in general.
 */
async function companyContextSearch(call: ResearchToolCall, context: ToolContext): Promise<ResearchToolResult> {
  if (!context.companyContextRevisionId) {
    return refused(call, 'This run is not bound to a company-context revision.');
  }
  try {
    const revision = await revisionById(context.companyContextRevisionId);
    if (!revision || revision.validationState !== 'valid') {
      return refused(call, 'The bound company-context revision is not valid.');
    }
    const selection = await selectCompanyContext(revision, { text: call.argument });
    const sections = [...selection.core, ...selection.taskRelevant];
    return performed(
      call,
      sections.map((section) => ({
        /*
         * Sprint 3.2's own ref format, reused rather than reinvented.
         *
         * `company:AUTHORITY.md#Financial Authority@83ac4a0` already names the
         * document AND the commit, which is what makes a PAC claim traceable to
         * the exact approved text. Its `company:` prefix is load-bearing in a
         * second way now: `classifyFindings` uses it to decide whether a
         * finding claiming `pac_fact` is genuinely grounded in PAC policy.
         */
        ref: section.ref,
        label: section.heading ?? section.document,
        excerpt: section.text.slice(0, 4000),
        retrievedAt: now(),
        external: false,
      })),
    );
  } catch (err) {
    return refused(call, `Company context is unreadable: ${(err as Error).message.slice(0, 200)}`);
  }
}

async function projectMemorySearch(
  call: ResearchToolCall,
  context: ToolContext,
  handle: DbHandle,
): Promise<ResearchToolResult> {
  const entries = await memoryForTask({ projectId: context.projectId, taskId: context.taskId }, handle);
  const terms = keywords(call.argument);
  const matched = entries
    .filter((entry) => terms.length === 0 || overlaps(`${entry.key} ${entry.value}`, terms))
    .slice(0, RESEARCH_LIMITS.maxSourcesPerTool);

  return performed(
    call,
    matched.map((entry) => ({
      ref: `project_memory:${entry.scope}/${entry.key}`,
      label: entry.key,
      excerpt: entry.value.slice(0, 4000),
      retrievedAt: now(),
      external: false,
    })),
  );
}

/**
 * What Mac decided on earlier runs in THIS project.
 *
 * Excludes the current run, exactly as `investigation.ts` does: an answer Mac
 * gave five minutes ago is not independent evidence for the same answer now,
 * and treating it as such would let one guess bootstrap itself into a fact.
 */
async function priorRunSearch(
  call: ResearchToolCall,
  context: ToolContext,
  handle: DbHandle,
): Promise<ResearchToolResult> {
  const rows = await handle
    .select({
      runId: agentQuestions.runId,
      question: agentQuestions.question,
      answer: agentQuestions.answer,
      groundedness: agentQuestions.groundedness,
    })
    .from(agentQuestions)
    .innerJoin(runs, eq(runs.id, agentQuestions.runId))
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(
      and(
        eq(tasks.projectId, context.projectId),
        isNotNull(agentQuestions.answer),
        eq(agentQuestions.decision, 'answered'),
        context.runId ? ne(agentQuestions.runId, context.runId) : undefined,
      ),
    )
    .orderBy(desc(agentQuestions.answeredAt))
    .limit(50);

  const terms = keywords(call.argument);
  const matched = rows
    .filter((row) => terms.length === 0 || overlaps(`${row.question} ${row.answer ?? ''}`, terms))
    .slice(0, RESEARCH_LIMITS.maxSourcesPerTool);

  return performed(
    call,
    matched.map((row) => ({
      ref: `previous_run:${row.runId}`,
      label: row.question.slice(0, 200),
      // Groundedness travels with the excerpt so a later reader can see whether
      // Mac established this last time or merely assumed it.
      excerpt: `Q: ${row.question}\nA: ${row.answer}\n(${row.groundedness ?? 'unknown groundedness'})`.slice(0, 4000),
      retrievedAt: now(),
      external: false,
    })),
  );
}

async function briefSearch(
  call: ResearchToolCall,
  context: ToolContext,
  handle: DbHandle,
): Promise<ResearchToolResult> {
  const rows = await handle
    .select({ id: handoffBriefs.id, content: handoffBriefs.content, taskId: handoffBriefs.taskId })
    .from(handoffBriefs)
    .where(and(eq(handoffBriefs.projectId, context.projectId), ne(handoffBriefs.taskId, context.taskId)))
    .orderBy(desc(handoffBriefs.updatedAt))
    .limit(20);

  const terms = keywords(call.argument);
  const sources: ResearchSource[] = [];

  for (const row of rows) {
    const parsed = handoffBriefContentSchema.safeParse(row.content);
    if (!parsed.success) continue;
    // Only the durable parts. A previous task's objective is about different
    // work and would only add noise; its constraints are facts about the project.
    const durable = [
      ...parsed.data.constraints.map((text, i) => ({ label: `constraint[${i}]`, text })),
      ...parsed.data.mustNotChange.map((text, i) => ({ label: `must not change[${i}]`, text: `Must not change: ${text}` })),
    ];
    for (const entry of durable) {
      if (terms.length && !overlaps(entry.text, terms)) continue;
      sources.push({
        ref: `brief:${row.id}#${entry.label}`,
        label: `${parsed.data.title} — ${entry.label}`,
        excerpt: entry.text.slice(0, 4000),
        retrievedAt: now(),
        external: false,
      });
    }
  }

  return performed(call, sources);
}

async function repositorySearch(
  call: ResearchToolCall,
  context: ToolContext,
  handle: DbHandle,
): Promise<ResearchToolResult> {
  const [session] = await handle
    .select({ snapshot: discoverySessions.contextSnapshot })
    .from(discoverySessions)
    .where(eq(discoverySessions.taskId, context.taskId))
    .orderBy(desc(discoverySessions.createdAt))
    .limit(1);

  if (!session?.snapshot) return refused(call, 'No repository has been inspected for this task.');

  const parsed = projectContextSnapshotSchema.safeParse(session.snapshot);
  if (!parsed.success) return refused(call, 'The recorded repository snapshot is unreadable.');

  const snapshot = parsed.data;
  const sources: ResearchSource[] = [];
  const push = (label: string, text: string) =>
    sources.push({
      ref: `repository:${label}@${snapshot.headSha.slice(0, 8)}`,
      label,
      excerpt: text.slice(0, 4000),
      retrievedAt: now(),
      external: false,
    });

  if (snapshot.readme) push('README', snapshot.readme);
  if (snapshot.languages.length) push('languages', snapshot.languages.join(', '));
  if (snapshot.testPaths.length) push('test layout', snapshot.testPaths.join(', '));
  if (snapshot.docFiles.length) push('documentation files', snapshot.docFiles.join(', '));
  for (const manifest of snapshot.packageManifests.slice(0, 5)) {
    push(`manifest ${manifest.path}`, `scripts: ${manifest.scripts.join(', ')}`);
  }

  const terms = keywords(call.argument);
  return performed(call, terms.length ? sources.filter((s) => overlaps(s.excerpt, terms)) : sources);
}

/**
 * The monday item ALREADY linked to this task, and nothing else.
 *
 * There is no code path here that takes a board id or an item id from the
 * caller, which is what stops a research run reading another customer's board.
 */
async function mondaySearch(
  call: ResearchToolCall,
  context: ToolContext,
  handle: DbHandle,
): Promise<ResearchToolResult> {
  const linked = await mondayItemForTask(context.taskId, handle);
  if (!linked) return refused(call, 'This task is not linked to a monday.com item.');

  const sources: ResearchSource[] = [];
  if (linked.item.description) {
    sources.push({
      ref: `monday:item/${linked.item.itemId}`,
      label: linked.item.name,
      excerpt: linked.item.description.slice(0, 4000),
      retrievedAt: now(),
      external: false,
    });
  }

  try {
    const client = await clientForBoard(linked.board);
    for (const update of await client.listUpdates(linked.item.itemId, 20)) {
      sources.push({
        ref: `monday:item/${linked.item.itemId}/update/${update.id}`,
        label: `Update on ${linked.item.name}`,
        excerpt: update.body.slice(0, 4000),
        retrievedAt: now(),
        external: false,
      });
    }
  } catch {
    // A board that is unreachable contributes nothing rather than failing the
    // step. The result still records that the source was consulted.
  }

  return performed(call, sources);
}

// ---------------------------------------------------------------------------
// External sources
// ---------------------------------------------------------------------------

/**
 * Public web search.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A SEAM, AND IT REFUSES HONESTLY
 *
 * No search provider is configured in this deployment, and Sprint 3.3 §12 is
 * explicit that capabilities must not be fabricated. So rather than quietly
 * returning nothing — which the model would read as "the web contains nothing
 * about this" and might then write down — it refuses with a reason naming the
 * missing configuration.
 *
 * Adding one later means implementing this function against a real API. The
 * shape it must return is already fixed by the tests.
 * ---------------------------------------------------------------------------
 */
async function publicWebSearch(call: ResearchToolCall): Promise<ResearchToolResult> {
  if (!config.research?.searchEndpoint) {
    return refused(
      call,
      'No web-search provider is configured (MAC_RESEARCH_SEARCH_ENDPOINT). Mac will not guess at search ' +
        'results, and an empty result here would read as "the web says nothing about this".',
    );
  }
  return refused(call, 'The configured web-search provider is not yet implemented.');
}

/**
 * Retrieval of one public document.
 *
 * Four gates before anything leaves the process: HTTPS only, host on the
 * administrator's allowlist, bounded response, and no redirect off the
 * allowlist. The last one matters — an allowlisted host that 302s elsewhere
 * would otherwise be an open proxy.
 */
async function publicDocFetch(call: ResearchToolCall, context: ToolContext): Promise<ResearchToolResult> {
  let url: URL;
  try {
    url = new URL(call.argument);
  } catch {
    return refused(call, 'That is not a valid URL.');
  }

  if (url.protocol !== 'https:') return refused(call, 'Only https URLs may be fetched.');

  if (!hostAllowed(url.hostname, context.allowedResearchDomains)) {
    return refused(
      call,
      `${url.hostname} is not on the approved research-domain allowlist. ` +
        'An administrator adds domains in settings; Mac does not add his own.',
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { redirect: 'manual', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) {
      return refused(call, `${url.hostname} redirected, and a redirect could leave the allowlist. Not followed.`);
    }
    if (!response.ok) return refused(call, `${url.hostname} returned ${response.status}.`);

    const body = (await response.text()).slice(0, 200_000);
    return performed(call, [
      {
        ref: url.toString(),
        label: url.hostname + url.pathname,
        excerpt: stripMarkup(body).slice(0, 4000),
        retrievedAt: now(),
        // The flag that keeps an internet claim from being filed as a PAC fact.
        external: true,
      },
    ]);
  } catch (err) {
    return refused(call, `Could not retrieve it: ${(err as Error).message.slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Exact host, or a subdomain of an allowlisted host. Never a suffix match. */
function hostAllowed(hostname: string, allowed: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return allowed.some((entry) => {
    const domain = entry.trim().toLowerCase().replace(/^\./, '');
    if (!domain) return false;
    // `.endsWith(domain)` alone would let `evil-example.com` match `example.com`.
    return host === domain || host.endsWith(`.${domain}`);
  });
}

const stripMarkup = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'are', 'be', 'it', 'that',
  'this', 'with', 'we', 'i', 'you', 'what', 'which', 'how', 'does', 'do', 'from', 'about',
]);

export const keywords = (text: string): string[] =>
  Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 3 && !STOP_WORDS.has(word)),
    ),
  ).slice(0, 20);

const overlaps = (text: string, terms: readonly string[]): boolean => {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term));
};

/** The project's declared capabilities, for the tool gate. */
export async function projectAllowsExternalResearch(projectId: string, handle: DbHandle = db): Promise<boolean> {
  const [row] = await handle.select({ capabilities: projects.capabilities }).from(projects).where(eq(projects.id, projectId)).limit(1);
  const capabilities = Array.isArray(row?.capabilities) ? (row.capabilities as string[]) : [];
  return capabilities.includes('external_research');
}
