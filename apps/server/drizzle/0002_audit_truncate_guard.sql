-- Row-level BEFORE DELETE triggers do not fire for TRUNCATE, so the
-- immutability guarantee added in 0001 had a hole: `TRUNCATE audit_events`
-- would have silently erased the entire audit trail. Close it with a
-- statement-level trigger.
--
-- Consequence for tests: the integration suite cannot truncate audit_events
-- between cases and instead deletes the trigger's parent rows... which it also
-- cannot do. Tests therefore scope their audit assertions by run/project id
-- rather than assuming an empty table — which is closer to how the table will
-- behave in production anyway.

CREATE OR REPLACE FUNCTION audit_events_no_truncate() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only: TRUNCATE is not permitted'
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_truncate
    BEFORE TRUNCATE ON audit_events
    FOR EACH STATEMENT EXECUTE FUNCTION audit_events_no_truncate();
