import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DEFAULT_MONDAY_STATUS_LABELS } from '@mac/protocol';
import { startWorker } from '@mac/worker';
import { silentLogger } from '@mac/worker/logger';
import { defaultSandboxConfig } from '@mac/worker/config';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { asUser, closePool, createAndLogin, resetDatabase, type Session } from '../helpers/harness.js';
import { db } from '../../src/db/client.js';
import { nightShifts, runs, tasks } from '../../src/db/schema.js';
import { createEnrollmentToken } from '../../src/services/workers.js';
import { SYSTEM_ACTOR } from '../../src/services/audit.js';
import { queryAuditEvents } from '../../src/services/audit-query.js';
import { MondayGraphqlClient } from '../../src/services/monday/graphql.js';
import { setMondayClient } from '../../src/services/monday/provider.js';
import { FakeMailProvider, setMailProvider } from '../../src/services/mail/provider.js';
import { deliverPendingMondayWrites } from '../../src/services/monday/outbox.js';
import { deliverPendingEmails, listEmailDeliveries } from '../../src/services/mail/delivery.js';
import { nightShiftTick, startNightShift, stopNightShift } from '../../src/services/night-shift.js';

/**
 * THE Sprint 3.1 commissioning night (brief §11).
 *
 * The Sprint 3 end-to-end test proved this sequence against fakes at every
 * provider boundary. This one runs the same sequence with the fakes taken out:
 *
 *   real monday.com          a dedicated board, through Mac's own GraphQL client
 *   real Claude Code CLI     the actual agent, spending actual subscription usage
 *   real GitHub              a disposable private repository and real pull requests
 *   real worker process      leasing, executing, reporting over real HTTP
 *   real git                 clone, worktree, branch, commit, push
 *
 * ---------------------------------------------------------------------------
 * CONTAINMENT MODE IS EXPLICIT, AND RECORDED RATHER THAN HIDDEN
 *
 * On Linux, setting `MAC_SANDBOX_PROVIDER=bubblewrap` together with an explicit
 * `MAC_SANDBOX_CREDENTIALS` mount turns `requireSandbox` ON and runs the real
 * authenticated agent inside Bubblewrap. Other hosts retain the documented
 * uncontained commissioning fallback and may not claim contained execution.
 * ---------------------------------------------------------------------------
 *
 * Opt-in, and skipped by default. It writes to a real board, opens real pull
 * requests and spends real model usage:
 *
 *   MAC_COMMISSIONING_NIGHT=1
 *   MONDAY_API_TOKEN=...                 (repository-root .env is fine)
 *   MAC_MONDAY_TEST_BOARD_ID=...         the dedicated commissioning board
 *   MAC_COMMISSIONING_REPO=...           https URL of a DISPOSABLE repository
 *
 * Optional, and the difference between a real morning email and a recorded one:
 *   MAC_MAIL_TENANT_ID / _CLIENT_ID / _CLIENT_SECRET / _FROM
 *   MAC_COMMISSIONING_RECIPIENT=...      an approved internal address
 */

const ENABLED = process.env.MAC_COMMISSIONING_NIGHT === '1';
const TOKEN = process.env.MONDAY_API_TOKEN ?? '';
const BOARD_ID = process.env.MAC_MONDAY_TEST_BOARD_ID ?? '';
const REPO_URL = process.env.MAC_COMMISSIONING_REPO ?? '';
const RECIPIENT = process.env.MAC_COMMISSIONING_RECIPIENT ?? 'kasper.simonsen@pac-technologies.com.au';
const SANDBOX_CREDENTIALS = (process.env.MAC_SANDBOX_CREDENTIALS ?? '')
  .split(/[,;]/)
  .map((entry) => entry.trim())
  .filter(Boolean);
const CONTAINED = process.env.MAC_SANDBOX_PROVIDER === 'bubblewrap' && SANDBOX_CREDENTIALS.length > 0;
const REAL_MAIL = Boolean(
  process.env.MAC_MAIL_TENANT_ID && process.env.MAC_MAIL_CLIENT_ID && process.env.MAC_MAIL_CLIENT_SECRET,
);

const runnable = ENABLED && Boolean(TOKEN && BOARD_ID && REPO_URL);

if (ENABLED && !runnable) {
  // eslint-disable-next-line no-console
  console.warn(
    '\n*** MAC_COMMISSIONING_NIGHT=1 but the night cannot run ***\n' +
      'Set MONDAY_API_TOKEN, MAC_MONDAY_TEST_BOARD_ID and MAC_COMMISSIONING_REPO.\n',
  );
}

