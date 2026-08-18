import { describe, expect, it } from 'vitest';
import { classifyTask } from '../../src/domain/task-classification.js';
import { evaluateEligibility, type EligibilityInput } from '../../src/domain/eligibility.js';
import { orderCandidates, type NightCandidate } from '../../src/domain/night-scheduler.js';

/**
 * Direct, non-coding work reaching a verdict at all (Sprint 3.3 §2, §5, §20).
 *
 * Before this sprint the predicate required a board and an item, so a direct
 * research task produced no verdict — not "ineligible", nothing. Which is why
 * it was invisible to the scheduler rather than merely refused by it.
 */

const directResearch = (overrides: Partial<EligibilityInput> = {}): EligibilityInput => ({
  project: {
    nightShiftApproved: true,
    isActive: true,
    capabilities: ['company_context'],
    allowedTaskKinds: ['research', 'investigation'],
  },
  work: { taskKind: 'research', origin: 'direct', title: 'Investigate the registry', priority: 'high' },
  board: null,
  item: null,
  dependencyStatuses: {},
  capability: { workerAvailable: true, reasoningModelAvailable: true, unmetRequirements: [] },
  mac: {
    briefConfidence: 0.88,
    hasApprovedLimitedScope: false,
    // No repository anywhere near this project, and that must not matter.
    repositoryApproved: false,
    hasActiveRun: false,
    attemptedThisShift: false,
    blockedEarlierTonight: false,
  },
  policy: { minExecutionConfidence: 0.6, defaultConfidenceThreshold: 0.8 },
  ...overrides,
});

const codes = (input: EligibilityInput) => evaluateEligibility(input).blockingCodes;

describe('a direct research task with no repository and no board', () => {
  it('is eligible', () => {
    const verdict = evaluateEligibility(directResearch());
    expect(verdict.eligible).toBe(true);
    expect(verdict.blockingCodes).toEqual([]);
  });

  it('is never asked about a repository', () => {
    const verdict = evaluateEligibility(directResearch());
    expect(verdict.checks.map((c) => c.code)).not.toContain('repository_approved');
  });

  it('is never asked about a board or an item', () => {
    const emitted = evaluateEligibility(directResearch()).checks.map((c) => c.code);
    // Skipped, not passed. A verdict claiming "board approved: yes" for a task
    // with no board would be a verdict nobody could trust.
    for (const code of ['board_approved', 'board_night_eligible', 'item_flagged', 'status_startable']) {
      expect(emitted, code).not.toContain(code);
    }
  });

  it('still passes through every authority gate that does apply', () => {
    const emitted = evaluateEligibility(directResearch()).checks.map((c) => c.code);
    expect(emitted).toContain('project_approved');
    expect(emitted).toContain('brief_exists');
    expect(emitted).toContain('confidence_above_floor');
    expect(emitted).toContain('confidence_permits_autonomy');
    expect(emitted).toContain('no_active_run');
  });
});

describe('the gates research does not get to skip', () => {
  it('refuses an unapproved project', () => {
    const input = directResearch();
    input.project.nightShiftApproved = false;
    expect(codes(input)).toContain('project_approved');
  });

  it('refuses a task with no handoff brief', () => {
    const input = directResearch();
    input.mac.briefConfidence = null;
    expect(codes(input)).toContain('brief_exists');
  });

  it('refuses the 60-79% band overnight, exactly as it does for coding', () => {
    // Sprint 3.3 §19: research can still spend money and produce consequential
    // recommendations, so the confidence model is not softened for it.
    const input = directResearch();
    input.mac.briefConfidence = 0.7;
    expect(codes(input)).toContain('confidence_permits_autonomy');
  });

  it('refuses a project that has not been approved for this kind of work', () => {
    const input = directResearch();
    input.project.allowedTaskKinds = ['coding'];
    expect(codes(input)).toContain('task_kind_permitted');
  });

  it('refuses when no reasoning provider is configured', () => {
    const input = directResearch();
    input.capability!.reasoningModelAvailable = false;
    expect(codes(input)).toContain('reasoning_model_available');
  });

  it('refuses when no online worker advertises the capability', () => {
    // Sprint 3.3 §22: a run must not disappear into `queued` with nothing able
    // to execute it.
    const input = directResearch();
    input.capability!.workerAvailable = false;
    expect(codes(input)).toContain('worker_capability_available');
  });
});

