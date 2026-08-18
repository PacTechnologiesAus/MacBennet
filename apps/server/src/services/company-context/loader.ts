import { eq, sql } from 'drizzle-orm';
import type {
  CompanyContextRevisionDto,
  CompanyContextSource,
  CompanyDocumentRecord,
  CompanyManifest,
} from '@mac/protocol';
import { shortSha } from '@mac/protocol';
import { db, type DbHandle } from '../../db/client.js';
import { companyContextRevisions } from '../../db/schema.js';
import type { CompanyContextRevisionRow } from '../../db/schema.js';
import { documentSetHash, headingsOf, isSubstantive, sha256 } from '../../domain/company-context.js';
import { CompanyDocumentMissing, type CompanyContextProvider } from './provider.js';
import { mandatoryDocuments, validateManifest, MANIFEST_PATH } from './manifest.js';

/**
 * Turning a commit into a validated, persisted revision (Sprint 3.2 §7, §8).
 *
 * The order below is the whole contract:
 *
 *   read manifest -> validate manifest -> read EVERY mandatory document ->
 *   validate each is present and non-empty -> hash -> persist
 *
 * A failure at any step still persists a row, marked `invalid`, carrying the
 * errors. That is deliberate. "Mac refused to start work at 02:14 and this is
 * why" must be answerable at 08:00 from the database, not from a log line that
 * has since scrolled past. What a failure does NOT do is become active — an
 * invalid revision is never bound to anything.
 */

export interface LoadedRevision {
  row: CompanyContextRevisionRow;
  /** Document text, keyed by normalised path. Held in memory, never persisted. */
  documents: Map<string, string>;
  manifest: CompanyManifest | null;
}

export type LoadOutcome =
  | { ok: true; revision: LoadedRevision }
  | { ok: false; code: string; errors: string[]; row: CompanyContextRevisionRow };

export async function loadRevision(
  provider: CompanyContextProvider,
  params: { commitSha: string; committedAt: string | null; source: CompanyContextSource },
  handle: DbHandle = db,
): Promise<LoadOutcome> {
  const description = provider.describe();

  // --- 1. The manifest --------------------------------------------------

  let manifestText: string;
  try {
    manifestText = await provider.readFile(params.commitSha, MANIFEST_PATH);
  } catch (err) {
    const message =
      err instanceof CompanyDocumentMissing
        ? `The company context repository has no ${MANIFEST_PATH} at ${shortSha(params.commitSha)}.`
        : `Could not read ${MANIFEST_PATH}: ${(err as Error).message}`;
    const row = await persist(handle, {
      description,
      params,
      providerKind: provider.kind,
      manifest: null,
      manifestSha256: '',
      documents: [],
      validationState: 'invalid',
      validationErrors: [message],
    });
    return { ok: false, code: 'COMPANY_MANIFEST_MISSING', errors: [message], row };
  }

  const manifestValidation = validateManifest(manifestText);
  if (!manifestValidation.ok) {
    const row = await persist(handle, {
      description,
      params,
      providerKind: provider.kind,
      manifest: null,
      manifestSha256: sha256(manifestText),
      documents: [],
      validationState: 'invalid',
      validationErrors: manifestValidation.errors,
    });
    return { ok: false, code: manifestValidation.code, errors: manifestValidation.errors, row };
  }

  const manifest = manifestValidation.manifest;

  // --- 2. Every mandatory document --------------------------------------

  const required = mandatoryDocuments(manifest);
  const documents = new Map<string, string>();
  const records: CompanyDocumentRecord[] = [];
  const errors: string[] = [];

  for (const path of required) {
    let text: string;
    try {
      text = await provider.readFile(params.commitSha, path);
    } catch (err) {
      errors.push(
        err instanceof CompanyDocumentMissing
          ? `Mandatory document "${path}" is declared by ${MANIFEST_PATH} but does not exist at ${shortSha(params.commitSha)}.`
          : `Mandatory document "${path}" could not be read: ${(err as Error).message}`,
      );
      continue;
    }

    /*
     * Present-but-empty is a failure too.
     *
     * A zero-byte AUTHORITY.md satisfies "the file exists" and grounds
     * absolutely nothing, which is precisely the state Sprint 3.2 §7 says must
     * not be allowed to look like a normally grounded run.
     */
    if (!isSubstantive(text)) {
      errors.push(`Mandatory document "${path}" is empty at ${shortSha(params.commitSha)}.`);
      continue;
    }

    documents.set(path, text);
    records.push({
      path,
      bytes: Buffer.byteLength(text, 'utf8'),
      sha256: sha256(text),
      headings: headingsOf(text),
    });
  }

  if (errors.length > 0) {
    const row = await persist(handle, {
      description,
      params,
      providerKind: provider.kind,
      manifest,
      manifestSha256: sha256(manifestText),
      documents: records,
      validationState: 'invalid',
      validationErrors: errors,
    });
    return { ok: false, code: 'COMPANY_MANDATORY_DOCUMENT_MISSING', errors, row };
  }

  // --- 3. Persist -------------------------------------------------------

  const row = await persist(handle, {
    description,
    params,
    providerKind: provider.kind,
    manifest,
    manifestSha256: sha256(manifestText),
    documents: records,
    validationState: 'valid',
    validationErrors: [],
  });

  return { ok: true, revision: { row, documents, manifest } };
}

