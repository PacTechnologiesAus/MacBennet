import { desc, eq } from 'drizzle-orm';
import {
  emptyBriefContent,
  handoffBriefContentSchema,
  projectContextSnapshotSchema,
  type DiscoveryMessageDto,
  type DiscoverySessionDto,
  type DiscoveryStatus,
  type HandoffBriefContent,
  type ModelBriefStructure,
  type ProjectContextSnapshot,
} from '@mac/protocol';
import { db, type DbHandle } from '../db/client.js';
import { discoverySessions, handoffBriefs, projects, tasks } from '../db/schema.js';
import type { DiscoverySessionRow } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { analyseGaps } from '../domain/gap-analysis.js';
import { briefDto, createBrief, requireBriefRow } from './briefs.js';
import { record, type Actor } from './audit.js';
import { getSettings } from './settings.js';
import { structureBriefWithModel } from './model/resolvers.js';
import { contextRefFor, requireActiveRevision } from './company-context/service.js';
import { recordContextBinding } from './company-context/bindings.js';

/**
 * Discovery (Sprint 2 §5, spec §4).
 *
 * The shape of the interaction, and why it is in this order:
 *
 *   A  the human explicitly selects the project — Mac never infers it;
 *   B  Mac inspects the repository BEFORE asking anything;
 *   C  the human talks freely and Mac only listens;
 *   D  Mac converts the conversation into a structured brief;
 *   E  Mac asks about what is still missing, one question at a time.
 *
 * B comes before E on purpose. That ordering is the mechanism behind "do not
 * ask the human what the repository can tell you": by the time gap analysis
 * runs, the inspected context is available to mark dimensions as discoverable,
 * and a discoverable dimension is never put to a person.
 */

const asMessages = (value: unknown): DiscoveryMessageDto[] =>
  Array.isArray(value) ? (value as DiscoveryMessageDto[]) : [];

