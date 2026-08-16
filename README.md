# Mac Bennett

Mac Bennett is a persistent AI Automation Engineer for PAC Technologies — intended eventually to
operate like an additional engineering employee who works overnight, delegates coding to agents such
as Claude Code, keeps a complete audit trail, and never merges to main on his own.

**This repository currently contains Sprint 1 only.** Sprint 1 deliberately builds none of that
autonomy. It builds and proves the control loop underneath it:

> a human creates work → a human approves it → a remote worker receives it → the worker executes a
> harmless action → progress and logs stream back → the run can be stopped remotely → everything is
> recorded in an immutable audit trail.

The full product specification is in [`Mac_Spec.md`](Mac_Spec.md). The design behind this
implementation, including its self-review against that spec, is in
[`docs/sprint-1-design.md`](docs/sprint-1-design.md).

---

## Sprint 1 capabilities

| Capability | State |
|---|---|
| Projects — create, inspect, activate/deactivate | ✅ |
| Tasks — create, inspect, priority, confidence | ✅ |
| Runs — create, submit, approve/reject, cancel | ✅ |
| Human approval required before any execution | ✅ enforced in SQL |
| Worker registration with single-use enrollment tokens | ✅ |
| Worker heartbeat and liveness detection | ✅ |
| Dispatch of a restricted set of harmless jobs | ✅ six job kinds, no shell |
| Progress reporting and log capture | ✅ polled, idempotent |
| Remote stop, propagated and acknowledged | ✅ ~1s latency |
| Immutable audit trail of every transition | ✅ enforced by DB trigger |
| Configurable confidence thresholds | ✅ |
| Configurable overnight cutoff, timezone-aware | ✅ |
| Nightly budget configuration and guardrail | ✅ real guardrail, no cost data yet |
| Operator web interface | ✅ |

