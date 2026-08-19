import { describe, expect, it } from 'vitest';
import {
  emptyBriefContent,
  makeResearchSource,
  emptyResearchState,
  handoffBriefContentSchema,
  RESEARCH_LIMITS,
  capFindingConfidence,
  establishedFindings,
  isExternalTool,
  renderArtefactMarkdown,
  type Finding,
  type ResearchSource,
} from '@mac/protocol';
import {
  accumulate,
  buildResearchPlan,
  classifyFindings,
  countFabricatedCitations,
  decideNextStep,
  permittedTools,
  refuseToolCall,
} from '../../src/domain/research.js';

/**
 * The research loop's judgement (Sprint 3.3 §13–§16).
 *
 * The interesting tests here are the adversarial ones. A research run's failure
 * mode is not crashing — it is producing a fluent, confident paragraph with
 * nothing behind it, which a human then acts on. Every assertion below is about
 * something the model is NOT permitted to get away with.
 */

const source = (ref: string, external = false): ResearchSource =>
  makeResearchSource({
    ref,
    label: ref,
    excerpt: 'some retrieved text',
    retrievedAt: '2026-08-18T02:00:00.000Z',
    external,
  });

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  statement: 'PAC requires two approvals for a production change.',
  evidenceClass: 'pac_fact',
  confidence: 0.95,
  sources: ['company:AUTHORITY.md@a1b2c3d'],
  reasoning: '',
  ...overrides,
});

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

describe('the plan is built from the brief, not written by the model', () => {
  it('takes its objective from the approved brief', () => {
    const brief = handoffBriefContentSchema.parse({
      ...emptyBriefContent('Investigate the registry'),
      userObjective: 'Work out whether a project registry is worth building.',
      acceptanceCriteria: ['A recommendation with a cost estimate.'],
    });

    const plan = buildResearchPlan({ taskKind: 'investigation', brief, permittedTools: [], maxSteps: 8 });
    expect(plan.objective).toBe('Work out whether a project registry is worth building.');
    expect(plan.deliverables).toEqual(['A recommendation with a cost estimate.']);
  });

  it('falls back to the task kind’s expected artefacts when the brief names no criteria', () => {
    const plan = buildResearchPlan({
      taskKind: 'scoping',
      brief: emptyBriefContent('Scope the thing'),
      permittedTools: [],
      maxSteps: 8,
    });
    expect(plan.deliverables.length).toBeGreaterThan(0);
  });

  it('always states the authority boundaries, because the run reads the plan and not the spec', () => {
    const plan = buildResearchPlan({
      taskKind: 'research',
      brief: emptyBriefContent('Anything'),
      permittedTools: [],
      maxSteps: 8,
    });
    expect(plan.authorityBoundaries.join(' ')).toMatch(/Do not take action/i);
    expect(plan.authorityBoundaries.join(' ')).toMatch(/commitment/i);
    expect(plan.authorityBoundaries.join(' ')).toMatch(/cannot establish something, say so/i);
  });

  it('never exceeds the hard step ceiling however large the request', () => {
    const plan = buildResearchPlan({
      taskKind: 'research',
      brief: emptyBriefContent('x'),
      permittedTools: [],
      maxSteps: 9999,
    });
    expect(plan.maxSteps).toBe(RESEARCH_LIMITS.maxSteps);
  });
});

