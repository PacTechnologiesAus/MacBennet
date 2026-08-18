import type { DecisionRisk, HandoffBriefContent, ProjectContextSnapshot } from '@mac/protocol';
import { decideAction, toScaled } from './confidence.js';

/**
 * Question-and-answer supervision (Sprint 2 §8, §9).
 *
 * When a coding agent asks a question mid-implementation, Mac tries to answer
 * it rather than blocking — spec §6: "Mac should favour forward progress over
 * unnecessary blocking." This module decides what he says.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS RETRIEVAL, NOT A MODEL CALL
 *
 * Every answer here is derived from a recorded source: a field of the handoff
 * brief, a memory entry, or a fact from the inspected repository. That choice
 * buys three properties which a model call would cost:
 *
 *   1. Every answer is EXPLAINABLE. The reasoning and the exact sources are
 *      persisted, so a human reviewing the morning report can see not just what
 *      Mac decided but what he decided it from.
 *   2. Confidence is HONEST BY CONSTRUCTION. It falls out of how well the
 *      sources match, so "I don't know" produces a low number automatically
 *      rather than a fluent guess with a high one.
 *   3. The whole supervision path is TESTABLE with no paid model usage, which
 *      the Sprint 2 test requirements demand.
 *
 * A model-backed resolver is a drop-in replacement for `resolveAnswer` later;
 * the surrounding risk classification and decision policy stay as they are,
 * because those are the parts that must not be delegated to a model.
 * ---------------------------------------------------------------------------
 */

export interface AnswerSource {
  /** Human-readable provenance, e.g. `brief.constraints[2]` or `project memory: test_framework`. */
  label: string;
  text: string;
  /** How much weight this source carries. Brief > project memory > repository. */
  authority: number;
}

export interface SupervisionInput {
  question: string;
  context?: string | undefined;
  brief: HandoffBriefContent;
  /** Project- and task-scoped memory. Task memory never crosses tasks. */
  memory: Array<{ key: string; value: string; scope: string; confidence: number }>;
  repositoryContext?: ProjectContextSnapshot | null | undefined;
  /** What the human actually approved, when narrower than the brief. */
  approvedScope?: string | null | undefined;
  policy: { answerConfidenceThreshold: number; minExecutionConfidence: number };
}

export interface SupervisionResult {
  decision: 'answered' | 'assumed' | 'blocked';
  answer: string;
  confidence: number;
  reasoning: string;
  sources: string[];
  risk: DecisionRisk;
  isAssumption: boolean;
  requiredHuman: boolean;
  /** Present when the decision is `blocked` — what to record as a blocker. */
  blocker: { description: string; reason: string } | null;
}

// ---------------------------------------------------------------------------
// Risk classification
// ---------------------------------------------------------------------------

/**
 * Words that mark a question as touching something Mac must not decide alone.
 *
 * This list is intentionally blunt and intentionally over-inclusive. A false
 * positive costs one blocked subtask and a line in the morning report. A false
 * negative costs a dropped table, a rotated credential, or a production
 * deployment. Those are not symmetric, so the list errs toward blocking.
 */
/**
 * Two patterns that must BOTH appear, in either order.
 *
 * Written this way because natural word order is not reliable: "download to the
 * live PLC" and "the PLC needs the new logic downloaded" are the same request,
 * and a single left-to-right regex catches only one of them.
 */
interface SensitiveRule {
  why: string;
  pattern?: RegExp;
  /** Every entry must match somewhere in the text, in any order. */
  all?: RegExp[];
}

const SENSITIVE_PATTERNS: SensitiveRule[] = [
  {
    why: 'destructive database operation',
    // `[^.?!]{0,40}?` rather than `\s+`: "drop the devices table" puts a noun
    // between the verb and the object, and that is the normal way to say it.
    pattern: /\b(drop|truncate|delete|wipe)\b[^.?!]{0,40}?\b(table|tables|database|schema|collection|index)\b/i,
  },
  { why: 'destructive data operation', pattern: /\b(delete|remove|purge|wipe)\b.{0,40}\b(production|prod|live|customer|user)\s+data\b/i },
  { why: 'production deployment', pattern: /\b(deploy|release|ship|publish|roll\s?out)\b.{0,30}\b(production|prod|live)\b/i },
  { why: 'credentials or secrets', pattern: /\b(secret|secrets|credential|credentials|password|api[- ]?key|access[- ]token|private[- ]key|certificate)\b/i },
  { why: 'access control', all: [/\b(auth|authentication|authorisation|authorization|permission|permissions|access control|rbac|role)\b/i, /\b(change|modify|bypass|disable|remove|relax|grant|escalate)\b/i] },
  { why: 'weakening a safety control', pattern: /\b(disable|skip|bypass|remove|turn off)\b.{0,40}\b(security|validation|check|checks|guard|sanitis|sanitiz|encryption|auth)\b/i },
  { why: 'irreversible migration', all: [/\b(migration|migrate)\b/i, /\b(irreversible|destructive|drop|data loss|down\s?time)\b/i] },
  { why: 'live industrial control', all: [/\b(plc|scada|hmi|industrial|controller)\b/i, /\b(download|write|control|command|deploy|upload)\b/i] },
  { why: 'financial commitment', all: [/\b(payment|invoice|charge|billing|refund)\b/i, /\b(customer|client|live|production)\b/i] },
  { why: 'prohibited git operation', pattern: /\bforce[- ]push\b|\b(merge|push)\b.{0,25}\b(main|master|default branch|trunk)\b/i },
];

