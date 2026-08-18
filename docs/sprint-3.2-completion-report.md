# Sprint 3.2 — Completion Report

**Sprint:** 3.2 — PAC Company Context Integration
**Branch:** `sprint-3.2/company-context`
**Base:** `main` at `b31937a` (Sprint 3.1, merged via PR #1)
**Date:** 2026-08-18
**Design:** `docs/sprint-3.2-company-context-design.md`

---

## 1. What was built

Mac now works from PAC Technologies' approved shared company context, loaded from
`github.com/PacTechnologiesAus/Company`, and every meaningful piece of work records exactly which
revision of that context governed it.

* A dedicated **Company Context provider** — a bare Git mirror, refreshed with `git remote update`,
  read with `git show <sha>:<path>`.
* **Manifest-driven loading**: `context.yaml` declares the mandatory document set; Mac hardcodes
  nothing and guesses nothing.
* **Provenance bindings** on discovery sessions, handoff briefs, runs and supervised answers, made
  immutable by a database trigger.
* A **deterministic selection layer** that always carries `AUTHORITY.md` in full and selects
  task-relevant sections on top of it.
* An **executable precedence ladder** with hard prohibitions declared in code, now cited in Mac's
  actual blocked answers.
* A **propose-only governance model**: Mac can raise a change to company context and has no verb
  that could apply one.
* **Cached/offline behaviour** that is explicit, marked, and refuses rather than running on empty
  company context.
* A **PAC context** status page, a per-run revision badge, and a sidebar warning.

---

## 2. Architecture changes

New, all additive:

```
apps/server/src/domain/
  company-context.ts        pure: markdown section parsing, hashing, substantiveness
  context-precedence.ts     pure: the layer ladder + hard prohibitions
  agent-registry.ts         pure: PAC agents vs platforms (Forja)

apps/server/src/services/company-context/
  provider.ts               the interface + test seam. NO write verb exists.
  git-provider.ts           bare mirror, GIT_ASKPASS credential, redaction
  manifest.ts               context.yaml parse + validation
  loader.ts                 fetch -> validate -> hash -> persist a revision
  service.ts                startup refresh, ensureCurrentRevision, status, cache policy
  selection.ts              deterministic core + scored task-relevant sections
  proposals.ts              propose-only governance
  bindings.ts               the shared "bound to this revision" audit event

apps/server/src/http/routes/company-context.ts
apps/web/src/pages/CompanyContext.tsx
```

Nothing in the Sprint 3.1 architecture was rewritten. The investigation gained a seventh source
class; supervision, discovery, briefs and run creation gained a binding and a context argument.
The worker is entirely untouched except for one addition to its credential refusal list.

**Where the mirror lives.** `~/.mac-bennett/company-context` by default — outside every coding
workspace. The mirror itself is a `mirror.git` subdirectory of that; Mac's own scaffolding (the
askpass helper) sits beside it, not inside it.

---

## 3. Schema changes

Migration `0007_sprint32_company_context.sql`. Additive; nothing dropped, nothing retyped.

**New tables**

| Table | Purpose |
| --- | --- |
| `company_context_revisions` | one row per (repository, commit) loaded or attempted, valid or not |
| `company_context_status` | singleton: active revision, status, last check, last success, last error |
| `company_context_proposals` | Mac's proposed changes, with provenance and review state |

**New columns**

* `settings.company_context_enabled`, `.company_context_allow_cached`,
  `.company_context_min_refresh_seconds`, `.company_context_max_stale_hours`
* `company_context_revision_id` on `discovery_sessions`, `handoff_briefs`, `runs`,
  `agent_questions` — all `ON DELETE RESTRICT`.

**New constraints and triggers**

* `BEFORE UPDATE` trigger on each of the four bound tables refusing to change a non-null
  `company_context_revision_id`, including to null.
* `company_context_proposals` CHECK requiring a reviewer on any `accepted`/`rejected` row — so an
  accepted proposal can never look like one Mac accepted himself.
* Enum CHECKs for validation state, source, provider kind, status and proposal status, all
  registered in `ENUM_CHECKS` so the existing schema-parity test covers them.

**Document content is not stored in Postgres.** Only identity: SHA, version, manifest, hashes and
per-document metadata. The authoritative copy stays in the repository PAC governs.

---

## 4. Company repository authentication model

