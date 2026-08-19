# Mac Bennett

Mac Bennett is a persistent AI Automation Engineer for PAC Technologies — intended eventually to
operate like an additional engineering employee who works overnight, delegates coding to agents such
as Claude Code, keeps a complete audit trail, and never merges to main on his own.

**This repository contains Sprints 1, 2, 3, 3.1, 3.2, 3.3 and Phase 4.**

Sprint 1 built and proved the control loop:

> a human creates work → a human approves it → a remote worker receives it → the worker executes a
> harmless action → progress and logs stream back → the run can be stopped remotely → everything is
> recorded in an immutable audit trail.

Sprint 2 put an autonomous coding engineer on top of it:

> a human describes work in their own words → Mac inspects the repository → Mac writes a structured
> handoff brief and calculates how well he understands it → a human approves → Mac creates an
> isolated git worktree → Mac delegates implementation to Claude Code → Mac supervises the session
> and answers its questions from recorded sources → tests run → Mac reviews his own work against
> the brief → Mac opens a pull request when it is warranted → a human reads a short morning report.

Sprint 3 turned that into a night shift:

> an engineer approves a project, a monday.com board and the items on it, and goes home → Mac picks
> the highest-priority eligible item, assigns it to himself and sets it In Progress → he works inside
> an OS-enforced sandbox that can reach the assigned worktree and nothing else on the machine → when
> a task finishes he leaves a pull request and moves the board to Ready for Review → when one blocks
> he posts what he needs, preserves the work and moves on to something else → he keeps going until
> the cutoff, the budget or an empty queue stops him → and one short email is waiting at 08:00.

**Mac never merges, and never touches the default branch.** That is enforced by application code in
three independent layers, not by a prompt.

The full product specification is in [`Mac_Spec.md`](Mac_Spec.md). The designs behind these
implementations, each with its self-review against that spec and its post-implementation notes, are
in [`docs/sprint-1-design.md`](docs/sprint-1-design.md),
[`docs/sprint-2-design.md`](docs/sprint-2-design.md) and
[`docs/sprint-3-design.md`](docs/sprint-3-design.md).

---

## Phase 4 capabilities

Mac becomes somebody you can work with, and stops being able to call work finished when it is not.

* **Persistent conversations.** One thread per piece of work, belonging to Mac rather than to a
  channel. Teams, the web UI and Forja all write to it, and all call the same handler — so a
  conversation begun in Teams and continued in the browser is one conversation rather than two that
  agree. Retrieval is structured: a summary plus a bounded tail, with decisions, corrections,
  project facts and unresolved questions carried forward from every summary.

* **Microsoft Teams.** A verified Bot Framework endpoint. Mac appears as an application named
  **Mac Bennett**, signed *Automation Engineer · PAC Technologies* — Teams provides no way for an
  application to post as a human account, and Mac does not pretend otherwise. Tell him to
  investigate something tonight and he raises the task, structures a brief, asks one question at a
  time, and comes back with an approval to press.

* **Approvals that cannot land on the wrong thing.** Every request carries a short code
  (`AP-4F2K`). "Sounds good" binds to nothing, ever — including when only one approval is
  outstanding, because the number outstanding changes between Mac asking and you answering. A stale
  card refuses by name. Spec §16's prohibitions are refused on **every** channel, including the web
  UI.

* **Controlled external web research.** A provider abstraction with three real implementations,
  source-quality classification, currency judgement, per-source provenance, and an injection defence
  that is structural rather than pattern-matched: a web page cannot change Mac's authority because
  the protocol has no field in which it could. Off by default and gated per project. *Nothing has
  been purchased and no account created* — each provider states exactly what it needs from a person.

* **Acceptance verification.** Machine-checkable criteria are derived onto the brief, frozen onto
  the run at approval, and checked before completion. A run that delivered some of what was asked
  for is `completed_with_gaps`, with the shortfall named in the morning report. A model may fail a
  criterion and may never pass one a count failed.

* **A Forja contract.** A fourth authentication plane with scoped API keys, narrow published
  projections, and an append-only event stream read by cursor. Every write names the person it acted
  for. Forja is an application, and never appears among the agents it orchestrates.

See [`docs/phase-4-completion-report.md`](docs/phase-4-completion-report.md) for what is proven, what
is not, and the eleven defects this phase found.

