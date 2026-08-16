import { describe, expect, it } from 'vitest';
import {
  adviseExecution,
  checkApprovalConfidence,
  classifyConfidence,
  decideAction,
  toScaled,
  type ConfidencePolicy,
} from '../../src/domain/confidence.js';

/**
 * The exact boundary list Sprint 2 §7 requires: 0.59, 0.60, 0.79, 0.80, 0.89,
 * 0.90 — each asserted for the behaviour the specification attaches to it, not
 * merely for a band label.
 */

const policy: ConfidencePolicy = { minExecutionConfidence: 0.6, defaultConfidenceThreshold: 0.8 };
const decisionPolicy = { answerConfidenceThreshold: 0.8, minExecutionConfidence: 0.6 };

describe('confidence boundaries — the six required values', () => {
  it('0.59 — execution prohibited, and the floor is not overridable', () => {
    const advice = adviseExecution(0.59, policy);
    expect(advice.band).toBe('below_floor');
    expect(advice.executionPermitted).toBe(false);
    expect(advice.message).toContain('cannot be overridden');

    // Not even with acknowledgement, notes, and an administrator behind it:
    // there is no parameter in the API that relaxes this.
    const approval = checkApprovalConfidence(0.59, policy, { acknowledgeBelowThreshold: true, hasNotes: true });
    expect(approval.ok).toBe(false);
    if (!approval.ok) expect(approval.code).toBe('CONFIDENCE_BELOW_FLOOR');
  });

  it('0.60 — limited scope, permitted only with explicit human approval of that scope', () => {
    const advice = adviseExecution(0.6, policy);
    expect(advice.band).toBe('limited_scope');
    expect(advice.executionPermitted).toBe(true);
    expect(advice.scopeKind).toBe('limited');
    expect(advice.requiresExplicitScopeApproval).toBe(true);

    expect(checkApprovalConfidence(0.6, policy, { acknowledgeBelowThreshold: false, hasNotes: false }).ok).toBe(false);
    expect(checkApprovalConfidence(0.6, policy, { acknowledgeBelowThreshold: true, hasNotes: true }).ok).toBe(true);
  });

  it('0.79 — still limited scope', () => {
    const advice = adviseExecution(0.79, policy);
    expect(advice.band).toBe('limited_scope');
    expect(advice.requiresExplicitScopeApproval).toBe(true);

    const approval = checkApprovalConfidence(0.79, policy, { acknowledgeBelowThreshold: true, hasNotes: true });
    expect(approval.ok).toBe(true);
    if (approval.ok) expect(approval.thresholdOverridden).toBe(true);
  });

  it('0.80 — autonomous after normal approval, no extra ceremony', () => {
    const advice = adviseExecution(0.8, policy);
    expect(advice.band).toBe('autonomous');
    expect(advice.scopeKind).toBe('full');
    expect(advice.requiresExplicitScopeApproval).toBe(false);
    expect(advice.highAutonomy).toBe(false);

    const approval = checkApprovalConfidence(0.8, policy, { acknowledgeBelowThreshold: false, hasNotes: false });
    expect(approval.ok).toBe(true);
    if (approval.ok) expect(approval.thresholdOverridden).toBe(false);
  });

  it('0.89 — still autonomous, not yet high autonomy', () => {
    const advice = adviseExecution(0.89, policy);
    expect(advice.band).toBe('autonomous');
    expect(advice.highAutonomy).toBe(false);
  });

  it('0.90 — high autonomy within existing guardrails', () => {
    const advice = adviseExecution(0.9, policy);
    expect(advice.band).toBe('high_autonomy');
    expect(advice.highAutonomy).toBe(true);
    expect(advice.executionPermitted).toBe(true);
  });
});

