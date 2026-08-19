import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  FORJA_KEY_PREFIX,
  isDeliveringRunStatus,
  type ForjaAgentDto,
  type ForjaArtefactDto,
  type ForjaBlockerDto,
  type ForjaBriefDto,
  type ForjaClientDto,
  type ForjaDiscoveryDto,
  type ForjaProjectDto,
  type ForjaRunDto,
  type ForjaScope,
  type ForjaTaskDto,
  type RunStatus,
} from '@mac/protocol';
import { db, type DbHandle } from '../db/client.js';
import {
  discoverySessions,
  forjaClients,
  handoffBriefs,
  projects,
  researchSources,
  runArtefacts,
  runBlockers,
  runs,
  tasks,
  users,
  workers,
  type ForjaClientRow,
} from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { sha256Hex } from '../lib/crypto.js';
import { AGENT_REGISTRY } from '../domain/agent-registry.js';
import { record, SYSTEM_ACTOR, type Actor } from './audit.js';
import { briefDto } from './briefs.js';
import { briefNarrowing } from './acceptance.js';

/**
 * The Forja orchestration contract (Phase 4 Part D).
 *
 * ---------------------------------------------------------------------------
 * FORJA IS AN APPLICATION
 *
 * It is PAC's engineering and agent-orchestration platform: a piece of software
 * through which PEOPLE do things. It is never registered as an agent, it never
 * appears in `AGENT_REGISTRY`, and — the part that actually bites — every write
 * it performs carries `onBehalfOf`, because "Forja approved it" is not an
 * answer to "who approved this?".
 *
 * The audit trail already distinguishes a human approval from a night-shift
 * policy approval for exactly this reason. An orchestration platform is a third
 * case, and the honest record is "Kasper approved this through Forja".
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export const toForjaClientDto = (row: ForjaClientRow): ForjaClientDto => ({
  id: row.id,
  name: row.name,
  keyPrefix: row.keyPrefix,
  scopes: Array.isArray(row.scopes) ? (row.scopes as ForjaScope[]) : [],
  isActive: row.isActive,
  webhookUrl: row.webhookUrl,
  lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  revokedAt: row.revokedAt?.toISOString() ?? null,
});

export interface IssuedForjaClient {
  client: ForjaClientDto;
  /** Returned exactly once and stored nowhere in plaintext. */
  apiKey: string;
  /** Also returned once. Used by Forja to verify webhook signatures. */
  webhookSecret: string;
}

/**
 * Creates a client and issues its key.
 *
 * Same shape as worker enrollment: the key exists in plaintext for the length
 * of this response and never again, only its SHA-256 is stored, and the display
 * prefix is denormalised so the admin screen can identify it without holding
 * anything usable.
 */
