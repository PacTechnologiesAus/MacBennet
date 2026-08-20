import { and, count, desc, eq } from 'drizzle-orm';
import {
  acceptanceCriteriaSchema,
  deriveAcceptanceState,
  describeTaskKind,
  findingSchema,
  handoffBriefContentSchema,
  renderAcceptanceMarkdown,
  semanticJudgementBatchSchema,
  unmetCriteria,
  type AcceptanceCriterion,
  type AcceptanceReviewDto,
  type AcceptanceState,
  type ArtefactType,
  type CriterionResult,
  type Finding,
  type TaskKind,
} from '@mac/protocol';
import { config } from '../config.js';
import { db, type DbHandle } from '../db/client.js';
import {
  auditEvents,
  handoffBriefs,
  projects,
  runAcceptance,
  runArtefacts,
  runReviews,
  runs,
  tasks,
} from '../db/schema.js';
import { AppError } from '../http/errors.js';
import {
  analyseDeliverables,
  compareRequestToBrief,
  contractTextOf,
  deliverableAmbiguityNote,
  deliverableNormalisationNote,
  deriveCriteria,
  evaluateDeterministic,
  unmetResearchCapability,
  type AcceptanceEvidence,
} from '../domain/acceptance.js';
import { record, SYSTEM_ACTOR, type Actor } from './audit.js';
import { getSettings } from './settings.js';
import { getModelProvider } from './model/provider.js';
import { sourceClassesFor } from './research/sources.js';
import { appendSystemLog } from './logs.js';

/**
 * Verifying that the work delivered is the work that was approved (Part F).
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS SITS IN THE LIFECYCLE
 *
 *   discovery  →  criteria DERIVED onto the brief, and editable
 *   approval   →  criteria FROZEN onto the run
 *   execution  →  work happens
 *   completion →  criteria CHECKED, and the run's final state chosen
 *
 * Freezing at approval is the part that matters. What is checked has to be what
 * somebody authorised: a brief edited after approval must not be able to move
 * the bar the work is measured by, in either direction.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Deriving
// ---------------------------------------------------------------------------

/**
 * Derives criteria for a brief and stores them on it.
 *
 * Idempotent, and it never overwrites criteria a human has edited — the check
 * is on `source`, so a list containing anything marked `human` is left alone.
 * Somebody who has curated the acceptance criteria should not lose that work
 * because Mac regenerated the brief.
 */
