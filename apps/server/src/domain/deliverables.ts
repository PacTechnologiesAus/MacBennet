import type { ArtefactType } from '@mac/protocol';

/**
 * Reading what a request asks Mac to PRODUCE (Phase 4 Part F, commissioning defect 9).
 *
 * ---------------------------------------------------------------------------
 * THE RUN THAT CAUSED THIS FILE
 *
 * A brief asking for
 *
 *   "two separate engineering briefs and two distinct documents"
 *
 * — where the second phrase was the requester naming the same two briefs a
 * second time — derived `engineering_brief × 2` AND `markdown_document × 2`,
 * and therefore required four artefacts. The run produced the two briefs that
 * were wanted and was reported with a gap.
 *
 * That is the worst direction for acceptance verification to fail in. Defect 8
 * was a criterion no compliant run could meet. This is a criterion no CORRECT
 * DELIVERY could meet, and a gap that appears when the work was right teaches a
 * reader that gaps are noise — which disarms the whole mechanism.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A TAXONOMY AND NOT A LONGER REGEX
 *
 * The tempting fix is an exception for "and N distinct documents". It would
 * pass the failing case and leave every other phrasing of the same idea broken,
 * because the problem is not the phrase. The problem is that the old pass had
 * no concept of two mentions REFERRING TO THE SAME THING — it turned every noun
 * it recognised into an independent requirement and summed them.
 *
 * So there are two stages here and they are deliberately separate:
 *
 *   EXTRACTION   finds every candidate mention, positionally, with the words
 *                that produced it. It decides nothing about identity.
 *   NORMALISATION decides, for each candidate, what relationship it bears to
 *                the ones around it: additive, alias, explanatory, contains, or
 *                — the important one — ambiguous.
 *
 * The rule normalisation applies:
 *
 *   A SPECIFIC DELIVERABLE TYPE DEFINES ARTEFACT IDENTITY. A GENERIC CONTAINER
 *   NOUN — document, file, report, artefact, output — MUST NOT CREATE AN
 *   ADDITIONAL REQUIRED ARTEFACT WHERE THE EVIDENCE SHOWS IT NAMES A
 *   DELIVERABLE ALREADY DERIVED.
 *
 * Generic nouns are not discarded. "Write me two documents" asks for two
 * documents and nothing here may talk it down to fewer. What a generic noun may
 * not do is silently double a count.
 *
 * ---------------------------------------------------------------------------
 * AND WHEN IT CANNOT TELL
 *
 * "provide two briefs and documentation" does not say whether the documentation
 * IS the briefs. Neither answer is safe to invent: guess `alias` and a real
 * deliverable disappears from the contract; guess `additive` and a correct run
 * is marked short. So normalisation returns `ambiguous`, derives no criterion
 * from it at all, and the ambiguity becomes a question put to a human during
 * discovery — while the criteria can still be changed, and before approval
 * freezes them onto a run.
 *
 * `required_count = a guessed number` is the failure this module exists to stop
 * making. `needs_clarification` is the correct output when the text is unclear.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// The taxonomy
// ---------------------------------------------------------------------------

/**
 * Deliverable types, which are not artefact types.
 *
 * `ARTEFACT_TYPES` is what Mac can STORE — eight rows in a database enum shared
 * with the worker, the web client and every persisted artefact. This vocabulary
 * is what a requester can NAME, and it is deliberately finer: "test report" and
 * "investigation report" are both stored as `investigation_report`, and a
 * summary document and a procedure are both `markdown_document`, but they are
 * different things to ask for and treating them as one would make "a summary
 * and a procedure" a single artefact.
 *
 * Keeping the two apart is what lets the specific-over-generic rule be stated
 * without touching the storage model at all.
 */
export const SPECIFIC_DELIVERABLE_TYPES = [
  'engineering_brief',
  'architecture_note',
  'summary_document',
  'test_report',
  'investigation_report',
  'recommendation',
  'task_proposal',
  'drawing',
  'diagram',
  'procedure',
  'structured_data',
] as const;

/**
 * Container nouns. A word for "a thing that was written", naming no kind.
 *
 * `report` is here as well as in the specific list, and the difference is which
 * pattern matched: "test report" and "investigation report" name a kind, a bare
 * "report" does not. The longest-match rule below is what decides.
 */
export const GENERIC_DELIVERABLE_TYPES = [
  'document',
  'documentation',
  'file',
  'artefact',
  'output',
  'report',
  'note',
  'write_up',
  /*
   * `deliverable` is deliberately NOT here.
   *
   * It is the word briefs use as a HEADING — "Deliverables:", or a task titled
   * "Deliverables" — far more often than as a countable noun, and a brief whose
   * objective line happens to be that word would have required an artefact
   * because of its own section title. Caught by the regression tests below on
   * the first run, which is exactly what they are for.
   */
] as const;

/**
 * Container nouns that are also everyday verbs.
 *
 * `documentation` and `artefact` are nouns in every tense; the other six are
 * not, and in the imperative mood a brief is usually written in, the verb
 * reading is the commoner one. See the bare-singular rule in extraction.
 */
const VERB_CONTAINERS = new Set(['document', 'note', 'file', 'report', 'output', 'write_up']);

export type SpecificDeliverableType = (typeof SPECIFIC_DELIVERABLE_TYPES)[number];
export type GenericDeliverableType = (typeof GENERIC_DELIVERABLE_TYPES)[number];
export type DeliverableType = SpecificDeliverableType | GenericDeliverableType;

/**
 * How a candidate relates to the deliverables around it.
 *
 * `ambiguous` is the one that matters. It is not an error state and not a
 * degraded `additive` — it is the honest answer for text that does not say,
 * and it produces a question rather than a number.
 */
export const DELIVERABLE_RELATIONSHIPS = ['additive', 'alias', 'explanatory', 'contains', 'ambiguous'] as const;
export type DeliverableRelationship = (typeof DELIVERABLE_RELATIONSHIPS)[number];

interface NounSpec {
  pattern: RegExp;
  type: DeliverableType;
  artefactType: ArtefactType;
  label: string;
  generic: boolean;
}

