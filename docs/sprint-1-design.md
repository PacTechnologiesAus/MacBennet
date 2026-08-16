# Mac Bennett — Sprint 1 Implementation Design

**Status:** Approved for implementation
**Scope:** Sprint 1 only (spec §32). Proves the control loop; no coding-agent integration.
**Author:** Implementation engineer
**Source of requirements:** `Mac_Spec.md`

---

## 1. Current repository assessment

The repository contained exactly one file when work started:

| Path | Size | Notes |
|---|---|---|
| `Mac_Spec.md` | 24 KB | The V1 product & system specification |

There was **no** git history, `package.json`, lockfile, source tree, configuration, database code, authentication, test suite, CI/CD pipeline, linter config, or developer documentation. `git init` was run as part of this sprint; the spec was committed to `main` and all Sprint 1 work happens on `sprint-1/control-loop`.

**Consequence for design:** there are no existing conventions to honour. Every convention in this sprint is therefore *established*, not inherited, and must be chosen conservatively because the whole future product will inherit it. Where the spec is silent, I have preferred the boring, replaceable option.

**Host tooling verified present:** Node v20.20.0, npm 11.6.2, Python 3.14.0, Docker 29.4.1.

---

## 2. Recommended Sprint 1 architecture

A **modular monolith control plane** plus a **separate worker process**, exactly as spec §31 requires ("Avoid premature distributed architecture. A modular monolith is preferred for V1").

```
┌──────────────────────────┐         ┌───────────────────────────────┐
│  Browser (React SPA)     │         │  Worker VM (Linux)            │
│  session cookie auth     │         │  @mac/worker                  │
└───────────┬──────────────┘         │  bearer worker-token auth     │
            │ /api/*                 └───────────────┬───────────────┘
            │ (HTTPS, same origin)                   │ /api/worker/*
            │                                        │ (HTTPS, outbound only)
            ▼                                        ▼
┌───────────────────────────────────────────────────────────────────┐
│  Control plane — @mac/server (Fastify, single process)            │
│                                                                   │
│  http/          routes, two isolated auth planes                  │
│  domain/        lifecycle state machine + guardrail policy (pure) │
│  services/      projects, tasks, runs, workers, approvals, audit  │
│  db/            drizzle schema + SQL migrations                   │
│  jobs/          sweepers: heartbeat liveness, overnight cutoff    │
└───────────────────────────┬───────────────────────────────────────┘
                            ▼
                   ┌──────────────────┐
                   │  PostgreSQL 16   │
                   └──────────────────┘
```

**Deliberate non-decisions.** No message queue (the run table *is* the queue, and a lease is a single `UPDATE ... RETURNING`). No Redis. No Kubernetes. No microservices. No event bus. No WebSocket gateway. Every one of these can be introduced later behind the same interfaces if measurement justifies it; none is justified by Sprint 1's load (one worker, human-initiated runs).

**Why one process rather than API + separate dispatcher:** dispatch in Sprint 1 is a database transaction triggered by an inbound worker request. Splitting it out would add a network hop and a failure mode without removing any coupling.

### Monorepo layout

npm **workspaces** (built into npm 11 — no pnpm/turbo/nx to install or learn):

- `packages/protocol` — shared zod schemas: worker wire protocol, job catalogue, run/task enums. Consumed by server, worker **and** web, so the contract cannot drift between the three.
- `apps/server` — control plane.
- `apps/web` — React SPA.
- `apps/worker` — the worker agent that runs on the Linux VM.

The lifecycle state machine and guardrail policy live in `apps/server/src/domain/` rather than a fifth package: they are pure, unit-testable, and consumed only by the server. Promoting them to a package would be structure without benefit.

---

## 3. Frontend approach

**React 18 + Vite + TypeScript + React Router.** Plain hand-written CSS in one stylesheet with CSS custom properties — no Tailwind, no component library, no state-management library.

Rationale: spec §23 says "V1 should favour functionality over elaborate design". Server state is fetched with a tiny typed `api.ts` client and local `useState`/`useEffect`; there are perhaps a dozen endpoints. Adding React Query or Redux now would be infrastructure serving a hypothetical future.

The Vite dev server proxies `/api` to the backend so the session cookie is same-origin in development and production alike, which removes an entire class of CORS/`SameSite` problems.

**Live updates:** the Run Detail screen **polls** (`GET /api/runs/:id/logs?afterSeq=N`, 1.5 s interval, monotonic cursor). Spec §32 permits "streamed **or** polled logs". Polling is a dozen lines, has no connection-lifecycle bugs, survives proxies, and resumes correctly after a browser sleep. SSE is a Sprint 2 optimisation with an already-correct fallback in place.

---

## 4. Backend approach

**Fastify 5 on Node 20, TypeScript, ESM.**

- Fastify over Express: first-class TypeScript types, built-in schema validation hooks, and a plugin/encapsulation model that maps cleanly onto "two auth planes that must not leak into each other".
- Validation with **zod** at every boundary. Requests are parsed into typed values; unparsed request bodies never reach a service.
- Layering: `routes → services → db`. Routes do auth, parse, and shape HTTP. Services own transactions, guardrails and audit writes. Domain is pure.
- **Every state-changing service call writes its audit event inside the same transaction as the state change.** An audit event cannot be lost while its effect persists, and it cannot describe something that rolled back.