export async function deriveCriteriaForBrief(
  briefId: string,
  actor: Actor = SYSTEM_ACTOR,
  handle: DbHandle = db,
): Promise<AcceptanceCriterion[]> {
  const [row] = await handle
    .select({
      brief: handoffBriefs,
      taskKind: tasks.taskKind,
      description: tasks.description,
      capabilities: projects.capabilities,
    })
    .from(handoffBriefs)
    .innerJoin(tasks, eq(tasks.id, handoffBriefs.taskId))
    .innerJoin(projects, eq(projects.id, handoffBriefs.projectId))
    .where(eq(handoffBriefs.id, briefId))
    .limit(1);
  if (!row) throw AppError.notFound('Handoff brief');

  const existing = acceptanceCriteriaSchema.safeParse(row.brief.acceptance ?? []);
  if (existing.success && existing.data.some((c) => c.source === 'human')) return existing.data;

  const settings = await getSettings(handle);
  const capabilities = Array.isArray(row.capabilities) ? (row.capabilities as string[]) : [];
  const taskKind = row.taskKind as TaskKind;

  const criteria = deriveCriteria({
    taskKind,
    brief: handoffBriefContentSchema.parse(row.brief.content),
    description: row.description,
    /*
     * BOTH gates, exactly as the tool layer applies them.
     *
     * A criterion the run could never satisfy fails every time for a reason the
     * run cannot act on, which teaches everybody to ignore gaps. If external
     * research is unavailable here, the shortfall belongs at approval time as a
     * blocker, not at completion time as a permanent red cross.
     */
    externalResearchAvailable: settings.externalResearchEnabled && capabilities.includes('external_research'),
    expectedArtefactTypes: describeTaskKind(taskKind).expectedArtefactTypes,
  });

  await handle.update(handoffBriefs).set({ acceptance: criteria, updatedAt: new Date() }).where(eq(handoffBriefs.id, briefId));

  await record(handle, {
    actor,
    eventType: 'acceptance.criteria_derived',
    context: { projectId: row.brief.projectId, taskId: row.brief.taskId },
    metadata: {
      briefId,
      count: criteria.length,
      kinds: criteria.map((c) => c.kind),
      /*
       * What could NOT be asked for, recorded next to what was.
       *
       * "No external_sources criterion" and "no external research was wanted"
       * look identical in this event otherwise, and the first is a gap while
       * the second is nothing at all.
       */
      researchGap: unmetResearchCapability({
        brief: handoffBriefContentSchema.parse(row.brief.content),
        description: row.description,
        externalResearchAvailable: settings.externalResearchEnabled && capabilities.includes('external_research'),
      }),
      /*
       * Commissioning defect 9: what normalisation decided, and what it would not.
       *
       * The criteria list records the numbers Mac arrived at. It cannot record
       * the wording he arrived at them FROM, or the mentions he folded together
       * to get there, and a count that looks like it came from nowhere is a
       * count nobody can argue with. So the resolutions and the ambiguities are
       * recorded beside the criteria they produced — including, deliberately,
       * the phrases that produced NO criterion because nothing could decide
       * what they meant.
       */
      deliverables: (() => {
        const analysis = analyseDeliverables(contractTextOf(handoffBriefContentSchema.parse(row.brief.content)));
        return {
          required: analysis.deliverables.map((d) => ({ type: d.type, count: d.count, phrase: d.sources[0]?.phrase ?? '' })),
          normalised: analysis.resolutions.map((r) => ({
            phrase: r.phrase,
            span: r.span,
            relationship: r.relationship,
            resolvedTo: r.resolvedTo,
            reason: r.reason,
          })),
          needsClarification: analysis.ambiguities.map((a) => ({ phrase: a.phrase, span: a.span, readings: a.readings })),
        };
      })(),
      // The divergence note, recorded alongside — see below.
      ...(row.description
        ? {
            narrowedFromRequest: compareRequestToBrief({
              requestText: row.description,
              brief: handoffBriefContentSchema.parse(row.brief.content),
            }).note,
          }
        : {}),
    },
  });

  return criteria;
}

/**
 * The two notes an approver must see, in one query.
 *
 * ---------------------------------------------------------------------------
 * WHY BOTH, AND WHY HERE
 *
 * `scopeNote` says the brief commits to less than the request asked for. It
 * existed already and reached exactly one reader: a Forja client. Its own
 * comment claimed it was "surfaced on the task screen and in the approval
 * card", and it was on neither — so the narrowing that commissioning found
 * would STILL have been invisible to the only person who currently approves
 * anything, because they approve in the web UI.
 *
 * `researchGapNote` says the brief asks for research this deployment cannot do,
 * so no `external_sources` criterion could be derived and completion will not
 * be judged on evidence nobody could have gathered.
 *
 * They are computed together because they need the same two joins — the task's
 * original wording and the project's capabilities — and a brief DTO should not
 * cost three round trips to answer one question.
 *
 * Neither blocks. Reducing five documents to one that covers the ground is
 * often right, and so is proceeding on what Mac already holds. What neither may
 * be is invisible.
 * ---------------------------------------------------------------------------
 */
