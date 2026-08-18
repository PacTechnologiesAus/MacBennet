# Sprint 3.1 — Handover

**For:** whoever picks this up next
**Branch:** `sprint-3.1/integration-commissioning` (finished by the Sprint 3.1 closure commit)
**Default branch:** `main` untouched, still at `0fa4ed0`
**Written:** 2026-08-17, mid-sprint, because the machine ended up in a state I should not fix by guessing.

Read `docs/sprint-3.1-commissioning-report.md` for the findings in full. This document is the
operational picture: what is done, what is blocked, what to do next, and the things that cost me
hours so they cost you none.

## Final Linux commissioning update — 2026-08-18

This block is authoritative and supersedes the older continuation and historical next-step sections
below.

- The Oracle Cloud instance is **Ubuntu 24.04.4 LTS** (despite originally being described as Oracle
  Linux), with PostgreSQL 16.14, Node 22.23.2, Bubblewrap 0.9.0 and 4 GB swap.
- Authenticated Claude Code 2.1.233 ran successfully **inside Bubblewrap** with only its own
  read-only credential mounted at the sandbox `$HOME`.
- Bubblewrap conformance is **18/18**, the 16 Bash git-shim checks execute on Linux, and real
  cancellation completes promptly.
- The final commissioning shift is `e0745e85-9648-40d4-88f8-abb2ffb46d58`. It ran from
  02:49:20–02:59:19 UTC, completed A and C, routed B's missing finance decision through Mac as
  `coding_session.blocked`, created no B pull request, continued to C, ended cleanly and produced
  exactly one morning report.
