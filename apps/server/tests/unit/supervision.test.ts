import { describe, expect, it } from 'vitest';
import { handoffBriefContentSchema, type HandoffBriefContent } from '@mac/protocol';
import {
  classifyQuestionRisk,
  isLowConfidenceAnswer,
  resolveAnswer,
  superviseQuestion,
  type SupervisionInput,
} from '../../src/domain/supervision.js';

const policy = { answerConfidenceThreshold: 0.8, minExecutionConfidence: 0.6 };

const brief = (overrides: Partial<HandoffBriefContent> = {}): HandoffBriefContent =>
  handoffBriefContentSchema.parse({
    title: 'Allow selecting multiple devices',
    userObjective: 'Operators must be able to select several devices on the device screen instead of only one.',
    currentBehaviour: 'The device selection screen accepts exactly one device at a time.',
    desiredBehaviour: 'The device selection screen accepts multiple devices and the API accepts an array of device ids.',
    constraints: ['Do not change the CSV import format, because customers depend on it.'],
    mustNotChange: ['the CSV import format'],
    acceptanceCriteria: ['An operator can select two or more devices and save.'],
    testingExpectations: ['Add unit tests for the selection reducer using Vitest.'],
    likelyAffectedComponents: ['DeviceSelector component', 'devices API route'],
    outOfScope: ['redesigning the device screen layout'],
    ...overrides,
  });

const input = (overrides: Partial<SupervisionInput> = {}): SupervisionInput => ({
  question: 'Which test framework should I use for the new tests?',
  brief: brief(),
  memory: [],
  policy,
  ...overrides,
});

describe('risk classification', () => {
  it.each([
    ['Should I drop the devices table and recreate it?', 'destructive database operation'],
    ['Can I deploy this to production once it builds?', 'production deployment'],
    ['Where do I find the API key for the device service?', 'credentials or secrets'],
    ['Should I disable the validation check on the import?', 'weakening a safety control'],
    ['Shall I merge this into main when I am done?', 'prohibited git operation'],
    ['Can I download the new logic to the live PLC controller?', 'live industrial control'],
  ])('flags %j as high risk', (question, why) => {
    const assessment = classifyQuestionRisk(question);
    expect(assessment.risk).toBe('high');
    expect(assessment.sensitive).toBe(true);
    expect(assessment.reasons).toContain(why);
  });

  it('flags a schema migration as medium risk and not reversible', () => {
    const assessment = classifyQuestionRisk('Do you want me to add a migration for the new column?');
    expect(assessment.risk).toBe('medium');
    expect(assessment.reversible).toBe(false);
  });

  it('flags adding a new dependency as medium risk', () => {
    expect(classifyQuestionRisk('Should I add a new library for date parsing?').risk).toBe('medium');
  });

  it('leaves an ordinary implementation question at low risk', () => {
    const assessment = classifyQuestionRisk('Should the selection list be sorted alphabetically?');
    expect(assessment.risk).toBe('low');
    expect(assessment.sensitive).toBe(false);
    expect(assessment.reversible).toBe(true);
  });
});

