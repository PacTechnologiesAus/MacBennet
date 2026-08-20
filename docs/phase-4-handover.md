# Phase 4 Commissioning — Handover

**For:** whoever picks this up next, human or agent
**Branch:** `commissioning/phase-4-teams-web`, pushed, at `49ff9f6`
**Default branch:** `main` **untouched**, still at `107aa5b`
**Written:** 2026-08-21, at a human-only gate. Nothing here is waiting on more code.

Read `docs/phase-4-commissioning-report.md` for the findings in full — it is the evidence record and
it governs. This document is the operational picture: what is done, what is blocked, what to do
next, and the two things that cost me most of a night so they cost you none.

---

## 1. Where Phase 4 actually is

**Not commissioned.** Two of the four completion criteria are met and two are not, and the gap in
both cases is a human action in someone else's system, not work left undone here.

| Completion criterion | State |
|---|---|
| Defect 9 fixed and proven | **Met**, at local strength. VM re-derivation outstanding — §4 |
| Full regression green | **Met**, at local strength — §2 |
| Real Teams proven against the PAC tenant | **Not met — blocked on a human** — §5 |
| Real external search proven, acceptance verified against real external evidence | **Not met — blocked on a human** — §6 |

Keep the four strengths apart, because the report does and the distinction is the point:

* **implemented** — code exists;
* **locally tested** — passes against a real database and a real HTTP surface on a workstation;
* **Linux-proven** — observed on `161.33.80.88`;
* **third-party proven** — exercised against the real external service.

Everything Defect 9 touches is **locally tested** and not yet Linux-proven, for the single reason in
§4. Real web *retrieval* is already third-party proven (Part C continued); real web *search* is not.

**Phase 5 was not started.** Do not start it.

---

## 2. What was done this pass

**Defect 9 — acceptance artefact double counting — is fixed.** Part D §21 of the report has the
whole account. In one paragraph: a brief asking for *"two separate engineering briefs and two
distinct documents"* derived `engineering_brief × 2` **and** `markdown_document × 2`, so a run that
produced exactly the two briefs wanted was reported with a gap. The old pass had no concept of two
mentions referring to the same thing — it turned every noun it recognised into an independent
requirement and summed them.

Extraction and normalisation are now separate stages in `apps/server/src/domain/deliverables.ts`.
Extraction finds candidates positionally, with the words and the source span that produced them, and
decides nothing. Normalisation decides what each one means relative to the others — `additive`,
`alias`, `explanatory`, `contains`, `ambiguous` — and only `additive` reaches a criterion. Where the
wording genuinely does not say, **nothing is guessed**: no criterion is derived and a question goes
onto the brief during discovery, while a person can still change the answer.

On the real production wording, required artefacts went **4 → 2**.

`ARTEFACT_TYPES` is unchanged. Deliverable types are a separate, finer vocabulary, which is what let
specific-over-generic be stated without touching the storage model.

### Final suite state, all on this workstation

| Suite | Result |
|---|---|
| Server | **1137 passed**, 61 skipped, **0 failed** (830 s) |
| Worker | **233 passed**, 3 skipped |
| Typecheck | clean, all four packages |
| Web build | clean |
| Deadlocks during the run | **0**, confirmed against the PostgreSQL server log |

Baseline was 1075 / 62 skipped on the VM. Defect 9 added **54 tests** (48 unit, 6 integration) →
1129. The remaining **+8** is environmental — the local `.env` enables opt-in tests the VM leaves
skipped, which is also why skipped falls 62 → 61 — and it is attributable rather than assumed: an
earlier run in the same session carrying a *different* number of new tests showed the same +8.

### Files changed

```
apps/server/src/domain/deliverables.ts                 NEW  — extraction + normalisation
apps/server/src/domain/acceptance.ts                        — derivation, clarifications, notes
apps/server/src/services/acceptance.ts                      — audit provenance, approval notes
apps/server/src/services/briefs.ts                          — ambiguity → openQuestions
packages/protocol/src/acceptance.ts                         — AcceptanceCriterion.provenance (optional)
apps/server/tests/unit/deliverable-normalisation.test.ts NEW — 48 tests
apps/server/tests/integration/acceptance.test.ts            — 6 defect-9 tests
docs/phase-4-commissioning-report.md                        — Part D §21, I.3, I.4, Part J
```

