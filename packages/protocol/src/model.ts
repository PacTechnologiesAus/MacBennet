import { z } from 'zod';

/**
 * Model-backed assistance (Sprint 3 §10, brief §13).
 *
 * Sprint 2 answered questions by scoring recorded sources, and said plainly
 * that a model-backed resolver was a drop-in replacement for `resolveAnswer`.
 * Sprint 3 builds it — and the interesting part is not the model call, it is
 * the shape of what the model is allowed to return.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE MODEL CANNOT DO, STRUCTURALLY
 *
 * The model receives candidate sources the deterministic layer already
 * selected, and returns `{ answer, reasoning, citedSourceIds }`. It does not
 * return a confidence. It does not return a risk class. It does not return a
 * decision. Those are not fields it is trusted to fill correctly and then
 * checked — they are fields that do not exist on its output type.
 *
 * Then, in code:
 *
 *   1. a cited id that was not in the supplied set is DROPPED, so a fabricated
 *      citation cannot survive contact with the caller;
 *   2. if nothing survives, the model's answer is DISCARDED and the
 *      deterministic resolver's result is used;
 *   3. confidence is RECOMPUTED from the surviving sources by the same function
 *      used when no model is configured.
 *
 * So the worst a hallucinating or compromised model can do is produce fluent
 * prose with a low deterministic confidence — which the existing decision
 * policy then treats as an assumption or a blocker.
 * ---------------------------------------------------------------------------
 */

/**
 * Sprint 3.3: `openai` joins the list, and the reason is not vendor preference.
 *
 * Spec section 31 requires "replaceable model providers", plural. One real
 * provider behind an interface is an interface nobody has ever tested against a
 * second implementation, and interfaces like that are usually wrong in ways
 * discovered on the day they matter. Two real providers keeps the seam honest.
 *
 * `none` remains the DEFAULT, and remains correct as a default: a model that is
 * off cannot degrade an answer at 03:00. What Sprint 3.3 changes is that
 * genuine research work now REFUSES to run against `none` rather than silently
 * producing nothing (see `MODEL_PROVIDER_REQUIRED`).
 */
export const MODEL_PROVIDERS = ['anthropic', 'openai', 'scripted', 'none'] as const;
export const modelProviderSchema = z.enum(MODEL_PROVIDERS);
export type ModelProviderName = z.infer<typeof modelProviderSchema>;

export interface ModelCompletionRequest {
  system: string;
  prompt: string;
  maxTokens: number;
  /** Names the shape the caller will parse. Advisory to the provider. */
  expectJson?: boolean;
}

export interface ModelCompletionResult {
  text: string;
  model: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  /**
   * Why the model stopped, verbatim from the provider where it says.
   *
   * `'max_tokens'` (Anthropic) and `'length'` (OpenAI) both mean the reply was
   * CUT OFF rather than finished, which for a JSON response means it will not
   * parse and the step produced nothing usable.
   *
   * This was previously discarded. The first real research run on the
   * commissioned VM truncated its write-up at exactly the token ceiling, failed
   * to parse, produced no artefacts, and still reported success — because the
   * one field that would have distinguished "the model had nothing to say" from
   * "we cut the model off mid-sentence" was thrown away while parsing the
   * response. `null` where a provider does not report one.
   */
  stopReason: string | null;
}

export interface ModelProvider {
  readonly name: ModelProviderName;
  isAvailable(): Promise<{ available: boolean; reason?: string }>;
  complete(request: ModelCompletionRequest): Promise<ModelCompletionResult>;
}

/**
 * The ONLY shape a model may return when assisting with an answer.
 *
 * Note the absence of `confidence`. A model that volunteers one has nowhere to
 * put it, and a caller that wanted to use one would have to add the field —
 * which is a reviewable change rather than an accident.
 */
export const modelAnswerSchema = z.object({
  answer: z.string().min(1).max(8000),
  reasoning: z.string().max(4000).default(''),
  /** Must reference ids the caller supplied. Anything else is dropped. */
  citedSourceIds: z.array(z.string().max(300)).max(20).default([]),
});
export type ModelAnswer = z.infer<typeof modelAnswerSchema>;

/** The model's contribution to structuring a free-flow brief. */
export const modelBriefStructureSchema = z.object({
  userObjective: z.string().max(4000).optional(),
  currentBehaviour: z.string().max(4000).optional(),
  desiredBehaviour: z.string().max(4000).optional(),
  proposedScope: z.string().max(4000).optional(),
  constraints: z.array(z.string().max(600)).max(40).optional(),
  mustNotChange: z.array(z.string().max(300)).max(40).optional(),
  acceptanceCriteria: z.array(z.string().max(600)).max(40).optional(),
  testingExpectations: z.array(z.string().max(600)).max(40).optional(),
  likelyAffectedComponents: z.array(z.string().max(300)).max(40).optional(),
  outOfScope: z.array(z.string().max(600)).max(40).optional(),
  /** What the model believes is still missing. Advisory input to gap analysis. */
  missingInformation: z.array(z.string().max(600)).max(20).optional(),
});
export type ModelBriefStructure = z.infer<typeof modelBriefStructureSchema>;

