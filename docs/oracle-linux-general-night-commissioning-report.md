# Oracle Linux Commissioning — General Night Shift — Report

**Branch:** `commissioning/oracle-linux-general-night`
**Plan:** `docs/oracle-linux-general-night-commissioning.md`
**Target:** Oracle Cloud VM `mac-bennet-pc`, `161.33.80.88`, ap-melbourne-1
**Public name:** `mac.pac-technologies.com.au`
**Started:** 2026-08-18 22:53 UTC · **This revision:** 2026-08-19 02:25 UTC

Where this report and the plan disagree, this report wins. Where something was not exercised, it
says `BLOCKED` or `NOT EXERCISED` and names what is missing rather than implying it passed.

The single inherited rule from Sprint 3.1 governs every claim below: **never describe simulated
behaviour as proven.**

---

## 0. Status at a glance

| Area | State |
|---|---|
| Host, service user, systemd units | Done, observed |
| PostgreSQL, migrations 0001–0008, backups | Done, observed |
| Acceptance task migration (ids preserved) | Done, observed |
| Worker enrolment, heartbeat, rotation, reconnect | Done, observed |
| Bubblewrap containment | Done, 18/18 against the real provider |
| Company context | Done, 7/7 documents, `valid`, SHA `83ac4a0` |
| Test suites on the VM | Done — 805 server, 18 sandbox, 6 company-live, 37 monday-live |
| Secret leakage | Done — every credential clean across worktree and 43 commits |
| DNS, OCI ingress, public HTTP | Done, observed from off-host |
| TLS, HTTPS-only, HSTS, renewal | Done, observed |
| fail2ban login jail | Done, ban proven into nftables |
| Reasoning provider | **BLOCKED** — awaiting `ANTHROPIC_API_KEY` |
| Company credential least-privilege | **BLOCKED** — awaiting fine-grained PAT |
| Project night-shift approval | **AWAITING HUMAN** — control now exists, not clicked |
| Acceptance run | **NOT STARTED** — gated on the three rows above |

---

## 1. The machine, as commissioned

| | Observed |
|---|---|
| OS | Ubuntu 24.04.4 LTS, kernel `6.17.0-1018-oracle`, `x86_64` |
| Memory | 954 MiB RAM, 4 GiB swap |
| Node | v22.23.2 |
| PostgreSQL | 16.14, bound `127.0.0.1:5432` |
| nginx | 1.24.0, the only public listener |
| Bubblewrap | 0.9.0 |
| Claude Code | 2.1.233, credential at `/home/mac/.claude/.credentials.json` mode `0600` |
| certbot | 2.9.0 |
| fail2ban | 1.0.2 |

The brief called this machine Oracle Linux on ARM. It is neither. It is Ubuntu on x86_64, and the
plan recorded that before any change was made rather than inheriting the assumption.

### 1.1 Service user and layout

Services run as the unprivileged `mac` user (uid 1002), which has no sudo. `ubuntu` retains
passwordless sudo and runs nothing.

| Path | Owner | Mode |
|---|---|---|
| `/opt/mac-bennett` | `mac:mac` | `0755` |
| `/var/lib/mac-bennett` | `mac:mac` | `0750` |
| `/etc/mac-bennett/control-plane.env` | `root:mac` | `0640` |
| `/etc/mac-bennett/worker.env` | `root:mac` | `0640` |
| `/etc/mac-bennett/seed-admin-password` | `root:mac` | `0640` |
| `/home/mac/.claude/.credentials.json` | `mac:mac` | `0600` |

No secret is in the checkout. `dotenv` does not override the process environment, so systemd's
`EnvironmentFile` wins and no `.env` needs to exist under `/opt/mac-bennett` at all — the property
is structural, not a matter of discipline.

### 1.2 Units

`mac-control-plane.service` and `mac-worker.service`, both `Type=simple`, `Restart=on-failure`,
`User=mac`, journald logging, `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`, explicit
`ReadWritePaths`. Plus `mac-bennett-backup.timer`.

The worker unit deliberately does **not** load `control-plane.env`, and deliberately does **not**
set `RestrictNamespaces` — Bubblewrap needs an unprivileged user namespace, and restricting them
would silently disable the sandbox the worker is required to have. That is a comment in the unit
file, not folklore.

