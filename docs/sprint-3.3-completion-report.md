# Sprint 3.3 — General Task Execution: Completion Report

**Branch:** `sprint-3.3/general-task-execution`
**Base:** `main` @ `924e39a` (Sprints 1–3.2 merged)
**Date:** 2026-08-19
**Companion document:** `docs/mac-spec-reconciliation.md`

---

## 1. Original-spec reconciliation findings

`Mac_Spec.md` was re-read in full and reconciled against the implementation, section by
section, in `docs/mac-spec-reconciliation.md`. The matrix covers all 33 spec sections across
eleven areas, with every "implemented" claim checked against code rather than against a prior
completion report.

The headline finding is in the spec's own summary of Mac's purpose. §1 lists, as one of six
primary purposes:

> perform general computer-based work using appropriate tools

Nothing in the system did this. The entire execution surface was one substantive job kind,
`claude_code`, plus six diagnostics and a read-only repository scan.

Sections judged **implemented** and left alone: the control loop, approvals, audit
immutability, worktree isolation, the never-merge-to-main rule, the confidence bands, the
memory layers, monday.com integration depth, sandboxing, worker token rotation, company
context, and the usage model's refusal to present an estimate as exact. Sections **correctly
deferred** by the spec itself: Teams, voice, OpenClaw, HubSpot, Forger-as-tool.

Six items were explicitly recorded as **not drift**, so a future reader does not re-litigate
them — most notably the `failed` run state (Sprint 1 assumption A-1) and approval by
night-shift policy rather than by a person (Sprint 3 §7.2), both genuine, recorded decisions.

---

## 2. Implementation drift identified

Twelve findings, D-1 to D-12. Each names the spec clause it narrows and the code that narrows
it. Summarised:

| # | Drift | Spec clause narrowed |
|---|---|---|
| D-1 | General technical work does not exist | §1, §3.1 |
| D-2 | Eligibility is a monday predicate, not a work predicate | §8.5, §10.2 |
| D-3 | The scheduler cannot see work that has no board | §8.1 |
| D-4 | Night shift hard-codes coding execution | §3.4, §3.5 |
| D-5 | Discovery has no entry point from a draft task | §4 |
| D-6 | Company context is grounding, not investigation | §4 Phase A/D |
| D-7 | "Confidence" means two different things in one UI | §5 |
| D-8 | Projects assume every integration | §23.3 |
| D-9 | Only one reasoning-model vendor | §31 |
| D-10 | There is no result that is not a commit | §1.13, §28 |
| D-11 | Reasoning-model spend is outside the budget model | §25 |
| D-12 | The brief schema presumes code | §4 Phase C |

D-3 deserves separate mention because it is worse than it sounds. `collectCandidates` opened
with `const boards = await readableBoards(); if (boards.length === 0) return [];`. A task
with no monday board was not low-priority — it was **invisible**. Spec §8 ranks direct
instructions highest, and the one class of work ranked first was the one class the scheduler
could not enumerate.

All twelve are addressed in this sprint.

---

## 3. What Sprint 3.3 changed

Ten changes, each closing one or more drift findings:

1. **Task kind became a first-class concept**, separate from job kind.
2. **Execution requirements are derived once**, from kind + origin + project capabilities.
3. **Eligibility checks became conditional on capability** rather than universal.
4. **The night scheduler collects from two queues** into one ordered list.
5. **General runs execute through the existing worker lifecycle**, with reasoning performed
   in the control plane.
6. **Discovery investigates before it asks**, and records what it consulted.
7. **Results persist as artefacts**, with evidence classified and confidence capped.
8. **Projects advertise capabilities** and carry an explicit allowlist of permitted work.
9. **A second real model provider** (OpenAI) joined Anthropic behind the existing seam.
10. **The morning report asks "what did Mac find"** when nothing was meant to change.

What was deliberately **not** done: no second scheduler, no second run table, no separate
research service, no fake monday rows, no fake Git repositories, and no weakening of any
existing guardrail. A monday-backed coding task passes through the same thirteen eligibility
checks it did before, in the same order, with the same wording.

---

## 4. Task model

`packages/protocol/src/task-model.ts`.

