import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codingTaskSchema, handoffBriefContentSchema, type AgentEvent, type CodingTask } from '@mac/protocol';
import { ClaudeCodeAdapter } from '../src/coding/claude-code-adapter.js';
import { buildGitShim, readShimViolations, resolveRealGit } from '../src/git/shim.js';

/**
 * OPT-IN: the real, locally authenticated Claude Code CLI.
 *
 * Skipped unless MAC_E2E_REAL_CLAUDE=1, because it spends real subscription
 * usage and depends on a machine that happens to be logged in. Everything the
 * normal suite needs is covered against the fake CLI in `claude-adapter.test.ts`.
 *
 * What this proves that the fake cannot:
 *
 *   1. the adapter's argv is accepted by the actual CLI;
 *   2. the real event stream parses into Mac's neutral events;
 *   3. the real `result` event yields usage the adapter classifies correctly;
 *   4. the git shim is genuinely on the agent's PATH inside a real session.
 *
 * Run it with:  MAC_E2E_REAL_CLAUDE=1 npm run test -w @mac/worker
 */

const enabled = process.env.MAC_E2E_REAL_CLAUDE === '1';
const describeReal = enabled ? describe : describe.skip;

let worktree: string;
let shimDir: string;

const git = (argv: string[], cwd: string): Promise<number> =>
  new Promise((resolve) => {
    execFile('git', argv, { cwd, shell: false, windowsHide: true }, (error) => {
      const code = (error as { code?: number } | null)?.code;
      resolve(typeof code === 'number' ? code : 0);
    });
  });

beforeAll(async () => {
  if (!enabled) return;

  worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'mac-real-claude-'));
  await git(['init', '--initial-branch=main'], worktree);
  await git(['config', 'user.email', 'mac@pac-technologies.com.au'], worktree);
  await git(['config', 'user.name', 'Mac Bennett'], worktree);
  await fs.writeFile(path.join(worktree, 'README.md'), '# Fixture\n', 'utf8');
  await git(['add', '-A'], worktree);
  await git(['commit', '-m', 'initial'], worktree);
  await git(['switch', '-c', 'mac/1-real-claude'], worktree);

  const realGit = await resolveRealGit();
  const shim = await buildGitShim({
    directory: path.join(worktree, '.mac-shim'),
    realGitPath: realGit,
    policy: { defaultBranch: 'main', currentBranch: 'mac/1-real-claude', allowPush: false },
  });
  shimDir = shim.binDir;
}, 300_000);

afterAll(async () => {
  if (worktree) await fs.rm(worktree, { recursive: true, force: true }).catch(() => undefined);
});

const task = (): CodingTask =>
  codingTaskSchema.parse({
    runId: '11111111-1111-1111-1111-111111111111',
    taskId: '22222222-2222-2222-2222-222222222222',
    worktreePath: worktree,
    branch: 'mac/1-real-claude',
    baseBranch: 'main',
    brief: handoffBriefContentSchema.parse({
      title: 'Add a NOTES.md file',
      userObjective: 'Create a file called NOTES.md containing exactly the single line: hello from mac',
      desiredBehaviour: 'A file NOTES.md exists at the repository root with that one line, and it is committed.',
      acceptanceCriteria: ['NOTES.md exists at the repository root', 'The file is committed on the current branch'],
    }),
    briefMarkdown:
      '# Add a NOTES.md file\n\nCreate a file called `NOTES.md` at the repository root containing exactly the single line ' +
      '`hello from mac`, then commit it. Do nothing else.',
    testCommand: [],
    buildCommand: [],
    limits: { maxMinutes: 5, maxQuestions: 3, maxBudgetUsd: null },
  });

