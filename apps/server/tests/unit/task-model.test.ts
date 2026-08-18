import { describe, expect, it } from 'vitest';
import {
  COMPLETENESS_DIMENSIONS,
  TASK_KINDS,
  applicableDimensions,
  capabilityForTaskKind,
  deriveExecutionRequirements,
  describeTaskKind,
  resolveJobKind,
  taskKindRequiresReasoningModel,
  taskKindRequiresRepository,
  taskRequiresMondayItem,
} from '@mac/protocol';
import { evaluateTaskRequirements, primaryBlocker } from '../../src/domain/task-requirements.js';

/**
 * The task model (Sprint 3.3 §1, §2).
 *
 * These are the assertions that would have caught the drift in the first place:
 * "does research need a repository" and "does a direct task need a monday item"
 * are questions the system had no way to answer before this sprint, because the
 * only answer available was whatever `claude_code` happened to require.
 */

const facts = (overrides: Partial<Parameters<typeof evaluateTaskRequirements>[0]['facts']> = {}) => ({
  hasApprovedRepository: true,
  hasApprovedBoard: true,
  hasMondayItem: true,
  hasBrief: true,
  hasReasoningModel: true,
  hasCompanyContext: true,
  codingAgentEnabled: true,
  projectCapabilities: [],
  allowedTaskKinds: [],
  ...overrides,
});

describe('task kind is not job kind', () => {
  it('maps coding to the coding agent and everything else to the general worker', () => {
    expect(resolveJobKind('coding')).toBe('claude_code');
    for (const kind of TASK_KINDS.filter((k) => k !== 'coding')) {
      expect(resolveJobKind(kind), kind).toBe('general_task');
    }
  });

  it('gives every task kind a capability, a label and a description', () => {
    for (const kind of TASK_KINDS) {
      const d = describeTaskKind(kind);
      expect(d.label.length, kind).toBeGreaterThan(0);
      expect(d.description.length, kind).toBeGreaterThan(10);
      expect(['coding', 'general']).toContain(d.capability);
    }
  });

  it('needs only two worker capabilities for seven kinds of work', () => {
    // The difference between research and scoping is what Mac is asked to
    // produce, not what the machine must be able to do.
    const capabilities = new Set(TASK_KINDS.map(capabilityForTaskKind));
    expect(capabilities).toEqual(new Set(['coding', 'general']));
  });
});

describe('a Git repository is required only by work that touches code', () => {
  it('requires one for coding', () => {
    expect(taskKindRequiresRepository('coding')).toBe(true);
  });

  it('requires one for NOTHING else', () => {
    for (const kind of TASK_KINDS.filter((k) => k !== 'coding')) {
      expect(taskKindRequiresRepository(kind), kind).toBe(false);
    }
  });

  it('leaves research executable in a project that has no repository at all', () => {
    const verdict = evaluateTaskRequirements({
      taskKind: 'research',
      origin: 'direct',
      facts: facts({ hasApprovedRepository: false, hasApprovedBoard: false, hasMondayItem: false }),
    });
    expect(verdict.ready).toBe(true);
    expect(verdict.unmet).toEqual([]);
    expect(verdict.checks.map((c) => c.requirement)).not.toContain('repository');
  });

  it('refuses coding in a project that has no repository, and says so', () => {
    const verdict = evaluateTaskRequirements({
      taskKind: 'coding',
      origin: 'direct',
      facts: facts({ hasApprovedRepository: false }),
    });
    expect(verdict.ready).toBe(false);
    expect(verdict.unmet).toContain('repository');
    expect(verdict.summary).toMatch(/no approved repository/i);
  });
});

describe('a monday.com item is required only by monday-backed work', () => {
  it('is never required of a direct task', () => {
    expect(taskRequiresMondayItem('direct')).toBe(false);
    for (const kind of TASK_KINDS) {
      const requirements = deriveExecutionRequirements({ taskKind: kind, origin: 'direct' });
      expect(requirements, kind).not.toContain('monday_item');
    }
  });

  it('is required of monday-backed work, whatever its kind', () => {
    for (const kind of TASK_KINDS) {
      const requirements = deriveExecutionRequirements({ taskKind: kind, origin: 'monday' });
      expect(requirements, kind).toContain('monday_item');
    }
  });

  it('reports a monday task that lost its item as unmet rather than pretending', () => {
    const verdict = evaluateTaskRequirements({
      taskKind: 'research',
      origin: 'monday',
      facts: facts({ hasMondayItem: false }),
    });
    expect(verdict.unmet).toContain('monday_item');
  });
});

