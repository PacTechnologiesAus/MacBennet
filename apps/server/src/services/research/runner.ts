import { eq } from 'drizzle-orm';
import {
  emptyResearchState,
  handoffBriefContentSchema,
  RESEARCH_LIMITS,
  researchPlanSchema,
  researchStateSchema,
  researchStepOutputSchema,
  type ArtefactContent,
  type ResearchPlan,
  type ResearchSource,
  type ResearchState,
  type ResearchStepOutput,
  type ResearchToolResult,
  type TaskKind,
} from '@mac/protocol';
import { db, type DbHandle } from '../../db/client.js';
import { generalRunState, handoffBriefs, projects, runs, runUsage, tasks } from '../../db/schema.js';
import { AppError } from '../../http/errors.js';
import {
  accumulate,
  buildResearchPlan,
  countFabricatedCitations,
  decideNextStep,
  permittedTools,
  refuseToolCall,
  stageFor,
  type LoopDecision,
} from '../../domain/research.js';
import { record, SYSTEM_ACTOR, type Actor } from '../audit.js';
import { getSettings } from '../settings.js';
import { requireReasoningProvider } from '../model/provider.js';
import { createArtefact } from '../artefacts.js';
import { appendSystemLog } from '../logs.js';
import { projectAllowsExternalResearch, runTool, type ToolContext } from './tools.js';

/**
 * Executing general work (Sprint 3.3 §13).
 *
 * ---------------------------------------------------------------------------
 * WHY THE REASONING HAPPENS HERE AND NOT ON THE WORKER
 *
 * The worker drives the run: it holds the lease, sends heartbeats, honours
 * cancellation, and stops at the cutoff. That is the Sprint 1 lifecycle and
 * Sprint 3.3 §13 requires reusing it rather than inventing a second one.
 *
 * But each reasoning STEP executes in the control plane, because of what a step
 * needs to touch. It needs the model credential, the company-context mirror,
 * project memory, prior runs and the monday client — every one of which is a
 * credential or a data scope the worker deliberately does not have. Pushing
 * reasoning onto the worker would mean shipping all of them to the VM, which is
 * precisely what Sprint 3.3 §29 forbids:
 *
 *   "General research must not expose worker credentials, mail credentials,
 *    monday credentials, Company repo write credentials, or unrelated project
 *    secrets."
 *
 * So the worker asks "do the next step" and gets back progress. It never sees a
 * key, never sees another project's data, and cannot widen its own scope,
 * because the scope is resolved here from the run row.
 * ---------------------------------------------------------------------------
 */

export interface StepResult {
  stage: string;
  stepsTaken: number;
  toolCallsMade: number;
  /** What Mac did this step, in one or two sentences. Shown as run progress. */
  narrative: string;
  findingsSoFar: number;
  sourcesSoFar: number;
  artefactsCreated: number;
  /** True when the loop is finished and the worker should complete the run. */
  done: boolean;
  /** Set when the loop stopped because it hit a ceiling. */
  limitReached: boolean;
  /** Set when the model proposed something a human must decide. */
  blockerProposed: string | null;
  percent: number;
}

// ---------------------------------------------------------------------------
// Starting a general run
// ---------------------------------------------------------------------------

/**
 * Builds the plan and pins it, before the model is called even once.
 *
 * Called at dispatch rather than lazily, so that a run whose project forbids its
 * task kind, or whose brief is missing, fails at the point a human is watching
 * rather than three steps into a night.
 */
