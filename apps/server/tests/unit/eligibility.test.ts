import { describe, expect, it } from 'vitest';
import { evaluateEligibility, type EligibilityInput } from '../../src/domain/eligibility.js';

/**
 * Sprint 3.3 made `board` and `item` nullable so that direct work can have a
 * verdict at all. Every case below describes MONDAY-BACKED work, where both are
 * always present — so the fixture narrows them once here rather than each test
 * asserting non-null. No assertion in this file changed.
 */
type MondayEligibilityInput = EligibilityInput & {
  board: NonNullable<EligibilityInput['board']>;
  item: NonNullable<EligibilityInput['item']>;
};

/**
 * The eligibility predicate (Sprint 3 §7).
 *
 * Every one of these is a rule a human would otherwise have to trust Mac to
 * remember at 02:00. They are cheap, exhaustive, and involve no I/O — which is
 * the whole argument for the predicate being code rather than a prompt.
 */

const base = (): MondayEligibilityInput => ({
  project: { nightShiftApproved: true, isActive: true },
  board: {
    isApproved: true,
    nightShiftEligible: true,
    requireItemFlag: true,
    startableStatuses: ['Ready for Mac', 'Backlog'],
    completedStatuses: ['Done'],
    allowedItemTypes: [],
    macUserId: 'mac-1',
  },
  item: {
    id: '8891',
    name: 'Multi-device selection',
    status: 'Ready for Mac',
    priority: 'High',
    assigneeIds: [],
    nightShiftFlag: true,
    dependsOn: [],
    itemType: 'Feature',
    dueDate: null,
  },
  dependencyStatuses: {},
  mac: {
    briefConfidence: 0.88,
    hasApprovedLimitedScope: false,
    repositoryApproved: true,
    hasActiveRun: false,
    attemptedThisShift: false,
    blockedEarlierTonight: false,
  },
  policy: { minExecutionConfidence: 0.6, defaultConfidenceThreshold: 0.8 },
});

const failing = (input: EligibilityInput) => evaluateEligibility(input).blockingCodes;

describe('a well-formed, approved, flagged item', () => {
  it('is eligible', () => {
    const verdict = evaluateEligibility(base());
    expect(verdict.eligible).toBe(true);
    expect(verdict.blockingCodes).toEqual([]);
  });

  it('reports EVERY check, not only the failures', () => {
    const verdict = evaluateEligibility(base());
    // The Night Queue has to answer "why is this eligible?" as readily as
    // "why was this skipped?", and a failures-only verdict cannot.
    expect(verdict.checks.length).toBeGreaterThanOrEqual(13);
    expect(verdict.checks.every((c) => c.ok)).toBe(true);
    expect(verdict.checks.every((c) => c.detail.length > 0)).toBe(true);
  });
});

describe('the two approval gates', () => {
  it('rejects an unapproved project', () => {
    const input = base();
    input.project.nightShiftApproved = false;
    expect(failing(input)).toContain('project_approved');
  });

  it('rejects an inactive project even when it was approved', () => {
    const input = base();
    input.project.isActive = false;
    expect(failing(input)).toContain('project_approved');
  });

  it('rejects an unapproved board', () => {
    const input = base();
    input.board.isApproved = false;
    expect(failing(input)).toContain('board_approved');
  });

  it('rejects a board approved for reading but not marked night-eligible', () => {
    const input = base();
    input.board.nightShiftEligible = false;
    expect(failing(input)).toContain('board_night_eligible');
  });
});

describe('the item itself', () => {
  it('rejects an item that was never flagged for Mac', () => {
    const input = base();
    input.item.nightShiftFlag = false;
    expect(failing(input)).toContain('item_flagged');
  });

  it('accepts an unflagged item on a board that does not require the flag', () => {
    const input = base();
    input.item.nightShiftFlag = false;
    input.board.requireItemFlag = false;
    expect(evaluateEligibility(input).eligible).toBe(true);
  });

  it('rejects a status Mac may not start from', () => {
    const input = base();
    input.item.status = 'Awaiting Testing';
    expect(failing(input)).toContain('status_startable');
  });

  it('matches statuses case- and whitespace-insensitively, because humans type them', () => {
    const input = base();
    input.item.status = '  ready for mac ';
    expect(evaluateEligibility(input).eligible).toBe(true);
  });

  it("rejects work assigned to somebody else", () => {
    const input = base();
    input.item.assigneeIds = ['person-7'];
    expect(failing(input)).toContain('not_assigned_elsewhere');
  });

  it('accepts work already assigned to Mac', () => {
    const input = base();
    input.item.assigneeIds = ['mac-1'];
    expect(evaluateEligibility(input).eligible).toBe(true);
  });

  it('rejects an item type outside the allowlist, and ignores the rule when none is configured', () => {
    const restricted = base();
    restricted.board.allowedItemTypes = ['Bug', 'Chore'];
    expect(failing(restricted)).toContain('task_type_allowed');

    const unrestricted = base();
    unrestricted.board.allowedItemTypes = [];
    unrestricted.item.itemType = 'Anything At All';
    expect(evaluateEligibility(unrestricted).eligible).toBe(true);
  });
});

