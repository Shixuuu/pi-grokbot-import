/**
 * Pi extension: Grok Bot import + Cursor login for full recipe downloads.
 *
 * Commands:
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
  try {
    if (typeof pi.sendUserMessage === "function") await pi.sendUserMessage(text);
    else console.log(text);
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
}
