import {
  ELIGIBILITY_LABELS,
  mondayPriorityRank,
  PRIORITY_RANK,
  taskKindRequiresReasoningModel,
  taskKindRequiresRepository,
  type CandidateSource,
  type EligibilityCheck,
  type EligibilityCode,
  type EligibilityVerdict,
  type ExecutionRequirement,
  type ProjectCapability,
  type TaskKind,
  type TaskOrigin,
  type TaskPriority,
} from '@mac/protocol';
import { toScaled } from './confidence.js';

/**
 * May Mac autonomously start this work now? (Sprint 3 §7, Sprint 3.3 §20)
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS CODE AND NOT A MODEL
 *
 * The question has a correct answer. It is a conjunction of approval states,
 * statuses, confidence thresholds, capability facts and dependency facts, every
 * one of which is already recorded somewhere. A model asked it would be fluent,
 * occasionally wrong, and — worse — unable to be disagreed with on a specific
 * clause.
 *
 * This module has no I/O at all.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * WHAT SPRINT 3.3 CHANGED, AND WHAT IT DELIBERATELY DID NOT
 *
 * Sprint 3 wrote thirteen checks, seven of which read a monday board or item and
 * one of which demanded a repository unconditionally. That made this predicate
 * unable to express a verdict about work with no board — not "ineligible", but
 * *no verdict at all* — which is why a direct research task was invisible to the
 * scheduler rather than merely refused by it (reconciliation drift D-2).
 *
 * The fix is that requirements are now CONDITIONAL ON CAPABILITY:
 *
 *   * board and item checks apply when the work CAME from a board;
 *   * the repository check applies when the work NEEDS a repository;
 *   * the reasoning-model check applies when the work NEEDS a model.
 *
 * Nothing was relaxed. A monday-backed coding task passes through exactly the
 * same thirteen checks it did before, in the same order, with the same details.
 * What changed is that a direct research task now gets a verdict too, made of
 * the checks that actually apply to it.
 * ---------------------------------------------------------------------------
 *
 * Every applicable check is reported whether it passed or failed. The Night
 * Queue screen has to answer "why is this eligible?" as readily as "why was
 * this skipped?", and a verdict carrying only failures cannot do that.
 */

/** The monday-side facts. Null for direct work. */
export interface EligibilityBoardFacts {
  isApproved: boolean;
  nightShiftEligible: boolean;
  requireItemFlag: boolean;
  startableStatuses: string[];
  completedStatuses: string[];
  allowedItemTypes: string[];
  macUserId: string | null;
}

export interface EligibilityItemFacts {
  id: string;
  name: string;
  status: string | null;
  priority: string | null;
  assigneeIds: string[];
  nightShiftFlag: boolean;
  dependsOn: string[];
  itemType: string | null;
  dueDate: string | null;
}