const matchesSensitiveRule = (rule: SensitiveRule, text: string): boolean =>
  rule.all ? rule.all.every((p) => p.test(text)) : Boolean(rule.pattern?.test(text));

/** Signals that a decision cannot be cheaply undone. */
const IRREVERSIBLE_PATTERNS: RegExp[] = [
  /\bmigration\b/i,
  /\bschema\s+change\b/i,
  /\bpublic\s+api\b/i,
  /\bbreaking\s+change\b/i,
  /\bdata\s+format\b/i,
  /\bwire\s+format\b/i,
  /\brename\b.{0,30}\b(column|table|endpoint|field)\b/i,
];

/** Architectural decisions: medium risk, because they are expensive to reverse. */
const ARCHITECTURAL_PATTERNS: RegExp[] = [
  /\b(architecture|architectural|design pattern|refactor the|restructure|new (library|dependency|package|service))\b/i,
  /\b(should i (add|install|introduce))\b.{0,40}\b(library|dependency|package|framework)\b/i,
];

export interface RiskAssessment {
  risk: DecisionRisk;
  sensitive: boolean;
  reversible: boolean;
  reasons: string[];
}

export function classifyQuestionRisk(question: string, context?: string): RiskAssessment {
  const text = `${question}\n${context ?? ''}`;
  const reasons: string[] = [];
  let sensitive = false;

  for (const rule of SENSITIVE_PATTERNS) {
    if (matchesSensitiveRule(rule, text)) {
      sensitive = true;
      reasons.push(rule.why);
    }
  }

  const irreversible = IRREVERSIBLE_PATTERNS.some((p) => p.test(text));
  if (irreversible) reasons.push('the change is not easily reversible');

  const architectural = ARCHITECTURAL_PATTERNS.some((p) => p.test(text));
  if (architectural) reasons.push('architectural or dependency decision');

  const risk: DecisionRisk = sensitive ? 'high' : irreversible || architectural ? 'medium' : 'low';

  return { risk, sensitive, reversible: !irreversible, reasons };
}

// ---------------------------------------------------------------------------
// Answer retrieval
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'should', 'would', 'could', 'what', 'which', 'where', 'when', 'does', 'do', 'is', 'are',
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'i', 'you', 'it', 'this',
  'that', 'with', 'use', 'using', 'want', 'need', 'be', 'have', 'has', 'can', 'may', 'my',
]);

/**
 * Crude suffix stripping, deliberately not a real stemmer.
 *
 * "What testing is expected" must match "Add unit tests ... using Vitest", and
 * exact substring matching does not: `testing` is not a substring of `tests`.
 * A full Porter stemmer would be a dependency and a source of surprises; three
 * suffix rules cover the plural/gerund/past-tense mismatches that actually
 * occur in engineering questions, and anything they miss simply scores lower
 * rather than producing a wrong answer.
 */
export function stem(term: string): string {
  if (term.length > 5 && term.endsWith('ing')) return term.slice(0, -3);
  if (term.length > 4 && term.endsWith('ed')) return term.slice(0, -2);
  if (term.length > 4 && term.endsWith('ies')) return `${term.slice(0, -3)}y`;
  if (term.length > 3 && term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1);
  return term;
}

/** Splits camelCase so a field label like `testingExpectations` yields real words. */
const splitCamelCase = (text: string): string => text.replace(/([a-z0-9])([A-Z])/g, '$1 $2');

export function keywords(text: string): string[] {
  return Array.from(
    new Set(
      splitCamelCase(text)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
        .map(stem),
    ),
  );
}

/**
 * Whether a question term is answered by a source term.
 *
 * Prefix matching in either direction, with a minimum length, so that `expect`
 * matches `expectation` without `add` matching `additional`.
 */
const termsMatch = (a: string, b: string): boolean => {
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 4 && longer.startsWith(shorter);
};

