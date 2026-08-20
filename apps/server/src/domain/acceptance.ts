import {
  acceptanceCriterionSchema,
  extractHeadings,
  headingSatisfies,
  isFactualClass,
  isPrimarySource,
  type AcceptanceCriterion,
  type ArtefactType,
  type CriterionResult,
  type EvidenceClass,
  type Finding,
  type SourceClass,
  type TaskKind,
  type HandoffBriefContent,
  type OpenQuestion,
} from '@mac/protocol';
import { assessCurrency } from './currency.js';
import { analyseDeliverables, detectDeliverables, NEGATORS, type DeliverableMention } from './deliverables.js';

/*
 * Re-exported so that `domain/acceptance.js` stays the one import every caller
 * and test already uses. Deliverable reading moved to its own module for
 * defect 9; where it is imported FROM should not have to move with it.
 */
export {
  analyseDeliverables,
  detectDeliverables,
  extractDeliverableCandidates,
  normaliseDeliverables,
} from './deliverables.js';
export type {
  DeliverableAmbiguity,
  DeliverableAnalysis,
  DeliverableCandidate,
  DeliverableMention,
  DeliverableRelationship,
  DeliverableResolution,
  NormalisedDeliverable,
} from './deliverables.js';

/**
 * Deriving acceptance criteria, and checking them (Phase 4 Part F).
 *
 * ---------------------------------------------------------------------------
 * THE RUN THIS EXISTS BECAUSE OF
 *
 * Commissioning §13.3: a task description asking for three engineering briefs,
 * a cross-system architecture recommendation and a build order produced one
 * artefact, and the run reported `completed`.
 *
 * There were TWO failures there and they need different fixes, which is why
 * this module does two things rather than one:
 *
 *   1. THE RUN WAS NOT CHECKED AGAINST ITS BRIEF. Fixed by `deriveCriteria` +
 *      `evaluateDeterministic`: the brief becomes machine-checkable and the run
 *      is measured against it before it may be called complete.
 *
 *   2. THE BRIEF HAD ALREADY LOST THREE OF THE FIVE DELIVERABLES. Discovery
 *      reduced "three briefs, an architecture recommendation and a build order"
 *      to "a written recommendation covering all three", and the run then
 *      followed that brief faithfully. No amount of checking the run against
 *      the brief would ever have caught this, because the run did exactly what
 *      the brief said.
 *
 * Only fixing (1) would have produced a system that verifies contracts
 * rigorously while quietly signing the wrong ones. So `compareRequestToBrief`
 * exists for (2): it reads what the REQUESTER asked for and says plainly what
 * the brief does not cover, at the moment a human is being asked to approve it.
 *
 * It does not block. Narrowing scope at discovery is a legitimate thing to do —
 * it is often the right thing to do. What it must not be is invisible.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Reading what was asked for
// ---------------------------------------------------------------------------

/*
 * DELIVERABLES MOVED OUT — see `./deliverables.ts`.
 *
 * Commissioning defect 9. What used to live here was a single pass that turned
 * every deliverable noun it recognised into an independent requirement and
 * summed them, so "two engineering briefs and two distinct documents" required
 * four artefacts and the run that produced the two briefs that were wanted was
 * reported with a gap.
 *
 * That is not a regex bug and it was not fixed as one. Extraction and
 * NORMALISATION are now separate stages in their own module: extraction finds
 * candidates positionally and decides nothing, normalisation decides what each
 * candidate means relative to the others — additive, alias, explanatory,
 * contains, or ambiguous — and only `additive` reaches a criterion.
 *
 * This file keeps the part that was always its own job: turning what a brief
 * requires into criteria a machine can check.
 */

/**
 * Sections a piece of text names as required content.
 *
 * Distinct from a deliverable: "a build order" inside a recommendation is a
 * heading, not a second document, and turning every noun into an artefact would
 * demand five files where one was wanted.
 */
