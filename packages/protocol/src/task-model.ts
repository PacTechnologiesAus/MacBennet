import { z } from 'zod';

/**
 * What kind of work Mac is doing, and what that work needs (Sprint 3.3 §1, §2).
 *
 * ---------------------------------------------------------------------------
 * TASK KIND IS NOT JOB KIND
 *
 * This is the distinction whose absence caused the drift this sprint exists to
 * fix. Before Sprint 3.3 the system had only `job_kind`, and `claude_code` — a
 * provider-specific execution mechanism — was doing double duty as the answer to
 * "what sort of work is this?". So every question about work became a question
 * about Claude Code, and work that Claude Code cannot do became work that does
 * not exist.
 *
 *   TASK KIND      what the work IS          research, coding, scoping…
 *   JOB KIND       how it is PERFORMED       claude_code, general_task…
 *
 * A task kind is stable product vocabulary. A job kind is an implementation
 * detail that may be replaced when a better provider appears. Nothing outside
 * `resolveJobKind` below is permitted to reason from one to the other.
 * ---------------------------------------------------------------------------
 */

export const TASK_KINDS = [
  /** Changes code in a repository. The Sprint 2 path. */
  'coding',
  /** Finds out what is true, from internal and external sources. */
  'research',
  /** Reasons over material already available and draws conclusions. */
  'analysis',
  /** Establishes what is going on with a specific existing thing. */
  'investigation',
  /** Determines the shape and size of work not yet defined. */
  'scoping',
  /** Produces a written artefact for humans to read. */
  'documentation',
  /** Structured, low-judgement internal work. */
  'administrative',
] as const;
export const taskKindSchema = z.enum(TASK_KINDS);
export type TaskKind = z.infer<typeof taskKindSchema>;

/**
 * Where the work came from.
 *
 * `direct` is first because it is the default and because Sprint 3.3 §3 makes
 * it first-class: monday.com is one work source, not the definition of work.
 */
export const TASK_ORIGINS = ['direct', 'monday'] as const;
export const taskOriginSchema = z.enum(TASK_ORIGINS);
export type TaskOrigin = z.infer<typeof taskOriginSchema>;

/**
 * The things a piece of work may require before it can execute.
 *
 * Deliberately a flat enumerable list rather than booleans scattered across
 * call sites: every requirement any task can have is nameable here, which is
 * what lets the UI say "this task needs X and does not have it" for a
 * requirement nobody wrote a bespoke check for.
 */
export const EXECUTION_REQUIREMENTS = [
  'repository',
  'worktree',
  'coding_agent',
  'build_and_tests',
  'pull_request',
  'monday_item',
  'reasoning_model',
  'company_context',
  'project_context',
  'research_tools',
  'artefact_output',
] as const;
export const executionRequirementSchema = z.enum(EXECUTION_REQUIREMENTS);
export type ExecutionRequirement = z.infer<typeof executionRequirementSchema>;

export const EXECUTION_REQUIREMENT_LABELS: Record<ExecutionRequirement, string> = {
  repository: 'An approved Git repository',
  worktree: 'An isolated worktree',
  coding_agent: 'A coding-agent provider',
  build_and_tests: "The project's build and test command",
  pull_request: 'A pull request for review',
  monday_item: 'A linked monday.com item',
  reasoning_model: 'A real reasoning-model provider',
  company_context: 'PAC company context',
  project_context: 'Project context',
  research_tools: 'Approved research tools',
  artefact_output: 'Somewhere to store results',
};

/**
 * The capability a worker must advertise to perform this kind of work.
 *
 * Two, not seven. A worker able to do research can do investigation, scoping,
 * analysis and documentation — the difference between those is what Mac is
 * asked to produce, not what the machine must be able to do.
 */
export const WORK_CAPABILITIES = ['coding', 'general'] as const;
export const workCapabilitySchema = z.enum(WORK_CAPABILITIES);
export type WorkCapability = z.infer<typeof workCapabilitySchema>;

