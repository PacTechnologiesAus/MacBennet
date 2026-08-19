import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  auditEvents,
  handoffBriefs,
  researchSources,
  runAcceptance,
  runArtefacts,
  runs,
  tasks,
} from '../../src/db/schema.js';
import { asUser, createAndLogin, resetDatabase, startTestApp, type Session, type TestApp } from '../helpers/harness.js';
import { makeProject, makeTask, registerTestWorker } from '../helpers/fixtures.js';
import { ScriptedModelProvider, setModelProvider } from '../../src/services/model/provider.js';
import { beginGeneralRun, performResearchStep } from '../../src/services/research/runner.js';
import {
  freezeCriteriaForRun,
  getRunAcceptance,
  noteRemediation,
  remediationAlreadyAttempted,
  reviewAcceptance,
} from '../../src/services/acceptance.js';
import { performAcceptanceRemediation } from '../../src/services/research/runner.js';
import { completeRun } from '../../src/services/runs.js';
import { updateSettings } from '../../src/services/settings.js';
import { createMemory } from '../../src/services/memory.js';
import { SYSTEM_ACTOR } from '../../src/services/audit.js';

/**
 * Acceptance verification, end to end (Phase 4 Part F, Acceptance Case 1).
 *
 * ---------------------------------------------------------------------------
 * THE RUN THIS FILE IS ABOUT
 *
 * Commissioning §13.3: a task description asking for three engineering briefs,
 * a cross-system architecture recommendation and a build order produced ONE
 * artefact and reported `completed`. Every component behaved. Nothing in the
 * system held a machine-checkable statement of what "asked for" meant that
 * survived from the request to the moment of completion.
 *
 * The scenario below is that one, deliberately: same shape of request, same
 * shape of shortfall. It must not be reportable as fully complete.
 * ---------------------------------------------------------------------------
 */

let app: TestApp;
let admin: Session;
let operator: Session;

const api = (session: Session) => asUser(app.fastify, session);

const REQUEST =
  'Investigate the PAC Project Registry, Project Document Controller and Sales Engineer. Produce three ' +
  'separate engineering briefs, one per system, plus a cross-system architecture recommendation and a ' +
  'build-order recommendation with a rough cost for each. Research external vendor documentation where ' +
  'useful. This is research, engineering analysis and scoping only. Do not implement anything.';

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

async function researchProject(capabilities: string[] = ['company_context', 'internal_only', 'external_research']) {
  const project = await makeProject(app.fastify, admin, { name: 'PAC Internal Development', repoUrl: null });
  const response = await api(admin).patch(`/api/projects/${project.id}/capabilities`, {
    capabilities,
    allowedTaskKinds: ['research', 'investigation', 'scoping'],
  });
  if (response.statusCode !== 200) throw new Error(`capabilities failed: ${response.body}`);
  return project;
}

/**
 * A briefed general run whose brief commits to what the request asked for.
 *
 * The discovery message deliberately restates the deliverables, so the BRIEF
 * carries them — which is the case where the run, not discovery, is the thing
 * that fell short.
 */
async function briefedRun(projectId: string, description = REQUEST) {
  await registerTestWorker(app.fastify, { capabilities: ['general_task'] });

  const task = await makeTask(app.fastify, operator, projectId, {
    title: 'Investigate PAC Project Registry, Document Controller & Sales Engineer',
    taskKind: 'investigation',
    description,
  });

  const { discovery } = (await api(operator).post(`/api/tasks/${task.id}/discovery`, {})).json();
  await api(operator).post(`/api/discovery/${discovery.id}/messages`, { message: description });
  const brief = (await api(operator).post(`/api/discovery/${discovery.id}/brief`, {})).json().brief;

  const [run] = await db
    .insert(runs)
    .values({
      taskId: task.id,
      status: 'queued',
      approvalState: 'approved',
      jobKind: 'general_task',
      jobParams: { briefId: brief.id, taskKind: 'investigation', maxMinutes: 30, maxSteps: 6 },
      handoffBriefId: brief.id,
      executionMode: 'overnight',
    })
    .returning();

  await freezeCriteriaForRun(run!.id);
  return { runId: run!.id, taskId: task.id, briefId: brief.id as string };
}

