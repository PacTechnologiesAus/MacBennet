import { z } from 'zod';
import { artefactContentSchema, findingSchema } from './artefacts.js';

/**
 * The controlled research tool layer (Sprint 3.3 §14, §15).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS AN ALLOWLIST AND NOT A TOOL-CALLING FREE-FOR-ALL
 *
 * The obvious way to build a research agent in 2026 is to hand a model a set of
 * tools and let it decide. That is exactly what `jobs.ts` refused to do for
 * execution, for exactly the same reason: a protocol with a field for "run this
 * command" is a remote shell no matter what the surrounding prose says.
 *
 * So the model does not call tools. It NAMES one of the tools below and
 * supplies a query string, and the control plane decides whether to perform it.
 * Every tool is scoped server-side to the run's own task and project — the
 * model cannot broaden a search to another customer's project by asking nicely,
 * because the scope is not a parameter it supplies.
 *
 * The three internal tools read material Mac is already entitled to. The two
 * external ones are off unless the project declares `external_research`, and
 * everything they retrieve is recorded with its query, source and timestamp so
 * a claim can be traced back to what was actually fetched (§15).
 * ---------------------------------------------------------------------------
 */

export const RESEARCH_TOOLS = [
  /** Approved PAC company context at the run's bound revision. */
  'company_context_search',
  /** Project and global memory for this project. */
  'project_memory_search',
  /** Questions Mac answered on earlier runs in this project, and their answers. */
  'prior_run_search',
  /** Constraints and decisions from earlier handoff briefs in this project. */
  'brief_search',
  /** The inspected repository snapshot, where the project has one. */
  'repository_search',
  /** The linked monday item's description and update feed, where one exists. */
  'monday_search',
  /** Public web search. Requires the project to permit external research. */
  'public_web_search',
  /** Retrieval of a specific public document. Requires external research. */
  'public_doc_fetch',
] as const;
export const researchToolSchema = z.enum(RESEARCH_TOOLS);
export type ResearchTool = z.infer<typeof researchToolSchema>;

/** Tools that leave PAC's own systems. Gated on project capability. */
export const EXTERNAL_RESEARCH_TOOLS: readonly ResearchTool[] = ['public_web_search', 'public_doc_fetch'];

export const isExternalTool = (tool: ResearchTool): boolean => EXTERNAL_RESEARCH_TOOLS.includes(tool);

export const RESEARCH_TOOL_LABELS: Record<ResearchTool, string> = {
  company_context_search: 'PAC company context',
  project_memory_search: 'Project memory',
  prior_run_search: 'Prior runs',
  brief_search: 'Earlier briefs',
  repository_search: 'Repository',
  monday_search: 'monday.com item',
  public_web_search: 'Public web search',
  public_doc_fetch: 'Public document',
};

/**
 * A tool the model asked for, and the query it supplied.
 *
 * Note what is absent: a path, a URL for internal tools, a project id, a scope,
 * a limit. Those are decided server-side from the run. `argument` is a search
 * string, or — for `public_doc_fetch` alone — a URL, which the tool layer
 * validates against its own scheme and host rules before fetching anything.
 */
export const researchToolCallSchema = z.object({
  tool: researchToolSchema,
  argument: z.string().min(1).max(1000),
  /** Why the model wants it. Recorded so a reader can judge the search itself. */
  purpose: z.string().max(500).default(''),
});
export type ResearchToolCall = z.infer<typeof researchToolCallSchema>;

/** One retrieved item. `ref` must be resolvable; `retrievedAt` must be real. */
export const researchSourceSchema = z.object({
  ref: z.string().min(1).max(500),
  label: z.string().max(300).default(''),
  excerpt: z.string().max(4000).default(''),
  retrievedAt: z.string(),
  /** True when it came from outside PAC. Drives evidence classification. */
  external: z.boolean().default(false),
});
export type ResearchSource = z.infer<typeof researchSourceSchema>;

export const researchToolResultSchema = z.object({
  tool: researchToolSchema,
  argument: z.string().max(1000),
  /** False when the tool is not permitted or not available for this run. */
  performed: z.boolean(),
  /** Present when `performed` is false. A reason a human can act on. */
  refusalReason: z.string().max(500).nullable().default(null),
  sources: z.array(researchSourceSchema).max(40).default([]),
  at: z.string(),
});
export type ResearchToolResult = z.infer<typeof researchToolResultSchema>;

