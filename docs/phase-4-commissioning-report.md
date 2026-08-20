# Phase 4 Commissioning — Real Microsoft Teams & Real External Web Research

**Target deployment:** Oracle Cloud VM `mac-bennet-pc`, `161.33.80.88`, ap-melbourne-1
**Public name:** `https://mac.pac-technologies.com.au`
**Repository:** `https://github.com/PacTechnologiesAus/MacBennet`
**Governing documents:** `Mac_Spec.md`, `docs/mac-spec-reconciliation.md`, `docs/phase-4-completion-report.md`
**Started:** 2026-08-19

This is a commissioning record, not a design document. The rule inherited from Sprint 3.1 and
Phase 4 governs every claim in it: **never describe simulated behaviour as proven.** Where something
was not exercised against the real third party, this report says so and names what is missing.

---

## Part A — Baseline

Recorded before any configuration was changed. Everything in this section was observed directly on
the production VM over SSH, or from off-host against the public name.

### A.1 Deployed commit — **the deployment predates Phase 4**

| Fact | Observed |
|---|---|
| Deployment path | `/opt/mac-bennett`, owned `mac:mac` |
| Deployed branch | `commissioning/oracle-linux-general-night` |
| Deployed commit | `d127a9e6fb62c9be771a401ab6a939c2b6f9cf15` — *"fix: raise the per-step ceiling, which was starving the run of findings"* |
| Working tree | **clean** (`git status --short` → empty) |
| Repository `main` | `107aa5b` — merge of PR #4, `phase-4/interaction-orchestration-research` |
| Schema | migration `0008_sprint33_general_work.sql` is the last applied; **41 tables** |

**This is the single most important baseline fact.** The running deployment is the Phase 4 *base*
branch. `0009_phase4_interaction.sql` has never been applied to `mac_bennett`, and none of the
Phase 4 code — conversations, the Teams plane, approval requests, Forja, `research_sources`,
acceptance verification — exists in the running process. The Phase 4 completion report's numbers
(50 tables) are development-environment numbers.

Consequence for this commissioning: **no Teams or web-research path can be commissioned against the
real deployment until merged `main` is deployed to the VM.** That deployment is itself a
commissioning step and is recorded as one below, not assumed.

A second checkout exists at `/home/ubuntu/mac-bennett` on branch
`sprint-3.1/integration-commissioning` with a dirty tree. It is a stale development checkout, it is
not what any systemd unit runs, and it was left untouched.

### A.2 Host and services

| Item | Observed |
|---|---|
| OS | Ubuntu 24.04.4 LTS, kernel `6.17.0-1018-oracle`, `x86_64` |
| CPU / RAM | 2 × AMD EPYC 7551, **954 MiB RAM**, 4 GiB swap (191 MiB in use) |
| Disk | 45 GiB, 19% used |
| Container runtime | **none** — neither `docker` nor `podman` is installed |
| `mac-control-plane` | `active` |
| `mac-worker` | `active` |
| `nginx` | `active` |
| `postgresql` | `active` (PostgreSQL 16.14) |
| `fail2ban` | `active` |
| Uptime | 1 day 15 h |

### A.3 Ingress boundary — correct, unchanged

Listening sockets, observed with `ss -tlnp`:

| Socket | Process | Exposure |
|---|---|---|
| `0.0.0.0:22` | sshd | public |
| `0.0.0.0:80`, `0.0.0.0:443` | nginx | public |
| `127.0.0.1:8080` | control plane (node) | **loopback only** |
| `127.0.0.1:5432` | postgres | **loopback only** |

Host firewall `INPUT` policy accepts only 22, 80, 443 and established/loopback/ICMP, then
`REJECT`s. nginx proxies `location /api/` to `http://127.0.0.1:8080`, so the Teams messaging
endpoint `POST /api/teams/messages` will be reachable through the existing ingress with **no new
port opened and no new public service**. Part B §2's requirement — that the control plane's
internal port must not simply be opened to the internet — is satisfied by the existing
configuration and nothing was changed to satisfy it.

### A.4 DNS, TLS, public reachability

* `mac.pac-technologies.com.au` → `161.33.80.88` (resolved from off-host).
* `https://mac.pac-technologies.com.au/api/health` → `200`, body
  `{"ok":true,"service":"mac-bennett-control-plane"}`, TLS handshake completed against the
  Let's Encrypt certificate, ALPN `http/1.1`, round trip 131 ms.
* Verified from a Windows workstation outside the VM's network.

### A.5 PostgreSQL

`mac_bennett` and `mac_bennett_test` are the only Mac databases. `mac_bennett` holds 41 tables, 1
project, 1 task, 4 runs, 4 email deliveries and 516 audit events.

### A.6 Company context — loaded and valid

| Field | Value |
|---|---|
| Repository | `https://github.com/PacTechnologiesAus/Company.git` |
| Ref | `main` |
| Commit | `83ac4a0c03…` |
| Context version | `0.1.0` |
| Validation state | `valid` |
| Loaded at | 2026-08-19 05:14:43 UTC |
| Freshness | `fresh` (`company_context_status`) |

### A.7 Reasoning provider — working

`settings.model_provider = 'anthropic'`, `model_assist_enabled = true`, `MAC_MODEL_NAME=claude-sonnet-5`.
Most recent real usage rows in `run_usage`, all `source = 'exact'` (that is, token counts reported by
the API rather than estimated):

```
2026-08-19 05:18:05Z  anthropic  claude-sonnet-5  reasoning_tokens  30,897  exact
2026-08-19 05:16:19Z  anthropic  claude-sonnet-5  reasoning_tokens  10,956  exact
2026-08-19 05:16:06Z  anthropic  claude-sonnet-5  reasoning_tokens  10,500  exact
```

### A.8 Mail integration — working

`settings.mail_provider = 'graph'`, sending as `mac.bennet@pac-technologies.com.au` from tenant
`370de8ef-61d9-4539-903d-4253050f2cea`. The four most recent `email_deliveries` rows are all
`status = 'sent'` via `provider = 'graph'`, most recently the morning report
*"Mac overnight — 1 done (2026-08-19)"* at 05:25:09 UTC, with the matching
`report.email_delivered` audit event at 05:25:22 UTC.

