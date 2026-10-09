# pi-grokbot-import

Search and install **Grok Bot templates** into **Pi** (`@earendil-works/pi-coding-agent`), from your terminal or by
just asking Pi ("find me a trading bot and install it").

Templates come from a GitHub **catalog repo** (default: the private `Shixuuu/grokbot-pi-templates`, which holds the
official marketplace bots, the in-app built-in starters, the community bots, and a trading-investing section). Each
install sets up:

| Piece | What happens |
| --- | --- |
| Skills + prompt templates | the template folder is registered with `pi install` (global) or `pi install -l` (project) |
| Persona + memory seeds | `AGENTS.md` + `MEMORY.md` go into a marked block in `APPEND_SYSTEM.md` (removed on uninstall) |
| Connectors | **disabled** stub entries in Pi's `mcp.json` with a note on what to configure (no secrets) |
| Routines | real user **crontab** lines or **systemd `--user` timers** (`--no-schedule` to skip) |
| Routines without a schedule | listed so you can set one: `grokbot schedule <bot> <routine> "<cron>"` |

Share links / marketplace URLs that are not in the catalog still work: they are fetched live (full recipe with a
Cursor login, metadata only without), and the legacy `/import-grokbot` folder import is unchanged.

**Version:** 2.0.0 · Node **≥ 22.19** · Pi **≥ 1.0**

## Quickstart

```bash
# 1. Pi + this extension (tools and /slash commands inside Pi)
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi install git:github.com/Shixuuu/pi-grokbot-import

# 2. The `grokbot` CLI (optional; everything also works from inside Pi)
npm install -g github:Shixuuu/pi-grokbot-import

# 3. Log in. GitHub = read access to the catalog repo. Reuses `gh auth login` / GH_TOKEN if present,
#    otherwise opens the browser via `gh auth login --web`. Cursor is optional (live fetch of non-catalog links).
grokbot login            # GitHub, then offers the Cursor browser login
grokbot status

# 4. Search (no downloads besides the cached catalog index)
grokbot search trading
grokbot search --tag crypto
grokbot search --section official
grokbot search inbox --section builtin
grokbot search --creator @lennysan
grokbot info overheard

# 5. Install (shows the plan, asks before writing anything)
grokbot install overheard                       # global: available in every Pi session
grokbot install frank --scope project           # only in the current project (.pi/)
grokbot install dentrade --dry-run              # preview only
grokbot install coin --no-schedule              # skip cron/systemd
grokbot install https://x.ai/bot/<shareId>      # not in the catalog: live fetch

# 6. Manage
grokbot list-installed
grokbot schedule overheard daily-mention-monitor "0 9 * * 1-5"
grokbot uninstall overheard                     # removes schedules, pi package, persona block, MCP stubs, files
```

Then talk to the bot: `pi` (global install) or `cd <project> && pi` (project install). Routines are prompt templates,
so `/daily-mention-monitor` runs one by hand.

### Talking to Pi

The extension registers tools (`grokbot_search`, `grokbot_info`, `grokbot_install`, `grokbot_uninstall`,
`grokbot_list`), so plain requests work:

```text
find me a trading bot for options and install it
what official Grok Bots are there for recruiting?
install overheard but don't schedule anything
which bots do I have installed? remove dentrade
```

Installs and uninstalls from chat are **two-step**. Pi first shows the plan (files, persona, MCP stubs, and every
cron/systemd entry). In the interactive TUI you get a confirmation dialog. In print/RPC mode the tool returns a
one-time `confirmToken`, and applying needs that token **plus** a new user message after the preview, so the model
cannot approve its own plan in the same turn.

Slash commands (interactive TUI): `/grokbot-search <query> [--tag t] [--section s]`, `/grokbot-info <id>`,
`/grokbot-install <id> [--scope project] [--no-schedule]`, `/grokbot-uninstall <bot>`, `/grokbot-list`,
`/grokbot-status`, `/grokbot-login`.

## Logins

**GitHub (catalog access).** Lookup order: `GH_TOKEN` / `GITHUB_TOKEN` → `gh auth token` (an existing
`gh auth login`) → a token saved by this tool (`~/.pi/agent/grokbot-import/github-token.json`, mode 0600).
`grokbot login github` runs `gh auth login --web` when the GitHub CLI is installed and no login exists.
Fallback: `grokbot login github --token` (reads a fine-grained token with *Contents: read* on the catalog repo from
a hidden prompt or stdin; never printed).

*GitHub device flow (optional).* This package ships **no OAuth client id** of its own and does not borrow another
app's. To get a browser device-code login without the `gh` CLI, create your own GitHub OAuth App
(Settings → Developer settings → OAuth Apps → New; any homepage/callback URL; tick **Enable Device Flow**), then:

```bash
grokbot config set github-client-id <your-client-id>   # or export GROKBOT_GITHUB_CLIENT_ID=...
grokbot login github --device                            # shows a code for github.com/login/device
```

It requests the `repo` scope (needed to read a private repo with an OAuth App token).

**Cursor (optional).** Only for fetching share links that are not in the catalog. Browser PKCE login by default
(`grokbot login cursor` or `/grokbot-cursor-login`); token paste is the fallback (`grokbot login cursor --token` or
`/grokbot-cursor-login-token`). Details below.

## Configuration

