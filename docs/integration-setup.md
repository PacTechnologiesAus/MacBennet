# Connecting Mac to the real world

Everything here is optional for development. The standard test suite runs
entirely on fakes and needs none of it, and it must stay that way: normal CI
must never depend on a paid external service.

This document is what Sprint 3.1 commissioning actually learned from configuring
each provider, including the parts that are not in anybody's quickstart.

---

## 1. monday.com

### Getting a token

Your avatar → **Developers** → **My Access Tokens** → copy.

Put it in the repository-root `.env`:

```
MONDAY_API_TOKEN=<token>
```

Nowhere else. It is read by the control plane only: never sent to the worker,
never written to the database, and structurally unable to appear in a sandboxed
agent's environment.

### The header, if you are testing by hand

monday is unusual — a **raw** `Authorization` header, no `Bearer` prefix:

```
Authorization: <token>
API-Version: 2024-10
Content-Type: application/json
```

The API version is pinned in `MondayGraphqlClient` so a server-side bump cannot
silently change how responses are parsed.

### Identity — read this before mapping a board

**monday attributes every write to the user who minted the token.** There is no
"application identity" for the ordinary API: an update Mac posts appears under
that person's name and photograph, and a person column can only hold real users.

Commissioning found no `Mac Bennett` user in the PAC Technologies account, so
during Sprint 3.1 Mac's assignments and updates appeared as **Kasper Simonsen**.
That is recorded rather than papered over, because the alternative — captioning
each update "posted by Mac" — would be a system that lies politely.

To make Mac appear as himself:

1. invite `mac.bennet@pac-technologies.com.au` as a monday.com user (this
   consumes a seat, which is a commercial decision, not a technical one);
2. sign in as Mac and mint the token from **his** profile;
3. put that token in `MONDAY_API_TOKEN`;
4. set `MAC_MONDAY_USER_ID` to his user id, or `macUserId` on the board mapping.

A monday **app** with OAuth is the other route. It would let updates be
attributed to the app rather than to a person, but it does not solve assignment:
a person column still needs a real user. It is also a much larger surface than
the five methods Mac has, and adopting it should be a deliberate decision rather
than a side effect of wanting a nicer avatar.

### Column ids are generated, and yours will not match anyone's

This is the single most likely thing to go wrong. A board created through the UI
gets ids like:

```
Status        color_mm6axkch
Priority      color_mm6a7h81
Owner         multiple_person_mm6atd5q
Due date      date_mm6arc88
Pull Request  link_mm6acy56
Night Shift   boolean_mm6aqx0j
```

Not `status`, not `person`, not `date`. Read the board first
(`get_board` returns `columns { id title type }`) and map by **title**, then
store the ids in the board mapping. Sprint 3.1's commissioning test resolves
them from the live board at run time for exactly this reason.

### Column types Mac's writes expect

| Role | monday column type | What Mac sends |
|---|---|---|
| Status | `status` | `{ "label": "Working on it" }` |
| Assignee | `people` | `{ "personsAndTeams": [{ "id": 123, "kind": "person" }] }` |
| Pull request | `link` | `{ "url": "…", "text": "…" }` |
| Night-shift flag | `checkbox` | read only — its text is `v` when ticked |

The flag is read as **text** and matched narrowly (`v`, `yes`, `true`, `checked`,
`night shift`, `mac`, `ready for mac`). An unrecognised value is not a flag:
an item Mac takes overnight has to have been marked deliberately, and "probably
yes" is not deliberate.

### Status labels must already exist

monday rejects an unknown label with a GraphQL error (HTTP **200** with an
`errors` array, which is why the client checks for that and not just the status
code):

```
This status label doesn't exist, possible statuses are: {0: Working on it, 1: Done, 2: Stuck}
```

Mac's default vocabulary is **Working on it**, **Stuck**, **Awaiting Testing**,
**Done**. Either create those labels on the board, or map Mac's intents onto the
board's own labels via `statusLabels` when you create the mapping. A
misconfiguration here fails loudly and is *not* retried, which is correct — a
refusal retried is a decision retried.

### The two approvals

A board must be **mapped** and separately **approved**, and the project must be
approved for night shift. Mapping is a technical act ("which column is status?");
approving is a decision about whether a machine may take work from it. Collapsing
them would mean configuring the integration silently authorised it.

`mayComplete` is off by default, so **Ready for Review** is Mac's terminal state
until somebody opts a board in.

---

## 2. The mailbox (Microsoft Graph)

Mac sends from a real PAC Technologies mailbox using the **client-credentials**
flow, so there is no signed-in user and no refresh token to babysit.

### Azure / Entra setup

1. **Entra admin centre → App registrations → New registration.**
   Single tenant. No redirect URI — client credentials do not use one.
