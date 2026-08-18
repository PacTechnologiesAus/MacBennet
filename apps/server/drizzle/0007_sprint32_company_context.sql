-- Mac Bennett — Sprint 3.2: PAC shared company context.
--
-- Purely additive. Nothing existing is dropped, no column changes type, and the
-- four new binding columns are all nullable — so a database that has never seen
-- a Company repository behaves exactly as it did at Sprint 3.1.
--
-- Two things here are load-bearing and worth reading before changing anything:
--
--   1. `company_context_revision_id` is IMMUTABLE once set. Sprint 3.2 §8.2
--      requires that an active run stays pinned to the context that governed it,
--      and a trigger is the only place that rule cannot be forgotten. Application
--      code that never intends to move a binding will not; application code
--      written next year, by someone who has not read this file, might.
--
--   2. Document CONTENT is deliberately absent from every table below. The
--      authoritative copy of PAC policy is the Git repository the humans govern.
--      Copying it into Postgres would create a second, un-governed copy — which
--      is the exact failure this sprint exists to prevent. What is stored is
--      identity: SHA, version, hashes, and document metadata.

-- ---------------------------------------------------------------------------
-- Revisions
-- ---------------------------------------------------------------------------
--
-- One row per (repository, commit) Mac has ever loaded OR failed to load.
--
-- Failures are recorded rather than discarded: "Mac refused to work at 02:14 and
-- this is the manifest error that stopped him" is exactly the row an operator
-- wants at 08:00, and it cannot be reconstructed from a log line that scrolled.

CREATE TABLE company_context_revisions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_url      text        NOT NULL,
    ref                 text        NOT NULL,
    commit_sha          text        NOT NULL,
    commit_authored_at  timestamptz,
    context_version     text        NOT NULL DEFAULT '',
    schema_version      integer     NOT NULL DEFAULT 0,
    -- The whole parsed manifest, unknown future fields included, so an operator
    -- can see what PAC declared even on a Mac that does not yet act on it.
    manifest            jsonb       NOT NULL DEFAULT '{}'::jsonb,
    manifest_sha256     text        NOT NULL DEFAULT '',
    document_set_sha256 text        NOT NULL DEFAULT '',
    -- [{path, bytes, sha256, headings}] — metadata only. Never content.
    documents           jsonb       NOT NULL DEFAULT '[]'::jsonb,
    validation_state    text        NOT NULL,
    validation_errors   jsonb       NOT NULL DEFAULT '[]'::jsonb,
    provider_kind       text        NOT NULL DEFAULT 'git',
    source              text        NOT NULL DEFAULT 'remote',
    loaded_at           timestamptz NOT NULL DEFAULT now(),
    first_seen_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT company_context_revisions_validation_state_check
        CHECK (validation_state IN ('valid', 'invalid')),
    CONSTRAINT company_context_revisions_source_check
        CHECK (source IN ('remote', 'cache')),
    CONSTRAINT company_context_revisions_provider_kind_check
        CHECK (provider_kind IN ('git', 'memory')),
    -- A valid revision must actually name the context version it validated.
    CONSTRAINT company_context_revisions_valid_has_version
        CHECK (validation_state <> 'valid' OR length(context_version) > 0)
);

-- Re-loading the same commit updates the existing row rather than creating a
-- second one, so bindings made yesterday still point at the row that describes
-- what was loaded.
CREATE UNIQUE INDEX company_context_revisions_repo_commit_key
    ON company_context_revisions (repository_url, commit_sha);
CREATE INDEX company_context_revisions_commit_idx ON company_context_revisions (commit_sha);
CREATE INDEX company_context_revisions_state_idx
    ON company_context_revisions (validation_state, loaded_at DESC);

-- ---------------------------------------------------------------------------
-- Status
-- ---------------------------------------------------------------------------
--
-- Singleton, like `settings`, and persisted rather than held in memory for one
-- reason: "when did Mac last successfully reach the Company repository?" is
-- asked most often immediately after a restart, which is precisely when an
-- in-memory answer would have just been lost.

CREATE TABLE company_context_status (
    id                         smallint PRIMARY KEY DEFAULT 1,
    active_revision_id         uuid REFERENCES company_context_revisions (id) ON DELETE RESTRICT,
    status                     text        NOT NULL DEFAULT 'disabled',
    last_check_at              timestamptz,
    last_successful_refresh_at timestamptz,
    -- Redacted before it ever arrives here. See redactGitError().
    last_error                 text,
    consecutive_failures       integer     NOT NULL DEFAULT 0,
    updated_at                 timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT company_context_status_singleton CHECK (id = 1),
    CONSTRAINT company_context_status_status_check
        CHECK (status IN ('disabled', 'fresh', 'cached', 'stale', 'invalid', 'unavailable'))
);

