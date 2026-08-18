import { describe, expect, it } from 'vitest';
import { handoffBriefContentSchema, reviewEvidenceSchema, type HandoffBriefContent, type ReviewEvidence } from '@mac/protocol';
import { reviewRun, assessAcceptanceCriteria, pathMatchesPhrase, type ReviewInputs } from '../../src/domain/review.js';

/**
 * Self-review (Sprint 2 §12) and pull-request eligibility (§13).
 *
 * The governing rule under test: a coding agent declaring success is not
 * evidence. Every assertion here works from repository facts.
 */

const brief = (overrides: Partial<HandoffBriefContent> = {}): HandoffBriefContent =>
  handoffBriefContentSchema.parse({
    title: 'Allow selecting multiple devices',
    userObjective: 'Operators must be able to select several devices.',
    desiredBehaviour: 'The device selector accepts multiple devices.',
    acceptanceCriteria: ['An operator can select multiple devices and save them.'],
    mustNotChange: ['csv import'],
    likelyAffectedComponents: ['DeviceSelector', 'devices route'],
    ...overrides,
  });

const evidence = (overrides: Partial<ReviewEvidence> = {}): ReviewEvidence =>
  reviewEvidenceSchema.parse({
    agentSummary: 'Added multiple device selection to the DeviceSelector component and the devices route.',
    agentReportedSuccess: true,
    filesChanged: [
      { path: 'src/components/DeviceSelector.tsx', status: 'M', insertions: 40, deletions: 8 },
      { path: 'src/routes/devices.ts', status: 'M', insertions: 15, deletions: 3 },
    ],
    uncommittedFiles: [],
    commits: [{ sha: 'abc1234', subject: 'feat: select multiple devices and save them' }],
    diffStat: { files: 2, insertions: 55, deletions: 11 },
    diffSample: 'operator can select multiple devices and save them',
    tests: { ran: true, command: ['npm', 'test'], exitCode: 0, passed: true, durationMs: 4200, output: 'all passed' },
    build: { ran: true, command: ['npm', 'run', 'typecheck'], exitCode: 0, passed: true, output: '' },
    dependencyChanges: [],
    configurationChanges: [],
    migrations: [],
    defaultBranchUnchanged: true,
    defaultBranchSha: 'basesha',
    prohibitedOperationsAttempted: 0,
    ...overrides,
  });

const inputs = (overrides: Partial<ReviewInputs> = {}): ReviewInputs => ({
  evidence: evidence(),
  brief: brief(),
  confidence: 0.85,
  confidenceThreshold: 0.8,
  scopeKind: 'full',
  blockers: [],
  flaggedAssumptions: [],
  unansweredQuestions: 0,
  gitViolations: 0,
  ...overrides,
});

describe('self-review — successful work', () => {
  it('accepts a clean run and recommends a pull request', () => {
    const result = reviewRun(inputs());
    expect(result.verdict).toBe('satisfies_brief');
    expect(result.satisfiesBrief).toBe(true);
    expect(result.riskLevel).toBe('low');
    expect(result.prRecommended).toBe(true);
    expect(result.prDeclineReason).toBeNull();
    expect(result.humanAttentionRequired).toBe(false);
  });
});

describe('self-review — failing tests', () => {
  it('downgrades the verdict and refuses a pull request', () => {
    const result = reviewRun(
      inputs({
        evidence: evidence({
          tests: { ran: true, command: ['npm', 'test'], exitCode: 1, passed: false, durationMs: 900, output: '2 failing' },
        }),
      }),
    );
    expect(result.verdict).toBe('partially_satisfies_brief');
    expect(result.prRecommended).toBe(false);
    expect(result.prDeclineReason).toContain('Tests failed');
    expect(result.anomalies.some((a) => a.includes('Tests failed'))).toBe(true);
    expect(result.humanAttentionRequired).toBe(true);
  });

  it('refuses a pull request when the build or typecheck fails', () => {
    const result = reviewRun(
      inputs({
        evidence: evidence({
          build: { ran: true, command: ['npm', 'run', 'typecheck'], exitCode: 2, passed: false, output: 'TS2345' },
        }),
      }),
    );
    expect(result.prRecommended).toBe(false);
    expect(result.prDeclineReason).toContain('build');
  });

  it('treats an absent test run as an anomaly and raises risk', () => {
    const result = reviewRun(inputs({ evidence: evidence({ tests: null }) }));
    expect(result.anomalies.some((a) => a.includes('No test run'))).toBe(true);
    expect(result.riskLevel).not.toBe('low');
  });
});

describe('self-review — unexpected changes', () => {
  it('reports a dependency change and raises risk without blocking the pull request', () => {
    // Spec §16 classes dependency changes as "allowed but must be reported".
    const result = reviewRun(inputs({ evidence: evidence({ dependencyChanges: ['package.json', 'package-lock.json'] }) }));
    expect(result.anomalies.some((a) => a.includes('Dependency manifests changed'))).toBe(true);
    expect(result.riskLevel).toBe('medium');
    expect(result.prRecommended).toBe(true);
    expect(result.humanAttentionRequired).toBe(true);
  });

  it('flags a migration as high risk', () => {
    const result = reviewRun(inputs({ evidence: evidence({ migrations: ['drizzle/0005_devices.sql'] }) }));
    expect(result.riskLevel).toBe('high');
    expect(result.anomalies.some((a) => a.includes('migration'))).toBe(true);
  });

  it('detects a change to something the brief said must not change', () => {
    const result = reviewRun(
      inputs({
        evidence: evidence({
          filesChanged: [{ path: 'src/import/csv-import.ts', status: 'M', insertions: 10, deletions: 2 }],
        }),
      }),
    );
    expect(result.unexpectedScope).toBe(true);
    expect(result.anomalies.some((a) => a.includes('must not change') || a.includes('not to change'))).toBe(true);
  });

  it('reports uncommitted files, which are work that would otherwise be silently lost', () => {
    const result = reviewRun(inputs({ evidence: evidence({ uncommittedFiles: ['src/scratch.ts'] }) }));
    expect(result.anomalies.some((a) => a.includes('never committed'))).toBe(true);
    expect(result.humanAttentionRequired).toBe(true);
  });
});

