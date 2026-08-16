import { eq, sql } from 'drizzle-orm';
import {
  agentAnswerSchema,
  handoffBriefContentSchema,
  projectContextSnapshotSchema,
  type AgentAnswer,
  type AskQuestionRequest,
  type ProjectContextSnapshot,
} from '@mac/protocol';
import { db, type DbHandle } from '../db/client.js';
import { agentQuestions, agentSessions, discoverySessions, handoffBriefs, runAssumptions, runBlockers, runs, tasks } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { superviseQuestion } from '../domain/supervision.js';
import { getSettings } from './settings.js';
import { memoryForTask } from './memory.js';
import { appendSystemLog } from './logs.js';
import { record, type Actor } from './audit.js';
import { toQuestionDto } from './coding-sessions.js';

/**
 * Question-and-answer supervision (Sprint 2 §8).
 *
 * Two structural decisions worth stating plainly:
 *
 *  1. **The worker does not answer.** It forwards the question here and applies
 *     whatever comes back. Every decision made during an autonomous run
 *     therefore exists in the control plane's database, where it is audited and
 *     reviewable — a worker that decided things itself would be a worker whose
 *     reasoning nobody could inspect in the morning.
 *
 *  2. **The question is persisted BEFORE it is answered.** If answering throws,
 *     crashes or times out, the record that the agent asked still exists. An
 *     audit trail that only contains questions Mac successfully answered would
 *     be exactly the wrong shape.
 */

export interface SupervisionOutcome {
  answer: AgentAnswer;
  questionId: string;
  /** Present when the decision was to block this portion of the work. */
  blockerId: string | null;
  assumptionId: string | null;
}