**No migration.** `provenance` is optional and lives inside the existing `handoff_briefs.acceptance`
and `run_acceptance.criteria` `jsonb` columns, so criteria written before this change parse
unchanged.

**The prompt-injection structural test is untouched** — same ten fields, `git diff` on
`web-research.test.ts` is empty. Defect 9 adds no tool-result field, and `provenance` never reaches
the reasoning model: the semantic prompt is built from `id` and `statement ?? description` only.

---

## 3. Two things that cost me hours. Read these before you run anything.

### 3.1 Stopping a suite does not stop `vitest`

The commissioning brief said, in terms: *"Because previous database corruption came from overlapping
suites, run database-mutating suites sequentially. Do not repeat that failure mode."*

**I repeated it.** Not by launching two suites deliberately. I stopped three full runs mid-flight,
and stopping the *task* killed the shell but **not** the `vitest` child processes, which went on
running against `mac_bennett_test`. The next run then had company. PostgreSQL named it exactly:

```
ERROR:  deadlock detected
  Process 6166:  INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING
  Process 6148:  TRUNCATE TABLE run_logs, run_usage, approvals, runs, tasks, projects, ...
```

Two backends both inside `resetDatabase`. Because `settings.updated_by` references `users`, the
TRUNCATE's CASCADE removes the settings singleton, and the window before it is reinserted is where
the other process reads `SETTINGS_MISSING`. Result: **288 failures across 16 files**, most in tests
Defect 9 never touches. It read as a broken fix and was a broken environment.

**The corrupt state left no trace.** By the time the run finished, `settings` and `users` were back
to one row each and the tables looked healthy. Only the server log could tell the difference.

### 3.2 Two process checks reported confident falsehoods

* `ps aux | grep -c vitest` returned `0` **while vitest was running**. On Git-Bash for Windows it
  cannot see Windows processes at all. That false zero is what let 3.1 happen — I ran the check and
  believed it.
* A wait loop written `until ! powershell "...exit 1 if running"` inverts the sense of `until`. It
  terminated immediately and printed *"vitest 45408 exited"* while the process was running with
  rising CPU.

### 3.3 So, the rules for running suites here

