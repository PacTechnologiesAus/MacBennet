/**
 * Confidence policy (spec §5, Sprint 2 §7).
 *
 * The spec's bands:
 *   < 60%    Mac must not begin substantive implementation.
 *   60–79%   Limited scope, only with an explicit human decision.
 *   80–89%   May execute autonomously after approval.
 *   90%+     High autonomy within guardrails.
 *
 * These are represented as two configurable numbers rather than four hard-coded
 * bands, because what actually changes behaviour is where the two boundaries
 * sit: the floor below which nothing may run at all, and the threshold above
 * which approval needs no extra ceremony.
 *
 * Everything here is a fraction in [0,1]. Percentages exist only in the UI.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY COMPARISON BELOW IS ON INTEGERS
 *
 * Sprint 2 requires that boundary behaviour be unambiguous at 0.59, 0.60, 0.79,
 * 0.80, 0.89 and 0.90. Binary floating point cannot represent any of those
 * exactly, so `0.8 <= 0.8` is safe but `0.79 + 0.01 <= 0.8` is not, and a
 * confidence arriving from arithmetic (a weighted gap analysis, say) can land a
 * hair below a threshold it was meant to meet.
 *
 * So the domain converts to a fixed-point INTEGER once, at the boundary, and
 * every band decision after that is integer arithmetic. There is no float
 * comparison anywhere in this file's decision logic.
 *
 * The scale is 1e6, not the 1e3 of the storage column, and the difference
 * matters. Rounding to thousandths would promote 0.5999 to 0.600 and let a
 * value below the floor be approved — the exact class of silent boundary bug
 * this is meant to prevent. At 1e6 the rounding absorbs floating-point
 * artefacts (which are ~1e-16 relative, so around 1e-10 here) while preserving
 * every genuine difference the API can express. `0.79 + 0.01` compares equal to
 * `0.8`; `0.5999` stays below `0.6`.
 * ---------------------------------------------------------------------------
 */

export interface ConfidencePolicy {
  /** Hard floor. Not overridable through the API. */
  minExecutionConfidence: number;
  /** Autonomy threshold. Below it, approval requires explicit acknowledgement. */
  defaultConfidenceThreshold: number;
}

/** Fixed-point scale for every confidence comparison. See the header note. */
export const CONFIDENCE_SCALE = 1_000_000;

/** High-autonomy boundary from spec §5. Fixed at 90%. */
export const HIGH_AUTONOMY_SCALED = 0.9 * CONFIDENCE_SCALE;

/**
 * Converts a fraction in [0,1] to a fixed-point integer.
 *
 * `Math.round` rather than truncation: 0.8 is the double nearest 0.8, and
 * `0.29 * 1e6` is 289999.99999999994 — truncating that drops a band by one
 * unit for no reason. Rounding at this scale is exact for every value the API
 * can meaningfully express.
 */
export const toScaled = (confidence: number): number => Math.round(confidence * CONFIDENCE_SCALE);

export type ConfidenceBand = 'below_floor' | 'limited_scope' | 'autonomous' | 'high_autonomy';

export function classifyConfidence(confidence: number, policy: ConfidencePolicy): ConfidenceBand {
  const value = toScaled(confidence);
  const floor = toScaled(policy.minExecutionConfidence);
  const threshold = toScaled(policy.defaultConfidenceThreshold);

  if (value < floor) return 'below_floor';
  if (value < threshold) return 'limited_scope';
  if (value < HIGH_AUTONOMY_SCALED) return 'autonomous';
  return 'high_autonomy';
}

/** What Mac is permitted to do at a given understanding confidence. */
export interface ExecutionAdvice {
  band: ConfidenceBand;
  executionPermitted: boolean;
  scopeKind: 'full' | 'limited';
  /** True in the 60–79% band: the human must approve the narrowed scope itself. */
  requiresExplicitScopeApproval: boolean;
  /** True at 90%+: Mac may make more of his own calls within existing guardrails. */
  highAutonomy: boolean;
  message: string;
}

