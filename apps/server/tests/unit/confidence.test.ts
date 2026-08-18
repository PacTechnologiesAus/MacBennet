import { describe, expect, it } from 'vitest';
import {
  checkApprovalConfidence,
  classifyConfidence,
  parseConfidence,
  type ConfidencePolicy,
} from '../../src/domain/confidence.js';

const policy: ConfidencePolicy = { minExecutionConfidence: 0.6, defaultConfidenceThreshold: 0.8 };

describe('confidence bands (spec §5)', () => {
  it('classifies each documented band at its boundary', () => {
    expect(classifyConfidence(0.0, policy)).toBe('below_floor');
    expect(classifyConfidence(0.599, policy)).toBe('below_floor');
    expect(classifyConfidence(0.6, policy)).toBe('limited_scope');
    expect(classifyConfidence(0.799, policy)).toBe('limited_scope');
    expect(classifyConfidence(0.8, policy)).toBe('autonomous');
    expect(classifyConfidence(0.899, policy)).toBe('autonomous');
    expect(classifyConfidence(0.9, policy)).toBe('high_autonomy');
    expect(classifyConfidence(1.0, policy)).toBe('high_autonomy');
  });

  it('honours a reconfigured floor and threshold', () => {
    const strict: ConfidencePolicy = { minExecutionConfidence: 0.75, defaultConfidenceThreshold: 0.95 };
    expect(classifyConfidence(0.7, strict)).toBe('below_floor');
    expect(classifyConfidence(0.8, strict)).toBe('limited_scope');
    expect(classifyConfidence(0.96, strict)).toBe('high_autonomy');
  });
});

describe('approval confidence policy', () => {
  const ack = { acknowledgeBelowThreshold: true, hasNotes: true };
  const noAck = { acknowledgeBelowThreshold: false, hasNotes: false };

  it('approves without ceremony at or above the threshold', () => {
    const result = checkApprovalConfidence(0.85, policy, noAck);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.thresholdOverridden).toBe(false);
  });

  it('refuses below the floor even with acknowledgement and notes', () => {
    // Spec §5 states this as a prohibition, not a default. It is deliberately
    // not overridable through the API by anyone, including an admin.
    const result = checkApprovalConfidence(0.59, policy, ack);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('CONFIDENCE_BELOW_FLOOR');
      expect(result.message).toContain('cannot be overridden');
    }
  });

  it('refuses in the limited-scope band without explicit acknowledgement', () => {
    const result = checkApprovalConfidence(0.7, policy, noAck);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ACKNOWLEDGEMENT_REQUIRED');
  });

  it('refuses in the limited-scope band when acknowledged but not explained', () => {
    const result = checkApprovalConfidence(0.7, policy, { acknowledgeBelowThreshold: true, hasNotes: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ACKNOWLEDGEMENT_REQUIRED');
  });

  it('permits the limited-scope band when acknowledged and explained, and records the override', () => {
    const result = checkApprovalConfidence(0.7, policy, ack);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.band).toBe('limited_scope');
      expect(result.thresholdOverridden).toBe(true);
    }
  });

  it('refuses a run with no recorded confidence at all', () => {
    const result = checkApprovalConfidence(null, policy, ack);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CONFIDENCE_BELOW_FLOOR');
  });

  it('treats the floor itself as permitted, not excluded', () => {
    expect(checkApprovalConfidence(0.6, policy, ack).ok).toBe(true);
    expect(checkApprovalConfidence(0.5999, policy, ack).ok).toBe(false);
  });
});

describe('parseConfidence', () => {
  it('reads the string form node-postgres returns for numeric columns', () => {
    expect(parseConfidence('0.850')).toBe(0.85);
    expect(parseConfidence(0.85)).toBe(0.85);
  });

  it('maps absent and unparseable values to null rather than NaN', () => {
    expect(parseConfidence(null)).toBeNull();
    expect(parseConfidence(undefined)).toBeNull();
    expect(parseConfidence('not a number')).toBeNull();
  });
});
