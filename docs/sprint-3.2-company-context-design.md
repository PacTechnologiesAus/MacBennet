# Mac Bennett — Sprint 3.2 Implementation Design

**Sprint:** 3.2 — PAC Company Context Integration
**Branch:** `sprint-3.2/company-context`
**Base:** `main` at `b31937a` (Sprint 3.1 merged via PR #1)
**Authoritative context repository:** `https://github.com/PacTechnologiesAus/Company`
**Written:** 2026-08-18, before implementation, and reviewed against the Sprint 3.2 brief in §26.

---

## 0. What this sprint is

Sprint 3.1 proved the integrations work against real external systems. Sprint 3.2 gives Mac
something he has never had: **the approved PAC company context**, loaded from a human-governed
repository, validated, and attributable — so that a run performed last Tuesday can still be shown
the exact company policy that governed it.

The one-sentence statement of the whole sprint:

> Mac reads PAC's approved company context, uses it, records which revision he used, and can
> never change it.

Three properties are load-bearing and everything below serves them:

1. **Grounded.** A run that claims to be grounded in company context must actually have loaded
   every mandatory document. A partially-loaded `AUTHORITY.md` is a failure, not a warning.
2. **Attributable.** Every discovery session, run, brief and supervised answer records the exact
   commit SHA of the company context in force at the time, and that binding never moves.
3. **Governed.** Mac may propose. Only a human may approve. This is enforced structurally — there
   is no code path from Mac to a write on the authoritative repository — not by convention.

### What Sprint 3.2 explicitly does not do

Per brief §23: no Teams, no voice, no OpenClaw, no Project Registry, no Sales Engineer, no Project
Document Controller, no Otto changes, no Forja integration beyond respecting its documented role,
no customer communication, no PLC deployment, no production deployment. No automation of the human
merge workflow for accepted proposals.

### Architectural clarification carried into the code

**Forja is not an AI agent.** It is PAC Technologies' engineering and orchestration platform.
The authoritative `AGENTS.md` states this directly ("Forja is not itself one of the specialist
staff agents"), and §16.4 below describes how Mac's agent-registry domain model reflects it rather
than asserting it in prose.

---

## 1. Current context architecture (what exists at `b31937a`)

Before proposing anything, this is what Mac already has. Sprint 3.2 extends it; it does not
rewrite it.

### 1.1 The context Mac holds today

| Layer | Where it lives | Scope | Written by |
| --- | --- | --- | --- |
| Repository facts | `discovery_sessions.context_snapshot` (`ProjectContextSnapshot`) | one task's project | the worker, which holds the clone |
| Handoff brief | `handoff_briefs.content` (`HandoffBriefContent`) | one task | discovery, from the human conversation |
| Global memory | `memory_entries` scope `global` | everything | operators and services |
| Project memory | `memory_entries` scope `project` | one project | operators, promotion from task memory |
| Task memory | `memory_entries` scope `task` | one task, structurally unreachable from siblings | services, during a run |
| monday.com item text | fetched live in `gatherMondayContext` | one task | humans, on the item |
| Previous runs / briefs | `agent_questions`, `handoff_briefs` | one project | earlier work |

There is **no company-wide, human-governed, versioned layer**. `global` memory is the closest
thing, and it is the wrong shape: it is mutable by Mac, unversioned, has no manifest, no mandatory
document set, no provenance, and no governance boundary. Sprint 3.2 does not repurpose it.

### 1.2 How context reaches the four consumers today

**Discovery** (`services/discovery.ts`)
`startDiscovery` → `recordContextSnapshot` (worker posts the repo snapshot) → free-flow messages →
`generateBrief`, which runs the deterministic `structureConversation`, optionally lets a model fill
*only empty* fields, then `createBrief` → `analyseGaps` computes understanding confidence → one
next question.

**Supervision** (`services/supervision.ts` + `domain/supervision.ts`)
`answerAgentQuestion` persists the question first, then decides from `loadRunContext` (brief, task
memory, repository snapshot, approved scope) via the pure `superviseQuestion`, and *alongside* it
runs the six-source `runInvestigation`. The investigation may improve the wording and confidence of
an **answered** decision; it can never rewrite a **blocked** one.

**Model-backed resolvers** (`services/model/resolvers.ts`)
Two seams only: `structureBriefWithModel` (fills empty brief fields, dropping anything not grounded
in the engineer's own vocabulary) and `resolveAnswerWithModel` (rephrases an answer from sources the
deterministic layer already supplied). The model never decides *whether* something resolved.

**Handoff briefs → coding agent** (`services/coding-runs.ts` → `protocol/brief.ts` →
`worker/coding/claude-code-adapter.ts`)
`buildCodingAssignment` renders `renderBriefMarkdown` into `CodingTask.briefMarkdown`;
`buildInitialPrompt` wraps it in standing rules and sends it to Claude Code. The structured brief is
the specification; the raw conversation never is.

**Reports** (`services/reports.ts`, `overnight-report.ts`) read runs, questions, assumptions,
blockers and reviews.

### 1.3 The properties Sprint 3.2 must not break

* Groundedness is **derived from evidence**, never asserted (`deriveGroundedness`), and an
  ungrounded answer is capped at `UNGROUNDED_CONFIDENCE_CEILING = 0.59`.
* Understanding confidence is **recomputed** from the brief; nobody can raise it by asserting it.
* Guardrails are pure predicates in `domain/guardrails.ts`, plus a SQL predicate at dispatch.
* Audit events are written **in the same transaction** as the change they describe, and are
  immutable (trigger on UPDATE/DELETE/TRUNCATE).
* Task memory cannot contaminate a sibling task.
* Credentials live only in the control plane. The sandbox environment is built from empty, and
  `REFUSED_SANDBOX_ENV` refuses to forward anything that names a control-plane credential.

---

## 2. Sprint 3.2 architecture at a glance

```
                        github.com/PacTechnologiesAus/Company   (human-governed, read-only to Mac)
                                       |  fetch (mirror, credential via GIT_ASKPASS)
                                       v
  +------------------------------------------------------------------------------+
  | CONTROL PLANE                                                                |
  |                                                                              |
  |  services/company-context/                                                   |
  |    provider.ts      CompanyContextProvider interface + registry              |
  |    git-provider.ts  bare MIRROR at $MAC_COMPANY_CONTEXT_DIR (no worktree)    |
  |    manifest.ts      context.yaml parse + validate (zod, path-safe)           |
  |    loader.ts        fetch -> validate -> load -> hash -> persist revision    |
  |    service.ts       startup refresh, ensureFresh, bind, status, cache policy |
  |    selection.ts     deterministic core + task-relevant section selection     |
  |    proposals.ts     propose-only governance                                  |
  |                                                                              |
  |  domain/                                                                     |
  |    company-context.ts    pure: section parsing, hashing, doc classification  |
  |    context-precedence.ts pure: layer ranks + hard prohibitions               |
  |    agent-registry.ts     pure: PAC agents vs platforms (Forja)               |
  |                                                                              |
  |  db: company_context_revisions -- bound by --> discovery_sessions            |
  |      company_context_status                   runs                           |
  |      company_context_proposals                handoff_briefs                 |
  |                                               agent_questions                |
  +------------------------------------------------------------------------------+
                    |                                    |
                    | selected sections only             | never
                    v                                    v
        handoff brief / supervision              worker + coding sandbox
        (Mac's own reasoning)                    (no Company credential, no checkout)
```

The checkout is a **bare mirror**, it lives **outside every coding workspace**, and no path to it is
ever placed in a sandbox mount plan. The coding agent receives *selected text*, embedded in a brief,
and never a filesystem handle to company policy.

---

## 3. Company Context Provider

### 3.1 The abstraction

Company context is deliberately **not** a memory scope. It is its own service with its own
interface, because it has properties memory does not: a manifest, mandatory documents, an external
governing authority, a commit identity, and a prohibition on Mac writing it.

```ts
// services/company-context/provider.ts
export interface CompanyContextProvider {
  /** Stable identifier for audit and status. First provider is 'git'. */
  readonly kind: CompanyContextProviderKind;   // 'git' | 'memory' (tests)
  /** Repository URL and ref, with any credential removed. */
  describe(): { repositoryUrl: string; ref: string; cacheDir: string };
  /** Ensure a local cache exists and is as current as the remote. */
  refresh(): Promise<RefreshOutcome>;
  /** The commit the ref currently points at in the LOCAL cache. Null when none. */
  headRevision(): Promise<{ commitSha: string; ref: string; committedAt: string } | null>;
  /** File list at an exact commit. */
  listFiles(commitSha: string): Promise<string[]>;
  /** File content at an exact commit. Throws when absent. */
  readFile(commitSha: string, relativePath: string): Promise<string>;
}

export type RefreshOutcome =
  | { ok: true; commitSha: string; changed: boolean; fetchedFromRemote: boolean }
  | { ok: false; error: string; cachedCommitSha: string | null };
```

Everything above the interface — validation, loading, provenance, selection, proposals — is provider
agnostic. Replacing Git later (an S3 bundle, a Forja-served manifest) means implementing five
methods.

The capability set the brief asks for maps onto these layers:

| Brief capability | Where it lives |
| --- | --- |
| fetch / refresh | `provider.refresh()` |
| validate | `manifest.ts` + `loader.validateDocuments` |
| load | `loader.loadRevision` |
| identify version | `manifest.context_version`, persisted on the revision |
| identify Git commit SHA | `provider.headRevision()`, persisted on the revision |
| retrieve required company context | `selection.selectCoreContext` |
| retrieve relevant sections | `selection.selectTaskContext` |
| expose provenance | `CompanyContextRevisionDto` |
| detect staleness | `service.getStatus()` (`cached`, `stale`, `lastSuccessfulRefreshAt`) |
| produce proposed changes without writing | `proposals.createProposal` |

### 3.2 Why the Git provider uses a bare mirror

`git clone --mirror` rather than a working checkout, refreshed with `git remote update --prune`,
read with `git show <sha>:<path>`. Four reasons, in order of importance:

1. **Historical attribution actually works.** Brief §8 requires that a run stays attributable to the
   context that governed it. With a mirror, the old commit's documents remain *readable*, so "show
   me the AUTHORITY.md this run was bound to" is answerable, not merely recorded as a SHA.
2. **There is no working tree to tamper with.** A checkout invites a stray process to edit
   `AUTHORITY.md` on disk and have Mac read the edit as policy. A mirror has no such file.
3. **Reads are pinned by construction.** `git show <sha>:<path>` cannot accidentally read a
   different revision than the one the run is bound to. There is no "current branch" to drift.
4. **Refresh is atomic from the reader's point of view.** `remote update` moves refs; in-flight
   readers are already holding a SHA.

**Repository integrity.** Reads resolve only through the mirror's own refs, and a `--prune` fetch
means a rewritten remote history is *observable* (the SHA changes, and the old commit may become
unreachable) rather than silently absorbed.

### 3.3 What the provider deliberately cannot do

There is no `write`, `commit`, `push`, or `checkout` method on the interface, and the Git provider
runs `git` with a fixed allowlisted argv per operation — never a caller-supplied subcommand. The
only mutating Git operations the process can perform are `clone --mirror` and `remote update` on
Mac's own cache directory. Brief §20's "coding-agent-generated text must never be able to mutate the
authoritative Company checkout" is therefore true because the mutation *verb* does not exist in the
codebase, which is a stronger guarantee than a permission check.

---

## 4. Repository configuration and authentication

### 4.1 Configuration

New environment (`apps/server/src/config.ts`, mirrored into `.env.example`):

```
MAC_COMPANY_CONTEXT_REPO_URL   default https://github.com/PacTechnologiesAus/Company.git
MAC_COMPANY_CONTEXT_REF        default main
MAC_COMPANY_CONTEXT_DIR        default <os.homedir()>/.mac-bennett/company-context
MAC_COMPANY_CONTEXT_TOKEN      optional; read-only GitHub token
MAC_COMPANY_CONTEXT_TIMEOUT_MS default 60000
```

The URL is configurable but the PAC deployment value is the default, so a correct deployment needs
only the token.

New settings columns (operator-controllable, not credentials):

```
company_context_enabled              boolean  default false
company_context_allow_cached         boolean  default true
company_context_min_refresh_seconds  integer  default 60
company_context_max_stale_hours      integer  default 168   -- 7 days; 0 = no limit
```

**Why `company_context_enabled` defaults to false.** It follows the established Sprint 3 idiom
(`night_shift_enabled`, `model_assist_enabled`, `mail_provider = 'none'`): an integration that
reaches an external system is inert until an operator turns it on. With it off, company context is
simply absent — bindings are `null` and nothing fails, which is why every Sprint 1–3.1 test remains
untouched and green. With it on, missing or invalid context **fails** context-dependent operations
per brief §7 and §10. The intended PAC deployment sets it true; `.env.example` and the README say so.

### 4.2 Authentication model

Preferred deployment permission is **read-only** access to `PacTechnologiesAus/Company`: a
fine-grained PAT or GitHub App installation token with `Contents: Read`, and nothing else.

The token is supplied to `git` through **`GIT_ASKPASS`**, never through argv and never through the
URL:

* the remote URL is `https://x-access-token@github.com/PacTechnologiesAus/Company.git` — a username,
  not a secret, so it is safe in `ps` output and in the audit trail;
* a helper script is generated into the cache directory (mode `0700`) whose entire body echoes the
  value of an environment variable. **The script contains no secret** — only the variable's name;
* the token is passed in the child process environment of the `git` invocation only;
* `GIT_TERMINAL_PROMPT=0` and `GIT_CONFIG_NOSYSTEM=1` are set, so an unauthenticated fetch fails
  fast instead of hanging on a prompt or picking up ambient config.

Alternatives considered and rejected: token-in-URL (leaks into `git remote -v`, reflog, error text
and `ps`); `http.extraheader` via `-c` (leaks into argv); a credential store on disk (writes the
secret to a file, which is worse than holding it in the process).

**Redaction.** All `git` stderr passes through `redactGitError()` before it is logged, persisted or
returned in an API error. It removes the token value if present, strips `https://<anything>@`
userinfo, and truncates. Every recorded failure reason goes through it — there is one funnel, not a
rule to remember at each call site.

### 4.3 What the worker and the coding agent get

Nothing. The `MAC_COMPANY_` prefix is added to the worker's `REFUSED_SANDBOX_ENV` list, so an
administrator cannot forward the token into a sandbox even by naming it explicitly; the worker
refuses to start rather than doing so. The worker's own config schema does not read it. Company
context reaches the coding agent only as **selected text inside the handoff brief markdown**.

---

## 5. Repository storage

| Property | How |
| --- | --- |
| outside project coding workspaces | default `~/.mac-bennett/company-context`; the worker's workspace is `MAC_WORKER_WORKSPACE` (default `./workspace`) and worktrees are created beneath it. Startup asserts the cache dir is not inside the configured worker workspace, and refuses otherwise. |
| readable by the control plane | it is the control plane's own directory |
| protected from coding-agent modification | never appears in a sandbox mount plan; the sandbox denies everything not explicitly mounted, and existing conformance tests prove an agent cannot reach unmounted paths |
| version identifiable | `git rev-parse refs/heads/<ref>` in the mirror; recorded on every revision row |
| safely refreshable | `git remote update --prune`; readers hold SHAs, not the ref |
| not cloned per worktree | there is exactly one cache, owned by the control plane; the worker has no company-context code at all |

The directory is created with mode `0700`.

---

## 6. Manifest: `context.yaml`

### 6.1 The real manifest

The authoritative repository at `83ac4a0` declares:

```yaml
schema_version: 1
organisation: { name: PAC Technologies }
context_version: 0.1.0
documents:
  mandatory: [COMPANY.md, VALUES.md, OPERATING_MODEL.md, SYSTEMS.md, AUTHORITY.md, AGENTS.md, GLOSSARY.md]
precedence: [AUTHORITY.md, agent_specific_context, project_context, task_context]
governance:
  agents_may_propose_changes: true
  agents_may_approve_changes: false
  human_review_required: true
refresh:
  check_on_agent_start: true
  check_before_new_project: true
  record_commit_sha: true
```

Note what is **not** hardcoded anywhere in Mac: the document list. Brief §"Authoritative Context
Repository" is explicit — the manifest is the loading definition. `README.md` is present in the
repository but is *not* mandatory, and Mac does not require it.

### 6.2 Validation rules

Parsed with `yaml` (new dependency, `apps/server`) into a zod schema. Unknown fields at every level
pass through and are preserved in the persisted manifest, so a future `documents.optional:` or
`retention:` block does not break an older Mac.

Critical validation, each producing a distinct error code and each a hard failure:

| Check | Failure code |
| --- | --- |
| YAML parses | `COMPANY_MANIFEST_MALFORMED` |
| `schema_version` present, integer, in `SUPPORTED_MANIFEST_SCHEMA_VERSIONS = [1]` | `COMPANY_MANIFEST_SCHEMA_UNSUPPORTED` |
| `context_version` present, non-empty string | `COMPANY_MANIFEST_INVALID` |
| `documents.mandatory` present, non-empty array of strings | `COMPANY_MANIFEST_INVALID` |
| every mandatory entry is a safe relative path (no `..`, no leading `/` or drive letter, no backslash, no NUL, bounded length) | `COMPANY_MANIFEST_UNSAFE_PATH` |
| no duplicate mandatory entries (after normalisation) | `COMPANY_MANIFEST_DUPLICATE_DOCUMENT` |
| `precedence` present, non-empty array of strings | `COMPANY_MANIFEST_INVALID` |
| `governance` present with all three booleans | `COMPANY_MANIFEST_INVALID` |
| `refresh` present with all three booleans | `COMPANY_MANIFEST_INVALID` |

There is **no fallback to a guessed policy**. A manifest Mac cannot understand produces a revision
recorded with `validation_state = 'invalid'` and its errors, and every context-dependent operation
then behaves as though no valid context exists (§10).

### 6.3 Governance fields are recorded, not obeyed upward

`governance.agents_may_approve_changes` is validated and persisted. It is **not** consulted as an
authorisation gate: even a manifest asserting `true` cannot grant Mac approval authority, because
approval requires a write path that does not exist (§3.3, §16). This is a deliberate instance of
precedence rule 1 — hard application guardrails outrank document content — and it is a test.

---

## 7. Mandatory documents

`loadRevision` reads every path in `documents.mandatory` at the pinned SHA. For each it records
`{ path, bytes, sha256, headings[] }`. Any missing or unreadable document is a hard failure
(`COMPANY_MANDATORY_DOCUMENT_MISSING`) naming *which* document; a revision with a missing mandatory
document is persisted with `validation_state = 'invalid'` so the failure is queryable afterwards,
and is never made active.

An empty (0-byte) mandatory document is also a failure: `AUTHORITY.md` present but empty would
otherwise pass a file-exists check while grounding nothing.

`manifest_sha256` is the hash of the raw `context.yaml` bytes. `document_set_sha256` is the hash of
the sorted `path:sha256` lines. Together they let two revisions be compared without re-reading Git,
and let a corrupted cache be detected.

---

## 8. Provenance model

### 8.1 The revision record

`company_context_revisions` — one row per (repository, commit) Mac has ever loaded or attempted:

| column | why |
| --- | --- |
| `id` uuid | referenced by bindings |
| `repository_url` text | brief §8; stored with credentials already stripped |
| `ref` text | branch/ref |
| `commit_sha` text | the exact revision |
| `commit_authored_at` timestamptz | lets the UI say how old the policy is |
| `context_version` text | from the manifest |
| `schema_version` integer | from the manifest |
| `manifest` jsonb | the whole parsed manifest, unknown fields included |
| `manifest_sha256` / `document_set_sha256` text | integrity + comparison |
| `documents` jsonb | `[{path, bytes, sha256, headings}]` — metadata, **not content** |
| `validation_state` text | `valid` \| `invalid` |
| `validation_errors` jsonb | populated when invalid |
| `provider_kind` text | `git` today |
| `source` text | `remote` \| `cache` — how this load was obtained |
| `loaded_at` / `first_seen_at` timestamptz | brief §8 |

Unique on `(repository_url, commit_sha)`. Reloading the same commit updates `loaded_at` and
`source`; it does not create a second row, so bindings stay stable.

Document **content is not stored in the database.** It is re-readable from the mirror at the SHA,
and duplicating policy text into Postgres would create a second, un-governed copy — exactly the
thing this sprint exists to avoid. Brief §19 also asks that document contents not be logged
unnecessarily.

### 8.2 Bindings

| Table | Column | Bound when | Mutable after? |
| --- | --- | --- | --- |
| `discovery_sessions` | `company_context_revision_id` | `startDiscovery` | never |
| `handoff_briefs` | `company_context_revision_id` | `createBrief` | never (new version = new row) |
| `runs` | `company_context_revision_id` | run creation (`createRun`, `createCodingRun`, night shift) | never |
| `agent_questions` | `company_context_revision_id` | `answerAgentQuestion` | never |

All four are `uuid references company_context_revisions(id) on delete restrict` — a revision that
governed work cannot be deleted out from under it.

**Immutability is enforced in SQL**, not by convention: a `BEFORE UPDATE` trigger on each of the
four tables raises if `company_context_revision_id` changes from a non-null value to a different
value, including to null. This is how brief §9's "active runs remain pinned" and §24's requirement
10 become true rather than intended, and it is why a mid-run refresh cannot leak into an in-flight
run even through a code path nobody anticipated.

An **audited context transition** (brief §9's explicit exception) is out of scope for 3.2: there is
no such operation, so the pin is absolute. This is recorded as assumption A-6.

### 8.3 The handoff brief carries it visibly

`renderBriefMarkdown` gains an optional `companyContext` meta field, rendering a line such as:

```
_PAC company context: 83ac4a0 (context version 0.1.0)_
```

so a brief read on paper, in a PR, or by the coding agent identifies its governing revision
(brief §8: "handoff brief can identify context revision").

---

## 9. Refresh behaviour

### 9.1 On startup

`apps/server/src/index.ts`, after settings load and before `listen`:

1. if `company_context_enabled` is false → status `disabled`, done;
2. verify/create the cache directory, assert it is outside the worker workspace;
3. `provider.refresh()` — clone-if-absent, else `remote update --prune`;
4. resolve the configured ref to a commit SHA;
5. validate the manifest;
6. validate every mandatory document;
7. load and persist the revision, mark it active;
8. record `company_context.loaded`.

**Startup does not crash on failure.** A control plane that refuses to boot because GitHub is down
is a control plane an operator cannot use to *see* that GitHub is down. Instead the failure is
recorded, `company_context.refresh_failed` is audited, and the cached-context policy in §10 decides
what happens next. Context-dependent operations then fail individually, loudly, and with the reason
on the status endpoint.

### 9.2 Before a new discovery or major task

`ensureCurrentRevision({ reason })` is called at the head of `startDiscovery`, `createRun`,
`createCodingRun`, and the night-shift run creation path:

1. if the last remote check was less than `company_context_min_refresh_seconds` ago, reuse the
   active revision (this stops a night shift creating fifty runs from making fifty fetches);
2. otherwise `provider.refresh()`; if the resolved SHA equals the active revision's, touch the check
   timestamp and reuse it — an unchanged remote costs one fetch and no re-validation;
3. if it differs, validate + load the new revision and make it active;
4. bind whatever is active to the new session/run.

A refresh failure here **does not** fail the operation if a valid active revision exists — the
active revision is used and marked cached/stale (§10). It fails only when there is nothing valid to
bind.

### 9.3 Mid-run

Nothing refreshes inside a run. `ensureCurrentRevision` is never called from the supervision path;
`answerAgentQuestion` binds **the run's** revision to the question row, deliberately reading it from
`runs.company_context_revision_id` rather than from the active pointer. A newer commit appearing at
02:14 is therefore invisible to a run that started at 02:00 — provably, because the question row's
binding comes from the run and the trigger forbids the run's binding from moving.

---

## 10. Offline / cached behaviour

State machine for the status the UI shows:

| status | meaning |
| --- | --- |
| `disabled` | `company_context_enabled` is false |
| `fresh` | last refresh contacted the remote successfully; active revision validated |
| `cached` | remote unreachable; a previously validated revision is active and permitted |
| `stale` | as `cached`, and older than `company_context_max_stale_hours` |
| `unavailable` | no valid revision (never loaded, or the only candidate failed validation) |
| `invalid` | remote reachable, but the current commit fails manifest/document validation |

Rules:

* cached context is used **only** when `company_context_allow_cached` is true. With it false, a
  fetch failure moves the status to `unavailable` and context-dependent operations fail;
* a cached revision keeps its exact SHA — nothing is approximated;
* `last_successful_refresh_at` is surfaced on the status endpoint and in the UI;
* every use of cached context audits `company_context.cached_used` **once per refresh attempt**, not
  once per read, so the trail stays readable;
* `unavailable` or `invalid` while enabled → context-dependent operations throw
  `COMPANY_CONTEXT_UNAVAILABLE` (409). There is no path that runs with empty company context while
  claiming to be grounded.

`company_context_status` is a singleton row (id = 1, CHECK-enforced, matching the `settings`
pattern) holding `active_revision_id`, `status`, `last_check_at`, `last_successful_refresh_at`,
`last_error`, `consecutive_failures`. It is persisted rather than in-memory so "last successful
refresh" survives a restart, which is precisely when an operator asks.

---

## 11. Context precedence

### 11.1 The ladder

`domain/context-precedence.ts`, pure and unit-tested:

```ts
export const CONTEXT_LAYERS = [
  'hard_guardrail',       // 0 — enforced in code; outranks every document
  'company_authority',    // 1 — AUTHORITY.md
  'mac_role',             // 2 — Mac-specific role configuration (AGENTS.md § Mac)
  'project_context',      // 3 — authoritative project context
  'task_instruction',     // 4 — the current approved task instructions
  'learned_knowledge',    // 5 — project/task learned knowledge
  'assumption',           // 6 — assumptions
] as const;
```

### 11.2 The hard prohibitions

```ts
export const PROHIBITED_CAPABILITIES = [
  'live_deployment',
  'protected_branch_merge',
  'financial_commitment',
  'external_communication',
  'customer_commitment',
  'safety_control_change',
  'destructive_action',
  'ip_or_warranty_authority',
] as const;
```

These are drawn from brief §11 and corroborated by the authoritative `AUTHORITY.md` and by spec §16
"Hard V1 Prohibitions". They are declared **in code**, not read from the repository, because a
document that can grant itself authority is not a guardrail. If `AUTHORITY.md` were edited tomorrow
to permit autonomous deployment, Mac would still refuse — and that is the correct behaviour, because
the prohibition is also a technical control in this application.

### 11.3 The resolution function

```ts
resolveCapability({
  capability: string,
  statements: Array<{ layer: ContextLayer; effect: 'allow' | 'deny'; source: string }>,
}): { allowed: boolean; decidedBy: ContextLayer; source: string; reason: string }
```

1. If `capability` is prohibited → `{ allowed: false, decidedBy: 'hard_guardrail' }`,
   **regardless of any statement at any layer**. A task instruction, a project fact, and a
   hypothetical `AUTHORITY.md` edit are all inert here.
2. Otherwise, a `deny` at `company_authority` or stronger is final.
3. Otherwise, the **most specific** statement wins — the highest layer index among those present —
   which is how "more specific context may refine general policy" becomes executable. A project
   context may refine a Company default; a task may refine a project default.
4. With no statement at all → denied, `decidedBy: 'hard_guardrail'`. Absence of permission is not
   permission.

This is a pure function over declared statements. It does not itself gate dispatch — the existing
`domain/guardrails.ts` predicates and the git shim continue to do that — but it is the model
supervision consults when classifying evidence, and it is what the §22 precedence tests assert
against.

---

## 12. Company context in discovery

`startDiscovery` binds the active revision. `generateBrief` then:

* selects company context for the task (§15) and records the selection on the brief;
* the model-assisted structuring path is given the selected sections as additional grounding
  vocabulary — with the *same* rule as today: a field the model returns that shares no distinctive
  vocabulary with what the engineer or the selected context actually said is dropped;
* `discovery.investigation` gains a seventh source class.

### 12.1 The seventh source class

`INVESTIGATION_SOURCES` becomes:

```
repository, company_context, project_memory, task_memory, previous_runs, previous_briefs, monday
```

with a matching evidence kind `company_policy` added to `EVIDENCE_KINDS` and to
`FACTUAL_EVIDENCE_KINDS` — company policy is a fact, not an assumption.

Ordering: `company_context` is placed **second**, after `repository`. Repository facts remain
cheapest and least ambiguous; company policy is next because it is authoritative and stable, and
because a policy answer should outrank a stale project memory.

Authority weight for a company-context candidate is `0.9`, with the evidence `ref` shaped as
`company:AUTHORITY.md#Financial Authority@83ac4a0`, so the source document *and* the commit SHA are
in the reference itself (brief §13).

**Existing behaviour is preserved.** With company context disabled or unavailable, the source is
recorded as `consulted: false, note: 'Nothing of this kind was available.'` — exactly the shape
every other absent source already produces — so no existing investigation test changes meaning.

### 12.2 What the human stops repeating

Selection guarantees the core block, which carries PAC's identity and direction, Mac's role, and the
whole of `AUTHORITY.md`. Brief §12's example — scoping an internal PAC idea — is then answerable
without the engineer restating that Forja is the orchestration platform, that monday.com is the work
system of record, or that Mac may not commit to a delivery date.

---

## 13. Company context in supervision

`answerAgentQuestion` reads the run's bound revision and adds company context to the evidence
gathering. The distinction brief §13 requires is made explicit by the evidence kinds, which already
flow into `agent_questions.evidence` and the audit metadata:

| Mac says | Evidence kind |
| --- | --- |
| company policy | `company_policy` |
| project fact | `project_memory`, `repository_fact` |
| task instruction | `user_approved_decision` (the brief) |
| learned project fact | `task_memory`, `previous_run` |
| assumption | `inferred_assumption` |

`AgentAnswer` gains `companyContext: { commitSha, contextVersion } | null`, so the answer handed
back to Claude Code names the governing revision.

**Generic model knowledge cannot override explicit PAC context.** Two existing mechanisms already
guarantee this and are extended rather than replaced: `resolveAnswerWithModel` may only phrase an
answer from sources the deterministic layer supplied (a citation to a source not in the supplied set
is counted as a fabrication and the output is rejected), and `capUngroundedConfidence` caps anything
without factual evidence at 0.59. A model assertion contradicting `AUTHORITY.md` therefore cannot
become a high-confidence answer, because it has no evidence ref to stand on.

A **blocked** decision is still never rewritten by better grounding, company context included.

---

## 14. Company context in handoff briefs

Brief §14 is explicit that the whole repository must not be injected into every prompt. The brief
carries:

* the **core** block, always (§15);
* **task-relevant** sections, selected;
* a provenance line naming the SHA and context version.

`renderBriefMarkdown` gains a `## PAC company context` section rendered from the selection, with
each included section headed by its document and heading so the coding agent can attribute it:

```
## PAC company context

_Revision 83ac4a0 (context version 0.1.0). Company policy, not task instruction._

### AUTHORITY.md — Live and Commissioned Systems
PAC AI agents must NEVER autonomously deploy changes to a live or commissioned customer system. ...
```

The framing sentence matters: the agent is told this block is **policy**, distinct from the task
instructions above it, which is the prompt-level expression of §11's precedence.

Worked examples from the brief:

* *a normal UI bug* — core only. `AUTHORITY.md`, Mac's role, PAC identity. No warranty policy,
  because no selection keyword matched it.
* *a project-architecture task* — core plus `COMPANY.md § Direction`, `SYSTEMS.md § Forja`,
  `SYSTEMS.md § Principle`, `AGENTS.md § Operating Model`.
* *a controls project* — core plus the operating model's implementation, testing, safety-review and
  commissioning sections, and the testing/safety values.

---

## 15. Context selection

`services/company-context/selection.ts`, over sections parsed by
`domain/company-context.ts:parseSections` (markdown split on `##`, retaining the `#` title as a
document preamble).

### 15.1 Always-required core — deterministic, not model-selected

```ts
export const CORE_SELECTORS = [
  { document: 'AUTHORITY.md', sections: '*' },      // entire document
  { document: 'AGENTS.md',   sections: ['Mac — Automation Engineer', 'Shared Agent Context', 'Operating Model'] },
  { document: 'COMPANY.md',  sections: ['Who We Are', 'Direction'] },
];
```

`AUTHORITY.md` is included **in full** rather than section-selected. It is roughly 4.7 KB — about
1,200 tokens — and the cost of including all of it is far below the cost of a selection heuristic
omitting the one clause that mattered. Brief §15's "hard authority content must remain
deterministically available" is satisfied by construction, not by scoring.

Core assembly is a pure function of the loaded document set. It has **no keyword input and no model
involvement**, so there is no code path along which a task description can cause `AUTHORITY.md` to
be dropped. `selectCompanyContext` asserts the core is non-empty and that `AUTHORITY.md` is present
before returning; a violation throws rather than returning a thinner selection.

A document named in `CORE_SELECTORS` that the manifest does not declare mandatory is skipped without
error — the manifest remains the authority on what exists — but `AUTHORITY.md` missing is already a
load failure (§7), so the core cannot silently lose it.

### 15.2 Task-relevant selection

Deterministic keyword coverage scoring, reusing the same `keywords()` tokeniser the Sprint 2/3
supervision uses, so section selection behaves like the rest of Mac's retrieval:

* candidate sections: everything in `COMPANY.md`, `VALUES.md`, `OPERATING_MODEL.md`, `SYSTEMS.md`,
  `AGENTS.md`, `GLOSSARY.md` that is not already in core;
* query text: the brief title, objective, desired behaviour, constraints and affected components —
  or, for supervision, the agent's question and context;
* score = (matched query terms / total query terms) × section weight, where weight is 1.0 for
  `OPERATING_MODEL.md` and `SYSTEMS.md`, 0.9 for `AGENTS.md` and `VALUES.md`, 0.8 for `COMPANY.md`,
  0.6 for `GLOSSARY.md` (definitions corroborate; they rarely decide);
* sections below `MIN_SECTION_SCORE` are dropped;
* the result is truncated to `TASK_CONTEXT_CHAR_BUDGET = 12000` characters by descending score,
  and what was dropped is reported in the selection result rather than silently discarded.

Correctness over premature token optimisation, per brief §14: the budget is generous, and the core
is never counted against it.

---

## 16. Context change proposals and the governance boundary

### 16.1 The proposal record

`company_context_proposals`:

`id`, `target_document`, `target_section`, `proposed_change`, `reason`, `evidence` (jsonb array of
`EvidenceRef`), `project_id`, `task_id`, `run_id`, `discovery_session_id`, `potential_impact`,
`agent` (text, default `'mac'`), `base_revision_id` (the revision it was written against),
`status` (`proposed` | `under_review` | `accepted` | `rejected` | `superseded`), `created_by`,
`created_at`, `updated_at`, `reviewed_by`, `reviewed_at`, `review_notes`.

`status` is CHECK-constrained against the enum, like every other enum column in the schema.

### 16.2 Why Mac structurally cannot approve

Three independent barriers, any one of which suffices:

1. **No write verb exists.** `CompanyContextProvider` has no method that mutates the repository
   (§3.3). There is nothing to call.
2. **Accepting a proposal changes nothing authoritative.** `status = 'accepted'` records a human
   decision; it does not produce a commit. Brief §16 explicitly leaves the human merge workflow to a
   person.
3. **Status transitions to `accepted` or `rejected` require a human actor** — `actor.type === 'user'`.
   A system or worker actor is refused with `COMPANY_PROPOSAL_HUMAN_REQUIRED`, and the refusal is
   audited via `recordRejection` so it outlives the rolled-back transaction.

### 16.3 No automatic learning into company policy

`promoteToProjectMemory` remains the only promotion path and it terminates at **project** memory.
There is no `promoteToCompanyContext`, and no service calls `createProposal` automatically. Brief
§17's VSD-firmware example resolves as: task memory → (validated) → project memory → (a human, or
Mac when asked) → a *proposal* → a human → a commit. The test asserts that recording learned
knowledge produces zero proposals and zero revisions.

### 16.4 Forja in the domain model

`domain/agent-registry.ts` declares PAC's agent workforce and its platforms as **separate typed
collections**:

```ts
export const PAC_AGENTS = ['mac', 'otto', 'project_document_controller', 'sales_engineer'] as const;
export const PAC_PLATFORMS = ['forja'] as const;
export interface PacActorDescriptor { key: string; displayName: string; kind: 'agent' | 'platform'; ... }
```

`isPacAgent('forja')` is `false` and `describeActor('forja').kind === 'platform'`. This is executable
data, not prose, and it is what the §22 Forja test asserts. It also cross-checks the authoritative
`AGENTS.md`, whose `# Forja — Orchestration Platform` section states the same thing — a test asserts
that Mac's registry and the loaded document agree, so a future divergence is caught.

---

## 17. Schema changes (migration `0007_sprint32_company_context.sql`)

New tables:

* `company_context_revisions` (§8.1)
* `company_context_status` (singleton, §10)
* `company_context_proposals` (§16.1)

New columns:

* `settings.company_context_enabled`, `.company_context_allow_cached`,
  `.company_context_min_refresh_seconds`, `.company_context_max_stale_hours`
* `discovery_sessions.company_context_revision_id`
* `handoff_briefs.company_context_revision_id`
* `runs.company_context_revision_id`
* `agent_questions.company_context_revision_id`

New constraints and triggers:

* CHECK on `company_context_revisions.validation_state` and `.source`
* CHECK on `company_context_proposals.status`
* UNIQUE `(repository_url, commit_sha)` on revisions
* `company_context_status` singleton CHECK `id = 1`
* `BEFORE UPDATE` trigger on each of the four bound tables refusing to change a non-null
  `company_context_revision_id` (§8.2)
* FKs `ON DELETE RESTRICT` from all four bindings

Indexes: `revisions(commit_sha)`, `revisions(validation_state, loaded_at DESC)`,
`proposals(status, created_at DESC)`, `proposals(base_revision_id)`, and one per binding column.

`ENUM_CHECKS` in `db/schema.ts` gains the new enumerations so the existing "every enum column is
CHECK-constrained" test covers them automatically.

---

## 18. API changes

New route group `apps/server/src/http/routes/company-context.ts`:

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| GET | `/api/company-context/status` | viewer | repository, ref, version, SHA, refresh status, cached/stale, validation state, mandatory documents loaded |
| POST | `/api/company-context/refresh` | operator | force a refresh now |
| GET | `/api/company-context/revisions` | viewer | recent revisions |
| GET | `/api/company-context/revisions/:id` | viewer | one revision's full provenance |
| GET | `/api/company-context/revisions/:id/document` | viewer | read a document **at that revision** — how a historical run's governing policy is inspected |
| POST | `/api/company-context/selection` | operator | preview the selection for a task or free text |
| GET | `/api/company-context/proposals` | viewer | list, filterable by status |
| POST | `/api/company-context/proposals` | operator | create a proposal |
| PATCH | `/api/company-context/proposals/:id` | operator | move status; `accepted`/`rejected` require a human actor |

Existing DTOs extended: `RunDto`, `DiscoverySessionDto`, `BriefDto`, `AgentQuestionDto` and
`CodingRunDetailDto` each gain
`companyContext: { revisionId, commitSha, shortSha, contextVersion, ref } | null`.

`DashboardDto` gains a compact `companyContext` summary for the header indicator.

---

## 19. UI changes

Minimal, per brief §18. No document editor.

* **New page `CompanyContext.tsx`** (nav entry "PAC Context"): repository URL, active branch/ref,
  context version, full and short commit SHA, last successful refresh, current refresh status,
  cached/stale indicator, validation state, and the list of mandatory documents with byte size and
  load state. A **Refresh now** button for operators. Beneath it, the proposals list with status
  chips and a form to create one.
* **`PAC Context: 83ac4a0`** badge rendered on `RunDetail`, `CodingRun` and `Discovery`, linking to
  the revision so an operator can read exactly what governed that work.
* A one-line status indicator in the sidebar when the status is `cached`, `stale`, `invalid` or
  `unavailable` — an operator must not have to open a page to learn that Mac is running on
  week-old policy.

---

## 20. Audit events

Added to `AUDIT_EVENT_TYPES`:

```
company_context.refresh_started
company_context.refresh_succeeded
company_context.refresh_failed
company_context.loaded
company_context.cached_used
company_context.bound_to_discovery
company_context.bound_to_run
company_context.proposal_created
company_context.proposal_status_changed
company_context.validation_failed
```

(The brief's list, in the codebase's existing `namespace.event` convention, plus two the brief's
own requirements imply: a status change on a proposal is a governance decision, and a validation
failure is the event an operator needs when Mac refuses to work.)

Metadata carries SHA, context version, document *names* and counts, and failure reasons —
**never document content**, per brief §19. Refresh failures carry the redacted error only.

---

## 21. Security model

| Requirement (brief §20) | Mechanism |
| --- | --- |
| Mac runtime prefers read-only Git access | documented deployment: fine-grained PAT, `Contents: Read`; no write verb exists in the provider regardless |
| Claude Code must not receive Company write credentials | `MAC_COMPANY_` added to `REFUSED_SANDBOX_ENV`; the worker refuses to start if it is named |
| project code must not receive Company credentials | the token is read only by `apps/server/src/config.ts`; the worker's schema does not declare it |
| secrets must not be written into Company context | Mac cannot write Company context at all; additionally, proposal bodies are scanned for secret-shaped strings before persistence and refused with `COMPANY_PROPOSAL_SECRET_SUSPECTED` |
| fetch failures must not expose Git credentials in logs | single `redactGitError()` funnel (§4.2); a dedicated secret-hygiene test asserts a sentinel token never appears in audit metadata, status, or API errors |
| content trusted only after validation | a revision is usable only at `validation_state = 'valid'`; `selectCompanyContext` refuses an invalid revision |
| agent-generated text cannot mutate the checkout | no write verb; cache dir never mounted; sandbox conformance already proves unmounted paths are unreachable |

One further consideration, not in the brief but real: **the Company repository is trusted input, and
trusted input is still input.** Document text flows into prompts. It is bounded (§15 budget),
rendered with document/heading attribution, and never given precedence over the hard guardrails in
code (§11.2) — so a hypothetical hostile edit to `AUTHORITY.md` could confuse a prompt but could not
grant an autonomous deployment.

---

## 22. Test plan

All Sprint 1–3.1 tests must stay green. New tests, mapped to brief §21:

**Manifest** (`tests/unit/company-manifest.test.ts`)
valid manifest loads · malformed YAML fails · unsupported schema version fails · missing mandatory
key fails · duplicate mandatory entry fails · unsafe path (`../`, absolute) fails · unknown
future-compatible fields survive round-trip · empty mandatory list fails.

**Git provider** (`tests/integration/company-context-git.test.ts`, local temp repositories)
first clone/load · refresh with unchanged remote (no new revision row) · new remote commit detected
and loaded · failed remote fetch with valid cache → cached, exact SHA retained · failed fetch with
no cache → `unavailable`, operations fail · `allow_cached = false` → failure rather than cache ·
missing mandatory file in the remote → load fails and records `invalid` · reading a document at an
*older* SHA still works after the remote moves on.

**Provenance** (`tests/integration/company-context-provenance.test.ts`)
commit SHA recorded · context version recorded · discovery binds the SHA · run binds the SHA ·
handoff brief identifies the revision (in DTO and in rendered markdown) · an old run retains its old
SHA after the Company repo advances · the immutability trigger refuses a direct UPDATE of a bound
revision id · supervised answers bind the run's revision, not the newer active one.

**Precedence** (`tests/unit/context-precedence.test.ts`)
task cannot override no-live-deployment · task cannot grant spending authority · task cannot grant
external communication authority · a manifest claiming `agents_may_approve_changes: true` still
cannot make Mac approve · project context may refine a non-prohibited Company default · absence of
any statement denies.

**Availability** (`tests/integration/company-context-availability.test.ts`)
discovery receives company context (and the investigation records `company_context` as a consulted
source) · supervision receives it and the answer carries `company_policy` evidence with the SHA in
the ref · handoff generation retrieves relevant sections · core is present even when the task text
matches nothing · `AUTHORITY.md` cannot be selected away by any query.

**Governance** (`tests/integration/company-context-governance.test.ts`)
no code path writes the authoritative checkout (the provider exposes no write method; the mirror's
refs are unchanged after a full discovery + run + proposal cycle) · proposal creation works and
records provenance · a system actor cannot accept a proposal · recording project learned knowledge
creates no proposal and no revision · a proposal body containing a secret-shaped string is refused.

**Forja** (`tests/unit/agent-registry.test.ts`)
`isPacAgent('forja') === false` · `describeActor('forja').kind === 'platform'` · every entry in
`PAC_AGENTS` is `kind: 'agent'` · the registry agrees with the loaded `AGENTS.md` (integration).

**Secret hygiene** (extends `tests/integration/secret-hygiene.test.ts`)
a sentinel company token never appears in audit metadata, the status endpoint, or an API error,
including on a forced fetch failure.

**Real GitHub** (`tests/integration/company-live.test.ts`, opt-in, skipped without
`MAC_COMPANY_CONTEXT_TOKEN` or `MAC_RUN_COMPANY_LIVE_TESTS`)
authenticates · fetches · loads the manifest · loads all seven mandatory documents · records the
commit SHA · asserts read-only. Standard CI never depends on it.

---

## 23. Assumptions

* **A-1** `company_context_enabled` defaults to **false**, matching the Sprint 3 idiom for every
  external integration. The PAC deployment sets it true. Without this, all Sprint 1–3.1 tests would
  need a Company repository to run, which would be a worse system.
* **A-2** The Git provider reads through a **bare mirror**; there is no working checkout. "Local
  checkout/cache" in brief §5 is satisfied by a cache.
* **A-3** `README.md` exists in the Company repository but is not manifest-mandatory, so Mac does
  not require it. The manifest is authoritative.
* **A-4** The `refresh.check_before_new_project` flag is honoured as "before a new discovery session
  or a new run", since Sprint 3.2 has no Project Registry (brief §23).
* **A-5** `precedence` in the manifest is validated and recorded but the executable ladder lives in
  code (§11.2), because a document cannot be permitted to grant itself authority. The two agree
  today; a test asserts the manifest's ladder is compatible with the code's.
* **A-6** The "explicit audited context transition" of brief §9 is not implemented; a run's binding
  is absolutely immutable in 3.2. Adding a transition later means adding an operation and a trigger
  exemption, both auditable.
* **A-7** Document content is not stored in Postgres; it is re-read from the mirror at the pinned
  SHA. Attribution of a historical run therefore depends on the mirror still holding that commit.
* **A-8** Proposal `accepted` means "a human agreed"; it does not create a commit. Brief §16 leaves
  the merge workflow to a person.

---

## 24. Risks

* **R-1 — the mirror is the only copy of history.** If the cache directory is deleted, old commits
  are re-fetchable from GitHub only while they remain reachable. *Mitigation:* SHA, context version,
  manifest hash, document set hash and document metadata are all in Postgres, so a run stays
  attributable even if the text is temporarily unreadable; the API reports a cache miss for a bound
  revision rather than silently substituting.
* **R-2 — selection omits a section that mattered.** *Mitigation:* `AUTHORITY.md` is never
  selectable-away; the selection result reports what was dropped; the budget is deliberately
  generous.
* **R-3 — a refresh mid-night-shift changes context between runs of the same shift.** This is
  permitted (each run pins its own revision) but could produce two runs in one shift under different
  policy. *Mitigation:* `min_refresh_seconds` plus per-run SHA in the morning report, so the
  divergence is visible rather than hidden. Pinning per-shift is deferred.
* **R-4 — token scope drift.** A deployment could hand Mac a write-capable token. *Mitigation:* the
  provider has no write verb, so a write-capable token grants nothing; documented as read-only.
* **R-5 — YAML dependency surface.** `yaml` is a new dependency in the control plane.
  *Mitigation:* parsing is confined to `manifest.ts`, input is a bounded file from a trusted
  repository, and the parse is wrapped so a throw becomes `COMPANY_MANIFEST_MALFORMED`.
* **R-6 — Windows/Linux askpass divergence.** The helper script differs by platform.
  *Mitigation:* generated at refresh time for the current platform, exercised on both, and the
  fallback (no token) is anonymous access, which works for a public repository and fails clearly for
  a private one.

---

## 25. Implementation order

1. protocol: enums, evidence kind, DTOs, audit events, `company-context.ts` schemas
2. domain: `company-context.ts`, `context-precedence.ts`, `agent-registry.ts` (+ unit tests)
3. migration `0007`, schema, `ENUM_CHECKS`
4. provider interface + Git provider + manifest validation (+ tests against temp repos)
5. loader, status, service (startup + `ensureCurrentRevision`) (+ tests)
6. selection (+ tests)
7. bindings: discovery, briefs, runs, coding runs, night shift, supervision (+ provenance tests)
8. investigation seventh source class (+ availability tests)
9. brief rendering + coding-agent prompt
10. proposals + governance (+ tests)
11. API routes, web UI
12. secret hygiene, worker refusal list
13. opt-in live test against `PacTechnologiesAus/Company`
14. full suite, typechecks, completion report

---

## 26. Design self-review against the Sprint 3.2 brief

| Brief § | Requirement | Where |
| --- | --- | --- |
| 1 | inspect first | §1; suite and typechecks run before writing this |
| 2 | design document | this file |
| 3 | dedicated provider abstraction, replaceable, Git first | §3 |
| 4 | configurable URL, PAC default, no hardcoded credentials, read-only | §4 |
| 5 | controlled checkout outside coding workspaces, protected | §5 |
| 6 | manifest read + validated, unknown fields tolerated, no guessed fallback | §6 |
| 7 | mandatory documents validated, clear failure, validation state recorded | §7 |
| 8 | provenance fields; bound to discovery, runs, briefs, supervision; historical attribution | §8 |
| 9 | startup + pre-task refresh; no mid-run change; active runs pinned | §9, §8.2 |
| 10 | deliberate cached mode, marked, exact SHA, last refresh time, fail when nothing valid | §10 |
| 11 | precedence ladder; hard prohibitions unoverridable; specific may refine | §11 |
| 12 | discovery has company context; provenance retained | §12 |
| 13 | supervision evidence source; distinguishes kinds; document + SHA; model cannot override | §13 |
| 14 | selective inclusion in briefs, not the whole repository | §14 |
| 15 | core vs task-relevant; hard authority deterministically available | §15 |
| 16 | proposals, not writes; full field set; statuses; human-only approval | §16 |
| 17 | no automatic learning into company policy | §16.3 |
| 18 | minimal UI: status area + per-run badge, no editor | §19 |
| 19 | audit events; no unnecessary content logging | §20 |
| 20 | security requirements | §21 |
| 21 | test set | §22 |
| 22 | opt-in real GitHub test, read-only, CI-independent | §22 |
| 23 | no scope expansion | §0 |
| 24 | definition of done | addressed by §§3–21; verified in the completion report |

Two places where this design is deliberately *stricter* than the brief:

* brief §9 permits an "explicit audited context transition" for an active run; this design forbids
  it outright in 3.2 and enforces the pin with a database trigger (A-6). Adding the transition later
  is a smaller change than recovering from a run whose governing policy silently moved.
* brief §16 requires that Mac not directly approve; this design also makes the approval *verb*
  nonexistent at the provider, so the guarantee does not rest on a status check.

One place where it is deliberately more permissive: the control plane does **not** refuse to start
when the Company repository is unreachable (§9.1), because an operator needs the UI to diagnose
that. Context-dependent operations still fail.