const SECTION_PHRASES: Array<{ pattern: RegExp; section: string }> = [
  /*
   * `[- ]` rather than a space.
   *
   * The real request says "a build-order recommendation". People hyphenate
   * compound modifiers and they are right to, so a pattern that only accepts
   * the spaced form misses the correctly-written half of its input — which is
   * how this was found.
   */
  { pattern: /\bbuild[- ]order\b/i, section: 'Build order' },
  { pattern: /\b(rough |indicative |ballpark )?cost(s| estimate| estimates)?\b/i, section: 'Cost' },
  { pattern: /\b(risk|risks) (assessment|analysis|register)?\b/i, section: 'Risks' },
  { pattern: /\boptions?\b/i, section: 'Options' },
  { pattern: /\btimeline|schedule\b/i, section: 'Timeline' },
  { pattern: /\bnext steps?\b/i, section: 'Next steps' },
  { pattern: /\bassumptions?\b/i, section: 'Assumptions' },
  { pattern: /\b(effort|sizing) (estimate)?\b/i, section: 'Effort' },
  { pattern: /\bdependenc(y|ies)\b/i, section: 'Dependencies' },
];

export function detectSections(text: string): string[] {
  const body = text ?? '';
  const sections: string[] = [];
  for (const entry of SECTION_PHRASES) {
    if (entry.pattern.test(body) && !sections.includes(entry.section)) sections.push(entry.section);
  }
  return sections;
}

/** Text asking for research outside PAC. */
const EXTERNAL_RESEARCH_CUES = [
  /\b(external|public|online|web|internet) (research|search|sources?|documentation)\b/i,
  /\bvendor (documentation|docs|manuals?|datasheets?|website)\b/i,
  /\b(look|search) (it )?up online\b/i,
  /\bmarket (research|analysis|comparison)\b/i,
  /\bcompare .{0,40}(vendors?|products?|suppliers?|competitors?)\b/i,
  /\b(standards?|regulations?|legislation) (research|review)\b/i,
  /\bthird[- ]party (documentation|sources?)\b/i,
];

/**
 * Words that turn a cue into its own refusal.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * A brief reading "Use only the PAC company context — no external research of
 * any kind" derived the criterion "Retrieve at least one external source,
 * because the brief asks for research outside PAC". The cue matched the phrase
 * inside its own negation, and a run that obeyed its brief was then measured
 * short for obeying it.
 *
 * That is the exact thing rule 2 of the derivation forbids: a criterion the run
 * could not meet — here, could not meet WITHOUT DISOBEYING — teaches everybody
 * to ignore gaps.
 * ---------------------------------------------------------------------------
 */
/*
 * One list, two windows.
 *
 * The words themselves are shared with the deliverable reader — a brief that
 * refuses a thing refuses it the same way whether the thing is a search or a
 * document. How far back each looks is NOT shared, and `negatedDeliverable`
 * says why.
 */

/**
 * Whether a cue is negated where it appears.
 *
 * Looks only at the words immediately before the match, so a negation attached
 * to something else in the same text does not suppress a genuine request:
 * "Do not assume monday.com is being replaced. Research external vendor
 * documentation." still asks for research.
 *
 * Deliberately shallow. Reading negation properly is a parsing problem, and the
 * regex cue layer is already known to be approximate — see the technical debt
 * on the intent classifier. What this catches is the common, direct form, which
 * is the form that actually appeared.
 */
