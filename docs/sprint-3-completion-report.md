# Sprint 3 — Completion Report

**Branch:** `sprint-3/operational-night-shift` (17 commits, not merged)
**Default branch:** untouched — `main` is still at the specification commit
**Tests:** 723 passing (310 unit · 235 integration · 169 worker · 9 end-to-end), 6 opt-in skipped

---

## 1. What was built

Mac can now be handed approved work in monday.com and left alone with it.

The loop that runs is: an engineer approves a project, a board and the items on it, and goes home →
Mac picks the highest-priority eligible item, assigns it to himself and sets it In Progress → he
works inside an OS-enforced sandbox that can reach the assigned worktree and nothing else on the
machine → he leaves a pull request and moves the board to Ready for Review → when something blocks he
posts what he needs, preserves the work and moves to the next eligible task, switching projects when
his current one is exhausted → he stops when the cutoff, the budget or an empty queue says so → and
one short email is waiting at 08:00.

Concretely, this sprint added:

- an **execution sandbox** with two providers over one shared plan, wrapping the coding agent and the
  project's own test command;
- **worker credential rotation** with a bounded overlap, instant revocation, and server-initiated
  rotation that needs no VM access;
- a **monday.com integration** — read boards and items, assign, set status, post updates and
  blockers, attach pull requests — whose prohibited operations are absent rather than guarded;
- a **deterministic eligibility predicate** and a **night scheduler** with a safe-start check;
- **investigation across six source classes** before any human question, with the checked-source list
  persisted;
- **evidence-based answers** whose groundedness is derived rather than asserted;
- **model-backed resolvers** behind the existing seams, off by default and structurally unable to own
  a decision;
- **email delivery** of the morning report, idempotent by database constraint;
- four **UI screens** and eleven new settings.

---

## 2. Architecture changes

The modular monolith and the separate worker are unchanged. No queue, no Redis, no orchestration, no
new process. Three things moved:

**A trusted/untrusted split appeared inside the worker.** Sprint 2 ran everything in one process with
one filesystem view. Now Mac's own code — policy-checked git, evidence collection, control-plane
communication — stays outside a boundary, and everything that executes agent intent goes inside it.

**Two new outboxes.** monday.com writes and email deliveries are both rows written in the same
transaction as the state change that justified them, drained by sweepers. This is the audit-event
pattern applied to two more durable side effects, and it is why a run never fails because monday.com
is down.

**Three more sweepers**, next to Sprint 1's two: the night tick (30 s), the monday outbox (10 s) and
the mail outbox (20 s). All idempotent, all safe to miss, all `setInterval` in the same process.

Interfaces added, each with a real and a fake implementation: `ExecutionSandbox`, `MondayClient`,
`MailProvider`, `ModelProvider`. Every one is swappable, and the standard test suite runs entirely on
the fakes.

---

## 3. Sandbox technology chosen, and why

**Bubblewrap is the production provider; Docker is the portable one.** Both translate the same pure
`SandboxPlan`, so there is one policy with two back-ends rather than two policies that can drift.

Bubblewrap was chosen for the Linux VM for four reasons that all matter at 02:00: no daemon (nothing
to be running, and no socket whose access is itself an escalation), identity path mapping (a stack
trace from inside names a file a human can open), roughly ten milliseconds of setup, and ordinary
process semantics — `--die-with-parent` and signal forwarding mean Sprint 2's existing cancellation
path works untouched.

Docker exists for two concrete reasons. Most deployments already have it, and a VM that cannot get
bubblewrap should still run coding work safely rather than not at all. And — decisively — it is
available on the machine this sprint was written on, where bubblewrap is not. Without it, every
containment claim in Sprint 3 would have rested on tests that skipped, and a boundary whose
enforcement has never been observed is one nobody should trust, including its author.

`none` exists for development. It attests no containment, so the control plane withholds coding work
from that worker. It is not a way to run coding work unconfined.

---

## 4. Security properties proven

