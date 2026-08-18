import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { MODEL_PROVIDER_REQUIRED } from '@mac/protocol';
import { db } from '../../src/db/client.js';
import { generalRunState, mondayWrites, runArtefacts, runUsage, runs, tasks } from '../../src/db/schema.js';
import { asUser, createAndLogin, resetDatabase, startTestApp, type Session, type TestApp } from '../helpers/harness.js';
import { queryAuditEvents } from '../../src/services/audit-query.js';
import { makeProject, makeTask, registerTestWorker } from '../helpers/fixtures.js';
import { setModelProvider, ScriptedModelProvider } from '../../src/services/model/provider.js';
import { beginGeneralRun, performResearchStep } from '../../src/services/research/runner.js';
import { generateRunReport } from '../../src/services/reports.js';

/**
 * General (non-coding) work, end to end (Sprint 3.3 §28).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE HAS TO PROVE
 *
 * That a task created in Mac's own UI, with no monday.com item and no Git
 * repository, can go: discovery → brief → approval → run → artefact → report.
 *
 * That is the product acceptance case for the sprint, and before it the system
 * had no path for it at all.
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

/** A project shaped like `PAC Internal Development`: internal, no repository. */
async function internalProject(name = 'PAC Internal Development') {
  const project = await makeProject(app.fastify, admin, { name, repoUrl: null });
  return project;
}

async function allowResearch(projectId: string) {
  const response = await api(admin).patch(`/api/projects/${projectId}/capabilities`, {
    capabilities: ['company_context', 'internal_only'],
    allowedTaskKinds: ['research', 'investigation', 'scoping'],
  });
  if (response.statusCode !== 200) throw new Error(`allowResearch failed: ${response.body}`);
}

/** A model that gathers once, then writes up. Deterministic, no network. */
function scriptedResearch() {
  return new ScriptedModelProvider([
    JSON.stringify({
      toolCalls: [{ tool: 'project_memory_search', argument: 'project registry', purpose: 'what we already know' }],
      findings: [],
      narrative: 'Looking at what PAC has already decided.',
      unknowns: [],
      artefacts: [],
      blockerProposed: null,
    }),
    JSON.stringify({
      toolCalls: [],
      findings: [
        {
          statement: 'A project registry would need to reconcile with monday.com.',
          evidenceClass: 'inference',
          confidence: 0.7,
          sources: [],
          reasoning: 'Follows from what the project already integrates with.',
        },
      ],
      narrative: 'Reasoning over what was gathered.',
      unknowns: ['Whether Otto already stores this information.'],
      artefacts: [
        {
          type: 'investigation_report',
          title: 'PAC Project Registry — investigation',
          format: 'markdown',
          body: '## What was asked\nWhether a project registry is worth building.\n\n## What Mac established\nSee findings.',
          summary: 'A registry is plausible but overlaps with existing systems.',
          findings: [],
        },
      ],
      blockerProposed: null,
    }),
  ]);
}

// ---------------------------------------------------------------------------

describe('a direct task needs neither a repository nor a monday item', () => {
  it('reports its own execution requirements, and none of them is a repository', async () => {
    const project = await internalProject();
    await allowResearch(project.id);
    const task = await makeTask(app.fastify, operator, project.id, {
      title: 'Investigate the PAC project registry',
      taskKind: 'investigation',
    });

    const detail = await api(operator).get(`/api/tasks/${task.id}`);
    expect(detail.statusCode).toBe(200);

    const { execution } = detail.json();
    expect(execution.taskKind).toBe('investigation');
    expect(execution.origin).toBe('direct');
    expect(execution.requirements.map((r: { requirement: string }) => r.requirement)).not.toContain('repository');
    expect(execution.requirements.map((r: { requirement: string }) => r.requirement)).not.toContain('monday_item');
    expect(execution.requirements.map((r: { requirement: string }) => r.requirement)).toContain('reasoning_model');
  });

  it('tells the user in one sentence what is stopping it', async () => {
    const project = await internalProject();
    await allowResearch(project.id);
    const task = await makeTask(app.fastify, operator, project.id, { taskKind: 'research' });

    const { execution } = (await api(operator).get(`/api/tasks/${task.id}`)).json();
    // The failure that started this sprint: a user created a task and the
    // screen said nothing at all.
    expect(execution.blockerSummary).toMatch(/Discovery has not been started/);
    expect(execution.discovery.canStart).toBe(true);
  });
});

