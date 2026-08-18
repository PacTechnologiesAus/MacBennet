import { describe, expect, it } from 'vitest';
import {
  computeUsageDelta,
  describeUsageSource,
  isEnforceableCost,
  PROVIDER_USAGE_UNAVAILABLE,
  handoffBriefContentSchema,
  reviewEvidenceSchema,
  weakerSource,
  type UsageSnapshot,
  type UsageSnapshotDto,
} from '@mac/protocol';
import { buildMorningReport, buildPullRequestBody, buildUsageSummary, estimateHumanHours, renderUsageLine } from '../../src/domain/report.js';
import { reviewRun } from '../../src/domain/review.js';

/**
 * The usage model (Sprint 2 §15) and the morning report (§14).
 *
 * The property being defended throughout: an estimate must never be presented
 * as exact provider usage, and an unknown must be reported as unknown rather
 * than as zero.
 */

const snapshot = (overrides: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  provider: 'claude_code',
  phase: 'after',
  source: 'exact',
  capturedAt: '2026-08-17T00:00:00.000Z',
  inputTokens: 100,
  outputTokens: 200,
  ...overrides,
});

const dto = (s: UsageSnapshot): UsageSnapshotDto => ({
  id: 'id',
  runId: 'run',
  provider: s.provider,
  phase: s.phase,
  source: s.source,
  inputTokens: s.inputTokens ?? null,
  outputTokens: s.outputTokens ?? null,
  cacheReadTokens: s.cacheReadTokens ?? null,
  cacheCreationTokens: s.cacheCreationTokens ?? null,
  costCents: s.costCents ?? null,
  percentUsed: s.percentUsed ?? null,
  state: s.state ?? null,
  reportingPeriod: s.reportingPeriod ?? null,
  note: s.note ?? null,
  capturedAt: s.capturedAt,
});

describe('usage sources are never conflated', () => {
  it('describes each source distinctly', () => {
    expect(describeUsageSource('exact')).toContain('Exact');
    expect(describeUsageSource('observed')).toContain('Observed');
    expect(describeUsageSource('estimated')).toContain('Estimated');
    expect(describeUsageSource('unavailable')).toBe(PROVIDER_USAGE_UNAVAILABLE);
  });

  it('only treats exact monetary cost as enforceable', () => {
    expect(isEnforceableCost('exact')).toBe(true);
    expect(isEnforceableCost('observed')).toBe(false);
    expect(isEnforceableCost('estimated')).toBe(false);
    expect(isEnforceableCost('unavailable')).toBe(false);
  });

  it('degrades a mixed-source delta to the weaker of the two', () => {
    expect(weakerSource('exact', 'estimated')).toBe('estimated');
    expect(weakerSource('observed', 'exact')).toBe('observed');

    const delta = computeUsageDelta(
      snapshot({ phase: 'before', source: 'exact', inputTokens: 10, outputTokens: 20 }),
      snapshot({ phase: 'after', source: 'estimated', inputTokens: 40, outputTokens: 60 }),
    );
    expect(delta.source).toBe('estimated');
    expect(delta.note).toContain('different sources');
  });

  it('produces no delta at all when usage is unavailable', () => {
    const delta = computeUsageDelta(null, snapshot({ source: 'unavailable', inputTokens: null, outputTokens: null }));
    expect(delta.meaningful).toBe(false);
    expect(delta.inputTokens).toBeNull();
    expect(delta.note).toBe(PROVIDER_USAGE_UNAVAILABLE);
  });

  it('subtracts before from after when both are real readings', () => {
    const delta = computeUsageDelta(
      snapshot({ phase: 'before', inputTokens: 10, outputTokens: 20, percentUsed: 42 }),
      snapshot({ phase: 'after', inputTokens: 110, outputTokens: 220, percentUsed: 51 }),
    );
    expect(delta.inputTokens).toBe(100);
    expect(delta.outputTokens).toBe(200);
    // The brief's worked example: before 42%, after 51%, delta ~9 points.
    expect(delta.percentUsedDelta).toBe(9);
    expect(delta.meaningful).toBe(true);
  });

  it('treats an after-only reading as a session total and says so', () => {
    const delta = computeUsageDelta(null, snapshot({ inputTokens: 500 }));
    expect(delta.inputTokens).toBe(500);
    expect(delta.meaningful).toBe(true);
    expect(delta.note).toContain('session totals');
  });
});

