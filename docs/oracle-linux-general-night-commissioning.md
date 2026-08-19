# Oracle Linux Commissioning — General Night Shift

**Branch:** `commissioning/oracle-linux-general-night`
**Deploying:** `main` @ `9d507ae` (Sprints 1, 2, 3, 3.1, 3.2, 3.3 merged)
**Target:** Oracle Cloud VM `mac-bennet-pc`, `161.33.80.88`, ap-melbourne-1
**Written:** 2026-08-19, before any substantive change to the VM
**Companion documents:** `Mac_Spec.md`, `docs/mac-spec-reconciliation.md`,
`docs/sprint-3.1-commissioning-report.md`, `docs/sprint-3.3-completion-report.md`

This is the plan. The report of what actually happened is
`docs/oracle-linux-general-night-commissioning-report.md`, and where the two disagree, the report
wins.

---

## 1. What this commissioning is for

Sprint 3.1 commissioned the **coding** path against real external systems. Sprint 3.3 restored
**general, non-coding** execution and proved it architecturally — against a scripted model, an
automated end-to-end test and the real acceptance task driven through the real HTTP surface — and
then said plainly that it had not been commissioned:

> Sprint 3.3 restored the capability. It has not yet been commissioned, in the sense Sprint 3.1
> used that word for the coding path.
> — `docs/sprint-3.3-completion-report.md`

This session closes that gap for one real task, end to end, on real infrastructure:

> **Investigate PAC Project Registry, Document Controller & Sales Engineer**
> `332dcf3e-ee41-44bb-8955-10bf8589dc1a` · project `PAC Internal Development` · no monday item ·
> no repository

It is **not a feature sprint**. Code changes happen only where commissioning exposes a real defect,
under the §27 defect policy, on this branch.

---

## 2. Current VM state — observed, 2026-08-19

Everything in this table was read off the machine before any change was made.

| | Observed |
|---|---|
| Hostname | `mac-bennet-pc`, KVM guest, QEMU i440FX |
| OS | **Ubuntu 24.04.4 LTS** — *not* Oracle Linux, despite the brief's wording. Kernel `6.17.0-1018-oracle` |
| Architecture | `x86_64`. **Not ARM**, so the §9 ARM caveat does not apply |
| CPU / RAM | 2 vCPU / **954 MiB** RAM + 4 GiB swap (45 MiB used) |
| Disk | 45 GiB, 8.3 GiB used, 36 GiB free |
| Login user | `ubuntu` (uid 1001), member of `sudo`, passwordless sudo |
| Node / npm | v22.23.2 / 10.9.8, at `/usr/local/bin` |
| Git | 2.43.0. `gh` present, authenticated as `KasperPac`, scopes `gist, read:org, repo` |
| PostgreSQL | **16.14**, `postgresql.service` enabled and active, listening `127.0.0.1:5432` only |
| Databases | `mac_bennett`, `mac_bennett_test`, both owned by role `mac` |
| Bubblewrap | **0.9.0** at `/usr/bin/bwrap` |
| Claude Code | **2.1.233** at `/usr/local/bin/claude`, credential file present at `~/.claude/.credentials.json` |
| Docker | **absent**. Bubblewrap is the only sandbox provider available, which is the intended one |
| systemd | available; **no Mac units exist**. Nothing survives logout today |
| Checkout | `/home/ubuntu/mac-bennett`, on branch `sprint-3.1/integration-commissioning`, 30 modified files, 1 untracked. **Three sprints behind `main`** |
| Firewall | iptables: `ACCEPT` established, ICMP, loopback, **tcp/22 only**; everything else `REJECT icmp-host-prohibited` |
| OCI control | **No OCI CLI, no instance principal.** The security list cannot be changed from the VM |
| Running Mac processes | none |

### 2.1 The VM's database is empty

`mac_bennett` on the VM has the Sprint 3.1 schema and **zero rows** in `projects`, `tasks`, `runs`,
`workers` and `audit_events`. Sprint 3.1 ran against `mac_bennett_test`, and the standard suite
truncates it.

The real acceptance task does **not** exist on the VM. It exists in the Windows development
database (`mac-bennett-db`, Docker, `localhost:5433`), which §5 of the brief forbids commissioning
against. This is dealt with in §6 below and is the single most delicate step in this plan.

