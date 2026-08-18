import { describe, expect, it } from 'vitest';
import { emptyBriefContent, capUngroundedConfidence, deriveGroundedness } from '@mac/protocol';
import { investigate, type InvestigationSources } from '../../src/domain/investigation.js';

/**
 * Investigate before escalating (Sprint 3 §6, brief §4).
 *
 * The claim under test is not "Mac finds the answer". It is that he CHECKS
 * every source before deciding he cannot, and that the record of what he
 * checked is complete enough to argue with.
 */

const empty = (): InvestigationSources => ({
  brief: null,
  repositoryContext: null,
  projectMemory: [],
  taskMemory: [],
  previousRuns: [],
  previousBriefs: [],
  mondayContext: [],
});

const run = (subject: string, sources: Partial<InvestigationSources>, threshold = 0.4) =>
  investigate({ subjectKind: 'agent_question', subject, sources: { ...empty(), ...sources }, resolveThreshold: threshold });

describe('the escalation receipt', () => {
  it('checks every one of the six source classes, even when the first one answers', () => {
    const result = run('What test framework should I use?', {
      repositoryContext: {
        repositoryId: '00000000-0000-4000-8000-000000000000',
        defaultBranch: 'main',
        headSha: 'abc',
        branches: [],
        recentCommits: [],
        readme: null,
        docFiles: [],
        packageManifests: [{ path: 'package.json', name: 'app', scripts: ['test'] }],
        testPaths: ['tests/unit'],
        languages: ['TypeScript'],
        fileCount: 10,
        changedSinceLastInvolvement: null,
      },
    });

    // Stopping early would be faster and would make the receipt a lie:
    // "checked the repository and stopped" does not justify asking a human.
    expect(result.checked).toHaveLength(6);
    expect(result.checked.map((c) => c.source)).toEqual([
      'repository',
      'project_memory',
      'task_memory',
      'previous_runs',
      'previous_briefs',
      'monday',
    ]);
  });

  it('says of each source whether it was available, and what it returned', () => {
    const result = run('Anything', { projectMemory: [{ key: 'framework', value: 'Vitest', confidence: 1 }] });

    const project = result.checked.find((c) => c.source === 'project_memory')!;
    expect(project.consulted).toBe(true);
    expect(project.note.length).toBeGreaterThan(0);

    const monday = result.checked.find((c) => c.source === 'monday')!;
    expect(monday.consulted).toBe(false);
    expect(monday.note).toContain('Nothing of this kind was available');
  });

  it('escalates only when every source has been checked and none resolved it', () => {
    const result = run('What colour should the button be?', {
      projectMemory: [{ key: 'deploy_target', value: 'Azure', confidence: 1 }],
    });
    expect(result.resolved).toBe(false);
    expect(result.escalatedToHuman).toBe(true);
    expect(result.checked.every((c) => c.consulted || c.note.includes('Nothing of this kind'))).toBe(true);
  });
});