export function adviseExecution(confidence: number | null, policy: ConfidencePolicy): ExecutionAdvice {
  if (confidence === null) {
    return {
      band: 'below_floor',
      executionPermitted: false,
      scopeKind: 'limited',
      requiresExplicitScopeApproval: false,
      highAutonomy: false,
      message: 'No confidence has been calculated yet. Discovery must continue before execution.',
    };
  }

  const band = classifyConfidence(confidence, policy);

  switch (band) {
    case 'below_floor':
      return {
        band,
        executionPermitted: false,
        scopeKind: 'limited',
        requiresExplicitScopeApproval: false,
        highAutonomy: false,
        message:
          `Understanding is ${pct(confidence)}, below the ${pct(policy.minExecutionConfidence)} floor. ` +
          'Execution is prohibited and this floor cannot be overridden by anyone, including an administrator. ' +
          'More discovery is required.',
      };
    case 'limited_scope':
      return {
        band,
        executionPermitted: true,
        scopeKind: 'limited',
        requiresExplicitScopeApproval: true,
        highAutonomy: false,
        message:
          `Understanding is ${pct(confidence)}, below the ${pct(policy.defaultConfidenceThreshold)} autonomy ` +
          'threshold. Mac may propose a limited scope, which a human must approve explicitly.',
      };
    case 'autonomous':
      return {
        band,
        executionPermitted: true,
        scopeKind: 'full',
        requiresExplicitScopeApproval: false,
        highAutonomy: false,
        message: `Understanding is ${pct(confidence)}. Mac may execute autonomously after normal approval, making reasonable assumptions and recording them.`,
      };
    case 'high_autonomy':
      return {
        band,
        executionPermitted: true,
        scopeKind: 'full',
        requiresExplicitScopeApproval: false,
        highAutonomy: true,
        message: `Understanding is ${pct(confidence)}. Mac may execute with high autonomy within existing guardrails.`,
      };
  }
}

export type ApprovalCheck =
  | { ok: true; band: ConfidenceBand; thresholdOverridden: boolean }
  | { ok: false; code: 'CONFIDENCE_BELOW_FLOOR' | 'ACKNOWLEDGEMENT_REQUIRED'; message: string; band: ConfidenceBand };

/**
 * Decides whether an approval may proceed.
 *
 * Note the asymmetry, which is deliberate: the floor cannot be overridden by
 * anyone through the API (spec §5 states it as a prohibition, not a default),
 * whereas the threshold can be crossed by a human who explicitly acknowledges
 * that they are authorising limited-confidence work and says why.
 */
export function checkApprovalConfidence(
  confidence: number | null,
  policy: ConfidencePolicy,
  opts: { acknowledgeBelowThreshold: boolean; hasNotes: boolean },
): ApprovalCheck {
  if (confidence === null) {
    return {
      ok: false,
      code: 'CONFIDENCE_BELOW_FLOOR',
      message: 'A run cannot be approved without a recorded confidence value.',
      band: 'below_floor',
    };
  }

  const band = classifyConfidence(confidence, policy);

  if (band === 'below_floor') {
    return {
      ok: false,
      code: 'CONFIDENCE_BELOW_FLOOR',
      message:
        `Confidence ${pct(confidence)} is below the minimum execution confidence of ` +
        `${pct(policy.minExecutionConfidence)}. More discovery is required; this floor cannot be overridden.`,
      band,
    };
  }

  if (band === 'limited_scope') {
    if (!opts.acknowledgeBelowThreshold || !opts.hasNotes) {
      return {
        ok: false,
        code: 'ACKNOWLEDGEMENT_REQUIRED',
        message:
          `Confidence ${pct(confidence)} is below the autonomy threshold of ` +
          `${pct(policy.defaultConfidenceThreshold)}. Approving anyway requires ` +
          `acknowledgeBelowThreshold=true and notes explaining the limited scope.`,
        band,
      };
    }
    return { ok: true, band, thresholdOverridden: true };
  }

  return { ok: true, band, thresholdOverridden: false };
}

// ---------------------------------------------------------------------------
// Decision confidence during execution (Sprint 2 §9)
// ---------------------------------------------------------------------------

export type DecisionRisk = 'low' | 'medium' | 'high';