/**
 * The nouns, and what satisfies each.
 *
 * Order does NOT establish precedence here — overlapping matches are resolved
 * longest-first after the scan, so "architecture recommendation" beats
 * "recommendation" and "test report" beats "report" without depending on which
 * line came first in this table. The old pass depended on table order, which is
 * a rule that holds until somebody appends a row.
 */
const DELIVERABLE_NOUNS: NounSpec[] = [
  // --- Specific: the requester named a kind ---------------------------------
  {
    pattern: /\barchitecture (?:recommendations?|notes?|proposals?|designs?)\b/i,
    type: 'architecture_note',
    artefactType: 'architecture_note',
    label: 'architecture note',
    generic: false,
  },
  {
    pattern: /\b(?:engineering |technical )?briefs?\b/i,
    type: 'engineering_brief',
    artefactType: 'engineering_brief',
    label: 'engineering brief',
    generic: false,
  },
  {
    pattern: /\btest reports?\b/i,
    type: 'test_report',
    artefactType: 'investigation_report',
    label: 'test report',
    generic: false,
  },
  {
    pattern: /\b(?:investigation|research|findings) reports?\b/i,
    type: 'investigation_report',
    artefactType: 'investigation_report',
    label: 'investigation report',
    generic: false,
  },
  {
    pattern: /\b(?:executive |management )?summar(?:y|ies)(?: (?:documents?|reports?|notes?))?\b/i,
    type: 'summary_document',
    artefactType: 'markdown_document',
    label: 'summary document',
    generic: false,
  },
  {
    pattern: /\brecommendations?\b/i,
    type: 'recommendation',
    artefactType: 'recommendation',
    label: 'recommendation',
    generic: false,
  },
  {
    pattern: /\b(?:task |work )?proposals?\b/i,
    type: 'task_proposal',
    artefactType: 'task_proposal',
    label: 'task proposal',
    generic: false,
  },
  {
    pattern: /\bdrawings?\b/i,
    type: 'drawing',
    artefactType: 'diagram_description',
    label: 'drawing',
    generic: false,
  },
  {
    pattern: /\bdiagrams?\b/i,
    type: 'diagram',
    artefactType: 'diagram_description',
    label: 'diagram',
    generic: false,
  },
  {
    pattern: /\b(?:procedures?|work instructions?|method statements?)\b/i,
    type: 'procedure',
    artefactType: 'markdown_document',
    label: 'procedure',
    generic: false,
  },
  {
    pattern: /\b(?:spreadsheets?|tables?|datasets?|structured data)\b/i,
    type: 'structured_data',
    artefactType: 'structured_data',
    label: 'structured data',
    generic: false,
  },

  // --- Generic: a container noun, naming no kind ----------------------------
  { pattern: /\bdocuments?\b/i, type: 'document', artefactType: 'markdown_document', label: 'document', generic: true },
  {
    pattern: /\bdocumentation\b/i,
    type: 'documentation',
    artefactType: 'markdown_document',
    label: 'documentation',
    generic: true,
  },
  { pattern: /\bfiles?\b/i, type: 'file', artefactType: 'markdown_document', label: 'file', generic: true },
  {
    pattern: /\bart[ei]facts?\b/i,
    type: 'artefact',
    artefactType: 'markdown_document',
    label: 'artefact',
    generic: true,
  },
  { pattern: /\boutputs?\b/i, type: 'output', artefactType: 'markdown_document', label: 'output', generic: true },
  { pattern: /\breports?\b/i, type: 'report', artefactType: 'investigation_report', label: 'report', generic: true },
  { pattern: /\bnotes?\b/i, type: 'note', artefactType: 'markdown_document', label: 'note', generic: true },
  {
    pattern: /\bwrite[- ]?ups?\b/i,
    type: 'write_up',
    artefactType: 'markdown_document',
    label: 'write-up',
    generic: true,
  },
];

// ---------------------------------------------------------------------------
// Words the lead-in is read with
// ---------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** Adjectives that sit between a count and its noun: "three SEPARATE briefs". */
const QUALIFIER_WORDS = new Set([
  'separate', 'distinct', 'individual', 'short', 'brief', 'detailed', 'engineering', 'technical',
  'required', 'additional', 'further', 'other', 'final', 'draft', 'written', 'concise', 'full',
  'complete', 'summary', 'cover', 'covering', 'standalone', 'extra', 'new', 'single', 'one-page',
  'formal', 'informal', 'internal', 'external', 'client', 'per',
]);

/**
 * Words that point BACKWARDS at something already named.
 *
 * "those documents", "the two documents", "the same documents" — every one of
 * them is the requester referring to a thing they have already asked for, which
 * is the single most reliable signal available that a mention is not new.
 */
const BACK_REFERENCE_WORDS = new Set([
  'the', 'those', 'these', 'this', 'that', 'said', 'aforementioned', 'above', 'same', 'both',
  // "Each document contains a 'Purpose' section" distributes over a set the
  // brief has already introduced. It announces nothing new, which is what
  // every other word here has in common.
  'each',
]);

/** Words that introduce a noun phrase. Used to tell a noun from a verb. */
const DETERMINERS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'each', 'every', 'both', 'some', 'another',
  'its', 'their', 'our', 'your', 'his', 'her', 'said', 'one', 'single',
]);

/** Where a determiner's reach over its noun phrase stops. */
const CONJUNCTIONS = new Set(['and', 'or', 'but', 'then', 'plus', 'nor', 'so', 'while', 'before', 'after']);

/**
 * Qualifiers that mean "the ones I just listed, counted out".
 *
 * "two engineering briefs and two DISTINCT documents" is the failing case, and
 * `distinct` is doing the referring: it distinguishes the two documents FROM
 * EACH OTHER, not from the briefs. On its own it decides nothing — it only
 * resolves a mention when the count also matches what was already required.
 */
const ENUMERATING_QUALIFIERS = new Set(['distinct', 'separate', 'individual', 'said', 'above', 'same']);

/**
 * Words that mark a container noun as something Mac must READ, not WRITE.
 *
 * "Research external vendor documentation where useful" names a source. Reading
 * it as a deliverable would demand an artefact nobody asked for, and — once
 * container nouns are recognised at all, which is new here — would raise a
 * clarifying question about a phrase that was never ambiguous.
 */