**Testing framework:** Vitest for everything (server integration, domain unit, worker, e2e), so there is one runner and one config style.

---

## 5. Database choice

**PostgreSQL 16**, run locally with a two-service `docker-compose.yml` (app database + test database), accessed through **Drizzle ORM** with **drizzle-kit**-generated plain SQL migrations.

- Postgres matches the eventual production target, gives real transactions for the approval/dispatch critical section, `JSONB` for audit metadata and worker capabilities, and `SELECT ... FOR UPDATE SKIP LOCKED` for lease dispatch.
- Drizzle over Prisma **specifically to reduce lock-in**: migrations are checked-in `.sql` files that any Postgres tool can apply, and the schema is ordinary TypeScript. There is no query engine binary and no proprietary schema language. If Drizzle is abandoned later, the migrations and the database survive it.
- SQLite was rejected: audit immutability is enforced with a Postgres trigger, and the lease uses `SKIP LOCKED`.

---

## 6. Authentication approach

Two **separate, non-overlapping** authentication planes. This separation is the single most important security decision in the sprint, because the worker plane will eventually be reachable from a VM that executes code.

### 6.1 Human plane (`/api/*` except `/api/worker/*`)

- `users` table; passwords hashed with **scrypt** from `node:crypto` (N=16384, r=8, p=1, 16-byte random salt, 64-byte key, constant-time compare). No native dependency, no argon2 build step on the VM.
- Login issues an **opaque 32-byte random session token**, stored only as a SHA-256 hash in `sessions`, returned as an `HttpOnly; SameSite=Lax; Path=/` cookie (`Secure` when `NODE_ENV=production`).
- Sessions are server-side and therefore **revocable** — the property that matters most for a system that will control autonomous agents. JWTs were rejected for exactly this reason.
- Roles: `admin` > `operator` > `viewer`. Approving, rejecting and cancelling runs require `operator`. Changing settings and creating enrollment tokens require `admin`. `viewer` is read-only.
- Login is rate-limited (5 attempts / 5 min / IP+email); failures emit `auth.login_failed` audit events.

### 6.2 Worker plane (`/api/worker/*`)

Described in §9 below. A worker token is **never** accepted on a human route and a session cookie is **never** accepted on a worker route; the two are separate Fastify plugin scopes with separate `preHandler` hooks, so this is structural rather than a convention.

### 6.3 What is deliberately not built

No SSO/Entra ID, no password reset email, no MFA. Spec §2 says Mac will eventually have a Microsoft identity; wiring Entra now would mean building an integration Sprint 1 explicitly excludes. The `users` table is the seam.

---

## 7. Data model

All ids are UUID v4 (`gen_random_uuid()`), all timestamps `timestamptz`.

```
users(id, email UNIQUE, name, role, password_hash, password_salt,
      is_active, created_at, updated_at)

sessions(id, user_id→users, token_hash UNIQUE, expires_at, created_at,
         revoked_at, last_seen_at, user_agent, ip)

settings(id=1 singleton CHECK, timezone, overnight_cutoff, currency,
         default_confidence_threshold, min_execution_confidence,
         nightly_budget_cents, budget_warning_pct, budget_stop_pct,
         heartbeat_interval_seconds, heartbeat_grace_seconds,
         updated_at, updated_by→users)

projects(id, name, slug UNIQUE, description, repo_url, repo_default_branch,
         is_active, created_at, updated_at, created_by→users)

tasks(id, project_id→projects, title, description, status, priority,
      confidence, created_at, updated_at, created_by→users)

runs(id, task_id→tasks, status, worker_id→workers, approval_state,
     confidence, job_kind, job_params JSONB, execution_mode,
     overnight_deadline_at, lease_expires_at, attempt,
     progress_percent, progress_stage, summary,
     cancel_requested_at, cancel_requested_by→users, stop_reason,
     started_at, completed_at, created_at, updated_at, created_by→users)

workers(id, name UNIQUE, status, capabilities JSONB, last_heartbeat_at,
        current_run_id→runs, token_hash UNIQUE, token_prefix, version,
        platform, registered_at, created_at, updated_at)

worker_enrollment_tokens(id, label, token_hash UNIQUE, created_by→users,
                         expires_at, used_at, used_by_worker_id, created_at)

approvals(id, run_id→runs, action, approver_user_id→users, notes,
          confidence_at_decision, threshold_at_decision,
          threshold_overridden, created_at)

run_logs(id BIGSERIAL, run_id→runs, seq, ts, stream, message, created_at,
         UNIQUE(run_id, seq))

run_usage(id, run_id→runs, provider, kind, quantity, unit, cost_cents,
          is_exact, recorded_at, metadata JSONB)

audit_events(id, ts, actor_type, actor_id, actor_label, event_type,
             project_id, task_id, run_id, worker_id, metadata JSONB)
```

Field-level mapping to the required domain objects is in §21.

### Enumerations

