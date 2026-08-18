/**
 * PAC's agent workforce, and the platforms it works through (Sprint 3.2 §16.4).
 *
 * ---------------------------------------------------------------------------
 * FORJA IS NOT AN AGENT
 *
 * This is the reason the file exists. Forja is PAC Technologies' engineering and
 * orchestration platform — the interface through which humans and agents work
 * together. It is not an employee, not an autonomous worker, and not something
 * that can be assigned a task or hold an authority.
 *
 * Getting that wrong is not a cosmetic error. An orchestration platform modelled
 * as an agent acquires, by implication, a role, a set of permissions, and the
 * ability to be handed work — and a system that believes its own scheduler is a
 * colleague makes incoherent decisions about who is responsible for what.
 *
 * So the distinction is TYPED DATA, not a sentence in a document: agents and
 * platforms are separate collections, `kind` is a discriminant, and
 * `isPacAgent('forja')` is false. The authoritative `AGENTS.md` says the same
 * thing in prose ("Forja is not itself one of the specialist staff agents"), and
 * a test asserts the two agree so a future divergence is caught rather than
 * discovered.
 * ---------------------------------------------------------------------------
 */

export const PAC_AGENTS = ['mac', 'otto', 'project_document_controller', 'sales_engineer'] as const;
export type PacAgentKey = (typeof PAC_AGENTS)[number];

export const PAC_PLATFORMS = ['forja'] as const;
export type PacPlatformKey = (typeof PAC_PLATFORMS)[number];

export type PacActorKey = PacAgentKey | PacPlatformKey;

export interface PacActorDescriptor {
  key: PacActorKey;
  displayName: string;
  kind: 'agent' | 'platform';
  /** One line, matching how the authoritative AGENTS.md describes it. */
  summary: string;
  /**
   * Whether work can be assigned to this actor. False for a platform: you route
   * work THROUGH Forja, you do not give Forja the work.
   */
  assignable: boolean;
  /** The heading under which the authoritative AGENTS.md describes it. */
  agentsDocumentHeading: string;
}

const DESCRIPTORS: Record<PacActorKey, PacActorDescriptor> = {
  mac: {
    key: 'mac',
    displayName: 'Mac',
    kind: 'agent',
    summary: "PAC's AI Automation Engineer and primary technical autonomous worker.",
    assignable: true,
    agentsDocumentHeading: 'Mac — Automation Engineer',
  },
  otto: {
    key: 'otto',
    displayName: 'Otto',
    kind: 'agent',
    summary: 'Documentation specialist; creates and maintains formal PAC documentation.',
    assignable: true,
    agentsDocumentHeading: 'Otto — Documentation Specialist',
  },
  project_document_controller: {
    key: 'project_document_controller',
    displayName: 'Project Document Controller',
    kind: 'agent',
    summary: 'Maintains project information order, traceability, revision history and completeness.',
    assignable: true,
    agentsDocumentHeading: 'Project Document Controller',
  },
  sales_engineer: {
    key: 'sales_engineer',
    displayName: 'Sales Engineer',
    kind: 'agent',
    summary: 'Identifies and qualifies potential PAC work; research and sales engineering.',
    assignable: true,
    agentsDocumentHeading: 'Sales Engineer',
  },
  forja: {
    key: 'forja',
    displayName: 'Forja',
    kind: 'platform',
    summary:
      "PAC's engineering and orchestration platform, through which humans and agents work together. " +
      'Not an agent, not an employee, and not an autonomous worker.',
    assignable: false,
    agentsDocumentHeading: 'Forja — Orchestration Platform',
  },
};

export const PAC_ACTORS: readonly PacActorDescriptor[] = Object.values(DESCRIPTORS);

export const isPacAgent = (key: string): key is PacAgentKey =>
  (PAC_AGENTS as readonly string[]).includes(key);

export const isPacPlatform = (key: string): key is PacPlatformKey =>
  (PAC_PLATFORMS as readonly string[]).includes(key);

export function describeActor(key: string): PacActorDescriptor | null {
  return DESCRIPTORS[key as PacActorKey] ?? null;
}

/**
 * Actors that may be given a task.
 *
 * Sprint 3.2 assigns nothing to anyone — Mac is the only agent that exists in
 * this application — but the predicate is the one a future handoff would call,
 * and having it return `false` for Forja from the start is cheaper than
 * discovering the assumption later.
 */
export const assignableActors = (): readonly PacActorDescriptor[] =>
  PAC_ACTORS.filter((a) => a.assignable);
