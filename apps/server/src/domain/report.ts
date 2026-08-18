import {
  computeUsageDelta,
  describeUsageSource,
  PROVIDER_USAGE_UNAVAILABLE,
  type HandoffBriefContent,
  type MorningReportDto,
  type ReviewEvidence,
  type RiskLevel,
  type RunUsageSummaryDto,
  type UsageSnapshot,
  type UsageSnapshotDto,
} from '@mac/protocol';
import type { ReviewOutcome } from './review.js';

/**
 * The pull-request body and the morning report (Sprint 2 §13, §14).
 *
 * Both are pure functions of recorded facts. Neither invents anything: where a
 * figure is unknown the text says so, because the failure mode of an
 * autonomous engineer's reporting is not being wrong, it is being confidently
 * vague.
 *
 * The morning report is deliberately SHORT at the top. Spec §28: "Engineers
 * will ignore giant AI-generated novels." Every long thing — the Q&A log, the
 * full diff, the run log — lives behind a link rather than in the body.
 */

export interface ReportInputs {
  runId: string;
  taskTitle: string;
  projectName: string;
  brief: HandoffBriefContent;
  evidence: ReviewEvidence | null;
  review: ReviewOutcome | null;
  questions: Array<{ question: string; answer: string | null; confidence: number | null; decision: string | null }>;
  assumptions: Array<{ statement: string; confidence: number; flagged: boolean }>;
  blockers: Array<{ description: string; reason: string; risk: string }>;
  usage: RunUsageSummaryDto;
  outcome: string;
  stopReason: string | null;
  pullRequest: { url: string; number: number | null } | null;
  /** Threshold below which an answer counts as low-confidence. */
  answerConfidenceThreshold: number;
  generatedAt: Date;
}

// ---------------------------------------------------------------------------
// Pull request body
// ---------------------------------------------------------------------------

export function buildPullRequestTitle(brief: HandoffBriefContent): string {
  const title = brief.title.trim().replace(/\s+/g, ' ');
  return title.length > 120 ? `${title.slice(0, 117)}…` : title;
}

/**
 * The seven fixed sections from Sprint 2 §13. Fixed, in this order, every time:
 * a reviewer who has read one of Mac's pull requests can skim the next.
 */
export function buildPullRequestBody(input: ReportInputs): string {
  const { brief, evidence, review } = input;
  const out: string[] = [];

  out.push('## Summary', '');
  out.push(summariseChange(input), '');

  out.push('## Why', '');
  out.push(brief.userObjective.trim() || 'No objective was recorded.', '');

  out.push('## Testing', '');
  out.push(describeTesting(evidence), '');

  out.push('## Assumptions', '');
  if (input.assumptions.length === 0) {
    out.push('None recorded.', '');
  } else {
    for (const a of input.assumptions) {
      out.push(`- ${a.statement} _(confidence ${(a.confidence * 100).toFixed(0)}%${a.flagged ? ', **flagged for review**' : ''})_`);
    }
    out.push('');
  }

  out.push('## Decisions Requiring Review', '');
  const lowConfidence = input.questions.filter(
    (q) => q.confidence !== null && Math.round(q.confidence * 1000) < Math.round(input.answerConfidenceThreshold * 1000),
  );
  if (lowConfidence.length === 0) {
    out.push(`No decisions were made below ${(input.answerConfidenceThreshold * 100).toFixed(0)}% confidence.`, '');
  } else {
    out.push(
      `${lowConfidence.length} decision(s) were made below ${(input.answerConfidenceThreshold * 100).toFixed(0)}% confidence and should be checked:`,
      '',
    );
    for (const q of lowConfidence) {
      out.push(`- **Q:** ${q.question}`);
      out.push(`  **Mac's answer** (${((q.confidence ?? 0) * 100).toFixed(0)}%): ${q.answer ?? '—'}`);
    }
    out.push('');
  }

  out.push('## Risk', '');
  const risk = review?.riskLevel ?? 'medium';
  out.push(`**${risk.toUpperCase()}** — ${riskRationale(input, risk)}`, '');

  out.push('## Known Issues', '');
  const issues = [
    ...(review?.anomalies ?? []),
    ...input.blockers.map((b) => `Blocked: ${b.description} — ${b.reason}`),
  ];
  if (issues.length === 0) {
    out.push('None recorded.', '');
  } else {
    for (const issue of issues) out.push(`- ${issue}`);
    out.push('');
  }

  out.push('---', '');
  out.push(
    `Prepared autonomously by Mac Bennett. Run \`${input.runId}\`. ` +
      'Mac does not merge his own work — this pull request is for human review.',
  );

  return out.join('\n');
}