**Not built in Sprint 1**, by design: Claude Code integration, Codex, OpenClaw, monday.com, Teams,
email, HubSpot, voice, Forger integration, production deployment, and any form of autonomous work
selection. See [Current limitations](#current-limitations).

---

## Architecture

A **modular monolith** control plane plus a **separate worker process**, as spec §31 requires.

```
┌──────────────────────────┐         ┌───────────────────────────────┐
│  Browser (React SPA)     │         │  Worker VM (Linux)            │
│  session cookie auth     │         │  @mac/worker                  │
└───────────┬──────────────┘         │  bearer worker-token auth     │
            │ /api/*                 └───────────────┬───────────────┘
            │                                        │ /api/worker/*
            │                                        │ (outbound only)
            ▼                                        ▼
┌───────────────────────────────────────────────────────────────────┐
│  @mac/server — Fastify control plane, single process              │
│    http/       routes, two isolated auth planes                   │
│    domain/     lifecycle state machine + guardrails (pure)        │
│    services/   projects, tasks, runs, workers, approvals, audit   │
│    db/         drizzle schema + plain SQL migrations              │
│    jobs/       sweepers: heartbeat liveness, overnight cutoff     │
└───────────────────────────┬───────────────────────────────────────┘
                            ▼
                   ┌──────────────────┐
                   │  PostgreSQL 16   │
                   └──────────────────┘
```

**Workspaces**

| Path | Purpose |
|---|---|
| `packages/protocol` | Shared zod schemas: job allowlist, enums, worker protocol, API DTOs. Consumed by all three apps, so the contract cannot drift. |
| `apps/server` | Control plane. Fastify 5, Drizzle ORM, PostgreSQL. |
| `apps/web` | Operator interface. React 18 + Vite. |
| `apps/worker` | Worker agent. Runs on its own Linux VM. |

There is deliberately **no** message queue, Redis, container orchestration, or microservice split.
The `runs` table is the queue and dispatch is a single `UPDATE … FOR UPDATE SKIP LOCKED`.

### Load-bearing design decisions

- **The worker never accepts inbound connections.** Every exchange is initiated by the worker over
  outbound HTTPS, so a worker VM needs no open ports, no public address and no certificate.
- **Approval is a SQL predicate, not an `if`.** The dispatch statement selects only rows with
  `approval_state = 'approved'`, so an unapproved run is *unselectable* rather than merely rejected.
- **Every worker response carries a control envelope.** Cancellation therefore reaches the worker on
  whichever call happens next — log upload, progress, or heartbeat — which is why a stop lands in
  about a second rather than waiting a heartbeat interval.
- **Audit events are immutable in the database.** A trigger raises on `UPDATE`, `DELETE` and
  `TRUNCATE`. They are written in the same transaction as the change they describe; events describing
  a *rejected* action are written out of band so they survive the rollback.
- **Sessions are server-side and revocable.** For a system that will direct autonomous agents, being
  able to kill a credential now matters more than avoiding a database lookup, so no JWTs.

---

## Local setup

**Prerequisites:** Node ≥ 20.10, npm ≥ 10, Docker (for PostgreSQL only).

```bash
git clone <this repository>
cd "mac bennet"

cp .env.example .env      # then edit SEED_ADMIN_PASSWORD

npm install               # install all workspaces
npm run db:up             # start PostgreSQL 16 in Docker (port 5433)
npm run db:wait           # block until it accepts connections
npm run migrate           # apply SQL migrations
npm run seed              # create the first administrator
```

Or, all of the above after `cp .env.example .env`:

```bash
npm run setup
```

> The example `SEED_ADMIN_PASSWORD` is `change-me-now`. Change it in `.env` before seeding, or the
> seed script will warn you. `npm run seed` is idempotent and never resets an existing password.

### Running it

Two terminals:

```bash
npm run dev          # control plane on :8080 and web UI on :5173
```

```bash
npm run dev:worker   # the worker (see below for its first start)
```

Then open **http://localhost:5173** and sign in with the seeded administrator.

`npm run dev` runs the server and web app together. The worker is a separate command on purpose — it
is meant to live on its own machine, and keeping it separate keeps that boundary visible.

| Command | Does |
|---|---|
| `npm run dev` | Control plane + web UI |
| `npm run dev:server` | Control plane only (`:8080`) |
| `npm run dev:web` | Web UI only (`:5173`, proxies `/api` to the server) |
| `npm run dev:worker` | Worker agent |
| `npm run migrate` | Apply pending SQL migrations |
| `npm run seed` | Create the seed administrator (idempotent) |
| `npm run db:up` / `db:down` | Start / stop PostgreSQL |
| `npm test` | Full test suite (server + worker) |
| `npm run test:unit` | Domain unit tests — **no database required** |
| `npm run test:integration` | HTTP + database integration tests |
| `npm run test:e2e` | End-to-end control loop |
| `npm run typecheck` | Typecheck every workspace |
| `npm run build` | Typecheck everything and build the web bundle |

### Database migrations

Migrations are hand-written, plain SQL files in `apps/server/drizzle/`, applied in filename order by
`apps/server/src/db/migrate.ts` and recorded in a `_migrations` table. They are forward-only: there
is no `down`. For a system whose entire purpose is an audit trail, "write a corrective migration" is
a better answer than "automatically undo the schema".

To add one: create `apps/server/drizzle/000N_description.sql` and run `npm run migrate`.

The enum values in those files are duplicated from `@mac/protocol` out of necessity.
`tests/integration/guardrails.test.ts` fails if the two ever drift, so the duplication is safe.

---

## Running a worker

The worker is designed to run as a service on Mac's dedicated Linux VM. It needs **outbound HTTPS
only** — no inbound ports.

**1. Mint an enrollment token.** In the UI, go to **Workers → New enrollment token**. The token is
shown exactly once; only its hash is stored. It is single-use and expires (24 h by default).

**2. Configure the worker.** On the worker machine, create a `.env`:

```bash
MAC_CONTROL_PLANE_URL=https://mac.internal.pac-technologies.com.au
MAC_ENROLLMENT_TOKEN=mac_en_…          # from step 1; needed only on first start
MAC_WORKER_NAME=mac-worker-01
MAC_WORKER_STATE_FILE=/var/lib/mac-worker/state.json
MAC_WORKER_WORKSPACE=/var/lib/mac-worker/workspace
```

**3. Start it.**

```bash
npm run dev:worker      # development
npm start -w @mac/worker
```

On first start the worker exchanges the enrollment token for a long-lived **worker token**, writes it
to `MAC_WORKER_STATE_FILE` with mode `0600`, and reuses it on every subsequent start. After that,
`MAC_ENROLLMENT_TOKEN` can be removed — a VM reboot needs no human.

The worker refuses to send its credentials over plaintext `http://` to anything other than localhost
unless `MAC_ALLOW_INSECURE_HTTP=true`, which is for local development only.

### What a worker can actually do

Exactly six things, and nothing else:

| Job | Behaviour |
|---|---|
| `noop` | Starts and finishes immediately |
| `echo` | Writes a bounded message to the run log |
| `sleep` | Sleeps 1–120s, reporting progress; cancellable mid-run |
| `system_info` | Reports platform, arch, CPU count, memory, Node version |
| `workspace_check` | Verifies the workspace directory exists and is writable |
| `fail` | Fails deliberately, so the failure path is testable |

These are pure TypeScript functions. **The worker contains no `child_process`, `exec`, `eval` or
dynamic `import`, and the protocol has no field in which a command could be expressed.** Job kind and
parameters are validated three times: at run creation, at dispatch, and again by the worker.

Adding a capability later means adding one entry to `packages/protocol/src/jobs.ts` and one handler —
a reviewable code change, never a configuration toggle.

---

## Testing

```bash
npm test                  # everything: 197 tests
npm run test:unit         # domain only, no database needed
```

| Layer | What it covers |
|---|---|
| **Unit** (66) | Lifecycle state machine, confidence bands at their boundaries, timezone-aware cutoff arithmetic across Sydney DST transitions, guardrail predicates |
| **Integration** (91) | Both auth planes and their separation, role enforcement, every guardrail, dispatch, logs, cancellation, schema parity |
| **Worker** (35) | Log buffering and retry idempotency, job handlers, abort behaviour, network-failure recovery, credential handling |
| **End-to-end** (5) | Real server, real worker, real Postgres: create → approve → dispatch → execute → log → complete, with the audit trail asserted transition by transition; plus remote cancel, the failure path, and identity reuse across restart |

Integration and e2e tests need PostgreSQL (`npm run db:up`) and refuse to run unless
`TEST_DATABASE_URL` is set and differs from `DATABASE_URL` — they truncate tables, and pointing them
at development data would destroy it.

---

## Current limitations

Honest list of what this is not, as of Sprint 1:

- **Mac does not think.** There is no reasoning loop, no discovery conversation, no confidence
  *estimation*. Confidence is a number a human types in. The `discovery`, `self_review` and
  `ready_for_human_review` lifecycle states exist and are tested, but nothing drives them yet.
- **No coding agent.** Claude Code, Codex and OpenClaw are not integrated. Workers execute six
  harmless jobs and nothing more.
- **No git operations.** Projects record a repository reference; nothing is cloned, branched or
  pushed.
- **No cost data.** The budget guardrail is real and tested, but nothing writes usage rows, so the UI
  reports "Provider usage unavailable" rather than inventing a number (spec §25).
- **No integrations.** monday.com, Teams, email, HubSpot and Forger are all out of scope.
- **Logs are polled, not streamed.** 1.5s interval. Spec §32 permits either; SSE is a Sprint 2
  optimisation with an already-correct fallback in place.
- **Local password auth only.** No SSO, MFA or password reset. The `users` table is the seam for
  Entra ID later.
- **Worker tokens do not rotate.** A leaked token is scoped to `/api/worker/*` and to that worker's
  own runs, but revoking it means disabling the worker and re-enrolling.
- **A run whose worker goes offline stays `running`** pending a human decision, deliberately — a
  40-second network blip must not destroy real work. Force-cancel exists for when it is genuinely
  wedged.
- **Single control-plane process.** The sweepers run in it. Dispatch is already multi-instance-safe
  (`SKIP LOCKED`) if that changes.
- **No production deployment.** Explicitly out of scope. There is no Dockerfile for the apps, no CI
  pipeline, and no secret manager — `.env` holds the database URL.

---

## Next planned phase

Sprint 2 should make Mac *do* something, on the loop Sprint 1 has proved. In rough priority order:

1. **Claude Code as a worker capability.** A `claude_code` job kind carrying an implementation brief,
   executed in an isolated git worktree, with the agent's output streamed into the existing run log.
   The allowlist, approval gate, cancellation and audit trail all apply unchanged — which is the
   whole point of having built them first.
2. **Git operations on the worker.** Clone, branch (`mac/<task>-<slug>`), commit, push. Never merge
   to the default branch — spec §14 makes that a hard rule, and it belongs in backend code, not a
   prompt.
3. **Discovery and confidence estimation.** A conversation surface that produces the structured brief
   of spec §4C, and populates confidence rather than having a human type it.
4. **Provider usage capture.** Write real rows to `run_usage` with `is_exact` set honestly, which
   turns the existing budget guardrail from correct-but-idle into load-bearing.
5. **Morning report** (spec §28) — the audit trail already contains everything it needs.
6. **monday.com**, then Teams, as the first external integrations.

Sprint 2 should not need to revisit the control loop, the guardrails, or the audit model.
