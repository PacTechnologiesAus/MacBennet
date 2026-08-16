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
] as const;
export const stopReasonSchema = z.enum(STOP_REASONS);
export type StopReason = z.infer<typeof stopReasonSchema>;

/** Outcome a worker may report when finishing a run. */
export const RUN_OUTCOMES = ['succeeded', 'failed', 'cancelled'] as const;
export const runOutcomeSchema = z.enum(RUN_OUTCOMES);
export type RunOutcome = z.infer<typeof runOutcomeSchema>;

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
] as const;
export const auditEventTypeSchema = z.enum(AUDIT_EVENT_TYPES);
export type AuditEventType = z.infer<typeof auditEventTypeSchema>;