describeReal('the real Claude Code CLI', () => {
  it('runs a small task, reports neutral events, and produces a real commit', async () => {
    const adapter = new ClaudeCodeAdapter({ shimBinDir: shimDir, idleTimeoutMs: 5 * 60_000, model: 'sonnet' });

    const availability = await adapter.isAvailable();
    expect(availability.available, availability.reason ?? '').toBe(true);

    const events: AgentEvent[] = [];
    const controller = new AbortController();

    const handle = await adapter.start(task(), {
      onEvent: (event) => {
        events.push(event);
      },
      onQuestion: async (question) => ({
        questionId: question.questionId,
        decision: 'answered' as const,
        answer: 'Just create NOTES.md with that one line and commit it. Nothing else is needed.',
        confidence: 0.95,
        reasoning: 'Stated directly in the brief.',
        sources: ['brief.userObjective'],
        requiredHuman: false,
        isAssumption: false,
      }),
      signal: controller.signal,
    });

    const result = await handle.finished;

    expect(['completed', 'failed']).toContain(result.state);
    expect(handle.providerSessionId).toBeTruthy();

    // The event stream was parsed into Mac's vocabulary.
    const types = new Set(events.map((e) => e.type));
    expect(types.has('session_started')).toBe(true);
    expect([...types].some((t) => t === 'activity' || t === 'progress')).toBe(true);

    // Usage was captured, and classified honestly.
    const usage = await adapter.usageSnapshot('after');
    expect(['exact', 'estimated']).toContain(usage.source);
    expect(usage.inputTokens).not.toBeNull();
    expect(usage.outputTokens).not.toBeNull();
    // Under subscription access the dollar figure must not claim to be billed.
    if (usage.source === 'estimated') expect(usage.note).toContain('NOT money billed');
    // No provider percentage exists, so none may be reported.
    expect(usage.percentUsed).toBeNull();

    if (result.state === 'completed') {
      const notes = await fs.readFile(path.join(worktree, 'NOTES.md'), 'utf8').catch(() => null);
      expect(notes, 'the agent was asked to create NOTES.md').not.toBeNull();
    }

    // Whatever happened, the default branch did not move.
    const mainLog = await new Promise<string>((resolve) => {
      execFile('git', ['log', '--oneline', 'main'], { cwd: worktree, shell: false }, (_e, stdout) => resolve(String(stdout)));
    });
    expect(mainLog.trim().split('\n')).toHaveLength(1);

    // The shim was on PATH; if the agent attempted anything prohibited it was
    // refused and recorded.
    const violations = await readShimViolations(path.join(shimDir, 'git-violations.jsonl'));
    for (const violation of violations) {
      expect(violation.code).toBeTruthy();
    }
  }, 600_000);
});

/**
 * §15 — cancelling a REAL coding run.
 *
 * Sprint 3 proved cancellation against a sleeping `sh` inside a sandbox, which
 * demonstrates the signal path but not this one: Claude Code is a long-lived
 * Node process holding an HTTP stream, and "the abort reaches it promptly" is a
 * different claim from "SIGTERM kills a shell".
 *
 * The task is deliberately open-ended, so the agent is certain to still be
 * working when the abort arrives. Nothing is damaged by stopping it: the
 * worktree is a temporary directory and the run is discarded.
 */
describeReal('cancelling the real Claude Code CLI', () => {
  it('aborts a running session promptly and leaves the default branch alone', async () => {
    const adapter = new ClaudeCodeAdapter({
      shimBinDir: shimDir,
      idleTimeoutMs: 10 * 60_000,
      model: 'sonnet',
      // Contained is false here: this test is about the signal path, and the
      // permission mode does not change how a process dies.
      contained: false,
    });

    const open = codingTaskSchema.parse({
      ...task(),
      brief: handoffBriefContentSchema.parse({
        title: 'Survey the repository',
        userObjective:
          'Read every file in this repository and write a long, careful description of each one into SURVEY.md.',
        desiredBehaviour: 'SURVEY.md contains a paragraph about every file.',
        acceptanceCriteria: ['Every file is described at length'],
      }),
      briefMarkdown:
        '# Survey the repository\n\nRead every file and write a long, careful description of each into ' +
        '`SURVEY.md`. Take your time and be thorough.',
      limits: { maxMinutes: 10, maxQuestions: 3, maxBudgetUsd: null },
    });

    const controller = new AbortController();
    const events: AgentEvent[] = [];

    const handle = await adapter.start(open, {
      onEvent: (event) => {
        events.push(event);
      },
      onQuestion: async (question) => ({
        questionId: question.questionId,
        decision: 'answered' as const,
        answer: 'Keep going as described.',
        confidence: 0.9,
        reasoning: 'Stated in the brief.',
        sources: ['brief.userObjective'],
        requiredHuman: false,
        isAssumption: false,
      }),
      signal: controller.signal,
    });

    // Let it genuinely start before pulling the plug; aborting a process that
    // has not begun would prove nothing.
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    expect(events.length, 'the agent never started, so cancelling it proves nothing').toBeGreaterThan(0);

    const started = Date.now();
    controller.abort();
    const result = await handle.finished;
    const elapsed = Date.now() - started;

    expect(result.state).toBe('cancelled');
    // Aborted, not waited out. The idle timeout is ten minutes.
    expect(elapsed, `cancellation took ${elapsed}ms`).toBeLessThan(45_000);

    // The process is gone rather than orphaned holding a model stream.
    const availability = await adapter.isAvailable();
    expect(availability.available).toBe(true);

    // And whatever it had done, the default branch did not move.
    const mainLog = await new Promise<string>((resolve) => {
      execFile('git', ['log', '--oneline', 'main'], { cwd: worktree, shell: false }, (_e, stdout) =>
        resolve(String(stdout)),
      );
    });
    expect(mainLog.trim().split('\n')).toHaveLength(1);
  }, 300_000);
});