### 2.2 Schema level

The VM database is at the Sprint 3.1 schema. Missing: `0007_sprint32_company_context.sql` and
`0008_sprint33_general_work.sql` — so no `company_context_revisions`, no `run_artefacts`, no
`general_run_state`, no `discovery_investigations`, and none of the Sprint 3.3 settings columns.

---

## 3. Target deployment shape

Single VM, both planes, three long-lived Mac processes plus PostgreSQL and nginx.

```
                    internet
                        │  HTTPS 443 (Let's Encrypt, PAC subdomain)
                        ▼
                     nginx ──────── static: apps/web/dist
                        │
                        └── proxy /api ──▶ 127.0.0.1:8080
                                             │
                                    Fastify control plane
                                    (reasoning, company context,
                                     monday, mail, night shift)
                                             │  worker protocol over loopback
                                             ▼
                                        Mac worker
                                             │
                                        Bubblewrap
                                             │
                                       Claude Code 2.1.233
                                             │
                        PostgreSQL 16.14 ◀───┘ (127.0.0.1:5432)
```

### 3.1 One VM, two planes — the §4 assessment

The brief asks this to be assessed rather than assumed.

Mac's architecture separates the **control plane** (holds every credential: model API key, monday
token, mail secret, company-context token, database) from the **worker** (holds only its own
enrolment/worker token). Sprint 3.3 §7 makes this load-bearing for general work: the worker drives
the research loop but the control plane performs it, precisely so the VM never holds the model
credential or the company-context mirror.

Running both on one host does **not** merge those planes, and this plan does not let it:

* the worker still authenticates over the worker protocol with its own rotating token — no
  in-process shortcut, no shared module;
* the worker's systemd unit gets an `EnvironmentFile` containing **only** worker variables. The
  control-plane secrets are in a separate file the worker's unit does not read;
* `REFUSED_SANDBOX_ENV` continues to refuse forwarding the enrolment token, database URL, monday
  token, mail credentials and GitHub tokens into a sandbox;
* both run as the same unprivileged user, which is a real weakening compared with two hosts, and is
  recorded as such in §14 rather than papered over.

Two hosts would be better and 954 MiB of RAM across two Always-Free VMs would be worse. One VM is
the right call at this scale; the auth-plane separation is preserved in code and configuration, not
merely asserted.

### 3.2 Service user

Mac's services will run as a **dedicated `mac` user with no sudo**, not as `ubuntu`.

`ubuntu` has passwordless sudo. A sandbox escape from a Claude Code session running as `ubuntu`
reaches root on a machine holding PAC's monday token, mailbox credential and company-context
credential. That is the whole containment argument from Sprint 3.1 §10 finding 2, one step further
along.

Cost: Claude Code's subscription credential is currently `ubuntu`'s. It is an OAuth token in a
portable file — Sprint 3.1 proved it works when mounted into a Bubblewrap sandbox with a fresh
`$HOME`, so it is not bound to the OS user. It will be copied to `/home/mac/.claude/`, mode `0600`,
owned by `mac`. Once `mac` refreshes it the refresh token rotates and `ubuntu`'s copy goes stale;
`mac` becomes its sole owner. If the copy does not authenticate, the fallback is documented in §12.

Layout:

| Path | Owner | Mode | Purpose |
|---|---|---|---|
| `/opt/mac-bennett` | `mac:mac` | `0755` | the checkout of `main` |
| `/var/lib/mac-bennett` | `mac:mac` | `0750` | worker workspace, worker state file, worktrees |
| `/etc/mac-bennett/control-plane.env` | `root:mac` | `0640` | model key, monday, mail, company context, database |
| `/etc/mac-bennett/worker.env` | `root:mac` | `0640` | worker identity and sandbox settings **only** |
| `/home/mac/.claude/.credentials.json` | `mac:mac` | `0600` | Claude Code subscription credential |

Secrets live in `/etc`, not in the checkout. `dotenv` does not override variables already in the
environment, so systemd `EnvironmentFile` values win and no `.env` needs to exist under
`/opt/mac-bennett` at all. That makes "no credential is committed" structural rather than
disciplined.

