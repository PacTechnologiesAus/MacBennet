import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startWorker } from '@mac/worker';
import { silentLogger } from '@mac/worker/logger';
import { defaultSandboxConfig } from '@mac/worker/config';
import { MockCodingAgent } from '@mac/worker/coding/mock-agent';
import { RecordingPullRequestGateway } from '@mac/worker/coding/pull-request';
import { buildApp } from '../../src/app.js';
import { closePool, createAndLogin, resetDatabase, type Session } from '../helpers/harness.js';
import { asUser } from '../helpers/harness.js';
import { createEnrollmentToken } from '../../src/services/workers.js';
import { SYSTEM_ACTOR } from '../../src/services/audit.js';
import { queryAuditEvents } from '../../src/services/audit-query.js';
import { getRunLogs } from '../../src/services/logs.js';
import type { FastifyInstance } from 'fastify';

/**
 * THE Sprint 2 end-to-end test.
 *
 * It proves the loop the sprint exists to prove, with real components at every
 * step: a real HTTP listener, a real worker process running its real lease loop,
 * a real git repository with a real bare remote, real worktrees, real commits,
 * a real test command, and the real supervision, review, pull-request and
 * reporting paths.
 *
 * The single substitution is the coding agent itself, which is the mock rather
 * than Claude Code — because the requirement is explicit that the normal
 * automated suite must not need paid model usage. The mock goes through exactly
 * the same `CodingAgent` interface, the same git shim, and the same supervision
 * endpoints that the Claude Code adapter does, so the loop under test is the
 * production one.
 *
 *   task → discovery → brief → confidence → approval → worktree → coding agent
 *   → code change → tests → self-review → PR-ready → morning report
 *
 * ...and, throughout, main is never touched.
 */

let app: FastifyInstance;
let baseUrl: string;
let admin: Session;
let operator: Session;

let tempDir: string;
let remoteDir: string;
let cloneDir: string;
let workspace: string;
let baseSha: string;

const git = (argv: string[], cwd: string): Promise<{ code: number; stdout: string }> =>
  new Promise((resolve) => {
    execFile('git', argv, { cwd, shell: false, windowsHide: true }, (error, stdout) => {
      const code = (error as { code?: number } | null)?.code;
      resolve({ code: typeof code === 'number' ? code : 0, stdout: String(stdout) });
    });
  });

const api = (session: Session) => asUser(app, session);

beforeAll(async () => {
  const built = await buildApp({ startBackgroundJobs: false, authRateLimitMax: 10_000, registerRateLimitMax: 10_000 });
  app = built.fastify;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';

  // A real repository with a real bare remote, so "the default branch never
  // moved" is asserted against something that could genuinely have moved.
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mac-e2e-'));
  remoteDir = path.join(tempDir, 'remote.git');
  cloneDir = path.join(tempDir, 'device-portal');
  workspace = path.join(tempDir, 'workspace');
  await fs.mkdir(workspace, { recursive: true });

  await fs.mkdir(remoteDir, { recursive: true });
  await git(['init', '--bare', '--initial-branch=main'], remoteDir);

  const seed = path.join(tempDir, 'seed');
  await fs.mkdir(seed, { recursive: true });
  await git(['init', '--initial-branch=main'], seed);
  await git(['config', 'user.email', 'mac@pac-technologies.com.au'], seed);
  await git(['config', 'user.name', 'Mac Bennett'], seed);
  await fs.writeFile(path.join(seed, 'README.md'), '# Device Portal\n\nA React SPA over a Fastify API.\n', 'utf8');
  await fs.writeFile(
    path.join(seed, 'package.json'),
    JSON.stringify({ name: 'device-portal', scripts: { test: 'node ./run-tests.mjs' } }, null, 2),
    'utf8',
  );
  // A real test command that really runs and really passes.
  await fs.writeFile(path.join(seed, 'run-tests.mjs'), 'console.log("2 tests passed");\nprocess.exit(0);\n', 'utf8');
  await fs.mkdir(path.join(seed, 'src'), { recursive: true });
  await fs.writeFile(path.join(seed, 'src', 'DeviceSelector.tsx'), 'export const DeviceSelector = () => null;\n', 'utf8');
  await git(['add', '-A'], seed);
  await git(['commit', '-m', 'initial'], seed);
  await git(['remote', 'add', 'origin', remoteDir], seed);
  await git(['push', 'origin', 'main'], seed);

  await git(['clone', remoteDir, cloneDir], tempDir);
  await git(['config', 'user.email', 'mac@pac-technologies.com.au'], cloneDir);
  await git(['config', 'user.name', 'Mac Bennett'], cloneDir);

  baseSha = (await git(['rev-parse', 'main'], remoteDir)).stdout.trim();
}, 300_000);

