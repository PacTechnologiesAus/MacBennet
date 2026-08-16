# Mac Bennett — Sprint 3 Implementation Design

**Status:** Approved for implementation
**Scope:** Sprint 3 — the operational night-shift employee.
**Builds on:** `docs/sprint-1-design.md` (control plane, lifecycle, audit, guardrails) and
`docs/sprint-2-design.md` (discovery, briefs, coding agent, git safety, review, reports)
**Source of requirements:** `Mac_Spec.md` §3–§9, §16–§19, §25–§28, plus the Sprint 3 brief.

Sprint 3 proves this loop:

> a human leaves Mac with approved projects and approved monday.com work → Mac inspects what he can
> discover himself before asking anyone → Mac executes approved work inside an OS-enforced sandbox →
> Mac updates monday.com as he goes → when a task finishes or blocks, Mac picks the next eligible one
> → he keeps going safely until cutoff, budget or an empty queue stops him → he leaves reviewable
> pull requests and preserved worktrees → and one concise email is in the engineer's inbox at 08:00.

---

## 1. Sprint 2 assessment

Sprint 2 was inspected in full and its suite re-run before any design work:
**492 tests pass** (375 server + 117 worker) against a real PostgreSQL 16 database, plus one opt-in
real-CLI test that is skipped by default. The autonomous coding loop is healthy.

### 1.1 What Sprint 2 got right, and which Sprint 3 therefore extends rather than replaces

| Sprint 2 decision | Why Sprint 3 keeps it |
|---|---|
| **The worker decides nothing.** It asks the control plane and applies the answer. | Sprint 3 adds far more decisions — which task to start, whether it is safe to start it, whether to post to monday.com. Every one of them belongs where it is audited. The split already exists; Sprint 3 just uses it more. |
| **Closed job allowlist; the protocol has no command field.** | Sprint 3 adds a sandbox and monday.com, and neither adds a way to express a command. `claude_code` gains a sandbox around it, not a new parameter. |
| **Three-layer git safety; the agent cannot push at all.** | Untouched. The sandbox is a *fourth*, independent layer, not a replacement — it constrains the filesystem, which is the axis the other three do not cover. |
| **Approval is a SQL predicate, not an `if`.** | Sprint 3 adds three more predicates to the same statement: repository approved (Sprint 2), **sandbox present**, and **project approved for night shift**. Same shape, same reason. |
| **`transition()` is the single choke point for run status.** | Night-shift scheduling creates and finishes many runs a night. Every one still goes through `transition()` and therefore audits itself. |
| **Confidence compared at a fixed-point scale of 1e6; the floor is non-overridable.** | Task eligibility and the scheduler both read confidence. They use the same comparator; there is no second implementation. |
| **Usage recorded as exact / observed / estimated / unavailable, never conflated.** | The night scheduler consults usage before starting another task. It must not treat an estimate as a dollar cap, and the existing model is exactly what prevents that. |
| **Retrieval-based supervision behind a clean `resolveAnswer` seam.** | Sprint 3's model-backed resolver drops into that seam. The seam was designed for this; it is being used as designed. |
| **Worktrees are preserved by default.** | Multi-task nights make this more important, not less: a night that touches five tasks must leave five inspectable results. |

### 1.2 Technical debt inherited, and what Sprint 3 does about it

| # | Sprint 2 debt | Sprint 3 action |
|---|---|---|
| S-1 | **No worker token rotation** (Sprint 1 R-1, Sprint 2 R-2, deferred twice). | **Fixed.** §4. |
| S-2 | **The agent could write outside the worktree**; containment was inspected after the fact, not enforced (Sprint 2 R-4). | **Fixed.** §3. |
| S-3 | **No cross-project fallback scheduling** (Sprint 2 B-7). | **Fixed.** §7, §8. |
| S-4 | **The morning report is generated but never delivered.** | **Fixed.** §9. |
| S-5 | **Discovery and supervision are literal-minded**; a question no source addresses gets a conservative answer rather than an investigation. | **Fixed.** §6 adds autonomous investigation across six source classes before any human is asked, and §10 adds an optional model-backed resolver behind the existing interface. |
| S-6 | **No integrations at all**; monday.com existed only as a design sketch. | **Fixed.** §5. |
| S-7 | A run whose worker goes offline stays `running` pending a human. | **Unchanged, deliberately.** Auto-failing on a network blip still destroys real work, and a multi-task night makes that worse rather than better. The night-shift dashboard now surfaces it within one heartbeat interval, which is the actual gap. |
| S-8 | Logs are polled, not streamed. | Unchanged. Still adequate; still not the bottleneck. |

### 1.3 What is *not* being rewritten

No change to: the two auth planes' shape, the lifecycle transition table's existing edges, the audit
table, the dispatch statement's shape, the log pipeline, the git policy, the worktree lifecycle, the
confidence model, the usage model, or the UI's architecture. **Sprint 3 is additive.**

---

## 2. Sprint 3 architecture at a glance

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  CONTROL PLANE  (@mac/server)                            "Mac, the manager"  │
│                                                                              │
│  night-shift/     the scheduler: eligibility → safe-start → select → record  │
│  eligibility/     deterministic predicate: may Mac start this item NOW?      │
│  investigation/   exhaust six source classes before asking a human           │
│  monday/          MondayClient interface · GraphQL impl · fake impl · guard  │
│  mail/            MailProvider interface · Graph impl · fake impl · outbox   │
│  model/           ModelProvider interface · Anthropic impl · null · scripted │
│  credentials/     worker token issue / rotate / revoke                       │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │  worker plane (outbound HTTPS only, unchanged shape)
                │  + rotate-token, + sandbox attestation on register/heartbeat
                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  WORKER  (@mac/worker)                                  "Mac's workstation"  │
│                                                                              │
│  TRUSTED ZONE (worker process)                                               │
│    GitRunner · WorktreeManager · evidence collection · control-plane client  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ SANDBOX (OS-enforced)          sandbox/plan.ts   pure, shared          │  │
│  │                                sandbox/bubblewrap.ts   Linux, preferred│  │
│  │                                sandbox/docker.ts       portable        │  │
│  │                                                                        │  │
│  │   the coding agent   ·   the project's own test and build command      │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

The one new structural idea is the **trusted/untrusted split inside the worker**. Sprint 2 ran
everything in one process with one filesystem view. Sprint 3 draws a line: Mac's own code stays
outside, and everything that executes agent-authored intent goes inside a sandbox.

---

## 3. Sandbox architecture