describe('each source class can answer on its own', () => {
  it('the repository', () => {
    const result = run('Where do the tests live?', {
      repositoryContext: {
        repositoryId: '00000000-0000-4000-8000-000000000000',
        defaultBranch: 'main',
        headSha: 'abc',
        branches: [],
        recentCommits: [],
        readme: null,
        docFiles: [],
        packageManifests: [],
        testPaths: ['tests/unit', 'tests/integration'],
        languages: [],
        fileCount: 10,
        changedSinceLastInvolvement: null,
      },
    });
    expect(result.resolved).toBe(true);
    expect(result.evidence[0]!.kind).toBe('repository_fact');
  });

  it('project memory', () => {
    const result = run('Which deployment target does this project use?', {
      projectMemory: [{ key: 'deployment target', value: 'Azure App Service', confidence: 1 }],
    });
    expect(result.resolved).toBe(true);
    expect(result.evidence[0]!.kind).toBe('project_memory');
    expect(result.answer).toContain('Azure App Service');
  });

  it('a previous run', () => {
    const result = run('Which logging library should I use?', {
      previousRuns: [
        {
          runId: '11111111-1111-4111-8111-111111111111',
          question: 'Which logging library should I use?',
          answer: 'pino, the same as the rest of the codebase.',
          confidence: 0.9,
        },
      ],
    });
    expect(result.resolved).toBe(true);
    expect(result.evidence[0]!.kind).toBe('previous_run');
    expect(result.answer).toContain('pino');
  });

  it('an earlier brief', () => {
    const result = run('Can I change the CSV import format?', {
      previousBriefs: [
        {
          briefId: '22222222-2222-4222-8222-222222222222',
          label: 'earlier brief: must not change[0]',
          text: 'Must not change: the existing CSV import format, because customers depend on it.',
        },
      ],
    });
    expect(result.resolved).toBe(true);
    expect(result.evidence[0]!.kind).toBe('user_approved_decision');
  });

  it('the monday item, where a human wrote it down at 16:00', () => {
    const result = run('Should the export include archived devices?', {
      mondayContext: [
        {
          ref: 'monday:item/8891/update/3',
          text: 'The export should include archived devices — finance asked for them explicitly.',
        },
      ],
    });
    expect(result.resolved).toBe(true);
    expect(result.evidence[0]!.kind).toBe('monday_item');
    expect(result.answer).toContain('archived devices');
  });

  it('the handoff brief', () => {
    const result = run('What are the acceptance criteria?', {
      brief: {
        ...emptyBriefContent('Multi-device selection'),
        acceptanceCriteria: ['An operator can select two or more devices and save them together.'],
      },
    });
    expect(result.resolved).toBe(true);
    expect(result.answer).toContain('two or more devices');
  });
});

describe('confidence and grounding', () => {
  it('discounts an answer Mac merely assumed on a previous run', () => {
    const confident = run('Which logging library?', {
      previousRuns: [
        { runId: 'r1', question: 'Which logging library?', answer: 'pino', confidence: 1 },
      ],
    });
    const uncertain = run('Which logging library?', {
      previousRuns: [
        { runId: 'r1', question: 'Which logging library?', answer: 'pino', confidence: 0.3 },
      ],
    });
    // An assumption does not become a fact by being repeated.
    expect(uncertain.confidence).toBeLessThan(confident.confidence);
  });

  it('never reports confidence above the ungrounded ceiling without factual evidence', () => {
    // The domain rule, asserted directly: an answer resting on nothing factual
    // cannot claim to be one Mac may act on.
    expect(capUngroundedConfidence(0.99, [])).toBeLessThanOrEqual(0.59);
    expect(capUngroundedConfidence(0.99, [{ kind: 'inferred_assumption', ref: 'guess', excerpt: '' }])).toBeLessThanOrEqual(
      0.59,
    );
    expect(capUngroundedConfidence(0.99, [{ kind: 'repository_fact', ref: 'README', excerpt: '' }])).toBe(0.99);
  });

  it('derives groundedness rather than accepting a claim of it', () => {
    expect(deriveGroundedness([])).toBe('assumption');
    expect(deriveGroundedness([{ kind: 'inferred_assumption', ref: 'x', excerpt: '' }])).toBe('assumption');
    expect(deriveGroundedness([{ kind: 'monday_item', ref: 'monday:item/1', excerpt: '' }])).toBe('established_fact');
  });

  it('returns no evidence at all when nothing matched, rather than a weak citation', () => {
    const result = run('Something nobody has ever discussed anywhere', {
      projectMemory: [{ key: 'unrelated', value: 'unrelated', confidence: 1 }],
    });
    expect(result.evidence).toEqual([]);
    expect(result.confidence).toBe(0);
  });

  it('is corroborated by, but not dominated by, a second source', () => {
    const single = run('Which test framework?', {
      projectMemory: [{ key: 'test framework', value: 'Vitest', confidence: 1 }],
    });
    const corroborated = run('Which test framework?', {
      projectMemory: [{ key: 'test framework', value: 'Vitest', confidence: 1 }],
      taskMemory: [{ key: 'test framework', value: 'Vitest', confidence: 1 }],
    });
    expect(corroborated.confidence).toBeGreaterThan(single.confidence);
    // Corroboration is real but worth much less than the primary match.
    expect(corroborated.confidence - single.confidence).toBeLessThan(0.3);
  });
});
