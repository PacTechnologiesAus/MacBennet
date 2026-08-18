# Mac Bennett — Specification Reconciliation

**Date:** 2026-08-18
**Governing document:** `Mac_Spec.md` (V1 Product & System Specification)
**Implementation reviewed:** `main` @ `924e39a` (Sprints 1, 2, 3, 3.1, 3.2 merged)
**Author:** Sprint 3.3 preparation
**Status:** Reconciliation complete. Findings feed Sprint 3.3 scope.

---

## 1. Why this document exists

Sprint documents 1 through 3.2 are records of *implementation decisions*. `Mac_Spec.md` is the
statement of *product intent*. Over five sprints the two have diverged, and the divergence was
discovered the way these things usually are — a real user created a real task and it could not run.

The task was:

> **Investigate PAC Project Registry, Document Controller & Sales Engineer**
> Project: PAC Internal Development · status `draft` · priority `high` · no monday item · no repository

The system correctly reported seven independent blockers. Six were configuration. The seventh was
architectural, and it is the reason for this document:

> The autonomous execution path is built around monday-backed coding work. This is a legitimate
> technical research task with no repository and no code change, and there is no path through the
> system for it.

This document reconciles every material requirement in `Mac_Spec.md` against what exists, and says
plainly where the implementation has become **narrower than the spec**. It does not redefine the spec
to match the code. Where a later human decision genuinely changed intent, that is recorded as such and
the decision is named.

---

## 2. Method

Read in full:

* `Mac_Spec.md` (33 sections)
* `docs/sprint-1-design.md`, `docs/sprint-2-design.md`, `docs/sprint-3-design.md`
* `docs/sprint-3.1-commissioning-report.md`, `docs/sprint-3.1-handover.md`
* `docs/sprint-3.2-company-context-design.md`, `docs/sprint-3.2-completion-report.md`
* `docs/sprint-3-completion-report.md`, `docs/monday-integration-design.md`
* The implementation: `packages/protocol`, `apps/server`, `apps/worker`, `apps/web`
* The live development database (the real draft task and its two projects)

Every "implemented" claim below was checked against code, not against a completion report. Where a
completion report and the code disagree, the code wins and the disagreement is noted.

---

## 3. State definitions

| State | Meaning |
|---|---|
| **Implemented** | The spec requirement is met by code that runs, with tests. |
| **Partially implemented** | Some of the requirement is met; a named part is missing or conditional. |
| **Not implemented** | Nothing exists. Usually deliberate deferral. |
| **Changed by explicit decision** | Intent genuinely changed, by a decision recorded in a sprint document and accepted by a human. Not drift. |
| **Implementation drift** | The code is **narrower than, or differently shaped from, the spec** without any recorded human decision to make it so. This is the category that matters. |

"Recommended target sprint" is a proposal, not a commitment.

---

## 4. Reconciliation matrix

### 4.1 Identity and communication (spec §1, §2)

