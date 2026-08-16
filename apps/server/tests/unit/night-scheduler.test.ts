import { describe, expect, it } from 'vitest';
import { emptyBriefContent, type EligibilityVerdict } from '@mac/protocol';
import { estimateEffort, safeToStart } from '../../src/domain/effort.js';
import {
  classifyBudget,
  decideNextAction,
  orderCandidates,
  type NightCandidate,
  type NightState,
  type UsageState,
} from '../../src/domain/night-scheduler.js';

/**
 * Effort estimation and night scheduling (Sprint 3 §8).
 *
 * Both are pure, which is the point: "should Mac start a large task at 07:40?"
 * is a question with a defensible answer, and answering it in code means the
 * answer can be argued with rather than merely observed the next morning.
 */

const NOW = new Date('2026-08-17T18:00:00.000Z');
const POLICY = { safetyFactor: 1.5, wrapUpMinutes: 10, minStartMinutes: 20, largeTaskMinMinutes: 90 };

const verdict = (overrides: Partial<EligibilityVerdict> = {}): EligibilityVerdict => ({
  eligible: true,
  checks: [],
  blockingCodes: [],
  priorityRank: 1,
  summary: 'Eligible',
  ...overrides,
});

const candidate = (overrides: Partial<NightCandidate> = {}): NightCandidate => ({
  taskId: 't1',
  mondayItemId: 'i1',
  title: 'A task',
  projectId: 'p1',
  projectName: 'Project One',
  eligibility: verdict(),
  effort: { sizeClass: 'small', minutes: 20, basis: 'test', partialUseful: true, preservable: true },
  ...overrides,
});

const noUsage: UsageState = {
  source: 'unavailable',
  recordedSpendCents: null,
  nightlyBudgetCents: 5000,
  budgetStopPct: 100,
  observedPct: null,
  softThresholdPct: 80,
  softStopsExecution: false,
};

