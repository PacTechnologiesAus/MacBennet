import { z } from 'zod';

/**
 * The handoff brief (Sprint 2 §6, spec §4 Phase C).
 *
 * This is the artefact that makes Mac a manager rather than a prompt relay.
 * Spec §12 is explicit: "Mac must not simply forward the human's raw prompt to
 * Claude Code." The brief is what he forwards instead.
 *
 * It has two representations, and both matter:
 *
 *   * the STRUCTURED form below, which is what is persisted, diffed, gap-analysed
 *     and handed to a coding agent;
 *   * a rendered MARKDOWN form (see `renderBriefMarkdown`), which is what a human
 *     reads in the UI and what is embedded in the agent's task prompt.
 *
 * The raw conversation is kept alongside it as provenance, never as the
 * specification.
 */

export const BRIEF_STATUSES = ['draft', 'ready', 'approved', 'superseded'] as const;
export const briefStatusSchema = z.enum(BRIEF_STATUSES);
export type BriefStatus = z.infer<typeof briefStatusSchema>;

export const SCOPE_KINDS = ['full', 'limited'] as const;
export const scopeKindSchema = z.enum(SCOPE_KINDS);
export type ScopeKind = z.infer<typeof scopeKindSchema>;

/** A question Mac still needs answered, and where the answer might come from. */
export const openQuestionSchema = z.object({
  id: z.string().min(1).max(80),
  question: z.string().min(1).max(1000),
  /** Which completeness dimension it belongs to. Drives gap analysis. */
  dimension: z.string().min(1).max(60),
  /**
   * Non-empty when the answer is discoverable from the repository or another
   * connected system. Spec §4 Phase D: Mac must not ask the human these.
   */
  discoverableFrom: z.array(z.string().max(200)).default([]),
  answer: z.string().max(4000).nullable().default(null),
  answeredAt: z.string().nullable().default(null),
  answeredBy: z.string().max(120).nullable().default(null),
});
export type OpenQuestion = z.infer<typeof openQuestionSchema>;

export const briefAssumptionSchema = z.object({
  statement: z.string().min(1).max(1000),
  confidence: z.number().min(0).max(1),
  reversible: z.boolean().default(true),
  basis: z.string().max(1000).nullable().default(null),
});
export type BriefAssumption = z.infer<typeof briefAssumptionSchema>;

export const briefRiskSchema = z.object({
  description: z.string().min(1).max(1000),
  severity: z.enum(['low', 'medium', 'high']),
  mitigation: z.string().max(1000).nullable().default(null),
});
export type BriefRisk = z.infer<typeof briefRiskSchema>;

const shortList = (max = 40) => z.array(z.string().min(1).max(1000)).max(max).default([]);

/**
 * The structured brief. Every field the Sprint 2 brief §6 lists is present and
 * named after the thing it holds.
 */
export const handoffBriefContentSchema = z.object({
  /** One-line statement of the work, used as the run and PR title. */
  title: z.string().min(1).max(200),
  userObjective: z.string().min(1).max(4000),
  currentBehaviour: z.string().max(4000).default(''),
  desiredBehaviour: z.string().max(4000).default(''),
  relevantArchitecture: z.string().max(6000).default(''),
  constraints: shortList(),
  /** Areas that must not change. Enforced socially in the brief, and checked at review. */
  mustNotChange: shortList(),
  likelyAffectedComponents: shortList(),
  acceptanceCriteria: shortList(),
  testingExpectations: shortList(),
  implementationConsiderations: shortList(),
  risks: z.array(briefRiskSchema).max(40).default([]),
  assumptions: z.array(briefAssumptionSchema).max(40).default([]),
  openQuestions: z.array(openQuestionSchema).max(60).default([]),
  /** What Mac proposes to actually do in this run. Narrowed in the limited band. */
  proposedScope: z.string().max(4000).default(''),
  outOfScope: shortList(),
});
export type HandoffBriefContent = z.infer<typeof handoffBriefContentSchema>;