describe('Start Discovery, from the task itself', () => {
  it('creates a session and is idempotent when pressed twice', async () => {
    const project = await internalProject();
    await allowResearch(project.id);
    const task = await makeTask(app.fastify, operator, project.id, { taskKind: 'research' });

    const first = await api(operator).post(`/api/tasks/${task.id}/discovery`, {});
    expect(first.statusCode).toBe(201);
    expect(first.json().created).toBe(true);

    const second = await api(operator).post(`/api/tasks/${task.id}/discovery`, {});
    expect(second.statusCode).toBe(200);
    expect(second.json().created).toBe(false);
    // Pressing a button twice must not start a second conversation about one task.
    expect(second.json().discovery.id).toBe(first.json().discovery.id);
  });

  it('records that a human asked for discovery', async () => {
    const project = await internalProject();
    await allowResearch(project.id);
    const task = await makeTask(app.fastify, operator, project.id, { taskKind: 'research' });
    await api(operator).post(`/api/tasks/${task.id}/discovery`, {});

    const events = await queryAuditEvents({ taskId: task.id, limit: 20, offset: 0 });
    expect(events.map((e) => e.eventType)).toContain('task.discovery_requested');
  });

  it('proposes a task kind for an unclassified task, and records the change', async () => {
    const project = await internalProject();
    await allowResearch(project.id);
    // No taskKind supplied: the column default is `coding`.
    const task = await makeTask(app.fastify, operator, project.id, {
      title: 'Investigate why the overnight import keeps failing',
    });

    await api(operator).post(`/api/tasks/${task.id}/discovery`, {});

    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row!.taskKind).toBe('investigation');

    const events = await queryAuditEvents({ taskId: task.id, limit: 20, offset: 0 });
    const change = events.find((e) => e.eventType === 'task.kind_changed');
    expect(change).toBeDefined();
    // A reclassification is invisible to whoever wrote the title, so the words
    // that decided it are recorded.
    expect((change!.metadata as { signals: string[] }).signals.length).toBeGreaterThan(0);
  });

  it('leaves an ambiguous title alone rather than guessing', async () => {
    const project = await internalProject();
    await allowResearch(project.id);
    const task = await makeTask(app.fastify, operator, project.id, { title: 'Widgets' });

    await api(operator).post(`/api/tasks/${task.id}/discovery`, {});

    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row!.taskKind).toBe('coding');
  });
});

describe('discovery derives confidence, and a typed number cannot substitute', () => {
  it('stores an understanding confidence separate from the requester’s estimate', async () => {
    const project = await internalProject();
    await allowResearch(project.id);
    const task = await makeTask(app.fastify, operator, project.id, {
      title: 'Investigate the registry',
      taskKind: 'investigation',
      // A human typing 0.99 must not make Mac confident.
      userInitialConfidence: 0.99,
    });

    const { discovery } = (await api(operator).post(`/api/tasks/${task.id}/discovery`, {})).json();
    await api(operator).post(`/api/discovery/${discovery.id}/messages`, {
      message: 'We want to know whether a project registry is worth building. Done when we have a recommendation.',
    });
    const brief = (await api(operator).post(`/api/discovery/${discovery.id}/brief`, {})).json().brief;

    const detail = (await api(operator).get(`/api/tasks/${task.id}`)).json();
    expect(detail.task.userInitialConfidence).toBe(0.99);
    expect(detail.execution.understandingConfidence).toBe(brief.confidence);
    // The derived number is Mac's own, and it is not 0.99 because somebody typed it.
    expect(detail.execution.understandingConfidence).not.toBe(0.99);
  });

  it('emits exactly one confidence calculation per brief', async () => {
    const project = await internalProject();
    await allowResearch(project.id);
    const task = await makeTask(app.fastify, operator, project.id, { taskKind: 'research' });
    const { discovery } = (await api(operator).post(`/api/tasks/${task.id}/discovery`, {})).json();
    await api(operator).post(`/api/discovery/${discovery.id}/messages`, { message: 'Find out what the options are.' });
    await api(operator).post(`/api/discovery/${discovery.id}/brief`, {});

    const events = await queryAuditEvents({ taskId: task.id, eventType: 'brief.confidence_calculated', limit: 20, offset: 0 });
    // Two would mean a window in which the stored number — the one every
    // execution gate reads — was already stale.
    expect(events).toHaveLength(1);
  });

  it('scores a research brief on the dimensions that apply to it', async () => {
    const project = await internalProject();
    await allowResearch(project.id);
    // Titles chosen so the discovery classifier leaves both kinds alone: a
    // title saying "research" would reclassify the coding task and the two
    // briefs would then be scored identically, which is a confound rather than
    // a result.
    const research = await makeTask(app.fastify, operator, project.id, {
      title: 'Evaluate the costing options',
      taskKind: 'research',
    });
    const coding = await makeTask(app.fastify, operator, project.id, {
      title: 'Implement the costing comparison',
      taskKind: 'coding',
    });

    const message =
      'We need to know which of the three options is cheapest. It is done when we have a costed recommendation. ' +
      'The current situation is that nobody has compared them.';

    const confidences: number[] = [];
    for (const task of [research, coding]) {
      const { discovery } = (await api(operator).post(`/api/tasks/${task.id}/discovery`, {})).json();
      await api(operator).post(`/api/discovery/${discovery.id}/messages`, { message });
      confidences.push((await api(operator).post(`/api/discovery/${discovery.id}/brief`, {})).json().brief.confidence);
    }

    // Drift D-12: the coding brief is marked down for having no testing
    // strategy and no must-not-change areas. The research brief is not, because
    // those questions were never asked of it.
    expect(confidences[0]!).toBeGreaterThan(confidences[1]!);
  });
});