describe('usage rendering always carries provenance', () => {
  it('renders the unavailable case with the exact wording the spec requires', () => {
    const summary = buildUsageSummary('claude_code', null, null);
    expect(summary.source).toBe('unavailable');
    expect(summary.label).toBe(PROVIDER_USAGE_UNAVAILABLE);
    expect(summary.costEnforceable).toBe(false);
  });

  it('labels subscription cost as an equivalent list price rather than money billed', () => {
    // This is the honesty requirement from Sprint 2 §16: under subscription
    // access the dollar figure is not what was charged.
    const summary = buildUsageSummary(
      'claude_code',
      null,
      dto(snapshot({ source: 'estimated', costCents: 34, note: 'Subscription access; list-price equivalent.' })),
    );
    expect(summary.costEnforceable).toBe(false);
    expect(summary.label).toContain('equivalent API list price');
    expect(summary.label).toContain('not billed');
  });

  it('labels API-key cost as billed and enforceable', () => {
    const summary = buildUsageSummary('claude_code', null, dto(snapshot({ source: 'exact', costCents: 34 })));
    expect(summary.costEnforceable).toBe(true);
    expect(summary.label).toContain('billed');
  });

  it('never prints a bare number without its source', () => {
    for (const source of ['exact', 'observed', 'estimated'] as const) {
      const summary = buildUsageSummary('claude_code', null, dto(snapshot({ source, inputTokens: 1, outputTokens: 2 })));
      expect(renderUsageLine(summary)).toContain('Source:');
    }
  });

  it('reports an observed rate-limit state without inventing a percentage', () => {
    const summary = buildUsageSummary(
      'claude_code',
      dto(snapshot({ phase: 'before', source: 'observed', inputTokens: null, outputTokens: null, state: 'allowed', reportingPeriod: 'five_hour' })),
      dto(snapshot({ phase: 'after', source: 'observed', inputTokens: null, outputTokens: null, state: 'allowed', reportingPeriod: 'five_hour' })),
    );
    expect(summary.source).toBe('observed');
    expect(summary.delta.percentUsedDelta).toBeNull();
    expect(summary.label).not.toMatch(/\d+(\.\d+)?%/);
  });
});

describe('estimated human hours', () => {
  const evidence = (files: number, insertions: number, deletions: number, commits = 1) =>
    reviewEvidenceSchema.parse({
      agentSummary: '',
      agentReportedSuccess: true,
      filesChanged: [],
      commits: Array.from({ length: commits }, (_, i) => ({ sha: `sha${i}`, subject: 's' })),
      diffStat: { files, insertions, deletions },
      tests: { ran: true, command: ['npm', 'test'], exitCode: 0, passed: true, durationMs: 1, output: '' },
      defaultBranchUnchanged: true,
    });

  it('scales with the size of the change', () => {
    const small = estimateHumanHours(evidence(1, 10, 2), 0);
    const large = estimateHumanHours(evidence(20, 800, 200), 10);
    expect(large.hours).toBeGreaterThan(small.hours);
  });

  it('always states the basis, because the figure is an estimate', () => {
    const result = estimateHumanHours(evidence(3, 90, 10), 2);
    expect(result.basis).toContain('estimate');
    expect(result.basis).toContain('file');
  });

  it('reports zero for a run that produced nothing', () => {
    expect(estimateHumanHours(null, 0).hours).toBe(0);
  });
});