| # | Original requirement (`Mac_Spec.md`) | State | Evidence / gap | Target |
|---|---|---|---|---|
| 1.1 | Mac is a **persistent autonomous technical employee**, not a chatbot | **Implementation drift** | Persistence, audit and the control loop are real. But "technical employee" narrowed to "coding delegate": the only substantive execution capability is `claude_code` (`packages/protocol/src/jobs.ts`). A technical employee who can only produce commits is a coding agent with extra steps. | **3.3** |
| 1.2 | Take technical work from human engineers | Partially implemented | Tasks can be created in the UI (`apps/web/src/pages/Tasks.tsx`), but a directly-created task has no route to execution unless it is coding work in an approved repository, mirrored to an approved monday board. | **3.3** |
| 1.3 | Understand work through natural conversation | Implemented | `apps/server/src/services/discovery.ts` — free-flow messages, one question at a time. | |
| 1.4 | Inspect existing project context independently | Partially implemented | Repository inspection (`repo_inspect` job) and company context exist. There is no context inspection for a project **without** a repository. | **3.3** |
| 1.5 | Develop sufficient understanding before execution | Implemented | Gap analysis + derived confidence (`domain/gap-analysis.ts`, `domain/confidence.ts`). | |
| 1.6 | Delegate coding to coding agents such as Claude Code | Implemented | `apps/worker/src/coding/claude-code-adapter.ts`, commissioned for real in Sprint 3.1. | |
| 1.7 | **Perform general computer-based work using appropriate tools** | **Not implemented** | This clause is in the spec's own summary of Mac's purpose. Nothing in the system performs non-coding work. This is the single largest gap. | **3.3** |
| 1.8 | Work autonomously overnight | Partially implemented | Night shift exists and is real (`services/night-shift.ts`) — but only over monday-backed coding tasks. | **3.3** |
| 1.9 | Make reasonable assumptions rather than stopping | Implemented | `domain/supervision.ts` + `run_assumptions`. | |
| 1.10 | Keep a complete audit trail | Implemented | `audit_events`, append-only, trigger-enforced (`drizzle/0002_audit_truncate_guard.sql`). | |
| 1.11 | Escalate uncertainty without blocking | Implemented | `run_blockers`, blocker → continue other work. | |
| 1.12 | Update project-management systems | Implemented | monday.com outbox (`services/monday/outbox.ts`). | |
| 1.13 | Prepare completed work for human review | Partially implemented | PR path complete. **No review path for a non-code deliverable** — there is no artefact model at all. | **3.3** |
| 1.14 | Never merge to main autonomously | Implemented | Enforced in the git shim before git sees the command (`apps/worker/src/git/shim.ts`), with 16 tests. | |
| 2.1 | Real PAC email account | Implemented | Sprint 3.1 commissioned real SMTP delivery. | |
| 2.2 | Microsoft Teams identity | Not implemented | Deferred; explicitly out of scope in Sprints 1–3.3. | Post-3.3 |
| 2.3 | GitHub repository access | Implemented | `services/repositories.ts`, approval-gated. | |
| 2.4 | monday.com access | Implemented | Sprint 3.1 commissioned real API access. | |
| 2.5 | Dedicated cloud workstation | Implemented | Linux worker + Bubblewrap sandbox (Sprint 3.1). | |
| 2.6 | Voice interaction | Not implemented | Deferred by every sprint scope statement. | Post-3.3 |
| 2.7 | Communication style: informal, concise, direct | Partially implemented | Report and PR prose match the register. There is no conversational surface where style is exercised beyond discovery. | Post-3.3 |

---

### 4.2 Operating model (spec §3)

| # | Original requirement | State | Evidence / gap | Target |
|---|---|---|---|---|
| 3.1 | **Day Mode**: answer questions, inspect repositories, analyse problems, perform discovery, discuss requirements, draft specifications, prepare plans, review code, inspect monday, prepare tasks, provide recommendations | **Implementation drift** | Discovery and monday inspection exist. But there is no day-mode *execution of analysis work*: "analyse problems", "draft specifications" and "provide recommendations" are things Mac is supposed to **do and deliver**, and there is no capability that produces such a deliverable. `interactive` execution mode exists but its only real job kind is coding. | **3.3** |
| 3.2 | Mac makes no project changes during Day Mode unless instructed | Implemented | `execution_mode = interactive` requires explicit human approval of a run. | |
| 3.3 | Human can explicitly authorise execution during the day | Implemented | Approve a run with `executionMode: 'interactive'`. | |
| 3.4 | **Night Shift**: autonomous approved work | **Implementation drift** | Implemented as an autonomous *coding* mode. `startSelectedTask` (`services/night-shift.ts`) hard-codes `jobKind: 'claude_code'` and returns `null` if the project has no approved repository. The spec describes a general autonomous work mode of which coding is one kind. | **3.3** |
| 3.5 | Night workflow steps 1–18 (select project → … → morning report) | Partially implemented | Steps 1–13 and 15–18 exist for coding work. Step 14 ("delegates coding work **where appropriate**") has been read as "always", which is exactly where the generality was lost. | **3.3** |
| 3.6 | Hard stop 08:00 Australia/Sydney, configurable | Implemented | `domain/overnight.ts`, settings-driven, DST-correct. | |

---

### 4.3 Discovery and handoff (spec §4)

