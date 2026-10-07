# pi-grokbot-import

One-command import of a **Grok Bot** into **Pi** (`@earendil-works/pi-coding-agent`).

Builds a portable `grokbot-bundle/v1` from:

1. **Full recipe** — Cursor account session → `GetGrokBotTemplateImportDetails` + recipe blob (skills, routines, memory, plugins)
2. **Metadata-only** — public `GetPublicGrokBotTemplate` / share HTML when not logged in
3. **Local export** — `export-grokbot.mjs` on a box that already Added the bot

**Version:** 1.2.0

## What Pi actually supports (cited)

Sources: [Pi coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md), [extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), [skills.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md), [configuration.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md), [prompt-templates.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/prompt-templates.md), [mcp.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md), [packages.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).

| Mechanism | Where it lives | Notes |
| --- | --- | --- |
| Extensions (TS) | `~/.pi/agent/extensions/`, `.pi/extensions/`, or a Pi package | `export default function (pi) { … }`; `pi.registerCommand`, `pi.registerTool`, … |
| Skills | `~/.pi/agent/skills/`, `.pi/skills/`, … | Directory + `SKILL.md` |
| Prompt templates | `~/.pi/agent/prompts/`, `.pi/prompts/` | Markdown → `/templatename` |
| Agent instructions | `AGENTS.md` / `CLAUDE.md` | Context files |
| System prompt overlays | `SYSTEM.md`, `APPEND_SYSTEM.md` | |
| MCP | `mcp.json`, `pi mcp add`, `pi.registerMcpServer()` | **Pi does support MCP** |
| Packages | `package.json` → `"pi": { "extensions": […] }` | |

Pi has **no built-in cron / routines engine**. Schedules become prompt templates plus optional `cron/` / `systemd/` sketches.

## Install

Needs Node **≥ 22.19** and Pi:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

```bash
# from this directory (or after unzipping pi-grokbot-import.zip)
pi install ./pi-grokbot-import
# one-shot:
pi -e /path/to/pi-grokbot-import
```

## Cursor login (for full share/marketplace import)

Grok Bot templates on `api2.cursor.sh` require a **Cursor session** for the full recipe. This is **not** xAI OAuth.

A **free Cursor account is enough** for public templates; Pro is not required.

### Auth method (why)