Against real Docker on the development machine, fourteen conformance tests run real processes inside
a real sandbox and demonstrate:

| Property | How it is shown |
|---|---|
| The assigned project is readable **and writable** | A file written inside appears on the host worktree |
| An unrelated project on the same machine is unreachable | `cat` of its secret fails; the directory does not exist |
| A known secret location is unreachable | `~/.ssh/id_ed25519` is absent, not merely unreadable |
| The worker's own credential file is unreachable | `mac_wk_…` never appears |
| Filesystem traversal cannot escape | Climbing out with `..` reaches the sandbox's own root, and no host content |
| Every path the plan declared denied is absent | The plan's `deniedWitnesses` are tested directly with `test -e` |
| The environment carries nothing from the worker | A variable set in the parent does not appear in `env` |
| The git shim cannot be rewritten from inside | A write to it fails; the host file is unchanged |
| Cancellation kills the sandboxed process | A 60 s sleep is aborted in about two seconds |
| Network isolation holds when the plan says `none` | No non-loopback interface exists |

Beyond containment:

- **Fail-closed is proven in three places**: the coding job refuses and reports `sandbox_unavailable`
  with the worktree preserved; the dispatch statement removes `claude_code` from the capabilities of
  a worker that has not attested a sandbox; and an invalid plan is a refusal carrying its reason.
- **Nothing is stored in plaintext.** Asserted before and after rotation.
- **A revoked or expired token is rejected and audited** — the signal that a killed credential is
  still in someone's hands.
- **monday.com cannot alter a due date or a priority.** The methods do not exist (asserted
  structurally), and the column guard refuses them by name (asserted behaviourally).
- **Email cannot reach an arbitrary recipient.** The send path has no recipient parameter, asserted
  by inspecting the function's own shape.
- **A model cannot ground an answer in a source that does not exist.** Fabricated citations are
  dropped; an answer citing nothing real is discarded entirely.

**What is not proven:** bubblewrap. The containment suite ran against Docker because the development
machine is Windows. The plan's rules are unit-tested on every platform and both providers translate
the same plan, but "bubblewrap enforced this" has not been observed and should be before the VM is
relied on.

---

## 5. Token rotation implementation

Credentials moved from a column on `workers` into a `worker_tokens` table, because rotation needs
several tokens per worker to exist at once and a single column cannot express that. `workers.token_hash`
was **dropped** rather than kept alongside: two sources of truth for the credential guarding code
execution is a footgun, and the one that drifts is always the one nobody tests.

Three statuses, and the middle one is the point:

- `active` — the current credential;
- `superseded` — replaced, still accepted until `expires_at`. A CHECK constraint makes a superseded
  token without an expiry impossible to store, so an unbounded overlap cannot exist. Default 300 s;
- `revoked` — rejected immediately, no grace.

**Rotation is requested through the control envelope**, which is on every worker-facing response. The
worker picks the request up on its next call and replaces its own credential. That is what satisfies
"the worker can rotate without requiring manual VM rebuilding": nobody logs in, and nothing dials the
worker. Automatic rotation past `workerTokenMaxAgeHours` (168) uses the same mechanism, so a VM that
is offline when its token ages out is not locked out — it rotates when it returns.

The worker persists the new token **before** adopting it, via write-then-rename, so a crash mid-rotation
leaves a usable credential rather than a truncated file.

Tested: rotation issues a working token; the old one works during the overlap and fails after it;
revocation kills everything instantly with no grace; a revoked token presented is audited; rotation
over rotation leaves exactly one active token; a revoked worker can re-enroll and reconnect while the
old credential stays dead; and rotation and revocation are admin-only.

---

## 6. monday.com integration behaviour

**Reads:** boards, groups, items, priority, status, assignee, due date, description, dependencies, the
per-item night-shift flag, item type, size, and the item's update feed — the last of which is where an
engineer writes "the CSV header must stay as it is" at 16:00, and Mac reading it at 02:00 instead of
asking is most of the point.

