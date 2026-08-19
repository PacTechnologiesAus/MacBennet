# Phase 4 — Human Interaction, Forja Orchestration, Acceptance Verification & Controlled Web Research

**Branch:** `phase-4/interaction-orchestration-research`
**Base:** `commissioning/oracle-linux-general-night` @ `3a90e81`
**Date:** 2026-08-19
**Governing document:** `Mac_Spec.md`
**Design:** `docs/phase-4-design.md`

Where this report and the design document disagree, this report wins. Where something was not
exercised, it says so and names what is missing rather than implying it passed. The rule inherited
from Sprint 3.1 governs every claim below: **never describe simulated behaviour as proven.**

---

## 0. Status at a glance

| Area | State |
|---|---|
| Persistent conversations, one thread across channels | Done — proven end to end across two real HTTP surfaces |
| Microsoft Teams inbound (verified JWT) | Done — implemented and tested against genuinely signed tokens |
| Microsoft Teams outbound (Bot Connector) | Done — **not exercised against Microsoft**; opt-in live test provided, credentials absent |
| Questions, blockers and approvals through conversation | Done, proven |
| Approval binding (ambiguity refused) | Done, proven |
| Authority boundary (spec §16) enforced on every channel | Done, proven |
| Cross-channel continuity | Done — Acceptance Case 3 |
| Forja contract and event stream | Done — Acceptance Case 4, driven by a test client |
| Forja is a platform, never an agent | Done, asserted by test |
| Web-search provider abstraction | Done — three real providers implemented, **none configured, nothing purchased** |
| External retrieval, provenance, source quality | Done, proven |
| Prompt-injection defence | Done, proven — structural, not merely detected |
| Acceptance criteria derived, frozen and verified | Done — Acceptance Case 1 |
| `completed_with_gaps` | Done — changes one existing coding behaviour, deliberately (§16) |
| Morning report names the shortfall | Done |
| UI: conversations, inbox, acceptance, sources, channel status | Done |
| Real Teams tenant commissioning | **NOT DONE** — no credentials in this environment |
| Real search provider commissioning | **NOT DONE** — requires a human commercial decision |
| Defects found by this phase | **11**, all fixed on this branch |

---

## 1. Architecture changes

Six changes, in the order they depend on one another.

```
   ┌─────────────────────────────────────────────────────────────┐
   │ 1. CONVERSATIONS   one persistent thread model, any channel │
   └───────────────┬─────────────────────────────────────────────┘
     ┌─────────────┼─────────────┬──────────────────┐
     ▼             ▼             ▼                  ▼
  2. TEAMS     3. APPROVALS   4. FORJA           7. STATUS
  a channel    bound, not     an app talking     answers from
  onto (1)     ambiguous      to (1)(3)(5)       data, not memory
                   │
                   ▼
              5. WEB RESEARCH ──────▶ 6. ACCEPTANCE VERIFICATION
```

**What was deliberately not done.** No second discovery system, no second approval system, no
second run lifecycle, no second scheduler, no message broker, and no rewrite of the Sprint 1–3.3
execution path. A coding run passes through the same thirteen eligibility checks, the same
confidence gates and the same git shim as before.

**Four authentication planes now, not two.** Human sessions, worker tokens, a Bot Framework JWT and
a Forja API key. Each is registered in its own Fastify scope with its own hook and a non-overlapping
prefix, so "a credential for one plane cannot authenticate a call on another" is a property of how
the routes are mounted rather than a convention. Asserted by test for the Forja plane.

---

## 2. Conversation model

A conversation belongs to **Mac**, not to a channel. Teams, the web UI, Forja and (later) voice
attach to the same thread.

| Table | Holds |
|---|---|
| `conversations` | thread identity: originating channel, project, task, external ref, Bot Connector service URL, company-context binding |
| `conversation_participants` | humans and external identities, by AAD object id where there is one |
| `conversation_messages` | every message both directions, with intent, evidence refs and delivery state |
| `conversation_summaries` | structured summaries, appended **alongside** source messages |

Three decisions worth recording.

**Delivery state lives on the message row, not in a separate outbox.** The mail outbox proved the
retry and idempotency pattern in Sprint 3.1; a second table holding a copy of the same text would
only create a way for the two to disagree about what was actually sent.

