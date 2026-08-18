# Sprint 3.1 — Commissioning Report

**Branch:** `sprint-3.1/integration-commissioning`
**Default branch:** untouched — `main` is still at the specification commit (`0fa4ed0`)
**Purpose:** move Sprint 3 from *the integrations should work* to *the integrations have been
exercised successfully against the real external systems* — and say plainly where that did not happen.

---

## 1. The short version

monday.com is **commissioned**. Mac authenticates against the real API, reads a real board with real
generated column ids, performs all five of his permitted writes, and is structurally incapable of the
prohibited ones. Thirty-seven checks against the live API prove it.

Real Claude Code **works**, and commissioning found the reason it had never actually worked properly:
the agent could not run a single command, so it could not run tests, could not commit, and could not
practise six of the seven steps of the discipline its own brief demanded. That is fixed.

The **sandbox** contains what it claims to contain — eighteen tests against Bubblewrap — and an
authenticated real Claude session has now edited, tested and committed inside that boundary. Linux
commissioning also found and fixed credential discovery: the read-only credential must appear at the
sandbox's own `$HOME/.claude/.credentials.json`, not merely at an arbitrary host path.

Microsoft Graph email is **fully commissioned**. The dedicated Entra service principal has
Exchange Online `Application Mail.Send` scoped only to `mac.bennet@pac-technologies.com.au`.
Authentication passed, Graph accepted a controlled morning-report request with HTTP 202, and Kasper
confirmed the messages arrived in Outlook with the human-visible sender name **Mac Bennet**.

Twenty-four defects were found. All twenty-four now have fixes and regression coverage. The final
Linux commissioning night is green, including authenticated Claude inside Bubblewrap, the real Task B
blocker path, continuation to Task C, one pull request and one morning report. The completed shift was
then reconciled independently against monday, Git, GitHub and the delivery table before the standard
suite reset any transient rows.

---

## 2. Environment used

| | |
|---|---|
| Host | Oracle Cloud VM, Ubuntu 24.04.4 LTS, Node 22.23.2, 2 vCPU, 954 MiB RAM + 4 GB swap |
| Database | PostgreSQL 16.14, separate `mac_bennett` and `mac_bennett_test` databases |
| Coding agent | Claude Code CLI **2.1.233**, subscription auth (`max`) |
| Sandbox | Bubblewrap 0.9.0 with Ubuntu's packaged AppArmor user-namespace profile |
| monday.com | `pac-technologies-company`, standard tier, 5 active members |
| GitHub | GitHub CLI, authenticated as `KasperPac` on the VM |
| Mailbox | `mac.bennet@pac-technologies.com.au`, Microsoft Graph client credentials with mailbox-scoped Exchange RBAC |

### A finding about the host itself

The machine runs **AVG Antivirus, which terminates and re-signs every HTTPS connection** with a
locally generated root CA (`NODE_EXTRA_CA_CERTS=C:\ProgramData\AVG\Antivirus\wscert.pem`, and npm
configured with `strict-ssl=false`). The host trusts it; a container does not.

This is not a curiosity. It broke the sandbox image build with
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, and it would equally break the agent's own calls to
`api.anthropic.com` from inside a container. Any sandbox image on this network needs that root
installed. `scripts/commissioning/Dockerfile.mac-agent` does it; `scripts/commissioning/ca/` is
gitignored, because those certificates are machine-local and committing one would be committing a
statement about somebody's laptop.

---

## 3. Integrations configured

| Integration | Configured | Credential location | Evidence level |
|---|---|---|---|
| monday.com | yes | `MONDAY_API_TOKEN` in the gitignored root `.env` | **Proven** |
| Claude Code CLI | yes | read-only credential mounted at sandbox `$HOME/.claude/.credentials.json` | **Proven inside Bubblewrap** |
| GitHub | yes | `gh` keyring | **Proven** |
| Execution sandbox | yes (Bubblewrap) | n/a | **Proven with an authenticated real agent** |
| Microsoft Graph mailbox | yes | gitignored VM `.env` | **Authentication, API submission, human receipt and sender identity proven** |
| bubblewrap | yes | — | **Proven** |