export async function discoverySessionDto(
  row: DiscoverySessionRow,
  handle: DbHandle = db,
): Promise<DiscoverySessionDto> {
  const [context] = await handle
    .select({ projectName: projects.name, taskTitle: tasks.title })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, row.taskId))
    .limit(1);

  return {
    id: row.id,
    projectId: row.projectId,
    projectName: context?.projectName ?? '',
    taskId: row.taskId,
    taskTitle: context?.taskTitle ?? '',
    status: row.status as DiscoveryStatus,
    messages: asMessages(row.messages),
    contextSummary: row.contextSummary,
    contextInspectedAt: row.contextInspectedAt?.toISOString() ?? null,
    briefId: row.briefId,
    pendingQuestion: (row.pendingQuestion as DiscoverySessionDto['pendingQuestion']) ?? null,
    companyContext: await contextRefFor(row.companyContextRevisionId, handle),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function requireSessionRow(id: string, handle: DbHandle = db): Promise<DiscoverySessionRow> {
  const [row] = await handle.select().from(discoverySessions).where(eq(discoverySessions.id, id)).limit(1);
  if (!row) throw AppError.notFound('Discovery session');
  return row;
}

export async function getDiscoverySession(id: string): Promise<DiscoverySessionDto> {
  return discoverySessionDto(await requireSessionRow(id));
}

export async function listDiscoverySessions(filter: { projectId?: string; taskId?: string } = {}): Promise<DiscoverySessionDto[]> {
  const rows = await db
    .select()
    .from(discoverySessions)
    .where(
      filter.taskId
        ? eq(discoverySessions.taskId, filter.taskId)
        : filter.projectId
          ? eq(discoverySessions.projectId, filter.projectId)
          : undefined,
    )
    .orderBy(desc(discoverySessions.createdAt))
    .limit(100);

  return Promise.all(rows.map((row) => discoverySessionDto(row)));
}

/**
 * Step A — project selection.
 *
 * The project id is required, and there is no code path that guesses it. Spec
 * §5 Step A: "Mac does not infer the project when multiple projects are
 * available."
 */
export async function startDiscovery(
  input: { projectId: string; taskId?: string; title?: string },
  actor: Actor,
): Promise<DiscoverySessionDto> {
  /*
   * Sprint 3.2 section 9.2: a new discovery session is exactly the moment to
   * check for newer approved company context.
   *
   * Resolved before the transaction opens - it may talk to GitHub, and holding
   * a database connection across a network round trip is pointless. Throws when
   * company context is required but unavailable, so a discovery session can
   * never be started with PAC policy silently absent.
   */
  const companyContext = await requireActiveRevision('discovery.start');

  return db.transaction(async (tx) => {
    const [project] = await tx.select().from(projects).where(eq(projects.id, input.projectId)).limit(1);
    if (!project) throw AppError.notFound('Project');
    if (!project.isActive) throw AppError.conflict('PROJECT_INACTIVE', 'That project is not active.');

    let taskId = input.taskId;
    if (!taskId) {
      if (!input.title) {
        throw AppError.badRequest('TASK_REQUIRED', 'Supply either an existing taskId or a title for a new task.');
      }
      const [task] = await tx
        .insert(tasks)
        .values({ projectId: input.projectId, title: input.title, status: 'draft', createdBy: actor.id })
        .returning();
      if (!task) throw new AppError(500, 'TASK_CREATE_FAILED', 'Could not create the task.');
      taskId = task.id;

      await record(tx, {
        actor,
        eventType: 'task.created',
        context: { projectId: input.projectId, taskId },
        metadata: { title: input.title, via: 'discovery' },
      });
    } else {
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
      if (!task) throw AppError.notFound('Task');
      if (task.projectId !== input.projectId) {
        throw AppError.badRequest('TASK_PROJECT_MISMATCH', 'That task does not belong to the selected project.');
      }
    }

    const [row] = await tx
      .insert(discoverySessions)
      .values({
        projectId: input.projectId,
        taskId,
        status: 'open',
        messages: [],
        companyContextRevisionId: companyContext?.id ?? null,
        createdBy: actor.id,
      })
      .returning();
    if (!row) throw new AppError(500, 'DISCOVERY_CREATE_FAILED', 'Could not start discovery.');

    await record(tx, {
      actor,
      eventType: 'discovery.started',
      context: { projectId: input.projectId, taskId },
      metadata: {
        discoverySessionId: row.id,
        companyContextSha: companyContext?.commitSha ?? null,
      },
    });

    await recordContextBinding(tx, {
      actor,
      discoverySessionId: row.id,
      projectId: input.projectId,
      taskId,
      revision: companyContext,
    });

    return discoverySessionDto(row, tx);
  });
}

/**
 * Step B — context inspection.
 *
 * The snapshot is produced by the worker (it holds the clone) and posted here.
 * Keeping inspection on the worker preserves Sprint 1's property that the
 * control plane never reaches into the VM.
 */
export async function recordContextSnapshot(
  sessionId: string,
  snapshot: ProjectContextSnapshot,
  actor: Actor,
  handle?: DbHandle,
): Promise<DiscoverySessionDto> {
  const run = async (tx: DbHandle) => {
    const session = await requireSessionRow(sessionId, tx);
    const parsed = projectContextSnapshotSchema.parse(snapshot);
    const summary = summariseContext(parsed);

    const [row] = await tx
      .update(discoverySessions)
      .set({
        contextSnapshot: parsed,
        contextSummary: summary,
        contextInspectedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(discoverySessions.id, sessionId))
      .returning();
    if (!row) throw AppError.notFound('Discovery session');

    await record(tx, {
      actor,
      eventType: 'discovery.context_inspected',
      context: { projectId: session.projectId, taskId: session.taskId },
      metadata: {
        discoverySessionId: sessionId,
        headSha: parsed.headSha,
        fileCount: parsed.fileCount,
        branches: parsed.branches.length,
        recentCommits: parsed.recentCommits.length,
        changedSinceLastInvolvement: parsed.changedSinceLastInvolvement?.commitCount ?? null,
      },
    });

    return discoverySessionDto(row, tx);
  };

  return handle ? run(handle) : db.transaction(run);
}

/**
 * A short, human-readable account of what Mac actually looked at.
 *
 * This is what the human sees before being asked anything, and it is the reason
 * the first question does not feel like a form: it demonstrates that Mac did
 * his own reading first.
 */
export function summariseContext(snapshot: ProjectContextSnapshot): string {
  const parts: string[] = [];
  parts.push(`Inspected the repository at ${snapshot.headSha.slice(0, 8)} on ${snapshot.defaultBranch}.`);
  parts.push(`${snapshot.fileCount} file(s)${snapshot.languages.length ? `, mostly ${snapshot.languages.slice(0, 3).join('/')}` : ''}.`);
  if (snapshot.packageManifests.length) {
    parts.push(`${snapshot.packageManifests.length} package manifest(s); scripts available: ${
      Array.from(new Set(snapshot.packageManifests.flatMap((m) => m.scripts))).slice(0, 8).join(', ') || 'none'
    }.`);
  }
  if (snapshot.testPaths.length) parts.push(`Tests in ${snapshot.testPaths.slice(0, 4).join(', ')}.`);
  if (snapshot.docFiles.length) parts.push(`Documentation: ${snapshot.docFiles.slice(0, 5).join(', ')}.`);
  if (snapshot.branches.length) parts.push(`${snapshot.branches.length} branch(es).`);
  if (snapshot.recentCommits.length) {
    parts.push(`Most recent commit: "${snapshot.recentCommits[0]!.subject}" by ${snapshot.recentCommits[0]!.author}.`);
  }
  if (snapshot.changedSinceLastInvolvement) {
    const c = snapshot.changedSinceLastInvolvement;
    parts.push(
      `Since Mac last worked here (${c.sinceSha.slice(0, 8)}): ${c.commitCount} commit(s) touching ${c.files.length} file(s).`,
    );
  } else {
    parts.push('Mac has not worked in this repository before.');
  }
  return parts.join(' ');
}

/**
 * Step C — free-flow conversation.
 *
 * Mac records what he is told and does not interrogate. The only reply he makes
 * here is an acknowledgement; questions are Step E and happen once, after the
 * brief exists.
 */
export async function addDiscoveryMessage(
  sessionId: string,
  input: { message: string },
  actor: Actor,
): Promise<DiscoverySessionDto> {
  return db.transaction(async (tx) => {
    const session = await requireSessionRow(sessionId, tx);
    if (session.status === 'closed') {
      throw AppError.conflict('DISCOVERY_CLOSED', 'This discovery session is closed.');
    }

    const messages = asMessages(session.messages);
    const pending = session.pendingQuestion as { id: string; question: string; dimension: string } | null;

    messages.push({
      role: 'human',
      message: input.message,
      at: new Date().toISOString(),
      // When Mac had asked something, this message is the answer to it.
      ...(pending ? { questionId: pending.id } : {}),
    });

    // If this answered a pending question, fold it into the brief so the
    // confidence actually moves.
    if (pending && session.briefId) {
      const { answerBriefQuestion } = await import('./briefs.js');
      await answerBriefQuestion(session.briefId, { questionId: pending.id, answer: input.message }, actor).catch(() => {
        // A brief that no longer has that question is not an error worth
        // failing the conversation over; the message is still recorded.
      });
    }

    const [row] = await tx
      .update(discoverySessions)
      .set({ messages, pendingQuestion: null, updatedAt: new Date() })
      .where(eq(discoverySessions.id, sessionId))
      .returning();
    if (!row) throw AppError.notFound('Discovery session');

    await record(tx, {
      actor,
      eventType: 'discovery.message_recorded',
      context: { projectId: session.projectId, taskId: session.taskId },
      metadata: { discoverySessionId: sessionId, length: input.message.length, answeredQuestionId: pending?.id ?? null },
    });

    return discoverySessionDto(row, tx);
  });
}

/**
 * Step D — structured understanding, then Step E — the next single question.
 *
 * The brief is built from the whole conversation plus the inspected context.
 * The raw conversation is retained on the brief as provenance, but it is the
 * STRUCTURE that a coding agent is later given (spec §12).
 */
export async function generateBrief(
  sessionId: string,
  input: { overrides?: Partial<HandoffBriefContent> },
  actor: Actor,
): Promise<{ session: DiscoverySessionDto; brief: Awaited<ReturnType<typeof briefDto>> }> {
  return db.transaction(async (tx) => {
    const session = await requireSessionRow(sessionId, tx);
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, session.taskId)).limit(1);
    if (!task) throw AppError.notFound('Task');

    const messages = asMessages(session.messages);
    const humanText = messages.filter((m) => m.role === 'human').map((m) => m.message);
    if (humanText.length === 0 && !input.overrides) {
      throw AppError.badRequest(
        'NOTHING_TO_STRUCTURE',
        'There is no conversation to structure yet. Describe the work first.',
      );
    }

    const conversation = humanText.join('\n\n');
    const snapshot = session.contextSnapshot
      ? projectContextSnapshotSchema.parse(session.contextSnapshot)
      : null;

    const derived = structureConversation(task.title, conversation);

    /*
     * Sprint 3: a model may help structure the free-flow brief.
     *
     * It runs ALONGSIDE the deterministic structurer, never instead of it, and
     * only fills fields the sentence classifier left empty. Two properties keep
     * that safe:
     *
     *   1. every string it returns must share distinctive vocabulary with what
     *      the engineer actually said, or it is dropped — because a field the
     *      model invented would go on to raise the understanding confidence
     *      that decides whether Mac may execute at all;
     *   2. an operator override still wins over both, so a human correcting the
     *      brief is never argued with.
     */
    const settings = await getSettings(tx);
    let modelStructure: Partial<HandoffBriefContent> = {};
    if (settings.modelAssistEnabled) {
      const outcome = await structureBriefWithModel(task.title, conversation).catch(() => null);
      if (outcome?.structure) {
        modelStructure = onlyEmptyFields(derived, outcome.structure);
      }
      if (outcome) {
        await record(tx, {
          actor,
          eventType: outcome.structure ? 'model.assisted_discovery' : 'model.output_rejected',
          context: { projectId: session.projectId, taskId: session.taskId },
          metadata: {
            discoverySessionId: sessionId,
            provider: outcome.record.provider,
            model: outcome.record.model,
            outcome: outcome.record.outcome,
            inputTokens: outcome.record.inputTokens,
            outputTokens: outcome.record.outputTokens,
            // Fields the model produced that nothing in the conversation
            // supported. The number worth watching.
            ungroundedFieldsDropped: outcome.record.fabricatedCitations,
            fieldsFilled: Object.keys(modelStructure),
          },
        });
      }
    }

    const content = handoffBriefContentSchema.parse({
      ...derived,
      ...modelStructure,
      ...(input.overrides ?? {}),
    });

    const brief = await createBrief(
      {
        taskId: session.taskId,
        projectId: session.projectId,
        content,
        sourceConversation: conversation,
        contextSummary: session.contextSummary,
        contextSnapshot: snapshot,
        // The SESSION's revision, not whatever is active now: a brief belongs to
        // the discovery that produced it, and a company commit landing between
        // the conversation and the structuring must not silently re-govern it.
        companyContextRevisionId: session.companyContextRevisionId,
      },
      actor,
      tx,
    );

    // Step E: pick the ONE next question. Never a batch.
    const analysis = analyseGaps(brief.content, snapshot);
    const next = analysis.nextQuestion;
    const updatedMessages = [...messages];

    if (next) {
      updatedMessages.push({
        role: 'mac',
        message: next.question,
        at: new Date().toISOString(),
        questionId: `gap-${next.dimension}`,
      });
    }

    const [row] = await tx
      .update(discoverySessions)
      .set({
        briefId: brief.id,
        status: next ? 'brief_drafted' : 'ready',
        messages: updatedMessages,
        pendingQuestion: next ? { id: `gap-${next.dimension}`, question: next.question, dimension: next.dimension } : null,
        updatedAt: new Date(),
      })
      .where(eq(discoverySessions.id, sessionId))
      .returning();
    if (!row) throw AppError.notFound('Discovery session');

    if (next) {
      await record(tx, {
        actor,
        eventType: 'discovery.question_asked',
        context: { projectId: session.projectId, taskId: session.taskId },
        metadata: { discoverySessionId: sessionId, dimension: next.dimension, question: next.question },
      });
    }

    return { session: await discoverySessionDto(row, tx), brief };
  });
}