**Discovery is LINKED, not merged.** `discovery_sessions.conversation_id` joins the two. Rewriting
discovery to sit on top of conversations would have put the working half of Sprints 2 and 3.3 at
risk for a structural tidiness nobody asked for. What the link buys is that an answer given in Teams
reaches the same brief a web-UI answer would — proven by Acceptance Case 3.

**Retrieval is structured by SHAPE.** `ConversationContext` has no `transcript` field, so there is
nowhere for a full history to go, and the tail is bounded by a constant rather than a parameter a
caller could raise. What survives from before the tail is the structured summary plus four things
carried forward from **every** summary rather than the latest: decisions, corrections, project facts
and unresolved questions. A correction that is compressed away is a mistake that will be made again.

Summaries never modify a message. The module that writes them contains no statement that could.

---

## 3. Teams implementation

### 3.1 Inbound

One endpoint, `POST /api/teams/messages`, in its own authentication plane. Every activity is
verified against the Bot Framework's published signing keys before its body is read for anything but
its shape:

* `alg` checked against an allowlist **first** — `alg: none` and algorithm confusion are the two
  oldest JWT vulnerabilities;
* `aud` must equal Mac's own app id, compared in constant time — a validly-signed token issued for a
  *different* bot is signed by the same authority and would otherwise pass;
* issuer, `exp`, `nbf` with bounded skew;
* `serviceUrl` in the token must match the activity's, and must be a Bot Framework host;
* tenant must be PAC's.

Written with `node:crypto` and `fetch` — no new dependency in the trust path of a public endpoint.
The JWKS cache refreshes once on an unknown `kid`, so a Microsoft key rotation does not fail closed
until somebody restarts the process.

The endpoint answers 200 or 401 and never 5xx, because the Bot Framework retries on 5xx and a bug in
Mac would otherwise become a loop between Microsoft and this service.

### 3.2 Idempotency

Teams retries. `conversation_messages` has a unique index on `(channel, external_message_id)`, and
`handleInboundTurn` returns early on a duplicate. Proven by a test that posts the same activity three
times and asserts one message and one task.

### 3.3 Outbound

Bot Connector REST at the `serviceUrl` the **token** signed, with an AAD client-credentials token.
Every field holding a secret is an ECMAScript `#` member rather than a TypeScript `private` one —
the discipline commissioning established on the monday client, because TypeScript erases `private`
and an ordinary field appears in `Object.keys`, in a spread, and in anything that `JSON.stringify`s a
provider into a log line.

Delivery is retried by a sweeper and dead-lettered after six attempts.

### 3.4 What has NOT been exercised

**No message has been sent to a real Microsoft tenant.** No Azure Bot resource exists for this
work, no credentials are configured, and this environment has none. The offline suite signs its own
tokens with a locally generated RSA key and verifies them through the production code path, which
covers everything except whether Microsoft accepts the credential and whether a message arrives in
somebody's Teams client.

`tests/integration/teams-live.test.ts` exercises exactly that and skips loudly without credentials.
The setup checklist is `TEAMS_SETUP_REQUIREMENTS` in the protocol package and is repeated in
`.env.example`.

---

## 4. Identity model

Microsoft Teams provides **no mechanism** by which a third-party application can post as a human user
account. Applications post as bot identities. This is a platform constraint, not a configuration
choice.

Mac therefore appears as an application named **Mac Bennett**, and every substantive message is
signed `Mac Bennett · Automation Engineer · PAC Technologies`. Human attribution is deliberately not
simulated — a message that looks like it came from a colleague and did not is a lie told by the
system rather than by anybody in particular.

The limitation is typed data (`MAC_TEAMS_IDENTITY.limitation`), asserted by test, and displayed on
the Settings page — so an operator meets it before they assume otherwise.

Separately: an inbound sender's authority is read from `settings.teams_authorised_users`, matched on
**AAD object id** first and UPN second. Display names are never accepted, because a display name is
chosen by its owner and an authorisation list keyed on a value the subject controls is not an
authorisation list. Proven by a test that sends from an impostor calling themselves "Kasper".

---

## 5. Approval flow