export const MODEL_OUTCOMES = ['accepted', 'rejected_no_valid_citation', 'rejected_unparseable', 'unavailable'] as const;
export const modelOutcomeSchema = z.enum(MODEL_OUTCOMES);
export type ModelOutcome = z.infer<typeof modelOutcomeSchema>;

/** What gets audited about every model-assisted step. */
export interface ModelAssistRecord {
  provider: ModelProviderName;
  model: string | null;
  outcome: ModelOutcome;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Citations the model produced that did not exist. The interesting number. */
  fabricatedCitations: number;
  detail: string | null;
}

// ---------------------------------------------------------------------------
// Sprint 3.3 — general reasoning
// ---------------------------------------------------------------------------

/**
 * Providers that talk to a real model on a real account.
 *
 * `scripted` is deliberately included: it is a real provider from the caller's
 * point of view — it returns what it was told to return, deterministically —
 * and excluding it would make every research test require a network and a
 * credential, which is how test suites come to be skipped.
 *
 * `none` is the one that is not. That distinction is the whole of
 * `MODEL_PROVIDER_REQUIRED`.
 */
export const REAL_MODEL_PROVIDERS: readonly ModelProviderName[] = ['anthropic', 'openai', 'scripted'];

export const isRealModelProvider = (name: ModelProviderName): boolean => REAL_MODEL_PROVIDERS.includes(name);

/**
 * The error code raised when genuine reasoning work has no provider.
 *
 * Sprint 3.3 section 10 is explicit that a null provider must not silently
 * stand in for a model during real research. The distinction being drawn:
 *
 *   * model ASSISTANCE (phrasing an answer the deterministic layer already
 *     grounded) degrades safely to nothing, and always has;
 *   * model REASONING (going and finding something out) has no deterministic
 *     fallback, so producing an empty result would be indistinguishable from
 *     having researched the question and found nothing.
 *
 * The second is a lie a report would then repeat, so it fails instead.
 */
export const MODEL_PROVIDER_REQUIRED = 'MODEL_PROVIDER_REQUIRED';

/**
 * How Mac's reasoning model is reached, and what that means for accounting.
 *
 * Sprint 3.3 section 12 asks this to be stated rather than assumed. It matters
 * because a coding-agent subscription and a reasoning-model API are DIFFERENT
 * access mechanisms with different usage visibility, and assuming otherwise
 * would produce a budget that silently does not apply.
 */
export const MODEL_ACCESS_MODES = ['api_key', 'subscription_cli'] as const;
export const modelAccessModeSchema = z.enum(MODEL_ACCESS_MODES);
export type ModelAccessMode = z.infer<typeof modelAccessModeSchema>;

export interface ModelAccessDescriptor {
  provider: ModelProviderName;
  mode: ModelAccessMode;
  /** Whether the provider reports token counts we can bill against a budget. */
  reportsExactUsage: boolean;
  note: string;
}

/**
 * What each provider actually offers.
 *
 * Written down because the tempting assumption — "Claude Code works off a
 * subscription, so Mac's reasoning model can too" — is false. Claude Code is a
 * CLI that holds its own OAuth session; the Messages API is a separate,
 * key-authenticated product. Mac's reasoning path uses the API, which means
 * per-token cost we can see, which is what preserves the budget controls.
 */
export const MODEL_ACCESS: readonly ModelAccessDescriptor[] = [
  {
    provider: 'anthropic',
    mode: 'api_key',
    reportsExactUsage: true,
    note:
      'Anthropic Messages API, authenticated by ANTHROPIC_API_KEY. Returns input and output token counts on ' +
      'every call. A Claude Code subscription does NOT grant this access; the coding agent authenticates ' +
      'separately and its usage is accounted separately.',
  },
  {
    provider: 'openai',
    mode: 'api_key',
    reportsExactUsage: true,
    note: 'OpenAI Chat Completions API, authenticated by OPENAI_API_KEY. Returns prompt and completion token counts.',
  },
  {
    provider: 'scripted',
    mode: 'api_key',
    reportsExactUsage: true,
    note: 'Test provider. Returns supplied responses and character-count usage. Never reaches a network.',
  },
  {
    provider: 'none',
    mode: 'api_key',
    reportsExactUsage: false,
    note: 'No provider. Model assistance degrades to the deterministic path; genuine research work refuses to run.',
  },
];

export const describeModelAccess = (provider: ModelProviderName): ModelAccessDescriptor =>
  MODEL_ACCESS.find((a) => a.provider === provider) ?? MODEL_ACCESS[MODEL_ACCESS.length - 1]!;

/**
 * A reasoning call, as distinct from an assistance call.
 *
 * The difference in the type is `expectSchema`: reasoning callers parse the
 * result against a schema they name, and a provider that cannot honour the
 * request still returns text rather than inventing structure. Cancellation is
 * carried explicitly because a research step must abort when the run does —
 * Sprint 3.3 section 11 lists cancellation as part of the provider contract.
 */
export interface ReasoningRequest extends ModelCompletionRequest {
  /** Aborts the underlying request. Honoured by every real provider. */
  signal?: AbortSignal;
  /** Names the shape the caller will parse. Advisory to the provider. */
  schemaName?: string;
}

/** Usage from one reasoning call, in the shape the usage model records. */
export interface ReasoningUsage {
  provider: ModelProviderName;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}
