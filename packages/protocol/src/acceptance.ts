import { z } from 'zod';
import { ARTEFACT_TYPES } from './artefacts.js';
import { EVIDENCE_CLASSES } from './artefacts.js';
import { SOURCE_CLASSES } from './web-research.js';

/**
 * Verifying that the work approved is the work that was done (Phase 4 Part F).
 *
 * ---------------------------------------------------------------------------
 * THE RUN THAT CAUSED THIS FILE
 *
 * Commissioning §13.3, on the first real research run:
 *
 *   "One artefact, where the task description names five. The description asks
 *    for three briefs, a cross-system architecture recommendation and a build
 *    order. The handoff brief derived at discovery reduced that to 'a written
 *    recommendation covering all three', and the run correctly followed the
 *    brief."
 *
 * Every component behaved. Discovery structured the request, the brief became
 * the contract, the run executed the contract, and the report described what
 * the run did. What no component did was ask whether the thing delivered was
 * the thing asked for — because nothing in the system held a machine-checkable
 * statement of what "asked for" meant that survived from the request to the
 * moment of completion.
 *
 * That is what these criteria are. Not a new gate on top of the brief: the
 * brief REMAINS the contract. This is the contract written down in a form that
 * can be checked at the end rather than only read at the start.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Criteria
// ---------------------------------------------------------------------------

export const ACCEPTANCE_CRITERION_KINDS = [
  'artefact_count',
  'artefact_type',
  'named_section',
  'evidence_class',
  'source_class',
  'external_sources',
  'test_run',
  'review_step',
  'semantic',
] as const;
export const acceptanceCriterionKindSchema = z.enum(ACCEPTANCE_CRITERION_KINDS);
export type AcceptanceCriterionKind = z.infer<typeof acceptanceCriterionKindSchema>;

const base = {
  id: z.string().min(1).max(80),
  /** What a human reads. Always present, even for a mechanical count. */
  description: z.string().min(1).max(600),
  /**
   * An unmet OPTIONAL criterion is reported and does not create a gap.
   *
   * Present so that "it would be good if this cited a standard" can be recorded
   * without turning every nice-to-have into a reason a run is not complete.
   */
  required: z.boolean().default(true),
  /** Where it came from, so a human can tell a derived criterion from theirs. */
  source: z.enum(['derived', 'human', 'task_kind']).default('derived'),
};

/**
 * The criteria, as a discriminated union.
 *
 * A union rather than a `kind` plus a bag of optional parameters, because the
 * bag version permits `{ kind: 'artefact_count' }` with no count — which parses,
 * stores, and then silently passes at review time. A criterion that cannot fail
 * is worse than no criterion, because it looks like coverage.
 */
export const acceptanceCriterionSchema = z.discriminatedUnion('kind', [
  z.object({
    ...base,
    kind: z.literal('artefact_count'),
    /** At least this many artefacts of any type. */
    minimum: z.number().int().min(1).max(50),
  }),
  z.object({
    ...base,
    kind: z.literal('artefact_type'),
    artefactType: z.enum(ARTEFACT_TYPES),
    minimum: z.number().int().min(1).max(50).default(1),
  }),
  z.object({
    ...base,
    kind: z.literal('named_section'),
    /** Matched tolerantly against artefact headings. See `normaliseHeading`. */
    section: z.string().min(1).max(200),
  }),
  z.object({
    ...base,
    kind: z.literal('evidence_class'),
    evidenceClass: z.enum(EVIDENCE_CLASSES),
    minimum: z.number().int().min(1).max(200).default(1),
  }),
  z.object({
    ...base,
    kind: z.literal('source_class'),
    /** Any one of these satisfies it. "A primary source" is several classes. */
    sourceClasses: z.array(z.enum(SOURCE_CLASSES)).min(1).max(SOURCE_CLASSES.length),
    minimum: z.number().int().min(1).max(200).default(1),
  }),
  z.object({
    ...base,
    kind: z.literal('external_sources'),
    minimum: z.number().int().min(1).max(200).default(1),
  }),
  z.object({
    ...base,
    kind: z.literal('test_run'),
    /** True when the tests must also have passed, not merely been run. */
    mustPass: z.boolean().default(true),
  }),
  z.object({
    ...base,
    kind: z.literal('review_step'),
  }),
  z.object({
    ...base,
    kind: z.literal('semantic'),
    /**
     * The claim a model is asked to judge, phrased so that a NO is meaningful.
     *
     * "The report is good" cannot be judged. "The report states a rough cost for
     * each of the three systems" can.
     */
    statement: z.string().min(1).max(1000),
  }),
]);
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;