// ---------------------------------------------------------------------------
// The research loop
// ---------------------------------------------------------------------------

export const RESEARCH_STEP_KINDS = ['gather', 'synthesise', 'finalise'] as const;
export const researchStepKindSchema = z.enum(RESEARCH_STEP_KINDS);
export type ResearchStepKind = z.infer<typeof researchStepKindSchema>;

/**
 * What the model may return at the end of one step.
 *
 * As in `model.ts`, notice what it CANNOT say. There is no field for "I am
 * done, mark this run successful", no field for a confidence on the run, and no
 * field for an action. It may ask for more sources, contribute findings, or
 * offer deliverables — and the control plane decides what that means.
 */
export const researchStepOutputSchema = z.object({
  /** What the model wants to look at next. Empty means it has enough. */
  toolCalls: z.array(researchToolCallSchema).max(6).default([]),
  /** Claims established or drawn during this step. */
  findings: z.array(findingSchema).max(50).default([]),
  /** Free-text account of the step, shown as run progress. */
  narrative: z.string().max(4000).default(''),
  /** Deliverables. Only read on a `finalise` step. */
  artefacts: z.array(artefactContentSchema).max(10).default([]),
  /** Things the model could not establish. Reported, never filled in. */
  unknowns: z.array(z.string().min(1).max(1000)).max(40).default([]),
  /**
   * A decision the model believes needs a human.
   *
   * Advisory: the control plane decides whether this becomes a run blocker,
   * because "should I stop and ask?" is a guardrail question and guardrails are
   * not delegated to models anywhere else in this system either.
   */
  blockerProposed: z.string().max(1000).nullable().default(null),
});
export type ResearchStepOutput = z.infer<typeof researchStepOutputSchema>;

/**
 * Bounds on the loop.
 *
 * A research run that never terminates is the same operational problem as a
 * coding run that never terminates, and the same answer applies: a hard ceiling
 * enforced in code, not a hope expressed in a prompt.
 */
export const RESEARCH_LIMITS = {
  maxSteps: 12,
  maxToolCallsPerStep: 6,
  maxTotalToolCalls: 40,
  maxSourcesPerTool: 20,
  maxArtefactsPerRun: 10,
} as const;

/** Progress stages a general run reports, in order. */
export const RESEARCH_STAGES = ['planning', 'gathering', 'synthesising', 'writing', 'complete'] as const;
export type ResearchStage = (typeof RESEARCH_STAGES)[number];

/**
 * The plan the control plane builds before the first model call.
 *
 * Built from the handoff brief, deterministically. The model is given the plan;
 * it does not write it. That keeps the objective and the deliverables under the
 * brief's control — the brief is the execution contract (Sprint 3.3 §18), and a
 * model that could rewrite its own objective would not be executing a contract.
 */
export const researchPlanSchema = z.object({
  objective: z.string().min(1).max(4000),
  deliverables: z.array(z.string().min(1).max(600)).max(20).default([]),
  acceptanceCriteria: z.array(z.string().min(1).max(600)).max(20).default([]),
  /** Tools this run may use, already filtered by project capability. */
  permittedTools: z.array(researchToolSchema).max(RESEARCH_TOOLS.length).default([]),
  /** What the brief says is out of bounds. */
  constraints: z.array(z.string().min(1).max(600)).max(40).default([]),
  authorityBoundaries: z.array(z.string().min(1).max(600)).max(20).default([]),
  maxSteps: z.number().int().min(1).max(RESEARCH_LIMITS.maxSteps),
});
export type ResearchPlan = z.infer<typeof researchPlanSchema>;

/** Accumulated state of one research run. Persisted between steps. */
export const researchStateSchema = z.object({
  stepsTaken: z.number().int().min(0).default(0),
  toolCallsMade: z.number().int().min(0).default(0),
  sources: z.array(researchSourceSchema).max(400).default([]),
  findings: z.array(findingSchema).max(400).default([]),
  unknowns: z.array(z.string().max(1000)).max(100).default([]),
  toolResults: z.array(researchToolResultSchema).max(200).default([]),
});
export type ResearchState = z.infer<typeof researchStateSchema>;

export const emptyResearchState = (): ResearchState => researchStateSchema.parse({});
