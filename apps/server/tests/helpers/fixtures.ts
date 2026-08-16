import type { FastifyInstance } from 'fastify';
import { JOB_KINDS, PROTOCOL_VERSION, type JobKind } from '@mac/protocol';
import { createEnrollmentToken } from '../../src/services/workers.js';
import { SYSTEM_ACTOR } from '../../src/services/audit.js';
import { asUser, type Session } from './harness.js';

/**
 * Fixture builders. Each one goes through the real HTTP surface rather than
 * inserting rows directly, so a test that says "given an approved run" is
 * asserting that the approval path actually works, not fabricating a state the
 * application could never reach.
 */

export async function makeProject(
  app: FastifyInstance,
  session: Session,
  overrides: { name?: string; repoUrl?: string } = {},
): Promise<{ id: string; name: string }> {
  const response = await asUser(app, session).post('/api/projects', {
    name: overrides.name ?? `Project ${Math.floor(Math.random() * 1e9)}`,
    description: 'Created by the integration test suite.',
    repoUrl: overrides.repoUrl ?? 'https://github.com/pac-technologies/example.git',
  });
  if (response.statusCode !== 201) throw new Error(`makeProject failed: ${response.body}`);
  return response.json().project;
}

export async function makeTask(
  app: FastifyInstance,
  session: Session,
  projectId: string,
  overrides: { title?: string; priority?: string; confidence?: number } = {},
): Promise<{ id: string; title: string }> {
  const response = await asUser(app, session).post('/api/tasks', {
    projectId,
    title: overrides.title ?? 'Prove the control loop',
    description: 'A Sprint 1 task.',
    priority: overrides.priority ?? 'normal',
    ...(overrides.confidence !== undefined ? { confidence: overrides.confidence } : {}),
  });
  if (response.statusCode !== 201) throw new Error(`makeTask failed: ${response.body}`);
  return response.json().task;
}

export async function makeRun(
  app: FastifyInstance,
  session: Session,
  taskId: string,
  overrides: { jobKind?: JobKind; jobParams?: Record<string, unknown>; confidence?: number; executionMode?: string } = {},
): Promise<{ id: string; status: string; approvalState: string }> {
  const response = await asUser(app, session).post('/api/runs', {
    taskId,
    jobKind: overrides.jobKind ?? 'noop',
    jobParams: overrides.jobParams ?? {},
    confidence: overrides.confidence ?? 0.9,
    executionMode: overrides.executionMode ?? 'interactive',
  });
  if (response.statusCode !== 201) throw new Error(`makeRun failed: ${response.body}`);
  return response.json().run;
}

/** Drives a run all the way to `queued` through the real submit/approve path. */
export async function makeApprovedRun(
  app: FastifyInstance,
  session: Session,
  taskId: string,
  overrides: Parameters<typeof makeRun>[3] = {},
): Promise<{ id: string }> {
  const run = await makeRun(app, session, taskId, overrides);
  const api = asUser(app, session);

  const submitted = await api.post(`/api/runs/${run.id}/submit`);
  if (submitted.statusCode !== 200) throw new Error(`submit failed: ${submitted.body}`);

  const approved = await api.post(`/api/runs/${run.id}/approve`, { notes: 'Approved by fixture.' });
  if (approved.statusCode !== 200) throw new Error(`approve failed: ${approved.body}`);

  return run;
}

export interface RegisteredWorker {
  workerId: string;
  token: string;
  name: string;
}

export async function registerTestWorker(
  app: FastifyInstance,
  overrides: { name?: string; capabilities?: JobKind[] } = {},
): Promise<RegisteredWorker> {
  // Enrollment tokens are minted through the service rather than the admin
  // route so that worker fixtures do not require an admin session.
  const enrollment = await createEnrollmentToken({ label: 'test', expiresInHours: 1 }, SYSTEM_ACTOR);
  const name = overrides.name ?? `test-worker-${Math.floor(Math.random() * 1e9)}`;

  const response = await app.inject({
    method: 'POST',
    url: '/api/worker/register',
    headers: { authorization: `Bearer ${enrollment.token}` },
    payload: {
      name,
      capabilities: overrides.capabilities ?? [...JOB_KINDS],
      version: '0.1.0-test',
      platform: 'linux-x64-test',
      protocolVersion: PROTOCOL_VERSION,
    },
  });
  if (response.statusCode !== 201) throw new Error(`registerTestWorker failed: ${response.body}`);

  const body = response.json();
  return { workerId: body.workerId, token: body.workerToken, name };
}