No credential is committed. `.env` is gitignored, and a regression test asserts that every key in it
reaches the test process — **keys only, never values**, so the test itself cannot leak one.

---

## 4. Test board and repository

**Board:** `Mac Commissioning (Sprint 3.1)`, board id `5102345434`, in the *Software Automation*
workspace. Created for this and disposable. A second board, `Mac Commissioning — Unapproved Board`
(`5102345613`), exists solely so "Mac cannot take work from a board nobody approved" can be
demonstrated rather than asserted.

Two groups: **Night Shift Queue**, which Mac is mapped to, and **Not For Mac**, which he is not.

Four items:

| | Item | Priority | Night-shift flag | Purpose |
|---|---|---|---|---|
| A | Add a `--json` flag to the summarise command | Critical | ✓ | Should complete |
| B | Round invoice totals to match the finance system | High | ✓ | Contains a decision nobody has made |
| C | Reject negative durations with a clear error | Medium | ✓ | Should complete after B |
| D | **NOT for Mac** | Critical | ✗ | Control. Highest priority, wrong group, unflagged |

Task D is the load-bearing one. It is the most attractive item on the board by every ordering rule
Mac uses, and it is the first thing he would take if the eligibility predicate were wrong.

**Repository:** `KasperPac/mac-commissioning-sprint-3-1` — a private, disposable Node project
(`shiftlog`, a timesheet summariser) with a passing five-test suite. Task B's ambiguity is real:
`invoiceTotal` sums floats, and which rounding rule the finance system uses is genuinely not written
down anywhere in the repository, the brief, or the item.

---

## 5. Commissioning procedure

1. Read the spec, the Sprint 3 design and completion report; inspect the existing opt-in tests.
2. Run the full standard suite to establish a baseline on a clean tree.
3. Branch `sprint-3.1/integration-commissioning` off `sprint-3/operational-night-shift`.
4. Build an isolated monday.com board and an unapproved sibling, through a separate transport
   (the monday MCP server, authenticated as a human) so the verifier and the system under test never
   share a code path.
5. Exercise monday.com: authentication, reads, mapping, the five writes, the prohibitions, scoping.
6. Re-run the real Claude Code test under the Sprint 3 architecture.
7. Attempt an authenticated agent *inside* the sandbox; record precisely why it cannot be done here.
8. Audit credential isolation, and add regression tests for what commissioning revealed.
9. Run a controlled night with real monday.com, real Claude Code, real git and real pull requests.
10. Verify the result from the human side, through monday.com's own UI data and GitHub, not through
    Mac's records.
11. Reconcile Mac's audit trail against every external system.

---

## 6. monday.com — results

### 6.1 Authentication and reads (§3.1–3.9) — **Proven**

| Capability | Result |
|---|---|
| Authenticate | ✓ resolves to a real user |
| Read an approved board | ✓ |
| Read groups | ✓ |
| Read items | ✓ |
| Read relevant column values | ✓ every mapped column present on the item payload |
| Identify priority | ✓ |
| Identify status | ✓ |
| Identify assignee | ✓ |
| Identify due date **without modifying it** | ✓ read before, exercised the full read path, read after, unchanged |
| Read the item's update feed | ✓ |
| Filter by group | ✓ an unmapped group's items are not visible as work |

### 6.2 The five writes (§3.10–3.16) — **Proven**

| Capability | Result |
|---|---|
| Assign an eligible item to Mac | ✓ the people column holds his id afterwards |
| Set status to In Progress | ✓ read back from the board |
| Post a meaningful internal update | ✓ read back through the update feed |
| Post a blocker | ✓ |
| Attach a pull request | ✓ the link column holds the URL |
| Move to Ready for Review | ✓ |
| Mark Complete **only where permitted** | ✓ refused by the guard with `completion_not_permitted` by default; succeeds against the real board when a board opts in |

