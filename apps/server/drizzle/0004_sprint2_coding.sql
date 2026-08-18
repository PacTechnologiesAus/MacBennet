-- Mac Bennett — Sprint 2: the autonomous coding worker.
--
-- Everything here is ADDITIVE. No Sprint 1 table is dropped, no column is
-- removed, and `audit_events` is not touched at all beyond its CHECK constraint
-- gaining the new event types — its immutability triggers stay exactly as they
-- were installed by 0001/0002/0003.
--
-- Enum CHECK constraints continue to duplicate the authoritative lists in
-- @mac/protocol; tests/integration/schema-parity.test.ts fails if they diverge.

-- ---------------------------------------------------------------------------
-- Repositories
-- ---------------------------------------------------------------------------
--
-- `is_approved` is the gate for every repository operation. It is a column
-- rather than a policy in code because the dispatch statement JOINs against it:
-- a run against an unapproved repository is unselectable, not merely rejected.
--
-- `test_command` / `build_command` are argv ARRAYS stored as jsonb, settable by
-- an admin only and executed with shell:false. This is the single place a
-- project-specific command exists in the system, and it deliberately cannot
-- express a pipeline, a redirect, or any shell metacharacter.

CREATE TABLE repositories (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id               uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name                     text        NOT NULL,
    remote_url               text        NOT NULL,
    local_path               text        NOT NULL,
    default_branch           text        NOT NULL DEFAULT 'main',
    remote_name              text        NOT NULL DEFAULT 'origin',
    is_approved              boolean     NOT NULL DEFAULT false,
    approved_by              uuid        REFERENCES users (id) ON DELETE SET NULL,
    approved_at              timestamptz,
    last_fetched_at          timestamptz,
    last_known_default_sha   text,
    test_command             jsonb       NOT NULL DEFAULT '[]'::jsonb,
    build_command            jsonb       NOT NULL DEFAULT '[]'::jsonb,
    created_by               uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT repositories_default_branch_not_empty CHECK (length(trim(default_branch)) > 0)
);
CREATE INDEX repositories_project_id_idx ON repositories (project_id);
CREATE UNIQUE INDEX repositories_project_name_key ON repositories (project_id, name);

-- ---------------------------------------------------------------------------
-- Handoff briefs and discovery
-- ---------------------------------------------------------------------------

CREATE TABLE handoff_briefs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id             uuid        NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    project_id          uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    version             integer     NOT NULL DEFAULT 1,
    status              text        NOT NULL DEFAULT 'draft',
    -- The structured brief. The rendered markdown is derived, never stored as
    -- the source of truth, so the two can never disagree.
    content             jsonb       NOT NULL,
    confidence          numeric(4,3) NOT NULL DEFAULT 0,
    -- Provenance: the free-flow conversation the brief was derived from. Kept
    -- so a reviewer can see what Mac was told, never used as the specification.
    source_conversation text        NOT NULL DEFAULT '',
    context_summary     text,
    created_by          uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT handoff_briefs_status_check CHECK (status IN ('draft', 'ready', 'approved', 'superseded')),
    CONSTRAINT handoff_briefs_confidence_range CHECK (confidence >= 0 AND confidence <= 1)
);
CREATE INDEX handoff_briefs_task_id_idx ON handoff_briefs (task_id);
CREATE UNIQUE INDEX handoff_briefs_task_version_key ON handoff_briefs (task_id, version);

CREATE TABLE discovery_sessions (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id            uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    task_id               uuid        NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    status                text        NOT NULL DEFAULT 'open',
    messages              jsonb       NOT NULL DEFAULT '[]'::jsonb,
    context_summary       text,
    context_snapshot      jsonb,
    context_inspected_at  timestamptz,
    brief_id              uuid        REFERENCES handoff_briefs (id) ON DELETE SET NULL,
    pending_question      jsonb,
    created_by            uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT discovery_sessions_status_check CHECK (status IN ('open', 'brief_drafted', 'ready', 'closed'))
);
CREATE INDEX discovery_sessions_task_id_idx ON discovery_sessions (task_id);
CREATE INDEX discovery_sessions_project_id_idx ON discovery_sessions (project_id);

