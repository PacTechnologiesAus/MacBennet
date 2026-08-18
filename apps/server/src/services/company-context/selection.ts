import type { CompanyContextSection, CompanyContextSelection } from '@mac/protocol';
import { companySectionRef } from '@mac/protocol';
import type { CompanyContextRevisionRow } from '../../db/schema.js';
import { AppError } from '../../http/errors.js';
import { parseSections } from '../../domain/company-context.js';
import { keywords } from '../../domain/supervision.js';
import { documentsForRevision, toContextRef } from './service.js';

/**
 * Choosing which company context to put in front of Mac (Sprint 3.2 §15).
 *
 * ---------------------------------------------------------------------------
 * THE ONE PROPERTY THAT MATTERS
 *
 * **Hard authority content cannot be selected away.**
 *
 * Everything else here is an optimisation. This is not. A selection layer that
 * scored `AUTHORITY.md` against a task description would, on a task about CSS,
 * legitimately conclude that PAC's rules on live deployment are irrelevant — and
 * would be wrong in exactly the situation where being wrong is worst, because
 * the run that wanders towards a prohibited action is precisely the one whose
 * brief did not mention it.
 *
 * So the core block takes NO query input. It is a pure function of the loaded
 * document set, `AUTHORITY.md` is included whole, and `selectCompanyContext`
 * throws rather than returning a selection without it.
 * ---------------------------------------------------------------------------
 */

/**
 * The always-required core.
 *
 * `AUTHORITY.md` entire: it is about 4.7 KB, roughly 1,200 tokens, and the cost
 * of carrying all of it is far below the cost of a heuristic that drops the one
 * clause that mattered.
 */
export const CORE_SELECTORS: ReadonlyArray<{ document: string; sections: '*' | readonly string[] }> = [
  { document: 'AUTHORITY.md', sections: '*' },
  { document: 'AGENTS.md', sections: ['Mac — Automation Engineer', 'Shared Agent Context', 'Operating Model'] },
  { document: 'COMPANY.md', sections: ['Who We Are', 'Direction'] },
];

/** The document without which a selection is not a selection. */
export const REQUIRED_CORE_DOCUMENT = 'AUTHORITY.md';

/**
 * How much a section's home document is worth.
 *
 * The operating model and the systems map decide things; the glossary
 * corroborates. A definition of "FAT" matching a query about factory acceptance
 * testing is genuinely useful and genuinely less useful than the operating
 * model's FAT stage, and scoring them equally would let definitions crowd out
 * policy.
 */
const DOCUMENT_WEIGHT: Record<string, number> = {
  'OPERATING_MODEL.md': 1.0,
  'SYSTEMS.md': 1.0,
  'AGENTS.md': 0.9,
  'VALUES.md': 0.9,
  'COMPANY.md': 0.8,
  'GLOSSARY.md': 0.6,
};
const DEFAULT_DOCUMENT_WEIGHT = 0.7;

/** Below this a section is noise: one incidental word in common. */
export const MIN_SECTION_SCORE = 0.15;

/**
 * Generous on purpose (Sprint 3.2 §14): correctness and provenance matter more
 * than premature token optimisation. The core is not counted against it.
 */
export const TASK_CONTEXT_CHAR_BUDGET = 12_000;

export interface SelectionQuery {
  /** Free text describing the work. Brief fields, or an agent's question. */
  text: string;
  /** Overrides the default budget; the core is never subject to it. */
  budget?: number;
}

/**
 * Builds the context block for one piece of work.
 *
 * Throws when the revision is not valid, rather than returning a thinner
 * selection: Sprint 3.2 §21 requires that content is treated as trusted company
 * policy only after validation, and "some of the policy" is not a safe
 * degradation of "the policy".
 */
export async function selectCompanyContext(
  revision: CompanyContextRevisionRow,
  query: SelectionQuery,
): Promise<CompanyContextSelection> {
  if (revision.validationState !== 'valid') {
    throw new AppError(
      409,
      'COMPANY_CONTEXT_INVALID',
      `Company context revision ${revision.commitSha.slice(0, 7)} did not validate and must not be used as policy.`,
    );
  }

  const documents = await documentsForRevision(revision);

  const core = buildCore(documents, revision.commitSha);
  if (!core.some((s) => s.document === REQUIRED_CORE_DOCUMENT)) {
    throw new AppError(
      500,
      'COMPANY_CONTEXT_CORE_MISSING',
      `${REQUIRED_CORE_DOCUMENT} is not readable at ${revision.commitSha.slice(0, 7)}, so Mac cannot ` +
        'assemble the authority context every piece of work requires. Refusing rather than ' +
        'proceeding on partial company policy.',
    );
  }

  const coreRefs = new Set(core.map((s) => s.ref));
  const { selected, dropped } = selectTaskRelevant({
    documents,
    commitSha: revision.commitSha,
    query,
    exclude: coreRefs,
  });

  const characters =
    core.reduce((n, s) => n + s.text.length, 0) + selected.reduce((n, s) => n + s.text.length, 0);

  return {
    revision: toContextRef(revision),
    core,
    taskRelevant: selected,
    droppedForBudget: dropped,
    characters,
  };
}

/**
 * The core block.
 *
 * Takes no query. That is the guarantee, not an oversight.
 *
 * A document listed here that the manifest does not declare mandatory is skipped
 * without complaint — the manifest stays the authority on what exists — but
 * `AUTHORITY.md` missing is already a load failure, so it cannot vanish quietly.
 */
