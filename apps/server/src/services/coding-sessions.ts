import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  agentEventSchema,
  type AgentEvent,
  type AgentQuestionDto,
  type AgentSessionDto,
  type AgentSessionState,
  type CodingAgentProvider,
  type DecisionRisk,
  type GitViolationDto,
  type Groundedness,
  type RunAssumptionDto,
  type RunBlockerDto,
  type WorktreeReportRequest,
} from '@mac/protocol';
import { db, type DbHandle } from '../db/client.js';
import {
  agentQuestions,
  agentSessions,
  gitViolations,
  runAssumptions,
  runBlockers,
  runs,
  tasks,
  worktrees,
} from '../db/schema.js';
import type { AgentQuestionRow, AgentSessionRow, WorktreeRow } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { parseConfidence } from '../domain/confidence.js';
import { toWorktreeDto } from './repositories.js';
import { appendSystemLog } from './logs.js';
import { record, type Actor } from './audit.js';

/**
 * Coding-agent sessions, worktrees, assumptions, blockers and refused git
 * operations (Sprint 2 §3, §8, §9, §10, §20).
 *
 * Everything here is written by the worker through the worker plane, and every
 * write emits an audit event, because these are precisely the records that make
 * an autonomous run reviewable in the morning.
 */

export const toAgentSessionDto = (row: AgentSessionRow): AgentSessionDto => ({
  id: row.id,
  runId: row.runId,
  provider: row.provider as CodingAgentProvider,
  providerSessionId: row.providerSessionId,
  providerVersion: row.providerVersion,
  model: row.model,
  state: row.state as AgentSessionState,
  currentActivity: row.currentActivity,
  startedAt: row.startedAt.toISOString(),
  endedAt: row.endedAt?.toISOString() ?? null,
  error: row.error,
});

export const toQuestionDto = (row: AgentQuestionRow): AgentQuestionDto => ({
  id: row.id,
  runId: row.runId,
  seq: row.seq,
  question: row.question,
  answer: row.answer,
  decision: row.decision as AgentQuestionDto['decision'],
  confidence: parseConfidence(row.confidence),
  reasoning: row.reasoning,
  sources: Array.isArray(row.sources) ? (row.sources as string[]) : [],
  risk: row.risk as DecisionRisk,
  requiredHuman: row.requiredHuman,
  affectedImplementation: row.affectedImplementation,
  askedAt: row.askedAt.toISOString(),
  answeredAt: row.answeredAt?.toISOString() ?? null,
  evidence: Array.isArray(row.evidence) ? (row.evidence as AgentQuestionDto['evidence']) : [],
  groundedness: row.groundedness as Groundedness,
  modelAssisted: row.modelAssisted,
  sourcesChecked: Array.isArray(row.sourcesChecked) ? (row.sourcesChecked as string[]) : [],
});

