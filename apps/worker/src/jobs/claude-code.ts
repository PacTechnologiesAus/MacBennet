import path from 'node:path';
import {
  codingTaskSchema,
  type AgentEvent,
  type CodingAgent,
  type CodingAssignment,
  type CodingTask,
  type ReviewEvidence,
  type RunAssignment,
} from '@mac/protocol';
import type { ControlPlaneClient } from '../client.js';
import { GitRunner, ProhibitedGitOperation } from '../git/git-runner.js';
import { WorktreeManager, initialPolicy } from '../git/worktree.js';
import { buildGitShim, readShimViolations, resolveRealGit } from '../git/shim.js';
import { ClaudeCodeAdapter } from '../coding/claude-code-adapter.js';
import { MockCodingAgent } from '../coding/mock-agent.js';
import { GhPullRequestGateway, type PullRequestGateway } from '../coding/pull-request.js';
import { NOT_RUN, runProjectCommand, type CommandResult } from '../testing/test-runner.js';
import {
  buildSandboxPlan,
  resolveSandbox,
  SandboxPlanError,
  SandboxUnavailable,
  type ExecutionSandbox,
  type SandboxSession,
} from '../sandbox/index.js';
import type { JobContext, JobResult } from './index.js';

/**
 * The coding job — Sprint 2's whole reason for existing.
 *
 * The sequence, and why it is in this order:
 *
 *   1. worktree      isolate before anything can write
 *   2. sandbox       establish the OS boundary BEFORE anything runs inside it
 *   3. shim          install the git guard BEFORE the agent starts
 *   4. session       delegate implementation, supervising every question
 *   5. commit        capture anything the agent left uncommitted
 *   6. test          run the project's own tests and read the result
 *   7. verify        confirm the default branch did not move
 *   8. review        submit facts; Mac returns the verdict
 *   9. push + PR     only if Mac decided one is warranted
 *  10. preserve      leave the worktree unless the work is finished and clean
 *
 * Steps 3 and 7 are the two halves of the git safety argument: prevent the
 * command, then verify the effect. Neither alone would be enough.
 *
 * Step 2 is Sprint 3's addition and it is FAIL-CLOSED: if the sandbox cannot be
 * established, the run fails with `sandbox_unavailable` and the worktree is
 * preserved. There is deliberately no path that falls back to running the agent
 * unconfined — a boundary that silently turns itself off is worse than one that
 * was never claimed.
 *
 * Note which steps run INSIDE the sandbox: the agent (step 4) and the project's
 * own test and build command (step 6). Everything else is Mac's own code acting
 * on his own intent, and the control-plane credential must never sit inside the
 * boundary with something that executes agent-authored code.
 */

export interface CodingJobDependencies {
  client: ControlPlaneClient;
  /** Overridable so tests can inject a mock agent and a recording PR gateway. */
  agentFactory?: (assignment: CodingAssignment) => CodingAgent;
  pullRequestGateway?: PullRequestGateway;
  /** Skips the real `gh`/`git push` when running against a local test remote. */
  skipPush?: boolean;
  /**
   * Test seam for the containment boundary.
   *
   * Supplying a sandbox here lets a test assert that the job builds a valid
   * plan and routes the agent and the test command through the session, without
   * needing a container image that happens to carry Node and git. The real
   * providers are proven separately, against real filesystems, by the sandbox
   * conformance suite.
   */
  sandbox?: ExecutionSandbox | null;
  /** Overrides the worker's configured sandbox settings. Tests only. */
  sandboxOptions?: {
    provider?: 'auto' | 'bubblewrap' | 'docker' | 'none';
    image?: string;
    toolingMounts?: string[];
    credentialMounts?: string[];
    agentEnv?: Record<string, string>;
    nodePath?: string;
    gitPath?: string;
    uid?: number;
    gid?: number;
    workerStateFile?: string;
  };
}