* Configured by `MAC_COMPANY_CONTEXT_REPO_URL` (default: the real PAC repository),
  `MAC_COMPANY_CONTEXT_REF`, `MAC_COMPANY_CONTEXT_DIR`, `MAC_COMPANY_CONTEXT_TOKEN`.
* The intended deployment credential is a **read-only** fine-grained PAT or GitHub App installation
  token (`Contents: Read`).
* The token is delivered to `git` through **`GIT_ASKPASS`**, in the child process environment only.
  It never appears in argv, never in the remote URL, and is never written to disk — the generated
  helper script contains only the *name* of an environment variable.
* The remote URL git receives carries the username `x-access-token`, which is a public sentinel,
  not a secret.
* `GIT_TERMINAL_PROMPT=0` and a per-invocation `-c credential.helper=` prevent both console and GUI
  credential prompts, so an unattended refresh fails fast rather than hanging.
* Every `git` failure passes through a single `redactGitError()` funnel before being logged,
  persisted or returned.
* `MAC_COMPANY_` is in the worker's `REFUSED_SANDBOX_ENV`, so the credential cannot be forwarded
  into a coding sandbox even by an administrator naming it explicitly.

---

## 5. Manifest behaviour

Validated against a zod schema that passes unknown fields through. Each failure has its own code and
is a hard failure recorded on the revision:

`COMPANY_MANIFEST_MALFORMED`, `COMPANY_MANIFEST_SCHEMA_UNSUPPORTED`, `COMPANY_MANIFEST_INVALID`,
`COMPANY_MANIFEST_UNSAFE_PATH`, `COMPANY_MANIFEST_DUPLICATE_DOCUMENT`.

* Schema version is checked **before** shape, so a future manifest is reported as an unsupported
  version rather than as a confusing shape complaint.
* Unsafe paths (`..`, absolute, backslash, NUL) are refused.
* Duplicates are refused rather than de-duplicated.
* Unknown future fields — top-level or nested — survive into the persisted manifest.
* `README.md` exists in the repository and is *not* mandatory; Mac does not require it.
* `governance.agents_may_approve_changes` is recorded but never obeyed upward: a manifest asserting
  `true` still cannot make Mac approve anything.

Every mandatory document must exist **and be non-empty**. A present-but-empty `AUTHORITY.md` is a
failure, because it would otherwise pass a file-exists check while grounding nothing.

---

## 6. Refresh behaviour

**At startup** (`index.ts`): verify the cache directory is outside the worker workspace, fetch,
resolve the ref, validate the manifest, validate every mandatory document, load, record the active
SHA. Startup does **not** crash on failure — an operator needs the UI to diagnose an unreachable
GitHub — but context-dependent work then fails individually and loudly.

**Before new work**: `ensureCurrentRevision` runs at the head of `startDiscovery`, `createRun`,
`createCodingRun` and the night-shift task start. A quiet window
(`company_context_min_refresh_seconds`, default 60) stops a night shift creating fifty runs from
making fifty fetches. An unchanged remote costs one fetch and no re-validation.

**Mid-run**: nothing refreshes. `answerAgentQuestion` reads the revision from the **run**, not from
the active pointer, so a commit landing at 02:14 is invisible to a run that started at 02:00.

**A bad commit does not disarm Mac.** If the current commit fails validation, the last known-good
revision stays active and the status reports `invalid`.

---

## 7. Cached / offline behaviour

Six explicit statuses: `disabled`, `fresh`, `cached`, `stale`, `invalid`, `unavailable`.

* Cached context is used **only** when `company_context_allow_cached` is true.
* The exact SHA is retained; nothing is approximated.
* `last_successful_refresh_at` is persisted (so it survives a restart) and surfaced in the UI.
* `company_context.cached_used` is audited **once per refresh attempt**, not once per read.
* With no valid revision and the feature enabled, context-dependent operations throw
  `COMPANY_CONTEXT_UNAVAILABLE`. There is no path that runs on empty company context while claiming
  to be grounded.

---

## 8. Context-selection behaviour

**Always-required core** — `AUTHORITY.md` in full, Mac's role and Shared Agent Context from
`AGENTS.md`, PAC identity and direction from `COMPANY.md`.