2. Note the **Directory (tenant) ID** and **Application (client) ID**.
3. **Certificates & secrets → New client secret.** Copy the *value* immediately;
   it is never shown again. Note its expiry — a secret that quietly expires
   turns into "the morning report stopped arriving" some months later.
4. In **Enterprise applications**, open the matching application and note its
   **Object ID**. This is the service-principal object id, not the Object ID on
   the App registrations page.
5. In Exchange Online PowerShell, grant `Application Mail.Send` through
   **Application RBAC**, scoped to Mac's mailbox alone:

   ```powershell
   Connect-ExchangeOnline
   Set-Mailbox mac.bennet@pac-technologies.com.au -CustomAttribute15 "MacBennettMailer"
   New-ServicePrincipal `
     -AppId <application-client-id> `
     -ObjectId <enterprise-application-object-id> `
     -DisplayName "Mac Bennett Mailer"
   New-ManagementScope `
     -Name "Mac Bennett Mailbox Only" `
     -RecipientRestrictionFilter "CustomAttribute15 -eq 'MacBennettMailer'"
   New-ManagementRoleAssignment `
     -Name "Mac Bennett Mail.Send" `
     -App <enterprise-application-object-id> `
     -Role "Application Mail.Send" `
     -CustomResourceScope "Mac Bennett Mailbox Only"
   Test-ServicePrincipalAuthorization `
     -Identity <enterprise-application-object-id> `
     -Resource mac.bennet@pac-technologies.com.au
   ```

   The test result must show `Application Mail.Send` with `InScope: True`.
   Do not also grant an organisation-wide `Mail.Send` application permission
   in Entra: Entra and Exchange grants are additive, so that would defeat the
   mailbox-only scope. Application RBAC replaces legacy Application Access
   Policies for new configurations.

6. Configure:

   ```
   MAC_MAIL_TENANT_ID=<directory id>
   MAC_MAIL_CLIENT_ID=<application id>
   MAC_MAIL_CLIENT_SECRET=<secret value>
   MAC_MAIL_FROM=mac.bennet@pac-technologies.com.au
   ```

7. In **Settings → Reports**, set `mailProvider` to `graph`, add the recipients,
   and set the allowed recipient domains. An address outside the allowlist is
   refused and audited rather than silently dropped.

### What to expect from Graph

`sendMail` answers **202 with an empty body and no message id**. Mac records the
provider message id as `null` rather than inventing one — a fabricated id would
look like proof of delivery in the one table that exists to record whether
delivery happened. Correlate instead on the `x-mac-idempotency-key` header,
which carries `morning-report:<nightShiftId>`.

### Identity

The display name comes from the mailbox, not from Mac's code. Set it on the
Exchange mailbox:

```powershell
Set-Mailbox mac.bennet@pac-technologies.com.au -DisplayName "Mac Bennet"
```

A signature block is deliberately not a feature yet. Sprint 3.1's scope was to
verify identity and delivery, not to build signature management.

---

## 3. The execution sandbox

### Providers

`MAC_SANDBOX_PROVIDER=auto` prefers **bubblewrap** and falls back to **docker**.
Bubblewrap is the production choice: no daemon, identity path mapping, about ten
milliseconds of setup, and ordinary process semantics so cancellation already
works. Docker is the portable fallback and is what a Windows development machine
gets.

`none` attests no containment, and the control plane then withholds coding work
from that worker. It is a development setting, not a way to run coding work
unconfined.

### The agent needs its own credential, and only its own

The sandbox environment is built from **empty** and `HOME` is a tmpfs, so an
agent inside holds nothing unless an administrator says so. Two settings, both
guarded:

```
MAC_SANDBOX_AGENT_ENV=ANTHROPIC_API_KEY
MAC_SANDBOX_CREDENTIALS=/home/mac/.claude/.credentials.json
```

`MAC_SANDBOX_AGENT_ENV` takes variable **names**; the worker reads each one from
its own environment and passes the value in. Naming a credential that belongs to
the worker or the control plane — `MAC_ENROLLMENT_TOKEN`, `DATABASE_URL`,
`MONDAY_API_TOKEN`, `MAC_MAIL_*`, `GITHUB_TOKEN`, and anything with those
prefixes — is refused, and the worker **refuses to start** rather than starting
with a hole. `PATH`, `HOME` and `TMPDIR` are refused twice: by name, and by the
plan builder which ignores them regardless.

Both settings refuse a path that does not exist. Docker would otherwise turn
`-v /typo:/mac/credentials/0:ro` into an empty directory and mount it, producing
an agent that cannot log in and a plan that looks perfectly correct.

### A sandbox image that carries the agent

The default image (`node:22-bookworm-slim`) has node and git but no Claude Code,
so nothing authenticated can run inside it. `scripts/commissioning/Dockerfile.mac-agent`
is the minimum that works:

```bash
docker build -f scripts/commissioning/Dockerfile.mac-agent -t mac-agent:commissioning .
export MAC_SANDBOX_IMAGE=mac-agent:commissioning
```

It carries no credentials. Authentication arrives at run time through the two
settings above.

### If your network inspects TLS

The machine Sprint 3.1 was commissioned on runs AVG Antivirus, which terminates
and re-signs every HTTPS connection with a locally generated root. The host
trusts it; a container does not, so `npm install` inside the image failed with
`UNABLE_TO_VERIFY_LEAF_SIGNATURE` — and so would the agent's own calls to
`api.anthropic.com` once it was running.

Drop the root into `scripts/commissioning/ca/` as a `.crt`. The Dockerfile
trusts it at build time and at run time. That directory is gitignored: those
certificates are machine-local, and committing one would be committing a
statement about somebody's laptop.

### Known limitation: Windows hosts

A Claude Code **subscription** credential cannot be carried from a Windows host
into a Linux container — the credential is held by the operating system rather
than in a mountable file. On Windows, either supply `ANTHROPIC_API_KEY` through
`MAC_SANDBOX_AGENT_ENV`, or run commissioning on the Linux VM, where
`~/.claude/.credentials.json` is a real file and `MAC_SANDBOX_CREDENTIALS` works
as designed.

---

## 4. Running the opt-in tests

None of these run in the standard suite. Each is skipped unless its switch is
set, and each says loudly when it is switched on and cannot run — a skipped
external test that looks green is worse than no test.

```bash
# The standard suite. No credentials, no external services.
npm test