**Writes:** exactly five — assign to Mac, set status, post an update, post a blocker, attach a pull
request.

**Prohibitions are absent, not guarded.** There is no `setDueDate`, no `setPriority`, no `deleteItem`,
no `deleteBoard`, no `createBoard`, no `moveItem`, no `updateUser`, and deliberately no generic
`changeColumnValue` through which any of them could be reached — monday's own API is exactly that one
mutation, and it is private. A second, independent guard then checks the resolved column id against
the board's declared roles; the due-date and priority column ids are *stored* precisely so an attempt
on them is refused by name rather than merely missing from an allowlist.

**Scoping.** Mac reads only from boards in the mapping table, so he cannot roam every board the
connected account can see. The restriction is in the query, not in the token's permissions. Two
independent approvals gate autonomous work: the project must be approved for night shift and the
board must be mapped, approved and marked eligible.

**Completion is opt-in per board.** `mayComplete` defaults false, so Ready for Review is Mac's
terminal state unless a human decides otherwise.

**Writes are an outbox.** Written in the same transaction as the state change, drained with backoff,
dead-lettered after five attempts and surfaced in the UI. A refusal is terminal and is *not* retried —
retrying a refusal would be retrying a decision.

**Update discipline.** Mac posts on starting, on blocking and on becoming ready for review. He does
not post per progress tick. A board that receives forty updates a night is a board nobody reads.

Twenty-seven tests cover this against an in-memory provider that holds real state and applies real
writes, so a status Mac sets can be read back.

---

## 7. Autonomous scheduling behaviour

The decision function is pure and takes the whole state of the night. Its order matters:

1. **Deal with the current run first** — a finished or blocked run is finalised *before* the stop
   conditions are evaluated, or a night ends with an unreported result.
2. **Stop conditions** — operator stop, guardrail, cutoff, budget, no worker.
3. **Choose** — spec §8's order verbatim: the current project first, then monday priority, then due
   date, then board position, folded into one sort key so no caller can apply the tiebreakers
   differently. Same-project-first is not arbitrary: the repository is fetched, the tooling is warm,
   and the project memory is the one Mac has been reasoning with for the last hour.

**Eligibility is fourteen checks with no I/O and no model.** The question "may Mac start this now?"
has a correct answer, and a model asked it would be fluent, occasionally wrong, and impossible to
disagree with on a specific clause. Every check is reported whether it passed or failed, because the
Night Queue has to answer "why is this eligible?" as readily as "why was this skipped?".

The rule that matters most: **autonomous selection requires the autonomous confidence band.** Spec §5
lets the 60–79 % band proceed only with an explicit human decision on a narrower scope, and nobody is
awake at 02:00 to give one — unless a human already recorded such an approval for that specific task,
which is honoured. This is what stops "keep Mac busy" from quietly eroding the confidence model.

**Safe start.** Effort is a size class with a stated basis, not a duration prediction: it comes from
the brief's shape, the board's own size label (which wins, because a human who knows the codebase is
better evidence than counting acceptance criteria) and signals like migrations. The check reserves a
wrap-up allowance for the committing, testing, reviewing and reporting that all happen *after* the
agent stops, refuses anything inside a 20-minute floor, refuses large work without 90 minutes, and
allows a slightly-too-long task only when a partial result is useful and preservable.

**Approval authority.** A night-shift run is approved by policy, and recorded as such:
`approvals.source = 'night_shift_policy'`, the audit event is `run.auto_approved` rather than
`run.approved`, and the approver is null with the policy basis stored beside it. A machine approval is
never readable as a human one.

**Every decision is recorded**, including the refusals, with the rationale, the remaining minutes, the
budget basis, the usage source, and what was skipped and why. "Not eligible" and "eligible but not
enough night left" are different things and are recorded differently.

---

## 8. Model-backed discovery changes

Off by default. When on, it sits behind the two seams Sprint 2 designed for it.

