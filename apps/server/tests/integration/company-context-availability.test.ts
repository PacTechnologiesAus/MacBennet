import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { asUser, closePool, createAndLogin, resetDatabase, startTestApp, type Session } from '../helpers/harness.js';
import { makeProject, makeRun, makeTask } from '../helpers/fixtures.js';
import { createCompanyRepo, type CompanyRepoFixture } from '../helpers/company-repo.js';
import { db } from '../../src/db/client.js';
import { handoffBriefs, runs, settings } from '../../src/db/schema.js';
import { GitCompanyContextProvider } from '../../src/services/company-context/git-provider.js';
import { setCompanyContextProvider } from '../../src/services/company-context/provider.js';
import {
  refreshCompanyContext,
  resetCompanyContextCache,
} from '../../src/services/company-context/service.js';
import {
  renderCompanyContextMarkdown,
  selectCompanyContext,
  TASK_CONTEXT_CHAR_BUDGET,
} from '../../src/services/company-context/selection.js';
import { listInvestigations } from '../../src/services/investigation.js';

/**
 * Company context actually reaching the places that reason (Sprint 3.2 §12–15, §22).
 *
 * Two claims, and the second is the one with teeth:
 *
 *  1. discovery, supervision and handoff generation all receive company context;
 *  2. **AUTHORITY.md cannot be selected away.** A selection layer that scored
 *     the authority document against a task description would, on a CSS task,
 *     correctly conclude that PAC's deployment rules are irrelevant — and would
 *     be wrong in exactly the case where being wrong is worst.
 */

let app: FastifyInstance;
let close: () => Promise<void>;
let repo: CompanyRepoFixture;
let admin: Session;

const useRepo = (fixture: CompanyRepoFixture) => {
  setCompanyContextProvider(
    new GitCompanyContextProvider({
      repositoryUrl: fixture.url,
      ref: 'main',
      cacheDir: fixture.cacheDir,
      timeoutMs: 30_000,
    }),
  );
};

beforeAll(async () => {
  ({ fastify: app, close } = await startTestApp());
});

afterAll(async () => {
  setCompanyContextProvider(null);
  await close();
  await closePool();
});

beforeEach(async () => {
  await resetDatabase();
  repo = createCompanyRepo();
  useRepo(repo);
  await db
    .update(settings)
    .set({ companyContextEnabled: true, companyContextMinRefreshSeconds: 0 })
    .where(eq(settings.id, 1));
  await refreshCompanyContext({ reason: 'test-setup' });
  admin = await createAndLogin(app, { email: 'admin@pac.test', name: 'Admin', role: 'admin' });
});

afterEach(() => {
  setCompanyContextProvider(null);
  resetCompanyContextCache();
  repo.cleanup();
});

const activeRevision = async () => {
  const result = await refreshCompanyContext({ reason: 'test' });
  return result.revision!;
};

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe('the always-required core', () => {
  it('carries AUTHORITY.md in full, Mac\'s role, and PAC identity', async () => {
    const selection = await selectCompanyContext(await activeRevision(), { text: 'anything' });

    const documents = selection.core.map((s) => s.document);
    expect(documents).toContain('AUTHORITY.md');
    expect(documents).toContain('AGENTS.md');
    expect(documents).toContain('COMPANY.md');

    const authority = selection.core.find((s) => s.document === 'AUTHORITY.md')!;
    // The WHOLE document, not a section of it.
    expect(authority.heading).toBeNull();
    expect(authority.text).toContain('must NEVER autonomously deploy');
    expect(authority.text).toContain('no authority to spend PAC money');
    expect(authority.text).toContain('not authorised to communicate directly with customers');
  });

  it('includes Mac\'s own role definition, matching an em dash heading', async () => {
    const selection = await selectCompanyContext(await activeRevision(), { text: 'anything' });
    const role = selection.core.find((s) => s.heading?.includes('Automation Engineer'));
    expect(role).toBeDefined();
    expect(role!.text).toContain('AI Automation Engineer');
  });

  it('is present even when the task text matches NOTHING in the company documents', async () => {
    const selection = await selectCompanyContext(await activeRevision(), {
      text: 'zzqqxx wibble frobnicate 12345',
    });

    expect(selection.core.some((s) => s.document === 'AUTHORITY.md')).toBe(true);
    expect(selection.taskRelevant).toHaveLength(0);
  });

  it('cannot be selected away by ANY query, including an empty one', async () => {
    const revision = await activeRevision();
    for (const text of ['', 'css button colour', 'rename a variable', 'update the readme typo']) {
      const selection = await selectCompanyContext(revision, { text });
      expect(selection.core.some((s) => s.document === 'AUTHORITY.md')).toBe(true);
    }
  });

  it('is not counted against the task-relevant budget', async () => {
    // Budget zero: every scored section is dropped, and the core survives.
    const selection = await selectCompanyContext(await activeRevision(), {
      text: 'commissioning safety review digital twin',
      budget: 0,
    });

    expect(selection.taskRelevant).toHaveLength(0);
    expect(selection.core.some((s) => s.document === 'AUTHORITY.md')).toBe(true);
    expect(selection.droppedForBudget.length).toBeGreaterThan(0);
  });

  it('refuses to build a selection from a revision that did not validate', async () => {
    const revision = await activeRevision();
    await expect(
      selectCompanyContext({ ...revision, validationState: 'invalid' }, { text: 'x' }),
    ).rejects.toThrow(/must not be used as policy/);
  });
});