/**
 * Turns free-flow prose into the structured fields.
 *
 * Deliberately mechanical, and honest about it: it splits the conversation on
 * the cues engineers actually use ("at the moment", "we need", "don't change")
 * and files each fragment under the field it belongs to. Anything it cannot
 * classify goes to the objective, so nothing the human said is lost.
 *
 * What this must NOT do is invent content. A field it cannot fill stays empty,
 * which lowers confidence and produces a question — the correct outcome. An
 * LLM-backed structurer can replace this function without touching anything
 * else; the surrounding gap analysis and confidence rules are what keep it safe.
 */
export function structureConversation(title: string, conversation: string): HandoffBriefContent {
  const base = emptyBriefContent(title);
  if (!conversation.trim()) return base;

  const sentences = conversation
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const currentBehaviour: string[] = [];
  const desiredBehaviour: string[] = [];
  const constraints: string[] = [];
  const mustNotChange: string[] = [];
  const acceptance: string[] = [];
  const testing: string[] = [];
  const components: string[] = [];
  const objective: string[] = [];

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();

    const forbidden = extractMustNotChange(sentence);
    if (forbidden) {
      // The whole sentence is the constraint a human should read; the extracted
      // NOUN is what "must not change" means to the review, which compares it
      // against changed file paths. Storing the sentence in both places would
      // make that comparison useless.
      mustNotChange.push(forbidden);
      constraints.push(sentence);
      continue;
    }
    if (/\b(at the moment|currently|today|right now|as it stands|existing behaviour)\b/.test(lower)) {
      currentBehaviour.push(sentence);
      continue;
    }
    if (/\b(should|needs? to|want|must be able|so that|make it|change it so)\b/.test(lower)) {
      desiredBehaviour.push(sentence);
      continue;
    }
    if (/\b(done when|acceptance|accept(ed)? if|success(ful)? when|verify that)\b/.test(lower)) {
      acceptance.push(sentence);
      continue;
    }
    if (/\b(test|tests|testing|coverage|unit test|integration test)\b/.test(lower)) {
      testing.push(sentence);
      continue;
    }
    if (/\b(because|since|must|has to|required|constraint|deadline|compatib)\b/.test(lower)) {
      constraints.push(sentence);
      continue;
    }
    if (/\b(screen|page|component|endpoint|api|route|service|module|table|schema)\b/.test(lower)) {
      components.push(sentence);
      desiredBehaviour.push(sentence);
      continue;
    }
    objective.push(sentence);
  }

  return handoffBriefContentSchema.parse({
    ...base,
    userObjective: [objective.join(' '), desiredBehaviour.join(' ')].filter(Boolean).join(' ').trim() || conversation.slice(0, 3000),
    currentBehaviour: currentBehaviour.join(' '),
    desiredBehaviour: desiredBehaviour.join(' '),
    constraints: dedupe(constraints),
    mustNotChange: dedupe(mustNotChange),
    acceptanceCriteria: dedupe(acceptance),
    testingExpectations: dedupe(testing),
    likelyAffectedComponents: dedupe(components),
    proposedScope: desiredBehaviour.join(' ') || objective.join(' '),
  });
}

