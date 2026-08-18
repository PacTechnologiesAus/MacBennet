import {
  capUngroundedConfidence,
  deriveGroundedness,
  INVESTIGATION_SOURCES,
  type EvidenceKind,
  type EvidenceRef,
  type Groundedness,
  type HandoffBriefContent,
  type InvestigationResult,
  type InvestigationSource,
  type ProjectContextSnapshot,
  type SourceCheck,
} from '@mac/protocol';
import { collectSources, keywords, type AnswerSource } from './supervision.js';

/**
 * Investigate before escalating (Sprint 3 §6, brief §4).
 *
 * ---------------------------------------------------------------------------
 * THE RULE, MADE MECHANICAL
 *
 * Sprint 2 already refused to ask the human a question the repository could
 * answer. Sprint 3 generalises it: six source classes are consulted in order,
 * and a human is asked only once ALL of them have been checked and none
 * resolved it.
 *
 * The important output is not the answer. It is `checked` — every source, and
 * what each returned — which turns "he asked me something he could have looked
 * up" from an impression into a falsifiable claim. That list is persisted
 * whether the investigation succeeded or not.
 * ---------------------------------------------------------------------------
 *
 * This module is pure. It scores material the caller has already gathered; it
 * does no I/O and knows nothing about the database.
 */

export interface InvestigationSources {
  brief: HandoffBriefContent | null;
  repositoryContext: ProjectContextSnapshot | null;
  projectMemory: Array<{ key: string; value: string; confidence: number }>;
  taskMemory: Array<{ key: string; value: string; confidence: number }>;
  /** Questions Mac answered on earlier runs of this project, and their answers. */
  previousRuns: Array<{ runId: string; question: string; answer: string; confidence: number }>;
  /** Constraints and must-not-change statements from earlier briefs. */
  previousBriefs: Array<{ briefId: string; label: string; text: string }>;
  /** The monday item's description and its update feed. */
  mondayContext: Array<{ ref: string; text: string }>;
  /**
   * Sprint 3.2: selected sections of the approved PAC company context, each
   * `ref` already naming its document AND the commit SHA it came from.
   *
   * Supplied by the caller rather than fetched here, because this module stays
   * pure — it knows nothing about revisions, manifests or Git.
   */
  companyContext: Array<{ ref: string; text: string }>;
  approvedScope?: string | null;
}

export interface InvestigationInput {
  subjectKind: 'dimension' | 'agent_question';
  subject: string;
  sources: InvestigationSources;
  /** At or above this, the investigation counts as resolved. */
  resolveThreshold: number;
}

/** Which evidence kind each source class produces. */
const EVIDENCE_KIND: Record<InvestigationSource, EvidenceKind> = {
  repository: 'repository_fact',
  company_context: 'company_policy',
  project_memory: 'project_memory',
  task_memory: 'task_memory',
  previous_runs: 'previous_run',
  previous_briefs: 'user_approved_decision',
  monday: 'monday_item',
};

interface Candidate {
  source: InvestigationSource;
  ref: string;
  text: string;
  authority: number;
}

/**
 * Everything Mac may read, tagged with which source class it came from.
 *
 * The brief is folded into `previous_briefs` as `user_approved_decision`: it is
 * literally what the human agreed to, which is a stronger kind of evidence than
 * anything Mac inferred, and labelling it as merely "a document" would
 * understate it.
 */
function candidatesFrom(sources: InvestigationSources): Candidate[] {
  const candidates: Candidate[] = [];

  if (sources.brief) {
    const briefSources: AnswerSource[] = collectSources({
      question: '',
      brief: sources.brief,
      memory: [],
      repositoryContext: null,
      approvedScope: sources.approvedScope,
      policy: { answerConfidenceThreshold: 0.8, minExecutionConfidence: 0.6 },
    });
    for (const source of briefSources) {
      candidates.push({
        source: 'previous_briefs',
        ref: source.label,
        text: source.text,
        authority: source.authority,
      });
    }
  }

  const context = sources.repositoryContext;
  if (context) {
    if (context.testPaths.length) {
      candidates.push({
        source: 'repository',
        ref: 'repository: test layout',
        text: `Existing tests live in ${context.testPaths.slice(0, 8).join(', ')}.`,
        authority: 0.7,
      });
    }
    for (const manifest of context.packageManifests.slice(0, 5)) {
      if (manifest.scripts.length) {
        candidates.push({
          source: 'repository',
          ref: `repository: ${manifest.path} scripts`,
          text: `Available scripts: ${manifest.scripts.join(', ')}.`,
          authority: 0.7,
        });
      }
    }
    if (context.languages.length) {
      candidates.push({
        source: 'repository',
        ref: 'repository: languages',
        text: `Languages in use: ${context.languages.join(', ')}.`,
        authority: 0.6,
      });
    }
    if (context.readme) {
      candidates.push({
        source: 'repository',
        ref: 'repository: README',
        text: context.readme.slice(0, 4000),
        authority: 0.65,
      });
    }
    for (const commit of context.recentCommits.slice(0, 10)) {
      candidates.push({
        source: 'repository',
        ref: `repository: commit ${commit.sha.slice(0, 8)}`,
        text: commit.subject,
        authority: 0.45,
      });
    }
  }

  /*
   * Approved PAC company policy.
   *
   * Authority 0.9: above project memory (0.8), below task memory's ceiling
   * (0.9 x confidence, for material about THIS task). Company policy is
   * authoritative and stable, and it should outrank a project note somebody
   * recorded eight months ago — but a fact recorded about the task in hand is
   * still the more specific answer to a question about that task.
   */
  for (const entry of sources.companyContext) {
    candidates.push({
      source: 'company_context',
      ref: entry.ref,
      text: entry.text,
      authority: 0.9,
    });
  }

  for (const entry of sources.projectMemory) {
    candidates.push({
      source: 'project_memory',
      ref: `project memory: ${entry.key}`,
      text: `${entry.key}: ${entry.value}`,
      authority: 0.8 * entry.confidence,
    });
  }

  for (const entry of sources.taskMemory) {
    candidates.push({
      source: 'task_memory',
      ref: `task memory: ${entry.key}`,
      text: `${entry.key}: ${entry.value}`,
      authority: 0.9 * entry.confidence,
    });
  }

  for (const previous of sources.previousRuns) {
    candidates.push({
      source: 'previous_runs',
      ref: `previous run ${previous.runId.slice(0, 8)}`,
      /*
       * Both halves, deliberately.
       *
       * A previous answer is only useful next to the question it answered —
       * "Vitest" on its own matches nothing, while "What test framework? Vitest"
       * matches a question about testing.
       */
      text: `${previous.question} → ${previous.answer}`,
      // Discounted by how confident Mac was the first time. An assumption he
      // made last week does not become a fact by being repeated.
      authority: 0.7 * previous.confidence,
    });
  }

  for (const previous of sources.previousBriefs) {
    candidates.push({
      source: 'previous_briefs',
      ref: previous.label || `previous brief ${previous.briefId.slice(0, 8)}`,
      text: previous.text,
      authority: 0.85,
    });
  }

  for (const entry of sources.mondayContext) {
    candidates.push({
      source: 'monday',
      ref: entry.ref,
      text: entry.text,
      // A human wrote it on the item, about this work, on purpose.
      authority: 0.8,
    });
  }

  return candidates;
}