**Answering.** The model receives candidate sources the deterministic layer already selected and
returns `{ answer, reasoning, citedSourceIds }`. There is no field for a confidence, a decision or a
risk class — not "checked afterwards", but absent from the type. Then: a cited id that was not
supplied is dropped; if nothing survives, the answer is discarded and the deterministic result stands;
and confidence is recomputed from the surviving sources by the same function used with no model. The
worst a hallucinating model can do is produce fluent prose carrying a low deterministic confidence.

**Structuring** needed a different check, because it has no natural grounding test: the model is
handed prose and asked to sort it, so a fabricated constraint looks exactly like a real one — and it
would go on to *raise* the understanding confidence that decides whether Mac may execute at all.
So every string it returns must share distinctive vocabulary with what the engineer actually said, or
it is dropped and the count is audited. And it may only fill fields the sentence classifier left
empty: a field the classifier filled holds the engineer's own words, and a rephrasing might be tidier
and might also be subtly different.

**Investigation** is the larger change and needs no model at all. Six source classes — repository,
project memory, task memory, previous runs, previous briefs, the monday item's own updates — consulted
in order, with a human asked only once all six have been checked. Every source class is visited even
after one has already answered, because "checked the repository and stopped" is a different claim from
"checked all six", and only the second justifies waking someone. The checked-source list is persisted
whether or not the investigation succeeded.

**Evidence.** An answer now carries the material it rests on, and whether it is an established fact or
an assumption — derived from the evidence, never asserted. An answer with nothing factual behind it is
forced to `assumption` and capped below the answering threshold, so there is no code path that writes
an ungrounded high-confidence claim.

Deterministic code still owns: confidence thresholds, the execution floor, risk classification,
prohibited operations, git restrictions, sandbox rules, task eligibility, approval state, budget stops
and scheduling. None of it is reachable from a model.

---

## 9. Email delivery implementation

Microsoft Graph, because spec §2 and §19 already give Mac a real PAC Technologies mailbox and a
Microsoft identity — this is the mailbox he is supposed to send from, not a parallel one. `fetch` only,
no new dependency. A recording fake covers the standard suite.

- **Idempotent by constraint.** The key is `morning-report:<nightShiftId>`, and it is a `UNIQUE`
  column. A second attempt to queue finds the first row; a row already `sent` is never sent again.
  Duplicate sends are prevented by the database, not by a caller remembering.
- **Retryable.** Exponential backoff, five attempts, then `dead` and visible on the Reports screen
  rather than retried forever where nobody would notice the report never arrived.
- **Crash-safe.** `sending` and the attempt count are written *before* the provider call, so a process
  that dies mid-send leaves a row that says so rather than an ambiguous `pending`.
- **Auditable.** Attempt, delivery, failure and recipient refusal.
- **Recipients are a shape, not a check.** The send path has no recipient parameter anywhere in its
  signature or its call chain; addresses are read from settings immediately before sending. That is
  why external customer-facing email is not merely disallowed in Sprint 3 but unreachable.

The email carries §16's structure exactly, one line per task, no log content, and links back to the UI
for the detail. Usage always carries its source label, and a non-exact figure says "not billed" and
"not an enforceable dollar figure" in as many words.

---

## 10. Schema changes

Migration `0006_sprint3_night_shift.sql`.

**New tables:** `worker_tokens`, `monday_boards`, `monday_items`, `monday_writes`, `night_shifts`,
`night_decisions`, `discovery_investigations`, `email_deliveries`.

**Altered:**

- `workers` + sandbox attestation columns, token timestamps, rotation flag; **−`token_hash`**
- `projects` + night-shift approval
- `runs` + `night_shift_id`, `monday_item_id`, `selected_by`
- `tasks` + `monday_item_id`
- `approvals` + `source`, `policy_basis`
- `agent_questions` + `evidence`, `groundedness`, `model_assisted`, `sources_checked`
- `repositories` + `test_network`
- `settings` + fourteen columns

