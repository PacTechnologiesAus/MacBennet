import { z } from 'zod';
import { evidenceRefSchema } from './evidence.js';

/**
 * PAC shared company context (Sprint 3.2).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A MEMORY SCOPE
 *
 * Mac already has three memory layers (spec §9) and every one of them is
 * something he writes. Company context is the opposite: it is written by PAC
 * humans in a Git repository Mac may only read, it declares its own mandatory
 * document set through a manifest, and it carries a commit identity that must
 * still be resolvable years after the run it governed finished.
 *
 * Modelling it as `global` memory would have quietly given Mac write access to
 * PAC policy and thrown away the version identity. So it is its own thing, with
 * its own provenance record, and the only verb Mac has against the authoritative
 * repository is "read".
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Which kind of provider produced a revision.
 *
 * `git` is the only real one. `memory` exists so the domain and service layers
 * can be tested without a repository, and it is never selectable from
 * configuration.
 */
export const COMPANY_CONTEXT_PROVIDER_KINDS = ['git', 'memory'] as const;
export const companyContextProviderKindSchema = z.enum(COMPANY_CONTEXT_PROVIDER_KINDS);
export type CompanyContextProviderKind = z.infer<typeof companyContextProviderKindSchema>;

/** How a particular load of a revision was obtained. */
export const COMPANY_CONTEXT_SOURCES = ['remote', 'cache'] as const;
export const companyContextSourceSchema = z.enum(COMPANY_CONTEXT_SOURCES);
export type CompanyContextSource = z.infer<typeof companyContextSourceSchema>;

export const COMPANY_CONTEXT_VALIDATION_STATES = ['valid', 'invalid'] as const;
export const companyContextValidationStateSchema = z.enum(COMPANY_CONTEXT_VALIDATION_STATES);
export type CompanyContextValidationState = z.infer<typeof companyContextValidationStateSchema>;

/**
 * What the operator sees, and what context-dependent operations branch on.
 *
 * `cached` and `stale` are deliberately distinct from `fresh`: Sprint 3.2 §10
 * requires that context obtained from a cache is never presented as though the
 * remote had just confirmed it.
 */
export const COMPANY_CONTEXT_STATUSES = [
  'disabled',
  'fresh',
  'cached',
  'stale',
  'invalid',
  'unavailable',
] as const;
export const companyContextStatusSchema = z.enum(COMPANY_CONTEXT_STATUSES);
export type CompanyContextStatusKind = z.infer<typeof companyContextStatusSchema>;

/** A status a run may actually be grounded on. */
export const USABLE_COMPANY_CONTEXT_STATUSES: readonly CompanyContextStatusKind[] = [
  'fresh',
  'cached',
  'stale',
];

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * Manifest schema versions this build of Mac understands.
 *
 * A manifest declaring anything else is a hard failure, not a warning: Sprint
 * 3.2 §6 is explicit that Mac must not silently fall back to a guessed policy.
 * Widening this list is a deliberate act by a person who has read the new
 * schema.
 */
export const SUPPORTED_MANIFEST_SCHEMA_VERSIONS = [1] as const;

/**
 * A path inside the company repository.
 *
 * The constraints are all about not letting a manifest read outside its own
 * tree. Mac resolves these against a bare Git mirror rather than a filesystem,
 * so traversal is already unlikely to succeed — but a manifest that asks for
 * `../../etc/passwd` is a manifest to reject loudly, not to quietly normalise.
 */
export const companyDocumentPathSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((p) => !p.includes('\0'), 'must not contain a NUL byte')
  .refine((p) => !p.includes('\\'), 'must use forward slashes')
  .refine((p) => !p.startsWith('/'), 'must be relative')
  .refine((p) => !/^[A-Za-z]:/.test(p), 'must not be an absolute Windows path')
  .refine((p) => !p.split('/').includes('..'), 'must not traverse upwards')
  .refine((p) => p.trim() === p && p.length > 0, 'must not be padded with whitespace');

