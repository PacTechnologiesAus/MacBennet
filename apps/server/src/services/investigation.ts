import { and, desc, eq, isNotNull, ne } from 'drizzle-orm';
import {
  capUngroundedConfidence,
  deriveGroundedness,
  handoffBriefContentSchema,
  projectContextSnapshotSchema,
  type EvidenceRef,
  type InvestigationDto,
  type InvestigationResult,
  type ProjectContextSnapshot,
} from '@mac/protocol';
import { db, type DbHandle } from '../db/client.js';
import {
  agentQuestions,
  discoveryInvestigations,
  discoverySessions,
  handoffBriefs,
  mondayItems,
  runs,
  tasks,
} from '../db/schema.js';
import { parseConfidence } from '../domain/confidence.js';
import { consultedSources, investigate, type InvestigationSources } from '../domain/investigation.js';
import { memoryForTask } from './memory.js';
import { clientForBoard } from './monday/provider.js';
import { mondayItemForTask } from './monday/outbox.js';
import { record, type Actor } from './audit.js';
import { resolveAnswerWithModel } from './model/resolvers.js';

/**
 * Gathering the six source classes, and recording what was checked (Sprint 3 §6).
 *
 * The domain function does the reasoning and has no I/O. This file does the I/O
 * and persists the receipt. Splitting them that way means the rule "Mac must
 * exhaust his own sources before asking a person" is tested without a database,
 * and the evidence that he did so is durable.
 */

export interface InvestigationContext {
  taskId: string;
  projectId: string;
  runId?: string | null;
  discoverySessionId?: string | null;
}

/**
 * Every source Mac is entitled to read for this task.
 *
 * Note the scoping: task memory is fetched for THIS task, previous runs are
 * scoped to this PROJECT, and the monday context comes from the item linked to
 * this task. Another task's assumptions are structurally unreachable, which is
 * spec §9's requirement that task memory must not contaminate unrelated tasks.
 */