Note for Part B: **Mac already holds a real Microsoft 365 identity** (`mac.bennet@…`) used for
mail via Graph application permissions, in the same tenant a Teams bot would live in. It is a
mailbox identity, not a Teams application identity, and it does not shorten the Azure Bot
registration described in Part B.

### A.9 Existing Teams and web-research configuration state

**Teams: entirely unconfigured, as expected.**

* `/etc/mac-bennett/control-plane.env` contains no `MAC_TEAMS_*` key of any kind.
* `settings.teams_enabled` and `settings.teams_authorised_users` do not exist in the deployed
  schema — they arrive with migration 0009.
* No Azure Bot resource is known to this deployment.

**Web research: the Sprint 3.3 gates exist and are closed.**

* `settings.external_research_enabled = false`
* `settings.allowed_research_domains = []`
* `settings.max_research_steps = 8`, `max_research_tool_calls = 40`
* No `MAC_SEARCH_*` key of any kind in the service environment.
* `settings.web_search_provider` does not exist in the deployed schema — it arrives with 0009,
  defaulting to `'none'`.

So at baseline Mac cannot search the web for three independent reasons: no provider is
configured, the deployment switch is off, and the host allowlist is empty.

### A.10 Standard test suites — baseline reproduced

Run against a clean local PostgreSQL with nothing else touching it, on merged `main` (`107aa5b`),
after applying `0009` to the development database.

| Suite | Result |
|---|---|
| Server | **1055 passed**, 61 skipped (54 files passed, 5 skipped), 627 s |
| Worker | **233 passed**, 3 skipped (14 files passed, 1 skipped), 24 s |
| Exit code | `0` |

Identical to the Phase 4 completion report's numbers. The 61 + 3 skips are environment-gated
opt-in suites, not failures: `monday-commissioning.live` (37), `commissioning-night.e2e` (1),
`teams-live` and the other live suites — all of which skip because no real credential is present,
which at baseline is the correct state.

---

## A.11 Deploying Phase 4 to the VM

Authorised by the operator before it was done. Recorded here because it is a commissioning step in
its own right, not an assumption.

**Rollback point:** commit `d127a9e6fb62c9be771a401ab6a939c2b6f9cf15`; database dump
`/var/backups/mac-bennett/pre-0009-mac_bennett.dump` (268 KB, taken before the migration).

Sequence, in order:

1. `pg_dump -Fc mac_bennett` → the rollback dump above.
2. `systemctl stop mac-worker mac-control-plane` — so no process was running against a half-installed
   `node_modules` or a half-applied schema.
3. `git fetch origin && git checkout main && git merge --ff-only origin/main` → **`107aa5b`**.
   Working tree clean before and after. (The deployment had been 27 commits behind, and behind its
   own former branch as well: `origin/commissioning/oracle-linux-general-night` had moved
   `d127a9e → 3a90e81` after the deployment was made.)
4. `npm ci` — 188 packages added, 22 s.
5. `npm run migrate -w @mac/server` → **`Applied 1 migration(s): 0009_phase4_interaction.sql`**.
   Table count **41 → 50**, matching the Phase 4 design exactly.
6. `npm run build -w @mac/web` → clean, 16.5 s, `dist/assets/index-DalxLhUl.js` 411.72 kB.
   Peak memory was not a problem with both services stopped: 206 MiB free before, 284 MiB after.
7. `systemctl start mac-control-plane mac-worker`.

**Observed after restart:**

* control plane: `PAC company context 83ac4a0 (version 0.1.0) loaded; status fresh.` then
  `listening on http://127.0.0.1:8080`;
* worker: `Execution sandbox: bubblewrap (bubblewrap 0.9.0)`, re-registered as `mac-linux-01`
  from its stored identity, heartbeating (`workers.status = idle`, last heartbeat 23:11:45 UTC).
  Four heartbeat retries were logged during startup because the worker came up a few seconds before
  the control plane finished binding; it recovered on its own, which is the retry behaviour Sprint
  3.1 built;
* public: `https://mac.pac-technologies.com.au/api/health` → `200`, and the served bundle is the
  newly built `index-DalxLhUl.js`.

**The migration enabled nothing, as designed.** Immediately after deployment:

```
teams_enabled                    f
forja_enabled                    f
web_search_provider              none
external_research_enabled        f
allow_fetch_from_search_results  f
acceptance_verification_enabled  t
conversation_summary_threshold   24
```

**The Teams endpoint is now live on the public host and refuses everything.** Observed from
off-host:

| Request | Response |
|---|---|
| `POST /api/teams/messages`, no `Authorization` | `401` `{"error":{"code":"TEAMS_REJECTED","message":"Teams is not enabled in this deployment."}}` |
| `POST /api/teams/messages`, `Authorization: Bearer not.a.token` | `401` |

No new port was opened, no new public service was added, and nginx's existing `/api/` proxy is
what carries it.

---

## Part B — Real Teams commissioning

### B.1 What Phase 4 expects from Microsoft

Read out of the implementation rather than from generic Teams documentation, because the
implementation defines a specific contract and it is narrower than the platform's.

| Requirement | Where it is defined | Value for this deployment |
|---|---|---|
| Azure Bot resource | `TEAMS_SETUP_REQUIREMENTS` | must be created — **human action** |
| Application (client) ID | `MAC_TEAMS_APP_ID` | also the **expected inbound JWT audience**, compared in constant time |
| Client secret | `MAC_TEAMS_APP_PASSWORD` | used **only** to obtain a Bot Connector token |
| Tenant ID | `MAC_TEAMS_TENANT_ID` | `370de8ef-61d9-4539-903d-4253050f2cea` — already known; it is the tenant Mac's mailbox authenticates against |
| Messaging endpoint | `apps/server/src/http/routes/teams.ts` | `https://mac.pac-technologies.com.au/api/teams/messages` |
| Teams channel | Azure Bot → Channels | must be enabled — **human action**, requires accepting Microsoft's terms |
| Teams app package | *did not exist* — see B.2 | now `deploy/teams-app/` |
| Inbound JWT issuer | `EXPECTED_ISSUERS` | `https://api.botframework.com` |
| Inbound signing keys | `MAC_TEAMS_OPENID_METADATA` | `https://login.botframework.com/v1/.well-known/openidconfiguration` |
| Outbound token authority | `MAC_TEAMS_LOGIN_URL` | **depends on the bot's app type — see B.3** |
| Outbound scope | `provider.ts` | `https://api.botframework.com/.default` |
| Reply host allowlist | `TEAMS_SERVICE_HOSTS` | `smba.trafficmanager.net` and five others |
| Graph permissions / admin consent | — | **none.** Mac uses the Bot Connector, not Graph, for Teams |
| Who may assign work and approve | `settings.teams_authorised_users` | starts empty; empty means nobody |

