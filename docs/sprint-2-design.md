# Mac Bennett — Sprint 2 Implementation Design

**Status:** Approved for implementation
**Scope:** Sprint 2 — the autonomous coding worker.
**Builds on:** `docs/sprint-1-design.md` (control plane, worker, approvals, lifecycle, audit, guardrails)
**Source of requirements:** `Mac_Spec.md` §4–§16, §24–§28, plus the Sprint 2 brief.

Sprint 2 proves this loop:

> human describes work → Mac inspects the project → Mac produces a structured handoff brief →
> human approves → Mac creates an isolated worktree → Mac delegates to Claude Code → Mac supervises
> and answers questions → Claude implements and tests → Mac self-reviews → Mac opens a PR when
> appropriate → human gets a short morning report — **and main is never touched.**

---

## 1. Sprint 1 assessment

Sprint 1 was inspected in full and its suite re-run before any design work: **197 tests pass**
(162 server + 35 worker) against a real PostgreSQL 16 database. The control loop is healthy.

### 1.1 What Sprint 1 got right, and which Sprint 2 therefore extends rather than replaces

| Sprint 1 decision | Why Sprint 2 keeps it |
|---|---|
| **Two structurally separated auth planes** | Sprint 2 makes the worker VM execute a coding agent. The property "a worker token reaches only `/api/worker/*`, and within that only its own runs" becomes *more* load-bearing, not less. |
| **Worker-initiated HTTP only; no inbound ports** | A machine that now runs Claude Code, git and project test suites is exactly the machine that must not listen on a port. |
| **The runs table is the queue; approval is a SQL predicate** | An unapproved coding run must be *unselectable*, not merely rejected. Sprint 2 adds predicates to the same statement rather than a second dispatch path. |
| **`transition()` as the single choke point for run status** | Every new Sprint 2 state change (`self_review`, `blocked`, `ready_for_human_review`) goes through it and therefore audits itself. No new code path can forget. |
| **Audit written in the same transaction; `recordRejection` out of band** | Sprint 2 adds ~20 event types and one new refusal class (prohibited git operation). The existing distinction between "audit a change" and "audit a refusal" is exactly what that needs. |
| **Immutable audit enforced by DB trigger (incl. TRUNCATE)** | Untouched. Sprint 2 adds no update or delete path. |
| **Confidence stored as `numeric(4,3)` in `[0,1]`; floor non-overridable** | The Sprint 2 boundary tests (0.59/0.60/0.79/0.80/0.89/0.90) need exactly this, plus one correction — see §7. |
| **Closed job allowlist, validated three times, no command field** | Sprint 2 must add process execution without turning the worker into a remote shell. The allowlist model is how that is done safely: `claude_code` is *one more closed job kind*, not an escape hatch. |
| **Cancellation as request → propagate → acknowledge, with force-cancel** | A Claude Code session is a long-lived child process. This is the right cancellation shape for it; the adapter honours the same `AbortSignal`. |
| **Overnight cutoff stored as a resolved instant, DST-correct** | Retained verbatim. Sprint 2 only adds "preserve the worktree" to what happens at cutoff. |

### 1.2 Technical debt inherited, and what Sprint 2 does about it

| # | Sprint 1 debt | Sprint 2 action |
|---|---|---|
| T-1 | `run_usage` ships with zero rows; `providerUsageAvailable` is hard-coded `false`. | **Fixed.** Real usage is now captured from the Claude Code CLI, with an honest `source` (§10). |
| T-2 | Worker tokens have no rotation (R-1). | **Deferred, deliberately.** Still narrowly scoped. Sprint 2 does not widen worker authority beyond the new job kind, so the risk does not grow. Recorded again as R-2. |
| T-3 | Lease expiry is recorded but never acted on; an offline worker leaves a run `running`. | **Partially addressed.** Unchanged for correctness (auto-failing on a blip still destroys work), but a coding run now preserves its worktree, so a human recovering it loses nothing. |
| T-4 | `blocked`, `self_review`, `ready_for_human_review` exist in the state machine but nothing drives them. | **Fixed.** All three are now driven by real coding runs. |
| T-5 | No project/task memory, though spec §9 requires it. | **Added** — memory is a *source* for Q&A supervision, so Sprint 2 needs it to answer questions honestly. |
| T-6 | Confidence band comparisons use floating-point `<`. | **Fixed** — see §7.1. |
| T-7 | Duplicated enum lists between `schema.ts` and hand-written SQL. | Kept, and kept safe: the schema-parity test already fails if they diverge. Sprint 2 adds its enums to both and to that test. |

### 1.3 What is *not* being rewritten

No change to: the auth model, the dispatch statement's shape, the audit table, the lifecycle table's
existing edges, the log pipeline, the worker's register/heartbeat/lease loop, the overnight
computation, or the UI's architecture. Sprint 2 is additive.

---

## 2. Sprint 2 architecture at a glance

