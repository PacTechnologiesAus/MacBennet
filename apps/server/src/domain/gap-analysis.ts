import {
  applicableDimensions,
  COMPLETENESS_DIMENSIONS,
  DIMENSION_QUESTIONS,
  DIMENSION_WEIGHTS,
  INVESTIGATED_DIMENSION_WEIGHT,
  type CompletenessDimension,
  type HandoffBriefContent,
  type ProjectContextSnapshot,
  type TaskKind,
} from '@mac/protocol';

/**
 * Gap analysis (spec §4 Phase D, Sprint 2 §5 Step E).
 *
 * Understanding confidence is DERIVED from a completeness checklist rather than
 * guessed, which matters for a number that decides whether autonomous execution
 * is permitted at all: a reviewer can see exactly which dimensions are
 * satisfied and which are not, and can disagree with a specific one.
 *
 * The second rule this file implements is the one that makes discovery feel
 * like talking to a colleague rather than filling in a form:
 *
 *   Mac must not ask the human a question the repository can answer.
 *
 * So each unsatisfied dimension is first checked against the inspected project
 * context. If the context can supply it, the dimension is marked discoverable
 * and is NOT put to the human — it is answered from the repository instead.
 */

export interface DimensionAssessment {
  dimension: CompletenessDimension;
  satisfied: boolean;
  weight: number;
  /** Non-empty when the repository can answer this, so Mac must not ask. */
  discoverableFrom: string[];
  /**
   * Sprint 3.3: non-empty when Mac ACTUALLY WENT AND FOUND OUT.
   *
   * Distinct from `discoverableFrom`, which only says an answer exists
   * somewhere. Sprint 3 already priced the difference at
   * `INVESTIGATED_DIMENSION_WEIGHT` (0.75 vs 0.5): having gone and looked is
   * worth more than the answer being findable, and less than being told.
   */
  investigatedFrom: string[];
  question: string;
}

/**
 * Sprint 3.3: how a dimension is worded for work that is not about code.
 *
 * The Sprint 2 wording assumes an existing system being changed — "What does
 * the system do at the moment in this area?" is not a question a scoping task
 * has an answer to. Asking a badly-fitting question is worse than asking none:
 * the human answers the question they were asked, and the brief records it
 * under a heading that means something else.
 */
const GENERAL_DIMENSION_QUESTIONS: Partial<Record<CompletenessDimension, string>> = {
  problem: 'What question are we actually trying to answer, and what goes wrong if we do not?',
  user_outcome: 'Who needs this, and what decision will they make with it?',
  current_behaviour: 'What is the current situation, as far as you know it?',
  desired_behaviour: 'What should the finished work tell us or produce?',
  constraints: 'Are there constraints on this — sources I must or must not use, time, sensitivity?',
  acceptance_criteria: 'What must the result contain for you to consider this done?',
};

export interface GapAnalysis {
  assessments: DimensionAssessment[];
  /** Weighted completeness in [0,1]. This is the understanding confidence. */
  confidence: number;
  /** Dimensions Mac genuinely needs a human for, in priority order. */
  outstanding: DimensionAssessment[];
  /** The single next question. Spec §4: one at a time. */
  nextQuestion: DimensionAssessment | null;
}

/** A field counts as supplied when it has real content, not just whitespace. */
const hasText = (value: string | undefined | null, minLength = 12): boolean =>
  typeof value === 'string' && value.trim().length >= minLength;

const hasItems = (items: readonly string[] | undefined): boolean => Array.isArray(items) && items.length > 0;

/**
 * Whether each dimension is satisfied by the brief as it stands.
 *
 * The thresholds are deliberately modest: this is asking "did the human tell me
 * anything about this", not "is this prose excellent". Being strict here would
 * make Mac interrogate people who had already explained themselves.
 */
