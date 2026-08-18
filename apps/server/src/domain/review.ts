import type { HandoffBriefContent, ReviewEvidence, ReviewVerdict, RiskLevel } from '@mac/protocol';

/**
 * Mac's self-review (Sprint 2 §12) and pull-request eligibility (§13).
 *
 * The governing principle: **a coding agent declaring success is not evidence.**
 * Everything judged here comes from the repository itself — the diff, the test
 * exit code, the working tree, the commit list — not from what the agent said
 * about its own work. The agent's summary is one input among many, and it is
 * explicitly cross-checked against the facts rather than trusted.
 *
 * Pure: no database, no filesystem, no process. The worker gathers facts, this
 * module draws conclusions, and the service layer persists them.
 */

export interface ReviewInputs {
  evidence: ReviewEvidence;
  brief: HandoffBriefContent;
  /** Understanding confidence recorded on the run. */
  confidence: number | null;
  /** The autonomy threshold in force. */
  confidenceThreshold: number;
  /** Was the approved scope narrowed (the 60–79% band)? */
  scopeKind: 'full' | 'limited';
  /** Blockers recorded during the run — work deliberately left undone. */
  blockers: Array<{ description: string; risk: 'low' | 'medium' | 'high' }>;
  /** Assumptions below the autonomy threshold. */
  flaggedAssumptions: Array<{ statement: string; confidence: number }>;
  /** Questions Mac could not answer safely. */
  unansweredQuestions: number;
  /** Refused git operations. Any at all is disqualifying. */
  gitViolations: number;
}

export interface ReviewOutcome {
  verdict: ReviewVerdict;
  riskLevel: RiskLevel;
  satisfiesBrief: boolean;
  acceptanceCriteriaMet: boolean;
  unexpectedScope: boolean;
  humanAttentionRequired: boolean;
  anomalies: string[];
  prRecommended: boolean;
  prDeclineReason: string | null;
}

/**
 * Things that are individually legal but collectively mean "a human should look
 * at this before it is trusted". Each is reported in the review and the report;
 * none is silently tolerated.
 */
function detectAnomalies(input: ReviewInputs): string[] {
  const { evidence } = input;
  const anomalies: string[] = [];

  if (evidence.uncommittedFiles.length > 0) {
    anomalies.push(
      `${evidence.uncommittedFiles.length} file(s) were modified but never committed: ${evidence.uncommittedFiles.slice(0, 8).join(', ')}. Work in the worktree is not in the branch.`,
    );
  }

  if (evidence.dependencyChanges.length > 0) {
    // Spec §16 lists dependency changes as "allowed but must be reported".
    anomalies.push(`Dependency manifests changed: ${evidence.dependencyChanges.join(', ')}. Review the new or updated packages.`);
  }

  if (evidence.configurationChanges.length > 0) {
    anomalies.push(`Configuration changed: ${evidence.configurationChanges.join(', ')}.`);
  }

  if (evidence.migrations.length > 0) {
    anomalies.push(`Database migrations added: ${evidence.migrations.join(', ')}. These are not reversible by re-running the branch.`);
  }

  if (!evidence.defaultBranchUnchanged) {
    anomalies.push('The default branch moved during this run. This must be investigated before anything is merged.');
  }

  if (evidence.prohibitedOperationsAttempted > 0) {
    anomalies.push(
      `${evidence.prohibitedOperationsAttempted} prohibited git operation(s) were attempted and refused during this run.`,
    );
  }

  // The agent said it finished but produced nothing. This is the single most
  // common way an autonomous coding run silently wastes a night.
  if (evidence.agentReportedSuccess && evidence.commits.length === 0) {
    anomalies.push('The coding agent reported success but created no commits.');
  }

  if (evidence.agentReportedSuccess && evidence.diffStat.files === 0 && evidence.commits.length > 0) {
    anomalies.push('Commits exist but the diff against the base branch is empty.');
  }

  if (evidence.tests && evidence.tests.ran && evidence.tests.passed === false) {
    anomalies.push(`Tests failed (exit code ${evidence.tests.exitCode}).`);
  }

  if (!evidence.tests || !evidence.tests.ran) {
    anomalies.push('No test run was recorded for this change.');
  }

  if (evidence.build && evidence.build.ran && evidence.build.passed === false) {
    anomalies.push(`Build or typecheck failed (exit code ${evidence.build.exitCode}).`);
  }

  // Scope check: did the agent touch something the brief said not to?
  for (const forbidden of input.brief.mustNotChange) {
    const hits = evidence.filesChanged.filter((f) => pathMatchesPhrase(f.path, forbidden));
    if (hits.length > 0) {
      anomalies.push(
        `The brief said not to change "${forbidden}", but ${hits.length} changed file(s) match it: ${hits.slice(0, 5).map((h) => h.path).join(', ')}.`,
      );
    }
  }

  return anomalies;
}

