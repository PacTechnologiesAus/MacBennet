-- Sprint 2 replaced `run_usage.is_exact` — a boolean — with `source`, which has
-- four values (exact | observed | estimated | unavailable). Both columns are
-- retained so that no Sprint 1 query silently changed meaning.
--
-- Retaining both creates a hazard: a row could be written with is_exact = true
-- and source = 'estimated', and the budget guardrail (which reads `source`,
-- because only exact money is enforceable) would quietly ignore real spend.
-- That is precisely the class of silent accounting failure the usage model
-- exists to prevent, so the two are made structurally unable to disagree rather
-- than relying on every insert site to remember.
--
-- Sprint 1's style throughout is to put a guardrail in SQL where SQL can hold
-- it, for the same reason the approval check lives in the dispatch predicate.

-- Any row written between migration 0004 and this one where the two disagree is
-- resolved in favour of `source`, which is the authoritative column.
UPDATE run_usage SET is_exact = (source = 'exact') WHERE is_exact <> (source = 'exact');

ALTER TABLE run_usage
    ADD CONSTRAINT run_usage_source_matches_is_exact
    CHECK (is_exact = (source = 'exact'));
