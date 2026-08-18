import { describe, expect, it } from 'vitest';
import {
  checkBudget,
  checkDispatch,
  checkJobAllowed,
  checkNoCancelPending,
  checkOvernightCutoff,
  checkRunApproved,
  checkRunDispatchable,
  checkWorkerCapability,
} from '../../src/domain/guardrails.js';
import { JOB_KINDS } from '@mac/protocol';

const now = new Date('2026-08-16T02:00:00Z');

const dispatchableRun = {
  status: 'queued' as const,
  approvalState: 'approved' as const,
  cancelRequestedAt: null,
  overnightDeadlineAt: null,
  jobKind: 'noop',
  jobParams: {},
};

const healthyBudget = { recordedSpendCents: 0, nightlyBudgetCents: 5000, budgetStopPct: 100 };

describe('guardrail: unapproved runs cannot execute', () => {
  it('blocks every non-approved approval state', () => {
    for (const state of ['pending', 'rejected', 'revoked', 'not_required'] as const) {
      const result = checkRunApproved({ status: 'queued', approvalState: state });
      expect(result.ok, state).toBe(false);
      if (!result.ok) expect(result.code).toBe('RUN_NOT_APPROVED');
    }
  });

  it('permits an approved run', () => {
    expect(checkRunApproved({ status: 'queued', approvalState: 'approved' }).ok).toBe(true);
  });
});

describe('guardrail: only queued runs dispatch', () => {
  it('blocks every status other than queued', () => {
    for (const status of ['draft', 'ready_for_approval', 'approved', 'running', 'completed', 'cancelled'] as const) {
      expect(checkRunDispatchable({ status }).ok, status).toBe(false);
    }
    expect(checkRunDispatchable({ status: 'queued' }).ok).toBe(true);
  });
});

describe('guardrail: job allowlist', () => {
  it('accepts every catalogued job with valid params', () => {
    const valid: Record<string, unknown> = {
      noop: {},
      echo: { message: 'hello' },
      sleep: { seconds: 5 },
      system_info: {},
      workspace_check: {},
      fail: {},
      claude_code: {
        repositoryId: '11111111-1111-1111-1111-111111111111',
        briefId: '22222222-2222-2222-2222-222222222222',
      },
      repo_inspect: { repositoryId: '11111111-1111-1111-1111-111111111111' },
      // Sprint 3.3: general work names a brief and a kind. No repository.
      general_task: { briefId: '22222222-2222-2222-2222-222222222222', taskKind: 'research' },
    };
    for (const kind of JOB_KINDS) {
      expect(checkJobAllowed(kind, valid[kind]).ok, kind).toBe(true);
    }
  });

  it('rejects anything not in the catalogue', () => {
    for (const kind of ['shell', 'exec', 'run_command', 'bash', '', null, undefined, 42, {}]) {
      const result = checkJobAllowed(kind, {});
      expect(result.ok, String(kind)).toBe(false);
      if (!result.ok) expect(result.code).toBe('JOB_NOT_ALLOWED');
    }
  });

  it('rejects out-of-range parameters rather than clamping them', () => {
    expect(checkJobAllowed('sleep', { seconds: 0 }).ok).toBe(false);
    expect(checkJobAllowed('sleep', { seconds: 121 }).ok).toBe(false);
    expect(checkJobAllowed('sleep', { seconds: 1.5 }).ok).toBe(false);
    expect(checkJobAllowed('sleep', { seconds: '5' }).ok).toBe(false);
    expect(checkJobAllowed('echo', { message: '' }).ok).toBe(false);
    expect(checkJobAllowed('echo', { message: 'x'.repeat(501) }).ok).toBe(false);
  });

  it('rejects unexpected extra parameters, so nothing can be smuggled through', () => {
    expect(checkJobAllowed('noop', { command: 'rm -rf /' }).ok).toBe(false);
    expect(checkJobAllowed('echo', { message: 'hi', command: 'curl evil.example' }).ok).toBe(false);
    expect(checkJobAllowed('sleep', { seconds: 1, cwd: '/etc' }).ok).toBe(false);
  });
});