- Independent reconciliation completed **before** the standard-suite reset. It found nothing to
  explain: all 15 monday writes were delivered and monday's own activity log was non-empty; GitHub
  PR [#11](https://github.com/KasperPac/mac-commissioning-sprint-3-1/pull/11) matched Mac's record;
  `origin/main` still had one commit; and exactly one report delivery existed.
- Final Linux standard suites: server **567 passed, 52 skipped**; worker **216 passed, 3 skipped**.
  All four workspace typechecks pass. The server suite still prints two known non-failing warnings: a
  missing `await` in `worker-plane.test.ts:295` and pg's concurrent-query deprecation.
- Defects #16–#24 were found and fixed during Linux commissioning and final email commissioning: portable shell exit semantics,
  production cancellation wiring, sandbox credential discovery, safe parsing of Git `-C` plus two
  read-only Claude inspections, provider-5xx recoverability, three reconciliation defects, and a
  decision request delivered in Claude's `result` being mistaken for completion, and an email outbox
  race that allowed concurrent sweepers to send the same row twice.
- Microsoft Graph email is now **fully commissioned**. The mailbox is
  `mac.bennet@pac-technologies.com.au`; the Entra service principal has Exchange Online
  `Application Mail.Send` scoped only to that mailbox. Authentication passed and Graph returned 202
  for a controlled morning-report send, and Kasper confirmed the messages arrived in Outlook with
  the visible sender name **Mac Bennet**.
- The first full live-mail attempt exposed stale fixtures and the real concurrent-sweeper defect. It
  submitted five test messages instead of the two promised by the test comment. No further live sends
  were made until the delivery row was protected by an atomic compare-and-swap claim. The focused
  non-sending suite then passed 31/31 on Windows and Linux, including three concurrent sweepers, and
  one final controlled Graph send passed.

The implementation and report were committed only after the final Linux server and worker suites,
all four workspace typechecks, the scoped Graph send, and human Outlook verification were green. Do
not repeat the historical Docker/WSL recovery steps below.

## Continuation update — 2026-08-17 23:15 AEST

This block supersedes the stale operational state in §§2–6 below. Keep the earlier detail as history,
but do not repeat its Docker recovery steps.

### Current state

- Docker Desktop was recovered without a factory reset or data deletion. `mac-bennett-db` is healthy.
- Defect #7 is proven against real Claude Code: the adapter settles on `result`; the run no longer
  waits for the idle timeout.
- Defect #8 is proven: Docker conformance is 18/18 and no Mac sandbox containers remain afterwards.
- A real night completed Task A and Task C twice, updated monday, ran real repository tests and opened
  PRs. The latest immutable shift id is `0f861e39-0663-4faa-93c3-8e2b7360c8fb`.
- The work found seven further application/policy defects: duplicate terminal events, Windows npm
  spawning, read-only Git false positives, oversized completion summaries, duplicate approval audit
  semantics, provider-error credential redaction, and Claude plugin-clone false positives. All have
  fixes and regressions; the final plugin-clone change still needs a real-agent rerun.
- Full server suite: **564 passed**, 53 opt-in tests skipped.
- Worker on Windows: **197 passed**. The remaining 15 failures are all `git-shim.test.ts` because this
  host has no general WSL distro with `/bin/bash`; the error is
  `execvpe(/bin/bash) failed: No such file or directory`.
- All four workspace typechecks pass.
- The Oracle Linux VM now exists and is the next execution environment.

### Important correction to the original Task B expectation

Task B never reached the real agent. Its conversational brief scored 0.58, below the immutable 0.60
execution floor, so every night safely skipped it. The fixture now states the known scope and
must-not-change constraints without supplying the missing finance rounding decision. The
commissioning test now requires a real `coding_session.blocked`, no Task B PR, and continuation to
Task C. This strengthened path is unverified until the VM run.

### Do next, in this order

1. Clone or copy this branch and its uncommitted changes to the Oracle Linux VM.
2. Install/configure Node 20+, Git, GitHub CLI, PostgreSQL 16 and bubblewrap.
3. Configure a mountable Claude credential on the VM. Do not paste credentials into chat or commit
   them.
4. Run the full standard suite. The 16 Bash git-shim tests should execute normally there.
5. Run authenticated real Claude inside bubblewrap and the sandbox conformance suite.
6. Run the strengthened commissioning night. It must exercise A, block B safely, continue to C,
   produce no false Git violations, and finish its final assertions.
7. Before any standard suite resets test rows, independently verify monday/GitHub and run
   `scripts/commissioning/reconcile.mjs`.
8. Finish the final evidence matrix. Email remains blocked by the missing Entra application.

Do not commit the current working tree merely to make transfer convenient. The report and code are
intentionally still uncommitted until the Linux proof closes the remaining claims.

---

## 1. What this sprint is

Not a feature sprint. The objective is to move Sprint 3 from *"the integrations should work"* to
*"the integrations have been exercised successfully against the real external systems"* — and to say
plainly, per the brief's §17 evidence levels, where that did not happen.

**Do not add features. Do not start Sprint 4.** The brief's §19 lists what is explicitly out of
scope.

The single most important rule in this sprint: **never describe simulated behaviour as proven.** If
something could not be exercised, it is marked `BLOCKED — EXTERNAL CONFIGURATION REQUIRED` with the
exact configuration needed.

---

## 2. State at a glance

| Area | State |
|---|---|
| monday.com integration | **Proven.** 37 checks against the real API |
| Real Claude Code, unsandboxed | **Proven.** Opt-in test passed, 367 s |
| Real Claude Code, *inside* the sandbox | **Proven on Ubuntu with Bubblewrap.** |
| Sandbox containment | **Proven.** 18/18 Bubblewrap conformance plus authenticated real Claude |
| Email / Microsoft Graph | **Fully proven.** Scoped mailbox auth, Graph acceptance, Outlook receipt and sender name `Mac Bennet` confirmed |
| Full commissioning night | **Proven.** Final shift and formal reconciliation both exited 0 |
| Standard suite | Linux server **567 passed**; worker **216 passed**; all workspace typechecks pass |
| Defects found | 24. All fixed with regressions and proportionate real evidence |

---

## 3. Closure changes

The original three paths expanded into the focused fixes and regressions captured by the Sprint 3.1
closure commit. Use the final Linux commissioning block above as the authoritative verification
state.

| File | What it is | Verified? |
|---|---|---|
| `apps/worker/src/coding/claude-code-adapter.ts` | **Defect #7/#9 fix.** Settle on `result` and emit exactly one terminal outcome | **Verified against real Claude Code** |
| `apps/worker/src/sandbox/docker.ts` | **Defect #8 fix.** `docker rm --force` instead of `docker kill` when a session closes | **Verified against real Docker; 18/18 and no leaked containers** |
| `docs/sprint-3.1-commissioning-report.md` | The report | Records the completed Linux, cross-system and real-email evidence |

They were committed only after the final verification listed above.

---

## 4. Historical Docker incident — resolved

**Be honest with the user about this if it comes up. I was not careful enough.**

Docker Desktop and PostgreSQL are healthy again. No factory reset or data deletion was used. The
following is retained as incident history, not as the machine's current state.

How it got there, in order:

1. Mac's Docker sandbox provider leaked containers in `Created` state — `--rm` only reaps a container
   that has *run*, and `docker kill` fails on one that never started, with the failure swallowed by a
   `.catch()`. Twenty-two accumulated over the day. **This is a real defect (#8) and the fix is in the
   then-uncommitted `docker.ts`.**
2. Each leaked container held a bind mount to a test temp directory that had since been deleted, so
   `docker rm -f` on them hung. The daemon degraded until `docker run alpine echo` took >90 s.
3. I asked the user, got approval to restart Docker Desktop, and then **restarted it badly**: I killed
   the Docker Desktop and backend processes and ran `wsl --shutdown` while it was mid-shutdown.
4. I then relaunched and waited three times, which is repetition rather than diagnosis. The user
   stopped me, correctly.

I also misread `wsl -l -v` as hanging when in fact WSL emits UTF-16 and my shell pipe (`tr -d '\0'`)
had eaten the output. **Do not conclude WSL is broken from that.** Run it through PowerShell.

**What I recommend:** let the user restart Docker Desktop from the tray icon, or use
*Troubleshoot → Reset to factory defaults* if that fails. It is thirty seconds for them and a
guessing game for you. Do not kill Docker processes by hand.

**If the user would rather not:** you do not need Docker specifically — you need *a* PostgreSQL 16 on
`localhost:5433` with the credentials in `.env`. Any instance will do. Only the sandbox conformance
suite genuinely needs Docker, and it already passed today (18/18) with the credential tests included.

---

## 5. The eight defects

| # | Defect | Status |
|---|---|---|
| 1 | Opt-in tests could not see the repository-root `.env`, so a correctly configured machine reported it could not run | **Fixed, verified.** `setupFiles` in both vitest projects, regression test asserts every `.env` key reaches `process.env` (keys only, never values) |
| 2 | `(client as any).changeColumn(board, item, dueDateColumnId, …)` would have moved a customer's deadline past the guard. TypeScript `private` is erased; the raw `query` escape hatch and the API token were reachable the same way | **Fixed, verified.** All three are ECMAScript `#` members now |
| 3 | No authenticated coding agent had ever run inside the sandbox — `extraEnv` and `credentialMounts` existed in the plan and were wired to nothing | **Fixed, verified.** Wired with `REFUSED_SANDBOX_ENV` guarding it; 4 new conformance tests prove the credential arrives and nobody else's does |
| 4 | The agent could not run tests or commit, and never had. `--permission-mode acceptEdits` permits edits and nothing else, and a `-p` session cannot answer a prompt | **Fixed, verified.** Permission now follows containment. Watched the real agent run `npm test` and `git commit` afterwards |
| 5 | A mistyped tooling or credential path became an empty Docker volume and an agent that could not log in | **Fixed, verified** |
| 6 | A coding run that is working but quiet is indistinguishable from a hung one — 36 log lines for 15 minutes of real work | **Fixed, verified.** 5-second heartbeat flushes events and moves `updated_at` |
| 7 | **A successful coding session is recorded as a failure.** The CLI does not exit after `result` in stream-json input mode, so the adapter waited out the full idle timeout and logged `Coding-agent session stalled` | **Fixed and verified against the real CLI** |
| 8 | The Docker sandbox leaks containers in `Created` state | **Fixed and verified against real Docker** |

Defect #7 deserves a note: it survived Sprint 2 because the opt-in real-Claude test asserts
`expect(['completed', 'failed']).toContain(result.state)` — which accepts the bug as a pass. If you
touch that test, tighten it.

---

## 6. Historical next steps — superseded by the continuation block

1. **Get PostgreSQL back** (see §4). Nothing else can proceed without it.
2. **Re-run the commissioning night.** It is the centrepiece (§11 of the brief) and has never
   completed. It is also the only way to verify defect #7's fix.
3. **Read the result honestly.** Four attempts have each been stopped by a different real defect. A
   fifth finding is likelier than a clean pass, and finding it is the point of the sprint.
4. **Once the night completes:** human verification (§12), run `reconcile.mjs` (§13), re-run the full
   standard suite, and finish report sections 11–16.
5. **Re-run the sandbox conformance suite** once Docker is back, to verify defect #8.

---

## 7. Commands

```bash
# Standard suite. No credentials, no external services. This must stay green.
npm test

# The commissioning night — the centrepiece. 20–60 minutes.
cd apps/server && MAC_COMMISSIONING_NIGHT=1 \
  MAC_MONDAY_TEST_BOARD_ID=5102345434 \
  MAC_COMMISSIONING_REPO=https://github.com/KasperPac/mac-commissioning-sprint-3-1.git \
  npx vitest run tests/e2e/commissioning-night.e2e.test.ts

# Real monday.com — 37 checks. Safe to run any time the night is NOT running.
cd apps/server && MAC_MONDAY_LIVE_TEST=1 \
  MAC_MONDAY_TEST_BOARD_ID=5102345434 \
  MAC_MONDAY_UNAPPROVED_BOARD_ID=5102345613 \
  npx vitest run tests/integration/monday-commissioning.live.test.ts

# Real Claude Code, unsandboxed. ~6 minutes, real subscription usage.
MAC_E2E_REAL_CLAUDE=1 npm run test -w @mac/worker

# Sandbox containment against a real provider. Needs Docker.
npm run test -w @mac/worker -- tests/sandbox-conformance.test.ts

# Reconcile a night against every external system.
node scripts/commissioning/reconcile.mjs --test-db \
  --board 5102345434 \
  --repo KasperPac/mac-commissioning-sprint-3-1 \
  --clone /path/to/a/clone
```

`MONDAY_API_TOKEN` is already in the gitignored root `.env` and is picked up automatically.

---

## 8. The commissioning fixtures

**monday board** — `Mac Commissioning (Sprint 3.1)`, id `5102345434`, workspace *Software Automation*.
Disposable. A second board `5102345613` exists **only** to prove Mac cannot read from an unapproved
board; leave it unmapped.

Column ids are generated and **nothing is canonical** — `color_mm6axkch` is Status, not `status`.
Resolve them by title from the live board. The commissioning tests already do.

| | Item id | Priority | Flag | Role |
|---|---|---|---|---|
| Task A | `3165731590` | Critical | ✓ | should complete |
| Task B | `3165771857` | High | ✓ | contains a decision nobody has made |
| Task C | `3165731305` | Medium | ✓ | should complete after B |
| Task D | `3165772177` | Critical | ✗ | **control.** Highest priority, wrong group, unflagged. If Mac ever touches it, the eligibility predicate is wrong |

**Repository** — `KasperPac/mac-commissioning-sprint-3-1`, private and disposable. A small Node
project (`shiftlog`) with a passing test suite. Task B's ambiguity is genuine: `invoiceTotal` sums
floats and the finance system's rounding rule is written down nowhere.

The night test resets the board in `beforeAll`, so it is re-runnable. Verify that independently
through the monday MCP connection rather than through Mac's own client — different transport,
better evidence.

---

## 9. Traps that cost me time

- **One suite at a time against the test database.** The night e2e, the integration tests and the
  server suite all truncate it. Running two concurrently corrupts both.
- **Do not run the monday commissioning suite while a night is in flight.** It writes to Task A.
- **`waitForRun` must exceed the agent's idle timeout.** The idle budget is the operator's
  `maxAgentMinutes` (default **60**). Commissioning sets it to 20. A wait shorter than that reports a
  stall that has not happened.
- **A quiet coding session is not a stalled one.** Fixed by the heartbeat, but if you see a run whose
  `updated_at` is moving and whose logs are not, check `run_logs` before concluding anything.
- **vitest buffers output until a file finishes.** For a long e2e, watch the database, not stdout.
- **The host runs AVG Antivirus, which TLS-intercepts everything.** Any container needing the network
  must trust the local root — `scripts/commissioning/ca/` (gitignored) and
  `Dockerfile.mac-agent` handle it. This broke an image build with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`
  and would break the agent's own API calls.
- **Windows paths and colon-separated lists.** `splitPaths` in `apps/worker/src/config.ts` is
  drive-letter aware for this reason; do not simplify it.
- **`wsl -l -v` emits UTF-16.** Read it through PowerShell, not a bash pipe, or you will conclude WSL
  is broken when it is not. I did.

---

## 10. What is blocked, and exactly what would unblock it

**Real Claude Code inside the sandbox.** The subscription credential on Windows is held by the
operating system, not in a mountable file; mounting `~/.claude/.credentials.json` with
`CLAUDE_CONFIG_DIR` (and with `.claude.json` beside it) still yields `Not logged in`. Either:

```
ANTHROPIC_API_KEY=sk-ant-…
MAC_SANDBOX_AGENT_ENV=ANTHROPIC_API_KEY
MAC_SANDBOX_IMAGE=mac-agent:commissioning
```

or run commissioning on the Linux VM, where the credential is a real file and
`MAC_SANDBOX_CREDENTIALS` works as designed. **The VM is the better option** — it is also the only
place bubblewrap can finally be exercised, which Sprint 3 left unproven.

The user has chosen the VM. Do not spend more time trying to make this work on Windows.

**Email.** Configured on 2026-08-18. The current identifiers and secret are held only in the VM's
gitignored `.env`; never copy the secret into chat or source control. Exchange Online Application
RBAC grants `Application Mail.Send` only for `mac.bennet@pac-technologies.com.au`. The exact setup
and verification steps are in `docs/integration-setup.md` §2.

**Mac's monday identity.** There is no `Mac Bennett` user in the account, so his writes are
attributed to whoever minted the token — during commissioning, Kasper Simonsen. This cannot be fixed
in code and the brief says explicitly not to fake it. Giving Mac a seat is a commercial decision.
A test asserts the *absence* of that user, so the day a seat is created the test fails and somebody
has to come and update the claim.

---

## 11. Two things to hold on to

**Evidence levels are the product.** Sprint 3's report said containment was proven and coding work
was safe. Both were true of the *boundary* and neither had ever been exercised with an authenticated
agent behind it. Four of the eight defects were of that shape: not wrong code, but a claim standing
on evidence that did not reach as far as the claim did. When you write section 11–16, keep asking
what was actually observed.

**The best evidence in this sprint came from the agent complaining.** Defect #4 was found because the
real Claude Code session wrote:

> `npm test` … `git add -A` and `git commit` all come back "This command requires approval" … the
> tests have not been run, and nothing is committed. I've reviewed the diff by eye and it's
> consistent … but eyeballing is not the same as a green suite, and I'm not going to claim it is.

No fake would ever have said that. Run the real thing, read what it says, and believe it.