/** Collects every source Mac may answer from, with its authority weight. */
export function collectSources(input: SupervisionInput): AnswerSource[] {
  const sources: AnswerSource[] = [];
  const b = input.brief;

  // The brief is the most authoritative thing Mac has: it is what the human
  // agreed to, and it was produced specifically for this task.
  const push = (label: string, text: string, authority: number) => {
    if (text && text.trim().length > 0) sources.push({ label, text: text.trim(), authority });
  };

  push('brief.userObjective', b.userObjective, 1.0);
  push('brief.desiredBehaviour', b.desiredBehaviour, 1.0);
  push('brief.currentBehaviour', b.currentBehaviour, 0.9);
  push('brief.relevantArchitecture', b.relevantArchitecture, 0.85);
  push('brief.proposedScope', b.proposedScope, 0.95);
  b.constraints.forEach((c, i) => push(`brief.constraints[${i}]`, c, 1.0));
  b.mustNotChange.forEach((c, i) => push(`brief.mustNotChange[${i}]`, `Must not change: ${c}`, 1.0));
  b.acceptanceCriteria.forEach((c, i) => push(`brief.acceptanceCriteria[${i}]`, c, 1.0));
  b.testingExpectations.forEach((c, i) => push(`brief.testingExpectations[${i}]`, c, 0.95));
  b.implementationConsiderations.forEach((c, i) => push(`brief.implementationConsiderations[${i}]`, c, 0.8));
  b.outOfScope.forEach((c, i) => push(`brief.outOfScope[${i}]`, `Out of scope: ${c}`, 1.0));
  b.assumptions.forEach((a, i) => push(`brief.assumptions[${i}]`, a.statement, 0.6 * a.confidence));

  if (input.approvedScope) push('run.approvedScope', input.approvedScope, 1.0);

  for (const entry of input.memory) {
    // Project memory is durable knowledge about how this codebase works; task
    // memory is specific to this piece of work and outranks it here.
    const authority = (entry.scope === 'task' ? 0.9 : entry.scope === 'project' ? 0.8 : 0.7) * entry.confidence;
    push(`${entry.scope} memory: ${entry.key}`, `${entry.key}: ${entry.value}`, authority);
  }

  const ctx = input.repositoryContext;
  if (ctx) {
    if (ctx.testPaths.length) {
      push('repository: test layout', `Existing tests live in ${ctx.testPaths.slice(0, 8).join(', ')}.`, 0.7);
    }
    for (const manifest of ctx.packageManifests.slice(0, 5)) {
      if (manifest.scripts.length) {
        push(`repository: ${manifest.path} scripts`, `Available scripts: ${manifest.scripts.join(', ')}.`, 0.7);
      }
    }
    if (ctx.languages.length) push('repository: languages', `Languages in use: ${ctx.languages.join(', ')}.`, 0.6);
    if (ctx.readme) push('repository: README', ctx.readme.slice(0, 2000), 0.65);
  }

  return sources;
}

interface ScoredSource extends AnswerSource {
  score: number;
  matched: string[];
}

