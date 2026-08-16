-- Mac Bennett — Sprint 3: the operational night-shift employee.
--
-- Additive, with ONE deliberate removal: `workers.token_hash` moves into a
-- `worker_tokens` table. Rotation needs several tokens per worker to exist at
-- once and a single column cannot express that; leaving the column behind would
-- create two sources of truth for the credential that guards code execution,
-- and the one that drifts is always the one nobody tests.
--
-- `audit_events` is untouched beyond its CHECK constraint gaining new event
-- types. Its immutability triggers stay exactly as 0001/0002/0003 installed them.

-- ---------------------------------------------------------------------------
-- Worker credentials
-- ---------------------------------------------------------------------------
--
-- Three statuses, and the middle one is the whole point:
--
--   active      the current credential
--   superseded  replaced, still accepted until `expires_at` — a SHORT window,
--               so an in-flight request signed with the old token does not fail
--               mid-rotation
--   revoked     rejected immediately, no grace, and a presented revoked token
--               is audited because it means a leaked credential is being used

CREATE TABLE worker_tokens (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    worker_id      uuid        NOT NULL REFERENCES workers (id) ON DELETE CASCADE,
    token_hash     text        NOT NULL,
    token_prefix   text        NOT NULL,
    status         text        NOT NULL DEFAULT 'active',
    issued_via     text        NOT NULL DEFAULT 'enrollment',
    issued_at      timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz,
    last_used_at   timestamptz,
    superseded_at  timestamptz,
    revoked_at     timestamptz,
    revoked_by     uuid        REFERENCES users (id) ON DELETE SET NULL,
    revoked_reason text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT worker_tokens_status_check CHECK (status IN ('active', 'superseded', 'revoked')),
    CONSTRAINT worker_tokens_issued_via_check CHECK (issued_via IN ('enrollment', 'rotation', 'admin_reset')),
    -- A superseded token without an expiry would be an indefinitely valid second
    -- credential, which is precisely what rotation exists to end.
    CONSTRAINT worker_tokens_superseded_expires CHECK (status <> 'superseded' OR expires_at IS NOT NULL)
);
CREATE UNIQUE INDEX worker_tokens_token_hash_key ON worker_tokens (token_hash);
CREATE INDEX worker_tokens_worker_id_idx ON worker_tokens (worker_id);
CREATE INDEX worker_tokens_status_idx ON worker_tokens (status);

-- Carry every existing worker's credential across, so a running worker keeps
-- working over this migration without re-enrolling.
INSERT INTO worker_tokens (worker_id, token_hash, token_prefix, status, issued_via, issued_at)
SELECT id, token_hash, token_prefix, 'active', 'enrollment', registered_at
FROM workers;

ALTER TABLE workers DROP COLUMN token_hash;

ALTER TABLE workers ADD COLUMN sandbox_kind          text;
ALTER TABLE workers ADD COLUMN sandbox_ready         boolean     NOT NULL DEFAULT false;
ALTER TABLE workers ADD COLUMN sandbox_detail        text;
ALTER TABLE workers ADD COLUMN sandbox_version       text;
ALTER TABLE workers ADD COLUMN token_issued_at       timestamptz;
ALTER TABLE workers ADD COLUMN rotation_requested_at timestamptz;
ALTER TABLE workers ADD COLUMN last_rotated_at       timestamptz;
ALTER TABLE workers ADD CONSTRAINT workers_sandbox_kind_check
    CHECK (sandbox_kind IS NULL OR sandbox_kind IN ('bubblewrap', 'docker', 'none'));

UPDATE workers SET token_issued_at = registered_at;

-- ---------------------------------------------------------------------------
-- Project night-shift approval
-- ---------------------------------------------------------------------------
--
-- The second of the two gates. An approved board inside an unapproved project
-- yields nothing, and revoking either stops future selection without any call
-- site remembering to check — the same shape as `repositories.is_approved`.

ALTER TABLE projects ADD COLUMN night_shift_approved     boolean NOT NULL DEFAULT false;
ALTER TABLE projects ADD COLUMN night_shift_approved_by  uuid REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN night_shift_approved_at  timestamptz;