`approvals` (Sprint 1) is unchanged and remains the record of an authorisation. Phase 4 adds
`approval_requests`: the addressable object that makes the binding rule enforceable.

**A bare affirmation binds to nothing, ever** — including when exactly one approval is outstanding.
The softening was considered and rejected because it is a race rather than a philosophy: the number
outstanding changes between Mac sending a card and a human reading it. Mac asks about A, a night
shift raises B, the human looking at a phone showing only A types "yes", and under any
count-dependent rule they have authorised something they never saw.

So a decision binds on an explicit code (`AP-4F2K`) or on a card action carrying the request id, and
otherwise Mac replies naming the outstanding codes. The refusal is a **reply**, not a silence:
somebody who typed "sounds good" and heard nothing would reasonably conclude they had approved it.

Codes use a 32-character alphabet without I, O, 0 or 1, are allocated with `randomInt`, and are
unique among pending rows only — they are an addressing scheme for open questions, not a permanent
identifier.

**Supersession.** Raising a request for a subject marks earlier pending requests for that subject
`superseded` with a pointer to the replacement. A stale card on somebody's phone then refuses by
name rather than authorising work nobody read.

**The authority boundary.** `authority_class` splits into five classes a conversation may authorise
and seven that spec §16 forbids outright. The check runs at **decision** time, not only at request
time, and applies to **every channel including the web UI** — spec §16 says Mac may not merge to a
protected branch or deploy to a live system; it does not say he may if asked through a nicer
interface. A refused attempt is audited under its own event type, because somebody trying to
authorise a production deployment by message is a security signal rather than a validation error.

A conversational approval routes into the same `approveRun` as the web UI: same confidence floor,
same band check, same guardrail refusals. `acceptBelowThreshold` cannot be set from a card — a card
has two buttons and neither of them is "and I accept that Mac is not confident about this".

---

## 6. Blocker flow

`run_blockers` is unchanged. When one is raised, Mac now tells a person — if the policy permits it
and there is a thread to say it in.

The policy is one table (`domain/notification-policy.ts`). Five triggers may reach somebody
unprompted: a blocker, a required approval, a question, a detected anomaly, a completed
**high-priority** run, and the morning report. Nine are recorded and never pushed, including run
started, run completed, stage changed, artefact created and heartbeat — and each of those carries a
sentence saying why.

**There is no configuration that makes routine progress proactive**, because there is no field for
it: a setting can only switch a permitted class *off*. Asserted by test.

A suppressed notification is audited. "Mac did not tell me" and "Mac was never asked to tell me"
look identical from outside, and the second is what somebody will assume when they missed something.

Notification does not fail the blocker: a blocker that could not be announced is still a blocker.

---

## 7. Cross-channel continuity

**Acceptance Case 3, proven end to end** (`tests/e2e/cross-channel.e2e.test.ts`).

A signed Teams activity creates a task and starts discovery. The web UI then:

* finds the Teams thread by task id;
* reads what was said in it;
* posts into the **same** conversation, which afterwards holds messages of both channels;
* asks a status question and gets an answer built from what Teams created;
* answers a discovery question that was **asked in Teams**, and the answer lands in the same brief.

The reason this holds is that both channels call one function, `handleInboundTurn`. They differ in
authentication and in how a reply is delivered, and in nothing else. If the web UI had its own
routing, "Mac knows what you told him in Teams" would depend on somebody implementing every
behaviour twice, and the second implementation would drift within a sprint.

---

## 8. Forja contract

**Acceptance Case 4, proven by a test client** (`tests/integration/forja.test.ts`). Forja itself was
not built.

* **Auth:** `forja_clients` with hashed API keys, explicit scopes (`read`, `write`, `approve`,
  `events`), revocable. The key and webhook secret are returned exactly once.
* **Contract:** deliberately narrower projections than the internal DTOs, stamped with
  `FORJA_CONTRACT_VERSION`. `tasks.user_initial_confidence` is **not** exposed — two numbers under
  one word is how the second quietly becomes the first, and a published contract is the worst place
  for that.
* **Coverage:** agents, projects, task, discovery, brief (with structured acceptance criteria and
  the scope note), runs, blockers, artefacts, approvals — create, request, decide.