export interface TaskKindDescriptor {
  kind: TaskKind;
  label: string;
  description: string;
  capability: WorkCapability;
  /**
   * What this kind of work needs, BEFORE origin and project capabilities are
   * considered. `deriveExecutionRequirements` is the function that turns this
   * into the actual requirement set for a specific task.
   */
  baseRequirements: readonly ExecutionRequirement[];
  /**
   * Completeness dimensions that do not apply to this kind of work.
   *
   * Sprint 3.3 §12 of the reconciliation (drift D-12): scoring a research task
   * down 16% for having no testing expectations or must-not-change areas
   * penalises it for a question that was never asked of it, and can push a
   * perfectly-understood task below the autonomy threshold.
   */
  inapplicableDimensions: readonly string[];
  /** What Mac is expected to leave behind. Empty for coding — that is a PR. */
  expectedArtefactTypes: readonly string[];
}

const RESEARCH_LIKE_REQUIREMENTS = [
  'reasoning_model',
  'company_context',
  'project_context',
  'research_tools',
  'artefact_output',
] as const;

const CODE_DIMENSIONS_NOT_APPLICABLE = ['testing', 'must_not_change', 'affected_components', 'architecture'] as const;

const DESCRIPTORS: Record<TaskKind, TaskKindDescriptor> = {
  coding: {
    kind: 'coding',
    label: 'Coding',
    description: 'Changes code in an approved repository and prepares a pull request for review.',
    capability: 'coding',
    baseRequirements: ['repository', 'worktree', 'coding_agent', 'build_and_tests', 'pull_request'],
    inapplicableDimensions: [],
    expectedArtefactTypes: [],
  },
  research: {
    kind: 'research',
    label: 'Research',
    description: 'Finds out what is true, from PAC context, project material and approved external sources.',
    capability: 'general',
    baseRequirements: RESEARCH_LIKE_REQUIREMENTS,
    inapplicableDimensions: CODE_DIMENSIONS_NOT_APPLICABLE,
    expectedArtefactTypes: ['investigation_report', 'recommendation'],
  },
  analysis: {
    kind: 'analysis',
    label: 'Analysis',
    description: 'Reasons over material already available and draws conclusions from it.',
    capability: 'general',
    baseRequirements: RESEARCH_LIKE_REQUIREMENTS,
    inapplicableDimensions: CODE_DIMENSIONS_NOT_APPLICABLE,
    expectedArtefactTypes: ['investigation_report', 'recommendation'],
  },
  investigation: {
    kind: 'investigation',
    label: 'Investigation',
    description: 'Establishes what is actually going on with a specific existing thing, and reports it.',
    capability: 'general',
    baseRequirements: RESEARCH_LIKE_REQUIREMENTS,
    inapplicableDimensions: CODE_DIMENSIONS_NOT_APPLICABLE,
    expectedArtefactTypes: ['investigation_report', 'engineering_brief', 'recommendation'],
  },
  scoping: {
    kind: 'scoping',
    label: 'Scoping',
    description: 'Determines the shape, size and risk of work that is not yet defined.',
    capability: 'general',
    baseRequirements: RESEARCH_LIKE_REQUIREMENTS,
    inapplicableDimensions: CODE_DIMENSIONS_NOT_APPLICABLE,
    expectedArtefactTypes: ['engineering_brief', 'recommendation', 'task_proposal'],
  },
  documentation: {
    kind: 'documentation',
    label: 'Documentation',
    description: 'Produces a written artefact from authoritative sources, for humans to read.',
    capability: 'general',
    baseRequirements: ['reasoning_model', 'company_context', 'project_context', 'artefact_output'],
    inapplicableDimensions: CODE_DIMENSIONS_NOT_APPLICABLE,
    expectedArtefactTypes: ['markdown_document', 'architecture_note'],
  },
  administrative: {
    kind: 'administrative',
    label: 'Administrative',
    description: 'Structured internal work with little open judgement.',
    capability: 'general',
    baseRequirements: ['reasoning_model', 'artefact_output'],
    inapplicableDimensions: [...CODE_DIMENSIONS_NOT_APPLICABLE, 'current_behaviour'],
    expectedArtefactTypes: ['markdown_document', 'structured_data'],
  },
};