### 3.1 What is inside the boundary, and why exactly that

Two things run agent intent, and both go inside:

1. **the coding agent session** — the obvious one;
2. **the project's own `test_command` / `build_command`** — the non-obvious one, and arguably the
   more dangerous. `npm test` executes code the agent just wrote. Sandboxing the agent but not its
   test run would leave the widest hole open while claiming it was closed.

Three things stay **outside**, and this is a deliberate, defensible line rather than an omission:

| Outside | Why |
|---|---|
| `GitRunner` / `WorktreeManager` | Mac's own git is already a closed API whose every argv is policy-checked. Putting it inside would require mounting the clone writable *and* would gain nothing: the code is Mac's, not the agent's. |
| Evidence collection (diff, status, rev-list) | Reading the repository to judge the agent's work must not itself run under the agent's constraints. |
| Control-plane communication | Holds the worker token. Nothing that executes agent intent may ever see it. |

**The honest statement of what the sandbox guarantees:** filesystem containment to the assigned
project, plus environment and credential scrubbing. It does **not** replace the git policy — an agent
inside the sandbox still has the repository's git metadata, and it is the three existing layers that
stop it moving `main`. Saying otherwise would be over-claiming.

### 3.2 One plan, two providers

```ts
// pure, no I/O, unit-tested exhaustively on every platform
buildSandboxPlan(input): SandboxPlan | throws SandboxPlanError

interface SandboxPlan {
  workdir: string;                       // host path the child starts in
  mounts: Array<{ hostPath, mode: 'ro' | 'rw', purpose }>;
  tmpfs: string[];
  env: Record<string, string>;           // allowlisted, built from nothing
  network: 'none' | 'egress';
  user: { uid: number; gid: number } | null;
  deniedWitnesses: string[];             // paths asserted absent — the test oracle
}

interface ExecutionSandbox {
  readonly kind: 'bubblewrap' | 'docker';
  probe(): Promise<{ available: boolean; reason?: string; version?: string }>;
  open(plan: SandboxPlan): Promise<SandboxSession>;
}

interface SandboxSession {
  pathFor(hostPath: string): string;     // host → in-sandbox path
  spawner: Spawner;                      // drop-in for node's `spawn`
  close(): Promise<void>;
}
```

**Why two providers rather than one.** `bubblewrap` is the right answer on the Linux VM: no daemon,
no image, ~10 ms of setup, identity path mapping so nothing needs rewriting, signals and pipes behave
exactly as they already do, and it fails closed trivially. It is also unavailable on Windows and on
hosts without user namespaces, which would leave the enforcement claims of this sprint untested on
the machine the work is being done on. `docker` is available there, gives a genuinely stronger mount
namespace, and is what most deployments already have. Both are translations of the *same* plan, and
the plan is where every rule lives — so this is one policy with two back-ends, not two policies.

`Spawner` is a one-line seam:

```ts
type Spawner = (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
```

`ClaudeCodeAdapter` and `runProjectCommand` gain an optional `spawner`, defaulting to `node:child_process.spawn`.
That is the entire integration surface — no rewrite of either.

### 3.3 The mount plan for a coding session

| Mount | Mode | Why |
|---|---|---|
| the run's worktree | rw | The work. |
| `<repo>/.git` | rw | git must function inside; the git policy governs what it may do. |
| the git shim directory | ro | Layer 2 keeps working inside the sandbox. |
| a per-run temp directory | rw | Build tools need one; it is *not* shared with other runs. |
| admin-configured tooling mounts | ro | e.g. a node cache, a `~/.npmrc`. Explicit, allowlisted, never inferred. |
| `/usr`, `/bin`, `/lib`, `/lib64`, `/etc/ssl`, `/etc/resolv.conf` (bubblewrap only) | ro | The toolchain. Docker gets these from the image instead. |

Everything else is absent from the mount namespace. Not unreadable — **absent**. There is no
`$HOME`, no other worktree, no other repository, no `/etc/shadow`, no `~/.ssh`, no `~/.aws`, no
`~/.config/gh`, no `~/.claude`, no worker state file, no `.env`.

`buildSandboxPlan` refuses, with `SandboxPlanError`:

* any mount whose resolved host path escapes the repository root, the workspace root, or the tooling
  allowlist — checked after `realpath`, so a symlink cannot smuggle one in;
* any path containing a known-credential segment (`.ssh`, `.aws`, `.gnupg`, `.config/gh`, `.claude`,
  `.npmrc`, `.docker`, `.kube`) unless it is declared as a scoped credential mount, and then only `ro`;
* `/`, `$HOME`, the workspace root itself, and the worker's own state file;
* a workdir that is not inside a `rw` mount.

**Environment.** Built from empty, not filtered from `process.env`: `PATH`, `HOME` (pointing at a
tmpfs), `LANG`, `TERM`, `CI`, `GIT_TERMINAL_PROMPT=0`, plus an admin-configured allowlist and the
narrowly scoped credentials that task needs. Sprint 2 deleted `MAC_*` and `DATABASE_URL` from a
copied environment; starting from nothing is the stronger form of the same idea, because it is not a
list that can fall behind.

**Network.** Two values. The coding agent needs `egress` (it must reach the model API); the project
test command defaults to `none`, configurable per repository, because a test suite that needs the
internet is a test suite worth knowing about. Filesystem is the axis this sprint's requirements are
written on; network is treated as a second, smaller axis and described honestly as such.

### 3.4 Fail closed, in three places

1. **The worker refuses to start a coding session** when the configured provider probes unavailable
   or the plan is invalid: `SandboxUnavailable` → run fails with `stop_reason = 'sandbox_unavailable'`,
   worktree preserved, `sandbox.refused` audited. There is no fallback to unsandboxed execution.
2. **The control plane refuses to dispatch** a `claude_code` run to a worker that has not attested a
   working sandbox, when `settings.requireSandbox` (default **true**). This is a predicate in the
   dispatch statement, next to the approval and repository predicates, so it is not something a call
   site can forget.
3. **`MAC_SANDBOX_PROVIDER=none` exists** for development, is logged loudly, is attested to the
   control plane as `sandboxReady = false`, and therefore cannot receive coding work while
   `requireSandbox` is on. An escape hatch that the server can veto is a different thing from an
   escape hatch.

### 3.5 Cancellation

Unchanged in shape. `bwrap` is spawned with `--die-with-parent` and forwards signals, so the existing
`AbortSignal` path works untouched. Docker is spawned with a deterministic container name and
`--sig-proxy`; on abort the session additionally issues `docker kill`, because signal proxying through
the daemon is best-effort and a night shift must not depend on best-effort. Work already committed
inside the worktree survives either way — the worktree is a host directory, not container state.