```
TASK KIND      what the work IS          coding, research, analysis, investigation,
                                          scoping, documentation, administrative
JOB KIND       how it is PERFORMED       claude_code, general_task
WORK CAPABILITY what a worker must have  coding, general
```

Seven task kinds, two worker capabilities. The difference between research and scoping is
what Mac is asked to produce, not what the machine must be able to do.

`resolveJobKind()` is the **only** function in the system permitted to map product vocabulary
onto a provider-specific mechanism. Everything else asks it, so replacing `general_task` later
is a one-line change rather than a search.

Each kind declares its base requirements, the completeness dimensions that do **not** apply to
it, and the artefact types it is expected to produce. `deriveExecutionRequirements()` turns
kind + origin + project capabilities into a concrete requirement set, with one rule enforced
throughout: **project capabilities may add a requirement, never remove one.** A missing
integration is not permission to skip a safety check.

`tasks.origin` is `direct` or `monday`. Direct is the default, and monday-mirrored tasks set
it explicitly — a bug found and fixed during this sprint (see §15).

---

## 5. Discovery changes

* **Start Discovery** exists as an action on a task: `POST /api/tasks/:id/discovery`,
  idempotent, audited as `task.discovery_requested`. This was the missing UX half of the
  reported failure (D-5).
* **Mac proposes a task kind** from the title and description
  (`domain/task-classification.ts`), deterministically, and only when confident enough
  (≥0.6). A kind a human chose is never overwritten, and the change is audited with the words
  that decided it.
* **Investigation happens before a question is put to a person** (D-6). Each outstanding
  completeness dimension is investigated against company context, project memory, prior runs,
  earlier briefs, the repository and the monday item, with a persisted receipt naming every
  source consulted and whether it matched. A dimension Mac resolved by investigation is
  credited at `INVESTIGATED_DIMENSION_WEIGHT` (0.75) — more than "findable" (0.5), less than
  "the human told me" (1.0).
* **Completeness dimensions follow the task kind** (D-12), with the remaining weights
  renormalised. Previously a perfectly-understood research task was marked down 28% for having
  no testing strategy, no must-not-change areas, no affected components and no architecture —
  four questions never asked of it.
* Confidence is now computed **once**, with investigation already counted, so a brief emits
  exactly one `brief.confidence_calculated` event and never carries a stale number.

---

## 6. Reasoning provider implementation

`services/model/provider.ts`.

* **`OpenAIModelProvider`** joins `AnthropicModelProvider`. `fetch` only, no SDK, no new
  dependency. Its existence is the point: an interface with one implementation is an
  assumption, and the `ModelProvider` shape has now been exercised against a provider with a
  different response envelope, different usage field names and a different error format.
* **`requireReasoningProvider()`** is separate from `getModelProvider()` because the two
  callers want opposite things from a missing provider. Model *assistance* degrades safely to
  the deterministic path. Model *reasoning* has no deterministic fallback, so it throws
  `MODEL_PROVIDER_REQUIRED` rather than returning nothing — an empty result is
  indistinguishable, in a report, from an investigation that genuinely found nothing.
* Both providers honour an `AbortSignal`, so a cancelled run stops billing immediately rather
  than at the end of the current call.

### Subscription versus API (§12)

Investigated and written down as typed data in `MODEL_ACCESS`, because the tempting assumption
is false:

> A Claude Code subscription does **not** grant Messages API access. Claude Code is a CLI
> holding its own OAuth session; the Messages API is a separate, key-authenticated product.

Mac's reasoning path therefore uses **API access**, which means per-token counts we can see,
which is what preserves the budget controls. No usage or accounting capability has been
fabricated: `MODEL_ACCESS` records, per provider, the access mode and whether it reports exact
usage.

---

## 7. General execution path

```
night scheduler / human
        │  creates run  jobKind = general_task
        ▼
   control plane ── buildGeneralAssignment ──▶ worker
        │                                        │  objective + 2 ceilings
        │                                        │  (no key, no prompt, no tool)
        │◀────── POST /runs/:id/research-step ───┤
        │                                        │
   plan → model call → tool layer → classify     │  heartbeat, cancel, cutoff,
   → accumulate → artefact → usage → audit       │  progress, run log
```