export async function beginGeneralRun(runId: string, actor: Actor = SYSTEM_ACTOR): Promise<ResearchPlan> {
  const settings = await getSettings();

  // Fails loudly, before anything else, when there is no real provider.
  await requireReasoningProvider('General work');

  return db.transaction(async (tx) => {
    const context = await loadRunContext(runId, tx);
    const externalAllowed = await projectAllowsExternalResearch(context.projectId, tx);

    const tools = permittedTools({
      externalResearchEnabled: settings.externalResearchEnabled,
      projectAllowsExternal: externalAllowed,
      hasRepositorySnapshot: context.hasRepositorySnapshot,
      hasMondayItem: context.hasMondayItem,
      hasCompanyContext: context.companyContextRevisionId !== null,
    });

    const plan = buildResearchPlan({
      taskKind: context.taskKind,
      brief: context.brief,
      permittedTools: tools,
      maxSteps: Math.min(context.maxSteps, settings.maxResearchSteps),
    });

    await tx
      .insert(generalRunState)
      .values({
        runId,
        taskKind: context.taskKind,
        plan,
        state: emptyResearchState(),
        stage: 'planning',
      })
      .onConflictDoNothing();

    await record(tx, {
      actor,
      eventType: 'research.plan_built',
      context: { runId, taskId: context.taskId, projectId: context.projectId },
      metadata: {
        taskKind: context.taskKind,
        objective: plan.objective.slice(0, 500),
        deliverables: plan.deliverables.length,
        permittedTools: plan.permittedTools,
        externalResearchPermitted: plan.permittedTools.some((t) => t === 'public_web_search' || t === 'public_doc_fetch'),
        maxSteps: plan.maxSteps,
        companyContextRevisionId: context.companyContextRevisionId,
      },
    });

    return plan;
  });
}

// ---------------------------------------------------------------------------
// One step
// ---------------------------------------------------------------------------

const STEP_SYSTEM = [
  'You are Mac Bennett, an automation engineer at PAC Technologies, carrying out an approved piece of',
  'technical work that is NOT a coding task. You are researching, analysing or scoping.',
  '',
  'You will be given a PLAN (which you did not write and may not change), the SOURCES retrieved so far,',
  'and the FINDINGS established so far.',
  '',
  'Rules that are enforced in code, so breaking them only wastes a step:',
  '  * Every finding you state must cite refs from the SOURCES block, exactly as written there.',
  '    A citation that was not retrieved is dropped, and a factual claim left with no source is',
  '    demoted to an inference and its confidence capped.',
  '  * You may not claim a PAC fact without citing a company: source, nor an external fact without',
  '    citing something actually fetched.',
  '  * If you cannot establish something, put it in `unknowns`. Do not fill the gap.',
  '  * Distinguish what you found from what you concluded. `inference` and `recommendation` are',
  '    respectable answers; a dressed-up guess is not.',
  '',
  'To look something up, name a tool from the plan and give it a query. You do not call tools',
  'directly and you cannot name a tool that is not in the plan.',
  '',
  'Reply with JSON only:',
  '{"toolCalls":[{"tool":string,"argument":string,"purpose":string}],',
  ' "findings":[{"statement":string,"evidenceClass":string,"confidence":number,"sources":[string],"reasoning":string}],',
  ' "narrative":string,"unknowns":[string],"artefacts":[],"blockerProposed":string|null}',
  '',
  'evidenceClass is one of: pac_fact, project_fact, external_fact, user_approved_decision,',
  'inference, recommendation, assumption, unknown.',
].join('\n');

const FINALISE_SYSTEM = [
  STEP_SYSTEM,
  '',
  'THIS IS THE FINAL STEP. Do not request any more tools; anything you ask for will be ignored.',
  'Produce the deliverables named in the plan, in `artefacts`. Each artefact needs:',
  '  {"type":string,"title":string,"format":"markdown","body":string,"summary":string,"findings":[...]}',
  'type is one of: investigation_report, engineering_brief, architecture_note, recommendation,',
  'markdown_document, structured_data, diagram_description, task_proposal.',
  '',
  'Write the body for an engineer who will act on it: what you were asked, what you established,',
  'what you could not establish, and what you recommend. Say plainly where the evidence is thin.',
].join('\n');

/**
 * Performs one step of a general run.
 *
 * Returns enough for the worker to report progress and decide whether to loop
 * again. Every decision about whether to continue is made HERE, from persisted
 * counters, so a worker that misbehaves cannot extend a run past its ceiling.
 */