### 6.3 Prohibited operations (§4) — **Proven, structurally**

Mac has no method that could change a due date or a priority, delete an item or a board, restructure
a board, move an item, or modify a user. This is asserted against the client's **own runtime shape**,
and the full set of public write methods is exactly four: `assignToMac`, `setStatus`, `postUpdate`,
`setPullRequestLink`.

The second, independent guard was exercised against **this board's real generated column ids**: an
attempt on the due-date column is refused as `column_is_due_date` *by name*, priority as
`column_is_priority`, every other column on the board as `column_not_writable`, and every column on
an unapproved board as `board_not_approved`.

**Demonstrated vs inferred.** Destructive operations were *not* fired at the real API. That is
deliberate and it is the stronger evidence, not the weaker: "Mac cannot delete an item" is a property
of the interface, and firing `delete_item` at monday would demonstrate something about the token's
permissions rather than about Mac. What *is* demonstrated against the live API is that the four
permitted writes land; what is demonstrated structurally is that no fifth exists.

**One honest caveat, recorded because Sprint 3 claims it:** the restriction is in the query, not in
the token. A test asserts that the raw token *can* see the unapproved board, so nobody reads the
scoping claim as "the credential is scoped".

### 6.4 Mapping against a real board (§6) — **Proven, and it mattered**

monday generated the column ids. Not one is canonical:

```
Status  color_mm6axkch     Owner   multiple_person_mm6atd5q
Priority color_mm6a7h81    Due date date_mm6arc88
Pull Request link_mm6acy56  Night Shift boolean_mm6aqx0j
```

The pre-existing opt-in test defaults `MAC_MONDAY_TEST_STATUS_COLUMN` to `status`, which exists on no
real board. The commissioning test resolves every column from the live board **by title** and asserts
`columnIds.status !== 'status'`, so the assumption cannot creep back.

An unknown status label is refused by monday with a **GraphQL error inside an HTTP 200** — which is
exactly why the client inspects the `errors` array rather than the status code. The failure is loud
and correctly classified as non-retryable: retrying a refusal would be retrying a decision.

### 6.5 Identity (§5) — **Proven, and the answer is "not yet"**

`list_users` on the real account returns five active members: Kasper Simonsen, Cesar, Kim Simonsen,
Matt, Michael Thornton. **There is no Mac Bennett.**

Consequently, during commissioning:

- Mac's updates were attributed to **Kasper Simonsen** — verified independently through the monday
  MCP transport, which reports `creator: {id: 61829416, name: "Kasper Simonsen"}` on the update Mac's
  own client posted;
- "assign to Mac" resolved to Kasper's user id, because that is who the token authenticates as.

| | Mac as a service identity | Mac as a human-style user |
|---|---|---|
| Today | this is what exists — an API token belonging to a person | does not exist |
| Updates attributed to | the token's owner | would be Mac |
| Can be a person-column value | no | yes |

**This is not something the application can fix, and Sprint 3.1's brief is explicit that it must not
be faked.** monday attributes ordinary API writes to the token's owner, and a person column can only
hold real users.

**Recommendation.** Give Mac a monday.com seat (`mac.bennet@pac-technologies.com.au`), mint the
token from his profile, set `MAC_MONDAY_USER_ID`. That is a commercial decision — it consumes a seat
— not a technical one, and no code change is required. A monday **app** with OAuth would let updates
be attributed to an app rather than a person, but it does not solve assignment and it replaces a
five-method surface with an unbounded one; it should not be adopted as a side effect of wanting a
better avatar. **No architectural change is recommended before that decision is made.**

The commissioning test asserts the *absence* of a Mac Bennett user, so the day a seat is created the
test fails and somebody has to come and update this claim.

---

## 7. Real Claude Code — results

### 7.1 Under the Sprint 3 architecture — **Proven**

The opt-in real-Claude test was re-run on the current branch and passed in 367 s: the adapter's argv
is accepted by CLI 2.1.233, the real event stream parses into Mac's neutral events, usage is captured
and classified as `estimated` with the "NOT money billed" note, the git shim is on the agent's PATH,
and `main` did not move.

