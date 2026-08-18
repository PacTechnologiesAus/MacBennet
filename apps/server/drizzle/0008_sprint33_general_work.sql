-- Mac Bennett — Sprint 3.3: general (non-coding) task execution.
--
-- This migration exists because the implementation had narrowed to monday-backed
-- coding work while `Mac_Spec.md` §1 promises "general computer-based work". See
-- `docs/mac-spec-reconciliation.md`, drift findings D-1 through D-12.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--
-- It does not enable anything. Every new permission column is backfilled with
-- exactly what was ALREADY TRUE before this migration ran, and nothing more:
--
--   * `tasks.task_kind` defaults to 'coding', because in a system where the only
--     executable work was coding, that is an honest description of what every
--     existing row meant. Discovery re-classifies a task and records the change;
--     the migration does not guess on a human's behalf.
--
--   * `projects.allowed_task_kinds` is backfilled to ['coding'] ONLY for
--     projects that already had an approved repository — i.e. projects where
--     coding work was already possible. Every other project gets '[]', which
--     means "no kind of work has been allowed here yet".
--
--     `PAC Internal Development` therefore comes out of this migration with an
--     EMPTY allowlist, which is the correct and intended outcome: Sprint 3.3 §21
--     requires a human to explicitly approve it. A migration that helpfully
--     switched it on would be the migration that let a machine grant itself
--     permission.
--
--   * `projects.capabilities` is backfilled from resources that OBSERVABLY
--     exist. Declaring a capability a project has is a statement of fact, not a
--     grant of authority — the grant is `allowed_task_kinds`, above.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Tasks: what kind of work, and where it came from
-- ---------------------------------------------------------------------------

ALTER TABLE tasks ADD COLUMN task_kind text NOT NULL DEFAULT 'coding';
ALTER TABLE tasks ADD COLUMN origin    text NOT NULL DEFAULT 'direct';

ALTER TABLE tasks ADD CONSTRAINT tasks_task_kind_check CHECK (task_kind IN (
    'coding', 'research', 'analysis', 'investigation', 'scoping', 'documentation', 'administrative'
));
ALTER TABLE tasks ADD CONSTRAINT tasks_origin_check CHECK (origin IN ('direct', 'monday'));

-- Origin is a FACT about where the row came from, so it is derived rather than
-- defaulted: a task that mirrors a monday item did not originate in Mac's UI.
UPDATE tasks SET origin = 'monday' WHERE monday_item_id IS NOT NULL;

CREATE INDEX tasks_task_kind_idx ON tasks (task_kind);
CREATE INDEX tasks_origin_idx    ON tasks (origin);

-- ---------------------------------------------------------------------------
-- Tasks: the confidence rename (drift D-7)
-- ---------------------------------------------------------------------------
--
-- `tasks.confidence` was a number a human typed into the New Task form under a
-- label identical to the one Mac's DERIVED understanding confidence uses. It has
-- never gated execution — that reads `handoff_briefs.confidence` — but two
-- different things sharing one word is how the second one quietly becomes the
-- first.
--
-- Renamed rather than dropped: it has a legitimate separate meaning (how
-- well-specified the REQUESTER thinks the request is, which is useful signal
-- when reading a brief later), and dropping a column that three real rows carry
-- data in would destroy information for no gain.
--
-- A CHECK enforces the one rule that matters: this number may never be read as
-- an execution gate, so nothing may store a value here that looks like one
-- passing the floor by construction. That is a comment, not a constraint — what
-- the constraint below actually does is keep it in range.

ALTER TABLE tasks RENAME COLUMN confidence TO user_initial_confidence;
ALTER TABLE tasks ADD CONSTRAINT tasks_user_initial_confidence_range
    CHECK (user_initial_confidence IS NULL OR (user_initial_confidence >= 0 AND user_initial_confidence <= 1));

COMMENT ON COLUMN tasks.user_initial_confidence IS
    'The requester''s own rough sense of how well-specified this request is. NEVER an execution gate: '
    'Mac''s understanding confidence is derived through discovery and lives on handoff_briefs.confidence.';

-- ---------------------------------------------------------------------------
-- Projects: capabilities, and what they are allowed to be used for
-- ---------------------------------------------------------------------------

ALTER TABLE projects ADD COLUMN capabilities       jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE projects ADD COLUMN allowed_task_kinds jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Declared capabilities, from resources that observably exist right now.
UPDATE projects p SET capabilities = (
    SELECT COALESCE(jsonb_agg(c), '[]'::jsonb) FROM (
        SELECT 'repository'::text AS c
        WHERE EXISTS (SELECT 1 FROM repositories r WHERE r.project_id = p.id AND r.is_approved)
        UNION ALL
        SELECT 'monday_board'
        WHERE EXISTS (SELECT 1 FROM monday_boards b WHERE b.project_id = p.id AND b.is_approved)
        UNION ALL
        SELECT 'company_context'
    ) AS caps
);