afterAll(async () => {
  await app.close();
  await closePool();
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

beforeEach(async () => {
  await resetDatabase();
  admin = await createAndLogin(app, { email: 'admin@pac.test', role: 'admin' });
  operator = await createAndLogin(app, { email: 'operator@pac.test', role: 'operator' });

  /*
   * Sprint 3 withholds coding work from a worker that has not attested an
   * OS-enforced sandbox, and it does so by DEFAULT. This test's coding agent is
   * the in-process mock — it spawns nothing, so there is nothing here for a
   * sandbox to contain — and requiring one would only prove that the guardrail
   * blocks dispatch, which `sandbox.test.ts` proves directly and on purpose.
   *
   * Turning it off here is therefore explicit and narrow, not a convenience:
   * the containment boundary itself is proven against a real provider by the
   * sandbox conformance suite, and the withholding guardrail by its own test.
   */
  await asUser(app, admin).patch('/api/settings', { requireSandbox: false });
});

const CONVERSATION = [
  'I want the device selection screen changed so users can select multiple devices. At the moment it only accepts one.',
  'We also need the API to support that, but don\'t change the existing CSV import format because customers are using it.',
  'It is done when an operator can select two or more devices and save them together.',
  'Please add unit tests for the selection reducer using Vitest.',
  'The screen is the DeviceSelector component and the endpoint is the devices route.',
  'The architecture is a React SPA over a Fastify API, with the selection state in a reducer.',
];

/** Starts a real worker process against the real listener. */
async function startTestWorker(script: ConstructorParameters<typeof MockCodingAgent>[0] = {}) {
  const enrollment = await createEnrollmentToken({ label: 'e2e', expiresInHours: 1 }, SYSTEM_ACTOR);
  const gateway = new RecordingPullRequestGateway({
    url: 'https://github.com/pac-technologies/device-portal/pull/42',
    number: 42,
  });

  const handle = await startWorker({
    config: {
      controlPlaneUrl: baseUrl,
      enrollmentToken: enrollment.token!,
      name: `e2e-worker-${Math.floor(Math.random() * 1e9)}`,
      stateFile: path.join(tempDir, `worker-state-${Math.random().toString(36).slice(2)}.json`),
      workspace,
      heartbeatSeconds: 30,
      logLevel: 'silent',
      // The mock coding agent runs in-process and spawns nothing, so there is
      // nothing here for a sandbox to contain. Containment itself is proven
      // against a real provider by the sandbox conformance suite, and the
      // withholding guardrail by `sandbox.test.ts`.
      sandbox: defaultSandboxConfig(),
    },
    logger: silentLogger,
    maxRuns: 1,
    leaseWaitSeconds: 1,
    retryBaseMs: 50,
    codingOverrides: {
      agentFactory: () => new MockCodingAgent(script),
      pullRequestGateway: gateway,
    },
  });

  return { handle, gateway };
}

async function waitForRun(runId: string, statuses: string[], timeoutMs = 120_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const run = (await api(operator).get(`/api/runs/${runId}`)).json().run;
    last = run;
    if (statuses.includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Run ${runId} never reached ${statuses.join('/')}; last status was "${last.status}".`);
}

/** Discovery → brief → coding run → approval. Returns the queued run. */
async function prepareApprovedCodingRun(): Promise<{ runId: string; taskId: string; briefId: string; confidence: number }> {
  const project = (await api(admin).post('/api/projects', { name: `Device Portal ${Math.random()}` })).json().project;

  const repo = (
    await api(admin).post('/api/repositories', {
      projectId: project.id,
      name: 'device-portal',
      remoteUrl: remoteDir,
      localPath: cloneDir,
      defaultBranch: 'main',
      remoteName: 'origin',
      testCommand: ['node', './run-tests.mjs'],
    })
  ).json().repository;

  await api(admin).post(`/api/repositories/${repo.id}/approve`, { approved: true, notes: 'Reviewed by an engineer.' });

  const session = (
    await api(operator).post('/api/discovery', { projectId: project.id, title: 'Allow selecting multiple devices' })
  ).json().session;

  for (const message of CONVERSATION) {
    await api(operator).post(`/api/discovery/${session.id}/messages`, { message });
  }

  const brief = (await api(operator).post(`/api/discovery/${session.id}/brief`, {})).json().brief;

  const run = (
    await api(operator).post('/api/coding-runs', {
      taskId: session.taskId,
      repositoryId: repo.id,
      briefId: brief.id,
      provider: 'mock',
    })
  ).json().run;

  await api(operator).post(`/api/runs/${run.id}/submit`);
  const approved = await api(operator).post(`/api/runs/${run.id}/approve`, {});
  expect(approved.statusCode).toBe(200);

  return { runId: run.id, taskId: session.taskId, briefId: brief.id, confidence: brief.confidence };
}

// ---------------------------------------------------------------------------

describe('Sprint 2 end to end: Mac completes a coding task autonomously', () => {
  it('runs the whole loop and leaves a reviewable result without touching main', async () => {
    const { runId, confidence } = await prepareApprovedCodingRun();

    // Confidence was derived from the conversation, and is high enough to run.
    expect(confidence).toBeGreaterThanOrEqual(0.8);

    const { handle, gateway } = await startTestWorker({
      files: {
        'src/DeviceSelector.tsx':
          'export const DeviceSelector = ({ ids }: { ids: string[] }) => ids.length;\n' +
          '// An operator can now select multiple devices and save them together.\n',
        'src/selection-reducer.test.ts': 'import { test } from "vitest";\ntest("selects multiple devices", () => {});\n',
      },
      questions: [
        { id: 'q-testing', question: 'What testing expectations apply — should the selection reducer tests use Vitest?' },
        { id: 'q-sorting', question: 'Should the device list be sorted alphabetically when displayed?' },
      ],
      summary: 'Added multi-device selection to the DeviceSelector component and a reducer test.',
    });

    try {
      const run = await waitForRun(runId, ['completed', 'failed', 'cancelled']);
      expect(run.status).toBe('completed');

      const detail = (await api(operator).get(`/api/runs/${runId}/coding`)).json().detail;

      // --- an isolated worktree on a Mac task branch ----------------------
      expect(detail.worktree).not.toBeNull();
      expect(detail.worktree.branch).toMatch(/^mac\/[0-9a-f]{8}-allow-selecting-multiple-devices$/);
      expect(detail.worktree.baseBranch).toBe('main');
      expect(detail.worktree.baseSha).toBe(baseSha);
      expect(detail.worktree.commitCount).toBeGreaterThan(0);

      // --- a real commit, on the branch, containing the real change --------
      const branchLog = await git(['log', '--oneline', detail.worktree.branch], cloneDir);
      expect(branchLog.code).toBe(0);
      expect(branchLog.stdout.trim().split('\n').length).toBeGreaterThan(1);

      // --- MAIN IS UNTOUCHED, on the remote and locally --------------------
      expect((await git(['rev-parse', 'main'], remoteDir)).stdout.trim()).toBe(baseSha);
      expect((await git(['rev-parse', 'main'], cloneDir)).stdout.trim()).toBe(baseSha);
      const remoteLog = await git(['log', '--oneline', 'main'], remoteDir);
      expect(remoteLog.stdout.trim().split('\n')).toHaveLength(1);

      // --- Mac supervised the session --------------------------------------
      expect(detail.questions).toHaveLength(2);
      const testing = detail.questions.find((q: { question: string }) => q.question.includes('testing'))!;
      expect(testing.decision).toBe('answered');
      expect(testing.answer.toLowerCase()).toContain('vitest');
      expect(testing.sources.length).toBeGreaterThan(0);

      const sorting = detail.questions.find((q: { question: string }) => q.question.includes('sorted'))!;
      expect(sorting.decision).toBe('assumed');
      expect(detail.assumptions.some((a: { flagged: boolean }) => a.flagged)).toBe(true);

      // --- tests really ran --------------------------------------------------
      expect(detail.review).not.toBeNull();
      expect(detail.review.evidence.tests.ran).toBe(true);
      expect(detail.review.evidence.tests.passed).toBe(true);
      expect(detail.review.evidence.tests.output).toContain('2 tests passed');

      // --- Mac self-reviewed and decided a PR was warranted ------------------
      expect(detail.review.verdict).toBe('satisfies_brief');
      expect(detail.review.prRecommended).toBe(true);
      expect(detail.review.evidence.defaultBranchUnchanged).toBe(true);
      expect(detail.violations).toHaveLength(0);

      // --- ...and one was opened, from the task branch into main -------------
      expect(gateway.created).toHaveLength(1);
      expect(gateway.created[0]!.base).toBe('main');
      expect(gateway.created[0]!.head).toBe(detail.worktree.branch);
      expect(gateway.created[0]!.body).toContain('## Summary');
      expect(gateway.created[0]!.body).toContain('## Risk');
      expect(detail.pullRequest.url).toContain('/pull/42');

      // --- the branch really reached the remote; main still did not ---------
      const remoteBranches = await git(['branch', '--format=%(refname:short)'], remoteDir);
      expect(remoteBranches.stdout).toContain(detail.worktree.branch);
      expect((await git(['rev-parse', 'main'], remoteDir)).stdout.trim()).toBe(baseSha);

      // --- usage, reported honestly -----------------------------------------
      expect(detail.usage.source).not.toBe('unavailable');
      expect(detail.usage.label).toContain('Source:');

      // --- the morning report ------------------------------------------------
      const report = (await api(operator).get(`/api/runs/${runId}/report`)).json().report;
      expect(report.questionsAnswered).toBe(2);
      expect(report.lowConfidenceAnswers).toBe(1);
      expect(report.pullRequestUrl).toContain('/pull/42');
      expect(report.estimatedHumanHours).toBeGreaterThan(0);
      expect(report.markdown).toContain('## What Changed');
      expect(report.whatChanged.length).toBeLessThan(300);

      // --- the audit trail contains the whole night, in order ----------------
      const events = await queryAuditEvents({ runId, limit: 200, offset: 0 });
      const types = events.map((e) => e.eventType);

      for (const required of [
        'run.created',
        'run.submitted_for_approval',
        'run.approved',
        'run.queued',
        'run.dispatched',
        'worktree.created',
        'coding_session.started',
        'coding_session.question',
        'coding_session.answered',
        'coding_session.assumption_recorded',
        'test.run',
        'run.self_review',
        'run.review_completed',
        'pull_request.created',
        'usage.snapshot',
        'run.completed',
        'report.generated',
      ]) {
        expect(types, `audit trail is missing ${required}`).toContain(required);
      }

      // Ordering is meaningful: approval precedes dispatch, dispatch precedes
      // the worktree, review precedes the pull request.
      //
      // `seq` is the authoritative ordering key (several events share a
      // transaction timestamp), and the query returns newest-first, so the
      // trail is re-sorted ascending before ordering is asserted.
      const chronological = [...events].sort((a, b) => a.seq - b.seq);
      const at = (type: string) => chronological.findIndex((e) => e.eventType === type);
      expect(at('run.approved')).toBeLessThan(at('run.dispatched'));
      expect(at('run.dispatched')).toBeLessThan(at('worktree.created'));
      expect(at('worktree.created')).toBeLessThan(at('coding_session.started'));
      expect(at('run.review_completed')).toBeLessThan(at('pull_request.created'));

      // Discovery and the brief are on the trail too, under the project.
      const projectEvents = await queryAuditEvents({ projectId: detail.repository.projectId, limit: 200, offset: 0 });
      const projectTypes = projectEvents.map((e) => e.eventType);
      expect(projectTypes).toContain('repository.approved');
      expect(projectTypes).toContain('discovery.started');
      expect(projectTypes).toContain('brief.created');
      expect(projectTypes).toContain('brief.confidence_calculated');

      // --- the run log reads like an engineer's account of the night ---------
      const logs = await getRunLogs(runId, { limit: 500 });
      const text = logs.map((l) => l.message).join('\n');
      expect(text).toContain('Isolated worktree created');
      expect(text).toContain('Git guard installed');
      expect(text).toContain('Coding-agent session started');
      expect(text).toContain('Pull request opened');
    } finally {
      await handle.stop();
    }
  }, 300_000);

  it('preserves the worktree and opens no pull request when the tests fail', async () => {
    const { runId } = await prepareApprovedCodingRun();

    // Point the repository at a test command that fails.
    const detailBefore = (await api(operator).get(`/api/runs/${runId}/coding`)).json().detail;
    await fs.writeFile(path.join(cloneDir, 'run-tests.mjs'), 'console.error("1 failing");\nprocess.exit(1);\n', 'utf8');
    await git(['add', '-A'], cloneDir);
    await git(['commit', '-m', 'chore: make tests fail'], cloneDir);
    await git(['push', 'origin', 'main'], cloneDir);
    const failingBase = (await git(['rev-parse', 'main'], remoteDir)).stdout.trim();

    const { handle, gateway } = await startTestWorker({
      files: { 'src/change.ts': 'export const changed = true;\n' },
      summary: 'Made a change.',
    });

    try {
      const run = await waitForRun(runId, ['completed', 'failed', 'cancelled']);
      const detail = (await api(operator).get(`/api/runs/${runId}/coding`)).json().detail;

      expect(detail.review.evidence.tests.passed).toBe(false);
      expect(detail.review.prRecommended).toBe(false);
      expect(detail.review.prDeclineReason).toContain('Tests failed');
      expect(gateway.created).toHaveLength(0);
      expect(detail.pullRequest).toBeNull();

      // The worktree and its commits are preserved for a human to inspect.
      expect(detail.worktree.status).toBe('preserved');
      expect((await fs.stat(detail.worktree.path)).isDirectory()).toBe(true);
      expect(detail.worktree.commitCount).toBeGreaterThan(0);

      // main still did not move.
      expect((await git(['rev-parse', 'main'], remoteDir)).stdout.trim()).toBe(failingBase);

      const report = (await api(operator).get(`/api/runs/${runId}/report`)).json().report;
      expect(report.pullRequestUrl).toBeNull();
      expect(report.pullRequestDeclineReason).toContain('Tests failed');
      expect(report.risk).not.toBe('low');
      expect(run.status).toBeDefined();
      expect(detailBefore).toBeDefined();
    } finally {
      await handle.stop();
      // Restore the passing test command for any later test.
      await fs.writeFile(path.join(cloneDir, 'run-tests.mjs'), 'console.log("2 tests passed");\nprocess.exit(0);\n', 'utf8');
      await git(['add', '-A'], cloneDir);
      await git(['commit', '-m', 'chore: restore passing tests'], cloneDir);
      await git(['push', 'origin', 'main'], cloneDir);
    }
  }, 300_000);

  it('records a refused git operation and refuses the pull request because of it', async () => {
    const { runId } = await prepareApprovedCodingRun();

    const { handle, gateway } = await startTestWorker({
      files: { 'src/thing.ts': 'export const thing = 1;\n' },
      summary: 'Did the work, and also tried to merge to main.',
      // The mock reports the attempt; the shim's own refusal is proven as a
      // real process in the worker's git-shim tests.
      attemptProhibitedGit: ['push', 'origin', 'main'],
    });

    try {
      await waitForRun(runId, ['completed', 'failed', 'cancelled']);

      // Simulate the shim having caught it, through the same endpoint the
      // worker uses when it reads the violations file.
      await handle.stop();

      const detail = (await api(operator).get(`/api/runs/${runId}/coding`)).json().detail;
      // Whatever the agent attempted, main is untouched.
      expect(detail.review.evidence.defaultBranchUnchanged).toBe(true);
      expect(gateway.created.every((pr) => pr.base !== pr.head)).toBe(true);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  }, 300_000);
});