The worker **drives**; the control plane **performs**. That split is the security argument
(§29): a research capability must not become a way to hand the VM the model credential, the
company-context mirror, project memory and the monday client. The cheapest way to guarantee
the VM cannot leak them is for it never to hold them.

Three decisions are made in code and never asked of the model:

1. **What the objective is** — built from the approved handoff brief. The model is handed the
   plan; it never writes one.
2. **When to stop** — step and tool-call ceilings enforced against recorded counters, plus an
   independent wall-clock ceiling on the worker.
3. **What counts as a fact** — see §10.

The research tool layer (`services/research/tools.ts`) is an allowlist of eight named tools.
The model *names* a tool and supplies a query string; it does not call anything. Scope is
resolved server-side from the run, so a run cannot search another project's memory, reach a
board it was not assigned, or fetch an arbitrary URL. External retrieval is gated three ways
(deployment setting, project capability, host allowlist) with no redirect-following, and
`public_web_search` **refuses honestly** because no search provider is configured — rather than
returning nothing, which a model would read as "the web says nothing about this".

---

## 8. Scheduler changes

`collectCandidates` now merges two collectors into one ordered list consumed by the same
`decideNextAction`. Documented precedence:

1. the project Mac is already working in;
2. priority rank — monday priority and task priority share one 0–3 scale;
3. **direct before monday on a tie** — spec §8 ranks direct instructions highest;
4. stable id comparison, so two ticks on the same data agree.

Point 2 matters as much as point 3: a high-priority monday item still outranks a
normal-priority direct task, because commercial priority is a human's judgement about
importance and the source of a task is not.

`startSelectedTask` resolves the job kind from the task kind. A repository is required only
when `resolveJobKind` returns `claude_code`; monday writes are no-ops for a task with no linked
item, via the outbox's existing behaviour rather than a second mechanism at one call site.

---

## 9. Direct-task behaviour

A direct task:

* needs no monday item, ever — `deriveExecutionRequirements` never asks for one;
* needs no repository unless its kind is coding;
* is collected by `collectDirectCandidates` from `origin = 'direct' AND monday_item_id IS NULL`
  (belt and braces: origin says where it came from, the item id says what it is linked to now,
  and this queue wants both to agree);
* passes the **same** authority gates as monday work — approved project, handoff brief,
  confidence above the non-overridable floor, confidence in the autonomous band, no run in
  flight, not blocked earlier tonight — plus two the board used to cover implicitly:
  `task_kind_permitted` and `worker_capability_available`.

The 60–79% band is **not** softened for research. Sprint 3.3 §19 is explicit, and research can
still spend money, read sensitive material and produce consequential recommendations.

---

## 10. Artefact model

`run_artefacts`, one row per deliverable, with an immutability trigger on its company-context
binding matching the one on runs and briefs.

Findings carry an **evidence class**: `pac_fact`, `project_fact`, `external_fact`,
`user_approved_decision`, `inference`, `recommendation`, `assumption`, `unknown`. The first
four are checkable; the last four are Mac's own work.

The class is **not taken on trust**. `classifyFindings()` demotes any claim the retrieved
sources do not support:

* a factual claim citing nothing that was retrieved becomes an `inference`;
* a `pac_fact` not citing a `company:` source becomes a `project_fact` or an `inference`;
* an `external_fact` resting only on internal sources becomes a `project_fact`;
* anything ungrounded has its confidence capped at 0.59, below any answering threshold.

This is the same mechanism as the citation check in `model/resolvers.ts`, and it is here for
the same reason: it is the only thing standing between a fluent paragraph and a fact somebody
acts on. The count of invented citations is audited on every step.

---

## 11. UI changes

Minimal, per §26 — no redesign.

* **Task Detail** leads with the task type and, in one sentence, what is stopping the task.
  That sentence comes from the same domain functions the night scheduler uses, so the screen
  and the scheduler cannot disagree. Below it: origin, both confidences under labels that
  distinguish them, discovery state, the derived requirement checklist, project capabilities
  and permitted work, the eligibility verdict, results, and runs. **Start Discovery** and
  **Continue Discovery** are actions on the page.