function evaluate(brief: HandoffBriefContent, dimension: CompletenessDimension): boolean {
  switch (dimension) {
    case 'problem':
      return hasText(brief.userObjective, 20);
    case 'user_outcome':
      return hasText(brief.desiredBehaviour, 15) || hasText(brief.userObjective, 40);
    case 'current_behaviour':
      return hasText(brief.currentBehaviour, 15);
    case 'desired_behaviour':
      return hasText(brief.desiredBehaviour, 15);
    case 'constraints':
      return hasItems(brief.constraints);
    case 'architecture':
      return hasText(brief.relevantArchitecture, 20);
    case 'acceptance_criteria':
      return hasItems(brief.acceptanceCriteria);
    case 'testing':
      return hasItems(brief.testingExpectations);
    case 'must_not_change':
      return hasItems(brief.mustNotChange);
    case 'affected_components':
      return hasItems(brief.likelyAffectedComponents);
  }
}

/**
 * Which dimensions the inspected repository can answer on the human's behalf.
 *
 * This is the concrete implementation of "do not ask the human what you can
 * find out yourself". Only dimensions that a repository genuinely contains are
 * listed: a repository can tell Mac about architecture, testing conventions and
 * which components exist. It cannot tell him what the user wants or what
 * "done" means, so those are never marked discoverable.
 */
function discoverableFrom(
  dimension: CompletenessDimension,
  context: ProjectContextSnapshot | null,
): string[] {
  if (!context) return [];

  switch (dimension) {
    case 'architecture': {
      const sources: string[] = [];
      if (context.readme) sources.push('repository README');
      if (context.docFiles.length) sources.push(`${context.docFiles.length} documentation file(s)`);
      if (context.packageManifests.length) sources.push('package manifests');
      return sources;
    }
    case 'testing': {
      const sources: string[] = [];
      if (context.testPaths.length) sources.push(`${context.testPaths.length} existing test path(s)`);
      const scripts = context.packageManifests.flatMap((m) => m.scripts);
      if (scripts.some((s) => s.includes('test'))) sources.push('package manifest test script');
      return sources;
    }
    case 'affected_components':
      return context.fileCount > 0 ? ['repository file tree'] : [];
    case 'current_behaviour':
      // The repository shows what the code does today, but only for an area Mac
      // can already locate — which requires the human to have named it. So this
      // is discoverable only once affected components are known.
      return context.fileCount > 0 && context.recentCommits.length > 0
        ? ['repository source and recent commit history']
        : [];
    default:
      // problem, user_outcome, desired_behaviour, constraints,
      // acceptance_criteria, must_not_change — a repository cannot know these.
      return [];
  }
}

/**
 * Dimensions are asked about in descending weight order, so if the human
 * answers only one question it is the one that unblocks the most.
 */
export interface GapAnalysisOptions {
  /**
   * Sprint 3.3: which dimensions apply at all.
   *
   * Defaults to `coding`, so every pre-3.3 caller gets exactly the Sprint 2
   * behaviour. For general work the code-specific dimensions are dropped and
   * the remaining weights are RENORMALISED — see below, which is the part that
   * matters.
   */
  taskKind?: TaskKind;
  /**
   * Dimensions Mac resolved by investigation, and what he consulted.
   *
   * Sprint 3.3 section 9: company context, project memory and prior runs are
   * investigation SOURCES during discovery, not merely model grounding, and a
   * dimension one of them resolved must not be put to a human.
   */
  investigated?: Partial<Record<CompletenessDimension, string[]>>;
}

