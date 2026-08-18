import { z } from 'zod';
import { handoffBriefContentSchema } from './brief.js';
import { usageSnapshotSchema } from './usage.js';
import { evidenceRefSchema, groundednessSchema } from './evidence.js';

/**
 * The coding-agent abstraction (Sprint 2 §4).
 *
 * Mac is the manager; a coding agent is a worker. This file is the entire
 * vocabulary Mac uses to talk to one, and it mentions no vendor: the words are
 * "session", "question", "activity", "completion", not "Claude", "stream-json"
 * or "tool_use". That is what makes the Claude Code adapter replaceable rather
 * than load-bearing.
 *
 * Two implementations ship in Sprint 2 — the Claude Code CLI adapter and a mock
 * used by the test suite. Codex and others are deliberately NOT built; this
 * interface is the extension point, and nothing speculative is added for them.
 */

export const CODING_AGENT_PROVIDERS = ['claude_code', 'mock'] as const;
export const codingAgentProviderSchema = z.enum(CODING_AGENT_PROVIDERS);
export type CodingAgentProvider = z.infer<typeof codingAgentProviderSchema>;

export const AGENT_SESSION_STATES = [
  'starting',
  'running',
  'awaiting_answer',
  'completed',
  'failed',
  'cancelled',
] as const;
export const agentSessionStateSchema = z.enum(AGENT_SESSION_STATES);
export type AgentSessionState = z.infer<typeof agentSessionStateSchema>;

// ---------------------------------------------------------------------------
// What the agent is asked to do
// ---------------------------------------------------------------------------

/**
 * The task handed to a coding agent.
 *
 * Note what is present and what is absent. Present: the structured brief, the
 * worktree, the branch, hard limits. Absent: any command string, any path
 * outside the worktree, and the raw human conversation as the sole
 * specification.
 */
export const codingTaskSchema = z.object({
  runId: z.string().uuid(),
  taskId: z.string().uuid(),
  /** Absolute path of the isolated worktree. The agent's cwd; it may not escape it. */
  worktreePath: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  /** The structured handoff brief. Never a raw prompt. */
  brief: handoffBriefContentSchema,
  /** Rendered markdown of the same brief, for the agent's prompt. */
  briefMarkdown: z.string().min(1),
  /** argv arrays, admin-configured per repository. Empty when not configured. */
  testCommand: z.array(z.string()).default([]),
  buildCommand: z.array(z.string()).default([]),
  limits: z
    .object({
      maxMinutes: z.number().int().min(1).max(720).default(60),
      maxQuestions: z.number().int().min(0).max(200).default(20),
      /** Only enforceable when exact monetary cost is available. */
      maxBudgetUsd: z.number().min(0).nullable().default(null),
    })
    .default({}),
});
export type CodingTask = z.infer<typeof codingTaskSchema>;

// ---------------------------------------------------------------------------
// What the agent reports back
// ---------------------------------------------------------------------------

export const AGENT_EVENT_TYPES = [
  'session_started',
  'progress',
  'activity',
  'question',
  'output',
  'usage',
  'completed',
  'failed',
  'cancelled',
] as const;
export const agentEventTypeSchema = z.enum(AGENT_EVENT_TYPES);
export type AgentEventType = z.infer<typeof agentEventTypeSchema>;

const base = {
  /** Monotonic per session, so a retried upload is idempotent. */
  seq: z.number().int().min(0),
  at: z.string(),
};

export const agentEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('session_started'),
    providerSessionId: z.string().max(200).nullable(),
    model: z.string().max(120).nullable().optional(),
    providerVersion: z.string().max(60).nullable().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('progress'),
    stage: z.string().min(1).max(120),
    message: z.string().max(2000).optional(),
    percent: z.number().int().min(0).max(100).nullable().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('activity'),
    /** Neutral name of what the agent did: 'edit', 'read', 'command', 'search'. */
    tool: z.string().min(1).max(80),
    detail: z.string().max(2000).optional(),
  }),
  z.object({
    ...base,
    type: z.literal('question'),
    questionId: z.string().min(1).max(80),
    question: z.string().min(1).max(4000),
    context: z.string().max(4000).optional(),
  }),
  z.object({
    ...base,
    type: z.literal('output'),
    stream: z.enum(['stdout', 'stderr']),
    message: z.string().max(4000),
  }),
  z.object({ ...base, type: z.literal('usage'), snapshot: usageSnapshotSchema }),
  z.object({
    ...base,
    type: z.literal('completed'),
    summary: z.string().max(8000),
    filesTouched: z.array(z.string().max(400)).max(500).default([]),
  }),
  z.object({
    ...base,
    type: z.literal('failed'),
    error: z.string().max(4000),
    recoverable: z.boolean().default(false),
  }),
  z.object({ ...base, type: z.literal('cancelled'), reason: z.string().max(500) }),
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;