/**
 * Common words that identify nothing, so must not make a phrase match a path.
 * Without this, "the existing API" would match on "the".
 */
const GENERIC_PATH_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'existing', 'current',
  'format', 'file', 'files', 'code', 'data', 'system', 'thing', 'stuff', 'any',
  'our', 'their', 'its', 'new', 'old', 'other', 'same', 'main', 'src', 'app',
]);

/**
 * Does a file path refer to the thing a brief phrase names?
 *
 * Two ways this can go wrong, and both were seen in practice:
 *
 *   * a plain substring test fails on the case that matters — the brief says
 *     "csv import" and the file is `src/import/csv-import.ts`, where the
 *     separators differ between prose and path;
 *   * requiring EVERY word of the phrase to appear means the check never fires
 *     for any realistic phrase, so it looks like protection and is not.
 *
 * So both sides are reduced to tokens, and a match is any single DISTINCTIVE
 * token in common. It is deliberately generous: this produces a review note and
 * raises the risk level, and a false positive costs a line a human reads, while
 * a false negative means Mac silently changed something he was told not to.
 */
export function pathMatchesPhrase(path: string, phrase: string): boolean {
  const tokens = phrase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !GENERIC_PATH_WORDS.has(t));
  if (tokens.length === 0) return false;

  const pathTokens = path.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((t) => pathTokens.some((p) => p === t || (t.length >= 4 && p.includes(t))));
}

/** A change far larger than the brief implied is itself a review signal. */
function looksLikeUnexpectedScope(input: ReviewInputs): boolean {
  const { evidence, brief } = input;
  if (evidence.diffStat.files === 0) return false;

  const touchedForbidden = brief.mustNotChange.some((forbidden) =>
    evidence.filesChanged.some((f) => pathMatchesPhrase(f.path, forbidden)),
  );
  if (touchedForbidden) return true;

  if (evidence.migrations.length > 0 && !mentions(brief, 'migration')) return true;
  if (evidence.dependencyChanges.length > 0 && !mentions(brief, 'dependenc')) return true;

  // A very large diff for a task whose brief listed few affected components.
  const expectedComponents = Math.max(brief.likelyAffectedComponents.length, 1);
  return evidence.diffStat.files > expectedComponents * 12 && evidence.diffStat.files > 25;
}

const mentions = (brief: HandoffBriefContent, needle: string): boolean =>
  JSON.stringify(brief).toLowerCase().includes(needle.toLowerCase());

/**
 * Does the work appear to meet the acceptance criteria?
 *
 * This is a heuristic and is treated as one: it looks for each criterion's
 * distinctive words in the diff, the commit subjects and the agent's summary.
 * It can be wrong in both directions, which is exactly why a PR being opened
 * still leaves the merge decision with a human — Mac is producing a reviewable
 * result, not a verified one.
 */
export function assessAcceptanceCriteria(
  criteria: readonly string[],
  evidence: ReviewEvidence,
): { met: boolean; unmet: string[] } {
  if (criteria.length === 0) return { met: false, unmet: [] };

  const haystack = [
    evidence.diffSample,
    evidence.agentSummary,
    ...evidence.commits.map((c) => c.subject),
    ...evidence.filesChanged.map((f) => f.path),
  ]
    .join('\n')
    .toLowerCase();

  const unmet = criteria.filter((criterion) => {
    const terms = criterion
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4 && !STOP_WORDS.has(t));
    if (terms.length === 0) return false;
    const hits = terms.filter((t) => haystack.includes(t)).length;
    // Half the distinctive terms appearing is weak evidence of coverage — but
    // it is evidence, and demanding all of them would fail every real criterion.
    return hits / terms.length < 0.5;
  });

  return { met: unmet.length === 0, unmet };
}

const STOP_WORDS = new Set([
  'should', 'must', 'will', 'that', 'this', 'with', 'from', 'when', 'then', 'they',
  'have', 'been', 'were', 'able', 'user', 'users', 'system', 'work', 'works', 'without',
]);