### 3.3 Publishing the UI — and why it is public

The instinctive choice for a control plane holding these credentials is loopback plus an SSH
tunnel. That was rejected on a stated product requirement: several PAC people need to reach Mac
from different locations, usually on a phone, and `Mac_Spec.md` §22 makes spoken conversation the
long-term primary interface. A tunnel forecloses that; a real hostname on a real certificate is
what a future voice client will need anyway.

So: **nginx, HTTP redirected to HTTPS, Let's Encrypt certificate on a PAC subdomain pointing at
161.33.80.88.**

Publishing an authentication plane to the internet is a genuine increase in exposure and is
compensated, not ignored:

* TLS only; HSTS; no plaintext listener except the ACME redirect;
* the session cookie gets `Secure` — `MAC_ALLOW_INSECURE_HTTP` stays **off** in production;
* login rate limiting (`@fastify/rate-limit` is already a dependency; the effective limit will be
  verified rather than assumed) plus `fail2ban` on nginx auth failures;
* PostgreSQL stays bound to `127.0.0.1`; the control plane stays bound to `127.0.0.1:8080`. Only
  nginx listens publicly;
* the seeded admin password is rotated to a fresh high-entropy value that has never been in a repo.

**Two actions are human-only and block this section:** the DNS A record, and an OCI security-list
ingress rule for TCP 80 and 443. There is no OCI CLI or instance principal on the VM, so the
security list cannot be reached from here. Everything else in this plan proceeds without them.

---

## 4. Services

All `Type=simple`, `Restart=on-failure`, `User=mac`, journald logging, and hardened with
`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict` and an explicit `ReadWritePaths`.

| Unit | What it is | Depends on |
|---|---|---|
| `postgresql.service` | already present, enabled | — |
| `mac-control-plane.service` | Fastify, `tsx src/index.ts`, `127.0.0.1:8080` | postgresql |
| `mac-worker.service` | worker agent, capabilities `claude_code` + `general_task` | mac-control-plane |
| `nginx.service` | TLS termination, static `apps/web/dist`, `/api` proxy | — |

The night-shift scheduler, the email sweeper and the company-context refresher are **embedded in
the control plane**, not separate processes. That is checked before writing units, not assumed; if
any turns out to need its own timer it gets one and this table is corrected in the report.

`tsx` is used rather than a compiled bundle because that is how the repository runs the server
today (`"start": "tsx src/index.ts"`). Introducing a build step for production would be a change to
the architecture, which §4 of the brief forbids.

Documented status commands go in the report: `systemctl status mac-*`, `journalctl -u mac-worker -f`.

---

## 5. PostgreSQL

The existing 16.14 instance is kept. It already has `mac_bennett` and `mac_bennett_test` owned by
role `mac`, on local disk, started by systemd at boot.

Work required:

1. **Rotate the `mac` role's password** to a fresh high-entropy value and update both env files.
   The current one was set during Sprint 3.1 and has been in a `.env` on a laptop.
2. **Apply migrations 0007 and 0008** to `mac_bennett` and `mac_bennett_test` via
   `npm run migrate -w @mac/server`. Migration 0008 is additive apart from one column rename that
   preserves its data, and it **enables nothing** — every permission column is backfilled with what
   was already true.
3. **Separate concerns**: `mac_bennett` is production and is never pointed at by a test run;
   `mac_bennett_test` is the only database the suites touch. The night e2e, the integration tests
   and the server suite all truncate it, so they run one at a time (Sprint 3.1 §9).
4. **Backup**: a nightly `pg_dump` of `mac_bennett` to `/var/backups/mac-bennett/`, 14 days
   retained, by systemd timer, plus a documented restore command. Minimal by design — this is
   §5's "at least minimally", not a backup product.
5. **A pre-migration dump is taken before step 2** and kept, so the schema change is reversible.

The Windows Docker database is not used, not pointed at, and not deleted. It remains the source for
the one migration in §6 and is then left alone as history.

---

## 6. The acceptance task — moving it, not recreating it

§19 says use the existing real task and do not recreate it. §5 says do not commission against the
Windows database. Both are right, and together they mean the row has to move.