export async function createForjaClient(
  input: { name: string; scopes: ForjaScope[]; webhookUrl?: string | null },
  actor: Actor,
): Promise<IssuedForjaClient> {
  const apiKey = `${FORJA_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  const webhookSecret = randomBytes(32).toString('base64url');

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(forjaClients)
      .values({
        name: input.name,
        keyHash: sha256Hex(apiKey),
        keyPrefix: apiKey.slice(0, FORJA_KEY_PREFIX.length + 8),
        scopes: input.scopes,
        webhookUrl: input.webhookUrl ?? null,
        webhookSecret,
        createdBy: actor.id,
      })
      .returning();
    if (!row) throw new AppError(500, 'FORJA_CLIENT_FAILED', 'The Forja client could not be created.');

    await record(tx, {
      actor,
      eventType: 'forja.client_created',
      metadata: { clientId: row.id, name: row.name, scopes: input.scopes, hasWebhook: Boolean(input.webhookUrl) },
    });

    return { client: toForjaClientDto(row), apiKey, webhookSecret };
  });
}

export async function listForjaClients(): Promise<ForjaClientDto[]> {
  const rows = await db.select().from(forjaClients).orderBy(desc(forjaClients.createdAt)).limit(100);
  return rows.map(toForjaClientDto);
}

export async function revokeForjaClient(id: string, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(forjaClients)
      .set({ isActive: false, revokedAt: new Date() })
      .where(eq(forjaClients.id, id))
      .returning();
    if (!row) throw AppError.notFound('Forja client');

    await record(tx, { actor, eventType: 'forja.client_revoked', metadata: { clientId: id, name: row.name } });
  });
}

export interface AuthenticatedForjaClient {
  id: string;
  name: string;
  scopes: ForjaScope[];
}

/**
 * Resolves an API key.
 *
 * Looks up by HASH, so a timing difference in the lookup reveals nothing about
 * the key — the same property that makes session and worker token lookup safe,
 * and the reason the plaintext is never stored to compare against.
 */
export async function authenticateForja(apiKey: string | undefined): Promise<AuthenticatedForjaClient | null> {
  if (!apiKey || !apiKey.startsWith(FORJA_KEY_PREFIX)) return null;

  const [row] = await db
    .select()
    .from(forjaClients)
    .where(and(eq(forjaClients.keyHash, sha256Hex(apiKey)), eq(forjaClients.isActive, true)))
    .limit(1);
  if (!row) return null;

  await db.update(forjaClients).set({ lastSeenAt: new Date() }).where(eq(forjaClients.id, row.id));

  return {
    id: row.id,
    name: row.name,
    scopes: Array.isArray(row.scopes) ? (row.scopes as ForjaScope[]) : [],
  };
}

/**
 * Resolves the human a Forja write is acting for.
 *
 * An unknown address is REFUSED rather than falling back to a system actor.
 * Recording "system did this" for something a person asked for would put the
 * one field an auditor cares about beyond reach, and an integration that cannot
 * name its user has not been finished.
 */
export async function resolveOnBehalfOf(email: string): Promise<Actor> {
  const [user] = await db
    .select({ id: users.id, name: users.name, isActive: users.isActive })
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);

  if (!user || !user.isActive) {
    throw AppError.forbidden(
      `${email} is not an active Mac user. A Forja write records the person it acts for, and cannot ` +
        'be attributed to a name Mac does not recognise.',
    );
  }

  return { type: 'user', id: user.id, label: `${user.name} (via Forja)` };
}

// ---------------------------------------------------------------------------
// Webhook signing
// ---------------------------------------------------------------------------

/**
 * HMAC-SHA256 over `${timestamp}.${body}`.
 *
 * The timestamp is INSIDE the signed material, so a captured delivery cannot be
 * replayed a week later against a receiver that only checks the signature. That
 * is the whole reason it is not simply a header alongside one.
 */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** Provided so Forja's own test client can verify without reimplementing it. */
export function verifyWebhookSignature(input: {
  secret: string;
  timestamp: string;
  body: string;
  signature: string;
}): boolean {
  const expected = Buffer.from(signWebhook(input.secret, input.timestamp, input.body));
  const actual = Buffer.from(input.signature);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/**
 * The agents Forja may orchestrate.
 *
 * Built from `AGENT_REGISTRY`, which contains Mac and Otto and — deliberately —
 * does not contain Forja. A platform enumerating the agents it orchestrates
 * should not find itself in the list, and a test asserts it never does.
 */
export async function listAgents(): Promise<ForjaAgentDto[]> {
  const online = await db
    .select({ capabilities: workers.capabilities, status: workers.status })
    .from(workers)
    .where(inArray(workers.status, ['idle', 'busy']));

  const capabilities = Array.from(
    new Set(online.flatMap((w) => (Array.isArray(w.capabilities) ? (w.capabilities as string[]) : []))),
  );

  const [active] = await db
    .select({ value: count() })
    .from(runs)
    .where(inArray(runs.status, ['queued', 'running', 'blocked', 'self_review'] satisfies RunStatus[]));

  return AGENT_REGISTRY.filter((entry) => entry.kind === 'agent').map((entry) => ({
    key: entry.key,
    name: entry.name,
    jobTitle: entry.jobTitle,
    email: entry.email ?? null,
    responsibility: entry.responsibility,
    // Only Mac has workers. Otto is modelled but has nothing behind him yet,
    // and reporting him as online would be a capability nobody built.
    online: entry.key === 'mac' ? online.length > 0 : false,
    capabilities: entry.key === 'mac' ? capabilities : [],
    activeRunCount: entry.key === 'mac' ? Number(active?.value ?? 0) : 0,
    nightShiftActive: false,
  }));
}

export async function listForjaProjects(): Promise<ForjaProjectDto[]> {
  const rows = await db.select().from(projects).where(eq(projects.isActive, true)).orderBy(projects.name).limit(200);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    capabilities: Array.isArray(row.capabilities) ? (row.capabilities as string[]) : [],
    allowedTaskKinds: Array.isArray(row.allowedTaskKinds) ? (row.allowedTaskKinds as string[]) : [],
    nightShiftApproved: row.nightShiftApproved,
    hasRepository: Boolean(row.repoUrl),
  }));
}

export async function getForjaTask(taskId: string): Promise<ForjaTaskDto> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!row) throw AppError.notFound('Task');

  const [session] = await db
    .select({ id: discoverySessions.id, briefId: discoverySessions.briefId })
    .from(discoverySessions)
    .where(eq(discoverySessions.taskId, taskId))
    .orderBy(desc(discoverySessions.createdAt))
    .limit(1);

  const [brief] = await db
    .select({ confidence: handoffBriefs.confidence, id: handoffBriefs.id })
    .from(handoffBriefs)
    .where(eq(handoffBriefs.taskId, taskId))
    .orderBy(desc(handoffBriefs.version))
    .limit(1);

  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    taskKind: row.taskKind,
    origin: row.origin,
    /*
     * Mac's DERIVED confidence, never the requester's estimate.
     *
     * `tasks.user_initial_confidence` exists and is deliberately not exposed
     * here: two numbers under one word is how the second one quietly becomes
     * the first, and a published contract is the worst place for that to happen.
     */
    understandingConfidence: brief ? Number(brief.confidence) : null,
    discoverySessionId: session?.id ?? null,
    briefId: brief?.id ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getForjaDiscovery(taskId: string): Promise<ForjaDiscoveryDto | null> {
  const [session] = await db
    .select()
    .from(discoverySessions)
    .where(eq(discoverySessions.taskId, taskId))
    .orderBy(desc(discoverySessions.createdAt))
    .limit(1);
  if (!session) return null;

  const [brief] = await db
    .select({ id: handoffBriefs.id, confidence: handoffBriefs.confidence })
    .from(handoffBriefs)
    .where(eq(handoffBriefs.taskId, taskId))
    .orderBy(desc(handoffBriefs.version))
    .limit(1);

  const pending = session.pendingQuestion as { id: string; question: string; dimension: string } | null;
  const messages = Array.isArray(session.messages) ? session.messages : [];

  return {
    sessionId: session.id,
    taskId,
    status: session.status,
    pendingQuestion: pending,
    briefId: brief?.id ?? null,
    confidence: brief ? Number(brief.confidence) : null,
    messageCount: messages.length,
    contextSummary: session.contextSummary,
    companyContextSha: null,
  };
}

export async function getForjaBrief(briefId: string): Promise<ForjaBriefDto> {
  const [row] = await db.select().from(handoffBriefs).where(eq(handoffBriefs.id, briefId)).limit(1);
  if (!row) throw AppError.notFound('Handoff brief');

  const dto = await briefDto(row);
  const acceptance = Array.isArray(row.acceptance)
    ? (row.acceptance as Array<{ id: string; kind: string; description: string }>)
    : [];

  const narrowing = await briefNarrowing(briefId);

  return {
    id: dto.id,
    taskId: dto.taskId,
    version: dto.version,
    status: dto.status,
    confidence: dto.confidence,
    confidenceBand: dto.confidenceBand,
    title: dto.content.title,
    objective: dto.content.userObjective,
    acceptanceCriteria: dto.content.acceptanceCriteria,
    structuredAcceptance: acceptance.map((c) => ({ id: c.id, kind: c.kind, description: c.description })),
    openQuestions: dto.content.openQuestions.map((q) => ({
      id: q.id,
      question: q.question,
      answered: q.answer !== null,
    })),
    /*
     * The narrowing note, appended to the markdown Forja shows an approver.
     *
     * This is the sentence that would have made commissioning's silent scope
     * reduction visible to whoever approved it, and it belongs in front of the
     * person deciding rather than in an audit event they will never read.
     */
    markdown: narrowing ? `${dto.markdown}\n\n> **Scope note:** ${narrowing}` : dto.markdown,
    companyContextSha: dto.companyContext?.shortSha ?? null,
  };
}

export async function getForjaRun(runId: string): Promise<ForjaRunDto> {
  const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!row) throw AppError.notFound('Run');
  return toForjaRun(row);
}

export async function listForjaRuns(taskId: string): Promise<ForjaRunDto[]> {
  const rows = await db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(desc(runs.createdAt)).limit(50);
  return rows.map(toForjaRun);
}

const toForjaRun = (row: typeof runs.$inferSelect): ForjaRunDto => ({
  id: row.id,
  taskId: row.taskId,
  status: row.status,
  jobKind: row.jobKind,
  executionMode: row.executionMode,
  approvalState: row.approvalState,
  progressStage: row.progressStage,
  progressPercent: row.progressPercent,
  stopReason: row.stopReason,
  acceptanceState: row.acceptanceState,
  summary: row.summary,
  startedAt: row.startedAt?.toISOString() ?? null,
  completedAt: row.completedAt?.toISOString() ?? null,
});

export async function listForjaBlockers(filter: { projectId?: string; resolved?: boolean } = {}): Promise<ForjaBlockerDto[]> {
  const rows = await db
    .select({
      id: runBlockers.id,
      runId: runBlockers.runId,
      description: runBlockers.description,
      resolved: runBlockers.resolved,
      raisedAt: runBlockers.createdAt,
      taskId: runs.taskId,
      projectId: tasks.projectId,
    })
    .from(runBlockers)
    .innerJoin(runs, eq(runs.id, runBlockers.runId))
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(
      filter.projectId
        ? and(eq(tasks.projectId, filter.projectId), eq(runBlockers.resolved, filter.resolved ?? false))
        : eq(runBlockers.resolved, filter.resolved ?? false),
    )
    .orderBy(desc(runBlockers.createdAt))
    .limit(100);

  return rows.map((row) => ({
    id: row.id,
    runId: row.runId,
    taskId: row.taskId,
    projectId: row.projectId,
    description: row.description,
    resolved: row.resolved,
    raisedAt: row.raisedAt.toISOString(),
  }));
}

export async function listForjaArtefacts(filter: { taskId?: string; runId?: string }): Promise<ForjaArtefactDto[]> {
  const conditions = [
    filter.taskId ? eq(runArtefacts.taskId, filter.taskId) : undefined,
    filter.runId ? eq(runArtefacts.runId, filter.runId) : undefined,
  ].filter(Boolean);

  const rows = await db
    .select()
    .from(runArtefacts)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(runArtefacts.createdAt))
    .limit(100);

  const externalCounts = new Map<string, number>();
  for (const row of rows) {
    if (!row.runId || externalCounts.has(row.runId)) continue;
    const [tally] = await db
      .select({ value: count() })
      .from(researchSources)
      .where(and(eq(researchSources.runId, row.runId), eq(researchSources.external, true)));
    externalCounts.set(row.runId, Number(tally?.value ?? 0));
  }

  return rows.map((row) => ({
    id: row.id,
    taskId: row.taskId,
    runId: row.runId,
    type: row.artefactType,
    title: row.title,
    summary: row.summary,
    format: row.format,
    findingCount: Array.isArray(row.findings) ? row.findings.length : 0,
    externalSourceCount: row.runId ? (externalCounts.get(row.runId) ?? 0) : 0,
    companyContextSha: null,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Runs that delivered, for the "task ready for review" question. */
export async function deliveredRunCount(taskId: string, handle: DbHandle = db): Promise<number> {
  const rows = await handle.select({ status: runs.status }).from(runs).where(eq(runs.taskId, taskId));
  return rows.filter((row) => isDeliveringRunStatus(row.status as RunStatus)).length;
}

/** Records a Forja API call. Read by the security page. */
export async function recordForjaRequest(
  client: AuthenticatedForjaClient,
  input: { method: string; path: string; onBehalfOf?: string | null },
): Promise<void> {
  await db.transaction(async (tx) => {
    await record(tx, {
      actor: SYSTEM_ACTOR,
      eventType: 'forja.request',
      metadata: {
        clientId: client.id,
        clientName: client.name,
        method: input.method,
        path: input.path,
        onBehalfOf: input.onBehalfOf ?? null,
      },
    });
  });
}

/** The number of pending deliveries, for the Forja status panel. */
export async function forjaHealth(): Promise<{ clients: number; activeClients: number; lastSeenAt: string | null }> {
  const rows = await db.select({ isActive: forjaClients.isActive, lastSeenAt: forjaClients.lastSeenAt }).from(forjaClients);
  const lastSeen = rows
    .map((r) => r.lastSeenAt)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  return {
    clients: rows.length,
    activeClients: rows.filter((r) => r.isActive).length,
    lastSeenAt: lastSeen?.toISOString() ?? null,
  };
}

export { sql };