**Untouched:** `audit_events` and both its immutability triggers, `sessions`, `users`, `run_logs`,
`worktrees`, `git_violations`, `pull_requests`, `run_reviews`.

Three CHECK constraints exist to make a bad state unstorable rather than merely unlikely: a superseded
token must have an expiry, a `sent` delivery must have a timestamp, and the night-shift safety factor
must be between 1 and 5. The schema-parity test covers eighteen new enum constraints.

---

## 11. Tests performed

| Layer | Count | What is real |
|---|---|---|
| Unit | 310 | Pure domain. Containment rules, eligibility, effort, scheduling, budget classification, investigation, grounding — all with no I/O |
| Integration | 235 | Real PostgreSQL, real HTTP. Rotation, revocation, the sandbox dispatch guardrail, monday.com against a stateful fake, the night shift, adversarial model scripts, email delivery |
| Worker | 169 | Real processes and real repositories. **Containment against a real sandbox provider**, the git shim as a real process, both providers' argv, the coding job's fail-closed path |
| End-to-end | 9 | Real server, real worker process, real Postgres, real git with real bare remotes. Including a whole night |
| Opt-in | 6 | Real Claude Code CLI (1), real monday.com board (5) |

The end-to-end night simulation is the sprint's central piece of evidence: two approved projects with
real repositories, three items briefed through real discovery, a real worker leasing and executing
each one. One completes and produces a pull request; one blocks on a question Mac may not answer
alone; he switches projects; the cutoff ends the shift; exactly one email is delivered; and the audit
trail is asserted in order with `main` proven untouched in both repositories.

---

## 12. Test results

**723 passing, 0 failing, 6 opt-in skipped.** All 492 Sprint 1 and Sprint 2 tests still pass.

Four pre-existing tests were adjusted, none of them to weaken an assertion:

- the worker-token storage test now reads `worker_tokens` (the property — nothing plaintext at rest —
  is unchanged and strengthened with a status assertion);
- the heartbeat-audit test compares against the post-registration state rather than a fixed list,
  because registration now legitimately emits an attestation;
- the `registerTestWorker` fixture attests a working sandbox by default, since that is what a
  correctly provisioned worker looks like, and a test that wants the withholding behaviour asks for
  `sandbox: null` explicitly;
- the Sprint 2 coding e2e turns `requireSandbox` off in one line with a comment saying why — its agent
  is the in-process mock and spawns nothing, so there is nothing for a sandbox to contain.

---

## 13. Real external integration tests performed

**Docker: yes.** The containment suite ran against real Docker on this machine and passed all
fourteen assertions. This is the sprint's strongest external evidence.

**Bubblewrap: no.** Windows development machine. Written, and will run on the Linux VM.

**monday.com: no.** The opt-in test is written and gated; no credentials were available. This is the
largest gap in Sprint 3's evidence — the fake proves the behaviour *around* the calls, but not that
the GraphQL documents and column-value shapes are accepted by the live API.

**Microsoft Graph: no.** Same shape of gap, smaller surface.

**Claude Code CLI: not re-run this sprint.** Sprint 2's opt-in test still exists and still passes when
enabled; nothing in Sprint 3 changed the adapter's protocol, only how it is spawned.

**Browser: partially.** The control plane and web app were run together and the SPA loads with the new
routes and no application console errors. The authenticated screens were not driven, because doing so
would have meant entering a password, which is not something to do on someone's behalf.

---

## 14. Defects found and fixed