describe('answer retrieval', () => {
  it('answers from the brief and cites the field it used', () => {
    const result = resolveAnswer(input({ question: 'What testing is expected for this change?' }));
    expect(result.answer).toContain('Vitest');
    expect(result.sources.some((s) => s.startsWith('brief.testingExpectations'))).toBe(true);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('answers from project memory when the brief is silent', () => {
    const result = resolveAnswer(
      input({
        question: 'What indentation style does this codebase use?',
        memory: [{ key: 'indentation style', value: 'two spaces, enforced by the formatter', scope: 'project', confidence: 1 }],
      }),
    );
    expect(result.answer).toContain('two spaces');
    expect(result.sources[0]).toContain('project memory');
  });

  it('prefers task memory over project memory when both match', () => {
    const result = resolveAnswer(
      input({
        question: 'Which logging approach should the device selector use?',
        memory: [
          { key: 'logging approach', value: 'use the shared logger', scope: 'project', confidence: 1 },
          { key: 'logging approach', value: 'for this task, log nothing new', scope: 'task', confidence: 1 },
        ],
      }),
    );
    // The property under test is the RELATIVE authority of the two memory
    // layers, not that memory outranks the brief — the brief legitimately
    // outranks both when it speaks to the question.
    const taskRank = result.sources.findIndex((s) => s.startsWith('task memory'));
    const projectRank = result.sources.findIndex((s) => s.startsWith('project memory'));
    expect(taskRank).toBeGreaterThanOrEqual(0);
    expect(projectRank === -1 || taskRank < projectRank).toBe(true);
  });

  it('returns zero confidence and a conservative answer when nothing matches', () => {
    const result = resolveAnswer(input({ question: 'Which colour should the widget be painted?' }));
    expect(result.confidence).toBe(0);
    expect(result.sources).toEqual([]);
    expect(result.answer).toContain('conservative');
  });

  it('never claims certainty', () => {
    const result = resolveAnswer(input({ question: 'What testing is expected for this change?' }));
    expect(result.confidence).toBeLessThan(1);
  });
});

describe('supervision decisions (Sprint 2 §8, §9)', () => {
  it('answers a well-supported low-risk question and lets execution continue', () => {
    const result = superviseQuestion(
      input({
        question: 'What testing expectations apply, and should tests use Vitest for the selection reducer?',
      }),
    );
    expect(result.decision).toBe('answered');
    expect(result.requiredHuman).toBe(false);
    expect(result.blocker).toBeNull();
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.reasoning).not.toBe('');
  });

  it('makes a flagged assumption when confidence is low but the decision is reversible and in scope', () => {
    const result = superviseQuestion(
      input({ question: 'Should the device list be sorted alphabetically when displayed?' }),
    );
    expect(result.decision).toBe('assumed');
    expect(result.isAssumption).toBe(true);
    expect(result.answer).toContain('flagged for human review');
    expect(result.blocker).toBeNull();
  });

  it('blocks an unsafe decision rather than guessing, however it is phrased', () => {
    const result = superviseQuestion(
      input({ question: 'Should I drop the devices table so the new schema applies cleanly?' }),
    );
    expect(result.decision).toBe('blocked');
    expect(result.risk).toBe('high');
    expect(result.requiredHuman).toBe(true);
    expect(result.blocker).not.toBeNull();
    // The instruction back to the agent must keep the rest of the run alive.
    expect(result.answer).toContain('independent work');
  });

  it('blocks an irreversible decision it cannot support', () => {
    const result = superviseQuestion(
      input({ question: 'Should I rename the deviceId column to device_identifier?' }),
    );
    expect(result.decision).toBe('blocked');
  });

  it('blocks a question about something the brief put out of scope', () => {
    const result = superviseQuestion(
      input({ question: 'Should I start redesigning the device screen layout while I am here?' }),
    );
    expect(result.decision).toBe('blocked');
    expect(result.reasoning).toContain('scope');
  });

  it('answers a constraint question from the brief with the constraint itself', () => {
    const result = superviseQuestion(
      input({ question: 'Can I change the CSV import format to make this simpler?' }),
    );
    // Whatever it decides, it must surface the recorded constraint rather than
    // inventing permission.
    expect(`${result.answer} ${result.reasoning}`.toLowerCase()).toContain('csv import format');
  });

  it('records reasoning and sources for every decision, including blocks', () => {
    for (const question of [
      'What testing is expected?',
      'Should the list be sorted?',
      'Shall I drop the devices table?',
    ]) {
      const result = superviseQuestion(input({ question }));
      expect(result.reasoning.length).toBeGreaterThan(10);
      expect(Array.isArray(result.sources)).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe('low-confidence reporting threshold', () => {
  it('compares on the fixed-point scale, not floating point', () => {
    expect(isLowConfidenceAnswer(0.8, 0.8)).toBe(false);
    expect(isLowConfidenceAnswer(0.799, 0.8)).toBe(true);
    expect(isLowConfidenceAnswer(0.1 + 0.7, 0.8)).toBe(false);
  });
});
