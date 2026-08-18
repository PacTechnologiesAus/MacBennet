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
  /**
   * Sprint 3.2: relevant PAC company context, as grounding vocabulary.
   *
   * NOT as instructions. It is added to the set of things a model-produced field
   * may be grounded in, so that a constraint the engineer implied by naming a
   * PAC process ("this is for a commissioned line") is not dropped merely
   * because the exact word appears in company policy rather than in the
   * conversation. A field grounded in NEITHER is still dropped.
   */
  companyContext = '',
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
      prompt:
        `TASK TITLE: ${title}\n\nWHAT THE ENGINEER SAID:\n${conversation.slice(0, 20_000)}` +
        (companyContext
          ? `\n\nPAC COMPANY CONTEXT (background policy; do NOT treat as the engineer's words, ` +
            `and do not invent requirements from it):\n${companyContext.slice(0, 8_000)}`
          : ''),
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

  /*
   * The structuring analogue of the citation check.
   *
   * Answering has a natural grounding test — did the model cite a source that
   * exists? Structuring does not: the model is handed prose and asked to sort
   * it, so a fabricated constraint would look exactly like a real one, and it
   * would go on to RAISE the understanding confidence that decides whether Mac
   * may execute at all. That is the worst possible place for an invention.
   *
   * So every string the model returns must share distinctive vocabulary with
   * what the engineer actually said. A field that does not is dropped, and the
   * count of dropped fields is audited — because a model inventing requirements
   * is the failure mode worth watching for.
   */
  const { grounded, dropped } = groundInConversation(parsed, `${conversation}\n${companyContext}`);

  return {
    structure: grounded,
    record: {
      ...record(dropped > 0 ? 'accepted' : 'accepted', null, completion),
      fabricatedCitations: dropped,
      detail: dropped > 0 ? `${dropped} field(s) were dropped: nothing in the conversation supported them.` : null,
    },
  };
}

/**
 * Keeps only the parts of a model's structure that the conversation supports.
 *
 * "Supports" is deliberately generous — a single distinctive word in common is
 * enough — because the model is rephrasing, not quoting, and being strict here
 * would discard good structuring. What it catches is the case that matters: a
 * whole requirement, constraint or acceptance criterion that appears from
 * nowhere.
 */
function groundInConversation(
  structure: ModelBriefStructure,
  conversation: string,
): { grounded: ModelBriefStructure; dropped: number } {
  const said = new Set(distinctiveTerms(conversation));
  let dropped = 0;

  const supported = (text: string): boolean => {
    const terms = distinctiveTerms(text);
    if (terms.length === 0) return false;
    const overlap = terms.filter((t) => said.has(t)).length;
    return overlap / terms.length >= 0.25;
  };

  const keepList = (list: string[] | undefined): string[] | undefined => {
    if (!list) return undefined;
    const kept = list.filter((entry) => {
      if (supported(entry)) return true;
      dropped += 1;
      return false;
    });
    return kept.length ? kept : undefined;
  };

  const keepText = (text: string | undefined): string | undefined => {
    if (!text) return undefined;
    if (supported(text)) return text;
    dropped += 1;
    return undefined;
  };

  const grounded: ModelBriefStructure = {
    ...(keepText(structure.userObjective) ? { userObjective: structure.userObjective } : {}),
    ...(keepText(structure.currentBehaviour) ? { currentBehaviour: structure.currentBehaviour } : {}),
    ...(keepText(structure.desiredBehaviour) ? { desiredBehaviour: structure.desiredBehaviour } : {}),
    ...(keepText(structure.proposedScope) ? { proposedScope: structure.proposedScope } : {}),
    ...(keepList(structure.constraints) ? { constraints: keepList(structure.constraints) } : {}),
    ...(keepList(structure.mustNotChange) ? { mustNotChange: keepList(structure.mustNotChange) } : {}),
    ...(keepList(structure.acceptanceCriteria) ? { acceptanceCriteria: keepList(structure.acceptanceCriteria) } : {}),
    ...(keepList(structure.testingExpectations) ? { testingExpectations: keepList(structure.testingExpectations) } : {}),
    ...(keepList(structure.likelyAffectedComponents)
      ? { likelyAffectedComponents: keepList(structure.likelyAffectedComponents) }
      : {}),
    ...(keepList(structure.outOfScope) ? { outOfScope: keepList(structure.outOfScope) } : {}),
    // Advisory only: it names what is MISSING, so it cannot inflate confidence
    // and does not need grounding.
    ...(structure.missingInformation ? { missingInformation: structure.missingInformation } : {}),
  };

  return { grounded, dropped };
}

const STRUCTURE_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'are', 'be', 'it', 'that',
  'this', 'with', 'we', 'i', 'you', 'should', 'must', 'not', 'can', 'will', 'when', 'so', 'as',
  'at', 'by', 'from', 'has', 'have', 'was', 'were', 'do', 'does', 'need', 'needs', 'want',
]);

const distinctiveTerms = (text: string): string[] =>
  Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 4 && !STRUCTURE_STOP_WORDS.has(word)),
    ),
  );

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