export function buildCore(documents: Map<string, string>, commitSha: string): CompanyContextSection[] {
  const out: CompanyContextSection[] = [];

  for (const selector of CORE_SELECTORS) {
    const text = documents.get(selector.document);
    if (!text) continue;

    if (selector.sections === '*') {
      out.push({
        document: selector.document,
        heading: null,
        text: text.trim(),
        ref: companySectionRef({ document: selector.document, heading: null, commitSha }),
        score: null,
      });
      continue;
    }

    const parsed = parseSections(text);
    for (const wanted of selector.sections) {
      const section = parsed.find((s) => s.heading !== null && headingMatches(s.heading, wanted));
      if (!section) continue;
      out.push({
        document: selector.document,
        heading: section.heading,
        text: section.text,
        ref: companySectionRef({ document: selector.document, heading: section.heading, commitSha }),
        score: null,
      });
    }
  }

  return out;
}

/**
 * Heading comparison that survives typography.
 *
 * The authoritative documents use an em dash in `Mac — Automation Engineer`. A
 * selector written with a hyphen, or a future edit that changes the dash, should
 * not silently drop Mac's own role definition out of his context — so dashes are
 * normalised and comparison is case-insensitive.
 */
const normaliseHeading = (h: string): string =>
  h
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

const headingMatches = (actual: string, wanted: string): boolean =>
  normaliseHeading(actual) === normaliseHeading(wanted);

/**
 * Task-relevant sections, scored by keyword coverage.
 *
 * Coverage of the QUERY's terms, not hit count — the same measure the Sprint 2
 * supervision settled on, and for the same reason: counting hits would make the
 * longest section win, and `OPERATING_MODEL.md` is long.
 */
export function selectTaskRelevant(input: {
  documents: Map<string, string>;
  commitSha: string;
  query: SelectionQuery;
  exclude: ReadonlySet<string>;
}): { selected: CompanyContextSection[]; dropped: Array<{ ref: string; score: number }> } {
  const terms = keywords(input.query.text);
  if (terms.length === 0) return { selected: [], dropped: [] };

  const candidates: CompanyContextSection[] = [];

  for (const [document, text] of input.documents) {
    const weight = DOCUMENT_WEIGHT[document] ?? DEFAULT_DOCUMENT_WEIGHT;

    for (const section of parseSections(text)) {
      const ref = companySectionRef({ document, heading: section.heading, commitSha: input.commitSha });
      if (input.exclude.has(ref)) continue;

      const sectionTerms = keywords(`${section.heading ?? ''} ${section.text}`);
      const matched = terms.filter((t) => sectionTerms.some((c) => termsMatch(t, c)));
      const score = Math.round((matched.length / terms.length) * weight * 1000) / 1000;
      if (score < MIN_SECTION_SCORE) continue;

      candidates.push({ document, heading: section.heading, text: section.text, ref, score });
    }
  }

  candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.ref.localeCompare(b.ref));

  const budget = input.query.budget ?? TASK_CONTEXT_CHAR_BUDGET;
  const selected: CompanyContextSection[] = [];
  const dropped: Array<{ ref: string; score: number }> = [];
  let used = 0;

  for (const candidate of candidates) {
    if (used + candidate.text.length > budget) {
      // Reported, not silently discarded: a caller that keeps hitting the budget
      // should be able to see it rather than wonder why context looks thin.
      dropped.push({ ref: candidate.ref, score: candidate.score ?? 0 });
      continue;
    }
    selected.push(candidate);
    used += candidate.text.length;
  }

  return { selected, dropped };
}

/** Prefix matching in either direction, as elsewhere in Mac's retrieval. */
const termsMatch = (a: string, b: string): boolean => {
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 4 && longer.startsWith(shorter);
};

/**
 * Renders a selection for a coding agent's brief (Sprint 3.2 §14).
 *
 * The framing sentence is load-bearing. The agent is being handed two different
 * kinds of instruction in one prompt — what to build, and the company rules it
 * works under — and an agent that cannot tell them apart will treat a policy as
 * negotiable scope or a scope note as company law.
 */
export function renderCompanyContextMarkdown(selection: CompanyContextSelection): string {
  const sections = [...selection.core, ...selection.taskRelevant];
  if (sections.length === 0) return '';

  const lines: string[] = [
    '## PAC company context',
    '',
    `_Revision ${selection.revision.shortSha} (context version ${selection.revision.contextVersion}). ` +
      'This is PAC company policy, not task instruction. It constrains the work below; it does not ' +
      'describe it. Where the two appear to conflict, the policy wins and you ask._',
    '',
  ];

  for (const section of sections) {
    lines.push(`### ${section.document}${section.heading ? ` — ${section.heading}` : ''}`, '', section.text, '');
  }

  return lines.join('\n').trimEnd();
}

/**
 * Company context as investigation candidates (Sprint 3.2 §12.1).
 *
 * Returned as flat `{ref, text}` pairs so `domain/investigation.ts` stays pure
 * and knows nothing about revisions, manifests or Git.
 */
export function selectionAsEvidence(
  selection: CompanyContextSelection,
): Array<{ ref: string; text: string }> {
  return [...selection.core, ...selection.taskRelevant].map((s) => ({
    ref: s.ref,
    text: s.heading ? `${s.document} — ${s.heading}: ${s.text}` : `${s.document}: ${s.text}`,
  }));
}
