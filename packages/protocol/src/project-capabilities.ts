import { z } from 'zod';
import { TASK_KINDS, taskKindSchema, type TaskKind } from './task-model.js';

/**
 * What a project actually has (Sprint 3.3 §6).
 *
 * ---------------------------------------------------------------------------
 * WHY PROJECTS ADVERTISE RATHER THAN ASSUME
 *
 * Before Sprint 3.3, `projects` carried `repo_url` and nothing else, so a
 * project with no repository was indistinguishable from a project whose
 * repository somebody forgot to configure. `PAC Internal Development` — a real
 * project, deliberately without code — looked like a mistake.
 *
 * Capabilities make the difference statable. A project with no repository still
 * supports research; a project with no monday board still supports direct work.
 * And an eligibility check can then ask "does this project have what this work
 * needs?" instead of assuming the answer is yes and failing later.
 * ---------------------------------------------------------------------------
 */

export const PROJECT_CAPABILITIES = [
  /** An approved Git repository is attached. */
  'repository',
  /** An approved monday.com board is mapped. */
  'monday_board',
  /** PAC company context applies to this project's work. */
  'company_context',
  /** A Dropbox/network job folder. Declared now; consumed by a later sprint. */
  'dropbox_path',
  /** A Forja project reference. Declared now; consumed by a later sprint. */
  'forja_project',
  /** A HubSpot company/deal reference. Declared now; consumed by a later sprint. */
  'hubspot_reference',
  /**
   * Internal PAC work with no external customer.
   *
   * Not a resource but a classification, and it belongs here because it changes
   * what Mac may do: internal projects carry no customer-commitment risk, which
   * is one of the hard prohibitions in spec §16.
   */
  'internal_only',
  /** External research (public web/doc fetch) is permitted for this project. */
  'external_research',
] as const;
export const projectCapabilitySchema = z.enum(PROJECT_CAPABILITIES);
export type ProjectCapability = z.infer<typeof projectCapabilitySchema>;

export const PROJECT_CAPABILITY_LABELS: Record<ProjectCapability, string> = {
  repository: 'Git repository',
  monday_board: 'monday.com board',
  company_context: 'PAC company context',
  dropbox_path: 'Dropbox job folder',
  forja_project: 'Forja project',
  hubspot_reference: 'HubSpot reference',
  internal_only: 'Internal PAC project',
  external_research: 'External research permitted',
};

/**
 * The capabilities a project holds, plus what kinds of work it permits.
 *
 * `allowedTaskKinds` is a separate axis from capabilities on purpose. Having a
 * repository does not imply that a human wants Mac writing code there, and
 * being an internal project does not imply that every kind of work is welcome.
 * One is what the project HAS; the other is what a person has ALLOWED.
 */
export const projectCapabilityStateSchema = z.object({
  capabilities: z.array(projectCapabilitySchema).max(PROJECT_CAPABILITIES.length).default([]),
  /** Empty means "no kind of work has been allowed here yet", not "all kinds". */
  allowedTaskKinds: z.array(taskKindSchema).max(TASK_KINDS.length).default([]),
});
export type ProjectCapabilityState = z.infer<typeof projectCapabilityStateSchema>;

/**
 * The default for a project nobody has configured.
 *
 * Deliberately restrictive in what is ALLOWED and generous in what is
 * DECLARED: an unconfigured project permits no task kind, so migration cannot
 * silently enable autonomous work anywhere (Sprint 3.3 §21).
 */
export const emptyCapabilityState = (): ProjectCapabilityState => ({
  capabilities: [],
  allowedTaskKinds: [],
});

export const hasCapability = (state: ProjectCapabilityState, capability: ProjectCapability): boolean =>
  state.capabilities.includes(capability);

export const permitsTaskKind = (state: ProjectCapabilityState, kind: TaskKind): boolean =>
  state.allowedTaskKinds.includes(kind);

/**
 * Capabilities implied by resources the project genuinely has.
 *
 * Used at migration and whenever a repository or board is attached, so the
 * declared capability set cannot drift away from reality. It only ever ADDS —
 * removing a capability is a human decision, because a human may have turned
 * something off deliberately.
 */
export function reconcileCapabilities(
  declared: readonly ProjectCapability[],
  observed: { hasApprovedRepository: boolean; hasApprovedBoard: boolean },
): ProjectCapability[] {
  const set = new Set<ProjectCapability>(declared);
  if (observed.hasApprovedRepository) set.add('repository');
  if (observed.hasApprovedBoard) set.add('monday_board');
  return PROJECT_CAPABILITIES.filter((c) => set.has(c));
}
