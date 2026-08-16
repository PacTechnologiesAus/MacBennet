import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  ACTOR_TYPES,
  APPROVAL_ACTIONS,
  APPROVAL_STATES,
  AUDIT_EVENT_TYPES,
  EXECUTION_MODES,
  JOB_KINDS,
  LOG_STREAMS,
  RUN_STATUSES,
  STOP_REASONS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  USER_ROLES,
  WORKER_STATUSES,
} from '@mac/protocol';

/**
 * Enumerations are expressed as text columns with CHECK constraints rather than
 * Postgres ENUM types: adding a value to a Postgres ENUM is awkward inside a
 * transaction and it can never be removed, whereas a CHECK is a one-line
 * migration in either direction.
 *
 * The CHECK constraints themselves live in the hand-written migrations, so the
 * enum lists are necessarily duplicated between here and `drizzle/*.sql`. That
 * duplication is made safe by `ENUM_CHECKS` below plus the schema-parity test,
 * which fails if the two ever disagree.
 *
 * `values` is not used to build the column — it is passed so each declaration
 * names, at the point of use, which enum the column is constrained to.
 */
const enumText = (name: string, _values: readonly string[]) => text(name);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: enumText('role', USER_ROLES).notNull().default('viewer'),
    passwordHash: text('password_hash').notNull(),
    passwordSalt: text('password_salt').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: uniqueIndex('users_email_key').on(t.email),
  }),
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Only the SHA-256 hash of the session token is stored, so a database dump
    // does not yield usable session credentials.
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
    userIdx: index('sessions_user_id_idx').on(t.userId),
  }),
);

/** Singleton row (id = 1) enforced by a CHECK constraint in the migration. */
export const settings = pgTable('settings', {
  id: smallint('id').primaryKey().default(1),
  timezone: text('timezone').notNull().default('Australia/Sydney'),
  /** Wall-clock HH:MM in `timezone`. Spec §3: normal hard stop is 08:00 Sydney. */
  overnightCutoff: text('overnight_cutoff').notNull().default('08:00'),
  /** Autonomy threshold (spec §5, 80%). Stored as a fraction in [0,1]. */
  defaultConfidenceThreshold: numeric('default_confidence_threshold', { precision: 4, scale: 3 })
    .notNull()
    .default('0.800'),
  /** Hard floor (spec §5, 60%). Cannot be overridden through the API. */
  minExecutionConfidence: numeric('min_execution_confidence', { precision: 4, scale: 3 })
    .notNull()
    .default('0.600'),
  nightlyBudgetCents: integer('nightly_budget_cents').notNull().default(5000),
  currency: text('currency').notNull().default('AUD'),
  budgetWarningPct: integer('budget_warning_pct').notNull().default(80),
  budgetStopPct: integer('budget_stop_pct').notNull().default(100),
  heartbeatIntervalSeconds: integer('heartbeat_interval_seconds').notNull().default(10),
  heartbeatGraceSeconds: integer('heartbeat_grace_seconds').notNull().default(20),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
});

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    /** Repository reference. Sprint 1 stores it; nothing clones it yet. */
    repoUrl: text('repo_url'),
    repoDefaultBranch: text('repo_default_branch').default('main'),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugIdx: uniqueIndex('projects_slug_key').on(t.slug),
  }),
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    status: enumText('status', TASK_STATUSES).notNull().default('draft'),
    priority: enumText('priority', TASK_PRIORITIES).notNull().default('normal'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdx: index('tasks_project_id_idx').on(t.projectId),
    statusIdx: index('tasks_status_idx').on(t.status),
  }),
);

export const workers = pgTable(
  'workers',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    status: enumText('status', WORKER_STATUSES).notNull().default('registered'),
    capabilities: jsonb('capabilities').notNull().default(sql`'[]'::jsonb`),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    /** Set on dispatch, cleared on completion. Denormalised for the dashboard. */
    currentRunId: uuid('current_run_id'),
    tokenHash: text('token_hash').notNull(),
    /** First few characters of the token, for display only. Not a secret. */
    tokenPrefix: text('token_prefix').notNull(),
    version: text('version'),
    platform: text('platform'),
    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: uniqueIndex('workers_name_key').on(t.name),
    tokenHashIdx: uniqueIndex('workers_token_hash_key').on(t.tokenHash),
  }),
);

