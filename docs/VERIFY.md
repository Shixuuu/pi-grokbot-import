# E2E verification (2026-10-07, Asia/Singapore)

**Package:** pi-grokbot-import v1.2.0  
**Pi:** `@earendil-works/pi-coding-agent` 1.0.4  
**Node:** v22.20.0

## Proven

| Check | Result |
| --- | --- |
| `pi install` + `pi list` | PASS |
| Live AdaptlyPost share import (`https://x.ai/bot/1GpK7CoPs4e_M__9rb3uR`) | PASS |
| `AGENTS.md` persona written | PASS |
| `IMPORT_REPORT.md` mode | **metadata-only** (expected without Cursor session) |
| Getting-started skill stub | PASS |
| `node scripts/dry-run.mjs` | `DRY-RUN PASSED` (incl. live AdaptlyPost + public API) |
| Mock ImportDetails + blob → `mode: full` mapping | PASS (unit/mock only) |
| Cursor PKCE helpers (URL, session 0600, token normalize) | PASS under fake `$HOME` |

## Not proven yet

| Check | Status |
| --- | --- |
| Live `/grokbot-cursor-login` (PKCE browser) | Blocked — Cloudflare “Verify you are human” on `authenticator.cursor.sh` could not be completed from the agent box |
| Live `GetGrokBotTemplateImportDetails` + `blobGetUrl` full recipe | Blocked on Cursor session (depends on login above) |

Full recipe path is implemented (`src/cursor-auth.mjs` + `tryCursorImportDetails`); it needs a Cursor session from a browser that can pass Cloudflare (or `/grokbot-cursor-login-token` with a User API key / session JWT).

## Commands used

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi install .
node scripts/import-cli.mjs https://x.ai/bot/1GpK7CoPs4e_M__9rb3uR --out /tmp/adaptlypost --force
node scripts/dry-run.mjs
```