Observed: `systemctl is-active mac-control-plane mac-worker nginx postgresql fail2ban` → all
`active`.

---

## 2. Publishing Mac — DNS, TLS and the public surface

Two human-only actions unblocked this section and both were completed by the operator: an OCI
security-list ingress rule for TCP 80 and 443, and an A record
`mac.pac-technologies.com.au → 161.33.80.88`.

**DNS**, resolved independently from three places: Google `8.8.8.8`, Cloudflare `1.1.1.1`, and the
VM's own resolver. All three return `161.33.80.88`.

**Reachability**, from off-host: `http://mac.pac-technologies.com.au/` returned `200` before TLS was
configured, confirming the OCI security list *and* the VM's own iptables both permit the traffic.
The host firewall already carried explicit `ACCEPT` rules for `tcp dpt:80` and `tcp dpt:443` ahead
of the closing `REJECT`.

**Certificate**, issued by Let's Encrypt:

```
subject = CN = mac.pac-technologies.com.au
issuer  = C = US, O = Let's Encrypt, CN = YE1
notBefore = Aug 19 00:35:24 2026 GMT
notAfter  = Nov 17 00:35:23 2026 GMT
Verify return code: 0 (ok)
```

An external client outside this network fetched `https://mac.pac-technologies.com.au/api/health` and
received `{"ok":true,"service":"mac-bennett-control-plane"}`. That fetch validates the chain against
an ordinary trust store, so the certificate is confirmed publicly trusted rather than merely
present.

> **A note on one piece of evidence.** `openssl s_client` run from the commissioning laptop reports
> the issuer as *AVG Web/Mail Shield Root*, not Let's Encrypt. That laptop runs AVG, which
> intercepts TLS locally and re-signs it. It is a property of that laptop and not of the server, and
> it is why the certificate above was verified from the VM and from an independent external client
> instead. Recorded because a reader comparing outputs would otherwise reasonably conclude something
> was wrong.

**HTTPS-only.** nginx now serves three server blocks:

1. a `default_server` on both 80 and 443 that answers `444` — connection closed, no response — to
   any request whose `Host` is unrecognised, including a bare `https://161.33.80.88/`. The
   authentication plane is not served to something that merely scanned the address space;
2. plain HTTP on the real name, which does exactly two things: serve
   `/.well-known/acme-challenge/` for renewal, and `301` everything else to HTTPS;
3. HTTPS on the real name, which is where Mac lives.

Observed: `http://mac.pac-technologies.com.au/tasks` → `301` → `https://…/tasks` → `200`.

**TLS policy:** `TLSv1.2` and `TLSv1.3` only. Both were observed negotiating
(`ECDHE-ECDSA-AES256-GCM-SHA384` and `TLS_AES_256_GCM_SHA384`). TLS 1.0 and 1.1 could not be
observed being refused, because the OpenSSL 3 client on this host will not offer them at all
(`no protocols available` is a client-side error). Their refusal is therefore asserted from
configuration, not observed — stated plainly rather than claimed as proven.

**HSTS:** `max-age=31536000; includeSubDomains`, with `preload` deliberately omitted. Preloading
commits the whole `pac-technologies.com.au` domain and is a human decision, not a deploy step.

**Renewal** is proven, not assumed. `certbot renew --dry-run` succeeds. Three changes were needed to
get there and all three are recorded in §6.

**Cookie:** the session cookie is issued `Secure` and `HttpOnly`, observed on a real login over TLS.
`Secure` comes from `NODE_ENV=production`; see §6.7 for a correction to the plan on this point.

---

## 3. Data

### 3.1 PostgreSQL

Migrations `0001` … `0008` applied to `mac_bennett`. A pre-migration `pg_dump` of both databases was
taken and retained before `0007`/`0008` were applied, so the schema change is reversible.

Backups: `mac-bennett-backup.timer`, `OnCalendar=*-*-* 03:15:00 Australia/Sydney`,
`Persistent=true`, writing to `/var/backups/mac-bennett/`. A dump from the first firing exists.

### 3.2 The acceptance task — migrated, not recreated

Every id is the original. This is the single most delicate step in the plan and it is verifiable by
inspection:

| Row | Id | State on arrival |
|---|---|---|
| project `PAC Internal Development` | `a67d1055-a5dc-42cc-93b0-2b816c712018` | `night_shift_approved = false`, `allowed_task_kinds = []`, `repo_url` null |
| task | `332dcf3e-ee41-44bb-8955-10bf8589dc1a` | `draft`, kind `investigation`, origin `direct`, priority `high`, description 9,855 chars |
| discovery session | `fd7f30fa-8a57-45bc-97cf-1d1cd039abb2` | `ready` |
| handoff brief v1 | `0bb0b04a-e1c8-47fa-8328-ba428dfab1a2` | `draft`, confidence `0.999` |
| audit events | — | 98 rows, append-only history intact |

Nothing was invented in transit. No approval, no `night_shift_approved`, no `allowed_task_kinds`
entry travelled with the rows. The project arrived exactly as unapproved as it left, which is what
makes the human gate in §5 a real gate.

**One deviation from the plan, recorded.** The plan expected the Windows company-context revision
`28b00dde-…` to be migrated and the brief's `RESTRICT` foreign key re-pointed at it. What actually
happened is that the VM fetched the Company repository itself and the brief is bound to the VM's own
revision `f44eb70c-c785-4b3d-986d-2e06f62e17cd`. Both revisions describe the same commit,
`83ac4a0c03fb882b3b9050f05d718eb2164369db`, so the governing content is identical and the brief's
provenance claim remains true. The revision *id* is not the original; the *commit* is. That
distinction is recorded here rather than smoothed over.

---

## 4. Worker, sandbox and Claude Code

### 4.1 Worker

One worker, `mac-linux-01`, `fdd6aa81-59ec-495c-b96c-fe792f3c8907`, advertising nine capabilities
including both `claude_code` and `general_task`.

| Requirement | Evidence |
|---|---|
| Enrolment | `worker.enrollment_token_created`, `worker.registered` in the audit trail |
| Heartbeat | `workers.last_heartbeat_at` advancing on every check |
| Capability advertisement | `general_task` present in the capability list read directly from the row |
| Token rotation | `worker.token_rotation_requested` and `worker.token_rotated` in the audit trail |
| Reconnect | see below |

**Reconnect, observed directly.** `systemctl restart mac-worker` produced, in journald:

```
SIGTERM received. Finishing current work and stopping.
mac-worker.service: Deactivated successfully.
Execution sandbox: bubblewrap (bubblewrap 0.9.0).
Reusing stored identity from /var/lib/mac-bennett/worker-state.json.
Registered as "mac-linux-01" (fdd6aa81-59ec-495c-b96c-fe792f3c8907).
```

Same identity, from its own state file, heartbeat resumed, `NRestarts=0` — a clean stop and start,
not a crash loop.

### 4.2 Bubblewrap

`MAC_SANDBOX_PROVIDER=bubblewrap`, named explicitly rather than left on `auto`, so a future Docker
install cannot silently change the containment.

`apps/worker/tests/sandbox-conformance.test.ts` — **18 of 18 passing** on this VM against the real
provider, including that the assigned work area is readable and writable, that an unrelated
project's directory is not reachable, and that cancellation terminates the contained process.

### 4.3 Plane separation, verified rather than asserted

The worker process's own environment was read from `/proc/<pid>/environ` and contains **zero** of
`ANTHROPIC_API_KEY`, `MONDAY_API_TOKEN`, `DATABASE_URL`, `MAC_MAIL_CLIENT_SECRET`,
`MAC_COMPANY_CONTEXT_TOKEN`, `SEED_ADMIN_PASSWORD`. Its complete variable set is worker identity and
sandbox settings only.

**The known weakening is real and is confirmed real.** `sudo -u mac` can read
`/etc/mac-bennett/control-plane.env`. Both planes run as the same unprivileged user on one host, so
the separation between the two env files is a permission boundary, not a machine boundary. The
mitigations stand — `mac` has no sudo, the worker's unit never loads that file, the sandbox
environment is built from empty — and the real fix remains two hosts. This is §9 remaining risk, not
something to pretend away.

### 4.4 Claude Code

2.1.233, authenticated as the `mac` user from the copied subscription credential, mode `0600`.
`gh` is authenticated as `KasperPac` with scopes `gist, read:org, repo`.

