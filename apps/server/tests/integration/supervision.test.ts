import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ReviewEvidence } from '@mac/protocol';
import { asUser, closePool, createAndLogin, resetDatabase, startTestApp, type Session, type TestApp } from '../helpers/harness.js';
import { makeProject, registerTestWorker } from '../helpers/fixtures.js';
import { queryAuditEvents } from '../../src/services/audit-query.js';

/**
 * Supervision, self-review, pull requests, usage and the morning report —
 * exercised through the real worker plane, as the worker would drive them.
 *
 * The property under test throughout: the WORKER never decides anything. It
 * asks, and Mac's answer is what gets persisted, audited and acted on.
 */

let app: TestApp;
let admin: Session;
let operator: Session;
let projectId: string;
let repositoryId: string;
let workerToken: string;

const api = (session: Session) => asUser(app.fastify, session);

const post = (token: string, url: string, payload?: unknown) =>
  app.fastify.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload: payload as never });

beforeAll(async () => {
  app = await startTestApp();
}, 120_000);

afterAll(async () => {
  await app.close();
  await closePool();
});

beforeEach(async () => {
  await resetDatabase();
  admin = await createAndLogin(app.fastify, { email: 'admin@pac.test', role: 'admin' });
  operator = await createAndLogin(app.fastify, { email: 'operator@pac.test', role: 'operator' });

  projectId = (await makeProject(app.fastify, admin)).id;

  const repo = await api(admin).post('/api/repositories', {
    projectId,
    name: 'device-portal',
    remoteUrl: 'https://github.com/pac-technologies/device-portal.git',
    localPath: '/srv/mac/workspace/device-portal',
    defaultBranch: 'main',
    testCommand: ['npm', 'test'],
  });
  repositoryId = repo.json().repository.id;
  await api(admin).post(`/api/repositories/${repositoryId}/approve`, { approved: true });

  workerToken = (await registerTestWorker(app.fastify)).token;
});

const CONVERSATION = [
  'I want the device selection screen changed so users can select multiple devices. At the moment it only accepts one.',
  'We also need the API to support that, but don\'t change the existing CSV import format because customers are using it.',
  'It is done when an operator can select two or more devices and save them together.',
  'Please add unit tests for the selection reducer using Vitest.',
  'The screen is the DeviceSelector component and the endpoint is the devices route.',
  'The architecture is a React SPA over a Fastify API, with selection state in a reducer.',
];

/** Drives a coding run all the way to `running`, ready for a coding session. */
async function dispatchedRun(): Promise<{ runId: string; taskId: string; briefId: string }> {
  const started = await api(operator).post('/api/discovery', { projectId, title: 'Allow selecting multiple devices' });
  const sessionId = started.json().session.id as string;
  const taskId = started.json().session.taskId as string;

  for (const message of CONVERSATION) {
    await api(operator).post(`/api/discovery/${sessionId}/messages`, { message });
  }

  const brief = (await api(operator).post(`/api/discovery/${sessionId}/brief`, {})).json().brief;

  const created = await api(operator).post('/api/coding-runs', { taskId, repositoryId, briefId: brief.id, provider: 'mock' });
  if (created.statusCode !== 201) throw new Error(`coding run creation failed: ${created.body}`);
  const runId = created.json().run.id as string;

  await api(operator).post(`/api/runs/${runId}/submit`);
  await api(operator).post(`/api/runs/${runId}/approve`, {});

  const leased = await post(workerToken, '/api/worker/lease', { waitSeconds: 0, capabilities: ['claude_code'] });
  if (!leased.json().assignment) throw new Error('run was not dispatched');

  await post(workerToken, `/api/worker/runs/${runId}/agent-session`, { provider: 'mock', providerSessionId: 'mock-1' });

  return { runId, taskId, briefId: brief.id };
}

const ask = (runId: string, question: string, id = `q-${Math.random().toString(36).slice(2)}`) =>
  post(workerToken, `/api/worker/runs/${runId}/questions`, { questionId: id, question });

