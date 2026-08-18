-- Mac Bennett — Sprint 1 initial schema.
--
-- Migrations are hand-written, plain SQL, and applied by src/db/migrate.ts.
-- They are deliberately portable: nothing here depends on an ORM, so the
-- database survives any future change of data-access library.
--
-- Enumerations are text + CHECK rather than Postgres ENUM types, because
-- altering a CHECK is a one-line migration in either direction whereas an ENUM
-- value can never be removed. tests/integration/schema-parity.test.ts asserts
-- that these constraints still match the authoritative lists in @mac/protocol.

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TABLE users (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email           text        NOT NULL,
    name            text        NOT NULL,
    role            text        NOT NULL DEFAULT 'viewer',
    password_hash   text        NOT NULL,
    password_salt   text        NOT NULL,
    is_active       boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_role_check CHECK (role IN ('admin', 'operator', 'viewer'))
);
CREATE UNIQUE INDEX users_email_key ON users (email);

-- Sessions are server-side and therefore revocable, which is the property that
-- matters most for a system that will eventually control autonomous agents.
-- Only the SHA-256 hash of the token is stored.
CREATE TABLE sessions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash   text        NOT NULL,
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    user_agent   text,
    ip           text,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

-- ---------------------------------------------------------------------------
-- Work
-- ---------------------------------------------------------------------------

