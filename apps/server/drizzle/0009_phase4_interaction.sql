-- Mac Bennett — Phase 4: human interaction, Forja orchestration, acceptance
-- verification and controlled external web research.
--
-- Governing document: `Mac_Spec.md`. Design: `docs/phase-4-design.md`.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES NOT DO
--
-- It does not switch anything on. Teams, Forja and external web search all
-- reach outside this process, and every one of them arrives OFF — exactly as
-- monday.com, mail, company context and external research did before them. A
-- deployment that runs this migration and changes nothing else behaves
-- precisely as it did the day before.
--
-- It does not change how any existing run completes. `runs.acceptance_state`
-- is backfilled to 'not_assessed' for every row that exists, and a run with no
-- acceptance criteria stays 'not_assessed' forever — which is every coding run
-- ever executed. Acceptance verification adds a check where a contract exists
-- to check against; it does not invent one where there is none.
--
-- It does not destroy anything. No column is dropped, no table is dropped, and
-- the only UPDATE statements set new columns on rows that had no value.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- 1. Run status: `completed_with_gaps`
-- ===========================================================================
--
-- Commissioning §13.3 recorded a run that produced one artefact where the task
-- description named five, and reported `completed`. Nothing malfunctioned — the
-- brief had narrowed the request at discovery and the run followed the brief.
-- What was missing was any way for the system to notice, and any word for the
-- result once it had.
--
-- A run that delivered SOMETHING but not everything its approved criteria
-- required is now `completed_with_gaps`. Terminal, like `completed`.

ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check CHECK (status IN (
    'draft', 'discovery', 'ready_for_approval', 'approved', 'queued', 'running',
    'blocked', 'self_review', 'ready_for_human_review', 'completed',
    'completed_with_gaps', 'stopped_by_guardrail', 'cancelled', 'failed'
));

ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_stop_reason_check;
ALTER TABLE runs ADD CONSTRAINT runs_stop_reason_check CHECK (stop_reason IS NULL OR stop_reason IN (
    'completed', 'failed', 'cancelled_by_user', 'force_cancelled_worker_unreachable',
    'overnight_cutoff', 'budget_exhausted', 'confidence_below_threshold',
    'unsupported_job_kind', 'worker_error',
    'prohibited_git_operation', 'coding_agent_error', 'blocked_unsafe_decision',
    'repository_not_approved', 'agent_time_limit', 'completed_with_blockers',
    'sandbox_unavailable', 'usage_threshold_reached', 'night_shift_ended',
    'model_provider_required', 'no_capable_worker', 'research_limit_reached',
    'task_kind_not_permitted',
    'acceptance_gaps'
));


-- ===========================================================================
-- 2. Conversations
-- ===========================================================================
--
-- A conversation belongs to MAC, not to a channel. Teams, the web UI, Forja and
-- (later) voice attach to the same thread.
--
-- The alternative — a Teams message store separate from whatever the web UI
-- reads — is the "separate memory universes" the phase brief forbids, and it
-- fails the first time somebody discusses a task in Teams and opens it in the
-- UI expecting Mac to know what they said.

CREATE TABLE conversations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Where the thread STARTED. Individual messages carry their own channel,
    -- because a conversation begun in Teams and continued in the web UI is one
    -- conversation and must not be forced to pick.
    channel     text        NOT NULL DEFAULT 'web',
    status      text        NOT NULL DEFAULT 'open',
    title       text        NOT NULL DEFAULT '',
    project_id  uuid        REFERENCES projects (id) ON DELETE SET NULL,
    task_id     uuid        REFERENCES tasks (id) ON DELETE SET NULL,
    -- The channel's own thread identifier: a Teams conversation id, a Forja
    -- thread. Unique per channel so a redelivered webhook finds the thread it
    -- already created rather than starting a second one.
    external_ref text,
    -- The Bot Connector endpoint a reply must be sent to, captured from a
    -- JWT-VERIFIED activity and never from a request body. See the note on
    -- `serviceUrl` in packages/protocol/src/teams.ts: a serviceUrl an attacker
    -- supplies is an instruction to post Mac's bearer token to their host.
    service_url text,
    tenant_id   text,
    -- The PAC company context this conversation's answers were grounded in.
    -- Immutable once set, like runs and briefs.
    company_context_revision_id uuid REFERENCES company_context_revisions (id) ON DELETE SET NULL,
    last_message_at timestamptz,
    message_count   integer     NOT NULL DEFAULT 0,
    created_by  uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT conversations_channel_check CHECK (channel IN (
        'web', 'teams', 'forja', 'voice', 'email', 'system'
    )),
    CONSTRAINT conversations_status_check CHECK (status IN ('open', 'archived'))
);