Checked against Microsoft's current published contract
([Bot Connector authentication](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication)):
the inbound issuer, the OpenID metadata document and the audience rule Mac implements are exactly
what Microsoft specifies, and they are the same for single-tenant and multi-tenant bots.

**No Graph permission and no admin consent are required for the Teams channel itself.** A bot
authenticates to the Bot Connector with its own client credentials against
`https://api.botframework.com`; it is not calling Microsoft Graph and it requests no delegated or
application Graph scope. Admin involvement is needed for two different things: agreeing to the Teams
channel terms on the Azure Bot resource, and permitting the custom app to be uploaded and used in
the tenant.

**Cost: none.** Azure Bot Service's [Free tier](https://azure.microsoft.com/en-us/pricing/details/bot-services/)
includes unlimited messages on standard channels, and Microsoft Teams is a standard channel. Mac is
self-hosted, so there is no App Service, no Application Insights and no LUIS/QnA resource in this
picture. The Microsoft gate is consent and configuration, not money.

### B.2 Defect 1 — there was no way to install Mac in Teams

**Severity: high — it blocked commissioning outright.**

`TEAMS_SETUP_REQUIREMENTS` instructs an operator to "install the app in the PAC tenant", and no app
package existed anywhere in the repository to install. Microsoft's own guidance is explicit that
adding a bot by GUID "for anything other than testing purposes, isn't recommended" and that bots in
production should be added as part of an app.

**Fixed** on `commissioning/phase-4-teams-web` (`23ccfce`) by adding `deploy/teams-app/`:

* `manifest.template.json` — schema `v1.30`, both `personal` and `team` scope, `accentColor`
  matching the icon, `validDomains` limited to Mac's host;
* `make-icons.mjs` — generates the two required PNGs (192×192 colour, 32×32 outline) from four line
  segments and `node:zlib`, so the icons are reviewable as source rather than as binaries;
* `build.mjs` — stamps the bot application id into the manifest and writes a byte-reproducible
  `mac-bennett-teams.zip` (stored entries, fixed 1980 timestamp), so a checksum can answer "is the
  installed package the reviewed one?";
* `README.md` — how to build it and how to install it.

The package is a build artefact and is git-ignored: `botId` does not exist until the Azure Bot
resource does, and a placeholder inside a zip is a broken install nobody can review in a diff.
Verified by building with a dummy GUID and reading the archive back with an independent zip
implementation — three entries, no CRC errors, manifest parses, `manifestVersion 1.30`.

The manifest's description opens by saying Mac is an application and not a person, matching
`MAC_TEAMS_IDENTITY.limitation`. That is Part B §4's requirement met in the one place a person
actually reads before installing.

### B.3 Finding 1 — the shipped default contradicts the shipped instructions (single-tenant)

**Severity: high if followed literally. Not yet observed, because no credential exists.**

`.env.example` tells an operator to "Create an Azure Bot resource in the PAC tenant
**(single-tenant)**". `MAC_TEAMS_LOGIN_URL` defaults to
`https://login.microsoftonline.com/botframework.com`, and its comment says "Only change this for a
government cloud."

Those cannot both be right. Microsoft's contract is:

| Bot app type | Token endpoint |
|---|---|
| Multi-tenant | `https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token` |
| Single-tenant | `https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token` |

An operator who follows the checklist exactly — single-tenant bot, three environment values, nothing
else — gets a deployment whose **inbound path works and whose outbound path cannot obtain a token at
all**, surfacing as `Could not obtain a Bot Connector token (HTTP 400)`. Mac would receive Teams
messages and be unable to reply.

**Not fixed in code yet, deliberately.** The Defect Policy for this commissioning requires real
evidence and a reproducing regression test before a change, and this is an inspection finding rather
than an observation. It is neutralised for now by giving the operator the correct value in the
configuration below. If the observed behaviour differs, this section gets the evidence and the fix.

**It bites the opt-in live test too.** `tests/integration/teams-live.test.ts` constructs a
`BotFrameworkTeamsProvider` directly, and that class reads the token authority from
`config.teams.loginUrl` — i.e. from `MAC_TEAMS_LOGIN_URL`, for which there is no `MAC_TEAMS_LIVE_*`
equivalent. So the documented invocation in that file's own header will fail against a single-tenant
bot unless `MAC_TEAMS_LOGIN_URL` is exported alongside the five `MAC_TEAMS_LIVE_*` variables. The
runbook in this report sets it in the service environment, which covers both.

### B.4 Public endpoint — verified, and nothing new was exposed

Covered in A.3, A.4 and A.11. In summary: DNS and TLS verified from off-host; nginx is the only
public listener; the control plane and PostgreSQL remain bound to `127.0.0.1`; the messaging
endpoint rides the pre-existing `/api/` proxy; the endpoint answers `401` to an unauthenticated POST
and to a malformed bearer token.

### B.5 Identity in Teams

Mac appears as an **application (bot)** named **Mac Bennett**, signing substantive messages
`Mac Bennett · Automation Engineer · PAC Technologies`. This is not a configuration choice: Microsoft
Teams provides no mechanism by which a third-party application posts as a human user account.

Worth recording because it is easy to misread: **Mac already has a real Microsoft 365 user identity**
in this tenant — `mac.bennet@pac-technologies.com.au`, which sends his morning reports through Graph.
That mailbox is a *different identity* from the Teams bot, and using it would not make Mac appear as
a person in Teams either. The limitation is typed data (`MAC_TEAMS_IDENTITY.limitation`), asserted by
test, shown on the Settings page, and now also stated in the first paragraph of the app description
somebody reads before installing.

---

## Part C — External web research provider

### C.1 The three providers that exist in code

Read out of `apps/server/src/services/research/web.ts` and
`packages/protocol/src/web-research.ts`. No fourth provider was added.

