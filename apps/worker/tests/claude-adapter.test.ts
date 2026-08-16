import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codingTaskSchema, handoffBriefContentSchema, type AgentAnswerDraft, type AgentEvent, type CodingTask } from '@mac/protocol';
import {
  ClaudeCodeAdapter,
  buildInitialPrompt,
  formatAnswerForAgent,
  looksLikeQuestion,
  neutralToolName,
} from '../src/coding/claude-code-adapter.js';

/**
 * The Claude Code adapter, tested against a FAKE CLI.
 *
 * The fake speaks the same newline-delimited stream-json the real CLI emits
 * (shapes captured from Claude Code 2.1.233), so every required case — launch,
 * progress, activity, question, answer round-trip, cancellation, completion,
 * failure — is covered without any paid model usage, as Sprint 2 requires.
 *
 * The real CLI is exercised separately, opt-in, in `claude-real.e2e.test.ts`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeCli = path.join(here, 'fixtures', 'fake-claude.mjs');

let worktree: string;

const task = (): CodingTask =>
  codingTaskSchema.parse({
    runId: '11111111-1111-1111-1111-111111111111',
    taskId: '22222222-2222-2222-2222-222222222222',
    worktreePath: worktree,
    branch: 'mac/247-multi-device-selection',
    baseBranch: 'main',
    brief: handoffBriefContentSchema.parse({
      title: 'Allow selecting multiple devices',
      userObjective: 'Operators must be able to select several devices at once.',
      acceptanceCriteria: ['An operator can select two or more devices and save.'],
      testingExpectations: ['Unit tests for the selection reducer using Vitest.'],
    }),
    briefMarkdown: '# Allow selecting multiple devices\n\nOperators must be able to select several devices at once.',
    testCommand: ['npm', 'test'],
    buildCommand: [],
  });

/** Runs a scenario and collects everything the adapter reported. */
async function run(
  scenario: string,
  options: {
    answer?: (question: { questionId: string; question: string }) => AgentAnswerDraft;
    cancelAfterMs?: number;
  } = {},
) {
  const adapter = new ClaudeCodeAdapter({
    command: process.execPath,
    scriptPath: fakeCli,
    env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenario },
    killGraceMs: 500,
  });

  const events: AgentEvent[] = [];
  const questions: Array<{ questionId: string; question: string }> = [];
  const controller = new AbortController();

  const handle = await adapter.start(task(), {
    onEvent: (event) => {
      events.push(event);
    },
    onQuestion: async (question) => {
      questions.push(question);
      return (
        options.answer?.(question) ?? {
          questionId: question.questionId,
          decision: 'answered',
          answer: 'Sort alphabetically.',
          confidence: 0.9,
          reasoning: 'From the brief.',
          sources: ['brief.desiredBehaviour'],
          requiredHuman: false,
          isAssumption: false,
        }
      );
    },
    signal: controller.signal,
  });

  if (options.cancelAfterMs !== undefined) {
    setTimeout(() => {
      controller.abort();
      void adapter.cancel(handle.sessionId);
    }, options.cancelAfterMs).unref();
  }

  const result = await handle.finished;
  return { adapter, handle, events, result, questions };
}

const typesOf = (events: AgentEvent[]) => events.map((e) => e.type);

beforeAll(async () => {
  worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'mac-claude-'));
});

afterAll(async () => {
  await fs.rm(worktree, { recursive: true, force: true }).catch(() => undefined);
});