let app: FastifyInstance;
let baseUrl: string;
let admin: Session;
let operator: Session;
let monday: MondayGraphqlClient;
let mail: FakeMailProvider | null = null;
let tempDir: string;
let cloneDir: string;
type ColumnRole =
  | 'status'
  | 'priority'
  | 'assignee'
  | 'dueDate'
  | 'pullRequest'
  | 'nightShiftFlag'
  | 'itemType'
  | 'size'
  | 'dependency';
let columns: Record<ColumnRole, string>;
let macUserId: string;
/** monday item ids, resolved from the board by the `Task X` name prefix. */
const itemIds: Record<'A' | 'B' | 'C' | 'D', string> = { A: '', B: '', C: '', D: '' };

const api = (session: Session) => asUser(app, session);

const git = (argv: string[], cwd: string): Promise<{ code: number; stdout: string }> =>
  new Promise((resolve) => {
    execFile('git', argv, { cwd, shell: false, windowsHide: true }, (error, stdout) => {
      const code = (error as { code?: number } | null)?.code;
      resolve({ code: typeof code === 'number' ? code : 0, stdout: String(stdout) });
    });
  });

/** A direct call, for the two facts Mac's client deliberately cannot obtain. */
async function raw<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: TOKEN, 'API-Version': '2024-10' },
    body: JSON.stringify({ query, variables }),
  });
  const parsed = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (parsed.errors?.length) throw new Error(parsed.errors.map((e) => e.message).join('; '));
  return parsed.data as T;
}

/**
 * Puts the board back where a night starts from.
 *
 * Commissioning is re-runnable or it is a one-shot ceremony nobody repeats, and
 * the second run is where the interesting failures live. This uses the raw API
 * rather than Mac's client on purpose: resetting a board is a thing an operator
 * does, and Mac deliberately has no method for most of it.
 */
async function resetBoard(): Promise<void> {
  for (const key of ['A', 'B', 'C'] as const) {
    await raw(
      `mutation ($b: ID!, $i: ID!, $v: JSON!) {
         change_multiple_column_values (board_id: $b, item_id: $i, column_values: $v) { id }
       }`,
      {
        b: BOARD_ID,
        i: itemIds[key],
        v: JSON.stringify({
          [columns.status]: { label: 'Ready for Mac' },
          [columns.assignee]: { personsAndTeams: [] },
          [columns.pullRequest]: { url: '', text: '' },
        }),
      },
    );
  }
}