```
┌────────────────────────────────────────────────────────────────────────────┐
│  CONTROL PLANE  (@mac/server)                          "Mac, the manager"  │
│                                                                            │
│  discovery/       context inspection → free-flow → structured brief        │
│  briefs/          handoff brief, gap analysis, understanding confidence    │
│  supervision/     answers coding-agent questions from brief+memory+repo    │
│  review/          self-review verdict, PR eligibility                      │
│  reports/         morning report assembly                                  │
│  usage/           snapshots, source classification, budget separation      │
│  repositories/    approved repos, default branch, worktree registry        │
└───────────────┬────────────────────────────────────────────────────────────┘
                │  worker plane (outbound HTTPS only, unchanged shape)
                │  + 3 new endpoints: questions, agent-events, usage
                ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  WORKER  (@mac/worker)                                "Mac's workstation"  │
│                                                                            │
│  jobs/claude_code.ts   the coding job: the disciplined workflow            │
│  git/                  GitRunner (argv only, policy-checked), Worktrees    │
│  git/shim/             a `git` shim placed FIRST on the agent's PATH       │
│  coding/               CodingAgent interface                               │
│    ├── claude-code.ts  ClaudeCodeAdapter  (stream-json over stdio)         │
│    └── mock.ts         MockCodingAgent    (tests; no paid model usage)     │
│  testing/              project test/build runner (admin-configured argv)   │
└────────────────────────────────────────────────────────────────────────────┘
```

Mac reasons. The worker executes. **The worker never decides anything**: it forwards questions to
the control plane and applies the answer it gets back. That split is what keeps supervision
testable without a model, and keeps every decision in the audit trail.

---

## 3. Git and worktree architecture

### 3.1 Repository model

Repositories become a first-class table rather than two columns on `projects`, because Sprint 2
needs approval state, a local clone path, a fetch timestamp and a worktree registry per repository.

```
repositories(id, project_id→projects, name, remote_url, local_path, default_branch,
             remote_name, is_approved, approved_by→users, approved_at,
             last_fetched_at, last_known_default_sha,
             test_command jsonb, build_command jsonb,   -- argv arrays, admin-set
             created_at, updated_at)

worktrees(id, run_id→runs, repository_id→repositories, path, branch, base_branch,
          base_sha, head_sha, commit_count, status, created_at, released_at, removed_at)
```

**`is_approved` is the gate.** A run cannot be created against an unapproved repository, and the
dispatch predicate excludes runs whose repository is not approved — so revoking approval mid-flight
stops future dispatch without any application code remembering to check.

`test_command` and `build_command` are stored as **argv arrays** (`["npm","test"]`), settable by an
`admin` only, audited on change, and executed with `shell: false`. This is the one place a
project-specific command enters the system, and it deliberately cannot express a pipeline, a
redirect, or a metacharacter.

### 3.2 Per-run worktree lifecycle

```
1. resolve repository (must be approved)
2. git fetch --prune <remote>
3. resolve default branch  (repositories.default_branch, verified against remote HEAD)
4. record base sha = <remote>/<default>
5. git worktree add --detach <path> <base sha>
6. git switch -c mac/<task-short-id>-<slug>
7. ... all coding work happens here ...
8. record commits created during the run (rev-list base..HEAD)
9. preserve the worktree whenever a human must look at it
10. remove only when explicitly released
```

Branch naming: `mac/<task-id>-<slug>` where `<task-id>` is the task's short id and `<slug>` is a
kebab-cased, length-bounded, charset-restricted slug of the task title — e.g.
`mac/247-multi-device-selection`. Slug generation is pure and unit-tested, because a branch name is
an argv value and must never be able to smuggle a `--flag`.

**Preservation is the default.** A worktree is removed only when the run completed, a PR was
opened, and nothing needs human eyes. Cutoff, cancellation, failure, blockage and low-confidence
outcomes all preserve. Spec: *"Do not destroy useful work merely because the cutoff occurred."*

### 3.3 Hard git safety — enforced in three independent layers

The spec requires enforcement "by application code, not prompts alone". Prompts are not a layer
here at all; there are three real ones, and each works if the other two are removed.

**Layer 1 — Mac's own git access is a closed API.**
`GitRunner` spawns `git` with an **argv array and `shell: false`**. There is no string command
anywhere. Every invocation is first passed through the pure policy in
`@mac/protocol/git-policy.ts`, which classifies argv and returns `allowed` or a
`ProhibitedGitOperation` with a reason. `WorktreeManager` and `GitService` expose only the
operations Mac needs (fetch, worktree add/remove, switch -c, add, commit, rev-list, status, diff,
push-task-branch). Merge, force-push, and any write to the default branch have no method to call.

**Layer 2 — Claude Code cannot run git at all except through the shim.**
Before the agent starts, the worker writes a shim directory and prepends it to the agent process's
`PATH`. It contains `git` (POSIX sh) and `git.cmd` (Windows), both of which invoke a small Node
script that:

1. re-validates `argv` against the *same* `git-policy` module;
2. on rejection: prints the reason, appends a JSON record to a violations file the worker reads,
   and exits `77`;
3. on acceptance: `execFile`s the real git binary (resolved at shim-build time, not from `PATH`)
   with the identical argv.

So a coding agent that decides to `git push --force origin main` gets a non-zero exit and a
recorded, audited violation — regardless of what its prompt said. `--allowedTools` /
`--disallowedTools` are also set, but as defence in depth, never as the control.

