import {
  COMPLETENESS_DIMENSIONS,
  DIMENSION_QUESTIONS,
  DIMENSION_WEIGHTS,
  type CompletenessDimension,
  type HandoffBriefContent,
  type ProjectContextSnapshot,
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
  question: string;
}

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
export function analyseGaps(
  brief: HandoffBriefContent,
  context: ProjectContextSnapshot | null = null,
): GapAnalysis {
  const assessments: DimensionAssessment[] = COMPLETENESS_DIMENSIONS.map((dimension) => {
    const satisfied = evaluate(brief, dimension);
    return {
      dimension,
      satisfied,
      weight: DIMENSION_WEIGHTS[dimension],
      discoverableFrom: satisfied ? [] : discoverableFrom(dimension, context),
      question: DIMENSION_QUESTIONS[dimension],
    };
  });

  /*
   * A dimension the repository can answer counts as PARTIALLY satisfied.
   *
   * Not fully: Mac inferring the testing convention from the repository is
   * genuinely weaker evidence than the human stating it, and pretending
   * otherwise would let confidence reach the autonomous band on inference
   * alone. Half credit reflects that honestly.
   */
  const confidence = assessments.reduce((total, a) => {
    if (a.satisfied) return total + a.weight;
    if (a.discoverableFrom.length > 0) return total + a.weight * 0.5;
    return total;
  }, 0);

  const outstanding = assessments
    .filter((a) => !a.satisfied && a.discoverableFrom.length === 0)
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