---

## 4. Worker token rotation

### 4.1 The shape

Tokens move out of `workers.token_hash` into their own table, because rotation needs several tokens
per worker to exist at once and a single column cannot express that.

```
worker_tokens(id, worker_id→workers, token_hash UNIQUE, token_prefix,
              status: active | superseded | revoked,
              issued_at, expires_at, last_used_at,
              superseded_at, revoked_at, revoked_by→users, revoked_reason,
              issued_via: enrollment | rotation | admin_reset,
              created_at)
```

`workers.token_hash` is **dropped**. Keeping it would leave two sources of truth for the credential
that guards code execution, and the one that drifts is always the one nobody tests.
`workers.token_prefix` stays as a denormalised display of the active token.

### 4.2 The protocol

| Step | Mechanism |
|---|---|
| **Rotate** | `POST /api/worker/rotate-token` with the current token. Issues a new `active` token, marks the old `superseded` with `expires_at = now + overlapSeconds`, returns the new token exactly once. |
| **Overlap** | Auth accepts `active` tokens, and `superseded` tokens whose `expires_at > now()`. Default overlap **300 s**, configurable. It exists so an in-flight request signed with the old token does not fail mid-rotation; it is deliberately short. |
| **Revoke** | `POST /api/workers/:id/revoke-tokens` (admin). Every token → `revoked` immediately, no grace. The worker must re-enroll. |
| **Server-initiated** | The control envelope — already present on every worker-facing response — gains `rotateTokenRequested: boolean`. The worker rotates on its next call of any kind. **This is what makes rotation possible without touching the VM.** |
| **Automatic** | `settings.workerTokenMaxAgeHours` (default 168). A token older than that sets `rotationRequested` on the next heartbeat. |

The worker writes the new token to its state file with `0600` **before** discarding the old one, via
write-temp-then-rename, so a crash mid-rotation leaves a usable credential rather than a bricked VM.
If the persist fails, the worker keeps using the old token and retries — the overlap window is what
makes that safe.

### 4.3 Audit

`worker.token_rotation_requested`, `worker.token_rotated`, `worker.token_revoked`,
`worker.token_rejected` (a revoked or expired token was presented — a genuine security signal, and
the one that tells you a leaked token is being used).

Nothing plaintext is ever stored. The rotation endpoint returns the new token in the response body
and nowhere else, exactly as registration does.

---

## 5. monday.com integration model

### 5.1 Shape

```
monday.com  ──read──►  sync  ──►  monday_items (a cache, never a source of truth for Mac's state)
                                        │
                                        ▼
                              eligibility predicate (deterministic, §7)
                                        │
                                        ▼
                              night scheduler (§8)  ──►  runs (unchanged lifecycle)
                                        │
                                        ▼
                              monday_writes outbox  ──►  monday.com
```

Reads are pulled and cached. Writes go through an **outbox**, written in the same transaction as the
state change that justified them, so a run never fails because monday.com is down and monday.com is
never updated by a transaction that then rolls back. This is the same reasoning that already governs
audit events, applied to a second durable side effect.

### 5.2 The client interface, and what it deliberately cannot do

```ts
interface MondayClient {
  readonly name: string;
  getBoard(boardId): Promise<MondayBoard>;
  listItems(boardId, opts): Promise<MondayItem[]>;
  getItem(itemId): Promise<MondayItem | null>;
  assignToMac(itemId, columnId, macUserId): Promise<void>;
  setStatus(itemId, columnId, label): Promise<void>;
  postUpdate(itemId, body): Promise<{ updateId: string | null }>;
  setPullRequestLink(itemId, columnId, url): Promise<void>;
}
```

There is **no** `deleteItem`, `deleteBoard`, `setDueDate`, `setPriority`, `createBoard`,
`createGroup`, `moveItem`, `updateUser` or generic `changeColumnValue`. The prohibitions in the
Sprint 3 brief are therefore not rules the code must remember — they are capabilities that do not
exist. A future administrative task that genuinely needs one adds a method, which is a reviewable
code change.

Behind the interface, `MondayWriteGuard` wraps every call and validates the column id against the
board row's allowlist (`status_column_id`, `assignee_column_id`, `pr_column_id`). A write to any
other column — including the due-date column, which is stored precisely so it can be recognised and
refused — is rejected with `monday.write_refused` audited. So the restriction holds at two levels:
the method does not exist, and if one were added carelessly the guard still refuses the column.

Two implementations ship: `MondayGraphqlClient` (fetch only, no new dependency) and
`FakeMondayClient` (in-memory, deterministic, used by the entire standard suite). The real client is
exercised by an **opt-in** test against a dedicated test board, gated on
`MAC_MONDAY_LIVE_TEST=1` — never required by `npm test`.

### 5.3 Project mapping and approval

```
monday_boards(id, project_id→projects, board_id, name,
              group_ids jsonb,                       -- optional workstream filter
              status_column_id, priority_column_id, assignee_column_id,
              due_date_column_id, pr_column_id,
              status_labels jsonb,                   -- {inProgress, readyForReview, blocked, done}
              startable_statuses jsonb,              -- which statuses Mac may start from
              may_complete boolean default false,    -- else Ready for Review is terminal for Mac
              night_shift_eligible boolean default false,
              require_item_flag boolean default true,-- item must be explicitly marked
              mac_user_id text,                      -- Mac's own monday identity
              is_approved boolean default false, approved_by, approved_at,
              created_at, updated_at)
```

`is_approved` follows `repositories.is_approved` exactly: a separate, audited administrative act,
never set at creation, and revoking it stops future work without any call site checking. **Mac reads
only from boards that are mapped and approved**, so he cannot roam every board the connected account
can see — the query is scoped by `monday_boards`, not by the token's permissions.

`projects` gains `night_shift_approved`, `night_shift_approved_by`, `night_shift_approved_at`. Both
gates must be open: an approved board inside an unapproved project yields nothing.

---

## 6. Discovery: investigate before escalating

### 6.1 The rule, made mechanical

Sprint 2 already refused to ask about a dimension the repository could answer. Sprint 3 makes that
general: **six source classes, checked in order, and a human is asked only when all six have been
checked and none resolved it.**