| # | Original requirement | State | Evidence / gap | Target |
|---|---|---|---|---|
| 4.1 | Phase A — inspect available information before asking | Partially implemented | Repository inspection is real. Company context is **loaded as model grounding** but is not consulted as an investigation source during discovery — `runInvestigation` is called only from `services/supervision.ts` (coding-agent questions), never from discovery's question path. So at discovery time Mac can still ask a human something PAC policy already answers. | **3.3** |
| 4.2 | Phase A later includes monday, GitHub issues, HubSpot, email, Otto, Forger | Partially implemented | monday: yes. The rest: deferred as specified ("later"). Not drift. | Post-3.3 |
| 4.3 | Establish what changed since Mac last worked on the project | Implemented | `changedSinceLastInvolvement` in the context snapshot. | |
| 4.4 | Phase B — free-flow conversation, Mac primarily listens | Implemented | `addDiscoveryMessage` records without interrogating. | |
| 4.5 | Phase C — structured understanding, 14 named fields | Implemented | `handoffBriefContentSchema` covers all 14. | |
| 4.6 | Phase C brief must suit the work | **Implementation drift** | The brief schema is *code-shaped*: `mustNotChange`, `likelyAffectedComponents`, `testingExpectations`, `implementationConsiderations`. A research brief has no natural home for its objective, sources, deliverables or acceptance criteria beyond forcing them into coding fields. | **3.3** |
| 4.7 | Phase D — gap analysis, ask one question at a time | Implemented | `domain/gap-analysis.ts`, `pendingQuestion` is a single object, not a list. | |
| 4.8 | Avoid asking questions the repository or connected systems can answer | Partially implemented | Honoured for the repository. Not honoured for company context at discovery time (see 4.1). | **3.3** |
| 4.9 | **A draft task has a visible path into discovery** | **Implementation drift** | Not in the spec as a sentence, but it is the necessary consequence of §4. In practice the New Task form creates a `draft` row and the Task Detail page offers only "New run" — there is no Start Discovery action anywhere (`apps/web/src/pages/TaskDetail.tsx`). Discovery is reachable only from `/discovery`, which requires the user to understand the model. This is the UX half of the reported failure. | **3.3** |

---

### 4.4 Confidence, assumptions, blockers (spec §5, §6, §7)

| # | Original requirement | State | Evidence / gap | Target |
|---|---|---|---|---|
| 5.1 | Confidence on **understanding** | Implemented | Derived from weighted completeness dimensions; `handoff_briefs.confidence`. | |
| 5.2 | Confidence on **individual decisions** | Implemented | `agent_questions.confidence`, capped when ungrounded. | |
| 5.3 | <60% — no substantive implementation | Implemented | Non-overridable floor, enforced at approval and at eligibility. | |
| 5.4 | 60–79% — limited scope, explicit human choice | Implemented | `scope_kind = 'limited'` + `thresholdOverridden` approval. | |
| 5.5 | 80–89% / 90%+ bands | Implemented | `domain/confidence.ts` bands. | |
| 5.6 | Thresholds configurable | Implemented | Settings. | |
| 5.7 | **Understanding confidence is derived, not asserted** | **Implementation drift** | `tasks.confidence` is a free-text numeric on the task creation form (`apps/web/src/pages/Tasks.tsx`), typed by a human, labelled simply "Confidence". The real acceptance task carries `0.700` typed by a person. It is not used for execution gating — that reads `handoff_briefs.confidence` — but presenting a manual number under the same word as the derived one invites exactly the substitution the spec forbids. | **3.3** |
| 6.1 | Prefer forward progress; record question, answer, reasoning, confidence | Implemented | `agent_questions` with all four. | |
| 6.2 | Low-confidence assumptions flagged in the morning report | Implemented | `flaggedAssumptions` in the report DTO. | |
| 7.1 | A blocker does not stop the shift | Implemented | `record_blocker` → continue. | |
| 7.2 | Teams message when blocked | Not implemented | Teams deferred. Email substitutes at shift end. | Post-3.3 |
| 7.3 | Continue other work; check other tasks; move to another project | Implemented | `domain/night-scheduler.ts` — but only over monday candidates. | **3.3** |

---

### 4.5 Task selection (spec §8)

