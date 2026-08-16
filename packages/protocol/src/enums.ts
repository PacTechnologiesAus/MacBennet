import { z } from 'zod';

/**
 * Every enumeration in the system is declared exactly once, here, and is
 * consumed by the database schema, the HTTP layer, the worker and the UI.
 * A value that is not in this file cannot enter the system.
 */

export const USER_ROLES = ['admin', 'operator', 'viewer'] as const;
export const userRoleSchema = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof userRoleSchema>;

/** Ordered weakest → strongest. Used by the role gate. */
export const ROLE_RANK: Record<UserRole, number> = { viewer: 0, operator: 1, admin: 2 };

export const TASK_STATUSES = ['draft', 'ready', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const taskPrioritySchema = z.enum(TASK_PRIORITIES);
export type TaskPriority = z.infer<typeof taskPrioritySchema>;

/** Dispatch ordering: urgent first. Lower number = dispatched sooner. */
export const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/**
 * Spec §24's twelve suggested run states, plus `failed`.
 *
 * `failed` is an addition: §24 has no way to express "the job executed and did
 * not succeed", and folding that into `completed` would make the dashboard
 * report failures as successes. Recorded as assumption A-1 in the design.
 */
export const RUN_STATUSES = [
  'draft',
  'discovery',
  'ready_for_approval',
  'approved',
  'queued',
  'running',
  'blocked',
  'self_review',
  'ready_for_human_review',
  'completed',
  'stopped_by_guardrail',
  'cancelled',
  'failed',
] as const;
export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const TERMINAL_RUN_STATUSES = ['completed', 'stopped_by_guardrail', 'cancelled', 'failed'] as const;
export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

export const isTerminalRunStatus = (status: RunStatus): status is TerminalRunStatus =>
  (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);

export const APPROVAL_STATES = ['not_required', 'pending', 'approved', 'rejected', 'revoked'] as const;
export const approvalStateSchema = z.enum(APPROVAL_STATES);
export type ApprovalState = z.infer<typeof approvalStateSchema>;

export const APPROVAL_ACTIONS = ['approve', 'reject', 'revoke'] as const;
export const approvalActionSchema = z.enum(APPROVAL_ACTIONS);
export type ApprovalAction = z.infer<typeof approvalActionSchema>;

export const WORKER_STATUSES = ['registered', 'idle', 'busy', 'offline', 'disabled'] as const;
export const workerStatusSchema = z.enum(WORKER_STATUSES);
export type WorkerStatus = z.infer<typeof workerStatusSchema>;

/**
 * `interactive` — human authorised this work to happen now (spec §3 Day Mode).
 * `overnight`   — autonomous night-shift work, subject to the cutoff (spec §26).
 */
export const EXECUTION_MODES = ['interactive', 'overnight'] as const;
export const executionModeSchema = z.enum(EXECUTION_MODES);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

export const ACTOR_TYPES = ['user', 'worker', 'system'] as const;
export const actorTypeSchema = z.enum(ACTOR_TYPES);
export type ActorType = z.infer<typeof actorTypeSchema>;

export const LOG_STREAMS = ['stdout', 'stderr', 'system'] as const;
export const logStreamSchema = z.enum(LOG_STREAMS);
export type LogStream = z.infer<typeof logStreamSchema>;

/**
 * Machine-readable reasons a run stopped. Free text goes in the audit event
 * metadata; this field stays enumerable so the UI and future reporting can
 * group by it.
 */
export const STOP_REASONS = [
  'completed',
  'failed',
  'cancelled_by_user',
  'force_cancelled_worker_unreachable',
  'overnight_cutoff',
  'budget_exhausted',
  'confidence_below_threshold',
  'unsupported_job_kind',
  'worker_error',
  // --- Sprint 2 ---
  /** A coding agent attempted an operation the git policy forbids. */
  'prohibited_git_operation',
  /** The coding agent itself failed — crashed, unauthenticated, or unavailable. */
  'coding_agent_error',
  /** Work stopped because a decision was too risky to make without a human. */
  'blocked_unsafe_decision',
  /** The repository is not approved, or approval was withdrawn. */
  'repository_not_approved',
  /** The session exceeded its configured wall-clock limit. */
  'agent_time_limit',
  /** Completed, but part of the work was left unimplemented and reported. */
  'completed_with_blockers',
] as const;
export const stopReasonSchema = z.enum(STOP_REASONS);
export type StopReason = z.infer<typeof stopReasonSchema>;

/** Outcome a worker may report when finishing a run. */
export const RUN_OUTCOMES = ['succeeded', 'failed', 'cancelled'] as const;
export const runOutcomeSchema = z.enum(RUN_OUTCOMES);
export type RunOutcome = z.infer<typeof runOutcomeSchema>;

/**
 * How risky a decision is, independent of how confident Mac is about it.
 *
 * This axis exists because confidence alone is the wrong control: a confident
 * wrong answer to "should I drop this table" is worse than an unconfident one.
 * `high` blocks regardless of confidence (Sprint 2 §9).
 */
export const DECISION_RISKS = ['low', 'medium', 'high'] as const;
export const decisionRiskSchema = z.enum(DECISION_RISKS);
export type DecisionRisk = z.infer<typeof decisionRiskSchema>;

/** Outcome of the self-review phase (Sprint 2 §12). */
export const REVIEW_VERDICTS = [
  'satisfies_brief',
  'partially_satisfies_brief',
  'does_not_satisfy_brief',
  'unreviewable',
] as const;
export const reviewVerdictSchema = z.enum(REVIEW_VERDICTS);
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export const riskLevelSchema = z.enum(RISK_LEVELS);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

/** Lifecycle of an isolated worktree. `preserved` is the safe default. */
export const WORKTREE_STATUSES = ['active', 'preserved', 'removed'] as const;
export const worktreeStatusSchema = z.enum(WORKTREE_STATUSES);
export type WorktreeStatus = z.infer<typeof worktreeStatusSchema>;

/** Memory layers from spec §9. Task memory must not contaminate other tasks. */
export const MEMORY_SCOPES = ['global', 'project', 'task'] as const;
export const memoryScopeSchema = z.enum(MEMORY_SCOPES);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

export const DISCOVERY_STATUSES = ['open', 'brief_drafted', 'ready', 'closed'] as const;
export const discoveryStatusSchema = z.enum(DISCOVERY_STATUSES);
export type DiscoveryStatus = z.infer<typeof discoveryStatusSchema>;

export const AUDIT_EVENT_TYPES = [
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'project.created',
  'project.updated',
  'task.created',
  'task.updated',
  'run.created',
  'run.submitted_for_approval',
  'run.approved',
  'run.rejected',
  'run.queued',
  'run.dispatched',
  'run.progress_stage_changed',
  'run.completed',
  'run.failed',
  'run.cancel_requested',
  'run.cancelled',
  'run.force_cancelled',
  'run.stopped_by_guardrail',
  'run.transition_rejected',
  'worker.enrollment_token_created',
  'worker.registered',
  'worker.online',
  'worker.offline',
  'worker.unauthorized_run_access',
  'guardrail.blocked',
  'settings.updated',

  // --- Sprint 2 -------------------------------------------------------------
  // Sprint 2 §20 lists the events the trail must contain. Each one below maps
  // to exactly one item in that list; nothing is emitted that a reviewer has no
  // use for.
  'repository.created',
  'repository.updated',
  'repository.approved',
  'repository.approval_revoked',

  'discovery.started',
  'discovery.context_inspected',
  'discovery.message_recorded',
  'discovery.question_asked',
  'discovery.question_answered',

  'brief.created',
  'brief.updated',
  'brief.confidence_calculated',

  'worktree.created',
  'worktree.preserved',
  'worktree.removed',
  'git.operation_rejected',

  'coding_session.started',
  'coding_session.question',
  'coding_session.answered',
  'coding_session.assumption_recorded',
  'coding_session.blocked',
  'coding_session.activity',
  'coding_session.completed',
  'coding_session.failed',

  'test.run',
  'test.failed',

  'run.self_review',
  'run.review_completed',

  'pull_request.created',
  'pull_request.declined',

  'usage.snapshot',
  'report.generated',

  'memory.recorded',
  'memory.promoted',
] as const;
export const auditEventTypeSchema = z.enum(AUDIT_EVENT_TYPES);
export type AuditEventType = z.infer<typeof auditEventTypeSchema>;
