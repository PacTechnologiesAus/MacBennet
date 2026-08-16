-- Audit events written inside the same transaction all receive `now()`, which
-- in PostgreSQL is the transaction start time — so an approval and the queueing
-- that follows it in the same transaction were indistinguishable by timestamp,
-- and ordering fell back to a random UUID. The trail could not be replayed in
-- the order things actually happened.
--
-- Two changes fix that:
--   1. `seq` — a bigserial allocated at INSERT time, giving a total order that
--      matches insertion order even within a single transaction. This is now
--      the ordering key for every audit query.
--   2. `ts` now defaults to clock_timestamp() rather than now(), so events in
--      one transaction also carry distinct wall-clock times for a human reading
--      the trail. (`seq` remains the authoritative order; `ts` is for people.)

-- The immutability triggers are dropped and recreated around the column change
-- so the intent stays explicit rather than relying on which DDL happens to
-- bypass them.
DROP TRIGGER IF EXISTS audit_events_no_update_or_delete ON audit_events;
DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events;

ALTER TABLE audit_events ADD COLUMN seq bigserial NOT NULL;
ALTER TABLE audit_events ALTER COLUMN ts SET DEFAULT clock_timestamp();

CREATE UNIQUE INDEX audit_events_seq_key ON audit_events (seq);
CREATE INDEX audit_events_run_seq_idx ON audit_events (run_id, seq);

CREATE TRIGGER audit_events_no_update_or_delete
    BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

CREATE TRIGGER audit_events_no_truncate
    BEFORE TRUNCATE ON audit_events
    FOR EACH STATEMENT EXECUTE FUNCTION audit_events_no_truncate();