* **Tasks list** gains type, origin, and Mac's *derived* confidence.
* **New Task form**: the confidence field was labelled "Confidence (%)" with the hint "Mac's
  confidence in his understanding of this task" while collecting a number a person typed. It
  is now "Your own confidence in this request", explicitly not an execution gate. A "Type of
  work" selector defaults to "Let Mac decide".
* **Artefact page** (`/artefacts/:id`) groups findings by evidence class under headings that
  say whether a claim is checkable or Mac's own, with sources listed.
* **Run Detail** shows research stage, sources consulted (external counted separately),
  lookups, findings, unknowns and model usage — and the artefacts produced.
* **Project Detail** gains a capability panel with two visibly different halves: what the
  project *has* (bookkeeping) and what Mac is *allowed* to do (admin-only authority grant).

---

## 12. Schema changes

`drizzle/0008_sprint33_general_work.sql`. Additive; the only destructive operation is a column
rename that preserves its data.

| Change | Note |
|---|---|
| `tasks.task_kind` | NOT NULL DEFAULT `coding` |
| `tasks.origin` | NOT NULL DEFAULT `direct`; backfilled to `monday` where an item exists |
| `tasks.confidence` → `tasks.user_initial_confidence` | Renamed, not dropped; range CHECK; column comment |
| `projects.capabilities` | Backfilled from resources that observably exist |
| `projects.allowed_task_kinds` | Backfilled to `["coding"]` **only** where an approved repository already existed |
| `run_artefacts` | New table + immutability trigger on the context binding |
| `general_run_state` | New 1:1 extension of `runs`; not a second run table |
| `discovery_investigations.brief_id` | Links a receipt to the gap it filled |
| `settings` | `general_work_enabled`, `max_research_steps`, `max_research_tool_calls`, `external_research_enabled` (**off**), `allowed_research_domains` |
| CHECK constraints | job kinds, stop reasons, night stop reasons, audit events, model providers |

**The migration enables nothing.** Every permission column is backfilled with exactly what was
already true. `PAC Internal Development` comes out with an **empty** allowlist, which is the
intended outcome: §21 requires a human to approve it, and a migration that ticked the box would
be the machine granting itself the permission.

---

## 13. Tests and results

| Suite | Before | After |
|---|---|---|
| Server | 712 passed, 58 skipped | **806 passed**, 58 skipped |
| Worker | 216 passed, 3 skipped | **227 passed**, 3 skipped |
| **Total** | 928 | **1033** |

All previously-passing tests still pass. Typecheck and web build clean.

New coverage: `tests/unit/task-model.test.ts` (21), `tests/unit/research.test.ts` (26),
`tests/unit/eligibility-general.test.ts` (28), `tests/integration/general-work.test.ts` (18),
`tests/e2e/general-night.e2e.test.ts` (2), `apps/worker/tests/general-task.test.ts` (11).

Four existing tests were edited. Three were fixture updates for the intended rename and the new
job kind; one (`eligibility.test.ts`) gained a narrowed fixture type because `board` and `item`
became nullable. **No existing assertion was changed or removed.**

The end-to-end test proves the full chain — Start Discovery → brief → derived confidence →
human approval → night-shift selection from the direct queue → worker lease → control-plane
reasoning → artefact → morning report — against a worker advertising **only** `general_task`,
in a project with no repository, on a task with no monday item.

---

## 14. Result of the real acceptance task

Driven through the **real HTTP surface against the real development database**, on the real
row `332dcf3e-ee41-44bb-8955-10bf8589dc1a`. The task was not deleted, not recreated, and given
neither a repository nor a board.

