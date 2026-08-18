import {
  capFindingConfidence,
  EXTERNAL_RESEARCH_TOOLS,
  isExternalTool,
  RESEARCH_LIMITS,
  describeTaskKind,
  type Finding,
  type HandoffBriefContent,
  type ResearchPlan,
  type ResearchSource,
  type ResearchStage,
  type ResearchState,
  type ResearchStepOutput,
  type ResearchTool,
  type TaskKind,
} from '@mac/protocol';

/**
 * The research loop's judgement, with no I/O (Sprint 3.3 §13, §14, §16).
 *
 * ---------------------------------------------------------------------------
 * WHAT THE MODEL IS AND IS NOT ALLOWED TO DECIDE
 *
 * This module is the reason a research run is auditable rather than merely
 * plausible. Three decisions are made here, in code, and none of them is asked
 * of the model:
 *
 *   1. WHAT THE OBJECTIVE IS. Built from the approved handoff brief. The model
 *      is handed the plan; it never writes one. A model that could restate its
 *      own objective would not be executing the contract a human approved
 *      (Sprint 3.3 §18).
 *
 *   2. WHEN TO STOP. Step and tool-call ceilings are enforced against recorded
 *      counters, not against the model saying it is finished.
 *
 *   3. WHAT COUNTS AS A FACT. `classifyFindings` decides an evidence class from
 *      the sources actually retrieved. A model claiming `pac_fact` with no PAC
 *      source is demoted to `inference` and its confidence capped — because the
 *      one thing a research artefact must never do is let a guess read like a
 *      finding.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface PlanInput {
  taskKind: TaskKind;
  brief: HandoffBriefContent;
  /** Tools this deployment and project permit. Already filtered by the caller. */
  permittedTools: readonly ResearchTool[];
  maxSteps: number;
}

/**
 * Turns an approved brief into a plan.
 *
 * Deliverables come from the brief's acceptance criteria when it has them, and
 * from the task kind's expected artefacts when it does not. Note the ordering:
 * what the human asked for beats what the kind usually produces, every time.
 */
export function buildResearchPlan(input: PlanInput): ResearchPlan {
  const { brief, taskKind } = input;
  const descriptor = describeTaskKind(taskKind);

  const deliverables = brief.acceptanceCriteria.length
    ? brief.acceptanceCriteria.slice(0, 20)
    : descriptor.expectedArtefactTypes.map((type) => `A ${type.replace(/_/g, ' ')} covering the objective.`);

  return {
    objective: brief.userObjective.trim() || brief.title,
    deliverables,
    acceptanceCriteria: brief.acceptanceCriteria.slice(0, 20),
    permittedTools: [...input.permittedTools],
    constraints: [...brief.constraints, ...brief.outOfScope.map((o) => `Out of scope: ${o}`)].slice(0, 40),
    /*
     * The authority boundaries, restated into the plan rather than assumed.
     *
     * These are not new rules — they are spec §16's hard prohibitions and this
     * sprint's §29 — but a research run reads its plan and does not read the
     * specification, so a boundary that is not in the plan is a boundary the
     * run has not been told about.
     */
    authorityBoundaries: [
      'Report findings and recommendations. Do not take action on them.',
      'Do not contact anyone outside PAC, and do not make any commitment on PAC behalf.',
      'Do not treat your own prior knowledge as a researched fact; cite a retrieved source or mark it an inference.',
      'Where you cannot establish something, say so. Do not fill the gap.',
    ],
    maxSteps: Math.min(input.maxSteps, RESEARCH_LIMITS.maxSteps),
  };
}

/**
 * Which tools a run may actually use.
 *
 * Three gates, all of which must agree: the deployment must enable external
 * research at all, the project must declare the capability, and the resource
 * the tool reads must exist. A project without a repository does not get
 * `repository_search` — not because it would be dangerous, but because offering
 * a tool that always returns nothing wastes a step and teaches the model that
 * its tools do not work.
 */