-- ---------------------------------------------------------------------------
-- Runs gain a repository, a brief and a scope
-- ---------------------------------------------------------------------------

ALTER TABLE runs ADD COLUMN repository_id    uuid REFERENCES repositories (id) ON DELETE SET NULL;
ALTER TABLE runs ADD COLUMN handoff_brief_id uuid REFERENCES handoff_briefs (id) ON DELETE SET NULL;
-- What the human actually authorised. In the 60–79% band this is a NARROWER
-- scope than the brief describes, and the difference is the whole point of the
-- band, so it is recorded rather than implied.
ALTER TABLE runs ADD COLUMN scope_kind       text NOT NULL DEFAULT 'full';
ALTER TABLE runs ADD COLUMN approved_scope   text;
ALTER TABLE runs ADD CONSTRAINT runs_scope_kind_check CHECK (scope_kind IN ('full', 'limited'));

CREATE INDEX runs_repository_id_idx ON runs (repository_id);

-- ---------------------------------------------------------------------------
-- Worktrees
-- ---------------------------------------------------------------------------
--
-- `status` defaults to 'active' and moves to 'preserved' rather than 'removed'
-- whenever a human might need to look at the work. Sprint 2 §18: do not destroy
-- useful work merely because the cutoff occurred.

CREATE TABLE worktrees (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id        uuid        NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    repository_id uuid        NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
    path          text        NOT NULL,
    branch        text        NOT NULL,
    base_branch   text        NOT NULL,
    base_sha      text        NOT NULL,
    head_sha      text,
    commit_count  integer     NOT NULL DEFAULT 0,
    status        text        NOT NULL DEFAULT 'active',
    created_at    timestamptz NOT NULL DEFAULT now(),
    released_at   timestamptz,
    removed_at    timestamptz,
    CONSTRAINT worktrees_status_check CHECK (status IN ('active', 'preserved', 'removed'))
);
CREATE UNIQUE INDEX worktrees_run_id_key ON worktrees (run_id);
CREATE INDEX worktrees_repository_id_idx ON worktrees (repository_id);

-- ---------------------------------------------------------------------------
-- Coding-agent sessions, questions, assumptions, blockers
-- ---------------------------------------------------------------------------

CREATE TABLE agent_sessions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id              uuid        NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    provider            text        NOT NULL,
    -- The provider's own session id, recorded so a session dropped by a network
    -- failure can be re-attached rather than restarted from nothing.
    provider_session_id text,
    provider_version    text,
    model               text,
    state               text        NOT NULL DEFAULT 'starting',
    current_activity    text,
    highest_event_seq   integer     NOT NULL DEFAULT -1,
    error               text,
    started_at          timestamptz NOT NULL DEFAULT now(),
    ended_at            timestamptz,
    CONSTRAINT agent_sessions_provider_check CHECK (provider IN ('claude_code', 'mock')),
    CONSTRAINT agent_sessions_state_check CHECK (state IN ('starting', 'running', 'awaiting_answer', 'completed', 'failed', 'cancelled'))
);
CREATE UNIQUE INDEX agent_sessions_run_id_key ON agent_sessions (run_id);

-- Every question a coding agent asks and every answer Mac gives, with the
-- reasoning and the sources behind it. Sprint 2 §8 requires all of it to be
-- persisted; this table is that requirement.
CREATE TABLE agent_questions (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id                  uuid        NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    agent_session_id        uuid        REFERENCES agent_sessions (id) ON DELETE SET NULL,
    external_id             text        NOT NULL,
    seq                     integer     NOT NULL,
    question                text        NOT NULL,
    context                 text,
    answer                  text,
    decision                text,
    confidence              numeric(4,3),
    reasoning               text,
    sources                 jsonb       NOT NULL DEFAULT '[]'::jsonb,
    risk                    text        NOT NULL DEFAULT 'low',
    required_human          boolean     NOT NULL DEFAULT false,
    affected_implementation boolean     NOT NULL DEFAULT false,
    asked_at                timestamptz NOT NULL DEFAULT now(),
    answered_at             timestamptz,
    CONSTRAINT agent_questions_decision_check CHECK (decision IS NULL OR decision IN ('answered', 'assumed', 'blocked')),
    CONSTRAINT agent_questions_risk_check CHECK (risk IN ('low', 'medium', 'high')),
    CONSTRAINT agent_questions_confidence_range CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);