CREATE UNIQUE INDEX conversations_external_ref_key ON conversations (channel, external_ref)
    WHERE external_ref IS NOT NULL;
CREATE INDEX conversations_task_idx    ON conversations (task_id);
CREATE INDEX conversations_project_idx ON conversations (project_id);
CREATE INDEX conversations_recent_idx  ON conversations (last_message_at DESC NULLS LAST);

CREATE TRIGGER conversations_company_context_pin
    BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION company_context_binding_is_immutable();


CREATE TABLE conversation_participants (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid        NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    kind            text        NOT NULL,
    user_id         uuid        REFERENCES users (id) ON DELETE SET NULL,
    -- The channel's identifier for this person: an AAD object id, a Forja client
    -- principal. Stored so a Teams user who has never logged into Mac's web UI
    -- is still a recognisable participant rather than an anonymous string.
    external_id     text,
    display_name    text        NOT NULL DEFAULT '',
    first_seen_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT conversation_participants_kind_check CHECK (kind IN ('human', 'mac', 'system'))
);

CREATE UNIQUE INDEX conversation_participants_unique
    ON conversation_participants (conversation_id, COALESCE(user_id::text, external_id, display_name));
CREATE INDEX conversation_participants_conversation_idx ON conversation_participants (conversation_id);


CREATE TABLE conversation_messages (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid        NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    -- Monotonic WITHIN the conversation. Summaries cite ranges of it, which a
    -- timestamp cannot do reliably: two messages in the same millisecond have
    -- no order, and a summary that says "covers up to 10:04:33" is ambiguous
    -- about the message that arrived in the same tick.
    seq             integer     NOT NULL,
    direction       text        NOT NULL,
    channel         text        NOT NULL,
    author_kind     text        NOT NULL,
    author_user_id  uuid        REFERENCES users (id) ON DELETE SET NULL,
    author_name     text        NOT NULL DEFAULT '',
    body            text        NOT NULL,
    -- Null on outbound: Mac does not classify his own intent.
    intent            text,
    intent_confidence numeric(4,3),
    outbound_kind     text,
    delivery_state    text      NOT NULL DEFAULT 'not_required',
    delivery_attempts integer   NOT NULL DEFAULT 0,
    delivery_error    text,
    provider_message_id text,
    -- The channel's own message id. THE idempotency key: Teams retries, and a
    -- redelivered activity must record once and act once.
    external_message_id text,
    in_reply_to_message_id uuid REFERENCES conversation_messages (id) ON DELETE SET NULL,
    approval_request_id    uuid,
    -- {artefactIds[], runIds[], briefIds[], sourceRefs[]} — what Mac used to
    -- compose this, so a reader can check an answer rather than take his word.
    evidence        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT conversation_messages_direction_check CHECK (direction IN ('inbound', 'outbound')),
    CONSTRAINT conversation_messages_channel_check CHECK (channel IN (
        'web', 'teams', 'forja', 'voice', 'email', 'system'
    )),
    CONSTRAINT conversation_messages_author_kind_check CHECK (author_kind IN ('human', 'mac', 'system')),
    CONSTRAINT conversation_messages_intent_check CHECK (intent IS NULL OR intent IN (
        'conversation', 'question', 'instruction', 'task_assignment', 'approval_response',
        'answer', 'correction', 'project_context', 'status_request'
    )),
    CONSTRAINT conversation_messages_outbound_kind_check CHECK (outbound_kind IS NULL OR outbound_kind IN (
        'reply', 'question', 'blocker', 'approval_request', 'status', 'report', 'notice'
    )),
    CONSTRAINT conversation_messages_delivery_state_check CHECK (delivery_state IN (
        'not_required', 'pending', 'sent', 'failed', 'dead'
    ))
);