## Sprint 3.2 capabilities

Mac works from PAC Technologies' approved shared company context, and every
meaningful piece of work records exactly which revision of it applied.

* **Company context provider.** A bare Git mirror of
  `PacTechnologiesAus/Company`, refreshed with `git remote update` and read with
  `git show <sha>:<path>`. Because it is a mirror, an old commit's documents stay
  readable — so "show me the AUTHORITY.md this run worked under" has an answer,
  not just a SHA in a column.
* **Manifest-driven loading.** `context.yaml` declares the mandatory document
  set; Mac does not hardcode it. An unsupported schema version, a malformed
  manifest, a missing mandatory document or a present-but-empty one is a hard
  failure with a recorded reason, never a guessed default.
* **Provenance.** Discovery sessions, handoff briefs, runs and supervised
  answers each record the company-context revision that governed them. The
  binding is immutable — a database trigger refuses to move it — so a run that
  started at 02:00 stays attributable to the policy in force at 02:00 even if
  PAC revises it at 02:14.
* **Context selection.** `AUTHORITY.md` is carried in full on every piece of
  work, deterministically and with no keyword input, so hard authority content
  cannot be scored away by a task description that never mentions deployment.
  Task-relevant sections are selected on top of it.
* **Governance.** Mac may raise a proposal to change company context. He cannot
  apply one: the provider has no write verb, accepting a proposal produces no
  commit, and `accepted`/`rejected` require a human actor. Project knowledge
  never becomes company policy on its own.
* **Cached and offline behaviour.** When GitHub is unreachable, a previously
  validated revision may be used if an operator has permitted it — marked
  `cached` or `stale`, with its exact SHA and the last successful refresh time
  shown. With no valid revision, context-dependent work is refused rather than
  run on empty company context.
* **Forja is a platform, not an agent.** PAC's agent registry models agents and
  platforms as separate typed collections; `isPacAgent('forja')` is false.

Configure it with `MAC_COMPANY_CONTEXT_*` in `.env` (see `.env.example`) and
enable `companyContextEnabled` in Settings. It is off by default, like every
other integration that reaches an external service.

## Sprint 3 capabilities

| Capability | State |
|---|---|
| Coding sessions run inside an **OS-enforced sandbox** | OK bubblewrap or docker, one shared plan |
| The sandbox contains the agent **and the project's own test command** | OK `npm test` runs code the agent just wrote |
| Unrelated projects, home secrets and the worker's own credential are unreachable | OK proven against a real provider |
| A run that requires containment and cannot get it **fails** | OK no fallback to unconfined execution |
| Coding work is withheld from a worker that has not attested a sandbox | OK a predicate in the dispatch statement |
| Worker credentials **rotate**, with a bounded overlap | OK requested through the control envelope; no VM access needed |
| Credentials can be revoked instantly; a revoked token presented is audited | OK |
| monday.com: read boards, items, priority, status, assignee, due date, description | OK only from mapped, approved boards |
| monday.com: assign to Mac, In Progress, updates, blockers, PR links, Ready for Review | OK every write audited |
| monday.com: **cannot** change priority, due dates, delete anything, or restructure a board | OK no such method exists, and a guard refuses the column by name |
| Mark complete only where the board's workflow permits it | OK off by default |
| Project ↔ board ↔ repository mapping with explicit approval | OK two independent gates |
| Deterministic task-eligibility predicate | OK fourteen checks, no I/O, no model |
| Multi-task nights across projects, by monday.com priority | OK same project first |
| Safe-start check near the cutoff | OK size class, safety factor, wrap-up allowance |
| Every scheduling decision recorded, including the refusals | OK |
| Blocked work is preserved, posted and distinguishable from failed work | OK |
| Investigation across six source classes before any human question | OK the checked-source list is persisted |
| Evidence-based answers with derived groundedness | OK an ungrounded claim cannot be high-confidence |
| Model-backed resolvers behind the existing interfaces | OK off by default; fabricated citations dropped |
| Morning report **delivered** by email, idempotently and retryably | OK the send path has no recipient parameter |
| Night Shift, Night Queue, monday.com and Security screens | OK |

---

## Sprint 2 capabilities