Claude Code is **not** used by the acceptance task, which is non-coding. Its presence is recorded;
it is not exercised by the research run, and no API-key billing was introduced for it.

---

## 5. Human gates

### 5.1 What the eligibility check says right now

Read from the real API over TLS, as an authenticated admin:

```
ELIGIBLE: false
  FAIL project_approved              Nobody has approved this project for night-shift work.
  FAIL task_kind_permitted           Nobody has approved this project for investigation work.
  PASS brief_exists                  A handoff brief exists.
  PASS confidence_above_floor        Understanding confidence 100% is above the 60% floor.
  PASS confidence_permits_autonomy   Confidence 100% is in the autonomous band.
  PASS worker_capability_available   A worker advertising the required capability is online.
  FAIL reasoning_model_available     No reasoning-model provider is configured.
  PASS project_capabilities_sufficient
  PASS no_active_run
  PASS not_previously_blocked
```

`worker_capability_available` was one of the two checks Sprint 3.3 left failing. It now passes.

### 5.2 The gates, corrected

The plan named three human gates. There are **two**.

1. **Approve `PAC Internal Development` for night shift.**
2. **Permit `investigation` work on that project** (`allowed_task_kinds`).

The plan's third gate — approving the handoff brief — **does not exist in the implementation**.
`markBriefStatus()` is defined in `apps/server/src/services/briefs.ts:410` and is called from
nowhere; no HTTP route exposes it; and eligibility only checks `brief_exists`, never brief status.
The brief's authority comes from its *derived* confidence, which is recomputed on every write
precisely so nobody can raise it by asserting it. Reporting a gate that does not exist would have
been worse than reporting that it does not.

### 5.3 A defect that blocked the human path entirely

The approval control for night shift existed in exactly one place in the UI: inside a monday board's
card on the Monday page, keyed to `board.projectId`.

`PAC Internal Development` has no monday board, deliberately, per the plan's §16. So there was **no
control anywhere in the interface** capable of approving this project. The admin endpoint
`POST /api/projects/:id/night-shift-approval` existed and worked; nothing a human could click was
wired to it.

Sprint 3.3 introduced general work on projects with no repository and no board, and this control was
never lifted out of the monday page along with it.

Fixed on this branch in commit `235fd4c` as a §27 defect, with the operator's explicit decision to
take that route rather than approve through the API directly. The endpoint, the admin role check and
the audit event are unchanged; **no new authority is created**. The panel additionally warns when a
project is approved for night shift but permits no task kind, which is the state that produces a
project that looks approved and never runs.

Deployed and verified: the built bundle served from `https://mac.pac-technologies.com.au/` contains
the control, and the SPA was confirmed booting in a real browser over the public certificate.

### 5.4 The actions reserved for a person

Neither was taken, and neither will be.

| # | Action | Where |
|---|---|---|
| 1 | Approve the project for night shift | `https://mac.pac-technologies.com.au/projects/a67d1055-a5dc-42cc-93b0-2b816c712018` → **Night shift** panel → **Approve for night shift** |
| 2 | Permit `investigation` work | Same page → **Capabilities and permitted work** → tick **Investigation** under *What Mac may do here* → **Save** |

Both require the `admin` role. The signed-in commissioning account
(`kasper.simonsen@pac-technologies.com.au`) holds it.

No database mutation was used to bypass either, as the plan's §17.3 forbids.

---

## 6. Defects found during commissioning

Everything in this section was found by testing something rather than by reading it, and each was
re-tested after the fix.

### 6.1 The login rate limiter was completely bypassable — *security, high*

`buildApp()` sets `trustProxy: true`, so Fastify reads the **leftmost** `X-Forwarded-For` entry as
the client address, and `@fastify/rate-limit` keys the 5-per-5-minutes login limit on it. nginx was
configured with `proxy_add_x_forwarded_for`, which **appends** to whatever the client sent. A client
could therefore supply its own `X-Forwarded-For`, land leftmost, and get a fresh limiter bucket on
every single request.

Proven, not theorised — eight login attempts with rotating spoofed addresses:

```
attempt 1 (XFF 203.0.113.1) -> 401      attempt 5 (XFF 203.0.113.5) -> 401
attempt 2 (XFF 203.0.113.2) -> 401      attempt 6 (XFF 203.0.113.6) -> 401
attempt 3 (XFF 203.0.113.3) -> 401      attempt 7 (XFF 203.0.113.7) -> 401
attempt 4 (XFF 203.0.113.4) -> 401      attempt 8 (XFF 203.0.113.8) -> 401
```

Not one `429`. The same eight requests without the header tripped the limiter at attempt 6.

This matters more than an ordinary bug: login rate limiting is one of the compensating controls the
plan's §3.3 offered in exchange for putting an authentication plane on the internet. Without this
fix that compensation was fictional.

**Fixed** by having nginx *overwrite* rather than append: `proxy_set_header X-Forwarded-For
$remote_addr;`. nginx is the only hop, so `$remote_addr` is the whole truth and a client-supplied
header is discarded at the edge. Re-tested with rotating spoofed addresses: `401 401 401 401 401 429
429 429`.

### 6.2 The fail2ban jail would never have banned anyone — *security, high*

Debian ships `backend = systemd` under `[DEFAULT]` in `/etc/fail2ban/jail.d/defaults-debian.conf`.
Under that backend `logpath` is ignored entirely — the jail reads journald. A jail pointed at
`/var/log/nginx/mac-bennett.access.log` therefore matched nothing, silently, forever.

The jail reported itself healthy the whole time. It was caught only by feeding a synthetic attacker
into it and noticing that nothing happened:

```
Jail 'mac-bennett-auth' uses systemd {}        <- before
Jail 'mac-bennett-auth' uses pyinotify {}      <- after
```

**Fixed** with an explicit `backend = pyinotify`. Re-tested end to end with a disposable jail on a
scratch log so production traffic was untouched: four synthetic `401`s from `203.0.113.77` produced
`Currently banned: 1` and a real firewall entry:

```
set addr-set-mac-bennett-auth-bantest {
        type ipv4_addr
        elements = { 203.0.113.77 }
}
```

The disposable jail was removed afterwards.

### 6.3 Conflicting security headers on `/api` — *security, low*

Helmet sets its own headers on API responses and nginx sets a stronger set at server level, so every
`/api` response carried two. `X-Frame-Options: SAMEORIGIN` **and** `DENY` — a duplicate browsers are
entitled to ignore outright — and two `Strict-Transport-Security` headers, where the weaker 180-day
one won by arriving first.

**Fixed** with `proxy_hide_header` for the four duplicated headers, so exactly one set reaches the
client. Verified: HSTS header count `1`, `x-frame-options: DENY`.

### 6.4 TLS 1.0/1.1 were permitted at socket level — *security, medium*

nginx selects the protocol list from the **default server** for a listening socket, because it must
do so before it has read SNI. Ubuntu's `nginx.conf` still carries
`ssl_protocols TLSv1 TLSv1.1 TLSv1.2 TLSv1.3` at `http` level, and setting the modern list only in
the application's own server block leaves the socket-level policy stale.

**Fixed** by setting `ssl_protocols TLSv1.2 TLSv1.3;` in the `default_server` block as well.

### 6.5 The public origin was still loopback — *correctness, medium*

`WEB_ORIGIN` and `MAC_APP_URL` were both `http://127.0.0.1:8080`. `MAC_APP_URL` is what the morning
report uses to link a human back to the run, so every link in the first real report would have
pointed at a loopback address on a machine the reader is not sitting at.

**Fixed** to `https://mac.pac-technologies.com.au`. Verified: `access-control-allow-origin:
https://mac.pac-technologies.com.au`.

### 6.6 The worker suite could not pass on a correctly configured machine — *test defect, medium*

Four cases in `apps/worker/tests/sandbox-credentials.test.ts` failed on the VM:

```
Invalid worker configuration:
  MAC_CONTROL_PLANE_URL: Required

Did you copy .env.example to .env?
```

Their `withEnv` helper sets only the variables a given case is interested in, then calls
`loadConfig()`, which validates the **whole** worker environment. `MAC_CONTROL_PLANE_URL` is the one
variable with no default, and the helper never supplied it — it inherited whatever `dotenv` had
already loaded from `apps/worker/.env`.

That file exists on every development laptop and **deliberately does not exist on this VM**.
Configuration arrives from systemd's `EnvironmentFile`, which is precisely what makes "no credential
is in the checkout" structural here rather than a matter of remembering. So the suite passed
everywhere it was written and failed on the one machine configured the way the deployment requires.