describe('tool availability', () => {
  const base = {
    externalResearchEnabled: false,
    projectAllowsExternal: false,
    hasRepositorySnapshot: false,
    hasMondayItem: false,
    hasCompanyContext: true,
  };

  it('always offers the internal sources', () => {
    const tools = permittedTools(base);
    expect(tools).toContain('company_context_search');
    expect(tools).toContain('project_memory_search');
    expect(tools).toContain('prior_run_search');
  });

  it('offers no external tool unless the deployment AND the project both allow it', () => {
    expect(permittedTools(base).some(isExternalTool)).toBe(false);
    expect(permittedTools({ ...base, externalResearchEnabled: true }).some(isExternalTool)).toBe(false);
    expect(permittedTools({ ...base, projectAllowsExternal: true }).some(isExternalTool)).toBe(false);
    expect(
      permittedTools({ ...base, externalResearchEnabled: true, projectAllowsExternal: true }).some(isExternalTool),
    ).toBe(true);
  });

  it('does not offer a repository search to a project with no repository', () => {
    // Offering a tool that always returns nothing wastes a step and teaches the
    // model that its tools do not work.
    expect(permittedTools(base)).not.toContain('repository_search');
    expect(permittedTools({ ...base, hasRepositorySnapshot: true })).toContain('repository_search');
  });

  it('refuses a tool that is not on the run’s permitted list', () => {
    expect(
      refuseToolCall({ tool: 'public_web_search', permitted: ['company_context_search'], toolCallsMade: 0, maxToolCalls: 40 }),
    ).toMatch(/External research is not enabled/);
  });

  it('refuses any tool once the call ceiling is reached', () => {
    expect(
      refuseToolCall({ tool: 'company_context_search', permitted: ['company_context_search'], toolCallsMade: 40, maxToolCalls: 40 }),
    ).toMatch(/ceiling/);
  });
});

// ---------------------------------------------------------------------------
// Loop control
// ---------------------------------------------------------------------------

describe('the loop terminates on recorded counters, not on the model saying so', () => {
  const plan = buildResearchPlan({
    taskKind: 'research',
    brief: emptyBriefContent('x'),
    permittedTools: [],
    maxSteps: 5,
  });

  it('reserves the last step for writing up, so a run always produces something', () => {
    const state = { ...emptyResearchState(), stepsTaken: 4 };
    const decision = decideNextStep({ plan, state, modelSatisfied: false, maxToolCalls: 40 });
    expect(decision.action).toBe('finalise');
  });

  it('stops once the step ceiling is reached, and says the limit was reached', () => {
    const state = { ...emptyResearchState(), stepsTaken: 5 };
    const decision = decideNextStep({ plan, state, modelSatisfied: false, maxToolCalls: 40 });
    expect(decision.action).toBe('stop');
    expect(decision.action === 'stop' && decision.limitReached).toBe(true);
  });

  it('finalises once the tool-call ceiling is reached, rather than looping empty', () => {
    const state = { ...emptyResearchState(), stepsTaken: 1, toolCallsMade: 40 };
    const decision = decideNextStep({ plan, state, modelSatisfied: false, maxToolCalls: 40 });
    expect(decision.action).toBe('finalise');
  });

  it('keeps gathering while the model still wants sources', () => {
    const state = { ...emptyResearchState(), stepsTaken: 1 };
    expect(decideNextStep({ plan, state, modelSatisfied: false, maxToolCalls: 40 }).action).toBe('gather');
  });

  it('does not finalise an empty-handed run just because the model stopped asking', () => {
    const state = { ...emptyResearchState(), stepsTaken: 1 };
    // No findings yet: reason over what is there before writing nothing up.
    expect(decideNextStep({ plan, state, modelSatisfied: true, maxToolCalls: 40 }).action).toBe('synthesise');
  });
});

// ---------------------------------------------------------------------------
// Evidence classification — the adversarial part
// ---------------------------------------------------------------------------