export interface EligibilityInput {
  project: {
    nightShiftApproved: boolean;
    isActive: boolean;
    /**
     * Sprint 3.3. Optional so that a caller describing pre-3.3 monday work does
     * not have to invent them; when absent, no capability check is emitted and
     * the verdict is exactly the Sprint 3 verdict.
     */
    capabilities?: readonly ProjectCapability[];
    /** Task kinds a human has explicitly allowed here. */
    allowedTaskKinds?: readonly TaskKind[];
  };
  /**
   * Sprint 3.3: what the work IS, independent of where it is tracked.
   *
   * Optional for backwards compatibility: an input that supplies a board and an
   * item without this block is describing monday-backed coding work, which is
   * precisely what this predicate meant before Sprint 3.3, so that is what it
   * is taken to mean.
   */
  work?: {
    taskKind: TaskKind;
    origin: TaskOrigin;
    title: string;
    /** Mac-side priority. Used for ordering when there is no monday priority. */
    priority: TaskPriority;
  };
  board: EligibilityBoardFacts | null;
  item: EligibilityItemFacts | null;
  /** Statuses of the items this one depends on, keyed by monday item id. */
  dependencyStatuses: Record<string, string | null>;
  /** Mac's own side of the question. */
  mac: {
    /** Null when no handoff brief exists for the linked task. */
    briefConfidence: number | null;
    /** True when a human pre-approved a narrower scope for this task. */
    hasApprovedLimitedScope: boolean;
    repositoryApproved: boolean;
    hasActiveRun: boolean;
    /**
     * Mac already ran this task during THIS shift, whatever the outcome.
     *
     * Separate from `hasActiveRun` because the dangerous case is the finished
     * one: a completed run leaves no active run, and if monday.com has not yet
     * been updated — a failed write, a board that is down — the item is still
     * sitting in a startable status. Without this, Mac would cheerfully do the
     * same piece of work twice.
     */
    attemptedThisShift: boolean;
    blockedEarlierTonight: boolean;
  };
  /**
   * Sprint 3.3: whether the machinery this kind of work needs actually exists.
   *
   * Optional for the same backwards-compatibility reason as `work`.
   */
  capability?: {
    /** A live worker advertises the capability this task kind requires. */
    workerAvailable: boolean;
    /** A REAL reasoning-model provider is configured (not `none`). */
    reasoningModelAvailable: boolean;
    /**
     * Requirements this task needs and does not have, from
     * `evaluateTaskRequirements`. Repository and reasoning-model entries are
     * ignored here because each has its own dedicated check — reporting one
     * failure under two codes would double-count it in the summary.
     */
    unmetRequirements: readonly ExecutionRequirement[];
  };
  policy: {
    minExecutionConfidence: number;
    defaultConfidenceThreshold: number;
  };
  /** Position on the board, used only to break ties deterministically. */
  boardOrder?: number;
}

const check = (code: EligibilityCode, ok: boolean, detail: string): EligibilityCheck => ({ code, ok, detail });

/** What the input is describing, when it did not say. See `work` above. */
function resolveWork(input: EligibilityInput): NonNullable<EligibilityInput['work']> {
  if (input.work) return input.work;
  return {
    taskKind: 'coding',
    origin: 'monday',
    title: input.item?.name ?? 'Untitled',
    priority: 'normal',
  };
}

export const candidateSourceOf = (input: EligibilityInput): CandidateSource =>
  resolveWork(input).origin === 'monday' ? 'monday' : 'direct';