| # | Original requirement | State | Evidence / gap | Target |
|---|---|---|---|---|
| 8.1 | Direct instructions have highest priority | **Implementation drift** | The scheduler has no notion of a direct instruction. `collectCandidates` (`services/night-shift.ts`) begins `const boards = await readableBoards(); if (boards.length === 0) return [];` — a task with no monday board is invisible to the scheduler, whatever its priority. A directly-assigned high-priority task ranks below nothing; it does not rank at all. | **3.3** |
| 8.2 | Then highest-priority eligible in current project | Implemented | `orderCandidates`, monday priority. | |
| 8.3 | Then other eligible in current project | Implemented | Same-project-first comparator. | |
| 8.4 | Then highest-priority across approved projects | Implemented | Cross-project fallback exists. | |
| 8.5 | "monday.com will **eventually** be the primary source for task priority" | **Implementation drift** | The spec says *eventually* and *a* source. The implementation made it the *only* source. `evaluateEligibility` (`domain/eligibility.ts`) takes `board` and `item` as **required** inputs and runs three board-specific checks before it looks at Mac's own state. There is no way to express an eligible task that has no board. | **3.3** |
| 8.6 | Do not invent speculative work to stay busy | Implemented | Candidates come only from recorded work. | |

---

### 4.6 Memory and sources of truth (spec §9, §10)

| # | Original requirement | State | Evidence / gap | Target |
|---|---|---|---|---|
| 9.1 | Global / project / task memory layers | Implemented | `memory_entries.scope`. | |
| 9.2 | Task memory must not contaminate other tasks | Implemented | Queries scoped by `taskId`; verified by test. | |
| 9.3 | High-confidence facts may be promoted to project memory | Implemented | `memory.promoted` audit event. | |
| 9.4 | Assumptions must not become project facts unless validated | Implemented | `deriveGroundedness` — groundedness is computed, never asserted. | |
| 10.1 | Code source of truth = GitHub | Implemented | | |
| 10.2 | Task status source of truth = monday.com | **Changed by explicit decision (partially)** | Sprint 3 made monday authoritative for *monday-backed* work, which is correct. What was never decided is that work must therefore *have* a monday item. §10 names monday as the source of truth for **task status**, not as the definition of what a task is. | **3.3** |
| 10.3 | Conflicts logged rather than silently resolved | Implemented | Sprint 3.2 precedence ladder (`domain/context-precedence.ts`). | |
| 10.4 | Company context (Sprint 3.2 addition, consistent with §9 global memory) | Implemented | Versioned, provenance-bound, immutable per run. | |

---

### 4.7 Workstation, coding agents, Git, PRs (spec §11–§15)

| # | Original requirement | State | Evidence / gap | Target |
|---|---|---|---|---|
| 11.1 | Dedicated cloud VM behaving like Mac's workstation | Implemented | Linux worker. | |
| 11.2 | Persistent workspace; per-task isolated worktrees | Implemented | `worktrees` table, preserved by default. | |
| 11.3 | Secure secret storage | Implemented | `services/worker-credentials.ts`, sandbox-scoped. | |
| 11.4 | Eventually OpenClaw / computer-control layer | Not implemented | Explicitly future scope in §21 and in Sprint 3.3's own exclusions. | Post-3.3 |
| 12.1 | Mac is the manager, coding agents are workers | Implemented | Brief-driven delegation. | |
| 12.2 | Mac must not forward the raw human prompt | Implemented | The rendered brief is what the agent receives. | |
| 12.3 | Monitor, answer agent questions, log Q&A, verify, test, review, iterate | Implemented | `services/supervision.ts`, `services/reviews.ts`. | |
| 13.1 | Disciplined engineering workflow | Implemented | Self-review + test gate. | |
| 14.1 | Every execution task in an isolated branch/worktree | **Implementation drift (scope)** | Correct and strictly enforced **for coding work**. Read as a universal precondition, it forces non-coding work to invent a repository. §14's own words are "every *execution* task", written in a document whose §1 also promises general computer-based work — the reconciliation is that Git isolation is the isolation mechanism *for work that touches code*. | **3.3** |
| 14.2 | Naming identifies Mac and the task | Implemented | `mac/<n>-<slug>`. | |
| 14.3 | Never merge to main | Implemented | Shim-enforced. | |
| 15.1 | PR opened when criteria met, with 8 named sections | Implemented | `domain/report.ts`. | |
| 15.2 | When confidence insufficient, preserve worktree and report why | Implemented | `pull_request.declined`. | |

---

### 4.8 Permissions and integrations (spec §16–§20)

