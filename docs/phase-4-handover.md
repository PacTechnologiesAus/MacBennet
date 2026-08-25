# Phase 4 Commissioning — Handover

**For:** whoever picks this up next, human or agent
**Branch:** `commissioning/phase-4-teams-web`, at `bb0d291`
**Default branch:** `main` **untouched**, still at `107aa5b`
**Deployed on the VM:** `e8a804e` — one commit behind this branch, see §4
**Written:** 2026-08-25, at a human-only gate. Nothing here is waiting on more code except §4.

Read `docs/phase-4-commissioning-report.md` for the findings in full — it is the evidence record and
it governs. Part K is the most recent pass. This document is the operational picture: what is done,
what is blocked, what to do next, and the things that cost previous passes hours so they cost you
none.

---

## 1. Where Phase 4 actually is

**Not commissioned.** Two of the four completion criteria are met and two are not, and the gap in
both remaining cases is a human action in someone else's system, not work left undone here.

| Completion criterion | State |
|---|---|
| Defect 9 fixed and proven | **Met, and now Linux-proven** — K.2 |
| Defect 10 fixed and proven | **Met at local strength.** VM re-derivation outstanding — §4 |
| Full regression green | **Met** — Linux-proven for defect 9's state, locally proven for defect 10's |
| Real Teams proven against the PAC tenant | **Not met — blocked on a human** — §5 |
| Real external search proven, acceptance verified against real external evidence | **Not met — blocked on a human** — §6 |

Keep the four strengths apart, because the report does and the distinction is the point:

* **implemented** — code exists;
* **locally tested** — passes against a real database and a real HTTP surface on a workstation;
* **Linux-proven** — observed on `161.33.80.88`;
* **third-party proven** — exercised against the real external service.

Real web *retrieval* is third-party proven (Part C continued); real web *search* is not.

**Phase 5 was not started.** Do not start it.

---

## 2. What has happened since the last handover

### 2.1 The deployment gate is cleared

The previous handover's §4 said `BLOCKED — DEPLOYMENT ACCESS REQUIRED`. It no longer is. SSH to
`ubuntu@161.33.80.88` works from the current session. On 2026-08-21 `/opt/mac-bennett` was
fast-forwarded `4063ace → e8a804e`, `npm ci` run and `mac-control-plane` restarted, and the suites
were re-run on the VM: server **1137 passed / 61 skipped / 0 failed** (1076 s), worker **233 / 3
skipped**, typecheck and web build clean, **0 deadlocks**.

**This retires the standing baseline fact from Part A.** The deployment is no longer running the
Phase 4 *base* branch. Conversations, the Teams plane, approval requests, Forja and acceptance
verification are in the running process for the first time — which is what makes §5 actionable
rather than theoretical.

The web build on the VM needs `NODE_OPTIONS=--max-old-space-size=800`. The VM has 954 MiB of RAM.

### 2.2 Defect 10 — found by that deployment, fixed on 2026-08-25

Re-deriving the criteria on the VM did **not** confirm the D.21.8 AFTER table. Part K has the whole
account. In one paragraph: **defect 9 was proven against a paraphrase.** No brief in the database
contains the sentence the report quoted, "Two distinct documents, not one consolidated report". The
real briefs put the refusal on the *other* side of its noun — *"A single combined document covering
both is explicitly NOT what is wanted"* — which is the one position the derivation could not see.

Three faults, all in `apps/server/src/domain/deliverables.ts`:

1. `negatedDeliverable` reads three words **backward**, so a refusal written after the noun was
   invisible and a sentence declining a combined document required one.
2. The backward pass inspected only the generic immediately preceding each specific, and brief
   `7599b3fb…` walks straight past it.
3. "How many were already asked for" was measured two ways — the nearest sentence holding a
   specific, and what aggregation actually derives. For `7599b3fb…` those disagreed, and the gap
   became two more required artefacts.

Fault 3 was invisible to every wording written by hand. It needs a brief whose fields mention the
same deliverable four times with a section sentence last — which is what a real brief looks like and
what an example never does.

Both production briefs now derive `engineering_brief min=2` and no `markdown_document` criterion,
**on the wording the database holds**. Both are quoted verbatim and untidied in
`tests/unit/deliverable-normalisation.test.ts`.