export async function runCodingJob(
  assignment: RunAssignment,
  ctx: JobContext,
  deps: CodingJobDependencies,
): Promise<JobResult> {
  const coding = assignment.coding;
  if (!coding) {
    throw new Error('This run has no coding assignment. The control plane did not resolve a repository.');
  }

  const { client } = deps;
  const runId = assignment.runId;
  const workspaceRoot = path.resolve(ctx.workspace);

  // --- 1. Isolated worktree ------------------------------------------------

  const violations: Array<{ code: string; argv: string[]; message: string; origin: 'mac' | 'agent' }> = [];

  const reportViolation = async (v: { code: string; argv: string[]; message: string; origin: 'mac' | 'agent' }) => {
    violations.push(v);
    ctx.log(`REFUSED prohibited git operation (${v.code}): git ${v.argv.join(' ')}`, 'stderr');
    await client
      .reportGitViolation(runId, { code: v.code, argv: v.argv, message: v.message, origin: v.origin, at: new Date().toISOString() })
      .catch(() => undefined);
  };

  const git = new GitRunner({
    cwd: coding.localPath,
    // Mac may push, but only into his own namespace — the policy enforces that.
    policy: initialPolicy(coding.defaultBranch, true),
    signal: ctx.signal,
    onViolation: (v) => reportViolation({ ...v, origin: 'mac' }),
  });

  const worktrees = new WorktreeManager(git);

  await ctx.progress('preparing_worktree', 5);
  const setup = await worktrees.prepare({
    repositoryPath: coding.localPath,
    workspaceRoot,
    runId,
    branch: coding.branch,
    defaultBranch: coding.defaultBranch,
    remoteName: coding.remoteName,
    log: (message) => ctx.log(message, 'system'),
  });

  await client.reportWorktree(runId, {
    path: setup.path,
    branch: setup.branch,
    baseBranch: setup.baseBranch,
    baseSha: setup.baseSha,
    headSha: setup.baseSha,
    commitCount: 0,
    status: 'active',
  });

  // The worktree is preserved unless this flips. Every failure path below
  // leaves it as it is, which is the point: do not destroy reviewable work.
  let removeWorktree = false;
  let sandboxSession: SandboxSession | null = null;

  try {
    // --- 2. The execution sandbox, established before anything runs --------

    await ctx.progress('opening_sandbox', 7);
    const sandboxOpts = deps.sandboxOptions ?? {};
    const scratchDir = path.join(workspaceRoot, 'scratch', runId);
    const shimHostDir = path.join(workspaceRoot, 'shims', runId);
    await fsMkdir(scratchDir);

    const resolution = deps.sandbox
      ? { kind: deps.sandbox.kind, sandbox: deps.sandbox, available: true, version: null, detail: null }
      : await resolveSandbox({
          provider: sandboxOpts.provider ?? 'auto',
          ...(sandboxOpts.image ? { image: sandboxOpts.image } : {}),
        });

    if (coding.sandbox.required && !resolution.available) {
      const reason =
        `This run requires an OS-enforced sandbox and none is available on this worker. ${resolution.detail ?? ''}`.trim();
      // Audited before throwing, so the refusal is a durable, queryable fact
      // rather than something a reviewer has to infer from a failed run.
      await client
        .reportRunSandbox(runId, {
          sandbox: {
            established: false,
            kind: resolution.kind,
            version: resolution.version,
            mounts: [],
            network: 'none',
            refusalReason: reason,
          },
        })
        .catch(() => undefined);
      throw new SandboxUnavailable(resolution.kind, reason);
    }

    if (resolution.sandbox) {
      const plan = buildSandboxPlan({
        worktreePath: setup.path,
        repositoryGitDir: path.join(coding.localPath, '.git'),
        repositoryPath: coding.localPath,
        workspaceRoot,
        shimDir: shimHostDir,
        scratchDir,
        ...(sandboxOpts.toolingMounts ? { toolingMounts: sandboxOpts.toolingMounts } : {}),
        // The agent's OWN provider credential, and nothing else. Both are
        // read-only, both are recorded in the plan, and both are refused by the
        // plan builder if they name the worker's or the control plane's secrets.
        // Without these the sandbox environment is empty and no real coding
        // agent can authenticate inside it.
        ...(sandboxOpts.credentialMounts?.length ? { credentialMounts: sandboxOpts.credentialMounts } : {}),
        ...(sandboxOpts.agentEnv && Object.keys(sandboxOpts.agentEnv).length
          ? { extraEnv: sandboxOpts.agentEnv }
          : {}),
        // The coding agent must reach its model API; the test command must not,
        // unless the repository was explicitly configured to allow it.
        network: 'egress',
        kind: resolution.kind,
        ...(sandboxOpts.image ? { image: sandboxOpts.image } : {}),
        maxMinutes: coding.task.limits.maxMinutes,
        ...(sandboxOpts.uid !== undefined && sandboxOpts.gid !== undefined
          ? { user: { uid: sandboxOpts.uid, gid: sandboxOpts.gid } }
          : {}),
        ...(sandboxOpts.workerStateFile ? { workerStateFile: sandboxOpts.workerStateFile } : {}),
      });

      sandboxSession = await resolution.sandbox.open(plan);
      ctx.log(
        `Execution sandbox open (${resolution.kind}${resolution.version ? `, ${resolution.version}` : ''}). ` +
          `The coding agent can reach the worktree, this repository's git metadata and its scratch space, ` +
          'and nothing else on this machine.',
        'system',
      );

      await client
        .reportRunSandbox(runId, {
          sandbox: {
            established: true,
            kind: resolution.kind,
            version: resolution.version,
            // Purposes and modes, not host paths: what a reviewer needs is what
            // KIND of thing was reachable and whether it was writable.
            mounts: plan.mounts.map((m) => ({ purpose: m.purpose, mode: m.mode })),
            network: plan.network,
            refusalReason: null,
          },
        })
        .catch(() => undefined);
    } else {
      ctx.log(
        'WARNING: no execution sandbox. This run was permitted to proceed unconfined because the control ' +
          'plane did not require containment for it.',
        'stderr',
      );
    }

    // --- 3. The git shim, installed before the agent can run anything ------

    await ctx.progress('installing_git_guard', 9);
    const realGit = await resolveRealGit();
    const shim = await buildGitShim({
      directory: shimHostDir,
      realGitPath: realGit,
      policy: { defaultBranch: coding.defaultBranch, currentBranch: coding.branch, allowPush: false },
      // Outside the shim directory, which the sandbox mounts read-only so the
      // agent cannot rewrite the policy it is being judged by.
      violationsFile: path.join(scratchDir, 'git-violations.jsonl'),
      ...(sandboxSession
        ? {
            sandbox: {
              binDir: sandboxSession.pathFor(shimHostDir),
              scratchDir: sandboxSession.pathFor(scratchDir),
              nodePath: sandboxOpts.nodePath ?? DEFAULT_SANDBOX_NODE,
              realGitPath: sandboxOpts.gitPath ?? DEFAULT_SANDBOX_GIT,
            },
          }
        : {}),
    });
    ctx.log(`Git guard installed at ${shim.binDir}; the coding agent cannot merge, push or force-push.`, 'system');

    // --- 4. The coding session ---------------------------------------------

    const task: CodingTask = codingTaskSchema.parse({
      ...coding.task,
      runId,
      taskId: assignment.taskId,
      worktreePath: setup.path,
      branch: setup.branch,
      baseBranch: setup.baseBranch,
    });

    const agent =
      deps.agentFactory?.(coding) ??
      (coding.provider === 'mock'
        ? new MockCodingAgent()
        : new ClaudeCodeAdapter({
            shimBinDir: sandboxSession ? sandboxSession.pathFor(shim.binDir) : shim.binDir,
            idleTimeoutMs: task.limits.maxMinutes * 60_000,
            ...(sandboxSession
              ? { spawner: sandboxSession.spawner as never, workdir: sandboxSession.pathFor(setup.path) }
              : {}),
          }));

    const availability = await agent.isAvailable();
    if (!availability.available) {
      throw new CodingAgentUnavailable(availability.reason ?? 'The coding agent is not available on this worker.');
    }

    // Usage before. It may well be `unavailable`; that is reported honestly
    // rather than filled in with a zero.
    const before = await agent.usageSnapshot('before').catch(() => null);
    if (before) await client.reportUsage(runId, { snapshot: before }).catch(() => undefined);

    await ctx.progress('coding', 15);

    const pendingEvents: AgentEvent[] = [];
    let flushing: Promise<void> = Promise.resolve();

    const flushEvents = async () => {
      if (pendingEvents.length === 0) return;
      const batch = pendingEvents.splice(0, 200);
      await client
        .sendAgentEvents(runId, { sessionId: `${coding.provider}-${runId}`, provider: agent.provider, events: batch })
        .catch((err) => {
          // Losing an activity update must not fail a coding run; the events are
          // commentary, and the durable record is the commit and the review.
          ctx.log(`Could not upload ${batch.length} agent event(s): ${(err as Error).message}`, 'stderr');
        });
    };

    const handle = await agent.start(task, {
      onEvent: (event) => {
        pendingEvents.push(event);
        if (event.type === 'progress') void ctx.progress(event.stage.slice(0, 120));
        if (pendingEvents.length >= 25) flushing = flushing.then(flushEvents);
      },
      /*
       * The worker does NOT answer. It asks Mac and applies what comes back,
       * which is what keeps every decision made during an autonomous run in the
       * control plane where it is persisted, audited and reviewable.
       */
      onQuestion: async (question) => {
        await flushEvents();
        ctx.log(`Coding agent asked: ${question.question.slice(0, 300)}`, 'system');
        const response = await client.askQuestion(runId, {
          questionId: question.questionId,
          question: question.question,
          ...(question.context ? { context: question.context } : {}),
        });
        ctx.log(
          `Mac answered (${response.answer.decision}, ${(response.answer.confidence * 100).toFixed(0)}% confidence).`,
          'system',
        );
        return response.answer;
      },
      signal: ctx.signal,
    });

    await client
      .startAgentSession(runId, {
        provider: agent.provider,
        providerSessionId: handle.providerSessionId,
        ...(availability.version ? { providerVersion: availability.version } : {}),
      })
      .catch(() => undefined);

    const result = await handle.finished;
    await flushing;
    await flushEvents();

    if (result.usage) await client.reportUsage(runId, { snapshot: result.usage }).catch(() => undefined);

    // Refusals the shim caught, uploaded as security events.
    for (const violation of await readShimViolations(path.join(scratchDir, 'git-violations.jsonl'))) {
      await reportViolation({ ...violation, origin: 'agent' });
    }

    if (result.state === 'cancelled' || ctx.signal.aborted) {
      await preserve(client, runId, worktrees, setup, 'cancelled');
      return { summary: 'The coding session was cancelled. The worktree and any commits have been preserved.' };
    }

    // --- 4. Capture anything left uncommitted ------------------------------

    await ctx.progress('committing', 60);
    await commitLeftovers(git, worktrees, setup, ctx, task);

    // --- 5. Tests and build ------------------------------------------------

    let tests: CommandResult = NOT_RUN;
    let build: CommandResult = NOT_RUN;

    /*
     * The project's own commands run INSIDE the sandbox too.
     *
     * This is the non-obvious half of the boundary and arguably the more
     * important one: `npm test` executes code the agent has just written.
     * Sandboxing the agent but not its test run would leave the widest hole
     * open while claiming it had been closed.
     */
    const sandboxedCwd = sandboxSession ? sandboxSession.pathFor(setup.path) : setup.path;
    const commandOptions = {
      cwd: sandboxedCwd,
      signal: ctx.signal,
      timeoutMs: Math.min(task.limits.maxMinutes, 30) * 60_000,
      ...(sandboxSession ? { spawner: sandboxSession.spawner } : {}),
    };

    if (task.testCommand.length) {
      await ctx.progress('testing', 70);
      ctx.log(`Running tests: ${task.testCommand.join(' ')}`, 'system');
      tests = await runProjectCommand(task.testCommand, commandOptions);
      ctx.log(`Tests ${tests.passed ? 'passed' : `FAILED (exit ${tests.exitCode})`}.`, tests.passed ? 'system' : 'stderr');
    } else {
      ctx.log('No test command is configured for this repository; none was run.', 'system');
    }

    if (task.buildCommand.length) {
      await ctx.progress('building', 78);
      build = await runProjectCommand(task.buildCommand, commandOptions);
    }

    // --- 6. Verify the default branch did not move -------------------------

    await ctx.progress('verifying_git', 82);
    const verification = await worktrees.verifyDefaultBranchUnchanged({
      repositoryPath: coding.localPath,
      remoteName: coding.remoteName,
      defaultBranch: coding.defaultBranch,
      expectedSha: setup.baseSha,
    });

    if (!verification.unchanged) {
      ctx.log(
        `The default branch "${coding.defaultBranch}" moved during this run (expected ${setup.baseSha.slice(0, 8)}, found ${
          verification.actualSha?.slice(0, 8) ?? 'nothing'
        }). This must be investigated.`,
        'stderr',
      );
    }

    // --- 7. Self-review: submit facts, receive the verdict -----------------

    await ctx.progress('self_review', 88);
    const evidence = await collectEvidence({
      worktrees,
      setup,
      result,
      tests,
      build,
      verification,
      violationCount: violations.length,
    });

    const verdict = await client.submitReview(runId, { evidence });
    ctx.log(
      `Mac's self-review: ${verdict.verdict}, risk ${verdict.riskLevel}. ` +
        (verdict.pullRequest.shouldOpen ? 'Opening a pull request.' : `No pull request: ${verdict.pullRequest.reason}`),
      'system',
    );
    for (const anomaly of verdict.anomalies) ctx.log(`Anomaly: ${anomaly}`, 'stderr');

    // --- 8. Push and open the pull request, if Mac decided one is warranted -

    let pullRequestUrl: string | null = null;

    if (verdict.pullRequest.shouldOpen && !deps.skipPush) {
      await ctx.progress('opening_pull_request', 94);
      try {
        // Mac pushes. The agent never did and never could.
        await worktrees.pushTaskBranch({
          worktreePath: setup.path,
          remoteName: coding.remoteName,
          branch: setup.branch,
        });

        const gateway = deps.pullRequestGateway ?? new GhPullRequestGateway();
        const availability = await gateway.isAvailable();
        if (!availability.available) {
          ctx.log(`Branch pushed, but no pull request was opened: ${availability.reason}`, 'stderr');
        } else {
          const pr = await gateway.create({
            worktreePath: setup.path,
            title: verdict.pullRequest.title,
            body: verdict.pullRequest.body,
            head: setup.branch,
            base: verdict.pullRequest.base,
          });
          pullRequestUrl = pr.url;
          await client.reportPullRequest(runId, {
            number: pr.number,
            url: pr.url,
            title: verdict.pullRequest.title,
            branch: setup.branch,
            baseBranch: verdict.pullRequest.base,
            provider: gateway.provider,
          });
          ctx.log(`Pull request opened: ${pr.url}. Mac will not merge it.`, 'system');
        }
      } catch (err) {
        if (err instanceof ProhibitedGitOperation) {
          ctx.log(`Push refused by the git policy: ${err.message}`, 'stderr');
        } else {
          ctx.log(`Could not open a pull request: ${(err as Error).message}`, 'stderr');
        }
      }
    } else if (deps.skipPush && verdict.pullRequest.shouldOpen) {
      ctx.log('Pull-request creation was skipped for this run (no remote configured).', 'system');
    }

    // --- 9. Preserve or release --------------------------------------------

    // Removal requires everything to be finished AND reviewable. Anything less
    // preserves, so a human always has the work to look at.
    removeWorktree =
      pullRequestUrl !== null && !verdict.humanAttentionRequired && verdict.verdict === 'satisfies_brief';

    await preserve(client, runId, worktrees, setup, removeWorktree ? 'removed' : 'preserved', removeWorktree ? coding.localPath : undefined);

    await ctx.progress('complete', 100);

    const summaryParts = [
      result.summary || 'The coding agent completed.',
      `${evidence.commits.length} commit(s), ${evidence.diffStat.files} file(s) changed.`,
      tests.ran ? `Tests ${tests.passed ? 'passed' : 'FAILED'}.` : 'No tests configured.',
      pullRequestUrl ? `Pull request: ${pullRequestUrl}` : `No pull request: ${verdict.pullRequest.shouldOpen ? 'creation failed' : verdict.pullRequest.reason}`,
    ];

    if (result.state === 'failed') {
      throw new Error(`${result.error ?? 'The coding agent failed.'} ${summaryParts.join(' ')}`);
    }

    return { summary: summaryParts.join(' ') };
  } catch (err) {
    // Every failure path preserves the worktree. Spec: do not destroy useful
    // work merely because something went wrong.
    await preserve(client, runId, worktrees, setup, 'preserved').catch(() => undefined);

    if (err instanceof SandboxPlanError) {
      // A plan the builder refused is a configuration problem, not a run
      // failure — and it is reported as the refusal it is rather than as an
      // opaque crash, because someone has to go and fix the configuration.
      throw new SandboxUnavailable(
        'none',
        `Refusing to start a coding session: ${err.message} (${err.refusal}: ${err.offendingPath})`,
      );
    }
    throw err;
  } finally {
    await sandboxSession?.close().catch(() => undefined);
  }
}