The first run was also inconclusive in a way worth recording: it was executed with
`control-plane.env` sourced into the environment, so the failure could plausibly have been my own
pollution. It was re-run under `env -i` with nothing inherited, and failed identically — which is
what promoted it from "probably my harness" to a defect.

**Fixed** by having the helper supply the variable and spread the caller's overrides last, so a case
that wants a different URL still gets one. No worker behaviour changed. Re-run under `env -i` on the
VM: **226 passed, 4 skipped, 0 failed**.

### 6.7 Two corrections to the plan itself

* The plan said `MAC_ALLOW_INSECURE_HTTP` "stays off in production" as the control over the session
  cookie's `Secure` flag. It is not that. It is a **worker** variable
  (`apps/worker/src/config.ts:26`) guarding the worker's own transport, and it is legitimately
  `true` here because the worker talks to the control plane over `http://127.0.0.1:8080` — loopback,
  never the internet. The session cookie's `Secure` flag comes from `config.isProduction`, i.e.
  `NODE_ENV=production`, which is set. The outcome the plan wanted is correct; its stated mechanism
  was wrong.
* certbot's nginx *installer* could not install the certificate (`Could not automatically find a
  matching server block`, because `server_name` was the catch-all `_`) and later hung a renewal
  dry-run. Renewal was moved to the `webroot` authenticator with `installer = None` and a
  `renew_hook = systemctl reload nginx`. This also means renewal will never rewrite the hand-written
  nginx configuration. Dry-run then succeeded.

---

## 7. Company context

Fetched on the VM from `https://github.com/PacTechnologiesAus/Company.git`, ref `main`.

| | |
|---|---|
| Commit | `83ac4a0c03fb882b3b9050f05d718eb2164369db` |
| Context version | `0.1.0`, schema version 1 |
| Validation | `valid`, zero validation errors |
| Documents | all seven mandatory: `AGENTS.md`, `AUTHORITY.md`, `COMPANY.md`, `GLOSSARY.md`, `OPERATING_MODEL.md`, `SYSTEMS.md`, `VALUES.md` |
| Refresh | exercised through the real API; `consecutiveFailures: 0`, status `fresh` |

This is the same commit the migrated brief is bound to.

### 7.1 The credential finding, now measured

The plan recorded that the configured Company credential was not read-only. Measured directly
against the GitHub API, without printing the token:

```
token prefix : gho_...            (OAuth token, 40 chars)
x-oauth-scopes: gist, read:org, repo, workflow
permissions on PacTechnologiesAus/Company:
  { "admin": true, "maintain": true, "push": true, "triage": true, "pull": true }
private: True
```

Mac needs `Contents: Read`. It holds admin on a private repository. The provider only ever reads, so
no write is *performed* — but "no write capability is required" and "no write capability is held"
are different claims and only the first was true.

**Status: BLOCKED pending the operator's replacement** — a fine-grained PAT scoped to
`PacTechnologiesAus/Company` alone with `Contents: Read` and nothing else. The "after" measurement
will be recorded here using the same method.

---

## 8. Reasoning provider

**BLOCKED.** `model_provider` is `none` and no `ANTHROPIC_API_KEY` is present in
`/etc/mac-bennett/control-plane.env`.

`requireReasoningProvider()` refuses rather than degrading, and the eligibility check says so in
words a human can act on:

> No reasoning-model provider is configured (`MODEL_PROVIDER_REQUIRED`). General work will not be
> run against a null provider, because it would produce an empty result that reads like a finished
> one.

That refusal is the correct behaviour and is itself evidence: Mac will not manufacture an empty
investigation. Nothing in §10.1 of the plan — structured output, citations, cancellation mid-call,
usage reporting, and the mandatory **adversarial input** test — has been exercised, and none of it
will be claimed until it has.

---

## 7B. Test suites on the commissioned machine

Run on the VM itself, as the `mac` user, against `mac_bennett_test`. Production `mac_bennett` is
never pointed at by a test run. Suites run one at a time because 954 MiB does not hold two.