describe('task-relevant selection', () => {
  it('pulls the operating model and values for a controls task', async () => {
    const selection = await selectCompanyContext(await activeRevision(), {
      text: 'Update the PLC controls implementation and verify it against the digital twin before commissioning.',
    });

    const refs = selection.taskRelevant.map((s) => `${s.document}#${s.heading}`);
    expect(refs.join(' ')).toContain('OPERATING_MODEL.md');
    expect(refs.some((r) => /Controls Implementation|Digital Twin|Commissioning/.test(r))).toBe(true);
  });

  it('pulls the systems map for an architecture task', async () => {
    const selection = await selectCompanyContext(await activeRevision(), {
      text: 'Where should project context be assembled — is Forja the system of record for work items?',
    });

    const refs = selection.taskRelevant.map((s) => `${s.document}#${s.heading}`);
    expect(refs.join(' ')).toContain('SYSTEMS.md');
    expect(refs.some((r) => r.includes('Forja'))).toBe(true);
  });

  it('does NOT drag in warranty policy for an ordinary UI bug', async () => {
    // The brief's own example: correctness matters more than token thrift, but
    // that is not a licence to inject the whole repository into every prompt.
    const selection = await selectCompanyContext(await activeRevision(), {
      text: 'The save button on the settings dialog is misaligned by two pixels in Firefox.',
    });

    const refs = selection.taskRelevant.map((s) => `${s.document}#${s.heading}`).join(' ');
    expect(refs).not.toContain('Warranty');
  });

  it('names the document AND the commit sha in every evidence ref', async () => {
    const revision = await activeRevision();
    const selection = await selectCompanyContext(revision, { text: 'commissioning safety' });

    for (const section of [...selection.core, ...selection.taskRelevant]) {
      expect(section.ref).toMatch(/^company:[^@]+@[0-9a-f]{7}$/);
      expect(section.ref).toContain(revision.commitSha.slice(0, 7));
    }
  });

  it('keeps the default budget generous enough for real work', async () => {
    const selection = await selectCompanyContext(await activeRevision(), {
      text: 'controls implementation testing simulation commissioning safety review forja monday github',
    });
    expect(selection.characters).toBeLessThanOrEqual(TASK_CONTEXT_CHAR_BUDGET + 20_000);
    expect(selection.droppedForBudget).toHaveLength(0);
  });
});

describe('the rendered block a coding agent receives', () => {
  it('frames the content as company policy rather than task instruction', async () => {
    const selection = await selectCompanyContext(await activeRevision(), { text: 'commissioning' });
    const markdown = renderCompanyContextMarkdown(selection);

    expect(markdown).toContain('## PAC company context');
    expect(markdown).toContain('company policy, not task instruction');
    expect(markdown).toContain('the policy wins and you ask');
    // Each section is attributed to its document.
    expect(markdown).toContain('### AUTHORITY.md');
  });
});

// ---------------------------------------------------------------------------
// Discovery and supervision
// ---------------------------------------------------------------------------