CREATE TABLE projects (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                text        NOT NULL,
    slug                text        NOT NULL,
    description         text,
    repo_url            text,
    repo_default_branch text        DEFAULT 'main',
    is_active           boolean     NOT NULL DEFAULT true,
    created_by          uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX projects_slug_key ON projects (slug);

CREATE TABLE tasks (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  uuid          NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    title       text          NOT NULL,
    description text,
    status      text          NOT NULL DEFAULT 'draft',
    priority    text          NOT NULL DEFAULT 'normal',
    confidence  numeric(4, 3),
    created_by  uuid          REFERENCES users (id) ON DELETE SET NULL,
    created_at  timestamptz   NOT NULL DEFAULT now(),
    updated_at  timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT tasks_status_check CHECK (status IN ('draft', 'ready', 'in_progress', 'blocked', 'done', 'cancelled')),
    CONSTRAINT tasks_priority_check CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    CONSTRAINT tasks_confidence_range CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);
CREATE INDEX tasks_project_id_idx ON tasks (project_id);
CREATE INDEX tasks_status_idx ON tasks (status);

-- ---------------------------------------------------------------------------
-- Workers
-- ---------------------------------------------------------------------------

CREATE TABLE workers (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name              text        NOT NULL,
    status            text        NOT NULL DEFAULT 'registered',
    capabilities      jsonb       NOT NULL DEFAULT '[]'::jsonb,
    last_heartbeat_at timestamptz,
    current_run_id    uuid,
    token_hash        text        NOT NULL,
    token_prefix      text        NOT NULL,
    version           text,
    platform          text,
    registered_at     timestamptz NOT NULL DEFAULT now(),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT workers_status_check CHECK (status IN ('registered', 'idle', 'busy', 'offline', 'disabled'))
);
CREATE UNIQUE INDEX workers_name_key ON workers (name);
CREATE UNIQUE INDEX workers_token_hash_key ON workers (token_hash);

-- Single-use, expiring credential that a worker exchanges for its long-lived
-- token. Only the hash is stored; the plaintext is shown to an admin once.
CREATE TABLE worker_enrollment_tokens (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    label              text        NOT NULL,
    token_hash         text        NOT NULL,
    expires_at         timestamptz NOT NULL,
    used_at            timestamptz,
    used_by_worker_id  uuid        REFERENCES workers (id) ON DELETE SET NULL,
    created_by         uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX worker_enrollment_tokens_token_hash_key ON worker_enrollment_tokens (token_hash);

-- ---------------------------------------------------------------------------
-- Runs
-- ---------------------------------------------------------------------------

CREATE TABLE runs (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id               uuid          NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    status                text          NOT NULL DEFAULT 'draft',
    worker_id             uuid          REFERENCES workers (id) ON DELETE SET NULL,
    approval_state        text          NOT NULL DEFAULT 'pending',
    confidence            numeric(4, 3),
    job_kind              text          NOT NULL,
    job_params            jsonb         NOT NULL DEFAULT '{}'::jsonb,
    execution_mode        text          NOT NULL DEFAULT 'interactive',
    overnight_deadline_at timestamptz,
    lease_expires_at      timestamptz,
    attempt               integer       NOT NULL DEFAULT 0,
    progress_percent      integer,
    progress_stage        text,
    summary               text,
    cancel_requested_at   timestamptz,
    cancel_requested_by   uuid          REFERENCES users (id) ON DELETE SET NULL,
    stop_reason           text,
    started_at            timestamptz,
    completed_at          timestamptz,
    created_by            uuid          REFERENCES users (id) ON DELETE SET NULL,
    created_at            timestamptz   NOT NULL DEFAULT now(),
    updated_at            timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT runs_status_check CHECK (status IN (
        'draft', 'discovery', 'ready_for_approval', 'approved', 'queued', 'running',
        'blocked', 'self_review', 'ready_for_human_review', 'completed',
        'stopped_by_guardrail', 'cancelled', 'failed')),
    CONSTRAINT runs_approval_state_check CHECK (approval_state IN (
        'not_required', 'pending', 'approved', 'rejected', 'revoked')),
    CONSTRAINT runs_job_kind_check CHECK (job_kind IN (
        'noop', 'echo', 'sleep', 'system_info', 'workspace_check', 'fail')),
    CONSTRAINT runs_execution_mode_check CHECK (execution_mode IN ('interactive', 'overnight')),
    CONSTRAINT runs_stop_reason_check CHECK (stop_reason IS NULL OR stop_reason IN (
        'completed', 'failed', 'cancelled_by_user', 'force_cancelled_worker_unreachable',
        'overnight_cutoff', 'budget_exhausted', 'confidence_below_threshold',
        'unsupported_job_kind', 'worker_error')),
    CONSTRAINT runs_confidence_range CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    CONSTRAINT runs_progress_range CHECK (progress_percent IS NULL OR (progress_percent >= 0 AND progress_percent <= 100))
);
CREATE INDEX runs_task_id_idx ON runs (task_id);
CREATE INDEX runs_status_idx ON runs (status);
CREATE INDEX runs_worker_id_idx ON runs (worker_id);
-- Supports the dispatch query, which is the hottest path in the system.
CREATE INDEX runs_dispatch_idx ON runs (status, approval_state, created_at);

-- Now that both tables exist, close the circular reference.
ALTER TABLE workers
    ADD CONSTRAINT workers_current_run_id_fkey
    FOREIGN KEY (current_run_id) REFERENCES runs (id) ON DELETE SET NULL;

CREATE TABLE approvals (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id                 uuid          NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    action                 text          NOT NULL,
    approver_user_id       uuid          REFERENCES users (id) ON DELETE SET NULL,
    notes                  text,
    -- Captured at decision time so the record still makes sense after settings change.
    confidence_at_decision numeric(4, 3),
    threshold_at_decision  numeric(4, 3),
    threshold_overridden   boolean       NOT NULL DEFAULT false,
    created_at             timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT approvals_action_check CHECK (action IN ('approve', 'reject', 'revoke'))
);
CREATE INDEX approvals_run_id_idx ON approvals (run_id);

CREATE TABLE run_logs (
    id         bigserial PRIMARY KEY,
    run_id     uuid        NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    seq        integer     NOT NULL,
    ts         timestamptz NOT NULL,
    stream     text        NOT NULL,
    message    text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT run_logs_stream_check CHECK (stream IN ('stdout', 'stderr', 'system'))
);
-- Makes a retried log batch idempotent rather than duplicated.
CREATE UNIQUE INDEX run_logs_run_id_seq_key ON run_logs (run_id, seq);

-- Provider usage. Ships empty in Sprint 1 (no cost integration exists yet) but
-- exists so the budget guardrail sums real rows instead of being a stub.
-- `is_exact` encodes spec §25: never present an estimate as exact usage.
CREATE TABLE run_usage (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id      uuid           NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    provider    text           NOT NULL,
    kind        text           NOT NULL,
    quantity    numeric(18, 4),
    unit        text,
    cost_cents  integer,
    is_exact    boolean        NOT NULL DEFAULT false,
    metadata    jsonb          NOT NULL DEFAULT '{}'::jsonb,
    recorded_at timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX run_usage_run_id_idx ON run_usage (run_id);
CREATE INDEX run_usage_recorded_at_idx ON run_usage (recorded_at);

-- ---------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------

-- Note the deliberate absence of foreign keys: deleting a project must never
-- cascade away the record that it existed and what was done to it. The id
-- columns are references in spirit only, and actor_label is denormalised so
-- the trail stays readable after a user is renamed or removed.
CREATE TABLE audit_events (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ts          timestamptz NOT NULL DEFAULT now(),
    actor_type  text        NOT NULL,
    actor_id    uuid,
    actor_label text        NOT NULL,
    event_type  text        NOT NULL,
    project_id  uuid,
    task_id     uuid,
    run_id      uuid,
    worker_id   uuid,
    metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT audit_events_actor_type_check CHECK (actor_type IN ('user', 'worker', 'system')),
    CONSTRAINT audit_events_event_type_check CHECK (event_type IN (
        'auth.login', 'auth.login_failed', 'auth.logout',
        'project.created', 'project.updated',
        'task.created', 'task.updated',
        'run.created', 'run.submitted_for_approval', 'run.approved', 'run.rejected',
        'run.queued', 'run.dispatched', 'run.progress_stage_changed', 'run.completed',
        'run.failed', 'run.cancel_requested', 'run.cancelled', 'run.force_cancelled',
        'run.stopped_by_guardrail', 'run.transition_rejected',
        'worker.enrollment_token_created', 'worker.registered', 'worker.online',
        'worker.offline', 'worker.unauthorized_run_access',
        'guardrail.blocked', 'settings.updated'))
);
CREATE INDEX audit_events_ts_idx ON audit_events (ts);
CREATE INDEX audit_events_run_id_idx ON audit_events (run_id);
CREATE INDEX audit_events_task_id_idx ON audit_events (task_id);
CREATE INDEX audit_events_project_id_idx ON audit_events (project_id);
CREATE INDEX audit_events_event_type_idx ON audit_events (event_type);

-- Immutability is enforced by the database, not by convention. Application code
-- has no update or delete path for audit events, and now neither does anything
-- else short of dropping this trigger — which is itself a reviewable migration.
CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only: % is not permitted', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update_or_delete
    BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

-- ---------------------------------------------------------------------------
-- Settings (singleton)
-- ---------------------------------------------------------------------------

CREATE TABLE settings (
    id                           smallint PRIMARY KEY DEFAULT 1,
    timezone                     text          NOT NULL DEFAULT 'Australia/Sydney',
    overnight_cutoff             text          NOT NULL DEFAULT '08:00',
    default_confidence_threshold numeric(4, 3) NOT NULL DEFAULT 0.800,
    min_execution_confidence     numeric(4, 3) NOT NULL DEFAULT 0.600,
    nightly_budget_cents         integer       NOT NULL DEFAULT 5000,
    currency                     text          NOT NULL DEFAULT 'AUD',
    budget_warning_pct           integer       NOT NULL DEFAULT 80,
    budget_stop_pct              integer       NOT NULL DEFAULT 100,
    heartbeat_interval_seconds   integer       NOT NULL DEFAULT 10,
    heartbeat_grace_seconds      integer       NOT NULL DEFAULT 20,
    updated_at                   timestamptz   NOT NULL DEFAULT now(),
    updated_by                   uuid          REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT settings_singleton CHECK (id = 1),
    CONSTRAINT settings_cutoff_format CHECK (overnight_cutoff ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    CONSTRAINT settings_threshold_range CHECK (default_confidence_threshold >= 0 AND default_confidence_threshold <= 1),
    CONSTRAINT settings_floor_range CHECK (min_execution_confidence >= 0 AND min_execution_confidence <= 1)
);

INSERT INTO settings (id) VALUES (1);
