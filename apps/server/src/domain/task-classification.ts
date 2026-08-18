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
      // `commit` and `repository` only as ACTIONS. The real acceptance task's
      // description says "record the exact Company context version and commit
      // SHA", where `commit` is a provenance noun and says nothing whatever
      // about whether the work involves writing code.
      /\b(pull request|merge the|branch off|git commit|commit (?:the|a|these) chang\w*)\b/i,
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
    /*
     * Verb-led, deliberately.
     *
     * A bare "document-anything" pattern matched "Document Controller" - a noun phrase naming
     * a THING - and turned the real acceptance task, "Investigate PAC Project
     * Registry, Document Controller & Sales Engineer", into a near-tie between
     * investigation and documentation. What a piece of work is ABOUT is not a
     * statement about what kind of work it is.
     */
    patterns: [
      /\bdocument (the|a|an|our|this|these)\b/i,
      /\bdocumentation (for|of|on)\b/i,
      /\bwrite (up|a|an|the)\b/i,
      /\bdraft\b/i,
      /\bspecification\b/i,
      /\bhandbook\b/i,
      /\bwrite[^.]{0,20}\bguide\b/i,
    ],
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

/**
 * The first match of `pattern` that is not preceded by a negation.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * The real acceptance task's description contains the sentence:
 *
 *   "This is **research, engineering analysis and scoping only**. Do not
 *    implement anything."
 *
 * which is about as clear a statement as an engineer can make that the work is
 * not coding. The first version of this classifier read the word "implement",
 * scored it as coding evidence, and reported the classification as uncertain —
 * so the task stayed labelled `coding` and went on demanding a repository.
 *
 * A negated cue is not weak evidence for its category. It is usually strong
 * evidence against it, and the cheapest correct thing to do is refuse to count
 * it at all. Counting it negatively would be better still, and is a reasonable
 * later refinement; not counting a sentence backwards is the part that matters.
 * ---------------------------------------------------------------------------
 */
function firstUnnegated(pattern: RegExp, text: string): RegExpExecArray | null {
  if (!text) return null;
  // A fresh global copy, so callers are not affected by `lastIndex` state.
  const scan = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);

  let match: RegExpExecArray | null;
  while ((match = scan.exec(text)) !== null) {
    // Enough room for "do not " / "without " / "never " and a word between.
    const preceding = text.slice(Math.max(0, match.index - 28), match.index).toLowerCase();
    if (!NEGATION.test(preceding)) return match;
    if (match.index === scan.lastIndex) scan.lastIndex += 1;
  }
  return null;
}

const NEGATION = /\b(do not|don't|does not|doesn't|no|not|never|without|avoid|rather than|instead of)\b[^.;:]{0,20}$/;

export function classifyTask(input: { title: string; description?: string | null }): Classification {
  const title = input.title ?? '';
  const body = input.description ?? '';

  const scores = new Map<TaskKind, number>();
  const signals: string[] = [];

  for (const cue of CUES) {
    for (const pattern of cue.patterns) {
      const inTitle = firstUnnegated(pattern, title);
      const inBody = firstUnnegated(pattern, body);
      if (!inTitle && !inBody) continue;

      /*
       * Three tiers, because position carries real information.
       *
       * A title that OPENS with the cue is somebody stating the verb first —
       * "Investigate X", "Scope Y" — and that is the strongest signal available.
       * Elsewhere in the title is next. In the description it is weakest,
       * because a description names the subject matter and a subject is not a
       * statement about what kind of work it is.
       */
      const leading = inTitle !== null && inTitle.index <= 2;
      const score = cue.weight * (leading ? 3 : inTitle ? 2 : 1);
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

  /*
   * Confidence measures separation from the OTHER CAPABILITY, not from the
   * runner-up.
   *
   * ---------------------------------------------------------------------
   * WHY, AND WHAT IT FIXES
   *
   * The first version compared the winner to whatever scored second. On the
   * real acceptance task — "Investigate PAC Project Registry, Document
   * Controller & Sales Engineer", whose description says in terms "this is
   * research, engineering analysis and scoping only" — that produced 0.56 and
   * the task was left classified as coding. Four general kinds all scored,
   * so they diluted one another and the classification was reported as
   * uncertain when it was nothing of the sort.
   *
   * Investigation versus research versus scoping is not a consequential
   * ambiguity: all three resolve to the same capability, the same job kind and
   * the same requirement set. Getting the wrong one changes a label. The
   * ambiguity that MATTERS is coding versus general, because that decides
   * whether the work needs a repository, a worktree and a pull request.
   *
   * So confidence answers the question the threshold is actually gating.
   * Within-group runners-up remain visible in `signals`, where a human can see
   * that "scoping" was also plausible and change it in one click.
   * ---------------------------------------------------------------------
   */
  const winningCapability = CAPABILITY_OF[kind];
  const rival = ranked.find(([k]) => CAPABILITY_OF[k] !== winningCapability)?.[1] ?? 0;

  const separation = top > 0 ? (top - rival) / top : 0;
  const confidence = Math.round(Math.min(0.95, 0.4 + separation * 0.55) * 100) / 100;

  return { kind, confidence, signals: signals.slice(0, 8) };
}

/**
 * Which capability each kind resolves to.
 *
 * Duplicated from the protocol's descriptors rather than imported so this
 * module stays a pure lookup, and asserted against them by a test so the two
 * cannot drift.
 */
const CAPABILITY_OF: Record<TaskKind, 'coding' | 'general'> = {
  coding: 'coding',
  research: 'general',
  analysis: 'general',
  investigation: 'general',
  scoping: 'general',
  documentation: 'general',
  administrative: 'general',
};

export const isKnownTaskKind = (value: string): value is TaskKind =>
  (TASK_KINDS as readonly string[]).includes(value);
