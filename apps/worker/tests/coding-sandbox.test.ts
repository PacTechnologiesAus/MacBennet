import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CodingAssignment, RunAssignment, SandboxPlan } from '@mac/protocol';
import { runCodingJob } from '../src/jobs/claude-code.js';
import { MockCodingAgent } from '../src/coding/mock-agent.js';
import { RecordingPullRequestGateway } from '../src/coding/pull-request.js';
import { SandboxUnavailable, makePathMapper, nodeSpawner } from '../src/sandbox/index.js';
import type { ExecutionSandbox, SandboxSession } from '../src/sandbox/index.js';
import type { JobContext } from '../src/jobs/index.js';

/**
 * The coding job's use of the sandbox (Sprint 3 §3.4).
 *
 * Three claims are under test here, and none of them is "the boundary holds" —
 * that is `sandbox-conformance.test.ts`, against a real provider:
 *
 *   1. a run that REQUIRES containment and cannot get it FAILS, and does not
 *      quietly run the agent unconfined;
 *   2. the plan the job builds is the right one — the worktree writable, the
 *      shim read-only, and no path outside the project;
 *   3. the agent AND the project's own test command both go through the
 *      session's spawner, which is the difference between sandboxing the agent
 *      and sandboxing what the agent wrote.
 *
 * The recording sandbox below is deliberately a pass-through: it captures the
 * plan and the spawns and then delegates to an ordinary spawn, so this file can
 * assert routing without needing a container image that happens to carry Node
 * and git.
 */

let tempDir: string;
let remoteDir: string;
let cloneDir: string;
let workspace: string;

const exec = (cmd: string, argv: string[], cwd: string): Promise<number> =>
  new Promise((resolve) => {
    execFile(cmd, argv, { cwd, shell: false, windowsHide: true }, (error) => {
      const code = (error as { code?: number } | null)?.code;
      resolve(typeof code === 'number' ? code : 0);
    });
  });
const git = (argv: string[], cwd: string) => exec('git', argv, cwd);

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mac-cs-'));
  remoteDir = path.join(tempDir, 'remote.git');
  cloneDir = path.join(tempDir, 'clone');
  workspace = path.join(tempDir, 'workspace');

  await fs.mkdir(remoteDir, { recursive: true });
  await git(['init', '--bare', '--initial-branch=main'], remoteDir);

  const seed = path.join(tempDir, 'seed');
  await fs.mkdir(seed, { recursive: true });
  await git(['init', '--initial-branch=main'], seed);
  await git(['config', 'user.email', 'mac@pac-technologies.com.au'], seed);
  await git(['config', 'user.name', 'Mac Bennett'], seed);
  await fs.writeFile(path.join(seed, 'README.md'), '# Device Portal\n', 'utf8');
  await git(['add', '-A'], seed);
  await git(['commit', '-m', 'initial'], seed);
  await git(['remote', 'add', 'origin', remoteDir], seed);
  await git(['push', 'origin', 'main'], seed);

  await git(['clone', remoteDir, cloneDir], tempDir);
  await git(['config', 'user.email', 'mac@pac-technologies.com.au'], cloneDir);
  await git(['config', 'user.name', 'Mac Bennett'], cloneDir);
}, 180_000);

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

// ---------------------------------------------------------------------------
// A recording, pass-through sandbox
// ---------------------------------------------------------------------------

interface RecordedSpawn {
  executable: string;
  args: string[];
  cwd: string | undefined;
}

class RecordingSandbox implements ExecutionSandbox {
  readonly kind = 'docker' as const;
  plans: SandboxPlan[] = [];
  spawns: RecordedSpawn[] = [];
  closed = 0;

  async probe() {
    return { available: true, version: 'recording-1.0' };
  }