beforeAll(async () => {
  if (!runnable) return;

  if (CONTAINED) {
    await Promise.all(SANDBOX_CREDENTIALS.map((credential) => fs.access(credential)));
    await new Promise<void>((resolve, reject) => {
      execFile('bwrap', ['--version'], { shell: false, windowsHide: true }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  const built = await buildApp({ startBackgroundJobs: false, authRateLimitMax: 10_000, registerRateLimitMax: 10_000 });
  app = built.fastify;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';

  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mac-commissioning-'));
  cloneDir = path.join(tempDir, 'shiftlog');

  monday = new MondayGraphqlClient({ token: TOKEN });
  setMondayClient(monday);

  // --- Learn the board rather than assume it (brief §6) ---------------------
  const board = await monday.getBoard(BOARD_ID);
  if (!board) throw new Error(`Board ${BOARD_ID} is not readable with the configured token.`);
  const byTitle = new Map(board.columns.map((c) => [c.title, c.id]));
  columns = {
    status: byTitle.get('Status')!,
    priority: byTitle.get('Priority')!,
    assignee: byTitle.get('Owner')!,
    dueDate: byTitle.get('Due date')!,
    pullRequest: byTitle.get('Pull Request')!,
    nightShiftFlag: byTitle.get('Night Shift')!,
    itemType: byTitle.get('Item Type')!,
    size: byTitle.get('Size')!,
    dependency: byTitle.get('Depends On')!,
  };
  for (const [role, id] of Object.entries(columns)) {
    if (!id) throw new Error(`The commissioning board has no column for "${role}".`);
  }

  const items = await monday.withColumnMap(columns).listItems(BOARD_ID, { limit: 100 });
  for (const key of ['A', 'B', 'C', 'D'] as const) {
    const found = items.find((i) => i.name.startsWith(`Task ${key}`));
    if (!found) throw new Error(`Task ${key} is not on the commissioning board.`);
    itemIds[key] = found.id;
  }

  const me = await raw<{ me: { id: string } }>('query { me { id } }');
  macUserId = String(me.me.id);

  await resetBoard();

  // --- A real clone of the disposable repository ---------------------------
  await git(['clone', REPO_URL, cloneDir], tempDir);
  await git(['config', 'user.email', 'mac@pac-technologies.com.au'], cloneDir);
  await git(['config', 'user.name', 'Mac Bennett'], cloneDir);
}, 600_000);

afterAll(async () => {
  if (!runnable) return;
  setMondayClient(null);
  setMailProvider(null);
  await app?.close();
  await closePool();
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

// ---------------------------------------------------------------------------
// The engineer's day: three real handoffs
// ---------------------------------------------------------------------------

/**
 * What an engineer actually says at 16:00.
 *
 * Deliberately conversational and out of order, because that is the input
 * discovery is built for. Task B's is confident about the OUTCOME and silent on
 * the one decision nobody has made — which is how a genuine blocker arrives:
 * not as a missing requirement, but as a question that only surfaces once
 * somebody sits down to write the code.
 */
const CONVERSATIONS: Record<'A' | 'B' | 'C', string[]> = {
  A: [
    'The summarise command prints a human table at the moment. I want a --json flag on it so the site guys can pipe it into their own tooling.',
    'Do not change the default output. Scripts read that table and they will break if the columns move.',
    'It is done when `node src/cli.js summarise entries.json --json` prints valid JSON to stdout and nothing else.',
    'Add a unit test for the flag please, in test/, using node:test like the others.',
    'The code is src/summarise.js and src/cli.js. formatTable is the human one.',
    'Small job. Should be half an hour.',
  ],
  B: [
    'Finance are complaining that our invoice totals do not match their system. It is a cent here and there, but it is money so it matters.',
    'The totals come out of invoiceTotal in src/money.js. It just sums floats at the moment.',
    'I want invoiceTotal to produce the same final total as the finance system.',
    'It is done when our totals agree with the finance system for the same inputs.',
    'Add tests for whatever you do.',
    'The affected module is src/money.js; keep this as a small change to that one function.',
    'Do not change individual line amounts, rates, the function signature, or its callers.',
    'It is important - finance have asked twice now.',
  ],
  C: [
    'parseDuration in src/duration.js takes a negative number of minutes quite happily and then the totals are nonsense.',
    'I want it to reject a negative duration with an error that names the value it did not like.',
    'Do not change how it parses anything valid. "90", "1h30m", "2h", "45m" all keep working exactly as they do.',
    'It is done when a negative duration throws and there is a test proving it.',
    'Small one.',
    'src/duration.js, and the tests are in test/duration.test.js.',
  ],
};

const TITLES: Record<'A' | 'B' | 'C', string> = {
  A: 'Add a --json flag to the summarise command',
  B: 'Round invoice totals to match the finance system',
  C: 'Reject negative durations with a clear error',
};

/** Polls until a run reaches one of the given states, or gives up loudly. */
async function waitForRun(runId: string, statuses: string[], timeoutMs = 30 * 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const [row] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).limit(1);
    last = row?.status ?? 'missing';
    if (statuses.includes(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `Run ${runId} never reached ${statuses.join('/')} within ${Math.round(timeoutMs / 60_000)} minute(s); ` +
      `last status was "${last}". Check run_logs for this run — a coding session that is working but quiet ` +
      'looks identical to one that has stalled.',
  );
}

/**
 * A worker that registers and heartbeats but never leases.
 *
 * The scheduler will not start work when no worker is available, and it is
 * right not to: a run queued with nobody to take it idles the whole night. The
 * real per-task worker below is started only once a run exists, so without this
 * the very first tick would correctly refuse and the night would never begin.
 */
async function idleWorker(): Promise<void> {
  const enrollment = await createEnrollmentToken({ label: 'commissioning-idle', expiresInHours: 2 }, SYSTEM_ACTOR);
  const registered = await app.inject({
    method: 'POST',
    url: '/api/worker/register',
    headers: { authorization: `Bearer ${enrollment.token}` },
    payload: {
      name: `commissioning-idle-${Math.floor(Math.random() * 1e9)}`,
      capabilities: ['noop', 'claude_code', 'repo_inspect'],
      version: '0.1.0',
      platform: process.platform,
      protocolVersion: 1,
      sandbox: CONTAINED
        ? { kind: 'bubblewrap', available: true, version: null, detail: 'Commissioning host Bubblewrap preflight.' }
        : { kind: 'none', available: false, version: null, detail: 'Commissioning host: see file header.' },
    },
  });
  const token = registered.json().workerToken as string;
  await app.inject({
    method: 'POST',
    url: '/api/worker/heartbeat',
    headers: { authorization: `Bearer ${token}` },
    payload: { status: 'idle', currentRunId: null },
  });
}

/** One real worker process, running the REAL Claude Code CLI, for one run. */
async function runOneTaskOnAWorker(runId: string): Promise<string> {
  const enrollment = await createEnrollmentToken({ label: 'commissioning', expiresInHours: 2 }, SYSTEM_ACTOR);

  const handle = await startWorker({
    config: {
      controlPlaneUrl: baseUrl,
      enrollmentToken: enrollment.token!,
      name: `commissioning-worker-${Math.floor(Math.random() * 1e9)}`,
      stateFile: path.join(tempDir, `worker-${Math.random().toString(36).slice(2)}.json`),
      workspace: path.join(tempDir, 'workspace'),
      heartbeatSeconds: 30,
      logLevel: 'silent',
      // Containment grants command execution. The explicit uncontained flag is
      // retained only for the documented Windows commissioning fallback.
      sandbox: CONTAINED
        ? defaultSandboxConfig({ provider: 'bubblewrap', credentialMounts: SANDBOX_CREDENTIALS })
        : defaultSandboxConfig({ allowUncontainedCommands: true }),
    },
    logger: silentLogger,
    maxRuns: 1,
    leaseWaitSeconds: 1,
    retryBaseMs: 100,
    // No agentFactory and no pullRequestGateway: the worker resolves the real
    // Claude Code CLI and the real `gh` gateway, which is the entire point.
  });

  const status = await waitForRun(runId, ['completed', 'failed', 'blocked', 'cancelled', 'stopped_by_guardrail']);
  await handle.stop();
  return status;
}

// ---------------------------------------------------------------------------

describe.skipIf(!runnable)('Sprint 3.1: a commissioning night against real external systems', () => {
  it(
    'takes real monday work, uses real Claude Code, opens real pull requests, and leaves one morning report',
    async () => {
      await resetDatabase();
      admin = await createAndLogin(app, { email: 'admin@pac.test', role: 'admin' });
      operator = await createAndLogin(app, { email: 'kasper@pac.test', role: 'operator' });

      if (!REAL_MAIL) {
        mail = new FakeMailProvider();
        setMailProvider(mail);
      }

      await api(admin).patch('/api/settings', {
        nightShiftEnabled: true,
        mailProvider: REAL_MAIL ? 'graph' : 'fake',
        reportRecipients: [RECIPIENT],
        allowedRecipientDomains: ['pac-technologies.com.au'],
        requireSandbox: CONTAINED,
        /*
         * Twenty minutes rather than the sixty-minute default.
         *
         * This is the agent's IDLE timeout, and these are genuinely small tasks
         * — Mac's own effort model calls each of them "small". A sixty-minute
         * silence budget makes a commissioning night take three hours of
         * wall-clock to discover a stall, which is not a useful feedback loop.
         * An operator lowering this for short work is an ordinary setting, not
         * a test contrivance.
         */
        maxAgentMinutes: 20,
      });

      // --- The engineer's day ------------------------------------------------

      const project = (
        await api(admin).post('/api/projects', {
          name: 'Shiftlog (commissioning)',
          description: 'Disposable fixture for Sprint 3.1 commissioning.',
        })
      )
        .json()
        .project;

      const repository = await api(admin).post('/api/repositories', {
        projectId: project.id,
        name: 'shiftlog',
        remoteUrl: REPO_URL,
        localPath: cloneDir,
        defaultBranch: 'main',
        testCommand: ['npm', 'test'],
      });
      await api(admin).post(`/api/repositories/${repository.json().repository.id}/approve`, { approved: true });

      const mapped = await api(admin).post('/api/monday/boards', {
        projectId: project.id,
        boardId: BOARD_ID,
        name: 'Mac Commissioning (Sprint 3.1)',
        // The real, generated ids. Nothing here is canonical.
        statusColumnId: columns.status,
        assigneeColumnId: columns.assignee,
        priorityColumnId: columns.priority,
        dueDateColumnId: columns.dueDate,
        pullRequestColumnId: columns.pullRequest,
        nightShiftFlagColumnId: columns.nightShiftFlag,
        itemTypeColumnId: columns.itemType,
        sizeColumnId: columns.size,
        dependencyColumnId: columns.dependency,
        statusLabels: DEFAULT_MONDAY_STATUS_LABELS,
        startableStatuses: ['Ready for Mac'],
        completedStatuses: ['Done'],
        // The group a human said Mac may take work from. Task D lives elsewhere.
        groupIds: ['topics'],
        macUserId,
        nightShiftEligible: true,
        // Ready for Review stays Mac's terminal state.
        mayComplete: false,
      });
      const boardRowId = mapped.json().board.id as string;

      await api(admin).post(`/api/monday/boards/${boardRowId}/approve`, { approved: true });
      await api(admin).post(`/api/projects/${project.id}/night-shift-approval`, { approved: true });

      for (const key of ['A', 'B', 'C'] as const) {
        const started = await api(operator).post('/api/discovery', { projectId: project.id, title: TITLES[key] });
        const sessionId = started.json().session.id as string;
        const taskId = started.json().session.taskId as string;
        for (const message of CONVERSATIONS[key]) {
          await api(operator).post(`/api/discovery/${sessionId}/messages`, { message });
        }
        await api(operator).post(`/api/discovery/${sessionId}/brief`, {});
        await db.update(tasks).set({ mondayItemId: itemIds[key] }).where(eq(tasks.id, taskId));
      }

      const synced = await api(operator).post(`/api/monday/boards/${boardRowId}/sync`);
      expect(synced.statusCode).toBe(200);

      await idleWorker();

      // --- 22:00 -------------------------------------------------------------

      const auditFloor = (await queryAuditEvents({ limit: 1, offset: 0 }))[0]?.seq ?? 0;

      const shift = await startNightShift(
        { cutoffAt: new Date(Date.now() + 6 * 3_600_000).toISOString() },
        SYSTEM_ACTOR,
      );

      const observed: Array<{ item: string; run: string; status: string }> = [];

      /*
       * Three attempts, driven by the real scheduler.
       *
       * Deliberately NOT asserting which item is chosen at each step before the
       * fact beyond the first: the scheduler's order is under test, and a test
       * that dictated it would be testing itself. What IS asserted is that each
       * selection is one Mac was allowed to make, and that Task D — highest
       * priority on the board, and unflagged — is never among them.
       */
      const declined: string[] = [];

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const tick = await nightShiftTick();
        if (tick.decision !== 'start') {
          /*
           * A refusal is a result, not an absence of one. Recording the
           * rationale and every skip reason here is what makes the difference
           * between "the night did nothing" and "the night did nothing BECAUSE
           * the board flag was not set" — and the second is the only one
           * anybody can act on at 08:00.
           */
          const rationale = (
            tick as { rationale?: { reason?: string; skipped?: Array<{ title?: string; reason?: string }> } }
          ).rationale;
          const skipped = (rationale?.skipped ?? [])
            .map((skip) => (skip.title ?? '?') + ' (' + (skip.reason ?? '?') + ')')
            .join('; ');
          declined.push(
            'tick ' + attempt + ': ' + tick.decision + ' - ' +
              (rationale?.reason ?? 'no rationale recorded') +
              (skipped ? '\n      skipped: ' + skipped : ''),
          );
          if (tick.decision !== 'finalise' && tick.decision !== 'record_blocker') break;
          continue;
        }

        const active = await db
          .select()
          .from(runs)
          .where(eq(runs.nightShiftId, shift.id))
          .orderBy(runs.createdAt);
        const current = active[active.length - 1]!;

        expect(current.selectedBy).toBe('night_shift');
        expect(current.mondayItemId).not.toBe(itemIds.D);

        // The board learns Mac has taken it, before he starts.
        await deliverPendingMondayWrites();
        const claimed = await monday.withColumnMap(columns).getItem(current.mondayItemId!);
        expect(claimed!.status).toBe('Working on it');
        expect(claimed!.assigneeIds).toContain(macUserId);

        const status = await runOneTaskOnAWorker(current.id);

        // The scheduler finalises before it chooses again.
        await nightShiftTick();
        await deliverPendingMondayWrites();

        observed.push({ item: current.mondayItemId!, run: current.id, status });
      }

      // --- What the night actually did --------------------------------------

      expect(
        observed.length,
        ['Mac never started anything. The scheduler said:', ...declined].join('\n  '),
      ).toBeGreaterThan(0);

      // Task D is the control. It is Critical, startable and unflagged, and if
      // the eligibility predicate is wrong it is the first thing Mac would take.
      expect(observed.map((o) => o.item)).not.toContain(itemIds.D);
      const untouched = await monday.withColumnMap(columns).getItem(itemIds.D);
      expect(untouched!.status).toBe('Ready for Mac');
      expect(untouched!.assigneeIds).toEqual([]);

      // Highest priority first: Task A is Critical.
      expect(observed[0]!.item).toBe(itemIds.A);

      // Task B is complete enough to start but contains a financial decision
      // nobody supplied. The real agent must surface that decision, Mac must
      // block it, and no pull request may be created for guessed money logic.
      const blockedTask = observed.find((entry) => entry.item === itemIds.B);
      expect(blockedTask, 'Task B never reached the real coding agent').toBeDefined();
      const blockedEvents = await queryAuditEvents({ runId: blockedTask!.run, limit: 200, offset: 0 });
      const blockedTypes = blockedEvents.map((event) => event.eventType);
      expect(blockedTypes).toContain('coding_session.blocked');
      expect(blockedTypes).not.toContain('pull_request.created');

      // Once B is safely blocked, the scheduler must continue to C.
      expect(observed.map((entry) => entry.item)).toContain(itemIds.C);

      // --- The shift ends ----------------------------------------------------

      await stopNightShift({ reason: 'Commissioning night complete.' }, SYSTEM_ACTOR);

      const [finished] = await db.select().from(nightShifts).where(eq(nightShifts.id, shift.id));
      expect(finished!.status).not.toBe('running');

      // --- Exactly one morning email ----------------------------------------

      // Drained twice, and a second stop attempted, because the duplicate this
      // guards against is the one caused by a retry or an overlapping tick
      // rather than by a caller calling twice on purpose.
      await deliverPendingEmails();
      await deliverPendingEmails();
      await stopNightShift({ reason: 'Deliberate second stop.' }, SYSTEM_ACTOR).catch(() => undefined);
      await deliverPendingEmails();

      const deliveries = (await listEmailDeliveries(50)).filter((d) => d.nightShiftId === shift.id);
      expect(deliveries, 'exactly one morning report per night').toHaveLength(1);
      expect(deliveries[0]!.recipients).toEqual([RECIPIENT]);

      if (REAL_MAIL) {
        expect(deliveries[0]!.status).toBe('sent');
      } else {
        expect(mail!.sent.length).toBe(1);
        expect(mail!.sent[0]!.to).toEqual([RECIPIENT]);
      }

      // --- The default branch never moved ------------------------------------

      await git(['fetch', 'origin'], cloneDir);
      const localMain = await git(['rev-parse', 'origin/main'], cloneDir);
      const seeded = await git(['rev-list', '--count', 'origin/main'], cloneDir);
      expect(seeded.stdout.trim(), 'origin/main gained commits during the night').toBe('1');
      expect(localMain.stdout.trim().length).toBeGreaterThan(0);

      // Every branch Mac pushed is his own.
      const branches = await git(['branch', '-r'], cloneDir);
      const pushed = branches.stdout
        .split('\n')
        .map((b) => b.trim())
        .filter((b) => b && !b.includes('origin/HEAD') && b !== 'origin/main');
      for (const branch of pushed) {
        expect(branch.startsWith('origin/mac/'), `unexpected branch ${branch}`).toBe(true);
      }

      // --- The audit trail reconciles ---------------------------------------

      const events = (await queryAuditEvents({ limit: 500, offset: 0 })).filter((e) => e.seq > auditFloor);
      const types = events.map((e) => e.eventType);

      expect(types).toContain('night_shift.started');
      expect(types).toContain('run.auto_approved');
      // A machine approval must never read as a human one.
      expect(types).not.toContain('run.approved');
      expect(types).toContain('monday.status_changed');
      expect(types).toContain('night_shift.blocker_recorded');
      expect(types).toContain('monday.blocker_posted');
      expect(types).toContain('pull_request.created');
      expect(types).toContain('night_shift.ended');
      expect(types).toContain('report.email_attempted');

      // eslint-disable-next-line no-console
      console.info(
        `\n[commissioning night]\n` +
          observed.map((o) => `  item ${o.item} → run ${o.run} → ${o.status}`).join('\n') +
          `\n  audit events: ${events.length}\n  email deliveries: ${deliveries.length}\n`,
      );
    },
    150 * 60_000,
  );
});