describe('a claim is only as strong as the sources actually retrieved', () => {
  it('keeps a PAC fact that cites a company source that was really retrieved', () => {
    const [result] = classifyFindings([finding()], [source('company:AUTHORITY.md@a1b2c3d')]);
    expect(result!.evidenceClass).toBe('pac_fact');
    expect(result!.confidence).toBe(0.95);
  });

  it('demotes a PAC fact whose citation was never retrieved, and caps its confidence', () => {
    const [result] = classifyFindings([finding()], []);
    expect(result!.evidenceClass).toBe('inference');
    expect(result!.sources).toEqual([]);
    expect(result!.confidence).toBeLessThanOrEqual(0.59);
  });

  it('demotes a PAC fact that cites only NON-company sources', () => {
    // The model read a project memory and filed it as company policy. It is a
    // project fact, and calling it PAC policy would misattribute a decision.
    const [result] = classifyFindings(
      [finding({ sources: ['project_memory:project/test-command'] })],
      [source('project_memory:project/test-command')],
    );
    expect(result!.evidenceClass).toBe('project_fact');
  });

  it('demotes an external fact that rests only on internal sources', () => {
    const [result] = classifyFindings(
      [finding({ evidenceClass: 'external_fact', sources: ['project_memory:a'] })],
      [source('project_memory:a')],
    );
    expect(result!.evidenceClass).toBe('project_fact');
  });

  it('keeps an external fact that cites something genuinely fetched from outside', () => {
    const [result] = classifyFindings(
      [finding({ evidenceClass: 'external_fact', sources: ['https://example.com/spec'] })],
      [source('https://example.com/spec', true)],
    );
    expect(result!.evidenceClass).toBe('external_fact');
    expect(result!.confidence).toBe(0.95);
  });

  it('records how many citations were invented, because that is the number worth watching', () => {
    const findings = [finding({ sources: ['company:REAL.md@abc', 'company:INVENTED.md@zzz'] })];
    expect(countFabricatedCitations(findings, [source('company:REAL.md@abc')])).toBe(1);

    const [result] = classifyFindings(findings, [source('company:REAL.md@abc')]);
    expect(result!.sources).toEqual(['company:REAL.md@abc']);
    expect(result!.reasoning).toMatch(/1 cited source\(s\) were not retrieved/);
  });

  it('caps an inference however confident the model claims to be', () => {
    const capped = capFindingConfidence(finding({ evidenceClass: 'inference', confidence: 0.99, sources: [] }));
    expect(capped.confidence).toBeLessThanOrEqual(0.59);
  });

  it('counts only sourced factual claims as established', () => {
    const findings = [
      finding(),
      finding({ evidenceClass: 'recommendation', statement: 'Build it', sources: [] }),
      finding({ evidenceClass: 'project_fact', statement: 'No sources', sources: [] }),
    ];
    expect(establishedFindings(findings).map((f) => f.statement)).toEqual([
      'PAC requires two approvals for a production change.',
    ]);
  });
});

describe('accumulating a step', () => {
  it('classifies on the way in, so nothing unclassified is ever persisted', () => {
    const next = accumulate(
      emptyResearchState(),
      {
        toolCalls: [],
        findings: [finding({ sources: ['company:MISSING.md@zzz'] })],
        narrative: '',
        artefacts: [],
        unknowns: [],
        blockerProposed: null,
      },
      [],
    );
    expect(next.findings[0]!.evidenceClass).toBe('inference');
    expect(next.stepsTaken).toBe(1);
  });

  it('deduplicates a repeated claim, keeping the better-grounded version', () => {
    const sources = [source('company:AUTHORITY.md@a1b2c3d')];
    const first = accumulate(
      emptyResearchState(),
      {
        toolCalls: [],
        findings: [finding({ sources: [] })],
        narrative: '',
        artefacts: [],
        unknowns: [],
        blockerProposed: null,
      },
      sources,
    );
    const second = accumulate(
      first,
      { toolCalls: [], findings: [finding()], narrative: '', artefacts: [], unknowns: [], blockerProposed: null },
      sources,
    );
    expect(second.findings).toHaveLength(1);
    expect(second.findings[0]!.evidenceClass).toBe('pac_fact');
  });

  it('never counts one source twice', () => {
    const s = [source('company:A.md@abc')];
    const one = accumulate(emptyResearchState(), emptyOutput(), s);
    const two = accumulate(one, emptyOutput(), s);
    expect(two.sources).toHaveLength(1);
  });
});

describe('the rendered artefact keeps facts and reasoning visibly apart', () => {
  it('groups findings under headings that say what kind of claim they are', () => {
    const markdown = renderArtefactMarkdown({
      title: 'Registry investigation',
      type: 'investigation_report',
      body: 'The body.',
      summary: 'A summary.',
      companyContext: { revisionId: 'r', commitSha: 'a1b2c3d4', shortSha: 'a1b2c3d' },
      findings: [finding(), finding({ evidenceClass: 'recommendation', statement: 'Build it.', sources: [] })],
    });

    expect(markdown).toMatch(/## Findings and their basis/);
    expect(markdown).toMatch(/### PAC facts/);
    expect(markdown).toMatch(/### Recommendations/);
    // Provenance travels with the document, not only with the database row.
    expect(markdown).toMatch(/a1b2c3d/);
  });
});

const emptyOutput = () => ({
  toolCalls: [],
  findings: [],
  narrative: '',
  artefacts: [],
  unknowns: [],
  blockerProposed: null,
});
