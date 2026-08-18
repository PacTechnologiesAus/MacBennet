# monday.com integration — design only

**Status:** Design. Nothing in this document is implemented.
**Scope:** Sprint 2 §24 permits *preparing an integration design only*, and only after the core
autonomous coding loop is complete and passing. That condition is met: 492 tests pass and the loop
is proven end to end.

Nothing here should be built before Sprint 3 is scoped, and nothing here changes Sprint 2's
behaviour.

---

## 1. What Mac needs monday.com for

Spec §17 lists the whole of it:

* assign an item to himself;
* set status to In Progress;
* post internal progress updates;
* record blockers;
* set status to Ready for Review;
* mark complete when appropriate;
* attach or reference the pull request.

And what he must **not** do: alter commercial priorities, deadlines, or customer commitments.

The important observation is that this list maps almost exactly onto events the audit trail already
emits. Mac does not need a new source of truth or a new lifecycle — he needs a projection of the one
he has.

---

## 2. Shape: an outbound projection, not a second brain

```
run lifecycle transition (already audited)
        │
        ▼
  integration_outbox row          ← written in the SAME transaction as the audit event
        │
        ▼
  outbox worker (in the control plane)
        │
        ▼
  monday.com GraphQL API
```

**Why an outbox rather than calling monday.com inline.** A run must not fail because a third party
is down, and monday.com must not be updated by a transaction that then rolls back. Writing an
outbox row in the same transaction as the state change gives exactly-once *intent* with at-least-once
*delivery*, which is the correct trade for a status board: a duplicated "In Progress" is harmless, a
missed "Ready for Review" is not.

This mirrors a decision Sprint 1 already made and Sprint 2 kept — audit events are written inside
the transaction they describe — so it introduces no new reasoning about consistency.

**Why the control plane rather than the worker.** The worker holds code-execution credentials and
should not also hold business-system credentials. monday.com is a Mac-the-manager concern.

---

## 3. Event mapping

| Mac event (already emitted) | monday.com effect |
|---|---|
| `run.approved` | assign the item to Mac; status → *Working on it* |
| `run.dispatched` | update: branch and worktree created |
| `coding_session.blocked` | update: the blocker and why Mac would not guess; status → *Fixing* if unresolved at completion |
| `coding_session.assumption_recorded` | batched into the completion update, not posted individually |
| `run.review_completed` | update: verdict, risk, anomalies |
| `pull_request.created` | attach the PR link; status → *Awaiting Testing* |
| `pull_request.declined` | update: why no PR was opened; status stays *Working on it* |
| `run.stopped_by_guardrail` | update: cutoff or budget; status unchanged, so a human decides |
| `report.generated` | post the morning report body as the item's summary update |

Deliberately **not** mapped: every progress tick, every question, every activity event. A monday.com
item that receives forty updates a night is an item nobody reads — the same reasoning that keeps
heartbeats out of the audit trail.

---

## 4. Schema (additive, three tables)

```
monday_boards(id, project_id→projects, board_id, group_ids jsonb,
              status_column_id, priority_column_id, is_approved,
              created_at, updated_at)

monday_items(id, task_id→tasks, item_id, board_id, last_status,
             last_synced_at, created_at)

integration_outbox(id, integration, event_type, payload jsonb,
                   run_id→runs, task_id→tasks,
                   attempts, next_attempt_at, delivered_at, last_error,
                   created_at)
```

`monday_boards.is_approved` follows the same pattern as `repositories.is_approved`: a board Mac may
write to is a deliberate, audited admin decision, and revoking it stops future writes without any
call site remembering to check.

---

## 5. Security and permissions

1. **A scoped API token**, stored hashed-at-rest with the plaintext only in the control plane's
   secret configuration — never on the worker, never in the browser, never in an agent's environment.
2. **A column allowlist.** Mac may write only `status`, the updates feed, the assignee, and a PR
   link column. Priority, dates and any column not on the list are refused in code, so spec §17's
   "Mac should not autonomously alter commercial priorities or deadlines" is a capability that does
   not exist rather than a rule to remember.
3. **No deletes.** No mutation that removes an item, a group, a board or an update.
4. **Audited.** New event types `monday.item_linked`, `monday.status_changed`, `monday.update_posted`,
   `monday.write_refused`, written in the same transaction as the outbox row is marked delivered.
5. **Rate limiting and backoff** on the outbox worker, with a dead-letter state after N attempts that
   surfaces in the UI rather than retrying forever.

---

## 6. Reading from monday.com

Sprint 3 may want task *selection* from monday.com (spec §8). That is a larger change than status
projection and should be a separate decision, because it makes an external system an input to what
Mac chooses to work on overnight. Two properties would have to hold first:

* an item is only eligible when a human has explicitly marked it as available to Mac — an
  assignment, not an inference from status;
* eligibility is re-checked at dispatch, not only at selection, exactly as repository approval is.

Until then, work reaches Mac through discovery, where a human hands it to him.

---

## 7. What this design deliberately does not do

* **No bidirectional sync.** monday.com is a projection of Mac's state, not a peer. Conflicts are
  logged rather than silently resolved (spec §10).
* **No monday.com-driven lifecycle.** A status change in monday.com does not start, stop or approve
  a run. Approval stays in the control plane where it is audited.
* **No abstraction layer for "integrations" in general.** Sprint 2's rule against speculative
  infrastructure applies: build the monday.com client, and extract an interface when the second
  integration exists and its shape is known.
