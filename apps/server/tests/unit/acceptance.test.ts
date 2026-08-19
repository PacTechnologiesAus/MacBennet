import { describe, expect, it } from 'vitest';
import {
  deriveAcceptanceState,
  emptyBriefContent,
  extractHeadings,
  handoffBriefContentSchema,
  headingSatisfies,
  normaliseHeading,
  unmetCriteria,
  type AcceptanceCriterion,
  type CriterionResult,
  type Finding,
} from '@mac/protocol';
import {
  compareRequestToBrief,
  deriveCriteria,
  detectDeliverables,
  detectSections,
  evaluateDeterministic,
  requestsExternalResearch,
  requestsPrimarySources,
  type AcceptanceEvidence,
} from '../../src/domain/acceptance.js';

/**
 * Acceptance verification (Phase 4 Part F).
 *
 * The scenario running through this file is the real one from commissioning
 * §13.3, because a mechanism built to catch a specific failure should be tested
 * against that failure rather than against a convenient stand-in.
 */

const REAL_REQUEST =
  'Investigate the PAC Project Registry, Project Document Controller and Sales Engineer. ' +
  'Produce three separate engineering briefs, one per system, a cross-system architecture ' +
  'recommendation, and a build-order recommendation with a rough cost for each. ' +
  'Research external vendor documentation where useful. This is research, engineering ' +
  'analysis and scoping only. Do not implement anything.';

const brief = (over: Partial<ReturnType<typeof handoffBriefContentSchema.parse>> = {}) =>
  handoffBriefContentSchema.parse({ ...emptyBriefContent('Investigate three systems'), ...over });

const finding = (over: Partial<Finding> = {}): Finding => ({
  statement: 'The registry is planned but not built.',
  evidenceClass: 'pac_fact',
  confidence: 0.9,
  sources: ['company:ROADMAP.md@83ac4a0'],
  reasoning: '',
  ...over,
});

const evidence = (over: Partial<AcceptanceEvidence> = {}): AcceptanceEvidence => ({
  artefacts: [],
  sources: [],
  testsRun: 0,
  testsPassed: null,
  reviewCompleted: false,
  ...over,
});

// ---------------------------------------------------------------------------

