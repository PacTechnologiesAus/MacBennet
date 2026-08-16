import {
  bigint,
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
  AGENT_ANSWER_DECISIONS,
  AGENT_SESSION_STATES,
  APPROVAL_ACTIONS,
  APPROVAL_STATES,
  AUDIT_EVENT_TYPES,
  BRIEF_STATUSES,
  CODING_AGENT_PROVIDERS,
  DECISION_RISKS,
  DISCOVERY_STATUSES,
  EXECUTION_MODES,
  JOB_KINDS,
  LOG_STREAMS,
  MEMORY_SCOPES,
  RISK_LEVELS,
  REVIEW_VERDICTS,
  RUN_STATUSES,
  SCOPE_KINDS,
  STOP_REASONS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  USAGE_SOURCES,
  USAGE_SNAPSHOT_PHASES,
  USER_ROLES,
  WORKER_STATUSES,
  WORKTREE_STATUSES,
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

  // --- Sprint 2 ---
  /**
   * Soft threshold on usage that is NOT exact money. It warns; it stops
   * execution only when `softUsageStopsExecution` is set, and the UI always
   * shows that this is an uncertain signal (Sprint 2 §17).
   */
  softUsageThresholdPct: integer('soft_usage_threshold_pct').notNull().default(80),
  softUsageStopsExecution: boolean('soft_usage_stops_execution').notNull().default(false),
  codingAgentEnabled: boolean('coding_agent_enabled').notNull().default(true),
  maxAgentMinutes: integer('max_agent_minutes').notNull().default(60),
  maxQuestionsPerRun: integer('max_questions_per_run').notNull().default(20),
  /** At or above this, Mac answers outright; below it he records an assumption. */
  answerConfidenceThreshold: numeric('answer_confidence_threshold', { precision: 4, scale: 3 })
    .notNull()
    .default('0.800'),

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

    // --- Sprint 2 ---
    /** Which approved repository this run works in. Null for non-repository jobs. */
    repositoryId: uuid('repository_id'),
    handoffBriefId: uuid('handoff_brief_id'),
    /**
     * What the human actually authorised. In the 60–79% band this is narrower
     * than the brief describes, and that difference is the entire point of the
     * band — so it is recorded rather than implied.
     */
    scopeKind: enumText('scope_kind', SCOPE_KINDS).notNull().default('full'),
    approvedScope: text('approved_scope'),
  },
  (t) => ({
    taskIdx: index('runs_task_id_idx').on(t.taskId),
    repositoryIdx: index('runs_repository_id_idx').on(t.repositoryId),
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
    /**
     * Sprint 1's boolean, kept and maintained in step with `source` so no
     * existing query silently changed meaning when the four-valued model
     * replaced it.
     */
    isExact: boolean('is_exact').notNull().default(false),
    /** Sprint 2: exact | observed | estimated | unavailable. */
    source: enumText('source', USAGE_SOURCES).notNull().default('estimated'),
    model: text('model'),
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

// ===========================================================================
// Sprint 2 — repositories, briefs, discovery, coding sessions, review, usage
// ===========================================================================

/**
 * An approved repository Mac may work in.
 *
 * `isApproved` is the gate. The dispatch statement joins against it, so a run
 * against an unapproved repository is unselectable rather than merely rejected
 * — the same shape as the Sprint 1 approval guardrail, for the same reason.
 */
export const repositories = pgTable(
  'repositories',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    remoteUrl: text('remote_url').notNull(),
    /** Where the clone lives on the worker VM. Admin-configured, never run-supplied. */
    localPath: text('local_path').notNull(),
    defaultBranch: text('default_branch').notNull().default('main'),
    remoteName: text('remote_name').notNull().default('origin'),
    isApproved: boolean('is_approved').notNull().default(false),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
    lastKnownDefaultSha: text('last_known_default_sha'),
    /**
     * argv ARRAYS, not command strings. Admin-only, audited on change, executed
     * with shell:false. This is the only project-specific command in the system
     * and it cannot express a pipeline, a redirect or a metacharacter.
     */
    testCommand: jsonb('test_command').notNull().default(sql`'[]'::jsonb`),
    buildCommand: jsonb('build_command').notNull().default(sql`'[]'::jsonb`),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdx: index('repositories_project_id_idx').on(t.projectId),
    projectNameIdx: uniqueIndex('repositories_project_name_key').on(t.projectId, t.name),
  }),
);

