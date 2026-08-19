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
  APPROVAL_SOURCES,
  APPROVAL_STATES,
  AUDIT_EVENT_TYPES,
  BRIEF_STATUSES,
  CODING_AGENT_PROVIDERS,
  COMPANY_CONTEXT_PROVIDER_KINDS,
  COMPANY_CONTEXT_SOURCES,
  COMPANY_CONTEXT_STATUSES,
  COMPANY_CONTEXT_VALIDATION_STATES,
  COMPANY_PROPOSAL_STATUSES,
  DECISION_RISKS,
  DISCOVERY_STATUSES,
  EMAIL_DELIVERY_KINDS,
  EMAIL_DELIVERY_STATUSES,
  EXECUTION_MODES,
  GROUNDEDNESS,
  INVESTIGATION_SUBJECT_KINDS,
  JOB_KINDS,
  LOG_STREAMS,
  MAIL_PROVIDERS,
  MEMORY_SCOPES,
  MODEL_PROVIDERS,
  MONDAY_WRITE_KINDS,
  MONDAY_WRITE_STATUSES,
  NIGHT_DECISION_KINDS,
  NIGHT_SHIFT_STATUSES,
  NIGHT_STOP_REASONS,
  RISK_LEVELS,
  REVIEW_VERDICTS,
  RUN_SELECTION_SOURCES,
  RUN_STATUSES,
  ARTEFACT_FORMATS,
  ARTEFACT_TYPES,
  RESEARCH_STAGES,
  ACCEPTANCE_STATES,
  APPROVAL_REQUEST_STATES,
  APPROVAL_SUBJECT_KINDS,
  AUTHORITY_CLASSES,
  CONVERSATION_CHANNELS,
  CONVERSATION_STATUSES,
  DELIVERY_STATES,
  EVENT_DELIVERY_STATUSES,
  MAC_EVENT_TYPES,
  MESSAGE_DIRECTIONS,
  MESSAGE_INTENTS,
  OUTBOUND_KINDS,
  PARTICIPANT_KINDS,
  SOURCE_CLASSES,
  WEB_SEARCH_PROVIDERS,
  SANDBOX_KINDS,
  SANDBOX_NETWORK_MODES,
  SCOPE_KINDS,
  STOP_REASONS,
  TASK_KINDS,
  TASK_ORIGINS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  USAGE_SOURCES,
  USAGE_SNAPSHOT_PHASES,
  USER_ROLES,
  WORKER_STATUSES,
  WORKTREE_STATUSES,
} from '@mac/protocol';