* **Events:** an append-only `mac_events` table with a monotonic `seq`, read by cursor with optional
  long-poll. `seq` is the only cursor: two events written in the same millisecond have no order, and
  a consumer paging by timestamp will eventually skip one. No broker was introduced; Postgres
  already provides a durable ordered log the deployment backs up and monitors.
* **Webhooks:** HMAC-SHA256 over `${timestamp}.${body}`. The timestamp is inside the signed material
  so a captured delivery cannot be replayed later.

**Every write names a person.** `onBehalfOf` is mandatory and resolved against `users`; an unknown
address is refused rather than degraded to a system actor. "Forja approved it" is not an answer to
"who approved this?".

**Forja is never an agent.** `PAC_ACTORS` types it as a platform — "not an agent, not an employee,
and not an autonomous worker" in its own summary — `listAgents` filters on `kind === 'agent'`, and a
test asserts Forja never appears among the agents it orchestrates.

---

## 9. Web-research provider

`public_web_search` was a seam that refused. It is now a tool that works when configured and refuses
honestly when not — the Sprint 3.3 refusal wording is kept word for word, because "no provider is
configured" remains a genuinely different answer from "the web says nothing about this".

Three providers implemented against their real APIs, differing in the ways that make an abstraction
worth having (header key, query-string key, no key; three response envelopes; three error shapes):

| Provider | What a human must do | Account? | Payment? |
|---|---|---|---|
| `searxng` | Run a SearXNG instance PAC controls, JSON output enabled | No | **No** |
| `brave` | Brave Search API subscription key | Yes | **Yes** — payment method required even on the free tier |
| `google_cse` | Google Cloud API key + Programmable Search Engine id | Yes | **Yes** — billed above the free daily allowance |

**Nothing was purchased and no account was created.** Part E §16 says to stop at that point and
document the exact requirement, so the requirement is recorded as typed data
(`WEB_SEARCH_PROVIDER_REQUIREMENTS`) and shown on the Settings page next to the choice.

SearXNG is the one PAC can adopt without a commercial conversation, because it is a service PAC
hosts rather than a subscription. Pointing it at a public community instance would send PAC's
research queries to a stranger's server, and the setting says so.

**Three gates are unchanged from Sprint 3.3**: the deployment setting, the per-project
`external_research` capability, and an administrator's host allowlist with no redirect following.
One new gate is **off by default**: `allow_fetch_from_search_results`, which widens retrieval to
hosts a run's own search surfaced. It is a real widening and is stated as one — a poisoned result set
is a cheaper attack than compromising a host PAC already trusts.

**Provenance** moved out of the run-state JSON into `research_sources`: query, tool, ref, URL, title,
source class, external flag, bounded excerpt, publication date where the provider gave one, retrieval
timestamp, and an injection flag. That is what makes `external_sources_used = 0` answerable by a
predicate rather than by application code somebody could skip.

**Source quality** (§18) is classified deterministically into eight classes, with three counted as
primary. Lookalike domains are refused: `evil-siemens.com` does not inherit Siemens' authority, and a
vendor host is only *documentation* on a documentation path — a product landing page is marketing.

**Currency** (§19) is judged about the **question**, not the answer, across all eight categories the
brief names. A volatile question with no external source becomes an unmet acceptance criterion
rather than a confident sentence.

---

## 10. Research security

Four defences, in decreasing order of how much the design rests on them. It matters that a later
reader does not mistake the fourth for the first.

1. **Structural.** A web page cannot change Mac's authority because the protocol has no field in
   which an authority change could be expressed. It cannot cause a command to run because no
   protocol carries a command. It cannot approve anything because an approval requires a row, a
   person and a binding. It cannot alter the plan because the plan is built server-side from an
   approved brief and pinned before the first model call. It cannot reveal a credential because the
   object that reaches a model holds none.
2. **Scope.** Tools are an allowlist and their scope is resolved from the run row, not supplied by
   the model. There is no "search everything" to talk anybody into.
3. **Framing.** Retrieved text is wrapped in untrusted-content delimiters with an explicit preamble,
   and the delimiter sequence is stripped from the content so a page cannot close its own quotation.
4. **Detection.** Ten known injection shapes, recorded with the matched span. Trivially evadable by
   paraphrase; its real value is telling a **human** that a page tried something.