/**
 * The same coverage measure the Sprint 2 supervision uses.
 *
 * Coverage rather than hit count, for the reason Sprint 2 recorded: scoring by
 * hits would make a long README — which contains almost every word in the
 * project — outrank the one constraint that actually answers the question.
 */
function score(subject: string, candidate: Candidate): { score: number; matched: string[] } {
  const terms = keywords(subject);
  if (terms.length === 0) return { score: 0, matched: [] };

  const candidateTerms = keywords(`${candidate.ref} ${candidate.text}`);
  const matched = terms.filter((t) => candidateTerms.some((c) => termsMatch(t, c)));
  return { score: (matched.length / terms.length) * candidate.authority, matched };
}

const termsMatch = (a: string, b: string): boolean => {
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 4 && longer.startsWith(shorter);
};

export function investigate(input: InvestigationInput): InvestigationResult {
  const candidates = candidatesFrom(input.sources);
  const bySource = new Map<InvestigationSource, Candidate[]>();
  for (const candidate of candidates) {
    bySource.set(candidate.source, [...(bySource.get(candidate.source) ?? []), candidate]);
  }

  const checked: SourceCheck[] = [];
  const scored: Array<{ candidate: Candidate; score: number }> = [];

  /*
   * Every source class is visited, in order, even after one has already
   * answered.
   *
   * Stopping early would be faster and would make the escalation receipt a lie:
   * "Mac checked the repository and stopped" is a different claim from "Mac
   * checked all six", and only the second justifies asking a human.
   */
  for (const source of INVESTIGATION_SOURCES) {
    const available = bySource.get(source) ?? [];
    if (available.length === 0) {
      checked.push({ source, consulted: false, matched: false, note: 'Nothing of this kind was available.' });
      continue;
    }

    const results = available.map((candidate) => ({ candidate, ...score(input.subject, candidate) }));
    const best = results.reduce((a, b) => (b.score > a.score ? b : a));
    scored.push(...results.map((r) => ({ candidate: r.candidate, score: r.score })));

    checked.push({
      source,
      consulted: true,
      matched: best.score > 0,
      note:
        best.score > 0
          ? `Best match ${best.candidate.ref} (score ${best.score.toFixed(2)}, matched ${best.matched.join(', ')}).`
          : `Consulted ${available.length} item(s); none addressed the question.`,
    });
  }

  const ranked = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    return {
      subjectKind: input.subjectKind,
      subject: input.subject,
      resolved: false,
      answer: null,
      confidence: 0,
      evidence: [],
      checked,
      escalatedToHuman: true,
      modelAssisted: false,
    };
  }

  const top = ranked.slice(0, 3);
  const best = top[0]!;
  // Corroboration is real but worth much less than the primary match.
  const corroboration = top.slice(1).reduce((sum, s) => sum + s.score * 0.15, 0);
  const rawConfidence = Math.min(0.95, Math.round((best.score + corroboration) * 1000) / 1000);

  const evidence: EvidenceRef[] = top.map((s) => ({
    kind: EVIDENCE_KIND[s.candidate.source],
    ref: s.candidate.ref,
    excerpt: s.candidate.text.slice(0, 1000),
  }));

  // Groundedness is derived, and the cap is applied here rather than trusted to
  // a caller: an answer with no factual evidence cannot claim to be one.
  const confidence = capUngroundedConfidence(rawConfidence, evidence);
  const resolved = confidence >= input.resolveThreshold;

  return {
    subjectKind: input.subjectKind,
    subject: input.subject,
    resolved,
    answer: top
      .filter((s) => s.score >= best.score * 0.4)
      .map((s) => s.candidate.text)
      .join('\n\n'),
    confidence,
    evidence,
    checked,
    escalatedToHuman: !resolved,
    modelAssisted: false,
  };
}

/** Convenience for callers that need the grounding of an evidence set. */
export function groundednessOf(evidence: readonly EvidenceRef[]): Groundedness {
  return deriveGroundedness(evidence);
}

/** Which source classes were actually consulted, for the persisted record. */
export const consultedSources = (checked: readonly SourceCheck[]): string[] =>
  checked.filter((c) => c.consulted).map((c) => c.source);