/** Token lifecycle. `superseded` is the bounded overlap window (Sprint 3 §4). */
export const WORKER_TOKEN_STATUSES = ['active', 'superseded', 'revoked'] as const;
export const WORKER_TOKEN_ISSUE_ROUTES = ['enrollment', 'rotation', 'admin_reset'] as const;

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

  // --- Sprint 3 ---
  /**
   * When true, a coding run is not dispatched to a worker that has not attested
   * a working sandbox. Enforced as a predicate in the dispatch statement, so it
   * is not something a call site can forget.
   */
  requireSandbox: boolean('require_sandbox').notNull().default(true),
  workerTokenMaxAgeHours: integer('worker_token_max_age_hours').notNull().default(168),
  /** How long a superseded token keeps working. Short on purpose. */
  workerTokenOverlapSeconds: integer('worker_token_overlap_seconds').notNull().default(300),
  nightShiftEnabled: boolean('night_shift_enabled').notNull().default(false),
  nightShiftSafetyFactor: numeric('night_shift_safety_factor', { precision: 4, scale: 2 }).notNull().default('1.50'),
  nightShiftWrapUpMinutes: integer('night_shift_wrap_up_minutes').notNull().default(10),
  nightShiftMinStartMinutes: integer('night_shift_min_start_minutes').notNull().default(20),
  nightShiftLargeTaskMinMinutes: integer('night_shift_large_task_min_minutes').notNull().default(90),
  /**
   * The ONLY place a morning-report recipient can be configured.
   *
   * There is no recipient parameter anywhere in the send path, so nothing from
   * a task description, a brief, a monday item or a coding agent can introduce
   * an address (Sprint 3 §9.3).
   */
  reportRecipients: jsonb('report_recipients').notNull().default(sql`'[]'::jsonb`),
  allowedRecipientDomains: jsonb('allowed_recipient_domains').notNull().default(sql`'[]'::jsonb`),
  mailProvider: enumText('mail_provider', MAIL_PROVIDERS).notNull().default('none'),
  /** Off by default: determinism is the default posture for unattended work. */
  modelAssistEnabled: boolean('model_assist_enabled').notNull().default(false),
  modelProvider: enumText('model_provider', MODEL_PROVIDERS).notNull().default('none'),

  // --- Sprint 3.2 ---
  /**
   * Off by default, like every other integration that reaches a remote service.
   * With it off, company context is simply absent and nothing fails; with it on,
   * missing or invalid context FAILS context-dependent work rather than letting
   * a run look grounded when it is not (Sprint 3.2 §4.1, §10).
   */
  companyContextEnabled: boolean('company_context_enabled').notNull().default(false),
  /** Whether a previously validated revision may be used when GitHub is down. */
  companyContextAllowCached: boolean('company_context_allow_cached').notNull().default(true),
  /** Stops a night shift creating fifty runs from making fifty fetches. */
  companyContextMinRefreshSeconds: integer('company_context_min_refresh_seconds').notNull().default(60),
  /** Beyond this, cached context is reported as stale. 0 disables the check. */
  companyContextMaxStaleHours: integer('company_context_max_stale_hours').notNull().default(168),

  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  // --- Sprint 3.3 ---
  /** Master switch for general (non-coding) autonomous work. */
  generalWorkEnabled: boolean('general_work_enabled').notNull().default(true),
  maxResearchSteps: integer('max_research_steps').notNull().default(8),
  maxResearchToolCalls: integer('max_research_tool_calls').notNull().default(40),
  /**
   * External research is OFF by default.
   *
   * It is the only capability in the system that reaches outside PAC, and a
   * capability like that should be switched on deliberately rather than
   * inherited from a default somebody chose while thinking about something else.
   */
  externalResearchEnabled: boolean('external_research_enabled').notNull().default(false),
  allowedResearchDomains: jsonb('allowed_research_domains').notNull().default(sql`'[]'::jsonb`),

  // --- Phase 4 ---
  /** Off, like every integration that reaches outside this process. */
  teamsEnabled: boolean('teams_enabled').notNull().default(false),
  /**
   * Teams identities permitted to assign work and approve, by AAD object id or
   * UPN.
   *
   * Empty means nobody, and that is the safe reading rather than an oversight:
   * an unrecognised Teams sender may talk to Mac and ask for status, and may
   * not create work or authorise anything. Authorisation is not something a
   * chat platform confers.
   */
  teamsAuthorisedUsers: jsonb('teams_authorised_users').notNull().default(sql`'[]'::jsonb`),
  teamsNotifyBlockers: boolean('teams_notify_blockers').notNull().default(true),
  teamsNotifyApprovals: boolean('teams_notify_approvals').notNull().default(true),
  /**
   * Off. The morning report is long, arrives at 08:00, and is already emailed.
   * Part G §27 is explicit that Teams must not become progress chatter, and a
   * daily report is the thickest end of that wedge.
   */
  teamsNotifyReports: boolean('teams_notify_reports').notNull().default(false),

  forjaEnabled: boolean('forja_enabled').notNull().default(false),

  webSearchProvider: enumText('web_search_provider', WEB_SEARCH_PROVIDERS).notNull().default('none'),
  maxWebResultsPerSearch: integer('max_web_results_per_search').notNull().default(8),
  /**
   * Whether a search result's host may be fetched without being on the
   * research-domain allowlist.
   *
   * Off. A search provider that could choose what Mac may retrieve would make
   * the administrator's allowlist decorative — and a poisoned result set is a
   * cheaper attack than compromising a host PAC already trusts.
   */
  allowFetchFromSearchResults: boolean('allow_fetch_from_search_results').notNull().default(false),

  acceptanceVerificationEnabled: boolean('acceptance_verification_enabled').notNull().default(true),
  /** Separately switchable: semantic criteria cost model calls. */
  acceptanceSemanticReviewEnabled: boolean('acceptance_semantic_review_enabled').notNull().default(true),
  acceptanceRemediationEnabled: boolean('acceptance_remediation_enabled').notNull().default(true),

  conversationSummaryThreshold: integer('conversation_summary_threshold').notNull().default(24),
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
    /**
     * Sprint 3: the first of two gates on autonomous work selection.
     *
     * A project must be explicitly approved before Mac may take work from it
     * overnight, and the monday board must be approved too. Revoking either
     * stops future selection without any call site remembering to check — the
     * same shape as `repositories.is_approved`.
     */
    nightShiftApproved: boolean('night_shift_approved').notNull().default(false),
    nightShiftApprovedBy: uuid('night_shift_approved_by').references(() => users.id, { onDelete: 'set null' }),
    nightShiftApprovedAt: timestamp('night_shift_approved_at', { withTimezone: true }),
    /**
     * Sprint 3.3: what this project actually HAS.
     *
     * A statement of fact, not a grant of authority. A project with no
     * repository is a project that does research, not a misconfigured one.
     */
    capabilities: jsonb('capabilities').notNull().default(sql`'[]'::jsonb`),
    /**
     * Sprint 3.3: what a human has ALLOWED to happen here.
     *
     * Empty means nothing is allowed yet. Deliberately a separate axis from
     * `capabilities` — having a repository does not imply anyone wants Mac
     * writing code in it.
     */
    allowedTaskKinds: jsonb('allowed_task_kinds').notNull().default(sql`'[]'::jsonb`),
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
    /**
     * Sprint 3.3: the requester's own rough sense of how well-specified this is.
     *
     * NEVER an execution gate. Mac's understanding confidence is DERIVED through
     * discovery and lives on `handoff_briefs.confidence`; this column was
     * renamed from `confidence` precisely so the two can no longer be confused
     * for one another (reconciliation drift D-7).
     */
    userInitialConfidence: numeric('user_initial_confidence', { precision: 4, scale: 3 }),
    /** Sprint 3.3: what kind of work this is. Separate from how it is performed. */
    taskKind: enumText('task_kind', TASK_KINDS).notNull().default('coding'),
    /** Sprint 3.3: `direct` (created in Mac's UI) or `monday` (mirrored). */
    origin: enumText('origin', TASK_ORIGINS).notNull().default('direct'),
    /** The monday.com item this task mirrors, when it came from a board. */
    mondayItemId: text('monday_item_id'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdx: index('tasks_project_id_idx').on(t.projectId),
    statusIdx: index('tasks_status_idx').on(t.status),
    taskKindIdx: index('tasks_task_kind_idx').on(t.taskKind),
    originIdx: index('tasks_origin_idx').on(t.origin),
    mondayItemIdx: index('tasks_monday_item_id_idx').on(t.mondayItemId),
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
    /**
     * Sprint 3 moved the hash itself to `worker_tokens`: rotation needs several
     * tokens per worker to exist at once, and a single column cannot express
     * that. This is the display prefix of the ACTIVE token, kept denormalised so
     * the workers list needs no join.
     */
    tokenPrefix: text('token_prefix').notNull(),
    version: text('version'),
    platform: text('platform'),

    // --- Sprint 3: containment attestation ---
    /**
     * What containment this worker reports it can provide, re-attested on every
     * heartbeat. A sandbox that stopped working between registration and 02:00
     * must stop coding work, not persist as a stale claim on a dashboard.
     */
    sandboxKind: enumText('sandbox_kind', SANDBOX_KINDS),
    sandboxReady: boolean('sandbox_ready').notNull().default(false),
    sandboxDetail: text('sandbox_detail'),
    sandboxVersion: text('sandbox_version'),

    tokenIssuedAt: timestamp('token_issued_at', { withTimezone: true }),
    /** Set by an admin or the age sweeper; delivered via the control envelope. */
    rotationRequestedAt: timestamp('rotation_requested_at', { withTimezone: true }),
    lastRotatedAt: timestamp('last_rotated_at', { withTimezone: true }),

    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: uniqueIndex('workers_name_key').on(t.name),
  }),
);

/**
 * Worker credentials, one row per issued token (Sprint 3 §4).
 *
 * Sprint 1 stored a single hash on the worker and recorded rotation as debt;
 * Sprint 2 deferred it again. This table is the repayment. The load-bearing
 * detail is `status = 'superseded'` with an `expires_at`: a bounded overlap so
 * an in-flight request signed with the old token does not fail mid-rotation,
 * and a CHECK constraint that makes an unbounded overlap impossible to store.
 */