An important structural point first, because it changes what the choice is actually about:
**the provider supplies search results only.** Retrieving a page is Mac's own `public_doc_fetch`,
an HTTPS GET validated against the administrator's host allowlist with no redirect following, and
it is identical whichever provider is chosen. So the decision affects *discovery* — which URLs Mac
gets to consider — and nothing else about evidence handling, provenance or source classification.

| | `searxng` | `brave` | `google_cse` |
|---|---|---|---|
| Auth | none | `x-subscription-token` header | `key` + `cx` query parameters |
| Credential | — | `MAC_SEARCH_API_KEY` | `MAC_SEARCH_API_KEY`, `MAC_SEARCH_ENGINE_ID` |
| Account | none with anyone | Brave account | Google Cloud project |
| Payment | none | payment method on file | billing account |
| Infrastructure PAC must run | **a SearXNG instance** | none | none |
| Search | yes | yes | yes |
| Webpage retrieval | not from the provider — Mac fetches | same | same |
| Publication date in results | `publishedDate`, when upstream gives one | `age` | **none** |
| Result cap | instance-configured | 20 per query | 10 per query |
| Error shapes handled | 429, non-2xx, unreachable, malformed | 401/403, 429, non-2xx, malformed | 403 split into quota vs bad key, 429, malformed, empty-is-not-an-error |
| Runs on the Oracle x86_64 VM | only if PAC hosts it | yes — outbound HTTPS only | yes — outbound HTTPS only |

`publishedDate`/`age` is not a detail. Spec §19 and Part C §15 require Mac to judge **currency**,
and a provider that returns no date at all makes that judgement rest entirely on what the fetched
page says about itself.

### C.2 What each one would actually cost PAC

* **SearXNG — $0 to any vendor, but it is infrastructure.** It is a metasearch front end: it has no
  index and queries public engines on PAC's behalf. Two practical problems on this deployment.
  First, resources: the VM has **954 MiB of RAM with ~360 MiB free**, no container runtime is
  installed, and the Phase 4 web build already runs close to the limit. Second, and worse for a
  production research path, a self-hosted instance querying public engines from a cloud IP address
  gets rate-limited and CAPTCHA'd, and it degrades to *fewer or no results* rather than to an error
  — which is precisely the failure mode Sprint 3.3's refusal wording exists to prevent a model from
  misreading.
