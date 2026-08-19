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
} from '@mac/protocol';
import { assessCurrency } from './currency.js';

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

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/**
 * Nouns that name a deliverable, mapped to the artefact type that satisfies it.
 *
 * Ordered longest-phrase-first where it matters: "architecture recommendation"
 * must be read as an architecture note rather than matching the bare word
 * "recommendation" and losing the distinction.
 */
const DELIVERABLE_NOUNS: Array<{ pattern: RegExp; type: ArtefactType; label: string }> = [
  { pattern: /\barchitecture (recommendation|note|proposal|design)s?\b/i, type: 'architecture_note', label: 'architecture note' },
  { pattern: /\b(engineering |technical )?briefs?\b/i, type: 'engineering_brief', label: 'engineering brief' },
  { pattern: /\b(investigation|research|findings) reports?\b/i, type: 'investigation_report', label: 'investigation report' },
  { pattern: /\brecommendations?\b/i, type: 'recommendation', label: 'recommendation' },
  { pattern: /\b(task |work )?proposals?\b/i, type: 'task_proposal', label: 'task proposal' },
  { pattern: /\bdiagrams?\b/i, type: 'diagram_description', label: 'diagram' },
  { pattern: /\b(spreadsheets?|tables?|datasets?|structured data)\b/i, type: 'structured_data', label: 'structured data' },
  { pattern: /\b(documents?|write[- ]?ups?|summar(?:y|ies)|notes?)\b/i, type: 'markdown_document', label: 'document' },
  { pattern: /\breports?\b/i, type: 'investigation_report', label: 'report' },
];

export interface DeliverableMention {
  type: ArtefactType;
  count: number;
  label: string;
  /** The words that produced it, so a human can disagree with something real. */
  phrase: string;
}

/**
 * Finds the deliverables a piece of text asks for, with counts.
 *
 * "three separate engineering briefs" is the case that matters: the count is
 * carried by a word several tokens to the left of the noun, and a naive noun
 * scan produces "one brief" — which is exactly how five requested documents
 * became one.
 */
export function detectDeliverables(text: string): DeliverableMention[] {
  const body = text ?? '';
  const found = new Map<ArtefactType, DeliverableMention>();

  for (const noun of DELIVERABLE_NOUNS) {
    const scan = new RegExp(noun.pattern.source, 'gi');
    let match: RegExpExecArray | null;

    while ((match = scan.exec(body)) !== null) {
      // Look back a short way for a count: "three separate engineering briefs",
      // "2 short reports", "a recommendation".
      //
      // The fallback is 1 even for a plural noun. "briefs" with no number in
      // front of it asks for more than one and says nothing about how many, and
      // guessing 2 would be inventing a requirement — the criterion has to
      // trace to something somebody wrote.
      const preceding = body.slice(Math.max(0, match.index - 40), match.index);
      const count = countFrom(preceding, 1);

      const existing = found.get(noun.type);
      if (!existing || count > existing.count) {
        found.set(noun.type, {
          type: noun.type,
          count,
          label: noun.label,
          phrase: `${preceding.trim().split(/\s+/).slice(-3).join(' ')} ${match[0]}`.trim().slice(0, 80),
        });
      }
      if (match.index === scan.lastIndex) scan.lastIndex += 1;
    }
  }

  return Array.from(found.values());
}

/** The nearest count immediately before a noun, or the fallback. */
function countFrom(preceding: string, fallback: number): number {
  // Only the last few words: "three systems, and a recommendation" must read
  // one recommendation, not three.
  const tail = preceding.trim().split(/\s+/).slice(-3);
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const word = (tail[i] ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!word) continue;
    if (/^\d+$/.test(word)) {
      const value = Number(word);
      if (value >= 1 && value <= 20) return value;
    }
    if (word in NUMBER_WORDS) return NUMBER_WORDS[word]!;
    // A qualifier sits between the count and the noun: "three SEPARATE briefs".
    if (['separate', 'distinct', 'individual', 'short', 'brief', 'detailed', 'engineering', 'technical'].includes(word)) {
      continue;
    }
    break;
  }
  return fallback;
}

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

export const requestsExternalResearch = (text: string): boolean =>
  EXTERNAL_RESEARCH_CUES.some((pattern) => pattern.test(text ?? ''));

/** Text asking for a conclusion that should rest on a primary source. */
const PRIMARY_SOURCE_CUES = [
  /\bvendor (documentation|docs|manuals?|datasheets?)\b/i,
  /\b(official|authoritative|primary) (source|documentation)\b/i,
  /\b(standards?|regulator|regulation|legislation)\b/i,
  /\bspecification sheet\b/i,
];

export const requestsPrimarySources = (text: string): boolean =>
  PRIMARY_SOURCE_CUES.some((pattern) => pattern.test(text ?? ''));

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
  const contractText = [brief.acceptanceCriteria.join('\n'), brief.proposedScope, brief.userObjective, brief.desiredBehaviour]
    .filter(Boolean)
    .join('\n');

  // --- Deliverables --------------------------------------------------------

  const deliverables = detectDeliverables(contractText);
  for (const deliverable of deliverables) {
    push({
      id: `artefact-${deliverable.type}`,
      kind: 'artefact_type',
      description:
        deliverable.count > 1
          ? `Produce ${deliverable.count} ${deliverable.label}s`
          : `Produce ${aOrAn(deliverable.label)}`,
      required: true,
      source: 'derived',
      artefactType: deliverable.type,
      minimum: deliverable.count,
    });
  }

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

  for (const section of detectSections(brief.acceptanceCriteria.join('\n'))) {
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