export function analyseGaps(
  brief: HandoffBriefContent,
  context: ProjectContextSnapshot | null = null,
  options: GapAnalysisOptions = {},
): GapAnalysis {
  const taskKind: TaskKind = options.taskKind ?? 'coding';
  const dimensions = applicableDimensions(taskKind, COMPLETENESS_DIMENSIONS);
  const investigated = options.investigated ?? {};

  /*
   * Renormalisation, and why it is not a fudge.
   *
   * `DIMENSION_WEIGHTS` sums to 1.0 across all ten dimensions. Drop the four
   * that do not apply to research and the maximum achievable score becomes 0.72
   * — so a perfectly-understood research task would be scored 72% and refused
   * autonomy for failing to describe its testing strategy and the code it must
   * not change. That is reconciliation drift D-12, and it would silently
   * mis-gate every non-coding task.
   *
   * Renormalising over the applicable subset asks the right question: of the
   * things that matter FOR THIS KIND OF WORK, how much do we understand?
   */
  const totalWeight = dimensions.reduce((sum, d) => sum + DIMENSION_WEIGHTS[d], 0) || 1;
  const scale = 1 / totalWeight;

  const generalWork = taskKind !== 'coding';

  const assessments: DimensionAssessment[] = dimensions.map((dimension) => {
    const satisfied = evaluate(brief, dimension);
    const investigatedFrom = satisfied ? [] : (investigated[dimension] ?? []);
    return {
      dimension,
      satisfied,
      /*
       * Not rounded here.
       *
       * Rounding each renormalised weight to three places left a perfectly
       * complete brief scoring 0.999 instead of 1.0 — harmless, but it is the
       * sort of drift that later gets compared against a threshold. The final
       * confidence is rounded once, below, at the precision it is stored in.
       */
      weight: DIMENSION_WEIGHTS[dimension] * scale,
      discoverableFrom: satisfied ? [] : discoverableFrom(dimension, context),
      investigatedFrom,
      question: (generalWork ? GENERAL_DIMENSION_QUESTIONS[dimension] : undefined) ?? DIMENSION_QUESTIONS[dimension],
    };
  });

  /*
   * Credit, in three tiers, ordered by how much the evidence is actually worth.
   *
   *   told         1.00  the human said it
   *   investigated 0.75  Mac went and found it, from a recorded source
   *   discoverable 0.50  the answer exists somewhere and Mac has not read it
   *
   * The gap between the last two is the whole reason Sprint 3 introduced
   * `INVESTIGATED_DIMENSION_WEIGHT`: "findable" and "found" are different
   * claims, and only one of them has a receipt.
   */
  const confidence = assessments.reduce((total, a) => {
    if (a.satisfied) return total + a.weight;
    if (a.investigatedFrom.length > 0) return total + a.weight * INVESTIGATED_DIMENSION_WEIGHT;
    if (a.discoverableFrom.length > 0) return total + a.weight * 0.5;
    return total;
  }, 0);

  const outstanding = assessments
    .filter((a) => !a.satisfied && a.discoverableFrom.length === 0 && a.investigatedFrom.length === 0)
    .sort((a, b) => b.weight - a.weight);

  return {
    assessments,
    // Rounded to thousandths because that is the storage precision, and because
    // the band comparisons downstream are integer-based on exactly that scale.
    confidence: Math.round(confidence * 1000) / 1000,
    outstanding,
    nextQuestion: outstanding[0] ?? null,
  };
}

/**
 * Facts Mac can fill in from the repository, so that a dimension marked
 * "discoverable" is actually discovered rather than merely excused.
 *
 * Returns brief fragments to merge, each carrying its provenance so the brief
 * shows a reader where the statement came from.
 */
export function deriveFromContext(context: ProjectContextSnapshot): Partial<HandoffBriefContent> {
  const derived: Partial<HandoffBriefContent> = {};

  const architectureNotes: string[] = [];
  if (context.languages.length) architectureNotes.push(`Languages present: ${context.languages.join(', ')}.`);
  for (const manifest of context.packageManifests.slice(0, 5)) {
    architectureNotes.push(
      `Package manifest ${manifest.path}${manifest.name ? ` (${manifest.name})` : ''}` +
        (manifest.scripts.length ? ` with scripts: ${manifest.scripts.slice(0, 12).join(', ')}.` : '.'),
    );
  }
  if (context.docFiles.length) {
    architectureNotes.push(`Documentation: ${context.docFiles.slice(0, 10).join(', ')}.`);
  }
  if (architectureNotes.length) {
    derived.relevantArchitecture = `Inspected from the repository at ${context.headSha.slice(0, 8)}:\n${architectureNotes.join('\n')}`;
  }

  if (context.testPaths.length) {
    derived.testingExpectations = [
      `Follow the existing test conventions in ${context.testPaths.slice(0, 5).join(', ')}.`,
      'All existing tests must continue to pass.',
    ];
  }

  return derived;
}