function scoreSources(question: string, context: string | undefined, sources: AnswerSource[]): ScoredSource[] {
  const terms = keywords(`${question} ${context ?? ''}`);
  if (terms.length === 0) return [];

  return sources
    .map((source) => {
      // The LABEL is searched as well as the text. A field name encodes what
      // the field is about — `brief.testingExpectations` genuinely is the
      // answer to a question about testing expectations — and including it is
      // what stops a long README from outranking the one precise field.
      const sourceTerms = keywords(`${source.label} ${source.text}`);
      const matched = terms.filter((t) => sourceTerms.some((s) => termsMatch(t, s)));
      /*
       * Coverage, not raw hit count.
       *
       * Scoring by hits alone would make the README — which contains almost
       * every word in the project — outrank the one brief constraint that
       * actually answers the question. Dividing by the number of question terms
       * measures "how much of what was asked does this source speak to", which
       * is the thing that matters.
       */
      const coverage = matched.length / terms.length;
      return { ...source, score: coverage * source.authority, matched };
    })
    .filter((s) => s.matched.length > 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * Turns the scored sources into an answer and a confidence.
 *
 * Confidence is the top source's score, adjusted upward slightly when several
 * independent sources agree and downward when the best match is thin. It is
 * capped below 1.0: Mac is answering from documents, and certainty is not
 * something that process can honestly produce.
 */
export function resolveAnswer(input: SupervisionInput): {
  answer: string;
  confidence: number;
  reasoning: string;
  sources: string[];
} {
  const scored = scoreSources(input.question, input.context, collectSources(input));

  if (scored.length === 0) {
    return {
      answer:
        'Nothing in the handoff brief, project memory or inspected repository addresses this. ' +
        'Take the most conservative option that keeps existing behaviour unchanged, and note it for review.',
      confidence: 0,
      reasoning: 'No source in the brief, memory or repository context matched the question.',
      sources: [],
    };
  }

  const top = scored.slice(0, 3);
  const best = top[0]!;

  // Agreement bonus: a second independent source covering the same ground is
  // genuine corroboration, but it is worth much less than the primary match.
  const corroboration = top.slice(1).reduce((sum, s) => sum + s.score * 0.15, 0);
  const confidence = Math.min(0.95, Math.round((best.score + corroboration) * 1000) / 1000);

  const answer = top
    .filter((s) => s.score >= best.score * 0.4)
    .map((s) => `${s.text}`)
    .join('\n\n');

  const reasoning =
    `Matched ${best.matched.length} of ${keywords(input.question).length} question term(s) against ${best.label} ` +
    `(authority ${best.authority.toFixed(2)}, coverage ${(best.score / Math.max(best.authority, 0.01)).toFixed(2)})` +
    (top.length > 1 ? `, corroborated by ${top.slice(1).map((s) => s.label).join(' and ')}.` : '.');

  return { answer, confidence, reasoning, sources: top.map((s) => s.label) };
}

// ---------------------------------------------------------------------------
// The whole supervision decision
// ---------------------------------------------------------------------------

export function superviseQuestion(input: SupervisionInput): SupervisionResult {
  const risk = classifyQuestionRisk(input.question, input.context);
  const resolved = resolveAnswer(input);

  // Scope check: a question about something the brief explicitly excluded is
  // out of the approved mandate regardless of how well Mac could answer it.
  const withinApprovedScope = !isOutOfScope(input);

  const outcome = decideAction(
    {
      confidence: resolved.confidence,
      risk: risk.risk,
      reversible: risk.reversible,
      withinApprovedScope,
      sensitive: risk.sensitive,
    },
    input.policy,
  );

  if (outcome.action === 'block') {
    return {
      decision: 'blocked',
      answer:
        `Mac is not able to decide this safely, so this part of the work is out of scope for this run. ` +
        `Continue with any independent work that does not depend on it, and leave this portion unimplemented. ` +
        `Reason: ${outcome.reason}`,
      confidence: resolved.confidence,
      reasoning: `${outcome.reason}${risk.reasons.length ? ` Risk signals: ${risk.reasons.join('; ')}.` : ''} ${resolved.reasoning}`,
      sources: resolved.sources,
      risk: risk.risk,
      isAssumption: false,
      requiredHuman: true,
      blocker: {
        description: input.question,
        reason: outcome.reason,
      },
    };
  }

  if (outcome.action === 'assume') {
    return {
      decision: 'assumed',
      answer:
        `${resolved.answer}\n\n` +
        `Mac is not fully confident of this (${(resolved.confidence * 100).toFixed(0)}%). Take the safest reasonable ` +
        `option consistent with the above, keep the change reversible, and do not extend it further than necessary. ` +
        `This decision has been flagged for human review.`,
      confidence: resolved.confidence,
      reasoning: `${outcome.reason} ${resolved.reasoning}`,
      sources: resolved.sources,
      risk: risk.risk,
      isAssumption: true,
      requiredHuman: false,
      blocker: null,
    };
  }

  return {
    decision: 'answered',
    answer: resolved.answer,
    confidence: resolved.confidence,
    reasoning: resolved.reasoning,
    sources: resolved.sources,
    risk: risk.risk,
    isAssumption: false,
    requiredHuman: false,
    blocker: null,
  };
}

/**
 * Is the question about something the brief explicitly put out of scope?
 *
 * Uses the same coverage measure as answering, with a high bar: an out-of-scope
 * entry has to genuinely be what the question is about before Mac refuses to
 * engage with it.
 */
function isOutOfScope(input: SupervisionInput): boolean {
  const excluded = input.brief.outOfScope;
  if (excluded.length === 0) return false;

  const terms = keywords(input.question);
  if (terms.length === 0) return false;

  return excluded.some((entry) => {
    const entryTerms = keywords(entry);
    if (entryTerms.length === 0) return false;
    const overlap = entryTerms.filter((t) => terms.some((q) => termsMatch(q, t))).length;
    return overlap / entryTerms.length >= 0.6;
  });
}

/**
 * Whether an answer counts as low-confidence for reporting purposes.
 * Integer comparison, for the same reason as the confidence bands.
 */
export const isLowConfidenceAnswer = (confidence: number, threshold: number): boolean =>
  toScaled(confidence) < toScaled(threshold);