export const workerTokens = pgTable(
  'worker_tokens',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    workerId: uuid('worker_id')
      .notNull()
      .references(() => workers.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    status: enumText('status', WORKER_TOKEN_STATUSES).notNull().default('active'),
    issuedVia: enumText('issued_via', WORKER_TOKEN_ISSUE_ROUTES).notNull().default('enrollment'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    /** End of the overlap window. Null on an active token. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    revokedReason: text('revoked_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex('worker_tokens_token_hash_key').on(t.tokenHash),
    workerIdx: index('worker_tokens_worker_id_idx').on(t.workerId),
    statusIdx: index('worker_tokens_status_idx').on(t.status),
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

    // --- Sprint 3 ---
    /** Which autonomous shift produced this run, when one did. */
    nightShiftId: uuid('night_shift_id'),
    mondayItemId: text('monday_item_id'),
    /**
     * Who chose this work. Kept separate from `approvals.source` because they
     * answer different questions — who picked it, and who authorised it — and a
     * human can approve a run the scheduler proposed.
     */
    selectedBy: enumText('selected_by', RUN_SELECTION_SOURCES).notNull().default('human'),

    // --- Sprint 3.2 ---
    /**
     * The PAC company context that governed this run.
     *
     * Immutable once set — enforced by a BEFORE UPDATE trigger, not by
     * convention — so a newer Company commit appearing mid-run cannot change
     * what this run was working under (Sprint 3.2 §8.2, §9.3).
     */
    companyContextRevisionId: uuid('company_context_revision_id'),

    // --- Phase 4 ---
    /**
     * Whether the work delivered matched the criteria a human approved.
     *
     * Denormalised onto the run so every list, filter and report that already
     * reads this table can show the acceptance position without a join. The
     * detail lives in `run_acceptance`; this is the one word.
     *
     * `not_assessed` for every run that has no criteria, which is every coding
     * run that existed before Phase 4.
     */
    acceptanceState: enumText('acceptance_state', ACCEPTANCE_STATES).notNull().default('not_assessed'),
  },
  (t) => ({
    taskIdx: index('runs_task_id_idx').on(t.taskId),
    companyContextIdx: index('runs_company_context_idx').on(t.companyContextRevisionId),
    nightShiftIdx: index('runs_night_shift_id_idx').on(t.nightShiftId),
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
    /**
     * Sprint 3: WHICH authority approved this.
     *
     * `night_shift_policy` means a human pre-approved the project, the board and
     * the item, and the eligibility predicate then found it startable. That is a
     * real authority with a real trail — and a DIFFERENT one from a person
     * clicking approve, which is why it is not a null approver in the same
     * field. A machine approval must never be readable as a human one.
     */
    source: enumText('source', APPROVAL_SOURCES).notNull().default('human'),
    /** The project approval, board approval, item flag and eligibility verdict. */
    policyBasis: jsonb('policy_basis'),
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
    /**
     * Sprint 3: `npm test` executes code the agent just wrote, so it runs inside
     * the sandbox too. `none` by default, because a test suite that needs the
     * internet is a test suite worth knowing about.
     */
    testNetwork: enumText('test_network', SANDBOX_NETWORK_MODES).notNull().default('none'),
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
    /**
     * Phase 4: the machine-checkable acceptance criteria.
     *
     * Alongside `content.acceptanceCriteria`, which is free text and stays
     * exactly as it is. The free-text list is what a human reads and is where
     * requirements that cannot be mechanised belong; reducing it to a checklist
     * would lose them.
     *
     * This list is what completion is judged against, and it is FROZEN onto the
     * run at approval — so a brief edited afterwards cannot move the bar the
     * work is being measured by.
     */
    acceptance: jsonb('acceptance').notNull().default(sql`'[]'::jsonb`),
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull().default('0'),
    /** Provenance only. Never the specification handed to a coding agent. */
    sourceConversation: text('source_conversation').notNull().default(''),
    contextSummary: text('context_summary'),
    /** Sprint 3.2: which company context this brief was written under. */
    companyContextRevisionId: uuid('company_context_revision_id'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    taskIdx: index('handoff_briefs_task_id_idx').on(t.taskId),
    companyContextIdx: index('handoff_briefs_company_context_idx').on(t.companyContextRevisionId),
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
    /** Sprint 3.2: the company context bound when this session started. */
    companyContextRevisionId: uuid('company_context_revision_id'),
    /**
     * Phase 4: the conversation this discovery is being conducted through.
     *
     * A LINK, not a merge. Discovery keeps its own message array and its own
     * `pendingQuestion`, because rewriting the working half of Sprints 2 and
     * 3.3 to sit on top of conversations would risk a great deal for a
     * structural tidiness nobody asked for. What this column buys is that a
     * Teams answer can reach the same brief a web-UI answer would.
     */
    conversationId: uuid('conversation_id'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    taskIdx: index('discovery_sessions_task_id_idx').on(t.taskId),
    projectIdx: index('discovery_sessions_project_id_idx').on(t.projectId),
    companyContextIdx: index('discovery_sessions_company_context_idx').on(t.companyContextRevisionId),
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

    // --- Sprint 3: evidence-based answers (brief §14) ---
    /** The material Mac read, with an excerpt of each. `sources` holds the labels. */
    evidence: jsonb('evidence').notNull().default(sql`'[]'::jsonb`),
    /**
     * Established fact or assumption — DERIVED from the evidence by
     * `deriveGroundedness`, never asserted by the answering code. That is what
     * makes "no ungrounded high-confidence claims" a property rather than a hope.
     */
    groundedness: enumText('groundedness', GROUNDEDNESS).notNull().default('assumption'),
    modelAssisted: boolean('model_assisted').notNull().default(false),
    /** Which investigation source classes were consulted. */
    sourcesChecked: jsonb('sources_checked').notNull().default(sql`'[]'::jsonb`),

    // --- Sprint 3.2 ---
    /**
     * The company context this answer was decided under.
     *
     * Copied from the RUN, not from whatever is currently active. A commit that
     * lands at 02:14 must not retroactively appear to have governed a decision
     * made at 02:00 (Sprint 3.2 §9.3).
     */
    companyContextRevisionId: uuid('company_context_revision_id'),

    askedAt: timestamp('asked_at', { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
  },
  (t) => ({
    runIdx: index('agent_questions_run_id_idx').on(t.runId),
    externalIdx: uniqueIndex('agent_questions_run_external_key').on(t.runId, t.externalId),
    companyContextIdx: index('agent_questions_company_context_idx').on(t.companyContextRevisionId),
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

// ===========================================================================
// Sprint 3 — monday.com, night shift, investigations, email
// ===========================================================================

/**
 * A monday.com board Mac may read from and write to.
 *
 * `dueDateColumnId` and `priorityColumnId` are recorded even though Mac has no
 * method that writes to them. That is the point: storing them is what lets the
 * write guard RECOGNISE an attempt to change a commercial field and refuse it
 * by name, rather than merely failing to find it on an allowlist.
 */
export const mondayBoards = pgTable(
  'monday_boards',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    boardId: text('board_id').notNull(),
    name: text('name').notNull(),
    /** Optional workstream filter. Empty means the whole board. */
    groupIds: jsonb('group_ids').notNull().default(sql`'[]'::jsonb`),

    statusColumnId: text('status_column_id').notNull(),
    assigneeColumnId: text('assignee_column_id'),
    priorityColumnId: text('priority_column_id'),
    dueDateColumnId: text('due_date_column_id'),
    pullRequestColumnId: text('pull_request_column_id'),
    dependencyColumnId: text('dependency_column_id'),
    nightShiftFlagColumnId: text('night_shift_flag_column_id'),
    itemTypeColumnId: text('item_type_column_id'),
    sizeColumnId: text('size_column_id'),

    /** Mac's vocabulary → this board's labels, so no call site guesses. */
    statusLabels: jsonb('status_labels').notNull(),
    startableStatuses: jsonb('startable_statuses').notNull().default(sql`'[]'::jsonb`),
    completedStatuses: jsonb('completed_statuses').notNull().default(sql`'[]'::jsonb`),
    allowedItemTypes: jsonb('allowed_item_types').notNull().default(sql`'[]'::jsonb`),

    /** Off by default: Ready for Review is Mac's terminal state until opted in. */
    mayComplete: boolean('may_complete').notNull().default(false),
    nightShiftEligible: boolean('night_shift_eligible').notNull().default(false),
    /** On by default: an item must be explicitly marked before Mac may take it. */
    requireItemFlag: boolean('require_item_flag').notNull().default(true),
    macUserId: text('mac_user_id'),

    isApproved: boolean('is_approved').notNull().default(false),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    boardIdx: uniqueIndex('monday_boards_board_id_key').on(t.boardId),
    projectIdx: index('monday_boards_project_id_idx').on(t.projectId),
  }),
);

/**
 * A cache of what monday.com currently says.
 *
 * Never a source of truth for Mac's own lifecycle: a status change on a board
 * does not start, approve or stop a run. When the board is unreachable this is
 * what the scheduler reads, and the decision record says the data is stale.
 */
export const mondayItems = pgTable(
  'monday_items',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    boardRowId: uuid('board_row_id')
      .notNull()
      .references(() => mondayBoards.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    itemId: text('item_id').notNull(),
    groupId: text('group_id'),
    name: text('name').notNull(),
    url: text('url'),
    status: text('status'),
    priority: text('priority'),
    assigneeIds: jsonb('assignee_ids').notNull().default(sql`'[]'::jsonb`),
    dueDate: text('due_date'),
    description: text('description'),
    dependsOn: jsonb('depends_on').notNull().default(sql`'[]'::jsonb`),
    nightShiftFlag: boolean('night_shift_flag').notNull().default(false),
    itemType: text('item_type'),
    sizeLabel: text('size_label'),
    raw: jsonb('raw').notNull().default(sql`'{}'::jsonb`),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    itemIdx: uniqueIndex('monday_items_item_id_key').on(t.itemId),
    boardIdx: index('monday_items_board_row_id_idx').on(t.boardRowId),
    taskIdx: index('monday_items_task_id_idx').on(t.taskId),
  }),
);

/**
 * The monday.com write outbox.
 *
 * Written in the same transaction as the state change that justified it, for
 * the same reason audit events are: a run must not fail because a third party
 * is down, and monday.com must not be updated by a transaction that then rolls
 * back. Exactly-once intent, at-least-once delivery — the correct trade for a
 * status board, where a duplicated "In Progress" is harmless and a missed
 * "Ready for Review" is not.
 */
export const mondayWrites = pgTable(
  'monday_writes',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    boardRowId: uuid('board_row_id')
      .notNull()
      .references(() => mondayBoards.id, { onDelete: 'cascade' }),
    mondayItemId: text('monday_item_id').notNull(),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    kind: enumText('kind', MONDAY_WRITE_KINDS).notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    status: enumText('status', MONDAY_WRITE_STATUSES).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    providerMessageId: text('provider_message_id'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => ({
    statusIdx: index('monday_writes_status_idx').on(t.status, t.nextAttemptAt),
    runIdx: index('monday_writes_run_id_idx').on(t.runId),
  }),
);

/**
 * One autonomous shift.
 *
 * `settingsSnapshot` matters more than it looks: reading a morning report next
 * to the thresholds as they are NOW is misleading if somebody changed them at
 * 06:00. The shift records the policy it actually ran under.
 */
export const nightShifts = pgTable(
  'night_shifts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    status: enumText('status', NIGHT_SHIFT_STATUSES).notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    cutoffAt: timestamp('cutoff_at', { withTimezone: true }).notNull(),
    stopReason: enumText('stop_reason', NIGHT_STOP_REASONS),
    startedBy: uuid('started_by').references(() => users.id, { onDelete: 'set null' }),
    settingsSnapshot: jsonb('settings_snapshot').notNull().default(sql`'{}'::jsonb`),
    tasksAttempted: integer('tasks_attempted').notNull().default(0),
    tasksCompleted: integer('tasks_completed').notNull().default(0),
    tasksBlocked: integer('tasks_blocked').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusIdx: index('night_shifts_status_idx').on(t.status),
  }),
);

/**
 * Every scheduling decision, including the refusals.
 *
 * A scheduler whose refusals are invisible is one nobody can debug at 08:00,
 * so `skip`, `idle` and `stop` are recorded exactly as `start` is, each with the
 * rationale that produced it.
 */
export const nightDecisions = pgTable(
  'night_decisions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    nightShiftId: uuid('night_shift_id')
      .notNull()
      .references(() => nightShifts.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    sequence: integer('sequence').notNull(),
    decision: enumText('decision', NIGHT_DECISION_KINDS).notNull(),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    mondayItemId: text('monday_item_id'),
    rationale: jsonb('rationale').notNull().default(sql`'{}'::jsonb`),
    eligibility: jsonb('eligibility'),
    effort: jsonb('effort'),
  },
  (t) => ({
    sequenceIdx: uniqueIndex('night_decisions_shift_sequence_key').on(t.nightShiftId, t.sequence),
    runIdx: index('night_decisions_run_id_idx').on(t.runId),
  }),
);

/**
 * What Mac checked before asking a human.
 *
 * `checked` is the escalation receipt: every source class, whether it was
 * consulted, whether it matched, and what came back. It turns "he asked me
 * something he could have looked up" from an impression into a falsifiable
 * claim.
 */
export const discoveryInvestigations = pgTable(
  'discovery_investigations',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    discoverySessionId: uuid('discovery_session_id').references(() => discoverySessions.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    subjectKind: enumText('subject_kind', INVESTIGATION_SUBJECT_KINDS).notNull(),
    subject: text('subject').notNull(),
    resolved: boolean('resolved').notNull().default(false),
    answer: text('answer'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull().default('0'),
    checked: jsonb('checked').notNull().default(sql`'[]'::jsonb`),
    evidence: jsonb('evidence').notNull().default(sql`'[]'::jsonb`),
    escalatedToHuman: boolean('escalated_to_human').notNull().default(false),
    modelAssisted: boolean('model_assisted').notNull().default(false),
    /** Sprint 3.3: the brief whose gap this receipt belongs to, when discovery ran it. */
    briefId: uuid('brief_id').references(() => handoffBriefs.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    taskIdx: index('discovery_investigations_task_id_idx').on(t.taskId),
    runIdx: index('discovery_investigations_run_id_idx').on(t.runId),
    briefIdx: index('discovery_investigations_brief_idx').on(t.briefId),
  }),
);

/**
 * The email outbox.
 *
 * `idempotencyKey` is UNIQUE, so a duplicate send is prevented by the database
 * rather than by a caller remembering to check. A second attempt to create the
 * same delivery finds this row; a row already `sent` is never sent again.
 */
export const emailDeliveries = pgTable(
  'email_deliveries',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    kind: enumText('kind', EMAIL_DELIVERY_KINDS).notNull(),
    nightShiftId: uuid('night_shift_id').references(() => nightShifts.id, { onDelete: 'set null' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    idempotencyKey: text('idempotency_key').notNull(),
    /** Resolved from settings at creation. Never supplied by a caller. */
    recipients: jsonb('recipients').notNull().default(sql`'[]'::jsonb`),
    subject: text('subject').notNull(),
    bodyText: text('body_text').notNull(),
    bodyHtml: text('body_html'),
    content: jsonb('content').notNull().default(sql`'{}'::jsonb`),
    status: enumText('status', EMAIL_DELIVERY_STATUSES).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    provider: text('provider').notNull().default('none'),
    providerMessageId: text('provider_message_id'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => ({
    idempotencyIdx: uniqueIndex('email_deliveries_idempotency_key').on(t.idempotencyKey),
    statusIdx: index('email_deliveries_status_idx').on(t.status, t.nextAttemptAt),
  }),
);

// ---------------------------------------------------------------------------
// Sprint 3.2 - PAC shared company context
// ---------------------------------------------------------------------------

/**
 * Every revision of the PAC company context Mac has loaded, or tried to.
 *
 * Failed loads are rows too. "Mac refused to start work at 02:14 and this is the
 * manifest error that stopped him" is exactly what an operator needs at 08:00,
 * and it cannot be reconstructed from a log line that has scrolled away.
 *
 * Note what is NOT here: document text. The authoritative copy of PAC policy is
 * the Git repository the humans govern; a second copy in Postgres would be an
 * un-governed one. What is stored is identity - SHA, version, hashes, and per
 * document metadata - which is enough to prove which text a run was bound to.
 */
export const companyContextRevisions = pgTable(
  'company_context_revisions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    /** Credentials already stripped. Never the URL git was actually handed. */
    repositoryUrl: text('repository_url').notNull(),
    ref: text('ref').notNull(),
    commitSha: text('commit_sha').notNull(),
    commitAuthoredAt: timestamp('commit_authored_at', { withTimezone: true }),
    contextVersion: text('context_version').notNull().default(''),
    schemaVersion: integer('schema_version').notNull().default(0),
    /** The whole parsed manifest, unknown future fields included. */
    manifest: jsonb('manifest').notNull().default(sql`'{}'::jsonb`),
    manifestSha256: text('manifest_sha256').notNull().default(''),
    documentSetSha256: text('document_set_sha256').notNull().default(''),
    /** `[{path, bytes, sha256, headings}]`. Metadata only. */
    documents: jsonb('documents').notNull().default(sql`'[]'::jsonb`),
    validationState: enumText('validation_state', COMPANY_CONTEXT_VALIDATION_STATES).notNull(),
    validationErrors: jsonb('validation_errors').notNull().default(sql`'[]'::jsonb`),
    providerKind: enumText('provider_kind', COMPANY_CONTEXT_PROVIDER_KINDS).notNull().default('git'),
    source: enumText('source', COMPANY_CONTEXT_SOURCES).notNull().default('remote'),
    loadedAt: timestamp('loaded_at', { withTimezone: true }).notNull().defaultNow(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    repoCommitIdx: uniqueIndex('company_context_revisions_repo_commit_key').on(t.repositoryUrl, t.commitSha),
    commitIdx: index('company_context_revisions_commit_idx').on(t.commitSha),
    stateIdx: index('company_context_revisions_state_idx').on(t.validationState, t.loadedAt),
  }),
);

/**
 * Singleton (id = 1), enforced by a CHECK, like `settings`.
 *
 * Persisted rather than in-memory because "when did Mac last reach the Company
 * repository?" is asked most often right after a restart - precisely when an
 * in-memory answer would have just been lost.
 */
export const companyContextStatus = pgTable('company_context_status', {
  id: smallint('id').primaryKey().default(1),
  activeRevisionId: uuid('active_revision_id').references(() => companyContextRevisions.id, {
    onDelete: 'restrict',
  }),
  status: enumText('status', COMPANY_CONTEXT_STATUSES).notNull().default('disabled'),
  lastCheckAt: timestamp('last_check_at', { withTimezone: true }),
  lastSuccessfulRefreshAt: timestamp('last_successful_refresh_at', { withTimezone: true }),
  /** Already passed through `redactGitError` before it arrives here. */
  lastError: text('last_error'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A proposed change to PAC company context - the only artefact Mac may produce
 * about changing it (Sprint 3.2 section 16).
 *
 * There is no path from a row here to a commit in the Company repository.
 * `accepted` records that a person agreed; making the change is that person's
 * act, outside this system. A CHECK requires a reviewer on any decided row, so
 * an accepted proposal can never look like one Mac accepted himself.
 */
/**
 * Sprint 3.3: results that are not commits.
 *
 * Every column here exists because a reader needs it to judge the document:
 * what kind of thing it is, what it says, what is behind each claim, which PAC
 * policy governed it, and what it cost. An artefact without provenance is a
 * confident essay, and a confident essay from an autonomous agent is exactly
 * what nobody should act on.
 */
export const runArtefacts = pgTable(
  'run_artefacts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    /** Nullable: a future day-mode artefact may exist without a run. */
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    artefactType: enumText('artefact_type', ARTEFACT_TYPES).notNull(),
    title: text('title').notNull(),
    format: enumText('format', ARTEFACT_FORMATS).notNull().default('markdown'),
    summary: text('summary').notNull().default(''),
    body: text('body').notNull(),
    /** [{statement, evidenceClass, confidence, sources[], reasoning}] */
    findings: jsonb('findings').notNull().default(sql`'[]'::jsonb`),
    /** Immutable once set — enforced by trigger, as for runs and briefs. */
    companyContextRevisionId: uuid('company_context_revision_id'),
    modelProvider: text('model_provider'),
    modelName: text('model_name'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index('run_artefacts_run_idx').on(t.runId),
    taskIdx: index('run_artefacts_task_idx').on(t.taskId),
    projectIdx: index('run_artefacts_project_idx').on(t.projectId),
    createdIdx: index('run_artefacts_created_idx').on(t.createdAt),
  }),
);

/**
 * Sprint 3.3: what one general run accumulates between its steps.
 *
 * A 1:1 extension of `runs` rather than six always-null columns on it, so the
 * dispatch query — the hottest path in the system — does not widen for a run
 * kind it never selects on.
 *
 * This is NOT a second run table. The run is still a `runs` row with a status, a
 * worker, a lease, an approval and an audit trail; this holds the plan it is
 * executing and the evidence it has gathered so far.
 */
export const generalRunState = pgTable('general_run_state', {
  runId: uuid('run_id')
    .primaryKey()
    .references(() => runs.id, { onDelete: 'cascade' }),
  taskKind: text('task_kind').notNull(),
  /** Built server-side from the brief. The model is given it, never writes it. */
  plan: jsonb('plan').notNull().default(sql`'{}'::jsonb`),
  state: jsonb('state').notNull().default(sql`'{}'::jsonb`),
  stage: enumText('stage', RESEARCH_STAGES).notNull().default('planning'),
  stepsTaken: integer('steps_taken').notNull().default(0),
  toolCallsMade: integer('tool_calls_made').notNull().default(0),
  modelProvider: text('model_provider'),
  modelName: text('model_name'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const companyContextProposals = pgTable(
  'company_context_proposals',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    targetDocument: text('target_document').notNull(),
    targetSection: text('target_section'),
    proposedChange: text('proposed_change').notNull(),
    reason: text('reason').notNull(),
    evidence: jsonb('evidence').notNull().default(sql`'[]'::jsonb`),
    potentialImpact: text('potential_impact'),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    discoverySessionId: uuid('discovery_session_id').references(() => discoverySessions.id, {
      onDelete: 'set null',
    }),
    agent: text('agent').notNull().default('mac'),
    /** What the document said when Mac suggested changing it. */
    baseRevisionId: uuid('base_revision_id').references(() => companyContextRevisions.id, {
      onDelete: 'restrict',
    }),
    status: enumText('status', COMPANY_PROPOSAL_STATUSES).notNull().default('proposed'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNotes: text('review_notes'),
  },
  (t) => ({
    statusIdx: index('company_context_proposals_status_idx').on(t.status, t.createdAt),
    baseRevisionIdx: index('company_context_proposals_base_revision_idx').on(t.baseRevisionId),
    taskIdx: index('company_context_proposals_task_idx').on(t.taskId),
  }),
);


// ---------------------------------------------------------------------------
// Phase 4 — conversations
// ---------------------------------------------------------------------------

/**
 * A persistent thread that belongs to MAC, not to a channel.
 *
 * Teams, the web UI, Forja and (later) voice attach to the same conversation.
 * `channel` records where it STARTED; individual messages carry their own, so a
 * thread begun in Teams and continued in the web UI stays one thread rather
 * than being forced to pick.
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    channel: enumText('channel', CONVERSATION_CHANNELS).notNull().default('web'),
    status: enumText('status', CONVERSATION_STATUSES).notNull().default('open'),
    title: text('title').notNull().default(''),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    /** The channel's own thread id. Unique per channel; the webhook's anchor. */
    externalRef: text('external_ref'),
    /**
     * Where a Bot Connector reply must be POSTed.
     *
     * Captured from a JWT-verified activity and never from a request body. A
     * `serviceUrl` an attacker supplies is an instruction to send Mac's bearer
     * token to a host of their choosing, so this column is written from exactly
     * one place and validated against an allowlist before use.
     */
    serviceUrl: text('service_url'),
    tenantId: text('tenant_id'),
    /** Immutable once set, like runs and briefs. Trigger-enforced. */
    companyContextRevisionId: uuid('company_context_revision_id'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    messageCount: integer('message_count').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    taskIdx: index('conversations_task_idx').on(t.taskId),
    projectIdx: index('conversations_project_idx').on(t.projectId),
  }),
);

export const conversationParticipants = pgTable(
  'conversation_participants',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    kind: enumText('kind', PARTICIPANT_KINDS).notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** The channel's identifier — an AAD object id, a Forja principal. */
    externalId: text('external_id'),
    displayName: text('display_name').notNull().default(''),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    conversationIdx: index('conversation_participants_conversation_idx').on(t.conversationId),
  }),
);

/**
 * Every message, inbound and outbound.
 *
 * Delivery state lives here rather than in a separate outbox: the mail outbox
 * proved the retry and idempotency pattern in Sprint 3.1, and a second table
 * holding a copy of the same text would only create a way for the two to
 * disagree about what was actually sent.
 */
export const conversationMessages = pgTable(
  'conversation_messages',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** Monotonic within the conversation. Summaries cite ranges of it. */
    seq: integer('seq').notNull(),
    direction: enumText('direction', MESSAGE_DIRECTIONS).notNull(),
    channel: enumText('channel', CONVERSATION_CHANNELS).notNull(),
    authorKind: enumText('author_kind', PARTICIPANT_KINDS).notNull(),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    authorName: text('author_name').notNull().default(''),
    body: text('body').notNull(),
    /** Null on outbound: Mac does not classify his own intent. */
    intent: enumText('intent', MESSAGE_INTENTS),
    intentConfidence: numeric('intent_confidence', { precision: 4, scale: 3 }),
    outboundKind: enumText('outbound_kind', OUTBOUND_KINDS),
    deliveryState: enumText('delivery_state', DELIVERY_STATES).notNull().default('not_required'),
    deliveryAttempts: integer('delivery_attempts').notNull().default(0),
    deliveryError: text('delivery_error'),
    providerMessageId: text('provider_message_id'),
    /** The channel's own message id. The idempotency key; unique per channel. */
    externalMessageId: text('external_message_id'),
    inReplyToMessageId: uuid('in_reply_to_message_id'),
    approvalRequestId: uuid('approval_request_id'),
    evidence: jsonb('evidence').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    conversationIdx: index('conversation_messages_conversation_idx').on(t.conversationId, t.seq),
    seqKey: uniqueIndex('conversation_messages_seq_key').on(t.conversationId, t.seq),
  }),
);

/**
 * A generated summary of part of a conversation.
 *
 * Appended ALONGSIDE the source messages, never over them. A summary that
 * overwrote its own evidence would be the one artefact in this system nobody
 * could check.
 */
export const conversationSummaries = pgTable(
  'conversation_summaries',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    coversFromSeq: integer('covers_from_seq').notNull(),
    coversToSeq: integer('covers_to_seq').notNull(),
    content: jsonb('content').notNull().default(sql`'{}'::jsonb`),
    modelProvider: text('model_provider'),
    modelName: text('model_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    conversationIdx: index('conversation_summaries_conversation_idx').on(t.conversationId, t.coversToSeq),
  }),
);

// ---------------------------------------------------------------------------
// Phase 4 — approval requests
// ---------------------------------------------------------------------------

/**
 * The request that precedes an approval.
 *
 * `approvals` remains the record of the authorisation itself, with its
 * confidence and its threshold. This is the addressable object that makes
 * "sounds good must not approve the wrong action" enforceable: a pending
 * approval with no identity has nothing for a reply to bind to, so any
 * affirmation nearby is as good as any other.
 */
export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    /** The human-quotable code, e.g. `AP-4F2K`. Unique among pending rows. */
    code: text('code').notNull(),
    state: enumText('state', APPROVAL_REQUEST_STATES).notNull().default('pending'),
    subjectKind: enumText('subject_kind', APPROVAL_SUBJECT_KINDS).notNull(),
    /** A brief at v3 and at v4 are different contracts. */
    subjectVersion: integer('subject_version').notNull().default(0),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'cascade' }),
    briefId: uuid('brief_id').references(() => handoffBriefs.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    detail: text('detail').notNull().default(''),
    recommendation: text('recommendation').notNull().default(''),
    risk: enumText('risk', RISK_LEVELS).notNull().default('medium'),
    authority: enumText('authority', AUTHORITY_CLASSES).notNull().default('execute_run'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    deliveredChannels: jsonb('delivered_channels').notNull().default(sql`'[]'::jsonb`),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    decidedViaChannel: text('decided_via_channel'),
    decidedViaMessageId: uuid('decided_via_message_id'),
    decisionNotes: text('decision_notes'),
    supersededByRequestId: uuid('superseded_by_request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    taskIdx: index('approval_requests_task_idx').on(t.taskId),
    runIdx: index('approval_requests_run_idx').on(t.runId),
    pendingIdx: index('approval_requests_pending_idx').on(t.state, t.requestedAt),
  }),
);

// ---------------------------------------------------------------------------
// Phase 4 — Forja
// ---------------------------------------------------------------------------

/**
 * An API client, not an agent.
 *
 * Forja is never registered in `agent-registry.ts`, and every write it performs
 * carries the human it is acting for — because "Forja approved it" is not an
 * answer to "who approved this?".
 */
export const forjaClients = pgTable('forja_clients', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  /** SHA-256 only, so a database dump yields no usable credential. */
  keyHash: text('key_hash').notNull(),
  keyPrefix: text('key_prefix').notNull(),
  scopes: jsonb('scopes').notNull().default(sql`'[]'::jsonb`),
  isActive: boolean('is_active').notNull().default(true),
  webhookUrl: text('webhook_url'),
  /**
   * Separate from the API key on purpose: one authenticates Forja to Mac and
   * the other authenticates Mac to Forja, and a single secret doing both jobs
   * cannot be rotated independently.
   */
  webhookSecret: text('webhook_secret'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

/**
 * The event log. Append-only, trigger-enforced, cursor-read.
 *
 * `seq` is the only cursor. Timestamps are not one: two events written in the
 * same millisecond have no order between them, and a consumer paging by time
 * will eventually skip one.
 */
export const macEvents = pgTable(
  'mac_events',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    type: enumText('type', MAC_EVENT_TYPES).notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    projectId: uuid('project_id'),
    taskId: uuid('task_id'),
    runId: uuid('run_id'),
    conversationId: uuid('conversation_id'),
    approvalRequestId: uuid('approval_request_id'),
    artefactId: uuid('artefact_id'),
    data: jsonb('data').notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    typeIdx: index('mac_events_type_idx').on(t.type, t.seq),
  }),
);

export const eventDeliveries = pgTable(
  'event_deliveries',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    clientId: uuid('client_id')
      .notNull()
      .references(() => forjaClients.id, { onDelete: 'cascade' }),
    eventSeq: bigint('event_seq', { mode: 'number' }).notNull(),
    status: enumText('status', EVENT_DELIVERY_STATUSES).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueDelivery: uniqueIndex('event_deliveries_unique').on(t.clientId, t.eventSeq),
  }),
);

// ---------------------------------------------------------------------------
// Phase 4 — research provenance and acceptance
// ---------------------------------------------------------------------------

/**
 * One retrieved source, with enough provenance to trace a claim back to it.
 *
 * A table rather than a JSON blob because "did this run use any external
 * source?" has to be answerable by a predicate — that is the check Part F §23
 * describes, and it cannot be run against a JSON document.
 */
export const researchSources = pgTable(
  'research_sources',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** The query that found it, so a search is inspectable after the fact. */
    query: text('query').notNull().default(''),
    tool: text('tool').notNull(),
    ref: text('ref').notNull(),
    url: text('url'),
    title: text('title').notNull().default(''),
    sourceClass: enumText('source_class', SOURCE_CLASSES).notNull().default('unknown'),
    external: boolean('external').notNull().default(false),
    excerpt: text('excerpt').notNull().default(''),
    publishedAt: text('published_at'),
    retrievedAt: timestamp('retrieved_at', { withTimezone: true }).notNull().defaultNow(),
    /** Recorded, not acted on: a page discussing injection is not an attack. */
    injectionSuspected: boolean('injection_suspected').notNull().default(false),
    injectionDetail: text('injection_detail'),
  },
  (t) => ({
    runIdx: index('research_sources_run_idx').on(t.runId),
    taskIdx: index('research_sources_task_idx').on(t.taskId),
    externalIdx: index('research_sources_external_idx').on(t.runId, t.external),
  }),
);

/**
 * Whether the work delivered matched the criteria a human approved.
 *
 * `criteria` is a copy FROZEN at approval rather than a pointer to the brief:
 * what is checked has to be what somebody authorised, and a brief edited
 * afterwards must not silently move the bar.
 */
export const runAcceptance = pgTable('run_acceptance', {
  runId: uuid('run_id')
    .primaryKey()
    .references(() => runs.id, { onDelete: 'cascade' }),
  state: enumText('state', ACCEPTANCE_STATES).notNull().default('not_assessed'),
  criteria: jsonb('criteria').notNull().default(sql`'[]'::jsonb`),
  results: jsonb('results').notNull().default(sql`'[]'::jsonb`),
  artefactsProduced: integer('artefacts_produced').notNull().default(0),
  externalSourcesUsed: integer('external_sources_used').notNull().default(0),
  remediationAttempted: boolean('remediation_attempted').notNull().default(false),
  remediationNote: text('remediation_note'),
  modelAssisted: boolean('model_assisted').notNull().default(false),
  modelProvider: text('model_provider'),
  modelName: text('model_name'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull().defaultNow(),
});

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

export type WorkerTokenRow = typeof workerTokens.$inferSelect;
export type MondayBoardRow = typeof mondayBoards.$inferSelect;
export type MondayItemRow = typeof mondayItems.$inferSelect;
export type MondayWriteRow = typeof mondayWrites.$inferSelect;
export type NightShiftRow = typeof nightShifts.$inferSelect;
export type NightDecisionRow = typeof nightDecisions.$inferSelect;
export type DiscoveryInvestigationRow = typeof discoveryInvestigations.$inferSelect;
export type EmailDeliveryRow = typeof emailDeliveries.$inferSelect;

export type CompanyContextRevisionRow = typeof companyContextRevisions.$inferSelect;
export type CompanyContextStatusRow = typeof companyContextStatus.$inferSelect;
export type CompanyContextProposalRow = typeof companyContextProposals.$inferSelect;
// --- Sprint 3.3 ---
export type RunArtefactRow = typeof runArtefacts.$inferSelect;
export type GeneralRunStateRow = typeof generalRunState.$inferSelect;
// --- Phase 4 ---
export type ConversationRow = typeof conversations.$inferSelect;
export type ConversationParticipantRow = typeof conversationParticipants.$inferSelect;
export type ConversationMessageRow = typeof conversationMessages.$inferSelect;
export type ConversationSummaryRow = typeof conversationSummaries.$inferSelect;
export type ApprovalRequestRow = typeof approvalRequests.$inferSelect;
export type ForjaClientRow = typeof forjaClients.$inferSelect;
export type MacEventRow = typeof macEvents.$inferSelect;
export type EventDeliveryRow = typeof eventDeliveries.$inferSelect;
export type ResearchSourceRow = typeof researchSources.$inferSelect;
export type RunAcceptanceRow = typeof runAcceptance.$inferSelect;

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
  // --- Sprint 3 ---
  { table: 'worker_tokens', column: 'status', values: WORKER_TOKEN_STATUSES },
  { table: 'worker_tokens', column: 'issued_via', values: WORKER_TOKEN_ISSUE_ROUTES },
  { table: 'workers', column: 'sandbox_kind', values: SANDBOX_KINDS },
  { table: 'monday_writes', column: 'kind', values: MONDAY_WRITE_KINDS },
  { table: 'monday_writes', column: 'status', values: MONDAY_WRITE_STATUSES },
  { table: 'night_shifts', column: 'status', values: NIGHT_SHIFT_STATUSES },
  { table: 'night_shifts', column: 'stop_reason', values: NIGHT_STOP_REASONS },
  { table: 'night_decisions', column: 'decision', values: NIGHT_DECISION_KINDS },
  { table: 'runs', column: 'selected_by', values: RUN_SELECTION_SOURCES },
  { table: 'approvals', column: 'source', values: APPROVAL_SOURCES },
  { table: 'agent_questions', column: 'groundedness', values: GROUNDEDNESS },
  { table: 'discovery_investigations', column: 'subject_kind', values: INVESTIGATION_SUBJECT_KINDS },
  { table: 'email_deliveries', column: 'kind', values: EMAIL_DELIVERY_KINDS },
  { table: 'email_deliveries', column: 'status', values: EMAIL_DELIVERY_STATUSES },
  { table: 'repositories', column: 'test_network', values: SANDBOX_NETWORK_MODES },
  { table: 'settings', column: 'mail_provider', values: MAIL_PROVIDERS },
  { table: 'settings', column: 'model_provider', values: MODEL_PROVIDERS },
  // --- Sprint 3.2 ---
  { table: 'company_context_revisions', column: 'validation_state', values: COMPANY_CONTEXT_VALIDATION_STATES },
  { table: 'company_context_revisions', column: 'source', values: COMPANY_CONTEXT_SOURCES },
  { table: 'company_context_revisions', column: 'provider_kind', values: COMPANY_CONTEXT_PROVIDER_KINDS },
  { table: 'company_context_status', column: 'status', values: COMPANY_CONTEXT_STATUSES },
  { table: 'company_context_proposals', column: 'status', values: COMPANY_PROPOSAL_STATUSES },
  // --- Sprint 3.3 ---
  { table: 'tasks', column: 'task_kind', values: TASK_KINDS },
  { table: 'tasks', column: 'origin', values: TASK_ORIGINS },
  { table: 'run_artefacts', column: 'artefact_type', values: ARTEFACT_TYPES },
  { table: 'run_artefacts', column: 'format', values: ARTEFACT_FORMATS },
  { table: 'general_run_state', column: 'stage', values: RESEARCH_STAGES },
  // --- Phase 4 ---
  { table: 'conversations', column: 'channel', values: CONVERSATION_CHANNELS },
  { table: 'conversations', column: 'status', values: CONVERSATION_STATUSES },
  { table: 'conversation_participants', column: 'kind', values: PARTICIPANT_KINDS },
  { table: 'conversation_messages', column: 'direction', values: MESSAGE_DIRECTIONS },
  { table: 'conversation_messages', column: 'channel', values: CONVERSATION_CHANNELS },
  { table: 'conversation_messages', column: 'author_kind', values: PARTICIPANT_KINDS },
  { table: 'conversation_messages', column: 'intent', values: MESSAGE_INTENTS },
  { table: 'conversation_messages', column: 'outbound_kind', values: OUTBOUND_KINDS },
  { table: 'conversation_messages', column: 'delivery_state', values: DELIVERY_STATES },
  { table: 'approval_requests', column: 'state', values: APPROVAL_REQUEST_STATES },
  { table: 'approval_requests', column: 'subject_kind', values: APPROVAL_SUBJECT_KINDS },
  { table: 'approval_requests', column: 'risk', values: RISK_LEVELS },
  { table: 'approval_requests', column: 'authority', values: AUTHORITY_CLASSES },
  { table: 'mac_events', column: 'type', values: MAC_EVENT_TYPES },
  { table: 'event_deliveries', column: 'status', values: EVENT_DELIVERY_STATUSES },
  { table: 'research_sources', column: 'source_class', values: SOURCE_CLASSES },
  { table: 'run_acceptance', column: 'state', values: ACCEPTANCE_STATES },
  { table: 'runs', column: 'acceptance_state', values: ACCEPTANCE_STATES },
  { table: 'settings', column: 'web_search_provider', values: WEB_SEARCH_PROVIDERS },
];