-- ---------------------------------------------------------------------------
-- monday.com
-- ---------------------------------------------------------------------------
--
-- `due_date_column_id` and `priority_column_id` are stored even though Mac may
-- never write to them. That is deliberate: recording them is what lets the
-- write guard RECOGNISE an attempt to change a commercial field and refuse it
-- by name, rather than merely failing to find it on an allowlist.
--
-- `may_complete` defaults false. Spec §17 lets Mac mark work complete "when
-- appropriate"; the Sprint 3 brief narrows that to "where the configured
-- workflow permits", so Ready for Review is his terminal state until a human
-- opts in per board.

CREATE TABLE monday_boards (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id                uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    board_id                  text        NOT NULL,
    name                      text        NOT NULL,
    group_ids                 jsonb       NOT NULL DEFAULT '[]'::jsonb,
    status_column_id          text        NOT NULL,
    assignee_column_id        text,
    priority_column_id        text,
    due_date_column_id        text,
    pull_request_column_id    text,
    dependency_column_id      text,
    night_shift_flag_column_id text,
    item_type_column_id       text,
    size_column_id            text,
    status_labels             jsonb       NOT NULL,
    startable_statuses        jsonb       NOT NULL DEFAULT '[]'::jsonb,
    completed_statuses        jsonb       NOT NULL DEFAULT '[]'::jsonb,
    allowed_item_types        jsonb       NOT NULL DEFAULT '[]'::jsonb,
    may_complete              boolean     NOT NULL DEFAULT false,
    night_shift_eligible      boolean     NOT NULL DEFAULT false,
    require_item_flag         boolean     NOT NULL DEFAULT true,
    mac_user_id               text,
    is_approved               boolean     NOT NULL DEFAULT false,
    approved_by               uuid        REFERENCES users (id) ON DELETE SET NULL,
    approved_at               timestamptz,
    last_synced_at            timestamptz,
    created_by                uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX monday_boards_board_id_key ON monday_boards (board_id);
CREATE INDEX monday_boards_project_id_idx ON monday_boards (project_id);

-- A cache of what monday.com says, never a source of truth for Mac's own
-- lifecycle. A status change on a board does not start, approve or stop a run.
CREATE TABLE monday_items (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    board_row_id    uuid        NOT NULL REFERENCES monday_boards (id) ON DELETE CASCADE,
    project_id      uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    task_id         uuid        REFERENCES tasks (id) ON DELETE SET NULL,
    item_id         text        NOT NULL,
    group_id        text,
    name            text        NOT NULL,
    url             text,
    status          text,
    priority        text,
    assignee_ids    jsonb       NOT NULL DEFAULT '[]'::jsonb,
    due_date        text,
    description     text,
    depends_on      jsonb       NOT NULL DEFAULT '[]'::jsonb,
    night_shift_flag boolean    NOT NULL DEFAULT false,
    item_type       text,
    size_label      text,
    raw             jsonb       NOT NULL DEFAULT '{}'::jsonb,
    last_synced_at  timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX monday_items_item_id_key ON monday_items (item_id);
CREATE INDEX monday_items_board_row_id_idx ON monday_items (board_row_id);
CREATE INDEX monday_items_task_id_idx ON monday_items (task_id);

-- The outbox. Written in the same transaction as the state change that
-- justified it, for the same reason audit events are: a run must not fail
-- because a third party is down, and monday.com must not be updated by a
-- transaction that then rolls back.
CREATE TABLE monday_writes (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    board_row_id        uuid        NOT NULL REFERENCES monday_boards (id) ON DELETE CASCADE,
    monday_item_id      text        NOT NULL,
    run_id              uuid        REFERENCES runs (id) ON DELETE SET NULL,
    task_id             uuid        REFERENCES tasks (id) ON DELETE SET NULL,
    kind                text        NOT NULL,
    payload             jsonb       NOT NULL DEFAULT '{}'::jsonb,
    status              text        NOT NULL DEFAULT 'pending',
    attempts            integer     NOT NULL DEFAULT 0,
    next_attempt_at     timestamptz NOT NULL DEFAULT now(),
    provider_message_id text,
    last_error          text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    delivered_at        timestamptz,
    CONSTRAINT monday_writes_kind_check CHECK (kind IN (
        'assign_to_mac', 'set_status', 'post_update', 'post_blocker', 'attach_pull_request'
    )),
    CONSTRAINT monday_writes_status_check CHECK (status IN (
        'pending', 'sending', 'delivered', 'failed', 'refused', 'dead'
    ))
);
CREATE INDEX monday_writes_status_idx ON monday_writes (status, next_attempt_at);
CREATE INDEX monday_writes_run_id_idx ON monday_writes (run_id);

-- ---------------------------------------------------------------------------
-- Night shift
-- ---------------------------------------------------------------------------
--
-- `settings_snapshot` matters more than it looks: reading a morning report next
-- to the thresholds as they are NOW is misleading if somebody changed them at
-- 06:00. The shift records the policy it actually ran under.

CREATE TABLE night_shifts (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status            text        NOT NULL DEFAULT 'running',
    started_at        timestamptz NOT NULL DEFAULT now(),
    ended_at          timestamptz,
    cutoff_at         timestamptz NOT NULL,
    stop_reason       text,
    started_by        uuid        REFERENCES users (id) ON DELETE SET NULL,
    settings_snapshot jsonb       NOT NULL DEFAULT '{}'::jsonb,
    tasks_attempted   integer     NOT NULL DEFAULT 0,
    tasks_completed   integer     NOT NULL DEFAULT 0,
    tasks_blocked     integer     NOT NULL DEFAULT 0,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT night_shifts_status_check CHECK (status IN ('running', 'completed', 'stopped')),
    CONSTRAINT night_shifts_stop_reason_check CHECK (stop_reason IS NULL OR stop_reason IN (
        'cutoff_reached', 'budget_exhausted', 'usage_threshold', 'no_eligible_work',
        'guardrail_stop', 'stopped_by_user', 'worker_unavailable', 'sandbox_unavailable'
    ))
);
CREATE INDEX night_shifts_status_idx ON night_shifts (status);

-- Every scheduling decision, including the refusals. A scheduler whose
-- refusals are invisible is one nobody can debug at 08:00.
CREATE TABLE night_decisions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    night_shift_id  uuid        NOT NULL REFERENCES night_shifts (id) ON DELETE CASCADE,
    at              timestamptz NOT NULL DEFAULT now(),
    sequence        integer     NOT NULL,
    decision        text        NOT NULL,
    run_id          uuid        REFERENCES runs (id) ON DELETE SET NULL,
    task_id         uuid        REFERENCES tasks (id) ON DELETE SET NULL,
    monday_item_id  text,
    rationale       jsonb       NOT NULL DEFAULT '{}'::jsonb,
    eligibility     jsonb,
    effort          jsonb,
    CONSTRAINT night_decisions_decision_check CHECK (decision IN (
        'continue', 'finalise', 'record_blocker', 'start', 'skip', 'idle', 'stop'
    ))
);
CREATE UNIQUE INDEX night_decisions_shift_sequence_key ON night_decisions (night_shift_id, sequence);
CREATE INDEX night_decisions_run_id_idx ON night_decisions (run_id);

ALTER TABLE runs ADD COLUMN night_shift_id  uuid REFERENCES night_shifts (id) ON DELETE SET NULL;
ALTER TABLE runs ADD COLUMN monday_item_id  text;
ALTER TABLE runs ADD COLUMN selected_by     text NOT NULL DEFAULT 'human';
ALTER TABLE runs ADD CONSTRAINT runs_selected_by_check CHECK (selected_by IN ('human', 'night_shift'));
CREATE INDEX runs_night_shift_id_idx ON runs (night_shift_id);

ALTER TABLE tasks ADD COLUMN monday_item_id text;
CREATE INDEX tasks_monday_item_id_idx ON tasks (monday_item_id);

-- A machine approval must never be readable as a human one, so it gets its own
-- column rather than a null approver that a JOIN might quietly render as blank.
ALTER TABLE approvals ADD COLUMN source       text NOT NULL DEFAULT 'human';
ALTER TABLE approvals ADD COLUMN policy_basis jsonb;
ALTER TABLE approvals ADD CONSTRAINT approvals_source_check CHECK (source IN ('human', 'night_shift_policy'));

-- ---------------------------------------------------------------------------
-- Discovery investigations
-- ---------------------------------------------------------------------------
--
-- `checked` is the escalation receipt: it lists every source class Mac
-- consulted and what each returned, so "he asked me something he could have
-- looked up" becomes a falsifiable claim rather than an impression.

CREATE TABLE discovery_investigations (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    discovery_session_id uuid        REFERENCES discovery_sessions (id) ON DELETE CASCADE,
    run_id               uuid        REFERENCES runs (id) ON DELETE CASCADE,
    task_id              uuid        NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    project_id           uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    subject_kind         text        NOT NULL,
    subject              text        NOT NULL,
    resolved             boolean     NOT NULL DEFAULT false,
    answer               text,
    confidence           numeric(4,3) NOT NULL DEFAULT 0,
    checked              jsonb       NOT NULL DEFAULT '[]'::jsonb,
    evidence             jsonb       NOT NULL DEFAULT '[]'::jsonb,
    escalated_to_human   boolean     NOT NULL DEFAULT false,
    model_assisted       boolean     NOT NULL DEFAULT false,
    created_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT discovery_investigations_subject_kind_check
        CHECK (subject_kind IN ('dimension', 'agent_question'))
);
CREATE INDEX discovery_investigations_task_id_idx ON discovery_investigations (task_id);
CREATE INDEX discovery_investigations_run_id_idx ON discovery_investigations (run_id);

-- Evidence-based answers. `groundedness` is DERIVED from the evidence by
-- `deriveGroundedness`, never asserted by the answering code, which is what
-- makes "no ungrounded high-confidence claims" a property rather than a hope.
ALTER TABLE agent_questions ADD COLUMN evidence        jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agent_questions ADD COLUMN groundedness    text  NOT NULL DEFAULT 'assumption';
ALTER TABLE agent_questions ADD COLUMN model_assisted  boolean NOT NULL DEFAULT false;
ALTER TABLE agent_questions ADD COLUMN sources_checked jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agent_questions ADD CONSTRAINT agent_questions_groundedness_check
    CHECK (groundedness IN ('established_fact', 'assumption'));

-- ---------------------------------------------------------------------------
-- Email delivery
-- ---------------------------------------------------------------------------
--
-- `idempotency_key` is UNIQUE, so a duplicate send is prevented by the database
-- rather than by a caller remembering to check. A row already `sent` is never
-- sent again; a second attempt to create the same delivery finds this row.

CREATE TABLE email_deliveries (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind                text        NOT NULL,
    night_shift_id      uuid        REFERENCES night_shifts (id) ON DELETE SET NULL,
    run_id              uuid        REFERENCES runs (id) ON DELETE SET NULL,
    idempotency_key     text        NOT NULL,
    recipients          jsonb       NOT NULL DEFAULT '[]'::jsonb,
    subject             text        NOT NULL,
    body_text           text        NOT NULL,
    body_html           text,
    content             jsonb       NOT NULL DEFAULT '{}'::jsonb,
    status              text        NOT NULL DEFAULT 'pending',
    attempts            integer     NOT NULL DEFAULT 0,
    next_attempt_at     timestamptz NOT NULL DEFAULT now(),
    provider            text        NOT NULL DEFAULT 'none',
    provider_message_id text,
    last_error          text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    sent_at             timestamptz,
    CONSTRAINT email_deliveries_kind_check CHECK (kind IN ('morning_report', 'night_shift_summary')),
    CONSTRAINT email_deliveries_status_check CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'dead')),
    -- A `sent` row without a timestamp would make "was this delivered?"
    -- unanswerable, which is the one question this table exists to answer.
    CONSTRAINT email_deliveries_sent_has_time CHECK (status <> 'sent' OR sent_at IS NOT NULL)
);
CREATE UNIQUE INDEX email_deliveries_idempotency_key ON email_deliveries (idempotency_key);
CREATE INDEX email_deliveries_status_idx ON email_deliveries (status, next_attempt_at);