What moves, from `mac-bennett-db` (Windows, 5433) to `mac_bennett` (VM):

| Row | Id | Why |
|---|---|---|
| project `PAC Internal Development` | `a67d1055-…` | the task's parent; `repo_url` null, `night_shift_approved` false, `allowed_task_kinds` **empty** |
| task | `332dcf3e-ee41-44bb-8955-10bf8589dc1a` | status `draft`, kind `investigation`, origin `direct`, priority `high`, 9,855-char description |
| discovery session | `fd7f30fa-…` | status `ready` — Sprint 3.3 left valid state and §19 says reuse it |
| handoff brief v1 | `0bb0b04a-…` | status `draft`, confidence **0.999**, bound to a company-context revision |
| company-context revision | `28b00dde-…` | SHA `83ac4a0c03fb882b3b9050f05d718eb2164369db`, `valid`. The brief has a `RESTRICT` FK to it, so it must precede the brief |
| the task's audit events | — | append-only history; moving the task without its audit trail would break §20's reconciliation |

Rules for this migration:

* **Ids are preserved.** A new id would be a recreated task wearing the old one's name.
* **Nothing is invented.** No approval, no `night_shift_approved`, no `allowed_task_kinds` entry
  travels with it. Those are §17/§20 human decisions and the row arrives exactly as it left.
* **Insertion order follows the FK graph**: users → projects → company-context revision → tasks →
  discovery session → brief → audit events.
* `audit_events` is append-only with a truncate guard and a sequence; inserts are appends, which is
  what the table is for. If the guard refuses ordinary inserts, the audit trail is carried as an
  evidence file and the report says so rather than the guard being disabled.
* **Verified after**: row-for-row column comparison between the two databases, and the task's
  eligibility verdict re-derived on the VM from the migrated state.

If any of this cannot be done faithfully, the fallback is *not* to recreate the task. It is to stop
and report, because a recreated task would silently invalidate every claim in §30 about *the
existing* task.

---

## 7. Worker

One worker, on this VM, advertising both capabilities.

| Step | Evidence required |
|---|---|
| Enrolment | fresh enrolment token minted on the VM, single-use, consumed; `worker.enrolled` audit event |
| Authentication | worker token accepted; an unauthenticated call refused |
| Heartbeat | `workers.last_heartbeat_at` advancing; UI shows online |
| Capability advertisement | lease request carries `claude_code` **and** `general_task`; the control plane records both |
| Token rotation | rotation exercised deliberately, old token refused after the overlap window, no dropped work |
| Reconnect | `systemctl restart mac-worker`, worker re-authenticates from its state file and resumes heartbeating |

The Windows/laptop worker is not the production worker. The VM database has **zero** worker rows,
so there are no stale records to retire there; if any appear during commissioning they are revoked,
not deleted, so their audit history survives.

---

## 8. Bubblewrap

`MAC_SANDBOX_PROVIDER=bubblewrap`, explicitly, not `auto`. Docker is absent, so `auto` would resolve
to Bubblewrap anyway — naming it means a future Docker install cannot silently change the
containment.

`require_sandbox` stays **on**. `MAC_ALLOW_UNCONTAINED_AGENT_COMMANDS` stays **off**. Falling back to
uncontained execution to make a test pass is forbidden by §9 and is not in this plan.

Proof required, reusing and extending `apps/worker/tests/sandbox-conformance.test.ts` (18 checks,
green on Ubuntu at Sprint 3.1):

* Bubblewrap available and selected;
* the assigned work area is readable and writable;
* an unrelated project's directory is not reachable;
* the monday token, mail credentials, database URL and worker state file are absent from the
  session environment and unreachable on disk;
* cancellation terminates the contained process promptly;
* project test/tool execution still works inside the boundary;
* authenticated Claude Code works inside the boundary with only its own credential mounted at the
  sandbox's `$HOME/.claude/.credentials.json` (Sprint 3.1 defect 18).

Architecture is `x86_64`, so no ARM-specific behaviour is expected. If any appears it is documented
and fixed only if real.