### 2.3 Suite state, on this workstation

| Suite | Result |
|---|---|
| Server | **1156 passed**, 61 skipped, **0 failed** (577 s) |
| Worker | **233 passed**, 3 skipped |
| Typecheck | clean, all four packages |
| Web build | clean |
| Deadlocks during the run | **0**, confirmed against the PostgreSQL server log |

Baseline was 1137 / 61. The whole of the difference is the 19 new tests.

**No migration.** No protocol change, no new tool-result field, and the prompt-injection structural
test is untouched — `git diff` on `web-research.test.ts` is empty.

---

## 3. Things that cost previous passes hours. Read these before you run anything.

### 3.1 Stopping a suite does not stop `vitest`

The commissioning brief said, in terms: *"Because previous database corruption came from overlapping
suites, run database-mutating suites sequentially. Do not repeat that failure mode."*

A previous pass repeated it. Not by launching two suites deliberately — by stopping three full runs
mid-flight, where stopping the *task* killed the shell but **not** the `vitest` child processes,
which went on running against `mac_bennett_test`. The next run then had company. PostgreSQL named it
exactly:

```
ERROR:  deadlock detected
  Process 6166:  INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING
  Process 6148:  TRUNCATE TABLE run_logs, run_usage, approvals, runs, tasks, projects, ...
```

Two backends both inside `resetDatabase`. Because `settings.updated_by` references `users`, the
TRUNCATE's CASCADE removes the settings singleton, and the window before it is reinserted is where
the other process reads `SETTINGS_MISSING`. Result: **288 failures across 16 files**, most in tests
the change never touched. It read as a broken fix and was a broken environment.

**The corrupt state left no trace.** By the time the run finished, `settings` and `users` were back
to one row each and the tables looked healthy. Only the server log could tell the difference.

### 3.2 Two process checks reported confident falsehoods

* `ps aux | grep -c vitest` returned `0` **while vitest was running**. On Git-Bash for Windows it
  cannot see Windows processes at all. That false zero is what let 3.1 happen.
* A wait loop written `until ! powershell "...exit 1 if running"` inverts the sense of `until`. It
  terminated immediately and printed *"vitest 45408 exited"* while the process was running with
  rising CPU.

### 3.3 So, the rules for running suites here

1. Launch long runs **detached** so a stopped shell cannot orphan them.
2. Confirm exactly one instance, by command line, not by `ps`:
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*vitest*' }
   ```
3. Do not report a suite result until the process has been **observed to exit**.
4. After any interrupted run, check the server log before trusting a result:
   ```sh
   docker logs mac-bennett-db --since 30m 2>&1 | grep -ci "deadlock detected"
   ```
   Expected: `0`.

These rules were followed for every run recorded in §2.3, and the deadlock count says so.

### 3.4 Setting up a fresh checkout — two traps, both real

* **`cp .env.example .env` gives you a control plane that will not boot.**
  `MAC_COMPANY_CONTEXT_TIMEOUT_MS`, `MAC_FORJA_WEBHOOK_TIMEOUT_MS` and `MAC_SEARCH_TIMEOUT_MS` are
  set to an *empty value*, and `z.coerce.number().int().min(1000)` turns `""` into `0`. You get
  `Invalid environment configuration` under the hint *"Did you copy .env.example to .env?"* — which
  is exactly what you just did. Comment the three keys out; the schema defaults are correct. Logged
  as MACB-13.
* **`npm ci` first.** A fresh checkout has no `node_modules`, and `npx vitest` will cheerfully
  install a *different* vitest outside the workspace and then fail to resolve `vitest/config`. Use
  `node_modules/.bin/vitest` once dependencies are installed.

Then `docker compose up -d`, `npm run db:wait`, `npm run migrate` — ten migrations, through
`0010_commissioning_vendor_domains.sql`.

### 3.5 Two known local artefacts, neither a defect

* **`company-context-*` tests flake on Windows under load**, with `spawnSync('git', …)` returning
  non-zero and *empty* stdout and stderr — the signature of a process that never launched. I.1
  documents the same Windows file-locking artefact for these same files, which pass on Linux.
* **A `tsx watch src/index.ts` dev server** belonging to the operator may be running and restarting
  on every edit under `apps/server/src`. It connects to `mac_bennett`, never `mac_bennett_test`, so
  it takes no part in deadlocks, but it competes for CPU. If suite timings look inflated, check it.

---

## 4. `NEXT — REDEPLOY AND RE-DERIVE` (smallest, do this first)

Defect 10's fix is proven against a real database, a real HTTP surface and the real production
wording — but on a workstation. Making it **Linux-proven** needs the branch redeployed. SSH works;
there is no access gate any more.

1. Push `commissioning/phase-4-teams-web` (currently at `bb0d291`, one ahead of the VM).
2. On the VM, in `/opt/mac-bennett`:
   ```sh
   sudo -u mac git fetch origin
   sudo -u mac git pull --ff-only          # expect bb0d291
   sudo -u mac npm ci
   sudo systemctl restart mac-control-plane
   ```
3. Re-run the full suites against `mac_bennett_test` on the VM, to convert §2.3's numbers from
   *locally proven* to *Linux-proven*. Remember `NODE_OPTIONS=--max-old-space-size=800` for the web
   build.
4. Re-derive the criteria for briefs `47ff5d0f…` and `7599b3fb…` and confirm K.6 — one
   `artefact_type` criterion, `engineering_brief min=2`, and **no** `markdown_document` criterion,
   for **both**.

**No migration is required.**

Reading the briefs back, which is how the paraphrase was caught and how step 4 is checked:

```sh
sudo -u postgres psql -d mac_bennett -tAc \
  "select id::text, content->'acceptanceCriteria', content->>'proposedScope' \
   from handoff_briefs where id::text like '47ff5d0f%' or id::text like '7599b3fb%'"