export const acceptanceCriteriaSchema = z.array(acceptanceCriterionSchema).max(40).default([]);

/** Criteria a deterministic check can decide. Everything except `semantic`. */
export const isDeterministicCriterion = (criterion: AcceptanceCriterion): boolean => criterion.kind !== 'semantic';

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export const CRITERION_VERDICTS = [
  'satisfied',
  'unmet',
  /** The criterion does not apply to this run — a test criterion on research. */
  'not_applicable',
  /** Could not be decided. Counts as unmet when required; never as satisfied. */
  'indeterminate',
] as const;
export const criterionVerdictSchema = z.enum(CRITERION_VERDICTS);
export type CriterionVerdict = z.infer<typeof criterionVerdictSchema>;

export const criterionResultSchema = z.object({
  criterionId: z.string().min(1).max(80),
  kind: acceptanceCriterionKindSchema,
  description: z.string().max(600),
  required: z.boolean(),
  verdict: criterionVerdictSchema,
  /** How it was decided. `semantic` results say `model`. */
  method: z.enum(['deterministic', 'model']),
  /** What was actually observed, e.g. "2 artefacts, 3 required". */
  observed: z.string().max(1000).default(''),
  /** For a model judgement, its reasoning. Empty for a count. */
  reasoning: z.string().max(2000).default(''),
});
export type CriterionResult = z.infer<typeof criterionResultSchema>;

/**
 * The run's overall acceptance position.
 *
 * `not_assessed` is not a failure and not a gap. It is what a run with no
 * criteria says, which is every coding run that existed before Phase 4 — and it
 * is why adding acceptance verification does not change what those runs do.
 */
export const ACCEPTANCE_STATES = ['not_assessed', 'satisfied', 'gaps', 'failed'] as const;
export const acceptanceStateSchema = z.enum(ACCEPTANCE_STATES);
export type AcceptanceState = z.infer<typeof acceptanceStateSchema>;

export const ACCEPTANCE_STATE_LABELS: Record<AcceptanceState, string> = {
  not_assessed: 'No acceptance criteria were recorded',
  satisfied: 'Every required criterion was met',
  gaps: 'Delivered, with required criteria unmet',
  failed: 'Nothing was delivered',
};

export interface AcceptanceReviewDto {
  runId: string;
  state: AcceptanceState;
  results: CriterionResult[];
  /** Required criteria with a verdict other than `satisfied`. */
  unmet: CriterionResult[];
  /** Whether a remediation pass was attempted, and what it changed. */
  remediationAttempted: boolean;
  remediationNote: string | null;
  /** True when a model was consulted for at least one criterion. */
  modelAssisted: boolean;
  reviewedAt: string;
}

/**
 * Decides the overall state from the per-criterion results.
 *
 * ---------------------------------------------------------------------------
 * THE TWO RULES THAT MATTER
 *
 * 1. NOTHING DELIVERED IS A FAILURE, NOT A GAP. Commissioning established this
 *    the expensive way: a run that produced no artefacts reported success and a
 *    morning email announced a finished investigation containing nothing. A gap
 *    means "delivered, but not all of it". No delivery is a different word.
 *
 * 2. INDETERMINATE IS NOT SATISFIED. A criterion nobody could decide is not a
 *    criterion that passed. Counting it as passing would make every check
 *    degrade to green the moment it broke, which is the worst possible failure
 *    direction for a mechanism whose entire job is to notice.
 * ---------------------------------------------------------------------------
 */