-- Granted permissions, backfilled to exactly the status quo ante and no further.
UPDATE projects p SET allowed_task_kinds = '["coding"]'::jsonb
WHERE EXISTS (SELECT 1 FROM repositories r WHERE r.project_id = p.id AND r.is_approved);

-- ---------------------------------------------------------------------------
-- Artefacts: results that are not commits (drift D-10)
-- ---------------------------------------------------------------------------
--
-- One row per deliverable. `body` holds the document because a research report
-- is small, versionable-by-append, and pointless to store anywhere Mac's audit
-- trail cannot reach — the opposite of the Sprint 3.2 argument about company
-- documents, where the authoritative copy is a Git repository humans govern.
--
-- `run_id` is nullable so that a future day-mode artefact produced without a run
-- has somewhere to live. `task_id` is not: an artefact that belongs to no task
-- is an artefact nobody asked for.

CREATE TABLE run_artefacts (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id                      uuid        REFERENCES runs (id) ON DELETE SET NULL,
    task_id                     uuid        NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    project_id                  uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    artefact_type               text        NOT NULL,
    title                       text        NOT NULL,
    format                      text        NOT NULL DEFAULT 'markdown',
    summary                     text        NOT NULL DEFAULT '',
    body                        text        NOT NULL,
    -- [{statement, evidenceClass, confidence, sources[], reasoning}]
    findings                    jsonb       NOT NULL DEFAULT '[]'::jsonb,
    -- The PAC company context this was written under. Same immutability rule as
    -- runs and briefs: an artefact's provenance cannot be rewritten later.
    company_context_revision_id uuid        REFERENCES company_context_revisions (id) ON DELETE SET NULL,
    -- What producing it cost, where the provider reported it.
    model_provider              text,
    model_name                  text,
    input_tokens                integer,
    output_tokens               integer,
    created_by                  uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT run_artefacts_artefact_type_check CHECK (artefact_type IN (
        'investigation_report', 'engineering_brief', 'architecture_note', 'recommendation',
        'markdown_document', 'structured_data', 'diagram_description', 'task_proposal'
    )),
    CONSTRAINT run_artefacts_format_check CHECK (format IN ('markdown', 'json')),
    CONSTRAINT run_artefacts_body_not_empty CHECK (length(body) > 0)
);

CREATE INDEX run_artefacts_run_idx     ON run_artefacts (run_id);
CREATE INDEX run_artefacts_task_idx    ON run_artefacts (task_id);
CREATE INDEX run_artefacts_project_idx ON run_artefacts (project_id);
CREATE INDEX run_artefacts_created_idx ON run_artefacts (created_at DESC);

-- An artefact's company-context binding is immutable once set, for the same
-- reason a run's is (Sprint 3.2 §8.2): the provenance line on a document a human
-- read last week must still say what it said then.
CREATE OR REPLACE FUNCTION run_artefacts_freeze_context() RETURNS trigger AS $$
BEGIN
    IF OLD.company_context_revision_id IS NOT NULL
       AND NEW.company_context_revision_id IS DISTINCT FROM OLD.company_context_revision_id THEN
        RAISE EXCEPTION 'run_artefacts.company_context_revision_id is immutable once set (artefact %)', OLD.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER run_artefacts_freeze_context_trg
    BEFORE UPDATE ON run_artefacts
    FOR EACH ROW EXECUTE FUNCTION run_artefacts_freeze_context();

-- ---------------------------------------------------------------------------
-- General run state: the research loop's plan and accumulated evidence
-- ---------------------------------------------------------------------------
--
-- A 1:1 extension of `runs` rather than columns on `runs`, so a coding run does
-- not carry six always-null jsonb columns and the dispatch query — the hottest
-- path in the system — does not widen.
--
-- Sprint 3.3 §13: no second run table and no second scheduler. This is neither;
-- it is the state ONE run of one kind accumulates between its steps.

CREATE TABLE general_run_state (
    run_id           uuid PRIMARY KEY REFERENCES runs (id) ON DELETE CASCADE,
    task_kind        text        NOT NULL,
    -- Built server-side from the handoff brief before the first model call. The
    -- model is GIVEN the plan; it does not write it (§18: the brief is the
    -- execution contract, and a model that could rewrite its own objective
    -- would not be executing one).
    plan             jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- {stepsTaken, toolCallsMade, sources[], findings[], unknowns[], toolResults[]}
    state            jsonb       NOT NULL DEFAULT '{}'::jsonb,
    stage            text        NOT NULL DEFAULT 'planning',
    steps_taken      integer     NOT NULL DEFAULT 0,
    tool_calls_made  integer     NOT NULL DEFAULT 0,
    model_provider   text,
    model_name       text,
    input_tokens     integer     NOT NULL DEFAULT 0,
    output_tokens    integer     NOT NULL DEFAULT 0,
    started_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT general_run_state_task_kind_check CHECK (task_kind IN (
        'research', 'analysis', 'investigation', 'scoping', 'documentation', 'administrative'
    )),
    CONSTRAINT general_run_state_stage_check CHECK (stage IN (
        'planning', 'gathering', 'synthesising', 'writing', 'complete'
    ))
);