| # | Original requirement | State | Evidence / gap | Target |
|---|---|---|---|---|
| 16.1 | Pre-approved actions list | Implemented | Job allowlist + repository approval. | |
| 16.2 | "Allowed but must be reported" class | Partially implemented | Package installs and dependency changes are visible in the diff and reported; there is no explicit *class* in the permission model. | Post-3.3 |
| 16.3 | High-risk requires explicit approval | Implemented | `decision_risk = high` blocks regardless of confidence. | |
| 16.4 | Hard V1 prohibitions (7 items) | Implemented | Sprint 3.2 precedence ladder cites the prohibition when it blocks. | |
| 17.1 | monday: assign, In Progress, updates, blockers, Ready for Review, attach PR | Implemented | Column-allowlisted outbox. | |
| 17.2 | Mac must not alter commercial priorities/deadlines/commitments | Implemented | Write allowlist refuses them; refusals audited. | |
| 17.3 | "monday.com should remain the **visible source of truth for work in progress**" | Partially implemented | True for monday-backed work. For a direct task there is nothing to be a source of truth *of* — which is correct, and the fix is that Mac's own UI must be that surface. | **3.3** |
| 18.1 | Teams as command and notification channel | Not implemented | Deferred. | Post-3.3 |
| 19.1 | Genuine company mailbox, human-inspectable | Implemented | Real SMTP, Sprint 3.1. | |
| 19.2 | Mac and Otto as distinct agents with defined responsibilities | Partially implemented | Modelled as data (`domain/agent-registry.ts`) with Forja correctly typed as a platform, not an agent. No actual handoff mechanism. | Post-3.3 |
| 20.1 | Delegate document work to Otto | Not implemented | Out of Sprint 3.3 scope by instruction. Artefact model should not preclude it. | Post-3.3 |

---

### 4.9 Machine control, voice, UI (spec §21–§23)

| # | Original requirement | State | Evidence / gap | Target |
|---|---|---|---|---|
| 21.1 | OpenClaw / general machine control | Not implemented | Explicitly future. | Post-3.3 |
| 21.2 | **Execution hierarchy**: native API → integration → MCP → CLI → browser → desktop control | Partially implemented | The *principle* is honoured (no arbitrary execution; the protocol has no field for a command). The hierarchy is not modelled anywhere as a selectable ladder, because there is only one rung. A tool layer for general work is the first place it becomes real. | **3.3** |
| 22.1 | Voice / "Call Mac" | Not implemented | Deferred. | Post-3.3 |
| 23.1 | Home screen: status, current task, project, night status, usage, alerts | Implemented | `pages/Dashboard.tsx`. | |
| 23.2 | **Talk to Mac** screen | **Not implemented** | There is no general conversational surface. Discovery is the closest thing and is task-scoped. | Post-3.3 |
| 23.3 | Projects screen: approved projects, repository, memory, tasks | Partially implemented | Projects show repository and tasks. **No capability model** — every project is assumed to have every integration, so a project with no repository looks broken rather than different. | **3.3** |
| 23.4 | Runs screen | Implemented | | |
| 23.5 | Review screen: questions, assumptions, PRs, decisions required | Partially implemented | Present per-run. No artefact/result review for non-code output. | **3.3** |
| 23.6 | Settings: thresholds, cutoff, permissions, spend, connected systems | Implemented | | |

---

### 4.10 Lifecycle, budget, observability, reporting (spec §24–§28)

| # | Original requirement | State | Evidence / gap | Target |
|---|---|---|---|---|
| 24.1 | Twelve run states, every transition recorded | Implemented | Plus `failed` (recorded assumption A-1 in Sprint 1 — a legitimate explicit decision). | |
| 25.1 | Actively manage AI usage across providers | Partially implemented | Coding-agent usage is captured. Mac's own reasoning-model usage is recorded as token counts in audit metadata but **is not part of the budget model** — `run_usage` has no path for it. A research shift would spend money the budget cannot see. | **3.3** |
| 25.2 | Record exact cost where available | Implemented | `usage_sources = exact`. | |
| 25.3 | Snapshot subscription usage before/after where dollars unavailable | Implemented | `usage_snapshots`. | |
| 25.4 | Report "Provider usage unavailable" rather than estimating | Implemented | `PROVIDER_USAGE_UNAVAILABLE` constant; never presents an estimate as exact. | |
| 26.1 | Six overnight stop conditions | Implemented | All six in `decideNextAction`. | |
| 26.2 | If one task stops, continue safe work on another | Implemented | But only within the monday candidate set. | **3.3** |
| 27.1 | Observability: 13 recorded facts | Implemented | Audit + logs + sessions. | |
| 27.2 | Live status, inspect logs, pause, stop, approve blocked action | Implemented | | |
| 28.1 | Morning report, deliberately short, 9 named sections | Implemented | `domain/report.ts`. | |
| 28.2 | Report shape suits the work | **Implementation drift** | The report has a mandatory-feeling **Pull Requests** section and describes work in terms of diffs and tests. For a research run there is no PR, and "what changed" is the wrong question — the right one is "what did you find". | **3.3** |
| 28.3 | Estimated human hours | Implemented | | |
| 28.4 | AI usage section | Partially implemented | See 25.1 — reasoning-model spend is missing. | **3.3** |