/**
 * The manifest, as declared by `context.yaml`.
 *
 * `.passthrough()` at every level is deliberate. Sprint 3.2 §6 requires that
 * unknown future-compatible fields are handled sensibly, and the sensible thing
 * is to preserve them: a future `documents.optional:` block should reach the
 * persisted provenance record so an operator can see it, even on a Mac that
 * does not yet act on it.
 */
export const companyManifestSchema = z
  .object({
    schema_version: z.number().int(),
    context_version: z.string().min(1).max(80),
    organisation: z.object({ name: z.string().min(1).max(200) }).passthrough().optional(),
    documents: z
      .object({
        mandatory: z.array(companyDocumentPathSchema).min(1).max(200),
      })
      .passthrough(),
    precedence: z.array(z.string().min(1).max(120)).min(1).max(50),
    governance: z
      .object({
        agents_may_propose_changes: z.boolean(),
        agents_may_approve_changes: z.boolean(),
        human_review_required: z.boolean(),
      })
      .passthrough(),
    refresh: z
      .object({
        check_on_agent_start: z.boolean(),
        check_before_new_project: z.boolean(),
        record_commit_sha: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();
export type CompanyManifest = z.infer<typeof companyManifestSchema>;

// ---------------------------------------------------------------------------
// Documents and revisions
// ---------------------------------------------------------------------------

/**
 * What Mac records about a loaded document.
 *
 * Note the absence: the text. Sprint 3.2 §8.1 keeps content out of Postgres so
 * there is exactly one authoritative copy of PAC policy, in the repository the
 * humans govern. The hash proves which text it was; the headings make the
 * selection layer inspectable without re-reading Git.
 */
export const companyDocumentRecordSchema = z.object({
  path: companyDocumentPathSchema,
  bytes: z.number().int().min(0),
  sha256: z.string().length(64),
  headings: z.array(z.string().max(300)).max(200).default([]),
});
export type CompanyDocumentRecord = z.infer<typeof companyDocumentRecordSchema>;

export const companyContextRevisionSchema = z.object({
  id: z.string().uuid(),
  repositoryUrl: z.string().min(1),
  ref: z.string().min(1),
  commitSha: z.string().min(7).max(64),
  shortSha: z.string().min(7).max(12),
  commitAuthoredAt: z.string().nullable(),
  contextVersion: z.string(),
  schemaVersion: z.number().int(),
  manifest: z.unknown(),
  manifestSha256: z.string(),
  documentSetSha256: z.string(),
  documents: z.array(companyDocumentRecordSchema),
  validationState: companyContextValidationStateSchema,
  validationErrors: z.array(z.string()).default([]),
  providerKind: companyContextProviderKindSchema,
  source: companyContextSourceSchema,
  loadedAt: z.string(),
  firstSeenAt: z.string(),
});
export type CompanyContextRevisionDto = z.infer<typeof companyContextRevisionSchema>;

/**
 * The compact form embedded in every run, discovery session, brief and answer.
 *
 * Small on purpose: it is carried on a lot of DTOs, and everything else about
 * the revision is one request away by id.
 */
export const companyContextRefSchema = z.object({
  revisionId: z.string().uuid(),
  commitSha: z.string(),
  shortSha: z.string(),
  contextVersion: z.string(),
  ref: z.string(),
});
export type CompanyContextRef = z.infer<typeof companyContextRefSchema>;

export interface CompanyContextStatusDto {
  enabled: boolean;
  status: CompanyContextStatusKind;
  repositoryUrl: string;
  ref: string;
  providerKind: CompanyContextProviderKind;
  /** True when the active revision was not confirmed against the remote. */
  cached: boolean;
  stale: boolean;
  allowCached: boolean;
  lastCheckAt: string | null;
  lastSuccessfulRefreshAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  revision: CompanyContextRevisionDto | null;
  /** Mandatory document paths the manifest declares, and whether each loaded. */
  mandatoryDocuments: Array<{ path: string; loaded: boolean; bytes: number | null }>;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** One selected section of one company document. */
export const companyContextSectionSchema = z.object({
  document: companyDocumentPathSchema,
  /** The `##` heading, or `null` for the document preamble under its `#` title. */
  heading: z.string().max(300).nullable(),
  text: z.string(),
  /** `company:AUTHORITY.md#Financial Authority@83ac4a0` — document AND revision. */
  ref: z.string().min(1).max(400),
  /** Present for task-relevant sections; null for core, which is not scored. */
  score: z.number().min(0).max(1).nullable().default(null),
});
export type CompanyContextSection = z.infer<typeof companyContextSectionSchema>;

export interface CompanyContextSelection {
  revision: CompanyContextRef;
  /**
   * Always present, never scored, never omitted. Sprint 3.2 §15.1: hard
   * authority content must be deterministically available.
   */
  core: CompanyContextSection[];
  /** Selected for this particular piece of work. May legitimately be empty. */
  taskRelevant: CompanyContextSection[];
  /** Sections that scored above the floor but did not fit the budget. */
  droppedForBudget: Array<{ ref: string; score: number }>;
  characters: number;
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

/**
 * Where a proposal is in the human review process.
 *
 * Mac may only ever create one at `proposed`. Everything past that is a human
 * decision — see `services/company-context/proposals.ts`, which refuses a
 * non-user actor outright.
 */
export const COMPANY_PROPOSAL_STATUSES = [
  'proposed',
  'under_review',
  'accepted',
  'rejected',
  'superseded',
] as const;
export const companyProposalStatusSchema = z.enum(COMPANY_PROPOSAL_STATUSES);
export type CompanyProposalStatus = z.infer<typeof companyProposalStatusSchema>;

/** Statuses only a human may set. Enforced in the service, tested in §22. */
export const HUMAN_ONLY_PROPOSAL_STATUSES: readonly CompanyProposalStatus[] = ['accepted', 'rejected'];

export const createCompanyProposalSchema = z.object({
  targetDocument: companyDocumentPathSchema,
  targetSection: z.string().max(300).nullable().default(null),
  proposedChange: z.string().min(1).max(20_000),
  reason: z.string().min(1).max(4000),
  evidence: z.array(evidenceRefSchema).max(40).default([]),
  potentialImpact: z.string().max(4000).nullable().default(null),
  projectId: z.string().uuid().nullable().default(null),
  taskId: z.string().uuid().nullable().default(null),
  runId: z.string().uuid().nullable().default(null),
  discoverySessionId: z.string().uuid().nullable().default(null),
});
export type CreateCompanyProposalRequest = z.infer<typeof createCompanyProposalSchema>;

export const updateCompanyProposalSchema = z.object({
  status: companyProposalStatusSchema,
  reviewNotes: z.string().max(4000).nullable().default(null),
});
export type UpdateCompanyProposalRequest = z.infer<typeof updateCompanyProposalSchema>;

export interface CompanyProposalDto {
  id: string;
  targetDocument: string;
  targetSection: string | null;
  proposedChange: string;
  reason: string;
  evidence: unknown[];
  potentialImpact: string | null;
  projectId: string | null;
  taskId: string | null;
  runId: string | null;
  discoverySessionId: string | null;
  agent: string;
  baseRevision: CompanyContextRef | null;
  status: CompanyProposalStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const shortSha = (sha: string): string => sha.slice(0, 7);

/**
 * The reference string that carries BOTH the document and the revision.
 *
 * Sprint 3.2 §13 requires company-context evidence to name its source document
 * and commit SHA. Putting both in the ref itself means every consumer that
 * already renders an evidence ref — the audit trail, the morning report, the
 * question detail — gets it without changing.
 */
export const companySectionRef = (params: {
  document: string;
  heading: string | null;
  commitSha: string;
}): string =>
  `company:${params.document}${params.heading ? `#${params.heading}` : ''}@${shortSha(params.commitSha)}`;
