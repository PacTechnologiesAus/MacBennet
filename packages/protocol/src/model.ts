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

export const MODEL_PROVIDERS = ['anthropic', 'scripted', 'none'] as const;
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
