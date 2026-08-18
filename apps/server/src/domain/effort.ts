import type { EffortEstimate, EffortSizeClass, HandoffBriefContent, SafeStartVerdict } from '@mac/protocol';

/**
 * "Do not start work that cannot sensibly be left safe." (Sprint 3 §8.3, brief §11)
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS AND IS NOT
 *
 * It is not duration prediction. Nobody can derive minutes from a brief, and a
 * precise-looking number here would be a fabrication of exactly the kind the
 * usage model exists to prevent elsewhere.
 *
 * It is a size CLASS with a stated basis, used to answer one question: is there
 * enough of the night left that starting this is not obviously a bad idea? The
 * brief asks for exactly that — "it does not need perfect duration prediction,
 * it needs to avoid obviously bad scheduling" — and the estimate is recorded
 * alongside the decision so it can be tuned against what actually happened.
 * ---------------------------------------------------------------------------
 */

export interface EffortInput {
  brief: HandoffBriefContent | null;
  /** The board's own size column, when it has one. A human's estimate beats ours. */
  sizeLabel: string | null;
  /** Narrower than the brief, so smaller than the brief implies. */
  scopeKind: 'full' | 'limited';
}

const SIZE_MINUTES: Record<EffortSizeClass, number> = { small: 20, medium: 60, large: 150 };

/**
 * A human's size label, when the board carries one.
 *
 * Taken in preference to anything derived. Somebody who knows the codebase
 * writing "Large" is better evidence than counting acceptance criteria, and
 * ignoring it in favour of our own arithmetic would be arrogant.
 */
function fromLabel(label: string | null): EffortSizeClass | null {
  if (!label) return null;
  const key = label.trim().toLowerCase();
  if (['xs', 's', 'small', 'tiny', 'quick', '1', '2'].includes(key)) return 'small';
  if (['m', 'medium', 'normal', '3', '5'].includes(key)) return 'medium';
  if (['l', 'xl', 'large', 'big', 'epic', '8', '13', '21'].includes(key)) return 'large';
  return null;
}

export function estimateEffort(input: EffortInput): EffortEstimate {
  const labelled = fromLabel(input.sizeLabel);
  const brief = input.brief;

  const signals: string[] = [];
  let score = 0;

  if (brief) {
    const criteria = brief.acceptanceCriteria.length;
    const components = brief.likelyAffectedComponents.length;
    const considerations = brief.implementationConsiderations.length;

    score += criteria;
    score += components * 1.5;
    score += considerations * 0.5;
    signals.push(`${criteria} acceptance criterion/criteria`, `${components} affected component(s)`);

    // Things that are expensive whatever their size, because they need care
    // rather than typing.
    const text = [
      brief.userObjective,
      brief.desiredBehaviour,
      brief.proposedScope,
      ...brief.implementationConsiderations,
      ...brief.risks.map((r) => r.description ?? ''),
    ]
      .join(' ')
      .toLowerCase();

    if (/\bmigration|schema change|database\b/.test(text)) {
      score += 4;
      signals.push('touches a migration or schema');
    }
    if (/\bnew (library|dependency|package|service)\b|\brefactor\b|\barchitect/.test(text)) {
      score += 3;
      signals.push('architectural or dependency work');
    }
    if (brief.risks.length > 2) {
      score += 2;
      signals.push(`${brief.risks.length} recorded risks`);
    }
  } else {
    // No brief means no basis, and an unknown is treated as large rather than
    // small: guessing small on no information is how a night gets cut off
    // half-way through something that mattered.
    score = 12;
    signals.push('no handoff brief, so the size is unknown and assumed large');
  }

  if (input.scopeKind === 'limited') {
    score *= 0.6;
    signals.push('scope was explicitly narrowed by a human');
  }

  const derived: EffortSizeClass = score <= 4 ? 'small' : score <= 10 ? 'medium' : 'large';
  const sizeClass = labelled ?? derived;

  if (labelled) signals.unshift(`board size label "${input.sizeLabel}"`);

  return {
    sizeClass,
    minutes: SIZE_MINUTES[sizeClass],
    basis: `${signals.join('; ')}. Rough size class only — not a duration prediction.`,
    /*
     * Partial results are useful, and state is preservable, for essentially all
     * coding work: a worktree with three commits and a failing test is a real
     * artefact a human can pick up. The exception is work that would leave a
     * half-applied migration, which is not something to abandon at 07:59.
     */
    partialUseful: sizeClass !== 'large' || input.scopeKind === 'limited',
    preservable: !signals.some((s) => s.includes('migration')),
  };
}

export interface SafeStartPolicy {
  safetyFactor: number;
  wrapUpMinutes: number;
  minStartMinutes: number;
  largeTaskMinMinutes: number;
}

/**
 * Is there enough night left to start this?
 *
 * The wrap-up allowance is not padding: committing, running tests, reviewing the
 * diff, pushing and opening a pull request all happen after the agent stops, and
 * a task that consumes the whole runway produces an unreviewed branch instead of
 * a reviewable one.
 */
export function safeToStart(
  now: Date,
  cutoffAt: Date,
  estimate: EffortEstimate,
  policy: SafeStartPolicy,
): SafeStartVerdict {
  const remainingMinutes = Math.floor((cutoffAt.getTime() - now.getTime()) / 60_000);
  const requiredMinutes = Math.ceil(estimate.minutes * policy.safetyFactor + policy.wrapUpMinutes);

  if (remainingMinutes <= 0) {
    return { safe: false, reason: 'The cutoff has passed.', remainingMinutes, requiredMinutes };
  }

  if (remainingMinutes < policy.minStartMinutes) {
    return {
      safe: false,
      reason:
        `Only ${remainingMinutes} minute(s) remain, below the ${policy.minStartMinutes}-minute floor. ` +
        'Nothing new starts this close to the cutoff.',
      remainingMinutes,
      requiredMinutes,
    };
  }

  if (estimate.sizeClass === 'large' && remainingMinutes < policy.largeTaskMinMinutes) {
    return {
      safe: false,
      reason:
        `This looks like a large task and only ${remainingMinutes} minute(s) remain ` +
        `(large work needs ${policy.largeTaskMinMinutes}). Starting it would produce a half-finished branch ` +
        'rather than a reviewable one.',
      remainingMinutes,
      requiredMinutes,
    };
  }

  if (remainingMinutes >= requiredMinutes) {
    return {
      safe: true,
      reason: `${remainingMinutes} minute(s) remain and this needs about ${requiredMinutes}.`,
      remainingMinutes,
      requiredMinutes,
    };
  }

  /*
   * Short of the estimate, but the work is worth having half-done and can be
   * left safely.
   *
   * Spec §6 favours forward progress, and worktrees mean a partial result is a
   * real artefact rather than a mess. This is the one place the estimate is
   * allowed to be wrong in Mac's favour, and it is bounded by the floor above.
   */
  if (estimate.partialUseful && estimate.preservable) {
    return {
      safe: true,
      reason:
        `${remainingMinutes} minute(s) remain, short of the ~${requiredMinutes} this needs, but a partial ` +
        'result is useful and the work can be preserved mid-flight.',
      remainingMinutes,
      requiredMinutes,
    };
  }

  return {
    safe: false,
    reason:
      `${remainingMinutes} minute(s) remain and this needs about ${requiredMinutes}. ` +
      'A partial result would not be useful or could not be left safely.',
    remainingMinutes,
    requiredMinutes,
  };
}