describe('an unconfigured project grants the status quo and nothing more', () => {
  it('still permits coding, so nothing that worked before this sprint stops', () => {
    const input = directResearch({
      project: { nightShiftApproved: true, isActive: true, allowedTaskKinds: [] },
      work: { taskKind: 'coding', origin: 'direct', title: 'Fix the thing', priority: 'normal' },
    });
    input.mac.repositoryApproved = true;
    expect(codes(input)).not.toContain('task_kind_permitted');
  });

  it('does NOT permit research, which needs somebody to say so', () => {
    // Sprint 3.3 §21: PAC Internal Development must not become able to run
    // autonomous work as a side effect of a migration.
    const input = directResearch({
      project: { nightShiftApproved: true, isActive: true, allowedTaskKinds: [] },
    });
    expect(codes(input)).toContain('task_kind_permitted');
  });
});

describe('ordering across the two queues', () => {
  const candidate = (over: Partial<NightCandidate> & { rank: number }): NightCandidate => ({
    taskId: over.taskId ?? `task-${over.title}`,
    mondayItemId: over.mondayItemId ?? null,
    title: over.title ?? 'x',
    projectId: over.projectId ?? 'p1',
    projectName: 'Project',
    eligibility: { eligible: true, checks: [], blockingCodes: [], priorityRank: over.rank, summary: '' },
    effort: { sizeClass: 'small', minutes: 20, basis: '', partialUseful: true, preservable: true },
    ...(over.source ? { source: over.source } : {}),
  });

  it('lets commercial priority beat the source of a task', () => {
    const ordered = orderCandidates(
      [
        candidate({ title: 'direct-normal', source: 'direct', rank: 2 }),
        candidate({ title: 'monday-urgent', source: 'monday', mondayItemId: 'm1', rank: 0 }),
      ],
      null,
    );
    // A human's judgement about importance is not overridden by where the work
    // happens to be tracked.
    expect(ordered[0]!.title).toBe('monday-urgent');
  });

  it('breaks an exact tie in favour of direct work', () => {
    const ordered = orderCandidates(
      [
        candidate({ title: 'monday-high', source: 'monday', mondayItemId: 'm1', rank: 1 }),
        candidate({ title: 'direct-high', source: 'direct', rank: 1 }),
      ],
      null,
    );
    // Spec §8 ranks direct instructions highest; a direct task is one a human
    // handed Mac personally rather than one he found on a board.
    expect(ordered[0]!.title).toBe('direct-high');
  });

  it('is deterministic, so two ticks on the same data choose the same task', () => {
    const input = [
      candidate({ title: 'b', source: 'direct', rank: 1 }),
      candidate({ title: 'a', source: 'direct', rank: 1 }),
    ];
    expect(orderCandidates(input, null).map((c) => c.title)).toEqual(
      orderCandidates([...input].reverse(), null).map((c) => c.title),
    );
  });
});

describe('classifying a task from what somebody wrote', () => {
  it('recognises the real acceptance task as an investigation', () => {
    const result = classifyTask({ title: 'Investigate PAC Project Registry, Document Controller & Sales Engineer' });
    expect(result.kind).toBe('investigation');
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('recognises ordinary coding work', () => {
    expect(classifyTask({ title: 'Fix the CSV import endpoint' }).kind).toBe('coding');
    expect(classifyTask({ title: 'Refactor the device selection component' }).kind).toBe('coding');
  });

  it('recognises scoping and documentation', () => {
    expect(classifyTask({ title: 'Scope the new commissioning workflow' }).kind).toBe('scoping');
    expect(classifyTask({ title: 'Document the PLC tag naming convention' }).kind).toBe('documentation');
  });

  it('says plainly that it cannot tell, rather than guessing confidently', () => {
    const result = classifyTask({ title: 'Widgets' });
    expect(result.confidence).toBeLessThan(0.6);
    expect(result.signals).toEqual([]);
    // Falls back to the schema default so "classifier not run" and "classifier
    // ran and was unsure" leave a task in the same state.
    expect(result.kind).toBe('coding');
  });

  it('weights the title above the description, because that is where the verb is', () => {
    const result = classifyTask({
      title: 'Investigate the import failures',
      description: 'It might need an api change and a new schema component.',
    });
    expect(result.kind).toBe('investigation');
  });

  it('reports lower confidence when two readings are close', () => {
    const clear = classifyTask({ title: 'Investigate the outage' });
    const muddy = classifyTask({ title: 'Investigate and scope the outage' });
    expect(muddy.confidence).toBeLessThan(clear.confidence);
  });
});