/**
 * Pulls the THING that must not change out of a sentence about it.
 *
 * "don't change the existing import format because customers are using it"
 * yields "existing import format", not the whole sentence. That matters
 * downstream: the self-review compares each `mustNotChange` entry against the
 * paths of changed files, and a full sentence never matches a path — the check
 * would exist but never fire.
 *
 * Returns null when the sentence does not actually name something, in which
 * case the caller keeps it as an ordinary constraint.
 */
export function extractMustNotChange(sentence: string): string | null {
  const match = sentence.match(
    /\b(?:don'?t|do not|must not|never|avoid|without)\s+(?:chang\w*|touch\w*|modify\w*|alter\w*|break\w*)\s+(?:the\s+|any\s+|our\s+|its\s+)?([^,.;:]+?)(?:\s+(?:because|since|as|so)\b|[,.;:]|$)/i,
  );

  const captured = match?.[1]?.trim();
  if (!captured || captured.length < 3 || captured.length > 120) return null;
  return captured;
}

const dedupe = (items: string[]): string[] => Array.from(new Set(items.map((i) => i.trim()))).filter(Boolean).slice(0, 40);

/**
 * Model output may only fill gaps, never overwrite.
 *
 * The deterministic structurer put a sentence in a field because the engineer
 * wrote that sentence. A model rephrasing it might be tidier and might also be
 * subtly different, and "subtly different from what the human said" is exactly
 * the failure this whole arrangement is built to avoid. So a field the
 * classifier already filled is left alone.
 */
function onlyEmptyFields(
  derived: HandoffBriefContent,
  structure: ModelBriefStructure,
): Partial<HandoffBriefContent> {
  const patch: Partial<HandoffBriefContent> = {};

  const fillText = (key: 'userObjective' | 'currentBehaviour' | 'desiredBehaviour' | 'proposedScope') => {
    const value = structure[key];
    if (value && !derived[key]?.trim()) patch[key] = value;
  };

  const fillList = (
    key: 'constraints' | 'mustNotChange' | 'acceptanceCriteria' | 'testingExpectations' | 'likelyAffectedComponents' | 'outOfScope',
  ) => {
    const value = structure[key];
    if (value?.length && derived[key].length === 0) patch[key] = dedupe(value);
  };

  fillText('userObjective');
  fillText('currentBehaviour');
  fillText('desiredBehaviour');
  fillText('proposedScope');
  fillList('constraints');
  fillList('mustNotChange');
  fillList('acceptanceCriteria');
  fillList('testingExpectations');
  fillList('likelyAffectedComponents');
  fillList('outOfScope');

  return patch;
}

export async function closeDiscovery(sessionId: string, actor: Actor): Promise<DiscoverySessionDto> {
  return db.transaction(async (tx) => {
    const session = await requireSessionRow(sessionId, tx);
    if (session.briefId) {
      const brief = await requireBriefRow(session.briefId, tx);
      await tx.update(handoffBriefs).set({ status: 'ready', updatedAt: new Date() }).where(eq(handoffBriefs.id, brief.id));
    }
    const [row] = await tx
      .update(discoverySessions)
      .set({ status: 'ready', pendingQuestion: null, updatedAt: new Date() })
      .where(eq(discoverySessions.id, sessionId))
      .returning();
    if (!row) throw AppError.notFound('Discovery session');

    await record(tx, {
      actor,
      eventType: 'discovery.message_recorded',
      context: { projectId: session.projectId, taskId: session.taskId },
      metadata: { discoverySessionId: sessionId, closed: true },
    });

    return discoverySessionDto(row, tx);
  });
}
