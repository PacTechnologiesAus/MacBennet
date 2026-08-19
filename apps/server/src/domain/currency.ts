import type { InformationCurrency, VolatilityCategory } from '@mac/protocol';

/**
 * Whether a question's answer changes over time (Phase 4 Part E §19).
 *
 * ---------------------------------------------------------------------------
 * WHY THE QUESTION AND NOT THE ANSWER
 *
 * "What is the currently supported version of TIA Portal" and "what is a ladder
 * logic rung" are both things a model answers fluently from memory. One of
 * those answers is fine and the other is a guess whose staleness is invisible —
 * and you cannot tell which by reading them, because both arrive in the same
 * confident register.
 *
 * So the judgement is made about the QUESTION, before anything has been
 * answered. A volatile question with no external source becomes an unmet
 * acceptance criterion, which is a fact about the run rather than a caveat
 * buried in a paragraph somebody will skim.
 *
 * ---------------------------------------------------------------------------
 * THE ASYMMETRY THIS ENCODES
 *
 * Calling a stable question volatile costs a search. Calling a volatile
 * question stable produces a confident, wrong, current-sounding answer with
 * nothing marking it as old.
 *
 * Those are not comparable, so the classifier leans towards `volatile` — a
 * single cue is enough, and there is no scoring contest to lose.
 * ---------------------------------------------------------------------------
 */

export interface CurrencyAssessment {
  currency: InformationCurrency;
  categories: VolatilityCategory[];
  /** The words that decided it. */
  signals: string[];
}

const CUES: Array<{ category: VolatilityCategory; patterns: RegExp[] }> = [
  {
    category: 'software_version',
    patterns: [
      /\b(latest|current|newest|most recent) (version|release|build)\b/i,
      /\bversion \d/i,
      /\b(v\d+\.\d+|\d+\.\d+\.\d+)\b/,
      /\b(upgrade|update) path\b/i,
      /\bwhich version\b/i,
      /\brelease notes\b/i,
    ],
  },
  {
    category: 'vendor_support',
    patterns: [
      /\b(end[- ]of[- ](life|support|sale)|eol|eos)\b/i,
      /\b(still |currently )?supported\b/i,
      /\bdiscontinued\b/i,
      /\bobsolet\w*/i,
      /\blifecycle\b/i,
      /\bsupport (status|window|until)\b/i,
    ],
  },
  {
    category: 'pricing',
    patterns: [
      /\b(price|pricing|cost|costs|quote|rrp|licen[cs]e fee|subscription fee)\b/i,
      /\bhow much (does|is|would)\b/i,
      /\$\s?\d/,
      /\b(per (seat|user|month|year|device))\b/i,
    ],
  },
  {
    category: 'product_availability',
    patterns: [
      /\b(available|availability|in stock|lead time|back ?order|supply)\b/i,
      /\bcan (we|you) (still )?(buy|order|source|get)\b/i,
      /\bstill (sold|made|manufactured|produced)\b/i,
    ],
  },
  {
    category: 'company_roles',
    patterns: [
      /\bwho (is|are|leads|runs|heads|owns|manages)\b/i,
      /\b(current|new) (ceo|cto|manager|director|owner|contact)\b/i,
      /\bcontact (details|person|for)\b/i,
    ],
  },
  {
    category: 'tenders',
    patterns: [/\btender\w*/i, /\b(rfq|rft|rfp|eoi)\b/i, /\bbid\b/i, /\b(closing|submission) date\b/i],
  },
  {
    category: 'regulation',
    patterns: [
      /\b(regulation|regulatory|complian\w*|standard|legislation|legal requirement)\b/i,
      /\b(as\/nzs|iec \d|iso \d|ansi|osha|whs)\b/i,
      /\bcurrently required\b/i,
      /\bmandat\w*/i,
    ],
  },
  {
    category: 'external_announcements',
    patterns: [
      /\b(announce\w*|released|launched|acquired|acquisition|merger)\b/i,
      /\b(recent|latest|this year|20\d\d)\b/i,
      /\bnews\b/i,
      /\broadmap\b/i,
    ],
  },
];

export function assessCurrency(text: string): CurrencyAssessment {
  const body = text ?? '';
  const categories: VolatilityCategory[] = [];
  const signals: string[] = [];

  for (const cue of CUES) {
    for (const pattern of cue.patterns) {
      const match = pattern.exec(body);
      if (!match) continue;
      if (!categories.includes(cue.category)) categories.push(cue.category);
      if (!signals.includes(match[0])) signals.push(match[0].slice(0, 40));
      break;
    }
  }

  return {
    currency: categories.length > 0 ? 'volatile' : 'stable',
    categories,
    signals: signals.slice(0, 8),
  };
}

/**
 * The sentence Mac puts in front of a volatile question with no external source.
 *
 * Phrased as a limitation of the ANSWER rather than as an apology, because a
 * reader skimming a report needs the caveat attached to the claim rather than
 * filed under caveats.
 */
export function currencyWarning(assessment: CurrencyAssessment): string | null {
  if (assessment.currency === 'stable') return null;

  const subjects = assessment.categories.map((c) => c.replace(/_/g, ' ')).join(', ');
  return (
    `This question turns on information that changes over time (${subjects}), and no external source was ` +
    'retrieved to verify it. Anything stated here about the current position is unverified and should be ' +
    'checked before it is acted on.'
  );
}