1. Launch long runs **detached** (`nohup … &`) so a stopped shell cannot orphan them.
2. Confirm exactly one instance, by command line, not by `ps`:
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*vitest*' }
   ```
3. Do not report a suite result until the process has been **observed to exit** —
   `Get-Process -Id <pid>` returning nothing.
4. After any interrupted run, check the server log before trusting a result:
   ```sh
   docker logs mac-bennett-db --since 30m 2>&1 | grep -ci "deadlock detected"
   ```
   Expected: `0`.

### 3.4 Two known local artefacts, neither a defect

* **`company-context-*` tests flake on Windows under load.** All four failed in one run with
  `spawnSync('git', …)` returning non-zero and *empty* stdout and stderr — the signature of a
  process that never launched. Verified three ways: 25/25 succeed in isolation; every
  `company-context-*` file passed **with these changes present** in a 470-test integration run; and
  I.1 of the report already documents this same Windows file-locking artefact for these same files,
  which pass on Linux. The final run passed them.
* **A `tsx watch src/index.ts` dev server** belonging to the operator has been running since
  18 August and restarts on every edit under `apps/server/src`. It connects to `mac_bennett`, never
  `mac_bennett_test`, so it took no part in the deadlocks, but it competes for CPU. **Left running —
  it is the operator's process.** If suite timings look inflated, that is the first thing to check.

Housekeeping done: 348 leftover `mac-company-*` directories in `%TEMP%` were removed. They were
litter from the corrupted runs, whose cleanup handlers threw.

---

## 4. `BLOCKED — DEPLOYMENT ACCESS REQUIRED` (new, smallest, do this first)

Defect 9's fix is proven against a real database, a real HTTP surface and the real production
wording — but on a workstation. Making it **Linux-proven** needs SSH to `161.33.80.88`, and no
private key for that host exists in the session that did this work (`~/.ssh` holds `known_hosts`
only).

Exact actions:

1. Provide the SSH key for `ubuntu@161.33.80.88`, or run steps 2–4 on the VM yourself.
2. In `/opt/mac-bennett`:
   ```sh
   sudo -u mac git fetch origin
   sudo -u mac git checkout commissioning/phase-4-teams-web
   sudo -u mac git pull --ff-only          # expect 49ff9f6
   sudo -u mac npm ci
   sudo systemctl restart mac-control-plane
   ```
3. Re-run the full suites against `mac_bennett_test` on the VM, to convert §2's numbers from
   *locally proven* to *Linux-proven*.
4. Re-derive the criteria for the brief from run `2f2a5511…` and confirm the AFTER table in
   D.21.8 — one `artefact_type` criterion, `engineering_brief min=2`, and **no**
   `markdown_document` criterion.

**No migration is required** (§2).

Note the standing baseline fact from Part A: the deployment has been running the Phase 4 *base*
branch. Anything Phase 4 — conversations, the Teams plane, acceptance verification — is not in the
running process until a Phase 4 branch is actually deployed.

---

## 5. `BLOCKED — HUMAN MICROSOFT CONFIGURATION REQUIRED`

Unchanged by this pass; nothing in Defect 9 touches the Teams plane. The eight steps are in the
report and are not restated here. The essentials to have in hand:

| Item | Value |
|---|---|
| Messaging endpoint | `https://mac.pac-technologies.com.au/api/teams/messages` |
| Tenant ID | `370de8ef-61d9-4539-903d-4253050f2cea` |
| Pricing tier | **F0 (Free)** — not S1 |
| App type | **Single-tenant** |
| Config file | `/etc/mac-bennett/control-plane.env`, `root:mac`, `0640` |

**The line that is easy to miss and is not optional for a single-tenant bot:**

```
MAC_TEAMS_LOGIN_URL=https://login.microsoftonline.com/370de8ef-61d9-4539-903d-4253050f2cea
```

Mac's default is the multi-tenant token authority; with a single-tenant app he cannot obtain a Bot
Connector token at all without this.

`settings.teams_authorised_users` starts empty and **empty means nobody**. You do not need to look
object ids up in advance: enable Teams, send one message, read the sender's AAD object id out of
`teams.activity_received` in the audit trail, add it, carry on.

**Do not create paid Microsoft resources or broaden permissions without approval.** Nothing here
needs a Microsoft Graph permission.

Once configured, the nine proofs to run are listed in the brief and in Part B — real inbound PAC
message, real outbound reply, persistent Teams ↔ web conversation, discovery Q&A, explicit approval
code, ambiguous-approval refusal, blocker notification, duplicate/retry behaviour, audit records.
The first thing to do is re-prove the ten JWT rejection classes against the **live** endpoint; they
are currently covered only offline (G.2).

---

## 6. `BLOCKED — HUMAN FINANCIAL / PROVIDER ACTION REQUIRED`

Still blocked, and now fully specified — this pass added the four things the section was missing.

| Item | Value |
|---|---|
| Vendor / product | Brave Search API → **Data for Search**, **Free** plan |
| Payment method | required at signup as anti-fraud, **not charged** on Free |
| Credential | subscription token, sent as `x-subscription-token` |
| Env key | `MAC_SEARCH_API_KEY` |
| File | `/etc/mac-bennett/control-plane.env`, `root:mac`, `0640` |
| Needed by | **the control plane, and only the control plane** |

Recommended conservative commissioning configuration:

| Setting | Value |
|---|---|
| `settings.web_search_provider` | `brave` |
| `settings.max_web_results_per_search` | **5** (default 8) |
| `settings.allow_fetch_from_search_results` | **false** (already default) |
| `settings.max_research_tool_calls` | **12** (default 40, hard cap 40) |
| `settings.external_research_enabled` | `true` |
| project `capabilities` | add `external_research` **per project** |

Both gates must be on: the deployment setting **and** the project capability.