/** A model that gathers nothing external and writes exactly one document. */
function onePagerModel() {
  return new ScriptedModelProvider([
    JSON.stringify({
      toolCalls: [],
      findings: [
        {
          statement: 'All three systems are planned rather than built.',
          evidenceClass: 'inference',
          confidence: 0.6,
          sources: [],
          reasoning: 'Nothing retrieved describes an implementation.',
        },
      ],
      narrative: 'Reasoned over what PAC already records.',
      unknowns: ['No source contains a cost estimate.'],
      artefacts: [],
      blockerProposed: null,
    }),
    // The write-up outline: ONE deliverable, where the request named five.
    JSON.stringify({
      deliverables: [{ type: 'recommendation', title: 'Consolidated recommendation', purpose: 'Covers all three.' }],
      findings: [],
      narrative: 'Writing up.',
      unknowns: [],
      blockerProposed: null,
    }),
    JSON.stringify({
      type: 'recommendation',
      title: 'Consolidated recommendation',
      format: 'markdown',
      body: '# Recommendation\n\n## Summary\nAll three are planned.\n',
      summary: 'A single consolidated recommendation.',
      findings: [],
    }),
  ]);
}

// ---------------------------------------------------------------------------

describe('criteria are derived where a human can still argue with them', () => {
  it('puts machine-checkable criteria on the brief itself', async () => {
    const project = await researchProject();
    await updateSettings({ externalResearchEnabled: true }, { type: 'user', id: admin.user.id, label: admin.user.name });

    const { briefId } = await briefedRun(project.id);

    const [brief] = await db.select().from(handoffBriefs).where(eq(handoffBriefs.id, briefId));
    const criteria = brief!.acceptance as Array<{ kind: string; artefactType?: string; minimum?: number }>;

    expect(criteria.length).toBeGreaterThan(0);

    // The specific miss from commissioning: three separate engineering briefs.
    const briefsCriterion = criteria.find((c) => c.kind === 'artefact_type' && c.artefactType === 'engineering_brief');
    expect(briefsCriterion?.minimum).toBe(3);

    // And the request asked for research outside PAC.
    expect(criteria.map((c) => c.kind)).toContain('external_sources');
  });

  it('records that they were derived, and what from', async () => {
    const project = await researchProject();
    const { taskId } = await briefedRun(project.id);

    const events = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.taskId, taskId), eq(auditEvents.eventType, 'acceptance.criteria_derived')));

    expect(events.length).toBeGreaterThan(0);
  });

  it('does not derive an external-source criterion this deployment could never meet', async () => {
    // A criterion the run cannot satisfy for a reason it cannot act on fails
    // every time, and teaches everybody to ignore gaps.
    const project = await researchProject(['company_context', 'internal_only']);
    const { briefId } = await briefedRun(project.id);

    const [brief] = await db.select().from(handoffBriefs).where(eq(handoffBriefs.id, briefId));
    const criteria = brief!.acceptance as Array<{ kind: string }>;
    expect(criteria.map((c) => c.kind)).not.toContain('external_sources');
  });
});

// ---------------------------------------------------------------------------

describe('criteria are frozen at approval', () => {
  it('measures the run against what was authorised, not against a later edit', async () => {
    const project = await researchProject();
    const { runId, briefId } = await briefedRun(project.id);

    const frozen = (await db.select().from(runAcceptance).where(eq(runAcceptance.runId, runId)))[0]!;
    const frozenCount = (frozen.criteria as unknown[]).length;
    expect(frozenCount).toBeGreaterThan(0);

    // Somebody edits the brief's criteria afterwards — a normal thing to happen
    // while a run is in flight overnight.
    await db.update(handoffBriefs).set({ acceptance: [] }).where(eq(handoffBriefs.id, briefId));

    const still = (await db.select().from(runAcceptance).where(eq(runAcceptance.runId, runId)))[0]!;
    // The bar the work is measured by did not move, in either direction.
    expect((still.criteria as unknown[]).length).toBe(frozenCount);
  });
});

// ---------------------------------------------------------------------------

