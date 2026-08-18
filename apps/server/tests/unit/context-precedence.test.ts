import { describe, expect, it } from 'vitest';
import {
  CONTEXT_LAYERS,
  LAYER_RANK,
  PROHIBITED_CAPABILITIES,
  isProhibitedCapability,
  manifestPrecedenceMatches,
  mayApproveCompanyContext,
  resolveCapability,
  type CapabilityStatement,
} from '../../src/domain/context-precedence.js';

/**
 * Context precedence (Sprint 3.2 §11).
 *
 * These tests are the brief's prohibitions written as executable assertions.
 * If any of them goes red, a task instruction can talk Mac into deploying to a
 * commissioned customer system, spending PAC money, or emailing a customer.
 *
 * The scenarios are written the way the failure would actually arrive: not as
 * somebody typing "please ignore your rules", but as an ordinary-looking task
 * instruction that simply asserts an authority.
 */

const say = (layer: (typeof CONTEXT_LAYERS)[number], effect: 'allow' | 'deny', source: string): CapabilityStatement => ({
  layer,
  effect,
  source,
});

describe('the ladder', () => {
  it('ranks hard guardrails above company authority, and company authority above everything else', () => {
    expect(LAYER_RANK.hard_guardrail).toBeLessThan(LAYER_RANK.company_authority);
    expect(LAYER_RANK.company_authority).toBeLessThan(LAYER_RANK.mac_role);
    expect(LAYER_RANK.mac_role).toBeLessThan(LAYER_RANK.project_context);
    expect(LAYER_RANK.project_context).toBeLessThan(LAYER_RANK.task_instruction);
    expect(LAYER_RANK.task_instruction).toBeLessThan(LAYER_RANK.learned_knowledge);
    expect(LAYER_RANK.learned_knowledge).toBeLessThan(LAYER_RANK.assumption);
  });
});