---

### 4.11 Forger/Forja, CRM, MVP philosophy (spec §29–§31)

| # | Original requirement | State | Evidence / gap | Target |
|---|---|---|---|---|
| 29.1 | Forger is not part of V1; is initially just another codebase | Implemented | It is a project row with a repository. | |
| 29.2 | Later, Forger becomes a first-class engineering tool | Not implemented | Phase 2+. Sprint 3.2 correctly modelled **Forja** as a platform, not an agent — a distinction worth keeping. | Post-3.3 |
| 30.1 | HubSpot future scope | Not implemented | As specified. | Post-3.3 |
| 31.1 | Modular monolith, replaceable model providers, replaceable coding agents | Partially implemented | Coding agents are replaceable (`provider: claude_code \| mock`). Model providers are a real seam (`services/model/provider.ts`) but the enum is `anthropic \| scripted \| none` — **one vendor**. §31 asks for replaceable providers, plural. | **3.3** |
| 31.2 | Prove the fundamental loop | Implemented | Proven end-to-end for coding work. | |

---

## 5. Drift findings — where implementation is narrower than the spec

These are the findings, ranked by how much they cost the product. Each names the spec clause it
narrows, the code that narrows it, and what a correct shape would look like.

### D-1 — General technical work does not exist (spec §1, §3.1)

**Narrowing.** `Mac_Spec.md` §1 lists, as one of Mac's primary purposes, *"perform general
computer-based work using appropriate tools"*, and §3 Day Mode lists analysis, specification drafting
and recommendations as things Mac does. The implementation has exactly one substantive execution
capability: `claude_code`. `JOB_KINDS` otherwise contains `noop`, `echo`, `sleep`, `system_info`,
`workspace_check`, `fail` and `repo_inspect` — six diagnostics and a read-only repository scan.

**Where.** `packages/protocol/src/jobs.ts`.

**Consequence.** Every non-coding technical task is unexecutable. The real acceptance task is one.

**Correct shape.** Task *type* (what kind of work) must be separate from job *kind* (how it is
performed). A `research` task executed by a general worker capability is the same lifecycle — task,
discovery, brief, confidence, approval, run, heartbeat, audit, report — with a different execution
adapter. Not a second architecture.

---

### D-2 — Eligibility is a monday predicate, not a work predicate (spec §8.5, §10.2)

**Narrowing.** §8 says monday *will eventually be* the primary source *for task priority*. §10 makes
it the source of truth *for task status*. Neither says work must have a board.

**Where.** `domain/eligibility.ts` — `EligibilityInput` requires `board` and `item`. Three of the
thirteen checks (`board_approved`, `board_night_eligible`, `item_flagged`) are board facts, and
`status_startable`, `not_assigned_elsewhere`, `dependencies_clear` and `task_type_allowed` all read
monday columns. `repository_approved` is unconditional.

**Consequence.** A direct task cannot be expressed as eligible or ineligible. It has no verdict at all.

**Correct shape.** Requirements derived from *capability*: repository checks apply to work that needs
a repository; board checks apply to work that came from a board. Both remain enforced where relevant.

---

### D-3 — The scheduler cannot see work that has no board (spec §8.1)

**Narrowing.** §8 gives direct instructions the **highest** priority.

**Where.** `services/night-shift.ts` — `collectCandidates` starts from `readableBoards()` and
returns `[]` when there are none. Candidates are then built by iterating `monday_items`.

**Consequence.** The one class of work the spec ranks first is the one class the scheduler cannot
enumerate. This is worse than a priority bug: it is invisibility.

**Correct shape.** A second deterministic candidate source over approved direct tasks, merged into the
same ordered candidate list, with documented precedence between the two sources. Not fake monday rows.

