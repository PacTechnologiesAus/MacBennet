import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { mondayItems, mondayWrites, runArtefacts, runs, tasks } from '../../src/db/schema.js';
import {
  asUser,
  asWorker,
  createAndLogin,
  resetDatabase,
  startTestApp,
  type Session,
  type TestApp,
} from '../helpers/harness.js';
import { queryAuditEvents } from '../../src/services/audit-query.js';
import { makeProject, makeTask, registerTestWorker } from '../helpers/fixtures.js';
import { ScriptedModelProvider, setModelProvider } from '../../src/services/model/provider.js';
import { nightShiftTick, startNightShift } from '../../src/services/night-shift.js';
import { SYSTEM_ACTOR } from '../../src/services/audit.js';
import { generateRunReport } from '../../src/services/reports.js';

/**
 * Sprint 3.3 end to end: a night of NON-CODING work.
 *
 * ---------------------------------------------------------------------------
 * THE PRODUCT ACCEPTANCE TEST
 *
 * A task created in Mac's own UI, in a project with no Git repository and no
 * monday.com board, goes all the way:
 *
 *   Start Discovery → brief → derived confidence → human approval of the
 *   project for this kind of work → night shift selects it → a worker leases it
 *   → the control plane performs the reasoning → an evidence-backed artefact
 *   → a morning report.
 *
 * Every step of that was impossible before this sprint, and the last of the
 * seven blockers reported against the real task was that no path existed at all.
 * ---------------------------------------------------------------------------
 */

let app: TestApp;
let admin: Session;
let operator: Session;

const api = (session: Session) => asUser(app.fastify, session);

beforeAll(async () => {
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDatabase();
  admin = await createAndLogin(app.fastify, { email: 'admin@pac.test', role: 'admin' });
  operator = await createAndLogin(app.fastify, { email: 'operator@pac.test', role: 'operator' });
  setModelProvider(null);
});

/** Gathers once from project memory, then writes up. No network, no guessing. */
const researchModel = () =>
  new ScriptedModelProvider([
    JSON.stringify({
      toolCalls: [
        { tool: 'project_memory_search', argument: 'project registry', purpose: 'what PAC already records' },
      ],
      findings: [],
      narrative: 'Checking what is already recorded about how PAC tracks projects.',
      unknowns: [],
      artefacts: [],
      blockerProposed: null,
    }),
    JSON.stringify({
      toolCalls: [],
      findings: [
        {
          statement: 'Project information is currently spread across monday.com, Dropbox and the repository.',
          evidenceClass: 'inference',
          confidence: 0.75,
          sources: [],
          reasoning: 'Drawn from what the brief describes; no single record states it.',
        },
      ],
      narrative: 'Writing up what was established and what was not.',
      unknowns: ['Whether Otto already holds a document register that overlaps a registry.'],
      artefacts: [
        {
          type: 'investigation_report',
          title: 'PAC Project Registry, Document Controller and Sales Engineer',
          format: 'markdown',
          body:
            '## What was asked\nWhether PAC should build a project registry.\n\n' +
            '## What Mac established\nSee the findings table.\n\n' +
            '## What Mac could not establish\nWhether Otto already covers this.',
          summary: 'A registry overlaps existing systems; a decision is needed on scope before any build.',
          findings: [],
        },
      ],
      blockerProposed: null,
    }),
  ]);