| # | Source | What it can answer |
|---|---|---|
| 1 | repository context snapshot | architecture, testing conventions, affected components, current behaviour |
| 2 | project memory | conventions, decisions, constraints that outlive a task |
| 3 | task memory | this task's own prior decisions |
| 4 | previous runs on this project | what was tried, what failed, what was assumed and later confirmed |
| 5 | previous handoff briefs | constraints and must-not-change statements the human already gave once |
| 6 | monday.com item and its updates | description, acceptance notes, the human's own comments |

```ts
investigate(question | dimension, sources): Promise<InvestigationResult>

interface InvestigationResult {
  resolved: boolean;
  answer: string | null;
  confidence: number;
  evidence: EvidenceRef[];
  checked: Array<{ source: SourceClass; consulted: boolean; matched: boolean; note: string }>;
}
```

`checked` is persisted in full, whether or not the investigation succeeded:

```
discovery_investigations(id, discovery_session_id NULL, run_id NULL, task_id, project_id,
                         subject_kind: dimension | agent_question, subject,
                         resolved, answer, confidence,
                         checked jsonb, evidence jsonb,
                         escalated_to_human boolean,
                         model_assisted boolean,
                         created_at)
```

So "Mac asked me something he could have looked up" becomes a falsifiable claim: the row says which
sources he consulted and what each one returned. Audited as `discovery.investigation_completed` and,
when it fails to resolve, `discovery.escalated_to_human`.

### 6.2 Confidence recalculation

The flow the brief specifies — *uncertainty → autonomous investigation → confidence recalculation →
only then a human question* — is implemented by feeding investigation results back into
`analyseGaps`. A dimension resolved by investigation counts as satisfied at **0.75 weight** rather
than 1.0: Mac deducing the testing convention from four sources is real evidence but weaker than the
human stating it, and Sprint 2's existing half-credit rule for repository-discoverable dimensions
already establishes the principle. Inflating it to full credit would let confidence reach the
autonomous band on inference alone.

The floor is untouched. Below 0.60 execution is still prohibited, non-overridably — investigation
changes what Mac *knows*, never what he is *permitted* to do at a given confidence.

---

## 7. Task eligibility

### 7.1 A deterministic predicate, in code, not in a model

`domain/eligibility.ts`, pure and total:

```ts
evaluateEligibility(input: EligibilityInput): EligibilityVerdict

interface EligibilityVerdict {
  eligible: boolean;
  reasons: Array<{ code: EligibilityCode; ok: boolean; detail: string }>;  // ALL checks, not just failures
  blockingCodes: EligibilityCode[];
  priorityRank: number;
}
```

Every check is reported whether it passed or failed, because the Night Queue screen has to show
**why** a task is eligible as well as why one was skipped, and a verdict that only lists failures
cannot do that.

| Code | Rule |
|---|---|
| `project_not_approved` | the project is not approved for night shift |
| `board_not_approved` | the monday board is not mapped and approved |
| `board_not_night_eligible` | the board is approved but not marked night-shift eligible |
| `item_not_flagged` | the board requires an explicit per-item flag and the item lacks it |
| `status_not_startable` | the item's status is not in the board's `startable_statuses` |
| `assigned_elsewhere` | assigned to a human who is not Mac |
| `dependency_blocked` | a linked dependency item is not in a completed status |
| `no_brief` | no handoff brief exists for the task |
| `confidence_below_floor` | brief confidence < `minExecutionConfidence` |
| `confidence_below_autonomy` | confidence < `defaultConfidenceThreshold` **and** no pre-approved limited scope |
| `repository_not_approved` | the project's repository is not approved |
| `already_active` | a non-terminal run already exists for this task |
| `previously_blocked` | the task blocked earlier tonight and the blocker is unresolved |
| `task_type_not_allowed` | the item's type column is outside the configured allowlist |

`confidence_below_autonomy` deserves a note. Spec §5 lets the 60–79 % band proceed **only** with an
explicit human decision on a narrower scope. Nobody is awake at 02:00 to make that decision, so
autonomous selection requires the autonomous band — unless a human pre-approved a limited scope for
that specific task during the day, which is recorded on the run and honoured. This is the rule that
stops "keep Mac busy" from quietly eroding the confidence model.

**No LLM is consulted anywhere in this file.** It has no I/O at all.

### 7.2 How night-shift work is approved

Sprints 1 and 2 required a human to approve every run. A multi-task night cannot ask. The resolution
is that **approval moves up a level, not away**: a human approves the *project* for night shift, the
*board*, and (by default) each *item* by flagging it. The scheduler then creates runs already
approved, under a distinct and separately recorded authority.

`approvals` gains `source: 'human' | 'night_shift_policy'` and `policy_basis jsonb`, which records
the project approval, board approval, item flag and eligibility verdict that justified it. The
audit event is `run.auto_approved`, never `run.approved`, so a machine-approved run can never be
mistaken for a human-approved one in the trail or the UI.

Everything else still applies unchanged: the confidence floor, repository approval, sandbox
attestation, budget, cutoff.

---

## 8. Autonomous night scheduling

### 8.1 The algorithm

`domain/night-scheduler.ts`, pure:

```ts
decideNextAction(state: NightState): NightDecision

type NightDecision =
  | { action: 'continue';                  reason }        // current run is productive
  | { action: 'finalise'; runId;           reason }        // current run finished; report it
  | { action: 'record_blocker'; runId;     reason }
  | { action: 'start'; candidate; estimate; rationale }
  | { action: 'idle';                      reason }        // nothing eligible; wait
  | { action: 'stop'; stopReason;          reason };       // cutoff, budget, guardrail
```

Selection order is spec §8's, verbatim:

1. the explicitly assigned or human-approved current task;
2. other eligible work **in the same project**, by monday.com priority, then due date, then item order;
3. eligible work in **other approved projects**, by the same ordering.

Same-project first is not arbitrary: the repository is already fetched, the worktree tooling is warm,
and the project memory is already the one Mac has been reasoning with. Switching projects costs real
context, so it happens when the current project has nothing left, not merely because another board
has a higher number on it.

**Mac never invents work.** Candidates come only from monday items that passed the eligibility
predicate. There is no code path that generates a task.

### 8.2 The stop conditions, evaluated before every start

| Gate | Rule |
|---|---|
| cutoff | `now < cutoffAt` and the safe-start check (§8.3) passes |
| budget — hard | exact recorded spend < `nightlyBudgetCents × budgetStopPct%`. Enforceable only when cost is `exact`. |
| budget — soft | non-exact usage past `softUsageThresholdPct` warns, and stops **only** if `softUsageStopsExecution` is set. The decision record states which of the two applied, so a soft threshold is never reported as a dollar cap. |
| concurrency | one run per worker; the scheduler starts a task only when the worker is idle |
| project permissions | re-evaluated at selection **and** re-checked at dispatch, exactly as repository approval is |
| risk | a candidate whose eligibility verdict carries any blocking code is not selectable, ever |
| guardrail stop | any `guardrail.blocked` for budget or a security event ends the shift |