| Enum | Values |
|---|---|
| `user_role` | `admin`, `operator`, `viewer` |
| `task_status` | `draft`, `ready`, `in_progress`, `blocked`, `done`, `cancelled` |
| `task_priority` | `low`, `normal`, `high`, `urgent` |
| `run_status` | `draft`, `discovery`, `ready_for_approval`, `approved`, `queued`, `running`, `blocked`, `self_review`, `ready_for_human_review`, `completed`, `stopped_by_guardrail`, `cancelled`, `failed` |
| `approval_state` | `not_required`, `pending`, `approved`, `rejected`, `revoked` |
| `worker_status` | `registered`, `idle`, `busy`, `offline`, `disabled` |
| `execution_mode` | `interactive`, `overnight` |
| `actor_type` | `user`, `worker`, `system` |

`run_status` is spec §24's twelve states **plus `failed`**. Spec §24 offers "suggested states" and has no way to express "the job ran and returned a non-zero outcome" — folding that into `completed` would make the dashboard lie. Recorded as assumption A-1.

### Run lifecycle state machine

```
draft ─────────────► discovery ──┐
  │                              │
  ├──────────────────────────────┴──► ready_for_approval
  │                                        │  reject
  │◄───────────────────────────────────────┘
  │                                        │  approve
  │                                        ▼
  │                                    approved ──► queued ──► running
  │                                                    │          │
  │                                                    │   ┌──────┼────────────┐
  │                                                    │   ▼      ▼            ▼
  │                                                    │ blocked self_review  failed*
  │                                                    │   │      │
  │                                                    │   └──────┤
  │                                                    │          ▼
  │                                                    │  ready_for_human_review
  │                                                    │          │
  └──► cancelled* ◄────(any non-terminal)              │          ▼
       stopped_by_guardrail* ◄──(queued/running/blocked)      completed*
                                                              (* terminal)
```

Transitions are declared as a single table in `domain/run-lifecycle.ts` and are the **only** way run status changes. Terminal states have no outgoing edges; attempting to leave one is a `409 INVALID_TRANSITION` plus a `run.transition_rejected` audit event.

Sprint 1's happy path is `draft → ready_for_approval → approved → queued → running → completed`. `discovery`, `blocked`, `self_review` and `ready_for_human_review` are implemented in the state machine (so the model is complete and tested) but are not driven by the Sprint 1 worker, which has no discovery or self-review behaviour to drive them.

---

## 8. Worker communication architecture

**Worker-initiated HTTP over TLS. The control plane never dials the worker.**

This is the decisive choice, and it is made for security and operability rather than elegance: the worker VM needs **no inbound ports, no public address, and no certificate**. Firewall policy on the VM can be egress-443-only. A control plane that had to reach into the worker would be a far larger attack surface for a machine that will eventually run coding agents.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/worker/register` | POST | Exchange an enrollment token for a worker identity + token |
| `/api/worker/heartbeat` | POST | Liveness + status; **response carries pending commands** |
| `/api/worker/lease` | POST | Long-poll (≤25 s) for an approved, queued run |
| `/api/worker/runs/:id/progress` | POST | Stage/percent updates |
| `/api/worker/runs/:id/logs` | POST | Batched append-only log lines |
| `/api/worker/runs/:id/complete` | POST | Terminal outcome + stop reason |

**Every** worker-facing response body carries a `control` envelope:

```jsonc
{ "control": { "cancelRequested": true, "runId": "...", "serverTime": "...",
               "heartbeatIntervalSeconds": 10 } }
