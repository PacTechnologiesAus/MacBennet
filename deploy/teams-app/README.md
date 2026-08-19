# Mac Bennett — Microsoft Teams app package

What a person installs in the PAC tenant so that Mac can be talked to in Teams.

Phase 4 built the Teams channel — the JWT-verified inbound endpoint, the Bot Connector outbound
path, the cards — and did not ship a package to install it from. This directory is that package.

## What is here

| File | What it is |
|---|---|
| `manifest.template.json` | The app manifest, schema `v1.30`, with the two ids left as placeholders |
| `make-icons.mjs` | Generates `color.png` (192×192) and `outline.png` (32×32) — committed so the icons are reviewable as code rather than as binaries |
| `color.png`, `outline.png` | The generated icons |
| `build.mjs` | Stamps the ids into the manifest and writes `mac-bennett-teams.zip` |

The built `.zip` is deliberately **not** committed: its `botId` does not exist until somebody
creates the Azure Bot resource, and a placeholder inside a binary is a broken install nobody can
review in a diff.

## Building it

```sh
node deploy/teams-app/build.mjs <bot-app-id>
```

`<bot-app-id>` is the Azure Bot resource's **application (client) ID**. It is not a secret — it is
the bot's public identity and appears in every activity Microsoft sends — so it is safe on a command
line. The **client secret** is not used here and must never be passed to this script.

Optionally pass a second GUID to give the Teams application an id distinct from the bot's. They are
allowed to be the same value.

The archive is byte-for-byte reproducible: entries are stored uncompressed with a fixed timestamp,
so the same inputs always hash the same and "is the installed package the reviewed one?" is a
question a checksum can answer.

## Installing it

1. Teams → **Apps** → **Manage your apps** → **Upload an app** → **Upload a custom app**, and
   choose the built `mac-bennett-teams.zip`. This requires custom app upload to be permitted for
   the uploading account in the tenant's Teams app setup policy.
2. For everyone rather than one person: **Teams admin centre → Teams apps → Manage apps → Upload
   new app**, then allow it in the relevant app permission policy.

The manifest declares both `personal` and `team` scope, so Mac can be a one-to-one chat and can be
added to a channel. Personal scope is the one commissioning exercises first; a channel conversation
is a different conversation as far as Mac is concerned, and gets its own thread.

## What the manifest says about who Mac is

`name.short` is **Mac Bennett** and `description.full` opens by saying Mac is an application and not
a person. That is deliberate and matches `MAC_TEAMS_IDENTITY.limitation` in the protocol package:
Teams gives no mechanism for an application to post as a human user account, and Mac does not
simulate one. A reader must be able to tell that Mac is an agent.

`developer.privacyUrl` and `developer.termsOfUseUrl` currently point at PAC's website root. That
satisfies sideloading, which only requires reachable HTTPS URLs. Publishing to the Teams Store
would require real pages at those addresses; nothing here is submitted to the store.