export function evaluateEligibility(input: EligibilityInput): EligibilityVerdict {
  const { project, board, item, mac, policy } = input;
  const work = resolveWork(input);
  const checks: EligibilityCheck[] = [];

  checks.push(
    check(
      'project_approved',
      project.nightShiftApproved && project.isActive,
      project.nightShiftApproved
        ? project.isActive
          ? 'Approved for night-shift work.'
          : 'The project is inactive.'
        : 'Nobody has approved this project for night-shift work.',
    ),
  );

  /*
   * The board and item checks, applied only to work that came from a board.
   *
   * Skipped entirely for direct work — not passed, SKIPPED. A verdict that
   * reported "board approved: yes" for a task with no board would be a verdict
   * nobody could trust, and one that reported "board approved: no" would refuse
   * work for failing a rule that does not apply to it.
   */
  if (board && item) {
    checks.push(
      check(
        'board_approved',
        board.isApproved,
        board.isApproved ? 'Board mapping is approved.' : 'The board mapping has not been approved.',
      ),
    );

    checks.push(
      check(
        'board_night_eligible',
        board.nightShiftEligible,
        board.nightShiftEligible
          ? 'Board is marked eligible for night-shift work.'
          : 'The board is approved for reading but not marked eligible for autonomous work.',
      ),
    );

    /*
     * The per-item flag, on by default.
     *
     * An item Mac picks up at 02:00 should have been marked deliberately. A
     * board may turn this off, in which case any item in a startable status is
     * fair game — a deliberate choice a human makes once, per board, with the
     * consequence visible on this screen.
     */
    checks.push(
      check(
        'item_flagged',
        !board.requireItemFlag || item.nightShiftFlag,
        board.requireItemFlag
          ? item.nightShiftFlag
            ? 'Explicitly marked for Mac.'
            : 'This board requires an explicit per-item flag, and this item has none.'
          : 'This board does not require a per-item flag.',
      ),
    );

    const startable = board.startableStatuses.map(normalise);
    const status = normalise(item.status ?? '');
    checks.push(
      check(
        'status_startable',
        startable.includes(status),
        startable.includes(status)
          ? `Status "${item.status}" is one Mac may start from.`
          : `Status "${item.status ?? 'none'}" is not startable (expected one of: ${board.startableStatuses.join(', ') || 'none configured'}).`,
      ),
    );

    /*
     * Assignment.
     *
     * Unassigned is fine — that is work waiting for someone. Assigned to Mac is
     * fine. Assigned to a PERSON is not: taking work off a colleague's plate
     * overnight is the sort of helpful act that causes an argument in the morning.
     */
    const assignedElsewhere =
      item.assigneeIds.length > 0 && !(board.macUserId !== null && item.assigneeIds.includes(board.macUserId));
    checks.push(
      check(
        'not_assigned_elsewhere',
        !assignedElsewhere,
        assignedElsewhere
          ? `Assigned to someone else (${item.assigneeIds.join(', ')}).`
          : item.assigneeIds.length === 0
            ? 'Unassigned.'
            : 'Assigned to Mac.',
      ),
    );

    const completed = board.completedStatuses.map(normalise);
    const unfinished = item.dependsOn.filter((id) => {
      const dependencyStatus = input.dependencyStatuses[id];
      // An unknown dependency counts as unfinished. A dependency Mac cannot see
      // is not a dependency he may assume is done.
      return !dependencyStatus || !completed.includes(normalise(dependencyStatus));
    });
    checks.push(
      check(
        'dependencies_clear',
        unfinished.length === 0,
        unfinished.length === 0
          ? item.dependsOn.length === 0
            ? 'No dependencies.'
            : 'All dependencies are complete.'
          : `Waiting on ${unfinished.length} unfinished dependency/dependencies: ${unfinished.join(', ')}.`,
      ),
    );

    const allowedTypes = board.allowedItemTypes.map(normalise);
    const typeAllowed = allowedTypes.length === 0 || allowedTypes.includes(normalise(item.itemType ?? ''));
    checks.push(
      check(
        'task_type_allowed',
        typeAllowed,
        allowedTypes.length === 0
          ? 'This board restricts no task types.'
          : typeAllowed
            ? `Type "${item.itemType}" is allowed.`
            : `Type "${item.itemType ?? 'none'}" is outside the configured allowlist.`,
      ),
    );
  }

  /*
   * Sprint 3.3: has a human allowed this kind of work here?
   *
   * Emitted only when the project actually declares an allowlist. A caller that
   * supplies none is describing a pre-3.3 board, where the board's own
   * `allowedItemTypes` was the equivalent control and has already been checked.
   */
  if (project.allowedTaskKinds) {
    /*
     * An EMPTY allowlist means "nobody has configured this project", and it
     * resolves to exactly what the project could already do before Sprint 3.3:
     * coding, and nothing else.
     *
     * ---------------------------------------------------------------------
     * WHY EMPTY IS NOT SIMPLY "NOTHING ALLOWED"
     *
     * Two requirements pull in opposite directions, and this rule satisfies
     * both rather than choosing one.
     *
     *   * Sprint 3.3 §21: `PAC Internal Development` must NOT become able to run
     *     autonomous work as a side effect of a migration. A human approves it.
     *
     *   * Sprint 3.3 §4 and §28: existing monday coding workflows must remain
     *     intact, and every prior test must remain green.
     *
     * Treating empty as "nothing" would break the second: every project created
     * before this sprint, and every project created by any code path that does
     * not yet know about task kinds, would silently stop working. Treating it as
     * "everything" would break the first, and would be a machine granting itself
     * a permission — the exact thing this sprint is careful about everywhere
     * else.
     *
     * So empty grants the STATUS QUO ANTE and nothing beyond it. Coding was
     * possible before; coding stays possible. Research was not; research needs
     * somebody to say so. `PAC Internal Development` has no repository, so the
     * coding it is implicitly granted is not work it can actually do — and the
     * investigation it wants still requires the explicit approval §21 demands.
     *
     * The migration writes `['coding']` explicitly for projects that had an
     * approved repository, so in practice this fallback fires only for rows
     * created afterwards. It is the safety net, not the mechanism.
     * ---------------------------------------------------------------------
     */
    const effective = project.allowedTaskKinds.length ? project.allowedTaskKinds : (['coding'] as const);
    const permitted = (effective as readonly TaskKind[]).includes(work.taskKind);
    checks.push(
      check(
        'task_kind_permitted',
        permitted,
        permitted
          ? project.allowedTaskKinds.length
            ? `The project permits ${work.taskKind} work.`
            : `${work.taskKind} work was already possible here before task kinds existed, so it stays permitted.`
          : `Nobody has approved this project for ${work.taskKind} work` +
            (project.allowedTaskKinds.length
              ? ` (allowed here: ${project.allowedTaskKinds.join(', ')}).`
              : '; only coding is permitted until an administrator allows more.'),
      ),
    );
  }

  checks.push(
    check(
      'brief_exists',
      mac.briefConfidence !== null,
      mac.briefConfidence !== null
        ? 'A handoff brief exists.'
        : 'No handoff brief. Mac needs a structured understanding before he may do anything.',
    ),
  );

  const confidence = mac.briefConfidence ?? 0;
  const aboveFloor = mac.briefConfidence !== null && toScaled(confidence) >= toScaled(policy.minExecutionConfidence);
  checks.push(
    check(
      'confidence_above_floor',
      aboveFloor,
      aboveFloor
        ? `Understanding confidence ${(confidence * 100).toFixed(0)}% is above the ${(policy.minExecutionConfidence * 100).toFixed(0)}% floor.`
        : `Understanding confidence ${(confidence * 100).toFixed(0)}% is below the non-overridable execution floor.`,
    ),
  );

  /*
   * The band rule, and the reason it is stricter overnight than by day.
   *
   * Spec §5 permits the 60–79% band to proceed ONLY with an explicit human
   * decision on a narrower scope. Nobody is awake at 02:00 to make that
   * decision, so autonomous SELECTION requires the autonomous band — unless a
   * human already pre-approved a limited scope for this specific task during
   * the day, which is recorded and honoured.
   *
   * This is the rule that stops "keep Mac busy" from quietly eroding the
   * confidence model, and Sprint 3.3 does not soften it for research. Spec §19
   * of this sprint's brief is explicit: research can still spend money, read
   * sensitive material and produce consequential recommendations.
   */
  const autonomous = aboveFloor && toScaled(confidence) >= toScaled(policy.defaultConfidenceThreshold);
  const permitted = autonomous || (aboveFloor && mac.hasApprovedLimitedScope);
  checks.push(
    check(
      'confidence_permits_autonomy',
      permitted,
      autonomous
        ? `Confidence ${(confidence * 100).toFixed(0)}% is in the autonomous band.`
        : mac.hasApprovedLimitedScope
          ? 'Below the autonomy threshold, but a human pre-approved a limited scope for this task.'
          : `Confidence ${(confidence * 100).toFixed(0)}% needs an explicit human decision on scope, and nobody is awake to give one.`,
    ),
  );

  /*
   * The repository check — now conditional on the work needing one.
   *
   * This single line is the difference between "research needs a Git
   * repository" and "coding needs a Git repository". Sprint 3.3 §2.
   */
  if (taskKindRequiresRepository(work.taskKind)) {
    checks.push(
      check(
        'repository_approved',
        mac.repositoryApproved,
        mac.repositoryApproved ? 'Repository is approved.' : 'The project has no approved repository.',
      ),
    );
  }

  if (input.capability) {
    const { workerAvailable, reasoningModelAvailable, unmetRequirements } = input.capability;

    checks.push(
      check(
        'worker_capability_available',
        workerAvailable,
        workerAvailable
          ? 'A worker advertising the required capability is online.'
          : `No online worker advertises the capability ${work.taskKind} work needs. ` +
            'The run would sit queued rather than execute, so it is not started.',
      ),
    );

    /*
     * The model check, emitted only for work that genuinely needs to reason.
     *
     * Sprint 3.3 §10: a null provider must not silently stand in for a model
     * during real research, because an empty result is indistinguishable in a
     * report from a completed investigation that found nothing.
     */
    if (taskKindRequiresReasoningModel(work.taskKind)) {
      checks.push(
        check(
          'reasoning_model_available',
          reasoningModelAvailable,
          reasoningModelAvailable
            ? 'A real reasoning-model provider is configured.'
            : 'No reasoning-model provider is configured (MODEL_PROVIDER_REQUIRED). General work will not be ' +
              'run against a null provider, because it would produce an empty result that reads like a finished one.',
        ),
      );
    }

    // Repository and reasoning model each own a check above; counting them here
    // too would report one problem twice in the summary line.
    const remaining = unmetRequirements.filter((r) => r !== 'repository' && r !== 'reasoning_model');
    checks.push(
      check(
        'project_capabilities_sufficient',
        remaining.length === 0,
        remaining.length === 0
          ? 'The project holds everything this work requires.'
          : `Missing: ${remaining.join(', ')}.`,
      ),
    );
  }

  checks.push(
    check(
      'no_active_run',
      !mac.hasActiveRun && !mac.attemptedThisShift,
      mac.hasActiveRun
        ? 'A run for this task is already in flight.'
        : mac.attemptedThisShift
          ? 'Mac already worked on this task tonight.'
          : 'No run in flight, and not attempted tonight.',
    ),
  );

  checks.push(
    check(
      'not_previously_blocked',
      !mac.blockedEarlierTonight,
      mac.blockedEarlierTonight
        ? 'This task blocked earlier tonight and the blocker is unresolved; retrying it would just block again.'
        : 'Not blocked earlier tonight.',
    ),
  );

  const blockingCodes = checks.filter((c) => !c.ok).map((c) => c.code);
  const eligible = blockingCodes.length === 0;

  return {
    eligible,
    checks,
    blockingCodes,
    priorityRank: computePriorityRank(input),
    summary: eligible
      ? `Eligible: ${work.title}`
      : `Not eligible — ${blockingCodes.map((c) => ELIGIBILITY_LABELS[c]).join('; ')}`,
  };
}