| Setting | How |
| --- | --- |
| Catalog repo | `--repo owner/name[@ref]` · `GROKBOT_CATALOG_REPO` · `grokbot config set catalog-repo owner/name` · default `Shixuuu/grokbot-pi-templates@main` |
| Catalog cache | `~/.pi/agent/grokbot-import/catalog-cache/` (24 h; `--refresh` re-downloads, ETag-aware) |
| Pi agent dir | `PI_CODING_AGENT_DIR` (default `~/.pi/agent`) |
| Scheduler | `--scheduler auto|cron|systemd` (auto: systemd `--user` on Linux when available, else crontab) |
| `pi` binary used by schedules | first `pi` on `PATH`, or `GROKBOT_PI_BIN` |
| Test overrides | `GROKBOT_CRONTAB_BIN`, `GROKBOT_SYSTEMCTL_BIN`, `GROKBOT_GH_BIN` |

A catalog repo needs a `catalog.json` at its root (`{templates:[{shareId, slug, name, description, category,
official, builtin, tags, creator, creatorHandle, status, fidelity, skills, routines, path, ...}]}`) and one Pi
package folder per template at `path`.

## Where things go

| | global (default) | `--scope project` |
| --- | --- | --- |
| bot files | `~/.pi/agent/grokbot/bots/<slug>/` | `<project>/.pi/grokbot/<slug>/` |
| package entry | `~/.pi/agent/settings.json` | `<project>/.pi/settings.json` |
| persona block | `~/.pi/agent/APPEND_SYSTEM.md` | `<project>/.pi/APPEND_SYSTEM.md` |
| MCP stubs | `~/.pi/agent/mcp.json` | `<project>/.pi/mcp.json` |
| schedules | crontab / `~/.config/systemd/user/grokbot-<bot>-<routine>.{service,timer}` | same |
| logs | `~/.pi/agent/grokbot-import/logs/<bot>/<routine>.log` | same |
| install ledger | `~/.pi/agent/grokbot-import/installed.json` | same |

Notes:

- Scheduled runs execute `pi -p --approve "/<routine>"` **inside the bot folder**, so each run gets that bot's own
  persona, skills and memory, whatever else is installed. Cron lines end in `# grokbot-import:<bot>:<routine>`, and
  uninstall removes only those lines.
- Times in templates are the creator's local time; cron and systemd use the host's timezone.
- Pi uses only one `APPEND_SYSTEM.md`, and a project file replaces the global one. A second *global* install therefore
  skips the persona by default (pass `--persona` to stack them). `cd ~/.pi/agent/grokbot/bots/<slug> && pi` always
  gives a single bot's persona.
- MCP stubs are `enabled: false` with `command: "configure-me"` and a `_grokbot.note`. Replace the command/url, add
  credentials via `${ENV}` references, then enable. Stubs shared by several bots are removed with the last one, and
  a stub you edited is kept.
- systemd `OnCalendar` is converted from the cron expression. When a cron cannot be expressed (day-of-month **and**
  day-of-week both set, wrap-around ranges), that routine is listed as unscheduled; use `--scheduler cron` for it.

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

Pi has **no built-in cron / routines engine**. `grokbot install` writes real user crontab lines or systemd `--user` timers for routines that carry a schedule; `/import-grokbot` (legacy) only writes `cron/` / `systemd/` sketches.

## Cursor login (live fetch of share links not in the catalog)

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

## Legacy import (share links and bundles into a folder)

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
  scripts/grokbot.mjs       # CLI: login/search/info/install/schedule/list-installed/uninstall/config
  src/extension.ts          # Pi tools + slash commands (catalog and legacy import, Cursor login)
  src/chat-tools.mjs        # tool logic + preview/confirm flow
  src/paths.mjs             # agent dir, config, catalog repo selection
  src/github-auth.mjs       # gh / GH_TOKEN / saved token / device flow (your own client id)
  src/catalog.mjs           # catalog.json fetch + cache, search, per-template download
  src/installer.mjs         # install plan/apply, persona, MCP stubs, ledger, uninstall
  src/scheduler.mjs         # crontab + systemd --user timers with markers
  src/cursor-auth.mjs       # PKCE login, session store, ConnectRPC helpers
  src/fetch-template.mjs    # share URL → bundle (full or metadata)
  src/import-bundle.mjs
  src/schema.mjs
  scripts/import-cli.mjs
  scripts/dry-run.mjs
  test/                     # unit.mjs, e2e-sandbox.sh, mock-llm.mjs, verify-load.mjs, shims/
  fixtures/
  examples/
  README.md
```

## Tests

```bash
npm test             # legacy import dry run (offline + public endpoints)
npm run test:unit    # catalog search/resolve, cron parsing + OnCalendar, crontab add/remove (offline, sandboxed)
npm run test:e2e     # full sandbox: fresh HOME, gh auth reuse, search, installs, Pi load check, chat tools, uninstall
```

`test/e2e-sandbox.sh` never touches the real crontab or systemd: `GROKBOT_CRONTAB_BIN` / `GROKBOT_SYSTEMCTL_BIN` point at
`test/shims/` which write into the sandbox. It drives the Pi tools through a scripted OpenAI-compatible mock model
(`test/mock-llm.mjs`), so no model account is needed.

Legacy `dry-run.mjs` coverage:

- Local Side export/import + rich fixture + schema reject
- URL normalize (share / deep link / marketplace / grokbottemplates)
- Offline AdaptlyPost HTML fixture → metadata-only
- Live public AdaptlyPost + `GetPublicGrokBotTemplate` (no login)
- Cursor auth helpers (PKCE URL, token normalize, session 0600) under a fake `$HOME` — **no real user login**
- Mock `ImportDetails` + `blobGetUrl` → `mode: full` mapping

## License

MIT