CREATE UNIQUE INDEX conversation_messages_seq_key ON conversation_messages (conversation_id, seq);
-- The webhook idempotency guarantee, in the database rather than in a handler:
-- a duplicate activity cannot be recorded twice even if two requests race.
CREATE UNIQUE INDEX conversation_messages_external_key
    ON conversation_messages (channel, external_message_id)
    WHERE external_message_id IS NOT NULL;
CREATE INDEX conversation_messages_conversation_idx ON conversation_messages (conversation_id, seq);
-- Supports the delivery sweeper without scanning every message ever sent.
CREATE INDEX conversation_messages_pending_idx ON conversation_messages (delivery_state, created_at)
    WHERE delivery_state IN ('pending', 'failed');


CREATE TABLE conversation_summaries (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid        NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    -- Inclusive range. The source messages are NOT deleted, edited or replaced:
    -- a summary that overwrote its own evidence would be the one artefact in
    -- this system nobody could check.
    covers_from_seq integer     NOT NULL,
    covers_to_seq   integer     NOT NULL,
    -- {narrative, decisions[], approvals[], projectFacts[], unresolvedQuestions[],
    --  assumptions[], commitments[], corrections[]}
    content         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    model_provider  text,
    model_name      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT conversation_summaries_range_check CHECK (covers_to_seq >= covers_from_seq)
);

CREATE INDEX conversation_summaries_conversation_idx
    ON conversation_summaries (conversation_id, covers_to_seq DESC);


-- Discovery gains a LINK to a conversation. Deliberately a link and not a
-- merge: rewriting discovery to sit on top of conversations would put the
-- working half of Sprints 2 and 3.3 at risk for a tidiness nobody asked for.
ALTER TABLE discovery_sessions ADD COLUMN conversation_id uuid
    REFERENCES conversations (id) ON DELETE SET NULL;
CREATE INDEX discovery_sessions_conversation_idx ON discovery_sessions (conversation_id);


-- ===========================================================================
-- 3. Approval requests
-- ===========================================================================
--
-- Not a second approval system. `approvals` remains the record of an
-- authorisation against a run. This is the REQUEST that precedes it — the thing
-- Mac sends, a human answers, and which then routes into the existing
-- `approveRun` path with the existing confidence floor and threshold rules.
--
-- It exists as a row because of the binding problem: "sounds good" must not
-- approve the wrong action, and you cannot enforce that without an addressable
-- object carrying an identity a human can quote back.