describe('reading what was asked for', () => {
  it('counts "three separate engineering briefs" as three, not one', () => {
    // The specific miss that turned five requested documents into one. The
    // count sits several tokens left of the noun, so a naive noun scan reads it
    // as a single brief.
    const found = detectDeliverables(REAL_REQUEST);
    const briefs = found.find((d) => d.type === 'engineering_brief');

    expect(briefs).toBeDefined();
    expect(briefs!.count).toBe(3);
  });

  it('reads "architecture recommendation" as an architecture note, not a bare recommendation', () => {
    // Both nouns are present in the same sentence. Matching the shorter one
    // first would collapse two distinct deliverables into one.
    const found = detectDeliverables(REAL_REQUEST);

    expect(found.map((d) => d.type)).toContain('architecture_note');
    expect(found.map((d) => d.type)).toContain('recommendation');
  });

  it('does not let a count attach to a noun it was never in front of', () => {
    // "three systems, and a recommendation" asks for one recommendation.
    const found = detectDeliverables('Cover three systems, and a recommendation at the end.');
    expect(found.find((d) => d.type === 'recommendation')?.count).toBe(1);
  });

  it('finds required sections without turning each into a separate document', () => {
    const sections = detectSections(REAL_REQUEST);

    expect(sections).toContain('Build order');
    expect(sections).toContain('Cost');
    // A build order is a heading inside a document, not a sixth file.
    expect(detectDeliverables('a build order').length).toBe(0);
  });

  it('recognises a request for research outside PAC', () => {
    expect(requestsExternalResearch(REAL_REQUEST)).toBe(true);
    expect(requestsExternalResearch('Summarise what our own handbook says.')).toBe(false);
  });

  it('recognises a request that should rest on a primary source', () => {
    expect(requestsPrimarySources('check the vendor documentation for the supported firmware')).toBe(true);
    expect(requestsPrimarySources('have a think about it')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('deriving criteria from a brief', () => {
  const derive = (content: Parameters<typeof brief>[0], over: Partial<Parameters<typeof deriveCriteria>[0]> = {}) =>
    deriveCriteria({
      taskKind: 'investigation',
      brief: brief(content),
      description: null,
      externalResearchAvailable: true,
      expectedArtefactTypes: ['investigation_report', 'recommendation'],
      ...over,
    });

  it('derives one artefact criterion per named deliverable, with its count', () => {
    const criteria = derive({ acceptanceCriteria: ['Three separate engineering briefs', 'A build order'] });

    const briefsCriterion = criteria.find(
      (c): c is Extract<AcceptanceCriterion, { kind: 'artefact_type' }> =>
        c.kind === 'artefact_type' && c.artefactType === 'engineering_brief',
    );
    expect(briefsCriterion?.minimum).toBe(3);
  });

  it('requires an external source when the brief asks for research outside PAC', () => {
    const criteria = derive({ acceptanceCriteria: ['Review external vendor documentation for each option'] });
    expect(criteria.map((c) => c.kind)).toContain('external_sources');
  });

  it('requires an external source when the question turns on information that goes stale', () => {
    // §19: nobody wrote "do external research", but "currently supported
    // version" cannot be answered from model memory without the answer being
    // silently old.
    const criteria = derive({ acceptanceCriteria: ['State the currently supported version of each product'] });
    expect(criteria.map((c) => c.kind)).toContain('external_sources');
  });

  it('does NOT require an external source when this deployment cannot retrieve one', () => {
    // A criterion the run could never satisfy fails every time for a reason the
    // run cannot act on, which teaches everybody to ignore gaps. The
    // unavailability belongs at approval time as a blocker instead.
    const criteria = derive(
      { acceptanceCriteria: ['Review external vendor documentation'] },
      { externalResearchAvailable: false },
    );
    expect(criteria.map((c) => c.kind)).not.toContain('external_sources');
  });

  it('requires a primary source when the brief asks for vendor documentation', () => {
    const criteria = derive({ acceptanceCriteria: ['Confirm against the vendor documentation'] });
    const primary = criteria.find(
      (c): c is Extract<AcceptanceCriterion, { kind: 'source_class' }> => c.kind === 'source_class',
    );
    expect(primary?.sourceClasses).toContain('official_vendor_docs');
  });

  it('falls back to "at least one deliverable" when the brief names none', () => {
    const criteria = derive({ acceptanceCriteria: [] });
    const floor = criteria.find((c) => c.kind === 'artefact_count');

    expect(floor).toBeDefined();
    // Marked as coming from the task kind, so a reader can tell it apart from
    // something the requester actually asked for.
    expect(floor?.source).toBe('task_kind');
  });

  it('derives test and review criteria for coding work, and not for research', () => {
    const coding = deriveCriteria({
      taskKind: 'coding',
      brief: brief({ testingExpectations: ['unit tests for the new endpoint'] }),
      description: null,
      externalResearchAvailable: false,
      expectedArtefactTypes: [],
    });
    expect(coding.map((c) => c.kind)).toContain('test_run');
    expect(coding.map((c) => c.kind)).toContain('review_step');

    const research = derive({ acceptanceCriteria: ['A recommendation'] });
    expect(research.map((c) => c.kind)).not.toContain('test_run');
  });

  it('derives nothing at all from an empty brief for a kind with no expected artefacts', () => {
    const criteria = deriveCriteria({
      taskKind: 'coding',
      brief: brief({}),
      description: null,
      externalResearchAvailable: false,
      expectedArtefactTypes: [],
    });
    // Only the self-review, which every coding run does regardless.
    expect(criteria.every((c) => c.kind === 'review_step')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('the narrowing check', () => {
  it('names the deliverables a brief dropped from the request', () => {
    // Commissioning's actual brief: "a written recommendation covering all
    // three, with a rough cost for each". The run then satisfied it exactly.
    const divergence = compareRequestToBrief({
      requestText: REAL_REQUEST,
      brief: brief({
        acceptanceCriteria: ['A written recommendation covering all three, with a rough cost for each'],
      }),
    });

    expect(divergence.note).not.toBeNull();
    expect(divergence.missingDeliverables.map((d) => d.type)).toContain('engineering_brief');
    expect(divergence.note).toMatch(/3 engineering briefs/);
  });

  it('notices when the brief drops the request for external research', () => {
    const divergence = compareRequestToBrief({
      requestText: 'Research external vendor documentation and tell me what you find.',
      brief: brief({ acceptanceCriteria: ['A summary of what our handbook says'] }),
    });

    expect(divergence.externalResearchDropped).toBe(true);
  });

  it('says nothing when the brief covers what was asked', () => {
    const divergence = compareRequestToBrief({
      requestText: 'Write me a recommendation.',
      brief: brief({ acceptanceCriteria: ['A recommendation'] }),
    });

    expect(divergence.note).toBeNull();
  });

  it('does not flag a brief that commits to MORE than the request', () => {
    const divergence = compareRequestToBrief({
      requestText: 'A recommendation please.',
      brief: brief({ acceptanceCriteria: ['Three recommendations and an investigation report'] }),
    });

    expect(divergence.missingDeliverables).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('heading matching', () => {
  it('normalises case, punctuation and articles', () => {
    expect(normaliseHeading('## The Build-Order!')).toBe('build order');
  });

  it('matches a heading that says more than the criterion asked', () => {
    expect(headingSatisfies('Build order', ['recommended build order'])).toBe(true);
  });

  it('finds bold-only lines, which is how models write headings inside JSON', () => {
    expect(extractHeadings('**Build order**\nsome text')).toContain('build order');
  });

  it('does NOT match a sentence that merely mentions the words', () => {
    // The failure the whole heading approach exists to avoid: "we did not
    // establish a build order" would satisfy a naive `body.includes()`.
    const headings = extractHeadings('We did not establish a build order for these systems.');
    expect(headingSatisfies('Build order', headings)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('checking a run against its criteria', () => {
  const criteria = (...items: AcceptanceCriterion[]) => items;

  it('fails an artefact-type criterion the run did not meet, and says by how much', () => {
    const results = evaluateDeterministic(
      criteria({
        id: 'a',
        kind: 'artefact_type',
        description: 'Produce 3 engineering briefs',
        required: true,
        source: 'derived',
        artefactType: 'engineering_brief',
        minimum: 3,
      }),
      evidence({ artefacts: [{ type: 'recommendation', title: 'R', body: '# R', findings: [] }] }),
    );

    expect(results[0]!.verdict).toBe('unmet');
    expect(results[0]!.observed).toBe('0 of type engineering_brief, 3 required');
  });

  it('reports external_sources_used = 0 in exactly those terms', () => {
    // Part F §23 names this number. It is the sentence an operator will read.
    const results = evaluateDeterministic(
      criteria({
        id: 'e',
        kind: 'external_sources',
        description: 'Retrieve at least one external source',
        required: true,
        source: 'derived',
        minimum: 1,
      }),
      evidence({ sources: [{ sourceClass: 'unknown', external: false }] }),
    );

    expect(results[0]!.verdict).toBe('unmet');
    expect(results[0]!.observed).toContain('external_sources_used = 0');
  });

  it('does not count an ungrounded factual claim towards an evidence criterion', () => {
    // A `pac_fact` with no sources is somebody having typed the word "fact".
    // Counting it would let the unsupported claim satisfy the check that exists
    // to notice unsupported claims.
    const results = evaluateDeterministic(
      criteria({
        id: 'v',
        kind: 'evidence_class',
        description: 'Establish something checkable',
        required: true,
        source: 'task_kind',
        evidenceClass: 'project_fact',
        minimum: 1,
      }),
      evidence({
        artefacts: [
          { type: 'recommendation', title: 'R', body: '# R', findings: [finding({ sources: [] })] },
        ],
      }),
    );

    expect(results[0]!.verdict).toBe('unmet');
  });

  it('lets a stronger evidence class satisfy a weaker requirement', () => {
    const results = evaluateDeterministic(
      criteria({
        id: 'v',
        kind: 'evidence_class',
        description: 'Establish something checkable',
        required: true,
        source: 'task_kind',
        evidenceClass: 'project_fact',
        minimum: 1,
      }),
      evidence({
        artefacts: [{ type: 'recommendation', title: 'R', body: '# R', findings: [finding()] }],
      }),
    );

    // A PAC fact is a stronger basis than a project fact, not a different one.
    expect(results[0]!.verdict).toBe('satisfied');
  });

  it('returns a semantic criterion as indeterminate rather than omitting it', () => {
    const results = evaluateDeterministic(
      criteria({
        id: 's',
        kind: 'semantic',
        description: 'States a rough cost for each system',
        required: true,
        source: 'derived',
        statement: 'The report states a rough cost for each of the three systems.',
      }),
      evidence(),
    );

    // Indeterminate, so a disabled or failed model review degrades to a gap
    // rather than to a pass.
    expect(results[0]!.verdict).toBe('indeterminate');
    expect(results[0]!.method).toBe('model');
  });

  it('fails a test criterion when tests ran and did not pass', () => {
    const results = evaluateDeterministic(
      criteria({
        id: 't',
        kind: 'test_run',
        description: 'Tests pass',
        required: true,
        source: 'derived',
        mustPass: true,
      }),
      evidence({ testsRun: 2, testsPassed: false }),
    );

    expect(results[0]!.verdict).toBe('unmet');
  });
});

// ---------------------------------------------------------------------------

describe('the overall verdict', () => {
  const result = (over: Partial<CriterionResult> = {}): CriterionResult => ({
    criterionId: 'c',
    kind: 'artefact_count',
    description: 'Produce something',
    required: true,
    verdict: 'satisfied',
    method: 'deterministic',
    observed: '',
    reasoning: '',
    ...over,
  });

  it('is not_assessed when there are no criteria, which is every pre-Phase-4 run', () => {
    expect(deriveAcceptanceState({ results: [], artefactsProduced: 0, expectsArtefacts: true })).toBe('not_assessed');
  });

  it('is FAILED, not gaps, when nothing was delivered', () => {
    // Commissioning established this the expensive way: a run that produced no
    // artefacts reported success and an email announced a finished
    // investigation containing nothing. "Gaps" means delivered-but-incomplete.
    expect(
      deriveAcceptanceState({ results: [result({ verdict: 'unmet' })], artefactsProduced: 0, expectsArtefacts: true }),
    ).toBe('failed');
  });

  it('is gaps when something was delivered and a required criterion was not met', () => {
    expect(
      deriveAcceptanceState({ results: [result({ verdict: 'unmet' })], artefactsProduced: 1, expectsArtefacts: true }),
    ).toBe('gaps');
  });

  it('treats indeterminate as a gap, never as a pass', () => {
    // A check nobody could decide is not a check that passed. Degrading to
    // green the moment a mechanism breaks is the worst possible direction for a
    // mechanism whose whole job is to notice.
    expect(
      deriveAcceptanceState({
        results: [result({ verdict: 'indeterminate' })],
        artefactsProduced: 1,
        expectsArtefacts: true,
      }),
    ).toBe('gaps');
  });

  it('ignores an unmet OPTIONAL criterion', () => {
    expect(
      deriveAcceptanceState({
        results: [result({ verdict: 'unmet', required: false })],
        artefactsProduced: 1,
        expectsArtefacts: true,
      }),
    ).toBe('satisfied');
  });

  it('does not fail a coding run for producing no artefacts, because a PR is not one', () => {
    expect(deriveAcceptanceState({ results: [result()], artefactsProduced: 0, expectsArtefacts: false })).toBe(
      'satisfied',
    );
  });

  it('lists exactly the required, unsatisfied criteria', () => {
    const results = [
      result({ criterionId: 'ok' }),
      result({ criterionId: 'bad', verdict: 'unmet' }),
      result({ criterionId: 'optional', verdict: 'unmet', required: false }),
      result({ criterionId: 'na', verdict: 'not_applicable' }),
    ];
    expect(unmetCriteria(results).map((r) => r.criterionId)).toEqual(['bad']);
  });
});