async function projectIdForRun(tx: DbHandle, runId: string): Promise<{ projectId: string | null; taskId: string | null }> {
  const [row] = await tx
    .select({ taskId: runs.taskId, projectId: tasks.projectId })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(eq(runs.id, runId))
    .limit(1);
  return { projectId: row?.projectId ?? null, taskId: row?.taskId ?? null };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Creates or re-attaches the session for a run.
 *
 * Idempotent by run id: a worker that lost connectivity and restarted its
 * session must not create a second row, or the question sequence and the event
 * watermark would fork.
 */
export async function startAgentSession(
  runId: string,
  input: { provider: CodingAgentProvider; providerSessionId?: string | null; providerVersion?: string | null; model?: string | null },
  actor: Actor,
  handle?: DbHandle,
): Promise<AgentSessionDto> {
  const run = async (tx: DbHandle) => {
    const ctx = await projectIdForRun(tx, runId);

    const [existing] = await tx.select().from(agentSessions).where(eq(agentSessions.runId, runId)).limit(1);
    if (existing) {
      const [updated] = await tx
        .update(agentSessions)
        .set({
          state: 'running',
          ...(input.providerSessionId !== undefined ? { providerSessionId: input.providerSessionId } : {}),
          ...(input.providerVersion !== undefined ? { providerVersion: input.providerVersion } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
        })
        .where(eq(agentSessions.id, existing.id))
        .returning();
      return toAgentSessionDto(updated ?? existing);
    }

    const [row] = await tx
      .insert(agentSessions)
      .values({
        runId,
        provider: input.provider,
        providerSessionId: input.providerSessionId ?? null,
        providerVersion: input.providerVersion ?? null,
        model: input.model ?? null,
        state: 'running',
      })
      .returning();
    if (!row) throw new AppError(500, 'AGENT_SESSION_FAILED', 'Could not record the coding-agent session.');

    await record(tx, {
      actor,
      eventType: 'coding_session.started',
      context: { runId, ...ctx },
      metadata: { provider: input.provider, providerSessionId: input.providerSessionId ?? null, model: input.model ?? null },
    });

    await appendSystemLog(tx, runId, `Coding-agent session started (${input.provider}).`);

    return toAgentSessionDto(row);
  };

  return handle ? run(handle) : db.transaction(run);
}

export async function getAgentSession(runId: string, handle: DbHandle = db): Promise<AgentSessionDto | null> {
  const [row] = await handle.select().from(agentSessions).where(eq(agentSessions.runId, runId)).limit(1);
  return row ? toAgentSessionDto(row) : null;
}

/**
 * Ingests a batch of provider-neutral agent events.
 *
 * The session's `highestEventSeq` makes a retried batch idempotent — the worker
 * buffers events and re-sends after a network failure exactly as it does log
 * lines, and re-processing must not duplicate activity or audit rows.
 */
export async function ingestAgentEvents(
  runId: string,
  input: { sessionId: string; provider: string; events: AgentEvent[] },
  actor: Actor,
): Promise<{ accepted: number; highestSeq: number }> {
  return db.transaction(async (tx) => {
    const [session] = await tx.select().from(agentSessions).where(eq(agentSessions.runId, runId)).for('update').limit(1);
    if (!session) throw AppError.notFound('Coding-agent session');

    const ctx = await projectIdForRun(tx, runId);
    const fresh = input.events
      .map((e) => agentEventSchema.parse(e))
      .filter((e) => e.seq > session.highestEventSeq)
      .sort((a, b) => a.seq - b.seq);

    let activity = session.currentActivity;
    let state: AgentSessionState = session.state as AgentSessionState;
    let endedAt: Date | null = session.endedAt;
    let error: string | null = session.error;
    let model = session.model;
    let providerSessionId = session.providerSessionId;
    let providerVersion = session.providerVersion;

    for (const event of fresh) {
      switch (event.type) {
        case 'session_started':
          providerSessionId = event.providerSessionId ?? providerSessionId;
          model = event.model ?? model;
          providerVersion = event.providerVersion ?? providerVersion;
          state = 'running';
          break;

        case 'progress':
          activity = event.stage;
          await appendSystemLog(tx, runId, `[agent] ${event.stage}${event.message ? `: ${event.message}` : ''}`);
          break;

        case 'activity':
          activity = `${event.tool}${event.detail ? `: ${event.detail.slice(0, 120)}` : ''}`;
          // Tool activity goes to the run log, not the audit trail: it is
          // high-volume commentary, and auditing it would bury the decisions.
          await appendSystemLog(tx, runId, `[agent] ${activity}`);
          break;

        case 'output':
          await appendSystemLog(tx, runId, `[agent:${event.stream}] ${event.message.slice(0, 2000)}`);
          break;

        case 'question':
          // The question ITSELF is persisted by the supervision service when
          // the worker asks; this event only reflects the session state.
          state = 'awaiting_answer';
          break;

        case 'completed':
          state = 'completed';
          endedAt = new Date();
          activity = 'completed';
          await record(tx, {
            actor,
            eventType: 'coding_session.completed',
            context: { runId, ...ctx },
            metadata: { summary: event.summary.slice(0, 2000), filesTouched: event.filesTouched.length },
          });
          break;

        case 'failed':
          state = 'failed';
          endedAt = new Date();
          error = event.error.slice(0, 4000);
          await record(tx, {
            actor,
            eventType: 'coding_session.failed',
            context: { runId, ...ctx },
            metadata: { error: error, recoverable: event.recoverable },
          });
          break;

        case 'cancelled':
          state = 'cancelled';
          endedAt = new Date();
          activity = 'cancelled';
          break;

        case 'usage':
          // Handled by the usage service through its own endpoint; recording it
          // here as well would double-count.
          break;
      }
    }

    const highestSeq = fresh.length ? fresh[fresh.length - 1]!.seq : session.highestEventSeq;

    await tx
      .update(agentSessions)
      .set({ highestEventSeq: highestSeq, currentActivity: activity, state, endedAt, error, model, providerSessionId, providerVersion })
      .where(eq(agentSessions.id, session.id));

    return { accepted: fresh.length, highestSeq };
  });
}

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

export async function recordWorktree(
  runId: string,
  repositoryId: string,
  input: WorktreeReportRequest,
  actor: Actor,
): Promise<{ worktreeId: string }> {
  return db.transaction(async (tx) => {
    const ctx = await projectIdForRun(tx, runId);

    const [existing] = await tx.select().from(worktrees).where(eq(worktrees.runId, runId)).limit(1);

    if (existing) {
      const [updated] = await tx
        .update(worktrees)
        .set({
          headSha: input.headSha ?? existing.headSha,
          commitCount: input.commitCount,
          status: input.status,
          ...(input.status === 'removed' ? { removedAt: new Date() } : {}),
          ...(input.status === 'preserved' ? { releasedAt: new Date() } : {}),
        })
        .where(eq(worktrees.id, existing.id))
        .returning();

      if (input.status !== existing.status) {
        await record(tx, {
          actor,
          eventType: input.status === 'removed' ? 'worktree.removed' : 'worktree.preserved',
          context: { runId, ...ctx },
          metadata: { worktreeId: existing.id, path: existing.path, branch: existing.branch, commitCount: input.commitCount },
        });
      }

      return { worktreeId: (updated ?? existing).id };
    }

    const [row] = await tx
      .insert(worktrees)
      .values({
        runId,
        repositoryId,
        path: input.path,
        branch: input.branch,
        baseBranch: input.baseBranch,
        baseSha: input.baseSha,
        headSha: input.headSha ?? null,
        commitCount: input.commitCount,
        status: input.status,
      })
      .returning();
    if (!row) throw new AppError(500, 'WORKTREE_RECORD_FAILED', 'Could not record the worktree.');

    await record(tx, {
      actor,
      eventType: 'worktree.created',
      context: { runId, ...ctx },
      metadata: { worktreeId: row.id, path: row.path, branch: row.branch, baseBranch: row.baseBranch, baseSha: row.baseSha },
    });

    await appendSystemLog(tx, runId, `Isolated worktree created at ${row.path} on branch ${row.branch} (base ${row.baseBranch}@${row.baseSha.slice(0, 8)}).`);

    return { worktreeId: row.id };
  });
}

export async function getWorktree(runId: string, handle: DbHandle = db): Promise<WorktreeRow | null> {
  const [row] = await handle.select().from(worktrees).where(eq(worktrees.runId, runId)).limit(1);
  return row ?? null;
}

export async function getWorktreeDto(runId: string) {
  const row = await getWorktree(runId);
  return row ? toWorktreeDto(row) : null;
}

// ---------------------------------------------------------------------------
// Refused git operations
// ---------------------------------------------------------------------------

/**
 * Records an attempt to perform a prohibited git operation.
 *
 * This is a security event, not commentary. It is audited, it appears in the
 * run log so it cannot be missed, and its presence blocks pull-request creation
 * outright.
 */
export async function recordGitViolation(
  runId: string,
  input: { code: string; argv: string[]; message: string; origin: 'mac' | 'agent'; at?: string },
  actor: Actor,
): Promise<void> {
  await db.transaction(async (tx) => {
    const ctx = await projectIdForRun(tx, runId);

    await tx.insert(gitViolations).values({
      runId,
      code: input.code,
      argv: input.argv,
      message: input.message,
      origin: input.origin,
      ...(input.at ? { at: new Date(input.at) } : {}),
    });

    await record(tx, {
      actor,
      eventType: 'git.operation_rejected',
      context: { runId, ...ctx },
      metadata: { code: input.code, argv: input.argv, origin: input.origin, message: input.message },
    });

    await appendSystemLog(
      tx,
      runId,
      `REFUSED prohibited git operation (${input.code}, attempted by ${input.origin}): git ${input.argv.join(' ')}`,
    );
  });
}

/**
 * Records the containment a worker established for one run (Sprint 3 §22).
 *
 * A run-scoped fact, not a fleet-scoped one: "this worker can sandbox" is
 * useful for dispatch, but "this run WAS sandboxed, with these mounts" is what
 * a reviewer needs when they are deciding how much to trust a diff produced at
 * 03:00. It is audited rather than logged so it can be queried.
 */
export async function recordRunSandbox(
  runId: string,
  input: {
    established: boolean;
    kind: string;
    version: string | null;
    mounts: Array<{ purpose: string; mode: 'ro' | 'rw' }>;
    network: 'none' | 'egress';
    refusalReason: string | null;
  },
  actor: Actor,
): Promise<void> {
  await db.transaction(async (tx) => {
    const ctx = await projectIdForRun(tx, runId);

    await record(tx, {
      actor,
      eventType: input.established ? 'sandbox.created' : 'sandbox.refused',
      context: { runId, ...ctx },
      metadata: {
        kind: input.kind,
        version: input.version,
        network: input.network,
        mounts: input.mounts,
        refusalReason: input.refusalReason,
      },
    });

    await appendSystemLog(
      tx,
      runId,
      input.established
        ? `Execution sandbox established (${input.kind}${input.version ? `, ${input.version}` : ''}): ` +
            `${input.mounts.map((m) => `${m.purpose}:${m.mode}`).join(', ')}. Network ${input.network}.`
        : `REFUSED to start a coding session without containment: ${input.refusalReason ?? 'no sandbox available'}.`,
    );
  });
}

export async function listGitViolations(runId: string, handle: DbHandle = db): Promise<GitViolationDto[]> {
  const rows = await handle.select().from(gitViolations).where(eq(gitViolations.runId, runId)).orderBy(asc(gitViolations.at));
  return rows.map((r) => ({
    id: r.id,
    runId: r.runId,
    code: r.code,
    argv: Array.isArray(r.argv) ? (r.argv as string[]) : [],
    message: r.message,
    origin: r.origin as 'mac' | 'agent',
    at: r.at.toISOString(),
  }));
}

export async function countGitViolations(runId: string, handle: DbHandle = db): Promise<number> {
  const [row] = await handle
    .select({ count: sql<number>`count(*)::int` })
    .from(gitViolations)
    .where(eq(gitViolations.runId, runId));
  return row?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Questions, assumptions, blockers
// ---------------------------------------------------------------------------

export async function listQuestions(runId: string, handle: DbHandle = db): Promise<AgentQuestionDto[]> {
  const rows = await handle.select().from(agentQuestions).where(eq(agentQuestions.runId, runId)).orderBy(asc(agentQuestions.seq));
  return rows.map(toQuestionDto);
}

export async function countUnansweredQuestions(runId: string, handle: DbHandle = db): Promise<number> {
  const [row] = await handle
    .select({ count: sql<number>`count(*)::int` })
    .from(agentQuestions)
    .where(and(eq(agentQuestions.runId, runId), eq(agentQuestions.decision, 'blocked')));
  return row?.count ?? 0;
}

export async function listAssumptions(runId: string, handle: DbHandle = db): Promise<RunAssumptionDto[]> {
  const rows = await handle
    .select()
    .from(runAssumptions)
    .where(eq(runAssumptions.runId, runId))
    .orderBy(desc(runAssumptions.createdAt));

  return rows.map((r) => ({
    id: r.id,
    runId: r.runId,
    statement: r.statement,
    confidence: parseConfidence(r.confidence) ?? 0,
    reversible: r.reversible,
    flagged: r.flagged,
    source: r.source,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function listBlockers(runId: string, handle: DbHandle = db): Promise<RunBlockerDto[]> {
  const rows = await handle.select().from(runBlockers).where(eq(runBlockers.runId, runId)).orderBy(asc(runBlockers.createdAt));
  return rows.map((r) => ({
    id: r.id,
    runId: r.runId,
    description: r.description,
    reason: r.reason,
    risk: r.risk as DecisionRisk,
    resolved: r.resolved,
    createdAt: r.createdAt.toISOString(),
  }));
}