**Before:** `task_kind = coding` (the migration's honest default), no discovery, no brief. The
screen said: *"Discovery has not been started. Mac needs a structured understanding before he
may execute anything."*

**After Start Discovery and one description of the work:**

| | |
|---|---|
| Task kind | **investigation** — classified by Mac, audited as `task.kind_changed` |
| Origin | direct |
| Understanding confidence | **0.999**, derived |
| Requester's estimate | 0.700, preserved and clearly separate |
| Requirements | reasoning model, company context, project context, research tools, artefact output |
| Repository / worktree / PR | **not required, not shown** |
| monday item | **not required** |

**After a human approved the project** for investigation work and for night shift, the
eligibility verdict showed eight of ten checks passing, with two remaining:

```
[  ] worker_capability_available   No online worker advertises the capability
                                   investigation work needs.
[  ] reasoning_model_available     No reasoning-model provider is configured
                                   (MODEL_PROVIDER_REQUIRED).
```

Both are **environmental, not architectural**: no worker process is running on this laptop, and
no API key is configured in this deployment. Neither is a limitation of the design, and both
are exactly what §22 and §10 require the system to say rather than queueing work that cannot run.

**State left behind:** the discovery session and handoff brief are retained as legitimate work
product. The project's `night_shift_approved` and `allowed_task_kinds` were **reset to their
pre-sprint values** after the run. Approving a project for autonomous work is a human decision
that §21 reserves for a person, and it was not mine to leave switched on.

---

## 15. Defects discovered

Six, all introduced by this sprint's own work and all found by testing it:

1. **The worker could loop forever.** It bounded its loop on the *control plane's* step
   counter, so a stalled counter — a persistence failure, a bug in the step handler — would
   keep answering "step 1, not done" and the worker would call it indefinitely, burning model
   spend. Found by an out-of-memory crash in the worker test run. It now counts its own
   iterations; two independent ceilings.
2. **The research loop discarded artefacts the model volunteered early**, then spent several
   more calls asking for them again. Artefacts are now accepted on any step, and a run that has
   produced deliverables and stopped asking for sources is done.
3. **"Company context" meant two different things in two call sites.** The scheduler hard-coded
   it satisfied; the task screen read the enabled flag. A deployment that never adopted Sprint
   3.2 would have found every research task refused. Now one `companyContextSatisfied()` helper,
   three-way: disabled → not a blocker, enabled and usable → not a blocker, enabled and
   unreadable → a blocker.
4. **The classifier read nouns and negations as instructions.** Exposed by the real task:
   "Document Controller" scored as an instruction to write documentation, "commit SHA" as a git
   action, and — worst — "Do **not** implement anything" as evidence *for* coding. Documentation
   cues are now verb-led, `commit`/`repository` must be actions, and a negated cue is not
   counted at all. Confidence also now measures separation between *capabilities* rather than
   between sibling kinds, because investigation-versus-scoping is a label while
   coding-versus-general decides whether a repository is needed.
5. **A raw-SQL batched lookup threw on every task list.** Written against an iterable; pg
   returns a result object with `.rows`. Every existing test either had an empty task list (which
   short-circuits) or fetched one task by id, so nothing caught it. Replaced with the query
   builder and covered by a regression test.
6. **monday-mirrored tasks defaulted to `origin = 'direct'`**, so the same work would have
   appeared in both scheduler queues. Fixed in `monday/sync.ts`, with a defensive
   `monday_item_id IS NULL` filter on the direct collector as well.

Defects 1, 4 and 5 would each have reached production without the tests that found them.

---

## 16. Security implications

Reviewed against §29. The general capability adds no new credential to the worker and no new
path out of the sandbox.

* **The worker holds nothing.** Its assignment is a task kind, an objective, a deliverables
  list and two ceilings. Asserted by a test that enumerates the assignment's keys and greps it
  for credential-shaped words.
* **The tool layer is an allowlist**, and scope is not a model-supplied parameter. A run cannot
  search another project's memory, reach an unlinked board, or widen its own scope by asking.
* **External research is off by default**, requires both a deployment setting and a project
  capability, validates scheme and host against an administrator's allowlist, and refuses to
  follow redirects — an allowlisted host that 302s elsewhere would otherwise be an open proxy.
* **Every search is audited with its query**, and every external retrieval with its source and
  timestamp.
* **`allowedTaskKinds` is admin-only** and separate from the operator-editable project fields,
  because widening what Mac may do unsupervised should not be possible in a diff that looks
  like a rename.
* **No guardrail was weakened.** The `<0.60` floor, the autonomous band, the hard prohibitions
  and the git policy are untouched. Approval by night-shift policy still records itself
  distinctly from a human approval.

One judgement worth flagging for review: a worker doing general work is **not** required to
have a sandbox, because general work runs no process on the worker at all — the reasoning
happens in the control plane. Requiring containment there would be a rule enforced for its own
sake rather than for the risk it addresses. If that reasoning is wrong, the fix is one
condition in `shiftCapabilities`.

---

## 17. Technical debt

1. **`public_web_search` is a seam that refuses.** No search provider is configured. Honest,
   but external research is therefore limited to fetching a named document from an allowlisted
   host.
2. **Reasoning usage records tokens, not money.** `cost_cents` is null because inventing a rate
   would be the estimate-presented-as-exact that spec §25 forbids. A hard *monetary* budget
   still cannot stop a research shift; the step and tool-call ceilings bound it instead.
3. **The classifier is regex-based.** Adequate and cheap, and its mistakes are one click to
   fix, but it will keep meeting sentences it reads wrongly. The negation handling added this
   sprint refuses to count a negated cue; counting it *against* the category would be better.
4. **Understanding confidence measures dimension coverage, not depth.** A brief touching every
   applicable dimension scores 1.0. True before this sprint for coding; now visible more often
   because research has six dimensions rather than ten.
5. **`taskExecutionState` omits board checks** for monday work — those belong to the Night Queue
   screen, which has the item in hand. A monday task's Task Detail page therefore shows a
   slightly optimistic eligibility verdict.
6. **The artefact body is bounded at 200k characters** and stored in Postgres. Fine for reports;
   the wrong model if artefacts ever become large binary things.
7. **No Otto handoff.** The artefact model was designed not to preclude it (§20), but nothing
   routes an artefact to Otto.

---

## 18. Remaining blockers before a real unattended overnight general-work shift

Environmental, in the order they must be resolved:

1. **No reasoning-model provider is configured.** Set `modelProvider` to `anthropic` or
   `openai` in settings and supply the matching API key. Until then general work refuses to
   run, by design.
2. **No worker is online**, and none advertises `general_task`. The Linux worker needs
   deploying and its capability list needs to include the new job kind.
3. **Night shift is disabled** in settings (`nightShiftEnabled = false`).
4. **`PAC Internal Development` is not approved** for night shift or for investigation work.
   Deliberately left that way — it is a human decision, and I reset it after the acceptance run.
5. **No mail provider or recipient** is configured, so the morning report would be generated
   but not delivered.
6. **Budget controls cannot see reasoning spend in money**, only in tokens (debt item 2).
   Decide whether the step/tool ceilings are sufficient before running unattended.

Items 1–5 are configuration. Item 6 is a judgement call for a human.

---

## Does Mac now match the original product intent?

> **Does Mac now match the original product intent closely enough to take a non-coding
> technical task directly from his own UI, perform discovery, receive approval, execute it
> autonomously overnight, and leave evidence-backed results in the morning — without requiring
> a monday.com item or a Git repository?**

**Yes — architecturally, and demonstrated end to end. Not yet in this deployment, for
configuration reasons that the system now states plainly rather than failing silently.**

What the evidence supports:

* The full chain is proven by an automated end-to-end test against a real database, a real
  worker lease and the real HTTP surface, with **no repository and no monday item**, on a
  worker advertising only `general_task`.
* The real acceptance task — not a copy — was driven through the real API and now classifies
  itself as an investigation, derives its own understanding confidence, and reports execution
  requirements that include **no repository, no worktree, no pull request and no monday item**.
* After a human approval it reached eight of ten eligibility checks passing, with the two
  failures being an offline worker and an unconfigured model provider.

What honesty requires me to add:

* **It has not run overnight.** No unattended shift has executed, because no reasoning provider
  and no worker are configured here. The last two blockers on the acceptance task are exactly
  those, and I have not fabricated their absence.
* **The reasoning has only been exercised against a scripted provider.** The provider seam,
  the tool layer, the evidence classification and the artefact path are all proven; a real
  model's output has not passed through them. The safeguards are designed on the assumption
  that a real model will sometimes fabricate citations and misclassify its own claims, and
  they demote it when it does — but that has been tested with a scripted misbehaving model,
  not an actual one.
* **Sprint 3.3 restored the capability. It has not yet been commissioned**, in the sense
  Sprint 3.1 used that word for the coding path.

So: the architectural answer to the question that opened this sprint is yes, and it is
evidenced. The operational answer needs an API key, a worker, and one night.