export class CodingAgentUnavailable extends Error {
  override readonly name = 'CodingAgentUnavailable';
}

/**
 * Where node and git live inside a container image.
 *
 * Overridable, because "which image" is an admin decision and images differ.
 * Under bubblewrap these are never used — the host's own paths are visible
 * inside the sandbox unchanged, which is one of the reasons it is preferred.
 */
const DEFAULT_SANDBOX_NODE = '/usr/local/bin/node';
const DEFAULT_SANDBOX_GIT = '/usr/bin/git';

const fsMkdir = async (dir: string): Promise<void> => {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function preserve(
  client: ControlPlaneClient,
  runId: string,
  worktrees: WorktreeManager,
  setup: { path: string; branch: string; baseBranch: string; baseSha: string },
  status: 'preserved' | 'removed' | 'cancelled',
  repositoryPath?: string,
): Promise<void> {
  const headSha = await worktrees.headSha(setup.path).catch(() => null);
  const commits = await worktrees.commitsSince(setup.path, setup.baseSha).catch(() => []);

  await client
    .reportWorktree(runId, {
      path: setup.path,
      branch: setup.branch,
      baseBranch: setup.baseBranch,
      baseSha: setup.baseSha,
      headSha,
      commitCount: commits.length,
      status: status === 'removed' ? 'removed' : 'preserved',
    })
    .catch(() => undefined);

  if (status === 'removed' && repositoryPath) {
    await worktrees.remove(repositoryPath, setup.path).catch(() => undefined);
  }
}

/**
 * Commits whatever the agent edited but did not commit.
 *
 * A coding agent that edits files and then declares success without committing
 * is one of the commonest ways an autonomous night produces nothing. Capturing
 * the work is better than losing it — and the self-review still reports that it
 * happened, so the human sees that the agent left it behind.
 */
async function commitLeftovers(
  git: GitRunner,
  worktrees: WorktreeManager,
  setup: { path: string; baseSha: string },
  ctx: JobContext,
  task: CodingTask,
): Promise<void> {
  const uncommitted = await worktrees.uncommittedFiles(setup.path);
  if (uncommitted.length === 0) return;

  ctx.log(`The coding agent left ${uncommitted.length} file(s) uncommitted; committing them so they are not lost.`, 'system');
  await git.run(['add', '-A'], { cwd: setup.path });
  await git.run(
    ['commit', '-m', `chore: capture uncommitted work for "${task.brief.title}"`.slice(0, 200)],
    { cwd: setup.path, allowFailure: true },
  );
}

async function collectEvidence(params: {
  worktrees: WorktreeManager;
  setup: { path: string; baseSha: string };
  result: { summary: string; state: string };
  tests: CommandResult;
  build: CommandResult;
  verification: { unchanged: boolean; actualSha: string | null };
  violationCount: number;
}): Promise<ReviewEvidence> {
  const { worktrees, setup } = params;

  const [commits, filesChanged, uncommittedFiles, diffSample] = await Promise.all([
    worktrees.commitsSince(setup.path, setup.baseSha),
    worktrees.changedFiles(setup.path, setup.baseSha),
    worktrees.uncommittedFiles(setup.path),
    worktrees.diffSample(setup.path, setup.baseSha),
  ]);

  const diffStat = filesChanged.reduce(
    (acc, f) => ({
      files: acc.files + 1,
      insertions: acc.insertions + f.insertions,
      deletions: acc.deletions + f.deletions,
    }),
    { files: 0, insertions: 0, deletions: 0 },
  );

  return {
    agentSummary: params.result.summary.slice(0, 8000),
    agentReportedSuccess: params.result.state === 'completed',
    filesChanged: filesChanged.slice(0, 1000),
    uncommittedFiles,
    commits: commits.slice(0, 200),
    diffStat,
    diffSample,
    tests: params.tests.ran ? params.tests : null,
    build: params.build.ran ? { ran: true, command: params.build.command, exitCode: params.build.exitCode, passed: params.build.passed, output: params.build.output } : null,
    dependencyChanges: filesChanged.map((f) => f.path).filter(isDependencyManifest),
    configurationChanges: filesChanged.map((f) => f.path).filter(isConfiguration),
    migrations: filesChanged.map((f) => f.path).filter(isMigration),
    defaultBranchUnchanged: params.verification.unchanged,
    defaultBranchSha: params.verification.actualSha,
    prohibitedOperationsAttempted: params.violationCount,
  };
}

const DEPENDENCY_MANIFESTS = [
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'requirements.txt', 'pyproject.toml', 'poetry.lock', 'Pipfile', 'Pipfile.lock',
  'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock', 'Gemfile', 'Gemfile.lock',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'composer.lock',
];

const isDependencyManifest = (file: string): boolean => DEPENDENCY_MANIFESTS.includes(path.basename(file));

const isMigration = (file: string): boolean =>
  /(^|\/)(migrations?|drizzle|alembic|db\/migrate)(\/|$)/i.test(file) && /\.(sql|ts|js|py|rb)$/i.test(file);

const isConfiguration = (file: string): boolean => {
  const base = path.basename(file).toLowerCase();
  if (isDependencyManifest(file)) return false;
  return (
    /^(dockerfile|docker-compose\.ya?ml|\.env(\..+)?|.*\.config\.(ts|js|mjs|cjs|json)|tsconfig.*\.json|\.github\/.*)$/.test(base) ||
    /^\.github\//.test(file) ||
    /(^|\/)(config|conf)(\/|$)/i.test(file)
  );
};