---

### D-4 — Night shift hard-codes coding execution (spec §3.4, §3.5)

**Narrowing.** §3 describes Night Shift as autonomous performance of *approved work*, with step 14
delegating coding *"where appropriate"*.

**Where.** `services/night-shift.ts` — `startSelectedTask` returns `null` when no approved
repository exists, then unconditionally writes `jobKind: 'claude_code'` with `openPullRequest: true`.

**Consequence.** "Where appropriate" became "always". A research task that reached the scheduler would
still be run as a coding task or silently dropped.

**Correct shape.** Resolve the job kind from the task's type and the project's capabilities; refuse
clearly when no capability matches, rather than dropping the candidate.

---

### D-5 — Discovery has no entry point from a draft task (spec §4)

**Narrowing.** §4 makes discovery the mandatory front half of the lifecycle. A lifecycle whose first
step is unreachable from the object it operates on is not implemented in any useful sense.

**Where.** `apps/web/src/pages/TaskDetail.tsx` offers only "New run". `/discovery` exists but requires
the user to already understand sessions, briefs and statuses.

**Consequence.** The reported failure. A user created a task, correctly, and had no way to proceed.

**Correct shape.** A **Start Discovery** action on any draft task, and a task detail page that states
its own execution requirements and what is currently blocking them.

---

### D-6 — Company context is grounding, not investigation (spec §4 Phase A/D)

**Narrowing.** §4 Phase D: Mac *"should avoid asking questions whose answers can be obtained by
inspecting the repository or connected systems."* Sprint 3.2 made PAC company context a connected
system.

**Where.** Company context reaches discovery only as prompt text for the model structurer
(`services/discovery.ts` → `structureBriefWithModel`). The investigation machinery that would consult
it as a source — `runInvestigation`, which already has `company_context` as its second source class —
is invoked only from `services/supervision.ts`, during coding runs.

**Consequence.** During discovery Mac can ask a human a question that PAC's own approved documents
answer, and there is no persisted receipt showing he checked.

**Correct shape.** Run the investigation before each question is put to a person; persist sources
checked, documents consulted, commit SHA and whether the gap was resolved.

---

### D-7 — "Confidence" means two different things in one UI (spec §5)

**Narrowing.** §5 is unambiguous that confidence is Mac's own assessment, derived through discovery.

**Where.** `tasks.confidence` (`db/schema.ts`), exposed as a plain "Confidence (%)" field on the
new-task form. The real acceptance task carries `0.700` typed by a human.

**Consequence.** Not currently dangerous — execution gates read `handoff_briefs.confidence` — but it
is one refactor away from being load-bearing, and it visibly misrepresents the model to users.

**Correct shape.** Rename to something that cannot be mistaken for derived understanding confidence,
or remove it. The `<0.60` floor stays non-overridable either way.

---

### D-8 — Projects assume every integration (spec §23.3)

**Narrowing.** Nothing in the spec says a project has a repository. §23 lists repository as *a* thing a
project screen shows.

**Where.** `projects` has `repo_url` and `night_shift_approved` and nothing else. `PAC Internal
Development` has a null `repo_url` and is therefore indistinguishable from a misconfigured project.

**Consequence.** No way to say "this project supports research but has no code", so no way for
eligibility to reason about it.

**Correct shape.** Projects advertise capabilities: repository, monday board, allowed task kinds,
internal-only, night-shift approval.

---

### D-9 — Only one reasoning-model vendor (spec §31)

**Narrowing.** §31 requires *"replaceable model providers"*.

**Where.** `MODEL_PROVIDERS = ['anthropic', 'scripted', 'none']`. `getModelProvider()` constructs an
`AnthropicModelProvider` or nothing.

**Consequence.** Core workflow is coupled to one vendor. Also: `NullModelProvider` silently degrades —
correct for "help me phrase an answer", wrong for "go and research this", where a null provider must
fail loudly rather than return nothing.

**Correct shape.** Keep the seam; add at least one more real provider; make genuine reasoning work
fail with a clear error when no real provider is configured.

---

### D-10 — There is no result that is not a commit (spec §1.13, §28)

**Narrowing.** §1 promises work "prepared for human review"; §28's report describes findings and
decisions. Neither says the deliverable is a diff.

**Where.** No artefact table exists. Outputs are: a branch, a PR, a report row, audit metadata.