export function deriveAcceptanceState(input: {
  results: readonly CriterionResult[];
  /** Artefacts the run actually produced. Zero is a failure regardless. */
  artefactsProduced: number;
  /** False for runs whose deliverable is a pull request rather than an artefact. */
  expectsArtefacts: boolean;
}): AcceptanceState {
  if (input.results.length === 0) return 'not_assessed';
  if (input.expectsArtefacts && input.artefactsProduced === 0) return 'failed';

  const unmet = input.results.filter((r) => r.required && r.verdict !== 'satisfied' && r.verdict !== 'not_applicable');
  return unmet.length === 0 ? 'satisfied' : 'gaps';
}

export const unmetCriteria = (results: readonly CriterionResult[]): CriterionResult[] =>
  results.filter((r) => r.required && r.verdict !== 'satisfied' && r.verdict !== 'not_applicable');

// ---------------------------------------------------------------------------
// Heading matching
// ---------------------------------------------------------------------------

/**
 * Normalises a heading for tolerant comparison.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT `body.includes(section)`
 *
 * Because the brief warns against brittle string matching and is right to. A
 * criterion "Build order" would be satisfied by a sentence reading "we did not
 * establish a build order", which is the exact opposite of the thing being
 * checked.
 *
 * So the match is against HEADINGS — the document's own statement of its
 * structure — normalised for case, punctuation, articles and whitespace, and
 * satisfied by containment in either direction so that "Build order" matches a
 * heading reading "Recommended build order".
 *
 * A requirement that cannot be expressed as a heading is not forced into this
 * shape. It is marked `semantic` and judged by a model.
 * ---------------------------------------------------------------------------
 */
export function normaliseHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~#]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|a|an|of|for|and|to)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every markdown heading in a document, normalised. */
export function extractHeadings(markdown: string): string[] {
  const headings: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const atx = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (atx) {
      headings.push(normaliseHeading(atx[1]!));
      continue;
    }
    // Bold-only lines are how models write headings when told to reply in JSON.
    const bold = /^\s*\*\*(.+?)\*\*\s*:?\s*$/.exec(line);
    if (bold) headings.push(normaliseHeading(bold[1]!));
  }
  return headings.filter(Boolean);
}

export function headingSatisfies(required: string, headings: readonly string[]): boolean {
  const want = normaliseHeading(required);
  if (!want) return false;
  return headings.some((heading) => heading === want || heading.includes(want) || want.includes(heading));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderAcceptanceMarkdown(review: AcceptanceReviewDto): string {
  const lines: string[] = ['## Acceptance criteria', ''];
  lines.push(`**${ACCEPTANCE_STATE_LABELS[review.state]}**`, '');

  for (const result of review.results) {
    const mark = result.verdict === 'satisfied' ? '[x]' : result.verdict === 'not_applicable' ? '[–]' : '[ ]';
    const suffix = result.observed ? ` — ${result.observed}` : '';
    lines.push(`- ${mark} ${result.description}${suffix}${result.required ? '' : ' _(optional)_'}`);
  }

  if (review.unmet.length) {
    lines.push('', '### Not satisfied', '');
    for (const result of review.unmet) {
      lines.push(`- ${result.description}${result.observed ? ` — ${result.observed}` : ''}`);
      if (result.reasoning) lines.push(`  - ${result.reasoning}`);
    }
  }

  if (review.remediationAttempted && review.remediationNote) {
    lines.push('', `_Remediation: ${review.remediationNote}_`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The model's judgement, bounded
// ---------------------------------------------------------------------------

/**
 * What a model may return when asked to judge a semantic criterion.
 *
 * Note what it cannot say. There is no field for "and therefore the run is
 * complete", no field for a state, and no field for overriding another
 * criterion. It answers one yes/no question about one statement, and the
 * control plane decides what that means — the same division `research.ts`
 * makes, for the same reason.
 */
export const semanticJudgementSchema = z.object({
  criterionId: z.string().min(1).max(80),
  satisfied: z.boolean(),
  /** Quote or reference from the work that decided it. Empty is suspicious. */
  evidence: z.string().max(2000).default(''),
  reasoning: z.string().max(2000).default(''),
});
export type SemanticJudgement = z.infer<typeof semanticJudgementSchema>;

export const semanticJudgementBatchSchema = z.object({
  judgements: z.array(semanticJudgementSchema).max(40).default([]),
});
export type SemanticJudgementBatch = z.infer<typeof semanticJudgementBatchSchema>;