describe('discovery', () => {
  it('consults company context as an investigation source', async () => {
    const project = await makeProject(app, admin);
    const task = await makeTask(app, admin, project.id);
    const run = await makeRun(app, admin, task.id);

    const [brief] = await db
      .insert(handoffBriefs)
      .values({
        taskId: task.id,
        projectId: project.id,
        version: 1,
        status: 'ready',
        content: {
          title: task.title,
          userObjective: 'Prepare the controls change for the customer line.',
          currentBehaviour: '',
          desiredBehaviour: 'The recipe download works.',
          relevantArchitecture: '',
          constraints: [],
          mustNotChange: [],
          likelyAffectedComponents: [],
          acceptanceCriteria: ['It downloads.'],
          testingExpectations: [],
          implementationConsiderations: [],
          risks: [],
          assumptions: [],
          openQuestions: [],
          proposedScope: 'Prepare the change.',
          outOfScope: [],
        },
        confidence: '0.900',
        sourceConversation: 'x',
      })
      .returning();
    await db.update(runs).set({ handoffBriefId: brief!.id }).where(eq(runs.id, run.id));

    const { answerAgentQuestion } = await import('../../src/services/supervision.js');
    await answerAgentQuestion(
      run.id,
      {
        questionId: 'q-1',
        question: 'May I deploy this change to the live customer system myself once tests pass?',
      },
      { type: 'system', id: null, label: 'test' },
    );

    const investigations = await listInvestigations({ runId: run.id });
    expect(investigations.length).toBeGreaterThan(0);

    const checked = investigations[0]!.result.checked;
    const company = checked.find((c) => c.source === 'company_context');
    expect(company).toBeDefined();
    expect(company!.consulted).toBe(true);
  });

  it('produces company_policy evidence carrying the document and the sha', async () => {
    const project = await makeProject(app, admin);
    const task = await makeTask(app, admin, project.id);
    const run = await makeRun(app, admin, task.id);

    const [brief] = await db
      .insert(handoffBriefs)
      .values({
        taskId: task.id,
        projectId: project.id,
        version: 1,
        status: 'ready',
        content: {
          title: task.title,
          userObjective: 'Deployment question.',
          currentBehaviour: '',
          desiredBehaviour: '',
          relevantArchitecture: '',
          constraints: [],
          mustNotChange: [],
          likelyAffectedComponents: [],
          acceptanceCriteria: [],
          testingExpectations: [],
          implementationConsiderations: [],
          risks: [],
          assumptions: [],
          openQuestions: [],
          proposedScope: '',
          outOfScope: [],
        },
        confidence: '0.900',
        sourceConversation: 'x',
      })
      .returning();
    await db.update(runs).set({ handoffBriefId: brief!.id }).where(eq(runs.id, run.id));

    const { answerAgentQuestion } = await import('../../src/services/supervision.js');
    await answerAgentQuestion(
      run.id,
      {
        questionId: 'q-1',
        question: 'What is PAC policy on autonomously deploying to a live commissioned customer system?',
      },
      { type: 'system', id: null, label: 'test' },
    );

    const investigations = await listInvestigations({ runId: run.id });
    const evidence = investigations.flatMap((i) => i.result.evidence);
    const policy = evidence.filter((e) => e.kind === 'company_policy');

    expect(policy.length).toBeGreaterThan(0);
    expect(policy[0]!.ref).toContain('company:');
    expect(policy[0]!.ref).toContain(repo.head().slice(0, 7));
  });
});