```

so cancellation reaches the worker on whichever call happens next — heartbeat, log upload or progress — not only on the heartbeat. This is why cancellation latency is bounded by the log-batch interval (~1 s) rather than the heartbeat interval (10 s).

Long-polling on `/lease` was chosen over WebSockets because it gives near-instant dispatch with no connection state to resurrect, no sticky-session requirement if the control plane is ever put behind a load balancer, and trivially correct behaviour on network loss (the poll simply fails and is retried).

**Network-loss recovery.** The worker treats every call as retryable with full jitter exponential backoff (1 s → 30 s cap). Log lines are buffered in memory with a bounded ring (5 000 lines; overflow is recorded as a dropped-line marker so truncation is visible rather than silent) and re-sent on the next successful call. Log batches carry a per-run monotonic `seq`; the server upserts on `(run_id, seq)` so a retried batch is idempotent rather than duplicated. A job keeps executing while the network is down and reports its outcome when connectivity returns; `complete` is retried until acknowledged.

---

## 9. Worker authentication

Two-stage, so that the long-lived credential never has to be typed onto the VM by a human.

1. **Enrollment.** An admin creates a single-use enrollment token in the UI (`POST /api/worker-enrollment-tokens`). The plaintext is shown **once**; only a SHA-256 hash is stored, along with an expiry (default 24 h).
2. **Registration.** The worker posts its name, capabilities, version and platform with `Authorization: Bearer <enrollment-token>`. The server verifies the hash, checks it is unused and unexpired, marks it consumed, creates the `workers` row and returns a freshly generated **worker token** (`mac_wk_` + 32 random bytes, base64url). Only its SHA-256 hash and a display prefix are stored. The worker persists it to a state file (`0600`) and reuses it across restarts.
3. **Operation.** All other worker endpoints require the worker token. The lookup is by hash; the resolved `workerId` is authoritative.

**Authorisation, not just authentication.** A worker token grants access *only* to `/api/worker/*`, and within that, only to runs where `runs.worker_id = <authenticated worker id>`. Posting logs, progress or completion for another worker's run is `403`, audited. Workers cannot read projects, tasks, settings, audit events or other workers.

Token rotation, per-capability scoping and mTLS are out of scope; the token-hash column makes rotation a later additive change.

---

## 10. Heartbeat mechanism

- Worker `POST /api/worker/heartbeat` every `settings.heartbeat_interval_seconds` (default **10 s**) with `{ status, currentRunId, metrics }`.
- Server sets `workers.last_heartbeat_at = now()`, reconciles `workers.status` (`idle`/`busy`), and returns the control envelope including any pending cancel.
- A **liveness sweeper** runs every 15 s: any worker whose `last_heartbeat_at` is older than `heartbeat_interval_seconds + heartbeat_grace_seconds` (default 10 + 20 = 30 s) is marked `offline` and emits a `worker.offline` audit event. Returning workers emit `worker.online`.
- If an offline worker held a run in `running`, the run is **not** silently failed — it is left running with a visible "worker offline" indicator in the UI, and an operator may force-cancel. Silently killing a run whose worker had a 40-second network blip would destroy real work; that decision belongs to a human in Sprint 1.
- Heartbeats do **not** write audit events (that would be ~8 600 rows/day of noise). Only `worker.online` / `worker.offline` transitions are audited.

---

## 11. Task / run dispatch mechanism

The database is the queue. Dispatch is one statement inside one transaction:

```sql
UPDATE runs SET status='running', worker_id=$1, started_at=now(),
                lease_expires_at=now() + interval '120 seconds', attempt=attempt+1
WHERE id = (
  SELECT id FROM runs
   WHERE status = 'queued'
     AND approval_state = 'approved'      -- ← the approval guardrail, in SQL
     AND cancel_requested_at IS NULL
     AND (overnight_deadline_at IS NULL OR overnight_deadline_at > now())
   ORDER BY priority_rank, created_at
   FOR UPDATE SKIP LOCKED
   LIMIT 1)
RETURNING *;
```

`SKIP LOCKED` means the dispatch is already correct for multiple workers even though Sprint 1 has one. The `approval_state = 'approved'` predicate means **an unapproved run is not merely rejected by application code — it is unselectable**, which is the strongest available form of the spec's primary guardrail.

Before returning the assignment the server re-validates the job against the Sprint 1 allowlist (§16), so a run whose `job_kind` was somehow written by an older or compromised path still cannot dispatch.

The long-poll holds for up to 25 s, checking every 500 ms, then returns `204` so the worker loops.

Leases are extended by heartbeat/progress. Lease expiry is recorded but does **not** auto-fail a run in Sprint 1, for the same reason as §10.

---

## 12. Logging mechanism

- Worker buffers structured log lines `{ seq, ts, stream, message }` where `stream ∈ {stdout, stderr, system}`.
- Flush every **1 s** or **200 lines**, whichever first, to `POST /api/worker/runs/:id/logs`.
- Server appends to `run_logs`, ignoring conflicts on `(run_id, seq)` — retries are idempotent.
- UI reads `GET /api/runs/:id/logs?afterSeq=N&limit=500`, polling at 1.5 s while the run is live.
- Message length is capped at 4 KB server-side and batch size at 500 lines; oversize input is truncated with an explicit marker, never rejected silently. This is a denial-of-service boundary: the worker is a semi-trusted client.
- Application logging (the server's own) uses Fastify's built-in pino, at `info` in dev. Run logs and application logs are deliberately different things stored in different places.

---

## 13. Stop / cancel mechanism

Cancellation is **request → propagate → acknowledge**, never fire-and-forget:

1. Operator hits `POST /api/runs/:id/cancel { reason }`.
2. If the run has not yet been dispatched (`draft`, `discovery`, `ready_for_approval`, `approved`, `queued`), it goes straight to `cancelled` with `stop_reason` — no worker is involved.
3. If the run is `running` or `blocked`, the server sets `cancel_requested_at` / `cancel_requested_by` and **leaves the status alone**. The UI shows "cancelling".
4. The next worker call of any kind returns `control.cancelRequested = true`. The worker aborts the job via its `AbortSignal`, flushes logs, and calls `complete` with `outcome: 'cancelled'`.
5. The server transitions the run to `cancelled`, sets `completed_at`, and audits `run.cancelled`.
6. If the worker is unreachable, an operator with `operator` role may `POST /api/runs/:id/force-cancel`, which transitions immediately with `stop_reason = 'force_cancelled_worker_unreachable'` and an audit event that makes the forced nature explicit.

Guardrail stops (overnight cutoff, budget) use the same propagation path but terminate in `stopped_by_guardrail` with a machine-readable `stop_reason`.

---

## 14. Audit-event model

`audit_events` is append-only and **enforced as such by the database**: a `BEFORE UPDATE OR DELETE` trigger raises an exception. Application code has no update or delete path, and the table has no such route. This matters because the audit trail is the artefact that makes an autonomous agent reviewable.

Every row records: `ts`, actor (`actor_type`, `actor_id`, `actor_label` — the label is denormalised so the trail stays readable after a user is renamed or removed), `event_type`, the `project_id` / `task_id` / `run_id` / `worker_id` context available, and a `JSONB` `metadata` blob.

Events are written **in the same transaction** as the change they describe.

Event types emitted in Sprint 1:

| Domain | Events |
|---|---|
| auth | `auth.login`, `auth.login_failed`, `auth.logout` |
| project | `project.created`, `project.updated` |
| task | `task.created`, `task.updated` |
| run | `run.created`, `run.submitted_for_approval`, `run.approved`, `run.rejected`, `run.queued`, `run.dispatched`, `run.progress_stage_changed`, `run.completed`, `run.failed`, `run.cancel_requested`, `run.cancelled`, `run.force_cancelled`, `run.stopped_by_guardrail`, `run.transition_rejected` |
| worker | `worker.enrollment_token_created`, `worker.registered`, `worker.online`, `worker.offline`, `worker.unauthorized_run_access` |
| guardrail | `guardrail.blocked` |
| settings | `settings.updated` |

Deliberately **not** audited: individual heartbeats, individual log lines, read requests. Auditing those produces volume that makes the trail unreadable, which is the practical failure mode of audit systems.

---

## 15. Confidence representation

Confidence is a **`numeric(4,3)` in `[0,1]`** everywhere (`0.850`), rendered as a percentage in the UI. A single unambiguous internal unit avoids the classic 0.85-vs-85 bug class.

Two configurable levels, both in `settings`, encoding spec §5:

- `min_execution_confidence` (default **0.60**) — a **hard floor**. Spec §5: "Below 60% — Mac must not begin substantive implementation." An approval attempt below this floor returns `409 CONFIDENCE_BELOW_FLOOR` and **cannot be overridden** through the API.
- `default_confidence_threshold` (default **0.80**) — the autonomy threshold. Spec §5 lets 60–79 % proceed only with an explicit human decision on limited scope. So approval in the band `[floor, threshold)` is permitted **only** when the approver sends `acknowledgeBelowThreshold: true` **and** non-empty `notes`. The `approvals` row records `confidence_at_decision`, `threshold_at_decision` and `threshold_overridden`, and a distinct audit event is emitted.

This means the 60/80/90 bands of spec §5 are represented as data, are configurable as the spec requires, and are enforced in the backend rather than in a prompt.

---

## 16. Sprint 1 job catalogue (the execution allowlist)

**There is no shell execution anywhere in this system.** The UI cannot express a command, the protocol has no command field, and the worker has no code path that spawns a process. Job kinds are a closed enum implemented as pure TypeScript functions:

| `job_kind` | Params (zod-validated, bounded) | Behaviour |
|---|---|---|
| `noop` | — | Logs start/finish immediately |
| `echo` | `message` (≤ 500 chars) | Writes the message to the run log |
| `sleep` | `seconds` (1–120) | Sleeps in 250 ms slices, emitting progress; fully cancellable |
| `system_info` | — | Reports `os.platform/arch/release`, cpu count, total memory, node version |
| `workspace_check` | — | Stats the configured workspace directory; reports existence and writability |
| `fail` | `message?` | Fails deliberately — exists so the failure path is testable |

The catalogue lives in `packages/protocol/src/jobs.ts` and is validated **three times**: at run creation, again at dispatch, and again in the worker before execution. A worker that receives an unknown `job_kind` refuses it and completes the run as `failed` with `stop_reason = 'unsupported_job_kind'` rather than guessing.

**Extensibility without speculation:** adding a capability later means adding one entry with a zod schema and one handler function. Workers advertise `capabilities` at registration, so capability-aware routing is an additive change to the dispatch predicate. No abstraction is built for it today.

---

## 17. Budget configuration

- `settings`: `nightly_budget_cents`, `currency`, `budget_warning_pct` (80), `budget_stop_pct` (100).
- `run_usage` records provider usage with an explicit **`is_exact`** boolean and a nullable `cost_cents`. This directly encodes spec §25's rule that an estimate must never be presented as exact provider usage.
- `GET /api/budget/status` returns the configured budget, spend recorded for the current night window, and `providerUsageAvailable: false` — because in Sprint 1 nothing writes usage rows. The UI displays "Provider usage unavailable", the exact wording spec §25 requires.
- The dispatch guardrail `assertBudgetAvailable` genuinely sums `run_usage` for the window and blocks dispatch at `budget_stop_pct`. It is a real, tested guardrail that currently sums zero rows, rather than a stub — which is why the table exists at all.

The night window is `[previous cutoff, next cutoff)` in the configured timezone.

---

## 18. Overnight-cutoff configuration

- `settings.timezone` (default `Australia/Sydney`) and `settings.overnight_cutoff` (default `08:00`), both editable in Settings, matching spec §3 and §26.
- Runs carry `execution_mode`. `interactive` runs are human-authorised work happening now and are **not** subject to the cutoff — applying it to them would prevent daytime work, which the spec explicitly permits.
- When an `overnight` run is queued, the server computes and stores `overnight_deadline_at` = the next occurrence of the cutoff wall-clock time in the configured timezone. Storing the resolved instant means the deadline is stable and inspectable, and does not shift if someone edits settings mid-run.
- The **cutoff sweeper** (every 30 s) finds `running`/`blocked` overnight runs past their deadline and raises a guardrail stop, which propagates through the normal cancel path to `stopped_by_guardrail` with `stop_reason = 'overnight_cutoff'`.
- The dispatch predicate (§11) will not hand out a run whose deadline has already passed.

DST is handled by computing the deadline through the IANA zone database (`Intl.DateTimeFormat` with `timeZone`), not by fixed UTC offsets — relevant because Sydney observes DST.

---

## 19. Security boundaries

1. **Two auth planes, structurally separated.** Distinct Fastify scopes, distinct `preHandler`s, non-overlapping prefixes. A session cookie is rejected on `/api/worker/*`; a worker token is rejected everywhere else.
2. **Least privilege for workers.** A worker can act only on runs assigned to it; every other object is invisible. Cross-run access attempts are `403` and audited as `worker.unauthorized_run_access`.
3. **No arbitrary execution.** Closed job enum, bounded parameters, no shell, no `eval`, no dynamic import of job code, validated three times.
4. **Secrets are stored hashed.** Passwords (scrypt+salt), session tokens (SHA-256), worker tokens (SHA-256), enrollment tokens (SHA-256). Plaintext tokens are returned exactly once at creation and never retrievable. Constant-time comparison throughout.
5. **Immutable audit** enforced by database trigger, not convention.
6. **Guardrails in SQL where possible.** The approval check is a predicate in the dispatch statement, not an `if` a future refactor can drop.
7. **Input bounds everywhere.** Body size limit (256 KB), log batch caps, message truncation, numeric ranges — the worker is semi-trusted and its input is treated as hostile.
8. **Transport.** TLS is terminated by the deployment environment (out of Sprint 1 scope); the worker refuses a plaintext `http://` control-plane URL unless `MAC_ALLOW_INSECURE_HTTP=true`, which is intended for local development only and logs a loud warning.
9. **Headers and CORS.** `@fastify/helmet`; CORS allows only the configured web origin with credentials. Dev uses a Vite proxy so production and development share the same same-origin cookie model.
10. **Role gates.** `viewer` cannot mutate; `operator` cannot change settings or mint enrollment tokens; `admin` can.

**Known residual risks** are listed in §24.

---

## 20. Proposed file structure

```
mac-bennett/
├── package.json                    npm workspaces + top-level scripts
├── tsconfig.base.json
├── docker-compose.yml              postgres (app + test databases)
├── .env.example
├── README.md
├── Mac_Spec.md
├── docs/
│   └── sprint-1-design.md
├── packages/
│   └── protocol/
│       └── src/
│           ├── jobs.ts             job catalogue + param schemas
│           ├── enums.ts            run/task/worker/approval enums
│           ├── worker-protocol.ts  request/response schemas for /api/worker/*
│           ├── api.ts              DTOs shared with the web app
│           └── index.ts
└── apps/
    ├── server/
    │   ├── src/
    │   │   ├── index.ts            entrypoint
    │   │   ├── app.ts              Fastify assembly
    │   │   ├── config.ts           env parsing (zod)
    │   │   ├── db/
    │   │   │   ├── schema.ts       drizzle table definitions
    │   │   │   ├── client.ts
    │   │   │   └── migrate.ts
    │   │   ├── domain/
    │   │   │   ├── run-lifecycle.ts   transition table + validator
    │   │   │   ├── guardrails.ts      approval / confidence / budget / cutoff
    │   │   │   ├── confidence.ts
    │   │   │   └── overnight.ts       timezone-aware deadline computation
    │   │   ├── services/
    │   │   │   ├── audit.ts  auth.ts  projects.ts  tasks.ts
    │   │   │   ├── runs.ts   workers.ts  approvals.ts
    │   │   │   ├── logs.ts   settings.ts  budget.ts
    │   │   ├── http/
    │   │   │   ├── auth-plugin.ts     session auth + roles
    │   │   │   ├── worker-auth.ts     worker token auth
    │   │   │   ├── errors.ts          typed error → HTTP mapping
    │   │   │   └── routes/            auth, projects, tasks, runs, workers,
    │   │   │                          settings, audit, budget, worker/*
    │   │   ├── jobs/
    │   │   │   ├── heartbeat-sweeper.ts
    │   │   │   └── cutoff-sweeper.ts
    │   │   └── lib/  crypto.ts, ids.ts, time.ts
    │   ├── drizzle/                SQL migrations (checked in)
    │   ├── tests/                  unit, integration, e2e
    │   └── scripts/seed.ts
    ├── web/
    │   └── src/
    │       ├── main.tsx  App.tsx  api.ts  styles.css
    │       ├── components/
    │       └── pages/   Login, Dashboard, Projects, ProjectDetail,
    │                    Tasks, TaskDetail, Runs, RunDetail, Workers,
    │                    Audit, Settings
    └── worker/
        └── src/
            ├── index.ts        entrypoint / config
            ├── worker.ts       register → heartbeat → lease → execute loop
            ├── client.ts       HTTP client with retry + backoff
            ├── log-buffer.ts   bounded buffer + batched upload
            ├── state.ts        persisted worker token (0600)
            └── jobs/           one handler per allowed job kind
```

---

## 21. Required-field coverage

| Required object | Required fields | Where |
|---|---|---|
| **Project** | id, name, description, repository reference, active state, created at, updated at | `projects.id/name/description/repo_url(+repo_default_branch)/is_active/created_at/updated_at` |
| **Task** | id, project, title, description, status, priority, confidence, created at, updated at | `tasks.*` — all present |
| **Run** | id, task, status, worker, approval state, confidence, started at, completed at, stop reason, created at | `runs.*` — all present |
| **Worker** | id, name, status, last heartbeat, capabilities, current run | `workers.*` — all present |
| **Approval** | run, action, approver, timestamp, notes | `approvals.run_id/action/approver_user_id/created_at/notes` |
| **Audit Event** | timestamp, actor, event type, project, task, run, metadata | `audit_events.*` (+ `worker_id`) |

---

## 22. Testing strategy

Tests are written **alongside** each slice, not after. Three layers:

1. **Domain unit tests** (no I/O, milliseconds): the transition table (every legal edge accepted, a representative sample of illegal edges rejected, terminal states sealed), confidence guardrails at the 0.59/0.60/0.79/0.80/0.90 boundaries, overnight deadline computation across a Sydney DST boundary, budget threshold arithmetic.
2. **Integration tests** against a **real Postgres test database** with `app.inject()`: every route, both auth planes, role enforcement, and every guardrail. Each test file runs migrations once and truncates between tests, so tests are order-independent.
3. **End-to-end test** exercising the full spec §32 success criteria in one file, with the real worker loop driven against a real HTTP listener:

   > login → create project → create task → create run → submit → **assert dispatch is refused while unapproved** → approve → worker registers → heartbeats → leases the run → executes a harmless job → uploads logs → reports progress → completes → assert final status, logs, and that the audit trail contains the whole lifecycle in order.

   A second e2e case covers cancel-mid-run: dispatch a `sleep` job, cancel it, assert the worker observes `cancelRequested`, aborts, and the run ends `cancelled` with the audit trail intact.

Explicit coverage of the Step 8 list: task creation, run creation, approval, **rejected unapproved execution**, worker registration, heartbeat, job dispatch, run progress, cancellation, completion, invalid lifecycle transition, audit creation.

---

## 23. Implementation order

Each step ends green before the next begins.

1. Workspace scaffolding, TypeScript config, docker-compose, `.env.example`.
2. `packages/protocol` — enums, job catalogue, worker protocol schemas.
3. Database schema + initial migration + audit-immutability trigger; migration runner.
4. Domain layer + its unit tests (state machine, guardrails, overnight, confidence). **Pure, so it is proven before anything can depend on it.**
5. Server skeleton: config, error mapping, audit service, human auth plane, seed script. Integration tests for auth and roles.
6. Projects + tasks CRUD + tests.
7. Runs: create, submit, approve/reject, cancel + guardrail tests (this is where "unapproved cannot execute" is proven).
8. Worker plane: enrollment, register, heartbeat, lease, progress, logs, complete + tests.
9. Sweepers (heartbeat liveness, overnight cutoff) + tests.
10. Worker application + its own tests.
11. End-to-end tests (§22.3).
12. Web UI.
13. README, `.env.example` finalisation, developer setup verification, final self-review.

---

## 24. Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | A worker token leaking from the VM would let an attacker impersonate the worker. | Token is scoped to `/api/worker/*` and to its own runs only; stored `0600`; hashed server-side; rotation is an additive change. Not eliminated in Sprint 1. |
| R-2 | The job allowlist erodes over time until something takes a command string. | No command field exists in the protocol at all; adding one is a visible, reviewable schema change, not a config toggle. |
| R-3 | Cancellation not honoured by a wedged worker. | Force-cancel exists and is separately audited so a forced stop is never mistaken for a clean one. |
| R-4 | Long-poll connections held by a proxy with a shorter idle timeout. | Poll capped at 25 s (below the common 30/60 s defaults); worker treats a dropped poll as a normal empty result. |
| R-5 | Audit volume becoming unusable. | Heartbeats, log lines and reads are not audited; audit is for transitions and decisions only. |
| R-6 | Postgres required for the test suite raises onboarding friction. | Single `docker compose up -d`; domain unit tests run with no database at all. |
| R-7 | Clock skew between control plane and worker corrupting timing decisions. | All authoritative timestamps are server-side `now()`; worker timestamps are advisory and stored only on log lines. |
| R-8 | Sprint 1's `run_status` set may need to change once real coding-agent runs exist. | Transitions are a single declarative table; changing it is one edit plus one migration. |
| R-9 | No secret manager; env vars hold the database URL and session secret. | Documented limitation; `.env` is gitignored. Secret storage is a deployment concern deliberately out of Sprint 1 scope. |

---

## 25. Assumptions

| # | Assumption | Rationale |
|---|---|---|
| A-1 | `failed` added to spec §24's state list. | §24 states are "suggested" and cannot express a job that ran and did not succeed; folding failure into `completed` would misreport the dashboard. |
| A-2 | Overnight cutoff applies to `overnight` runs only, not `interactive` ones. | §3 permits explicitly authorised daytime execution; a global cutoff would forbid it. |
| A-3 | A run's job is chosen at creation from the Sprint 1 allowlist. | Sprint 1 has no coding agent to infer work; an explicit job makes the dispatch path real and testable. |
| A-4 | Approval is required for **every** run in Sprint 1. | §32 makes human approval a success criterion. `not_required` exists in the enum for future pre-approved classes but is never produced. |
| A-5 | A run whose worker goes offline stays `running` pending human decision. | Auto-failing on a transient network blip would destroy real work; §26 lists no such stop condition. |
| A-6 | Confidence is stored in `[0,1]`. | Single internal unit; percentage is a display concern. |
| A-7 | Local password auth for humans in Sprint 1. | Entra ID / Teams identity is explicitly out of Sprint 1 scope; `users` is the seam. |
| A-8 | Logs are polled, not streamed. | §32 permits either; polling is materially simpler and has no reconnection semantics to get wrong. |
| A-9 | Single control-plane process; sweepers run in it. | One worker, human-initiated runs. `SKIP LOCKED` dispatch is already multi-instance-safe if that changes. |
| A-10 | `run_usage` table ships with zero rows. | Makes the budget guardrail a real, tested code path rather than a stub, at the cost of one small table. |
| A-11 | Seeded admin credentials come from `.env` and must be changed. | Needed for a runnable system; documented prominently in the README. |

---

## 26. Design self-review against `Mac_Spec.md`

### 26.1 Omissions found and resolved

- **Task status was initially missing a `blocked` state** while runs had one; spec §7 treats blocking as first-class. Added to `task_status`.
- **`worker_id` was missing from the audit event model.** Step 4 lists project/task/run only, but worker registration and offline events have no run context and would have been unattributable. Added.
- **Actor label was missing.** Storing only `actor_id` makes the trail unreadable once a user row changes. Added denormalised `actor_label`.
- **No force-cancel path existed** for an unreachable worker, which would have made §27's "stop a run" a promise the system could not keep. Added, separately audited.
- **Log retry idempotency was unspecified**, which would have produced duplicated logs after a network blip. Resolved with `UNIQUE(run_id, seq)` + upsert.

### 26.2 Judged over-engineered and removed

- **SSE/WebSocket live streaming** — replaced with polling. Spec permits either.
- **A separate `packages/domain`** — folded into the server; only one consumer.
- **A job queue (BullMQ/Redis)** — the runs table with `SKIP LOCKED` is the queue.
- **A generic integration/plug-in abstraction** for monday.com, Teams, Claude Code, etc. — Step "Explicitly out of scope" warns against speculative abstractions. The seams that exist are concrete and load-bearing today: `worker.capabilities` for future job kinds, `run_usage.is_exact` for provider cost, `users` for future SSO. None is a framework.
- **Per-run cost estimation** — spec §25 forbids presenting estimates as provider usage; Sprint 1 reports "Provider usage unavailable" instead.

### 26.3 Vendor lock-in review

Avoided: no managed-cloud primitives (no Lambda/Cloud Run/SQS/Firebase), no proprietary auth provider, no ORM with a proprietary schema language (Drizzle emits plain SQL migrations), no hosted database service assumption (any Postgres 14+ works), no UI framework lock (plain CSS). The worker speaks documented HTTP+JSON, so a worker in another language is a straightforward port. The only meaningful commitments are Node/TypeScript and PostgreSQL, both explicitly chosen and both portable.

### 26.4 Security concerns raised by this review

1. Worker token is a bearer credential with no rotation in Sprint 1 (R-1) — accepted, scoped narrowly.
2. Log ingestion is a semi-trusted write path — bounded with size, count and length caps.
3. Long-polling ties up a connection per worker — fine at Sprint 1 scale; noted for revisit if worker count grows.
4. No secret manager (R-9) — deployment concern, explicitly out of scope.
5. Enrollment tokens are single-use and expiring, but an admin could mint many — mitigated by auditing creation and use.

### 26.5 Ambiguities in the spec, and how they were resolved

| Ambiguity | Resolution |
|---|---|
| §24 lists no failure state | Added `failed` (A-1) |
| "Configurable overnight cutoff" — applies to what exactly? | Applies to `overnight`-mode runs; stored as a resolved deadline (A-2, §18) |
| §5 thresholds "must eventually be configurable" | Made configurable now — it is two settings columns and removes a future migration (§15) |
| "Streamed **or** polled logs" | Polled (A-8) |
| "Worker" identity vs "Mac" identity | Sprint 1 workers are unattended job executors, not Mac; Mac's own reasoning loop is Sprint 2+ |
| Whether Sprint 1 needs multiple workers | Model and dispatch support N; documentation and setup describe one (A-9) |

### 26.6 Verdict

The design covers every Sprint 1 requirement in spec §32 and every item in the implementation brief. Nothing in it is built for a system larger than the one described. Proceeding to implementation.