### 8.3 Do not start what cannot be left safe

`domain/effort.ts`:

```ts
estimateEffort(candidate): { sizeClass: 'small'|'medium'|'large', minutes, basis, partialUseful, preservable }
safeToStart(now, cutoffAt, estimate, settings): { safe: boolean, reason, remainingMinutes }
```

The estimate is deliberately crude and labelled as such — derived from the brief's acceptance-criteria
count, affected-component count, scope kind, whether migrations or dependency changes are implied, and
the monday item's own size field where the board has one. Perfect duration prediction is not the goal.

`safeToStart` requires:

```
remainingMinutes >= estimate.minutes × safetyFactor + wrapUpMinutes
```

with `safetyFactor` default 1.5 and `wrapUpMinutes` default 10 (committing, testing, reviewing,
reporting all have to fit). A `large` task additionally requires
`remainingMinutes >= largeTaskMinRemainingMinutes` (default 90). A task whose partial result is
useful and whose state is preservable — which, given worktrees, is almost all coding work — may start
on a shorter runway, down to a floor of `minStartMinutes` (default 20). Below that, nothing starts.

Every evaluation is written to `night_decisions.rationale`, including the ones that decided *not* to
start something. A scheduler whose refusals are invisible is a scheduler nobody can debug at 08:00.

### 8.4 Where the loop lives

A third sweeper, `nightShiftTick`, every 30 s — alongside the heartbeat and cutoff sweepers, in the
same process, for the same reason those are there. No queue, no Redis, no workflow engine: the tick
is idempotent, cheap, and safe to miss.

```
night_shifts(id, started_at, ended_at, cutoff_at, status, stop_reason,
             started_by→users, settings_snapshot jsonb,
             tasks_completed, tasks_blocked, tasks_attempted, created_at)

night_decisions(id, night_shift_id→night_shifts, at, sequence,
                decision, run_id, task_id, monday_item_id,
                rationale jsonb, eligibility jsonb, effort jsonb)
```

`settings_snapshot` matters: reading the morning report next to the thresholds as they are *now* is
misleading if someone changed them at 06:00.

---

## 9. Email delivery architecture

### 9.1 Provider interface

```ts
interface MailProvider {
  readonly name: string;
  send(msg: { to: string[]; subject: string; text: string; html?: string; idempotencyKey: string })
    : Promise<{ accepted: boolean; providerMessageId: string | null; error?: string; retryable: boolean }>;
}
```

`GraphMailProvider` — Microsoft Graph `sendMail`, fetch only, client-credentials flow. Chosen because
spec §2 and §19 already say Mac has a genuine PAC Technologies mailbox and a Microsoft identity, so
this is the mailbox he is supposed to be sending from rather than a parallel one. It also needs no
new npm dependency. `FakeMailProvider` (recording, failure-injecting) covers the whole standard
suite. SMTP is a drop-in later; the interface is three lines wide.

### 9.2 Durability, idempotency, retry

```
email_deliveries(id, kind, night_shift_id NULL, run_id NULL,
                 idempotency_key UNIQUE,
                 recipients jsonb, subject, body_text, body_html,
                 status: pending | sending | sent | failed | dead,
                 attempts, next_attempt_at,
                 provider, provider_message_id, last_error,
                 created_at, sent_at)
```

* **Idempotent by construction.** The key is `morning-report:<nightShiftId>` (or
  `:<runId>` for a per-run report). `UNIQUE` means a second attempt to create the same delivery
  finds the existing row instead of creating one; a row already `sent` is never sent again. Duplicate
  sends are prevented by a database constraint, not by a caller remembering to check.
* **Retryable.** A sweeper picks up `pending`/`failed` rows whose `next_attempt_at` has passed, with
  exponential backoff, up to `maxAttempts` (default 5), then `dead` — visible in the UI rather than
  retried forever.
* **Auditable.** `report.email_attempted`, `report.email_delivered`, `report.email_failed`,
  `report.email_recipient_refused`.
* **Crash-safe.** `sending` is written before the provider call and includes the attempt number, so a
  process that dies mid-send leaves a row that says so rather than an ambiguous `pending`.

### 9.3 Recipient guardrail

`settings.report_recipients` (admin-set, validated as addresses) and
`settings.allowed_recipient_domains`. `resolveRecipients()` intersects them and refuses anything
outside — audited.

**The send API takes no recipient parameter at all.** There is no argument through which a task
description, a monday item, a brief or a coding agent could introduce an address. That is the
structural version of "do not allow arbitrary recipients from task prompts", and it is why external
customer-facing email is not merely disallowed in Sprint 3 but unreachable.

### 9.4 The email itself

Sections exactly as the brief specifies: Overnight Summary (completed / in progress / blocked) ·
What Changed · Pull Requests · Decisions Needed · Exceptions / Anomalies · Low-Confidence Assumptions ·
Estimated Human Hours · AI Usage · monday.com. Built by aggregating the per-run
`MorningReportDto`s Sprint 2 already produces, so there is one report generator, not two.

Length is bounded by construction: per-run contributions are one line each, the detail lives behind
links back to the Mac UI, and no log content is embedded. Text and HTML are both generated from the
same structure.

---

## 10. Model-backed resolvers

### 10.1 Where the model is allowed

```ts
interface ModelProvider {
  readonly name: string;
  complete(req: { system: string; prompt: string; maxTokens: number; schema?: JsonSchema })
    : Promise<{ text: string; json?: unknown; usage: { inputTokens, outputTokens } }>;
}
```

Implementations: `AnthropicModelProvider` (real), `NullModelProvider` (**default** — deterministic
behaviour unless explicitly enabled), `ScriptedModelProvider` (tests, including adversarial scripts).

Three seams, all of which already exist as functions:

| Seam | Deterministic today | Model-backed option |
|---|---|---|
| `structureConversation` | sentence classification | structure the free-flow brief; identify missing information |
| `resolveAnswer` | scored retrieval | answer an implementation question from supplied evidence |
| memory relevance | keyword coverage | estimate relevance of project memory |

### 10.2 What the model is structurally prevented from owning

The model never receives, and never returns, a decision. It receives **candidate sources the
deterministic layer already selected**, and returns `{ answer, reasoning, citedSourceIds }`.