-- ---------------------------------------------------------------------------
-- Enum CHECK constraints
-- ---------------------------------------------------------------------------

ALTER TABLE runs DROP CONSTRAINT runs_job_kind_check;
ALTER TABLE runs ADD CONSTRAINT runs_job_kind_check CHECK (job_kind IN (
    'noop', 'echo', 'sleep', 'system_info', 'workspace_check', 'fail',
    'claude_code', 'repo_inspect',
    -- Sprint 3.3
    'general_task'
));

ALTER TABLE runs DROP CONSTRAINT runs_stop_reason_check;
ALTER TABLE runs ADD CONSTRAINT runs_stop_reason_check CHECK (stop_reason IN (
    'completed', 'failed', 'cancelled_by_user', 'force_cancelled_worker_unreachable',
    'overnight_cutoff', 'budget_exhausted', 'confidence_below_threshold',
    'unsupported_job_kind', 'worker_error',
    'prohibited_git_operation', 'coding_agent_error', 'blocked_unsafe_decision',
    'repository_not_approved', 'agent_time_limit', 'completed_with_blockers',
    'sandbox_unavailable', 'usage_threshold_reached', 'night_shift_ended',
    -- Sprint 3.3
    'model_provider_required', 'no_capable_worker', 'research_limit_reached',
    'task_kind_not_permitted'
));

ALTER TABLE night_shifts DROP CONSTRAINT night_shifts_stop_reason_check;
ALTER TABLE night_shifts ADD CONSTRAINT night_shifts_stop_reason_check CHECK (stop_reason IS NULL OR stop_reason IN (
    'cutoff_reached', 'budget_exhausted', 'usage_threshold', 'no_eligible_work',
    'guardrail_stop', 'stopped_by_user', 'worker_unavailable', 'sandbox_unavailable',
    -- Sprint 3.3
    'model_provider_required'
));

ALTER TABLE audit_events DROP CONSTRAINT audit_events_event_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_event_type_check CHECK (event_type IN (
    -- Sprint 1
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
    -- Sprint 2
    'repository.created', 'repository.updated', 'repository.approved',
    'repository.approval_revoked',
    'discovery.started', 'discovery.context_inspected', 'discovery.message_recorded',
    'discovery.question_asked', 'discovery.question_answered',
    'brief.created', 'brief.updated', 'brief.confidence_calculated',
    'worktree.created', 'worktree.preserved', 'worktree.removed', 'git.operation_rejected',
    'coding_session.started', 'coding_session.question', 'coding_session.answered',
    'coding_session.assumption_recorded', 'coding_session.blocked',
    'coding_session.activity', 'coding_session.completed', 'coding_session.failed',
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
    'company_context.proposal_status_changed',
    -- Sprint 3.3
    'project.capabilities_updated', 'task.kind_changed', 'task.discovery_requested',
    'research.plan_built', 'research.step_completed', 'research.tool_called',
    'research.tool_refused', 'research.external_source_retrieved', 'research.limit_reached',
    'artefact.created',
    'model.reasoning_completed', 'model.provider_required'
));

-- Investigation subjects: discovery may now investigate a completeness dimension
-- for a NON-coding task, which is the same subject kind. No change needed there —
-- but discovery investigations gain a nullable link to the brief they informed,
-- so "which question did this receipt belong to" is answerable without joining
-- through the session's message array.
ALTER TABLE discovery_investigations ADD COLUMN brief_id uuid REFERENCES handoff_briefs (id) ON DELETE SET NULL;
CREATE INDEX discovery_investigations_brief_idx ON discovery_investigations (brief_id);

-- ---------------------------------------------------------------------------
-- Settings: the reasoning provider, and external research
-- ---------------------------------------------------------------------------

ALTER TABLE settings ADD COLUMN general_work_enabled     boolean NOT NULL DEFAULT true;
ALTER TABLE settings ADD COLUMN max_research_steps       integer NOT NULL DEFAULT 8;
ALTER TABLE settings ADD COLUMN max_research_tool_calls  integer NOT NULL DEFAULT 40;
-- Off by default. External research leaves PAC's systems, and a capability that
-- reaches the internet should be switched on deliberately rather than inherited.
ALTER TABLE settings ADD COLUMN external_research_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE settings ADD COLUMN allowed_research_domains  jsonb   NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_model_provider_check;
ALTER TABLE settings ADD CONSTRAINT settings_model_provider_check
    CHECK (model_provider IN ('anthropic', 'openai', 'scripted', 'none'));

ALTER TABLE settings ADD CONSTRAINT settings_research_limits_check
    CHECK (max_research_steps BETWEEN 1 AND 12 AND max_research_tool_calls BETWEEN 1 AND 200);
