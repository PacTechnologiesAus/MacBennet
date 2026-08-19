import { describe, expect, it, vi } from 'vitest';
import type { ResearchStepResponse, RunAssignment } from '@mac/protocol';
import { runGeneralTaskJob } from '../src/jobs/general-task.js';
import { JobCancelledError, type JobContext } from '../src/jobs/index.js';

/**
 * The general job on the worker (Sprint 3.3 §13).
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE TESTS ARE REALLY CHECKING
 *
 * That the worker DRIVES a general run and does not PERFORM it. Every assertion
 * about what the worker does is also an assertion about what it does not hold:
 * no model client, no API key, no company documents, no project memory, no
 * monday token. It sends "do the next step" and reports what came back.
 *
 * That is the whole security argument for general work (Sprint 3.3 §29) — the
 * cheapest way to guarantee the VM cannot leak a credential is for it never to
 * have one.
 * ---------------------------------------------------------------------------
 */

const assignment = (overrides: Partial<RunAssignment['general']> = {}): RunAssignment => ({
  runId: '00000000-0000-4000-8000-00000000000a',
  taskId: '00000000-0000-4000-8000-00000000000b',
  projectId: '00000000-0000-4000-8000-00000000000c',
  taskTitle: 'Investigate the project registry',
  projectName: 'PAC Internal Development',
  jobKind: 'general_task',
  jobParams: {},
  deadlineAt: null,
  leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
  attempt: 1,
  // The two absences this sprint is about: no repository assignment at all.
  coding: null,
  general: {
    taskKind: 'investigation',
    maxSteps: 4,
    maxMinutes: 30,
    objective: 'Work out whether a project registry is worth building.',
    deliverables: ['A costed recommendation.'],
    ...overrides,
  },
});

function context(overrides: Partial<JobContext> = {}): { ctx: JobContext; logs: string[]; progress: string[] } {
  const logs: string[] = [];
  const progress: string[] = [];
  const ctx: JobContext = {
    log: (message: string) => logs.push(message),
    progress: async (stage: string, percent?: number) => {
      progress.push(`${stage}:${percent ?? ''}`);
    },
    signal: new AbortController().signal,
    workspace: '/tmp/does-not-matter',
    ...overrides,
  };
  return { ctx, logs, progress };
}

type StepResponse = ResearchStepResponse;

const step = (over: Partial<StepResponse> = {}): StepResponse => ({
  control: {
    protocolVersion: 1,
    serverTime: new Date().toISOString(),
    heartbeatIntervalSeconds: 10,
    cancelRequested: false,
    cancelRunId: null,
    cancelReason: null,
    rotateTokenRequested: false,
  },
  stage: 'gathering',
  stepsTaken: 1,
  toolCallsMade: 1,
  narrative: 'Looked at what PAC already records.',
  findingsSoFar: 0,
  sourcesSoFar: 2,
  artefactsCreated: 0,
  done: false,
  limitReached: false,
  blockerProposed: null,
  percent: 25,
  ...over,
});