describe('boundary comparisons are integer, not floating point', () => {
  it('treats a value produced by arithmetic as equal to the literal threshold', () => {
    // 0.1 + 0.7 is 0.7999999999999999 in IEEE-754. A naive `>= 0.8` puts this
    // in the limited-scope band and demands an acknowledgement the
    // specification does not ask for — a weighted gap analysis summing to
    // exactly 0.8 would hit precisely this.
    const arithmetic = 0.1 + 0.7;
    expect(arithmetic === 0.8).toBe(false); // the hazard is real
    expect(classifyConfidence(arithmetic, policy)).toBe('autonomous');
  });

  it('treats a high-autonomy value produced by arithmetic as high autonomy', () => {
    const arithmetic = 0.7 + 0.2; // 0.8999999999999999
    expect(arithmetic === 0.9).toBe(false);
    expect(classifyConfidence(arithmetic, policy)).toBe('high_autonomy');
  });

  it('treats 0.1 + 0.2 as 0.3 for band purposes', () => {
    expect(toScaled(0.1 + 0.2)).toBe(toScaled(0.3));
  });

  it('still distinguishes a genuine value below the floor from the floor itself', () => {
    // The fix must not be so coarse that it rounds sub-threshold values UP
    // across the floor, which would be a worse bug than the one it prevents.
    expect(classifyConfidence(0.5999, policy)).toBe('below_floor');
    expect(classifyConfidence(0.6, policy)).toBe('limited_scope');
  });

  it('is exact at every documented boundary regardless of how the number was built', () => {
    for (const [a, b] of [[0.6, 0.3 + 0.3], [0.8, 0.4 + 0.4], [0.9, 0.45 + 0.45]] as const) {
      expect(classifyConfidence(b, policy)).toBe(classifyConfidence(a, policy));
    }
  });
});

describe('decision policy during execution (Sprint 2 §9)', () => {
  const safe = { risk: 'low' as const, reversible: true, withinApprovedScope: true };

  it('answers outright at or above the answering threshold', () => {
    const outcome = decideAction({ confidence: 0.85, ...safe }, decisionPolicy);
    expect(outcome.action).toBe('answer');
    expect(outcome.flag).toBe(false);
  });

  it('assumes and flags below the threshold when reversible, in scope and low risk', () => {
    const outcome = decideAction({ confidence: 0.7, ...safe }, decisionPolicy);
    expect(outcome.action).toBe('assume');
    expect(outcome.flag).toBe(true);
  });

  it('blocks below the execution floor when the decision is not low risk', () => {
    const outcome = decideAction({ confidence: 0.4, ...safe, risk: 'medium' }, decisionPolicy);
    expect(outcome.action).toBe('block');
    expect(outcome.reason).toContain('execution floor');
  });

  it('still makes a conservative flagged assumption below the floor when the choice is trivially reversible', () => {
    // Spec §6 favours forward progress. Blocking every small question Mac
    // cannot cite a document for would make him useless overnight; the
    // protection is that the choice is reversible, low risk, in scope, recorded
    // at its real confidence, and flagged.
    const outcome = decideAction({ confidence: 0.1, ...safe }, decisionPolicy);
    expect(outcome.action).toBe('assume');
    expect(outcome.flag).toBe(true);
  });

  it('blocks an irreversible decision even in the assumption band', () => {
    const outcome = decideAction({ confidence: 0.7, ...safe, reversible: false }, decisionPolicy);
    expect(outcome.action).toBe('block');
  });

  it('blocks a high-risk decision even at very high confidence', () => {
    // Risk is evaluated before confidence. A confident wrong answer to "shall I
    // drop this table" is worse than an unconfident one.
    const outcome = decideAction({ confidence: 0.99, ...safe, risk: 'high' }, decisionPolicy);
    expect(outcome.action).toBe('block');
    expect(outcome.reason).toContain('high risk');
  });

  it('blocks a sensitive decision even at very high confidence and low nominal risk', () => {
    const outcome = decideAction({ confidence: 0.99, ...safe, sensitive: true }, decisionPolicy);
    expect(outcome.action).toBe('block');
  });

  it('blocks anything outside the approved scope, however confident', () => {
    const outcome = decideAction({ confidence: 0.99, ...safe, withinApprovedScope: false }, decisionPolicy);
    expect(outcome.action).toBe('block');
    expect(outcome.reason).toContain('outside the scope');
  });
});