describe('dependencies', () => {
  it('rejects an item whose dependency is unfinished', () => {
    const input = base();
    input.item.dependsOn = ['8890'];
    input.dependencyStatuses = { '8890': 'Working on it' };
    expect(failing(input)).toContain('dependencies_clear');
  });

  it('accepts an item whose dependencies are all complete', () => {
    const input = base();
    input.item.dependsOn = ['8890', '8889'];
    input.dependencyStatuses = { '8890': 'Done', '8889': 'done' };
    expect(evaluateEligibility(input).eligible).toBe(true);
  });

  it('treats a dependency Mac cannot see as unfinished', () => {
    const input = base();
    input.item.dependsOn = ['unknown-item'];
    input.dependencyStatuses = {};
    // A dependency he cannot see is not one he may assume is done.
    expect(failing(input)).toContain('dependencies_clear');
  });
});

describe('confidence', () => {
  it('rejects a task with no handoff brief', () => {
    const input = base();
    input.mac.briefConfidence = null;
    const codes = failing(input);
    expect(codes).toContain('brief_exists');
    expect(codes).toContain('confidence_above_floor');
  });

  it('rejects confidence below the non-overridable floor', () => {
    const input = base();
    input.mac.briefConfidence = 0.59;
    expect(failing(input)).toContain('confidence_above_floor');
  });

  it('rejects the 60-79% band overnight, because nobody is awake to approve a scope', () => {
    const input = base();
    input.mac.briefConfidence = 0.75;
    const codes = failing(input);
    expect(codes).not.toContain('confidence_above_floor');
    expect(codes).toContain('confidence_permits_autonomy');
  });

  it('accepts the 60-79% band when a human pre-approved a limited scope for this task', () => {
    const input = base();
    input.mac.briefConfidence = 0.75;
    input.mac.hasApprovedLimitedScope = true;
    expect(evaluateEligibility(input).eligible).toBe(true);
  });

  it('accepts exactly the autonomy threshold', () => {
    const input = base();
    input.mac.briefConfidence = 0.8;
    expect(evaluateEligibility(input).eligible).toBe(true);
  });

  it('does not let a float artefact push a value across the threshold', () => {
    const input = base();
    input.mac.briefConfidence = 0.1 + 0.7; // 0.7999999999999999
    expect(evaluateEligibility(input).eligible).toBe(true);
  });
});

describe("Mac's own state", () => {
  it('rejects a project with no approved repository', () => {
    const input = base();
    input.mac.repositoryApproved = false;
    expect(failing(input)).toContain('repository_approved');
  });

  it('rejects a task that already has a run in flight', () => {
    const input = base();
    input.mac.hasActiveRun = true;
    expect(failing(input)).toContain('no_active_run');
  });

  it('rejects a task Mac already worked on tonight, even though nothing is in flight', () => {
    const input = base();
    input.mac.attemptedThisShift = true;
    /*
     * The dangerous case. A completed run leaves nothing in flight, and if the
     * monday.com write has not landed — a failed write, a board that is down —
     * the item is still sitting in a startable status. Without this check Mac
     * would do the same work twice and open two pull requests for it.
     */
    expect(failing(input)).toContain('no_active_run');
  });

  it('rejects a task that blocked earlier tonight', () => {
    const input = base();
    input.mac.blockedEarlierTonight = true;
    // Retrying it would just block again, and the night is finite.
    expect(failing(input)).toContain('not_previously_blocked');
  });
});

describe('ordering', () => {
  const rankOf = (overrides: Partial<EligibilityInput['item']>, boardOrder = 0) => {
    const input = base();
    Object.assign(input.item, overrides);
    input.boardOrder = boardOrder;
    return evaluateEligibility(input).priorityRank;
  };

  it('ranks higher monday priority first', () => {
    expect(rankOf({ priority: 'Critical' })).toBeLessThan(rankOf({ priority: 'High' }));
    expect(rankOf({ priority: 'High' })).toBeLessThan(rankOf({ priority: 'Medium' }));
    expect(rankOf({ priority: 'Medium' })).toBeLessThan(rankOf({ priority: 'Low' }));
  });

  it('sorts an unrecognised priority after everything recognised', () => {
    expect(rankOf({ priority: 'Whenever' })).toBeGreaterThan(rankOf({ priority: 'Low' }));
  });

  it('prefers the sooner due date within a priority band', () => {
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const later = new Date(Date.now() + 25 * 86_400_000).toISOString();
    expect(rankOf({ priority: 'High', dueDate: soon })).toBeLessThan(rankOf({ priority: 'High', dueDate: later }));
  });

  it('never lets a due date outrank commercial priority', () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const nextMonth = new Date(Date.now() + 30 * 86_400_000).toISOString();
    // An urgent item due next month still beats a low-priority one due
    // tomorrow: priority is a human's judgement about importance, and a date
    // must not silently override it.
    expect(rankOf({ priority: 'Urgent', dueDate: nextMonth })).toBeLessThan(
      rankOf({ priority: 'Low', dueDate: tomorrow }),
    );
  });

  it('breaks remaining ties by board order, deterministically', () => {
    expect(rankOf({ priority: 'High' }, 1)).toBeLessThan(rankOf({ priority: 'High' }, 5));
  });
});