export async function briefApprovalNotes(
  briefId: string,
  handle: DbHandle = db,
): Promise<{
  scopeNote: string | null;
  researchGapNote: string | null;
  deliverableNote: string | null;
  deliverableAmbiguityNote: string | null;
}> {
  const [row] = await handle
    .select({
      content: handoffBriefs.content,
      description: tasks.description,
      capabilities: projects.capabilities,
    })
    .from(handoffBriefs)
    .innerJoin(tasks, eq(tasks.id, handoffBriefs.taskId))
    .innerJoin(projects, eq(projects.id, handoffBriefs.projectId))
    .where(eq(handoffBriefs.id, briefId))
    .limit(1);

  if (!row) return { scopeNote: null, researchGapNote: null, deliverableNote: null, deliverableAmbiguityNote: null };

  const content = handoffBriefContentSchema.parse(row.content);
  const settings = await getSettings(handle);
  const capabilities = Array.isArray(row.capabilities) ? (row.capabilities as string[]) : [];

  return {
    scopeNote: row.description
      ? compareRequestToBrief({ requestText: row.description, brief: content }).note
      : null,
    /*
     * Commissioning defect 9. Two sentences, and they answer different questions.
     *
     * `deliverableNote` says Mac read two phrases as naming ONE deliverable —
     * "two distinct documents" is the two engineering briefs — so the approver
     * can see the judgement was made and overturn it if it is wrong.
     *
     * `deliverableAmbiguityNote` says Mac could NOT tell, derived nothing from
     * the phrase, and is waiting on the open question already on the brief.
     * Neither blocks, for the same reason nothing else here does: Mac notices, a
     * person chooses.
     */
    deliverableNote: deliverableNormalisationNote(content),
    deliverableAmbiguityNote: deliverableAmbiguityNote(content),
    researchGapNote: unmetResearchCapability({
      brief: content,
      description: row.description,
      // BOTH gates, exactly as `deriveCriteria` and the tool layer apply them.
      externalResearchAvailable: settings.externalResearchEnabled && capabilities.includes('external_research'),
    }),
  };
}

/** The narrowing note alone, for callers that only want that one. */
export async function briefNarrowing(briefId: string, handle: DbHandle = db): Promise<string | null> {
  return (await briefApprovalNotes(briefId, handle)).scopeNote;
}

// ---------------------------------------------------------------------------
// Freezing
// ---------------------------------------------------------------------------

/**
 * Copies the brief's criteria onto the run, at approval.
 *
 * A COPY and not a pointer. The brief may be revised while the run is in
 * flight — that is a normal thing to happen overnight — and the run must go on
 * being measured against what a person actually authorised.
 */
export async function freezeCriteriaForRun(runId: string, handle: DbHandle = db): Promise<AcceptanceCriterion[]> {
  const [row] = await handle
    .select({ run: runs, briefAcceptance: handoffBriefs.acceptance })
    .from(runs)
    .leftJoin(handoffBriefs, eq(handoffBriefs.id, runs.handoffBriefId))
    .where(eq(runs.id, runId))
    .limit(1);
  if (!row) throw AppError.notFound('Run');

  const parsed = acceptanceCriteriaSchema.safeParse(row.briefAcceptance ?? []);
  const criteria = parsed.success ? parsed.data : [];

  await handle
    .insert(runAcceptance)
    .values({ runId, state: 'not_assessed', criteria })
    .onConflictDoUpdate({ target: runAcceptance.runId, set: { criteria } });

  return criteria;
}

// ---------------------------------------------------------------------------
// Reviewing
// ---------------------------------------------------------------------------

export interface ReviewOptions {
  /** Off for the deterministic-only pass `completeRun` performs as a backstop. */
  allowModel?: boolean;
  actor?: Actor;
}

/**
 * Checks a run against its frozen criteria.
 *
 * ---------------------------------------------------------------------------
 * A MODEL MAY FAIL A CRITERION. IT MAY NEVER PASS ONE A COUNT FAILED.
 *
 * That asymmetry is the safety property of the whole mechanism. Semantic review
 * runs only over criteria marked `semantic`, whose verdicts start
 * `indeterminate`; it never revisits a deterministic result. A fluent
 * explanation must not be able to talk its way past "0 artefacts of type
 * engineering_brief, 3 required".
 *
 * And an `indeterminate` verdict — the model was disabled, unavailable, or
 * returned nothing usable — counts as unmet, not as satisfied. A check that
 * degrades to green the moment it breaks is worse than no check.
 * ---------------------------------------------------------------------------
 */
