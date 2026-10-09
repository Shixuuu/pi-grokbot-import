/**
 * Pi extension: Grok Bot import + Cursor login for full recipe downloads.
 *
 * Catalog (private GitHub repo, default Shixuuu/grokbot-pi-templates):
 * - tools: grokbot_search, grokbot_info, grokbot_install, grokbot_uninstall, grokbot_list
 * - commands: /grokbot-search, /grokbot-info, /grokbot-install, /grokbot-uninstall, /grokbot-list,
 *             /grokbot-status, /grokbot-login
 *
 * Legacy import commands:
 * - /import-grokbot <path-or-url> [--out dir] [--force]
 * - /grokbot-cursor-login
 * - /grokbot-cursor-login-token <token>
 * - /grokbot-cursor-logout
 * - /grokbot-cursor-status
 *
 * Citations:
 * - Pi extensions: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
 * - Cursor CLI auth: https://cursor.com/docs/cli/reference/authentication
 * - api2 Bearer + exchange_user_api_key: https://cursor.com/docs/rollouts
 * - PKCE loginDeepControl + /auth/poll (same as Cursor CLI / SDK login-flow)
 */

import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { importGrokBotBundle } from "./import-bundle.mjs";
import { toBotSlug } from "./schema.mjs";
import { loadBundleFromSource } from "./fetch-template.mjs";
import {
  loginWithBrowser,
  loginWithPastedToken,
  clearSession,
  getSessionStatus,
  sessionPath,
} from "./cursor-auth.mjs";
import { toolSearch, toolInfo, toolInstall, toolUninstall, toolList, statusText } from "./chat-tools.mjs";
import { githubStatus, loginGitHub, githubClientId } from "./github-auth.mjs";

async function readBundle(source: string, baseDir?: string) {
  return loadBundleFromSource(source, { baseDir: baseDir || process.cwd() });
}

