import { createHash } from 'node:crypto';
import type { CompanyDocumentRecord } from '@mac/protocol';

/**
 * Reading a company document, as pure functions (Sprint 3.2 §15).
 *
 * Everything here operates on strings the caller already fetched. No Git, no
 * database, no configuration — which is what makes the selection rules
 * unit-testable without a repository, and is the same split the Sprint 3
 * investigation uses (pure `domain/investigation.ts`, I/O in the service).
 */

export interface ParsedSection {
  /** The `##` heading, or null for the preamble beneath the document's `#` title. */
  heading: string | null;
  /** Body text with the heading line removed and surrounding blank lines trimmed. */
  text: string;
}

/**
 * Splits a company document into its `##` sections.
 *
 * Only level-2 headings start a new section. `###` stays inside its parent,
 * because in these documents a `###` is a sub-point of the policy above it —
 * `SYSTEMS.md`'s `### TIA Portal` under `## GitHub`, for instance — and
 * detaching it would produce a fragment that reads as though it stood alone.
 *
 * Fenced code blocks are respected, so a `## ` line inside a fence does not
 * split the section. None of the current documents contain one, but a future
 * `OPERATING_MODEL.md` showing a YAML example would otherwise fragment oddly.
 */
export function parseSections(markdown: string): ParsedSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: ParsedSection[] = [];

  let heading: string | null = null;
  let buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text || heading !== null) sections.push({ heading, text });
    buffer = [];
  };

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;

    const match = !inFence ? /^##\s+(.+?)\s*$/.exec(line) : null;
    if (match) {
      flush();
      heading = match[1]!;
      continue;
    }

    // The document's own `# Title` belongs to the preamble, not to a section.
    buffer.push(line);
  }
  flush();

  return sections.filter((s) => s.text.length > 0);
}

/** Every `##` heading in a document, in order. Persisted with the revision. */
export const headingsOf = (markdown: string): string[] =>
  parseSections(markdown)
    .map((s) => s.heading)
    .filter((h): h is string => h !== null);

export const sha256 = (input: string | Buffer): string =>
  createHash('sha256').update(input).digest('hex');

/**
 * A stable hash of the document SET, independent of read order.
 *
 * Two revisions with the same document-set hash contain the same policy text
 * even if their commit SHAs differ (a README-only commit, say), which lets the
 * UI say "nothing Mac reads actually changed" rather than alarming an operator
 * about every commit.
 */
export const documentSetHash = (documents: readonly CompanyDocumentRecord[]): string =>
  sha256(
    [...documents]
      .map((d) => `${d.path}:${d.sha256}`)
      .sort()
      .join('\n'),
  );

/**
 * Whether a document loaded to something worth grounding a run on.
 *
 * A zero-byte `AUTHORITY.md` passes a file-exists check and grounds nothing, so
 * "present" is not the test — "has content" is (Sprint 3.2 §7).
 */
export const isSubstantive = (text: string): boolean => text.trim().length > 0;