export function permittedTools(input: {
  externalResearchEnabled: boolean;
  projectAllowsExternal: boolean;
  hasRepositorySnapshot: boolean;
  hasMondayItem: boolean;
  hasCompanyContext: boolean;
}): ResearchTool[] {
  const tools: ResearchTool[] = ['project_memory_search', 'prior_run_search', 'brief_search'];
  if (input.hasCompanyContext) tools.unshift('company_context_search');
  if (input.hasRepositorySnapshot) tools.push('repository_search');
  if (input.hasMondayItem) tools.push('monday_search');
  if (input.externalResearchEnabled && input.projectAllowsExternal) tools.push(...EXTERNAL_RESEARCH_TOOLS);
  return tools;
}

// ---------------------------------------------------------------------------
// Loop control
// ---------------------------------------------------------------------------

export type LoopDecision =
  | { action: 'gather'; reason: string }
  | { action: 'synthesise'; reason: string }
  | { action: 'finalise'; reason: string }
  | { action: 'stop'; reason: string; limitReached: boolean };

/**
 * What the run should do next.
 *
 * Deliberately boring and deliberately not asked of the model: a loop whose
 * termination condition is "the model said it was done" terminates when the
 * model is confused as readily as when it is finished.
 *
 * The `finalise` step is guaranteed to happen — reserved by `maxSteps - 1` —
 * because a run that hits its ceiling mid-gathering with nothing written down
 * has spent money and produced no artefact, which is the worst of both.
 */
export function decideNextStep(input: {
  plan: ResearchPlan;
  state: ResearchState;
  /** True when the last model output asked for nothing more. */
  modelSatisfied: boolean;
  maxToolCalls: number;
}): LoopDecision {
  const { plan, state } = input;
  const stepsLeft = plan.maxSteps - state.stepsTaken;

  if (stepsLeft <= 0) {
    return { action: 'stop', reason: `Reached the ${plan.maxSteps}-step ceiling.`, limitReached: true };
  }
  if (state.toolCallsMade >= input.maxToolCalls) {
    return {
      action: 'finalise',
      reason: `Reached the ${input.maxToolCalls}-tool-call ceiling; writing up what was gathered.`,
    };
  }
  // Reserve the last step for writing up, always.
  if (stepsLeft === 1) {
    return { action: 'finalise', reason: 'Last available step; writing up what was gathered.' };
  }
  if (input.modelSatisfied) {
    return state.findings.length > 0
      ? { action: 'finalise', reason: 'Enough has been gathered to answer the objective.' }
      : {
          action: 'synthesise',
          reason: 'Nothing further to gather, but no findings yet; reasoning over what is available.',
        };
  }
  return { action: 'gather', reason: 'More sources are needed before the objective can be answered.' };
}

export const stageFor = (decision: LoopDecision['action']): ResearchStage => {
  switch (decision) {
    case 'gather':
      return 'gathering';
    case 'synthesise':
      return 'synthesising';
    case 'finalise':
      return 'writing';
    case 'stop':
      return 'complete';
  }
};

// ---------------------------------------------------------------------------
// Evidence classification
// ---------------------------------------------------------------------------

/**
 * Demotes any finding whose claimed class the retrieved sources do not support.
 *
 * ---------------------------------------------------------------------------
 * THE RULE, AND WHY IT IS MECHANICAL
 *
 * A model asked to label its own claims will label them generously. Not
 * maliciously — it genuinely does not distinguish "I read this in the PAC
 * handbook two steps ago" from "this is the sort of thing a PAC handbook says".
 * Both feel equally like knowing.
 *
 * So the label is not taken on trust. A finding claiming `pac_fact` must cite a
 * source that actually came from the company-context tool, in this run. One
 * claiming `external_fact` must cite something actually fetched. A claim whose
 * sources do not exist in the retrieved set is demoted to `inference` and its
 * confidence capped beneath the answering threshold.
 *
 * This is the same mechanism as the citation check in `model/resolvers.ts`, and
 * it is here for the same reason: it is the only thing standing between a
 * fluent paragraph and a fact somebody acts on.
 * ---------------------------------------------------------------------------
 */