const state = (overrides: Partial<NightState> = {}): NightState => ({
  now: NOW,
  cutoffAt: new Date(NOW.getTime() + 6 * 3_600_000),
  current: null,
  lastProjectId: null,
  candidates: [],
  usage: noUsage,
  workerAvailable: true,
  guardrailStopped: false,
  policy: POLICY,
  stopRequested: false,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Effort
// ---------------------------------------------------------------------------

describe('effort estimation', () => {
  const brief = (overrides: Partial<ReturnType<typeof emptyBriefContent>> = {}) => ({
    ...emptyBriefContent('A change'),
    ...overrides,
  });

  it('treats a short, well-specified brief as small', () => {
    const estimate = estimateEffort({
      brief: brief({ acceptanceCriteria: ['One thing works.'], likelyAffectedComponents: ['Button'] }),
      sizeLabel: null,
      scopeKind: 'full',
    });
    expect(estimate.sizeClass).toBe('small');
  });

  it('treats a broad brief across many components as large', () => {
    const estimate = estimateEffort({
      brief: brief({
        acceptanceCriteria: ['a', 'b', 'c', 'd', 'e'],
        likelyAffectedComponents: ['api', 'ui', 'db', 'worker'],
      }),
      sizeLabel: null,
      scopeKind: 'full',
    });
    expect(estimate.sizeClass).toBe('large');
  });

  it("prefers a human's own size label over anything derived", () => {
    const estimate = estimateEffort({
      brief: brief({ acceptanceCriteria: ['one'] }),
      sizeLabel: 'XL',
      scopeKind: 'full',
    });
    // Somebody who knows the codebase writing "XL" is better evidence than
    // counting acceptance criteria.
    expect(estimate.sizeClass).toBe('large');
    expect(estimate.basis).toContain('board size label');
  });

  it('assumes large when there is no brief at all', () => {
    const estimate = estimateEffort({ brief: null, sizeLabel: null, scopeKind: 'full' });
    // Guessing small on no information is how a night gets cut off half-way
    // through something that mattered.
    expect(estimate.sizeClass).toBe('large');
    expect(estimate.basis).toContain('assumed large');
  });

  it('shrinks the estimate when a human narrowed the scope', () => {
    const wide = estimateEffort({
      brief: brief({ acceptanceCriteria: ['a', 'b', 'c'], likelyAffectedComponents: ['x', 'y'] }),
      sizeLabel: null,
      scopeKind: 'full',
    });
    const narrow = estimateEffort({
      brief: brief({ acceptanceCriteria: ['a', 'b', 'c'], likelyAffectedComponents: ['x', 'y'] }),
      sizeLabel: null,
      scopeKind: 'limited',
    });
    expect(narrow.minutes).toBeLessThanOrEqual(wide.minutes);
  });

  it('always states its basis and calls itself a size class, not a duration', () => {
    const estimate = estimateEffort({ brief: brief(), sizeLabel: null, scopeKind: 'full' });
    expect(estimate.basis).toContain('not a duration prediction');
  });
});

// ---------------------------------------------------------------------------
// Safe start
// ---------------------------------------------------------------------------

describe('the safe-start check', () => {
  const small = { sizeClass: 'small' as const, minutes: 20, basis: '', partialUseful: true, preservable: true };
  const large = { sizeClass: 'large' as const, minutes: 150, basis: '', partialUseful: false, preservable: true };

  it('allows a small task with hours to spare', () => {
    const cutoff = new Date(NOW.getTime() + 4 * 3_600_000);
    expect(safeToStart(NOW, cutoff, small, POLICY).safe).toBe(true);
  });

  it('refuses anything at all inside the final floor', () => {
    const cutoff = new Date(NOW.getTime() + 15 * 60_000);
    const result = safeToStart(NOW, cutoff, small, POLICY);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('minute floor');
  });

  it('refuses a large task near the cutoff while allowing a small one', () => {
    const cutoff = new Date(NOW.getTime() + 45 * 60_000);
    expect(safeToStart(NOW, cutoff, large, POLICY).safe).toBe(false);
    expect(safeToStart(NOW, cutoff, small, POLICY).safe).toBe(true);
  });

  it('allows a slightly-too-long task whose partial result is useful and preservable', () => {
    const cutoff = new Date(NOW.getTime() + 50 * 60_000);
    const medium = { sizeClass: 'medium' as const, minutes: 60, basis: '', partialUseful: true, preservable: true };
    const result = safeToStart(NOW, cutoff, medium, POLICY);
    expect(result.safe).toBe(true);
    expect(result.reason).toContain('partial result is useful');
  });

  it('refuses a task that cannot be left safely mid-flight', () => {
    const cutoff = new Date(NOW.getTime() + 50 * 60_000);
    const migration = { sizeClass: 'medium' as const, minutes: 60, basis: '', partialUseful: true, preservable: false };
    expect(safeToStart(NOW, cutoff, migration, POLICY).safe).toBe(false);
  });

  it('refuses everything once the cutoff has passed', () => {
    const cutoff = new Date(NOW.getTime() - 60_000);
    expect(safeToStart(NOW, cutoff, small, POLICY).safe).toBe(false);
  });

  it('reserves time for the work that happens after the agent stops', () => {
    // Committing, testing, reviewing, pushing and opening a PR all happen after
    // the session ends. A task that consumes the whole runway leaves an
    // unreviewed branch rather than a reviewable one.
    const cutoff = new Date(NOW.getTime() + 40 * 60_000);
    const result = safeToStart(NOW, cutoff, small, POLICY);
    expect(result.requiredMinutes).toBe(Math.ceil(20 * 1.5 + 10));
  });
});

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

describe('the night scheduler', () => {
  it('leaves a productive run alone', () => {
    const decision = decideNextAction(
      state({
        current: { runId: 'r1', taskId: 't1', projectId: 'p1', status: 'running', productive: true },
        candidates: [candidate()],
      }),
    );
    expect(decision.action).toBe('continue');
  });

  it('finalises a run that has finished, even past the cutoff', () => {
    const decision = decideNextAction(
      state({
        now: NOW,
        cutoffAt: new Date(NOW.getTime() - 60_000),
        current: { runId: 'r1', taskId: 't1', projectId: 'p1', status: 'completed', productive: false },
      }),
    );
    // Ordered before the stop conditions on purpose: otherwise a night ends
    // with a finished task nobody reported.
    expect(decision.action).toBe('finalise');
    expect(decision.action === 'finalise' && decision.runId).toBe('r1');
  });

  it('records a blocker rather than stopping the shift', () => {
    const decision = decideNextAction(
      state({ current: { runId: 'r1', taskId: 't1', projectId: 'p1', status: 'blocked', productive: false } }),
    );
    expect(decision.action).toBe('record_blocker');
    expect(decision.rationale.reason).toContain('independent work');
  });

  it('starts the next eligible task once the current one is done', () => {
    const decision = decideNextAction(state({ candidates: [candidate({ title: 'Next up' })] }));
    expect(decision.action).toBe('start');
    expect(decision.action === 'start' && decision.candidate.title).toBe('Next up');
  });

  it('prefers the current project over a higher-priority task elsewhere', () => {
    const decision = decideNextAction(
      state({
        lastProjectId: 'p1',
        candidates: [
          candidate({
            title: 'Urgent elsewhere',
            projectId: 'p2',
            projectName: 'Other',
            mondayItemId: 'i2',
            eligibility: verdict({ priorityRank: 0 }),
          }),
          candidate({ title: 'Normal here', projectId: 'p1', mondayItemId: 'i1', eligibility: verdict({ priorityRank: 2 }) }),
        ],
      }),
    );
    // The repository is fetched, the tooling is warm, and the project memory is
    // the one Mac has been reasoning with. Switching costs real context.
    expect(decision.action === 'start' && decision.candidate.title).toBe('Normal here');
  });

  it('switches projects once the current one is exhausted', () => {
    const decision = decideNextAction(
      state({
        lastProjectId: 'p1',
        candidates: [candidate({ title: 'Elsewhere', projectId: 'p2', projectName: 'Other', mondayItemId: 'i2' })],
      }),
    );
    expect(decision.action === 'start' && decision.candidate.projectId).toBe('p2');
  });

  it('orders by priority within a project', () => {
    const decision = decideNextAction(
      state({
        lastProjectId: 'p1',
        candidates: [
          candidate({ title: 'Low', mondayItemId: 'i2', eligibility: verdict({ priorityRank: 3 }) }),
          candidate({ title: 'High', mondayItemId: 'i1', eligibility: verdict({ priorityRank: 1 }) }),
        ],
      }),
    );
    expect(decision.action === 'start' && decision.candidate.title).toBe('High');
  });

  it('never starts an ineligible task, and records why it was skipped', () => {
    const decision = decideNextAction(
      state({
        candidates: [
          candidate({
            title: 'Not approved',
            eligibility: verdict({
              eligible: false,
              blockingCodes: ['project_approved'],
              summary: 'Not eligible — Project approved for night shift',
            }),
          }),
        ],
      }),
    );
    expect(decision.action).toBe('idle');
    expect(decision.rationale.skipped[0]!.reason).toBe('not_eligible');
  });

  it('distinguishes "you may not" from "not now"', () => {
    const decision = decideNextAction(
      state({
        cutoffAt: new Date(NOW.getTime() + 30 * 60_000),
        candidates: [
          candidate({
            title: 'Big thing',
            effort: { sizeClass: 'large', minutes: 150, basis: '', partialUseful: false, preservable: true },
          }),
        ],
      }),
    );
    expect(decision.action).toBe('idle');
    // Conflating these would make the queue screen lie to whoever reads it.
    expect(decision.rationale.skipped[0]!.reason).toBe('insufficient_time');
  });

  it('idles cleanly when there is nothing eligible, rather than inventing work', () => {
    const decision = decideNextAction(state({ candidates: [] }));
    expect(decision.action).toBe('idle');
    expect(decision.rationale.reason).toContain('No candidate work');
  });

  it('stops at the cutoff', () => {
    const decision = decideNextAction(
      state({ cutoffAt: new Date(NOW.getTime() - 1), candidates: [candidate()] }),
    );
    expect(decision.action).toBe('stop');
    expect(decision.action === 'stop' && decision.stopReason).toBe('cutoff_reached');
  });

  it('stops when an operator ends the shift', () => {
    const decision = decideNextAction(state({ stopRequested: true, candidates: [candidate()] }));
    expect(decision.action === 'stop' && decision.stopReason).toBe('stopped_by_user');
  });

  it('idles rather than stopping when no worker is available', () => {
    const decision = decideNextAction(state({ workerAvailable: false, candidates: [candidate()] }));
    // A worker that comes back should find the shift still running.
    expect(decision.action).toBe('idle');
  });

  it('records the rationale on every decision, including the refusals', () => {
    for (const decision of [
      decideNextAction(state({ candidates: [candidate()] })),
      decideNextAction(state({ candidates: [] })),
      decideNextAction(state({ cutoffAt: new Date(NOW.getTime() - 1) })),
    ]) {
      expect(decision.rationale.reason.length).toBeGreaterThan(0);
      expect(decision.rationale.usageSourceAtDecision).toBe('unavailable');
      expect(typeof decision.rationale.remainingMinutes).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

describe('budget classification', () => {
  it('stops on exact money that has reached the limit', () => {
    const result = classifyBudget({
      ...noUsage,
      source: 'exact',
      recordedSpendCents: 5000,
      nightlyBudgetCents: 5000,
    });
    expect(result.stop).toBe(true);
    expect(result.basis).toBe('exact_hard_budget');
  });

  it('does not stop on exact money below the limit', () => {
    expect(
      classifyBudget({ ...noUsage, source: 'exact', recordedSpendCents: 100, nightlyBudgetCents: 5000 }).stop,
    ).toBe(false);
  });

  it('warns but does not stop on a soft signal by default', () => {
    const result = classifyBudget({ ...noUsage, source: 'observed', observedPct: 92 });
    expect(result.stop).toBe(false);
    expect(result.basis).toBe('soft_threshold');
    // The wording is the point: a soft threshold must never read as a dollar cap.
    expect(result.reason).toContain('not an enforceable limit');
  });

  it('stops on a soft signal when an administrator configured it to', () => {
    const result = classifyBudget({ ...noUsage, source: 'observed', observedPct: 92, softStopsExecution: true });
    expect(result.stop).toBe(true);
    expect(result.basis).toBe('soft_threshold');
  });

  it('applies no budget rule at all when nothing is known', () => {
    const result = classifyBudget(noUsage);
    expect(result.stop).toBe(false);
    expect(result.basis).toBe('no_budget_data');
  });

  it('is reflected in the scheduling decision, with its basis named', () => {
    const stopped = decideNextAction(
      state({
        usage: { ...noUsage, source: 'exact', recordedSpendCents: 6000, nightlyBudgetCents: 5000 },
        candidates: [candidate()],
      }),
    );
    expect(stopped.action === 'stop' && stopped.stopReason).toBe('budget_exhausted');
    expect(stopped.rationale.budgetBasis).toBe('exact_hard_budget');

    const soft = decideNextAction(
      state({
        usage: { ...noUsage, source: 'observed', observedPct: 95, softStopsExecution: true },
        candidates: [candidate()],
      }),
    );
    expect(soft.action === 'stop' && soft.stopReason).toBe('usage_threshold');
    expect(soft.rationale.budgetBasis).toBe('soft_threshold');
  });
});

describe('candidate ordering is deterministic', () => {
  it('produces the same order twice on the same data', () => {
    const list = [
      candidate({ title: 'B', mondayItemId: 'i2', eligibility: verdict({ priorityRank: 1 }) }),
      candidate({ title: 'A', mondayItemId: 'i1', eligibility: verdict({ priorityRank: 1 }) }),
    ];
    // Two runs of the scheduler on the same data must pick the same task, or
    // the recorded decision means nothing.
    expect(orderCandidates(list, null).map((c) => c.title)).toEqual(orderCandidates(list, null).map((c) => c.title));
    expect(orderCandidates(list, null)[0]!.mondayItemId).toBe('i1');
  });
});