describe('driving a general run', () => {
  it('loops until the control plane says the run is done', async () => {
    const performResearchStep = vi
      .fn()
      .mockResolvedValueOnce(step())
      .mockResolvedValueOnce(step({ stepsTaken: 2, done: true, artefactsCreated: 1, percent: 100 }));

    const { ctx, progress } = context();
    const result = await runGeneralTaskJob(assignment(), ctx, {
      client: { performResearchStep } as never,
    });

    expect(performResearchStep).toHaveBeenCalledTimes(2);
    expect(result.summary).toMatch(/1 artefact\(s\) produced/);
    expect(progress.at(0)).toBe('planning:0');
    expect(progress.at(-1)).toBe('complete:100');
  });

  it('FAILS the run when it produced nothing, rather than completing quietly', async () => {
    const performResearchStep = vi.fn().mockResolvedValue(step({ done: true, artefactsCreated: 0 }));

    const { ctx } = context();

    // Completing quietly is the failure this rule exists to prevent: a morning
    // report listing a finished investigation with nothing in it reads as
    // "looked, found nothing", which is a claim nobody made. Commissioning saw
    // exactly that reach a real inbox, which is why an empty run now throws
    // instead of returning a sad sentence alongside `succeeded`.
    await expect(
      runGeneralTaskJob(assignment(), ctx, { client: { performResearchStep } as never }),
    ).rejects.toThrow(/produced NO artefacts/);
  });

  it('names WHY the loop ended when it failed for producing nothing', async () => {
    // "Failed after being cut off at its ceiling" and "failed after the model
    // wrote nothing across four steps" need different fixes, so the summary has
    // to tell them apart.
    const performResearchStep = vi.fn().mockResolvedValue(step({ done: false, artefactsCreated: 0 }));

    const { ctx } = context();
    await expect(
      runGeneralTaskJob(assignment({ maxSteps: 2 }), ctx, { client: { performResearchStep } as never }),
    ).rejects.toThrow(/because it reached its 2-step ceiling/);
  });

  it('stops at its own step ceiling even when the control plane’s counter stalls', async () => {
    // The control plane keeps answering "step 1, not done". Looping on ITS
    // counter would never terminate, which is precisely the bug this asserts
    // against: the worker holds the lease and the clock, so it must be able to
    // stop on its own account.
    const performResearchStep = vi
      .fn()
      .mockResolvedValue(step({ stepsTaken: 1, done: false, artefactsCreated: 1 }));

    const { ctx } = context();
    await runGeneralTaskJob(assignment({ maxSteps: 3 }), ctx, { client: { performResearchStep } as never });

    expect(performResearchStep).toHaveBeenCalledTimes(3);
  });

  it('stops when the control plane reports a ceiling was reached', async () => {
    const performResearchStep = vi
      .fn()
      .mockResolvedValue(step({ limitReached: true, done: false, artefactsCreated: 1 }));

    const { ctx, logs } = context();
    await runGeneralTaskJob(assignment(), ctx, { client: { performResearchStep } as never });

    expect(performResearchStep).toHaveBeenCalledTimes(1);
    expect(logs.join('\n')).toMatch(/reached its configured ceiling/i);
  });

  it('honours the overnight cutoff carried on the assignment', async () => {
    const performResearchStep = vi.fn().mockResolvedValue(step());
    const past = { ...assignment(), deadlineAt: new Date(Date.now() - 1000).toISOString() };

    const { ctx, logs } = context();
    // Nothing was produced, so the run still fails — but it fails naming the
    // cutoff, rather than blaming the model for a silence it was never given
    // the chance to break.
    await expect(
      runGeneralTaskJob(past, ctx, { client: { performResearchStep } as never }),
    ).rejects.toThrow(/because it reached the overnight cutoff/);

    expect(performResearchStep).not.toHaveBeenCalled();
    expect(logs.join('\n')).toMatch(/overnight cutoff/i);
  });

  it('honours the wall-clock ceiling separately from the step ceiling', async () => {
    // A run can satisfy the STEP ceiling and still overrun the night, because a
    // step has no fixed duration. Minutes are therefore counted as well, and
    // this proves the two limits are genuinely independent.
    vi.useFakeTimers();
    try {
      const performResearchStep = vi.fn().mockImplementation(async () => {
        vi.advanceTimersByTime(2 * 60_000);
        return step();
      });

      const { ctx, logs } = context();
      await expect(
        runGeneralTaskJob(assignment({ maxSteps: 8, maxMinutes: 1 }), ctx, {
          client: { performResearchStep } as never,
        }),
      ).rejects.toThrow(/because it reached the 1-minute ceiling/);

      expect(performResearchStep).toHaveBeenCalledTimes(1);
      expect(logs.join(String.fromCharCode(10))).toMatch(/1-minute ceiling/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels promptly when the run is aborted', async () => {
    const controller = new AbortController();
    const performResearchStep = vi.fn().mockImplementation(async () => {
      controller.abort();
      return step();
    });

    const { ctx } = context({ signal: controller.signal });
    await expect(
      runGeneralTaskJob(assignment(), ctx, { client: { performResearchStep } as never }),
    ).rejects.toBeInstanceOf(JobCancelledError);
  });

  it('surfaces a proposed blocker without deciding it is one', async () => {
    const performResearchStep = vi
      .fn()
      .mockResolvedValue(step({ done: true, artefactsCreated: 1, blockerProposed: 'Needs a budget decision.' }));

    const { ctx, logs } = context();
    await runGeneralTaskJob(assignment(), ctx, { client: { performResearchStep } as never });

    // Reported, not acted on: "should I stop and ask?" is a guardrail question
    // and guardrails are not delegated to models anywhere in this system.
    expect(logs.join('\n')).toMatch(/human decision is needed: Needs a budget decision/);
  });

  it('refuses to run without a general assignment rather than improvising one', async () => {
    const { ctx } = context();
    const withoutAssignment = { ...assignment(), general: null };

    await expect(
      runGeneralTaskJob(withoutAssignment, ctx, { client: { performResearchStep: vi.fn() } as never }),
    ).rejects.toThrow(/no assignment/i);
  });
});

describe('what the worker never touches', () => {
  it('receives no credential, no prompt and no tool in its assignment', () => {
    const general = assignment().general!;
    const serialised = JSON.stringify(general);

    for (const forbidden of ['apiKey', 'api_key', 'token', 'prompt', 'system', 'tool', 'credential']) {
      expect(serialised.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    }
    // What it DOES get: an objective, deliverables and two ceilings.
    expect(Object.keys(general).sort()).toEqual(['deliverables', 'maxMinutes', 'maxSteps', 'objective', 'taskKind']);
  });

  it('has no repository assignment at all, so nothing can reach a clone', () => {
    expect(assignment().coding).toBeNull();
  });
});