describe('a reasoning provider is required, and a null one is refused', () => {
  it('refuses to plan a general run when no provider is configured', async () => {
    const project = await internalProject();
    await allowResearch(project.id);
    const { runId } = await briefedGeneralRun(project.id);

    setModelProvider(null); // settings default is `none`
    await expect(beginGeneralRun(runId)).rejects.toMatchObject({ code: MODEL_PROVIDER_REQUIRED });
  });

  it('plans happily against a scripted provider', async () => {
    const project = await internalProject();
    await allowResearch(project.id);
    const { runId } = await briefedGeneralRun(project.id);

    setModelProvider(scriptedResearch());
    const plan = await beginGeneralRun(runId);
    expect(plan.objective.length).toBeGreaterThan(0);
    // The internal sources Mac is always entitled to.
    expect(plan.permittedTools).toContain('project_memory_search');
    expect(plan.permittedTools).toContain('prior_run_search');
    // Company context is offered only when the run is BOUND to a revision, and
    // this deployment has none configured. Offering a tool that always returns
    // nothing would waste a step and teach the model its tools do not work.
    expect(plan.permittedTools).not.toContain('company_context_search');
    // External research is off by default and the project does not allow it.
    expect(plan.permittedTools).not.toContain('public_web_search');
    expect(plan.permittedTools).not.toContain('public_doc_fetch');
  });
});

describe('a general run produces artefacts, evidence and usage', () => {
  it('runs its steps, writes an artefact, and records what it consulted', async () => {
    const project = await internalProject();
    await allowResearch(project.id);
    const { runId, taskId } = await briefedGeneralRun(project.id);

    setModelProvider(scriptedResearch());
    await beginGeneralRun(runId);

    const first = await performResearchStep(runId);
    expect(first.done).toBe(false);
    expect(first.stepsTaken).toBe(1);

    const second = await performResearchStep(runId);
    expect(second.artefactsCreated).toBe(1);

    const [artefact] = await db.select().from(runArtefacts).where(eq(runArtefacts.runId, runId));
    expect(artefact).toBeDefined();
    expect(artefact!.artefactType).toBe('investigation_report');
    expect(artefact!.title).toMatch(/Project Registry/i);

    const events = await queryAuditEvents({ runId, limit: 100, offset: 0 });
    const types = events.map((e) => e.eventType);
    expect(types).toContain('research.plan_built');
    expect(types).toContain('research.step_completed');
    expect(types).toContain('research.tool_called');
    expect(types).toContain('artefact.created');
  });

  it('records the query of every search, so a search is inspectable', async () => {
    const project = await internalProject();
    await allowResearch(project.id);
    const { runId } = await briefedGeneralRun(project.id);

    setModelProvider(scriptedResearch());
    await beginGeneralRun(runId);
    await performResearchStep(runId);

    const events = await queryAuditEvents({ runId, eventType: 'research.tool_called', limit: 20, offset: 0 });
    expect(events).toHaveLength(1);
    expect((events[0]!.metadata as { query: string }).query).toBe('project registry');
  });

  it('routes reasoning spend into the usage model the budget already reads', async () => {
    const project = await internalProject();
    await allowResearch(project.id);
    const { runId } = await briefedGeneralRun(project.id);

    setModelProvider(scriptedResearch());
    await beginGeneralRun(runId);
    await performResearchStep(runId);

    const usage = await db.select().from(runUsage).where(eq(runUsage.runId, runId));
    const reasoning = usage.find((u) => u.kind === 'reasoning_tokens');
    // Drift D-11: spec §25 lists Mac's reasoning model FIRST among the sources
    // of AI usage, and before this sprint its tokens stopped at audit metadata.
    expect(reasoning).toBeDefined();
    expect(reasoning!.source).toBe('exact');
    // Tokens are exact; the dollar cost of them is not known, and inventing a
    // rate would be the estimate-presented-as-exact that spec §25 forbids.
    expect(reasoning!.costCents).toBeNull();
  });

  it('demotes a claim whose citation was never retrieved', async () => {
    const project = await internalProject();
    await allowResearch(project.id);
    const { runId } = await briefedGeneralRun(project.id);

    setModelProvider(
      new ScriptedModelProvider([
        JSON.stringify({
          toolCalls: [],
          findings: [
            {
              statement: 'PAC mandates a project registry.',
              evidenceClass: 'pac_fact',
              confidence: 0.98,
              sources: ['company:INVENTED.md@deadbee'],
              reasoning: '',
            },
          ],
          narrative: 'Writing up.',
          unknowns: [],
          artefacts: [
            {
              type: 'recommendation',
              title: 'Recommendation',
              format: 'markdown',
              body: 'Build it.',
              summary: '',
              findings: [],
            },
          ],
          blockerProposed: null,
        }),
      ]),
    );
    await beginGeneralRun(runId);

    // Drive straight to the final step so the fabricated citation is the one
    // that reaches the artefact.
    await db.update(generalRunState).set({ state: { stepsTaken: 7, toolCallsMade: 0, sources: [], findings: [], unknowns: [], toolResults: [] } }).where(eq(generalRunState.runId, runId));
    await performResearchStep(runId);

    const [artefact] = await db.select().from(runArtefacts).where(eq(runArtefacts.runId, runId));
    const findings = artefact!.findings as Array<{ evidenceClass: string; confidence: number; sources: string[] }>;
    expect(findings[0]!.evidenceClass).toBe('inference');
    expect(findings[0]!.sources).toEqual([]);
    expect(findings[0]!.confidence).toBeLessThanOrEqual(0.59);
  });

  it('never writes to monday.com for a task that has no item', async () => {
    const project = await internalProject();
    await allowResearch(project.id);
    const { runId } = await briefedGeneralRun(project.id);

    setModelProvider(scriptedResearch());
    await beginGeneralRun(runId);
    await performResearchStep(runId);

    const writes = await db.select().from(mondayWrites);
    expect(writes).toHaveLength(0);
  });
});