export const workerEnrollmentTokens = pgTable(
  'worker_enrollment_tokens',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    label: text('label').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    usedByWorkerId: uuid('used_by_worker_id').references(() => workers.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex('worker_enrollment_tokens_token_hash_key').on(t.tokenHash),
  }),
);

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    status: enumText('status', RUN_STATUSES).notNull().default('draft'),
    workerId: uuid('worker_id').references(() => workers.id, { onDelete: 'set null' }),
    approvalState: enumText('approval_state', APPROVAL_STATES).notNull().default('pending'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),

    // What the worker is to do. Validated against the allowlist at creation,
    // again at dispatch, and again by the worker.
    jobKind: enumText('job_kind', JOB_KINDS).notNull(),
    jobParams: jsonb('job_params').notNull().default(sql`'{}'::jsonb`),

    executionMode: enumText('execution_mode', EXECUTION_MODES).notNull().default('interactive'),
    /**
     * Resolved instant of the overnight cutoff for this run, computed when the
     * run is queued. Stored rather than derived so the deadline is stable and
     * inspectable, and does not move if settings are edited mid-run.
     */
    overnightDeadlineAt: timestamp('overnight_deadline_at', { withTimezone: true }),

    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    attempt: integer('attempt').notNull().default(0),

    progressPercent: integer('progress_percent'),
    progressStage: text('progress_stage'),
    summary: text('summary'),

    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    cancelRequestedBy: uuid('cancel_requested_by').references(() => users.id, { onDelete: 'set null' }),
    /** Reason the run stopped, whatever the terminal status. */
    stopReason: enumText('stop_reason', STOP_REASONS),

    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    taskIdx: index('runs_task_id_idx').on(t.taskId),
    statusIdx: index('runs_status_idx').on(t.status),
    workerIdx: index('runs_worker_id_idx').on(t.workerId),
    // Supports the dispatch query, which is the hottest path in the system.
    dispatchIdx: index('runs_dispatch_idx').on(t.status, t.approvalState, t.createdAt),
  }),
);

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    action: enumText('action', APPROVAL_ACTIONS).notNull(),
    approverUserId: uuid('approver_user_id').references(() => users.id, { onDelete: 'set null' }),
    notes: text('notes'),
    // The confidence and threshold *at the moment of the decision*, so the
    // record still makes sense after settings change.
    confidenceAtDecision: numeric('confidence_at_decision', { precision: 4, scale: 3 }),
    thresholdAtDecision: numeric('threshold_at_decision', { precision: 4, scale: 3 }),
    thresholdOverridden: boolean('threshold_overridden').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index('approvals_run_id_idx').on(t.runId),
  }),
);

export const runLogs = pgTable(
  'run_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    /** Monotonic per run. Unique with runId so retried batches are idempotent. */
    seq: integer('seq').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    stream: enumText('stream', LOG_STREAMS).notNull(),
    message: text('message').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runSeqIdx: uniqueIndex('run_logs_run_id_seq_key').on(t.runId, t.seq),
  }),
);

/**
 * Provider usage. Ships empty in Sprint 1 — there is no provider cost
 * integration yet — but exists so the budget guardrail sums real rows rather
 * than being a stub. `isExact` encodes spec §25's rule that an estimate must
 * never be presented as exact provider usage.
 */
export const runUsage = pgTable(
  'run_usage',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    kind: text('kind').notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 4 }),
    unit: text('unit'),
    costCents: integer('cost_cents'),
    isExact: boolean('is_exact').notNull().default(false),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index('run_usage_run_id_idx').on(t.runId),
    recordedIdx: index('run_usage_recorded_at_idx').on(t.recordedAt),
  }),
);

/**
 * Append-only. A BEFORE UPDATE OR DELETE trigger (see the migration) raises an
 * exception, so immutability is enforced by the database rather than by
 * convention — this is the artefact that makes an autonomous agent reviewable.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    /**
     * Authoritative ordering key. `ts` alone is not sufficient: several events
     * are written inside one transaction, and clock values can tie. `seq` is
     * allocated at INSERT time, so it always reflects the order things actually
     * happened — which is what makes the trail replayable.
     */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    actorType: enumText('actor_type', ACTOR_TYPES).notNull(),
    actorId: uuid('actor_id'),
    /** Denormalised so the trail stays readable after a user is renamed or removed. */
    actorLabel: text('actor_label').notNull(),
    eventType: enumText('event_type', AUDIT_EVENT_TYPES).notNull(),
    projectId: uuid('project_id'),
    taskId: uuid('task_id'),
    runId: uuid('run_id'),
    workerId: uuid('worker_id'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    tsIdx: index('audit_events_ts_idx').on(t.ts),
    runIdx: index('audit_events_run_id_idx').on(t.runId),
    taskIdx: index('audit_events_task_id_idx').on(t.taskId),
    projectIdx: index('audit_events_project_id_idx').on(t.projectId),
    typeIdx: index('audit_events_event_type_idx').on(t.eventType),
  }),
);

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type SettingsRow = typeof settings.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type WorkerRow = typeof workers.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type RunLogRow = typeof runLogs.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type EnrollmentTokenRow = typeof workerEnrollmentTokens.$inferSelect;

/** Re-exported so the migration generator can emit the CHECK constraints. */
export const ENUM_CHECKS: Array<{ table: string; column: string; values: readonly string[] }> = [
  { table: 'users', column: 'role', values: USER_ROLES },
  { table: 'tasks', column: 'status', values: TASK_STATUSES },
  { table: 'tasks', column: 'priority', values: TASK_PRIORITIES },
  { table: 'runs', column: 'status', values: RUN_STATUSES },
  { table: 'runs', column: 'approval_state', values: APPROVAL_STATES },
  { table: 'runs', column: 'job_kind', values: JOB_KINDS },
  { table: 'runs', column: 'execution_mode', values: EXECUTION_MODES },
  { table: 'runs', column: 'stop_reason', values: STOP_REASONS },
  { table: 'workers', column: 'status', values: WORKER_STATUSES },
  { table: 'approvals', column: 'action', values: APPROVAL_ACTIONS },
  { table: 'run_logs', column: 'stream', values: LOG_STREAMS },
  { table: 'audit_events', column: 'actor_type', values: ACTOR_TYPES },
  { table: 'audit_events', column: 'event_type', values: AUDIT_EVENT_TYPES },
];