# Real Claude Code CLI. Spends real subscription usage (~6 minutes).
MAC_E2E_REAL_CLAUDE=1 npm run test -w @mac/worker

# Sandbox containment against a real provider. Needs docker or bubblewrap.
npm run test -w @mac/worker -- tests/sandbox-conformance.test.ts

# Real monday.com, five wire-format checks.
MAC_MONDAY_LIVE_TEST=1 \
MAC_MONDAY_TEST_BOARD_ID=<board> \
MAC_MONDAY_TEST_ITEM_ID=<item> \
MAC_MONDAY_TEST_STATUS_COLUMN=<generated column id> \
MAC_MONDAY_TEST_STATUS_LABEL="Working on it" \
  npx vitest run tests/integration/monday-live.test.ts --root apps/server

# Real monday.com, full commissioning: reads, the five writes, the prohibitions,
# board scoping and identity. 33 checks.
MAC_MONDAY_LIVE_TEST=1 \
MAC_MONDAY_TEST_BOARD_ID=<board> \
MAC_MONDAY_UNAPPROVED_BOARD_ID=<other board> \
  npx vitest run tests/integration/monday-commissioning.live.test.ts --root apps/server

# Real mailbox. Sends TWO actual emails to MAC_MAIL_TEST_RECIPIENT.
MAC_MAIL_LIVE_TEST=1 MAC_MAIL_TEST_RECIPIENT=<internal address> \
  npx vitest run tests/integration/mail-commissioning.live.test.ts --root apps/server

# The full commissioning night: real monday, real Claude Code, real pull
# requests, real email. Needs a DISPOSABLE repository. Takes 20–40 minutes.
MAC_COMMISSIONING_NIGHT=1 \
MAC_MONDAY_TEST_BOARD_ID=<board> \
MAC_COMMISSIONING_REPO=https://github.com/<owner>/<disposable-repo>.git \
  npx vitest run tests/e2e/commissioning-night.e2e.test.ts --root apps/server
```

`.env` at the repository root is read by both vitest projects, so the tokens can
live there rather than being pasted onto a command line. An explicit variable on
the command line still wins over the file.

---

## 5. Preparing a commissioning board

The board Sprint 3.1 used has these columns, and the commissioning test asserts
their **titles** while resolving their generated ids:

| Title | Type | Purpose |
|---|---|---|
| Status | status | `Ready for Mac`, `Working on it`, `Stuck`, `Awaiting Testing`, `Done` |
| Priority | status | `Critical` / `High` / `Medium` / `Low`. Mac reads it, never writes it |
| Owner | people | Mac assigns himself here |
| Due date | date | Mac reads it, never writes it |
| Pull Request | link | Where Mac attaches the PR |
| Night Shift | checkbox | A human's explicit clearance for autonomous work |
| Item Type | status | Task / Bug / Feature |
| Size | status | Small / Medium / Large. Beats Mac's own effort inference |
| Depends On | dependency | Blocks starting until dependencies are complete |
| Brief | long text | What the engineer wrote during the day |

Two groups: one Mac is mapped to, and one he is not. Put a high-priority,
correctly-statused, **unflagged** item in the second group. If Mac ever touches
it, the eligibility predicate is wrong, and you want to find that out on a
disposable board rather than on a real one.