Core assembly takes **no query input and involves no model**, and `selectCompanyContext` throws if
`AUTHORITY.md` is absent rather than returning a thinner selection. There is therefore no code path
along which a task description can cause the authority document to be dropped. This is asserted
against an empty query, a nonsense query, a CSS query and a zero budget.

**Task-relevant** sections are scored by keyword coverage against the brief (or the agent's
question), weighted by document (`OPERATING_MODEL.md`/`SYSTEMS.md` 1.0 → `GLOSSARY.md` 0.6),
floored at 0.15, and truncated to a 12,000-character budget that the core is not counted against.
Dropped sections are reported, not silently discarded.

Rendered for the coding agent under `## PAC company context`, framed explicitly as *"company policy,
not task instruction… where the two appear to conflict, the policy wins and you ask"*, with every
section attributed to its document and heading.

---

## 9. Provenance behaviour

Recorded per revision: repository URL (credential-stripped), ref, commit SHA, commit authored date,
context version, schema version, the whole parsed manifest, manifest hash, document-set hash,
per-document metadata, validation state and errors, provider kind, source (`remote`/`cache`), and
load timestamps.

Bound to: discovery sessions, handoff briefs, runs, and supervised answers. Each binding emits
`company_context.bound_to_discovery` or `company_context.bound_to_run` carrying the SHA.

* The handoff brief names its revision **in the rendered markdown**, so a brief pasted into a pull
  request stays attributable.
* `GET /api/company-context/revisions/:id/document` serves a document **as it was at that revision**
  — proven by a test that rewrites `AUTHORITY.md`, refreshes, and reads the old text back.
* The binding is immutable: a direct `UPDATE` raises, and so does an attempt to null it.

---

## 10. Proposal and governance behaviour

Three independent barriers, any one sufficient:

1. **No write verb exists.** `CompanyContextProvider` has `describe`, `refresh`, `headRevision`,
   `listFiles`, `readFile`. A test enumerates the provider's entire surface and asserts exactly
   that set.
2. **Accepting changes nothing authoritative.** A test runs a full cycle — discovery, brief,
   proposal — and asserts the repository's refs and document bytes are unchanged.
3. **`accepted`/`rejected` require a human actor.** A `system` actor is refused with
   `COMPANY_PROPOSAL_HUMAN_REQUIRED`, and the refusal is audited on its own connection so it
   outlives the rolled-back transaction.

Proposals record target document and section, the change, reason, evidence, originating
project/task/run/discovery, potential impact, agent, base revision, status, timestamps and reviewer.
A proposal body containing a secret-shaped string is refused outright.

**No automatic learning into company policy.** `promoteToProjectMemory` still terminates at project
memory; there is no `promoteToCompanyContext`, and nothing calls `createProposal` automatically. A
test records the brief's own VSD-firmware example and asserts zero proposals and zero revisions
result.

**Forja** is modelled as a platform in `domain/agent-registry.ts`: `isPacAgent('forja') === false`,
`kind === 'platform'`, `assignable === false`. An integration test additionally asserts that Mac's
registry and the loaded `AGENTS.md` agree.

---

## 11. UI changes

* New **PAC context** page: repository, ref, context version, full and short SHA, refresh status,
  cached/stale indicator, validation state, obtained-from, last check, last successful refresh,
  commit authored date, consecutive failures, the mandatory document list with per-document load
  state and size, and the proposals list with accept/reject for operators. A **Refresh now** button.
* **`PAC Context: <short SHA>`** badge on the run detail page (which hosts the coding-run panels)
  and on the discovery session header.
* A **sidebar warning** that appears only when the status is not `fresh` — a permanent green badge
  is one an operator stops seeing.
* Dashboard carries a compact company-context summary.

No document editor, per the brief.

Verified visually against the real repository: the page renders `83ac4a0`, context version `0.1.0`,
`FRESH`, `VALID`, and all seven mandatory documents loaded with their real byte sizes; the run page
shows `PAC CONTEXT: 83AC4A0`.

---

## 12. Tests and results

**Final state — all green:**

| Suite | Result |
| --- | --- |
| `@mac/server` | **712 passed**, 58 skipped (opt-in) |
| `@mac/worker` | **216 passed**, 3 skipped |
| Typecheck (protocol, server, worker, web) | **clean** |
| Web production build | **clean** |

Baseline at the start of the sprint was 567 server / 216 worker. **145 tests were added and every
pre-existing test still passes.**

New test files:

| File | Tests | Covers |
| --- | --- | --- |
| `unit/company-manifest.test.ts` | 27 | valid manifest, malformed YAML, unsupported schema version, missing/empty/duplicate/unsafe mandatory entries, unknown-field round trip, section parsing, hashing |
| `unit/context-precedence.test.ts` | 31 | the ladder; task cannot grant deployment/spending/external-communication; manifest cannot grant approval; project may refine a non-prohibited default; silence denies; the ladder cited live in Mac's blocked answers |
| `unit/agent-registry.test.ts` | 13 | Forja is a platform, not an agent; agents and platforms disjoint |
| `integration/company-context-git.test.ts` | 25 | first clone, refresh, unchanged remote, new commit, README-only commit, historical read, failed fetch + cache, allow-cached off, staleness, no cache, validation failures, credential hygiene, **first authenticated clone** |
| `integration/company-context-provenance.test.ts` | 12 | SHA and version recorded; discovery/run/brief/answer bindings; old run keeps old SHA; trigger refuses re-pointing and nulling; ordinary run updates still work; historical document read |
| `integration/company-context-availability.test.ts` | 17 | core always present and unselectable-away; task-relevant selection for controls/architecture/UI tasks; refs carry document + SHA; rendered block framing; investigation consults company context; `company_policy` evidence; brief embeds context for the agent; discovery structuring receives it |
| `integration/company-context-governance.test.ts` | 16 | no write verb; repository byte-identical after a work cycle; no write routes; proposal creation and provenance; secret refusal; human-only accept/reject; refusal audited; decided proposals not reopened; learned knowledge creates nothing; Forja agreement with `AGENTS.md` |
| `integration/company-live.test.ts` | 6 | opt-in, real repository (below) |
| `integration/secret-hygiene.test.ts` | +4 | company token absent from provider fields, audit trail, status endpoint and API errors; refused by the sandbox env allowlist |

---

## 13. Real `PacTechnologiesAus/Company` test result

**Performed, and passing — 6/6.**

Run with `MAC_COMPANY_LIVE_TEST=1` and a token. Skipped by default; standard CI does not depend on
GitHub credentials.

Proven against the real repository:

* **Authentication** — the repository is **private**; anonymous access is refused, and the
  configured token authenticates.
* **Fetch** — mirror clone succeeded. `HEAD` of `main` is
  `83ac4a0c03fb882b3b9050f05d718eb2164369db`.
* **Manifest** — `context.yaml` validates at `schema_version: 1`, `context_version: 0.1.0`, with
  `agents_may_approve_changes: false`.
* **Mandatory documents** — all seven loaded and substantive: `COMPANY.md` (2161 B), `VALUES.md`
  (5969 B), `OPERATING_MODEL.md` (8357 B), `SYSTEMS.md` (6648 B), `AUTHORITY.md` (5741 B),
  `AGENTS.md` (8164 B), `GLOSSARY.md` (3460 B).
* **Commit SHA** recorded.
* **No write capability used** — the mirror's refs are identical before and after every read, and
  the provider exposes no write verb.
* `AUTHORITY.md` states the rules Mac enforces in code; `AGENTS.md` states that Forja is not one of
  the specialist staff agents.

The control plane was also started against the real repository and logged:
`PAC company context 83ac4a0 (version 0.1.0) loaded; status fresh.`

**Credential note, stated plainly:** the test was run with the developer's existing `gh` CLI token,
which is `repo`-scoped and therefore write-capable. No write was performed and none is possible
through this code path, but that token is **not** the deployment credential. The PAC deployment
should use a fine-grained PAT scoped to `Contents: Read` on this one repository.

---

## 14. Defects found and fixed

Four, all found by tests rather than by inspection.

* **#1 — `redactGitError` left a bearer token in the output.** The pattern consumed one token after
  the separator, so `Authorization: Bearer <secret>` had the word "Bearer" redacted and the secret
  preserved. Fixed to redact authorization headers to end of line, with separate patterns for bare
  credential assignments and `Bearer <token>`. *Found by the credential-hygiene test.*

