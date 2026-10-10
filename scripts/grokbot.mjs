#!/usr/bin/env node
/**
 * grokbot — search and install Grok Bot templates from the catalog repo into Pi.
 * Run `grokbot help` for usage.
 */
import readline from "node:readline";
import path from "node:path";
import { loadCatalog, searchCatalog, formatRow, resolveTemplate, sectionOf } from "../src/catalog.mjs";
import { catalogRepo, writeConfig, readConfig, configPath, stateDir } from "../src/paths.mjs";
import { githubStatus, loginGitHub, saveGitHubToken, clearGitHubToken, githubUser } from "../src/github-auth.mjs";
import { loginWithBrowser, loginWithPastedToken, clearSession, getSessionStatus } from "../src/cursor-auth.mjs";
import { planInstall, formatPlan, applyInstall, discardPlan, listInstalled, uninstall, findInstalled, formatUninstallPlan, addSchedule } from "../src/installer.mjs";

const HELP = `grokbot — Grok Bot templates for Pi

Usage:
  grokbot login [github|cursor] [--token] [--device]   Optional (catalog is public). Web login; --token reads stdin
  grokbot logout [github|cursor]
  grokbot status
  grokbot search [query] [--section official|builtin|community] [--category c] [--tag t]
                 [--creator name] [--limit n] [--refresh] [--json]
  grokbot info <slug|shareId|url> [--json]
  grokbot install <slug|shareId|url> [--scope global|project] [--project dir] [--no-schedule]
                 [--scheduler auto|cron|systemd] [--persona|--no-persona] [--no-mcp]
                 [--name n] [--dry-run] [--yes] [--force]
  grokbot schedule <installed-bot> <routine> "<M H DOM MON DOW>" [--scheduler ...]
  grokbot list-installed [--json]
  grokbot uninstall <installed-bot> [--dry-run] [--yes] [--keep-files]
  grokbot config [get | set catalog-repo owner/name[@ref] | set github-client-id <id> | unset <key>]

Global options: --repo owner/name[@ref]  (catalog repo; default ${catalogRepo().repo}; env GROKBOT_CATALOG_REPO)

Share links / marketplace URLs that are not in the catalog are fetched live
(full recipe with \`grokbot login cursor\`, otherwise metadata only).
The legacy importer is still available as \`grokbot-import <bundle|url> --out dir\`.`;

function parseArgs(argv) {
  const pos = [];
  const f = {};
  const bool = new Set(["refresh", "json", "dry-run", "yes", "y", "force", "no-schedule", "persona", "no-persona", "no-mcp", "keep-files", "token", "device", "dead", "help", "h"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") || (a.startsWith("-") && a.length === 2)) {
      const [k, v] = a.replace(/^--?/, "").split(/=(.*)/s);
      if (v !== undefined) f[k] = v;
      else if (bool.has(k)) f[k] = true;
      else f[k] = argv[++i];
    } else pos.push(a);
  }
  return { pos, f };
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((r) => rl.question(q, (a) => (rl.close(), r(a))));
}

async function readSecret(prompt) {
  if (!process.stdin.isTTY) {
    let s = "";
    for await (const c of process.stdin) s += c;
    return s.trim();
  }
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    let s = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const on = (b) => {
      const ch = b.toString("utf8");
      if (ch === "\r" || ch === "\n") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off("data", on);
        process.stderr.write("\n");
        resolve(s.trim());
      } else if (ch === "\u0003") process.exit(130);
      else if (ch === "\u007f") s = s.slice(0, -1);
      else s += ch;
    };
    process.stdin.on("data", on);
  });
}

const out = (s = "") => process.stdout.write(s + "\n");
const err = (s) => process.stderr.write(s + "\n");

async function cmdLogin(pos, f) {
  const which = pos[0] || "all";
  if (which === "github" || which === "all") {
    if (f.token) {
      const t = await readSecret("Paste a GitHub token with read access to the catalog repo (input hidden): ");
      const login = await githubUser(t);
      if (!login) throw new Error("That token was rejected by GitHub");
      saveGitHubToken(t, "pasted");
      out(`GitHub: saved pasted token (user ${login})`);
    } else {
      const r = await loginGitHub({
        mode: f.device ? "device" : "auto",
        onCode: ({ verificationUri, userCode }) => err(`Open ${verificationUri} and enter code ${userCode}`),
        log: err,
      });
      out(r.already ? `GitHub: already logged in as ${r.login} (via ${r.source})` : `GitHub: logged in as ${r.login || "?"}`);
    }
  }
  if (which === "cursor" || (which === "all" && !f.token)) {
    if (which === "all") {
      const st = getSessionStatus();
      if (st.loggedIn && !st.expired) {
        out(`Cursor: already logged in (${st.emailRedacted || st.authMethod}), expires ${st.expiresAt}`);
        return;
      }
      out("Cursor login is optional: only needed to fetch templates that are not in the catalog.");
      if (!process.stdin.isTTY || !/^y/i.test(await ask("Log in to Cursor now? [y/N] "))) return;
    }
    if (f.token) {
      const t = await readSecret("Paste a Cursor access token or API key (input hidden): ");
      const st = await loginWithPastedToken(t);
      out(`Cursor: saved (${st.authMethod}), expires ${st.expiresAt}`);
    } else {
      const r = await loginWithBrowser({ onLoginUrl: (u) => err(`Opening Cursor login. If no browser opens, visit:\n  ${u}`) });
      out(`Cursor: logged in (${r.status.emailRedacted || r.status.authMethod}), expires ${r.status.expiresAt}`);
    }
  }
}