describe('a reasoning model is required only by work that reasons', () => {
  it('is not required for coding, which delegates to a coding agent', () => {
    expect(taskKindRequiresReasoningModel('coding')).toBe(false);
  });

  it('is required for every general kind', () => {
    for (const kind of TASK_KINDS.filter((k) => k !== 'coding')) {
      expect(taskKindRequiresReasoningModel(kind), kind).toBe(true);
    }
  });

  it('refuses research with no provider, and names the failure mode', () => {
    const verdict = evaluateTaskRequirements({
      taskKind: 'research',
      origin: 'direct',
      facts: facts({ hasReasoningModel: false }),
    });
    expect(verdict.ready).toBe(false);
    expect(verdict.unmet).toContain('reasoning_model');
    // The reason matters: an empty result would READ like a finished
    // investigation, which is why this refuses rather than degrading.
    expect(verdict.checks.find((c) => c.requirement === 'reasoning_model')!.detail).toMatch(
      /MODEL_PROVIDER_REQUIRED/,
    );
  });
});

describe('project capabilities may add a requirement, never remove one', () => {
  it('lets a research task read a repository the project happens to have', () => {
    const requirements = deriveExecutionRequirements({
      taskKind: 'research',
      origin: 'direct',
      projectCapabilities: ['repository'],
    });
    expect(requirements).toContain('repository');
  });

  it('does not excuse coding from needing a repository when the project has none', () => {
    // A missing integration must never become permission to skip a check.
    const requirements = deriveExecutionRequirements({
      taskKind: 'coding',
      origin: 'direct',
      projectCapabilities: [],
    });
    expect(requirements).toContain('repository');
  });

  it('produces a stable order, so two derivations of one task compare equal', () => {
    const a = deriveExecutionRequirements({ taskKind: 'scoping', origin: 'monday' });
    const b = deriveExecutionRequirements({ taskKind: 'scoping', origin: 'monday' });
    expect(a).toEqual(b);
  });
});

describe('completeness dimensions follow the kind of work', () => {
  it('keeps all ten for coding', () => {
    expect(applicableDimensions('coding', COMPLETENESS_DIMENSIONS)).toEqual([...COMPLETENESS_DIMENSIONS]);
  });

  it('drops the code-specific ones for research', () => {
    const dimensions = applicableDimensions('research', COMPLETENESS_DIMENSIONS);
    // Drift D-12: a research task scored down for having no testing strategy
    // and no must-not-change areas is penalised for a question never asked of it.
    expect(dimensions).not.toContain('testing');
    expect(dimensions).not.toContain('must_not_change');
    expect(dimensions).toContain('acceptance_criteria');
    expect(dimensions).toContain('problem');
  });
});

describe('the blocker sentence leads with what the reader can actually fix', () => {
  const ready = evaluateTaskRequirements({ taskKind: 'research', origin: 'direct', facts: facts() });

  it('asks for discovery before anything else', () => {
    const blocker = primaryBlocker({
      requirements: ready,
      hasBrief: false,
      hasDiscoverySession: false,
      taskKindPermitted: false,
      understandingConfidence: null,
      minExecutionConfidence: 0.6,
    });
    // Deliberately NOT "the project does not permit this kind of work", even
    // though that is also true: one takes ten seconds to fix and the other
    // needs an administrator.
    expect(blocker).toMatch(/Discovery has not been started/);
  });

  it('reports the confidence floor as non-overridable', () => {
    const blocker = primaryBlocker({
      requirements: ready,
      hasBrief: true,
      hasDiscoverySession: true,
      taskKindPermitted: true,
      understandingConfidence: 0.42,
      minExecutionConfidence: 0.6,
    });
    expect(blocker).toMatch(/42%/);
    expect(blocker).toMatch(/cannot be overridden/);
  });

  it('says nothing at all when the task is ready', () => {
    expect(
      primaryBlocker({
        requirements: ready,
        hasBrief: true,
        hasDiscoverySession: true,
        taskKindPermitted: true,
        understandingConfidence: 0.9,
        minExecutionConfidence: 0.6,
      }),
    ).toBe('');
  });
});