/**
 * Upserts on (repository_url, commit_sha).
 *
 * Re-loading a commit Mac has seen before updates that row rather than creating
 * a second one, so a run bound yesterday still points at the row describing what
 * was loaded. `first_seen_at` is deliberately NOT touched on conflict: it
 * records when this policy revision first entered Mac's world.
 */
async function persist(
  handle: DbHandle,
  input: {
    description: { repositoryUrl: string; ref: string };
    params: { commitSha: string; committedAt: string | null; source: CompanyContextSource };
    providerKind: 'git' | 'memory';
    manifest: CompanyManifest | null;
    manifestSha256: string;
    documents: CompanyDocumentRecord[];
    validationState: 'valid' | 'invalid';
    validationErrors: string[];
  },
): Promise<CompanyContextRevisionRow> {
  const values = {
    repositoryUrl: input.description.repositoryUrl,
    ref: input.description.ref,
    commitSha: input.params.commitSha,
    commitAuthoredAt: input.params.committedAt ? new Date(input.params.committedAt) : null,
    contextVersion: input.manifest?.context_version ?? '',
    schemaVersion: input.manifest?.schema_version ?? 0,
    manifest: (input.manifest ?? {}) as Record<string, unknown>,
    manifestSha256: input.manifestSha256,
    documentSetSha256: documentSetHash(input.documents),
    documents: input.documents,
    validationState: input.validationState,
    validationErrors: input.validationErrors,
    providerKind: input.providerKind,
    source: input.params.source,
    loadedAt: new Date(),
  };

  const [row] = await handle
    .insert(companyContextRevisions)
    .values(values)
    .onConflictDoUpdate({
      target: [companyContextRevisions.repositoryUrl, companyContextRevisions.commitSha],
      set: {
        ref: values.ref,
        commitAuthoredAt: values.commitAuthoredAt,
        contextVersion: values.contextVersion,
        schemaVersion: values.schemaVersion,
        manifest: values.manifest,
        manifestSha256: values.manifestSha256,
        documentSetSha256: values.documentSetSha256,
        documents: values.documents,
        validationState: values.validationState,
        validationErrors: values.validationErrors,
        source: values.source,
        loadedAt: values.loadedAt,
      },
    })
    .returning();

  if (!row) throw new Error('Could not persist the company context revision.');
  return row;
}

export async function revisionById(
  id: string,
  handle: DbHandle = db,
): Promise<CompanyContextRevisionRow | null> {
  const [row] = await handle
    .select()
    .from(companyContextRevisions)
    .where(eq(companyContextRevisions.id, id))
    .limit(1);
  return row ?? null;
}

export async function recentRevisions(limit = 25, handle: DbHandle = db): Promise<CompanyContextRevisionRow[]> {
  return handle
    .select()
    .from(companyContextRevisions)
    .orderBy(sql`${companyContextRevisions.loadedAt} DESC`)
    .limit(limit);
}

export function revisionDto(row: CompanyContextRevisionRow): CompanyContextRevisionDto {
  return {
    id: row.id,
    repositoryUrl: row.repositoryUrl,
    ref: row.ref,
    commitSha: row.commitSha,
    shortSha: shortSha(row.commitSha),
    commitAuthoredAt: row.commitAuthoredAt?.toISOString() ?? null,
    contextVersion: row.contextVersion,
    schemaVersion: row.schemaVersion,
    manifest: row.manifest,
    manifestSha256: row.manifestSha256,
    documentSetSha256: row.documentSetSha256,
    documents: (row.documents as CompanyDocumentRecord[]) ?? [],
    validationState: row.validationState as 'valid' | 'invalid',
    validationErrors: (row.validationErrors as string[]) ?? [],
    providerKind: row.providerKind as 'git' | 'memory',
    source: row.source as CompanyContextSource,
    loadedAt: row.loadedAt.toISOString(),
    firstSeenAt: row.firstSeenAt.toISOString(),
  };
}