export function reviewRun(input: ReviewInputs): ReviewOutcome {
  const { evidence } = input;
  const anomalies = detectAnomalies(input);

  const acceptance = assessAcceptanceCriteria(input.brief.acceptanceCriteria, evidence);
  if (acceptance.unmet.length > 0) {
    anomalies.push(`Acceptance criteria with no visible evidence in the diff: ${acceptance.unmet.slice(0, 5).join(' | ')}`);
  }

  const unexpectedScope = looksLikeUnexpectedScope(input);
  const testsPassed = evidence.tests?.ran === true && evidence.tests.passed === true;
  const testsFailed = evidence.tests?.ran === true && evidence.tests.passed === false;
  const buildFailed = evidence.build?.ran === true && evidence.build.passed === false;
  const hasCommits = evidence.commits.length > 0;
  const openBlockers = input.blockers.filter((b) => !!b.description);
  const highRiskBlockers = openBlockers.filter((b) => b.risk === 'high');

  // --- Verdict -------------------------------------------------------------

  let verdict: ReviewVerdict;
  if (!hasCommits) {
    verdict = 'does_not_satisfy_brief';
  } else if (!evidence.defaultBranchUnchanged || evidence.prohibitedOperationsAttempted > 0) {
    // The work may be fine, but the run's integrity is in question, and that
    // has to dominate: an unreviewable run is not a passing one.
    verdict = 'unreviewable';
  } else if (testsFailed || buildFailed || openBlockers.length > 0 || acceptance.unmet.length > 0) {
    verdict = 'partially_satisfies_brief';
  } else {
    verdict = 'satisfies_brief';
  }

  const satisfiesBrief = verdict === 'satisfies_brief';

  // --- Risk ----------------------------------------------------------------

  let riskLevel: RiskLevel = 'low';
  const riskReasons: string[] = [];
  if (evidence.migrations.length > 0) { riskLevel = 'high'; riskReasons.push('database migrations'); }
  if (!evidence.defaultBranchUnchanged || evidence.prohibitedOperationsAttempted > 0) { riskLevel = 'high'; riskReasons.push('git integrity'); }
  if (highRiskBlockers.length > 0) { riskLevel = 'high'; riskReasons.push('high-risk blockers'); }
  if (riskLevel !== 'high') {
    if (testsFailed || buildFailed) { riskLevel = 'medium'; }
    else if (evidence.dependencyChanges.length > 0 || evidence.configurationChanges.length > 0) { riskLevel = 'medium'; }
    else if (unexpectedScope) { riskLevel = 'medium'; }
    else if (input.flaggedAssumptions.length > 2) { riskLevel = 'medium'; }
    else if (!evidence.tests?.ran) { riskLevel = 'medium'; }
  }

  const humanAttentionRequired =
    !satisfiesBrief ||
    riskLevel === 'high' ||
    unexpectedScope ||
    openBlockers.length > 0 ||
    input.unansweredQuestions > 0 ||
    input.flaggedAssumptions.length > 0 ||
    evidence.uncommittedFiles.length > 0;

  // --- PR eligibility ------------------------------------------------------

  const decline = firstFailingPrCondition({
    ...input,
    hasCommits,
    testsPassed,
    testsFailed,
    buildFailed,
    highRiskBlockers: highRiskBlockers.length,
    unexpectedScope,
  });

  return {
    verdict,
    riskLevel,
    satisfiesBrief,
    acceptanceCriteriaMet: acceptance.met,
    unexpectedScope,
    humanAttentionRequired,
    anomalies,
    prRecommended: decline === null,
    prDeclineReason: decline,
  };
}

/**
 * The seven PR conditions from Sprint 2 §13, evaluated in order.
 *
 * Returning the FIRST failure rather than a list is deliberate: the report says
 * "no PR because tests failed", which is actionable, instead of a paragraph
 * that a tired engineer skims past.
 */
function firstFailingPrCondition(
  input: ReviewInputs & {
    hasCommits: boolean;
    testsPassed: boolean;
    testsFailed: boolean;
    buildFailed: boolean;
    highRiskBlockers: number;
    unexpectedScope: boolean;
  },
): string | null {
  if (input.gitViolations > 0 || input.evidence.prohibitedOperationsAttempted > 0) {
    return 'A prohibited git operation was attempted during this run. No pull request will be opened until a human has reviewed what happened.';
  }

  if (!input.evidence.defaultBranchUnchanged) {
    return `The default branch changed during this run. No pull request will be opened; the repository state must be investigated first.`;
  }

  if (!input.hasCommits) {
    return 'No commits were created on the task branch, so there is nothing to review.';
  }

  if (input.confidence === null) {
    return 'No understanding confidence was recorded for this run.';
  }

  // Confidence: in the limited band a PR is still permitted, but ONLY because a
  // human explicitly approved that narrowed scope — which `scopeKind` records.
  const millis = Math.round(input.confidence * 1000);
  const threshold = Math.round(input.confidenceThreshold * 1000);
  if (millis < threshold && input.scopeKind !== 'limited') {
    return `Understanding confidence ${(input.confidence * 100).toFixed(0)}% is below the ${(input.confidenceThreshold * 100).toFixed(0)}% autonomy threshold and no limited scope was explicitly approved.`;
  }

  if (input.testsFailed) {
    return 'Tests failed and the failures are not explained. The branch and worktree have been left intact for inspection.';
  }

  if (input.buildFailed) {
    return 'The build or typecheck failed. The branch and worktree have been left intact for inspection.';
  }

  if (input.highRiskBlockers > 0) {
    return `${input.highRiskBlockers} high-risk blocker(s) remain unresolved, so this work is not ready for review as a pull request.`;
  }

  if (input.unansweredQuestions > 0) {
    return `${input.unansweredQuestions} question(s) could not be answered safely and were left for a human.`;
  }

  return null;
}
