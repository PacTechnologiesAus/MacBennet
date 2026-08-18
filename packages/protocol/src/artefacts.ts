import { z } from 'zod';

/**
 * Results that are not commits (Sprint 3.3 §16, §17).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A GIT COMMIT
 *
 * Before Sprint 3.3 every output Mac produced was a diff, and the only way to
 * hand a human something to read was to open a pull request against a
 * repository. For research work that is the wrong storage model twice over: it
 * requires a repository the work does not need, and it puts a document into a
 * review flow designed for code.
 *
 * So an artefact is a first-class row. It carries its own provenance — the
 * company-context commit it was written under, the evidence behind each claim,
 * and the model usage it cost — which is what makes "evidence-backed results"
 * a property of the stored object rather than a claim in a report.
 * ---------------------------------------------------------------------------
 */

export const ARTEFACT_TYPES = [
  'investigation_report',
  'engineering_brief',
  'architecture_note',
  'recommendation',
  'markdown_document',
  'structured_data',
  'diagram_description',
  /** A proposed follow-up task. Proposed only — Mac does not create work for himself. */
  'task_proposal',
] as const;
export const artefactTypeSchema = z.enum(ARTEFACT_TYPES);
export type ArtefactType = z.infer<typeof artefactTypeSchema>;

export const ARTEFACT_TYPE_LABELS: Record<ArtefactType, string> = {
  investigation_report: 'Investigation report',
  engineering_brief: 'Engineering brief',
  architecture_note: 'Architecture note',
  recommendation: 'Recommendation',
  markdown_document: 'Document',
  structured_data: 'Structured data',
  diagram_description: 'Diagram description',
  task_proposal: 'Proposed follow-up task',
};

export const ARTEFACT_FORMATS = ['markdown', 'json'] as const;
export const artefactFormatSchema = z.enum(ARTEFACT_FORMATS);
export type ArtefactFormat = z.infer<typeof artefactFormatSchema>;

// ---------------------------------------------------------------------------
// Evidence classification
// ---------------------------------------------------------------------------

/**
 * What kind of claim a statement is (Sprint 3.3 §16).
 *
 * The ordering is by authority, strongest first, and the split that matters is
 * between the first four and the last four: the first four are things somebody
 * can check, and the last four are things Mac produced. A report that does not
 * distinguish them is a report in which a guess reads exactly like a fact —
 * which is the specific failure mode an autonomous researcher has and a human
 * researcher mostly does not, because a human is embarrassed to be caught.
 */
export const EVIDENCE_CLASSES = [
  /** Established in PAC's approved company context, at a known commit. */
  'pac_fact',
  /** Established in this project's own material — repository, memory, briefs. */
  'project_fact',
  /** Established in an external source Mac actually retrieved. */
  'external_fact',
  /** A human decided this. Stronger than anything Mac worked out. */
  'user_approved_decision',
  /** Follows from the above, but is not itself recorded anywhere. */
  'inference',
  /** What Mac suggests should happen. Never a fact, however confident. */
  'recommendation',
  /** Chosen to make progress, and reversible. Spec §6. */
  'assumption',
  /** Mac looked and could not establish it. Reported rather than filled in. */
  'unknown',
] as const;
export const evidenceClassSchema = z.enum(EVIDENCE_CLASSES);
export type EvidenceClass = z.infer<typeof evidenceClassSchema>;

/** Classes that a reader may treat as established. The rest are Mac's own work. */
export const FACTUAL_EVIDENCE_CLASSES: readonly EvidenceClass[] = [
  'pac_fact',
  'project_fact',
  'external_fact',
  'user_approved_decision',
];

export const isFactualClass = (klass: EvidenceClass): boolean => FACTUAL_EVIDENCE_CLASSES.includes(klass);

/**
 * The confidence a non-factual finding may claim at most.
 *
 * Mirrors `UNGROUNDED_CONFIDENCE_CEILING` in `evidence.ts` and exists for the
 * same reason: an inference or an assumption that could claim 0.95 would be
 * indistinguishable, to any downstream reader, from something Mac verified.
 */
export const UNGROUNDED_FINDING_CEILING = 0.59;

/**
 * A single claim in a result, with what supports it.
 *
 * `sources` is required and may be empty only for `assumption` and `unknown` —
 * the two classes that by definition have nothing behind them. Enforced in
 * `capFindingConfidence` and by the persistence layer rather than left to the
 * good intentions of whatever produced the finding.
 */