export async function reviewAcceptance(runId: string, options: ReviewOptions = {}): Promise<AcceptanceReviewDto> {
  const actor = options.actor ?? SYSTEM_ACTOR;
  const settings = await getSettings();

  const [context] = await db
    .select({ run: runs, taskId: runs.taskId, taskKind: tasks.taskKind, projectId: tasks.projectId })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(eq(runs.id, runId))
    .limit(1);
  if (!context) throw AppError.notFound('Run');

  const [stored] = await db.select().from(runAcceptance).where(eq(runAcceptance.runId, runId)).limit(1);
  const parsed = acceptanceCriteriaSchema.safeParse(stored?.criteria ?? []);
  const criteria = parsed.success ? parsed.data : [];

  const evidence = await collectEvidence(runId);
  const artefactsProduced = evidence.artefacts.length;
  const externalSourcesUsed = evidence.sources.filter((s) => s.external).length;

  if (!settings.acceptanceVerificationEnabled || criteria.length === 0) {
    /*
     * No criteria is `not_assessed`, and that is not a failure.
     *
     * Every coding run that existed before Phase 4 lands here, which is exactly
     * the point: acceptance verification adds a check where a contract exists
     * to check against, and invents nothing where there is none.
     */
    return persist(runId, {
      state: 'not_assessed',
      results: [],
      unmet: [],
      artefactsProduced,
      externalSourcesUsed,
      remediationAttempted: false,
      remediationNote: null,
      modelAssisted: false,
      modelProvider: null,
      modelName: null,
      actor,
      taskId: context.taskId,
      projectId: context.projectId,
    });
  }

  let results = evaluateDeterministic(criteria, evidence);
  let modelAssisted = false;
  let modelProvider: string | null = null;
  let modelName: string | null = null;

  const semantic = criteria.filter((c) => c.kind === 'semantic');
  if (semantic.length > 0 && options.allowModel !== false && settings.acceptanceSemanticReviewEnabled) {
    const judged = await judgeSemantic(runId, semantic, evidence);
    if (judged) {
      modelAssisted = true;
      modelProvider = judged.provider;
      modelName = judged.model;
      results = results.map((result) => {
        if (result.kind !== 'semantic') return result;
        const verdict = judged.byId.get(result.criterionId);
        if (!verdict) return result;
        return {
          ...result,
          verdict: verdict.satisfied ? 'satisfied' : 'unmet',
          method: 'model',
          observed: verdict.evidence.slice(0, 1000),
          reasoning: verdict.reasoning.slice(0, 2000),
        };
      });
    }
  }

  const expectsArtefacts = describeTaskKind(context.taskKind as TaskKind).expectedArtefactTypes.length > 0;
  const state = deriveAcceptanceState({ results, artefactsProduced, expectsArtefacts });

  return persist(runId, {
    state,
    results,
    unmet: unmetCriteria(results),
    artefactsProduced,
    externalSourcesUsed,
    remediationAttempted: stored?.remediationAttempted ?? false,
    remediationNote: stored?.remediationNote ?? null,
    modelAssisted,
    modelProvider,
    modelName,
    actor,
    taskId: context.taskId,
    projectId: context.projectId,
  });
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

async function collectEvidence(runId: string): Promise<AcceptanceEvidence> {
  const artefacts = await db
    .select({
      type: runArtefacts.artefactType,
      title: runArtefacts.title,
      body: runArtefacts.body,
      findings: runArtefacts.findings,
    })
    .from(runArtefacts)
    .where(eq(runArtefacts.runId, runId));

  const sources = await sourceClassesFor(runId);

  /*
   * Test runs are read from the AUDIT TRAIL rather than from a status column.
   *
   * `test.run` and `test.failed` are already emitted by the coding path, and
   * the trail is append-only — so "did the tests pass?" is answered by what
   * actually happened rather than by a field something could have overwritten.
   */
  const testEvents = await db
    .select({ eventType: auditEvents.eventType, metadata: auditEvents.metadata })
    .from(auditEvents)
    .where(and(eq(auditEvents.runId, runId), eq(auditEvents.eventType, 'test.run')))
    .orderBy(desc(auditEvents.seq));

  const [review] = await db
    .select({ value: count() })
    .from(runReviews)
    .where(eq(runReviews.runId, runId));

  return {
    artefacts: artefacts.map((a) => ({
      type: a.type as ArtefactType,
      title: a.title,
      body: a.body,
      findings: parseFindings(a.findings),
    })),
    sources,
    testsRun: testEvents.length,
    testsPassed:
      testEvents.length === 0
        ? null
        : ((testEvents[0]!.metadata ?? {}) as { passed?: boolean }).passed ?? null,
    reviewCompleted: Number(review?.value ?? 0) > 0,
  };
}

const parseFindings = (value: unknown): Finding[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => findingSchema.safeParse(entry))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data!);
};