export const handoffBriefs = pgTable(
  'handoff_briefs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    status: text('status').notNull().default('draft'),
    content: jsonb('content').notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull().default('0'),
    /** Provenance only. Never the specification handed to a coding agent. */
    sourceConversation: text('source_conversation').notNull().default(''),
    contextSummary: text('context_summary'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    taskIdx: index('handoff_briefs_task_id_idx').on(t.taskId),
    taskVersionIdx: uniqueIndex('handoff_briefs_task_version_key').on(t.taskId, t.version),
  }),
);

export const discoverySessions = pgTable(
  'discovery_sessions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('open'),
    messages: jsonb('messages').notNull().default(sql`'[]'::jsonb`),
    contextSummary: text('context_summary'),
    contextSnapshot: jsonb('context_snapshot'),
    contextInspectedAt: timestamp('context_inspected_at', { withTimezone: true }),
    briefId: uuid('brief_id').references(() => handoffBriefs.id, { onDelete: 'set null' }),
    /** The single next question. Spec §4: Mac asks one at a time. */
    pendingQuestion: jsonb('pending_question'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    taskIdx: index('discovery_sessions_task_id_idx').on(t.taskId),
    projectIdx: index('discovery_sessions_project_id_idx').on(t.projectId),
  }),
);

export const worktrees = pgTable(
  'worktrees',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    branch: text('branch').notNull(),
    baseBranch: text('base_branch').notNull(),
    baseSha: text('base_sha').notNull(),
    headSha: text('head_sha'),
    commitCount: integer('commit_count').notNull().default(0),
    /** `preserved` is the safe default whenever a human might need to look. */
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (t) => ({
    runIdx: uniqueIndex('worktrees_run_id_key').on(t.runId),
    repoIdx: index('worktrees_repository_id_idx').on(t.repositoryId),
  }),
);

export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerSessionId: text('provider_session_id'),
    providerVersion: text('provider_version'),
    model: text('model'),
    state: text('state').notNull().default('starting'),
    currentActivity: text('current_activity'),
    highestEventSeq: integer('highest_event_seq').notNull().default(-1),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => ({
    runIdx: uniqueIndex('agent_sessions_run_id_key').on(t.runId),
  }),
);

/** Every question and every answer, with reasoning and sources (Sprint 2 §8). */
export const agentQuestions = pgTable(
  'agent_questions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    agentSessionId: uuid('agent_session_id').references(() => agentSessions.id, { onDelete: 'set null' }),
    /** The agent's own id for the question. Makes a retried upload idempotent. */
    externalId: text('external_id').notNull(),
    seq: integer('seq').notNull(),
    question: text('question').notNull(),
    context: text('context'),
    answer: text('answer'),
    decision: text('decision'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    reasoning: text('reasoning'),
    sources: jsonb('sources').notNull().default(sql`'[]'::jsonb`),
    risk: text('risk').notNull().default('low'),
    requiredHuman: boolean('required_human').notNull().default(false),
    affectedImplementation: boolean('affected_implementation').notNull().default(false),
    askedAt: timestamp('asked_at', { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
  },
  (t) => ({
    runIdx: index('agent_questions_run_id_idx').on(t.runId),
    externalIdx: uniqueIndex('agent_questions_run_external_key').on(t.runId, t.externalId),
  }),
);

export const runAssumptions = pgTable(
  'run_assumptions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    questionId: uuid('question_id').references(() => agentQuestions.id, { onDelete: 'set null' }),
    statement: text('statement').notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull(),
    reversible: boolean('reversible').notNull().default(true),
    /** Below the autonomy threshold → surfaced prominently in the report. */
    flagged: boolean('flagged').notNull().default(false),
    source: text('source'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index('run_assumptions_run_id_idx').on(t.runId),
  }),
);

export const runBlockers = pgTable(
  'run_blockers',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    questionId: uuid('question_id').references(() => agentQuestions.id, { onDelete: 'set null' }),
    description: text('description').notNull(),
    reason: text('reason').notNull(),
    risk: text('risk').notNull().default('high'),
    resolved: boolean('resolved').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index('run_blockers_run_id_idx').on(t.runId),
  }),
);