describe('handoff generation', () => {
  it('embeds the selected company context in what the coding agent is given', async () => {
    const project = await makeProject(app, admin);
    const repoResponse = await asUser(app, admin).post('/api/repositories', {
      projectId: project.id,
      name: 'plant-controls',
      remoteUrl: 'https://github.com/pac/plant-controls.git',
      localPath: '/tmp/plant-controls',
      defaultBranch: 'main',
    });
    expect(repoResponse.statusCode).toBe(201);
    const repositoryId = repoResponse.json().repository.id;
    await asUser(app, admin).post(`/api/repositories/${repositoryId}/approve`, { approved: true });

    const start = await asUser(app, admin).post('/api/discovery', {
      projectId: project.id,
      title: 'Add commissioning evidence capture to the controls test harness',
    });
    const session = start.json().session;

    await asUser(app, admin).post(`/api/discovery/${session.id}/messages`, {
      message:
        'At the moment the controls test harness does not record simulation evidence. It should write ' +
        'each digital twin run to the project record so commissioning has the evidence. Done when a ' +
        'run produces a stored evidence file. Tests should cover the writer.',
    });

    const generated = await asUser(app, admin).post(`/api/discovery/${session.id}/brief`);
    const brief = generated.json().brief;

    const { buildCodingAssignment } = await import('../../src/services/coding-runs.js');
    const { runs: runsTable } = await import('../../src/db/schema.js');

    const created = await asUser(app, admin).post('/api/coding-runs', {
      taskId: session.taskId,
      repositoryId,
      briefId: brief.id,
      provider: 'mock',
      maxMinutes: 10,
      openPullRequest: false,
      executionMode: 'interactive',
    });
    expect(created.statusCode).toBe(201);

    const [runRow] = await db.select().from(runsTable).where(eq(runsTable.id, created.json().run.id));
    const assignment = await buildCodingAssignment(db, runRow!);

    expect(assignment).not.toBeNull();
    const markdown = assignment!.task.briefMarkdown;

    // The agent gets the policy, framed as policy, with its revision named.
    expect(markdown).toContain('## PAC company context');
    expect(markdown).toContain(`PAC company context: ${repo.head().slice(0, 7)}`);
    expect(markdown).toContain('must NEVER autonomously deploy');
    expect(markdown).toContain('company policy, not task instruction');
  });
});

describe('discovery structuring', () => {
  it('is given the selected company context as grounding vocabulary', async () => {
    /*
     * The seam is the model structurer, which only runs when model assist is on.
     * Rather than call a model, this asserts the wiring: `structureBriefWithModel`
     * accepts a third argument and uses it to ground fields, so a constraint the
     * engineer implied by naming a PAC process survives instead of being dropped
     * as unsupported.
     */
    const { structureBriefWithModel } = await import('../../src/services/model/resolvers.js');
    const { setModelProvider } = await import('../../src/services/model/provider.js');

    // A scripted model that returns a constraint phrased in PAC's vocabulary
    // rather than the engineer's. Without company context as grounding it is
    // dropped as unsupported; with it, it survives.
    const scripted = {
      name: 'anthropic' as const,
      isAvailable: async () => ({ available: true }),
      complete: async (request: { prompt: string }) => {
        capturedPrompt = request.prompt;
        return {
          text: JSON.stringify({
            constraints: ['Verify against the digital twin before commissioning.'],
          }),
          model: 'scripted',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };

    let capturedPrompt = '';
    setModelProvider(scripted as never);

    try {
      const withoutContext = await structureBriefWithModel('A task', 'Please add a button.');
      // Nothing in that conversation supports a digital-twin constraint.
      expect(withoutContext.structure?.constraints ?? []).toHaveLength(0);
      expect(withoutContext.record.fabricatedCitations).toBeGreaterThan(0);

      const withContext = await structureBriefWithModel(
        'A task',
        'Please add a button.',
        'Controls software is verified against the digital twin before commissioning.',
      );

      // The company context reached the prompt...
      expect(capturedPrompt).toContain('PAC COMPANY CONTEXT');
      expect(capturedPrompt).toContain('digital twin');
      // ...and grounded the field rather than letting it be dropped.
      expect(withContext.structure?.constraints ?? []).toHaveLength(1);
    } finally {
      setModelProvider(null);
    }
  });

  it('binds the revision so the brief it produces is attributable', async () => {
    const project = await makeProject(app, admin);
    const start = await asUser(app, admin).post('/api/discovery', {
      projectId: project.id,
      title: 'Prepare commissioning evidence capture',
    });
    const session = start.json().session;
    expect(session.companyContext.commitSha).toBe(repo.head());

    await asUser(app, admin).post(`/api/discovery/${session.id}/messages`, {
      message:
        'The harness should write digital twin evidence to the project record. Done when a file is ' +
        'stored. Tests should cover the writer.',
    });

    const generated = await asUser(app, admin).post(`/api/discovery/${session.id}/brief`);
    expect(generated.statusCode).toBe(201);
    expect(generated.json().brief.companyContext.commitSha).toBe(repo.head());
  });
});