INSERT INTO company_context_status (id, status) VALUES (1, 'disabled');

-- ---------------------------------------------------------------------------
-- Proposals
-- ---------------------------------------------------------------------------
--
-- The ONLY thing Mac may produce that is about changing company context.
--
-- Note what this table cannot do: it cannot write the repository. Accepting a
-- proposal records that a human agreed; turning that into a commit is a human
-- action outside this system (Sprint 3.2 §16). That boundary is the reason the
-- table exists at all rather than Mac simply opening a pull request.

CREATE TABLE company_context_proposals (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    target_document      text        NOT NULL,
    target_section       text,
    proposed_change      text        NOT NULL,
    reason               text        NOT NULL,
    evidence             jsonb       NOT NULL DEFAULT '[]'::jsonb,
    potential_impact     text,
    project_id           uuid REFERENCES projects (id) ON DELETE SET NULL,
    task_id              uuid REFERENCES tasks (id) ON DELETE SET NULL,
    run_id               uuid REFERENCES runs (id) ON DELETE SET NULL,
    discovery_session_id uuid REFERENCES discovery_sessions (id) ON DELETE SET NULL,
    agent                text        NOT NULL DEFAULT 'mac',
    -- Which revision the proposal was written against, so a reviewer knows what
    -- the document said when Mac suggested changing it.
    base_revision_id     uuid REFERENCES company_context_revisions (id) ON DELETE RESTRICT,
    status               text        NOT NULL DEFAULT 'proposed',
    created_by           uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    reviewed_by          uuid REFERENCES users (id) ON DELETE SET NULL,
    reviewed_at          timestamptz,
    review_notes         text,
    CONSTRAINT company_context_proposals_status_check
        CHECK (status IN ('proposed', 'under_review', 'accepted', 'rejected', 'superseded')),
    -- A decided proposal must name who decided it. An "accepted" row with no
    -- reviewer would be indistinguishable from one Mac had accepted himself,
    -- which is the single thing this whole area exists to make impossible.
    CONSTRAINT company_context_proposals_decided_has_reviewer
        CHECK (status NOT IN ('accepted', 'rejected') OR reviewed_by IS NOT NULL)
);
CREATE INDEX company_context_proposals_status_idx
    ON company_context_proposals (status, created_at DESC);
CREATE INDEX company_context_proposals_base_revision_idx
    ON company_context_proposals (base_revision_id);
CREATE INDEX company_context_proposals_task_idx ON company_context_proposals (task_id);

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
--
-- Disabled by default, matching every other external integration in this system
-- (night shift, model assist, mail provider). An integration that reaches out to
-- a remote service is inert until an operator turns it on; the PAC deployment
-- turns this one on.

ALTER TABLE settings ADD COLUMN company_context_enabled             boolean NOT NULL DEFAULT false;
ALTER TABLE settings ADD COLUMN company_context_allow_cached        boolean NOT NULL DEFAULT true;
ALTER TABLE settings ADD COLUMN company_context_min_refresh_seconds integer NOT NULL DEFAULT 60;
-- 0 means "never call it stale". 168 hours = one week.
ALTER TABLE settings ADD COLUMN company_context_max_stale_hours     integer NOT NULL DEFAULT 168;

ALTER TABLE settings ADD CONSTRAINT settings_company_min_refresh_check
    CHECK (company_context_min_refresh_seconds >= 0 AND company_context_min_refresh_seconds <= 86400);
ALTER TABLE settings ADD CONSTRAINT settings_company_max_stale_check
    CHECK (company_context_max_stale_hours >= 0 AND company_context_max_stale_hours <= 8760);

-- ---------------------------------------------------------------------------
-- Bindings
-- ---------------------------------------------------------------------------
--
-- ON DELETE RESTRICT, not SET NULL: a revision that governed real work must not
-- be removable, because the whole point is that the run stays attributable.

ALTER TABLE discovery_sessions ADD COLUMN company_context_revision_id uuid
    REFERENCES company_context_revisions (id) ON DELETE RESTRICT;