describe('Acceptance Case 1 — research fidelity', () => {
  it('will not call a run complete when it delivered one of the documents asked for', async () => {
    const project = await researchProject();
    await updateSettings(
      { externalResearchEnabled: true, acceptanceSemanticReviewEnabled: false },
      { type: 'user', id: admin.user.id, label: admin.user.name },
    );

    const { runId } = await briefedRun(project.id);

    setModelProvider(onePagerModel());
    await beginGeneralRun(runId);
    await performResearchStep(runId);
    await performResearchStep(runId);

    // The run genuinely produced something. That is the whole difficulty: it is
    // not a failure, and reporting it as one would be as wrong as reporting it
    // as complete.
    const artefacts = await db.select().from(runArtefacts).where(eq(runArtefacts.runId, runId));
    expect(artefacts).toHaveLength(1);

    const review = await reviewAcceptance(runId, { allowModel: false });

    expect(review.state).toBe('gaps');

    const unmetKinds = review.unmet.map((u) => u.kind);
    expect(unmetKinds).toContain('artefact_type');
    expect(unmetKinds).toContain('external_sources');

    // The sentence Part F §23 names, in the words an operator reads.
    const external = review.unmet.find((u) => u.kind === 'external_sources');
    expect(external?.observed).toContain('external_sources_used = 0');

    /*
     * Every named deliverable is its own criterion, so the report says WHICH
     * one is missing rather than "some artefacts". Three briefs and an
     * architecture note are separate asks and separate gaps.
     */
    const observed = review.unmet.map((u) => u.observed);
    expect(observed).toContain('0 of type engineering_brief, 3 required');
    expect(observed).toContain('0 of type architecture_note, 1 required');
  });

  it('terminates the run as completed_with_gaps, not completed', async () => {
    const project = await researchProject();
    await updateSettings(
      { externalResearchEnabled: true, acceptanceSemanticReviewEnabled: false },
      { type: 'user', id: admin.user.id, label: admin.user.name },
    );

    const { runId, taskId } = await briefedRun(project.id);

    setModelProvider(onePagerModel());
    await beginGeneralRun(runId);
    await performResearchStep(runId);
    await performResearchStep(runId);

    const worker = await registerTestWorker(app.fastify, { name: 'acceptance-worker', capabilities: ['general_task'] });
    await db.update(runs).set({ status: 'running', workerId: worker.workerId }).where(eq(runs.id, runId));

    const status = await completeRun(runId, { id: worker.workerId, name: 'acceptance-worker' }, {
      outcome: 'succeeded',
      summary: 'Investigation completed in 2 steps; 1 artefact produced.',
    });

    /*
     * The status is the point.
     *
     * Every list, filter, dashboard tile and report in this system reads
     * `status`. Recording the shortfall only in `run_acceptance` would leave
     * every one of them reporting this as a completed investigation — which is
     * precisely what happened at commissioning.
     */
    expect(status).toBe('completed_with_gaps');

    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(run!.acceptanceState).toBe('gaps');
    expect(run!.stopReason).toBe('acceptance_gaps');

    // And the task is not `done`. It goes back to `ready`: the work exists and
    // something a person asked for is still missing.
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task!.status).toBe('ready');
  });

  it('records every gap individually, so a reader knows which one', async () => {
    const project = await researchProject();
    await updateSettings(
      { externalResearchEnabled: true, acceptanceSemanticReviewEnabled: false },
      { type: 'user', id: admin.user.id, label: admin.user.name },
    );
    const { runId } = await briefedRun(project.id);

    setModelProvider(onePagerModel());
    await beginGeneralRun(runId);
    await performResearchStep(runId);
    await performResearchStep(runId);
    await reviewAcceptance(runId, { allowModel: false });

    const gaps = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.runId, runId), eq(auditEvents.eventType, 'acceptance.gap_recorded')));

    expect(gaps.length).toBeGreaterThanOrEqual(2);
    const descriptions = gaps.map((g) => (g.metadata as { description: string }).description);
    expect(descriptions.some((d) => /engineering brief/i.test(d))).toBe(true);
  });
});


/**
 * A model that LOOKS SOMETHING UP and then cites what came back.
 *
 * The distinction from `onePagerModel` is the whole subject of this file: one
 * of them retrieves a source and grounds a claim in it, and the other asserts a
 * conclusion. Only the first can satisfy an evidence criterion.
 */