* **Brave Search API — $0 at PAC's expected volume, but a card must be on file.**
  [Brave's pricing](https://brave.com/search/api/) applies **$5 of free monthly credits** against a
  $5-per-1,000-request rate, so roughly **1,000 queries a month at no charge**, at up to 50 queries
  per second. A credit card is required as an anti-fraud measure and is **not charged** on the free
  plan. Brave operates its own index, so results do not depend on scraping anybody.
* **Google Programmable Search — unavailable to PAC.** The Custom Search JSON API is
  [closed to new customers](https://developers.google.com/custom-search/v1/overview) and is
  **discontinued on 1 January 2027**. PAC would be a new customer. Google directs new work to Vertex
  AI Search, which searches your own content rather than returning the public web, and is therefore
  not a replacement for what `public_web_search` is for.

**That last point removes a third of Phase 4's provider abstraction from the table on availability
grounds rather than on price**, and it is worth recording as a finding in its own right: the
`google_cse` implementation is dead code for any deployment that does not already hold a Custom
Search key, and it stops working entirely for everyone on 1 January 2027.

### C.3 Recommendation

**Brave Search API on the free tier.**

* No infrastructure on a 954 MiB VM that is already tight, and no new public service.
* An independent index, so discovery does not depend on scraping engines that block cloud IPs.
* Returns `age`, which is the input spec §19's currency judgement needs.
* A single header credential — the simplest of the three to isolate, and the least to go wrong.
* $0 at PAC's volume with a hard, visible ceiling: when the free credits run out, requests fail with
  a rate-limit error Mac already handles as `rate_limited`, rather than accruing a bill.

The cost of the recommendation is exactly the thing Part C §11 says to stop for: **a person at PAC
must open a Brave account and put a card on file.** Nothing was purchased and no account was created
by this commissioning.

SearXNG remains the right answer if PAC would rather run the service than hold a vendor account, but
it should be hosted somewhere other than this VM.

---

## BLOCKED — HUMAN MICROSOFT CONFIGURATION REQUIRED

Commissioning stops here for Part B. Everything below is a human action in the PAC tenant; none of
it can be done from this machine, and none of it may be done without the tenant owner.

**Nothing here creates a paid service.** Azure Bot Service's Free tier covers unlimited Teams
messages, Mac is self-hosted so there is no App Service, and no Microsoft Graph permission is
requested or needed.

### Step 1 — Create the Azure Bot resource

[Azure portal](https://portal.azure.com/) → **Create a resource** → **Azure Bot**.

| Field | Value |
|---|---|
| Bot handle | `mac-bennett` (globally unique; adjust if taken) |
| Subscription / Resource group | PAC's own choice |
| Pricing tier | **F0 (Free)** — not S1 |
| Type of App | **Single-tenant** |
| Creation type | **Create new Microsoft App ID** |

Single-tenant means the app registration is usable only inside PAC's directory
(`370de8ef-61d9-4539-903d-4253050f2cea`). It does not restrict which PAC domains it serves: every
domain verified in that tenant is inside it.

### Step 2 — Set the messaging endpoint

Azure Bot resource → **Settings → Configuration → Messaging endpoint**:

```
https://mac.pac-technologies.com.au/api/teams/messages
```

That endpoint is already live and already refusing unauthenticated requests with `401`.

### Step 3 — Create a client secret

From the same Configuration blade, **Manage** next to the Microsoft App ID → **Certificates &
secrets** → **New client secret**.

Record the **Value** (not the Secret ID) once — Azure never shows it again. Send it to whoever
installs it on the VM by a means that is not email or chat, or paste it into
`/etc/mac-bennett/control-plane.env` directly.

Note the expiry you choose. A secret that silently expires makes Mac stop replying in Teams with no
other symptom.

### Step 4 — Enable the Microsoft Teams channel

Azure Bot resource → **Channels** → **Microsoft Teams** → read and accept the terms → **Messaging**
tab → cloud environment **Microsoft Teams commercial** → **Apply**.

Accepting those terms is a human decision and is one of the gates this commissioning stops at.

### Step 5 — Collect three values

| Needed | Where it is |
|---|---|
| **Application (client) ID** | Azure Bot → Configuration → Microsoft App ID |
| **Client secret value** | from Step 3 |
| **Tenant ID** | `370de8ef-61d9-4539-903d-4253050f2cea` (already known) |

The application ID and tenant ID are **not secrets**. The client secret is.

### Step 6 — Configure Mac

Appended to `/etc/mac-bennett/control-plane.env` (`root:mac`, mode `0640`), then
`systemctl restart mac-control-plane`:

```
MAC_TEAMS_APP_ID=<application (client) id>
MAC_TEAMS_APP_PASSWORD=<client secret value>
MAC_TEAMS_TENANT_ID=370de8ef-61d9-4539-903d-4253050f2cea
MAC_TEAMS_LOGIN_URL=https://login.microsoftonline.com/370de8ef-61d9-4539-903d-4253050f2cea
```

**The fourth line is the one that is easy to miss and is not optional for a single-tenant bot.**
See B.3: Mac's default is the multi-tenant token authority, and with a single-tenant app it cannot
obtain a Bot Connector token at all. Omit this line only if the bot was created as multi-tenant.

The worker never receives any of these — verified in G.1.

### Step 7 — Build and install the Teams app

```sh
node deploy/teams-app/build.mjs <application (client) id>
```

Then Teams → **Apps → Manage your apps → Upload an app → Upload a custom app** →
`deploy/teams-app/mac-bennett-teams.zip`.

This needs custom app upload to be permitted for the uploading account in the tenant's Teams app
setup policy — a Teams admin centre setting, and a human decision about what the tenant allows.
For everyone rather than one person: **Teams admin centre → Teams apps → Manage apps → Upload new
app**, then allow it in the relevant app permission policy.

### Step 8 — Turn Teams on and authorise the right people

`settings.teams_enabled` must be set, and `settings.teams_authorised_users` must list the Microsoft
Entra **object ids** of the people who may assign work and approve. It starts empty and **empty
means nobody**: an unrecognised sender may talk to Mac and read status, and may not create work or
authorise anything. Display names are never accepted, because a display name is chosen by its owner.

The object id does not have to be looked up in advance. Mac records the sender's AAD object id on
the first inbound activity — in `teams.activity_received` and in `conversation_participants` —
whether or not that sender is authorised. So the sequence is: enable Teams, send one message, read
the object id out of the audit trail, add it, and carry on.

---

## BLOCKED — HUMAN FINANCIAL / PROVIDER DECISION REQUIRED

Commissioning stops here for Part C. The comparison is C.1–C.2 and the recommendation is C.3.

**Recommended: Brave Search API, free tier.** ~1,000 queries/month at no charge; a credit card is
required as anti-fraud and is not charged on the free plan; no infrastructure; returns publication
ages, which spec §19's currency judgement needs.

**`google_cse` is not an option** — the Custom Search JSON API is closed to new customers and is
discontinued on 1 January 2027.

**SearXNG** costs nothing to any vendor but requires PAC to run the service, and should not be run
on this VM: 954 MiB of RAM with ~360 MiB free, no container runtime, and a metasearch instance
querying public engines from a cloud IP degrades to *fewer results* rather than to an error.

What a person must do, if Brave is chosen:

1. Create a Brave Search API account and add a payment method.
2. Subscribe to the **Free** plan of the **Data for Search** product. Do not subscribe to a paid
   tier; the free credits are the ceiling that keeps this at $0.
3. Create an API key and send it by a means that is not email or chat.

Nothing has been purchased and no account has been created by this commissioning.

---

## Part E — Forja contract regression

Driven by a test client (`scratchpad/forja_client.py`, 37 checks) against the **real deployment**
over the real HTTP surface. Forja itself was not built, and nothing in this section implements any
part of it.

Two clients were issued through the admin plane: one with all four scopes, one with `read` only.
Both API keys were written to `0600` files on the VM and neither appears in any transcript.

### E.1 Result — 36 of 37, then 37 of 37

The first run found a defect (E.2). After the fix, every check passes. The one remaining red in the
final run was an error in the *client's* assertion, not in the contract — it looked for a field
called `acceptance` where the contract publishes `structuredAcceptance`, which is present and
populated. Confirmed separately by reading `GET /api/forja/briefs/{id}`:

```
structuredAcceptance = [
  { id: "artefact-markdown_document", kind: "artefact_type",   description: "Produce a document" },
  { id: "evidence-grounded",          kind: "evidence_class",  description: "Establish at least one finding a reader can check, with a source" }
]
```

| Part E §21 requirement | Observed |
|---|---|
| authenticated API key works | `GET /api/forja/projects` → `200` with the key; `401` with none; `401` with a wrong key |
| create/read conversation | conversation `46e44afc…` created **and Mac replied in the same response**; a second message accepted `201` |
| create task | task `75bc36c7…` created `201`, `contractVersion 1` |
| discovery state | `status=open` on creation, `brief_drafted` after an answer |
| approval state | request `AP-QN45`, `authority=accept_brief`, visible in the pending list, decided → `approved` |
| run state | `GET /tasks/{id}/runs` → `200` (0 runs; the brief was approved, not executed) |
| artefact retrieval | `GET /artefacts?taskId=…` → `200` |
| event cursor | 9 events after the pre-work cursor, `seq` 1–9 strictly increasing, and a mid-cursor resumed with the 4 later events and none repeated |
| no access outside the key's scope | read-only key: `403` on write, `403` on events, `200` on read; and `403` on an approval decision, which needs the separate `approve` scope |

Event types emitted by that one exchange: `task_created`, `discovery_started`, `question_required`,
`brief_ready`, `approval_required`, `approval_decided`, `conversation_message`.

Two further properties held against the real deployment:

* **Forja is never an agent.** `GET /api/forja/agents` returned `Mac`, `Otto`,
  `Project Document Controller`, `Sales Engineer` — and no Forja.
* **Every write names a person.** `onBehalfOf: nobody-at-all@example.com` was refused `403`
  rather than degraded to a system actor.
* **The contract stays narrower than the internal DTO.** The task projection carries
  `understandingConfidence` and does **not** carry `userInitialConfidence`.

### E.2 Defect 2 — a task kind the contract invented and the database refused

**Severity: high. Found against the real deployment; fixed on `commissioning/phase-4-teams-web`
(`ff85fc7`).**

`POST /api/forja/tasks` returned **`500 INTERNAL_ERROR`** for any `taskKind` outside the seven the
schema permits. Observed in the journal:

```
DatabaseError: new row for relation "tasks" violates check constraint "tasks_task_kind_check"
  at apps/server/src/services/tasks.ts:127
  at apps/server/src/http/routes/forja.ts:285
```

**Root cause.** `forjaCreateTaskRequestSchema` published `taskKind` as `z.string().max(40)` and the
route cast it `as never` into `createTask`. Every other plane in this system validates the same
field with `taskKindSchema` — a `z.enum(TASK_KINDS)`. Forja alone defeated the type checker at
exactly the boundary whose job is to refuse, so the value travelled to the `CHECK` constraint on
`tasks.task_kind` and came back as an unhandled `DatabaseError`.

Two things were wrong and only one of them is the status code:

* a client reading the published contract was told any string up to forty characters would do, and
  had no way to discover the real set except by provoking server errors;
* a `500` from a published API says *Mac is broken* when the truth is *you sent something Mac never
  accepted* — the more expensive of the two to diagnose from outside.

**Why 1055 green tests said nothing about it.** The only test that had ever exercised the field —
`forja.test.ts` — sends `taskKind: 'investigation'`, a valid value, in both places it appears. The
free-string schema was never given a string the database would reject.

**Fix:** `taskKind: taskKindSchema.optional()` in the protocol, and the `as never` removed from the
route because there is no longer anything for it to silence. A `ZodError` already maps to
`400 VALIDATION_FAILED`, so the correct status came with the correct schema.

**Regression test** (`forja.test.ts`, "refuses a task kind that is not one of the permitted kinds,
as a validation error") reproduces the production failure locally — asserted red at `500`, green at
`400` after the fix. Full Forja suite: **21 passed**. Typecheck clean across all four packages.

---

## Part D — Acceptance verification against real research

### D.1 The missing-evidence test, run against the real deployment

Part D §19 asks first for proof that the acceptance layer refuses full completion when external
search is disabled. Phase 4 answers that question differently from the way the brief assumes, and
the difference turned out to matter.

`deriveCriteria` **deliberately does not derive an `external_sources` criterion when external
research is unavailable**, and the reasoning beside it is right:

> A criterion that could not possibly be met is not derived at all… it would fail every run for a
> reason the run cannot do anything about — which trains everybody to ignore gaps. Instead the
> unavailability is surfaced where it belongs: as a blocker, at approval time.

So the behaviour to commission was not "does completion fail" but "is the approver told". A task was
created through the real Forja contract on the real deployment, with a description that could hardly
ask more plainly:

> Compare the current Siemens and Rockwell safety PLC families for a new PAC panel build. This needs
> external research: use the vendor documentation for each, and say which firmware versions are
> currently supported.

**Observed** (task `9d5c93b9…`, brief `a65f8de7…`):

```
derived criteria:
  artefact-recommendation     artefact_type   Produce a recommendation
  artefact-markdown_document  artefact_type   Produce a document
  section-assumptions         named_section   Cover "Assumptions" in the written output
  evidence-grounded           evidence_class  Establish at least one finding a reader can check

external_sources criterion derived?          NO
source_class (primary) criterion derived?    NO

occurrences in the brief a human would read:
  "unavailable"     0
  "not configured"  0
  "provider"        0
  "blocker"         0

confidence 0.806  band: autonomous
```

Nothing raised a blocker. Nothing told the approver anything. And the confidence band was
**`autonomous`** — Mac would have run this unattended overnight, produced a document with no source
from outside PAC, satisfied all four criteria and reported **fully complete**.

That is the Phase 4 failure reproduced exactly one layer up. Phase 4 fixed *"the run was never
checked against its brief"*. This is *"the brief asked for something the deployment cannot do, and
nobody said so"*.

### D.2 Defect 3 — research that could not be done was not mentioned to anybody

**Severity: high. Found against the real deployment; fixed on `commissioning/phase-4-teams-web`.**

**Root cause.** `settings.externalResearchEnabled` is read in exactly five places in the codebase:
the schema, the settings service, the research runner, the research tool gate, and
`deriveCriteriaForBrief`. **None of them raises a blocker, and none puts anything in front of an
approver.** The comment promising a blocker at approval time describes behaviour that was never
implemented.

**Fix.** `unmetResearchCapability` in `domain/acceptance.ts` — a pure function returning the
sentence, or `null` when there is nothing to say. It fires on any of the three signals the criterion
itself would have used: an explicit request for external research, a request for a primary source,
or a question `assessCurrency` judges volatile — so "which firmware version is currently supported"
is caught whether or not anybody wrote the word "research".

It does **not** block, and it does not resurrect the unmeetable criterion. It says:

> External research is not available in this deployment, and this brief asks for research outside
> PAC. No acceptance criterion was derived for it, because a criterion no run could ever meet is one
> everybody learns to ignore. Whatever Mac produces here will rest on what he already holds — the
> company context and the project — and not on anything current from outside PAC.

Recorded in the `acceptance.criteria_derived` audit event, returned as `researchGapNote` on the
brief DTO, and rendered into the brief markdown so it survives being read on a phone, on paper, or
pasted into a pull request.

### D.3 Defect 4 — the narrowing note only ever reached a client that does not exist

**Severity: high. Found while fixing defect 3; fixed in the same change.**

`briefNarrowing` is the check Phase 4 built so that commissioning's silent scope reduction — five
deliverables becoming one — would be visible to whoever approved it. Its own doc comment says:

> Surfaced on the task screen and in the approval card.

It is on neither. A search for `briefNarrowing` across the repository returns three call sites: its
definition, `services/forja.ts`, and a test. The Phase 4 completion report states the check is
"shown at approval time and in the Forja brief projection"; only the second half was true.

**Every approval on this deployment today happens in the web UI**, and the human-plane `BriefDto`
carried no such field and no such sentence. So the mechanism built to make a specific past failure
visible would not have made it visible to the only person in a position to act on it.

**Fix.** Both notes are computed together in `briefApprovalNotes` — one query for the two joins they
share — and rendered in `briefDto`, which every reader of a brief goes through. The Forja projection
no longer appends the scope note itself; it reads the same markdown everybody else does, and
additionally exposes `scopeNote` and `researchGapNote` as fields for a client that wants to style
them.

### D.4 Regression tests

| Test | Proves |
|---|---|
| `unit/acceptance.test.ts` — "says so, when external research is unavailable" | the note fires on an explicit research request |
| — "says nothing when the research is available" | and the `external_sources` criterion exists instead |
| — "says nothing about a brief that never wanted anything outside PAC" | no false positives |
| — "notices a question that is volatile even when nobody asked for research in so many words" | the §19 currency path |
| `integration/acceptance.test.ts` — "tells the approver so, when the project has no `external_research` capability" | the note reaches `GET /api/briefs/:id` and the markdown |
| — "tells the approver so, when the deployment setting is off" | both gates, independently |
| — "says nothing when the research can actually be done" | and the criterion is derived instead |
| — "records the gap in the audit trail beside the criteria it could not derive" | it is in `acceptance.criteria_derived` |
| — "puts the narrowing in front of whoever reads the brief, not only a Forja client" | defect 4 |

One of those tests found a trap worth recording for whoever writes the next one: `audit_events` is
trigger-protected against `TRUNCATE`, so `resetDatabase()` leaves every event any earlier test ever
wrote in place. A query filtered on event type alone returns the **oldest** matching row in the
database, which belongs to somebody else's test. Filter on `taskId` as well.

### D.5 What is still blocked in Part D

§19's second half — research **available** and the run producing **zero** external sources, giving
`completed_with_gaps` — needs the commissioned provider. §18 and §20 (the acceptance task with two
named artefacts, two external sources and one primary source) need it too. Both are blocked on the
Brave account.

Also recorded for the operator: the project `PAC Internal Development` currently has capabilities
`["company_context", "internal_only"]`. **Configuring Brave alone will not enable research** — the
project needs the `external_research` capability as well, which is the second of the three gates
Sprint 3.3 built and is a deliberate per-project decision.

### D.6 A smaller finding — the Forja brief projection drops `required`

`structuredAcceptance` is projected as `{ id, kind, description }` only. The stored criteria carry
`required`, `minimum`, `source`, `artefactType` and `section` as well. So a Forja client can read
that a criterion exists and cannot read whether it is required, how many of a thing are wanted, or
whether a human wrote it or Mac derived it — which are the parts a client would need to render an
approval screen honestly.

Not fixed: it is a contract widening rather than a defect, `FORJA_CONTRACT_VERSION` would have to
move, and no Forja client exists yet to be broken by either the gap or the fix. Recorded as
technical debt.
### D.7 A related finding, recorded and deliberately not fixed

The two approval notes now reach the brief, and the brief is rendered in full on the **Discovery**
screen — which is where a person reads what Mac is proposing and where the acceptance criteria are
shown. They do **not** reach the **Inbox** approval card, which renders `title`, `detail`,
`recommendation` and `confidence` from the `approval_requests` row and never loads the brief.

So somebody who approves from the Inbox without opening the brief still sees neither note.

Not fixed here. Carrying the notes onto the approval request would mean either denormalising them
onto a row written at a different time (and going stale when the brief is revised) or having the
Inbox load a brief per card. Both are design decisions rather than defect fixes, and this
commissioning's remit is the smallest robust change. Recorded as technical debt with a
recommendation: the Inbox card should link to the brief and say that criteria and notes live there,
which is a UI change and not a data-model one.

---

## Part F — Conversation summarisation technical debt

Phase 4 records that summarisation is designed and tested at the retrieval end and that nothing
generates a summary. Part F asks whether that is a commissioning blocker.

**It is not.** Measured on the deployment after the Forja and acceptance work above:

| Measure | Value |
|---|---|
| `settings.conversation_summary_threshold` | 24 messages |
| Conversations on the deployment | 1 |
| Longest thread | 3 messages |
| `conversation_summaries` rows | 0 |
| Retrieval tail | 12 messages, bounded by a constant |

No thread is within a factor of five of the threshold, and no behaviour observed during this
commissioning was affected by the absence of a summary. **Recorded as technical debt, not fixed**,
exactly as Part F directs. It should be re-measured once Teams has been in real use for a few
weeks, because a Teams thread with a colleague is the first conversation shape likely to run long.

---

## Part G — Security verification

What could be verified before Teams and the search provider are configured. The rest is recorded as
outstanding rather than assumed.

### G.1 Credentials do not reach the worker — verified on the running process

Read directly from `/proc/<pid>/environ` of the live `mac-worker` process:

```
HOME INVOCATION_ID JOURNAL_STREAM LANG LOGNAME MAC_ALLOW_INSECURE_HTTP MAC_CLAUDE_CLI_PATH
MAC_CONTROL_PLANE_URL MAC_ENROLLMENT_TOKEN MAC_HEARTBEAT_SECONDS MAC_SANDBOX_CREDENTIALS
MAC_SANDBOX_PROVIDER MAC_WORKER_NAME MAC_WORKER_STATE_FILE MAC_WORKER_WORKSPACE
MEMORY_PRESSURE_WATCH MEMORY_PRESSURE_WRITE NODE_ENV PATH SHELL SYSTEMD_EXEC_PID USER
```

Matches for `MAC_TEAMS_*`, `MAC_SEARCH_*`, `ANTHROPIC_API_KEY`, `MONDAY_API_TOKEN`, `MAC_MAIL_*`
and the company-context token: **zero**.

This is structural rather than disciplinary. `mac-worker.service` does not load
`control-plane.env` at all, so there is no configuration mistake that could leak a Teams secret or a
search key into the worker, and none that could leak one into a sandbox — the sandbox plan takes
"values only, never `process.env`".

### G.2 The webhook cannot be bypassed — verified so far as it can be

From off-host against `https://mac.pac-technologies.com.au/api/teams/messages`:

| Request | Response |
|---|---|
| POST, no `Authorization` | `401 TEAMS_REJECTED` |
| POST, `Authorization: Bearer not.a.token` | `401 TEAMS_REJECTED` |

With Teams disabled the handler refuses before it reads a token at all, which is the correct order
and also means **the ten JWT rejection classes cannot yet be exercised against the public endpoint**.
They are covered offline against genuinely signed tokens (`teams.test.ts`), and re-proving them
against the live endpoint is the first thing to do once credentials exist.

### G.3 The service-host allowlist

`TEAMS_SERVICE_HOSTS` contains `smba.trafficmanager.net` — the host every real Teams activity
nominates, and the omission of which was Phase 4's own defect 2. Correctness against **observed real
Microsoft traffic** cannot be claimed until real traffic has been observed, and is recorded as
outstanding.

`isPermittedServiceUrl` requires `https:` and anchors suffix matching on a leading dot, so
`evil-botframework.com` cannot match `botframework.com`. Verified by inspection and by the offline
suite; the value it will be tested against in production is the one already in the list.

### G.4 The Forja plane

Verified live in Part E: an unknown key is refused, a revoked key is refused, keys are stored as
64-character hashes with only a display prefix in the clear, a `read` key cannot write or read
events, and an `approve` action needs a scope distinct from `write`. A Forja key on the human plane
returns `401`.

### G.5 Outstanding until the two integrations are configured

* Microsoft credentials isolated from research sandboxes — the mechanism is verified (G.1); the
  specific credentials do not exist yet.
* Replay and duplicate handling against real Microsoft retries.
* Conversation messages cannot grant prohibited authority — proven offline on every channel; not yet
  proven with a real Teams sender.
* Provider key isolation, injection resistance against real fetched pages, and secrets absent from
  stored evidence — all need the commissioned provider.
---

## Part H — Readiness of the paths that are still blocked

Neither Teams nor web research can be failure-tested against the real third party until each is
configured. What *could* be established beforehand was whether the VM can reach them at all, and
whether the hosts a primary-source test would depend on are reachable the way Mac fetches. Both
turned out to be worth doing before anybody spends money.

### H.1 Egress — the VM can reach everything both integrations need

`iptables -S OUTPUT` has policy `ACCEPT` with only the OCI instance-metadata redirect. Observed from
the VM, HTTPS handshake completing in every case:

| Host | Needed by | Response |
|---|---|---|
| `login.botframework.com` | inbound JWT signing keys | `302` |
| `smba.trafficmanager.net` | outbound Bot Connector replies | `404` |
| `api.search.brave.com` | the recommended search provider | `301` |
| `api.anthropic.com` | the reasoning model (already in use) | `404` |

The status codes are irrelevant — a bare `GET /` on an API host is meant to be a 404 or a redirect.
What they establish is that TLS completed, so nothing between the VM and any of these is blocking.

### H.2 A finding worth having before the primary-source test

Part C §14 asks for proof that Mac prefers an authoritative primary source. `public_doc_fetch` sends
**no browser user-agent** and uses `redirect: 'manual'`, treating **any** 3xx as a hard refusal:

> `${url.hostname} redirected, and a redirect could leave the allowlist. Not followed.`

Probed from the VM with exactly the headers Mac sends:

| URL | Mac's request | Browser user-agent |
|---|---|---|
| `literature.rockwellautomation.com/...1756-rm093_-en-p.pdf` | **200** | — |
| `docs.python.org/3/library/zlib.html` | **200** | — |
| `learn.microsoft.com/en-us/azure/bot-service/channel-connect-teams` | **301** → refused | — |
| `support.industry.siemens.com/cs/document/109478459` | **403** | **403** |
| `www.iso.org/standard/62289.html` | **403** | **403** |

Three separate things, and they need separating:

1. **Siemens and ISO are not fetchable by any server**, browser user-agent or not. Their bot
   protection requires a session a machine does not have. This is not a Mac defect and no
   configuration fixes it. It matters because the Siemens support portal and ISO are exactly the
   primary sources an industrial-automation question wants, so a primary-source test must be built
   around vendors that publish openly — Rockwell's literature library does, and answered `200`.
2. **A canonical vendor URL that 301s to a locale variant is refused outright.** Microsoft Learn is
   the example above, and it is a common pattern. The security reasoning behind not *following*
   redirects is sound; refusing rather than re-validating the redirect target against the same
   allowlist is stricter than the reasoning requires, and will cost real primary sources.
3. **Mac sends no user-agent at all.** Some hosts refuse an unidentified client on principle. An
   honest identifying user-agent — naming Mac and PAC — would be more likely to be served *and*
   more courteous to the sites being read than the current silence.

**Neither 2 nor 3 was changed.** Both are design decisions with a security dimension, this
commissioning has not yet observed Mac failing a real research run on either, and the brief is
explicit that these paths must not be redesigned because configuration is inconvenient. They are
recorded so the primary-source test is designed around what is actually reachable, and so the
decision is taken deliberately rather than discovered at 02:00.

### H.3 What remains untested, and honestly so

| Part H case | State |
|---|---|
| Teams: duplicate inbound event | offline only (`teams.test.ts` posts the same activity three times) |
| Teams: invalid token/signature | offline only, ten rejection classes against real RSA signatures |
| Teams: expired credential | not simulated; will be observable when the Azure secret expiry is set |
| Teams: Microsoft transient failure | offline only |
| Teams: outbound retry/idempotency | offline only (sweeper, dead-letter after six attempts) |
| Search: timeout, rate limit, malformed result, no results | offline only, per provider error shape |
| Search: webpage fetch failure | **partly real** — the 403s and the 301 above are genuine fetch failures against genuine hosts, and Mac's refusal wording for each is the one it will use |

None of these may be reported as commissioned. They are listed so that what is proven and what is
merely tested are not confused with each other.

### H.4 The deployment is ready to receive the Teams credentials

`GET /api/teams/status` on the running deployment, as the operator will see it on the Settings page:

```
state          disabled
enabled        false
missing        ["MAC_TEAMS_APP_ID", "MAC_TEAMS_APP_PASSWORD", "MAC_TEAMS_TENANT_ID"]
identity       Mac Bennett | Automation Engineer
limitation     Microsoft Teams does not permit an application to post as a human user account…
conversations  0    pending 0    failed 0
```

It names the three specific missing keys rather than reporting "Teams is not configured", which is
what `TEAMS_SETUP_REQUIREMENTS` exists for, and it states the identity limitation to the operator
before they assume otherwise. `state` will move `disabled → unconfigured → ready` as the setting is
switched on and the credentials arrive.