/**
 * Ordering, lower first: priority, then due date, then position.
 *
 * Composed into one number so the caller sorts on a single key and cannot
 * accidentally apply the tiebreakers in a different order somewhere else.
 *
 * Due date contributes a bounded amount — at most one priority band's worth —
 * so an urgent item due next month still outranks a low-priority one due
 * tomorrow. Commercial priority is a human's judgement about importance and
 * must not be silently overridden by a date.
 *
 * Sprint 3.3: a direct task has no monday priority, so its own `priority`
 * column supplies the rank. The two scales are deliberately identical
 * (`PRIORITY_RANK` and `MONDAY_PRIORITY_RANK` both put urgent/critical at 0 and
 * low at 3), which is what lets one ordered list contain both without either
 * source being systematically advantaged.
 */
export function computePriorityRank(input: EligibilityInput): number {
  const work = resolveWork(input);
  const priority = input.item
    ? mondayPriorityRank(input.item.priority)
    : PRIORITY_RANK[work.priority];

  const dueMs = input.item?.dueDate ? Date.parse(input.item.dueDate) : Number.NaN;
  const daysAway = Number.isNaN(dueMs) ? null : (dueMs - Date.now()) / 86_400_000;
  // 0 when overdue or due today, approaching 1 as the date recedes past 30 days.
  const urgency = daysAway === null ? 0.5 : Math.max(0, Math.min(1, daysAway / 30));

  const order = Math.min(input.boardOrder ?? 0, 999) / 1000;

  return priority + urgency * 0.9 + order * 0.09;
}

/** Case- and whitespace-insensitive, because board labels are typed by humans. */
const normalise = (value: string): string => value.trim().toLowerCase();
