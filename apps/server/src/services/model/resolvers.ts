import {
  modelAnswerSchema,
  modelBriefStructureSchema,
  type EvidenceRef,
  type ModelAssistRecord,
  type ModelBriefStructure,
  type ModelOutcome,
} from '@mac/protocol';
import { getModelProvider } from './provider.js';

/**
 * Model-backed resolvers, behind Sprint 2's existing seams (Sprint 3 §10).
 *
 * ---------------------------------------------------------------------------
 * WHAT THE MODEL CANNOT DO, STRUCTURALLY
 *
 * It receives candidate sources the deterministic layer already selected, and
 * returns `{ answer, reasoning, citedSourceIds }`. It does not return a
 * confidence — there is no field for one. It does not return a decision, a risk
 * class or an eligibility verdict.
 *
 * Then, in code:
 *
 *   1. a cited id that was not in the supplied set is DROPPED, so a fabricated
 *      citation cannot survive contact with the caller;
 *   2. if nothing survives, the model's answer is DISCARDED entirely and the
 *      deterministic result stands;
 *   3. confidence is RECOMPUTED from the surviving sources by the same function
 *      used when no model is configured.
 *
 * So the worst a hallucinating or compromised model can do is produce fluent
 * prose carrying a low deterministic confidence — which the existing decision
 * policy then treats as an assumption or a blocker. That is not a mitigation
 * bolted on afterwards; it is the only shape the data can take.
 * ---------------------------------------------------------------------------
 */

const ANSWER_SYSTEM = [
  'You are helping an autonomous engineering assistant answer an implementation question.',
  '',
  'You will be given a question and a numbered list of SOURCES. Answer ONLY from those sources.',
  'Cite the ids of the sources you used. Do not cite a source you did not use, and do not invent an id.',
  'If the sources do not answer the question, say so plainly and cite nothing.',
  '',
  'Reply with JSON only: {"answer": string, "reasoning": string, "citedSourceIds": string[]}',
  '',
  'Do not state a confidence. It is not yours to assign and there is nowhere to put it.',
].join('\n');

export interface ModelAnswerInput {
  question: string;
  context?: string | undefined;
  /** The candidate sources, already selected and scored deterministically. */
  sources: Array<{ id: string; label: string; text: string }>;
}

export interface ModelAnswerOutcome {
  /** Null when the model was unavailable, unusable, or cited nothing real. */
  answer: string | null;
  reasoning: string;
  /** Only ids that genuinely existed in the supplied set. */
  citedSourceIds: string[];
  record: ModelAssistRecord;
}

