# Sprint 3.1 — Handover

**For:** whoever picks this up next
**Branch:** `sprint-3.1/integration-commissioning` (5 commits, plus uncommitted work — see §3)
**Default branch:** `main` untouched, still at `0fa4ed0`
**Written:** 2026-08-17, mid-sprint, because the machine ended up in a state I should not fix by guessing.

Read `docs/sprint-3.1-commissioning-report.md` for the findings in full. This document is the
operational picture: what is done, what is blocked, what to do next, and the things that cost me
hours so they cost you none.

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
| Real Claude Code, *inside* the sandbox | **Blocked.** Cannot be done from a Windows host |
| Sandbox containment | **Proven.** 18 conformance tests against real Docker, passed today |
| Email / Microsoft Graph | **Blocked.** No Entra app registration exists |
| Full commissioning night | **Not yet completed.** Four attempts, each stopped by a different real defect |
| Standard suite | 723 → **~760** passing. Worker verified at 210; server not re-run since the DB went down |
| Defects found | 8. Six fixed and committed, two fixed but unverified |

---

## 3. Uncommitted work — read this before you commit anything

Three uncommitted paths. All typecheck; two are **not yet verified against reality**.

| File | What it is | Verified? |
|---|---|---|
| `apps/worker/src/coding/claude-code-adapter.ts` | **Defect #7 fix.** Settle the session on the CLI's `result` message instead of waiting for the process to exit | Typechecks. All 18 adapter tests pass against the fake CLI. **Never exercised against real Claude Code.** This is the highest-value thing to verify |
| `apps/worker/src/sandbox/docker.ts` | **Defect #8 fix.** `docker rm --force` instead of `docker kill` when a session closes | Typechecks. **Not verified** — Docker is down |
| `docs/sprint-3.1-commissioning-report.md` | The report. Sections 1–10 written and accurate | Sections 11–16 (the night, human verification, reconciliation, evidence matrix, the final answer) are **not written**, because the night has not completed |

Commit them when you have verified them, not before.

---

## 4. The machine, and what I did to it

**Be honest with the user about this if it comes up. I was not careful enough.**

Docker Desktop will not start. `docker ps` returns `Docker Desktop is unable to start`; the backend
processes run, but the Linux VM never boots (`%LOCALAPPDATA%\Docker\log\vm\init.log` has had nothing
new since 09:45). PostgreSQL lived in Docker, so `TEST_DATABASE_URL` (`localhost:5433`) is
`ECONNREFUSED` and **no integration or e2e test can run**.

How it got there, in order:

1. Mac's Docker sandbox provider leaked containers in `Created` state — `--rm` only reaps a container
   that has *run*, and `docker kill` fails on one that never started, with the failure swallowed by a
   `.catch()`. Twenty-two accumulated over the day. **This is a real defect (#8) and the fix is in the
   uncommitted `docker.ts`.**
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
| 7 | **A successful coding session is recorded as a failure.** The CLI does not exit after `result` in stream-json input mode, so the adapter waited out the full idle timeout and logged `Coding-agent session stalled` | **Fixed, UNVERIFIED.** Uncommitted. This is the one that matters most |
| 8 | The Docker sandbox leaks containers in `Created` state | **Fixed, UNVERIFIED.** Uncommitted. Docker is down |

Defect #7 deserves a note: it survived Sprint 2 because the opt-in real-Claude test asserts
`expect(['completed', 'failed']).toContain(result.state)` — which accepts the bug as a pass. If you
touch that test, tighten it.

---

## 6. What to do next, in order

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

**Email.** No Entra app registration exists. The live suite is written and gated; the exact Azure
steps are in `docs/integration-setup.md` §2. The one that catches people: it needs the
**application** `Mail.Send` permission with admin consent, not the delegated one — the delegated
grant issues a token happily and then fails at `sendMail` with 403.

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