describe('Sprint 3.3 end to end: Mac does a night of research', () => {
  it('takes a direct task with no repository and no monday item all the way to a reported artefact', async () => {
    // --- A worker that can do general work, and nothing else ----------------
    //
    // Deliberately NOT `claude_code`: this proves the run does not quietly
    // depend on the coding capability being present.
    const worker = await registerTestWorker(app.fastify, { capabilities: ['general_task'] });
    // A registered worker is not yet an idle one; the scheduler withholds work
    // from anything that has not said it is ready (Sprint 3.3 §22).
    await asWorker(app.fastify, worker.token).post('/api/worker/heartbeat', {
      status: 'idle',
      currentRunId: null,
    });

    // --- A project shaped like PAC Internal Development ---------------------
    const project = await makeProject(app.fastify, admin, {
      name: 'PAC Internal Development',
      repoUrl: null,
    });

    // --- 1. A human creates a task in Mac's own UI --------------------------
    const task = await makeTask(app.fastify, operator, project.id, {
      title: 'Investigate PAC Project Registry, Document Controller & Sales Engineer',
      priority: 'high',
      description: 'We keep re-deciding how project information is tracked. Work out what we should actually build.',
    });

    // No task kind was supplied, so Mac classifies it during discovery.
    const beforeDiscovery = (await api(operator).get(`/api/tasks/${task.id}`)).json();
    expect(beforeDiscovery.execution.blockerSummary).toMatch(/Discovery has not been started/);
    expect(beforeDiscovery.execution.discovery.canStart).toBe(true);

    // --- 2. Start Discovery -------------------------------------------------
    const started = await api(operator).post(`/api/tasks/${task.id}/discovery`, {});
    expect(started.statusCode).toBe(201);
    const discoveryId = started.json().discovery.id;

    const [classified] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(classified!.taskKind).toBe('investigation');
    expect(classified!.origin).toBe('direct');

    // --- 3. The human explains the work, Mac structures it ------------------
    await api(operator).post(`/api/discovery/${discoveryId}/messages`, {
      message:
        'At the moment project information lives in monday.com, in Dropbox job folders and in a few spreadsheets. ' +
        'We need to know whether a project registry is worth building, and how it would relate to Otto. ' +
        'It is done when we have a costed recommendation covering all three areas. ' +
        "Don't assume monday.com is being replaced, because delivery depends on it.",
    });

    const briefResponse = await api(operator).post(`/api/discovery/${discoveryId}/brief`, {});
    expect(briefResponse.statusCode).toBe(201);
    const brief = briefResponse.json().brief;

    // Mac's confidence is DERIVED, and it is his rather than anybody's estimate.
    expect(brief.confidence).toBeGreaterThan(0);

    // --- 4. Answer whatever Mac still had to ask, one question at a time ----
    for (let i = 0; i < 4; i += 1) {
      const session = (await api(operator).get(`/api/discovery/${discoveryId}`)).json().session;
      if (!session.pendingQuestion) break;
      await api(operator).post(`/api/discovery/${discoveryId}/messages`, {
        message:
          'The audience is the engineering managers, and the acceptance criteria are a written recommendation ' +
          'with a rough cost for each of the three areas. The architecture should assume monday.com stays.',
      });
      await api(operator).post(`/api/discovery/${discoveryId}/brief`, {});
    }

    const finalBrief = (await api(operator).get(`/api/tasks/${task.id}/brief`)).json().brief;
    expect(finalBrief.confidence).toBeGreaterThanOrEqual(0.8);

    // --- 5. A human approves the project for this kind of work --------------
    //
    // Sprint 3.3 §21: the migration must NOT enable this, and it does not. Up
    // to this point the project permits only coding, which it cannot do.
    const beforeApproval = (await api(operator).get(`/api/tasks/${task.id}`)).json();
    expect(beforeApproval.execution.eligibility.blockingCodes).toContain('task_kind_permitted');

    await api(admin).patch(`/api/projects/${project.id}/capabilities`, {
      capabilities: ['company_context', 'internal_only'],
      allowedTaskKinds: ['investigation', 'research', 'scoping'],
    });
    await api(admin).post(`/api/projects/${project.id}/night-shift-approval`, { approved: true });

    // A real reasoning provider, without which general work refuses to run.
    await api(admin).patch('/api/settings', { modelProvider: 'scripted', nightShiftEnabled: true });
    setModelProvider(researchModel());

    // --- 6. The night shift selects it, from the direct queue ---------------
    const shift = await startNightShift(
      { cutoffAt: new Date(Date.now() + 6 * 60 * 60_000).toISOString() },
      SYSTEM_ACTOR,
    );
    const tick = await nightShiftTick();
    expect(tick.decision).toBe('start');
    expect(tick.taskId).toBe(task.id);

    const [run] = await db.select().from(runs).where(eq(runs.taskId, task.id));
    expect(run!.jobKind).toBe('general_task');
    // The two absences this whole sprint is about.
    expect(run!.repositoryId).toBeNull();
    expect(run!.mondayItemId).toBeNull();
    expect(run!.selectedBy).toBe('night_shift');
    expect(run!.nightShiftId).toBe(shift.id);

    // Nothing was written to a board, because there is no board to write to.
    expect(await db.select().from(mondayWrites)).toHaveLength(0);
    expect(await db.select().from(mondayItems)).toHaveLength(0);

    // --- 7. A worker leases it and drives the run ---------------------------
    const workerApi = asWorker(app.fastify, worker.token);

    const lease = await workerApi.post('/api/worker/lease', { capabilities: ['general_task'] });
    expect(lease.statusCode).toBe(200);
    const assignment = lease.json().assignment;
    expect(assignment.runId).toBe(run!.id);
    expect(assignment.jobKind).toBe('general_task');
    // Server-built, and carrying no credential, no prompt and no tool.
    expect(assignment.general.taskKind).toBe('investigation');
    expect(assignment.general.objective.length).toBeGreaterThan(0);
    expect(assignment.coding).toBeNull();

    let done = false;
    for (let step = 0; step < 8 && !done; step += 1) {
      const response = await workerApi.post(`/api/worker/runs/${run!.id}/research-step`, {});
      expect(response.statusCode).toBe(200);
      done = response.json().done;
    }
    expect(done).toBe(true);

    const complete = await workerApi.post(`/api/worker/runs/${run!.id}/complete`, {
      outcome: 'succeeded',
      summary: 'Investigation complete; one report produced.',
    });
    expect(complete.statusCode).toBe(200);

    // --- 8. The results are artefacts, with provenance ----------------------
    const artefacts = await db.select().from(runArtefacts).where(eq(runArtefacts.runId, run!.id));
    expect(artefacts).toHaveLength(1);
    expect(artefacts[0]!.artefactType).toBe('investigation_report');
    expect(artefacts[0]!.body).toMatch(/could not establish/i);

    const findings = artefacts[0]!.findings as Array<{ evidenceClass: string; confidence: number }>;
    // The model claimed an inference and was believed about that, but its
    // confidence is capped because nothing was retrieved to support it.
    expect(findings[0]!.evidenceClass).toBe('inference');
    expect(findings[0]!.confidence).toBeLessThanOrEqual(0.59);

    const listed = await api(operator).get(`/api/artefacts?runId=${run!.id}`);
    expect(listed.json().artefacts).toHaveLength(1);

    // --- 9. The morning report describes research, not a diff ---------------
    const report = await generateRunReport(run!.id, SYSTEM_ACTOR);
    expect(report.markdown).toMatch(/## What Mac Found/);
    expect(report.markdown).not.toMatch(/## Pull Request/);
    expect(report.markdown).toMatch(/## Still Unknown/);
    expect(report.markdown).toMatch(/Otto already holds a document register/);
    expect(report.findings?.artefacts).toHaveLength(1);
    expect(report.findings?.externalSourcesUsed).toBe(0);

    // --- 10. The whole thing is inspectable ---------------------------------
    const events = await queryAuditEvents({ runId: run!.id, limit: 200, offset: 0 });
    const types = events.map((e) => e.eventType);
    for (const expected of [
      'run.auto_approved',
      'night_shift.task_selected',
      'run.dispatched',
      'research.plan_built',
      'research.tool_called',
      'research.step_completed',
      'artefact.created',
      'run.completed',
    ]) {
      expect(types, expected).toContain(expected);
    }

    // A machine approval is never readable as a human one.
    const approval = events.find((e) => e.eventType === 'run.auto_approved');
    expect((approval!.metadata as { basis: string }).basis).toMatch(/project permits this task kind/);
    expect(types).not.toContain('run.approved');
  }, 60_000);

  it('refuses to start general work when no reasoning provider is configured', async () => {
    const worker = await registerTestWorker(app.fastify, { capabilities: ['general_task'] });
    await asWorker(app.fastify, worker.token).post('/api/worker/heartbeat', {
      status: 'idle',
      currentRunId: null,
    });
    const project = await makeProject(app.fastify, admin, { name: 'Internal', repoUrl: null });
    const task = await makeTask(app.fastify, operator, project.id, {
      title: 'Investigate the thing',
      taskKind: 'investigation',
    });

    const { discovery } = (await api(operator).post(`/api/tasks/${task.id}/discovery`, {})).json();
    await api(operator).post(`/api/discovery/${discovery.id}/messages`, {
      message:
        'At the moment nobody knows. We need a recommendation. It is done when we have one. ' +
        'The audience is the engineering managers.',
    });
    await api(operator).post(`/api/discovery/${discovery.id}/brief`, {});

    await api(admin).patch(`/api/projects/${project.id}/capabilities`, {
      allowedTaskKinds: ['investigation'],
    });
    await api(admin).post(`/api/projects/${project.id}/night-shift-approval`, { approved: true });
    // modelProvider stays `none`.
    await api(admin).patch('/api/settings', { nightShiftEnabled: true });

    await startNightShift({}, SYSTEM_ACTOR);
    const tick = await nightShiftTick();

    // Not started, and not silently skipped either: the queue records why.
    expect(tick.decision).not.toBe('start');
    const detail = (await api(operator).get(`/api/tasks/${task.id}`)).json();
    expect(detail.execution.eligibility.blockingCodes).toContain('reasoning_model_available');
    expect(
      detail.execution.requirements.find((r: { requirement: string }) => r.requirement === 'reasoning_model').detail,
    ).toMatch(/MODEL_PROVIDER_REQUIRED/);
  }, 30_000);
});