describe('self-review — incomplete work', () => {
  it('does not trust an agent that reports success while producing no commits', () => {
    const result = reviewRun(
      inputs({ evidence: evidence({ commits: [], diffStat: { files: 0, insertions: 0, deletions: 0 }, filesChanged: [] }) }),
    );
    expect(result.verdict).toBe('does_not_satisfy_brief');
    expect(result.anomalies.some((a) => a.includes('reported success but created no commits'))).toBe(true);
    expect(result.prRecommended).toBe(false);
    expect(result.prDeclineReason).toContain('No commits');
  });

  it('refuses a pull request while a high-risk blocker is unresolved', () => {
    const result = reviewRun(inputs({ blockers: [{ description: 'schema change needed', risk: 'high' }] }));
    expect(result.prRecommended).toBe(false);
    expect(result.prDeclineReason).toContain('blocker');
    expect(result.riskLevel).toBe('high');
  });

  it('refuses a pull request while questions remain unanswered', () => {
    const result = reviewRun(inputs({ unansweredQuestions: 2 }));
    expect(result.prRecommended).toBe(false);
    expect(result.prDeclineReason).toContain('question');
  });
});

describe('pull-request eligibility — confidence', () => {
  it('refuses below the autonomy threshold when no limited scope was approved', () => {
    const result = reviewRun(inputs({ confidence: 0.7, scopeKind: 'full' }));
    expect(result.prRecommended).toBe(false);
    expect(result.prDeclineReason).toContain('autonomy threshold');
  });

  it('permits a pull request in the limited band when the narrowed scope was explicitly approved', () => {
    const result = reviewRun(inputs({ confidence: 0.7, scopeKind: 'limited' }));
    expect(result.prRecommended).toBe(true);
  });

  it('refuses when no confidence was recorded at all', () => {
    const result = reviewRun(inputs({ confidence: null }));
    expect(result.prRecommended).toBe(false);
  });
});

describe('pull-request eligibility — git integrity', () => {
  it('refuses outright when a prohibited git operation was attempted', () => {
    const result = reviewRun(inputs({ gitViolations: 1 }));
    expect(result.prRecommended).toBe(false);
    expect(result.prDeclineReason).toContain('prohibited git operation');
  });

  it('refuses and marks the run unreviewable when the default branch moved', () => {
    const result = reviewRun(inputs({ evidence: evidence({ defaultBranchUnchanged: false }) }));
    expect(result.verdict).toBe('unreviewable');
    expect(result.prRecommended).toBe(false);
    expect(result.prDeclineReason).toContain('default branch');
    expect(result.riskLevel).toBe('high');
  });

  it('reports the git-integrity failure ahead of every other reason', () => {
    // A run whose integrity is in doubt must not be declined for a lesser
    // reason — the reviewer needs to see the important one first.
    const result = reviewRun(inputs({ gitViolations: 1, confidence: 0.2, unansweredQuestions: 5 }));
    expect(result.prDeclineReason).toContain('prohibited git operation');
  });
});

describe('matching a "must not change" phrase against a file path', () => {
  it('matches across the separator difference between prose and paths', () => {
    expect(pathMatchesPhrase('src/import/csv-import.ts', 'csv import')).toBe(true);
    expect(pathMatchesPhrase('src/importer/CsvImporter.tsx', 'the CSV importer')).toBe(true);
  });

  it('matches a realistic multi-word phrase that a path cannot contain in full', () => {
    // Requiring every word would make this check exist but never fire — which
    // is worse than not having it, because it looks like protection.
    expect(pathMatchesPhrase('src/import/csv-import.ts', 'existing import format')).toBe(true);
  });

  it('does not match on generic words alone', () => {
    expect(pathMatchesPhrase('src/components/DeviceSelector.tsx', 'the existing format')).toBe(false);
    expect(pathMatchesPhrase('src/app/main.ts', 'the current system')).toBe(false);
  });

  it('does not match an unrelated file', () => {
    expect(pathMatchesPhrase('src/components/DeviceSelector.tsx', 'csv import')).toBe(false);
    expect(pathMatchesPhrase('src/routes/devices.ts', 'the billing schedule')).toBe(false);
  });

  it('ignores an empty or meaningless phrase', () => {
    expect(pathMatchesPhrase('src/a.ts', '')).toBe(false);
    expect(pathMatchesPhrase('src/a.ts', 'the and for')).toBe(false);
  });
});

describe('acceptance-criteria assessment', () => {
  it('finds criteria whose distinctive terms appear in the change', () => {
    const result = assessAcceptanceCriteria(['An operator can select multiple devices and save them.'], evidence());
    expect(result.met).toBe(true);
    expect(result.unmet).toEqual([]);
  });

  it('reports criteria with no visible evidence rather than assuming they are met', () => {
    const result = assessAcceptanceCriteria(
      ['The export endpoint returns a paginated CSV attachment with checksum headers.'],
      evidence(),
    );
    expect(result.met).toBe(false);
    expect(result.unmet).toHaveLength(1);
  });

  it('treats an empty criteria list as not met, so a brief without criteria is visible', () => {
    expect(assessAcceptanceCriteria([], evidence()).met).toBe(false);
  });
});
