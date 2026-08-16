# Mac Bennett

Mac Bennett is a persistent AI Automation Engineer for PAC Technologies — intended eventually to
operate like an additional engineering employee who works overnight, delegates coding to agents such
as Claude Code, keeps a complete audit trail, and never merges to main on his own.

**This repository contains Sprints 1 and 2.**

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

**Mac never merges, and never touches the default branch.** That is enforced by application code in
three independent layers, not by a prompt.

The full product specification is in [`Mac_Spec.md`](Mac_Spec.md). The designs behind these
implementations, each with its self-review against that spec and its post-implementation notes, are
in [`docs/sprint-1-design.md`](docs/sprint-1-design.md) and
[`docs/sprint-2-design.md`](docs/sprint-2-design.md).

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
at run creation, at dispatch, and again by the worker.

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

---

## Testing

```bash
npm test                  # everything: 492 tests
npm run test:unit         # domain only, no database needed

# Opt-in, and it spends real subscription usage:
MAC_E2E_REAL_CLAUDE=1 npm run test -w @mac/worker
```

| Layer | What it covers |
|---|---|
| **Unit** (231) | Lifecycle state machine; confidence bands at 0.59/0.60/0.79/0.80/0.89/0.90 including genuine float-boundary hazards; the git policy against every prohibited form, including obfuscated ones (`HEAD:main`, `:main`, `+refs/heads/main`, `-c receive.*`); supervision decisions; self-review verdicts and PR eligibility; usage-source rules; report assembly; gap analysis |
| **Integration** (136) | Both auth planes and their separation, role enforcement, every guardrail, dispatch, logs, cancellation, schema parity, discovery, briefs, Q&A supervision, self-review, pull requests, usage, reports, memory scoping, and the overnight cutoff on a live coding run |
| **Worker** (117) | Log buffering and retry idempotency; job handlers; **the git shim as a real process**, refusing real prohibited commands against a real repository and failing closed; git and worktree behaviour against a real bare remote; the Claude Code adapter against a fake CLI; the execution boundary |
| **End-to-end** (8) | Real server, real worker, real Postgres, real git. Sprint 1's control loop, plus the whole Sprint 2 loop: discovery → brief → approval → worktree → coding agent → commit → tests → self-review → pull request → report, with the audit trail asserted in order and `main` proven untouched on the remote |
| **Opt-in** (1) | The same flow against the **real** Claude Code CLI. Skipped unless `MAC_E2E_REAL_CLAUDE=1`. |

The normal suite needs no paid model usage: the coding agent is substituted through the same
`CodingAgent` interface production uses, and everything around it — the worktree, the git shim, the
supervision endpoints, the test runner, the review — is the real implementation.

Integration and e2e tests need PostgreSQL (`npm run db:up`) and refuse to run unless
`TEST_DATABASE_URL` is set and differs from `DATABASE_URL` — they truncate tables, and pointing them
at development data would destroy it.

---

## Current limitations

Honest list of what this is not, as of Sprint 2.

**Mac's reasoning is retrieval, not a model.** Discovery structures a conversation with sentence
classification, and supervision answers questions by scoring recorded sources — the brief, project
and task memory, and the inspected repository. That buys three properties a model call would cost:
every answer cites what it came from, confidence falls out of match strength rather than fluency, and
the whole supervision path is testable with no paid usage. It also means Mac is literal-minded: a
question no source addresses gets a low-confidence conservative answer, not an insight. Replacing
`resolveAnswer` with a model-backed resolver is a drop-in change; the risk classification and
decision policy around it are the parts that must not be delegated to a model.

**Question detection from the coding agent is a heuristic.** The CLI has no explicit "I am asking
you something" event, so an assistant turn with no tool call whose text reads as a question is
treated as one. Missing a question means the agent proceeds on its own assumption — which the
self-review still inspects — rather than stalling.

**Acceptance-criteria assessment is evidence-seeking, not verification.** Mac looks for each
criterion's distinctive terms in the diff, the commits and the summary. It can be wrong in both
directions, which is exactly why a pull request being opened still leaves the merge decision with a
human.

**The agent could still write outside the worktree.** Its `cwd` is the worktree and `--add-dir` is
not passed, but nothing enforces filesystem containment at the OS level. The self-review inspects the
whole repository for unexpected changes. Proper sandboxing is Sprint 3 work.

**A dollar budget is not enforceable under subscription access.** The Claude Code CLI reports exact
token counts, but its dollar figure is a list-price equivalent of those tokens, not money billed —
so it is recorded as `estimated` and the UI says so. Only under API-key access does the monetary
budget become a hard limit. There is no subscription percentage available from the CLI at all, and
none is invented.

**Cross-project fallback scheduling is not implemented** (spec §8). A blocked subtask leaves the rest
of its own run continuing, but Mac does not move to another project.

**No integrations.** monday.com, Teams, email, HubSpot, Otto, voice and Forger are all out of scope,
as the Sprint 2 brief requires.

**Inherited from Sprint 1, unchanged:** logs are polled rather than streamed; local password auth
only; worker tokens do not rotate; a run whose worker goes offline stays `running` pending a human
decision; single control-plane process; no production deployment, CI pipeline or secret manager.

**The largest residual risk** is that a worker token now grants access to a machine that executes
code. The token's scope is unchanged — `/api/worker/*`, and within that only its own runs — and the
worker still executes only closed job kinds. That is a real reduction in blast radius, not an
elimination, and it is stated rather than mitigated away.

---

## Next planned phase

Sprint 3 should build on a loop that now demonstrably works. In rough priority order:

1. **Sandbox the coding agent's filesystem access**, so worktree containment is enforced by the OS
   rather than inspected after the fact.
2. **A model-backed resolver for discovery structuring and question answering**, behind the existing
   interfaces, keeping the risk classification and decision policy in code.
3. **monday.com** — assign, In Progress, progress updates, blockers, Ready for Review, PR links. A
   design-only sketch is all Sprint 2 was permitted to produce.
4. **Worker token rotation**, the one Sprint 1 security debt Sprint 2 deliberately did not repay.
5. **Multi-task nights**: task selection across an approved backlog, and the cross-project fallback
   of spec §8.
6. **Codex or a second coding agent**, to prove the `CodingAgent` abstraction by using it twice.

Sprint 3 should not need to revisit the control loop, the guardrails, the git safety model, or the
audit model.