Mac's behaviour at each provider boundary is already defined and tested — `401/403` → `unauthorised`,
`429` → `rate_limited`, timeout → `timeout`, other non-2xx → `unreachable`, missing result list →
`malformed_response`, zero results → an empty list, which is a finding and not an error. Every one is
a **refusal recorded on the run**, which is what lets an acceptance criterion requiring external
evidence stay unmet rather than quietly passing.

Verify isolation after installing the key — full commands in the report:

1. worker does not have it — `grep -c MAC_SEARCH` over `/proc/<mac-worker pid>/environ` → `0`;
2. Claude Code does not have it — covered structurally by (1);
3. Teams/Forja clients do not have it — the settings DTO publishes the provider *name*, never the key;
4. it does not enter evidence or audit logs — grep `audit_events` for the token prefix → `0`.

**Nothing was purchased, no account created, no key requested.**

---

## 7. Deliberate technical debt — left alone on purpose

Three items were recorded by earlier passes as debt with stated reasons. This pass did **not**
reopen them, because commissioning findings are not a licence for unrelated refactors:

* **D.6** — the Forja `structuredAcceptance` projection drops `required`, `minimum`, `source`,
  `artefactType`. Fixing it widens the contract and moves `FORJA_CONTRACT_VERSION`; no Forja client
  exists yet.
* **D.7** — the Inbox approval card renders from `approval_requests` and never loads the brief, so
  the scope, research and (now) deliverable notes do not reach someone approving from the Inbox.
  Recommended fix is a UI change: link the card to the brief and say the criteria and notes live
  there.
* **C.10** — a re-fetch of the same page with a different `#fragment` creates a new
  `research_sources` row. Cosmetic; inflates a source count rather than corrupting a conclusion.

Also still open and correctly deferred: **Part F**, conversation summarisation. Nothing generates a
summary; measured on the deployment, no thread is within a factor of five of the threshold.
**Re-measure once Teams has been in real use for a few weeks** — a Teams thread with a colleague is
the first conversation shape likely to run long.

---

## 8. Security position

No authority boundary was changed. What this pass added was checked against each:

| Boundary | State |
|---|---|
| Teams credentials do not reach worker sandboxes | Unchanged — `mac-worker.service` does not load `control-plane.env` |
| Brave credential does not reach Claude Code | Unchanged; verification method now written down |
| Brave credential does not reach Teams/Forja clients | Unchanged — DTO publishes the provider name, never the key |
| Company context credentials remain isolated | Unchanged — not touched |
| Web content cannot modify Mac authority | Unchanged — the deliverable reader runs over the brief, never over retrieved content |
| Web content cannot invoke arbitrary commands | Unchanged — no new tool, no new tool-result field |
| Secrets do not enter evidence or audit logs | **Re-checked** — new `deliverables.*` audit metadata carries brief phrases only |
| `main` remains untouched | **Verified** — `107aa5b`, identical to `origin/main` |

Live boundary re-checked off-host during this pass: `/api/health` → `200`, TLS valid,
`POST /api/teams/messages` → `401 TEAMS_REJECTED`. Unchanged from A.4 and G.2.

---

## 9. If you are an agent picking this up

* Work on `commissioning/phase-4-teams-web`. **Do not modify `main`.** Do not start Phase 5.
* Read §3 before running any suite. The failure mode there wastes hours and imitates a broken fix.
* The report is the governing record. Its rule is inherited and absolute: **never describe simulated
  behaviour as proven.** Where something was not exercised against the real third party, say so and
  name what is missing.
* If a real defect turns up: capture evidence, reproduce it, add a regression test, make the
  smallest robust fix, re-run the failed real path, and document it as the next numbered
  commissioning defect. Defect 9 is the highest number used.
* When you reach a human-only gate, stop there and give exact next actions. Do not fake a third
  party to keep moving.

One thing Defect 9 is worth generalising. Testing the fix against the **real** production brief and
thirty ordinary wordings found **five defects in the fix itself** — none of which the tidy
one-sentence cases caught. The worst had the ambiguity rule asking about seven briefs in ten, which
is the false gap moved one step earlier into discovery, and it is hard to notice in production
because its symptom is a *question*, and a question looks like diligence. Probe against real input
early, not after you believe you are finished.
