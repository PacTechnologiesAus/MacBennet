import { z } from 'zod';

/**
 * Evidence, investigation and grounding (Sprint 3 §6, §11).
 *
 * Sprint 2's supervision already returned an answer, a confidence, a reasoning
 * summary and a list of source labels. Sprint 3 adds the distinction the brief
 * asks for — is this an established fact or an assumption? — and makes it a
 * COMPUTED property rather than a claim.
 *
 * The rule that gives it teeth is in `deriveGroundedness` below: a claim of
 * "established fact" requires at least one factual evidence item. An answer
 * with nothing behind it is forced to `assumption` and its confidence is capped
 * beneath the answering threshold, so there is no code path that produces an
 * ungrounded high-confidence claim.
 */

// ---------------------------------------------------------------------------
// Source classes
// ---------------------------------------------------------------------------

/**
 * The six source classes Mac must exhaust before asking a human, in the order
 * he consults them (Sprint 3 §4 of the brief, §6 of the design).
 *
 * Order matters: repository facts are cheapest and least ambiguous, monday.com
 * is the slowest and most likely to be stale, and a human is last.
 */
export const INVESTIGATION_SOURCES = [
  'repository',
  'project_memory',
  'task_memory',
  'previous_runs',
  'previous_briefs',
  'monday',
] as const;
export const investigationSourceSchema = z.enum(INVESTIGATION_SOURCES);
export type InvestigationSource = z.infer<typeof investigationSourceSchema>;

/**
 * What kind of thing a piece of evidence is.
 *
 * `inferred_assumption` is the only non-factual kind, and it is the one that
 * cannot on its own support a claim of established fact.
 */
export const EVIDENCE_KINDS = [
  'repository_fact',
  'project_memory',
  'task_memory',
  'user_approved_decision',
  'previous_run',
  'monday_item',
  'inferred_assumption',
] as const;
export const evidenceKindSchema = z.enum(EVIDENCE_KINDS);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

export const FACTUAL_EVIDENCE_KINDS: readonly EvidenceKind[] = [
  'repository_fact',
  'project_memory',
  'task_memory',
  'user_approved_decision',
  'previous_run',
  'monday_item',
];

export const evidenceRefSchema = z.object({
  kind: evidenceKindSchema,
  /** Stable, resolvable provenance: `brief.constraints[2]`, `monday:item/8891`. */
  ref: z.string().min(1).max(300),
  /** Enough of the source to judge it without opening it. Bounded on purpose. */
  excerpt: z.string().max(1000),
});
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

export const GROUNDEDNESS = ['established_fact', 'assumption'] as const;
export const groundednessSchema = z.enum(GROUNDEDNESS);
export type Groundedness = z.infer<typeof groundednessSchema>;

/**
 * Groundedness is derived, never asserted.
 *
 * This is the whole mechanism behind "do not make ungrounded high-confidence
 * claims": callers cannot pass `established_fact` in, they can only supply
 * evidence and be told what that evidence supports.
 */
export function deriveGroundedness(evidence: readonly EvidenceRef[]): Groundedness {
  return evidence.some((e) => FACTUAL_EVIDENCE_KINDS.includes(e.kind)) ? 'established_fact' : 'assumption';
}

/**
 * The confidence an ungrounded answer may claim at most.
 *
 * Sits just below any sane answering threshold so that an answer with no
 * factual evidence can never be treated as one Mac may act on outright. Applied
 * in `capUngroundedConfidence`, which is called on every answer before it is
 * persisted.
 */
export const UNGROUNDED_CONFIDENCE_CEILING = 0.59;

export function capUngroundedConfidence(confidence: number, evidence: readonly EvidenceRef[]): number {
  if (deriveGroundedness(evidence) === 'established_fact') return confidence;
  return Math.min(confidence, UNGROUNDED_CONFIDENCE_CEILING);
}

// ---------------------------------------------------------------------------
// Investigation
// ---------------------------------------------------------------------------

export const sourceCheckSchema = z.object({
  source: investigationSourceSchema,
  /** False when the source simply was not available for this task. */
  consulted: z.boolean(),
  matched: z.boolean(),
  /** What was looked at and what came back. Persisted so escalation is falsifiable. */
  note: z.string().max(600),
});
export type SourceCheck = z.infer<typeof sourceCheckSchema>;

export const INVESTIGATION_SUBJECT_KINDS = ['dimension', 'agent_question'] as const;
export const investigationSubjectKindSchema = z.enum(INVESTIGATION_SUBJECT_KINDS);
export type InvestigationSubjectKind = z.infer<typeof investigationSubjectKindSchema>;

export const investigationResultSchema = z.object({
  subjectKind: investigationSubjectKindSchema,
  subject: z.string().min(1).max(1000),
  resolved: z.boolean(),
  answer: z.string().max(8000).nullable().default(null),
  confidence: z.number().min(0).max(1),
  evidence: z.array(evidenceRefSchema).max(40).default([]),
  /** EVERY source, whether or not it helped. This is the escalation receipt. */
  checked: z.array(sourceCheckSchema).default([]),
  escalatedToHuman: z.boolean().default(false),
  modelAssisted: z.boolean().default(false),
});
export type InvestigationResult = z.infer<typeof investigationResultSchema>;

/**
 * Weight given to a dimension satisfied by investigation rather than by the
 * human saying it (Sprint 3 §6.2).
 *
 * Not 1.0. Mac deducing the testing convention from four sources is genuine
 * evidence, but it is weaker than being told, and pretending otherwise would
 * let understanding confidence reach the autonomous band on inference alone.
 * Sprint 2 already set the precedent at 0.5 for merely *discoverable*; actually
 * having gone and discovered it is worth more than that, and less than being
 * told.
 */
export const INVESTIGATED_DIMENSION_WEIGHT = 0.75;