export async function performResearchStep(
  runId: string,
  options: { signal?: AbortSignal } = {},
  actor: Actor = SYSTEM_ACTOR,
): Promise<StepResult> {
  const settings = await getSettings();
  const provider = await requireReasoningProvider('General work');

  const loaded = await loadStepState(runId);
  const { plan, state, context } = loaded;

  const maxToolCalls = Math.min(settings.maxResearchToolCalls, RESEARCH_LIMITS.maxTotalToolCalls);

  // Decided before the model is asked anything, from recorded counters.
  const decision = decideNextStep({ plan, state, modelSatisfied: loaded.modelSatisfied, maxToolCalls });

  if (decision.action === 'stop') {
    await finishState(runId, state, 'complete');
    await record(db, {
      actor,
      eventType: 'research.limit_reached',
      context: { runId, taskId: context.taskId, projectId: context.projectId },
      metadata: { reason: decision.reason, stepsTaken: state.stepsTaken, toolCallsMade: state.toolCallsMade },
    });
    return summarise(state, decision, 0, null, true);
  }

  const finalising = decision.action === 'finalise';

  const completion = await provider.complete({
    system: finalising ? FINALISE_SYSTEM : STEP_SYSTEM,
    prompt: buildPrompt(plan, state, decision, context.taskTitle),
    maxTokens: finalising ? 8000 : 3000,
    expectJson: true,
    ...(options.signal ? { signal: options.signal } : {}),
  } as Parameters<typeof provider.complete>[0]);

  const parsed = parseStepOutput(completion.text);

  /*
   * A model that returned nothing usable does not stop the run.
   *
   * It costs one step, is audited, and the loop proceeds — because the
   * alternative, failing the whole run on one malformed response, would make a
   * night's work hostage to a single unlucky completion.
   */
  const output: ResearchStepOutput = parsed ?? researchStepOutputSchema.parse({ narrative: '' });

  // --- Tools ---------------------------------------------------------------

  const toolResults: ResearchToolResult[] = [];
  const newSources: ResearchSource[] = [];
  let toolCallsMade = state.toolCallsMade;

  if (!finalising) {
    const toolContext: ToolContext = {
      runId,
      taskId: context.taskId,
      projectId: context.projectId,
      companyContextRevisionId: context.companyContextRevisionId,
      allowedResearchDomains: settings.allowedResearchDomains,
      externalResearchEnabled: settings.externalResearchEnabled,
    };

    for (const call of output.toolCalls.slice(0, RESEARCH_LIMITS.maxToolCallsPerStep)) {
      const refusal = refuseToolCall({
        tool: call.tool,
        permitted: plan.permittedTools,
        toolCallsMade,
        maxToolCalls,
      });

      const result = refusal
        ? { tool: call.tool, argument: call.argument, performed: false, refusalReason: refusal, sources: [], at: new Date().toISOString() }
        : await runTool(call, toolContext);

      toolResults.push(result);
      toolCallsMade += 1;
      newSources.push(...result.sources);

      await record(db, {
        actor,
        eventType: result.performed ? 'research.tool_called' : 'research.tool_refused',
        context: { runId, taskId: context.taskId, projectId: context.projectId },
        metadata: {
          tool: call.tool,
          // Sprint 3.3 §15: the query itself, so a search is inspectable.
          query: call.argument.slice(0, 500),
          purpose: call.purpose.slice(0, 300),
          sources: result.sources.length,
          refusalReason: result.refusalReason,
        },
      });

      for (const source of result.sources.filter((s) => s.external)) {
        await record(db, {
          actor,
          eventType: 'research.external_source_retrieved',
          context: { runId, taskId: context.taskId, projectId: context.projectId },
          metadata: { ref: source.ref, retrievedAt: source.retrievedAt, chars: source.excerpt.length },
        });
      }
    }
  }

  // --- Accumulate ----------------------------------------------------------

  const fabricated = countFabricatedCitations(output.findings, [...state.sources, ...newSources]);
  const next = { ...accumulate(state, output, newSources), toolCallsMade };

  // --- Artefacts -----------------------------------------------------------

  /*
   * Artefacts are accepted on ANY step, not only the one the loop labelled
   * "finalise".
   *
   * The loop decides when to PROMPT for a write-up; it does not get to discard
   * one the model volunteered earlier. Throwing away a finished report because
   * it arrived a step ahead of schedule would spend a model call and produce
   * nothing, and would then loop on to spend several more.
   *
   * This lets a run finish sooner. It cannot let one run longer: the step and
   * tool-call ceilings are enforced above, before the model is asked anything.
   */
  let artefactsCreated = 0;
  {
    for (const content of output.artefacts.slice(0, RESEARCH_LIMITS.maxArtefactsPerRun)) {
      const withFindings: ArtefactContent = {
        ...content,
        // The run's whole finding set, classified, rather than whatever the
        // model chose to repeat inside the artefact block.
        findings: content.findings.length ? content.findings : next.findings,
      };
      await createArtefact(
        {
          taskId: context.taskId,
          runId,
          content: withFindings,
          usage: {
            provider: provider.name,
            model: completion.model,
            inputTokens: completion.usage.inputTokens,
            outputTokens: completion.usage.outputTokens,
          },
          companyContextRevisionId: context.companyContextRevisionId,
        },
        actor,
      ).catch(async (err) => {
        await appendSystemLog(db, runId, `An artefact could not be stored: ${(err as Error).message}`);
        return null;
      });
      artefactsCreated += 1;
    }
  }

  // --- Persist, audit, account --------------------------------------------

  await persistStep(runId, {
    state: next,
    stage: stageFor(finalising ? 'stop' : decision.action),
    provider: provider.name,
    model: completion.model,
    inputTokens: completion.usage.inputTokens ?? 0,
    outputTokens: completion.usage.outputTokens ?? 0,
    toolResults,
  });

  await recordReasoningUsage(runId, {
    provider: provider.name,
    model: completion.model,
    inputTokens: completion.usage.inputTokens,
    outputTokens: completion.usage.outputTokens,
  });

  await record(db, {
    actor,
    eventType: 'research.step_completed',
    context: { runId, taskId: context.taskId, projectId: context.projectId },
    metadata: {
      step: next.stepsTaken,
      stage: stageFor(finalising ? 'stop' : decision.action),
      decision: decision.action,
      reason: decision.reason,
      toolCalls: toolResults.length,
      toolsRefused: toolResults.filter((r) => !r.performed).length,
      findingsTotal: next.findings.length,
      sourcesTotal: next.sources.length,
      // The number worth watching, exactly as in the coding path: a model
      // inventing sources is the failure mode this design exists to survive.
      fabricatedCitations: fabricated,
      unparseableOutput: parsed === null,
      artefactsCreated,
      provider: provider.name,
      model: completion.model,
      inputTokens: completion.usage.inputTokens,
      outputTokens: completion.usage.outputTokens,
    },
  });

  if (parsed === null) {
    await appendSystemLog(db, runId, 'The reasoning model returned output Mac could not parse; the step was still counted.');
  }
  if (output.narrative.trim()) {
    await appendSystemLog(db, runId, output.narrative.slice(0, 2000));
  }

  /*
   * Done when the loop said to finalise, or when the model has produced
   * deliverables and stopped asking for sources. The second condition is what
   * makes an early write-up terminate the run rather than merely be kept.
   */
  const done = finalising || (artefactsCreated > 0 && output.toolCalls.length === 0);

  return summarise(
    next,
    done ? { action: 'stop', reason: decision.reason, limitReached: false } : decision,
    artefactsCreated,
    output.blockerProposed,
    done,
  );
}