function summariseChange(input: ReportInputs): string {
  const { evidence } = input;
  if (!evidence || evidence.diffStat.files === 0) {
    return input.brief.proposedScope.trim() || input.brief.userObjective.trim() || 'No changes were produced.';
  }
  const files = evidence.filesChanged.slice(0, 12).map((f) => `- \`${f.path}\` (+${f.insertions}/-${f.deletions})`);
  const more = evidence.filesChanged.length > 12 ? `\n- …and ${evidence.filesChanged.length - 12} more file(s)` : '';
  return [
    input.brief.proposedScope.trim() || input.brief.desiredBehaviour.trim() || input.brief.userObjective.trim(),
    '',
    `${evidence.diffStat.files} file(s) changed, +${evidence.diffStat.insertions}/-${evidence.diffStat.deletions}, across ${evidence.commits.length} commit(s).`,
    '',
    ...files,
  ].join('\n') + more;
}

function describeTesting(evidence: ReviewEvidence | null): string {
  if (!evidence) return 'No test evidence was collected.';
  const parts: string[] = [];

  if (evidence.tests?.ran) {
    const verdict = evidence.tests.passed ? 'passed' : `FAILED (exit code ${evidence.tests.exitCode})`;
    parts.push(`- \`${evidence.tests.command.join(' ')}\` — **${verdict}**${evidence.tests.durationMs ? ` in ${(evidence.tests.durationMs / 1000).toFixed(1)}s` : ''}`);
  } else {
    parts.push('- No test command was configured or run for this repository.');
  }

  if (evidence.build?.ran) {
    const verdict = evidence.build.passed ? 'passed' : `FAILED (exit code ${evidence.build.exitCode})`;
    parts.push(`- \`${evidence.build.command.join(' ')}\` — **${verdict}**`);
  }

  return parts.join('\n');
}

function riskRationale(input: ReportInputs, risk: RiskLevel): string {
  const reasons: string[] = [];
  const e = input.evidence;
  if (e?.migrations.length) reasons.push(`${e.migrations.length} database migration(s)`);
  if (e?.dependencyChanges.length) reasons.push('dependency changes');
  if (e?.configurationChanges.length) reasons.push('configuration changes');
  if (e?.tests?.ran === false || !e?.tests) reasons.push('no tests were run');
  if (e?.tests?.passed === false) reasons.push('tests failed');
  if (input.review?.unexpectedScope) reasons.push('the change is broader than the brief implied');
  if (input.assumptions.some((a) => a.flagged)) reasons.push(`${input.assumptions.filter((a) => a.flagged).length} flagged assumption(s)`);
  if (input.blockers.length) reasons.push(`${input.blockers.length} blocker(s)`);

  if (reasons.length === 0) {
    return risk === 'low'
      ? 'Isolated change, tests passed, no dependency, configuration or schema changes, and no flagged assumptions.'
      : 'See the known issues below.';
  }
  return reasons.join('; ') + '.';
}

// ---------------------------------------------------------------------------
// Morning report
// ---------------------------------------------------------------------------

/**
 * Effort estimate.
 *
 * Deliberately crude, and labelled as an estimate everywhere it appears. A
 * precise-looking figure here would be a fabrication: nobody can derive human
 * hours from a diff. What the number IS good for is order of magnitude — "this
 * saved an afternoon" versus "this saved ten minutes" — so the basis is always
 * reported alongside it and the result is rounded to a quarter hour.
 */
export function estimateHumanHours(evidence: ReviewEvidence | null, questions: number): { hours: number; basis: string } {
  if (!evidence || evidence.diffStat.files === 0) {
    return { hours: 0, basis: 'No changes were produced.' };
  }

  const lines = evidence.diffStat.insertions + evidence.diffStat.deletions;
  // ~35 changed lines per hour for considered work including reading, testing
  // and iteration — not typing speed.
  const fromLines = lines / 35;
  // Each file carries orientation cost regardless of how much changed in it.
  const fromFiles = evidence.diffStat.files * 0.15;
  // Each question represents a decision a human would also have had to make.
  const fromQuestions = questions * 0.1;
  const testBonus = evidence.tests?.ran ? 0.25 : 0;

  const raw = fromLines + fromFiles + fromQuestions + testBonus;
  const hours = Math.max(0.25, Math.round(raw * 4) / 4);

  return {
    hours,
    basis: `${evidence.diffStat.files} file(s), ${lines} changed line(s), ${evidence.commits.length} commit(s), ${questions} decision(s)${evidence.tests?.ran ? ', tests run' : ''}. Rough order-of-magnitude estimate only.`,
  };
}