**One thing this plan will test rather than assume.** Sprint 3.3 §16 recorded a judgement for
review: a worker doing *general* work is not required to have a sandbox, because general work runs
no process on the worker — the reasoning happens in the control plane. That reasoning is checked
against the real run: if the general path turns out to execute anything locally, the judgement is
wrong and the fix is one condition in `shiftCapabilities`.

---

## 9. Claude Code

Claude Code remains the coding worker and is not replaced by the reasoning provider. It is not used
by the research task, which is non-coding — so this section proves it still works on this VM rather
than exercising it in the acceptance run.

To determine and record: installed version (2.1.233 observed), authentication method, credential
location, whether the credential is available at the sandbox path, execution, logs, cancellation,
usage reporting.

**No switch to API-key billing.** §10 forbids it, and the reasoning-provider decision in §10 below
is a separate credential for a separate purpose. Claude Code keeps its subscription session; the
Anthropic API key is never placed in Claude Code's environment.

---

## 10. Reasoning provider

`services/model/provider.ts` offers `anthropic`, `openai`, `scripted` and `none`.
`requireReasoningProvider()` throws `MODEL_PROVIDER_REQUIRED` when no real provider is configured —
deliberately, because an empty research result is indistinguishable in a report from an
investigation that genuinely found nothing.

**Investigated, and the tempting assumption is false.** Sprint 3.3 recorded it as typed data in
`MODEL_ACCESS`: a Claude Code subscription does not grant Messages API access. Claude Code holds an
OAuth session; the Messages API is a separate, key-authenticated product. Mac's reasoning therefore
requires **API access**, which is also what preserves the per-token counts the budget model reads.

Both providers exist and are equivalent for this purpose. **Anthropic was chosen**, on a human
decision recorded here:

| | |
|---|---|
| Provider | `anthropic` |
| Model | `claude-sonnet-5` (`MAC_MODEL_NAME` default) |
| Credential | `ANTHROPIC_API_KEY` in `/etc/mac-bennett/control-plane.env` |
| Billing | metered per token, prepaid credit, separate account and separate billing from Claude Code Max |
| Initial limit | **USD 25**, human-set. A full 8-step run at the configured ceilings is roughly USD 1–2 |
| Not given to | Claude Code, the worker, the sandbox, monday tooling, mail tooling |

Provider architecture is not redesigned. `MAC_RESEARCH_SEARCH_ENDPOINT` stays unset, so
`public_web_search` continues to refuse honestly rather than returning an empty result.

### 10.1 Validation before the real run

Against the real provider: receives company context; produces structured output; carries citations
where the implementation requires them; is cancelled mid-call by an `AbortSignal`; reports usage;
rejects malformed or unsupported output safely.

**Adversarial input is mandatory, not optional.** Sprint 3.3's safeguards — `classifyFindings()`
demoting unsupported claims, capping ungrounded confidence at 0.59, auditing invented citations —
were built and tested against a *scripted* misbehaving model. They have never seen a real one. At
least one deliberately ambiguous or adversarial research input goes through the real path, and the
demotion is observed in the artefact, not inferred from the code.

---

## 11. PAC Company context

Repository `https://github.com/PacTechnologiesAus/Company`, ref `main`, currently at SHA
`83ac4a0c03fb882b3b9050f05d718eb2164369db` — the same SHA the migrated brief is bound to.

To prove: authenticated fetch on the VM; manifest validation; all seven mandatory documents loaded
(`COMPANY.md`, `VALUES.md`, `OPERATING_MODEL.md`, `SYSTEMS.md`, `AUTHORITY.md`, `AGENTS.md`,
`GLOSSARY.md`); version and SHA recorded; refresh works; no write capability required; the worker
and coding sandbox receive no Company write credential.

The exact SHA governing the first real night run is recorded in the report.

### 11.1 A credential finding, recorded up front

§11 asks for a read-only credential, target permission **Contents: Read**. The credential currently
configured is a `gho_` OAuth token with scopes `gist, read:org, repo, workflow`, and the GitHub API
reports `admin: true` on the Company repository. It is not read-only.

The provider only ever reads, so no write is *performed* — but "no write capability is required"
and "no write capability is held" are different claims, and only the first is currently true.
Commissioning proceeds with the existing token so the rest is not blocked, and the exact human
action is: create a fine-grained PAT scoped to `PacTechnologiesAus/Company` alone with **Contents:
Read** and nothing else, and replace `MAC_COMPANY_CONTEXT_TOKEN`. This appears in the report's
security findings and in its list of credentials requiring human ownership.