### 7.2 Inside the sandbox — **Proven on Linux**

Ubuntu provided the mountable subscription credential Windows could not. The plan now recognises a
Claude credential and mounts it read-only at the sandbox's own
`$HOME/.claude/.credentials.json`. The real CLI authenticated inside Bubblewrap, edited a disposable
worktree, ran the repository tests and committed. The same session could not see the monday token,
mail credentials, worker state file or any other host secret.

The opt-in contained real-Claude test passed in 28.3 s, Bubblewrap conformance passed 18/18, and the
final commissioning night repeated the authenticated boundary three times. The earlier Windows
failure remains useful history: a Windows subscription session is held by the operating system and
cannot be copied as a mountable credential file.

---

## 8. Email — **API-SUBMISSION PROVEN; HUMAN RECEIPT PENDING**

The mailbox `mac.bennet@pac-technologies.com.au`, Entra application and client credential were
configured on the Ubuntu VM. Exchange Online Application RBAC grants the service principal only
`Application Mail.Send` over that mailbox; `Test-ServicePrincipalAuthorization` returned `InScope:
True`. No organisation-wide Entra `Mail.Send` grant was added.

The live commissioning path authenticated with client credentials and Microsoft Graph accepted a
morning report with HTTP 202. The delivery row became `sent`, its attempt count remained one, the
attempt and delivery audit events were present, and `providerMessageId` was correctly recorded as
`null` because Graph returns no message id. This proves authentication, sender endpoint selection,
API submission, persistence and audit. Kasper subsequently confirmed downstream receipt in Outlook
and the visible sender name **Mac Bennet**.

Commissioning also exposed defect #24. The original live harness had stale foreign-key fixtures and
ran every delivery-safety test against the real provider. Once those fixtures were corrected, three
concurrent sweepers selected the same pending row and two reached Graph. The first corrected full
attempt therefore submitted five test messages rather than the two promised by its comment. Live
sends stopped immediately. The production delivery path now claims a row with an atomic
status/attempt compare-and-swap before calling the provider. A new standard regression runs three
sweepers concurrently and observes exactly one fake-provider send.

After the fix, the focused non-sending suite passed **31/31** on Windows and Linux, server
type-checking passed on both, and a single controlled real morning-report test passed. The live file
now uses Graph only for the two tests explicitly intended to submit real mail; all idempotency and
race checks use the fake provider.

Full setup and rotation steps are in `docs/integration-setup.md`.

---

## 9. Defects found