| Capability | State |
|---|---|
| Discovery: explicit project selection, repository inspection, free-flow conversation | OK |
| Structured handoff brief, versioned and human-readable | OK |
| Understanding confidence derived from a weighted completeness checklist | OK explainable, not asserted |
| Execution prohibited below 0.60 confidence | OK non-overridable, even for an admin |
| Focused follow-up questions, one at a time, never asking what the repository answers | OK |
| Approved repositories, admin-gated | OK enforced in the dispatch SQL |
| Isolated git worktree and `mac/<task>-<slug>` branch per run | OK |
| **Never merge, push to, force-push or delete the default branch** | OK three enforcement layers |
| Claude Code CLI as the coding worker, behind a replaceable adapter | OK verified against the real CLI |
| Mac answers the agent's questions from brief, memory and repository | OK every Q&A persisted with sources |
| Low-confidence reversible decisions become flagged assumptions | OK |
| Unsafe decisions block that subtask and let the rest of the run continue | OK |
| Project tests and build run, with the result read rather than assumed | OK |
| Mac's self-review of his own diff against the brief | OK |
| Pull request opened only when seven conditions hold | OK no merge capability exists |
| Provider usage recorded as exact / observed / estimated / unavailable | OK never conflated |
| Concise morning report | OK |
| Overnight cutoff preserves the worktree and partial commits | OK |

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
└───────────┬──────────────┘         │  rotating worker-token auth   │
            │ /api/*                 │  ┌─────────────────────────┐  │
            │                        │  │ SANDBOX (bwrap/docker)  │  │
            │                        │  │  coding agent           │  │
            │                        │  │  project test command   │  │
            │                        │  └─────────────────────────┘  │
            │                        └───────────────┬───────────────┘
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

Exactly eight things, and nothing else:

| Job | Behaviour |
|---|---|
| `noop` | Starts and finishes immediately |
| `echo` | Writes a bounded message to the run log |
| `sleep` | Sleeps 1–120s, reporting progress; cancellable mid-run |
| `system_info` | Reports platform, arch, CPU count, memory, Node version |
| `workspace_check` | Verifies the workspace directory exists and is writable |
| `fail` | Fails deliberately, so the failure path is testable |
| `claude_code` | The coding job: worktree, coding agent, supervision, tests, self-review, pull request |
| `repo_inspect` | Read-only repository inspection for discovery |

The first six are pure TypeScript functions that spawn nothing at all.

The last two do execute processes, which is why their parameter schemas are worth reading:
**neither takes a command, a script, a path or an argument list.** They take identifiers, which the
control plane resolves against its own database into a repository and a brief. What actually runs is
fixed by worker code (git, the coding agent) or by an admin-configured argv array on the repository
row (the project's own test command). The protocol still has no field in which a shell command could
be expressed, so adding a coding agent did not turn the worker into a remote shell.

There are exactly three places that spawn a process, each with an argv array and `shell: false`:
`GitRunner`, `ClaudeCodeAdapter` and `TestRunner`. Job kind and parameters are validated three times:
at run creation, at dispatch, and again by the worker. Since Sprint 3 the last two spawn **inside the
sandbox**, and `GitRunner` — Mac's own code, not the agent's — stays outside it.

Adding a capability later means adding one entry to `packages/protocol/src/jobs.ts` and one handler —
a reviewable code change, never a configuration toggle.

### How "never merge to main" is actually enforced

Three independent layers. Any one of them would still work with the other two removed.

1. **Mac's own git access is a closed API.** `GitRunner` spawns git with an argv array, and every
   invocation is first classified by the pure policy in `packages/protocol/src/git-policy.ts`. There
   is no method to call that merges, force-pushes, or writes to the default branch.
2. **The coding agent's `git` is shimmed.** Before the agent starts, a directory is placed *first* on
   its `PATH` containing a `git` that re-validates argv against *the same policy module*, records any
   refusal, and exits non-zero. It binds regardless of what the agent's prompt said, and it fails
   **closed** — if the policy cannot be loaded, every git invocation is refused. The agent cannot
   push at all; Mac pushes the task branch himself afterwards.
3. **The effect is verified afterwards.** However an agent might have reached git, the default branch
   either moved or it did not. Mac re-reads the repository and compares it with the sha he recorded
   at the start. A discrepancy fails the run and blocks the pull request.

The prohibited set — merge into the default branch, push to it, force-push, delete it, bypass branch
protection, rewrite shared history — is **not configurable**. There is no setting, environment
variable or parameter that relaxes any of it.

### The execution sandbox (Sprint 3)

Layers 1–3 govern what the agent may do with **git**. They say nothing about the rest of the machine,
and Sprint 2's risk register admitted it: `cwd` was set to the worktree and the damage was inspected
afterwards, which is a convention rather than a boundary.

Sprint 3 draws a real one. Two things run agent intent and both go inside it:

* the **coding agent**, and
* the project's own **test and build command** — the non-obvious half, because `npm test` executes
  code the agent has just written.

Everything else stays outside: Mac's own policy-checked git, the evidence collection that judges the
agent's work, and anything holding the worker token.

Inside, the process can reach the run's worktree (rw), this repository's git metadata (rw), a
per-run scratch directory (rw), the git shim (**ro**, so the policy cannot be rewritten from inside)
and whatever tooling an administrator explicitly mounted. Everything else is not unreadable —
it is **absent**. No home directory, no other project, no other worktree, no `~/.ssh`, no `~/.aws`,
no worker state file. The environment is built from empty rather than filtered, so a secret-bearing
variable introduced later is excluded by default.

| Provider | When |
|---|---|
| `bubblewrap` | The production choice. No daemon, ~10 ms, identity paths, ordinary signal semantics. |
| `docker` | Portable, and the one available on a Windows development machine. Stronger mount namespace; its daemon is a real trust boundary. |
| `none` | Development only. The worker attests no containment, and the control plane withholds coding work from it. |

Both providers translate the **same plan**, and the plan holds every containment rule. This is one
policy with two back-ends, not two policies.

It fails closed in three places: the worker refuses to start a session without containment, the
dispatch statement removes `claude_code` from the capabilities of a worker that has not attested a
sandbox, and an invalid plan is a refusal rather than a crash. There is no path that degrades to
running unconfined.

```bash
MAC_SANDBOX_PROVIDER=auto                  # bubblewrap, then docker
MAC_SANDBOX_IMAGE=node:22-bookworm-slim    # must carry the project's toolchain
MAC_SANDBOX_TOOLING=/opt/toolchain         # optional, read-only, explicit
```

### Rotating a worker credential (Sprint 3)

Nobody logs into the VM. An admin presses **Request rotation** on the Security screen; the request
rides the control envelope, which is on every worker-facing response, so the worker picks it up on
its next call and replaces its own token. The previous credential stays valid for a short overlap
(300 s by default) so an in-flight request does not fail mid-rotation.

**Revocation** is the immediate one: every token dies at once with no grace period, and the worker
must re-enroll with a fresh single-use token. Presenting a revoked token is an audit event, because
it means a credential somebody deliberately killed is still in use.

A credential older than `workerTokenMaxAgeHours` (168 by default) is asked to rotate automatically.


---

## Letting Mac write code

### On the worker VM

| Requirement | Why |
|---|---|
| `git` | Worktrees, commits, and the shim's pass-through target |
| `claude` (Claude Code CLI), authenticated | The coding agent. `claude auth status` must report `loggedIn: true` |
| `gh` (GitHub CLI), authenticated | Opening pull requests. Without it the branch is still pushed and the run reports that no PR was opened |
| A clone of each approved repository | Mac fetches and creates worktrees from it; he never clones on demand |
| Push access for the `mac/*` namespace | Mac pushes only his own task branches |
| `typescript` installed (it is, via the monorepo) | The git shim transpiles the shared policy module at build time, and refuses to start a coding session if it cannot |

`MAC_CLAUDE_CLI_PATH` overrides CLI resolution for unusual installations.

### In the application

1. **Add the repository** (admin): remote URL, the clone's local path on the worker, the default
   branch, and optionally the project's own test and build commands.

   Test and build commands are **argv arrays**, not shell strings — `["npm","test"]`. Shells,
   process launchers and inline-program flags (`sh -c`, `env`, `node -e`) are refused, because the
   whole point of `shell: false` is that nothing interprets these arguments.

2. **Approve the repository** (admin). This is a separate, audited act; a repository is never
   approved at creation, and revoking approval makes existing runs against it undispatchable.

3. **Run discovery** (operator): select the project, describe the work, let Mac structure it and ask
   his question. Watch the confidence.

4. **Create a coding run and approve it.** Below 0.60 there is no run to approve. Between 0.60 and
   0.79 you approve a limited scope explicitly and say why.

5. **Read the report in the morning.**

## Letting Mac work a night

Sprint 2 let Mac execute one approved task. Sprint 3 lets him work a queue. Setting that up is five
deliberate acts, and they are deliberately separate.

1. **Approve the project for night shift** (admin). A project Mac may work in during the day is not
   automatically one he may take work from at 02:00.

2. **Map the monday.com board** (admin): its id, which column is status, which is assignee, which is
   priority and which is the due date. The last two are recorded precisely so that a write aimed at
   them can be refused *by name* — Mac has no method that sets either.

3. **Approve the board** (admin). Separate from mapping, because configuring an integration should
   not be the same gesture as authorising a machine to take work from it. Mac reads only from boards
   in this table, so he cannot roam every board the connected account can see.

4. **Mark the board night-shift eligible**, and **flag the items** Mac may take. The per-item flag is
   required by default: work he picks up at 02:00 should have been marked on purpose.

5. **Do discovery during the day**, as in Sprint 2, and record the monday item id on the task. This
   is the step that cannot be skipped: an item with no handoff brief has no understanding confidence,
   and Mac will not start it. He does not invent a brief for work he has never discussed.

Then press **Start night shift**. From there he selects the highest-priority eligible item, assigns
it to himself, sets In Progress, works, opens a pull request, moves the board to Ready for Review,
and picks the next one — preferring the project he is already in, because the repository is fetched
and the project memory is the one he has been reasoning with.

When something blocks he posts what he needs, preserves the worktree, does **not** mark it complete,
and moves on. Near the cutoff he stops starting things that cannot sensibly be left half-done. Every
one of those decisions, including the refusals, is on the Night Queue screen with its reasoning.

At the end he sends one short email — to the addresses configured in Settings, and to nowhere else:
the send path has no recipient parameter at all, so nothing from a task, a brief or a coding agent
can introduce an address.

### Settings that govern autonomy

| Setting | Default | Effect |
|---|---|---|
| `minExecutionConfidence` | 0.60 | Hard floor. Not overridable through the API by anyone |
| `defaultConfidenceThreshold` | 0.80 | Above it, approval needs no extra ceremony |
| `answerConfidenceThreshold` | 0.80 | At or above it Mac answers; below it he records a flagged assumption |
| `codingAgentEnabled` | true | Master switch for delegating work to a coding agent |
| `maxAgentMinutes` | 60 | Wall-clock ceiling on a coding session |
| `maxQuestionsPerRun` | 20 | Bounds an agent stuck in a question loop |
| `softUsageThresholdPct` | 80 | Warns on non-exact usage; its uncertainty stays visible |
| `overnightCutoff` / `timezone` | 08:00 Australia/Sydney | DST-correct. Preserves worktrees and partial commits |
| `nightShiftEnabled` | **false** | The master switch. With it off, no shift can be started whatever is approved |
| `requireSandbox` | true | A coding run is not dispatched to a worker without an attested sandbox |
| `workerTokenMaxAgeHours` | 168 | Past this, a worker is asked to rotate itself |
| `workerTokenOverlapSeconds` | 300 | How long a superseded credential keeps working |
| `nightShiftSafetyFactor` | 1.5 | An effort estimate is multiplied by this before it meets the clock |
| `nightShiftWrapUpMinutes` | 10 | Reserved for committing, testing, reviewing and reporting |
| `nightShiftMinStartMinutes` | 20 | Below this much runway, nothing new starts |
| `nightShiftLargeTaskMinMinutes` | 90 | A large task additionally needs this much |
| `reportRecipients` | — | The **only** place a morning-report recipient can be set |
| `allowedRecipientDomains` | — | An address outside these is refused and audited |
| `mailProvider` | none | `graph` sends from Mac's real mailbox |
| `modelAssistEnabled` | false | Off by default; the model never owns a safety decision |

---

## Testing

```bash
npm test                  # everything: 723 tests
npm run test:unit         # domain only, no database needed

# Opt-in, and each spends something real:
MAC_E2E_REAL_CLAUDE=1 npm run test -w @mac/worker            # real Claude Code CLI
MAC_MONDAY_LIVE_TEST=1 npm run test:integration -w @mac/server  # a real monday.com board
```

| Layer | What it covers |
|---|---|
| **Unit** (310) | Lifecycle state machine; confidence bands at 0.59/0.60/0.79/0.80/0.89/0.90 including genuine float-boundary hazards; the git policy against every prohibited form, including obfuscated ones (`HEAD:main`, `:main`, `+refs/heads/main`, `-c receive.*`); supervision decisions; self-review verdicts and PR eligibility; usage-source rules; report assembly; gap analysis; **the sandbox plan's containment rules**; **task eligibility**; **effort and safe-start**; **night scheduling and budget classification**; **investigation and grounding** |
| **Integration** (235) | Both auth planes and their separation, role enforcement, every guardrail, dispatch, logs, cancellation, schema parity, discovery, briefs, Q&A supervision, self-review, pull requests, usage, reports, memory scoping, the overnight cutoff on a live coding run; **credential rotation, revocation and the sandbox dispatch guardrail**; **monday.com reads, writes, refusals and the outbox**; **the night shift against a real database**; **model resolvers under adversarial scripts and email delivery** |
| **Worker** (169) | Log buffering and retry idempotency; job handlers; **the git shim as a real process**, refusing real prohibited commands against a real repository and failing closed; git and worktree behaviour against a real bare remote; the Claude Code adapter against a fake CLI; the execution boundary; **the sandbox plan and both providers' argv**; **containment proven against a real provider**; **the coding job's fail-closed path** |
| **End-to-end** (9) | Real server, real worker, real Postgres, real git. Sprint 1's control loop; Sprint 2's coding loop; and **a whole night**: two approved projects, three briefed monday items, one completed with a pull request, one blocked and posted, a project switch, the cutoff, exactly one delivered email, and the audit trail asserted in order with `main` proven untouched in both repositories |
| **Opt-in** (6) | The Sprint 2 loop against the **real** Claude Code CLI, and five checks against a **real** monday.com board. Neither runs by default. |

The normal suite needs no paid model usage and no external service: the coding agent, monday.com and
the mailbox are all substituted through the same interfaces production uses, and everything around
them — the worktree, the git shim, the sandbox, the supervision endpoints, the test runner, the
review, the scheduler, the outboxes — is the real implementation.

**The containment tests are not skipped here.** They run against whichever sandbox provider the host
has — bubblewrap on Linux, Docker anywhere — and skip only if it has neither, loudly. A boundary
whose enforcement has never been observed is one nobody should trust.

Integration and e2e tests need PostgreSQL (`npm run db:up`) and refuse to run unless
`TEST_DATABASE_URL` is set and differs from `DATABASE_URL` — they truncate tables, and pointing them
at development data would destroy it.

---

## Current limitations

Honest list of what this is not, as of Phase 4.

**Teams has never talked to Microsoft.** Every token in the suite is genuinely signed and genuinely
verified through the production code path, which covers everything except whether Microsoft accepts
the credential and whether a message arrives in somebody's client. No Azure Bot resource exists for
this work. `teams-live.test.ts` exercises exactly that gap and skips loudly without credentials.

**No web search has ever been performed.** Three providers are implemented against their real APIs
and none is configured, because adopting one is a commercial decision that belongs to a person at
PAC. The tool refuses honestly rather than returning an empty result, since a model reading zero
results will write down that the web says nothing about the subject.

**Conversation summarisation does not run.** The table, the schema, the retrieval path and the
carry-forward behaviour are all built and tested; nothing yet generates a summary when a thread grows
long, so a long thread relies on its twelve-message tail.

**Nothing POSTs a webhook to Forja yet.** Delivery rows are created and the signing is implemented
and tested. Cursor polling works and is what the contract test uses.

**The sandbox contains the filesystem, not git.** An agent inside it can reach the repository's `.git`
directory, because git has to work. What stops it moving the default branch is the three layers
Sprint 2 built — the closed API, the PATH shim, and the after-the-fact comparison of the default
branch sha — not the sandbox. The sandbox's guarantee is that it cannot reach *another* project, a
home directory, a credential store, or the worker's own token, and that guarantee is tested against a
real provider.

**Bubblewrap is the production provider and has not been exercised here.** The development machine is
Windows, so the containment suite ran against Docker. Both translate the same plan and the plan's
rules are unit-tested on every platform, but "bubblewrap enforced this" is a claim Sprint 3 has not
observed. Run `npm run test -w @mac/worker` on the Linux VM before relying on it.

**monday.com has only been exercised against an in-memory implementation.** The fake holds real state
and applies real writes, so the behaviour around the calls is genuinely tested — but that the GraphQL
documents and column-value shapes are accepted by the live API is unproven. `monday-live.test.ts`
exists for exactly this and needs a token and a dedicated board.

**Email has only been exercised against an in-memory provider.** The outbox, the idempotency, the
retry and the recipient guardrail are all real and tested; the Microsoft Graph client itself has not
sent a message.

**The authenticated UI has not been driven in a browser.** It typechecks, it builds, the SPA boots
without console errors, and every endpoint behind it is covered by integration tests — but nobody has
clicked through the new screens. Sprint 1 found a real CSS defect exactly that way.

**Mac still needs a human to prepare the work.** A monday item with no handoff brief has no
understanding confidence, so he will not start it. Discovery happens during the day, with a person;
the night shift executes what that produced. He does not invent briefs for items he has never
discussed, and the confidence model is why.

**Effort estimation is crude.** It produces a size class from the brief's shape and the board's own
size label, with the basis stated. It is used only to avoid obviously bad scheduling near the cutoff,
and it will sometimes be wrong in both directions.

**Acceptance-criteria assessment is evidence-seeking, not verification** (unchanged from Sprint 2).
Mac looks for each criterion's distinctive terms in the diff, the commits and the summary. This is
exactly why a pull request being opened still leaves the merge decision with a human.

**Question detection from the coding agent is a heuristic** (unchanged from Sprint 2). The CLI has no
explicit "I am asking you something" event.

**A dollar budget is not enforceable under subscription access** (unchanged from Sprint 2). The
Claude Code CLI reports exact token counts, but its dollar figure is a list-price equivalent, so it
is recorded as `estimated` and the scheduler's decision record says which of the hard or soft rule
applied. No subscription percentage exists, and none is invented.

**Model assistance is off by default and narrow when on.** It may improve the wording of an answer
Mac already grounded in his own sources. It never decides confidence, risk, eligibility, or whether
to execute; a citation it invents is dropped, and an answer citing nothing real is discarded
entirely.

**No Teams, HubSpot, Otto, voice, OpenClaw or Forger.** All explicitly out of Sprint 3 scope.

**Inherited from Sprint 1, unchanged:** logs are polled rather than streamed; local password auth
only; a run whose worker goes offline stays `running` pending a human decision; single control-plane
process; no production deployment, CI pipeline or secret manager.

**The largest residual risk** is now the sandbox provider's own trust boundary. Under Docker, a worker
that can reach the daemon socket can escape any container it starts — which is precisely why
bubblewrap, which has no daemon, is the production choice. Under either, a compromised worker token
still yields code execution on the VM; the token now rotates and can be revoked instantly, which
shortens the window rather than closing it.

---

## Next planned phase

Sprint 4 should build on a night shift that now demonstrably works end to end. In rough priority
order:

1. **Prove the two unproven integrations.** Run the containment suite under bubblewrap on the real
   Linux VM, and the live monday.com test against a dedicated board. Both are written and skipped.
2. **Microsoft Teams**, so a blocker at 02:00 reaches a person before 08:00 — the spec's intended
   notification channel, and the one thing that would make a blocked task less costly.
3. **Drive the UI in a browser**, including the night-shift screens, and fix what that finds.
4. **A second coding agent** (Codex), to prove the `CodingAgent` abstraction by using it twice.
5. **Otto collaboration** over real mailboxes, now that Mac can send email.
6. **Lease recovery**: a run whose worker never comes back still waits for a human. With multi-task
   nights, that idles the shift.

Sprint 4 should not need to revisit the control loop, the guardrails, the git safety model, the audit
model, the sandbox, or the scheduler.