**Consequence.** A research run has nowhere to put an investigation report, a recommendation or a
structured finding. Storing them as commits would be exactly the fake-Git coupling this sprint exists
to remove.

**Correct shape.** A first-class artefact model: task, run, type, title, content, provenance, company
context SHA, model usage.

---

### D-11 — Reasoning-model spend is outside the budget model (spec §25)

**Narrowing.** §25: *"Usage can come from: Mac's reasoning model; Claude Code; Codex; API calls."*
Mac's reasoning model is listed **first**.

**Where.** `run_usage` is populated from coding-agent sessions. Model-assist token counts are written
into audit event metadata and go no further.

**Consequence.** Today it is a rounding error because model assistance is a per-question call. A
research shift makes it the dominant cost, and the nightly budget would not see it.

**Correct shape.** Route reasoning-model usage through the existing usage model so the existing budget
stop conditions apply unchanged.

---

### D-12 — The brief schema presumes code (spec §4 Phase C)

**Narrowing.** §4 Phase C lists 14 fields, of which two are code-specific ("known architecture",
"affected areas"). The implementation added `mustNotChange`, `implementationConsiderations` and
`testingExpectations` and made them the vocabulary of the whole document.

**Where.** `packages/protocol/src/brief.ts`; `COMPLETENESS_DIMENSIONS` and `DIMENSION_WEIGHTS`, where
`testing` carries 0.08 and `must_not_change` 0.08 of understanding confidence.

**Consequence.** A perfectly-understood research task is scored down 16% for not having testing
expectations or must-not-change areas — which can push it below the autonomy threshold for reasons
that do not apply to it.

**Correct shape.** Dimensions and weights selected by task type. The brief remains the execution
contract; what "complete" means depends on the work.

---

## 6. Explicitly *not* drift

Recorded so that a future reader does not re-litigate them:

| Item | Why it is not drift |
|---|---|
| `failed` added to the twelve run states | Sprint 1 assumption A-1, explicit and reasoned: §24 has no way to say "executed and did not succeed". |
| Teams, voice, OpenClaw, HubSpot, Forger-as-tool absent | The spec itself defers all five ("eventually", "future scope", "Phase 2+"). |
| monday integration depth | Sprint 3 built more than §17 required. Additive, not narrowing. |
| Company context (Sprint 3.2) | Not in `Mac_Spec.md` at all; a human-approved addition consistent with §9 global memory and §16 authority. |
| Sandbox / Bubblewrap requirement | Additive safety beyond §11. |
| Approval by night-shift *policy* rather than a person | Sprint 3 §7.2, explicit, with a distinct audit event and approval source so a machine approval can never read as a human one. Genuine decision, correctly recorded. |
| Git isolation for coding work | §14 is right and stays. The drift is applying it to work that touches no code. |

---

## 7. Recommended target sprints

**Sprint 3.3 (this sprint) — restore general-purpose execution.**
D-1, D-2, D-3, D-4, D-5, D-6, D-7, D-8, D-9, D-10, D-11, D-12.

These twelve are one problem seen from twelve angles: the execution path assumed its own most common
case was its only case. They should be fixed together, because fixing any subset leaves the acceptance
task still unexecutable.

**Post-3.3, in rough priority order.**

1. Talk to Mac — a general conversational surface (§23.2). Currently the largest remaining spec
   surface with nothing behind it.
2. Otto handoff — agent-to-agent delegation (§20), now that artefacts exist to hand over.
3. Microsoft Teams (§18) — command and notification channel.
4. Permission class "allowed but must be reported" (§16.2) as an explicit model.
5. Forja as a first-class engineering tool (§29.2).
6. Voice (§22).
7. OpenClaw / machine control (§21), with the execution hierarchy made real.
8. HubSpot (§30).

---

## 8. The question this sprint has to answer

> Can Mac take a non-coding technical task created in his own UI, perform discovery, receive approval,
> execute it autonomously overnight, and leave evidence-backed results in the morning — without a
> monday.com item and without a Git repository?

Today: **no**, for the twelve reasons above.

The acceptance test is the real task already in the database:
`Investigate PAC Project Registry, Document Controller & Sales Engineer`
(`332dcf3e-ee41-44bb-8955-10bf8589dc1a`, project `PAC Internal Development`).

It is not to be deleted, not to be recreated, and not to be given a repository or a board.
