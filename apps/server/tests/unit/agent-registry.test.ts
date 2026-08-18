import { describe, expect, it } from 'vitest';
import {
  PAC_ACTORS,
  PAC_AGENTS,
  PAC_PLATFORMS,
  assignableActors,
  describeActor,
  isPacAgent,
  isPacPlatform,
} from '../../src/domain/agent-registry.js';

/**
 * PAC's agent workforce, and its platforms (Sprint 3.2 §16.4).
 *
 * The headline claim: **Forja is not an AI agent.** It is PAC Technologies'
 * engineering and orchestration platform.
 *
 * This is tested against executable data rather than prose, because the
 * distinction has consequences. An orchestration platform modelled as an agent
 * acquires, by implication, a role, a set of permissions and the ability to be
 * handed work — and a system that believes its own orchestration layer is a
 * colleague will make incoherent decisions about who is responsible for what.
 */

describe('Forja', () => {
  it('is NOT an agent', () => {
    expect(isPacAgent('forja')).toBe(false);
    expect(PAC_AGENTS).not.toContain('forja');
  });

  it('is a platform', () => {
    expect(isPacPlatform('forja')).toBe(true);
    expect(describeActor('forja')?.kind).toBe('platform');
  });

  it('cannot be assigned work', () => {
    // You route work THROUGH Forja. You do not give Forja the work.
    expect(describeActor('forja')?.assignable).toBe(false);
    expect(assignableActors().map((a) => a.key)).not.toContain('forja');
  });

  it('is described as a platform, not as a worker or an employee', () => {
    const summary = describeActor('forja')!.summary.toLowerCase();
    expect(summary).toContain('platform');
    expect(summary).toContain('not an agent');
  });
});

describe('the agents', () => {
  it('lists PAC\'s four specialist agents', () => {
    expect([...PAC_AGENTS]).toEqual(['mac', 'otto', 'project_document_controller', 'sales_engineer']);
  });

  it.each([...PAC_AGENTS])('describes %s as an agent that may be assigned work', (key) => {
    const actor = describeActor(key);
    expect(actor).not.toBeNull();
    expect(actor!.kind).toBe('agent');
    expect(actor!.assignable).toBe(true);
  });

  it('keeps agents and platforms as disjoint sets', () => {
    for (const key of PAC_AGENTS) expect(isPacPlatform(key)).toBe(false);
    for (const key of PAC_PLATFORMS) expect(isPacAgent(key)).toBe(false);
  });

  it('gives every declared actor a descriptor, and every descriptor a kind', () => {
    expect(PAC_ACTORS).toHaveLength(PAC_AGENTS.length + PAC_PLATFORMS.length);
    for (const actor of PAC_ACTORS) {
      expect(['agent', 'platform']).toContain(actor.kind);
      expect(actor.displayName.length).toBeGreaterThan(0);
      expect(actor.agentsDocumentHeading.length).toBeGreaterThan(0);
    }
  });

  it('knows Mac is the automation engineer', () => {
    const mac = describeActor('mac')!;
    expect(mac.kind).toBe('agent');
    expect(mac.summary).toContain('Automation Engineer');
  });

  it('returns null for something that is neither', () => {
    expect(describeActor('monday.com')).toBeNull();
    expect(describeActor('dropbox')).toBeNull();
  });
});