const SOURCE_QUALIFIERS = new Set([
  'vendor', 'vendors', 'external', 'third', 'party', 'third-party', 'supplier', 'suppliers',
  'manufacturer', 'manufacturers', 'official', 'oem', 'upstream', 'public', 'online', 'published',
  'product', 'api', 'reference', 'source', 'existing', 'their', 'its', 'legacy', 'incoming',
]);

/**
 * Words that refuse the thing they precede.
 *
 * Shared with the research-cue layer, which learned this the expensive way as
 * commissioning defect 8: a brief saying "no external research of any kind"
 * derived a criterion demanding external research, because the cue matched
 * inside its own negation.
 *
 * The same trap sits under deliverables, and defect 9's own re-derivation walked
 * into it: "Two distinct documents, **not one consolidated report**" produced a
 * candidate `report`, and a phrase saying what NOT to deliver became a phrase
 * asking for a delivery.
 */
export const NEGATORS = ['no', 'not', 'never', 'without', 'avoid', 'exclude', 'excluding', 'skip', 'neither', 'nor'];

/**
 * Whether a deliverable noun is being refused where it appears.
 *
 * THREE words, where the research-cue check looks back six, and the difference
 * is deliberate. A cue can be negated at a distance — "this must be done
 * without any external research" — and suppressing one wrongly costs an
 * unnecessary criterion. A DELIVERABLE negation is attached directly to its
 * noun: "not one consolidated report", "no separate document". Suppressing a
 * deliverable wrongly costs a requirement dropped from the contract, which is
 * the original Part F failure — five requested documents becoming one — so this
 * window is the narrow one.
 */