| # | Symptom | Root cause | Class | Fixed |
|---|---|---|---|---|
| 1 | The opt-in monday test reported it could not run, on a machine where the token was configured exactly where the documentation says to put it | Only `src/config.ts` loads `.env`, and the opt-in tests deliberately import almost nothing | configuration | ✓ |
| 2 | `(client as any).changeColumn(board, item, dueDateColumnId, …)` would have moved a customer's deadline, past the guard | TypeScript `private` is erased; the method sat on the prototype. The raw `query` escape hatch and the API token were reachable the same way | **security** | ✓ |
| 3 | No authenticated coding agent had ever run inside the sandbox | `extraEnv` and `credentialMounts` existed in the plan and were wired to nothing; the sandbox environment is built from empty | **application defect** | ✓ |
| 4 | The agent could not run tests, could not commit, and reported a blocker no human could clear | `--permission-mode acceptEdits` permits edits and nothing else, and a `-p` session cannot answer a prompt | **application defect** | ✓ |
| 5 | A mistyped tooling or credential path became an empty Docker volume and an agent that could not log in | No existence check on operator mounts | robustness | ✓ |
| 6 | A working but quiet coding run looked stalled | Agent events were flushed only when new output arrived | observability | ✓ |
| 7 | A successful coding session waited for the idle timeout and was recorded as stalled | Stream-JSON emits a terminal `result` but keeps the process alive for another input message | **application defect** | ✓ real CLI |
| 8 | Docker sandbox containers accumulated in `Created` state | Cleanup used `docker kill`; a container that never started can only be removed | resource leak | ✓ real Docker |
| 9 | One real session emitted both `coding_session.completed` and `coding_session.failed` | Terminating the CLI after `result` caused a Windows `close` event with a null exit code to manufacture a second terminal outcome | audit integrity | ✓ real CLI + regression |
| 10 | Repository tests failed with `spawn npm ENOENT` on Windows | `npm` is a `.cmd` shim and cannot be spawned directly with `shell: false` | portability | ✓ real night |
| 11 | Claude's read-only Git inspection created security incidents and made clean work unreviewable | The policy rejected the CLI's exact `core.hooksPath=/dev/null` read-only forms | policy false positive | ✓ real night |
| 12 | A successful reviewed run opened a PR and then remained at 88% forever | The agent summary exceeded the completion protocol's 2,000-character limit; the server rejected the final report | **application defect** | ✓ real night |
| 13 | A machine-selected run was audited as both `run.auto_approved` and human-style `run.approved` | The night path recorded an auto-approval and then reused the human transition event name | **authority/audit defect** | ✓ real night + regression |
| 14 | A hostile monday error body could echo the API token into the durable outbox and audit trail | Provider response text was persisted without redacting the credential known to the client | **security** | ✓ hostile-response regression |
| 15 | Claude's plugin loader produced three prohibited-Git incidents | The exact hardened `core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes` clone form was classified as a redirect attempt | policy false positive | ✓ real contained rerun |
| 16 | Bubblewrap's read-only redirection check failed only on Ubuntu | The test required shell exit code 1, but Ubuntu `/bin/sh` correctly reports another non-zero code for the same refused write | portability | ✓ Linux conformance |
| 17 | Cancelling a real Claude run took almost two minutes | The adapter exposed `context.signal` but never subscribed to its abort event; the fake test also called `adapter.cancel()` and masked the missing production path | **application defect** | ✓ real CLI cancellation + regression |
| 18 | A mounted Claude subscription credential was not discovered inside Bubblewrap | The file was mounted read-only at its host path while the sandbox has a temporary `$HOME`; Claude looks in `$HOME/.claude/.credentials.json` | configuration/application defect | ✓ authenticated contained CLI |
| 19 | Claude's `git -C … ls-files` and `worktree list` inspections were false security incidents; write-capable `-C` was also misparsed | The policy skipped `-C` but not its directory argument, so the directory became the apparent subcommand | **policy/security defect** | ✓ real night + 65 policy regressions |
| 20 | Claude API 500 results were recorded as permanently non-recoverable | Result errors were emitted with `recoverable: false` regardless of provider status | resilience/audit accuracy | ✓ adapter regression |
| 21 | Formal reconciliation crashed before reading the audit trail | It queried `audit_events.created_at`; the append-only table's timestamp column is `ts` | evidence-tool defect | ✓ real reconciliation |
| 22 | Reconciliation reported the remote HEAD alias as a rogue branch and attributed every historical PR to one shift | Git formats the symref as `origin` on this host, and `gh pr list` was not filtered by shift start time | evidence-tool defect | ✓ repeated real reconciliation |
| 23 | Claude explicitly asked for the missing finance decision, but Task B was recorded as completed | The CLI placed the decision request in its stream-json `result`; the adapter treated every successful result as terminal instead of routing question-shaped results through Mac | **application/audit defect** | ✓ real Task B blocker + regression |
| 24 | Concurrent email sweepers submitted the same morning report twice | Each sweeper selected the pending row and then performed an unconditional `sending` update, so every contender reached Graph | **application/idempotency defect** | ✓ atomic claim + 31/31 focused suite + controlled Graph send |

Two smaller things fixed alongside: the mount-list separator split unconditionally on colon, cutting
every Windows path in half at the drive letter; and `GraphMailProvider` held its client secret and
live bearer token in TypeScript-private fields, one `JSON.stringify` from a log line.

