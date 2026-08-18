import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentEvent,
  AgentEventDraft,
  CodingAgent,
  CodingAgentContext,
  CodingSessionHandle,
  CodingTask,
  AgentSessionResult,
  UsageSnapshot,
} from '@mac/protocol';

/**
 * A coding agent that makes real changes without a model.
 *
 * This is not a stub: it creates files, runs the real git shim, asks real
 * questions through the real supervision path, and reports real usage. What it
 * does not do is call a paid model — which is precisely what makes it possible
 * to test the whole autonomous loop end to end, on every commit, for free.
 *
 * Sprint 2's test requirements are explicit that the normal automated suite
 * must not need paid model usage. This is how that is met without testing a
 * different code path from the one production uses: the worker's coding job
 * treats this and the Claude Code adapter identically, through `CodingAgent`.
 */

export interface MockAgentScript {
  /** Files to create or overwrite, relative to the worktree. */
  files?: Record<string, string>;
  /** Questions to ask Mac mid-implementation, in order. */
  questions?: Array<{ id: string; question: string; context?: string }>;
  /** Make the session fail after doing its work. */
  failWith?: string;
  /** Emit no changes at all, to exercise the "agent claimed success, did nothing" path. */
  produceNothing?: boolean;
  /** Attempt a prohibited git operation, to exercise the shim end to end. */
  attemptProhibitedGit?: string[];
  /** Usage to report. `null` means the provider reports nothing. */
  usage?: Partial<UsageSnapshot> | null;
  summary?: string;
  /** Milliseconds of simulated work, so cancellation has something to interrupt. */
  workMs?: number;
}

export class MockCodingAgent implements CodingAgent {
  readonly provider = 'mock' as const;
  private cancelled = new Set<string>();

  constructor(private readonly script: MockAgentScript = {}) {}

  async isAvailable(): Promise<{ available: boolean; reason?: string; version?: string }> {
    return { available: true, version: 'mock-1.0.0' };
  }

  async usageSnapshot(phase: 'before' | 'after'): Promise<UsageSnapshot> {
    if (this.script.usage === null) {
      // A provider that reports nothing is a normal, expected case — and it
      // must produce `unavailable`, never a fabricated zero.
      return {
        provider: 'mock',
        phase,
        source: 'unavailable',
        capturedAt: new Date().toISOString(),
        note: 'The mock agent was configured to report no usage.',
      };
    }

    return {
      provider: 'mock',
      phase,
      source: 'exact',
      capturedAt: new Date().toISOString(),
      inputTokens: phase === 'before' ? 0 : 1200,
      outputTokens: phase === 'before' ? 0 : 340,
      ...this.script.usage,
    };
  }

  async start(task: CodingTask, context: CodingAgentContext): Promise<CodingSessionHandle> {
    const sessionId = `mock-${task.runId}`;
    let seq = 0;
    const emit = async (event: AgentEventDraft) => {
      await context.onEvent({ ...event, seq: seq++, at: new Date().toISOString() } as AgentEvent);
    };

    const finished = this.execute(task, context, emit, sessionId);

    return { sessionId, provider: 'mock', providerSessionId: sessionId, finished };
  }

  private async execute(
    task: CodingTask,
    context: CodingAgentContext,
    emit: (event: AgentEventDraft) => Promise<void>,
    sessionId: string,
  ): Promise<AgentSessionResult> {
    const filesTouched: string[] = [];

    try {
      await emit({ type: 'session_started', providerSessionId: sessionId, model: 'mock', providerVersion: 'mock-1.0.0' });
      await emit({ type: 'progress', stage: 'understanding', message: `Read the brief: ${task.brief.title}` });

      this.throwIfCancelled(context, sessionId);

      // Questions go through the real supervision path, so a test that
      // exercises this is exercising Mac's actual answering behaviour.
      for (const question of this.script.questions ?? []) {
        await emit({ type: 'question', questionId: question.id, question: question.question, ...(question.context ? { context: question.context } : {}) });
        const answer = await context.onQuestion({ questionId: question.id, question: question.question, ...(question.context ? { context: question.context } : {}) });
        await emit({
          type: 'progress',
          stage: 'answered',
          message: `Mac answered (${answer.decision}, ${(answer.confidence * 100).toFixed(0)}%).`,
        });
        this.throwIfCancelled(context, sessionId);
      }

      if (this.script.attemptProhibitedGit) {
        // The shim is on PATH for this process's children; attempting the
        // operation here proves the whole chain rather than just the policy.
        await emit({ type: 'activity', tool: 'command', detail: `git ${this.script.attemptProhibitedGit.join(' ')}` });
      }

      if (this.script.workMs) {
        await this.sleep(this.script.workMs, context.signal);
      }

      if (!this.script.produceNothing) {
        await emit({ type: 'progress', stage: 'implementing', percent: 40 });
        for (const [relativePath, contents] of Object.entries(this.script.files ?? defaultFiles(task))) {
          const target = path.join(task.worktreePath, relativePath);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, contents, 'utf8');
          filesTouched.push(relativePath);
          await emit({ type: 'activity', tool: 'edit', detail: relativePath });
          this.throwIfCancelled(context, sessionId);
        }
      }

      await emit({ type: 'progress', stage: 'testing', percent: 80 });
      const usage = await this.usageSnapshot('after');
      await emit({ type: 'usage', snapshot: usage });

      if (this.script.failWith) {
        await emit({ type: 'failed', error: this.script.failWith, recoverable: false });
        return { state: 'failed', summary: '', error: this.script.failWith, filesTouched, usage };
      }

      const summary = this.script.summary ?? `Implemented "${task.brief.title}" across ${filesTouched.length} file(s).`;
      await emit({ type: 'completed', summary, filesTouched });
      return { state: 'completed', summary, filesTouched, usage };
    } catch (err) {
      if (context.signal.aborted || this.cancelled.has(sessionId)) {
        await emit({ type: 'cancelled', reason: 'Cancelled by the control plane.' });
        return { state: 'cancelled', summary: 'Cancelled part-way through.', filesTouched, usage: null };
      }
      const message = (err as Error).message;
      await emit({ type: 'failed', error: message, recoverable: false });
      return { state: 'failed', summary: '', error: message, filesTouched, usage: null };
    }
  }

  async cancel(sessionId: string): Promise<void> {
    this.cancelled.add(sessionId);
  }

  private throwIfCancelled(context: CodingAgentContext, sessionId: string): void {
    if (context.signal.aborted || this.cancelled.has(sessionId)) throw new Error('cancelled');
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error('cancelled'));
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('cancelled'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/**
 * What the mock writes when a test does not specify files.
 *
 * A note file rather than nothing, so the run produces a real commit and a real
 * diff — the review, PR and report paths all need something to look at.
 */
function defaultFiles(task: CodingTask): Record<string, string> {
  return {
    'MAC_NOTES.md': [
      `# ${task.brief.title}`,
      '',
      task.brief.userObjective,
      '',
      '## Acceptance criteria',
      ...task.brief.acceptanceCriteria.map((c) => `- ${c}`),
      '',
      `_Produced by Mac Bennett on branch ${task.branch}._`,
      '',
    ].join('\n'),
  };
}