export async function answerAgentQuestion(
  runId: string,
  input: AskQuestionRequest,
  actor: Actor,
): Promise<SupervisionOutcome> {
  return db.transaction(async (tx) => {
    const context = await loadRunContext(tx, runId);
    const settings = await getSettings(tx);

    // Bound the volume: an agent stuck in a question loop must not be able to
    // fill the database or spend the night asking.
    const [countRow] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(agentQuestions)
      .where(eq(agentQuestions.runId, runId));

    const count = countRow?.count ?? 0;
    const seq = count;

    // --- 1. Record the question, before anything can fail ------------------

    const [inserted] = await tx
      .insert(agentQuestions)
      .values({
        runId,
        agentSessionId: context.agentSessionId,
        externalId: input.questionId,
        seq,
        question: input.question,
        context: input.context ?? null,
      })
      // A retried upload of the same question must not create a second row.
      .onConflictDoNothing({ target: [agentQuestions.runId, agentQuestions.externalId] })
      .returning();

    const [questionRow] = inserted
      ? [inserted]
      : await tx
          .select()
          .from(agentQuestions)
          .where(eq(agentQuestions.runId, runId))
          .then((rows) => rows.filter((r) => r.externalId === input.questionId));

    if (!questionRow) throw new AppError(500, 'QUESTION_RECORD_FAILED', 'Could not record the question.');

    // An already-answered question is returned as-is rather than re-decided:
    // the agent may simply be retrying after a dropped connection.
    if (questionRow.answer !== null && questionRow.decision !== null) {
      const existing = toQuestionDto(questionRow);
      return {
        questionId: questionRow.id,
        blockerId: null,
        assumptionId: null,
        answer: agentAnswerSchema.parse({
          questionId: input.questionId,
          decision: existing.decision ?? 'answered',
          answer: existing.answer ?? '',
          confidence: existing.confidence ?? 0,
          reasoning: existing.reasoning ?? '',
          sources: existing.sources,
          requiredHuman: existing.requiredHuman,
          isAssumption: existing.decision === 'assumed',
        }),
      };
    }

    await record(tx, {
      actor,
      eventType: 'coding_session.question',
      context: { runId, taskId: context.taskId, projectId: context.projectId },
      metadata: { questionId: input.questionId, seq, question: input.question.slice(0, 1000), activity: input.activity ?? null },
    });

    if (count >= settings.maxQuestionsPerRun) {
      const answer = agentAnswerSchema.parse({
        questionId: input.questionId,
        decision: 'blocked',
        answer:
          `This run has already reached its limit of ${settings.maxQuestionsPerRun} questions. ` +
          'Stop asking and complete whatever independent work is already safe to finish, leaving the rest unimplemented.',
        confidence: 0,
        reasoning: `Question limit (${settings.maxQuestionsPerRun}) reached for this run.`,
        sources: [],
        requiredHuman: true,
        isAssumption: false,
      });

      const blockerId = await insertBlocker(tx, runId, {
        description: input.question,
        reason: answer.reasoning,
        risk: 'medium',
      });

      await finaliseQuestion(tx, questionRow.id, answer, 'medium');
      await recordDecisionAudit(tx, actor, context, runId, input.questionId, answer, 'medium');
      return { answer, questionId: questionRow.id, blockerId, assumptionId: null };
    }

    // --- 2. Decide, from recorded sources only ------------------------------

    const result = superviseQuestion({
      question: input.question,
      context: input.context,
      brief: context.brief,
      memory: context.memory,
      repositoryContext: context.repositoryContext,
      approvedScope: context.approvedScope,
      policy: {
        answerConfidenceThreshold: settings.answerConfidenceThreshold,
        minExecutionConfidence: settings.minExecutionConfidence,
      },
    });

    const answer = agentAnswerSchema.parse({
      questionId: input.questionId,
      decision: result.decision,
      answer: result.answer,
      confidence: result.confidence,
      reasoning: result.reasoning,
      sources: result.sources,
      requiredHuman: result.requiredHuman,
      isAssumption: result.isAssumption,
    });

    // --- 3. Persist the consequences ---------------------------------------

    let blockerId: string | null = null;
    let assumptionId: string | null = null;

    if (result.blocker) {
      blockerId = await insertBlocker(tx, runId, { ...result.blocker, risk: result.risk, questionId: questionRow.id });
    }

    if (result.isAssumption) {
      const [assumption] = await tx
        .insert(runAssumptions)
        .values({
          runId,
          questionId: questionRow.id,
          /*
           * Deliberately short.
           *
           * This statement is rendered in the morning report, which must stay
           * skimmable — spec §28: engineers ignore giant AI-generated novels.
           * The full question, answer, reasoning and sources are all persisted
           * on the question row and reachable from the report's Q&A link, so
           * nothing is lost by keeping the headline brief.
           */
          statement: `${truncate(firstLine(input.question), 160)} → ${truncate(firstLine(result.answer), 200)}`,
          confidence: result.confidence.toFixed(3),
          reversible: true,
          // Below the answering threshold, so it must be surfaced prominently.
          flagged: true,
          source: result.sources.join(', ') || null,
        })
        .returning();
      assumptionId = assumption?.id ?? null;

      await record(tx, {
        actor,
        eventType: 'coding_session.assumption_recorded',
        context: { runId, taskId: context.taskId, projectId: context.projectId },
        metadata: { questionId: input.questionId, confidence: result.confidence, sources: result.sources },
      });
    }

    await finaliseQuestion(tx, questionRow.id, answer, result.risk);
    await recordDecisionAudit(tx, actor, context, runId, input.questionId, answer, result.risk);

    await appendSystemLog(
      tx,
      runId,
      `Q: ${truncate(input.question, 300)}\n` +
        `Mac (${result.decision}, ${(result.confidence * 100).toFixed(0)}% confidence): ${truncate(result.answer, 600)}`,
    );

    return { answer, questionId: questionRow.id, blockerId, assumptionId };
  });
}

async function insertBlocker(
  tx: DbHandle,
  runId: string,
  input: { description: string; reason: string; risk: string; questionId?: string },
): Promise<string> {
  const [row] = await tx
    .insert(runBlockers)
    .values({
      runId,
      questionId: input.questionId ?? null,
      description: truncate(input.description, 2000),
      reason: truncate(input.reason, 2000),
      risk: input.risk,
    })
    .returning();
  return row!.id;
}