export async function resolveAnswerWithModel(input: ModelAnswerInput): Promise<ModelAnswerOutcome> {
  const provider = await getModelProvider();
  const availability = await provider.isAvailable();

  const empty = (outcome: ModelOutcome, detail: string | null): ModelAnswerOutcome => ({
    answer: null,
    reasoning: '',
    citedSourceIds: [],
    record: {
      provider: provider.name,
      model: null,
      outcome,
      inputTokens: null,
      outputTokens: null,
      fabricatedCitations: 0,
      detail,
    },
  });

  if (!availability.available) return empty('unavailable', availability.reason ?? null);
  if (input.sources.length === 0) {
    // Nothing to ground an answer in, so there is nothing worth asking about.
    return empty('rejected_no_valid_citation', 'No candidate sources were supplied.');
  }

  const prompt = [
    `QUESTION: ${input.question}`,
    input.context ? `CONTEXT: ${input.context}` : '',
    '',
    'SOURCES:',
    ...input.sources.map((s) => `[${s.id}] ${s.label}\n${s.text.slice(0, 2000)}`),
  ]
    .filter(Boolean)
    .join('\n');

  let completion;
  try {
    completion = await provider.complete({ system: ANSWER_SYSTEM, prompt, maxTokens: 1200, expectJson: true });
  } catch (err) {
    return empty('unavailable', (err as Error).message.slice(0, 300));
  }

  const parsed = parseJson(completion.text, modelAnswerSchema);
  if (!parsed) {
    return {
      ...empty('rejected_unparseable', 'The model did not return the required JSON shape.'),
      record: {
        provider: provider.name,
        model: completion.model,
        outcome: 'rejected_unparseable',
        inputTokens: completion.usage.inputTokens,
        outputTokens: completion.usage.outputTokens,
        fabricatedCitations: 0,
        detail: completion.text.slice(0, 300),
      },
    };
  }

  /*
   * The citation check.
   *
   * A model that cites `[7]` when only `[1]`–`[3]` were supplied has invented a
   * source, and an invented source is exactly what a reader would take as
   * evidence. Dropping it is not a courtesy — it is the mechanism that stops a
   * hallucination becoming a fact.
   */
  const supplied = new Set(input.sources.map((s) => s.id));
  const cited = parsed.citedSourceIds.filter((id) => supplied.has(id));
  const fabricated = parsed.citedSourceIds.length - cited.length;

  if (cited.length === 0) {
    return {
      answer: null,
      reasoning: parsed.reasoning,
      citedSourceIds: [],
      record: {
        provider: provider.name,
        model: completion.model,
        outcome: 'rejected_no_valid_citation',
        inputTokens: completion.usage.inputTokens,
        outputTokens: completion.usage.outputTokens,
        fabricatedCitations: fabricated,
        detail:
          fabricated > 0
            ? `The model cited ${fabricated} source(s) that do not exist; its answer was discarded.`
            : 'The model cited nothing, so its answer had no grounding and was discarded.',
      },
    };
  }

  return {
    answer: parsed.answer,
    reasoning: parsed.reasoning,
    citedSourceIds: cited,
    record: {
      provider: provider.name,
      model: completion.model,
      outcome: 'accepted',
      inputTokens: completion.usage.inputTokens,
      outputTokens: completion.usage.outputTokens,
      fabricatedCitations: fabricated,
      detail: fabricated > 0 ? `${fabricated} fabricated citation(s) were dropped.` : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Structuring a free-flow brief
// ---------------------------------------------------------------------------

const STRUCTURE_SYSTEM = [
  'You are structuring an engineer\'s free-flow description of a piece of work into a handoff brief.',
  '',
  'Use ONLY what the engineer said. Do not invent requirements, constraints or acceptance criteria.',
  'A field you cannot fill from what was said must be omitted — an omission lowers the confidence',
  'score and produces a question, which is the correct outcome. A plausible invention does not.',
  '',
  'Reply with JSON only, using these optional keys: userObjective, currentBehaviour, desiredBehaviour,',
  'proposedScope, constraints[], mustNotChange[], acceptanceCriteria[], testingExpectations[],',
  'likelyAffectedComponents[], outOfScope[], missingInformation[].',
].join('\n');

export interface ModelStructureOutcome {
  structure: ModelBriefStructure | null;
  record: ModelAssistRecord;
}

export async function structureBriefWithModel(
  title: string,
  conversation: string,
): Promise<ModelStructureOutcome> {
  const provider = await getModelProvider();
  const availability = await provider.isAvailable();

  const record = (outcome: ModelOutcome, detail: string | null, completion?: { model: string; usage: { inputTokens: number | null; outputTokens: number | null } }): ModelAssistRecord => ({
    provider: provider.name,
    model: completion?.model ?? null,
    outcome,
    inputTokens: completion?.usage.inputTokens ?? null,
    outputTokens: completion?.usage.outputTokens ?? null,
    fabricatedCitations: 0,
    detail,
  });

  if (!availability.available) {
    return { structure: null, record: record('unavailable', availability.reason ?? null) };
  }

  let completion;
  try {
    completion = await provider.complete({
      system: STRUCTURE_SYSTEM,
      prompt: `TASK TITLE: ${title}\n\nWHAT THE ENGINEER SAID:\n${conversation.slice(0, 20_000)}`,
      maxTokens: 2000,
      expectJson: true,
    });
  } catch (err) {
    return { structure: null, record: record('unavailable', (err as Error).message.slice(0, 300)) };
  }

  const parsed = parseJson(completion.text, modelBriefStructureSchema);
  if (!parsed) {
    return { structure: null, record: record('rejected_unparseable', completion.text.slice(0, 300), completion) };
  }

  return { structure: parsed, record: record('accepted', null, completion) };
}

// ---------------------------------------------------------------------------

/**
 * Parses a model's JSON, tolerating the prose it wraps around it.
 *
 * Models are asked for JSON only and mostly comply; when they do not, the
 * object is usually still in there. Extracting it is worth doing once here
 * rather than treating a fenced code block as a hallucination.
 */
function parseJson<T>(text: string, schema: { safeParse: (value: unknown) => { success: boolean; data?: T } }): T | null {
  const candidates = [text, extractBraced(text)].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    try {
      const result = schema.safeParse(JSON.parse(candidate));
      if (result.success && result.data) return result.data;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function extractBraced(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

/** Turns supplied sources into stable ids for citation checking. */
export const withCitationIds = <T extends { label: string; text: string }>(sources: T[]) =>
  sources.map((source, index) => ({ id: `s${index + 1}`, label: source.label, text: source.text, source }));

/** Maps surviving citations back to evidence refs, preserving their kinds. */
export function evidenceFromCitations<T extends { label: string; text: string }>(
  supplied: Array<{ id: string; source: T }>,
  citedIds: string[],
  kindOf: (source: T) => EvidenceRef['kind'],
): EvidenceRef[] {
  return supplied
    .filter((entry) => citedIds.includes(entry.id))
    .map((entry) => ({
      kind: kindOf(entry.source),
      ref: entry.source.label,
      excerpt: entry.source.text.slice(0, 1000),
    }));
}