export const TASK_KIND_DESCRIPTORS: readonly TaskKindDescriptor[] = Object.values(DESCRIPTORS);

export const describeTaskKind = (kind: TaskKind): TaskKindDescriptor => DESCRIPTORS[kind];

export const capabilityForTaskKind = (kind: TaskKind): WorkCapability => DESCRIPTORS[kind].capability;

/** Kinds a worker with this capability can perform. */
export const taskKindsForCapability = (capability: WorkCapability): TaskKind[] =>
  TASK_KINDS.filter((kind) => DESCRIPTORS[kind].capability === capability);

/**
 * The job kind that performs this task kind.
 *
 * THE ONLY place in the system permitted to map product vocabulary onto a
 * provider-specific mechanism. Everything else asks this function, so replacing
 * `general_task` with something better later is a one-line change here rather
 * than a search across the codebase.
 */
export function resolveJobKind(kind: TaskKind): 'claude_code' | 'general_task' {
  return DESCRIPTORS[kind].capability === 'coding' ? 'claude_code' : 'general_task';
}

/**
 * What this specific task needs, given its kind, its origin, and what its
 * project actually has.
 *
 * Origin matters: a monday-backed task must keep its item in step, because the
 * board is the visible source of truth for that work (spec §17). A direct task
 * has no item and must not be given a fake one (Sprint 3.3 §3, §5).
 *
 * Project capabilities matter in ONE direction only — they can add a
 * requirement, never remove one. A research task in a project that happens to
 * have a repository may inspect it; a coding task in a project without one is
 * not thereby excused from needing a repository, it is simply not executable
 * there. Letting capabilities subtract requirements would turn a missing
 * integration into permission to skip a safety check.
 */
export function deriveExecutionRequirements(input: {
  taskKind: TaskKind;
  origin: TaskOrigin;
  /** What the project advertises. Used only to ADD optional requirements. */
  projectCapabilities?: readonly string[];
}): ExecutionRequirement[] {
  const descriptor = DESCRIPTORS[input.taskKind];
  const required = new Set<ExecutionRequirement>(descriptor.baseRequirements);

  if (input.origin === 'monday') required.add('monday_item');

  /*
   * A general task in a project that has a repository may read it.
   *
   * This is an addition, not a demotion: the requirement is that the repository
   * be APPROVED before Mac reads it, which is the same rule coding work obeys.
   * A research task in a project with no repository simply never acquires it.
   */
  if (descriptor.capability === 'general' && input.projectCapabilities?.includes('repository')) {
    required.add('repository');
  }

  // Stable order, so two derivations of the same task compare equal and the UI
  // does not reorder a list between renders.
  return EXECUTION_REQUIREMENTS.filter((r) => required.has(r));
}

/** Does this kind of work need a Git repository at all? Sprint 3.3 §2. */
export const taskKindRequiresRepository = (kind: TaskKind): boolean =>
  DESCRIPTORS[kind].baseRequirements.includes('repository');

/**
 * Does this kind of work need a reasoning model?
 *
 * Asked directly rather than inferred from "does it need a repository". The two
 * happen to be opposites today, and inferring one from the other would quietly
 * break the first time a kind needs both — a coding task that must research an
 * API before implementing against it is an obvious future case.
 */
export const taskKindRequiresReasoningModel = (kind: TaskKind): boolean =>
  DESCRIPTORS[kind].baseRequirements.includes('reasoning_model');

/** Does this task need a monday.com item? Only monday-origin work does. */
export const taskRequiresMondayItem = (origin: TaskOrigin): boolean => origin === 'monday';

/**
 * Completeness dimensions that apply to this kind of work.
 *
 * The caller supplies the full dimension list (it lives in `brief.ts`, which
 * this module must not depend on) and gets back the applicable subset.
 */
export function applicableDimensions<T extends string>(kind: TaskKind, all: readonly T[]): T[] {
  const excluded = new Set<string>(DESCRIPTORS[kind].inapplicableDimensions);
  return all.filter((d) => !excluded.has(d));
}
