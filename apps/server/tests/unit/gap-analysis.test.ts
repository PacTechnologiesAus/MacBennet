import { describe, expect, it } from 'vitest';
import { handoffBriefContentSchema, projectContextSnapshotSchema, type HandoffBriefContent, type ProjectContextSnapshot } from '@mac/protocol';
import { analyseGaps, deriveFromContext } from '../../src/domain/gap-analysis.js';
import { classifyConfidence } from '../../src/domain/confidence.js';

/**
 * Gap analysis (spec §4 Phase D).
 *
 * Two behaviours matter here: understanding confidence must be DERIVED from a
 * visible checklist rather than guessed, and Mac must not ask the human a
 * question the repository can answer.
 */

const emptyish = (overrides: Partial<HandoffBriefContent> = {}): HandoffBriefContent =>
  handoffBriefContentSchema.parse({ title: 'Something', userObjective: 'Do a thing', ...overrides });

const complete = (): HandoffBriefContent =>
  handoffBriefContentSchema.parse({
    title: 'Allow selecting multiple devices',
    userObjective: 'Operators must be able to select several devices instead of only one, so bulk actions are possible.',
    currentBehaviour: 'The device selection screen accepts exactly one device at a time.',
    desiredBehaviour: 'The screen accepts multiple devices and the API accepts an array of device ids.',
    relevantArchitecture: 'React SPA with a Fastify API; the selector is a controlled component.',
    constraints: ['Do not change the CSV import format.'],
    mustNotChange: ['the CSV import format'],
    likelyAffectedComponents: ['DeviceSelector', 'devices API route'],
    acceptanceCriteria: ['An operator can select two or more devices and save.'],
    testingExpectations: ['Unit tests for the selection reducer.'],
  });

const context = (overrides: Partial<ProjectContextSnapshot> = {}): ProjectContextSnapshot =>
  projectContextSnapshotSchema.parse({
    repositoryId: '11111111-1111-1111-1111-111111111111',
    defaultBranch: 'main',
    headSha: 'abcdef1234567890',
    branches: ['main'],
    recentCommits: [{ sha: 'abc', author: 'Kasper', at: '2026-08-01T00:00:00Z', subject: 'chore: bump deps' }],
    readme: '# Device Portal\nA React SPA over a Fastify API.',
    docFiles: ['docs/architecture.md'],
    packageManifests: [{ path: 'package.json', name: 'device-portal', scripts: ['test', 'build', 'typecheck'] }],
    testPaths: ['tests/unit', 'tests/integration'],
    languages: ['TypeScript'],
    fileCount: 240,
    ...overrides,
  });