export function buildMorningReport(input: ReportInputs): MorningReportDto {
  const lowConfidenceAnswers = input.questions.filter(
    (q) => q.confidence !== null && Math.round(q.confidence * 1000) < Math.round(input.answerConfidenceThreshold * 1000),
  ).length;

  const flaggedAssumptions = input.assumptions
    .filter((a) => a.flagged)
    .map((a) => ({ statement: a.statement, confidence: a.confidence }));

  const effort = estimateHumanHours(input.evidence, input.questions.length);
  const risk: RiskLevel = input.review?.riskLevel ?? (input.outcome === 'completed' ? 'medium' : 'high');

  const exceptions = [
    ...(input.review?.anomalies ?? []),
    ...(input.stopReason && input.stopReason !== 'completed' ? [`Run ended with stop reason: ${input.stopReason}.`] : []),
  ];

  const decisionsNeeded: string[] = [];
  if (input.blockers.length > 0) {
    for (const b of input.blockers) decisionsNeeded.push(`${b.description} — ${b.reason}`);
  }
  if (input.review && !input.review.prRecommended && input.review.prDeclineReason) {
    decisionsNeeded.push(`No pull request was opened: ${input.review.prDeclineReason}`);
  }
  if (input.review?.unexpectedScope) {
    decisionsNeeded.push('The change is broader than the brief implied — confirm the extra scope is wanted.');
  }

  const content: MorningReportDto = {
    runId: input.runId,
    taskTitle: input.taskTitle,
    projectName: input.projectName,
    generatedAt: input.generatedAt.toISOString(),
    whatChanged: shortWhatChanged(input),
    why: firstSentence(input.brief.userObjective) || input.taskTitle,
    risk,
    riskRationale: riskRationale(input, risk),
    exceptions,
    decisionsNeeded,
    flaggedAssumptions,
    questionsAnswered: input.questions.length,
    lowConfidenceAnswers,
    questionsLogUrl: `/runs/${input.runId}/questions`,
    pullRequestUrl: input.pullRequest?.url ?? null,
    pullRequestDeclineReason: input.pullRequest ? null : (input.review?.prDeclineReason ?? null),
    estimatedHumanHours: effort.hours,
    estimatedHumanHoursBasis: effort.basis,
    usage: input.usage,
    outcome: input.outcome,
    markdown: '',
  };

  content.markdown = renderMorningReportMarkdown(content);
  return content;
}

/** One or two sentences. If Mac needs a paragraph here, he is doing it wrong. */
function shortWhatChanged(input: ReportInputs): string {
  const e = input.evidence;
  if (!e || e.diffStat.files === 0) {
    return input.outcome === 'completed'
      ? 'No code changes were produced.'
      : `No code changes were produced; the run ended as ${input.outcome}.`;
  }
  const scope = firstSentence(input.brief.proposedScope) || firstSentence(input.brief.desiredBehaviour) || input.taskTitle;
  return `${scope} (${e.diffStat.files} file(s), +${e.diffStat.insertions}/-${e.diffStat.deletions}, ${e.commits.length} commit(s)).`;
}

function firstSentence(text: string): string {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return '';
  const match = trimmed.match(/^.{0,240}?[.!?](\s|$)/s);
  return (match ? match[0] : trimmed.slice(0, 240)).trim();
}