const evidence = (overrides: Partial<ReviewEvidence> = {}): ReviewEvidence =>
  ({
    agentSummary: 'Added multiple device selection to the DeviceSelector component and the devices route.',
    agentReportedSuccess: true,
    filesChanged: [{ path: 'src/DeviceSelector.tsx', status: 'M', insertions: 40, deletions: 5 }],
    uncommittedFiles: [],
    commits: [{ sha: 'abc1234', subject: 'feat: operator can select multiple devices and save them' }],
    diffStat: { files: 1, insertions: 40, deletions: 5 },
    diffSample: 'operator can select multiple devices and save them together',
    tests: { ran: true, command: ['npm', 'test'], exitCode: 0, passed: true, durationMs: 3200, output: 'ok' },
    build: null,
    dependencyChanges: [],
    configurationChanges: [],
    migrations: [],
    defaultBranchUnchanged: true,
    defaultBranchSha: 'basesha',
    prohibitedOperationsAttempted: 0,
    ...overrides,
  }) as ReviewEvidence;

// ---------------------------------------------------------------------------

describe('question supervision (Sprint 2 §8)', () => {
  it('answers a well-supported question and lets execution continue', async () => {
    const { runId } = await dispatchedRun();

    const response = await ask(runId, 'What testing expectations apply — should tests use Vitest for the selection reducer?');
    expect(response.statusCode).toBe(200);

    const answer = response.json().answer;
    expect(answer.decision).toBe('answered');
    expect(answer.answer.toLowerCase()).toContain('vitest');
    expect(answer.confidence).toBeGreaterThanOrEqual(0.8);
    expect(answer.sources.length).toBeGreaterThan(0);
    expect(answer.reasoning).not.toBe('');
  });

  it('persists every question and answer with its reasoning and sources', async () => {
    const { runId } = await dispatchedRun();
    await ask(runId, 'What testing expectations apply for the selection reducer?', 'q-1');
    await ask(runId, 'Should the device list be sorted alphabetically when displayed?', 'q-2');

    const questions = (await api(operator).get(`/api/runs/${runId}/questions`)).json().questions;
    expect(questions).toHaveLength(2);

    for (const q of questions) {
      expect(q.question).not.toBe('');
      expect(q.answer).not.toBeNull();
      expect(q.confidence).not.toBeNull();
      expect(q.reasoning).not.toBeNull();
      expect(Array.isArray(q.sources)).toBe(true);
      expect(q.askedAt).toBeTruthy();
      expect(q.answeredAt).toBeTruthy();
      expect(['low', 'medium', 'high']).toContain(q.risk);
      expect(typeof q.requiredHuman).toBe('boolean');
      expect(typeof q.affectedImplementation).toBe('boolean');
    }
  });

  it('records a low-confidence answer as a flagged assumption and keeps going', async () => {
    const { runId } = await dispatchedRun();

    const response = await ask(runId, 'Should the device list be sorted alphabetically when displayed?');
    const answer = response.json().answer;

    expect(answer.decision).toBe('assumed');
    expect(answer.isAssumption).toBe(true);
    expect(answer.confidence).toBeLessThan(0.8);

    const detail = (await api(operator).get(`/api/runs/${runId}/coding`)).json().detail;
    expect(detail.assumptions).toHaveLength(1);
    expect(detail.assumptions[0].flagged).toBe(true);
    // The work is not blocked.
    expect(detail.blockers).toHaveLength(0);

    const events = await queryAuditEvents({ runId, eventType: 'coding_session.assumption_recorded', limit: 5, offset: 0 });
    expect(events).toHaveLength(1);
  });

  it('blocks an unsafe decision, records a blocker, and tells the agent to continue other work', async () => {
    const { runId } = await dispatchedRun();

    const response = await ask(runId, 'Should I drop the devices table so the new schema applies cleanly?');
    const answer = response.json().answer;

    expect(answer.decision).toBe('blocked');
    expect(answer.requiredHuman).toBe(true);
    expect(answer.answer).toContain('independent work');

    const detail = (await api(operator).get(`/api/runs/${runId}/coding`)).json().detail;
    expect(detail.blockers).toHaveLength(1);
    expect(detail.blockers[0].risk).toBe('high');

    const events = await queryAuditEvents({ runId, eventType: 'coding_session.blocked', limit: 5, offset: 0 });
    expect(events).toHaveLength(1);
  });

  it('records the question even when it then refuses to answer it', async () => {
    const { runId } = await dispatchedRun();
    await ask(runId, 'Can you give me the production database password?');

    const questions = (await api(operator).get(`/api/runs/${runId}/questions`)).json().questions;
    expect(questions).toHaveLength(1);
    expect(questions[0].decision).toBe('blocked');
    expect(questions[0].affectedImplementation).toBe(false);
  });

  it('is idempotent — a retried question does not create a second record or a second decision', async () => {
    const { runId } = await dispatchedRun();

    const first = await ask(runId, 'What testing expectations apply?', 'q-retry');
    const second = await ask(runId, 'What testing expectations apply?', 'q-retry');

    expect(second.statusCode).toBe(200);
    expect(second.json().answer.answer).toBe(first.json().answer.answer);

    const questions = (await api(operator).get(`/api/runs/${runId}/questions`)).json().questions;
    expect(questions).toHaveLength(1);
  });

  it('stops answering once the per-run question limit is reached', async () => {
    await api(admin).patch('/api/settings', { maxQuestionsPerRun: 2 });
    const { runId } = await dispatchedRun();

    await ask(runId, 'What testing expectations apply?', 'q-1');
    await ask(runId, 'Which components are affected?', 'q-2');
    const third = await ask(runId, 'Should the list be sorted?', 'q-3');

    expect(third.json().answer.decision).toBe('blocked');
    expect(third.json().answer.reasoning).toContain('limit');
  });

  it('refuses a question about a run belonging to another worker', async () => {
    const { runId } = await dispatchedRun();
    const other = await registerTestWorker(app.fastify, { name: 'other-worker' });

    const response = await post(other.token, `/api/worker/runs/${runId}/questions`, {
      questionId: 'q-x',
      question: 'What testing is expected?',
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('self-review (Sprint 2 §12)', () => {
  it('moves the run into self_review and recommends a pull request for clean work', async () => {
    const { runId } = await dispatchedRun();

    const response = await post(workerToken, `/api/worker/runs/${runId}/review`, { evidence: evidence() });
    expect(response.statusCode).toBe(200);

    const verdict = response.json();
    expect(verdict.verdict).toBe('satisfies_brief');
    expect(verdict.riskLevel).toBe('low');
    expect(verdict.pullRequest.shouldOpen).toBe(true);
    expect(verdict.pullRequest.base).toBe('main');

    // The seven required sections, in order.
    for (const heading of ['## Summary', '## Why', '## Testing', '## Assumptions', '## Decisions Requiring Review', '## Risk', '## Known Issues']) {
      expect(verdict.pullRequest.body).toContain(heading);
    }
    expect(verdict.pullRequest.body).toContain('does not merge');

    const run = (await api(operator).get(`/api/runs/${runId}`)).json().run;
    expect(run.status).toBe('self_review');

    const events = await queryAuditEvents({ runId, limit: 50, offset: 0 });
    expect(events.some((e) => e.eventType === 'run.self_review')).toBe(true);
    expect(events.some((e) => e.eventType === 'run.review_completed')).toBe(true);
    expect(events.some((e) => e.eventType === 'test.run')).toBe(true);
  });

  it('refuses a pull request when tests failed, and says why', async () => {
    const { runId } = await dispatchedRun();

    const response = await post(workerToken, `/api/worker/runs/${runId}/review`, {
      evidence: evidence({ tests: { ran: true, command: ['npm', 'test'], exitCode: 1, passed: false, durationMs: 900, output: '2 failing' } }),
    });

    const verdict = response.json();
    expect(verdict.pullRequest.shouldOpen).toBe(false);
    expect(verdict.pullRequest.reason).toContain('Tests failed');
    expect(verdict.humanAttentionRequired).toBe(true);

    const events = await queryAuditEvents({ runId, limit: 50, offset: 0 });
    expect(events.some((e) => e.eventType === 'test.failed')).toBe(true);
    expect(events.some((e) => e.eventType === 'pull_request.declined')).toBe(true);
  });

  it('refuses a pull request when the coding agent attempted a prohibited git operation', async () => {
    const { runId } = await dispatchedRun();

    await post(workerToken, `/api/worker/runs/${runId}/git-violation`, {
      code: 'PUSH_TO_DEFAULT',
      argv: ['push', 'origin', 'main'],
      message: 'Pushing to the default branch "main" is prohibited.',
      origin: 'agent',
      at: new Date().toISOString(),
    });

    const verdict = (await post(workerToken, `/api/worker/runs/${runId}/review`, { evidence: evidence() })).json();
    expect(verdict.pullRequest.shouldOpen).toBe(false);
    expect(verdict.pullRequest.reason).toContain('prohibited git operation');

    const detail = (await api(operator).get(`/api/runs/${runId}/coding`)).json().detail;
    expect(detail.violations).toHaveLength(1);
    expect(detail.violations[0].origin).toBe('agent');

    const events = await queryAuditEvents({ runId, eventType: 'git.operation_rejected', limit: 5, offset: 0 });
    expect(events).toHaveLength(1);
  });

  it('refuses a pull request when the default branch moved', async () => {
    const { runId } = await dispatchedRun();
    const verdict = (
      await post(workerToken, `/api/worker/runs/${runId}/review`, { evidence: evidence({ defaultBranchUnchanged: false }) })
    ).json();

    expect(verdict.verdict).toBe('unreviewable');
    expect(verdict.riskLevel).toBe('high');
    expect(verdict.pullRequest.shouldOpen).toBe(false);
  });

  it('does not believe an agent that reports success while producing nothing', async () => {
    const { runId } = await dispatchedRun();
    const verdict = (
      await post(workerToken, `/api/worker/runs/${runId}/review`, {
        evidence: evidence({ commits: [], filesChanged: [], diffStat: { files: 0, insertions: 0, deletions: 0 } }),
      })
    ).json();

    expect(verdict.verdict).toBe('does_not_satisfy_brief');
    expect(verdict.anomalies.join(' ')).toContain('no commits');
    expect(verdict.pullRequest.shouldOpen).toBe(false);
  });

  it('reports a dependency change without blocking the pull request', async () => {
    const { runId } = await dispatchedRun();
    const verdict = (
      await post(workerToken, `/api/worker/runs/${runId}/review`, {
        evidence: evidence({ dependencyChanges: ['package.json'] }),
      })
    ).json();

    expect(verdict.riskLevel).toBe('medium');
    expect(verdict.anomalies.join(' ')).toContain('Dependency manifests changed');
    expect(verdict.pullRequest.shouldOpen).toBe(true);
  });

  it('blocks the pull request while a high-risk blocker is unresolved', async () => {
    const { runId } = await dispatchedRun();
    await ask(runId, 'Should I drop the devices table to apply the new schema?');

    const verdict = (await post(workerToken, `/api/worker/runs/${runId}/review`, { evidence: evidence() })).json();
    expect(verdict.pullRequest.shouldOpen).toBe(false);
    expect(verdict.pullRequest.reason).toMatch(/blocker|question/);
  });
});

describe('pull requests (Sprint 2 §13)', () => {
  it('records a pull request the review approved', async () => {
    const { runId } = await dispatchedRun();
    await post(workerToken, `/api/worker/runs/${runId}/review`, { evidence: evidence() });

    const response = await post(workerToken, `/api/worker/runs/${runId}/pull-request`, {
      number: 12,
      url: 'https://github.com/pac-technologies/device-portal/pull/12',
      title: 'Allow selecting multiple devices',
      branch: 'mac/abc12345-allow-selecting-multiple-devices',
      baseBranch: 'main',
      provider: 'github',
    });
    expect(response.statusCode).toBe(200);

    const detail = (await api(operator).get(`/api/runs/${runId}/coding`)).json().detail;
    expect(detail.pullRequest.number).toBe(12);
    // There is no merge state to record, because Mac cannot merge.
    expect(Object.keys(detail.pullRequest)).not.toContain('mergedAt');
  });

  it('refuses to record a pull request the review did not recommend', async () => {
    const { runId } = await dispatchedRun();
    await post(workerToken, `/api/worker/runs/${runId}/review`, {
      evidence: evidence({ tests: { ran: true, command: ['npm', 'test'], exitCode: 1, passed: false, durationMs: 1, output: 'fail' } }),
    });

    const response = await post(workerToken, `/api/worker/runs/${runId}/pull-request`, {
      number: 13,
      url: 'https://github.com/x/y/pull/13',
      title: 'Sneaky',
      branch: 'mac/abc-sneaky',
      baseBranch: 'main',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('PR_NOT_APPROVED_BY_REVIEW');
  });

  it('refuses a pull request whose head is the default branch', async () => {
    const { runId } = await dispatchedRun();
    await post(workerToken, `/api/worker/runs/${runId}/review`, { evidence: evidence() });

    const response = await post(workerToken, `/api/worker/runs/${runId}/pull-request`, {
      number: 14,
      url: 'https://github.com/x/y/pull/14',
      title: 'Merge main into main',
      branch: 'main',
      baseBranch: 'main',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('PR_HEAD_IS_BASE');
  });
});

describe('usage (Sprint 2 §15)', () => {
  it('records exact, observed, estimated and unavailable distinctly', async () => {
    const { runId } = await dispatchedRun();

    await post(workerToken, `/api/worker/runs/${runId}/usage`, {
      snapshot: {
        provider: 'claude_code',
        phase: 'before',
        source: 'observed',
        capturedAt: new Date().toISOString(),
        state: 'allowed',
        reportingPeriod: 'five_hour',
      },
    });

    await post(workerToken, `/api/worker/runs/${runId}/usage`, {
      snapshot: {
        provider: 'claude_code',
        phase: 'after',
        source: 'estimated',
        capturedAt: new Date().toISOString(),
        inputTokens: 1200,
        outputTokens: 340,
        costCents: 34,
        note: 'Subscription access; the dollar figure is a list-price equivalent, not money billed.',
      },
    });

    const usage = (await api(operator).get(`/api/runs/${runId}/usage`)).json();
    expect(usage.snapshots).toHaveLength(2);
    expect(usage.usage.source).toBe('estimated');
    // Money that is not exact is never presented as enforceable.
    expect(usage.usage.costEnforceable).toBe(false);
    expect(usage.usage.label).toContain('not billed');

    const events = await queryAuditEvents({ runId, eventType: 'usage.snapshot', limit: 10, offset: 0 });
    expect(events).toHaveLength(2);
  });

  it('says "Provider usage unavailable" rather than reporting zero', async () => {
    const { runId } = await dispatchedRun();

    await post(workerToken, `/api/worker/runs/${runId}/usage`, {
      snapshot: {
        provider: 'claude_code',
        phase: 'after',
        source: 'unavailable',
        capturedAt: new Date().toISOString(),
        note: 'The CLI exposes no usage for this session.',
      },
    });

    const usage = (await api(operator).get(`/api/runs/${runId}/usage`)).json().usage;
    expect(usage.source).toBe('unavailable');
    expect(usage.label).toBe('Provider usage unavailable');
    expect(usage.delta.meaningful).toBe(false);
  });

  it('keeps a soft usage signal separate from an enforceable budget', async () => {
    const { runId } = await dispatchedRun();
    await post(workerToken, `/api/worker/runs/${runId}/usage`, {
      snapshot: {
        provider: 'claude_code',
        phase: 'after',
        source: 'estimated',
        capturedAt: new Date().toISOString(),
        costCents: 9000, // far above the 5000c nightly budget
        outputTokens: 100,
      },
    });

    const budget = (await api(operator).get('/api/budget')).json().budget;
    // Estimated cost does not count toward the hard budget...
    expect(budget.recordedSpendCents).toBe(0);
    expect(budget.costEnforceable).toBe(false);
    // ...but it is visible as a soft signal, with its uncertainty stated.
    expect(budget.softUsage.estimatedSpendCents).toBe(9000);
    expect(budget.softUsage.warning).toBe(true);
    expect(budget.softUsage.note).toContain('not an enforceable monetary limit');
  });
});

describe('the morning report (Sprint 2 §14)', () => {
  it('assembles a short report from what actually happened', async () => {
    const { runId } = await dispatchedRun();

    await ask(runId, 'What testing expectations apply for the selection reducer?', 'q-1');
    await ask(runId, 'Should the device list be sorted alphabetically?', 'q-2');
    await post(workerToken, `/api/worker/runs/${runId}/usage`, {
      snapshot: {
        provider: 'claude_code',
        phase: 'after',
        source: 'estimated',
        capturedAt: new Date().toISOString(),
        inputTokens: 1200,
        outputTokens: 340,
        costCents: 34,
      },
    });
    await post(workerToken, `/api/worker/runs/${runId}/review`, { evidence: evidence() });

    const report = (await api(operator).get(`/api/runs/${runId}/report`)).json().report;

    expect(report.questionsAnswered).toBe(2);
    expect(report.lowConfidenceAnswers).toBe(1);
    expect(report.flaggedAssumptions).toHaveLength(1);
    expect(report.questionsLogUrl).toContain(`/runs/${runId}/questions`);

    // Short at the top; the detail lives behind links. A flagged assumption is
    // summarised in one line — the full question, answer, reasoning and sources
    // stay on the Q&A log rather than being inlined here.
    expect(report.whatChanged.length).toBeLessThan(300);
    expect(report.markdown).not.toContain('Matched'); // no reasoning text
    expect(report.markdown).not.toContain('brief.testingExpectations'); // no source labels
    expect(report.flaggedAssumptions[0].statement.length).toBeLessThan(400);
    expect(report.markdown.length).toBeLessThan(4000);

    for (const heading of [
      '## What Changed', '## Why', '## Risk', '## Exceptions / Anomalies',
      '## Decisions Needed', '## Assumptions', '## Questions Mac Answered',
      '## Pull Request', '## Estimated Human Hours', '## AI Usage',
    ]) {
      expect(report.markdown, `missing ${heading}`).toContain(heading);
    }

    expect(report.estimatedHumanHours).toBeGreaterThan(0);
    expect(report.estimatedHumanHoursBasis).toContain('estimate');

    const events = await queryAuditEvents({ runId, eventType: 'report.generated', limit: 5, offset: 0 });
    expect(events).toHaveLength(1);
  });

  it('explains why no pull request was opened', async () => {
    const { runId } = await dispatchedRun();
    await post(workerToken, `/api/worker/runs/${runId}/review`, {
      evidence: evidence({ tests: { ran: true, command: ['npm', 'test'], exitCode: 1, passed: false, durationMs: 1, output: 'fail' } }),
    });

    const report = (await api(operator).get(`/api/runs/${runId}/report`)).json().report;
    expect(report.pullRequestUrl).toBeNull();
    expect(report.pullRequestDeclineReason).toContain('Tests failed');
    expect(report.markdown).toContain('Tests failed');
  });
});

describe('memory (spec §9)', () => {
  it('does not let one task\'s memory contaminate another', async () => {
    const first = await dispatchedRun();

    await api(operator).post('/api/memory', {
      scope: 'task',
      taskId: first.taskId,
      key: 'sort order',
      value: 'for this task only, sort devices by last-seen time',
      confidence: 0.9,
    });

    // A second task in the same project must not see it.
    const second = await dispatchedRun();
    const answer = (await ask(second.runId, 'What sort order should the device list use?')).json().answer;
    expect(answer.answer).not.toContain('last-seen time');
  });

  it('refuses to promote an unvalidated assumption into project memory', async () => {
    const { taskId } = await dispatchedRun();
    const created = await api(operator).post('/api/memory', {
      scope: 'task',
      taskId,
      key: 'guess',
      value: 'probably sorted alphabetically',
      confidence: 0.4,
    });

    const promoted = await api(operator).post(`/api/memory/${created.json().memory.id}/promote`, { projectId });
    expect(promoted.statusCode).toBe(409);
    expect(promoted.json().error.code).toBe('MEMORY_NOT_VALIDATED');
  });

  it('uses project memory to answer a question the brief does not cover', async () => {
    await api(operator).post('/api/memory', {
      scope: 'project',
      projectId,
      key: 'indentation style',
      value: 'two spaces, enforced by the repository formatter',
      confidence: 1,
    });

    const { runId } = await dispatchedRun();
    const answer = (await ask(runId, 'What indentation style does this codebase use?')).json().answer;

    expect(answer.answer).toContain('two spaces');
    expect(answer.sources.join(' ')).toContain('project memory');
  });
});