function groundedModel() {
  return new ScriptedModelProvider([
    JSON.stringify({
      toolCalls: [{ tool: 'project_memory_search', argument: 'existing panel', purpose: 'what PAC already records' }],
      findings: [],
      narrative: 'Reading what PAC already records.',
      unknowns: [],
      artefacts: [],
      blockerProposed: null,
    }),
    /*
     * Step two: reason over what came back, asking for nothing more.
     *
     * The empty `toolCalls` is what tells the loop the model is satisfied —
     * `lastRequestedToolCount` is read from what was ASKED FOR, not from what
     * came back, so a step whose every tool was refused does not end the run.
     */
    JSON.stringify({
      toolCalls: [],
      findings: [
        {
          statement: 'The existing panel is an S7-300 with a CP343-1.',
          evidenceClass: 'project_fact',
          confidence: 0.85,
          sources: ['project_memory:project/existing-panel'],
          reasoning: 'Recorded in this project.',
        },
      ],
      narrative: 'Reasoning over what was gathered.',
      unknowns: [],
      artefacts: [],
      blockerProposed: null,
    }),
    // Step three, phase one: what is being written.
    JSON.stringify({
      deliverables: [{ type: 'recommendation', title: 'Replace or migrate', purpose: 'The recommendation.' }],
      findings: [],
      narrative: 'Writing up.',
      unknowns: [],
      blockerProposed: null,
    }),
    // Step three, phase two: the document itself, on its own budget.
    JSON.stringify({
      type: 'recommendation',
      title: 'Replace or migrate',
      format: 'markdown',
      body: ['# Recommendation', '', '## Summary', 'Migrate incrementally.'].join('\n'),
      summary: 'Migrate incrementally.',
      findings: [],
    }),
  ]);
}

// ---------------------------------------------------------------------------

/** Runs the loop far enough to produce exactly one recommendation. */
async function produceOneArtefact(runId: string): Promise<void> {
  setModelProvider(onePagerModel());
  await beginGeneralRun(runId);
  await performResearchStep(runId);
  await performResearchStep(runId);
}

describe('a run that met everything asked of it', () => {
  it('is satisfied, and completes as completed', async () => {
    const project = await researchProject(['company_context', 'internal_only']);
    await updateSettings(
      { acceptanceSemanticReviewEnabled: false },
      { type: 'user', id: admin.user.id, label: admin.user.name },
    );

    // A modest request, met in full: one recommendation, one grounded finding.
    const { runId, taskId } = await briefedRun(
      project.id,
      'Give me a single written recommendation on whether to replace or migrate. Internal sources only.',
    );

    /*
     * Something for Mac to actually retrieve.
     *
     * The evidence criterion asks for a finding a reader can CHECK, and
     * `classifyFindings` demotes any factual claim whose citation was not
     * retrieved during the run. So a satisfied run has to have gone and read
     * something — which is the whole point of the criterion, and the reason
     * this test seeds project memory rather than asserting against a model that
     * merely claims to be grounded.
     */
    await createMemory(
      {
        scope: 'project',
        projectId: project.id,
        key: 'existing-panel',
        value: 'The existing panel at this site is an S7-300 with a CP343-1 ethernet module.',
        confidence: 1,
      },
      SYSTEM_ACTOR,
    );

    setModelProvider(groundedModel());
    await beginGeneralRun(runId);
    // Gather, reason, write up — three steps, because this run actually looks
    // something up rather than asserting a conclusion from nothing.
    await performResearchStep(runId);
    await performResearchStep(runId);
    await performResearchStep(runId);

    const review = await reviewAcceptance(runId, { allowModel: false });
    expect(review.unmet).toEqual([]);
    expect(review.state).toBe('satisfied');

    const worker = await registerTestWorker(app.fastify, { name: 'happy-worker', capabilities: ['general_task'] });
    await db.update(runs).set({ status: 'running', workerId: worker.workerId }).where(eq(runs.id, runId));

    const status = await completeRun(runId, { id: worker.workerId, name: 'happy-worker' }, {
      outcome: 'succeeded',
      summary: 'Done.',
    });

    expect(status).toBe('completed');
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task!.status).toBe('done');
  });
});

// ---------------------------------------------------------------------------