export function renderMorningReportMarkdown(r: MorningReportDto): string {
  const out: string[] = [];
  out.push(`# ${r.taskTitle}`, '', `_${r.projectName} · ${new Date(r.generatedAt).toISOString()} · outcome: **${r.outcome}**_`, '');

  out.push('## What Changed', '', r.whatChanged, '');
  out.push('## Why', '', r.why, '');
  out.push('## Risk', '', `**${r.risk.toUpperCase()}** — ${r.riskRationale}`, '');

  out.push('## Exceptions / Anomalies', '');
  out.push(r.exceptions.length ? r.exceptions.map((e) => `- ${e}`).join('\n') : 'None.', '');

  out.push('## Decisions Needed', '');
  out.push(r.decisionsNeeded.length ? r.decisionsNeeded.map((d) => `- ${d}`).join('\n') : 'None.', '');

  out.push('## Assumptions', '');
  out.push(
    r.flaggedAssumptions.length
      ? r.flaggedAssumptions.map((a) => `- ${a.statement} _(${(a.confidence * 100).toFixed(0)}%)_`).join('\n')
      : 'No assumptions below the confidence threshold.',
    '',
  );

  out.push('## Questions Mac Answered', '');
  out.push(
    `${r.questionsAnswered} question(s)` +
      (r.lowConfidenceAnswers > 0 ? `, **${r.lowConfidenceAnswers} answered below the confidence threshold**` : '') +
      `. Full log: ${r.questionsLogUrl}`,
    '',
  );

  out.push('## Pull Request', '');
  out.push(r.pullRequestUrl ? r.pullRequestUrl : `None opened. ${r.pullRequestDeclineReason ?? 'No reason recorded.'}`, '');

  out.push('## Estimated Human Hours', '', `~${r.estimatedHumanHours}h — ${r.estimatedHumanHoursBasis}`, '');

  out.push('## AI Usage', '', renderUsageLine(r.usage), '');

  return out.join('\n').trimEnd();
}

/**
 * Renders usage with its provenance attached, always.
 *
 * There is no branch here that prints a bare number: every figure carries the
 * word `exact`, `observed` or `estimated`, or the whole line is
 * "Provider usage unavailable".
 */
export function renderUsageLine(usage: RunUsageSummaryDto): string {
  if (usage.source === 'unavailable') return PROVIDER_USAGE_UNAVAILABLE;

  const parts: string[] = [];
  const d = usage.delta;
  if (d.inputTokens !== null || d.outputTokens !== null) {
    parts.push(`${(d.inputTokens ?? 0).toLocaleString()} in / ${(d.outputTokens ?? 0).toLocaleString()} out tokens`);
  }
  if (d.cacheReadTokens !== null || d.cacheCreationTokens !== null) {
    parts.push(`cache ${(d.cacheReadTokens ?? 0).toLocaleString()} read / ${(d.cacheCreationTokens ?? 0).toLocaleString()} written`);
  }
  if (d.costCents !== null) {
    parts.push(
      usage.costEnforceable
        ? `$${(d.costCents / 100).toFixed(2)} billed`
        : `$${(d.costCents / 100).toFixed(2)} equivalent API list price (not billed — subscription access)`,
    );
  }
  if (d.percentUsedDelta !== null) parts.push(`${d.percentUsedDelta.toFixed(1)} percentage points of allowance`);

  const body = parts.length ? parts.join(' · ') : 'No usage figures were reported.';
  const note = d.note ? ` (${d.note})` : '';
  return `${usage.provider ?? 'provider'}: ${body}. Source: ${describeUsageSource(usage.source)}.${note}`;
}

// ---------------------------------------------------------------------------
// Usage summary assembly
// ---------------------------------------------------------------------------

export function buildUsageSummary(
  provider: string | null,
  before: UsageSnapshotDto | null,
  after: UsageSnapshotDto | null,
): RunUsageSummaryDto {
  const toSnapshot = (dto: UsageSnapshotDto | null): UsageSnapshot | null =>
    dto
      ? {
          provider: dto.provider,
          phase: dto.phase,
          source: dto.source,
          capturedAt: dto.capturedAt,
          inputTokens: dto.inputTokens,
          outputTokens: dto.outputTokens,
          cacheReadTokens: dto.cacheReadTokens,
          cacheCreationTokens: dto.cacheCreationTokens,
          costCents: dto.costCents,
          percentUsed: dto.percentUsed,
          state: dto.state,
          reportingPeriod: dto.reportingPeriod,
          note: dto.note,
        }
      : null;

  const delta = computeUsageDelta(toSnapshot(before), toSnapshot(after));

  const summary: RunUsageSummaryDto = {
    provider: provider ?? after?.provider ?? before?.provider ?? null,
    source: delta.source,
    before,
    after,
    delta: {
      inputTokens: delta.inputTokens,
      outputTokens: delta.outputTokens,
      cacheReadTokens: delta.cacheReadTokens,
      cacheCreationTokens: delta.cacheCreationTokens,
      costCents: delta.costCents,
      percentUsedDelta: delta.percentUsedDelta,
      meaningful: delta.meaningful,
      note: delta.note,
    },
    label: '',
    // Money is only enforceable when it is exact. Under subscription access it
    // never is, and the UI must not imply a dollar limit is being enforced.
    costEnforceable: delta.source === 'exact' && delta.costCents !== null,
  };

  summary.label = renderUsageLine(summary);
  return summary;
}