describe('morning report', () => {
  const brief = handoffBriefContentSchema.parse({
    title: 'Allow selecting multiple devices',
    userObjective: 'Operators must be able to select several devices at once. Today they can only pick one.',
    proposedScope: 'Add multi-select to the device selector and accept an array in the devices API.',
    acceptanceCriteria: ['An operator can select multiple devices and save them.'],
  });

  const evidence = reviewEvidenceSchema.parse({
    agentSummary: 'Implemented multi-device selection.',
    agentReportedSuccess: true,
    filesChanged: [{ path: 'src/DeviceSelector.tsx', status: 'M', insertions: 40, deletions: 5 }],
    commits: [{ sha: 'abc', subject: 'feat: select multiple devices and save them' }],
    diffStat: { files: 1, insertions: 40, deletions: 5 },
    diffSample: 'operator select multiple devices save them',
    tests: { ran: true, command: ['npm', 'test'], exitCode: 0, passed: true, durationMs: 3000, output: '' },
    defaultBranchUnchanged: true,
  });

  const review = reviewRun({
    evidence,
    brief,
    confidence: 0.85,
    confidenceThreshold: 0.8,
    scopeKind: 'full',
    blockers: [],
    flaggedAssumptions: [],
    unansweredQuestions: 0,
    gitViolations: 0,
  });

  const base = {
    runId: '11111111-1111-1111-1111-111111111111',
    taskTitle: 'Allow selecting multiple devices',
    projectName: 'Device Portal',
    brief,
    evidence,
    review,
    questions: [
      { question: 'Sort the list?', answer: 'Alphabetically.', confidence: 0.55, decision: 'assumed' },
      { question: 'Which test runner?', answer: 'Vitest.', confidence: 0.9, decision: 'answered' },
    ],
    assumptions: [{ statement: 'The device list should be sorted alphabetically.', confidence: 0.55, flagged: true }],
    blockers: [],
    usage: buildUsageSummary('claude_code', null, dto(snapshot({ source: 'estimated', costCents: 34, inputTokens: 1000, outputTokens: 500 }))),
    outcome: 'completed',
    stopReason: 'completed',
    pullRequest: { url: 'https://github.com/acme/portal/pull/12', number: 12 },
    answerConfidenceThreshold: 0.8,
    generatedAt: new Date('2026-08-17T08:00:00.000Z'),
  };

  it('stays short at the top', () => {
    const report = buildMorningReport(base);
    // "What Changed" is one or two sentences, not an essay.
    expect(report.whatChanged.length).toBeLessThan(300);
    expect(report.why.length).toBeLessThan(300);
  });

  it('counts questions and links the detailed log rather than inlining it', () => {
    const report = buildMorningReport(base);
    expect(report.questionsAnswered).toBe(2);
    expect(report.lowConfidenceAnswers).toBe(1);
    expect(report.questionsLogUrl).toContain('/questions');
    // The full Q&A text must not be dumped into the report body.
    expect(report.markdown).not.toContain('Which test runner?');
  });

  it('surfaces only assumptions below the threshold', () => {
    const report = buildMorningReport(base);
    expect(report.flaggedAssumptions).toHaveLength(1);
    expect(report.markdown).toContain('sorted alphabetically');
  });

  it('includes every required section', () => {
    const md = buildMorningReport(base).markdown;
    for (const heading of [
      '## What Changed',
      '## Why',
      '## Risk',
      '## Exceptions / Anomalies',
      '## Decisions Needed',
      '## Assumptions',
      '## Questions Mac Answered',
      '## Pull Request',
      '## Estimated Human Hours',
      '## AI Usage',
    ]) {
      expect(md).toContain(heading);
    }
  });

  it('explains why no pull request exists rather than silently omitting one', () => {
    const declined = reviewRun({
      evidence: { ...evidence, tests: { ran: true, command: ['npm', 'test'], exitCode: 1, passed: false, durationMs: 1, output: 'fail' } },
      brief,
      confidence: 0.85,
      confidenceThreshold: 0.8,
      scopeKind: 'full',
      blockers: [],
      flaggedAssumptions: [],
      unansweredQuestions: 0,
      gitViolations: 0,
    });
    const report = buildMorningReport({ ...base, review: declined, pullRequest: null });
    expect(report.pullRequestUrl).toBeNull();
    expect(report.pullRequestDeclineReason).toContain('Tests failed');
    expect(report.markdown).toContain('Tests failed');
  });

  it('reports AI usage with its provenance attached', () => {
    const report = buildMorningReport(base);
    expect(report.markdown).toContain('Source: Estimated');
    expect(report.markdown).toContain('not billed');
  });

  it('says so plainly when provider usage is unavailable', () => {
    const report = buildMorningReport({ ...base, usage: buildUsageSummary('claude_code', null, null) });
    expect(report.markdown).toContain(PROVIDER_USAGE_UNAVAILABLE);
  });
});

describe('pull-request body', () => {
  const brief = handoffBriefContentSchema.parse({
    title: 'Allow selecting multiple devices',
    userObjective: 'Operators must be able to select several devices at once.',
    proposedScope: 'Add multi-select to the device selector.',
  });

  const evidence = reviewEvidenceSchema.parse({
    agentSummary: 'done',
    agentReportedSuccess: true,
    filesChanged: [{ path: 'src/DeviceSelector.tsx', status: 'M', insertions: 40, deletions: 5 }],
    commits: [{ sha: 'abc', subject: 'feat: multi select' }],
    diffStat: { files: 1, insertions: 40, deletions: 5 },
    tests: { ran: true, command: ['npm', 'test'], exitCode: 0, passed: true, durationMs: 3000, output: '' },
    defaultBranchUnchanged: true,
  });

  const body = buildPullRequestBody({
    runId: 'run-1',
    taskTitle: 'Allow selecting multiple devices',
    projectName: 'Device Portal',
    brief,
    evidence,
    review: null,
    questions: [{ question: 'Sort order?', answer: 'Alphabetical.', confidence: 0.5, decision: 'assumed' }],
    assumptions: [{ statement: 'Sorted alphabetically.', confidence: 0.5, flagged: true }],
    blockers: [],
    usage: buildUsageSummary('claude_code', null, null),
    outcome: 'completed',
    stopReason: 'completed',
    pullRequest: null,
    answerConfidenceThreshold: 0.8,
    generatedAt: new Date('2026-08-17T08:00:00.000Z'),
  });

  it('contains all seven required sections in the specified order', () => {
    const headings = ['## Summary', '## Why', '## Testing', '## Assumptions', '## Decisions Requiring Review', '## Risk', '## Known Issues'];
    let cursor = -1;
    for (const heading of headings) {
      const index = body.indexOf(heading);
      expect(index, `missing section ${heading}`).toBeGreaterThan(-1);
      expect(index, `section ${heading} is out of order`).toBeGreaterThan(cursor);
      cursor = index;
    }
  });

  it('surfaces decisions made below the confidence threshold', () => {
    expect(body).toContain('Sort order?');
    expect(body).toContain('50%');
  });

  it('states plainly that Mac does not merge his own work', () => {
    expect(body).toContain('does not merge');
  });
});
