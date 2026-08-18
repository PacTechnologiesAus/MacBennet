import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { DEFAULT_MONDAY_STATUS_LABELS } from '@mac/protocol';
import { startWorker } from '@mac/worker';
import { silentLogger } from '@mac/worker/logger';
import { defaultSandboxConfig } from '@mac/worker/config';
import { MockCodingAgent } from '@mac/worker/coding/mock-agent';
import { RecordingPullRequestGateway } from '@mac/worker/coding/pull-request';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { asUser, closePool, createAndLogin, resetDatabase, type Session } from '../helpers/harness.js';
import { db } from '../../src/db/client.js';
import { nightShifts, runs, tasks } from '../../src/db/schema.js';
import { createEnrollmentToken } from '../../src/services/workers.js';
import { SYSTEM_ACTOR } from '../../src/services/audit.js';
import { queryAuditEvents } from '../../src/services/audit-query.js';
import { FakeMondayClient } from '../../src/services/monday/fake.js';
import { setMondayClient } from '../../src/services/monday/provider.js';
import { FakeMailProvider, setMailProvider } from '../../src/services/mail/provider.js';
import { deliverPendingMondayWrites } from '../../src/services/monday/outbox.js';
import { deliverPendingEmails, listEmailDeliveries } from '../../src/services/mail/delivery.js';
import { nightShiftTick, startNightShift, stopNightShift } from '../../src/services/night-shift.js';

/**
 * THE Sprint 3 end-to-end test: one night, start to finish.
 *
 * Real at every step that matters — a real HTTP listener, a real worker process
 * running its real lease loop, real git repositories with real bare remotes,
 * real worktrees and commits, the real scheduler, the real eligibility
 * predicate, the real monday.com projection, the real report and the real mail
 * outbox.
 *
 * Two substitutions, both deliberate and both at a provider boundary:
 *
 *   * the coding agent is the mock rather than Claude Code, because the
 *     requirement is explicit that the standard suite must not spend paid model
 *     usage. It goes through the same `CodingAgent` interface, the same git
 *     shim and the same supervision endpoints;
 *   * monday.com and the mailbox are in-memory implementations of the same
 *     interfaces the real ones implement, holding real state.
 *
 * The sequence under test, which is the Definition of Done in one file:
 *
 *   two approved projects with monday work
 *     → Mac selects the highest-priority eligible item and assigns it to himself
 *     → he executes it, and leaves a reviewable pull request
 *     → monday goes In Progress, then Ready for Review, with the PR attached
 *     → the next task blocks; the blocker is posted and the worktree preserved
 *     → Mac moves to the OTHER project rather than stopping
 *     → the cutoff ends the shift
 *     → exactly one morning email is delivered
 *     → and the audit trail proves the whole sequence, in order.
 */

let app: FastifyInstance;
let baseUrl: string;
let admin: Session;
let operator: Session;
let monday: FakeMondayClient;
let mail: FakeMailProvider;

let tempDir: string;

interface ProjectFixture {
  projectId: string;
  boardRowId: string;
  boardId: string;
  remoteDir: string;
  cloneDir: string;
}

const api = (session: Session) => asUser(app, session);

const git = (argv: string[], cwd: string): Promise<{ code: number; stdout: string }> =>
  new Promise((resolve) => {
    execFile('git', argv, { cwd, shell: false, windowsHide: true }, (error, stdout) => {
      const code = (error as { code?: number } | null)?.code;
      resolve({ code: typeof code === 'number' ? code : 0, stdout: String(stdout) });
    });
  });

beforeAll(async () => {
  const built = await buildApp({ startBackgroundJobs: false, authRateLimitMax: 10_000, registerRateLimitMax: 10_000 });
  app = built.fastify;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';

  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mac-night-'));
}, 300_000);