ALTER TABLE handoff_briefs ADD COLUMN company_context_revision_id uuid
    REFERENCES company_context_revisions (id) ON DELETE RESTRICT;
ALTER TABLE runs ADD COLUMN company_context_revision_id uuid
    REFERENCES company_context_revisions (id) ON DELETE RESTRICT;
ALTER TABLE agent_questions ADD COLUMN company_context_revision_id uuid
    REFERENCES company_context_revisions (id) ON DELETE RESTRICT;

CREATE INDEX discovery_sessions_company_context_idx ON discovery_sessions (company_context_revision_id);
CREATE INDEX handoff_briefs_company_context_idx     ON handoff_briefs (company_context_revision_id);
CREATE INDEX runs_company_context_idx               ON runs (company_context_revision_id);
CREATE INDEX agent_questions_company_context_idx    ON agent_questions (company_context_revision_id);

-- ---------------------------------------------------------------------------
-- The pin
-- ---------------------------------------------------------------------------
--
-- Sprint 3.2 §9: "Do not silently change company context in the middle of an
-- active run." Application code does not try to. This makes it so that it
-- cannot, including through a code path nobody has written yet.
--
-- Setting a NULL binding is allowed — that is the initial bind, and it also lets
-- a row created before the feature was enabled be bound the first time work
-- actually uses it. Changing a non-null binding, to a different revision or to
-- NULL, raises.

CREATE OR REPLACE FUNCTION company_context_binding_is_immutable() RETURNS trigger AS $$
BEGIN
    IF OLD.company_context_revision_id IS NOT NULL
       AND (NEW.company_context_revision_id IS DISTINCT FROM OLD.company_context_revision_id) THEN
        RAISE EXCEPTION
            'company_context_revision_id is immutable once set (table %, row %): work stays attributable to the company context that governed it',
            TG_TABLE_NAME, OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER discovery_sessions_company_context_pin
    BEFORE UPDATE ON discovery_sessions
    FOR EACH ROW EXECUTE FUNCTION company_context_binding_is_immutable();

CREATE TRIGGER handoff_briefs_company_context_pin
    BEFORE UPDATE ON handoff_briefs
    FOR EACH ROW EXECUTE FUNCTION company_context_binding_is_immutable();

CREATE TRIGGER runs_company_context_pin
    BEFORE UPDATE ON runs
    FOR EACH ROW EXECUTE FUNCTION company_context_binding_is_immutable();

CREATE TRIGGER agent_questions_company_context_pin
    BEFORE UPDATE ON agent_questions
    FOR EACH ROW EXECUTE FUNCTION company_context_binding_is_immutable();

-- ---------------------------------------------------------------------------
-- Evidence and investigation vocabulary
-- ---------------------------------------------------------------------------
--
-- `agent_questions.evidence` and `discovery_investigations.evidence` are jsonb
-- and unconstrained, so the new `company_policy` evidence kind and the new
-- `company_context` investigation source need no DDL. They are enumerated in
-- @mac/protocol, which is what validates them on the way in.

-- ---------------------------------------------------------------------------
-- Audit events
-- ---------------------------------------------------------------------------

ALTER TABLE audit_events DROP CONSTRAINT audit_events_event_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_event_type_check CHECK (event_type IN (
    'auth.login', 'auth.login_failed', 'auth.logout',
    'project.created', 'project.updated',
    'task.created', 'task.updated',
    'run.created', 'run.submitted_for_approval', 'run.approved', 'run.rejected', 'run.queued',
    'run.dispatched', 'run.progress_stage_changed', 'run.completed', 'run.failed',
    'run.cancel_requested', 'run.cancelled', 'run.force_cancelled', 'run.stopped_by_guardrail',
    'run.transition_rejected',
    'worker.enrollment_token_created', 'worker.registered', 'worker.online', 'worker.offline',
    'worker.unauthorized_run_access',
    'guardrail.blocked', 'settings.updated',
    -- Sprint 2
    'repository.created', 'repository.updated', 'repository.approved',
    'repository.approval_revoked',
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
    'model.assisted_discovery', 'model.assisted_answer', 'model.output_rejected',
    -- Sprint 3.2
    'company_context.refresh_started', 'company_context.refresh_succeeded',
    'company_context.refresh_failed', 'company_context.loaded', 'company_context.cached_used',
    'company_context.validation_failed', 'company_context.bound_to_discovery',
    'company_context.bound_to_run', 'company_context.proposal_created',
    'company_context.proposal_status_changed'
));