-- ---------------------------------------------------------------------------
-- Repository: network posture for the project's own test command
-- ---------------------------------------------------------------------------
--
-- `npm test` executes code the agent just wrote, which is why it runs inside
-- the sandbox too. A test suite that needs the internet is a test suite worth
-- knowing about, so the default is `none`.

ALTER TABLE repositories ADD COLUMN test_network text NOT NULL DEFAULT 'none';
ALTER TABLE repositories ADD CONSTRAINT repositories_test_network_check
    CHECK (test_network IN ('none', 'egress'));

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

ALTER TABLE settings ADD COLUMN require_sandbox                    boolean NOT NULL DEFAULT true;
ALTER TABLE settings ADD COLUMN worker_token_max_age_hours         integer NOT NULL DEFAULT 168;
ALTER TABLE settings ADD COLUMN worker_token_overlap_seconds       integer NOT NULL DEFAULT 300;
ALTER TABLE settings ADD COLUMN night_shift_enabled                boolean NOT NULL DEFAULT false;
ALTER TABLE settings ADD COLUMN night_shift_safety_factor          numeric(4,2) NOT NULL DEFAULT 1.50;
ALTER TABLE settings ADD COLUMN night_shift_wrap_up_minutes        integer NOT NULL DEFAULT 10;
ALTER TABLE settings ADD COLUMN night_shift_min_start_minutes      integer NOT NULL DEFAULT 20;
ALTER TABLE settings ADD COLUMN night_shift_large_task_min_minutes integer NOT NULL DEFAULT 90;
ALTER TABLE settings ADD COLUMN report_recipients                  jsonb   NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE settings ADD COLUMN allowed_recipient_domains          jsonb   NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE settings ADD COLUMN mail_provider                      text    NOT NULL DEFAULT 'none';
ALTER TABLE settings ADD COLUMN model_assist_enabled               boolean NOT NULL DEFAULT false;
ALTER TABLE settings ADD COLUMN model_provider                     text    NOT NULL DEFAULT 'none';
ALTER TABLE settings ADD CONSTRAINT settings_mail_provider_check
    CHECK (mail_provider IN ('graph', 'fake', 'none'));