describe('the morning report for work that changed nothing', () => {
  it('asks what Mac found, not what changed, and omits the pull-request section', async () => {
    const project = await internalProject();
    await allowResearch(project.id);
    const { runId } = await briefedGeneralRun(project.id);

    setModelProvider(scriptedResearch());
    await beginGeneralRun(runId);
    await performResearchStep(runId);
    await performResearchStep(runId);

    const report = await generateRunReport(runId, { type: 'system', id: null, label: 'test' });

    expect(report.markdown).toMatch(/## What Mac Found/);
    expect(report.markdown).not.toMatch(/## What Changed/);
    // A "None opened" pull-request line invites the reader to ask why, about a
    // thing that was never going to happen.
    expect(report.markdown).not.toMatch(/## Pull Request/);
    expect(report.markdown).toMatch(/## Artefacts/);
    expect(report.markdown).toMatch(/## Still Unknown/);
    expect(report.findings?.artefacts.length).toBe(1);
  });

  it('keeps the coding report exactly as it was', async () => {
    const project = await makeProject(app.fastify, admin, { name: 'Coding project' });
    const task = await makeTask(app.fastify, operator, project.id, { taskKind: 'coding' });
    const run = await db
      .insert(runs)
      .values({ taskId: task.id, jobKind: 'noop', jobParams: {}, status: 'completed' })
      .returning();

    const report = await generateRunReport(run[0]!.id, { type: 'system', id: null, label: 'test' });
    expect(report.markdown).toMatch(/## What Changed/);
    expect(report.markdown).toMatch(/## Pull Request/);
    expect(report.findings).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

/** A briefed, approved general run against a project with no repository. */
async function briefedGeneralRun(projectId: string): Promise<{ runId: string; taskId: string }> {
  await registerTestWorker(app.fastify, { capabilities: ['general_task'] });

  const task = await makeTask(app.fastify, operator, projectId, {
    title: 'Investigate the PAC project registry',
    taskKind: 'investigation',
  });

  const { discovery } = (await api(operator).post(`/api/tasks/${task.id}/discovery`, {})).json();
  await api(operator).post(`/api/discovery/${discovery.id}/messages`, {
    message:
      'We want to know whether a PAC project registry is worth building. The current situation is that project ' +
      'information lives in three places. It is done when we have a costed recommendation. Do not assume monday.com ' +
      'is being replaced.',
  });
  const brief = (await api(operator).post(`/api/discovery/${discovery.id}/brief`, {})).json().brief;

  const [run] = await db
    .insert(runs)
    .values({
      taskId: task.id,
      status: 'queued',
      approvalState: 'approved',
      jobKind: 'general_task',
      jobParams: { briefId: brief.id, taskKind: 'investigation', maxMinutes: 30, maxSteps: 8 },
      handoffBriefId: brief.id,
      executionMode: 'overnight',
    })
    .returning();

  return { runId: run!.id, taskId: task.id };
}