---

## 12. Email / morning report

Reuse the Sprint 3.1 Microsoft Graph path. It was fully commissioned: a dedicated Entra service
principal with Exchange Online `Application Mail.Send` scoped only to
`mac.bennet@pac-technologies.com.au`, `InScope: True`, Graph HTTP 202, and human confirmation of
receipt in Outlook with sender name **Mac Bennet**.

The Entra configuration is not recreated. The existing tenant, client and secret are carried into
`/etc/mac-bennett/control-plane.env`.

To prove here: authentication from the VM; correct sender; an approved recipient; report generation
for the *research* run; exactly one delivery; idempotency; provider message id recorded (Graph
returns none, so `null` is the correct value and not a failure); audit events for attempt and
delivery.

`allowed_recipient_domains` is set so arbitrary external recipients are impossible.
`report_recipients` is set to the one approved internal address. Sprint 3.1 defect 24 — concurrent
sweepers double-sending — has an atomic compare-and-swap claim and a three-sweeper regression;
idempotency is re-proved here on the real path.

---

## 13. Configuration to be set

Nothing in this table grants new authority. Every value is either an existing human-approved limit
or a conservative default.

| Setting | Value | Note |
|---|---|---|
| `timezone` | `Australia/Sydney` | already correct |
| `overnight_cutoff` | `08:00` | already correct; production value, verified DST-correct |
| `night_shift_enabled` | `true` | currently false |
| `model_provider` | `anthropic` | currently `none` |
| `model_assist_enabled` | `true` | currently false |
| `general_work_enabled` | `true` | already true |
| `max_research_steps` | `8` | unchanged |
| `max_research_tool_calls` | `40` | unchanged |
| `external_research_enabled` | `false` | **stays off**; see §15 |
| `mail_provider` | `graph` | currently `none` |
| `report_recipients` | one internal address | currently empty |
| `allowed_recipient_domains` | `pac-technologies.com.au` | currently empty |
| `nightly_budget_cents` | `5000` AUD | **unchanged** — an existing human-approved limit. Not raised |
| `min_execution_confidence` | `0.600` | unchanged, non-overridable |
| `require_sandbox` | `true` | unchanged |

**No new spend authority is created.** The nightly budget is not raised. Note the honest limitation
from Sprint 3.3 debt item 2: reasoning usage is recorded in tokens, not money, so the monetary
budget cannot stop a research shift — the step and tool-call ceilings bound it instead. The USD 25
provider-side limit is the real backstop and it is human-set.

`night_shift_approved` and `allowed_task_kinds` on `PAC Internal Development` are **not** in this
table. See §17.

---

## 14. Credential model

| Credential | Held by | Reaches the worker? | Reaches the sandbox / Claude Code? | Reaches the research model? |
|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | control plane | no | no | it *is* the model call; never forwarded as data |
| `MONDAY_API_TOKEN` | control plane | no | no (`REFUSED_SANDBOX_ENV`) | no |
| Mail client secret | control plane | no | no (`REFUSED_SANDBOX_ENV`) | no |
| `MAC_COMPANY_CONTEXT_TOKEN` | control plane | no | no | no — documents are passed as text, the token is not |
| Database URL / password | control plane | no | no | no |
| Worker enrolment + worker token | worker | yes | no (`REFUSED_SANDBOX_ENV`) | no |
| Claude Code subscription credential | `mac` user | yes | **yes, deliberately** — mounted read-only at the sandbox `$HOME` | no |
| `gh` GitHub token | `mac` user | yes | only where a coding run needs it | no |

Every one of these is verified during commissioning rather than asserted, per §26.

**Known weakening, recorded rather than hidden:** control plane and worker run as the same
unprivileged user on the same host, so filesystem separation between the two env files is a
permission boundary, not a machine boundary. A worker compromise that achieved arbitrary file read
as `mac` would reach the control-plane env file. Mitigations in place: `mac` has no sudo, the
worker's own unit never loads that file, and the sandbox environment is built from empty. The real
fix is two hosts, and it is a §22 remaining-risk item, not something to pretend away.