export function classifyFindings(findings: readonly Finding[], retrieved: readonly ResearchSource[]): Finding[] {
  const byRef = new Map(retrieved.map((s) => [s.ref, s]));

  return findings.map((finding) => {
    const realSources = finding.sources.filter((ref) => byRef.has(ref));
    const fabricated = finding.sources.length - realSources.length;

    let evidenceClass = finding.evidenceClass;

    // A factual claim with no surviving source is not a fact.
    if (realSources.length === 0 && ['pac_fact', 'project_fact', 'external_fact'].includes(evidenceClass)) {
      evidenceClass = 'inference';
    }

    // An external claim resting only on internal sources is an internal claim,
    // and vice versa. Getting this backwards would misattribute PAC policy to
    // the internet, or worse, the internet to PAC policy.
    if (evidenceClass === 'external_fact' && realSources.every((ref) => !byRef.get(ref)?.external)) {
      evidenceClass = realSources.length ? 'project_fact' : 'inference';
    }
    if (evidenceClass === 'pac_fact' && !realSources.some((ref) => ref.startsWith('company:'))) {
      evidenceClass = realSources.length ? 'project_fact' : 'inference';
    }

    return capFindingConfidence({
      ...finding,
      evidenceClass,
      sources: realSources,
      reasoning:
        fabricated > 0
          ? `${finding.reasoning} (${fabricated} cited source(s) were not retrieved during this run and were dropped.)`.trim()
          : finding.reasoning,
    });
  });
}

/** How many citations the model invented. The number worth watching. */
export function countFabricatedCitations(
  findings: readonly Finding[],
  retrieved: readonly ResearchSource[],
): number {
  const refs = new Set(retrieved.map((s) => s.ref));
  return findings.reduce((total, f) => total + f.sources.filter((ref) => !refs.has(ref)).length, 0);
}

/**
 * Merges one step's output into the accumulated state.
 *
 * Findings are classified on the way in, not on the way out, so nothing
 * unclassified is ever persisted and a later reader cannot encounter a raw
 * model claim by reading the wrong column.
 */
export function accumulate(
  state: ResearchState,
  output: ResearchStepOutput,
  newSources: readonly ResearchSource[],
): ResearchState {
  const sources = dedupeSources([...state.sources, ...newSources]);
  const classified = classifyFindings(output.findings, sources);

  return {
    stepsTaken: state.stepsTaken + 1,
    toolCallsMade: state.toolCallsMade + output.toolCalls.length,
    sources,
    findings: dedupeFindings([...state.findings, ...classified]),
    unknowns: Array.from(new Set([...state.unknowns, ...output.unknowns])).slice(0, 100),
    toolResults: state.toolResults,
    lastRequestedToolCount: output.toolCalls.length,
  };
}

const dedupeSources = (sources: readonly ResearchSource[]): ResearchSource[] => {
  const seen = new Map<string, ResearchSource>();
  for (const source of sources) if (!seen.has(source.ref)) seen.set(source.ref, source);
  return Array.from(seen.values()).slice(0, 400);
};

const dedupeFindings = (findings: readonly Finding[]): Finding[] => {
  const seen = new Map<string, Finding>();
  for (const finding of findings) {
    const key = finding.statement.trim().toLowerCase();
    const existing = seen.get(key);
    // Keep the better-grounded version when the same claim appears twice.
    if (!existing || finding.sources.length > existing.sources.length) seen.set(key, finding);
  }
  return Array.from(seen.values()).slice(0, 400);
};

/**
 * A tool call the run is not allowed to make.
 *
 * Returns null when it is allowed. Separated from the tool layer itself so the
 * refusal rules can be tested without a database, and so that "was this refused
 * for a good reason?" is a question with a readable answer.
 */
export function refuseToolCall(input: {
  tool: ResearchTool;
  permitted: readonly ResearchTool[];
  toolCallsMade: number;
  maxToolCalls: number;
}): string | null {
  if (input.toolCallsMade >= input.maxToolCalls) {
    return `The ${input.maxToolCalls}-tool-call ceiling for this run has been reached.`;
  }
  if (!input.permitted.includes(input.tool)) {
    return isExternalTool(input.tool)
      ? 'External research is not enabled for this deployment or this project.'
      : `The ${input.tool} source is not available for this run.`;
  }
  return null;
}
