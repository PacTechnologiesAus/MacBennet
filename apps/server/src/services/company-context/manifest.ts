import { parse as parseYaml } from 'yaml';
import {
  companyManifestSchema,
  SUPPORTED_MANIFEST_SCHEMA_VERSIONS,
  type CompanyManifest,
} from '@mac/protocol';

/**
 * Reading and validating `context.yaml` (Sprint 3.2 §6).
 *
 * ---------------------------------------------------------------------------
 * NO GUESSED FALLBACK
 *
 * The single rule this file exists to enforce: a manifest Mac cannot fully
 * understand produces a FAILURE, never a default.
 *
 * The tempting alternative — "unknown schema version, assume version 1 and press
 * on" — would mean a Mac that silently misreads PAC's declared document set,
 * loads six of seven mandatory documents, and then runs work that looks
 * perfectly grounded. Sprint 3.2 §6 forbids exactly that, and §7 forbids the
 * quieter version of it where AUTHORITY.md fails to load and nothing says so.
 *
 * Unknown *fields*, on the other hand, are fine and are preserved: a future
 * `documents.optional:` block should reach the provenance record so an operator
 * can see what PAC declared, even on a Mac that does not yet act on it.
 * ---------------------------------------------------------------------------
 */

export const MANIFEST_PATH = 'context.yaml';

export type ManifestErrorCode =
  | 'COMPANY_MANIFEST_MALFORMED'
  | 'COMPANY_MANIFEST_SCHEMA_UNSUPPORTED'
  | 'COMPANY_MANIFEST_INVALID'
  | 'COMPANY_MANIFEST_UNSAFE_PATH'
  | 'COMPANY_MANIFEST_DUPLICATE_DOCUMENT';

export class ManifestError extends Error {
  override readonly name = 'ManifestError';
  constructor(
    readonly code: ManifestErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type ManifestValidation =
  | { ok: true; manifest: CompanyManifest }
  | { ok: false; code: ManifestErrorCode; errors: string[] };

/**
 * Parses and validates the manifest text.
 *
 * Returns a result rather than throwing, because both outcomes are persisted:
 * a failure becomes a revision row with `validation_state = 'invalid'` and these
 * exact error strings, which is what an operator reads at 08:00 to find out why
 * Mac refused to work.
 */
export function validateManifest(text: string): ManifestValidation {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    return {
      ok: false,
      code: 'COMPANY_MANIFEST_MALFORMED',
      errors: [`context.yaml is not valid YAML: ${(err as Error).message}`],
    };
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      code: 'COMPANY_MANIFEST_MALFORMED',
      errors: ['context.yaml did not parse to a mapping.'],
    };
  }

  /*
   * Schema version is checked BEFORE the rest of the shape.
   *
   * A version 2 manifest may legitimately have a different shape, and reporting
   * "documents.mandatory is missing" about it would send whoever reads the error
   * looking for the wrong problem. The honest message is "this build does not
   * understand schema version 2".
   */
  const declared = (raw as { schema_version?: unknown }).schema_version;
  if (typeof declared !== 'number' || !Number.isInteger(declared)) {
    return {
      ok: false,
      code: 'COMPANY_MANIFEST_INVALID',
      errors: ['context.yaml must declare an integer `schema_version`.'],
    };
  }
  if (!(SUPPORTED_MANIFEST_SCHEMA_VERSIONS as readonly number[]).includes(declared)) {
    return {
      ok: false,
      code: 'COMPANY_MANIFEST_SCHEMA_UNSUPPORTED',
      errors: [
        `context.yaml declares schema_version ${declared}; this build of Mac supports ` +
          `${SUPPORTED_MANIFEST_SCHEMA_VERSIONS.join(', ')}. Mac will not guess at an unfamiliar ` +
          'context schema — upgrade Mac, or pin the company context to a supported revision.',
      ],
    };
  }

  const parsed = companyManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const unsafePath = parsed.error.issues.some(
      (i) => i.path.join('.').startsWith('documents.mandatory') && i.code === 'custom',
    );
    return {
      ok: false,
      code: unsafePath ? 'COMPANY_MANIFEST_UNSAFE_PATH' : 'COMPANY_MANIFEST_INVALID',
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'context.yaml'}: ${i.message}`),
    };
  }

  /*
   * Duplicates are rejected rather than de-duplicated.
   *
   * A manifest listing AUTHORITY.md twice is a manifest somebody edited by hand
   * and got wrong. Quietly collapsing it would hide an editing mistake in the
   * document that defines Mac's authority, which is the last place to be
   * relaxed about mistakes.
   */
  const mandatory = parsed.data.documents.mandatory;
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of mandatory) {
    const key = normaliseDocumentPath(entry);
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  if (duplicates.size > 0) {
    return {
      ok: false,
      code: 'COMPANY_MANIFEST_DUPLICATE_DOCUMENT',
      errors: [`context.yaml lists these mandatory documents more than once: ${[...duplicates].join(', ')}.`],
    };
  }

  return { ok: true, manifest: parsed.data };
}

/**
 * Canonical form for comparison.
 *
 * `./AUTHORITY.md` and `AUTHORITY.md` are the same document; case is NOT
 * folded, because Git is case-sensitive and treating `authority.md` as the same
 * file would produce a manifest that validates and a read that fails.
 */
export const normaliseDocumentPath = (p: string): string =>
  p.trim().replace(/^\.\//, '').replace(/\/{2,}/g, '/');

export const mandatoryDocuments = (manifest: CompanyManifest): string[] =>
  manifest.documents.mandatory.map(normaliseDocumentPath);