### Defect 4 in the agent's own words

This is the one worth quoting, because no fake could ever have produced it:

> `npm test`, `npm run test`, `node --test test/`, `node test/summarise.test.js`, `git add -A` and
> `git commit` all come back "This command requires approval", including with the sandbox override.
> Only read-only calls (`git status`, `git diff`, `git log`, `node --version`) go through. This
> session is non-interactive, so I can't clear the prompt from here.
>
> So: **the tests have not been run, and nothing is committed.** I've reviewed the diff by eye and
> it's consistent — I found and fixed one bad expectation of my own along the way (I'd written the
> fixture total as $427.50; it's $442.50) — but eyeballing is not the same as a green suite, and I'm
> not going to claim it is.

Latent since Sprint 2. It survived because the opt-in real-Claude test asks for a file to be
**created** — which an edit can do — and never asserted a commit. Mac then answered that blocker with
an 11 %-confidence assumption assembled from brief fragments, which is the confidence model behaving
as designed on a question that should never have been asked.

### The fix, and why it is not a weakened boundary

The permission mode now follows the containment the run actually has:

- **contained** → `bypassPermissions`, because the mount namespace is a stronger control than a
  prompt nobody is present to answer;
- **uncontained** → `acceptEdits`, and the brief tells the agent it is edit-only rather than
  demanding discipline it cannot practise.

Containment is now what *buys* the agent the ability to work, which is the right relationship between
the two. A development override exists for hosts that cannot run a sandbox; it is off by default and
the run log says in as many words that the agent can reach anything the worker can.

---

## 10. Security findings

1. **TypeScript `private` is not a boundary** (defect 2). Three credential-bearing or
   capability-bearing members were reachable by a cast. Now `#`, enforced by the runtime. If any
   further provider is added, its secrets should be `#` from the first commit.
2. **An uncontained real agent reaches the home directory.** During the first commissioning run —
   deliberately unsandboxed — the agent read `C:\Users\kaspe\.claude\settings.json`. Nothing was
   exfiltrated and `acceptEdits` still applied, but this is the containment argument made concrete
   rather than hypothetical, and it is the strongest argument in this report for the sandbox being
   mandatory on the VM.
3. **A contained agent necessarily holds a credential.** The boundary is "no *other* project and no
   *other* secret", not "no secrets". A plan that mounts one records it as `purpose: 'credential'`,
   which is what keeps that visible. Mac should hold **his own** provider credential — a dedicated
   Anthropic API key — rather than a human's subscription session.
4. **The forwarding allowance is the new sharp edge**, and is guarded: `REFUSED_SANDBOX_ENV` refuses
   the worker's enrollment token, the database URL, the monday token, the mailbox credentials, the
   GitHub tokens and anything sharing their prefixes, case-insensitively, and the worker refuses to
   start rather than starting with a hole.
5. **Everything Sprint 3 already listed still stands**: the Docker daemon is a trust boundary when
   Docker is used, `.git` is writable inside the sandbox, a compromised worker token
   still yields code execution, the monday token lives in the control plane's environment with no
   secret manager, and night-shift approval does not expire.

### Credential isolation (§14)

| Requirement | Result |
|---|---|
| monday credential not exposed to Claude Code | ✓ proven inside a real sandbox: `MONDAY_API_TOKEN` is absent from the session's environment |
| mailbox credential not exposed to Claude Code | ✓ same test, same session |
| worker credential not exposed to project code | ✓ the worker state file is unreachable from inside; `mac_wk_…` never appears |
| sandbox does not inherit unnecessary secrets | ✓ the environment is built from empty; only explicitly named variables arrive |
| logs do not contain secrets | ✓ a new standard-suite test injects a monday API error that **echoes the token back** and asserts it reaches neither the outbox row's error nor the audit trail |

---

## 11. The commissioning night

### What was actually observed

The real night now completes work instead of stalling at the coding-agent boundary. Two consecutive
shifts are the useful evidence:

| Shift | Result |
|---|---|
| `d8e56ca5-236e-42b9-a842-3f43fe9b0be3` | Task A and Task C both reached `completed`, ran their repository tests successfully, opened PRs [#2](https://github.com/KasperPac/mac-commissioning-sprint-3-1/pull/2) and [#3](https://github.com/KasperPac/mac-commissioning-sprint-3-1/pull/3), updated monday, and produced one morning report. The final assertion exposed that policy approval was also being mislabelled as human `run.approved`. |
| `0f861e39-0663-4faa-93c3-8e2b7360c8fb` | After the authority fix, both runs again reached `completed` and the audit contained `run.auto_approved` with no `run.approved`. Task C passed 8 tests and opened PR [#4](https://github.com/KasperPac/mac-commissioning-sprint-3-1/pull/4). Task A passed 11 tests, but self-review correctly withheld its PR because Claude's plugin loader triggered three policy false positives. |

The second shift ran from 12:46:31 to 12:53:21 UTC. Its immutable audit spine records:

- Task A: `coding_session.completed` → tests passed → self-review → run completed;
- Task C: `coding_session.completed` → tests passed → review satisfied → PR #4 → run completed;
- real monday assignment, In Progress and Ready for Review writes for both items;
- Task D untouched — it was the deliberately attractive unflagged control;
- one idempotent morning report through the fake mail provider;
- `origin/main` still one commit long, and every pushed branch under `origin/mac/`.

This proves defects 7, 9, 10, 11 and 12 against the real CLI and real external workflow. Defect 15
was then narrowed to three exact commands from Claude's plugin loader. The fix allows only this exact
hardening form and only for clone:

```
core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes
```

Modified forms, weakened host checking, and reuse for fetch remain prohibited. The policy suite is
65/65 green, and the final real contained night produced no false Git violation.

### Final contained Linux night

Shift `e0745e85-9648-40d4-88f8-abb2ffb46d58` ran from 02:49:20 to 02:59:19 UTC on Ubuntu and passed
the strengthened commissioning test. Its audit contains 140 events, including:

- three `sandbox.created` events for Bubblewrap and three authenticated real Claude sessions;
- Task A completed without a PR after self-review;
- Task B reached the real agent, which explicitly asked whether finance rounds each line or the final
  total; Mac recorded `coding_session.blocked`, the night recorded the blocker, monday received the
  blocker, no Task B PR was created, and scheduling continued;
- Task C completed and created GitHub PR
  [#11](https://github.com/KasperPac/mac-commissioning-sprint-3-1/pull/11);
- one `night_shift.ended`, one `report.email_attempted` and one fake-provider delivery;
- no human-style `run.approved` event and no false Git-policy event.

The important final defect was not that Claude failed to recognise the missing rule. Its recorded
summary said plainly that it needed a decision and included a direct question. Claude Code delivered
that question in the turn's stream-json `result`; the adapter interpreted every successful `result`
as terminal. The adapter now routes question-shaped results through Mac, suppresses duplicates, keeps
stdin open for the answer and waits for the next result. A focused fake-CLI regression reproduces
that exact protocol shape.

## 12. Human-side verification

GitHub was read independently with `gh`, not through Mac's database. For the final shift, GitHub had
exactly one new PR: #11, from `mac/0dcd70c3-reject-negative-durations-with-a-clear-error` to `main`.
It matched Mac's pull-request row in both directions. Earlier open PRs and branches are disposable
artefacts from previous commissioning attempts; none is merged.

The final night read monday after every write and proved Task D remained Ready for Mac and unassigned.
The independent reconciliation then queried monday's own activity log: all 15 queued writes were
delivered and the provider log was non-empty for the shift window.

The final commissioning night still used `FakeMailProvider`, so that historical shift's delivery row
proves report generation, idempotency and bookkeeping only. A later controlled Graph commissioning
send was accepted with HTTP 202. Kasper confirmed receipt and the sender name **Mac Bennet** in
Outlook.

## 13. Reconciliation

Formal reconciliation ran **before** the standard suite reset the test database:

```text
node scripts/commissioning/reconcile.mjs --night e0745e85-9648-40d4-88f8-abb2ffb46d58 \
  --test-db --board 5102345434 \
  --repo KasperPac/mac-commissioning-sprint-3-1 --clone /tmp/mac-reconcile-failed
```

It exited 0 with “Nothing to explain.” Mac's 140-event audit, monday's activity log, the remote Git
history, GitHub PR #11 and the single report-delivery row agreed. `origin/main` remained the seeded
one-commit branch. Commissioning also repaired the reconciler itself: it now uses `audit_events.ts`,
ignores Git's formatted remote-HEAD alias, and scopes GitHub PRs to the selected shift rather than
comparing one shift with all historical PRs.

## 14. Evidence matrix

| Claim | Evidence | Level |
|---|---|---|
| Real monday authentication, reads, permitted writes and scoping | 37 live API checks | **Proven** |
| Real Claude Code can edit, test and commit | Authenticated contained run plus commissioning shift | **Proven inside Bubblewrap** |
| A real run settles on the CLI result and reaches `completed` | Two completed real shifts after the fix | **Proven** |
| Windows host can execute configured npm tests without a shell | Real night plus focused regression | **Proven** |
| Pull requests are opened only after review and never merged by Mac | Final shift PR #11 and immutable audit | **Proven** |
| Default branch remains unchanged | Remote read during each night | **Proven** |
| Bubblewrap containment and credential isolation | 18/18 conformance plus authenticated real Claude run | **Proven** |
| Machine approval is not recorded as human approval | Real audit finding, fix, integration regression, corrected shift audit | **Proven** |
| Provider error text cannot persist an echoed monday token | Hostile-response regression, 6/6 secret-hygiene suite | **Proven by adversarial simulation** |
| Exact Claude plugin clone/read-only inspection forms are safe without permitting writes | 65/65 policy tests and final real night | **Proven** |
| Task B blocks on the real missing finance decision and the night continues | `coding_session.blocked`, no B PR, Task C and shift completed | **Proven** |
| Authenticated Claude Code inside containment | Real credential mounted read-only at sandbox `$HOME`; real edit/test/commit | **Proven** |
| Formal cross-system reconciliation | Shift, monday, Git, GitHub, and report row; exit 0 | **Proven** |
| Real morning email submission | Scoped Entra/Exchange identity, Graph HTTP 202, persisted delivery and audit | **Proven to API acceptance** |
| Human receipt | Messages observed in Outlook by Kasper | **Proven** |
| Sender display name | `Mac Bennet`, observed in Outlook by Kasper | **Proven** |

## 15. Final standard-suite state

- Server on Linux: **567 passed**, 52 live opt-in tests skipped.
- Worker on Linux: **216 passed**, 3 real-Claude opt-in tests skipped.
- Bubblewrap conformance: **18/18**.
- Bash git shim: **16/16**.
- Git policy: **65/65**.
- Worker and server TypeScript checks pass; all four workspace typechecks passed earlier in the
  commissioning branch.
- Known non-failing server warnings remain: the missing `await` at
  `tests/integration/worker-plane.test.ts:295` and pg's concurrent-query deprecation.

No external commissioning work remains. The implementation and report are included in the Sprint
3.1 closure commit.

## 16. Final assessment

Sprint 3.1 has moved the core night-shift workflow from inferred to observed: real monday work was
selected, authenticated real Claude Code worked inside Bubblewrap, real repository tests ran, the
missing finance decision blocked safely without a PR, scheduling continued, a reviewed branch was
pushed, PR #11 opened, the shift ended and one report was recorded. Formal reconciliation agreed
across every checked system. The exercise found eighteen additional defects after the first five,
including policy, audit and evidence-tool failures that fake happy-path tests had missed.

All non-email commissioning claims are proven on Linux, and Microsoft Graph authentication and API
submission, human receipt and the visible sender identity are now proven.