export const findingSchema = z.object({
  statement: z.string().min(1).max(4000),
  evidenceClass: evidenceClassSchema,
  confidence: z.number().min(0).max(1),
  /**
   * Where this came from, resolvably. `company:AGENTS.md@a1b2c3d`,
   * `project_memory:test-command`, `https://example.com/spec` — never prose.
   */
  sources: z.array(z.string().min(1).max(500)).max(20).default([]),
  /** Why Mac believes it, in one or two sentences. */
  reasoning: z.string().max(2000).default(''),
});
export type Finding = z.infer<typeof findingSchema>;

/**
 * Caps a finding's confidence at what its class and sources actually support.
 *
 * Applied on every finding before it is persisted, so there is no path that
 * stores a 0.9-confidence inference. A factual class with no source is not a
 * fact — it is somebody having typed the word "fact" — so it is capped too.
 */
export function capFindingConfidence(finding: Finding): Finding {
  const grounded = isFactualClass(finding.evidenceClass) && finding.sources.length > 0;
  return grounded ? finding : { ...finding, confidence: Math.min(finding.confidence, UNGROUNDED_FINDING_CEILING) };
}

/** Findings a reader may act on without checking. Used by the report. */
export const establishedFindings = (findings: readonly Finding[]): Finding[] =>
  findings.filter((f) => isFactualClass(f.evidenceClass) && f.sources.length > 0);

// ---------------------------------------------------------------------------
// The artefact
// ---------------------------------------------------------------------------

export const MAX_ARTEFACT_CONTENT_CHARS = 200_000;

export const artefactContentSchema = z.object({
  type: artefactTypeSchema,
  title: z.string().min(1).max(300),
  format: artefactFormatSchema.default('markdown'),
  /** The document itself. Bounded, because an unbounded blob is not a result. */
  body: z.string().min(1).max(MAX_ARTEFACT_CONTENT_CHARS),
  /** One-paragraph summary for the report and the list view. */
  summary: z.string().max(4000).default(''),
  findings: z.array(findingSchema).max(200).default([]),
});
export type ArtefactContent = z.infer<typeof artefactContentSchema>;

export interface ArtefactDto {
  id: string;
  runId: string | null;
  taskId: string;
  projectId: string;
  type: ArtefactType;
  title: string;
  format: ArtefactFormat;
  summary: string;
  body: string;
  findings: Finding[];
  /** The PAC company context this was produced under. */
  companyContext: { revisionId: string; commitSha: string; shortSha: string } | null;
  /** What producing it cost, where the provider told us. */
  usage: { provider: string; model: string | null; inputTokens: number | null; outputTokens: number | null } | null;
  createdAt: string;
}

/**
 * Renders an artefact as markdown for reading, emailing, or handing to Otto.
 *
 * Findings are rendered as a table AFTER the body, grouped by class, so a
 * reader who skims the prose still meets the distinction between what Mac
 * established and what he concluded before they act on either.
 */
export function renderArtefactMarkdown(
  artefact: Pick<ArtefactDto, 'title' | 'type' | 'body' | 'summary' | 'findings' | 'companyContext'>,
): string {
  const lines: string[] = [`# ${artefact.title}`, ''];

  lines.push(`_${ARTEFACT_TYPE_LABELS[artefact.type]}`
    + (artefact.companyContext ? ` · PAC company context ${artefact.companyContext.shortSha}` : '')
    + '_', '');

  if (artefact.summary.trim()) lines.push(artefact.summary.trim(), '');
  lines.push(artefact.body.trim(), '');

  if (artefact.findings.length) {
    lines.push('---', '', '## Findings and their basis', '');
    for (const klass of EVIDENCE_CLASSES) {
      const group = artefact.findings.filter((f) => f.evidenceClass === klass);
      if (!group.length) continue;
      lines.push(`### ${EVIDENCE_CLASS_LABELS[klass]}`, '');
      for (const finding of group) {
        lines.push(`- ${finding.statement} _(${(finding.confidence * 100).toFixed(0)}%)_`);
        if (finding.sources.length) lines.push(`  - Sources: ${finding.sources.join(', ')}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd();
}

export const EVIDENCE_CLASS_LABELS: Record<EvidenceClass, string> = {
  pac_fact: 'PAC facts',
  project_fact: 'Project facts',
  external_fact: 'External facts',
  user_approved_decision: 'Decisions a human made',
  inference: 'Inferences Mac drew',
  recommendation: 'Recommendations',
  assumption: 'Assumptions Mac made to proceed',
  unknown: 'Still unknown',
};