Then, in code:

1. any `citedSourceId` not in the supplied set is **dropped** (a fabricated citation cannot survive);
2. if no cited source survives, the model's answer is **discarded** and the deterministic resolver's
   result is used instead;
3. **confidence is recomputed from the cited sources' authority and coverage** by the same function
   used without a model. The model does not report a confidence, and if it volunteers one it is
   ignored.

So the worst a compromised or hallucinating model can do is produce a fluent answer with a low
deterministic confidence — which the existing decision policy then treats as an assumption or a
blocker. Tests assert exactly this.

These stay in deterministic code and are never sent to a model: confidence thresholds, the execution
floor, risk classification, prohibited operations, git restrictions, sandbox rules, task eligibility,
approval state, budget stops, scheduling. `model.assisted_discovery` and `model.assisted_answer`
audit events record the provider, model, token usage and whether the output was accepted or rejected.

---

## 11. Evidence-based answers

`AgentAnswer` and `agent_questions` gain:

```ts
evidence: Array<{
  kind: 'repository_fact' | 'project_memory' | 'task_memory'
      | 'user_approved_decision' | 'previous_run' | 'monday_item' | 'inferred_assumption';
  ref: string;        // e.g. 'brief.constraints[2]', 'monday:item/8891/update/3'
  excerpt: string;
}>;
groundedness: 'established_fact' | 'assumption';
reasoningSummary: string;
```

The invariant that makes this more than a label: **`groundedness` is computed, not asserted.**
`established_fact` requires at least one evidence item of a factual kind (everything except
`inferred_assumption`); otherwise it is forced to `assumption` and the confidence is capped at just
below the answering threshold. There is no code path that writes a high-confidence ungrounded claim,
and a test asserts it by trying.

---

## 12. Schema changes (migration `0006_sprint3_night_shift.sql`)

New tables:

```
worker_tokens, monday_boards, monday_items, monday_writes,
night_shifts, night_decisions, discovery_investigations, email_deliveries
```

Altered:

```
workers        + sandbox_kind, sandbox_ready, sandbox_detail, token_issued_at,
                 rotation_requested_at;  − token_hash (moved to worker_tokens)
projects       + night_shift_approved, night_shift_approved_by, night_shift_approved_at
runs           + night_shift_id, monday_item_id, selected_by ('human'|'night_shift')
tasks          + monday_item_id
approvals      + source ('human'|'night_shift_policy'), policy_basis jsonb
agent_questions+ evidence jsonb, groundedness, model_assisted
repositories   + test_network ('none'|'egress')
settings       + require_sandbox, sandbox_provider, worker_token_max_age_hours,
                 worker_token_overlap_seconds, night_shift_enabled,
                 night_shift_safety_factor, night_shift_wrap_up_minutes,
                 night_shift_min_start_minutes, night_shift_large_task_min_minutes,
                 report_recipients jsonb, allowed_recipient_domains jsonb,
                 mail_provider, model_provider, model_assist_enabled,
                 monday_provider
```

Unchanged and untouched: `audit_events` (both triggers), `sessions`, `users`, `run_logs`,
`worktrees`, `git_violations`, `pull_requests`, `run_reviews`. New enum values are added to
`@mac/protocol` and to the matching CHECK constraints, keeping the schema-parity test green.

---

## 13. API changes

Human plane (all additive):

```
POST   /api/night-shift/start            POST /api/night-shift/stop
GET    /api/night-shift                  POST /api/night-shift/tick        (admin, for tests/ops)
GET    /api/night-shift/queue            GET  /api/night-shift/:id/decisions

GET    /api/monday/boards                POST /api/monday/boards           (admin)
PATCH  /api/monday/boards/:id            POST /api/monday/boards/:id/approve (admin)
POST   /api/monday/boards/:id/sync       GET  /api/monday/items?projectId=
POST   /api/projects/:id/night-shift-approval                              (admin)

POST   /api/workers/:id/rotate           POST /api/workers/:id/revoke-tokens (admin)
GET    /api/workers/:id/tokens           GET  /api/security                 (admin)

GET    /api/reports/deliveries           POST /api/reports/deliveries/:id/retry
GET    /api/runs/:id/investigations
```

Worker plane (two additions, same auth, same run-scoping):

```
POST /api/worker/rotate-token            rotate this worker's own credential
POST /api/worker/sandbox-attestation     report sandbox kind, availability and detail
```

`RunAssignment.coding` gains a `sandbox` block (provider, mounts the worker should establish, network
policy) built **server-side** at lease time, and the control envelope gains `rotateTokenRequested`.

---

## 14. UI changes

Extends the existing pages; no redesign (spec §23).

* **Night Shift** — Mac's state, active task and project, the queue, blocked tasks, tasks completed
  tonight, time until cutoff, usage state with its source label, worker health.
* **Night Queue** (same page, second panel) — candidate tasks with **every** eligibility check shown
  as pass/fail, priority, current confidence, effort estimate, and the recorded reason a skipped
  candidate was skipped.
* **monday.com** — project ↔ board mapping, column mapping, status-label mapping, night-shift
  eligibility, approval, and a sync button.
* **Security** — worker credential state (prefix, age, status, last rotation), rotate and revoke
  actions, and sandbox status per worker.
* **Reports** — extended with delivery status: recipients, provider message id, attempts, last error,
  and a retry action for a `dead` delivery.

---

## 15. Security implications

1. **Filesystem containment is now enforced by the OS**, not inspected afterwards. This is the single
   biggest change in the sprint and it closes Sprint 2's R-4.
2. **The environment is built from empty**, not filtered. A new secret-bearing variable introduced
   later is excluded by default rather than included until someone updates a regex.
3. **The worker credential rotates**, can be revoked instantly, and a rejected token is a first-class
   audit event. Sprint 1's R-1 is closed.
4. **monday.com credentials live only in the control plane.** The worker never sees them; nor does the
   coding agent, whose environment is built from an allowlist that cannot contain them.
5. **Prohibited monday.com operations are absent from the interface**, so they are not rules to
   remember. The column guard is a second, independent check.
6. **Email cannot address an arbitrary recipient** because the send API has no recipient parameter.
7. **The model owns no safety decision.** Fabricated citations are dropped, and confidence is always
   recomputed deterministically.
8. **Night-shift approval is recorded as a distinct authority** and can never be displayed or queried
   as a human approval.
9. **Three new fail-closed points**: sandbox unavailable, sandbox attestation missing at dispatch,
   sandbox plan invalid.