afterAll(async () => {
  setMondayClient(null);
  setMailProvider(null);
  await app.close();
  await closePool();
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

// ---------------------------------------------------------------------------
// Building a project: a real repository, a mapped board, and briefed work
// ---------------------------------------------------------------------------

async function buildRepository(slug: string): Promise<{ remoteDir: string; cloneDir: string }> {
  const remoteDir = path.join(tempDir, `${slug}.git`);
  const cloneDir = path.join(tempDir, slug);
  const seed = path.join(tempDir, `${slug}-seed`);

  await fs.mkdir(remoteDir, { recursive: true });
  await git(['init', '--bare', '--initial-branch=main'], remoteDir);

  await fs.mkdir(seed, { recursive: true });
  await git(['init', '--initial-branch=main'], seed);
  await git(['config', 'user.email', 'mac@pac-technologies.com.au'], seed);
  await git(['config', 'user.name', 'Mac Bennett'], seed);
  await fs.writeFile(path.join(seed, 'README.md'), `# ${slug}\n\nA React SPA over a Fastify API.\n`, 'utf8');
  await fs.writeFile(
    path.join(seed, 'package.json'),
    JSON.stringify({ name: slug, scripts: { test: 'node ./run-tests.mjs' } }, null, 2),
    'utf8',
  );
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

  return { remoteDir, cloneDir };
}

const CONVERSATION = (title: string) => [
  `I want ${title.toLowerCase()} on the device portal. At the moment it does not work that way.`,
  "We also need the API to support it, but don't change the existing CSV import format because customers are using it.",
  'It is done when an operator can do it end to end and save the result.',
  'Please add unit tests for the selection reducer.',
  'The screen is the DeviceSelector component and the endpoint is the devices route.',
  'The architecture is a React SPA over a Fastify API, with the selection state in a reducer.',
];

async function buildProject(
  name: string,
  slug: string,
  items: Array<{ itemId: string; title: string; priority: string }>,
): Promise<ProjectFixture> {
  const { remoteDir, cloneDir } = await buildRepository(slug);

  const project = (await api(admin).post('/api/projects', { name, description: `${name} project` })).json().project;

  const repository = await api(admin).post('/api/repositories', {
    projectId: project.id,
    name: slug,
    remoteUrl: remoteDir,
    localPath: cloneDir,
    defaultBranch: 'main',
    testCommand: ['node', './run-tests.mjs'],
  });
  await api(admin).post(`/api/repositories/${repository.json().repository.id}/approve`, { approved: true });

  const boardId = `board-${slug}`;
  monday.addBoard({
    id: boardId,
    name: `${name} delivery`,
    groups: [],
    columns: [
      { id: 'status', title: 'Status', type: 'status' },
      { id: 'priority', title: 'Priority', type: 'status' },
      { id: 'due', title: 'Due date', type: 'date' },
      { id: 'people', title: 'Owner', type: 'people' },
      { id: 'pr', title: 'Pull request', type: 'link' },
    ],
  });

  const mapped = await api(admin).post('/api/monday/boards', {
    projectId: project.id,
    boardId,
    name: `${name} delivery`,
    statusColumnId: 'status',
    assigneeColumnId: 'people',
    priorityColumnId: 'priority',
    dueDateColumnId: 'due',
    pullRequestColumnId: 'pr',
    statusLabels: DEFAULT_MONDAY_STATUS_LABELS,
    startableStatuses: ['Ready for Mac'],
    completedStatuses: ['Done'],
    macUserId: 'mac-1',
    nightShiftEligible: true,
  });
  const boardRowId = mapped.json().board.id as string;

  await api(admin).post(`/api/monday/boards/${boardRowId}/approve`, { approved: true });
  await api(admin).post(`/api/projects/${project.id}/night-shift-approval`, { approved: true });

  for (const item of items) {
    monday.addItem({
      id: item.itemId,
      boardId,
      name: item.title,
      status: 'Ready for Mac',
      priority: item.priority,
      nightShiftFlag: true,
    });

    // Real discovery during the "day": the confidence that gates the whole
    // night has to be one the discovery path actually produced.
    const started = await api(operator).post('/api/discovery', { projectId: project.id, title: item.title });
    const sessionId = started.json().session.id as string;
    const taskId = started.json().session.taskId as string;
    for (const message of CONVERSATION(item.title)) {
      await api(operator).post(`/api/discovery/${sessionId}/messages`, { message });
    }
    await api(operator).post(`/api/discovery/${sessionId}/brief`, {});
    await db.update(tasks).set({ mondayItemId: item.itemId }).where(eq(tasks.id, taskId));
  }

  await api(operator).post(`/api/monday/boards/${boardRowId}/sync`);

  return { projectId: project.id, boardRowId, boardId, remoteDir, cloneDir };
}

/**
 * Runs one queued task to completion through a REAL worker process.
 *
 * Started per task and stopped after one run, so the test can interleave
 * scheduler ticks with execution deterministically rather than racing a
 * long-lived worker against the tick loop.
 */
async function runOneTaskOnAWorker(runId: string, script: ConstructorParameters<typeof MockCodingAgent>[0] = {}) {
  const enrollment = await createEnrollmentToken({ label: 'night-e2e', expiresInHours: 1 }, SYSTEM_ACTOR);
  const gateway = new RecordingPullRequestGateway({
    url: 'https://github.com/pac-technologies/device-portal/pull/42',
    number: 42,
  });

  const handle = await startWorker({
    config: {
      controlPlaneUrl: baseUrl,
      enrollmentToken: enrollment.token!,
      name: `night-worker-${Math.floor(Math.random() * 1e9)}`,
      stateFile: path.join(tempDir, `worker-${Math.random().toString(36).slice(2)}.json`),
      workspace: path.join(tempDir, 'workspace'),
      heartbeatSeconds: 30,
      logLevel: 'silent',
      // The mock agent runs in-process and spawns nothing, so there is nothing
      // for a sandbox to contain here. Containment is proven against a real
      // provider by the conformance suite, and the withholding guardrail by
      // `security.test.ts`.
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

  await waitForRun(runId, ['completed', 'failed', 'cancelled', 'stopped_by_guardrail']);
  await handle.stop();
  return gateway;
}

/** Polls until a run reaches one of the given states, or gives up loudly. */
async function waitForRun(runId: string, statuses: string[], timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const [row] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).limit(1);
    last = row?.status ?? 'missing';
    if (statuses.includes(last)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Run ${runId} never reached ${statuses.join('/')}; last status was "${last}".`);
}

/** A worker that only registers, so the scheduler sees somebody available. */
async function idleWorker() {
  const enrollment = await createEnrollmentToken({ label: 'idle', expiresInHours: 1 }, SYSTEM_ACTOR);
  const response = await app.inject({
    method: 'POST',
    url: '/api/worker/register',
    headers: { authorization: `Bearer ${enrollment.token}` },
    payload: {
      name: `idle-worker-${Math.floor(Math.random() * 1e9)}`,
      capabilities: ['noop', 'claude_code', 'repo_inspect'],
      version: '0.1.0',
      platform: 'linux',
      protocolVersion: 1,
      sandbox: { kind: 'bubblewrap', available: true, version: 'test', detail: null },
    },
  });
  const token = response.json().workerToken as string;
  await app.inject({
    method: 'POST',
    url: '/api/worker/heartbeat',
    headers: { authorization: `Bearer ${token}` },
    payload: { status: 'idle', currentRunId: null },
  });
  return token;
}

// ---------------------------------------------------------------------------

describe('Sprint 3 end to end: Mac works a whole night unsupervised', () => {
  it(
    'takes approved monday work across two projects, updates the board, blocks safely, and leaves one morning email',
    async () => {
      await resetDatabase();
      admin = await createAndLogin(app, { email: 'admin@pac.test', role: 'admin' });
      operator = await createAndLogin(app, { email: 'operator@pac.test', role: 'operator' });

      monday = new FakeMondayClient();
      setMondayClient(monday);
      mail = new FakeMailProvider();
      setMailProvider(mail);

      await api(admin).patch('/api/settings', {
        nightShiftEnabled: true,
        mailProvider: 'fake',
        reportRecipients: ['kasper@pac-technologies.com.au'],
        allowedRecipientDomains: ['pac-technologies.com.au'],
        // The mock agent is in-process; containment has its own suite.
        requireSandbox: false,
      });

      // --- The engineer's day: two projects, three pieces of briefed work ---

      const portal = await buildProject('Device Portal', 'device-portal', [
        { itemId: 'portal-1', title: 'Allow selecting multiple devices', priority: 'Critical' },
        { itemId: 'portal-2', title: 'Show device health on the list', priority: 'Medium' },
      ]);
      const forger = await buildProject('Forger', 'forger', [
        { itemId: 'forger-1', title: 'Export the tag list as CSV', priority: 'High' },
      ]);

      await idleWorker();

      // --- 22:00. The engineer goes home. ---------------------------------

      /*
       * The audit trail is append-only and is never truncated between tests —
       * that is the whole point of it — so every assertion below is scoped to
       * events written AFTER this moment. An unscoped assertion would be
       * reading other test files' history.
       */
      const auditFloor = (await queryAuditEvents({ limit: 1, offset: 0 }))[0]?.seq ?? 0;

      const shift = await startNightShift(
        { cutoffAt: new Date(Date.now() + 6 * 3_600_000).toISOString() },
        SYSTEM_ACTOR,
      );

      // === TASK 1 ==========================================================
      // Highest priority anywhere wins the first selection.

      const first = await nightShiftTick();
      expect(first.decision).toBe('start');

      const [run1] = await db.select().from(runs).where(eq(runs.nightShiftId, shift.id));
      expect(run1!.mondayItemId).toBe('portal-1');
      expect(run1!.selectedBy).toBe('night_shift');

      await deliverPendingMondayWrites();
      expect(monday.snapshot('portal-1')!.assigneeIds).toEqual(['mac-1']);
      expect(monday.snapshot('portal-1')!.status).toBe('Working on it');

      // A real worker leases it and runs the whole coding flow.
      const gateway = await runOneTaskOnAWorker(run1!.id);

      const [completed] = await db.select().from(runs).where(eq(runs.id, run1!.id));
      expect(completed!.status).toBe('completed');
      expect(gateway.created).toHaveLength(1);

      // Mac reviewed his own diff and opened a pull request; the branch is his
      // own namespace and the default branch never moved.
      const detail = (await api(operator).get(`/api/runs/${run1!.id}/coding`)).json().detail;
      expect(detail.review.verdict).toBe('satisfies_brief');
      expect(detail.pullRequest.url).toContain('/pull/42');
      expect(detail.worktree.branch.startsWith('mac/')).toBe(true);
      const remoteMain = await git(['rev-parse', 'main'], portal.remoteDir);
      const localMain = await git(['rev-parse', 'origin/main'], portal.cloneDir);
      expect(remoteMain.stdout.trim()).toBe(localMain.stdout.trim());

      // The scheduler notices, reports it, and tells the board.
      const finalise = await nightShiftTick();
      expect(finalise.decision).toBe('finalise');

      await deliverPendingMondayWrites();
      expect(monday.snapshot('portal-1')!.status).toBe('Awaiting Testing');
      expect((await monday.listUpdates('portal-1')).some((u) => u.body.includes('Ready for review'))).toBe(true);

      // === TASK 2 ==========================================================
      // Same project first, then it blocks.

      const second = await nightShiftTick();
      expect(second.decision).toBe('start');

      const [, run2] = await db.select().from(runs).where(eq(runs.nightShiftId, shift.id)).orderBy(runs.createdAt);
      expect(run2!.mondayItemId).toBe('portal-2');

      await deliverPendingMondayWrites();
      expect(monday.snapshot('portal-2')!.status).toBe('Working on it');

      /*
       * The agent asks something Mac may not decide alone.
       *
       * The question is genuinely dangerous — dropping a table — so the real
       * supervision path blocks it rather than guessing, which is what produces
       * the blocker and the preserved worktree.
       */
      await runOneTaskOnAWorker(run2!.id, {
        questions: [
          {
            id: 'q-blocking',
            question: 'Should I drop the legacy devices table as part of this change?',
          },
        ],
      });

      const blockers = (await api(operator).get(`/api/runs/${run2!.id}/coding`)).json().detail.blockers;
      expect(blockers.length).toBeGreaterThan(0);
      expect(blockers[0].description).toContain('drop the legacy devices table');

      const blockedTick = await nightShiftTick();
      expect(blockedTick.decision).toBe('record_blocker');

      await deliverPendingMondayWrites();
      expect(monday.snapshot('portal-2')!.status).toBe('Stuck');
      const blockerPost = (await monday.listUpdates('portal-2')).at(-1)!.body;
      expect(blockerPost).toContain('Blocked');
      expect(blockerPost).toContain('What Mac needs');
      expect(blockerPost).toContain('moved on to other eligible work');

      /*
       * A blocked task is distinguishable from a completed one AND from a
       * failed one.
       *
       * The run itself did finish — Sprint 2's design is that a blocked subtask
       * does not stop the run, so the independent work carried on. What makes
       * this BLOCKED is the unresolved blocker, and the consequence is visible
       * where it matters: the board says Stuck rather than Ready for Review,
       * and the worktree is preserved for a human to pick up.
       */
      const [blockedRun] = await db.select().from(runs).where(eq(runs.id, run2!.id));
      expect(blockedRun!.status).not.toBe('failed');
      expect(monday.snapshot('portal-2')!.status).not.toBe('Awaiting Testing');
      expect((await api(operator).get(`/api/runs/${run2!.id}/coding`)).json().detail.worktree.status).toBe('preserved');

      // === TASK 3 ==========================================================
      // Device Portal is exhausted, so Mac switches projects rather than idling.

      const third = await nightShiftTick();
      expect(third.decision).toBe('start');

      const allRuns = await db.select().from(runs).where(eq(runs.nightShiftId, shift.id)).orderBy(runs.createdAt);
      expect(allRuns).toHaveLength(3);
      expect(allRuns[2]!.mondayItemId).toBe('forger-1');

      await runOneTaskOnAWorker(allRuns[2]!.id);
      await nightShiftTick(); // finalise
      await deliverPendingMondayWrites();
      expect(monday.snapshot('forger-1')!.status).toBe('Awaiting Testing');

      // === 08:00 ===========================================================

      await db.execute(sql`UPDATE night_shifts SET cutoff_at = now() - interval '1 minute' WHERE id = ${shift.id}`);
      const stop = await nightShiftTick();
      expect(stop.decision).toBe('stop');

      const [endedShift] = await db.select().from(nightShifts).where(eq(nightShifts.id, shift.id));
      expect(endedShift!.status).toBe('completed');
      expect(endedShift!.stopReason).toBe('cutoff_reached');
      expect(endedShift!.tasksAttempted).toBe(3);
      expect(endedShift!.tasksCompleted).toBe(2);
      expect(endedShift!.tasksBlocked).toBe(1);

      // --- Exactly one morning email --------------------------------------

      await deliverPendingEmails();

      const deliveries = await listEmailDeliveries();
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.status).toBe('sent');
      expect(deliveries[0]!.recipients).toEqual(['kasper@pac-technologies.com.au']);
      expect(mail.sent).toHaveLength(1);

      const body = mail.sent[0]!.text;
      expect(mail.sent[0]!.subject).toContain('Mac overnight');
      expect(body).toContain('Allow selecting multiple devices');
      expect(body).toContain('Export the tag list as CSV');
      expect(body).toContain('Show device health on the list');
      expect(body).toContain('## Pull Requests');
      expect(body).toContain('/pull/42');
      expect(body).toContain('## monday.com');
      // Short: no log content, and the detail lives behind a link.
      expect(body).not.toContain('[agent]');
      expect(body).toContain('/night-shift');

      // A second sweep must not send it again.
      await deliverPendingEmails(new Date(Date.now() + 3_600_000));
      expect(mail.sent).toHaveLength(1);

      // --- The audit trail proves the sequence ----------------------------

      const events = (await queryAuditEvents({ limit: 500, offset: 0 })).filter((e) => e.seq > auditFloor);
      const ordered = [...events].sort((a, b) => a.seq - b.seq).map((e) => e.eventType);

      const required: string[] = [
        'night_shift.started',
        'run.auto_approved',
        'night_shift.task_selected',
        'monday.assigned',
        'monday.status_changed',
        'monday.update_posted',
        'run.dispatched',
        'coding_session.started',
        'run.review_completed',
        'pull_request.created',
        'coding_session.blocked',
        'night_shift.blocker_recorded',
        'monday.blocker_posted',
        'night_shift.scheduling_decision',
        'report.generated',
        'report.email_attempted',
        'report.email_delivered',
        'night_shift.ended',
      ];
      for (const eventType of required) {
        expect(ordered, eventType).toContain(eventType);
      }

      // Order, on the spine of the night.
      const at = (type: string) => (ordered as string[]).indexOf(type);
      expect(at('night_shift.started')).toBeLessThan(at('run.auto_approved'));
      expect(at('run.auto_approved')).toBeLessThan(at('run.dispatched'));
      expect(at('run.dispatched')).toBeLessThan(at('pull_request.created'));
      expect(at('night_shift.blocker_recorded')).toBeLessThan(at('night_shift.ended'));
      expect(at('night_shift.ended')).toBeLessThan((ordered as string[]).lastIndexOf('report.email_delivered'));

      // A machine approval was never recorded as a human one.
      const autoApprovals = events.filter((e) => e.eventType === 'run.auto_approved');
      expect(autoApprovals).toHaveLength(3);
      for (const approval of autoApprovals) {
        expect(approval.actorType).toBe('system');
        expect(approval.metadata.basis).toContain('eligibility predicate');
      }

      // --- And main was never touched, in either repository ---------------

      for (const fixture of [portal, forger]) {
        const branches = await git(['branch', '-a'], fixture.cloneDir);
        expect(branches.stdout).toContain('mac/');
        const remoteHead = await git(['rev-parse', 'main'], fixture.remoteDir);
        const trackedHead = await git(['rev-parse', 'origin/main'], fixture.cloneDir);
        expect(remoteHead.stdout.trim()).toBe(trackedHead.stdout.trim());
      }

      await stopNightShift({ reason: 'cleanup', skipReport: true }, SYSTEM_ACTOR);
    },
    900_000,
  );
});