CREATE TABLE approval_requests (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The human-quotable code, e.g. 'AP-4F2K'. Short because somebody has to
    -- type it on a phone; non-sequential because AP-7 and AP-8 are one keystroke
    -- apart and the entire point of this object is that approving the wrong
    -- thing should be hard.
    code            text        NOT NULL,
    state           text        NOT NULL DEFAULT 'pending',
    subject_kind    text        NOT NULL,
    -- A brief at version 3 and a brief at version 4 are different contracts.
    -- Approving a stale card must not authorise work nobody read, which is what
    -- `superseded` and this column exist for together.
    subject_version integer     NOT NULL DEFAULT 0,
    project_id      uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    task_id         uuid        NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    run_id          uuid        REFERENCES runs (id) ON DELETE CASCADE,
    brief_id        uuid        REFERENCES handoff_briefs (id) ON DELETE SET NULL,
    title           text        NOT NULL,
    detail          text        NOT NULL DEFAULT '',
    recommendation  text        NOT NULL DEFAULT '',
    risk            text        NOT NULL DEFAULT 'medium',
    authority       text        NOT NULL DEFAULT 'execute_run',
    confidence      numeric(4,3),
    requested_at    timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz,
    delivered_channels jsonb    NOT NULL DEFAULT '[]'::jsonb,
    decided_at      timestamptz,
    decided_by_user_id uuid     REFERENCES users (id) ON DELETE SET NULL,
    decided_via_channel text,
    decided_via_message_id uuid REFERENCES conversation_messages (id) ON DELETE SET NULL,
    decision_notes  text,
    superseded_by_request_id uuid REFERENCES approval_requests (id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT approval_requests_state_check CHECK (state IN (
        'pending', 'approved', 'rejected', 'expired', 'superseded', 'cancelled'
    )),
    CONSTRAINT approval_requests_subject_kind_check CHECK (subject_kind IN ('run', 'brief', 'action')),
    CONSTRAINT approval_requests_risk_check CHECK (risk IN ('low', 'medium', 'high')),
    CONSTRAINT approval_requests_authority_check CHECK (authority IN (
        'execute_run', 'accept_brief', 'expand_scope', 'proceed_on_assumption', 'open_pull_request',
        'merge_protected_branch', 'deploy_live_system', 'spend_money', 'external_commitment',
        'destructive_action', 'change_access_control', 'release_pac_ip'
    ))
);

-- Codes are unique among PENDING requests only.
--
-- A four-character code has ~1M values, which is ample for the handful ever
-- outstanding at once and would eventually collide across years of history. It
-- is an addressing scheme for open questions, not a permanent identifier — the
-- uuid is that.
CREATE UNIQUE INDEX approval_requests_code_pending_key ON approval_requests (code)
    WHERE state = 'pending';
CREATE INDEX approval_requests_task_idx    ON approval_requests (task_id);
CREATE INDEX approval_requests_run_idx     ON approval_requests (run_id);
CREATE INDEX approval_requests_pending_idx ON approval_requests (state, requested_at DESC);

ALTER TABLE conversation_messages ADD CONSTRAINT conversation_messages_approval_fk
    FOREIGN KEY (approval_request_id) REFERENCES approval_requests (id) ON DELETE SET NULL;


-- ===========================================================================
-- 4. Forja: clients and events
-- ===========================================================================
--
-- Forja is an APPLICATION, not an agent. It is never registered in the agent
-- registry, and an approval arriving through it records the human it came from
-- rather than "Forja" — which is why every write in the contract carries
-- `onBehalfOf`.

CREATE TABLE forja_clients (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text        NOT NULL,
    -- Only the SHA-256 of the key is stored, so a database dump yields no usable
    -- credential. Same shape as worker tokens and session tokens.
    key_hash    text        NOT NULL,
    key_prefix  text        NOT NULL,
    scopes      jsonb       NOT NULL DEFAULT '[]'::jsonb,
    is_active   boolean     NOT NULL DEFAULT true,
    webhook_url text,
    -- HMAC secret for signed webhook delivery. Separate from the API key: one
    -- authenticates Forja to Mac, the other authenticates Mac to Forja, and a
    -- single shared secret doing both jobs cannot be rotated independently.
    webhook_secret text,
    last_seen_at timestamptz,
    created_by  uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    revoked_at  timestamptz
);

CREATE UNIQUE INDEX forja_clients_key_hash_key ON forja_clients (key_hash);


-- The event log. Append-only, with the same trigger discipline as audit_events:
-- an event stream a consumer can be caught up on is only useful if nothing
-- rewrites history behind them.
CREATE TABLE mac_events (
    seq         bigserial PRIMARY KEY,
    type        text        NOT NULL,
    at          timestamptz NOT NULL DEFAULT now(),
    project_id  uuid,
    task_id     uuid,
    run_id      uuid,
    conversation_id uuid,
    approval_request_id uuid,
    artefact_id uuid,
    -- Small and stable. Deliberately NOT "the whole DTO of whatever changed":
    -- an event says THAT something happened and gives identifiers to go and read
    -- it, so a DTO change is not a contract change.
    data        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT mac_events_type_check CHECK (type IN (
        'task_created', 'discovery_started', 'question_required', 'brief_ready',
        'approval_required', 'approval_decided', 'run_started', 'blocker_raised',
        'artefact_created', 'task_ready_for_review', 'run_completed',
        'night_report_ready', 'conversation_message'
    ))
);

CREATE INDEX mac_events_type_idx ON mac_events (type, seq);
CREATE INDEX mac_events_task_idx ON mac_events (task_id) WHERE task_id IS NOT NULL;

CREATE OR REPLACE FUNCTION mac_events_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'mac_events is append-only (attempted % on seq %)', TG_OP, OLD.seq;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER mac_events_no_update_or_delete
    BEFORE UPDATE OR DELETE ON mac_events
    FOR EACH ROW EXECUTE FUNCTION mac_events_immutable();


-- Webhook delivery, with the outbox discipline the mail path already proves.
CREATE TABLE event_deliveries (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id   uuid        NOT NULL REFERENCES forja_clients (id) ON DELETE CASCADE,
    event_seq   bigint      NOT NULL,
    status      text        NOT NULL DEFAULT 'pending',
    attempts    integer     NOT NULL DEFAULT 0,
    last_error  text,
    delivered_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT event_deliveries_status_check CHECK (status IN ('pending', 'sent', 'failed', 'dead'))
);

-- One delivery per client per event, enforced in the database rather than by a
-- handler remembering. Sprint 3.1 defect 24 was concurrent sweepers
-- double-sending mail; this is the same guard applied before the same bug.
CREATE UNIQUE INDEX event_deliveries_unique ON event_deliveries (client_id, event_seq);
CREATE INDEX event_deliveries_pending_idx ON event_deliveries (status, created_at)
    WHERE status IN ('pending', 'failed');


-- ===========================================================================
-- 5. Research provenance
-- ===========================================================================
--
-- Sources move out of the run-state JSON blob and into a table, for one
-- concrete reason: Part F §23 requires that a run which used no external
-- sources cannot be marked fully complete when its brief asked for external
-- research. That is a question a SQL predicate should be able to answer, and it
-- cannot answer it about a JSON document.

CREATE TABLE research_sources (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id      uuid        NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    task_id     uuid        NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    -- The query that found it, so a search is inspectable after the fact rather
    -- than only while it is happening.
    query       text        NOT NULL DEFAULT '',
    tool        text        NOT NULL,
    ref         text        NOT NULL,
    url         text,
    title       text        NOT NULL DEFAULT '',
    source_class text       NOT NULL DEFAULT 'unknown',
    external    boolean     NOT NULL DEFAULT false,
    -- Bounded. A whole page is deliberately not kept: §17 asks for enough
    -- provenance to support a conclusion, not for a web archive.
    excerpt     text        NOT NULL DEFAULT '',
    published_at text,
    retrieved_at timestamptz NOT NULL DEFAULT now(),
    -- Set when the injection scanner matched. Recorded rather than acted on:
    -- a page that DISCUSSES prompt injection is not an attack, and silently
    -- dropping evidence would lose more than it protects.
    injection_suspected boolean NOT NULL DEFAULT false,
    injection_detail    text,
    CONSTRAINT research_sources_source_class_check CHECK (source_class IN (
        'official_vendor_docs', 'standards_body', 'government', 'industry_publication',
        'company_website', 'secondary_reporting', 'forum_community', 'unknown'
    ))
);

CREATE UNIQUE INDEX research_sources_run_ref_key ON research_sources (run_id, ref);
CREATE INDEX research_sources_run_idx      ON research_sources (run_id);
CREATE INDEX research_sources_task_idx     ON research_sources (task_id);
-- The index that makes "did this run use any external source?" cheap, which is
-- the check §23 is about.
CREATE INDEX research_sources_external_idx ON research_sources (run_id, external);


-- ===========================================================================
-- 6. Acceptance verification
-- ===========================================================================

-- The machine-checkable criteria, alongside the free-text ones the brief
-- already had. The free-text list is NOT replaced: it is what a human reads,
-- and reducing it to a checklist would lose the requirements that cannot be
-- expressed as one.
ALTER TABLE handoff_briefs ADD COLUMN acceptance jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Denormalised onto the run so lists, filters and the morning report can show
-- the acceptance position without joining. Backfilled to 'not_assessed', which
-- is what every run that already exists genuinely is.
ALTER TABLE runs ADD COLUMN acceptance_state text NOT NULL DEFAULT 'not_assessed';
ALTER TABLE runs ADD CONSTRAINT runs_acceptance_state_check CHECK (acceptance_state IN (
    'not_assessed', 'satisfied', 'gaps', 'failed'
));

CREATE TABLE run_acceptance (
    run_id      uuid PRIMARY KEY REFERENCES runs (id) ON DELETE CASCADE,
    state       text        NOT NULL DEFAULT 'not_assessed',
    -- The criteria as FROZEN AT APPROVAL, not as the brief says now. What is
    -- checked has to be what somebody authorised; a brief edited after approval
    -- must not silently change the bar.
    criteria    jsonb       NOT NULL DEFAULT '[]'::jsonb,
    -- [{criterionId, kind, verdict, method, observed, reasoning}]
    results     jsonb       NOT NULL DEFAULT '[]'::jsonb,
    artefacts_produced integer NOT NULL DEFAULT 0,
    external_sources_used integer NOT NULL DEFAULT 0,
    remediation_attempted boolean NOT NULL DEFAULT false,
    remediation_note text,
    model_assisted boolean  NOT NULL DEFAULT false,
    model_provider text,
    model_name     text,
    reviewed_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT run_acceptance_state_check CHECK (state IN ('not_assessed', 'satisfied', 'gaps', 'failed'))
);


-- ===========================================================================
-- 7. Settings
-- ===========================================================================
--
-- Every integration below is OFF. That is the standing posture for anything
-- reaching outside this process, and Phase 4 adds three such things at once.

-- Teams
ALTER TABLE settings ADD COLUMN teams_enabled boolean NOT NULL DEFAULT false;
-- Teams users who may assign work and approve, by AAD object id or UPN. Empty
-- means nobody: an unknown Teams sender can talk to Mac and read status, and
-- cannot create work or authorise anything.
ALTER TABLE settings ADD COLUMN teams_authorised_users jsonb NOT NULL DEFAULT '[]'::jsonb;
-- Proactive notification is opt-in per class, and routine progress is not in
-- the list at all. Part G §27: Teams must not become a stream of progress chatter.
ALTER TABLE settings ADD COLUMN teams_notify_blockers  boolean NOT NULL DEFAULT true;
ALTER TABLE settings ADD COLUMN teams_notify_approvals boolean NOT NULL DEFAULT true;
ALTER TABLE settings ADD COLUMN teams_notify_reports   boolean NOT NULL DEFAULT false;

-- Forja
ALTER TABLE settings ADD COLUMN forja_enabled boolean NOT NULL DEFAULT false;

-- External web search
ALTER TABLE settings ADD COLUMN web_search_provider text NOT NULL DEFAULT 'none';
ALTER TABLE settings ADD CONSTRAINT settings_web_search_provider_check
    CHECK (web_search_provider IN ('none', 'brave', 'google_cse', 'searxng'));
ALTER TABLE settings ADD COLUMN max_web_results_per_search integer NOT NULL DEFAULT 8;
ALTER TABLE settings ADD CONSTRAINT settings_web_results_check
    CHECK (max_web_results_per_search BETWEEN 1 AND 25);
-- Whether a search result's own host may be fetched without being on the
-- research-domain allowlist. OFF: a search provider choosing what Mac may
-- retrieve would make the allowlist decorative.
ALTER TABLE settings ADD COLUMN allow_fetch_from_search_results boolean NOT NULL DEFAULT false;

-- Acceptance verification
ALTER TABLE settings ADD COLUMN acceptance_verification_enabled boolean NOT NULL DEFAULT true;
-- Model-assisted semantic criteria are separately switchable, because they cost
-- money and a deployment may reasonably want deterministic checks only.
ALTER TABLE settings ADD COLUMN acceptance_semantic_review_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE settings ADD COLUMN acceptance_remediation_enabled boolean NOT NULL DEFAULT true;

-- Conversations
ALTER TABLE settings ADD COLUMN conversation_summary_threshold integer NOT NULL DEFAULT 24;
ALTER TABLE settings ADD CONSTRAINT settings_conversation_summary_threshold_check
    CHECK (conversation_summary_threshold BETWEEN 4 AND 500);


-- ===========================================================================
-- 8. Audit events
-- ===========================================================================
--
-- Restated in full rather than appended to, because the constraint has to name
-- every permitted value and a partial list would reject everything else.

ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_event_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_event_type_check CHECK (event_type IN (
    'auth.login', 'auth.login_failed', 'auth.logout',
    'project.created', 'project.updated', 'task.created',
    'task.updated', 'run.created', 'run.submitted_for_approval',
    'run.approved', 'run.rejected', 'run.queued',
    'run.dispatched', 'run.progress_stage_changed', 'run.completed',
    'run.failed', 'run.cancel_requested', 'run.cancelled',
    'run.force_cancelled', 'run.stopped_by_guardrail', 'run.transition_rejected',
    'worker.enrollment_token_created', 'worker.registered', 'worker.online',
    'worker.offline', 'worker.unauthorized_run_access', 'guardrail.blocked',
    'settings.updated', 'repository.created', 'repository.updated',
    'repository.approved', 'repository.approval_revoked', 'discovery.started',
    'discovery.context_inspected', 'discovery.message_recorded', 'discovery.question_asked',
    'discovery.question_answered', 'brief.created', 'brief.updated',
    'brief.confidence_calculated', 'worktree.created', 'worktree.preserved',
    'worktree.removed', 'git.operation_rejected', 'coding_session.started',
    'coding_session.question', 'coding_session.answered', 'coding_session.assumption_recorded',
    'coding_session.blocked', 'coding_session.activity', 'coding_session.completed',
    'coding_session.failed', 'test.run', 'test.failed',
    'run.self_review', 'run.review_completed', 'pull_request.created',
    'pull_request.declined', 'usage.snapshot', 'report.generated',
    'memory.recorded', 'memory.promoted', 'sandbox.created',
    'sandbox.refused', 'sandbox.attested', 'worker.token_rotation_requested',
    'worker.token_rotated', 'worker.token_revoked', 'worker.token_rejected',
    'monday.board_mapped', 'monday.board_approved', 'monday.board_approval_revoked',
    'monday.read', 'monday.item_linked', 'monday.assigned',
    'monday.status_changed', 'monday.update_posted', 'monday.blocker_posted',
    'monday.pull_request_attached', 'monday.write_refused', 'monday.write_failed',
    'night_shift.started', 'night_shift.ended', 'night_shift.task_selected',
    'night_shift.task_skipped', 'night_shift.scheduling_decision', 'night_shift.task_switched',
    'night_shift.blocker_recorded', 'night_shift.idle', 'run.auto_approved',
    'project.night_shift_approved', 'project.night_shift_approval_revoked', 'discovery.investigation_completed',
    'discovery.escalated_to_human', 'report.email_attempted', 'report.email_delivered',
    'report.email_failed', 'report.email_recipient_refused', 'model.assisted_discovery',
    'model.assisted_answer', 'model.output_rejected', 'company_context.refresh_started',
    'company_context.refresh_succeeded', 'company_context.refresh_failed', 'company_context.loaded',
    'company_context.cached_used', 'company_context.validation_failed', 'company_context.bound_to_discovery',
    'company_context.bound_to_run', 'company_context.proposal_created', 'company_context.proposal_status_changed',
    'project.capabilities_updated', 'task.kind_changed', 'task.discovery_requested',
    'research.plan_built', 'research.step_completed', 'research.tool_called',
    'research.tool_refused', 'research.external_source_retrieved', 'research.limit_reached',
    'artefact.created', 'model.reasoning_completed', 'model.provider_required',
    'conversation.started', 'conversation.message_received', 'conversation.message_sent',
    'conversation.message_duplicate_ignored', 'conversation.linked_to_task', 'conversation.summarised',
    'conversation.intent_classified', 'teams.activity_received', 'teams.activity_rejected',
    'teams.message_sent', 'teams.delivery_failed', 'teams.task_created_from_message',
    'approval_request.created', 'approval_request.delivered', 'approval_request.decided',
    'approval_request.ambiguous_reply_refused', 'approval_request.superseded', 'approval_request.expired',
    'approval_request.authority_refused', 'blocker.notified', 'notification.suppressed',
    'forja.client_created', 'forja.client_revoked', 'forja.request',
    'forja.unauthorized', 'forja.webhook_delivered', 'forja.webhook_failed',
    'research.web_search', 'research.web_search_failed', 'research.injection_suspected',
    'acceptance.criteria_derived', 'acceptance.reviewed', 'acceptance.gap_recorded',
    'acceptance.remediation_attempted', 'status.query_answered'
));