function negatedAt(text: string, index: number): boolean {
  // Six words is enough for "no", "do not", "must not be done without".
  const preceding = text.slice(Math.max(0, index - 40), index).toLowerCase();
  const words = preceding.split(/[^a-z']+/).filter(Boolean).slice(-6);
  return words.some((word) => NEGATORS.includes(word));
}

/** True when a cue matches somewhere it is not being refused. */
function matchesUnnegated(text: string, patterns: readonly RegExp[]): boolean {
  const haystack = text ?? '';
  return patterns.some((pattern) => {
    // `g` so every occurrence is considered: one negated mention must not hide
    // a genuine request elsewhere in the same brief.
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const match of haystack.matchAll(global)) {
      if (match.index !== undefined && !negatedAt(haystack, match.index)) return true;
    }
    return false;
  });
}

export const requestsExternalResearch = (text: string): boolean =>
  matchesUnnegated(text, EXTERNAL_RESEARCH_CUES);

/** Text asking for a conclusion that should rest on a primary source. */
const PRIMARY_SOURCE_CUES = [
  /\bvendor (documentation|docs|manuals?|datasheets?)\b/i,
  /\b(official|authoritative|primary) (source|documentation)\b/i,
  /\b(standards?|regulator|regulation|legislation)\b/i,
  /\bspecification sheet\b/i,
];

export const requestsPrimarySources = (text: string): boolean =>
  matchesUnnegated(text, PRIMARY_SOURCE_CUES);

// ---------------------------------------------------------------------------
// Deriving criteria
// ---------------------------------------------------------------------------

export interface DeriveCriteriaInput {
  taskKind: TaskKind;
  brief: HandoffBriefContent;
  /** The task description as the requester wrote it. Used for §19 currency. */
  description?: string | null;
  /** True when this project and deployment actually permit external research. */
  externalResearchAvailable: boolean;
  /** Artefact types this task kind is expected to produce. */
  expectedArtefactTypes: readonly string[];
}

/**
 * Turns an approved brief into machine-checkable criteria.
 *
 * ---------------------------------------------------------------------------
 * TWO RULES ABOUT WHAT IS DERIVED
 *
 * 1. A criterion is only derived where the brief SAYS something. This does not
 *    invent a requirement for three documents because three sounds thorough;
 *    everything below traces to a phrase somebody wrote.
 *
 * 2. A criterion that could not possibly be met is not derived at all. If
 *    external research is unavailable in this deployment, an `external_sources`
 *    criterion would fail every run for a reason the run cannot do anything
 *    about — which trains everybody to ignore gaps. Instead the unavailability
 *    is surfaced where it belongs: as a blocker, at approval time.
 * ---------------------------------------------------------------------------
 */
export function deriveCriteria(input: DeriveCriteriaInput): AcceptanceCriterion[] {
  const { brief } = input;
  const criteria: AcceptanceCriterion[] = [];
  const seen = new Set<string>();

  const push = (criterion: AcceptanceCriterion) => {
    const key = `${criterion.kind}:${keyOf(criterion)}`;
    if (seen.has(key)) return;
    seen.add(key);
    criteria.push(acceptanceCriterionSchema.parse(criterion));
  };

  // What the acceptance criteria and the objective between them ask for. The
  // acceptance criteria come first because they are the human's own statement
  // of "done", and the objective is context.
  const contractText = contractTextOf(brief);

  // --- Deliverables --------------------------------------------------------

  /*
   * Normalised first, then grouped by the artefact type that satisfies them.
   *
   * Two steps, and both matter. NORMALISATION is defect 9's fix: it decides
   * which mentions name the same thing, so a generic container noun restating a
   * specific deliverable stops adding artefacts nobody asked for.
   *
   * GROUPING is the other half. Several deliverable types share one artefact
   * type — a summary document and a procedure are both `markdown_document` —
   * and a criterion is keyed by artefact type, so "a summary document and a
   * procedure" has to arrive as `markdown_document >= 2` rather than as two
   * criteria of which the second silently overwrites the first.
   */
  const analysis = analyseDeliverables(contractText);

  const byArtefact = new Map<ArtefactType, { minimum: number; labels: string[]; provenance: string[] }>();
  for (const deliverable of analysis.deliverables) {
    const entry = byArtefact.get(deliverable.artefactType) ?? { minimum: 0, labels: [], provenance: [] };
    entry.minimum += deliverable.count;
    entry.labels.push(deliverable.count > 1 ? `${deliverable.count} ${deliverable.label}s` : aOrAn(deliverable.label));
    entry.provenance.push(deliverable.provenance);
    byArtefact.set(deliverable.artefactType, entry);
  }

  for (const [artefactType, entry] of byArtefact) {
    push({
      id: `artefact-${artefactType}`,
      kind: 'artefact_type',
      description: `Produce ${entry.labels.join(' and ')}`,
      required: true,
      source: 'derived',
      artefactType,
      minimum: Math.min(entry.minimum, 50),
      /*
       * The wording that produced it, and anything folded into it.
       *
       * Defect 9's normalisation makes judgements a human may want to overturn
       * — "documents" meant the briefs — and a judgement nobody can see is a
       * judgement nobody can correct.
       */
      provenance: entry.provenance.join(' ').slice(0, 1200),
    });
  }

  const deliverables = analysis.deliverables;

  /*
   * A floor on the artefact count when the brief named none.
   *
   * From the task kind rather than from the text, and marked as such, so a
   * reader can tell "the requester asked for this" from "work of this kind
   * produces one of these". Without it a research run could satisfy an empty
   * criteria list by producing nothing — and zero artefacts is already a
   * failure, but a criteria list that cannot express "at least one" is a list
   * that says nothing about what was wanted.
   */
  if (deliverables.length === 0 && input.expectedArtefactTypes.length > 0) {
    push({
      id: 'artefact-count-minimum',
      kind: 'artefact_count',
      description: 'Produce at least one written deliverable',
      required: true,
      source: 'task_kind',
      minimum: 1,
    });
  }

  // --- Named sections ------------------------------------------------------

  /*
   * Two sources, and the second one is defect 9's.
   *
   * `detectSections` finds the section names the brief asks for by phrase.
   * `analysis.sections` adds the ones lifted out of a "containing …" clause —
   * "one report containing a summary and a build order" requires a Summary
   * heading, and used to require a second DOCUMENT instead.
   */
  const sectionNames = [...detectSections(brief.acceptanceCriteria.join('\n')), ...analysis.sections];

  for (const section of sectionNames) {
    push({
      id: `section-${section.toLowerCase().replace(/\s+/g, '-')}`,
      kind: 'named_section',
      description: `Cover "${section}" in the written output`,
      required: true,
      source: 'derived',
      section,
    });
  }

  // --- Evidence ------------------------------------------------------------

  /*
   * Something the reader may treat as established.
   *
   * Not a count of findings: a run can produce forty inferences and have
   * established nothing. `establishedFindings` is the distinction the whole
   * evidence model exists to draw, and this is where it earns its keep.
   */
  if (input.expectedArtefactTypes.length > 0) {
    push({
      id: 'evidence-grounded',
      kind: 'evidence_class',
      description: 'Establish at least one finding a reader can check, with a source',
      required: true,
      source: 'task_kind',
      evidenceClass: 'project_fact',
      minimum: 1,
    });
  }

  // --- External sources ----------------------------------------------------

  const wantsExternal = requestsExternalResearch(contractText) || requestsExternalResearch(input.description ?? '');
  const currency = assessCurrency([contractText, input.description ?? ''].join('\n'));

  if ((wantsExternal || currency.currency === 'volatile') && input.externalResearchAvailable) {
    push({
      id: 'external-sources',
      kind: 'external_sources',
      description: wantsExternal
        ? 'Retrieve at least one external source, because the brief asks for research outside PAC'
        : `Retrieve at least one external source, because this turns on information that changes over time (${currency.categories.join(', ')})`,
      required: true,
      source: 'derived',
      minimum: 1,
    });
  }

  if (requestsPrimarySources(contractText) && input.externalResearchAvailable) {
    push({
      id: 'primary-source',
      kind: 'source_class',
      description: 'Cite a primary source — vendor documentation, a standard, or a regulator',
      required: true,
      source: 'derived',
      sourceClasses: ['official_vendor_docs', 'standards_body', 'government'],
      minimum: 1,
    });
  }

  // --- Coding work ---------------------------------------------------------

  if (input.taskKind === 'coding') {
    if (brief.testingExpectations.length > 0) {
      push({
        id: 'tests-run',
        kind: 'test_run',
        description: 'Run the project test suite and have it pass',
        required: true,
        source: 'derived',
        mustPass: true,
      });
    }
    push({
      id: 'self-review',
      kind: 'review_step',
      description: 'Complete a self-review against the brief',
      required: true,
      source: 'task_kind',
    });
  }

  return criteria.slice(0, 40);
}

const keyOf = (criterion: AcceptanceCriterion): string => {
  switch (criterion.kind) {
    case 'artefact_type':
      return criterion.artefactType;
    case 'named_section':
      return criterion.section.toLowerCase();
    case 'evidence_class':
      return criterion.evidenceClass;
    case 'source_class':
      return criterion.sourceClasses.join('|');
    case 'semantic':
      return criterion.statement.toLowerCase().slice(0, 80);
    default:
      return criterion.kind;
  }
};

const aOrAn = (noun: string): string => (/^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`);

/**
 * The exact text `deriveCriteria` reads a brief's requirements out of.
 *
 * Shared so that the criteria, the clarifying questions and the note shown at
 * approval are all derived from the same words. A question raised about a
 * phrase that did not contribute to any criterion is a question about nothing.
 */
export function contractTextOf(brief: HandoffBriefContent): string {
  return [brief.acceptanceCriteria.join('\n'), brief.proposedScope, brief.userObjective, brief.desiredBehaviour]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Ambiguity, before approval freezes it
// ---------------------------------------------------------------------------

/**
 * Deliverable wording nothing may decide, as questions for a human.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A QUESTION AND NOT A DEFAULT
 *
 * "provide two briefs and documentation" does not say whether the documentation
 * IS the briefs, and both available guesses are harmful. Reading it as an alias
 * drops a deliverable out of the contract, which is exactly the failure Part F
 * exists to stop. Reading it as an addition invents an artefact the run will be
 * marked short for not producing, which is defect 9 all over again.
 *
 * So no criterion is derived from an ambiguous mention at all, and the question
 * goes where the brief's other unknowns already go: `openQuestions`, during
 * discovery, while a person can still change the answer. Criteria are frozen at
 * approval, and a count frozen from a guess is a guess nobody will ever revisit.
 * ---------------------------------------------------------------------------
 */
export function deliverableClarifications(input: {
  brief: HandoffBriefContent;
  description?: string | null;
}): OpenQuestion[] {
  const ambiguities = analyseDeliverables(contractTextOf(input.brief)).ambiguities;

  return ambiguities.slice(0, 6).map((ambiguity, index) => ({
    id: `deliverable-ambiguity-${index + 1}`,
    question: ambiguity.question,
    /*
     * The dimension it genuinely belongs to.
     *
     * `acceptance_criteria` carries the heaviest weight in gap analysis (0.16)
     * because not knowing what "done" means is the thing that makes autonomous
     * work dangerous. Not knowing how many artefacts "done" is, is that.
     */
    dimension: 'acceptance_criteria',
    /*
     * Empty, deliberately. Nothing in the repository or the company context can
     * answer what the person who wrote the sentence meant by it.
     */
    discoverableFrom: [],
    answer: null,
    answeredAt: null,
    answeredBy: null,
  }));
}

/** The same ambiguities as one sentence, for the approval card. */
export function deliverableAmbiguityNote(brief: HandoffBriefContent): string | null {
  const ambiguities = analyseDeliverables(contractTextOf(brief)).ambiguities;
  if (ambiguities.length === 0) return null;

  return (
    `This brief does not settle how many artefacts it asks for. ${ambiguities
      .map((a) => `"${a.phrase}" could mean ${a.readings.join(', or ')}`)
      .join('; ')}. ` +
    'No acceptance criterion was derived from it, because freezing a guessed count onto the run would ' +
    'either drop a deliverable from the contract or mark a correct delivery short. Answer the open ' +
    'question on this brief, or edit the criteria yourself, before approving.'
  );
}

/** What normalisation folded together, and why, for the approval card. */
export function deliverableNormalisationNote(brief: HandoffBriefContent): string | null {
  const folded = analyseDeliverables(contractTextOf(brief)).resolutions.filter((r) => r.relationship !== 'contains');
  if (folded.length === 0) return null;

  return (
    `Mac read some of this brief's wording as naming the same deliverable twice: ${folded
      .map((r) => r.reason)
      .join(' ')} ` + 'If that is wrong, edit the acceptance criteria before approving.'
  );
}

// ---------------------------------------------------------------------------
// The narrowing check
// ---------------------------------------------------------------------------

export interface RequestDivergence {
  /** Deliverables the requester named that the brief does not ask for. */
  missingDeliverables: DeliverableMention[];
  /** Sections the requester named that the brief does not ask for. */
  missingSections: string[];
  /** True when the request wants external research and the brief is silent. */
  externalResearchDropped: boolean;
  /** One paragraph naming the divergence, or null when there is none. */
  note: string | null;
}

/**
 * Compares what the requester asked for against what the brief commits to.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A NOTE AND NOT A BLOCK
 *
 * Narrowing scope during discovery is legitimate and frequently correct. An
 * engineer describing five documents often wants one that covers the ground,
 * and Mac proposing that is him doing his job rather than failing at it.
 *
 * What went wrong at commissioning was not the narrowing. It was that the
 * narrowing was INVISIBLE: the brief was approved by somebody who had no way to
 * see that three of the five named deliverables had gone, and the run then
 * satisfied its contract exactly.
 *
 * So this produces a sentence, shown at approval time and recorded on the
 * brief. The human decides. That is the same division of labour as everywhere
 * else here — Mac notices, a person chooses.
 * ---------------------------------------------------------------------------
 */
export function compareRequestToBrief(input: {
  requestText: string;
  brief: HandoffBriefContent;
}): RequestDivergence {
  const requested = detectDeliverables(input.requestText);
  const briefText = [input.brief.acceptanceCriteria.join('\n'), input.brief.proposedScope, input.brief.userObjective]
    .filter(Boolean)
    .join('\n');
  const committed = detectDeliverables(briefText);

  const committedByType = new Map(committed.map((d) => [d.type, d]));

  const missingDeliverables = requested.filter((want) => {
    const has = committedByType.get(want.type);
    return !has || has.count < want.count;
  });

  const requestedSections = detectSections(input.requestText);
  const briefSections = detectSections(briefText);
  const missingSections = requestedSections.filter((s) => !briefSections.includes(s));

  const externalResearchDropped = requestsExternalResearch(input.requestText) && !requestsExternalResearch(briefText);

  if (missingDeliverables.length === 0 && missingSections.length === 0 && !externalResearchDropped) {
    return { missingDeliverables: [], missingSections: [], externalResearchDropped: false, note: null };
  }

  const parts: string[] = [];
  if (missingDeliverables.length) {
    parts.push(
      `the request names ${missingDeliverables
        .map((d) => (d.count > 1 ? `${d.count} ${d.label}s` : aOrAn(d.label)))
        .join(', ')}, and the brief does not commit to ${missingDeliverables.length === 1 ? 'it' : 'them'}`,
    );
  }
  if (missingSections.length) {
    parts.push(`the request asks for ${missingSections.join(', ')}, which the brief does not mention`);
  }
  if (externalResearchDropped) {
    parts.push('the request asks for research outside PAC, and the brief does not');
  }

  return {
    missingDeliverables,
    missingSections,
    externalResearchDropped,
    note:
      `This brief is narrower than the request it came from: ${parts.join('; ')}. ` +
      'That may be right — a single document covering the ground is often better than five. ' +
      'It is flagged so the decision is yours rather than a side effect.',
  };
}

/**
 * What the derivation could not ask for, because the deployment cannot do it.
 *
 * ---------------------------------------------------------------------------
 * THE OTHER HALF OF RULE 2
 *
 * `deriveCriteria` omits an `external_sources` criterion when external research
 * is unavailable, and that is right: a criterion that fails every run for a
 * reason the run cannot act on teaches everybody to ignore gaps.
 *
 * But omitting it silently is worse than either alternative. A brief asking for
 * vendor documentation and currently-supported firmware versions then derives
 * four criteria, none of them about sources, and the run that satisfies all
 * four is reported as fully satisfied having read nothing outside PAC. That is
 * the shortfall this whole mechanism exists to make visible, one layer up: not
 * "the run fell short of the brief" but "the brief asked for something this
 * deployment cannot do, and nobody said so."
 *
 * So the requirement moves from the criteria to a sentence in front of the
 * person approving, exactly as `compareRequestToBrief` does for a narrowed
 * scope. It does not block. Approving research that will be done from what Mac
 * already holds is often the right call at 17:00 on a Friday. What it must not
 * be is invisible.
 * ---------------------------------------------------------------------------
 */
export function unmetResearchCapability(input: {
  brief: HandoffBriefContent;
  description?: string | null;
  externalResearchAvailable: boolean;
}): string | null {
  if (input.externalResearchAvailable) return null;

  const contractText = [input.brief.acceptanceCriteria.join('\n'), input.brief.proposedScope, input.brief.userObjective]
    .filter(Boolean)
    .join('\n');
  const description = input.description ?? '';

  const asked = requestsExternalResearch(contractText) || requestsExternalResearch(description);
  const primary = requestsPrimarySources(contractText) || requestsPrimarySources(description);
  // The same currency judgement the criterion would have used, so a volatile
  // question is caught whether or not anybody wrote the word "research".
  const currency = assessCurrency([contractText, description].join('\n'));

  if (!asked && !primary && currency.currency !== 'volatile') return null;

  const because = asked
    ? 'this brief asks for research outside PAC'
    : primary
      ? 'this brief asks for a conclusion resting on a primary source outside PAC'
      : `this brief turns on information that changes over time (${currency.categories.join(', ')})`;

  return (
    `External research is not available in this deployment, and ${because}. ` +
    'No acceptance criterion was derived for it, because a criterion no run could ever meet is ' +
    'one everybody learns to ignore. Whatever Mac produces here will rest on what he already ' +
    'holds — the company context and the project — and not on anything current from outside PAC.'
  );
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

export interface AcceptanceEvidence {
  artefacts: Array<{ type: ArtefactType; title: string; body: string; findings: Finding[] }>;
  sources: Array<{ sourceClass: SourceClass; external: boolean }>;
  /** How many test runs the run recorded, and whether the last one passed. */
  testsRun: number;
  testsPassed: boolean | null;
  reviewCompleted: boolean;
}

/**
 * Runs every deterministic criterion.
 *
 * `semantic` criteria are returned as `indeterminate` here rather than omitted,
 * so the caller has a complete result set even when the model review is
 * disabled or fails — and `indeterminate` never counts as satisfied, so a
 * missing model review degrades to a gap rather than to a pass.
 */
export function evaluateDeterministic(
  criteria: readonly AcceptanceCriterion[],
  evidence: AcceptanceEvidence,
): CriterionResult[] {
  const headings = evidence.artefacts.flatMap((a) => extractHeadings(a.body));
  const allFindings = evidence.artefacts.flatMap((a) => a.findings);

  return criteria.map((criterion): CriterionResult => {
    const base = {
      criterionId: criterion.id,
      kind: criterion.kind,
      description: criterion.description,
      required: criterion.required,
      method: 'deterministic' as const,
      reasoning: '',
    };

    switch (criterion.kind) {
      case 'artefact_count': {
        const count = evidence.artefacts.length;
        return {
          ...base,
          verdict: count >= criterion.minimum ? 'satisfied' : 'unmet',
          observed: `${count} artefact(s), ${criterion.minimum} required`,
        };
      }

      case 'artefact_type': {
        const count = evidence.artefacts.filter((a) => a.type === criterion.artefactType).length;
        return {
          ...base,
          verdict: count >= criterion.minimum ? 'satisfied' : 'unmet',
          observed: `${count} of type ${criterion.artefactType}, ${criterion.minimum} required`,
        };
      }

      case 'named_section': {
        const present = headingSatisfies(criterion.section, headings);
        return {
          ...base,
          verdict: present ? 'satisfied' : 'unmet',
          observed: present
            ? `a heading matching "${criterion.section}" is present`
            : `no heading matching "${criterion.section}" in ${evidence.artefacts.length} artefact(s)`,
        };
      }

      case 'evidence_class': {
        /*
         * Counted only among GROUNDED findings.
         *
         * A factual class with no source is not a fact — `capFindingConfidence`
         * already caps its confidence, and counting it towards an evidence
         * criterion would let the same unsupported claim satisfy the check that
         * exists to notice unsupported claims.
         */
        const matching = allFindings.filter(
          (f) => qualifiesAs(f, criterion.evidenceClass) && (!isFactualClass(f.evidenceClass) || f.sources.length > 0),
        );
        return {
          ...base,
          verdict: matching.length >= criterion.minimum ? 'satisfied' : 'unmet',
          observed: `${matching.length} grounded finding(s) at or above ${criterion.evidenceClass}, ${criterion.minimum} required`,
        };
      }

      case 'source_class': {
        const matching = evidence.sources.filter((s) => criterion.sourceClasses.includes(s.sourceClass));
        return {
          ...base,
          verdict: matching.length >= criterion.minimum ? 'satisfied' : 'unmet',
          observed:
            matching.length > 0
              ? `${matching.length} source(s) of the required class`
              : evidence.sources.length === 0
                ? 'no sources were retrieved at all'
                : `${evidence.sources.length} source(s) retrieved, none of the required class`,
        };
      }

      case 'external_sources': {
        const count = evidence.sources.filter((s) => s.external).length;
        return {
          ...base,
          verdict: count >= criterion.minimum ? 'satisfied' : 'unmet',
          // The exact sentence Part F §23 asks for, in the words a reader needs.
          observed: `external_sources_used = ${count}, ${criterion.minimum} required`,
        };
      }

      case 'test_run': {
        if (evidence.testsRun === 0) {
          return { ...base, verdict: 'unmet', observed: 'no test run was recorded' };
        }
        if (!criterion.mustPass) {
          return { ...base, verdict: 'satisfied', observed: `${evidence.testsRun} test run(s) recorded` };
        }
        return {
          ...base,
          verdict: evidence.testsPassed === true ? 'satisfied' : 'unmet',
          observed:
            evidence.testsPassed === null
              ? `${evidence.testsRun} test run(s), outcome not recorded`
              : `${evidence.testsRun} test run(s), last one ${evidence.testsPassed ? 'passed' : 'failed'}`,
        };
      }

      case 'review_step':
        return {
          ...base,
          verdict: evidence.reviewCompleted ? 'satisfied' : 'unmet',
          observed: evidence.reviewCompleted ? 'a self-review was recorded' : 'no self-review was recorded',
        };

      case 'semantic':
        return {
          ...base,
          verdict: 'indeterminate',
          method: 'model',
          observed: 'awaiting model review',
        };
    }
  });
}

/**
 * Whether a finding counts towards a required evidence class.
 *
 * Stronger classes satisfy weaker requirements: a criterion asking for a
 * project fact is satisfied by a PAC fact, because PAC policy is a stronger
 * basis than a project's own material rather than a different one. The reverse
 * is not true, which is the whole point of the ordering.
 */
const CLASS_RANK: Record<EvidenceClass, number> = {
  user_approved_decision: 5,
  pac_fact: 4,
  external_fact: 3,
  project_fact: 3,
  inference: 2,
  recommendation: 1,
  assumption: 1,
  unknown: 0,
};

const qualifiesAs = (finding: Finding, required: EvidenceClass): boolean =>
  CLASS_RANK[finding.evidenceClass] >= CLASS_RANK[required];

/** Sources whose class is primary. Used by the report and the UI. */
export const countPrimarySources = (sources: readonly { sourceClass: SourceClass }[]): number =>
  sources.filter((s) => isPrimarySource(s.sourceClass)).length;