async function cmdStatus() {
  const g = await githubStatus();
  const c = getSessionStatus();
  const { repo, ref } = catalogRepo();
  out(`Catalog repo: ${repo}@${ref}`);
  out(`GitHub:  ${g.loggedIn ? `logged in as ${g.login} (via ${g.source})` : g.invalid ? `token from ${g.source} was rejected` : "not logged in (optional: the default catalog is public; log in for a private catalog or a higher API limit)"}`);
  out(`Cursor:  ${c.loggedIn ? `${c.expired ? "expired" : "logged in"} (${c.emailRedacted || c.authMethod}), expires ${c.expiresAt}` : "not logged in (optional; run: grokbot login cursor)"}`);
  out(`Installed bots: ${listInstalled().length}`);
}

async function cmdSearch(pos, f) {
  const cat = await loadCatalog({ refresh: !!f.refresh, repo: f.repo });
  if (cat.stale) err(`warning: using cached catalog from ${cat.fetchedAt} (${cat.error})`);
  const { total, results } = searchCatalog(cat.templates, pos.join(" "), {
    section: f.section,
    category: f.category,
    tag: f.tag,
    creator: f.creator,
    includeDead: !!f.dead,
    limit: Number(f.limit || 20),
  });
  if (f.json) return out(JSON.stringify({ total, results }, null, 2));
  if (!total) return out("No matches.");
  for (const t of results) out(formatRow(t));
  out(`\n${results.length} of ${total} match(es) · catalog ${cat.repo}@${cat.ref} (${cat.fromCache ? `cached ${cat.fetchedAt}` : "fresh"}) · install with: grokbot install <slug>`);
}

async function cmdInfo(pos, f) {
  const cat = await loadCatalog({ refresh: !!f.refresh, repo: f.repo });
  const t = resolveTemplate(cat.templates, pos[0]);
  if (f.json) return out(JSON.stringify(t, null, 2));
  out(`${t.name}  [${t.slug}]`);
  out(`  section/category: ${sectionOf(t)}/${t.category}${t.tags?.length ? `  tags: ${t.tags.join(", ")}` : ""}`);
  out(`  creator: ${t.creator || "?"}${t.creatorHandle ? ` (@${t.creatorHandle})` : ""}`);
  out(`  shareId: ${t.shareId || "-"}  ${t.url || ""}`);
  out(`  fidelity: ${t.fidelity}  skills: ${t.skills}  routines: ${t.routines} (scheduled: ${t.scheduledRoutines ?? "?"})  memories: ${t.memories}`);
  if (t.connectors?.length) out(`  connectors: ${t.connectors.join(", ")}`);
  out(`  path: ${cat.repo}/${t.path}`);
  out(`\n  ${t.description || ""}`);
  const inst = listInstalled().filter((b) => b.catalog?.path === t.path);
  if (inst.length) out(`\n  installed as: ${inst.map((b) => b.botId).join(", ")}`);
}

async function cmdInstall(pos, f) {
  if (!pos[0]) throw new Error("Usage: grokbot install <slug|shareId|url>");
  const plan = await planInstall(pos[0], {
    scope: f.scope,
    projectDir: f.project,
    schedule: !f["no-schedule"],
    scheduler: f.scheduler,
    persona: f["no-persona"] ? false : f.persona ? true : "auto",
    mcp: !f["no-mcp"],
    name: f.name,
    repo: f.repo,
    refresh: !!f.refresh,
    force: !!f.force,
  });
  out(formatPlan(plan));
  if (f["dry-run"]) {
    discardPlan(plan);
    return out("\n(dry run: nothing written)");
  }
  if (!f.yes && !f.y) {
    if (!process.stdin.isTTY) {
      discardPlan(plan);
      throw new Error("Not a terminal: re-run with --yes to apply this plan (or --dry-run to preview).");
    }
    if (!/^y/i.test(await ask(`\nProceed${plan.schedules.length ? ` (writes ${plan.schedules.length} schedule entr${plan.schedules.length === 1 ? "y" : "ies"})` : ""}? [y/N] `))) {
      discardPlan(plan);
      return out("Cancelled.");
    }
  }
  const rec = await applyInstall(plan, { log: (s) => err(`  ✓ ${s}`) });
  out(`\nInstalled ${rec.botId}.`);
  out(`  Talk to it:  cd ${rec.scope === "project" ? rec.projectDir : rec.botDir} && pi`);
  if (rec.schedules.length) out(`  Logs:        ${path.join(stateDir(), "logs", rec.botId)}/`);
  if (rec.mcp?.servers?.length) out(`  Connectors:  edit ${rec.mcp.file} to configure ${rec.mcp.servers.join(", ")} (disabled until you do)`);
  out(`  Remove:      grokbot uninstall ${rec.botId}`);
}