  async open(plan: SandboxPlan): Promise<SandboxSession> {
    this.plans.push(plan);
    // Identity mapping so the pass-through spawn still finds real files: the
    // point of this double is routing, not path translation, which the plan
    // tests cover.
    const pathFor = (hostPath: string) => makePathMapper({ ...plan, mounts: [] })(hostPath);

    return {
      kind: this.kind,
      pathFor,
      spawner: (executable, args, options) => {
        this.spawns.push({ executable, args: [...args], cwd: options.cwd as string | undefined });
        return nodeSpawner(executable, args, options);
      },
      close: async () => {
        this.closed += 1;
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Minimal control-plane double
// ---------------------------------------------------------------------------

function fakeClient() {
  const calls: Record<string, unknown[]> = {};
  const push = (name: string, value: unknown) => {
    (calls[name] ??= []).push(value);
  };

  const client = {
    reportWorktree: async (_runId: string, body: unknown) => {
      push('worktree', body);
      return { worktreeId: '00000000-0000-4000-8000-000000000000' } as never;
    },
    reportGitViolation: async (_runId: string, body: unknown) => {
      push('violation', body);
      return {} as never;
    },
    reportRunSandbox: async (_runId: string, body: unknown) => {
      push('sandbox', body);
      return {} as never;
    },
    reportUsage: async (_runId: string, body: unknown) => {
      push('usage', body);
      return {} as never;
    },
    sendAgentEvents: async (_runId: string, body: unknown) => {
      push('events', body);
      return {} as never;
    },
    startAgentSession: async (_runId: string, body: unknown) => {
      push('session', body);
      return {} as never;
    },
    askQuestion: async (_runId: string, body: { questionId: string }) => {
      push('question', body);
      return {
        answer: {
          questionId: body.questionId,
          decision: 'answered' as const,
          answer: 'Yes.',
          confidence: 0.9,
          reasoning: 'test',
          sources: [],
          requiredHuman: false,
          isAssumption: false,
        },
      } as never;
    },
    submitReview: async (_runId: string, body: unknown) => {
      push('review', body);
      return {
        verdict: 'satisfies_brief',
        riskLevel: 'low' as const,
        satisfiesBrief: true,
        acceptanceCriteriaMet: true,
        unexpectedScope: false,
        humanAttentionRequired: false,
        anomalies: [],
        pullRequest: { shouldOpen: false as const, reason: 'Not needed for this test.' },
      } as never;
    },
    reportPullRequest: async (_runId: string, body: unknown) => {
      push('pr', body);
      return { pullRequestId: '00000000-0000-4000-8000-000000000001' } as never;
    },
  };

  return { client: client as never, calls };
}

// ---------------------------------------------------------------------------

function makeAssignment(overrides: Partial<CodingAssignment> = {}): RunAssignment {
  const runId = `00000000-0000-4000-8000-${Math.floor(Math.random() * 1e11).toString().padStart(12, '0')}`;
  const coding: CodingAssignment = {
    repositoryId: '00000000-0000-4000-8000-00000000000a',
    repositoryName: 'device-portal',
    remoteUrl: remoteDir,
    remoteName: 'origin',
    localPath: cloneDir,
    defaultBranch: 'main',
    // Unique per assignment: these tests share one clone, and a fixed branch
    // name would make the second run fail on `switch -c` rather than on
    // anything this file is trying to prove.
    branch: `mac/sbx-${Math.random().toString(36).slice(2, 10)}`,
    provider: 'mock',
    task: {
      brief: {
        title: 'Sandboxed change',
        userObjective: 'Prove the coding job routes through the sandbox.',
        currentBehaviour: '',
        desiredBehaviour: '',
        relevantArchitecture: '',
        constraints: [],
        mustNotChange: [],
        likelyAffectedComponents: [],
        acceptanceCriteria: [],
        testingExpectations: [],
        implementationConsiderations: [],
        openQuestions: [],
        assumptions: [],
        risks: [],
        proposedScope: 'Touch one file.',
        outOfScope: [],
      },
      briefMarkdown: '# Sandboxed change',
      testCommand: [process.execPath, '-v'],
      buildCommand: [],
      limits: { maxMinutes: 5, maxQuestions: 5, maxBudgetUsd: null },
    },
    openPullRequest: false,
    pullRequestBase: 'main',
    sandbox: { required: true, testNetwork: 'none' },
    ...overrides,
  };

  return {
    runId,
    taskId: '00000000-0000-4000-8000-00000000000b',
    projectId: '00000000-0000-4000-8000-00000000000c',
    taskTitle: 'Sandboxed change',
    projectName: 'Device Portal',
    jobKind: 'claude_code',
    jobParams: {},
    deadlineAt: null,
    leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    attempt: 1,
    coding,
    general: null,
  };
}

function makeContext(): JobContext & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    log: (message: string) => logs.push(message),
    progress: async () => undefined,
    signal: new AbortController().signal,
    workspace,
  } as never;
}

// ---------------------------------------------------------------------------

describe('a coding run that requires containment and cannot get it', () => {
  it('FAILS rather than running the coding agent unconfined', async () => {
    const { client } = fakeClient();
    const assignment = makeAssignment();

    await expect(
      runCodingJob(assignment, makeContext(), {
        client,
        skipPush: true,
        agentFactory: () => new MockCodingAgent({}),
        // The explicit development setting. It attests nothing and, crucially,
        // it must not become a way to run coding work unconfined.
        sandboxOptions: { provider: 'none' },
      }),
    ).rejects.toBeInstanceOf(SandboxUnavailable);
  }, 120_000);

  it('audits the refusal before it throws, so the reason is queryable', async () => {
    const { client, calls } = fakeClient();

    await runCodingJob(makeAssignment(), makeContext(), {
      client,
      skipPush: true,
      agentFactory: () => new MockCodingAgent({}),
      sandboxOptions: { provider: 'none' },
    }).catch(() => undefined);

    const reports = (calls.sandbox ?? []) as Array<{ sandbox: { established: boolean; refusalReason: string } }>;
    expect(reports).toHaveLength(1);
    expect(reports[0]!.sandbox.established).toBe(false);
    expect(reports[0]!.sandbox.refusalReason).toContain('requires an OS-enforced sandbox');
  }, 120_000);

  it('preserves the worktree when it refuses, so nothing is lost', async () => {
    const { client, calls } = fakeClient();
    const assignment = makeAssignment();

    await runCodingJob(assignment, makeContext(), {
      client,
      skipPush: true,
      agentFactory: () => new MockCodingAgent({}),
      sandboxOptions: { provider: 'none' },
    }).catch(() => undefined);

    const worktreeReports = (calls.worktree ?? []) as Array<{ status: string }>;
    expect(worktreeReports.length).toBeGreaterThan(0);
    expect(worktreeReports.at(-1)!.status).toBe('preserved');
  }, 120_000);

  it('runs unconfined only when the control plane explicitly did not require containment', async () => {
    const { client } = fakeClient();
    const assignment = makeAssignment({ sandbox: { required: false, testNetwork: 'none' } });
    const ctx = makeContext();

    const result = await runCodingJob(assignment, ctx, {
      client,
      skipPush: true,
      agentFactory: () => new MockCodingAgent({}),
      sandboxOptions: { provider: 'none' },
    });

    expect(result.summary).toBeTruthy();
    // And it says so, loudly, in the run log a human will read.
    expect(ctx.logs.join('\n')).toContain('WARNING: no execution sandbox');
  }, 180_000);
});

describe('the plan the coding job builds', () => {
  let sandbox: RecordingSandbox;

  beforeEach(() => {
    sandbox = new RecordingSandbox();
  });

  it('mounts the worktree writable, the shim read-only, and nothing outside the project', async () => {
    const { client } = fakeClient();

    await runCodingJob(makeAssignment(), makeContext(), {
      client,
      skipPush: true,
      sandbox,
      agentFactory: () => new MockCodingAgent({}),
      pullRequestGateway: new RecordingPullRequestGateway({ url: 'unused', number: null }),
    });

    expect(sandbox.plans).toHaveLength(1);
    const plan = sandbox.plans[0]!;

    const byPurpose = Object.fromEntries(plan.mounts.map((m) => [m.purpose, m]));
    expect(byPurpose.worktree!.mode).toBe('rw');
    expect(byPurpose.repository_git!.mode).toBe('rw');
    expect(byPurpose.git_shim!.mode).toBe('ro');
    expect(byPurpose.scratch!.mode).toBe('rw');

    // Every mount sits inside the repository clone or the worker workspace.
    for (const mount of plan.mounts) {
      const insideRepo = mount.hostPath.startsWith(path.resolve(cloneDir));
      const insideWorkspace = mount.hostPath.startsWith(path.resolve(workspace));
      expect(insideRepo || insideWorkspace, mount.hostPath).toBe(true);
    }
  }, 180_000);

  it('reports the containment it established, with mount purposes and modes', async () => {
    const { client, calls } = fakeClient();

    await runCodingJob(makeAssignment(), makeContext(), {
      client,
      skipPush: true,
      sandbox,
      agentFactory: () => new MockCodingAgent({}),
    });

    const reports = (calls.sandbox ?? []) as Array<{
      sandbox: { established: boolean; kind: string; mounts: Array<{ purpose: string; mode: string }> };
    }>;
    expect(reports).toHaveLength(1);
    expect(reports[0]!.sandbox.established).toBe(true);

    const byPurpose = Object.fromEntries(reports[0]!.sandbox.mounts.map((m) => [m.purpose, m.mode]));
    // What a reviewer needs afterwards: what kind of thing was reachable, and
    // whether it was writable.
    expect(byPurpose.worktree).toBe('rw');
    expect(byPurpose.git_shim).toBe('ro');
  }, 180_000);

  it('closes the session when the run finishes', async () => {
    const { client } = fakeClient();
    await runCodingJob(makeAssignment(), makeContext(), {
      client,
      skipPush: true,
      sandbox,
      agentFactory: () => new MockCodingAgent({}),
    });
    expect(sandbox.closed).toBe(1);
  }, 180_000);

  it("routes the project's own test command through the sandbox, not just the agent", async () => {
    const { client } = fakeClient();

    await runCodingJob(makeAssignment(), makeContext(), {
      client,
      skipPush: true,
      sandbox,
      agentFactory: () => new MockCodingAgent({}),
    });

    /*
     * The non-obvious half of the boundary. `npm test` executes code the agent
     * has just written, so a sandbox that covered the agent but not its test
     * run would leave the widest hole open while claiming it was closed.
     */
    expect(sandbox.spawns.length).toBeGreaterThan(0);
    expect(sandbox.spawns.some((s) => s.executable === process.execPath)).toBe(true);
  }, 180_000);
});