| Suite | Result |
|---|---|
| `@mac/server`, full | **805 passed, 59 skipped, 0 failed** (40 files, 13m 41s) |
| `@mac/worker`, full | **226 passed, 4 skipped, 0 failed** — after the fix in §6.6 |
| `apps/worker/tests/sandbox-conformance.test.ts` | **18 passed** against real Bubblewrap 0.9.0 |
| `company-live` (opt-in, real GitHub) | **6 passed** |
| `monday-commissioning.live` (opt-in, real monday.com) | **37 passed** |

The 59 skips are the opt-in live suites, which are skipped by design in the standard run and were
then executed deliberately — the two rows beneath.

**Company, live.** Authenticated against the real `PacTechnologiesAus/Company` from this VM, resolved
`HEAD` of `main` to `83ac4a0c03fb882b3b9050f05d718eb2164369db`, parsed a manifest this build
understands at `context_version 0.1.0`, and loaded all seven mandatory documents. This proves
authentication against github.com rather than a `file://` path, which the local-repository tests
cannot.

**monday.com, live.** Thirty-seven checks against the disposable Sprint 3.1 board `5102345434` and
its unapproved sibling `5102345613`, covering reads, every write Mac is permitted, the unapproved
board scoping, and failure classification. No monday item, board or dependency was given to the
acceptance task; the plan's §16 is explicit that the direct-task case needs none, and none was
invented.

**The Sprint 3.1 attribution finding is unchanged and still true.** The suite printed:

```
[identity] Mac's writes are attributed to: Kasper Simonsen (id 61829416)
```

There is no `Mac Bennett` user in the monday account, so Mac's writes carry the token owner's name.
That is a commercial decision — a paid seat — not a technical one, and it is outside what this
commissioning may decide. A test asserts the absence so the claim cannot silently go stale.

---

## 8A. Secret leakage — verified, and verified again after the first check was worthless

Every credential the system holds was compared, by exact value, against the working tree and against
**all 43 commits** of history. No secret was ever printed; only match counts.

| Credential | Worktree | Git history |
|---|---|---|
| `DATABASE_URL` | 0 | 0 |
| `TEST_DATABASE_URL` | 0 | 0 |
| `SEED_ADMIN_PASSWORD` (env and file) | 0 | 0 |
| `MONDAY_API_TOKEN` | 0 | 0 |
| `MAC_MAIL_CLIENT_SECRET` / `CLIENT_ID` / `TENANT_ID` | 0 | 0 |
| `MAC_COMPANY_CONTEXT_TOKEN` | 0 | 0 |
| `MAC_ENROLLMENT_TOKEN` | 0 | 0 |
| worker token (`workerToken` in the state file) | 0 | 0 |
| Claude Code `accessToken` and `refreshToken` | 0 | 0 |

`.env` has never been committed on any branch.

Six tracked files match credential-shaped patterns. All three distinct strings are deliberate test
fixtures — `ghp_abcdefghijklmnopqrstuvwxyz0123456789`,
`ghp_sentinelcompanytoken0123456789abcd` and `sk-ant-conformance-probe`. The last is the sentinel
the sandbox conformance suite uses to prove a model credential does *not* reach a sandbox, so its
presence in the repository is the test working, not a leak.

**The first run of this check was invalid and is recorded because of it.** It executed `git` as root
against a directory owned by `mac`, so every `git log` invocation failed with `detected dubious
ownership` and returned nothing. Every `git-history=0` in that run therefore meant "git produced no
output", not "the secret is absent" — a check that could only ever pass. It was re-run with
`git -c safe.directory=…` and a sanity line proving history was readable (`43 commits`) before any
conclusion was drawn from it. A verification that cannot fail is worse than no verification, because
it is reported as a pass.

The same first run also flagged seven false positives by treating any value over twelve characters
as a secret. The mail sender address, the Company repository URL, the model name `claude-sonnet-5`,
the loopback control-plane URL and two filesystem paths are configuration, not credentials, and they
appear in `.env.example` and the documentation correctly.

---

## 9. Settings

Read back from the live database:

| Setting | Value |
|---|---|
| `timezone` | `Australia/Sydney` |
| `overnight_cutoff` | `08:00` |
| `night_shift_enabled` | `true` |
| `model_provider` | `none` — **pending** |
| `model_assist_enabled` | `true` |
| `general_work_enabled` | `true` |
| `max_research_steps` | `8` |
| `max_research_tool_calls` | `40` |
| `external_research_enabled` | `false` |
| `mail_provider` | `graph` |
| `report_recipients` | one internal address |
| `allowed_recipient_domains` | `pac-technologies.com.au` |
| `nightly_budget_cents` | `5000` — **unchanged**, an existing human-approved limit |
| `min_execution_confidence` | `0.600` |
| `require_sandbox` | `true` |

### 9.1 The night window, read back from the running system

No clock was moved and no timezone was misrepresented. The VM's system timezone is `Etc/UTC` and its
clock is NTP-synchronised; the *application* timezone is `Australia/Sydney`, which is the correct
separation.

Read live from `/api/night-shift` at 12:18 AEST on 19 August:

```
macState            = day_mode
minutesUntilCutoff  = 1181            (19h 41m → 08:00 AEST tomorrow)
budget.windowStart  = 2026-08-18T22:00:00.000Z
budget.windowEnd    = 2026-08-19T22:00:00.000Z
sandboxReadyWorkers = 1
```

`22:00Z` is `08:00` AEST exactly. The derived window matches the configured cutoff.

DST correctness is proven by `tests/unit/overnight.test.ts`, which passed here and covers the Sydney
daylight-saving start and end explicitly, including the 23-hour and 25-hour windows either side of
each transition. A fixed UTC offset would fail those cases.

### 9.2 The budget cannot enforce, and the system says so out loud

The same dashboard read reports:

```
providerUsageAvailable = false
costEnforceable        = false
usageSource            = "unavailable"
recordedSpendCents     = 0
```

This is Sprint 3.3 debt item 2, visible in production data rather than inferred from a changelog.
Reasoning usage is counted in tokens, not money, so `nightly_budget_cents` **cannot stop a research
shift**. What actually bounds a run is `max_research_steps = 8` and `max_research_tool_calls = 40`,
plus whatever spending limit is set on the provider account — and that limit is a human setting this
commissioning cannot make or verify from here.

**This is the one item requiring an explicit human judgement before Mac runs unattended**, and it is
put plainly rather than buried: the monetary guardrail you can see in the UI is not currently load
bearing for general work.

**No new spend authority was created.** The nightly budget was not raised. The honest limitation
from Sprint 3.3 stands: reasoning usage is recorded in tokens, not money, so the monetary budget
cannot stop a research shift. The step and tool-call ceilings bound each run, and the provider-side
account limit is the real backstop — which is a human setting, not one this commissioning can make.

`external_research_enabled` stays `false` for the first run, as planned. The consequence is stated
rather than discovered: the investigation will legitimately produce **no** `external_fact` findings.

---

## 10. Remaining risks

1. **Same-host planes.** Confirmed real in §4.3. The fix is two hosts.
2. **A public authentication plane.** Compensated by TLS-only, HSTS, an unspoofable rate limiter
   (§6.1), a working fail2ban jail (§6.2), loopback-only Postgres and control plane, and a rotated
   admin password. The residual exposure is real.
3. **A non-read-only Company credential.** §7.1, pending replacement.
4. **The monetary budget cannot see reasoning spend.** Bounded by ceilings; needs a human judgement
   before unattended running.
5. **A real model has never been through the evidence-classification safeguards.** §8. Finding a
   defect there is a likely outcome, not a failure.
6. **954 MiB of RAM.** The web build peaked with 73 MiB free and 105 MiB of swap in use. It
   completed. Suites are run one at a time.
7. **TLS 1.0/1.1 refusal is configured but not observed** (§2), because no available client will
   offer those protocols.

---

## 11. What has not been done

* The acceptance run. Gated on §5.4 and §8.
* Everything in §10.1 of the plan (real-provider validation, including the adversarial input).
* Failure injection that requires a model: transient provider failure, cancellation of a live
  research call.
* Mail delivery of a real morning report on the real path. Idempotency is covered by the server
  suite against the test database; a real Graph send for the research run is not yet done.
* Company-refresh failure injection. Deliberately deferred until after the Company credential is
  replaced, so the two changes to that file cannot collide and be mistaken for each other.
* The §30 definition-of-done list.

None of these are claimed. This report will be extended, not rewritten, as each is exercised.