/**
 * Refused git operations.
 *
 * A table rather than a log line because this is a security event: it must be
 * queryable and countable, and a row here blocks PR creation outright.
 */
export const gitViolations = pgTable(
  'git_violations',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    argv: jsonb('argv').notNull().default(sql`'[]'::jsonb`),
    message: text('message').notNull(),
    /** 'mac' — Mac's own code was refused. 'agent' — the shim caught the agent. */
    origin: text('origin').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index('git_violations_run_id_idx').on(t.runId),
  }),
);

export const runReviews = pgTable(
  'run_reviews',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    verdict: text('verdict').notNull(),
    riskLevel: text('risk_level').notNull(),
    satisfiesBrief: boolean('satisfies_brief').notNull(),
    acceptanceCriteriaMet: boolean('acceptance_criteria_met').notNull(),
    unexpectedScope: boolean('unexpected_scope').notNull(),
    humanAttentionRequired: boolean('human_attention_required').notNull(),
    prRecommended: boolean('pr_recommended').notNull(),
    prDeclineReason: text('pr_decline_reason'),
    anomalies: jsonb('anomalies').notNull().default(sql`'[]'::jsonb`),
    /** The facts the verdict was drawn from, so it can be re-examined later. */
    evidence: jsonb('evidence').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runIdx: uniqueIndex('run_reviews_run_id_key').on(t.runId),
  }),
);

/**
 * Note what this table does NOT have: no `merged_at`, no `merge_sha`, no
 * `state`. Mac has no merge capability, so there is nowhere to record one.
 */
export const pullRequests = pgTable(
  'pull_requests',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('github'),
    number: integer('number'),
    url: text('url').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    branch: text('branch').notNull(),
    baseBranch: text('base_branch').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runIdx: uniqueIndex('pull_requests_run_id_key').on(t.runId),
  }),
);

/**
 * Provider usage readings.
 *
 * `source` is the load-bearing column: it says what KIND of number this is, and
 * it sits next to the number so the two can never be separated in a query, a
 * DTO or a report.
 */
export const usageSnapshots = pgTable(
  'usage_snapshots',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    phase: text('phase').notNull(),
    source: text('source').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }),
    outputTokens: bigint('output_tokens', { mode: 'number' }),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }),
    cacheCreationTokens: bigint('cache_creation_tokens', { mode: 'number' }),
    costCents: integer('cost_cents'),
    percentUsed: numeric('percent_used', { precision: 6, scale: 3 }),
    state: text('state'),
    reportingPeriod: text('reporting_period'),
    note: text('note'),
    raw: jsonb('raw').notNull().default(sql`'{}'::jsonb`),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index('usage_snapshots_run_id_idx').on(t.runId),
    uniqueIdx: uniqueIndex('usage_snapshots_run_provider_phase_key').on(t.runId, t.provider, t.phase),
  }),
);

export const runReports = pgTable(
  'run_reports',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
    content: jsonb('content').notNull(),
    markdown: text('markdown').notNull(),
  },
  (t) => ({
    runIdx: uniqueIndex('run_reports_run_id_key').on(t.runId),
  }),
);

/**
 * Memory (spec §9), three layers in one table.
 *
 * A CHECK constraint enforces the shape of each scope, which is what actually
 * prevents task memory from contaminating unrelated tasks: a task-scoped row
 * MUST carry a task_id, so it is unreachable from another task's query.
 */
