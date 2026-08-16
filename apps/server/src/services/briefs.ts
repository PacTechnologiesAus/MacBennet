import { and, desc, eq } from 'drizzle-orm';
import {
  handoffBriefContentSchema,
  renderBriefMarkdown,
  type BriefDto,
  type BriefStatus,
  type CompletenessDto,
  type HandoffBriefContent,
  type ProjectContextSnapshot,
} from '@mac/protocol';
import { db, type DbHandle } from '../db/client.js';
import { handoffBriefs } from '../db/schema.js';
import type { HandoffBriefRow } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { adviseExecution, parseConfidence } from '../domain/confidence.js';
import { analyseGaps, deriveFromContext } from '../domain/gap-analysis.js';
import { getSettings, toConfidencePolicy } from './settings.js';
import { record, type Actor } from './audit.js';

/**
 * The handoff brief (Sprint 2 §6).
 *
 * Understanding confidence is never supplied by a caller. It is recomputed from
 * the brief's own content every time the brief changes, so the number that
 * decides whether autonomous execution is permitted cannot be set by whoever
 * wants the execution to happen.
 */

export async function briefDto(row: HandoffBriefRow, handle: DbHandle = db): Promise<BriefDto> {
  const content = handoffBriefContentSchema.parse(row.content);
  const settings = await getSettings(handle);
  const policy = toConfidencePolicy(settings);
  const confidence = parseConfidence(row.confidence) ?? 0;
  const analysis = analyseGaps(content, (row as { contextSnapshot?: ProjectContextSnapshot }).contextSnapshot ?? null);
  const advice = adviseExecution(confidence, policy);

  const completeness: CompletenessDto[] = analysis.assessments.map((a) => ({
    dimension: a.dimension,
    satisfied: a.satisfied,
    weight: a.weight,
    discoverableFrom: a.discoverableFrom,
    question: a.question,
  }));

  return {
    id: row.id,
    taskId: row.taskId,
    projectId: row.projectId,
    version: row.version,
    status: row.status as BriefStatus,
    content,
    markdown: renderBriefMarkdown(content, { confidence }),
    confidence,
    confidenceBand: advice.band,
    completeness,
    executionAdvice: {
      executionPermitted: advice.executionPermitted,
      scopeKind: advice.scopeKind,
      requiresExplicitScopeApproval: advice.requiresExplicitScopeApproval,
      message: advice.message,
    },
    contextSummary: row.contextSummary,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function requireBriefRow(id: string, handle: DbHandle = db): Promise<HandoffBriefRow> {
  const [row] = await handle.select().from(handoffBriefs).where(eq(handoffBriefs.id, id)).limit(1);
  if (!row) throw AppError.notFound('Handoff brief');
  return row;
}

export async function getBrief(id: string): Promise<BriefDto> {
  return briefDto(await requireBriefRow(id));
}

export async function latestBriefForTask(taskId: string): Promise<BriefDto | null> {
  const [row] = await db
    .select()
    .from(handoffBriefs)
    .where(eq(handoffBriefs.taskId, taskId))
    .orderBy(desc(handoffBriefs.version))
    .limit(1);
  return row ? briefDto(row) : null;
}

/**
 * Creates a brief, deriving whatever the inspected repository can supply and
 * computing understanding confidence from the result.
 */
export async function createBrief(
  input: {
    taskId: string;
    projectId: string;
    content: HandoffBriefContent;
    sourceConversation: string;
    contextSummary?: string | null;
    contextSnapshot?: ProjectContextSnapshot | null;
  },
  actor: Actor,
  handle?: DbHandle,
): Promise<BriefDto> {
  const run = async (tx: DbHandle) => {
    // Merge in what the repository already answered, so gap analysis subtracts
    // it and Mac does not put those questions to the human.
    const merged: HandoffBriefContent = input.contextSnapshot
      ? handoffBriefContentSchema.parse({ ...input.content, ...withoutOverwriting(input.content, deriveFromContext(input.contextSnapshot)) })
      : input.content;

    const analysis = analyseGaps(merged, input.contextSnapshot ?? null);

    // Unanswered gaps become the brief's open questions, so the artefact itself
    // records what is still unknown rather than hiding it behind a number.
    const withQuestions: HandoffBriefContent = handoffBriefContentSchema.parse({
      ...merged,
      openQuestions: [
        ...merged.openQuestions,
        ...analysis.assessments
          .filter((a) => !a.satisfied && !merged.openQuestions.some((q) => q.dimension === a.dimension))
          .map((a) => ({
            id: `gap-${a.dimension}`,
            question: a.question,
            dimension: a.dimension,
            discoverableFrom: a.discoverableFrom,
            answer: null,
            answeredAt: null,
            answeredBy: null,
          })),
      ],
    });

    const [previous] = await tx
      .select({ version: handoffBriefs.version })
      .from(handoffBriefs)
      .where(eq(handoffBriefs.taskId, input.taskId))
      .orderBy(desc(handoffBriefs.version))
      .limit(1);

    // A new version supersedes the old rather than overwriting it: the brief a
    // run was approved against must remain readable after the brief moves on.
    if (previous) {
      await tx
        .update(handoffBriefs)
        .set({ status: 'superseded', updatedAt: new Date() })
        .where(and(eq(handoffBriefs.taskId, input.taskId), eq(handoffBriefs.status, 'draft')));
    }

    const [row] = await tx
      .insert(handoffBriefs)
      .values({
        taskId: input.taskId,
        projectId: input.projectId,
        version: (previous?.version ?? 0) + 1,
        status: 'draft',
        content: withQuestions,
        confidence: analysis.confidence.toFixed(3),
        sourceConversation: input.sourceConversation,
        contextSummary: input.contextSummary ?? null,
        createdBy: actor.id,
      })
      .returning();
    if (!row) throw new AppError(500, 'BRIEF_CREATE_FAILED', 'Could not create the handoff brief.');

    await record(tx, {
      actor,
      eventType: 'brief.created',
      context: { projectId: input.projectId, taskId: input.taskId },
      metadata: { briefId: row.id, version: row.version, confidence: analysis.confidence },
    });

    await record(tx, {
      actor,
      eventType: 'brief.confidence_calculated',
      context: { projectId: input.projectId, taskId: input.taskId },
      metadata: {
        briefId: row.id,
        confidence: analysis.confidence,
        // The whole checklist, so the number can be audited rather than trusted.
        dimensions: analysis.assessments.map((a) => ({
          dimension: a.dimension,
          satisfied: a.satisfied,
          weight: a.weight,
          discoverableFrom: a.discoverableFrom,
        })),
      },
    });

    return briefDto(row, tx);
  };

  return handle ? run(handle) : db.transaction(run);
}

/** Only fills fields the human left empty; never overwrites what they said. */
function withoutOverwriting(
  content: HandoffBriefContent,
  derived: Partial<HandoffBriefContent>,
): Partial<HandoffBriefContent> {
  const result: Partial<HandoffBriefContent> = {};
  for (const [key, value] of Object.entries(derived) as Array<[keyof HandoffBriefContent, unknown]>) {
    const existing = content[key];
    const isEmpty = Array.isArray(existing) ? existing.length === 0 : !existing || String(existing).trim() === '';
    if (isEmpty) (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

/**
 * Applies an operator's edits and RECOMPUTES confidence.
 *
 * Confidence is deliberately not patchable: it is a function of the brief, so
 * that nobody — human or agent — can raise it by asserting it.
 */
export async function updateBrief(
  id: string,
  patch: Partial<HandoffBriefContent>,
  actor: Actor,
  handle?: DbHandle,
): Promise<BriefDto> {
  const run = async (tx: DbHandle) => {
    const existing = await requireBriefRow(id, tx);
    if (existing.status === 'superseded') {
      throw AppError.conflict('BRIEF_SUPERSEDED', 'This brief has been superseded by a newer version.');
    }

    const current = handoffBriefContentSchema.parse(existing.content);
    const merged = handoffBriefContentSchema.parse({ ...current, ...patch });
    const analysis = analyseGaps(merged, null);

    const [row] = await tx
      .update(handoffBriefs)
      .set({ content: merged, confidence: analysis.confidence.toFixed(3), updatedAt: new Date() })
      .where(eq(handoffBriefs.id, id))
      .returning();
    if (!row) throw AppError.notFound('Handoff brief');

    await record(tx, {
      actor,
      eventType: 'brief.updated',
      context: { projectId: row.projectId, taskId: row.taskId },
      metadata: {
        briefId: row.id,
        changed: Object.keys(patch),
        confidence: { from: parseConfidence(existing.confidence), to: analysis.confidence },
      },
    });

    return briefDto(row, tx);
  };

  return handle ? run(handle) : db.transaction(run);
}

/**
 * Records a human's answer to one of the brief's open questions, then
 * recomputes confidence — which is how answering a question actually moves the
 * run toward being executable.
 */
export async function answerBriefQuestion(
  id: string,
  input: { questionId: string; answer: string },
  actor: Actor,
): Promise<BriefDto> {
  return db.transaction(async (tx) => {
    const existing = await requireBriefRow(id, tx);
    const content = handoffBriefContentSchema.parse(existing.content);

    const question = content.openQuestions.find((q) => q.id === input.questionId);
    if (!question) throw AppError.notFound('Question');

    const answeredAt = new Date().toISOString();
    const updated: HandoffBriefContent = {
      ...content,
      openQuestions: content.openQuestions.map((q) =>
        q.id === input.questionId ? { ...q, answer: input.answer, answeredAt, answeredBy: actor.label } : q,
      ),
    };

    // The answer must actually land in the brief field the question was about,
    // otherwise answering a question would raise nothing and Mac would ask it
    // again on the next pass.
    const enriched = applyAnswerToDimension(updated, question.dimension, input.answer);
    const analysis = analyseGaps(enriched, null);

    const [row] = await tx
      .update(handoffBriefs)
      .set({ content: enriched, confidence: analysis.confidence.toFixed(3), updatedAt: new Date() })
      .where(eq(handoffBriefs.id, id))
      .returning();
    if (!row) throw AppError.notFound('Handoff brief');

    await record(tx, {
      actor,
      eventType: 'discovery.question_answered',
      context: { projectId: row.projectId, taskId: row.taskId },
      metadata: {
        briefId: row.id,
        questionId: input.questionId,
        dimension: question.dimension,
        confidence: { from: parseConfidence(existing.confidence), to: analysis.confidence },
      },
    });

    return briefDto(row, tx);
  });
}

/** Maps a completeness dimension onto the brief field it is asking about. */
export function applyAnswerToDimension(
  content: HandoffBriefContent,
  dimension: string,
  answer: string,
): HandoffBriefContent {
  const append = (existing: string) => (existing.trim() ? `${existing.trim()}\n${answer.trim()}` : answer.trim());
  const add = (existing: string[]) => [...existing, answer.trim()];

  switch (dimension) {
    case 'problem':
    case 'user_outcome':
      return { ...content, userObjective: append(content.userObjective) };
    case 'current_behaviour':
      return { ...content, currentBehaviour: append(content.currentBehaviour) };
    case 'desired_behaviour':
      return { ...content, desiredBehaviour: append(content.desiredBehaviour) };
    case 'architecture':
      return { ...content, relevantArchitecture: append(content.relevantArchitecture) };
    case 'constraints':
      return { ...content, constraints: add(content.constraints) };
    case 'acceptance_criteria':
      return { ...content, acceptanceCriteria: add(content.acceptanceCriteria) };
    case 'testing':
      return { ...content, testingExpectations: add(content.testingExpectations) };
    case 'must_not_change':
      return { ...content, mustNotChange: add(content.mustNotChange) };
    case 'affected_components':
      return { ...content, likelyAffectedComponents: add(content.likelyAffectedComponents) };
    default:
      return { ...content, implementationConsiderations: add(content.implementationConsiderations) };
  }
}

export async function markBriefStatus(id: string, status: BriefStatus, handle: DbHandle = db): Promise<void> {
  await handle.update(handoffBriefs).set({ status, updatedAt: new Date() }).where(eq(handoffBriefs.id, id));
}