---

## 15. External research

`external_research_enabled` stays **false** for the first real run.

That is a deliberate narrowing of the acceptance test and it must be stated plainly rather than
discovered in the results. The consequence: this investigation is grounded in PAC Company context,
project memory, prior runs and earlier briefs — the internal sources — and produces **no
`external_fact` findings**. §22 asks the result to distinguish PAC facts from external facts; with
external retrieval off, the external category will legitimately be empty, and the evidence
classifier's demotion of an `external_fact` resting only on internal sources is exercised
adversarially in §10.1 instead.

Reasons: `public_web_search` has no provider configured and refuses by design, so external
retrieval would be limited to fetching named documents from an allowlisted host; turning it on
requires an administrator host allowlist that does not exist yet; and §21's deliverables are about
PAC's own systems, which are internal by nature.

If the run demonstrably needs an external source, the allowlist is added deliberately, recorded, and
the run repeated — not switched on mid-flight.

---

## 16. monday.com

§16 is explicit: monday is not required for the direct-task acceptance case, and no fake monday item
is to be created for the internal investigation task.

What is done: confirm the real integration still works and has not regressed, using the existing
Sprint 3.1 opt-in suite against the existing disposable board `5102345434` and unapproved sibling
`5102345613`. What is not done: give the acceptance task a board, an item, or any monday dependency.

The Sprint 3.1 finding stands unchanged — there is no `Mac Bennett` user in the monday account, so
Mac's writes are attributed to the token's owner. That is a commercial decision (a seat), not a
technical one, and a test asserts the absence so the claim cannot silently go stale.

---

## 17. Human gates — what I will not do

Three things are reserved for a person and this plan does not take them.

1. **Approving `PAC Internal Development` for night shift and for investigation work.**
   Sprint 3.3 §12 was explicit that the migration deliberately left `allowed_task_kinds` empty
   because "a migration that ticked the box would be the machine granting itself the permission",
   and §14 recorded that the sprint reset both fields afterwards. The same reasoning applies here.
   This is requested through the authenticated UI as a human action.
2. **Approving the handoff brief.** The brief is presented with its derived confidence through the
   normal path. It is not approved on the human's behalf.
3. **Direct database mutation to bypass either.** Explicitly forbidden by §17 and not in this plan.

The exact human-facing actions, with the screen and the control, go in the report so they can be
performed without guesswork.

---

## 18. First live run procedure

1. Confirm services healthy, worker online advertising `general_task`, company context loaded at a
   recorded SHA, reasoning provider validated.
2. Human approves the project (§17.1) and the brief (§17.2) through the UI.
3. Confirm the eligibility verdict now passes every check. Sprint 3.3 left two failing:
   `worker_capability_available` and `reasoning_model_available`. Both should now pass; if a third
   appears, that is a finding.
4. Run the night shift through the real scheduler and the real execution path.
5. Observe: run created with `jobKind = general_task`; worker leases it; research steps performed in
   the control plane; sources consulted recorded; findings classified; artefacts persisted; usage
   recorded; morning report generated and delivered exactly once.
6. Verify from the human side (§25 of the brief) and reconcile the audit trail.

### 18.1 Running it during the day

§23 permits daytime execution for commissioning provided the real scheduler and execution behaviour
are exercised and nothing is falsified.

`MAC_COMMISSIONING_NIGHT=1` already exists and is what Sprint 3.1 used. It is preferred over
altering the cutoff. If a shortened window is used instead, it is recorded exactly, and the
production `08:00 Australia/Sydney` configuration is proved still correct afterwards by reading it
back and re-deriving the cutoff — including its DST behaviour.

**Timestamps and timezone logic are not falsified.** No clock is moved, no timezone is
misrepresented, and the report states which mechanism was used.

### 18.2 Expected deliverables

Per §21: a Project Registry / Jobs Database brief, a Project Document Controller brief, a Sales
Engineer brief, a cross-system architecture recommendation, a recommended build order, and the
report.

The task is **non-implementing**. If Mac turns it into code or build work, that is a defect under
§27, not a curiosity — and it is a plausible one, because the classifier already had to be fixed
once for reading "Document Controller" as an instruction to write documentation and "Do **not**
implement anything" as evidence *for* coding.