Residual risks are in §19.

---

## 16. Test plan

| Area | Coverage |
|---|---|
| **Sandbox — plan (unit)** | allowed paths accepted; a path outside the repository/workspace/tooling allowlist refused; `..` traversal refused after realpath; symlink escape refused; a credential-bearing path refused; workdir outside a rw mount refused; environment built from empty; network defaults. |
| **Sandbox — enforcement (real)** | Against whichever provider is available (Docker on this machine, bubblewrap on the VM): an allowed project file is readable **and writable**; an unrelated project's files are **not** present; a known secret location is **not** present; `cat ../../<secret>` fails; cancellation kills the sandboxed process; a bad plan refuses to open. Skipped **only** if no provider exists at all, and the skip is loud. |
| **Sandbox — fail closed** | A worker with no available provider refuses to run `claude_code` and reports `sandbox_unavailable` with the worktree preserved; the control plane will not dispatch a coding run to a worker that has not attested a sandbox while `requireSandbox` is on. |
| **Token rotation** | rotate issues a new working token; the old token works during the overlap; the old token fails after it; a revoked token fails immediately; a revoked token presented is audited; re-registration after revocation works; the worker rotates on an envelope request and reconnects; nothing plaintext is stored. |
| **monday.com (fake provider)** | read a task; assign to Mac; set In Progress; post a progress update; post a blocker; attach a PR link; set Ready for Review; **a due-date change is refused and audited**; **a delete has no method and the guard refuses the column**; items outside approved boards are invisible; write outbox retries and is idempotent. |
| **monday.com (opt-in, real)** | The same flow against a dedicated test board, gated on `MAC_MONDAY_LIVE_TEST=1`. Never part of `npm test`. |
| **Eligibility** | approved project accepted; unapproved project rejected; unapproved board rejected; wrong status rejected; unflagged item rejected; assigned-to-a-human rejected; blocked dependency rejected; confidence below floor rejected; confidence in the limited band rejected without a pre-approved scope and accepted with one; every verdict lists all checks, not only failures. |
| **Scheduling** | finish a task then start the next; a blocked task then an alternate task; same-project priority ordering; cross-project ordering only after the current project is exhausted; cutoff prevents an inappropriate new start; a large task near cutoff is refused while a small one is allowed; no eligible tasks → idle cleanly, not busy-loop; hard budget stop; soft threshold stop only when configured; every decision recorded with its rationale. |
| **Discovery investigation** | the repository answers → no human question; a previous run answers → no human question; project memory answers → no human question; monday context answers → no human question; all six exhausted → a human question is generated **and** the checked-source list is persisted; confidence is recalculated after investigation. |
| **Model-backed resolvers** | a scripted model's fabricated source id is dropped; a model answer citing nothing falls back to the deterministic resolver; a model-claimed confidence is ignored and recomputed; risk classification is unchanged by the model; audit records acceptance or rejection. |
| **Evidence** | an answer with a factual source is `established_fact`; one with none is forced to `assumption` with capped confidence; evidence refs are persisted and rendered. |
| **Email** | one morning report is sent; a transient failure retries; **a retry does not send twice**; an arbitrary recipient is refused; the provider message id is stored; `dead` after max attempts is visible; the send API has no recipient parameter (asserted structurally). |
| **E2E night simulation** | Two approved projects, several monday tasks, mock coding agent: one task completes → PR-ready → monday Ready for Review; one blocks → blocker posted, worktree preserved, **not** marked complete; Mac selects another eligible task; a project switch happens when the first project is exhausted; the cutoff ends the shift; exactly one morning email is delivered; the audit trail proves the whole sequence in order. |
| **Regression** | All 492 existing tests must still pass, unmodified. |

---

## 17. Failure and recovery strategy

| Failure | Behaviour |
|---|---|
| Sandbox provider unavailable mid-shift | The run fails `sandbox_unavailable`, the worktree is preserved, the shift stops starting coding work and reports it. It does **not** fall back to unsandboxed execution. |
| monday.com unreachable | Reads use the cached `monday_items` and the decision records say the data is stale. Writes queue in the outbox and drain later. A run never fails because a board is down. |
| monday.com write permanently rejected | The outbox row goes `dead` after backoff, surfaces in the UI, and the morning email lists it under Exceptions. Mac's own state is unaffected — monday.com is a projection. |
| Mail provider down | Deliveries retry with backoff; `dead` after 5 attempts and visible. The report itself is already persisted, so nothing is lost. |
| Worker dies mid-task | Unchanged from Sprint 2: the run stays `running` with a visible offline indicator; the worktree and commits survive on disk. The scheduler will not start new work on an offline worker. |
| Rotation persist fails on the worker | The old token is kept and rotation is retried. The overlap window is what makes this safe. |
| Control plane restarts mid-shift | `night_shifts` and `night_decisions` are durable; the tick resumes. No in-memory scheduler state survives, and none needs to. |
| A task blocks | Blocker recorded, posted to monday.com, worktree preserved, task **not** marked complete, run ends `blocked`-then-terminal with `completed_with_blockers`, and the shift continues with other work. A blocked task is distinguishable from a failed one by status and by the presence of a `run_blockers` row. |

---

## 18. Assumptions

| # | Assumption | Rationale |
|---|---|---|
| C-1 | Filesystem containment is the sandbox's guarantee; git safety remains the three existing layers. | Honest scoping. Claiming the sandbox prevents `main` from moving would be false while `.git` is writable inside it. |
| C-2 | Bubblewrap is the production provider; Docker is the portable one and the one proven on the development machine. | One plan, two translations. Neither is a different policy. |
| C-3 | Night-shift work is approved at project + board + item level, recorded as `night_shift_policy`, never as a human approval. | A multi-task night cannot ask a sleeping human, and conflating the two authorities in the trail would be worse than either. |
| C-4 | Autonomous selection requires the autonomous confidence band unless a limited scope was pre-approved for that task. | Spec §5 requires an explicit human decision in the 60–79 % band, and nobody is available to make it overnight. |
| C-5 | monday.com is a projection of Mac's state, never an input to his lifecycle. | Status changes on a board do not start, approve or stop a run. |
| C-6 | Microsoft Graph is the mail provider. | Spec §2 and §19 already give Mac a real company mailbox and a Microsoft identity; it also needs no new dependency. |
| C-7 | The model provider is **off by default**. | Determinism is the default posture for a system that runs unattended. |
| C-8 | Effort estimation is crude and labelled as such. | The requirement is to avoid obviously bad scheduling, not to predict durations. |
| C-9 | One run per worker at a time. | Sprint 1's dispatch model. Multi-task nights are sequential, which is what the requirement describes. |
| C-10 | The morning email is per night shift; per-run reports remain available in the UI. | One email per night is the requirement; per-run detail belongs behind a link. |