/**
 * An event before the sequence number and timestamp are stamped on.
 *
 * A plain `Omit<AgentEvent, 'seq' | 'at'>` does NOT work here: `Omit` is not
 * distributive, so applied to a discriminated union it collapses to the common
 * members and every variant-specific field becomes a type error. The
 * conditional type below distributes over the union, omitting from each member
 * separately and leaving the discriminant intact.
 */
export type AgentEventDraft = AgentEvent extends infer T
  ? T extends AgentEvent
    ? Omit<T, 'seq' | 'at'>
    : never
  : never;

// ---------------------------------------------------------------------------
// Mac's reply to a question
// ---------------------------------------------------------------------------

export const AGENT_ANSWER_DECISIONS = ['answered', 'assumed', 'blocked'] as const;
export const agentAnswerDecisionSchema = z.enum(AGENT_ANSWER_DECISIONS);
export type AgentAnswerDecision = z.infer<typeof agentAnswerDecisionSchema>;

export const agentAnswerSchema = z.object({
  questionId: z.string().min(1).max(80),
  decision: agentAnswerDecisionSchema,
  answer: z.string().max(8000),
  confidence: z.number().min(0).max(1),
  /** Why Mac answered this way. Persisted and shown in the run report. */
  reasoning: z.string().max(4000),
  /** Where the answer came from: brief field, memory key, repository fact. */
  sources: z.array(z.string().max(300)).max(20).default([]),
  requiredHuman: z.boolean().default(false),
  /** True when the answer is a recorded low-confidence assumption. */
  isAssumption: z.boolean().default(false),

  // --- Sprint 3 (§14 of the brief): evidence-based answers ------------------

  /**
   * The specific things Mac read, with enough of each to judge it.
   *
   * `sources` above is a list of labels; this is the material. Both are kept
   * because the labels are what a reviewer skims and the excerpts are what they
   * open when a label looks wrong.
   */
  evidence: z.array(evidenceRefSchema).max(40).default([]),
  /**
   * Whether this is something Mac ESTABLISHED or something he ASSUMED.
   *
   * Derived from the evidence by `deriveGroundedness`, never supplied by the
   * answering code — which is what makes "no ungrounded high-confidence claims"
   * a property rather than an aspiration.
   */
  groundedness: groundednessSchema.default('assumption'),
  /** Short prose version of the reasoning, for the report. */
  reasoningSummary: z.string().max(1000).default(''),
  /** True when a model contributed to the wording. Always visible to a reviewer. */
  modelAssisted: z.boolean().default(false),
  /** Which of the six source classes were consulted before answering. */
  sourcesChecked: z.array(z.string().max(60)).max(12).default([]),
});
export type AgentAnswer = z.infer<typeof agentAnswerSchema>;

/**
 * An answer before the schema fills in its defaults.
 *
 * Sprint 3 added evidence, groundedness and the checked-source list to an
 * answer. Those are properties of SUPERVISION — Mac reading his sources — and a
 * caller supplying an answer directly (a mock agent, a test fixture, a future
 * adapter) has no business inventing them. Typing the callback with the input
 * type lets those callers omit what they do not know, while the parse that
 * follows normalises every answer into the same shape.
 *
 * Same idiom as `AgentEventDraft`, for the same reason.
 */
export type AgentAnswerDraft = z.input<typeof agentAnswerSchema>;

// ---------------------------------------------------------------------------
// The interface itself
// ---------------------------------------------------------------------------

export interface CodingSessionHandle {
  readonly sessionId: string;
  readonly provider: CodingAgentProvider;
  /** Provider-native id, recorded so a dropped session can be re-attached. */
  providerSessionId: string | null;
  /** Resolves when the session reaches a terminal state. */
  readonly finished: Promise<AgentSessionResult>;
}

export interface AgentSessionResult {
  state: Extract<AgentSessionState, 'completed' | 'failed' | 'cancelled'>;
  summary: string;
  error?: string;
  filesTouched: string[];
  usage: z.infer<typeof usageSnapshotSchema> | null;
}

export interface CodingAgentContext {
  /** Called for every event the agent emits. Must not throw. */
  onEvent: (event: AgentEvent) => void | Promise<void>;
  /**
   * Called when the agent asks a question. The returned answer is delivered
   * back into the live session. Mac — not the worker — decides what it says.
   */
  onQuestion: (question: { questionId: string; question: string; context?: string }) => Promise<AgentAnswerDraft>;
  /** Aborted when the control plane requests a stop. */
  signal: AbortSignal;
}

export interface CodingAgent {
  readonly provider: CodingAgentProvider;
  /** Whether this agent is usable on this machine right now (CLI present, authenticated). */
  isAvailable(): Promise<{ available: boolean; reason?: string; version?: string }>;
  start(task: CodingTask, context: CodingAgentContext): Promise<CodingSessionHandle>;
  cancel(sessionId: string, reason: string): Promise<void>;
  /**
   * Samples provider usage. Implementations that cannot MUST return a snapshot
   * with `source: 'unavailable'` rather than fabricating one.
   */
  usageSnapshot(phase: 'before' | 'after'): Promise<z.infer<typeof usageSnapshotSchema>>;
}