Detection **annotates and does not delete**. A vendor security advisory matches every pattern, and
discarding it would lose real evidence to defend against something the structure already prevents.
The audit event says so in terms, because "we flagged it" reads like "we blocked it".

The test feeds a page containing instruction override, role reassignment, an authority claim, a
credential request, a command, a forged delimiter and an exfiltration URL through the full retrieval
path, then asserts that settings are unchanged, no approval exists, the tool result has no field
through which any of it could have happened, and nothing credential-shaped appears anywhere in it.

---

## 11. Acceptance verification

Commissioning §13.3 recorded a task description naming three engineering briefs, a cross-system
architecture recommendation and a build order — and one artefact, reported as `completed`. Every
component behaved. There were **two** failures there, and they need different fixes:

**(a) The run was never checked against its brief.** Fixed by deriving machine-checkable criteria,
freezing them at approval, and checking them before completion.

**(b) The brief had already lost three of the five deliverables at discovery**, and the run then
followed it faithfully. No amount of checking the run against the brief would ever have caught this.
Fixed by `compareRequestToBrief`, which reads what the requester asked for and names what the brief
dropped, shown at approval time and in the Forja brief projection.

It does not block. Reducing five documents to one that covers the ground is often the right call.
What it must not be is invisible.

### The mechanism

Nine criterion kinds — artefact count, artefact type, named section, evidence class, source class,
external sources, test run, review step, semantic. Derived deterministically from the brief (never
invented: every criterion traces to a phrase somebody wrote), editable by a human, **frozen onto the
run at approval** so a later brief edit cannot move the bar in either direction.

**A model may FAIL a criterion and may never PASS one a count failed.** Semantic review runs only
over criteria marked `semantic`, whose verdicts start `indeterminate`; it never revisits a
deterministic result. A fluent explanation must not be able to talk its way past
"0 artefacts of type engineering_brief, 3 required".

**`indeterminate` reads as a gap, never as a pass.** A check that degrades to green the moment it
breaks is worse than no check.

**Heading matching is tolerant, not brittle.** Sections are matched against the document's own
headings, normalised for case, punctuation and articles — so "we did not establish a build order"
does not satisfy a "Build order" criterion, which a naive substring search would.

**One bounded remediation attempt**, before completion, while the worker still holds the lease and
the night has time in it. One, because a loop that retries until the criteria pass will eventually
produce something shaped like the criterion rather than something true.

### The states

`completed_with_gaps` is a terminal run status, not only a column on a side table. Every list,
filter, dashboard tile, report and monday mapping in this system reads `status`, and a distinction
they do not join to is one they will all report as success — which is exactly the failure this phase
exists to fix, one layer down.

A task whose run fell short goes back to `ready`, not `done`.

**Zero artefacts stays a failure**, not a gap. Commissioning established that distinction the
expensive way.

**Runs with no criteria are `not_assessed` and complete exactly as before** — which is every coding
run that existed before Phase 4.

---

## 12. Schema changes

Migration `0009_phase4_interaction.sql`. Additive; no column dropped, no table dropped, and the only
UPDATEs set new columns on rows that had no value.

| Object | Note |
|---|---|
| `conversations` | + company-context immutability trigger, matching runs and briefs |
| `conversation_participants` | |
| `conversation_messages` | unique `(channel, external_message_id)` — the webhook idempotency guarantee, in the database |
| `conversation_summaries` | append-only alongside source messages |
| `approval_requests` | code unique among **pending** rows; authority CHECK-constrained |
| `forja_clients` | hashed key, separate webhook secret so the two rotate independently |
| `mac_events` | append-only, trigger-enforced |
| `event_deliveries` | unique `(client_id, event_seq)` — the guard Sprint 3.1 defect 24 needed |
| `research_sources` | unique `(run_id, ref)`; index on `(run_id, external)` |
| `run_acceptance` | criteria frozen at approval, per-criterion results |
| `handoff_briefs.acceptance` | structured criteria alongside the free-text ones, which are unchanged |
| `runs.acceptance_state` | denormalised; backfilled `not_assessed` |
| `discovery_sessions.conversation_id` | the link, not a merge |
| `settings` | Teams, Forja, web search and acceptance — **every integration off** |
| `RUN_STATUSES` | `+ completed_with_gaps` |
| `STOP_REASONS` | `+ acceptance_gaps` |
| `AUDIT_EVENT_TYPES` | +33 |