const summarise = (
  state: ResearchState,
  decision: LoopDecision,
  artefactsCreated: number,
  blockerProposed: string | null,
  done: boolean,
): StepResult => ({
  stage: stageFor(decision.action),
  stepsTaken: state.stepsTaken,
  toolCallsMade: state.toolCallsMade,
  narrative: decision.reason,
  findingsSoFar: state.findings.length,
  sourcesSoFar: state.sources.length,
  artefactsCreated,
  done,
  limitReached: decision.action === 'stop' && decision.limitReached === true,
  blockerProposed,
  percent: done ? 100 : Math.min(95, Math.round((state.stepsTaken / Math.max(1, RESEARCH_LIMITS.maxSteps)) * 100)),
});

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildPrompt(plan: ResearchPlan, state: ResearchState, decision: LoopDecision, taskTitle: string): string {
  const lines: string[] = [];

  lines.push(`TASK: ${taskTitle}`, '');
  lines.push('PLAN', `Objective: ${plan.objective}`);
  if (plan.deliverables.length) lines.push('Deliverables:', ...plan.deliverables.map((d) => `  - ${d}`));
  if (plan.acceptanceCriteria.length) {
    lines.push('Acceptance criteria:', ...plan.acceptanceCriteria.map((a) => `  - ${a}`));
  }
  if (plan.constraints.length) lines.push('Constraints:', ...plan.constraints.map((c) => `  - ${c}`));
  lines.push('Authority boundaries:', ...plan.authorityBoundaries.map((b) => `  - ${b}`));
  lines.push(`Tools available to you: ${plan.permittedTools.join(', ') || 'none'}`, '');

  lines.push(`STEP ${state.stepsTaken + 1} of at most ${plan.maxSteps}. ${decision.reason}`, '');

  lines.push('SOURCES RETRIEVED SO FAR (cite refs exactly as written):');
  if (state.sources.length === 0) {
    lines.push('  (none yet)');
  } else {
    for (const source of state.sources.slice(0, 60)) {
      lines.push(`  [${source.ref}] ${source.label}`, `    ${source.excerpt.slice(0, 1200)}`);
    }
  }
  lines.push('');

  lines.push('FINDINGS SO FAR:');
  if (state.findings.length === 0) {
    lines.push('  (none yet)');
  } else {
    for (const finding of state.findings.slice(0, 60)) {
      lines.push(`  - [${finding.evidenceClass}] ${finding.statement}`);
    }
  }

  if (state.unknowns.length) {
    lines.push('', 'STILL UNKNOWN:', ...state.unknowns.slice(0, 30).map((u) => `  - ${u}`));
  }

  return lines.join('\n');
}