// ---------------------------------------------------------------------------
// Semantic review
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM = [
  'You are checking whether a piece of finished work satisfies specific acceptance criteria.',
  '',
  'You are NOT reviewing quality, and you are NOT deciding whether the run succeeded. You answer one',
  'yes/no question per criterion, about what the work actually contains.',
  '',
  'Rules:',
  '  * Answer NO unless the work plainly contains what the criterion asks for. "It could be inferred"',
  '    is a no. "It is discussed in passing" is a no.',
  '  * Quote the passage that decided it. A yes with no quotable evidence is a no.',
  '  * You cannot pass a criterion by explaining why it did not need to be met.',
  '',
  'Reply with JSON only: {"judgements":[{"criterionId":string,"satisfied":boolean,"evidence":string,"reasoning":string}]}',
].join('\n');

async function judgeSemantic(
  runId: string,
  criteria: readonly AcceptanceCriterion[],
  evidence: AcceptanceEvidence,
): Promise<{ byId: Map<string, { satisfied: boolean; evidence: string; reasoning: string }>; provider: string; model: string | null } | null> {
  const provider = await getModelProvider();
  if (!provider) {
    /*
     * No provider is `indeterminate`, which is a GAP.
     *
     * Deliberately not a silent pass. A deployment that switches off semantic
     * review is telling Mac to check less, and the honest consequence is a run
     * that cannot be marked fully satisfied when a semantic criterion exists.
     */
    await appendSystemLog(
      db,
      runId,
      'Semantic acceptance criteria could not be checked: no reasoning provider is configured. They are ' +
        'recorded as unmet rather than assumed satisfied.',
    );
    return null;
  }

  const prompt = [
    'CRITERIA TO CHECK:',
    ...criteria.map((c) => `  - id: ${c.id}\n    statement: ${'statement' in c ? c.statement : c.description}`),
    '',
    'THE WORK PRODUCED:',
    ...evidence.artefacts.map((a) => `--- ${a.type}: ${a.title} ---\n${a.body.slice(0, 20_000)}`),
  ].join('\n');

  try {
    const completion = await provider.complete({
      system: JUDGE_SYSTEM,
      prompt,
      maxTokens: config.model.outlineMaxTokens,
      expectJson: true,
    });

    const parsed = parseJudgements(completion.text);
    if (!parsed) return null;

    return {
      byId: new Map(
        parsed.judgements.map((j) => [
          j.criterionId,
          { satisfied: j.satisfied, evidence: j.evidence, reasoning: j.reasoning },
        ]),
      ),
      provider: provider.name,
      model: completion.model,
    };
  } catch {
    // A failed judgement leaves the criteria indeterminate, which reads as a
    // gap. Failing the whole review would throw away the deterministic results
    // that did land.
    return null;
  }
}