| # | Defect | Found by |
|---|---|---|
| 1 | The sandbox plan builder added tooling mounts to its own allowed-roots list, so each such mount authorised itself — a check that read as rigorous and enforced nothing | A unit test I expected to pass |
| 2 | The conformance suite decided its skips in `beforeAll`, which vitest runs after collection — so every containment test would have silently skipped on a host that could run them | Watching it report green in 0.8 s |
| 3 | `sandboxOptions` never reached the coding job, so a real run auto-resolved a provider and an image nobody configured | The Sprint 2 e2e failing with `exec: "node": not found` |
| 4 | An unapproved project made its monday items invisible rather than explicably skipped — the commonest misconfiguration would have had no feedback | A night-shift test asserting the skip reason |
| 5 | A completed task stayed eligible. A completed run leaves nothing in flight, and if the monday write had not landed the item was still startable — Mac would have done the work twice and opened two pull requests | The project-switch test picking the same item twice |
| 6 | **Sprint 1:** `markStaleWorkersOffline`'s `OR` escaped its `AND` chain, so the sweeper re-marked and re-audited every already-offline worker every 15 s — ~5,700 audit rows a day for one dead VM, precisely the flooding the decision not to audit heartbeats exists to prevent | Reading the development log |
| 7 | The morning report was queued inside the transaction that ended the shift, so it would have summarised a night that had not finished | Reasoning about it while writing the test |
| 8 | `sandbox.created` and `model.assisted_discovery` were declared in the audit enum and never emitted — and `structureBriefWithModel` was written and never called | Self-review against the brief's event list |
| 9 | `nightShiftEnabled` existed in the schema, the DTO and the update contract, and nothing read it | Self-review |
| 10 | `approvals.source` was recorded and never exposed, so the UI would have rendered a machine approval as a blank approver | Self-review |

Two behaviours were also corrected rather than being defects exactly: a run finishing with an
unresolved blocker is now treated as a blocked task rather than a clean completion, and the git shim's
violations file moved out of the (now read-only) shim directory.

---

## 15. Assumptions made

1. Filesystem containment is the sandbox's guarantee; git safety remains Sprint 2's three layers. An
   agent inside can reach `.git`, because git must work.
2. Bubblewrap in production, Docker for portability and for provable evidence here.
3. Night-shift work is approved at project + board + item level, recorded as `night_shift_policy`,
   never as a human approval.
4. Autonomous *selection* requires the autonomous confidence band unless a limited scope was
   pre-approved for that task.
5. monday.com is a projection of Mac's state, never an input to his lifecycle.
6. Microsoft Graph is the mail provider.
7. Model assistance is off by default.
8. Effort estimation is a size class, not a duration.
9. One run per worker; multi-task nights are sequential.
10. One email per night shift; per-run reports stay in the UI.
11. A monday item with no handoff brief is not startable. Discovery happens during the day, with a
    person. Mac does not invent a brief for work he has never discussed.

---

## 16. Remaining security concerns

1. **The Docker daemon is a trust boundary.** A worker that can reach its socket can escape any
   container it starts. This is exactly why bubblewrap — which has no daemon — is the production
   choice, and why the Docker provider should be understood as the portable fallback.
2. **Bubblewrap's enforcement is unobserved.** Rules unit-tested, argv unit-tested, enforcement not
   witnessed. Run the suite on the VM.
3. **`.git` is writable inside the sandbox.** Stated plainly rather than mitigated away. The three git
   layers and the post-run verification are what cover it.
4. **A compromised worker token still yields code execution on the VM.** Rotation and instant
   revocation shorten the window; they do not close it.
5. **The monday.com token lives in the control plane's environment.** No secret manager yet — a
   Sprint 1 limitation that now guards more.
6. **Night-shift approval is coarse.** Approving a project and a board authorises Mac for every
   flagged item on it, indefinitely, until somebody revokes it. The per-item flag is the fine-grained
   control and it defaults to required, but nothing expires.
7. **Model assistance widens the input surface when enabled.** Citations are verified and confidence
   is recomputed, so the blast radius is a badly worded answer rather than a bad decision — but a
   model is a third party reading brief content.

---

## 17. Technical debt

- **Two integrations unproven against the real thing** (monday.com, Graph). Tests written and gated.
- **Bubblewrap unproven.** Same shape.
- **The authenticated UI has not been clicked through.**
- **A run whose worker disappears still waits for a human.** Inherited from Sprint 1, and it matters
  more now: a stuck run idles the whole shift, since the scheduler will not start work while one is in
  flight.