function parseStepOutput(text: string): ResearchStepOutput | null {
  const candidates = [text, extractBraced(text)].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    try {
      const result = researchStepOutputSchema.safeParse(JSON.parse(candidate));
      if (result.success) return result.data;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function extractBraced(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface RunContext {
  taskId: string;
  projectId: string;
  taskTitle: string;
  taskKind: TaskKind;
  brief: ReturnType<typeof handoffBriefContentSchema.parse>;
  companyContextRevisionId: string | null;
  hasRepositorySnapshot: boolean;
  hasMondayItem: boolean;
  maxSteps: number;
}

async function loadRunContext(runId: string, handle: DbHandle): Promise<RunContext> {
  const [row] = await handle
    .select({
      run: runs,
      taskTitle: tasks.title,
      taskKind: tasks.taskKind,
      projectId: tasks.projectId,
      mondayItemId: tasks.mondayItemId,
    })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(eq(runs.id, runId))
    .limit(1);
  if (!row) throw AppError.notFound('Run');

  const params = (row.run.jobParams ?? {}) as { briefId?: string; maxSteps?: number };
  const briefId = params.briefId ?? row.run.handoffBriefId;
  if (!briefId) {
    throw new AppError(409, 'BRIEF_REQUIRED', 'A general run needs a handoff brief; this one has none.');
  }

  const [brief] = await handle.select().from(handoffBriefs).where(eq(handoffBriefs.id, briefId)).limit(1);
  if (!brief) throw AppError.notFound('Handoff brief');

  const [project] = await handle.select().from(projects).where(eq(projects.id, row.projectId)).limit(1);

  return {
    taskId: row.run.taskId,
    projectId: row.projectId,
    taskTitle: row.taskTitle,
    taskKind: row.taskKind as TaskKind,
    brief: handoffBriefContentSchema.parse(brief.content),
    companyContextRevisionId: row.run.companyContextRevisionId,
    hasRepositorySnapshot: Boolean(project?.repoUrl),
    hasMondayItem: Boolean(row.mondayItemId ?? row.run.mondayItemId),
    maxSteps: params.maxSteps ?? 8,
  };
}

async function loadStepState(runId: string): Promise<{
  plan: ResearchPlan;
  state: ResearchState;
  context: RunContext;
  modelSatisfied: boolean;
}> {
  const [row] = await db.select().from(generalRunState).where(eq(generalRunState.runId, runId)).limit(1);
  if (!row) {
    throw new AppError(409, 'RESEARCH_NOT_STARTED', 'This run has no research plan. Dispatch builds one.');
  }

  const state = researchStateSchema.parse(row.state ?? {});

  return {
    plan: researchPlanSchema.parse(row.plan),
    state,
    context: await loadRunContext(runId, db),
    /*
     * "The model asked for nothing last step."
     *
     * Read from a recorded COUNT of what was requested, not from what came
     * back. A step whose every tool was refused still asked for something, and
     * treating that as satisfaction would end a run early exactly when its
     * sources were being denied — the worst possible moment to stop and write
     * up, because the write-up would then describe an absence of evidence as an
     * absence of facts.
     *
     * Note this still is not the model DECIDING to stop: it only lets the
     * scheduler skip pointless gather steps. The ceilings are unaffected.
     */
    modelSatisfied: state.stepsTaken > 0 && state.lastRequestedToolCount === 0,
  };
}

async function persistStep(
  runId: string,
  input: {
    state: ResearchState;
    stage: string;
    provider: string;
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    toolResults: ResearchToolResult[];
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(generalRunState).where(eq(generalRunState.runId, runId)).limit(1);
    if (!existing) return;

    const merged: ResearchState = {
      ...input.state,
      toolResults: [...(researchStateSchema.parse(existing.state ?? {}).toolResults ?? []), ...input.toolResults].slice(-200),
    };

    await tx
      .update(generalRunState)
      .set({
        state: merged,
        stage: input.stage as never,
        stepsTaken: merged.stepsTaken,
        toolCallsMade: merged.toolCallsMade,
        modelProvider: input.provider,
        modelName: input.model,
        inputTokens: existing.inputTokens + input.inputTokens,
        outputTokens: existing.outputTokens + input.outputTokens,
        updatedAt: new Date(),
      })
      .where(eq(generalRunState.runId, runId));
  });
}

async function finishState(runId: string, state: ResearchState, stage: string): Promise<void> {
  await db
    .update(generalRunState)
    .set({ stage: stage as never, state, updatedAt: new Date() })
    .where(eq(generalRunState.runId, runId));
}

/**
 * Mac's own reasoning spend, into the usage model the budget already reads.
 *
 * Reconciliation drift D-11: spec §25 lists "Mac's reasoning model" FIRST among
 * the sources of AI usage, and before Sprint 3.3 its token counts went into
 * audit metadata and stopped there. For a coding night that was a rounding
 * error. For a research night it is the dominant cost, and a nightly budget that
 * cannot see the dominant cost is not a budget.
 *
 * Recorded as `exact` because both real providers return real token counts on
 * every call — see `MODEL_ACCESS` in the protocol, which is where the claim that
 * they do is written down and checkable.
 */
export async function recordReasoningUsage(
  runId: string,
  usage: { provider: string; model: string | null; inputTokens: number | null; outputTokens: number | null },
  handle: DbHandle = db,
): Promise<void> {
  const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  if (total === 0) return;

  await handle.insert(runUsage).values({
    runId,
    provider: usage.provider,
    kind: 'reasoning_tokens',
    quantity: String(total),
    unit: 'tokens',
    // Tokens are exact; the DOLLAR cost of them is not known here, and inventing
    // a rate would be exactly the "estimate presented as exact" that spec §25
    // forbids. `cost_cents` stays null and the report says so.
    costCents: null,
    isExact: true,
    source: 'exact',
    model: usage.model,
    metadata: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
  });
}

/** The stored plan and state, for the UI and the report. */
export async function getGeneralRunState(runId: string, handle: DbHandle = db) {
  const [row] = await handle.select().from(generalRunState).where(eq(generalRunState.runId, runId)).limit(1);
  if (!row) return null;
  return {
    runId: row.runId,
    taskKind: row.taskKind as TaskKind,
    plan: researchPlanSchema.safeParse(row.plan).data ?? null,
    state: researchStateSchema.safeParse(row.state).data ?? emptyResearchState(),
    stage: row.stage,
    stepsTaken: row.stepsTaken,
    toolCallsMade: row.toolCallsMade,
    modelProvider: row.modelProvider,
    modelName: row.modelName,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
  };
}