async function cmdUninstall(pos, f) {
  if (!pos[0]) throw new Error("Usage: grokbot uninstall <installed-bot>");
  const rec = findInstalled(pos[0], { projectDir: f.project });
  if (!rec) throw new Error(`Not installed: ${pos[0]} (see grokbot list-installed)`);
  out(formatUninstallPlan(rec));
  if (f["dry-run"]) return out("\n(dry run: nothing changed)");
  if (!f.yes && !f.y && process.stdin.isTTY && !/^y/i.test(await ask("\nProceed? [y/N] "))) return out("Cancelled.");
  const r = await uninstall(rec.botId, { keepFiles: !!f["keep-files"] });
  out(`\nRemoved ${r.botId}: ${r.schedules.removed.length} schedule(s), pi package ${r.pi || "n/a"}, persona ${r.persona ? "removed" : "n/a"}, mcp stubs removed ${r.mcp?.removed?.length || 0}${r.mcp?.kept?.length ? ` (kept, in use or edited: ${r.mcp.kept.join(", ")})` : ""}.`);
  if (r.errors.length) {
    err(`Problems:\n  ${r.errors.join("\n  ")}`);
    process.exitCode = 1;
  }
}

function cmdList(f) {
  const bots = listInstalled();
  if (f.json) return out(JSON.stringify(bots, null, 2));
  if (!bots.length) return out("No Grok Bot templates installed by this tool.");
  for (const b of bots) {
    out(`${b.botId}  (${b.scope}${b.projectDir ? `: ${b.projectDir}` : ""})  ${b.displayName}`);
    out(`    dir ${b.botDir}`);
    out(`    schedules: ${b.schedules.length ? b.schedules.map((s) => `/${s.routine} ${s.kind === "systemd" ? `${s.unit} (${s.onCalendar})` : `cron "${s.cron}"`}`).join("; ") : "none"}`);
    if (b.unscheduled?.length) out(`    unscheduled: ${b.unscheduled.map((u) => `/${u.routine}`).join(", ")}`);
  }
}

function cmdConfig(pos) {
  const keys = { "catalog-repo": "catalogRepo", "catalog-ref": "catalogRef", "github-client-id": "githubClientId" };
  if (!pos[0] || pos[0] === "get") return out(`${configPath()}\n${JSON.stringify(readConfig(), null, 2)}`);
  const k = keys[pos[1]];
  if (!k) throw new Error(`Unknown key ${pos[1]} (use ${Object.keys(keys).join(", ")})`);
  if (pos[0] === "set") writeConfig({ [k]: pos[2] });
  else if (pos[0] === "unset") writeConfig({ [k]: null });
  out(JSON.stringify(readConfig(), null, 2));
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, f } = parseArgs(rest);
  if (f.repo) process.env.GROKBOT_CATALOG_REPO = f.repo;
  switch (cmd) {
    case "login":
      return cmdLogin(pos, f);
    case "logout":
      if (!pos[0] || pos[0] === "github") out(clearGitHubToken() ? "GitHub: removed saved token" : "GitHub: no saved token (gh / GH_TOKEN are left alone)");
      if (!pos[0] || pos[0] === "cursor") (clearSession(), out("Cursor: session cleared"));
      return;
    case "status":
      return cmdStatus();
    case "search":
      return cmdSearch(pos, f);
    case "info":
      return cmdInfo(pos, f);
    case "install":
      return cmdInstall(pos, f);
    case "schedule": {
      const s = await addSchedule(pos[0], pos[1], pos.slice(2).join(" "), { scheduler: f.scheduler });
      return out(`Scheduled /${s.routine}: ${s.kind === "systemd" ? `${s.unit} (${s.onCalendar})` : `cron "${s.cron}"`}`);
    }
    case "list-installed":
    case "list":
      return cmdList(f);
    case "uninstall":
    case "remove":
      return cmdUninstall(pos, f);
    case "config":
      return cmdConfig(pos);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return out(HELP);
    default:
      throw new Error(`Unknown command "${cmd}". Run: grokbot help`);
  }
}

main().catch((e) => {
  err(`error: ${e.message}`);
  process.exit(1);
});