Implemented: **Cursor CLI-compatible PKCE browser flow** (`https://cursor.com/loginDeepControl` + poll `https://api2.cursor.sh/auth/poll`), same family as official [`agent login`](https://cursor.com/docs/cli/reference/authentication). Session is stored only under:

```text
~/.pi/agent/grokbot-import/cursor-session.json   # mode 0600
```

`api2.cursor.sh` ConnectRPC calls use `Authorization: Bearer <accessToken>` ([rollouts / API key exchange docs](https://cursor.com/docs/rollouts)). The browser cookie `WorkosCursorSessionToken` is for `cursor.com` web only; if you paste that cookie value, we extract the JWT and store the Bearer token — we do **not** scrape browser cookie databases.

Fallback: paste an access JWT, `WorkosCursorSessionToken` value, or Dashboard **User API key** (`crsr_…` → `/auth/exchange_user_api_key`).

**Never** put real tokens in README examples, commits, or shared logs.

### Commands

```text
/grokbot-cursor-login
/grokbot-cursor-login-token <token>
/grokbot-cursor-status
/grokbot-cursor-logout
```

1. `/grokbot-cursor-login` — opens (or prints) the Cursor login URL; waits until you approve in the browser.
2. If the browser flow fails (headless host, timeout): create a User API key in the Cursor Dashboard, or copy the session JWT / `WorkosCursorSessionToken` value from DevTools, then run `/grokbot-cursor-login-token …` (the value is not echoed back).
3. `/grokbot-cursor-status` — logged in or not (redacted email only; **no secret echo**).
4. `/grokbot-cursor-logout` — deletes the session file.

Set `NO_OPEN_BROWSER=1` to always print the URL without spawning a browser.

## Usage

### Import a share / marketplace link

```text
/grokbot-cursor-login
/import-grokbot https://x.ai/bot/1GpK7CoPs4e_M__9rb3uR
/import-grokbot https://x.ai/bot/1GpK7CoPs4e_M__9rb3uR?ref=grokbottemplates.app
/import-grokbot grokbot://app/v1/bot-template?id=1GpK7CoPs4e_M__9rb3uR
/import-grokbot https://x.ai/bot/marketplace/bots/seed-a91e4c
/import-grokbot https://grokbottemplates.app/t/adaptlypost
```

When logged in, import uses:

1. `POST /aiserver.v1.GrokBotService/GetGrokBotTemplateImportDetails` `{ "shareId" }`
2. `GET blobGetUrl` with `redirect: error` semantics → CreateBotShareJson-style recipe JSON
3. Map to `grokbot-bundle/v1` with `mode: full`

When not logged in (or API returns `ERROR_NOT_LOGGED_IN` / 401), falls back to public metadata (`GetPublicGrokBotTemplate` or HTML) with `mode: metadata-only` and says so in the report.

### Import a local bundle / CLI

```text
/import-grokbot ./examples/side.grokbot.json --out ./imported-bots/side --force
```

```bash
node scripts/import-cli.mjs https://x.ai/bot/1GpK7CoPs4e_M__9rb3uR --out ./imported-bots/adaptlypost --force
node scripts/import-cli.mjs ./examples/side.grokbot.json --out ./imported-bots/side --force
```

### Export from a Grok Bot box (alternative full path)

```bash
node export-grokbot.mjs <agentId> --out ./my-bot.grokbot.json
```

Secrets are never included.

### Run the imported bot

```bash
cd imported-bots/side
pi
```

## Confirmed Cursor APIs

Base: `https://api2.cursor.sh` (ConnectRPC JSON, `Content-Type: application/json`, `Connect-Protocol-Version: 1`)

| RPC | Auth | Body | Returns |
| --- | --- | --- | --- |
| `GrokBotService/GetPublicGrokBotTemplate` | none | `{"shareId":"<21-char id>"}` | name, description, blobObjectKey, activeVersion, ownerDisplayName |
| `GrokBotService/GetGrokBotTemplateImportDetails` | Bearer session | `{"shareId":"…"}` | `blobGetUrl` + template metadata; **401 `ERROR_NOT_LOGGED_IN`** if unauthenticated |

This package does **not** call `CreateBotShareJson`.

## Bundle schema (`grokbot-bundle/v1`)

```json
{
  "format": "grokbot-bundle/v1",
  "exportedAt": "ISO-8601",
  "source": {
    "platform": "grok-bot",
    "kind": "xai-share",
    "id": "…",
    "url": "https://x.ai/bot/…",
    "mode": "full | metadata-only",
    "importSource": "GetGrokBotTemplateImportDetails"
  },
  "persona": { "name": "…", "title": "", "description": "…", "avatarShape": "", "avatarColor": "" },
  "memories": [{ "kind": "profile"|"log", "text": "…" }],
  "skills": [{ "name": "slug", "description": "…", "body": "…" }],
  "routines": [{ "name": "slug", "schedule": "…", "prompt": "…" }],
  "plugins": [{ "id": "…", "note": "…" }],
  "omitted": ["…"]
}
```

Recipe blob fields mapped from ImportDetails: `profile`, `memory`, `skills[{name,description?,content}]`, `routines[{slug,name?,description,content}]`, `plugins[{pluginId,…}]`, optional `gettingStarted`.

### Mapping into Pi

| Bundle field | Written as |
| --- | --- |
| `persona` | `AGENTS.md` + `.pi/APPEND_SYSTEM.md` |
| `memories` | `NOTES.md` |
| `skills` | `.pi/skills/<name>/SKILL.md` |
| `routines` | `.pi/prompts/<name>.md` + `cron/` + `systemd/` sketches |
| `plugins` | Listed in `IMPORT_REPORT.md` only |

## What does **not** transfer

| Grok Bot capability | Status |
| --- | --- |
| Persona / voice | Imported (full or metadata description) |
| Memories | Imported when present in full recipe / local export |
| Skills / routines | Imported on full path |
| Cron engine | Partial — prompt + OS sketches only |
| Event listeners | **Not transferred** |
| Marketplace plugins / MCP | Names/hints only — reconnect with `pi mcp add` |
| Shared **box computer** / browser desktop | **Not transferred** |
| Built-in X / Grok data tools | **Not transferred** |
| **Channels** / send-on-behalf | **Not transferred** |
| **Connector secrets** / tokens | **Excluded on purpose** |
| Team multi-bot wake | **Not transferred** |

## Layout

```
pi-grokbot-import/
  package.json
  export-grokbot.mjs
  src/extension.ts          # /import-grokbot + Cursor login commands
  src/cursor-auth.mjs       # PKCE login, session store, ConnectRPC helpers
  src/fetch-template.mjs    # share URL → bundle (full or metadata)
  src/import-bundle.mjs
  src/schema.mjs
  scripts/import-cli.mjs
  scripts/dry-run.mjs
  fixtures/
  examples/
  README.md
```

## Tests

```bash
npm test
# or
node scripts/dry-run.mjs
```

Coverage:

- Local Side export/import + rich fixture + schema reject
- URL normalize (share / deep link / marketplace / grokbottemplates)
- Offline AdaptlyPost HTML fixture → metadata-only
- Live public AdaptlyPost + `GetPublicGrokBotTemplate` (no login)
- Cursor auth helpers (PKCE URL, token normalize, session 0600) under a fake `$HOME` — **no real user login**
- Mock `ImportDetails` + `blobGetUrl` → `mode: full` mapping

## License

MIT