* **#2 — `GIT_CONFIG_NOSYSTEM=1` broke HTTPS on Windows.** Discarding the system gitconfig also
  discarded the platform's TLS backend configuration, producing
  `schannel: CRYPT_E_NO_REVOCATION_CHECK` on every fetch. A controlled four-way probe confirmed the
  flag was the sole cause. Removed, with the reasoning recorded in the code; the one ambient
  behaviour genuinely worth suppressing — an interactive credential helper — is now handled with a
  per-invocation `-c credential.helper=`. The environment allowlist was also widened to include the
  proxy, profile and CA-bundle variables git legitimately needs. *Found by the real GitHub test.*

* **#3 — every authenticated first-time clone failed.** The askpass helper was written into the
  cache directory and the mirror was cloned into that same directory, so `git clone` found a
  non-empty destination and refused. This broke exactly the configuration the PAC deployment uses,
  while the token-less local tests passed happily. Fixed by cloning into a `mirror.git`
  subdirectory. A regression test now exercises the token path against a local repository, so this
  is caught without GitHub. *Found by the real GitHub test.*

* **#4 — `Function.length` used as a wiring assertion.** A test asserted the arity of
  `structureBriefWithModel` to prove company context was plumbed through; `Function.length` stops
  counting at the first defaulted parameter, so the assertion was wrong about correct code.
  Replaced with a behavioural test using the scripted-model seam, which proves the context reaches
  the prompt *and* changes which fields survive grounding. *Found by the test failing against
  working code.*

---

## 15. Assumptions

* **A-1** `company_context_enabled` defaults to **false**, matching the Sprint 3 idiom for every
  external integration (`night_shift_enabled`, `model_assist_enabled`, `mail_provider`). The PAC
  deployment sets it true. Without this, every Sprint 1–3.1 test would need a Company repository.
* **A-2** The Git provider reads through a **bare mirror**; there is no working checkout. "Local
  checkout/cache" in brief §5 is satisfied by a cache.
* **A-3** `README.md` is present in the repository but not manifest-mandatory, so Mac does not
  require it. The manifest is the authority on the document set.
* **A-4** `refresh.check_before_new_project` is honoured as "before a new discovery session or a new
  run", since Sprint 3.2 has no Project Registry.
* **A-5** The manifest's `precedence` list is validated and recorded, but the executable ladder
  lives in code — a document may not grant itself authority. `manifestPrecedenceMatches` reports
  disagreement; it does not fail the load.
* **A-6** The "explicit audited context transition" of brief §9 is **not** implemented. A run's
  binding is absolutely immutable in 3.2, enforced by a trigger. This is stricter than the brief
  requires.
* **A-7** Document content is not stored in Postgres; it is re-read from the mirror at the pinned
  SHA. Attribution of a historical run depends on the mirror still holding that commit (see R-1).
* **A-8** Proposal `accepted` means "a human agreed"; it does not create a commit. The merge
  workflow remains a human act, per brief §16.

---

## 16. Remaining security concerns

* **The deployment token is not yet read-only.** The live test used a `repo`-scoped developer
  token. Before this runs in production, PAC should mint a fine-grained PAT scoped to
  `Contents: Read` on `PacTechnologiesAus/Company` and nothing else. The provider has no write verb,
  so an over-scoped token grants nothing through Mac — but least privilege should still hold.
* **Company context is trusted input, and trusted input is still input.** Document text flows into
  coding-agent prompts. It is bounded, attributed and subordinate to the hard guardrails in code, so
  a hostile edit to `AUTHORITY.md` could confuse a prompt but could not grant an autonomous
  deployment. The mitigation is repository governance — branch protection and review on the Company
  repository — which is outside this codebase.
* **The askpass helper is a file on disk.** It contains no secret (only an environment variable
  name) and is written `0700`, but on a host where another process runs as the same user it is
  readable. The token itself is only ever in process memory and the child's environment.
* **`.env` now holds a real token on this development machine.** It is gitignored and was verified
  absent from git history. It should be rotated if this machine is shared.
* **Proposal secret-scanning is heuristic.** It catches common credential shapes; it is a safety
  net, not a guarantee.

---

## 17. Technical debt

* **Two known non-failing warnings persist** from Sprint 3.1: a missing `await` at
  `worker-plane.test.ts:295` and pg's concurrent-query deprecation notice. Unchanged by this sprint.
* **Discovery does not run investigations.** Company context reaches discovery through selection and
  the model-grounding path; the six/seven-source investigation is still only invoked from
  supervision. Wiring it into the gap-analysis question path would let Mac answer a discovery
  question from PAC policy instead of asking the engineer.
