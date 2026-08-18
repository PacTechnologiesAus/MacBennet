import {
  deriveExecutionRequirements,
  describeTaskKind,
  EXECUTION_REQUIREMENT_LABELS,
  type ExecutionRequirement,
  type ProjectCapability,
  type TaskKind,
  type TaskOrigin,
} from '@mac/protocol';

/**
 * What a specific task needs, and whether it has it (Sprint 3.3 §2).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ONE FUNCTION AND NOT A CHECK PER CALL SITE
 *
 * Before Sprint 3.3 the answer to "can this run?" was spread across three
 * places that each assumed a repository: the dispatch guardrail, the night
 * eligibility predicate, and `startSelectedTask`. They agreed by coincidence.
 *
 * A user then created a research task and got a different, incomplete answer
 * from each — and the Task Detail screen, which had no answer at all, showed
 * "New run" as though everything were fine.
 *
 * So requirements are derived ONCE, from the task's kind and origin and what
 * the project actually holds, and every consumer reads the same list. The UI's
 * "why is this blocked" and the scheduler's "skip this" are then guaranteed to
 * be the same sentence, because they are literally the same computation.
 *
 * This module is pure. It has no I/O and no database.
 * ---------------------------------------------------------------------------
 */

export interface RequirementFacts {
  /** An approved repository exists for this project. */
  hasApprovedRepository: boolean;
  /** An approved, night-eligible monday board is mapped. */
  hasApprovedBoard: boolean;
  /** This task is linked to a monday item. */
  hasMondayItem: boolean;
  /** A handoff brief exists for this task. */
  hasBrief: boolean;
  /** A REAL reasoning-model provider is configured (not `none`). */
  hasReasoningModel: boolean;
  /** Valid PAC company context is loadable. */
  hasCompanyContext: boolean;
  /** The coding-agent provider is switched on. */
  codingAgentEnabled: boolean;
  /** The project declares the resources it holds. */
  projectCapabilities: readonly ProjectCapability[];
  /** Task kinds a human has allowed on this project. */
  allowedTaskKinds: readonly TaskKind[];
  /** Artefact storage. Always true — the table exists — but stated, not assumed. */
  artefactStorageAvailable?: boolean;
}

export interface RequirementCheck {
  requirement: ExecutionRequirement;
  label: string;
  satisfied: boolean;
  detail: string;
}

export interface TaskRequirementVerdict {
  taskKind: TaskKind;
  origin: TaskOrigin;
  checks: RequirementCheck[];
  unmet: ExecutionRequirement[];
  ready: boolean;
  /** One sentence a human can act on. Empty when ready. */
  summary: string;
}

/**
 * Evaluate a task's execution requirements.
 *
 * Note the two things that are NOT here: approval and confidence. Those are
 * authority questions, and they belong to eligibility and to the approval gate.
 * This function answers only "does this task have the machinery it needs?",
 * which is a different question a human debugging a stuck task asks first.
 */
export function evaluateTaskRequirements(input: {
  taskKind: TaskKind;
  origin: TaskOrigin;
  facts: RequirementFacts;
}): TaskRequirementVerdict {
  const { taskKind, origin, facts } = input;

  const requirements = deriveExecutionRequirements({
    taskKind,
    origin,
    projectCapabilities: facts.projectCapabilities,
  });

  const checks = requirements.map((requirement) => {
    const { satisfied, detail } = evaluateOne(requirement, facts);
    return { requirement, label: EXECUTION_REQUIREMENT_LABELS[requirement], satisfied, detail };
  });

  const unmet = checks.filter((c) => !c.satisfied).map((c) => c.requirement);

  return {
    taskKind,
    origin,
    checks,
    unmet,
    ready: unmet.length === 0,
    summary: unmet.length === 0 ? '' : summarise(taskKind, checks.filter((c) => !c.satisfied)),
  };
}