**Layer 3 — post-run verification.**
After the session, Mac re-reads the repository and asserts:
`<remote>/<default>` still points at the base sha it recorded; HEAD is the task branch, not the
default; no merge commit reachable from the task branch has the default branch as a parent it
created; and the reflog contains no entry moving the default branch. A violation fails the run with
`stop_reason = 'prohibited_git_operation'` and blocks PR creation.

**Prohibited set (non-configurable in V1):**

| Prohibited | How argv is recognised |
|---|---|
| merge into the default branch | `merge`/`rebase` while HEAD is the default branch, or any `merge` with the default as target |
| push to the default branch | `push` with a refspec whose destination resolves to the default branch, including `HEAD:main`, `:main` and bare `push` while on default |
| force push | `push` with `-f`, `--force`, `--force-with-lease`, `--force-if-includes`, or a `+`-prefixed refspec |
| delete the default branch | `push --delete`, `push :main`, `branch -d/-D <default>` |
| bypass branch protection | `push --no-verify`, `-c` overrides of `receive.*`/`http.*`, `--exec` |
| rewrite shared history | `filter-branch`, `filter-repo`, `rebase` of published commits onto default, `reset --hard` while on default, `update-ref` / `symbolic-ref` targeting the default, `push --mirror`, `gc --prune=now` against a bare shared repo |
| **all pushes, from the agent** | Claude never pushes at all. Mac pushes the task branch himself, through the validated API. |

That last row deserves emphasis: the strongest available rule is not "let the agent push carefully",
it is *the agent has no push capability*, and the only pushing code in the system is a function that
refuses any destination that is not `refs/heads/mac/*`.

---

## 4. The coding-agent abstraction

Provider-neutral, defined in `@mac/protocol/coding-agent.ts` so the control plane, the worker and
the tests share one vocabulary and Mac's domain model never mentions Claude.

```ts
interface CodingAgent {
  readonly provider: string;                       // 'claude_code' | 'mock' | future
  start(task: CodingTask, ctx): Promise<CodingSessionHandle>;
  answer(sessionId, answer: AgentAnswer): Promise<void>;
  cancel(sessionId, reason): Promise<void>;
  usageSnapshot(phase): Promise<UsageSnapshot>;    // may report `unavailable`
}

type AgentEvent =
  | { type: 'session_started';  providerSessionId, model? }
  | { type: 'progress';         stage, message?, percent? }
  | { type: 'activity';         tool, detail? }          // tool/command visibility
  | { type: 'question';         questionId, question, context? }
  | { type: 'output';           stream: 'stdout'|'stderr', message }
  | { type: 'usage';            snapshot: UsageSnapshot }
  | { type: 'completed';        summary, filesTouched?, testsRun? }
  | { type: 'failed';           error, recoverable }
  | { type: 'cancelled';        reason };
```