export async function gatherSources(
  context: InvestigationContext,
  handle: DbHandle = db,
): Promise<InvestigationSources> {
  const [brief] = await handle
    .select()
    .from(handoffBriefs)
    .where(eq(handoffBriefs.taskId, context.taskId))
    .orderBy(desc(handoffBriefs.version))
    .limit(1);

  const memory = await memoryForTask({ projectId: context.projectId, taskId: context.taskId }, handle);

  const [discovery] = await handle
    .select({ snapshot: discoverySessions.contextSnapshot })
    .from(discoverySessions)
    .where(eq(discoverySessions.taskId, context.taskId))
    .limit(1);

  let repositoryContext: ProjectContextSnapshot | null = null;
  if (discovery?.snapshot) {
    const parsed = projectContextSnapshotSchema.safeParse(discovery.snapshot);
    if (parsed.success) repositoryContext = parsed.data;
  }

  /*
   * What Mac decided on earlier runs IN THIS PROJECT.
   *
   * Excludes the current run: an answer Mac gave five minutes ago is not
   * independent evidence for the same answer now, and treating it as such would
   * let a single guess bootstrap itself into a confident fact.
   */
  const previousRuns = await handle
    .select({
      runId: agentQuestions.runId,
      question: agentQuestions.question,
      answer: agentQuestions.answer,
      confidence: agentQuestions.confidence,
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

  const previousBriefs = await handle
    .select({ id: handoffBriefs.id, content: handoffBriefs.content, taskId: handoffBriefs.taskId })
    .from(handoffBriefs)
    .where(and(eq(handoffBriefs.projectId, context.projectId), ne(handoffBriefs.taskId, context.taskId)))
    .orderBy(desc(handoffBriefs.updatedAt))
    .limit(10);

  const previousBriefSources: InvestigationSources['previousBriefs'] = [];
  for (const previous of previousBriefs) {
    const parsed = handoffBriefContentSchema.safeParse(previous.content);
    if (!parsed.success) continue;
    // Only the durable parts: a constraint or a must-not-change from another
    // task in the same project is a fact about the codebase. Its objective is
    // about a different piece of work and would only add noise.
    parsed.data.constraints.forEach((text, i) =>
      previousBriefSources.push({ briefId: previous.id, label: `earlier brief: constraint[${i}]`, text }),
    );
    parsed.data.mustNotChange.forEach((text, i) =>
      previousBriefSources.push({
        briefId: previous.id,
        label: `earlier brief: must not change[${i}]`,
        text: `Must not change: ${text}`,
      }),
    );
  }

  return {
    brief: brief ? handoffBriefContentSchema.parse(brief.content) : null,
    repositoryContext,
    projectMemory: memory
      .filter((m) => m.scope === 'project' || m.scope === 'global')
      .map((m) => ({ key: m.key, value: m.value, confidence: m.confidence })),
    taskMemory: memory
      .filter((m) => m.scope === 'task')
      .map((m) => ({ key: m.key, value: m.value, confidence: m.confidence })),
    previousRuns: previousRuns
      .filter((r) => r.answer !== null)
      .map((r) => ({
        runId: r.runId,
        question: r.question,
        answer: r.answer!,
        // An answer Mac merely assumed last week does not become a fact by
        // being repeated, so its own confidence carries forward as a discount.
        confidence: r.groundedness === 'established_fact' ? (parseConfidence(r.confidence) ?? 0.5) : 0.4,
      })),
    previousBriefs: previousBriefSources,
    mondayContext: await gatherMondayContext(context.taskId, handle),
  };
}

/**
 * The monday item's own text and its update feed.
 *
 * This is where a human writes "the CSV header must stay as it is" at 16:00,
 * and Mac reading it at 02:00 instead of asking about it is most of the point
 * of the integration.
 */
async function gatherMondayContext(taskId: string, handle: DbHandle): Promise<Array<{ ref: string; text: string }>> {
  const linked = await mondayItemForTask(taskId, handle);
  if (!linked) return [];

  const out: Array<{ ref: string; text: string }> = [];
  if (linked.item.description) {
    out.push({ ref: `monday:item/${linked.item.itemId}`, text: linked.item.description });
  }

  try {
    const client = await clientForBoard(linked.board);
    const updates = await client.listUpdates(linked.item.itemId, 20);
    for (const update of updates) {
      out.push({ ref: `monday:item/${linked.item.itemId}/update/${update.id}`, text: update.body });
    }
  } catch {
    // A board that is unreachable contributes nothing rather than failing the
    // investigation; `checked` will record that this source was consulted and
    // matched nothing, which is honest.
  }

  return out;
}

// ---------------------------------------------------------------------------
// Running an investigation
// ---------------------------------------------------------------------------

export interface RunInvestigationInput extends InvestigationContext {
  subjectKind: 'dimension' | 'agent_question';
  subject: string;
  contextText?: string | undefined;
  resolveThreshold: number;
  /** When true and a provider is configured, the model may phrase the answer. */
  allowModel?: boolean;
}

/**
 * Investigate, optionally let a model phrase the result, and persist the receipt.
 *
 * The model never changes WHETHER the investigation resolved or HOW confident it
 * is — both come from the deterministic scoring. It may only improve the
 * wording of an answer that was already grounded, and only using sources the
 * deterministic layer supplied.
 */
export async function runInvestigation(
  input: RunInvestigationInput,
  actor: Actor,
): Promise<InvestigationResult> {
  const sources = await gatherSources(input);

  const result = investigate({
    subjectKind: input.subjectKind,
    subject: input.contextText ? `${input.subject}\n${input.contextText}` : input.subject,
    sources,
    resolveThreshold: input.resolveThreshold,
  });

  let modelAssisted = false;
  let answer = result.answer;

  if (input.allowModel && result.evidence.length > 0) {
    const supplied = result.evidence.map((e, index) => ({
      id: `s${index + 1}`,
      label: e.ref,
      text: e.excerpt,
      evidence: e,
    }));

    const outcome = await resolveAnswerWithModel({
      question: input.subject,
      ...(input.contextText ? { context: input.contextText } : {}),
      sources: supplied,
    });

    if (outcome.answer) {
      answer = outcome.answer;
      modelAssisted = true;
    }

    await db.transaction(async (tx) => {
      await record(tx, {
        actor,
        eventType: outcome.answer ? 'model.assisted_answer' : 'model.output_rejected',
        context: { taskId: input.taskId, projectId: input.projectId, runId: input.runId ?? null },
        metadata: {
          subject: input.subject.slice(0, 300),
          provider: outcome.record.provider,
          model: outcome.record.model,
          outcome: outcome.record.outcome,
          inputTokens: outcome.record.inputTokens,
          outputTokens: outcome.record.outputTokens,
          // The number worth watching: a model inventing sources is the failure
          // mode this whole arrangement exists to survive.
          fabricatedCitations: outcome.record.fabricatedCitations,
          detail: outcome.record.detail,
        },
      });
    });
  }

  /*
   * Confidence is recomputed here regardless of what the model did.
   *
   * `capUngroundedConfidence` is applied a second time deliberately: the model
   * path could in principle have produced prose whose grounding is weaker than
   * the deterministic answer's, and the cap is cheap.
   */
  const final: InvestigationResult = {
    ...result,
    answer,
    confidence: capUngroundedConfidence(result.confidence, result.evidence),
    modelAssisted,
  };

  await persistInvestigation(input, final, actor);
  return final;
}

async function persistInvestigation(
  context: RunInvestigationInput,
  result: InvestigationResult,
  actor: Actor,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(discoveryInvestigations).values({
      discoverySessionId: context.discoverySessionId ?? null,
      runId: context.runId ?? null,
      taskId: context.taskId,
      projectId: context.projectId,
      subjectKind: context.subjectKind,
      subject: context.subject.slice(0, 4000),
      resolved: result.resolved,
      answer: result.answer,
      confidence: result.confidence.toFixed(3),
      checked: result.checked,
      evidence: result.evidence,
      escalatedToHuman: result.escalatedToHuman,
      modelAssisted: result.modelAssisted,
    });

    await record(tx, {
      actor,
      eventType: 'discovery.investigation_completed',
      context: { taskId: context.taskId, projectId: context.projectId, runId: context.runId ?? null },
      metadata: {
        subject: context.subject.slice(0, 300),
        resolved: result.resolved,
        confidence: result.confidence,
        // The escalation receipt, in the trail as well as in the table.
        sourcesConsulted: consultedSources(result.checked),
        sourcesMatched: result.checked.filter((c) => c.matched).map((c) => c.source),
        evidence: result.evidence.map((e) => e.ref),
        modelAssisted: result.modelAssisted,
      },
    });

    if (result.escalatedToHuman) {
      await record(tx, {
        actor,
        eventType: 'discovery.escalated_to_human',
        context: { taskId: context.taskId, projectId: context.projectId, runId: context.runId ?? null },
        metadata: {
          subject: context.subject.slice(0, 300),
          // Every source class and what it returned — so "he asked me something
          // he could have looked up" is a claim someone can check.
          checked: result.checked,
        },
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listInvestigations(filter: { taskId?: string; runId?: string }): Promise<InvestigationDto[]> {
  const conditions = [];
  if (filter.taskId) conditions.push(eq(discoveryInvestigations.taskId, filter.taskId));
  if (filter.runId) conditions.push(eq(discoveryInvestigations.runId, filter.runId));

  const rows = await db
    .select()
    .from(discoveryInvestigations)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(discoveryInvestigations.createdAt))
    .limit(200);

  return rows.map((row) => ({
    id: row.id,
    taskId: row.taskId,
    runId: row.runId,
    discoverySessionId: row.discoverySessionId,
    result: {
      subjectKind: row.subjectKind as 'dimension' | 'agent_question',
      subject: row.subject,
      resolved: row.resolved,
      answer: row.answer,
      confidence: parseConfidence(row.confidence) ?? 0,
      evidence: (row.evidence as EvidenceRef[]) ?? [],
      checked: (row.checked as InvestigationResult['checked']) ?? [],
      escalatedToHuman: row.escalatedToHuman,
      modelAssisted: row.modelAssisted,
    },
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Groundedness of an evidence set, for callers persisting an answer. */
export const groundednessFor = (evidence: readonly EvidenceRef[]) => deriveGroundedness(evidence);
