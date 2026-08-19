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