* **Per-shift context pinning is deferred.** Each run pins its own revision, so a long night shift
  could in principle run two tasks under two revisions. Visible (each run reports its SHA) but not
  prevented.
* **No revision retention policy.** `company_context_revisions` grows one row per commit Mac loads.
  Small in practice; unbounded in principle.
* **`manifestPrecedenceMatches` is not surfaced in the UI.** It is implemented and tested but
  nothing displays a disagreement between PAC's declared precedence and the code's ladder.
* **The selection layer is keyword-based.** It is deterministic and inspectable, which is why it was
  chosen, but it will miss a semantically relevant section that shares no vocabulary with the task.
  `AUTHORITY.md` being unconditional is what makes this safe rather than merely acceptable.

---

## 18. Definition of Done

| # | Requirement | Status |
| --- | --- | --- |
| 1 | Mac can securely load `PacTechnologiesAus/Company` | **Yes** — proven against the real private repository |
| 2 | `context.yaml` is validated | **Yes** — 27 manifest tests; no guessed fallback |
| 3 | Every mandatory document is validated | **Yes** — including present-but-empty |
| 4 | Context version and exact commit SHA are known | **Yes** — `0.1.0` / `83ac4a0…` |
| 5 | Discovery sessions record their PAC context SHA | **Yes** |
| 6 | Execution runs record their PAC context SHA | **Yes** — all three creation paths |
| 7 | Context is available to discovery and supervision | **Yes** — seventh source class; grounding in structuring |
| 8 | Mac distinguishes company policy from project knowledge and assumptions | **Yes** — `company_policy` evidence kind, factual, with document + SHA in the ref |
| 9 | Updates are detected before new work | **Yes** — `ensureCurrentRevision`, with a quiet window |
| 10 | Active runs remain pinned to their original context | **Yes** — database trigger, tested |
| 11 | Cached context behaviour is explicit and safe | **Yes** — six statuses, opt-in, exact SHA retained |
| 12 | Mac cannot directly modify authoritative company context | **Yes** — no write verb exists |
| 13 | Mac can create a separate proposal | **Yes** |
| 14 | Authority precedence remains enforced | **Yes** — and now cited in blocked answers |
| 15 | Forja is not treated as an agent | **Yes** — typed data, cross-checked against `AGENTS.md` |
| 16 | All previous tests remain green | **Yes** — 567 → 712 server, 216 worker, all passing |

---

## 19. The question the brief asks

> Can Mac now reliably perform a task knowing PAC Technologies' approved company context, values,
> operating model, system boundaries, agent roles, and authority rules, while preserving exactly
> which Company repository revision governed that work?

**Yes.**

The load path is proven against the real private `PacTechnologiesAus/Company` repository: it
authenticates, fetches, validates `context.yaml`, loads all seven mandatory documents, and records
commit `83ac4a0c03fb882b3b9050f05d718eb2164369db` at context version `0.1.0`.

That context reaches the places that reason. `AUTHORITY.md` is carried in full on every piece of
work and cannot be selected away by any query — asserted against empty, nonsense, unrelated and
zero-budget cases. Supervision consults company context as a factual evidence source whose
references name both the document and the SHA. The operating model, values, systems map and agent
roles are selected on relevance and delivered to the coding agent framed explicitly as policy rather
than as task instruction.

Attribution holds. Discovery sessions, briefs, runs and individual supervised answers each record
the governing revision, and the binding is immutable in the database — a test rewrites
`AUTHORITY.md`, advances the repository, and confirms the earlier run still reports its original SHA
while a new run picks up the new one. Because the checkout is a mirror, the old commit's text is
still readable, so "show me the policy this run worked under" is answerable rather than merely
recorded.

The governance boundary is structural rather than procedural: Mac has no verb that writes the
Company repository, accepting a proposal produces no commit, and a non-human actor cannot mark a
proposal accepted or rejected. Project knowledge does not become company policy on its own.

Two honest qualifications, neither of which undermines the answer. First, the live proof used a
developer token that is write-capable; no write was performed and none is reachable through this
code, but the deployment credential should be reduced to `Contents: Read`. Second, discovery's
question-asking path still does not run the full investigation, so company context informs
discovery through selection and grounding rather than by answering a gap-analysis question outright
— a capability gap, not a correctness one.