```

---

## 5. `BLOCKED — HUMAN MICROSOFT CONFIGURATION REQUIRED`

Unchanged by the last two passes; nothing in defect 9 or 10 touches the Teams plane. What **has**
changed is that the Phase 4 code is now actually deployed (§2.1), so this is ready to be done rather
than waiting on anything here.

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

Once configured, re-prove the ten JWT rejection classes against the **live** endpoint first — they
are currently covered offline only (G.2) — then the nine proofs the brief lists: real inbound PAC
message, real outbound reply, persistent Teams ↔ web conversation, discovery Q&A, explicit approval
code, ambiguous-approval refusal, blocker notification, duplicate/retry behaviour, audit records.

---

## 6. `BLOCKED — HUMAN FINANCIAL / PROVIDER ACTION REQUIRED`

Still blocked. **It is a commercial decision with a recurring cost, not the free signup earlier
passes described** — see K.12. Brave withdrew its free tier in February 2026, six months before the
comparison in Part C was written, so C.3 recommends a plan that cannot be subscribed to.

| Item | Value |
|---|---|
| Vendor / product | Brave Search API, **Search** plan. There is no Free plan and no "Data for Search" product |
| Cost | **$5 per 1,000 requests**, ~50 q/s. A $5 renewing monthly credit covers ~1,000 queries, but only if you publicly attribute Brave — **don't**; pay the $5 |
| Payment method | a **live billing instrument** once the credit is spent. Set a dashboard spending cap to $5 if the control exists — check this at signup |
| Expected spend | **~$5/month** at commissioning volumes |
| Credential | subscription token, sent as `x-subscription-token` |
| Env key | `MAC_SEARCH_API_KEY` |
| File | `/etc/mac-bennett/control-plane.env`, `root:mac`, `0640` |
| Needed by | **the control plane, and only the control plane** |

Install it with `sudo -e`, which keeps the key out of shell history, and never through a chat client
or a session transcript. The provider stays Brave because its client is already written and tested,
because it is the only candidate that returns publication ages — which spec §19's currency judgement
needs — and because query text drawn from confidential briefs should go to an index that does not log
it. **Fallback if an uncapped card is unacceptable:** Tavily's Researcher tier, 1,000 credits/month
with no card at all, at the cost of a new provider client and of `publishedAt`. K.12 has the full
comparison.

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

## 7. Open findings, left alone on purpose

Recorded as debt with stated reasons. None were reopened under cover of defect 10, because a
commissioning fix that quietly repairs whatever it passes stops being reviewable.

**New, and the one worth arguing about:**

* **Defect 11 (MACB-12) — a section the brief names reaches no acceptance criterion.**
  `SECTION_PHRASES` is a fixed vocabulary, so the `'Purpose'` section **both** production briefs ask
  for in so many words produces no criterion. A run that omits it is accepted as complete and the
  requester has no gap to read. This is a requirement **dropped** rather than invented — the Part F
  direction, and the worse one. It is not one of the four completion criteria, but shipping
  commissioning with it open repeats exactly the pattern defect 10 taught: the tidy cases pass and
  the real wording does not. K.9 has the evidence.
* **`.env.example` will not boot (MACB-13)** — §3.4.

**Older, and correctly deferred:**

* **D.6** — the Forja `structuredAcceptance` projection drops `required`, `minimum`, `source`,
  `artefactType`. Fixing it widens the contract and moves `FORJA_CONTRACT_VERSION`; no Forja client
  exists yet.
* **D.7** — the Inbox approval card renders from `approval_requests` and never loads the brief, so
  the scope, research and deliverable notes do not reach someone approving from the Inbox.
* **C.10** — a re-fetch of the same page with a different `#fragment` creates a new
  `research_sources` row. Cosmetic; inflates a source count rather than corrupting a conclusion.