describe('criteria a count cannot decide', () => {
  const semanticCriterion = {
    id: 'semantic-costs',
    kind: 'semantic' as const,
    description: 'States a rough cost for each of the three systems',
    required: true,
    source: 'human' as const,
    statement: 'The report states a rough cost for each of the three systems.',
  };

  it('is unmet when no model is available to judge it', async () => {
    const project = await researchProject(['company_context', 'internal_only']);
    const { runId } = await briefedRun(project.id, 'Write me a recommendation.');

    await produceOneArtefact(runId);
    await db.update(runAcceptance).set({ criteria: [semanticCriterion] }).where(eq(runAcceptance.runId, runId));

    // No provider configured. `indeterminate` reads as a gap, never as a pass:
    // a check that degrades to green when it breaks is worse than no check.
    setModelProvider(null);
    const review = await reviewAcceptance(runId);

    expect(review.state).toBe('gaps');
    expect(review.unmet.map((u) => u.criterionId)).toContain('semantic-costs');
  });

  it('is decided by a model when one is available', async () => {
    const project = await researchProject(['company_context', 'internal_only']);
    const { runId } = await briefedRun(project.id, 'Write me a recommendation.');

    await produceOneArtefact(runId);
    await db.update(runAcceptance).set({ criteria: [semanticCriterion] }).where(eq(runAcceptance.runId, runId));

    setModelProvider(
      new ScriptedModelProvider([
        JSON.stringify({
          judgements: [
            {
              criterionId: 'semantic-costs',
              satisfied: true,
              evidence: 'Section "Cost" gives a figure for each system.',
              reasoning: 'All three are costed.',
            },
          ],
        }),
      ]),
    );

    const review = await reviewAcceptance(runId);

    expect(review.modelAssisted).toBe(true);
    expect(review.state).toBe('satisfied');
    expect(review.results[0]!.method).toBe('model');
  });

  it('cannot let a model talk its way past a failed count', async () => {
    /*
     * The safety property of the whole mechanism. Semantic review runs ONLY
     * over criteria marked semantic; it never revisits a deterministic result.
     * A fluent explanation must not be able to pass "0 of type
     * engineering_brief, 3 required".
     */
    const project = await researchProject(['company_context', 'internal_only']);
    const { runId } = await briefedRun(project.id, 'Write me a recommendation.');

    await produceOneArtefact(runId);
    await db
      .update(runAcceptance)
      .set({
        criteria: [
          {
            id: 'briefs',
            kind: 'artefact_type',
            description: 'Produce 3 engineering briefs',
            required: true,
            source: 'derived',
            artefactType: 'engineering_brief',
            minimum: 3,
          },
          semanticCriterion,
        ],
      })
      .where(eq(runAcceptance.runId, runId));

    // A model that says everything is fine, about everything.
    setModelProvider(
      new ScriptedModelProvider([
        JSON.stringify({
          judgements: [
            { criterionId: 'briefs', satisfied: true, evidence: 'It is all covered.', reasoning: 'Trust me.' },
            { criterionId: 'semantic-costs', satisfied: true, evidence: 'Costed.', reasoning: 'Yes.' },
          ],
        }),
      ]),
    );

    const review = await reviewAcceptance(runId);

    expect(review.state).toBe('gaps');
    const briefs = review.results.find((r) => r.criterionId === 'briefs')!;
    expect(briefs.verdict).toBe('unmet');
    // Decided by a count, and the count is what is reported.
    expect(briefs.method).toBe('deterministic');
    expect(briefs.observed).toContain('0 of type engineering_brief, 3 required');
  });
});

// ---------------------------------------------------------------------------

describe('required source classes', () => {
  it('is unmet when the sources retrieved are not of the class asked for', async () => {
    const project = await researchProject();
    const { runId, taskId } = await briefedRun(project.id, 'Confirm against the vendor documentation.');

    await produceOneArtefact(runId);
    await db
      .update(runAcceptance)
      .set({
        criteria: [
          {
            id: 'primary',
            kind: 'source_class',
            description: 'Cite a primary source',
            required: true,
            source: 'derived',
            sourceClasses: ['official_vendor_docs', 'standards_body', 'government'],
            minimum: 1,
          },
        ],
      })
      .where(eq(runAcceptance.runId, runId));

    // A forum thread is a source. It is not a primary source, and a conclusion
    // resting on it is second-hand.
    await db.insert(researchSources).values({
      runId,
      taskId,
      query: 'anything',
      tool: 'public_web_search',
      ref: 'https://reddit.com/r/plc/1',
      url: 'https://reddit.com/r/plc/1',
      title: 'A thread',
      sourceClass: 'forum_community',
      external: true,
      excerpt: 'somebody said',
    });

    const review = await reviewAcceptance(runId, { allowModel: false });

    expect(review.state).toBe('gaps');
    expect(review.unmet[0]!.observed).toMatch(/retrieved, none of the required class/);
  });
});

// ---------------------------------------------------------------------------