describe('session launch and completion', () => {
  it('starts a session, reports the provider session id, and completes', async () => {
    const { events, result, handle } = await run('success');

    expect(typesOf(events)).toContain('session_started');
    const started = events.find((e) => e.type === 'session_started');
    expect(started && 'providerSessionId' in started && started.providerSessionId).toBe('11111111-2222-3333-4444-555555555555');
    expect(handle.providerSessionId).toBe('11111111-2222-3333-4444-555555555555');

    expect(result.state).toBe('completed');
    expect(result.summary).toContain('multi-device selection');
    expect(typesOf(events)).toContain('completed');
  }, 60_000);

  it('reports tool activity in neutral terms, not provider ones', async () => {
    const { events } = await run('success');
    const activity = events.filter((e) => e.type === 'activity') as Array<Extract<AgentEvent, { type: 'activity' }>>;

    expect(activity.length).toBeGreaterThan(0);
    // 'Read' and 'Edit' become 'read' and 'edit'; Mac's model never learns the
    // provider's tool names.
    expect(activity.map((a) => a.tool)).toEqual(expect.arrayContaining(['read', 'edit']));
    expect(activity.some((a) => a.detail?.includes('DeviceSelector.tsx'))).toBe(true);
  }, 60_000);

  it('reports assistant narration as progress', async () => {
    const { events } = await run('success');
    const progress = events.filter((e) => e.type === 'progress') as Array<Extract<AgentEvent, { type: 'progress' }>>;
    expect(progress.some((p) => p.message?.includes('Reading the brief'))).toBe(true);
  }, 60_000);

  it('tolerates non-JSON noise and malformed lines rather than crashing', async () => {
    const { events, result } = await run('success');
    expect(result.state).toBe('completed');
    const output = events.filter((e) => e.type === 'output') as Array<Extract<AgentEvent, { type: 'output' }>>;
    expect(output.some((o) => o.message.includes('non-JSON warning'))).toBe(true);
  }, 60_000);
});

describe('questions and answers', () => {
  it('surfaces a question, delivers Mac\'s answer into the live session, and continues', async () => {
    const { events, questions, result } = await run('question');

    expect(questions).toHaveLength(1);
    expect(questions[0]!.question).toContain('sorted alphabetically');

    expect(typesOf(events)).toContain('question');
    expect(result.state).toBe('completed');

    // The answer really reached the CLI over stdin: the fake echoes it back.
    const progress = events.filter((e) => e.type === 'progress') as Array<Extract<AgentEvent, { type: 'progress' }>>;
    expect(progress.some((p) => p.message?.includes('Sort alphabetically'))).toBe(true);
  }, 60_000);

  it('frames a blocked decision so the agent knows it is out of scope', async () => {
    const { events } = await run('question', {
      answer: (question) => ({
        questionId: question.questionId,
        decision: 'blocked',
        answer: 'This portion is out of scope for this run.',
        confidence: 0.2,
        reasoning: 'High risk.',
        sources: [],
        requiredHuman: true,
        isAssumption: false,
      }),
    });

    const progress = events.filter((e) => e.type === 'progress') as Array<Extract<AgentEvent, { type: 'progress' }>>;
    expect(progress.some((p) => p.message?.includes('out of scope'))).toBe(true);
  }, 60_000);
});