export interface HandoffBriefDto {
  id: string;
  taskId: string;
  projectId: string;
  version: number;
  status: BriefStatus;
  content: HandoffBriefContent;
  /** Understanding confidence in [0,1], computed by gap analysis. */
  confidence: number;
  confidenceBand: string;
  /** The free-flow conversation this was derived from. Provenance, not spec. */
  sourceConversation: string;
  /** Summary of what Mac inspected before asking anything. */
  contextSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The completeness checklist from spec §4 Phase D.
 *
 * Understanding confidence is derived from these rather than guessed, so the
 * number is explainable: a reviewer can see exactly which dimensions are
 * satisfied and which are not.
 */
export const COMPLETENESS_DIMENSIONS = [
  'problem',
  'user_outcome',
  'current_behaviour',
  'desired_behaviour',
  'constraints',
  'architecture',
  'acceptance_criteria',
  'testing',
  'must_not_change',
  'affected_components',
] as const;
export type CompletenessDimension = (typeof COMPLETENESS_DIMENSIONS)[number];

/**
 * Weights sum to 1.0. They encode a judgement about which gaps actually make
 * autonomous work dangerous: not knowing the acceptance criteria is worse than
 * not knowing the architecture, because Mac can discover architecture from the
 * repository but cannot discover what "done" means.
 */
export const DIMENSION_WEIGHTS: Record<CompletenessDimension, number> = {
  problem: 0.14,
  user_outcome: 0.12,
  current_behaviour: 0.08,
  desired_behaviour: 0.14,
  constraints: 0.08,
  architecture: 0.06,
  acceptance_criteria: 0.16,
  testing: 0.08,
  must_not_change: 0.08,
  affected_components: 0.06,
};

/** Human-readable prompts used when Mac has to ask about a dimension. */
export const DIMENSION_QUESTIONS: Record<CompletenessDimension, string> = {
  problem: 'What problem is this solving — what goes wrong today without it?',
  user_outcome: 'Who is the user here, and what should they be able to do afterwards?',
  current_behaviour: 'What does the system do at the moment in this area?',
  desired_behaviour: 'What should it do instead, precisely?',
  constraints: 'Are there constraints I should work within — compatibility, performance, deadlines?',
  architecture: 'Is there an architectural approach you want me to follow here?',
  acceptance_criteria: 'How will we know this is done? What must be true for you to accept it?',
  testing: 'What testing do you expect — unit, integration, or a manual check?',
  must_not_change: 'Is there anything in this area I must not change?',
  affected_components: 'Which parts of the system do you expect this to touch?',
};

export const emptyBriefContent = (title: string): HandoffBriefContent =>
  handoffBriefContentSchema.parse({ title, userObjective: title });

/**
 * Renders the brief as markdown for human reading and for the coding agent's
 * task prompt.
 *
 * Deliberately plain and stable: an agent prompt that changes shape between runs
 * makes results irreproducible, and a human who has read one brief should be
 * able to skim the next.
 */
export interface BriefRenderMeta {
  confidence?: number;
  /**
   * Sprint 3.2: the PAC company context revision governing this work.
   *
   * Rendered as a provenance line so a brief read on paper, in a pull request,
   * or by a coding agent identifies which company policy governed it - which is
   * what makes "handoff brief can identify context revision" true of the
   * artefact itself and not merely of a database column beside it.
   */
  companyContext?: { shortSha: string; contextVersion: string } | null;
  /**
   * The rendered company-context block, already selected and attributed.
   *
   * Passed in rather than built here because selection needs the repository and
   * this module is pure protocol. Placed AFTER the task content on purpose: the
   * agent reads what it is being asked to do, then the standing company policy
   * that constrains it.
   */
  companyContextMarkdown?: string | null;
}

export function renderBriefMarkdown(brief: HandoffBriefContent, meta: BriefRenderMeta = {}): string {
  const lines: string[] = [];
  const section = (heading: string, body: string) => {
    if (!body.trim()) return;
    lines.push(`## ${heading}`, '', body.trim(), '');
  };
  const list = (heading: string, items: readonly string[]) => {
    if (!items.length) return;
    lines.push(`## ${heading}`, '', ...items.map((i) => `- ${i}`), '');
  };

  lines.push(`# ${brief.title}`, '');
  if (meta.confidence !== undefined) {
    lines.push(`_Understanding confidence: ${(meta.confidence * 100).toFixed(0)}%_`, '');
  }
  if (meta.companyContext) {
    lines.push(
      `_PAC company context: ${meta.companyContext.shortSha} (context version ${meta.companyContext.contextVersion})_`,
      '',
    );
  }

  section('Objective', brief.userObjective);
  section('Current behaviour', brief.currentBehaviour);
  section('Desired behaviour', brief.desiredBehaviour);
  section('Relevant architecture', brief.relevantArchitecture);
  list('Constraints', brief.constraints);
  list('Must not change', brief.mustNotChange);
  list('Likely affected components', brief.likelyAffectedComponents);
  list('Acceptance criteria', brief.acceptanceCriteria);
  list('Testing expectations', brief.testingExpectations);
  list('Implementation considerations', brief.implementationConsiderations);
  section('Proposed scope for this run', brief.proposedScope);
  list('Explicitly out of scope', brief.outOfScope);

  if (brief.assumptions.length) {
    lines.push('## Assumptions already made', '');
    for (const a of brief.assumptions) {
      lines.push(`- ${a.statement} _(confidence ${(a.confidence * 100).toFixed(0)}%${a.reversible ? '' : ', not easily reversible'})_`);
    }
    lines.push('');
  }

  if (brief.risks.length) {
    lines.push('## Risks', '');
    for (const r of brief.risks) lines.push(`- **${r.severity}** — ${r.description}`);
    lines.push('');
  }

  const unresolved = brief.openQuestions.filter((q) => q.answer === null);
  if (unresolved.length) {
    lines.push('## Unresolved questions', '');
    for (const q of unresolved) lines.push(`- ${q.question}`);
    lines.push('');
  }

  if (meta.companyContextMarkdown && meta.companyContextMarkdown.trim()) {
    lines.push(meta.companyContextMarkdown.trim(), '');
  }

  return lines.join('\n').trimEnd();
}
