/**
 * Confidence policy (spec §5).
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
 */

export interface ConfidencePolicy {
  /** Hard floor. Not overridable through the API. */
  minExecutionConfidence: number;
  /** Autonomy threshold. Below it, approval requires explicit acknowledgement. */
  defaultConfidenceThreshold: number;
}

export type ConfidenceBand = 'below_floor' | 'limited_scope' | 'autonomous' | 'high_autonomy';

export function classifyConfidence(confidence: number, policy: ConfidencePolicy): ConfidenceBand {
  if (confidence < policy.minExecutionConfidence) return 'below_floor';
  if (confidence < policy.defaultConfidenceThreshold) return 'limited_scope';
  if (confidence < 0.9) return 'autonomous';
  return 'high_autonomy';
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