describe('cancellation', () => {
  it('stops a long session promptly and reports it as cancelled', async () => {
    const started = Date.now();
    const { result, events } = await run('long', { cancelAfterMs: 400 });

    expect(result.state).toBe('cancelled');
    expect(typesOf(events)).toContain('cancelled');
    // Promptly: it must not run the fake's full 20 seconds of work.
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);
});

describe('failure', () => {
  it('reports a session the CLI ended with an error', async () => {
    const { result, events } = await run('failure');
    expect(result.state).toBe('failed');
    expect(result.error).toContain('conflicted state');
    expect(typesOf(events)).toContain('failed');
  }, 60_000);

  it('reports a CLI that dies without a result event', async () => {
    const { result } = await run('crash');
    expect(result.state).toBe('failed');
    expect(result.error).toContain('exited with code');
  }, 60_000);
});

describe('usage, reported honestly (Sprint 2 §16)', () => {
  it('reports exact token counts but labels subscription cost as an estimate', async () => {
    const { adapter } = await run('success');
    // `isAvailable` reads `claude auth status`, which the fake answers as a
    // subscription (claude.ai) account — the deployment this is built for.
    await adapter.isAvailable();
    const snapshot = await adapter.usageSnapshot('after');

    expect(snapshot.inputTokens).toBe(4);
    expect(snapshot.outputTokens).toBe(228);
    expect(snapshot.cacheReadTokens).toBe(85_882);
    expect(snapshot.costCents).toBe(19);

    // The critical assertion: under subscription access this is NOT exact money.
    expect(snapshot.source).toBe('estimated');
    expect(snapshot.note).toContain('NOT money billed');

    // No subscription percentage is exposed, so none is invented.
    expect(snapshot.percentUsed).toBeNull();

    // The rate-limit state IS observable, and is recorded as a state.
    expect(snapshot.state).toBe('allowed');
    expect(snapshot.reportingPeriod).toBe('five_hour');
  }, 60_000);

  it('reports `unavailable` before a session rather than a fabricated zero baseline', async () => {
    const adapter = new ClaudeCodeAdapter({ command: process.execPath });
    const snapshot = await adapter.usageSnapshot('before');
    expect(snapshot.source).toBe('unavailable');
    expect(snapshot.inputTokens ?? null).toBeNull();
    expect(snapshot.note).toContain('no meaningful baseline');
  });

  it('reports `unavailable` after a session that produced no usage report', async () => {
    const adapter = new ClaudeCodeAdapter({ command: process.execPath });
    const snapshot = await adapter.usageSnapshot('after');
    expect(snapshot.source).toBe('unavailable');
  });
});

describe('availability', () => {
  it('detects an installed, authenticated CLI', async () => {
    const adapter = new ClaudeCodeAdapter({
      command: process.execPath,
      scriptPath: fakeCli,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: 'success' },
    });
    const availability = await adapter.isAvailable();
    expect(availability.available).toBe(true);
    expect(availability.version).toContain('2.1.233');
  }, 60_000);

  it('reports a missing CLI as unavailable rather than throwing', async () => {
    const adapter = new ClaudeCodeAdapter({ command: 'definitely-not-a-real-binary-mac-test' });
    const availability = await adapter.isAvailable();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain('not available');
  }, 60_000);
});

describe('the pieces that shape what the agent is told', () => {
  it('maps provider tool names into Mac\'s vocabulary', () => {
    expect(neutralToolName('Edit')).toBe('edit');
    expect(neutralToolName('Write')).toBe('edit');
    expect(neutralToolName('Read')).toBe('read');
    expect(neutralToolName('Bash')).toBe('command');
    expect(neutralToolName('Grep')).toBe('search');
    expect(neutralToolName('SomethingNew')).toBe('tool');
  });

  it('recognises a question without treating ordinary narration as one', () => {
    expect(looksLikeQuestion('Should the list be sorted alphabetically?')).toBe(true);
    expect(looksLikeQuestion('Which approach do you want here?')).toBe(true);
    expect(looksLikeQuestion('Do you want me to add a migration?')).toBe(true);

    expect(looksLikeQuestion('I edited the selector and ran the tests.')).toBe(false);
    // A rhetorical question mark in narration must not stall the session.
    expect(looksLikeQuestion('The tricky part was the reducer state. Anyway, done.')).toBe(false);
    expect(looksLikeQuestion('')).toBe(false);
  });

  it('frames an answer as an instruction from the manager', () => {
    expect(formatAnswerForAgent('Use Vitest.', 'answered')).toContain('Mac (your manager) answers');
    expect(formatAnswerForAgent('Not now.', 'blocked')).toContain('out of scope');
    expect(formatAnswerForAgent('Probably alphabetical.', 'assumed')).toContain('not fully certain');
    expect(formatAnswerForAgent('x', 'answered')).toContain('Do not ask this again');
  });

  it('gives the agent the structured brief and the standing git rules', () => {
    const prompt = buildInitialPrompt(task());

    // The STRUCTURED brief, never the raw conversation (spec §12).
    expect(prompt).toContain('Allow selecting multiple devices');
    expect(prompt).toContain('mac/247-multi-device-selection');

    expect(prompt).toContain('may NEVER merge');
    expect(prompt).toContain('Do not push at all');
    expect(prompt).toContain('Mac pushes the branch himself');
    expect(prompt).toContain('npm test');

    // The disciplined workflow the sprint requires.
    expect(prompt).toContain('Run the tests and read the output');
    expect(prompt).toContain('Self-review your own diff');
  });
});
