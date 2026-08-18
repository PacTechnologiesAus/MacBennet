import { TASK_KINDS, type TaskKind } from '@mac/protocol';

/**
 * Proposing what kind of work a task is (Sprint 3.3 §1, §7).
 *
 * ---------------------------------------------------------------------------
 * WHY A CLASSIFIER RATHER THAN A DROPDOWN ALONE
 *
 * The dropdown exists too — a human may always set the kind, and their choice
 * always wins. But the acceptance case for this sprint is a task somebody
 * already created and titled "Investigate PAC Project Registry, Document
 * Controller & Sales Engineer", and requiring them to go back and reclassify it
 * before Mac will look at it is the same failure this sprint is fixing, moved
 * one step earlier: the system knowing perfectly well what the work is and
 * making the human say it in the system's own vocabulary.
 *
 * So Mac reads the title and description and proposes. It is deliberately
 * DETERMINISTIC rather than model-backed: the classifier runs before discovery
 * has a model call to spare, its mistakes are cheap and visible, and a wrong
 * answer here is corrected by one click rather than by an investigation.
 *
 * The result is a PROPOSAL. `classifyTask` returns a confidence with it, and
 * the caller records the change in the audit trail so a reclassification is
 * never silent.
 * ---------------------------------------------------------------------------
 */

export interface Classification {
  kind: TaskKind;
  /** How strongly the text pointed here, in [0,1]. Not an execution gate. */
  confidence: number;
  /** The words that decided it, so a human can disagree with something specific. */
  signals: string[];
}

/**
 * Verb-led cues, weighted.
 *
 * Ordered by how decisive each is. "investigate" is a stronger signal for
 * investigation than "look at" is for anything, and a title that says both
 * "refactor" and "review" is more likely coding than analysis — which is why
 * coding's cues score highest when they appear at all.
 */
const CUES: Array<{ kind: TaskKind; weight: number; patterns: RegExp[] }> = [
  {
    kind: 'coding',
    weight: 1.0,
    patterns: [
      /\b(implement|refactor|fix|bug|patch|migrate|build|code|endpoint|api|schema|component|deploy script)\b/i,
      /\b(add|change|update|remove)\s+(the\s+)?(function|method|class|module|field|column|route|test)\b/i,
      /\b(pull request|merge|branch|commit|repository)\b/i,
    ],
  },
  {
    kind: 'investigation',
    weight: 0.95,
    patterns: [/\binvestigat\w*/i, /\bdiagnos\w*/i, /\broot cause\b/i, /\bwhy (is|does|did|are)\b/i, /\blook into\b/i],
  },
  {
    kind: 'research',
    weight: 0.9,
    patterns: [/\bresearch\w*/i, /\bfind out\b/i, /\bcompare\b/i, /\bevaluate\b/i, /\boptions\b/i, /\bfeasib\w*/i],
  },
  {
    kind: 'scoping',
    weight: 0.9,
    patterns: [/\bscop\w*/i, /\bestimat\w*/i, /\bbreak down\b/i, /\bplan\b/i, /\bproposal\b/i, /\bhow (big|long|much)\b/i],
  },
  {
    kind: 'analysis',
    weight: 0.85,
    patterns: [/\banalys\w*/i, /\banalyz\w*/i, /\bassess\w*/i, /\breview the\b/i, /\bimplications?\b/i],
  },
  {
    kind: 'documentation',
    weight: 0.85,
    patterns: [/\bdocument\w*/i, /\bwrite (up|a|the)\b/i, /\bdraft\b/i, /\bspecification\b/i, /\bhandbook\b/i, /\bguide\b/i],
  },
  {
    kind: 'administrative',
    weight: 0.6,
    patterns: [/\btidy\b/i, /\bclean up the\b/i, /\bcollate\b/i, /\bcompile a list\b/i, /\breconcile\b/i],
  },
];

/**
 * Classifies from the title and description.
 *
 * The title is weighted higher than the description because it is where people
 * put the verb: "Investigate X — we need to know whether Y before Z" is an
 * investigation, and the description's mention of an API endpoint should not
 * make it a coding task.
 */
export function classifyTask(input: { title: string; description?: string | null }): Classification {
  const title = input.title ?? '';
  const body = input.description ?? '';

  const scores = new Map<TaskKind, number>();
  const signals: string[] = [];

  for (const cue of CUES) {
    for (const pattern of cue.patterns) {
      const inTitle = pattern.exec(title);
      const inBody = pattern.exec(body);
      if (!inTitle && !inBody) continue;

      // Title cues count double: that is where the verb lives.
      const score = cue.weight * (inTitle ? 2 : 1);
      scores.set(cue.kind, (scores.get(cue.kind) ?? 0) + score);
      const matched = (inTitle ?? inBody)![0];
      if (!signals.includes(matched)) signals.push(matched);
    }
  }

  if (scores.size === 0) {
    /*
     * Nothing matched, and the honest answer is "I cannot tell".
     *
     * That is what the 0.2 confidence says, and every caller is expected to
     * apply a threshold rather than take the kind on its own. The kind returned
     * alongside it is therefore a FALLBACK, not a guess, and it is `coding`
     * for one specific reason: it is the schema default.
     *
     * A caller that ignores the confidence then lands in exactly the same state
     * as a caller that never ran the classifier at all. Returning anything else
     * would mean "classifier not run" and "classifier ran and was unsure"
     * produce different rows for the same task, which is the kind of divergence
     * nobody discovers until it matters.
     *
     * Both fallbacks block equally when wrong — coding demands a repository the
     * work may not need, research demands a model the work may not need — so
     * safety does not decide this; consistency does.
     */
    return { kind: 'coding', confidence: 0.2, signals: [] };
  }

  const ranked = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
  const [kind, top] = ranked[0]!;
  const runnerUp = ranked[1]?.[1] ?? 0;

  /*
   * Confidence reflects SEPARATION, not the raw score.
   *
   * A title that scores 4.0 for research and 3.8 for scoping is genuinely
   * ambiguous, and reporting that as high confidence would invite a human to
   * skim past a classification worth checking.
   */
  const separation = top > 0 ? (top - runnerUp) / top : 0;
  const confidence = Math.round(Math.min(0.95, 0.4 + separation * 0.55) * 100) / 100;

  return { kind, confidence, signals: signals.slice(0, 8) };
}

export const isKnownTaskKind = (value: string): value is TaskKind =>
  (TASK_KINDS as readonly string[]).includes(value);