CREATE INDEX agent_questions_run_id_idx ON agent_questions (run_id);
-- Idempotency: a retried question upload must not create a second row.
CREATE UNIQUE INDEX agent_questions_run_external_key ON agent_questions (run_id, external_id);

CREATE TABLE run_assumptions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id      uuid         NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    question_id uuid         REFERENCES agent_questions (id) ON DELETE SET NULL,
    statement   text         NOT NULL,
    confidence  numeric(4,3) NOT NULL,
    reversible  boolean      NOT NULL DEFAULT true,
    -- Set when the assumption sits below the autonomy threshold and must be
    -- surfaced prominently in the morning report (spec §6).
    flagged     boolean      NOT NULL DEFAULT false,
    source      text,
    created_at  timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT run_assumptions_confidence_range CHECK (confidence >= 0 AND confidence <= 1)
);
CREATE INDEX run_assumptions_run_id_idx ON run_assumptions (run_id);

-- A blocked subtask does not stop the run (Sprint 2 §10). It is recorded here,
-- the independent work continues, and the blocker is reported.
CREATE TABLE run_blockers (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id      uuid        NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    question_id uuid        REFERENCES agent_questions (id) ON DELETE SET NULL,
    description text        NOT NULL,
    reason      text        NOT NULL,
    risk        text        NOT NULL DEFAULT 'high',
    resolved    boolean     NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT run_blockers_risk_check CHECK (risk IN ('low', 'medium', 'high'))
);
CREATE INDEX run_blockers_run_id_idx ON run_blockers (run_id);

-- ---------------------------------------------------------------------------
-- Refused git operations
-- ---------------------------------------------------------------------------
--
-- A separate table rather than a log line, because an attempt to merge into the
-- default branch is a security event: it needs to be queryable, countable, and
-- impossible to lose in log volume. Rows here also block PR creation.

CREATE TABLE git_violations (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id     uuid        NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    code       text        NOT NULL,
    argv       jsonb       NOT NULL DEFAULT '[]'::jsonb,
    message    text        NOT NULL,
    origin     text        NOT NULL,
    at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT git_violations_origin_check CHECK (origin IN ('mac', 'agent'))
);
CREATE INDEX git_violations_run_id_idx ON git_violations (run_id);

-- ---------------------------------------------------------------------------
-- Self-review and pull requests
-- ---------------------------------------------------------------------------

CREATE TABLE run_reviews (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id                   uuid        NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    verdict                  text        NOT NULL,
    risk_level               text        NOT NULL,
    satisfies_brief          boolean     NOT NULL,
    acceptance_criteria_met  boolean     NOT NULL,
    unexpected_scope         boolean     NOT NULL,
    human_attention_required boolean     NOT NULL,
    pr_recommended           boolean     NOT NULL,
    pr_decline_reason        text,
    anomalies                jsonb       NOT NULL DEFAULT '[]'::jsonb,
    -- The raw facts the verdict was drawn from, kept so the judgement can be
    -- re-examined later against evidence rather than against a summary.
    evidence                 jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT run_reviews_verdict_check CHECK (verdict IN ('satisfies_brief', 'partially_satisfies_brief', 'does_not_satisfy_brief', 'unreviewable')),
    CONSTRAINT run_reviews_risk_check CHECK (risk_level IN ('low', 'medium', 'high'))
);
CREATE UNIQUE INDEX run_reviews_run_id_key ON run_reviews (run_id);