- **`ensureTaskForItem` is written and unused.** The night shift only takes items a human already
  prepared, so nothing calls it. It should be deleted or wired to an explicit "adopt this item"
  action; leaving it is the same category of untruth as the two unemitted audit events.
- **Effort estimation has no feedback loop.** Estimates and outcomes are both recorded and nothing
  compares them.
- **Logs are still polled**, auth is still local passwords, still one control-plane process, still no
  CI pipeline or secret manager.
- **Enum lists are still duplicated** between `schema.ts` and the SQL migrations. Safe, because the
  schema-parity test fails if they diverge, but it is duplication.

---

## 18. Equivalent human engineering hours

Roughly **12–17 engineer-days** for someone who already knew this codebase, or three to four weeks for
someone who did not.

The estimate is dominated by three things rather than by volume: getting the containment boundary
right and provable (3–4 days, most of it deciding what the boundary *is* and how to demonstrate it);
the monday.com integration with its two approval gates, the write guard and the outbox (3–4 days); and
the scheduler with its eligibility predicate, effort model and decision records (3–4 days). Rotation,
investigation, email, the model resolvers and the UI account for the rest.

Around 12,000 lines of TypeScript and SQL were added, roughly 40 % of it tests. Basis: file counts,
subsystem count, and the six defects that took real debugging. Order-of-magnitude only.

---

## 19. Recommended Sprint 4 scope

1. **Prove the three unproven integrations.** Run the containment suite under bubblewrap on the VM,
   the live monday.com test against a dedicated board, and one real Graph send. All three are written
   and skipped, and until they run the confidence in them is inherited from their fakes.
2. **Microsoft Teams.** The single highest-value addition. A blocker at 02:00 currently waits until
   08:00; the spec already names Teams as the notification channel, and it is what makes a blocked
   task cost minutes instead of a night.
3. **Drive the UI in a browser**, including the night-shift screens.
4. **Lease recovery.** A run whose worker never returns now idles an entire shift.
5. **A second coding agent (Codex)**, to prove the `CodingAgent` abstraction by using it twice.
6. **Otto collaboration** over real mailboxes, now that Mac can send email.

Explicitly *not* recommended: revisiting the control loop, the guardrails, the git safety model, the
audit model, the sandbox or the scheduler. And not OpenClaw — computer control is a fallback, and Mac
does not yet need one.

---

## The question the brief asks

> Can Mac now be treated as a practical night-shift engineering employee who can take approved work
> from monday.com, work through multiple tasks safely, update the board, and leave a concise morning
> report without requiring a human to supervise the night?

**Yes — with one qualification that matters, and it is about evidence rather than about the code.**

The loop works and is demonstrated end to end against real infrastructure. Mac takes approved work
from a board, assigns it to himself, executes it inside a boundary that is proven to exclude every
other project and secret on the machine, leaves reviewable pull requests, posts blockers instead of
guessing, moves to the next task and to the next project, stops when he should, and sends one email.
Every decision he makes overnight — including the ones not to do something — is in an immutable audit
trail, and `main` is untouched throughout.

The qualification: **two of the three external systems he depends on have only ever been exercised
against fakes.** monday.com and the mailbox are proven in behaviour and unproven in wire format. If
the first real board write fails, the outbox retries, dead-letters and surfaces it — the failure mode
is visible rather than silent, which is the right one — but the night would produce a correct result
that nobody was told about. Running the two opt-in tests is perhaps an hour of work and it is the
difference between "should work" and "does".

There is also a narrower honest caveat: he is a night-shift employee who needs his work prepared. A
monday item nobody has done discovery on has no understanding confidence, and he will not touch it.
That is a deliberate consequence of the confidence model rather than a gap, but it means the
engineer's day still includes fifteen minutes of handing over — which is, in fairness, what handing
work to a colleague has always cost.
