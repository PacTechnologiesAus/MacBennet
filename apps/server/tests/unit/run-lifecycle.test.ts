import { describe, expect, it } from 'vitest';
import { RUN_STATUSES, TERMINAL_RUN_STATUSES, isTerminalRunStatus, type RunStatus } from '@mac/protocol';
import {
  InvalidTransitionError,
  RUN_TRANSITIONS,
  assertTransition,
  canTransition,
} from '../../src/domain/run-lifecycle.js';

describe('run lifecycle state machine', () => {
  it('covers every status declared in the protocol', () => {
    for (const status of RUN_STATUSES) {
      expect(RUN_TRANSITIONS[status], `missing entry for ${status}`).toBeDefined();
    }
    expect(Object.keys(RUN_TRANSITIONS).sort()).toEqual([...RUN_STATUSES].sort());
  });

  it('seals every terminal state', () => {
    for (const status of TERMINAL_RUN_STATUSES) {
      expect(RUN_TRANSITIONS[status]).toEqual([]);
      for (const target of RUN_STATUSES) {
        expect(canTransition(status, target)).toBe(false);
      }
    }
  });

  it('accepts the Sprint 1 happy path', () => {
    const path: RunStatus[] = ['draft', 'ready_for_approval', 'approved', 'queued', 'running', 'completed'];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i]!, path[i + 1]!), `${path[i]} → ${path[i + 1]}`).toBe(true);
    }
  });

  it('accepts the discovery and self-review path reserved for later sprints', () => {
    expect(canTransition('draft', 'discovery')).toBe(true);
    expect(canTransition('discovery', 'ready_for_approval')).toBe(true);
    expect(canTransition('running', 'self_review')).toBe(true);
    expect(canTransition('self_review', 'ready_for_human_review')).toBe(true);
    expect(canTransition('ready_for_human_review', 'completed')).toBe(true);
  });

  it('lets a rejected run return to draft for revision', () => {
    expect(canTransition('ready_for_approval', 'draft')).toBe(true);
  });

  it('refuses to skip approval', () => {
    // The critical rule: nothing may reach `running` without passing through
    // `approved` then `queued`.
    expect(canTransition('draft', 'running')).toBe(false);
    expect(canTransition('draft', 'queued')).toBe(false);
    expect(canTransition('ready_for_approval', 'queued')).toBe(false);
    expect(canTransition('ready_for_approval', 'running')).toBe(false);
    expect(canTransition('approved', 'running')).toBe(false);
  });

  it('refuses to resurrect a finished run', () => {
    expect(canTransition('completed', 'running')).toBe(false);
    expect(canTransition('cancelled', 'queued')).toBe(false);
    expect(canTransition('failed', 'running')).toBe(false);
    expect(canTransition('stopped_by_guardrail', 'running')).toBe(false);
  });

  it('refuses to move backwards through execution', () => {
    expect(canTransition('running', 'queued')).toBe(false);
    expect(canTransition('running', 'approved')).toBe(false);
    expect(canTransition('queued', 'approved')).toBe(false);
  });

  it('allows a guardrail stop from every pre-terminal execution state', () => {
    for (const status of ['approved', 'queued', 'running', 'blocked'] as const) {
      expect(canTransition(status, 'stopped_by_guardrail'), status).toBe(true);
    }
  });

  it('allows cancellation from every non-terminal state', () => {
    for (const status of RUN_STATUSES) {
      if (isTerminalRunStatus(status)) continue;
      expect(canTransition(status, 'cancelled'), `${status} → cancelled`).toBe(true);
    }
  });

  it('throws a typed error carrying both ends of the rejected transition', () => {
    expect(() => assertTransition('completed', 'running')).toThrow(InvalidTransitionError);
    try {
      assertTransition('draft', 'running');
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as InvalidTransitionError;
      expect(e.code).toBe('INVALID_TRANSITION');
      expect(e.from).toBe('draft');
      expect(e.to).toBe('running');
    }
  });

  it('explains terminality distinctly from an ordinary illegal move', () => {
    const terminal = new InvalidTransitionError('completed', 'running');
    expect(terminal.message).toContain('terminal');
    const ordinary = new InvalidTransitionError('draft', 'running');
    expect(ordinary.message).not.toContain('terminal');
  });

  it('never permits a self-transition', () => {
    for (const status of RUN_STATUSES) {
      expect(canTransition(status, status), `${status} → itself`).toBe(false);
    }
  });
});