* **Part F** — conversation summarisation. Nothing generates a summary; measured on the deployment,
  no thread is within a factor of five of the threshold. **Re-measure once Teams has been in real use
  for a few weeks** — a Teams thread with a colleague is the first conversation shape likely to run
  long.

---

## 8. Security position

No authority boundary was changed by defect 9 or defect 10. Both are confined to domain code that
reads the brief.

| Boundary | State |
|---|---|
| Teams credentials do not reach worker sandboxes | Unchanged — `mac-worker.service` does not load `control-plane.env` |
| Brave credential does not reach Claude Code | Unchanged; verification method written down in §6 |
| Brave credential does not reach Teams/Forja clients | Unchanged — the DTO publishes the provider name, never the key |
| Company context credentials remain isolated | Unchanged — not touched |
| Web content cannot modify Mac authority | Unchanged — the deliverable reader runs over the brief, never over retrieved content |
| Web content cannot invoke arbitrary commands | Unchanged — no new tool, no new tool-result field |
| Secrets do not enter evidence or audit logs | **Re-checked** — `deliverables.*` audit metadata carries brief phrases only |
| Prompt-injection structural gate | **Intact** — same ten fields |
| `main` remains untouched | **Verified** — `107aa5b`, identical to `origin/main` |

Live boundary re-checked off-host: `/api/health` → `200`, TLS valid, `POST /api/teams/messages` →
`401 TEAMS_REJECTED`. Unchanged from A.4 and G.2.

---

## 9. If you are an agent picking this up

* Work on `commissioning/phase-4-teams-web`. **Do not modify `main`.** Do not start Phase 5.
* Read §3 before running any suite. The failure mode there wastes hours and imitates a broken fix.
* The report is the governing record. Its rule is inherited and absolute: **never describe simulated
  behaviour as proven.** Where something was not exercised against the real third party, say so and
  name what is missing.
* If a real defect turns up: capture evidence, reproduce it, add a regression test, make the smallest
  robust fix, re-run the failed real path, and document it as the next numbered commissioning defect.
  **Defect 11 is the highest number used** — it is logged and unfixed, so the next new one is 12.
* When you reach a human-only gate, stop there and give exact next actions. Do not fake a third party
  to keep moving.

Two things worth generalising, both learned the expensive way.

**Probe against real input, not against your record of it.** Defect 9's fix was tested against the
wording the *report* quoted. It passed. The database held a different sentence, and the first thing
the real data did was fail. Fault 3 of defect 10 could not have been found any other way: it needs a
brief that mentions the same deliverable four times across four fields with a section sentence last,
which is what a real brief looks like and what a hand-written example never is.

**A rule written from one example encodes the half of the language that example showed.** All three
faults in defect 10 are that: a negation test that only looked backward, a pass that only looked at
one neighbour, a quantity defined once for the general case and once for the local one. None were
wrong about the case that produced them.