describe('understanding confidence is derived, not guessed', () => {
  it('gives a nearly empty brief a confidence below the execution floor', () => {
    const analysis = analyseGaps(emptyish());
    expect(analysis.confidence).toBeLessThan(0.6);
    expect(classifyConfidence(analysis.confidence, { minExecutionConfidence: 0.6, defaultConfidenceThreshold: 0.8 })).toBe('below_floor');
  });

  it('gives a complete brief a confidence in the autonomous band', () => {
    const analysis = analyseGaps(complete());
    expect(analysis.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('exposes every dimension so the number can be argued with', () => {
    const analysis = analyseGaps(complete());
    expect(analysis.assessments).toHaveLength(10);
    for (const a of analysis.assessments) {
      expect(typeof a.satisfied).toBe('boolean');
      expect(a.weight).toBeGreaterThan(0);
      expect(a.question.length).toBeGreaterThan(0);
    }
  });

  it('weights the dimensions to sum to one, so confidence is a real proportion', () => {
    const analysis = analyseGaps(complete());
    const total = analysis.assessments.reduce((sum, a) => sum + a.weight, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('rises monotonically as the brief is filled in', () => {
    const partial = analyseGaps(emptyish({ desiredBehaviour: 'The screen should accept multiple devices at once.' }));
    const fuller = analyseGaps(
      emptyish({
        desiredBehaviour: 'The screen should accept multiple devices at once.',
        acceptanceCriteria: ['An operator can select two devices and save.'],
      }),
    );
    expect(fuller.confidence).toBeGreaterThan(partial.confidence);
  });
});

describe('Mac does not ask what the repository can answer', () => {
  it('marks architecture and testing as discoverable once the repository is inspected', () => {
    const analysis = analyseGaps(emptyish(), context());
    const architecture = analysis.assessments.find((a) => a.dimension === 'architecture')!;
    const testing = analysis.assessments.find((a) => a.dimension === 'testing')!;

    expect(architecture.discoverableFrom.length).toBeGreaterThan(0);
    expect(testing.discoverableFrom.length).toBeGreaterThan(0);

    // ...and therefore never puts them to the human.
    expect(analysis.outstanding.map((o) => o.dimension)).not.toContain('architecture');
    expect(analysis.outstanding.map((o) => o.dimension)).not.toContain('testing');
  });

  it('never treats intent as discoverable — a repository cannot know what the user wants', () => {
    const analysis = analyseGaps(emptyish(), context());
    for (const dimension of ['user_outcome', 'desired_behaviour', 'acceptance_criteria', 'constraints', 'must_not_change'] as const) {
      const assessment = analysis.assessments.find((a) => a.dimension === dimension)!;
      expect(assessment.discoverableFrom, `${dimension} must not be answerable from the repository`).toEqual([]);
    }
  });

  it('gives discoverable dimensions partial rather than full credit', () => {
    // Inference from a repository is weaker evidence than the human saying it,
    // and pretending otherwise would let confidence reach the autonomous band
    // on inference alone.
    const withoutContext = analyseGaps(emptyish());
    const withContext = analyseGaps(emptyish(), context());
    const fullySpecified = analyseGaps(complete());

    expect(withContext.confidence).toBeGreaterThan(withoutContext.confidence);
    expect(withContext.confidence).toBeLessThan(fullySpecified.confidence);
    expect(withContext.confidence).toBeLessThan(0.6);
  });
});

describe('one question at a time (spec §4)', () => {
  it('offers exactly one next question, and it is the heaviest gap', () => {
    const analysis = analyseGaps(emptyish(), context());
    expect(analysis.nextQuestion).not.toBeNull();
    const heaviest = Math.max(...analysis.outstanding.map((o) => o.weight));
    expect(analysis.nextQuestion!.weight).toBe(heaviest);
  });

  it('has no next question once everything the human must supply is supplied', () => {
    expect(analyseGaps(complete(), context()).nextQuestion).toBeNull();
  });
});

describe('deriving brief content from the repository', () => {
  it('fills architecture and testing from what was actually inspected, with provenance', () => {
    const derived = deriveFromContext(context());
    expect(derived.relevantArchitecture).toContain('TypeScript');
    expect(derived.relevantArchitecture).toContain('abcdef12'); // the inspected commit
    expect(derived.testingExpectations?.join(' ')).toContain('tests/unit');
  });

  it('derives nothing it did not observe', () => {
    const derived = deriveFromContext(context({ testPaths: [], packageManifests: [], docFiles: [], languages: [] }));
    expect(derived.testingExpectations).toBeUndefined();
  });
});

describe('structuring a free-flow conversation', () => {
  it('extracts what must not change, not the whole sentence about it', async () => {
    // The extracted noun is what the self-review compares against changed file
    // paths. Storing the whole sentence would make that comparison useless,
    // which is a check that exists and never fires.
    const { structureConversation, extractMustNotChange } = await import('../../src/services/discovery.js');

    expect(extractMustNotChange("don't change the existing import format because customers are using it")).toBe(
      'existing import format',
    );
    expect(extractMustNotChange('we must not modify the billing schedule')).toBe('billing schedule');
    expect(extractMustNotChange('please make the screen nicer')).toBeNull();

    const brief = structureConversation(
      'Allow selecting multiple devices',
      "I want this screen changed so users can select multiple devices. At the moment it only accepts one. " +
        "We also need the API to support that, but don't change the existing import format because customers are using it.",
    );

    expect(brief.mustNotChange).toEqual(['existing import format']);
    // The full sentence is still kept, as the constraint a human reads.
    expect(brief.constraints.join(' ')).toContain('customers are using it');
    expect(brief.currentBehaviour).toContain('only accepts one');
  });
});