function parseCommandArgs(args: string) {
  const tokens = args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const cleaned = tokens.map((t) => t.replace(/^["']|["']$/g, ""));
  let source = "";
  let out: string | undefined;
  let force = false;
  for (let i = 0; i < cleaned.length; i++) {
    const t = cleaned[i];
    if (t === "--out") out = cleaned[++i];
    else if (t === "--force") force = true;
    else if (!source) source = t;
  }
  return { source, out, force };
}

async function say(pi: ExtensionAPI, ctx: any, text: string) {
  // Display-only message: shows output in the transcript without starting a model turn.
  try {
    if (typeof (pi as any).sendMessage === "function") {
      await (pi as any).sendMessage({ customType: "grokbot", content: text, display: true });
    } else console.log(text);
  } catch {
    console.log(text);
  }
  if (ctx?.hasUI && ctx.ui?.notify) {
    try {
      ctx.ui.notify(text.split("\n")[0].slice(0, 120), "info");
    } catch {
      /* ignore */
    }
  }
}

function splitArgs(args: string) {
  const tokens = String(args || "").match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const pos: string[] = [];
  const flags: Record<string, any> = {};
  const cleaned = tokens.map((t) => t.replace(/^["']|["']$/g, ""));
  for (let i = 0; i < cleaned.length; i++) {
    const t = cleaned[i];
    if (t.startsWith("--")) {
      const k = t.slice(2);
      if (["scope", "scheduler", "section", "category", "tag", "creator", "limit", "name"].includes(k)) flags[k] = cleaned[++i];
      else flags[k] = true;
    } else pos.push(t);
  }
  return { pos, flags };
}

const resultText = (r: any) => (r?.content || []).map((c: any) => c.text).join("\n");

function summarize(bundle: any, result: any) {
  const mode = bundle.source?.mode || (bundle.source?.kind === "xai-share" ? "metadata-only" : "full");
  const lines = [
    `Imported **${bundle.persona.name}** → \`${result.outDir}\``,
    "",
    `- mode: \`${mode}\``,
    `- Memories: ${result.imported.memories}`,
    `- Skills: ${result.imported.skills}`,
    `- Routines: ${result.imported.routines}`,
    `- Plugin hints: ${result.imported.pluginsNoted}`,
    "",
    `Full report: \`${result.reportPath}\``,
    "",
    "```bash",
    `cd ${result.outDir} && pi`,
    "```",
  ];
  if (mode === "metadata-only") {
    lines.push(
      "",
      "This was a **metadata-only** import (public metadata / no usable Cursor session).",
      "For the full recipe (skills, routines, memory, plugins):",
      "",
      "```text",
      "/grokbot-cursor-login",
      `/import-grokbot ${bundle.source?.url || "<share-url>"} --force`,
      "```",
      "",
      "A **free Cursor account** is enough for public templates. Or Add in Grok Bot + `export-grokbot.mjs`.",
    );
    const ci = bundle.source?.cursorImport;
    if (ci && !ci.attempted) {
      lines.push("", "_No Cursor session on disk — login first for full import._");
    } else if (ci?.reason === "not-logged-in") {
      lines.push("", "_Cursor API returned ERROR_NOT_LOGGED_IN — session expired; login again._");
    }
  } else {
    lines.push(
      "",
      "Not transferred: shared box/browser, built-in X data, Grok channels, connector secrets.",
      "Pi supports MCP via mcp.json / `pi mcp add` / registerMcpServer — re-add connectors yourself.",
    );
  }
  return lines.join("\n");
}

function statusMessage() {
  const st = getSessionStatus();
  if (!st.loggedIn) {
    return [
      "**Cursor session:** not logged in",
      "",
      `Store path: \`${sessionPath()}\` (mode 0600 when present)`,
      "",
      "Sign in (free Cursor account is enough for public templates):",
      "",
      "```text",
      "/grokbot-cursor-login",
      "```",
      "",
      "Or paste a session token / User API key (never commit it):",
      "",
      "```text",
      "/grokbot-cursor-login-token <token>",
      "```",
    ].join("\n");
  }
  return [
    "**Cursor session:** logged in",
    "",
    `- auth method: \`${st.authMethod}\``,
    `- account: ${st.emailRedacted || "(email not in token)"}`,
    `- access token expired: **${st.expired ? "yes — refresh or re-login" : "no"}**`,
    `- expires (approx): ${st.expiresAt}`,
    `- store: \`${st.path}\``,
    "",
    "Secrets are not printed. Use `/grokbot-cursor-logout` to clear.",
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("import-grokbot", {
    description:
      "Import a Grok Bot bundle JSON or share/marketplace link into a Pi agent folder (full recipe when Cursor-logged-in)",
    handler: async (args: string, ctx: any) => {
      const parsed = parseCommandArgs(args || "");
      if (!parsed.source) {
        throw new Error(
          "Usage: /import-grokbot <path-or-share-url> [--out dir] [--force]\n" +
            "Examples:\n" +
            "  /import-grokbot ./bot.grokbot.json\n" +
            "  /import-grokbot https://x.ai/bot/1GpK7CoPs4e_M__9rb3uR\n" +
            "  /import-grokbot https://x.ai/bot/marketplace/bots/seed-a91e4c\n" +
            "Tip: /grokbot-cursor-login first for full recipe import.",
        );
      }
      const bundle = await readBundle(parsed.source, ctx.cwd || process.cwd());
      const slug = toBotSlug(bundle.persona.name);
      const defaultOut = path.join(ctx.cwd || process.cwd(), "imported-bots", slug);
      const outDir = parsed.out ? path.resolve(ctx.cwd || process.cwd(), parsed.out) : defaultOut;
      const result = importGrokBotBundle(bundle, { outDir, force: parsed.force });
      await say(pi, ctx, summarize(bundle, result));
    },
  });

  pi.registerCommand("grokbot-cursor-login", {
    description:
      "Sign into Cursor (browser PKCE, same family as `agent login`) so /import-grokbot can download full templates",
    handler: async (_args: string, ctx: any) => {
      await say(
        pi,
        ctx,
        "Starting Cursor browser login (PKCE / loginDeepControl)…\n" +
          "A free Cursor account is enough for public Grok Bot templates.\n" +
          "If the browser does not open, copy the URL below. Tokens are never echoed.",
      );
      try {
        const { status, loginUrl, opened } = await loginWithBrowser({
          openBrowser: true,
          onLoginUrl: async (url: string) => {
            await say(
              pi,
              ctx,
              [
                opened === false ? "Open this URL in a browser and approve the login:" : "Login URL (also opened if possible):",
                "",
                url,
                "",
                "Waiting for approval… (or cancel and use `/grokbot-cursor-login-token <token>`)",
              ].join("\n"),
            );
          },
        });
        await say(
          pi,
          ctx,
          [
            "**Cursor login OK**",
            "",
            `- auth method: \`${status.authMethod}\``,
            `- account: ${status.emailRedacted || "(email not in token)"}`,
            `- store: \`${status.path}\` (0600)`,
            "",
            "Next:",
            "```text",
            "/import-grokbot https://x.ai/bot/<shareId>",
            "```",
          ].join("\n"),
        );
      } catch (err: any) {
        await say(
          pi,
          ctx,
          [
            `**Cursor login failed:** ${err?.message || err}`,
            "",
            "Fallback — paste a Cursor access JWT, `WorkosCursorSessionToken` value, or Dashboard User API key:",
            "",
            "```text",
            "/grokbot-cursor-login-token <token>",
            "```",
            "",
            "How to get a token without scraping DBs:",
            "1. Run `agent login` (Cursor CLI) elsewhere, or sign in at cursor.com",
            "2. From Dashboard → API Keys, create a **User API key**, or copy the session JWT from DevTools Application → Cookies → `WorkosCursorSessionToken` (value only)",
            "3. Paste via the command above (do not put secrets in README or chat logs you will share)",
          ].join("\n"),
        );
      }
    },
  });

  pi.registerCommand("grokbot-cursor-login-token", {
    description:
      "Store a pasted Cursor access JWT, WorkosCursorSessionToken, or User API key for template import (not echoed)",
    handler: async (args: string, ctx: any) => {
      const token = String(args || "").trim();
      if (!token) {
        throw new Error(
          "Usage: /grokbot-cursor-login-token <access-jwt|WorkosCursorSessionToken|crsr_api_key>\n" +
            "The token is written to ~/.pi/agent/grokbot-import/cursor-session.json (0600) and never printed back.",
        );
      }
      const status = await loginWithPastedToken(token);
      await say(
        pi,
        ctx,
        [
          "**Cursor token stored** (value not echoed)",
          "",
          `- auth method: \`${status.authMethod}\``,
          `- account: ${status.emailRedacted || "(email not in token)"}`,
          `- store: \`${status.path}\``,
          "",
          "Check with `/grokbot-cursor-status`. Import with `/import-grokbot <share-url>`.",
        ].join("\n"),
      );
    },
  });

  pi.registerCommand("grokbot-cursor-logout", {
    description: "Clear the stored Cursor session used for Grok Bot template import",
    handler: async (_args: string, ctx: any) => {
      clearSession();
      await say(pi, ctx, `Logged out. Removed \`${sessionPath()}\` if it existed.`);
    },
  });

  pi.registerCommand("grokbot-cursor-status", {
    description: "Show whether a Cursor session is stored for Grok Bot import (no secrets)",
    handler: async (_args: string, ctx: any) => {
      await say(pi, ctx, statusMessage());
    },
  });

  pi.registerTool({
    name: "import_grokbot",
    label: "Import Grok Bot",
    description:
      "Import a grokbot-bundle/v1 JSON/URL or a Grok Bot share/marketplace link into a Pi agent folder. When a Cursor session is stored (~/.pi/agent/grokbot-import/cursor-session.json), uses GetGrokBotTemplateImportDetails for a full recipe; otherwise metadata-only.",
    parameters: Type.Object({
      source: Type.String({
        description:
          "Path, https bundle URL, https://x.ai/bot/{id}, marketplace bots/{slug}, grokbot:// deep link, or grokbottemplates.app/t/{slug}",
      }),
      outDir: Type.Optional(Type.String({ description: "Output directory" })),
      force: Type.Optional(Type.Boolean({ description: "Overwrite non-empty output directory" })),
    }),
    async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const bundle = await readBundle(params.source, ctx.cwd || process.cwd());
      const slug = toBotSlug(bundle.persona.name);
      const defaultOut = path.join(ctx.cwd || process.cwd(), "imported-bots", slug);
      const outDir = params.outDir
        ? path.resolve(ctx.cwd || process.cwd(), params.outDir)
        : defaultOut;
      const result = importGrokBotBundle(bundle, { outDir, force: Boolean(params.force) });
      const mode = bundle.source?.mode || "full";
      return {
        content: [
          {
            type: "text",
            text: `Imported ${bundle.persona.name} → ${result.outDir}\nmode=${mode} memories=${result.imported.memories} skills=${result.imported.skills} routines=${result.imported.routines}\nreport=${result.reportPath}`,
          },
        ],
        details: { ...result.imported, mode },
      };
    },
  });

  // ---------------- catalog: tools the model can call ----------------
  pi.registerTool({
    name: "grokbot_search",
    label: "Search Grok Bot templates",
    description:
      "Search the Grok Bot template catalog (official marketplace, built-in starters, community, trading-investing) by free text and filters. Read-only; downloads nothing but the cached catalog index.",
    promptSnippet: "grokbot_search: find Grok Bot templates to install into Pi",
    promptGuidelines: [
      "When the user asks to find, browse, or install a Grok Bot / bot template, call grokbot_search first and show the best few matches (slug, section, one-liner, skill/routine counts).",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Free text: matches name, description, category, section, tags, creator" })),
      section: Type.Optional(Type.String({ description: "official | builtin | community" })),
      category: Type.Optional(Type.String({ description: "Category, e.g. trading-investing, personal-admin" })),
      tag: Type.Optional(Type.String({ description: "Tag, e.g. trading, stocks, crypto, options, macro, earnings, portfolio, other-markets" })),
      creator: Type.Optional(Type.String({ description: "Creator name or @handle" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10, max 50)" })),
      refresh: Type.Optional(Type.Boolean({ description: "Re-download the catalog index" })),
    }),
    annotations: { readOnlyHint: true },
    async execute(_id: string, params: any) {
      return toolSearch(params);
    },
  } as any);

  pi.registerTool({
    name: "grokbot_info",
    label: "Grok Bot template details",
    description: "Show details for one catalog template (by slug, shareId, or section path) and whether it is installed. Read-only.",
    parameters: Type.Object({ id: Type.String({ description: "slug, shareId, x.ai/bot URL, or section path like community/trading-investing/trading" }) }),
    annotations: { readOnlyHint: true },
    async execute(_id: string, params: any) {
      return toolInfo(params);
    },
  } as any);

  pi.registerTool({
    name: "grokbot_install",
    label: "Install Grok Bot template",
    description:
      "Install a Grok Bot template into Pi: downloads only that template, registers skills/prompts with `pi install`, adds the persona + memory, adds disabled MCP stubs for its connectors, and (unless schedule=false) writes cron or systemd --user schedules for routines. Two-step: the first call returns a plan; apply only after the user explicitly approves.",
    promptGuidelines: [
      "grokbot_install without confirmed returns a plan. Show the plan to the user (especially schedules that will be written to cron/systemd) and wait for an explicit yes in a NEW user message before calling again with confirmed: true and the confirmToken. Never confirm on the user's behalf.",
      "Use scope 'project' only when the user wants the bot in the current project; default is global.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Catalog slug, shareId, section path, or an x.ai/bot share link (fetched live if not in the catalog)" }),
      scope: Type.Optional(Type.String({ description: "global (default) or project" })),
      schedule: Type.Optional(Type.Boolean({ description: "Write cron/systemd schedules for routines (default true)" })),
      scheduler: Type.Optional(Type.String({ description: "auto (default) | cron | systemd" })),
      persona: Type.Optional(Type.Boolean({ description: "Add the persona + memory to APPEND_SYSTEM.md (default: project yes; global only if no other bot persona)" })),
      mcp: Type.Optional(Type.Boolean({ description: "Add disabled MCP stubs for the template's connectors (default true)" })),
      name: Type.Optional(Type.String({ description: "Install under a different name" })),
      confirmed: Type.Optional(Type.Boolean({ description: "Set true ONLY after the user approved the previewed plan" })),
      confirmToken: Type.Optional(Type.String({ description: "Token returned by the preview call" })),
    }),
    annotations: { destructiveHint: true },
    async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      return toolInstall(params, ctx);
    },
  } as any);

  pi.registerTool({
    name: "grokbot_uninstall",
    label: "Uninstall Grok Bot template",
    description:
      "Remove an installed Grok Bot template: its cron/systemd schedules, pi package, persona block, unused MCP stubs, and files. Two-step like grokbot_install.",
    parameters: Type.Object({
      id: Type.String({ description: "Installed bot id or name (see grokbot_list)" }),
      confirmed: Type.Optional(Type.Boolean({ description: "Set true ONLY after the user approved" })),
      confirmToken: Type.Optional(Type.String({ description: "Token returned by the preview call" })),
    }),
    annotations: { destructiveHint: true },
    async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      return toolUninstall(params, ctx);
    },
  } as any);

  pi.registerTool({
    name: "grokbot_list",
    label: "List installed Grok Bots",
    description: "List Grok Bot templates installed by pi-grokbot-import, with their schedules.",
    parameters: Type.Object({}),
    annotations: { readOnlyHint: true },
    async execute() {
      return toolList();
    },
  } as any);

  // ---------------- catalog: slash commands ----------------
  pi.registerCommand("grokbot-search", {
    description: "Search Grok Bot templates: /grokbot-search <query> [--section s] [--category c] [--tag t] [--creator x] [--limit n]",
    handler: async (args: string, ctx: any) => {
      const { pos, flags } = splitArgs(args);
      await say(pi, ctx, resultText(await toolSearch({ query: pos.join(" "), ...flags })));
    },
  });

  pi.registerCommand("grokbot-info", {
    description: "Show a Grok Bot template: /grokbot-info <slug|shareId>",
    handler: async (args: string, ctx: any) => {
      await say(pi, ctx, resultText(await toolInfo({ id: String(args || "").trim() })));
    },
  });

  pi.registerCommand("grokbot-install", {
    description:
      "Install a Grok Bot template: /grokbot-install <slug|shareId|url> [--scope project] [--no-schedule] [--scheduler cron|systemd] [--no-persona] [--no-mcp]",
    handler: async (args: string, ctx: any) => {
      const { pos, flags } = splitArgs(args);
      if (!pos[0]) throw new Error("Usage: /grokbot-install <slug|shareId|url> [--scope project] [--no-schedule]");
      const r = await toolInstall(
        {
          id: pos[0],
          scope: flags.scope,
          schedule: flags["no-schedule"] ? false : undefined,
          scheduler: flags.scheduler,
          persona: flags["no-persona"] ? false : flags.persona ? true : undefined,
          mcp: flags["no-mcp"] ? false : undefined,
          name: flags.name,
        },
        ctx,
      );
      await say(pi, ctx, resultText(r));
    },
  });

  pi.registerCommand("grokbot-uninstall", {
    description: "Uninstall a Grok Bot template (removes its schedules): /grokbot-uninstall <bot>",
    handler: async (args: string, ctx: any) => {
      await say(pi, ctx, resultText(await toolUninstall({ id: String(args || "").trim() }, ctx)));
    },
  });

  pi.registerCommand("grokbot-list", {
    description: "List installed Grok Bot templates and their schedules",
    handler: async (_args: string, ctx: any) => {
      await say(pi, ctx, resultText(await toolList()));
    },
  });

  pi.registerCommand("grokbot-status", {
    description: "Show catalog repo, GitHub + Cursor login state, and installed bots (no secrets)",
    handler: async (_args: string, ctx: any) => {
      await say(pi, ctx, await statusText());
    },
  });

  pi.registerCommand("grokbot-login", {
    description: "Log in for the template catalog (GitHub) and live fetches (Cursor): /grokbot-login [github|cursor]",
    handler: async (args: string, ctx: any) => {
      const which = String(args || "").trim() || "github";
      if (which === "cursor") {
        await say(pi, ctx, "Use /grokbot-cursor-login (browser) or /grokbot-cursor-login-token <token> (fallback).");
        return;
      }
      const st = await githubStatus();
      if (st.loggedIn) {
        await say(pi, ctx, `GitHub: already logged in as ${st.login} (via ${st.source}). Catalog access is ready.`);
        return;
      }
      if (githubClientId()) {
        await say(pi, ctx, "Starting GitHub device login…");
        const r = await loginGitHub({
          mode: "device",
          interactive: false,
          onCode: async ({ verificationUri, userCode }: any) =>
            say(pi, ctx, `Open ${verificationUri} and enter code **${userCode}** (waiting…)`),
        });
        await say(pi, ctx, `GitHub: logged in as ${r.login || "?"}`);
        return;
      }
      await say(
        pi,
        ctx,
        [
          "GitHub login needed for the private template catalog. Pick one:",
          "",
          "- In a terminal: `gh auth login --web` (or `grokbot login github`), then run /grokbot-status",
          "- In Pi: `!gh auth login --web`",
          "- Or start Pi with `GH_TOKEN=<fine-grained token with Contents: read on the catalog repo>`",
          "- Or `grokbot login github --token` and paste the token (stored 0600, never printed)",
        ].join("\n"),
      );
    },
  });
}