function evaluateOne(
  requirement: ExecutionRequirement,
  facts: RequirementFacts,
): { satisfied: boolean; detail: string } {
  switch (requirement) {
    case 'repository':
      return facts.hasApprovedRepository
        ? { satisfied: true, detail: 'An approved repository is attached to this project.' }
        : {
            satisfied: false,
            detail: 'This project has no approved repository, and this kind of work needs one.',
          };

    case 'worktree':
    case 'build_and_tests':
    case 'pull_request':
      /*
       * These three follow from the repository and the coding agent, and are
       * listed separately so the UI can say what a coding run will actually do
       * rather than only what it needs. They cannot be independently missing:
       * a worker that has a repository creates a worktree, runs the project's
       * configured test command, and prepares a PR.
       */
      return facts.hasApprovedRepository
        ? { satisfied: true, detail: 'Provided by the coding worker once a repository is approved.' }
        : { satisfied: false, detail: 'Depends on an approved repository, which this project does not have.' };

    case 'coding_agent':
      return facts.codingAgentEnabled
        ? { satisfied: true, detail: 'The coding-agent provider is enabled.' }
        : { satisfied: false, detail: 'Coding-agent execution is switched off in settings.' };

    case 'monday_item':
      return facts.hasMondayItem
        ? { satisfied: true, detail: 'Linked to a monday.com item.' }
        : {
            satisfied: false,
            detail:
              'This task came from monday.com but is no longer linked to an item. ' +
              'Direct tasks do not need one; this one does, because the board is its source of truth.',
          };

    case 'reasoning_model':
      /*
       * The refusal that Sprint 3.3 §10 asks for, expressed as a requirement
       * rather than as a runtime surprise.
       *
       * A null provider is fine for model ASSISTANCE, which degrades to a
       * deterministic path. It is not fine for research, where there is no
       * deterministic path and an empty result would be reported as "looked and
       * found nothing" — a claim nobody made.
       */
      return facts.hasReasoningModel
        ? { satisfied: true, detail: 'A real reasoning-model provider is configured.' }
        : {
            satisfied: false,
            detail:
              'No reasoning-model provider is configured. General work cannot run against a null provider — ' +
              'it would produce an empty result that reads like a completed investigation (MODEL_PROVIDER_REQUIRED).',
          };

    case 'company_context':
      return facts.hasCompanyContext
        ? { satisfied: true, detail: 'PAC company context is available.' }
        : {
            satisfied: false,
            detail: 'PAC company context is unavailable, so Mac would be working without approved company policy.',
          };

    case 'project_context':
      // Always satisfiable: every project has at least a name, a description and
      // whatever memory has accumulated. A project with nothing recorded yields
      // a thin context, which lowers confidence — it does not block execution.
      return { satisfied: true, detail: 'Project memory and description are available.' };

    case 'research_tools':
      return { satisfied: true, detail: 'The internal research tools are always available to an approved run.' };

    case 'artefact_output':
      return facts.artefactStorageAvailable === false
        ? { satisfied: false, detail: 'Artefact storage is unavailable.' }
        : { satisfied: true, detail: 'Results will be stored as artefacts against this task.' };
  }
}

/**
 * Requirements that are CONSEQUENCES of another requirement, not causes.
 *
 * A missing repository makes the worktree, the test command and the pull
 * request unmet too, but reporting four unmet requirements for one root cause
 * buries the sentence a reader can act on under three restatements of it.
 */
const CONSEQUENCES_OF_REPOSITORY: readonly ExecutionRequirement[] = ['worktree', 'build_and_tests', 'pull_request'];

function summarise(taskKind: TaskKind, failed: RequirementCheck[]): string {
  const label = describeTaskKind(taskKind).label.toLowerCase();

  // Collapse the cascade: if the repository is missing, say only that.
  const root = failed.some((f) => f.requirement === 'repository')
    ? failed.filter((f) => !CONSEQUENCES_OF_REPOSITORY.includes(f.requirement))
    : failed;

  if (root.length === 1) return `This ${label} task cannot run yet: ${root[0]!.detail}`;
  return (
    `This ${label} task cannot run yet. ${root.length} requirements are unmet: ` +
    root.map((f) => f.label.toLowerCase()).join('; ') +
    '.'
  );
}

/**
 * The one-line reason a task is stuck, preferring the reason a human can fix.
 *
 * Ordering is deliberate and is about who has to do something. "Nobody has run
 * discovery" is actionable in ten seconds; "no reasoning provider is
 * configured" needs an administrator; "this project does not allow this kind of
 * work" needs a decision. Leading with the deepest problem would send a user to
 * settings when all they needed was to press a button.
 */
export function primaryBlocker(input: {
  requirements: TaskRequirementVerdict;
  hasBrief: boolean;
  hasDiscoverySession: boolean;
  taskKindPermitted: boolean;
  understandingConfidence: number | null;
  minExecutionConfidence: number;
}): string {
  if (!input.hasDiscoverySession) {
    return 'Discovery has not been started. Mac needs a structured understanding before he may execute anything.';
  }
  if (!input.hasBrief) {
    return 'Discovery is under way but has not produced a handoff brief yet.';
  }
  if (input.understandingConfidence !== null && input.understandingConfidence < input.minExecutionConfidence) {
    return (
      `Understanding confidence is ${(input.understandingConfidence * 100).toFixed(0)}%, below the ` +
      `${(input.minExecutionConfidence * 100).toFixed(0)}% floor. More discovery is required — this floor cannot be overridden.`
    );
  }
  if (!input.taskKindPermitted) {
    return 'This project has not been approved for this kind of work. An administrator must allow it explicitly.';
  }
  if (!input.requirements.ready) return input.requirements.summary;
  return '';
}