describe('guardrail: pending cancellation', () => {
  it('blocks dispatch once a stop has been requested', () => {
    const result = checkNoCancelPending({ cancelRequestedAt: new Date() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CANCEL_PENDING');
  });

  it('permits a run with no stop request', () => {
    expect(checkNoCancelPending({ cancelRequestedAt: null }).ok).toBe(true);
  });
});

describe('guardrail: overnight cutoff', () => {
  it('blocks a run whose deadline has passed', () => {
    const result = checkOvernightCutoff({ overnightDeadlineAt: new Date('2026-08-16T01:00:00Z') }, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('OVERNIGHT_CUTOFF_PASSED');
  });

  it('permits a run whose deadline is still ahead', () => {
    expect(checkOvernightCutoff({ overnightDeadlineAt: new Date('2026-08-16T03:00:00Z') }, now).ok).toBe(true);
  });

  it('permits an interactive run, which has no deadline at all', () => {
    expect(checkOvernightCutoff({ overnightDeadlineAt: null }, now).ok).toBe(true);
  });
});

describe('guardrail: nightly budget', () => {
  it('permits spend below the stop threshold', () => {
    expect(checkBudget({ recordedSpendCents: 4999, nightlyBudgetCents: 5000, budgetStopPct: 100 }).ok).toBe(true);
  });

  it('blocks at the stop threshold', () => {
    const result = checkBudget({ recordedSpendCents: 5000, nightlyBudgetCents: 5000, budgetStopPct: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('BUDGET_EXHAUSTED');
  });

  it('honours a stop percentage other than 100', () => {
    expect(checkBudget({ recordedSpendCents: 4000, nightlyBudgetCents: 5000, budgetStopPct: 80 }).ok).toBe(false);
    expect(checkBudget({ recordedSpendCents: 3999, nightlyBudgetCents: 5000, budgetStopPct: 80 }).ok).toBe(true);
  });

  it('treats a zero budget as "not configured" rather than "no spend allowed"', () => {
    expect(checkBudget({ recordedSpendCents: 100, nightlyBudgetCents: 0, budgetStopPct: 100 }).ok).toBe(true);
  });
});

describe('guardrail: worker capability', () => {
  it('blocks a job the worker does not advertise', () => {
    const result = checkWorkerCapability(['noop', 'echo'], 'sleep');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('WORKER_NOT_CAPABLE');
  });

  it('permits an advertised job', () => {
    expect(checkWorkerCapability(['noop', 'sleep'], 'sleep').ok).toBe(true);
  });
});

describe('combined dispatch check', () => {
  const base = { run: dispatchableRun, workerCapabilities: [...JOB_KINDS], budget: healthyBudget, now };

  it('permits a fully compliant dispatch', () => {
    expect(checkDispatch(base).ok).toBe(true);
  });

  it('reports approval failure ahead of every other reason', () => {
    // Ordering matters: an operator debugging a stuck run should be told the
    // run is unapproved rather than being sent down a budget rabbit hole.
    const result = checkDispatch({
      ...base,
      run: { ...dispatchableRun, approvalState: 'pending', cancelRequestedAt: new Date() },
      budget: { recordedSpendCents: 999_999, nightlyBudgetCents: 100, budgetStopPct: 100 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('RUN_NOT_APPROVED');
  });

  it('rejects a run carrying a job that is no longer allowlisted', () => {
    const result = checkDispatch({
      ...base,
      run: { ...dispatchableRun, jobKind: 'noop', jobParams: { command: 'whoami' } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('JOB_NOT_ALLOWED');
  });

  it('rejects an approved, queued run whose overnight cutoff has passed', () => {
    const result = checkDispatch({
      ...base,
      run: { ...dispatchableRun, overnightDeadlineAt: new Date('2026-08-16T01:00:00Z') },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('OVERNIGHT_CUTOFF_PASSED');
  });
});