`CodingTask` carries the **structured brief** — never the raw conversation alone (spec §12: "Mac
must not simply forward the human's raw prompt to Claude Code").

Two implementations ship: `ClaudeCodeAdapter` and `MockCodingAgent`. Codex and others are explicitly
not implemented; the interface is the extension point and nothing speculative is built for them.

---

## 5. The Claude Code adapter

### 5.1 What the installed CLI actually offers (investigated, not assumed)

Investigated against **Claude Code 2.1.233** on this machine:

| Capability | Verified finding |
|---|---|
| Non-interactive execution | `claude -p` works; `--output-format stream-json --verbose` emits newline-delimited JSON events. |
| Session events | `system/init` (carries `session_id`, `cwd`, tool list), `assistant` (text + `tool_use` blocks), `user` (`tool_result`), `system/hook_*`, `rate_limit_event`, and a terminal `result`. |
| Tool/activity visibility | Yes — `tool_use` blocks name the tool and its input. This is what feeds `activity` events. |
| Mid-session input | `--input-format stream-json` keeps stdin open, so an answer can be delivered as a further user message without restarting the session. This is how Mac answers questions. |
| Cancellation | Killing the child process; the adapter first closes stdin, then `SIGTERM`, then `SIGKILL` after a grace period. |
| Resumption after communication loss | `--session-id <uuid>` / `--resume` exist, so a dropped session can be re-attached. The adapter records the provider session id for this. |
| Permissions | `--allowedTools`, `--disallowedTools`, `--permission-mode` — used as defence in depth. |
| Hard cost cap | `--max-budget-usd` exists in print mode and is set when a monetary budget is configured. |
| **Exact token usage** | **Yes.** The terminal `result` event carries `usage` (input/output/cache-read/cache-creation tokens) and `modelUsage` per model. |
| **Monetary cost** | `total_cost_usd` is present — but see §10.2. On subscription auth it is a *list-price equivalent*, not money billed. |
| **Subscription percentage** | **No.** There is no `claude usage` command and no percentage anywhere. |
| Subscription state | `claude auth status` reports `authMethod`, `subscriptionType` (e.g. `max`) and `apiProvider`. |
| Rate-limit state | `rate_limit_event` in the stream reports `{status, rateLimitType, resetsAt, overageStatus}` — a *state*, not a percentage. |

### 5.2 Adapter behaviour

* Launches `claude` as a child process with `cwd` = the run's worktree, `shell: false`, a fixed argv,
  a scrubbed environment, and the git shim first on `PATH`.
* Argv is fixed by the adapter — the brief is delivered on **stdin**, not as an argv string, so no
  brief content can ever be interpreted as a flag.
* Parses newline-delimited JSON, tolerating partial lines and non-JSON noise (a malformed line
  becomes an `output` event, never a crash).
* Maps CLI events onto the neutral `AgentEvent` union. Mac's domain model sees no Claude concepts.
* **Question detection**: an assistant turn that ends without a tool call and whose text is
  interrogative is surfaced as a `question` event. This is a heuristic and is treated as one — it is
  bounded (max question rate), recorded, and the run continues if a question is missed.
* Session state machine: `starting → running → awaiting_answer → running → completed|failed|cancelled`.
* Survives temporary communication loss: events are buffered by the worker's existing bounded log
  buffer and the same retry/backoff client; the provider session id is persisted so a re-attach is
  possible.

---

## 6. Discovery model

Discovery is a conversation, not a form.

```
Step A  project selection        explicit; Mac never infers among several projects
Step B  context inspection       repository, README, docs, manifests, tests, recent commits,
                                 branches, previous Mac runs on this project, project memory,
                                 and what changed since Mac's last involvement
Step C  free-flow brief          the human talks; Mac records and does not interrogate
Step D  structured understanding conversation → HandoffBrief
Step E  gap analysis             one focused question at a time, and never a question the
                                 repository already answers
```

`discovery_sessions` holds the transcript and the inspected-context summary. Step B runs *before*
Step E so that gap analysis can subtract what was discovered — the rule "do not ask the human what
the repo can tell you" is implemented as: a gap whose `discoverableFrom` is non-empty is not asked.

Repository inspection in Sprint 2 is performed by the worker (it holds the clone) through a second
new job kind, `repo_inspect`, and returned to the control plane as a structured
`ProjectContextSnapshot`. That keeps the "no inbound access to the VM" property intact.

---

## 7. Confidence model

### 7.1 Boundaries without floating point

Spec: *"Do not rely on floating-point comparisons that create ambiguous boundary behaviour."*

Confidence is stored as `numeric(4,3)`, i.e. thousandths. All band comparisons are therefore
performed on **integers**: `toMillis(c) = Math.round(c * 1000)`, and every comparison is
`>=` against an integer threshold. `0.1 + 0.2 !== 0.3` cannot affect a band decision, and 0.80
is unambiguously in the autonomous band rather than "sometimes 0.7999999".

### 7.2 Bands

| Band | Millis | Behaviour |
|---|---|---|
| `below_floor` | `< 600` | Execution prohibited. Discovery continues. **Non-overridable, by anyone, including admin.** |
| `limited_scope` | `600–799` | Mac proposes a limited execution scope; the human must approve *that scope* explicitly (`acknowledgeBelowThreshold` + notes + a recorded `approved_scope`). |
| `autonomous` | `800–899` | Executes autonomously after normal approval. Reasonable assumptions permitted, recorded. |
| `high_autonomy` | `>= 900` | High autonomy within existing guardrails. |

Tested at 0.59, 0.60, 0.79, 0.80, 0.89, 0.90 — the exact list the brief requires.

### 7.3 Decision confidence (during execution)

Separate from understanding confidence. For each coding-agent question Mac assigns an answer
confidence and a **risk class**:

```
answer confidence >= 0.80                      → answer and continue
0.60 <= confidence < 0.80  and reversible
                           and in scope
                           and not high-risk   → safest assumption, continue, FLAG prominently
otherwise                                      → do not guess; block that subtask
```

High-risk is not a confidence question. Destructive, security-sensitive, architecturally
irreversible, or out-of-approved-scope decisions block **regardless of confidence**, because a
confident wrong answer to "should I drop this table" is worse than an unconfident one.

---

## 8. Question and answer supervision

Sequence for every question:

```
agent asks → worker forwards to control plane → Mac:
   1. records the question (persisted before any answering happens)
   2. searches task memory
   3. searches project memory
   4. searches the handoff brief (constraints, must-not-change, acceptance criteria)
   5. searches the inspected repository context
   6. selects the best answer, assigns confidence, records reasoning + sources
   7. classifies risk
   8. answers if safe → worker delivers it to the agent → execution continues
      otherwise → records a blocker and the agent is told that portion is out of scope
```

The answering engine is **deterministic and source-attributed**, not a model call: it scores
candidate sources against the question and returns the best-supported answer with an honest
confidence derived from match strength and source authority. This matters for three reasons: every
answer is explainable, the whole supervision path is testable with no paid model usage, and Mac
cannot hallucinate a constraint that no source contains. When nothing supports an answer, confidence
is low by construction and the safe path is taken.

Persisted per question: question, answer, confidence, reasoning summary, sources used, timestamp,
whether human input was required, whether it affected implementation, and risk class.

---

## 9. Blocked work

A blocked subtask does not stop the run:

1. record the blocker (`run_blockers`);
2. tell the agent that portion is out of scope for this run;
3. let independent work continue;
4. leave the blocked portion unimplemented;
5. report it prominently.

Cross-project fallback scheduling is **not** implemented — it is not trivial with the current
single-run-per-worker dispatch, and the brief says not to let it distract.

---

## 10. Usage model

### 10.1 Four sources, never conflated

```
exact        provider supplied the figure directly (token counts; API-key dollar cost)
observed     provider exposes a samplable state; before/after snapshots give a delta
estimated    Mac computed it internally
unavailable  nothing reliable was obtainable →  UI shows "Provider usage unavailable"
```

`usage_snapshots(run_id, provider, phase, source, reported jsonb, reporting_period, captured_at)`
records before/after; `run_usage` gains a `source` column. The UI always renders the source label
next to the number. There is no code path that upgrades an estimate to exact.

### 10.2 What that means for Claude Code specifically — the honest answer

* **Token counts: `exact`.** They come from the CLI's `result` event.
* **Dollar cost on subscription auth (this deployment): `estimated`.** `total_cost_usd` is a
  list-price equivalent of the tokens used. The account is billed by subscription, so presenting it
  as money spent would be a fabrication. It is stored, labelled `estimated`, and described in the UI
  as "equivalent API list price — not billed".
* **Dollar cost on API-key auth: `exact`**, and only then does the monetary budget become a *hard*
  budget.
* **Subscription percentage: `unavailable`.** The CLI exposes none.
* **Rate-limit state: `observed`.** `rate_limit_event` gives `{status, rateLimitType, resetsAt}`
  before and after a run. That is a genuine observable, so it is recorded as `observed` — while
  being explicit that it is a *state*, not a percentage, and cannot be subtracted into "9 points".

The brief's "before 42% → after 51%" shape is fully supported by the schema; this provider simply
does not supply percentages, and Mac says so rather than inventing them.

### 10.3 Budget guardrail: hard vs soft

| | Hard budget | Soft usage threshold |
|---|---|---|
| Basis | `exact` monetary cost only | `observed` or `estimated` |
| Enforcement | blocks dispatch and stops a run | warns; may stop if configured |
| Presented as | an enforceable limit | an uncertain signal, with the uncertainty visible |

`GET /api/budget/status` now reports `enforceable: boolean` and the usage source, so the UI never
implies a dollar limit is being enforced when it cannot be.

---

## 11. Self-review and pull requests

### 11.1 Self-review (uses the existing `self_review` state)

Claude declaring success is not evidence. Mac collects, from the repository itself:

git diff · files changed · diff stat · test result · build/typecheck result · uncommitted files ·
dependency-manifest changes · configuration changes · migration files added ·
assumptions recorded · unanswered questions · the agent's completion summary

and produces a verdict: does the work satisfy the brief; do acceptance criteria appear met; was
unexpected scope introduced; should a PR be opened; is human attention required.

### 11.2 PR eligibility — all must hold

```
execution was approved
implementation reported complete
understanding confidence >= autonomy threshold  (or the limited scope was explicitly approved)
required tests passed, or every failure is explicitly understood and recorded
no unresolved high-risk issue
no prohibited git operation occurred, and layer-3 verification passed
at least one commit exists on the task branch
the branch is not, and cannot be, the default branch
```

Failing any of these leaves the branch and worktree intact and records *why* — which is itself the
report's most useful line.

PR body sections are fixed: Summary / Why / Testing / Assumptions / Decisions Requiring Review /
Risk / Known Issues. `PullRequestGateway` has a `gh` CLI implementation (argv, no shell) and a mock;
**it has no merge method at all**, so "Mac must never merge" is not a rule the code has to remember.

---

## 12. Morning report

Short at the top, by construction: the DTO's headline fields are length-bounded, and the detailed
Q&A log is a separate endpoint rather than an appendix. Sections exactly as the brief specifies,
including "Questions Mac Answered" as a **count** plus a link, with low-confidence answers
highlighted, and an "Estimated Human Hours" figure derived from files/commits/tests touched and
explicitly labelled an estimate.

---

## 13. Security implications

The single most dangerous thing Sprint 2 does is give the worker the ability to execute processes.
The mitigations are structural:

1. **Still no arbitrary commands.** `claude_code` and `repo_inspect` are closed job kinds with
   bounded zod params. The protocol still has no field carrying a command string from a UI or a run
   request.
2. **Three, and only three, spawn sites**, each purpose-built and each `shell: false` with argv
   arrays: `GitRunner`, `ClaudeCodeAdapter`, `TestRunner`. There is no `exec`, no shell string, and
   no interpolation of user input into a command line anywhere.
3. **The one configurable command** (`test_command` / `build_command`) is an argv array, admin-only,
   audited on change, validated to reject shell metacharacters, and scoped to the repository.
4. **The agent's git is shimmed and policy-checked**, and the agent cannot push at all.
5. **Environment scrubbing.** The agent child process receives an explicit allowlisted environment.
   Worker tokens, database URLs and control-plane credentials are never in it.
6. **Path containment.** Worktrees are created only under the configured workspace root; a resolved
   path outside it is refused. Repository local paths are admin-configured, not run-supplied.
7. **No new inbound surface.** The three new worker endpoints are outbound calls from the worker, on
   the existing plane, still scoped to the worker's own run.
8. **Credentials for git/GitHub** live on the VM as they would for a human engineer (SSH agent or
   `gh` keyring) and are never transmitted through the control plane or stored in the database.
9. **Prohibited-operation attempts are audited** as first-class security events, not log lines.

Residual risks are in §17.

---

## 14. Schema changes (migration `0004_sprint2_coding.sql`)

New tables:

```
repositories, worktrees, handoff_briefs, discovery_sessions, project_context_snapshots,
agent_sessions, agent_questions, run_assumptions, run_blockers, run_reviews,
pull_requests, usage_snapshots, run_reports, memory_entries, git_violations
```

Altered:

```
runs          + repository_id, handoff_brief_id, worktree_id, approved_scope, scope_kind
run_usage     + source (exact|observed|estimated|unavailable), model
settings      + soft_usage_threshold_pct, claude_code_enabled, max_agent_minutes,
                max_questions_per_run
```

Unchanged and untouched: `audit_events` (append-only, both triggers), `sessions`, `users`,
`approvals`, `run_logs`.

New enum values are added to `AUDIT_EVENT_TYPES` and `STOP_REASONS` in `@mac/protocol` and to the
matching CHECK constraints, keeping the schema-parity test green.

---

## 15. API changes

Human plane (all additive):

```
GET    /api/projects/:id/repositories          POST /api/repositories        (admin)
PATCH  /api/repositories/:id                   POST /api/repositories/:id/approve (admin)
POST   /api/discovery                          POST /api/discovery/:id/messages
POST   /api/discovery/:id/inspect              GET  /api/discovery/:id
POST   /api/discovery/:id/brief                GET  /api/briefs/:id
PATCH  /api/briefs/:id                         POST /api/briefs/:id/answer
GET    /api/runs/:id/coding                    GET  /api/runs/:id/questions
GET    /api/runs/:id/review                    GET  /api/runs/:id/report
GET    /api/runs/:id/usage                     GET  /api/runs/:id/worktree
GET    /api/reports?since=                     GET  /api/memory?projectId=
```

Worker plane (three new endpoints, same auth, same run-scoping):

```
POST /api/worker/runs/:id/questions      ask Mac a question, receive the answer
POST /api/worker/runs/:id/agent-events   batched neutral AgentEvents
POST /api/worker/runs/:id/usage          usage snapshot (before/after)
```

`RunAssignment` gains an optional `coding` block (repository, branch name, base branch, worktree
root, the structured brief, limits). It is built server-side at lease time — never supplied by a
client.

---

## 16. UI changes

Extends the existing pages; no redesign, minimal styling effort (spec §23).

* **Discovery** — free-form message box, inspected-context summary, generated brief, confidence
  with band, unresolved questions asked one at a time.
* **Run Detail → Coding tab** — repository, branch, worktree path, agent session state, current
  activity, live logs, questions and Mac's answers with confidence.
* **Review tab** — changed files, diff stat, test/build result, assumptions, anomalies,
  low-confidence decisions, PR link, "human decision required" banner.
* **Usage panel** — provider, source badge (`exact` / `observed` / `estimated` / `unavailable`),
  before, after, delta where meaningful, and "Provider usage unavailable" where it is not.
* **Report view** — the morning report, short, with a link to the full Q&A log.

---

## 17. Test plan

| Area | Coverage |
|---|---|
| Git policy (unit) | Every prohibited form in §3.3, including obfuscated ones: `HEAD:main`, `:main`, `+refs/heads/main`, `-f`, `--force-with-lease`, `push --delete`, `branch -D main`, `update-ref refs/heads/main`, `reset --hard` on default, `filter-branch`, `push --mirror`, `-c receive.denyNonFastForwards=false`. Plus the allowed forms, so the policy is not merely "deny everything". |
| Git (integration) | Real temp repositories: worktree creation, branch naming, commit tracking, preservation, removal; **default branch cannot be modified, pushed to, force-pushed, or merged into** — proven against a real bare "remote". |
| Git shim | Spawns the shim with prohibited argv and asserts non-zero exit + violation record; and with allowed argv and asserts pass-through. |
| Confidence | 0.59 blocked (non-overridable even for admin), 0.60 limited, 0.79 limited, 0.80 autonomous, 0.89 autonomous, 0.90 high autonomy — plus integer-boundary tests proving no float ambiguity. |
| Claude adapter | Against a **fake CLI** (a Node script emitting recorded stream-json): session launch, progress, activity, question, answer round-trip, cancellation, completion, failure, malformed output, and process death. No paid model usage. |
| Supervision | High-confidence answer continues; low-confidence reversible assumption continues and is flagged; unsafe/irreversible/out-of-scope decision blocks; every Q&A persists with sources and reasoning. |
| Self-review | Passing tests, failing tests, unexpected dependency change, incomplete work, uncommitted files. |
| Pull request | Eligible run opens a PR with all seven sections; low-confidence run does not and says why; high-risk run does not; **no merge method exists** (asserted structurally and behaviourally). |
| Usage | exact / observed / estimated / unavailable each render and persist distinctly; hard vs soft budget; no estimate is ever reported as exact. |
| Blocked work | A blocked subtask leaves independent work completed and the run reportable. |
| Cutoff | Cutoff during a coding run stops it, preserves the worktree and the partial commits, and reports. |
| E2E | task → discovery → brief → confidence → approval → worktree → mock coding agent → real code change → tests → self-review → PR-ready → morning report, with the audit trail asserted in order. |
| E2E (opt-in) | The same flow with the **real** Claude Code CLI, skipped unless `MAC_E2E_REAL_CLAUDE=1`. |
| Sprint 1 regression | All 197 existing tests must still pass, unmodified. |

---

## 18. Assumptions

| # | Assumption | Rationale |
|---|---|---|
| B-1 | One approved repository per project in V1 (schema allows N). | Spec speaks of "the repository" for a project; N is free in the model, so this is a UI simplification only. |
| B-2 | Mac pushes; the coding agent never pushes. | Strictly stronger than policing the agent's pushes, and removes an entire class of failure. |
| B-3 | Supervision answers are derived from recorded sources, not a model call. | Explainable, testable without paid usage, and cannot hallucinate a constraint. A model-backed resolver is a drop-in later. |
| B-4 | `total_cost_usd` under subscription auth is `estimated`, not `exact`. | The account is not billed per token. Reporting it as exact money would be the exact fabrication §25 forbids. |
| B-5 | Question detection from the CLI stream is heuristic. | The CLI has no explicit "I am asking you a question" event. Treated as a heuristic: bounded, recorded, non-fatal when missed. |
| B-6 | `test_command` is admin-configured per repository. | A test command must be project-specific; making it an admin-only argv array is the narrowest form that still works. |
| B-7 | Cross-project fallback scheduling is out of scope. | Not trivial under single-run dispatch; the brief says not to let it distract. |
| B-8 | monday.com is design-only, and only if time remains. | Brief §24. |
| B-9 | Worktrees live under the worker's configured workspace root. | Path containment; also makes cleanup auditable. |
| B-10 | The morning report is generated per run, and the daily digest is a query over runs. | Avoids a scheduler this sprint while producing exactly the required document. |

---

## 19. Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | A coding agent finds a way to run git outside the shim (absolute path, libgit2, a language binding). | Layer 3 verification catches the *effect* regardless of the mechanism, and Mac's push function refuses any non-`mac/*` destination. Residual risk accepted and documented. |
| R-2 | Worker token compromise now yields code execution on the VM. | Unchanged token scope; the worker still only executes closed job kinds. This is the sprint's largest residual risk and is stated plainly rather than mitigated away. |
| R-3 | Question-detection heuristic misses a question and the agent stalls. | Bounded idle timeout; a stalled session fails cleanly with the worktree preserved. |
| R-4 | The agent writes outside the worktree. | `cwd` is the worktree, `--add-dir` is not passed, and the self-review inspects the whole repository for unexpected changes. Not fully preventable without OS sandboxing; noted for Sprint 3. |
| R-5 | Long coding sessions exceed the lease/heartbeat model. | Progress and agent-event uploads extend the lease exactly as Sprint 1 intended; `max_agent_minutes` bounds the session. |
| R-6 | Test commands hang. | Bounded timeout, killed process group, recorded as a test failure rather than a hung run. |
| R-7 | Provider output format changes between CLI versions. | The adapter tolerates unknown event types and malformed lines; the version is recorded on the session so a mismatch is diagnosable. |
| R-8 | PR opened for work that should not have been. | Seven independent eligibility conditions, all tested, and the human still merges. |

---

## 20. Implementation order

Each step ends green before the next begins.

1. Protocol: enums, git policy, coding-agent types, brief, usage, new job kinds.
2. Migration `0004` + drizzle schema + schema-parity test.
3. Domain (pure) + unit tests: git policy, branch naming, confidence integers, decision policy,
   gap analysis, review verdict, PR eligibility, usage classification, report assembly.
4. Server services + routes + integration tests: repositories, discovery, briefs, supervision,
   agent sessions, reviews, PRs, usage, reports.
5. Worker: `GitRunner`, `WorktreeManager`, git shim, `TestRunner`.
6. Worker: `CodingAgent` interface, `MockCodingAgent`, `ClaudeCodeAdapter` + fake-CLI tests.
7. Worker: the `claude_code` job — the disciplined workflow — and `repo_inspect`.
8. E2E: the full loop with the mock agent; opt-in real-CLI variant.
9. UI.
10. Documentation, self-review, completion report.

---

## 21. Implementation notes — where reality differed from this design

Written *after* implementation, so this document describes what was built rather
than only what was intended. Every item below was found by a test, by driving
the UI, or by running the real Claude Code CLI.

### 21.1 Defects found during implementation

| # | Defect | Fix |
|---|---|---|
| D-1 | **Confidence bands were to be compared in integer thousandths.** That would have rounded `0.5999` up to `0.600` and permitted a run below the non-overridable floor — the exact silent-boundary bug the requirement exists to prevent, introduced by the fix for it. Caught by a surviving Sprint 1 test. | Comparisons use a fixed-point scale of 1e6. Float artefacts are still absorbed (`0.1 + 0.7` compares equal to `0.8`), but every difference the API can express is preserved. |
| D-2 | **The decision policy blocked on low confidence alone**, so almost every question — including "should the list be sorted alphabetically?" — stopped a subtask. Mac would have been useless overnight. | Risk, reversibility and scope decide whether to block; confidence only chooses between answering and assuming. Below the floor, a *medium*-risk decision blocks, but a reversible low-risk one becomes a recorded, flagged, conservative assumption. Spec §6 favours forward progress. |
| D-3 | **The supervision retrieval could not match `testing` against `tests`,** so a question about testing expectations scored zero against the brief field that answered it. Substring matching is not enough for English. | Light suffix stemming plus prefix matching, and the field LABEL is searched as well as its content — `brief.testingExpectations` genuinely is the answer to a question about testing expectations. |
| D-4 | **"Must not change" stored the whole sentence.** The self-review compares each entry against changed file paths, and a sentence never matches a path — the check existed and could never fire. | `extractMustNotChange` pulls the noun out of the sentence ("existing import format"), and the full sentence is kept separately as the human-readable constraint. |
| D-5 | **The path matcher required EVERY word of a phrase to appear in a path.** Same failure: protection that looks real and never triggers. | Any single distinctive token matches, with generic words excluded. Deliberately generous: a false positive costs a line in a review, a false negative means Mac changed something he was told not to. |
| D-6 | **`sh -c "rm -rf /"` passed the test-command validator**, because the shell syntax sits inside one argument and the validator only rejected metacharacters. | Shells, process launchers (`env`, `xargs`) and inline-program flags (`node -e`, `python -c`) are refused as executables. `node ./scripts/test.mjs` still works. |
| D-7 | **The morning report inlined whole Q&A exchanges** through the assumption text, defeating "short at the top". | Assumption statements are bounded to one line; the full question, answer, reasoning and sources stay on the Q&A log the report links to. |
| D-8 | **`run_usage.is_exact` and the new `source` column could disagree**, and the budget guardrail reads `source` — so a row could record real spend that the hard budget silently ignored. | Migration `0005` adds `CHECK (is_exact = (source = 'exact'))`. The contradiction is now impossible rather than merely unlikely. |
| D-9 | **The Claude Code CLI could not be spawned on Windows.** npm installs it as a `sh` script plus a `.cmd`; Node 20 refuses `.cmd` (CVE-2024-27980) and cannot execute the sh script. Found by running the real CLI. | The adapter resolves the real executable — via `where`/`which`, then by reading the shim's own target — rather than reaching for `shell: true`, which would have introduced a quoting surface into a command line the brief contributes to. |

### 21.2 Design changes made during implementation

- **The git shim's policy module is transpiled, not duplicated or built.** The
  guard runs in a bare `node` process that cannot import TypeScript, and the
  repository has no build output. A hand-written JavaScript copy of the rules
  was rejected outright — two copies of a safety policy drift, and the copy that
  drifts is the one nobody tests. `git-policy.ts` is deliberately import-free so
  it can be transpiled into a standalone module at shim-build time; the shim
  throws if that ever stops being true.
- **The shim fails CLOSED.** If the policy cannot be loaded, every git
  invocation is refused. Proven by a test that corrupts the emitted module.
- **`checkGitCommand` refuses a merge when the current branch is unknown.** The
  merge prohibition is the specification's one absolute, and it must not rest on
  an optimistic assumption about unreadable state.
- **`repo_inspect` became a second job kind.** Discovery needs repository facts,
  and the control plane must not reach into the VM — so inspection runs on the
  worker and posts a structured snapshot back.
- **Understanding confidence is not patchable.** It is recomputed from the brief
  on every write, so nobody — human or agent — can raise it by asserting it.

### 21.3 What the Claude Code CLI actually provides

Verified against **2.1.233**, not assumed:

- exact token counts (input, output, cache read, cache creation) in the terminal
  `result` event;
- `total_cost_usd`, which under `claude.ai` subscription auth is a **list-price
  equivalent, not money billed** — recorded as `estimated` with that stated;
- **no** usage subcommand and **no** subscription percentage anywhere, so
  `percentUsed` is reported as absent rather than as zero;
- `rate_limit_event` giving `{status, rateLimitType, resetsAt}` — a genuine
  observable, recorded as `observed` state and never converted into a percentage;
- `--input-format stream-json`, which keeps stdin open so an answer can be
  delivered into a live session — this is what makes supervision possible at all.

### 21.4 Verified beyond the automated suite

- The full loop was driven in a browser: project selection, free-flow
  conversation, one focused question, a brief at 88 % confidence with the
  weighted checklist behind it, and a correct refusal to create a coding run
  because the project had no approved repository.
- The **real** Claude Code CLI ran a task end to end under the adapter
  (`MAC_E2E_REAL_CLAUDE=1`): real session, real events, real usage, real commit,
  and `main` untouched.