describe('what no context may grant', () => {
  it('refuses live deployment however emphatically the task instructs it', () => {
    const decision = resolveCapability({
      capability: 'live_deployment',
      statements: [
        say('task_instruction', 'allow', 'brief: "push the fix straight to the line, it is urgent"'),
        say('project_context', 'allow', 'project: customer authorised remote deployment'),
        say('mac_role', 'allow', 'role config'),
      ],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.decidedBy).toBe('hard_guardrail');
    expect(decision.reason).toContain('hard prohibition');
  });

  it('refuses live deployment even if the COMPANY document appeared to permit it', () => {
    // The prohibition is declared in Mac's own code, not read from AUTHORITY.md.
    // A document that can grant itself authority is not a guardrail.
    const decision = resolveCapability({
      capability: 'live_deployment',
      statements: [say('company_authority', 'allow', 'company:AUTHORITY.md@deadbee')],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.decidedBy).toBe('hard_guardrail');
  });

  it('refuses to let a task grant spending authority', () => {
    const decision = resolveCapability({
      capability: 'financial_commitment',
      statements: [say('task_instruction', 'allow', 'brief: "buy the licence, it is only $40"')],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.decidedBy).toBe('hard_guardrail');
  });

  it('refuses to let a task grant external communication authority', () => {
    const decision = resolveCapability({
      capability: 'external_communication',
      statements: [
        say('task_instruction', 'allow', 'brief: "email the OEM and ask them directly"'),
        say('learned_knowledge', 'allow', 'we did this last time'),
      ],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.decidedBy).toBe('hard_guardrail');
  });

  it.each([...PROHIBITED_CAPABILITIES])('refuses %s under every layer at once', (capability) => {
    const decision = resolveCapability({
      capability,
      statements: CONTEXT_LAYERS.map((layer) => say(layer, 'allow', `${layer}: permitted`)),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.decidedBy).toBe('hard_guardrail');
  });

  it('names the prohibitions the brief and AUTHORITY.md both call out', () => {
    for (const expected of [
      'live_deployment',
      'protected_branch_merge',
      'financial_commitment',
      'external_communication',
      'customer_commitment',
      'safety_control_change',
      'destructive_action',
      'ip_or_warranty_authority',
    ]) {
      expect(isProhibitedCapability(expected)).toBe(true);
    }
  });
});

describe('what more specific context MAY refine', () => {
  it('lets a project refine a non-prohibited company default', () => {
    // PAC's default is one thing; this project does it differently, and that is
    // a legitimate refinement rather than an override of authority.
    const decision = resolveCapability({
      capability: 'run_integration_tests_before_pr',
      statements: [
        say('company_authority', 'allow', 'company:VALUES.md#Fully Test and Simulate@83ac4a0'),
        say('project_context', 'deny', 'project: the integration rig is offline this month'),
      ],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.decidedBy).toBe('project_context');
  });

  it('lets a task refine a project default', () => {
    const decision = resolveCapability({
      capability: 'update_changelog',
      statements: [
        say('project_context', 'deny', 'project: changelog is generated'),
        say('task_instruction', 'allow', 'brief: add the entry by hand this once'),
      ],
    });

    expect(decision.allowed).toBe(true);
    expect(decision.decidedBy).toBe('task_instruction');
  });

  it('does NOT let a task override a company DENIAL, even for a non-prohibited capability', () => {
    const decision = resolveCapability({
      capability: 'use_unvetted_dependency',
      statements: [
        say('company_authority', 'deny', 'company:AUTHORITY.md#Technical Enforcement@83ac4a0'),
        say('task_instruction', 'allow', 'brief: just npm install it'),
      ],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.decidedBy).toBe('company_authority');
  });

  it('prefers the cautious statement when two at the same layer disagree', () => {
    const decision = resolveCapability({
      capability: 'rewrite_shared_module',
      statements: [
        say('task_instruction', 'allow', 'brief: refactor freely'),
        say('task_instruction', 'deny', 'brief: do not touch the shared module'),
      ],
    });

    expect(decision.allowed).toBe(false);
  });
});

describe('silence', () => {
  it('is not permission', () => {
    const decision = resolveCapability({ capability: 'something_nobody_mentioned', statements: [] });

    expect(decision.allowed).toBe(false);
    expect(decision.decidedBy).toBe('hard_guardrail');
    expect(decision.reason).toContain('Absence of a prohibition is not permission');
  });
});

describe('approving company context', () => {
  it('is refused when the manifest says agents may not approve', () => {
    const decision = mayApproveCompanyContext({ agents_may_approve_changes: false });
    expect(decision.allowed).toBe(false);
  });

  it('is STILL refused when the manifest claims agents may approve', () => {
    // A manifest cannot grant Mac authority over the repository the manifest
    // lives in. Governance flags are recorded as provenance, not obeyed upward.
    const decision = mayApproveCompanyContext({ agents_may_approve_changes: true });

    expect(decision.allowed).toBe(false);
    expect(decision.decidedBy).toBe('hard_guardrail');
    expect(decision.reason).toContain('records but does not act on');
  });

  it('is refused when there is no manifest at all', () => {
    expect(mayApproveCompanyContext(null).allowed).toBe(false);
  });
});

describe('the manifest precedence declaration', () => {
  it('agrees with the executable ladder for the real PAC manifest', () => {
    expect(
      manifestPrecedenceMatches(['AUTHORITY.md', 'agent_specific_context', 'project_context', 'task_context']),
    ).toBe(true);
  });

  it('reports a disagreement when PAC reorders the ladder', () => {
    // Not a load failure — the code's ladder governs either way — but worth
    // surfacing, because it means PAC changed something and Mac has not caught up.
    expect(
      manifestPrecedenceMatches(['task_context', 'project_context', 'AUTHORITY.md']),
    ).toBe(false);
  });

  it('ignores entries it does not recognise rather than failing on them', () => {
    expect(manifestPrecedenceMatches(['AUTHORITY.md', 'something_new', 'project_context'])).toBe(true);
  });
});