export const memoryEntries = pgTable(
  'memory_entries',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    scope: text('scope').notNull(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull().default('1'),
    source: text('source'),
    /** Assumptions are never promoted; only validated high-confidence facts. */
    promoted: boolean('promoted').notNull().default(false),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdx: index('memory_entries_project_idx').on(t.projectId),
    taskIdx: index('memory_entries_task_idx').on(t.taskId),
    keyIdx: index('memory_entries_key_idx').on(t.key),
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

export type RepositoryRow = typeof repositories.$inferSelect;
export type HandoffBriefRow = typeof handoffBriefs.$inferSelect;
export type DiscoverySessionRow = typeof discoverySessions.$inferSelect;
export type WorktreeRow = typeof worktrees.$inferSelect;
export type AgentSessionRow = typeof agentSessions.$inferSelect;
export type AgentQuestionRow = typeof agentQuestions.$inferSelect;
export type RunAssumptionRow = typeof runAssumptions.$inferSelect;
export type RunBlockerRow = typeof runBlockers.$inferSelect;
export type GitViolationRow = typeof gitViolations.$inferSelect;
export type RunReviewRow = typeof runReviews.$inferSelect;
export type PullRequestRow = typeof pullRequests.$inferSelect;
export type UsageSnapshotRow = typeof usageSnapshots.$inferSelect;
export type RunReportRow = typeof runReports.$inferSelect;
export type MemoryEntryRow = typeof memoryEntries.$inferSelect;

/**
 * The authoritative list of enum CHECK constraints.
 *
 * The migrations are hand-written, so these lists are necessarily duplicated
 * between here and `drizzle/*.sql`. The schema-parity integration test reads
 * every CHECK constraint out of the live database and fails if any value in
 * this table is missing from it — which is what makes the duplication safe.
 */
export const ENUM_CHECKS: Array<{ table: string; column: string; values: readonly string[] }> = [
  { table: 'users', column: 'role', values: USER_ROLES },
  { table: 'tasks', column: 'status', values: TASK_STATUSES },
  { table: 'tasks', column: 'priority', values: TASK_PRIORITIES },
  { table: 'runs', column: 'status', values: RUN_STATUSES },
  { table: 'runs', column: 'approval_state', values: APPROVAL_STATES },
  { table: 'runs', column: 'job_kind', values: JOB_KINDS },
  { table: 'runs', column: 'execution_mode', values: EXECUTION_MODES },
  { table: 'runs', column: 'stop_reason', values: STOP_REASONS },
  { table: 'runs', column: 'scope_kind', values: SCOPE_KINDS },
  { table: 'workers', column: 'status', values: WORKER_STATUSES },
  { table: 'approvals', column: 'action', values: APPROVAL_ACTIONS },
  { table: 'run_logs', column: 'stream', values: LOG_STREAMS },
  { table: 'audit_events', column: 'actor_type', values: ACTOR_TYPES },
  { table: 'audit_events', column: 'event_type', values: AUDIT_EVENT_TYPES },
  // --- Sprint 2 ---
  { table: 'handoff_briefs', column: 'status', values: BRIEF_STATUSES },
  { table: 'discovery_sessions', column: 'status', values: DISCOVERY_STATUSES },
  { table: 'worktrees', column: 'status', values: WORKTREE_STATUSES },
  { table: 'agent_sessions', column: 'provider', values: CODING_AGENT_PROVIDERS },
  { table: 'agent_sessions', column: 'state', values: AGENT_SESSION_STATES },
  { table: 'agent_questions', column: 'decision', values: AGENT_ANSWER_DECISIONS },
  { table: 'agent_questions', column: 'risk', values: DECISION_RISKS },
  { table: 'run_blockers', column: 'risk', values: DECISION_RISKS },
  { table: 'run_reviews', column: 'verdict', values: REVIEW_VERDICTS },
  { table: 'run_reviews', column: 'risk', values: RISK_LEVELS },
  { table: 'usage_snapshots', column: 'phase', values: USAGE_SNAPSHOT_PHASES },
  { table: 'usage_snapshots', column: 'source', values: USAGE_SOURCES },
  { table: 'run_usage', column: 'source', values: USAGE_SOURCES },
  { table: 'memory_entries', column: 'scope', values: MEMORY_SCOPES },
];