---

## 19. Failure testing

Safely, on the test database or on disposable state — never by corrupting production data.

| Failure | Method |
|---|---|
| Worker restart / reconnect | `systemctl restart mac-worker` with work in flight |
| Model-provider transient failure | controlled mock returning 500, then success; assert recoverable classification |
| Cancellation | cancel a live research run; assert the model call aborts rather than finishing |
| Company refresh failure | make the fetch fail; assert cached-vs-blocked behaviour matches `companyContextSatisfied()`'s three-way rule |
| Report idempotency | re-run delivery; assert exactly one send |
| Direct task recoverable after interruption | interrupt mid-run; assert the task is not stranded |

---

## 20. Evidence standard

The single rule inherited from Sprint 3.1: **never describe simulated behaviour as proven.** Every
claim in the report carries what was actually observed, and anything not exercised is marked
`BLOCKED` with the exact configuration needed.

Evidence collected: `systemctl`/`journalctl` output, database rows read directly, the audit trail,
the artefact contents, provider usage, the delivered email, screenshots or DOM text of the UI as a
human sees it, and independent reads of external systems through a different transport than Mac's
own client.

---

## 21. Rollback and recovery

| If | Then |
|---|---|
| Migration 0007/0008 fails | restore the pre-migration `pg_dump`; the VM database returns to Sprint 3.1 schema |
| A service misbehaves | `systemctl stop mac-worker mac-control-plane`; nothing runs unattended; the VM returns to its current state |
| The Claude credential copy breaks Claude Code for `mac` | revert to running as `ubuntu`, record it as a security finding, and re-authenticate `mac` interactively later |
| The acceptance task migration is imperfect | stop; do **not** recreate the task; report |
| TLS or DNS is not ready | the control plane stays on loopback and the UI is reached by tunnel for the technical proof, with public access marked incomplete |
| A real run spends more than expected | the USD 25 provider-side limit is the hard stop; step and tool-call ceilings bound each run |
| Anything touches `main` or a customer system | it does not; no protected branch is written and no customer system is reachable from this VM |

The Windows development database is untouched throughout and remains a complete copy of the
acceptance task's pre-migration state.

---

## 22. Known risks

1. **954 MiB of RAM.** Two `tsx` processes, nginx, PostgreSQL and a vitest run do not obviously fit.
   Swap is 4 GiB and Sprint 3.1's suites passed here, but the web build and the full suite are the
   likely pressure points. Mitigation: build the web bundle once, not per deploy; run suites one at
   a time; watch for OOM in journald. Sprint 3.3 already found one out-of-memory crash in a worker
   test run, which is how defect 1 was discovered.
2. **A public authentication plane.** New exposure, mitigated in §3.3, and the residual risk is real.
3. **Same-host planes.** §14's recorded weakening.
4. **A non-read-only Company credential.** §11.1.
5. **Monetary budget cannot see reasoning spend.** Sprint 3.3 debt item 2. Bounded by ceilings and
   the provider-side limit; a human judgement is required before unattended running, and the report
   asks for it explicitly.
6. **A real model has never been through these safeguards.** The entire evidence-classification
   design assumes a model that sometimes fabricates. §10.1 is where that assumption first meets
   reality, and finding a defect there is a likely outcome, not a failure of the plan.
7. **The classifier is regex-based** and has already misread this exact task once.
8. **Claude Code credential rotation** could invalidate `ubuntu`'s session. Intended, but it means
   there is one owner of that session from now on.
9. **The acceptance task migration** is the most delicate step and has no partial-success mode
   worth accepting.

---

## 23. Out of scope

Per §29, and not started: Teams, voice, OpenClaw, the Project Registry, the Project Document
Controller, the Sales Engineer, Forja changes, customer communication, PLC deployment, a Windows
engineering worker, production deployment automation.

The research task investigates three of those and implements none of them. That distinction is the
acceptance criterion, not a technicality.

---

## 24. Definition of done

The brief's §30 list of twenty-three items, each answered with observed evidence or an explicit
statement of what remains, and the §31 closing question answered **yes** only where directly
observed evidence supports it.