function negatedDeliverable(text: string, index: number): boolean {
  const preceding = text.slice(Math.max(0, index - 30), index).toLowerCase();
  const tail = preceding.split(/[^a-z']+/).filter(Boolean).slice(-3);
  return tail.some((word) => NEGATORS.includes(word));
}

/**
 * The refusal idiom that sits AFTER the noun it refuses.
 *
 * `negatedDeliverable` reads backwards, and commissioning defect 10 was the
 * half of English it therefore could not see. The database wording for the
 * brief behind defect 9 does not say "not one consolidated report" — the
 * report quoted a paraphrase. It says:
 *
 *   "A single combined document covering both is explicitly NOT what is wanted."
 *
 * Same refusal, opposite side of the noun, and the sentence declining a
 * combined document required one.
 *
 * The anchor is deliberately the WANTING word and not the negator. "a report
 * that is not longer than five pages" and "the report is not final until
 * reviewed" both carry `is not` and both genuinely ask for a report; reading a
 * bare trailing negation as a refusal would drop them, and dropping a requested
 * deliverable is the original Part F failure — the worse of the two
 * directions. So this matches the shape that only ever refuses: a copula
 * governing the noun, a negator, and then a word about being asked for.
 * Anything less certain keeps the deliverable.
 */
const REFUSAL_AFTER =
  /^\s*(?:[a-z][a-z'’-]*\s+){0,4}?\b(?:is|are|was|were)\b\s+(?:[a-z][a-z'’-]*\s+){0,3}?\b(?:not|never)\b\s+(?:[a-z][a-z'’-]*\s+){0,3}?\b(?:wanted|required|needed|necessary|expected|acceptable|sought)\b/i;

/**
 * Whether the clause following a deliverable noun refuses it.
 *
 * Bounded by the clause the noun sits in, because a refusal in the NEXT
 * sentence is about something else: "Produce two briefs. External research is
 * not required." asks for two briefs.
 */
function refusedAfterDeliverable(text: string, end: number): boolean {
  const clause = /^[^.;:,\n]*/.exec(text.slice(end, end + 90))?.[0] ?? '';
  return REFUSAL_AFTER.test(clause);
}

const CONSUMING_VERBS = new Set([
  'research', 'researching', 'read', 'reading', 'consult', 'consulting', 'cite', 'citing',
  'search', 'searching', 'retrieve', 'retrieving', 'fetch', 'fetching', 'quote', 'quoting',
  'against', 'from', 'using',
]);

/** Explanatory connectives. Everything after one of these restates what precedes. */
const ALIAS_MARKER = /\b(?:i\.?\s?e\.?|that is|namely|specifically|in other words|in short|or simply|meaning|which is|which are)\b/i;

/** A colon or dash introducing an expansion: "two documents: two engineering briefs". */
const EXPANSION_MARKER = /[:—–]\s*$/;

/** A plain coordination — "and", a comma — carrying no claim about identity. */
const COORDINATION_ONLY = /^[\s,;]*(?:and|plus|as well as|,)?[\s,;]*$/i;

/**
 * Clauses whose contents belong to the deliverable that precedes them.
 *
 * "one report containing a summary and a build order" asks for ONE report. The
 * summary is a section of it. Turning contents into documents is how a single
 * requested report becomes three required files.
 *
 * `with` is deliberately absent: "a recommendation with a rough cost for each"
 * is the real commissioning wording, and `with` attaches far too much that is
 * not containment to be safe as a marker.
 */
const CONTENTS_MARKER =
  /\b(?:containing|comprising|consisting of|made up of|that includes?|which includes?|including|covering|with sections?|broken into|split into|organised into|organized into)\b/gi;

// ---------------------------------------------------------------------------
// Stage 1 — extraction
// ---------------------------------------------------------------------------

export interface DeliverableCandidate {
  /** The kind the requester named, or null when only a container noun was used. */
  specificType: SpecificDeliverableType | null;
  /** The container noun used, when one was. */
  genericType: GenericDeliverableType | null;
  type: DeliverableType;
  artefactType: ArtefactType;
  label: string;
  count: number;
  /** True when a number or article actually appeared. A bare plural is not a count. */
  countExplicit: boolean;
  /** Words between the count and the noun, kept for provenance and for telling two mentions apart. */
  qualifiers: string[];
  /** A few words after the noun, for the same reason. */
  trailing: string;
  backReference: boolean;
  /** The requester's own words, verbatim. */
  phrase: string;
  span: { start: number; end: number };
  sentence: number;
  /** True when this sits inside a "containing …" clause belonging to another deliverable. */
  insideContents: boolean;
}

const words = (text: string): Array<{ word: string; index: number }> => {
  const out: Array<{ word: string; index: number }> = [];
  const scan = /[A-Za-z0-9][A-Za-z0-9'’-]*/g;
  let match: RegExpExecArray | null;
  while ((match = scan.exec(text)) !== null) out.push({ word: match[0]!.toLowerCase(), index: match.index });
  return out;
};

interface Lead {
  count: number;
  explicit: boolean;
  /** A determiner actually governs the noun. Independent of the count scan. */
  hasDeterminer: boolean;
  qualifiers: string[];
  backReference: boolean;
  /** Offset within `preceding` where the lead-in begins, for the verbatim phrase. */
  offset: number;
  /** True when the noun is being named as a source to read rather than a thing to write. */
  isSource: boolean;
}

/**
 * Reads the words immediately before a noun.
 *
 * The count is looked for right-to-left and stops at the first word that is
 * neither a number nor a qualifier, so "three systems, and a recommendation"
 * reads ONE recommendation rather than three — the miss that turned five
 * requested documents into one, and which must not come back.
 */
function readLead(preceding: string): Lead {
  const tail = words(preceding).slice(-4);
  let count = 1;
  let explicit = false;
  let offset = preceding.length;
  const qualifiers: string[] = [];

  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const entry = tail[i]!;
    const word = entry.word.replace(/[^a-z0-9]/g, '');
    if (!word) continue;

    if (/^\d+$/.test(word)) {
      const value = Number(word);
      if (value >= 1 && value <= 20) {
        count = value;
        explicit = true;
        offset = entry.index;
      }
      break;
    }
    if (word in NUMBER_WORDS) {
      count = NUMBER_WORDS[word]!;
      explicit = true;
      offset = entry.index;
      break;
    }
    if (QUALIFIER_WORDS.has(word)) {
      qualifiers.unshift(word);
      offset = entry.index;
      continue;
    }
    break;
  }

  /*
   * Whether a determiner actually governs this noun.
   *
   * Deliberately NOT `explicit`, which is set by the count scan and is false
   * whenever an adjective the qualifier list has never heard of sits in the
   * way — "a **scoping** document" went missing that way, and widening the
   * qualifier list to fix it would be the phrase-by-phrase accumulation this
   * whole module exists to avoid.
   *
   * A determiner governs its noun phrase until a conjunction breaks it, so
   * "Produce **a** brief **and** note the risks" does not hand "a" to "note".
   */
  const determinerIndex = [...tail]
    .reverse()
    .slice(0, 3)
    .findIndex((entry) => DETERMINERS.has(entry.word) || entry.word in NUMBER_WORDS || /^\d+$/.test(entry.word));
  const wordsAfterDeterminer = determinerIndex === -1 ? [] : tail.slice(tail.length - determinerIndex);
  const hasDeterminer =
    determinerIndex !== -1 && !wordsAfterDeterminer.some((entry) => CONJUNCTIONS.has(entry.word));

  const backReference = tail.some((entry) => BACK_REFERENCE_WORDS.has(entry.word));
  if (backReference && !explicit) {
    const first = tail.find((entry) => BACK_REFERENCE_WORDS.has(entry.word));
    if (first) offset = Math.min(offset, first.index);
  }

  const lastThree = tail.slice(-3).map((entry) => entry.word);
  const lastFour = tail.map((entry) => entry.word);
  const isSource =
    lastThree.some((word) => SOURCE_QUALIFIERS.has(word)) || lastFour.some((word) => CONSUMING_VERBS.has(word));

  return { count, explicit, hasDeterminer, qualifiers, backReference, offset, isSource };
}

/**
 * Sentence index for every character position.
 *
 * `i.e.` and `e.g.` are masked first. They end in a full stop and they are the
 * commonest alias marker in a specification, so treating their punctuation as a
 * sentence boundary would put the alias and the thing it explains in different
 * sentences — and every same-sentence rule below would stop seeing them.
 */
function sentenceIndexer(text: string): (position: number) => number {
  const masked = text
    .replace(/\bi\.\s?e\./gi, (m) => 'i_e_'.slice(0, m.length).padEnd(m.length, '_'))
    .replace(/\be\.\s?g\./gi, (m) => 'e_g_'.slice(0, m.length).padEnd(m.length, '_'))
    .replace(/\betc\./gi, (m) => 'etc_'.slice(0, m.length).padEnd(m.length, '_'));

  const boundaries: number[] = [];
  for (let i = 0; i < masked.length; i += 1) {
    if (/[.!?\n]/.test(masked[i]!)) boundaries.push(i);
  }
  return (position: number) => boundaries.filter((b) => b < position).length;
}

/**
 * Finds every candidate mention, positionally, deciding nothing about identity.
 */
export function extractDeliverableCandidates(text: string): DeliverableCandidate[] {
  const body = text ?? '';
  if (!body.trim()) return [];

  const sentenceOf = sentenceIndexer(body);

  // Every match from every noun, then overlaps resolved longest-first, so the
  // table's row order carries no meaning.
  interface RawMatch {
    spec: NounSpec;
    start: number;
    end: number;
    matched: string;
  }
  const raw: RawMatch[] = [];
  for (const spec of DELIVERABLE_NOUNS) {
    const scan = new RegExp(spec.pattern.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = scan.exec(body)) !== null) {
      raw.push({ spec, start: match.index, end: match.index + match[0]!.length, matched: match[0]! });
      if (match.index === scan.lastIndex) scan.lastIndex += 1;
    }
  }

  raw.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const chosen: RawMatch[] = [];
  for (const candidate of raw) {
    const overlaps = chosen.some((kept) => candidate.start < kept.end && kept.start < candidate.end);
    if (overlaps) continue;
    // A longer match starting later can still contain this one: "summary" then
    // "summary document". Prefer the longer of any pair that overlaps at all.
    const longerLater = raw.find(
      (other) =>
        other !== candidate &&
        other.start < candidate.end &&
        candidate.start < other.end &&
        other.end - other.start > candidate.end - candidate.start,
    );
    if (longerLater) continue;
    chosen.push(candidate);
  }
  chosen.sort((a, b) => a.start - b.start);

  // Contents clauses: everything from the marker to the end of its sentence
  // belongs to the deliverable named before the marker.
  const contentsRegions: Array<{ start: number; sentence: number }> = [];
  const contentsScan = new RegExp(CONTENTS_MARKER.source, 'gi');
  let marker: RegExpExecArray | null;
  while ((marker = contentsScan.exec(body)) !== null) {
    contentsRegions.push({ start: marker.index, sentence: sentenceOf(marker.index) });
  }

  const candidates: DeliverableCandidate[] = [];
  for (const match of chosen) {
    const preceding = body.slice(Math.max(0, match.start - 48), match.start);
    const lead = readLead(preceding);

    /*
     * A container noun inside a proper name is not a deliverable.
     *
     * "the PAC Project Document Controller" contains the word "Document", and
     * before this check the derivation quietly required a `markdown_document`
     * artefact because a SYSTEM had that word in its name. Two capitals in a row
     * on one line is what distinguishes a name from a sentence.
     */
    const after = body.slice(match.end, match.end + 24);
    const nextWord = /^([^A-Za-z0-9]{0,3})([A-Za-z][A-Za-z'’-]*)/.exec(after);
    const gap = nextWord?.[1] ?? '';
    const sentenceInitial = /(?:^|[.!?;:\n])\s*$/.test(body.slice(Math.max(0, match.start - 4), match.start));
    const partOfName =
      /^[A-Z]/.test(match.matched) &&
      !sentenceInitial &&
      !!nextWord &&
      /^[A-Z]/.test(nextWord[2]!) &&
      // Same line, and no sentence ended between them: "Briefs. Deliver …" is
      // two sentences, "Document Controller" is one name.
      !/[.\n;!?]/.test(gap);
    if (partOfName) continue;

    // A source to read is not a deliverable to write. Containers only: nobody
    // writes "research the external engineering brief" meaning a source.
    if (match.spec.generic && lead.isSource) continue;

    // A deliverable being refused is not a deliverable being asked for,
    // whichever side of the noun the refusal was written on.
    if (negatedDeliverable(body, match.start)) continue;
    if (refusedAfterDeliverable(body, match.end)) continue;

    /*
     * A container noun being used as a VERB is not a deliverable either.
     *
     * "Investigate and **report** back", "**Write up** your findings as a
     * recommendation", "**file** the drawings" — six of the eight container
     * nouns are also everyday verbs, and reading them as outputs invents a
     * requirement a correct run will be marked short for. That is defect 9's
     * own failure direction, so it is worth a rule rather than a shrug.
     *
     * The rule is grammatical: an English noun phrase needs a determiner or a
     * count in the singular. "a report" is a thing, bare "report" is an
     * instruction. Plurals need no determiner — "briefs and documents" is a
     * noun phrase — so only the singular is filtered, and the two containers
     * that are not verbs in any tense are exempt.
     */
    const bareSingularVerb =
      match.spec.generic &&
      VERB_CONTAINERS.has(match.spec.type) &&
      !/s$/i.test(match.matched) &&
      !lead.hasDeterminer &&
      !lead.backReference;
    if (bareSingularVerb) continue;

    const trailingRaw = body.slice(match.end, match.end + 40);
    const trailing = (/^[^.;:,\n]*/.exec(trailingRaw)?.[0] ?? '')
      .split(/\b(?:and|or)\b/i)[0]!
      .trim()
      .toLowerCase();

    const sentence = sentenceOf(match.start);
    const insideContents = contentsRegions.some(
      (region) => region.start < match.start && region.sentence === sentence,
    );

    const phraseStart = Math.max(0, match.start - (preceding.length - lead.offset));

    candidates.push({
      specificType: match.spec.generic ? null : (match.spec.type as SpecificDeliverableType),
      genericType: match.spec.generic ? (match.spec.type as GenericDeliverableType) : null,
      type: match.spec.type,
      artefactType: match.spec.artefactType,
      label: match.spec.label,
      count: lead.count,
      countExplicit: lead.explicit,
      qualifiers: lead.qualifiers,
      trailing,
      backReference: lead.backReference,
      phrase: body.slice(phraseStart, match.end).trim(),
      span: { start: phraseStart, end: match.end },
      sentence,
      insideContents,
    });
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Stage 2 — normalisation
// ---------------------------------------------------------------------------

export interface NormalisedDeliverable {
  type: DeliverableType;
  artefactType: ArtefactType;
  label: string;
  count: number;
  /** Always `additive` — these are the mentions that create a requirement. */
  relationship: Extract<DeliverableRelationship, 'additive'>;
  confidence: number;
  /** Every phrase that contributed, verbatim, with where it was. */
  sources: Array<{ phrase: string; span: { start: number; end: number } }>;
  /** One sentence a human can disagree with. */
  provenance: string;
}

export interface DeliverableResolution {
  phrase: string;
  span: { start: number; end: number };
  relationship: Exclude<DeliverableRelationship, 'additive'>;
  /** The deliverable type this was folded into, when it was folded into one. */
  resolvedTo: DeliverableType | null;
  confidence: number;
  reason: string;
}

export interface DeliverableAmbiguity {
  phrase: string;
  span: { start: number; end: number };
  /** The readings that could not be told apart. */
  readings: string[];
  question: string;
}

export interface DeliverableAnalysis {
  /** What the text requires. Only `additive` mentions reach this list. */
  deliverables: NormalisedDeliverable[];
  /** Every mention that did NOT create a requirement, and why. */
  resolutions: DeliverableResolution[];
  /** Mentions nothing here may decide. These derive no criterion at all. */
  ambiguities: DeliverableAmbiguity[];
  /** Section names lifted out of "containing …" clauses. */
  sections: string[];
}

const titleCase = (text: string): string => {
  const singular = /s$/i.test(text) && !/ss$/i.test(text) && text.length > 3 ? text.slice(0, -1) : text;
  return singular.charAt(0).toUpperCase() + singular.slice(1).toLowerCase();
};

/**
 * Nouns with no plural and no article. "a documentation" is not English, and
 * these sentences are read by a person deciding whether Mac understood them.
 */
const MASS_NOUNS = new Set(['documentation', 'structured data']);

const plural = (label: string, count: number): string =>
  count === 1 || MASS_NOUNS.has(label) ? label : `${label}s`;

const aOrAn = (noun: string): string =>
  MASS_NOUNS.has(noun) ? noun : /^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`;

const describeCount = (count: number, label: string): string =>
  count === 1 ? aOrAn(label) : `${count} ${plural(label, count)}`;

/** What distinguishes one mention of a type from another mention of the same type. */
const modifierSignature = (candidate: DeliverableCandidate): string =>
  [...candidate.qualifiers.filter((q) => !ENUMERATING_QUALIFIERS.has(q)), candidate.trailing]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * How many artefacts a set of mentions of ONE type requires.
 *
 * MAX across sentences, SUM within one — the brief's fields restate the same
 * request three or four times, so summing across them would multiply every
 * count by the number of fields that mention it, while inside a single sentence
 * "a document for the client and a document for the internal team" really is
 * two, and what says so is that the two mentions carry different modifiers.
 *
 * Shared, because commissioning defect 10 found the forward pass measuring
 * "how many were already asked for" a second, narrower way — the sum over the
 * nearest sentence holding a specific. For brief 7599b3fb that sentence was
 * "Each brief needs a section 'Purpose'", giving one, so a closing
 * "Two distinct documents are created" matched nothing and became two more
 * required artefacts. Two definitions of the same quantity is how that happens.
 */
const aggregateCount = (mentions: readonly DeliverableCandidate[]): number => {
  const bySentence = new Map<number, DeliverableCandidate[]>();
  for (const mention of mentions) {
    const list = bySentence.get(mention.sentence) ?? [];
    list.push(mention);
    bySentence.set(mention.sentence, list);
  }

  let count = 0;
  for (const list of bySentence.values()) {
    const signatures = list.map(modifierSignature);
    const allDistinct =
      list.length > 1 &&
      signatures.every((signature) => signature.length > 0) &&
      new Set(signatures).size === signatures.length;
    const sentenceCount = allDistinct
      ? list.reduce((total, mention) => total + mention.count, 0)
      : Math.max(...list.map((mention) => mention.count));
    count = Math.max(count, sentenceCount);
  }
  return count;
};

/**
 * Decides what each candidate means, and returns only what actually creates a
 * requirement.
 */
export function normaliseDeliverables(text: string, candidates: DeliverableCandidate[]): DeliverableAnalysis {
  const body = text ?? '';
  const resolutions: DeliverableResolution[] = [];
  const ambiguities: DeliverableAmbiguity[] = [];
  const sections: string[] = [];

  // --- Contents clauses ----------------------------------------------------

  const free: DeliverableCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.insideContents) {
      free.push(candidate);
      continue;
    }
    // The section is named from the deliverable's TYPE, not from the words that
    // matched: "a summary" and "an executive summary document" are both a
    // Summary heading, and a heading called "Executive summary document" would
    // match nothing a writer would ever write.
    const name = titleCase(candidate.label === 'summary document' ? 'summary' : candidate.label);
    if (!sections.includes(name)) sections.push(name);
    resolutions.push({
      phrase: candidate.phrase,
      span: candidate.span,
      relationship: 'contains',
      resolvedTo: null,
      confidence: 0.9,
      reason:
        `"${candidate.phrase}" appears inside a clause describing what another deliverable contains, ` +
        `so it is required as a section named "${name}" rather than as a separate artefact.`,
    });
  }

  // --- Forward pass: a generic noun after a specific one -------------------

  const kept: DeliverableCandidate[] = [];
  const retracted = new Set<DeliverableCandidate>();

  for (const candidate of free) {
    if (candidate.specificType) {
      kept.push(candidate);
      continue;
    }

    const priorSpecifics = kept.filter((k) => k.specificType && !retracted.has(k));
    if (priorSpecifics.length === 0) {
      // Nothing to refer back to. A generic noun on its own is a real request
      // for a document and this must never talk it down to nothing.
      kept.push(candidate);
      continue;
    }

    const previous = kept[kept.length - 1]!;
    const between = body.slice(previous.span.end, candidate.span.start);
    const nearest = priorSpecifics[priorSpecifics.length - 1]!;

    /*
     * What "the same number as what was already asked for" counts over.
     *
     * The same sentence first, because that is where a restatement usually
     * sits. But a brief is a LIST — its acceptance criteria are separate lines,
     * and the real production wording put them on two:
     *
     *   Two separate engineering briefs, one per system.
     *   Two distinct documents, not one consolidated report.
     *
     * Requiring the same sentence made that pair undecidable and asked a human
     * a question about a brief nobody would call unclear. So when the sentence
     * holds no specific deliverable, the count is taken from the nearest
     * preceding sentence that does.
     */
    const sameSentence = priorSpecifics.filter((s) => s.sentence === candidate.sentence);
    const scope = sameSentence.length > 0
      ? sameSentence
      : priorSpecifics.filter((s) => s.sentence === nearest.sentence);
    const priorTotal = scope.reduce((total, s) => total + s.count, 0);
    /*
     * And the same quantity aggregation will actually derive for that type.
     * `priorTotal` is a local reading — the sentence nearest the mention — and
     * defect 10 showed it going out of step with the contract whenever the
     * sentence that established a count was not the sentence that last touched
     * the type. Either reading matching is evidence of a restatement.
     */
    const establishedTotal = aggregateCount(priorSpecifics.filter((s) => s.type === nearest.type));
    const matchesPrior = candidate.count === priorTotal || candidate.count === establishedTotal;
    const nearestDescription = describeCount(nearest.count, nearest.label);

    // The marker itself, not the whole gap, so the reason a human reads says
    // `follows "i.e."` rather than `follows ", i.e. "`.
    const marker = ALIAS_MARKER.exec(between)?.[0]?.trim();
    const aliasMarker = Boolean(marker) || EXPANSION_MARKER.test(between);
    const enumerating = candidate.qualifiers.some((q) => ENUMERATING_QUALIFIERS.has(q));

    if (aliasMarker) {
      retracted.add(candidate);
      resolutions.push({
        phrase: candidate.phrase,
        span: candidate.span,
        relationship: 'alias',
        resolvedTo: nearest.type,
        confidence: 0.95,
        reason:
          `"${candidate.phrase}" follows ${marker ? `"${marker}"` : 'a colon'}, which introduces an ` +
          `explanation rather than an addition, so it names ${nearestDescription} already required.`,
      });
      continue;
    }

    if (candidate.backReference && !candidate.countExplicit) {
      retracted.add(candidate);
      resolutions.push({
        phrase: candidate.phrase,
        span: candidate.span,
        relationship: 'alias',
        resolvedTo: nearest.type,
        confidence: 0.9,
        reason:
          `"${candidate.phrase}" refers back with a definite article and names no new kind, so it is ` +
          `${nearestDescription} already required.`,
      });
      continue;
    }

    if ((candidate.backReference || enumerating) && candidate.countExplicit && matchesPrior) {
      retracted.add(candidate);
      resolutions.push({
        phrase: candidate.phrase,
        span: candidate.span,
        relationship: 'explanatory',
        resolvedTo: nearest.type,
        confidence: 0.85,
        reason:
          `"${candidate.phrase}" counts out the same ${priorTotal} already required as ` +
          `${plural(nearest.label, priorTotal)}, and adds no kind of its own, so it restates them.`,
      });
      continue;
    }

    /*
     * ---------------------------------------------------------------------
     * WHAT IS ACTUALLY UNDECIDABLE, AND WHAT ONLY LOOKS IT
     *
     * The first cut of this rule called a generic noun ambiguous whenever a
     * specific deliverable preceded it and nothing pointed backwards. Probed
     * against ordinary phrasings, that asked a human a question about SEVEN of
     * TEN briefs — including "a recommendation and a report on the trial" and
     * "two engineering briefs and three documents", where the counts plainly
     * differ and no English speaker would hesitate.
     *
     * That is the false gap again, moved one step earlier into discovery, and
     * it is just as corrosive there: a system that asks about everything is one
     * whose questions stop being read.
     *
     * The principle that replaced it is how English introduces things. A
     * container noun carrying ITS OWN count or article is a new deliverable —
     * "and a document" announces a document. It is a restatement only when
     * something points backwards, which the three branches above have already
     * tested for: an alias marker, a definite determiner, or an enumerating
     * qualifier over a matching count.
     *
     * So exactly two shapes remain genuinely undecidable:
     *
     *   1. A REPEATED COUNT ABOVE ONE with nothing to resolve it — "two
     *      engineering briefs and two documents". The repetition is itself the
     *      suspicious signal. Two singulars repeating "one" is not: "a brief
     *      and a note" is two things.
     *
     *   2. A BARE CONTAINER — no article, no count, nothing introducing it as
     *      new and nothing pointing back. "two briefs and documentation".
     * ---------------------------------------------------------------------
     */
    const repeatedCount = candidate.countExplicit && candidate.count > 1 && matchesPrior;
    const bareContainer = !candidate.countExplicit && !modifierSignature(candidate);

    if (!repeatedCount && !bareContainer) {
      kept.push(candidate);
      continue;
    }

    retracted.add(candidate);
    ambiguities.push({
      phrase: candidate.phrase,
      span: candidate.span,
      readings: [
        `${nearestDescription} already required`,
        `${describeCount(candidate.count, candidate.label)} in addition`,
      ],
      question:
        `The brief asks for ${describeCount(nearest.count, nearest.label)} and then says "${candidate.phrase}". ` +
        `Is that the same ${describeCount(nearest.count, nearest.label)}, or ` +
        `${describeCount(candidate.count, candidate.label)} in addition? ` +
        'Acceptance criteria are frozen when the brief is approved, so this needs an answer first.',
    });
  }

  // --- Backward pass: a generic noun BEFORE the specific one it named ------

  for (const specific of kept.filter((k) => k.specificType && !retracted.has(k))) {
    const before = kept.filter(
      (k) => !k.specificType && !retracted.has(k) && k.span.end <= specific.span.start,
    );
    const generic = before[before.length - 1];
    if (!generic) continue;
    // Only when nothing specific sits between them: otherwise the generic has
    // already been accounted for against that one.
    const interposed = kept.some(
      (k) => k.specificType && k.span.start >= generic.span.end && k.span.end <= specific.span.start,
    );
    if (interposed) continue;

    const between = body.slice(generic.span.end, specific.span.start);
    const countsAgree = !generic.countExplicit || !specific.countExplicit || generic.count === specific.count;

    if ((ALIAS_MARKER.test(between) || EXPANSION_MARKER.test(between)) && countsAgree) {
      retracted.add(generic);
      resolutions.push({
        phrase: generic.phrase,
        span: generic.span,
        relationship: 'alias',
        resolvedTo: specific.type,
        confidence: 0.9,
        reason:
          `"${generic.phrase}" is expanded by what follows it, so it names ` +
          `${describeCount(specific.count, specific.label)} rather than requiring anything of its own.`,
      });
      continue;
    }

    /*
     * The same "a repeated count above one" test the forward pass makes, and
     * for the same reason. Two singulars both carrying the count 1 is a
     * coincidence, not evidence: "a short write-up and a diagram" is two
     * deliverables, and the first cut of this pass called it undecidable.
     */
    if (
      generic.sentence === specific.sentence &&
      generic.countExplicit &&
      specific.countExplicit &&
      generic.count === specific.count &&
      generic.count > 1 &&
      COORDINATION_ONLY.test(between)
    ) {
      retracted.add(generic);
      ambiguities.push({
        phrase: generic.phrase,
        span: generic.span,
        readings: [
          `${describeCount(specific.count, specific.label)} named twice`,
          `${describeCount(generic.count, generic.label)} in addition to them`,
        ],
        question:
          `The brief says "${generic.phrase}" and "${specific.phrase}" in the same breath. ` +
          `Are those the same ${specific.count} ${plural(specific.label, specific.count)}, or ` +
          `${describeCount(generic.count, generic.label)} as well? ` +
          'Acceptance criteria are frozen when the brief is approved, so this needs an answer first.',
      });
    }
  }

  // --- Backward pass, over EVERY generic: the forward pass's restatement
  //     branches in the direction they were never given ----------------------

  /*
   * Commissioning defect 10, second half.
   *
   * The loop above walks specifics and looks at the ONE generic immediately
   * before each of them. Brief 7599b3fb walks straight past it: its acceptance
   * criteria say "Two separate documents exist, each dedicated to one system"
   * and then twice more "Each document contains ...", so by the time the scope
   * names those documents as engineering briefs, the nearest preceding generic
   * is an "Each document" and the mention that carries the count is three
   * candidates back. Nothing folded, and defect 9's four-artefact false gap
   * came back in full.
   *
   * `contractTextOf` concatenates acceptanceCriteria, proposedScope,
   * userObjective and desiredBehaviour in that fixed order, so which side of a
   * specific a generic falls on is decided by WHICH FIELD a writer happened to
   * put it in and not by anything they meant. The forward pass already resolves
   * this shape; it simply never ran in this direction. So it does now, over
   * every generic rather than one per specific, with the same evidence the
   * forward pass accepts and nothing weaker:
   *
   *   - a generic pointing back and carrying no count of its own restates what
   *     it points at ("Each document contains a 'Purpose' section");
   *   - a generic that points back or enumerates, carrying the SAME count as
   *     the specific beside it, restates that specific ("Two separate
   *     documents" against "TWO separate engineering briefs").
   *
   * A generic whose count differs, or which introduces itself with nothing but
   * its own article, is a real and separate request and still survives here
   * untouched. Dropping a requested deliverable is the Part F failure and the
   * worse of the two directions, so this pass only ever folds on evidence.
   */
  for (const generic of kept.filter((k) => !k.specificType && !retracted.has(k))) {
    const specific = kept.find(
      (k) => k.specificType && !retracted.has(k) && k.span.start >= generic.span.end,
    );
    if (!specific) continue;

    const enumeratingGeneric = generic.qualifiers.some((q) => ENUMERATING_QUALIFIERS.has(q));

    if (generic.backReference && !generic.countExplicit) {
      retracted.add(generic);
      resolutions.push({
        phrase: generic.phrase,
        span: generic.span,
        relationship: 'alias',
        resolvedTo: specific.type,
        confidence: 0.9,
        reason:
          `"${generic.phrase}" points back and names no new kind, so it is ` +
          `${describeCount(specific.count, specific.label)} already required.`,
      });
      continue;
    }

    if (
      (generic.backReference || enumeratingGeneric) &&
      generic.countExplicit &&
      specific.countExplicit &&
      generic.count === specific.count
    ) {
      retracted.add(generic);
      resolutions.push({
        phrase: generic.phrase,
        span: generic.span,
        relationship: 'explanatory',
        resolvedTo: specific.type,
        confidence: 0.85,
        reason:
          `"${generic.phrase}" counts out the same ${specific.count} already required as ` +
          `${plural(specific.label, specific.count)}, and adds no kind of its own, so it restates them.`,
      });
    }
  }

  // --- Aggregation ---------------------------------------------------------

  const surviving = kept.filter((k) => !retracted.has(k));
  const byType = new Map<DeliverableType, DeliverableCandidate[]>();
  for (const candidate of surviving) {
    const list = byType.get(candidate.type) ?? [];
    list.push(candidate);
    byType.set(candidate.type, list);
  }

  const deliverables: NormalisedDeliverable[] = [];
  for (const [type, mentions] of byType) {
    /*
     * MAX across sentences, SUM within one.
     *
     * The text this runs over is a concatenation of the brief's acceptance
     * criteria, scope, objective and desired behaviour, which restate the same
     * request three or four times. Summing across them would multiply every
     * count by the number of fields that mention it.
     *
     * Within a single sentence the opposite holds: "a document for the client
     * and a document for the internal team" is two documents, and the thing
     * that says so is that the two mentions carry different modifiers.
     */
    const count = aggregateCount(mentions);

    const first = mentions[0]!;
    const folded = resolutions.filter((r) => r.resolvedTo === type && r.relationship !== 'contains');

    /*
     * The same phrase, deduplicated by its words rather than by its position.
     *
     * The text this reads is the brief's acceptance criteria, scope, objective
     * and desired behaviour concatenated, and a brief that says "two separate
     * engineering briefs" in three of those fields would otherwise cite itself
     * three times. Three identical quotations is not more provenance.
     */
    const seenPhrases = new Set<string>();
    const quoted: string[] = [];
    for (const mention of mentions) {
      const key = mention.phrase.toLowerCase().replace(/\s+/g, ' ').trim();
      if (seenPhrases.has(key)) continue;
      seenPhrases.add(key);
      quoted.push(`"${mention.phrase}"`);
    }

    deliverables.push({
      type,
      artefactType: first.artefactType,
      label: first.label,
      count,
      relationship: 'additive',
      confidence: folded.length ? Math.min(...folded.map((r) => r.confidence)) : 1,
      sources: mentions.map((mention) => ({ phrase: mention.phrase, span: mention.span })),
      provenance: [`From ${quoted.join(', ')}.`, ...folded.map((r) => r.reason)].join(' '),
    });
  }

  return { deliverables, resolutions, ambiguities, sections };
}

/** Extraction then normalisation, which is the only way callers should use either. */
export function analyseDeliverables(text: string): DeliverableAnalysis {
  return normaliseDeliverables(text ?? '', extractDeliverableCandidates(text ?? ''));
}

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

export interface DeliverableMention {
  type: DeliverableType;
  artefactType: ArtefactType;
  count: number;
  label: string;
  /** The words that produced it, so a human can disagree with something real. */
  phrase: string;
}

/**
 * The deliverables a text requires, normalised.
 *
 * Ambiguous mentions are absent by design: this answers "what does the text
 * require", and an ambiguous mention does not require anything until somebody
 * says which reading was meant. Callers that need to know an ambiguity exists
 * ask `analyseDeliverables` for it.
 */
export function detectDeliverables(text: string): DeliverableMention[] {
  return analyseDeliverables(text).deliverables.map((deliverable) => ({
    type: deliverable.type,
    artefactType: deliverable.artefactType,
    count: deliverable.count,
    label: deliverable.label,
    phrase: deliverable.sources[0]?.phrase ?? '',
  }));
}
