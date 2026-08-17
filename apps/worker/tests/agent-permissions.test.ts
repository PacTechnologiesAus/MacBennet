import { describe, expect, it } from 'vitest';
import { codingTaskSchema, handoffBriefContentSchema, type CodingTask } from '@mac/protocol';
import { ClaudeCodeAdapter, buildInitialPrompt } from '../src/coding/claude-code-adapter.js';

/**
 * What the coding agent is allowed to DO, and whether it is told the truth
 * about it (Sprint 3.1, commissioning defect #4).
 *
 * The first real coding run against a real repository ended like this, in the
 * agent's own words:
 *
 *   "`npm test`, `npm run test`, `node --test test/`, `git add -A` and
 *    `git commit` all come back 'This command requires approval' … This session
 *    is non-interactive, so I can't clear the prompt from here. So: the tests
 *    have not been run, and nothing is committed."
 *
 * `--permission-mode acceptEdits` allows edits and nothing else. Steps 4 to 7
 * of the discipline the brief demands — run the tests, read the output, debug,
 * iterate, run the suite again — were impossible, and the agent spent its
 * budget discovering that and then reported a blocker no human could clear.
 *
 * It had been latent since Sprint 2, and the opt-in real-Claude test did not
 * catch it because it asks for a file to be CREATED (an edit can do that) and
 * never asserts a commit.
 *
 * The rule these tests pin down: **containment is what buys the agent the
 * ability to run commands.** Inside a sandbox the mount namespace is the real
 * boundary and the CLI's prompt is redundant. Outside one it is not redundant,
 * and the agent keeps only the edit permission it had.
 */

const task = (): CodingTask =>
  codingTaskSchema.parse({
    runId: '11111111-1111-1111-1111-111111111111',
    taskId: '22222222-2222-2222-2222-222222222222',
    worktreePath: '/tmp/worktree',
    branch: 'mac/1-example',
    baseBranch: 'main',
    brief: handoffBriefContentSchema.parse({
      title: 'Add a --json flag',
      userObjective: 'Add a --json flag to the summarise command.',
      desiredBehaviour: 'The flag prints JSON and the default table is unchanged.',
      acceptanceCriteria: ['`summarise --json` prints valid JSON'],
    }),
    briefMarkdown: '# Add a --json flag\n\nDo the thing.',
    testCommand: ['npm', 'test'],
    buildCommand: [],
    limits: { maxMinutes: 30, maxQuestions: 5, maxBudgetUsd: null },
  });

describe('the permission mode follows the containment', () => {
  it('is edit-only when nothing is containing the agent', () => {
    expect(new ClaudeCodeAdapter({}).permissionMode()).toBe('acceptEdits');
    expect(new ClaudeCodeAdapter({ contained: false }).permissionMode()).toBe('acceptEdits');
  });

  it('lets a CONTAINED agent run commands, because the sandbox is the boundary', () => {
    expect(new ClaudeCodeAdapter({ contained: true }).permissionMode()).toBe('bypassPermissions');
  });

  it('has a development escape hatch that is off unless asked for', () => {
    expect(new ClaudeCodeAdapter({ contained: false }).permissionMode()).toBe('acceptEdits');
    expect(new ClaudeCodeAdapter({ contained: false, allowUncontainedCommands: true }).permissionMode()).toBe(
      'bypassPermissions',
    );
  });

  it('never grants commands merely because a model or a task asked for it', () => {
    // The option is a property of the WORKER's configuration and the run's
    // containment. Nothing in the task, the brief or the agent's own output
    // reaches it, which is what stops "please enable my permissions" being a
    // sentence that works.
    const adapter = new ClaudeCodeAdapter({ contained: false });
    (adapter as unknown as Record<string, unknown>).contained = true;
    expect(adapter.permissionMode()).toBe('acceptEdits');
  });
});

describe('the brief tells the agent what this session can actually do', () => {
  it('asks for the full discipline when the agent can run commands', () => {
    const prompt = buildInitialPrompt(task(), { canRunCommands: true });
    expect(prompt).toContain('Run the tests and read the output.');
    expect(prompt).toContain('Debug and iterate until they pass.');
    expect(prompt).not.toContain('EDIT-ONLY');
  });

  it('does not ask for discipline an edit-only session cannot practise', () => {
    const prompt = buildInitialPrompt(task(), { canRunCommands: false });

    expect(prompt).toContain('EDIT-ONLY');
    // The specific instruction that produced the false blocker.
    expect(prompt).not.toContain('Debug and iterate until they pass.');
    expect(prompt).not.toContain('Run the full test suite once more at the end.');

    // And it says what WILL happen, so the agent does not treat a refusal as
    // something worth stopping for.
    expect(prompt).toMatch(/being refused is not a blocker worth reporting/i);
    expect(prompt).toMatch(/Mac commits what you leave behind/i);
    // The tests are still expected to be written; only running them is not.
    expect(prompt).toMatch(/Write the tests the brief asks for/i);
  });

  it('keeps the git prohibitions in both modes, because those are never relaxed', () => {
    for (const canRunCommands of [true, false]) {
      const prompt = buildInitialPrompt(task(), { canRunCommands });
      expect(prompt).toContain('You may NEVER merge into');
      expect(prompt).toContain('Do not push at all.');
    }
  });
});