**The migration enables nothing.** A deployment that runs it and changes nothing else behaves
precisely as it did the day before.

50 tables; 41 before.

---

## 13. UI changes

Minimal, per Part J — no redesign.

* **Conversations** — thread list plus reader/composer. The **channel is shown per message**, which
  is the fact the model exists to make visible.
* **Waiting on you** — the approval inbox. The code is prominent because it is the actionable part.
  A request for an authority nobody may grant appears with the refusal and **no buttons**.
* **Run detail** — acceptance criteria **above** the results (scrolling past five documents to
  discover two more were asked for is the reading order this phase fixes), and every retrieved
  source with its class, its query and its injection flag.
* **Settings** — Teams (connection state separate from the enabled checkbox, naming the specific
  missing configuration key), external search (each provider's exact human requirement), acceptance
  verification, Forja.

---

## 14. Tests and results

<!--TEST_RESULTS-->

New coverage:

| File | What it proves |
|---|---|
| `tests/unit/acceptance.test.ts` | criteria derivation, the narrowing check, deterministic evaluation, verdicts |
| `tests/unit/message-intent.test.ts` | intent classification, and that classification confers nothing |
| `tests/unit/approval-binding.test.ts` | binding, refusal, codes, the authority deny list |
| `tests/unit/web-research-domain.test.ts` | source quality, currency, injection detection, framing, provider requirements |
| `tests/unit/notification-policy.test.ts` | what may be pushed and what may never be |
| `tests/integration/conversations.test.ts` | threads, task creation, answers reaching the brief, approvals, retrieval |
| `tests/integration/teams.test.ts` | real signed JWTs, ten rejection classes, idempotency, card actions, authorisation |
| `tests/integration/forja.test.ts` | auth, scopes, `onBehalfOf`, the full contract, events, webhook signing |
| `tests/integration/web-research.test.ts` | search, retrieval, provenance, and the injection assertions |
| `tests/integration/acceptance.test.ts` | **Acceptance Case 1** |
| `tests/e2e/cross-channel.e2e.test.ts` | **Acceptance Cases 2 and 3** |
| `tests/integration/teams-live.test.ts` | opt-in real Microsoft; skips loudly |
| `apps/worker/tests/general-task.test.ts` | the acceptance review call and its bounds |

**Existing tests changed:** three, all for the same intended semantic change (`completed_with_gaps`),
plus the five stale worker tests that had been red on the base branch since commissioning changed the
empty-run contract without updating them. **No existing assertion was weakened.**

---

## 15. Real integration tests

| Integration | Exercised for real? |
|---|---|
| Bot Framework JWT verification | **Yes** — real RSA signatures through the production path |
| Microsoft tenant / Bot Connector send | **No** — no credentials in this environment. Opt-in test provided |
| Web search provider | **No** — requires a commercial decision. All three implemented, none configured |
| External document retrieval | Path proven with a stub provider; **no live host fetched** |
| Forja client | **Yes** — a test client through the real HTTP surface |
| Postgres, migrations, triggers | **Yes** — every test runs against real PostgreSQL |
| Reasoning model | Scripted provider. The real-model path is unchanged from commissioning |

---

## 16. Defects found

Eleven, all fixed on this branch. Five were found by tests written for something else, which is the
usual way.

| # | Defect | Severity | Found by |
|---|---|---|---|
| 1 | Five worker tests red on the base branch — commissioning changed the empty-run contract and did not update them | medium | Baseline run |
| 2 | `smba.trafficmanager.net` missing from the Teams service-host allowlist — **every genuine Teams message would have been rejected** | high | Teams integration test, using the real value |
| 3 | Status-request classifier read all six of Part G's phrasings as ordinary questions, because "what … ?" was counted twice | high | Unit test |
| 4 | Answers to Mac's own questions were dropped: the pending-question lookup filtered `status = 'open'`, but a session moves to `brief_drafted` the moment a brief exists | high | Conversation integration test |
| 5 | A task assignment started discovery and stopped — no question, no brief, no approval | high | Conversation integration test |
| 6 | The answer handler regenerated the brief from the transcript, discarding the field mapping the answer had just made — **the same question asked eight times** | high | Cross-channel acceptance case |
| 7 | A declarative answer opening "What we want is…" classified as a question and never reached the brief | medium | Cross-channel acceptance case |
| 8 | Forja scope gate was a synchronous Fastify hook — ten tests hung at exactly thirty seconds | medium | Forja contract test |
| 9 | Event types declared in the migration and almost none of them emitted | high | Forja event test |
| 10 | `acceptance.reviewed` fired on every noop run to say there was nothing to assess | low | Sprint 1 e2e, asserting an exact event sequence |
| 11 | Deliverable detection missed "a build-order recommendation" — only the spaced form matched | medium | Acceptance unit test |

Defects 2, 4, 5 and 6 would each have made the Teams channel useless in a way that would have taken
a long time to diagnose from the outside, and none of them would have been caught by anything short
of driving the real HTTP surface.

---

## 17. Security findings

* **No new credential reaches the worker.** The general assignment is still a task kind, an
  objective, a deliverables list and two ceilings. The acceptance review adds one call carrying a
  single boolean.
* **No credential reaches a model prompt.** Asserted by enumerating the tool result and grepping it
  for credential-shaped words.
* **Teams secrets are `#` private fields**, following the discipline commissioning established.
* **A rejected Teams activity is audited without its token** — logging it would put an
  attacker-supplied credential-shaped string into the trail.
* **Forja keys are stored hashed**, looked up by hash, and the plaintext exists for one response.
* **The authority deny list is enforced at decision time on every channel**, including the web UI.
* **Teams authorisation is keyed on AAD object id**, never on a display name.
* **`serviceUrl` is treated as a credential sink** — taken from the signed token, validated against
  a specific host allowlist, and re-validated at the point of use because that is the line that
  attaches Mac's bearer token to an outbound request.
* **No guardrail was weakened.** The `<0.60` floor, the autonomy band, the hard prohibitions, the
  git policy, the sandbox requirement and the company-context immutability triggers are untouched.

One judgement worth flagging for review: `allow_fetch_from_search_results` lets an administrator
widen retrieval to hosts a run's own search returned. It is **off by default** and every fetch is
still recorded with its host and source class, but it is a genuine widening and somebody should
decide about it deliberately rather than discover it.

---

## 18. Technical debt

1. **Conversation summarisation is not automatic.** The table, the schema, the retrieval path and
   the "carry forward from every summary" behaviour all exist and are tested, but nothing yet
   *generates* a summary when a thread passes `conversation_summary_threshold`. A long thread
   therefore relies on its 12-message tail. The setting exists and is unused.
2. **`public_web_search` has never contacted a search engine.** Three real implementations, a stub
   in the tests, and no live call. The first real query will find something, as the first real model
   call did at commissioning.
3. **The intent classifier is regex-based**, like the task classifier before it, and will keep
   meeting sentences it reads wrongly. Its mistakes are one message away from correction.
4. **Semantic acceptance criteria are never *derived*** — only human-authored ones exist. Everything
   Mac derives today is deterministic. The evaluation path, the model prompt and the
   pass/fail asymmetry are implemented and tested.
5. **Blocker notifications need an existing conversation.** A blocker on a task nobody has ever
   discussed is recorded and not announced, because Mac has no thread to speak in and does not start
   one unprompted.
6. **No webhook delivery sweeper.** `event_deliveries` rows are created and the signing function is
   implemented and tested; nothing yet POSTs them. Cursor polling works and is what the Forja test
   uses.
7. **Acceptance criteria are frozen at approval, and a run created without going through
   `approveRun`** (a night-shift policy approval takes that path; a directly-inserted row does not)
   **has none.** The deterministic backstop in `completeRun` then reports `not_assessed`.
8. **`countArtefacts` in the worker acceptance route parses a number out of an observed string.**
   It works and it is ugly.

---

## 19. Remaining gaps from `Mac_Spec.md`

Closed by this phase: §18 (Teams as a command and notification channel), §23.2 (Talk to Mac), most
of §7 (blocker notification), §27's proactive half.

Still open:

| Spec | Gap | Note |
|---|---|---|
| §22 | Voice / "Call Mac" | Designed at interface level only — `voice` is a channel value with nothing behind it. No voice code was written, per the phase brief |
| §20 | Otto handoff | Artefacts and conversations both exist to support it; nothing routes to Otto |
| §21 | OpenClaw / machine control | Future |
| §29.2 | Forja as a first-class engineering tool | Phase 4 built the interface Forja calls, not the tooling Mac would call in Forja |
| §30 | HubSpot | Future |
| §16.2 | "Allowed but must be reported" as an explicit permission class | Still implicit |
| §25 | Reasoning spend in **money** | Still tokens only; inventing a rate would be the estimate-as-exact §25 forbids |
| §9 | Automatic promotion of conversation facts into project memory | Conversation facts are carried forward within a thread, not promoted |

---

## 20. Recommended next development step

**Commission Teams against the real PAC tenant**, and nothing else until that is done.

Everything in Part A is implemented and tested offline, and exactly one class of thing remains
unknown: whether Microsoft accepts the credential and whether a message arrives. Commissioning at
3.1 and again on Oracle Linux both found defects that no offline test could have found — the 60-second
model ceiling, the truncated write-up, the fail2ban jail reading the wrong log — and defect 2 in this
phase is the same shape, caught only because a test used the real service host rather than a
plausible one.

Concretely, in order:

1. Register the Azure Bot resource, enable the Teams channel, install the app, set the four
   configuration values, and run `MAC_TEAMS_LIVE_TEST=1`.
2. Add the intended people to `teams_authorised_users` by AAD object id.
3. Drive Acceptance Case 2 by hand from a real Teams client against the real deployment.
4. Only then decide about a search provider — that is a commercial decision and it is independent.

The second priority is conversation summarisation (debt item 1), because it is the one piece of the
conversation model that is designed, tested at the retrieval end, and not yet doing anything.

---

## Does Mac now match the phase's own question?

> **Can Mac now be interacted with naturally as a persistent PAC employee through Teams and the web
> interface, receive and clarify work, obtain controlled approvals, perform evidence-backed external
> research, verify that approved acceptance criteria were actually satisfied, and expose the same
> persistent agent/work state to Forja?**

Taken clause by clause, because only some of it is proven.

**Interacted with as a persistent employee through Teams and the web interface — YES, architecturally
and end to end, but NOT against a real Microsoft tenant.** A signed Bot Framework activity creates a
task, starts discovery and asks a question; the web UI reads that thread, continues it, and answers
the question Teams asked. Both channels call one handler. What has not happened is a single message
travelling through Microsoft's infrastructure.

**Receive and clarify work — YES, proven.** Acceptance Case 2 goes instruction → discovery →
question → answer → brief → approval request → explicit approval, all through the Teams HTTP
surface. Four of this phase's eleven defects were found making that true.

**Obtain controlled approvals — YES, proven.** Binding refuses ambiguity, supersession refuses stale
cards, and spec §16's prohibitions are refused on every channel including the web UI.

**Perform evidence-backed external research — PARTIALLY.** The abstraction, three real provider
implementations, provenance, source quality, currency and the injection defence are all built and
tested. **No search has ever been performed against a live engine**, because none is configured and
adopting one is a commercial decision this phase was told not to make.

**Verify that approved acceptance criteria were actually satisfied — YES, proven.** Acceptance Case
1 reproduces the commissioning shortfall deliberately: a brief committing to three engineering
briefs, an architecture note and external research; a run delivering one document and no external
sources; a terminal state of `completed_with_gaps` with `external_sources_used = 0` recorded where an
operator reads it. Under the old code that run reported `completed`.

**Expose the same persistent state to Forja — YES, proven by a test client.** Task creation,
discovery, brief, approval, run status, artefacts and an event stream, with every write naming the
person it acted for, and Forja itself never appearing among the agents it orchestrates.

So: **yes for five of the six clauses, and honestly qualified for the sixth.** The two things
standing between this and an unreserved yes are both commissioning against a real third party, and
neither is an architectural limitation:

* a Microsoft tenant and an Azure Bot registration, which is a configuration task; and
* a search provider, which is a decision about money that belongs to a person at PAC.