async function finaliseQuestion(
  tx: DbHandle,
  questionId: string,
  answer: AgentAnswer,
  risk: string,
): Promise<void> {
  await tx
    .update(agentQuestions)
    .set({
      answer: answer.answer,
      decision: answer.decision,
      confidence: answer.confidence.toFixed(3),
      reasoning: answer.reasoning,
      sources: answer.sources,
      risk,
      requiredHuman: answer.requiredHuman,
      // An answered or assumed question changed what the agent did next; a
      // blocked one deliberately did not.
      affectedImplementation: answer.decision !== 'blocked',
      answeredAt: new Date(),
    })
    .where(eq(agentQuestions.id, questionId));
}

async function recordDecisionAudit(
  tx: DbHandle,
  actor: Actor,
  context: { taskId: string; projectId: string },
  runId: string,
  externalQuestionId: string,
  answer: AgentAnswer,
  risk: string,
): Promise<void> {
  await record(tx, {
    actor,
    eventType: answer.decision === 'blocked' ? 'coding_session.blocked' : 'coding_session.answered',
    context: { runId, taskId: context.taskId, projectId: context.projectId },
    metadata: {
      questionId: externalQuestionId,
      decision: answer.decision,
      confidence: answer.confidence,
      risk,
      sources: answer.sources,
      reasoning: truncate(answer.reasoning, 1000),
      requiredHuman: answer.requiredHuman,
    },
  });
}

interface RunSupervisionContext {
  taskId: string;
  projectId: string;
  brief: ReturnType<typeof handoffBriefContentSchema.parse>;
  memory: Array<{ key: string; value: string; scope: string; confidence: number }>;
  repositoryContext: ProjectContextSnapshot | null;
  approvedScope: string | null;
  agentSessionId: string | null;
}

/**
 * Gathers every source Mac is permitted to answer from.
 *
 * Note the scoping: memory is fetched for THIS task, so another task's
 * assumptions are structurally unreachable, and the repository context comes
 * from the discovery session that produced this task's brief.
 */
async function loadRunContext(tx: DbHandle, runId: string): Promise<RunSupervisionContext> {
  const [row] = await tx
    .select({
      taskId: runs.taskId,
      projectId: tasks.projectId,
      briefId: runs.handoffBriefId,
      approvedScope: runs.approvedScope,
    })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(eq(runs.id, runId))
    .limit(1);

  if (!row) throw AppError.notFound('Run');

  if (!row.briefId) {
    throw AppError.conflict(
      'NO_BRIEF',
      'This run has no handoff brief, so Mac has no basis on which to answer questions about it.',
    );
  }

  const [briefRow] = await tx.select().from(handoffBriefs).where(eq(handoffBriefs.id, row.briefId)).limit(1);
  if (!briefRow) throw AppError.notFound('Handoff brief');

  const memory = await memoryForTask({ projectId: row.projectId, taskId: row.taskId }, tx);

  const [discovery] = await tx
    .select({ snapshot: discoverySessions.contextSnapshot })
    .from(discoverySessions)
    .where(eq(discoverySessions.taskId, row.taskId))
    .limit(1);

  const [session] = await tx.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.runId, runId)).limit(1);

  return {
    taskId: row.taskId,
    projectId: row.projectId,
    brief: handoffBriefContentSchema.parse(briefRow.content),
    memory: memory.map((m) => ({ key: m.key, value: m.value, scope: m.scope, confidence: m.confidence })),
    repositoryContext: discovery?.snapshot ? projectContextSnapshotSchema.parse(discovery.snapshot) : null,
    approvedScope: row.approvedScope,
    agentSessionId: session?.id ?? null,
  };
}

const truncate = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** The first meaningful line, so a multi-paragraph answer does not fill a report. */
const firstLine = (text: string): string => (text.split('\n').map((l) => l.trim()).find(Boolean) ?? text).trim();