ALTER TABLE settings ADD CONSTRAINT settings_model_provider_check
    CHECK (model_provider IN ('anthropic', 'scripted', 'none'));
ALTER TABLE settings ADD CONSTRAINT settings_night_shift_safety_factor_check
    CHECK (night_shift_safety_factor >= 1 AND night_shift_safety_factor <= 5);

-- ---------------------------------------------------------------------------
-- Enum CHECK constraints
-- ---------------------------------------------------------------------------

ALTER TABLE runs DROP CONSTRAINT runs_stop_reason_check;
ALTER TABLE runs ADD CONSTRAINT runs_stop_reason_check CHECK (stop_reason IN (
    'completed', 'failed', 'cancelled_by_user', 'force_cancelled_worker_unreachable',
    'overnight_cutoff', 'budget_exhausted', 'confidence_below_threshold',
    'unsupported_job_kind', 'worker_error',
    'prohibited_git_operation', 'coding_agent_error', 'blocked_unsafe_decision',
    'repository_not_approved', 'agent_time_limit', 'completed_with_blockers',
    'sandbox_unavailable', 'usage_threshold_reached', 'night_shift_ended'
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
    'memory.recorded', 'memory.promoted',
    -- Sprint 3
    'sandbox.created', 'sandbox.refused', 'sandbox.attested',
    'worker.token_rotation_requested', 'worker.token_rotated', 'worker.token_revoked',
    'worker.token_rejected',
    'monday.board_mapped', 'monday.board_approved', 'monday.board_approval_revoked',
    'monday.read', 'monday.item_linked', 'monday.assigned', 'monday.status_changed',
    'monday.update_posted', 'monday.blocker_posted', 'monday.pull_request_attached',
    'monday.write_refused', 'monday.write_failed',
    'night_shift.started', 'night_shift.ended', 'night_shift.task_selected',
    'night_shift.task_skipped', 'night_shift.scheduling_decision', 'night_shift.task_switched',
    'night_shift.blocker_recorded', 'night_shift.idle',
    'run.auto_approved',
    'project.night_shift_approved', 'project.night_shift_approval_revoked',
    'discovery.investigation_completed', 'discovery.escalated_to_human',
    'report.email_attempted', 'report.email_delivered', 'report.email_failed',
    'report.email_recipient_refused',
    'model.assisted_discovery', 'model.assisted_answer', 'model.output_rejected'
));