/**
 * What Mac does with a decision he has to make mid-run.
 *
 *   answer  — confident enough to just answer, and continue.
 *   assume  — not confident, but the decision is reversible, in scope and
 *             low-consequence: take the safest option, record it, FLAG it,
 *             and continue. Spec §6 favours forward progress over blocking.
 *   block   — do not guess. Record a blocker, leave that portion unimplemented,
 *             and let independent work continue (Sprint 2 §10).
 */
export type DecisionAction = 'answer' | 'assume' | 'block';

export interface DecisionInput {
  confidence: number;
  risk: DecisionRisk;
  /** Can the effect be undone cheaply if the assumption turns out wrong? */
  reversible: boolean;
  /** Is this within the scope the human actually approved? */
  withinApprovedScope: boolean;
  /** Destructive, security-sensitive or architecturally irreversible. */
  sensitive?: boolean;
}

export interface DecisionOutcome {
  action: DecisionAction;
  /** True when the outcome must be surfaced prominently for human review. */
  flag: boolean;
  reason: string;
}

/**
 * The decision policy.
 *
 * Read the order of the checks carefully: risk is evaluated BEFORE confidence.
 * That is the whole point. A confident wrong answer to "shall I drop this
 * table" is worse than an unconfident one, so high risk blocks regardless of
 * how sure Mac feels. Confidence only decides between answering and assuming
 * once the decision is already known to be safe to make at all.
 */
export function decideAction(input: DecisionInput, policy: { answerConfidenceThreshold: number; minExecutionConfidence: number }): DecisionOutcome {
  // --- The four unconditional blocks. Risk is evaluated BEFORE confidence. ---

  if (input.sensitive) {
    return {
      action: 'block',
      flag: true,
      reason: 'The decision is destructive, security-sensitive or architecturally irreversible. Mac does not guess about these.',
    };
  }

  if (input.risk === 'high') {
    return {
      action: 'block',
      flag: true,
      reason: 'The decision is high risk. Mac blocks this portion of the work rather than guessing, and continues with independent work.',
    };
  }

  if (!input.withinApprovedScope) {
    return {
      action: 'block',
      flag: true,
      reason: 'The decision falls outside the scope the human approved. Mac will not widen his own mandate.',
    };
  }

  const value = toScaled(input.confidence);
  const answerAt = toScaled(policy.answerConfidenceThreshold);
  const floor = toScaled(policy.minExecutionConfidence);

  if (value >= answerAt) {
    return { action: 'answer', flag: false, reason: 'Confidence is at or above the answering threshold.' };
  }

  if (!input.reversible) {
    return {
      action: 'block',
      flag: true,
      reason: `Confidence ${pct(input.confidence)} is below the ${pct(policy.answerConfidenceThreshold)} answering threshold and the decision is not easily reversible. Mac does not make an unrecoverable choice on a hunch.`,
    };
  }

  /*
   * Below the execution floor, Mac has essentially no supporting source.
   *
   * For a MEDIUM-risk decision — architectural, a new dependency, anything
   * expensive to unwind — that is not enough to proceed on, so it blocks. For a
   * genuinely reversible, low-risk choice it is not a reason to stop: spec §6
   * says Mac should favour forward progress, and blocking every small question
   * he cannot cite a document for would make him useless overnight. He takes the
   * conservative option, records it honestly at its real confidence, and flags it.
   */
  if (value < floor && input.risk !== 'low') {
    return {
      action: 'block',
      flag: true,
      reason: `Confidence ${pct(input.confidence)} is below the ${pct(policy.minExecutionConfidence)} execution floor and the decision is not low risk. Mac has no basis for even a safe assumption.`,
    };
  }

  return {
    action: 'assume',
    flag: true,
    reason:
      `Confidence ${pct(input.confidence)} is below the ${pct(policy.answerConfidenceThreshold)} answering threshold, ` +
      'but the decision is reversible, in scope and low risk. Mac takes the safest reasonable option, records it, and flags it for review.',
  };
}

const pct = (value: number): string => `${Math.round(value * 1000) / 10}%`;

export const formatConfidencePercent = pct;

/**
 * Parses a numeric(4,3) column, which node-postgres returns as a string to
 * avoid silent precision loss.
 */
export function parseConfidence(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}