-- Note the absence of any `merged_at`, `merge_sha` or `state` column that could
-- record a merge. Mac has no merge capability, so the schema has nowhere to
-- write one.
CREATE TABLE pull_requests (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id      uuid        NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    provider    text        NOT NULL DEFAULT 'github',
    number      integer,
    url         text        NOT NULL,
    title       text        NOT NULL,
    body        text        NOT NULL DEFAULT '',
    branch      text        NOT NULL,
    base_branch text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pull_requests_run_id_key ON pull_requests (run_id);

-- ---------------------------------------------------------------------------
-- Usage
-- ---------------------------------------------------------------------------

CREATE TABLE usage_snapshots (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id                uuid        NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    provider              text        NOT NULL,
    phase                 text        NOT NULL,
    -- The whole point of the usage model: what KIND of number this is, stored
    -- next to the number so the two can never be separated.
    source                text        NOT NULL,
    input_tokens          bigint,
    output_tokens         bigint,
    cache_read_tokens     bigint,
    cache_creation_tokens bigint,
    cost_cents            integer,
    percent_used          numeric(6,3),
    state                 text,
    reporting_period      text,
    note                  text,
    raw                   jsonb       NOT NULL DEFAULT '{}'::jsonb,
    captured_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT usage_snapshots_phase_check CHECK (phase IN ('before', 'after')),
    CONSTRAINT usage_snapshots_source_check CHECK (source IN ('exact', 'observed', 'estimated', 'unavailable')),
    CONSTRAINT usage_snapshots_percent_range CHECK (percent_used IS NULL OR (percent_used >= 0 AND percent_used <= 100))
);
CREATE INDEX usage_snapshots_run_id_idx ON usage_snapshots (run_id);
CREATE UNIQUE INDEX usage_snapshots_run_provider_phase_key ON usage_snapshots (run_id, provider, phase);

-- `is_exact` from Sprint 1 was a boolean where the domain has four values.
-- `source` replaces it; `is_exact` is retained and kept consistent so no
-- existing query silently changes meaning.
ALTER TABLE run_usage ADD COLUMN source text NOT NULL DEFAULT 'estimated';
ALTER TABLE run_usage ADD COLUMN model  text;
ALTER TABLE run_usage ADD CONSTRAINT run_usage_source_check CHECK (source IN ('exact', 'observed', 'estimated', 'unavailable'));
UPDATE run_usage SET source = CASE WHEN is_exact THEN 'exact' ELSE 'estimated' END;

-- ---------------------------------------------------------------------------
-- Morning reports
-- ---------------------------------------------------------------------------

CREATE TABLE run_reports (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id       uuid        NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    generated_at timestamptz NOT NULL DEFAULT now(),
    content      jsonb       NOT NULL,
    markdown     text        NOT NULL
);
CREATE UNIQUE INDEX run_reports_run_id_key ON run_reports (run_id);

-- ---------------------------------------------------------------------------
-- Memory (spec §9)
-- ---------------------------------------------------------------------------
--
-- Three layers in one table, separated by `scope` plus the nullable project/task
-- foreign keys. The CHECK enforces the shape of each layer, which is what stops
-- task memory from leaking into unrelated tasks: a task-scoped row is
-- unreachable from a query for another task's memory because it MUST carry a
-- task_id.

CREATE TABLE memory_entries (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scope      text         NOT NULL,
    project_id uuid         REFERENCES projects (id) ON DELETE CASCADE,
    task_id    uuid         REFERENCES tasks (id) ON DELETE CASCADE,
    key        text         NOT NULL,
    value      text         NOT NULL,
    confidence numeric(4,3) NOT NULL DEFAULT 1,
    source     text,
    -- Set when a high-confidence fact has been promoted from task memory into
    -- project memory. Assumptions are never promoted (spec §9).
    promoted   boolean      NOT NULL DEFAULT false,
    created_by uuid         REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz  NOT NULL DEFAULT now(),
    updated_at timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT memory_entries_scope_check CHECK (scope IN ('global', 'project', 'task')),
    CONSTRAINT memory_entries_confidence_range CHECK (confidence >= 0 AND confidence <= 1),
    CONSTRAINT memory_entries_scope_shape CHECK (
        (scope = 'global'  AND project_id IS NULL AND task_id IS NULL) OR
        (scope = 'project' AND project_id IS NOT NULL AND task_id IS NULL) OR
        (scope = 'task'    AND task_id IS NOT NULL)
    )
);
CREATE INDEX memory_entries_project_idx ON memory_entries (project_id);
CREATE INDEX memory_entries_task_idx ON memory_entries (task_id);
CREATE INDEX memory_entries_key_idx ON memory_entries (key);

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

ALTER TABLE settings ADD COLUMN soft_usage_threshold_pct   integer      NOT NULL DEFAULT 80;
ALTER TABLE settings ADD COLUMN soft_usage_stops_execution boolean      NOT NULL DEFAULT false;
ALTER TABLE settings ADD COLUMN coding_agent_enabled       boolean      NOT NULL DEFAULT true;
ALTER TABLE settings ADD COLUMN max_agent_minutes          integer      NOT NULL DEFAULT 60;
ALTER TABLE settings ADD COLUMN max_questions_per_run      integer      NOT NULL DEFAULT 20;
-- Confidence at or above which Mac answers a coding-agent question outright
-- rather than recording a flagged assumption (Sprint 2 §9).
ALTER TABLE settings ADD COLUMN answer_confidence_threshold numeric(4,3) NOT NULL DEFAULT 0.800;
ALTER TABLE settings ADD CONSTRAINT settings_soft_usage_pct_check CHECK (soft_usage_threshold_pct BETWEEN 1 AND 100);
ALTER TABLE settings ADD CONSTRAINT settings_answer_confidence_range CHECK (answer_confidence_threshold >= 0 AND answer_confidence_threshold <= 1);

-- ---------------------------------------------------------------------------
-- Enum CHECK constraints extended for the new job kinds, stop reasons and
-- audit event types.
-- ---------------------------------------------------------------------------

ALTER TABLE runs DROP CONSTRAINT runs_job_kind_check;
ALTER TABLE runs ADD CONSTRAINT runs_job_kind_check CHECK (job_kind IN (
    'noop', 'echo', 'sleep', 'system_info', 'workspace_check', 'fail',
    'claude_code', 'repo_inspect'
));

ALTER TABLE runs DROP CONSTRAINT runs_stop_reason_check;
ALTER TABLE runs ADD CONSTRAINT runs_stop_reason_check CHECK (stop_reason IN (
    'completed', 'failed', 'cancelled_by_user', 'force_cancelled_worker_unreachable',
    'overnight_cutoff', 'budget_exhausted', 'confidence_below_threshold',
    'unsupported_job_kind', 'worker_error',
    'prohibited_git_operation', 'coding_agent_error', 'blocked_unsafe_decision',
    'repository_not_approved', 'agent_time_limit', 'completed_with_blockers'
));

ALTER TABLE audit_events DROP CONSTRAINT audit_events_event_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_event_type_check CHECK (event_type IN (
    'auth.login', 'auth.login_failed', 'auth.logout',
    'project.created', 'project.updated',
    'task.created', 'task.updated',
    'run.created', 'run.submitted_for_approval', 'run.approved', 'run.rejected',
    'run.queued', 'run.dispatched', 'run.progress_stage_changed', 'run.completed',
    'run.failed', 'run.cancel_requested', 'run.cancelled', 'run.force_cancelled',
    'run.stopped_by_guardrail', 'run.transition_rejected',
    'worker.enrollment_token_created', 'worker.registered', 'worker.online',
    'worker.offline', 'worker.unauthorized_run_access',
    'guardrail.blocked', 'settings.updated',
    'repository.created', 'repository.updated', 'repository.approved', 'repository.approval_revoked',
    'discovery.started', 'discovery.context_inspected', 'discovery.message_recorded',
    'discovery.question_asked', 'discovery.question_answered',
    'brief.created', 'brief.updated', 'brief.confidence_calculated',
    'worktree.created', 'worktree.preserved', 'worktree.removed', 'git.operation_rejected',
    'coding_session.started', 'coding_session.question', 'coding_session.answered',
    'coding_session.assumption_recorded', 'coding_session.blocked', 'coding_session.activity',
    'coding_session.completed', 'coding_session.failed',
    'test.run', 'test.failed',
    'run.self_review', 'run.review_completed',
    'pull_request.created', 'pull_request.declined',
    'usage.snapshot', 'report.generated',
    'memory.recorded', 'memory.promoted'
));