---

## 19. Risks

| # | Risk | Mitigation |
|---|---|---|
| T-1 | An agent inside the sandbox still reaches `.git` and could corrupt local refs. | The three git layers are unchanged, and layer 3 verifies the effect afterwards. Stated plainly rather than mitigated away. |
| T-2 | Docker's daemon is a privileged component; a worker that can talk to it can escape. | Bubblewrap is preferred in production precisely because it has no daemon. Where Docker is used, the worker's socket access is the deployment's trust boundary and is documented as such. |
| T-3 | Sandboxing slows coding sessions. | Bubblewrap adds ~10 ms. Docker adds container start time, which is why it is not the production default. |
| T-4 | Eligibility mis-configuration lets Mac take work he should not. | Two independent approvals (project, board), an optional per-item flag defaulting to required, and a verdict that shows every check in the UI so a mis-configuration is visible before the night rather than after it. |
| T-5 | The scheduler thrashes between projects. | Same-project-first ordering, and a project switch only when the current project has no eligible work. |
| T-6 | Effort estimation is wrong and a task is cut off mid-flight. | Worktrees are preserved and partial work is committed; the safety factor and wrap-up allowance are configurable; the decision and its rationale are recorded so the estimate can be tuned against reality. |
| T-7 | A model-backed resolver degrades answer quality subtly. | Off by default; citations verified; confidence recomputed deterministically; every model-assisted answer is audited and flagged in the report. |
| T-8 | Email delivers repeatedly after a partial failure. | Idempotency is a `UNIQUE` constraint, not a convention, and a `sent` row is never re-sent. |
| T-9 | monday.com API changes or rate-limits. | Behind an interface with a fake for tests; writes are an outbox with backoff and a dead-letter state; reads degrade to cache. |
| T-10 | The night shift runs while an engineer is also working. | Day mode remains the default; night shift is explicitly started, and a human-created interactive run is never pre-empted. |

---

## 20. Implementation order

Each step ends green before the next begins.

1. Protocol: enums, sandbox types, monday types, eligibility codes, mail and model types, new audit
   events and stop reasons.
2. Migration `0006` + drizzle schema + schema-parity test.
3. Sandbox: pure plan + unit tests; bubblewrap and docker providers + real conformance tests;
   worker wiring, attestation, fail-closed paths.
4. Token rotation: `worker_tokens`, auth resolution, rotate/revoke, envelope flag, worker persistence.
5. Domain (pure) + unit tests: eligibility, effort, night scheduler, investigation, evidence rules.
6. monday.com: client interface, fake, guard, GraphQL implementation, board mapping, sync, outbox.
7. Discovery investigation + evidence-based answers, wired into discovery and supervision.
8. Night-shift service, sweeper, routes.
9. Email: provider interface, fake, Graph implementation, outbox, sweeper, recipient guardrail,
   night-shift email assembly.
10. Model provider interface + null/scripted/Anthropic implementations behind the two seams.
11. E2E night simulation.
12. UI.
13. Documentation, self-review, completion report.

---

## 21. Design self-review against the specification

### 21.1 Checked against `Mac_Spec.md`

* §3 Night Shift Mode — the multi-task loop, the 08:00 Sydney cutoff and its configurability are all
  honoured; the cutoff computation is Sprint 1's, unchanged and DST-correct.
* §4 Discovery — Phase A now spans six source classes rather than one, and §6 makes "do not ask what
  you can find out" mechanical and falsifiable.
* §5 Confidence — untouched thresholds; §7.1 explains why autonomous *selection* needs the autonomous
  band even though autonomous *execution* after human approval may sit lower.
* §7 Blocking — a blocker no longer merely fails to stop the run; it now moves Mac to other eligible
  work, which is what §7 actually asks for.
* §8 Task Selection — the four-level preference order is implemented verbatim, and "Mac should not
  invent speculative work" is structural: candidates come only from approved monday items.
* §16 Permissions — updating approved monday fields is pre-approved; altering commercial priorities
  and deadlines is not merely disallowed but has no method.
* §17 monday.com — every listed capability is implemented; every listed prohibition is absent from
  the interface.
* §19 Email — Mac sends from his own mailbox; internal only.
* §25/§26 Budget and stop conditions — the scheduler consults usage before every start and records
  which of the hard or soft rule applied.
* §28 Morning Report — the email carries §16's structure and links back rather than embedding logs.

### 21.2 Judged over-engineered and removed

* **A separate scheduler process or workflow engine** — the tick is a third `setInterval` next to two
  that already exist.
* **A generic "integrations" framework** — there are now two integrations (monday.com, mail) and each
  has exactly one interface shaped by its own needs. A shared abstraction over them would be a
  framework with two users and no common behaviour.
* **Bidirectional monday.com sync** — a projection, as Sprint 2's sketch already argued.
* **A per-task container image build** — the image is admin-configured; building one per run would be
  a cluster platform, which the brief explicitly forbids.
* **A model-backed eligibility or scheduling decision** — forbidden by the brief and, independently,
  the wrong tool: these are predicates with correct answers.
* **Per-item monday.com webhooks** — polling on the night tick is sufficient and needs no inbound
  endpoint, preserving the no-inbound-surface property.

### 21.3 Ambiguities in the brief, and how they were resolved

| Ambiguity | Resolution |
|---|---|
| "Approved work" overnight, when Sprints 1–2 require per-run human approval | Approval moves up to project + board + item, recorded as a distinct authority (§7.2) |
| Which processes the sandbox must contain | The coding agent **and** the project test command; Mac's own git stays outside (§3.1) |
| Whether the sandbox must also prevent git damage | No — that is the existing three layers; the sandbox's guarantee is filesystem containment, stated honestly (C-1) |
| "Mark work complete where the configured workflow permits" | `monday_boards.may_complete`, default **false**, so Ready for Review is Mac's terminal state unless a human opted in |
| "Bounded transition period" for a rotated token | 300 s default, configurable; overlap exists for in-flight requests only |
| Effort estimation precision | Deliberately crude, labelled, and recorded so it can be tuned (C-8) |

### 21.4 Verdict

The design covers every item in the Sprint 3 brief and every Definition-of-Done clause, and nothing
in it is built for a system larger than the one described. Proceeding to implementation.