function parseJudgements(text: string) {
  for (const candidate of [text, extractBraced(text)].filter((c): c is string => Boolean(c))) {
    try {
      const parsed = semanticJudgementBatchSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

const extractBraced = (text: string): string | null => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function persist(
  runId: string,
  input: {
    state: AcceptanceState;
    results: CriterionResult[];
    unmet: CriterionResult[];
    artefactsProduced: number;
    externalSourcesUsed: number;
    remediationAttempted: boolean;
    remediationNote: string | null;
    modelAssisted: boolean;
    modelProvider: string | null;
    modelName: string | null;
    actor: Actor;
    taskId: string;
    projectId: string;
  },
): Promise<AcceptanceReviewDto> {
  const reviewedAt = new Date();

  await db.transaction(async (tx) => {
    await tx
      .insert(runAcceptance)
      .values({
        runId,
        state: input.state,
        results: input.results,
        artefactsProduced: input.artefactsProduced,
        externalSourcesUsed: input.externalSourcesUsed,
        remediationAttempted: input.remediationAttempted,
        remediationNote: input.remediationNote,
        modelAssisted: input.modelAssisted,
        modelProvider: input.modelProvider,
        modelName: input.modelName,
        reviewedAt,
      })
      .onConflictDoUpdate({
        target: runAcceptance.runId,
        set: {
          state: input.state,
          results: input.results,
          artefactsProduced: input.artefactsProduced,
          externalSourcesUsed: input.externalSourcesUsed,
          modelAssisted: input.modelAssisted,
          modelProvider: input.modelProvider,
          modelName: input.modelName,
          reviewedAt,
        },
      });

    // Denormalised onto the run, so every list and report reads one word
    // without a join.
    await tx.update(runs).set({ acceptanceState: input.state, updatedAt: reviewedAt }).where(eq(runs.id, runId));

    /*
     * A run with NO criteria writes no audit event.
     *
     * `audit.ts` is explicit that heartbeats, log lines and reads are
     * deliberately not audited, because volume is what makes a trail
     * unreadable — and "acceptance was not assessed, because there was nothing
     * to assess" on every noop, echo and sleep run in the system is exactly
     * that volume. It is also information nobody can act on.
     *
     * Found by the Sprint 1 end-to-end test, which asserts the complete event
     * sequence of one run and got an extra one.
     */
    if (input.state !== 'not_assessed') {
      await record(tx, {
        actor: input.actor,
        eventType: 'acceptance.reviewed',
        context: { runId, taskId: input.taskId, projectId: input.projectId },
        metadata: {
          state: input.state,
          criteria: input.results.length,
          unmet: input.unmet.length,
          artefactsProduced: input.artefactsProduced,
          // The number Part F §23 names explicitly.
          externalSourcesUsed: input.externalSourcesUsed,
          modelAssisted: input.modelAssisted,
        },
      });
    }

    for (const gap of input.unmet) {
      await record(tx, {
        actor: input.actor,
        eventType: 'acceptance.gap_recorded',
        context: { runId, taskId: input.taskId, projectId: input.projectId },
        metadata: {
          criterionId: gap.criterionId,
          kind: gap.kind,
          description: gap.description,
          observed: gap.observed,
          verdict: gap.verdict,
        },
      });
    }
  });

  const dto: AcceptanceReviewDto = {
    runId,
    state: input.state,
    results: input.results,
    unmet: input.unmet,
    remediationAttempted: input.remediationAttempted,
    remediationNote: input.remediationNote,
    modelAssisted: input.modelAssisted,
    reviewedAt: reviewedAt.toISOString(),
  };

  if (input.unmet.length > 0) {
    await appendSystemLog(db, runId, renderAcceptanceMarkdown(dto));
  }

  return dto;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function getRunAcceptance(runId: string, handle: DbHandle = db): Promise<AcceptanceReviewDto | null> {
  const [row] = await handle.select().from(runAcceptance).where(eq(runAcceptance.runId, runId)).limit(1);
  if (!row) return null;

  const results = Array.isArray(row.results) ? (row.results as CriterionResult[]) : [];

  return {
    runId,
    state: row.state as AcceptanceState,
    results,
    unmet: unmetCriteria(results),
    remediationAttempted: row.remediationAttempted,
    remediationNote: row.remediationNote,
    modelAssisted: row.modelAssisted,
    reviewedAt: row.reviewedAt.toISOString(),
  };
}

/** Records that a remediation pass was attempted, and what it changed. */
export async function noteRemediation(runId: string, note: string, actor: Actor = SYSTEM_ACTOR): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(runAcceptance)
      .values({ runId, remediationAttempted: true, remediationNote: note.slice(0, 2000) })
      .onConflictDoUpdate({
        target: runAcceptance.runId,
        set: { remediationAttempted: true, remediationNote: note.slice(0, 2000) },
      });

    await record(tx, {
      actor,
      eventType: 'acceptance.remediation_attempted',
      context: { runId },
      metadata: { note: note.slice(0, 500) },
    });
  });
}

/** Whether a remediation pass has already been spent on this run. */
export async function remediationAlreadyAttempted(runId: string, handle: DbHandle = db): Promise<boolean> {
  const [row] = await handle
    .select({ attempted: runAcceptance.remediationAttempted })
    .from(runAcceptance)
    .where(eq(runAcceptance.runId, runId))
    .limit(1);
  return row?.attempted ?? false;
}