describe('remediation', () => {
  it('is attempted once, and recorded as such', async () => {
    const project = await researchProject(['company_context', 'internal_only']);
    const { runId } = await briefedRun(project.id, 'Write me a recommendation.');

    await produceOneArtefact(runId);

    await noteRemediation(runId, 'Attempted once.');
    expect(await remediationAlreadyAttempted(runId)).toBe(true);

    const review = await reviewAcceptance(runId, { allowModel: false });
    expect(review.remediationAttempted).toBe(true);
  });

  it('produces the missing deliverable when the evidence supports it', async () => {
    const project = await researchProject(['company_context', 'internal_only']);
    const { runId } = await briefedRun(project.id, 'Write me a recommendation.');

    await produceOneArtefact(runId);

    setModelProvider(
      new ScriptedModelProvider([
        JSON.stringify({
          type: 'engineering_brief',
          title: 'Engineering brief — Project Registry',
          format: 'markdown',
          body: '# Engineering brief\n\n## Scope\nThe registry.\n',
          summary: 'The missing brief.',
          findings: [],
        }),
      ]),
    );

    const outcome = await performAcceptanceRemediation(runId, [
      { description: 'Produce 1 engineering brief', observed: '0 of type engineering_brief, 1 required' },
    ]);

    expect(outcome.artefactsCreated).toBe(1);
    const artefacts = await db.select().from(runArtefacts).where(eq(runArtefacts.runId, runId));
    expect(artefacts.map((a) => a.artefactType)).toContain('engineering_brief');
  });

  it('produces nothing rather than inventing a document', async () => {
    const project = await researchProject(['company_context', 'internal_only']);
    const { runId } = await briefedRun(project.id, 'Write me a recommendation.');

    await produceOneArtefact(runId);

    // The model returns something unusable. An invented document is worse than
    // an acknowledged gap.
    setModelProvider(new ScriptedModelProvider(['I am afraid I cannot write that from what I have.']));

    const outcome = await performAcceptanceRemediation(runId, [
      { description: 'Produce 1 engineering brief', observed: '0 of type engineering_brief, 1 required' },
    ]);

    expect(outcome.artefactsCreated).toBe(0);
    expect(outcome.note).toMatch(/produced nothing further/);
  });
});

// ---------------------------------------------------------------------------

describe('the narrowing that happened before the run', () => {
  it('says plainly when the brief commits to less than the request', async () => {
    const project = await researchProject();

    // Discovery narrows five deliverables to one — exactly what happened at
    // commissioning, and correctly followed by the run afterwards.
    const { briefNarrowing } = await import('../../src/services/acceptance.js');
    const task = await makeTask(app.fastify, operator, project.id, {
      title: 'Investigate three systems',
      description: REQUEST,
    });
    const { discovery } = (await api(operator).post(`/api/tasks/${task.id}/discovery`, {})).json();
    await api(operator).post(`/api/discovery/${discovery.id}/messages`, {
      message: 'Just give me a single written recommendation covering all three, with a rough cost for each.',
    });
    const brief = (await api(operator).post(`/api/discovery/${discovery.id}/brief`, {})).json().brief;

    const note = await briefNarrowing(brief.id);

    /*
     * A note, not a block. Reducing five documents to one that covers the
     * ground is often the right call — what it must not be is invisible to
     * whoever is about to approve it.
     */
    expect(note).not.toBeNull();
    expect(note).toMatch(/narrower than the request/);
    expect(note).toMatch(/engineering brief/i);
    expect(note).toMatch(/may be right/);
  });
});

// ---------------------------------------------------------------------------

describe('runs with nothing to check', () => {
  it('leaves a run with no criteria not_assessed, and completes it normally', async () => {
    const project = await makeProject(app.fastify, admin, { repoUrl: null });
    const task = await makeTask(app.fastify, operator, project.id);
    const worker = await registerTestWorker(app.fastify, { name: 'plain-worker' });

    const [run] = await db
      .insert(runs)
      .values({
        taskId: task.id,
        status: 'running',
        approvalState: 'approved',
        jobKind: 'noop',
        jobParams: {},
        workerId: worker.workerId,
      })
      .returning();

    const status = await completeRun(run!.id, { id: worker.workerId, name: 'plain-worker' }, {
      outcome: 'succeeded',
      summary: 'Done.',
    });

    // Every coding run that existed before Phase 4 lands here. Acceptance
    // verification adds a check where a contract exists to check against, and
    // invents nothing where there is none.
    expect(status).toBe('completed');
    const acceptance = await getRunAcceptance(run!.id);
    expect(acceptance?.state ?? 'not_assessed').toBe('not_assessed');
  });
});
