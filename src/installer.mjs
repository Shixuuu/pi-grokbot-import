/**
 * Install / uninstall Grok Bot templates as Pi packages.
 *
 * install = download one template folder → copy to a bot dir → `pi install` (global or -l project)
 *         → persona + memory block in APPEND_SYSTEM.md → disabled MCP stubs → cron/systemd schedules
 *         → ledger entry (<agentDir>/grokbot-import/installed.json) so uninstall can undo every step.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { agentDir, stateDir, readJson, writeJson, catalogRepo } from "./paths.mjs";
import { loadCatalog, resolveTemplate, downloadTemplate, sectionOf } from "./catalog.mjs";
import { detectScheduler, parseCronFile, cronToOnCalendar, validCron, installSchedules, removeSchedules } from "./scheduler.mjs";

const MARK = "grokbot-import";
const STUB_COMMAND = "configure-me";

// ---------- small helpers ----------
export function ledgerPath() {
  return path.join(stateDir(), "installed.json");
}
export function readLedger() {
  const l = readJson(ledgerPath(), null);
  return l && l.bots ? l : { version: 1, bots: {} };
}
function writeLedger(l) {
  writeJson(ledgerPath(), l);
}
const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "bot";

function run(cmd, args, { cwd, timeout = 120000, env } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, env: env || process.env, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || ""), missing: err?.code === "ENOENT" }),
    );
  });
}

function which(bin) {
  for (const d of String(process.env.PATH || "").split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

export function resolvePiBin(override) {
  const cand = override || process.env.GROKBOT_PI_BIN || which("pi");
  if (cand) return path.resolve(cand);
  const argv1 = process.argv[1] || "";
  if (/(^|\/)(pi|cli\.js)$/.test(argv1)) return argv1;
  return null;
}

function scheduleEnvPath(piBin) {
  const dirs = [path.dirname(process.execPath), piBin ? path.dirname(fs.realpathSync(piBin)) : null, piBin ? path.dirname(piBin) : null, "/usr/local/bin", "/usr/bin", "/bin"];
  return [...new Set(dirs.filter(Boolean))].join(":");
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
const exists = (p) => fs.existsSync(p);
const read = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ---------- reading a downloaded template ----------
export function inspectTemplateDir(dir) {
  const pkg = readJson(path.join(dir, "package.json"), {});
  const skills = listDir(path.join(dir, "skills")).filter((n) => exists(path.join(dir, "skills", n, "SKILL.md")));
  const prompts = listDir(path.join(dir, "prompts")).filter((n) => n.endsWith(".md")).map((n) => n.slice(0, -3));
  const routineNames = new Set([
    ...listDir(path.join(dir, "routines")).filter((n) => n.endsWith(".md")).map((n) => n.slice(0, -3)),
    ...listDir(path.join(dir, "cron")).filter((n) => n.endsWith(".cron")).map((n) => n.slice(0, -5)),
  ]);
  const routines = [...routineNames].sort().map((name) => {
    const { cron, cadence } = parseCronFile(read(path.join(dir, "cron", `${name}.cron`)));
    return { routine: name, cron, cadence, hasPrompt: prompts.includes(name) };
  });
  const cj = readJson(path.join(dir, "connectors.json"), null);
  const connectors = (cj?.plugins || []).map((p) => ({ name: p.name || p.pluginId, pluginId: p.pluginId || null, description: p.description || "" }));
  return {
    name: pkg?.grokbot?.name || (read(path.join(dir, "AGENTS.md")).match(/^#\s+(.+)$/m) || [])[1] || path.basename(dir),
    description: pkg.description || "",
    grokbot: pkg.grokbot || {},
    skills,
    prompts,
    routines,
    connectors,
    hasAgents: exists(path.join(dir, "AGENTS.md")),
    hasAppendSystem: exists(path.join(dir, ".pi", "APPEND_SYSTEM.md")),
    hasMemory: exists(path.join(dir, "MEMORY.md")),
    hasSettings: exists(path.join(dir, ".pi", "settings.json")),
  };
}

/** Make sure a template dir is a loadable Pi package (manifest + project settings). */
function normalizePackage(dir, info) {
  const pkgPath = path.join(dir, "package.json");
  const pkg = readJson(pkgPath, {});
  pkg.name = pkg.name || `grokbot-${slugify(info.name)}`;
  pkg.version = pkg.version || "1.0.0";
  pkg.private = true;
  pkg.keywords = [...new Set([...(pkg.keywords || []), "pi-package", "grok-bot-template"])];
  pkg.pi = pkg.pi || {};
  if (exists(path.join(dir, "skills"))) pkg.pi.skills = pkg.pi.skills || ["./skills"];
  if (exists(path.join(dir, "prompts"))) pkg.pi.prompts = pkg.pi.prompts || ["./prompts"];
  writeJson(pkgPath, pkg);
  const settings = path.join(dir, ".pi", "settings.json");
  if (!exists(settings)) {
    const s = {};
    if (pkg.pi.skills) s.skills = ["../skills"];
    if (pkg.pi.prompts) s.prompts = ["../prompts"];
    writeJson(settings, s);
  }
}

// ---------- live (non-catalog) templates via the original importer ----------
const CRON_RE =
  /(?<![\w*/,-])((?:\*|\d{1,2}(?:[-,/]\d{1,2})*|\*\/\d+)\s+(?:\*|\d{1,2}(?:[-,/]\d{1,2})*|\*\/\d+)\s+(?:\*|\d{1,2}(?:[-,/]\d{1,2})*|\*\/\d+)\s+(?:\*|\d{1,2}(?:[-,/]\d{1,2})*|\*\/\d+)\s+(?:\*|[0-7](?:[-,/][0-7])*|\*\/\d+))(?![\w*/,-])/;

async function stageLiveTemplate(source, stageDir) {
  const { loadBundleFromSource } = await import("./fetch-template.mjs");
  const { importGrokBotBundle } = await import("./import-bundle.mjs");
  const { toSkillSlug } = await import("./schema.mjs");
  const src = /^[A-Za-z0-9_-]{18,24}$/.test(source) && !fs.existsSync(source) ? `https://x.ai/bot/${source}` : source;
  const bundle = await loadBundleFromSource(src, { baseDir: process.cwd() });
  importGrokBotBundle(bundle, { outDir: stageDir, force: true });
  // Re-shape into the catalog package layout.
  const mv = (a, b) => exists(path.join(stageDir, a)) && fs.renameSync(path.join(stageDir, a), path.join(stageDir, b));
  mv(".pi/skills", "skills");
  mv(".pi/prompts", "prompts");
  if (exists(path.join(stageDir, "NOTES.md"))) fs.copyFileSync(path.join(stageDir, "NOTES.md"), path.join(stageDir, "MEMORY.md"));
  fs.rmSync(path.join(stageDir, "cron"), { recursive: true, force: true });
  fs.rmSync(path.join(stageDir, "systemd"), { recursive: true, force: true });
  fs.mkdirSync(path.join(stageDir, "cron"), { recursive: true });
  for (const r of bundle.routines) {
    const name = toSkillSlug(r.name);
    const text = `${r.triggerSummary || ""}\n${r.prompt || ""}`;
    const cron = validCron(r.schedule) ? r.schedule.trim() : (text.match(CRON_RE) || [])[1] || null;
    fs.writeFileSync(
      path.join(stageDir, "cron", `${name}.cron`),
      cron ? `# Routine "${r.name}" (live import)\n${cron} pi -p "/${name}"\n` : `# Routine "${r.name}": no machine-readable schedule in the template.\n# M H DOM MON DOW pi -p "/${name}"\n`,
    );
  }
  writeJson(path.join(stageDir, "connectors.json"), {
    note: "Plugins referenced by the live template (names only; not configured).",
    plugins: bundle.plugins.map((p) => ({ name: p.name || p.id, pluginId: p.id, description: p.note || "" })),
  });
  const mode = bundle.source?.mode || "full";
  writeJson(path.join(stageDir, "package.json"), {
    name: `grokbot-${toSkillSlug(bundle.persona.name)}`,
    version: "1.0.0",
    private: true,
    description: bundle.persona.description,
    keywords: ["pi-package", "grok-bot-template"],
    pi: { skills: ["./skills"], prompts: ["./prompts"] },
    grokbot: { name: bundle.persona.name, shareId: bundle.source?.agentId || null, url: bundle.source?.url || null, fidelity: mode, origin: "live" },
  });
  return { bundle, mode };
}

// ---------- persona block ----------
function personaTarget(scope, projectDir) {
  return scope === "global" ? path.join(agentDir(), "APPEND_SYSTEM.md") : path.join(projectDir, ".pi", "APPEND_SYSTEM.md");
}
const beginTag = (id) => `<!-- ${MARK}:begin ${id} -->`;
const endTag = (id) => `<!-- ${MARK}:end ${id} -->`;

function otherPersonas(file, botId) {
  return [...read(file).matchAll(new RegExp(`<!-- ${MARK}:begin (\\S+) -->`, "g"))].map((m) => m[1]).filter((x) => x !== botId);
}

function buildPersonaBlock(botId, botDir, info) {
  const persona = read(path.join(botDir, "AGENTS.md")).trim() || read(path.join(botDir, ".pi", "APPEND_SYSTEM.md")).trim();
  const memory = read(path.join(botDir, "MEMORY.md")).trim();
  const parts = [
    beginTag(botId),
    `<!-- Added by pi-grokbot-import. Remove with: grokbot uninstall ${botId} -->`,
    "",
    `Installed Grok Bot persona "${info.name}". Bot files (skills/, routines/, MEMORY.md) live in \`${botDir}\`; relative paths mentioned below are relative to that folder.`,
    "",
    persona,
  ];
  if (memory) parts.push("", memory.length <= 12000 ? memory : `${memory.slice(0, 12000)}\n\n…(truncated; full file: ${path.join(botDir, "MEMORY.md")})`);
  parts.push("", endTag(botId));
  return parts.join("\n");
}

function writePersonaBlock(file, botId, block) {
  const cur = read(file);
  const stripped = removeBlockText(cur, botId);
  const next = (stripped.trimEnd() ? `${stripped.trimEnd()}\n\n` : "") + block + "\n";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
}

function removeBlockText(text, botId) {
  const b = beginTag(botId);
  const e = endTag(botId);
  const i = text.indexOf(b);
  if (i < 0) return text;
  const j = text.indexOf(e, i);
  if (j < 0) return text;
  return (text.slice(0, i).replace(/\n+$/, "\n") + text.slice(j + e.length).replace(/^\n+/, "\n")).replace(/^\n+/, "");
}

function removePersonaBlock(file, botId) {
  if (!exists(file)) return false;
  const cur = read(file);
  const next = removeBlockText(cur, botId);
  if (next === cur) return false;
  if (!next.trim()) fs.unlinkSync(file);
  else fs.writeFileSync(file, next.replace(/\n*$/, "\n"));
  return true;
}

// ---------- MCP stubs ----------
function mcpTarget(scope, projectDir) {
  return scope === "global" ? path.join(agentDir(), "mcp.json") : path.join(projectDir, ".pi", "mcp.json");
}
const stubName = (c) => `grokbot-${slugify(c.name || c.pluginId)}`.slice(0, 60);

function planMcp(file, connectors) {
  const cur = readJson(file, {})?.mcpServers || {};
  return connectors.map((c) => {
    const name = stubName(c);
    const ex = cur[name];
    const status = !ex ? "add" : ex._grokbot?.stub ? "share" : "exists";
    return { name, connector: c.name, pluginId: c.pluginId, description: c.description, status };
  });
}

function applyMcp(file, botId, botName, items) {
  if (!items.length) return [];
  const doc = readJson(file, {}) || {};
  doc.mcpServers = doc.mcpServers || {};
  const written = [];
  for (const it of items) {
    const ex = doc.mcpServers[it.name];
    if (ex && !ex._grokbot?.stub) continue; // user's own server; never touch
    if (ex) {
      ex._grokbot.bots = [...new Set([...(ex._grokbot.bots || []), botId])];
    } else {
      doc.mcpServers[it.name] = {
        enabled: false,
        command: STUB_COMMAND,
        args: [],
        description: `${it.connector} connector used by Grok Bot "${botName}" (placeholder; not configured)`,
        _grokbot: {
          stub: true,
          connector: it.connector,
          pluginId: it.pluginId || undefined,
          note: `Placeholder from pi-grokbot-import. Replace "command"/"args" (stdio) or use "url" (HTTP) with a real ${it.connector} MCP server, put credentials in env/headers via \${VARS}, then set "enabled": true. ${it.description || ""}`.trim(),
          bots: [botId],
        },
      };
    }
    written.push(it.name);
  }
  writeJson(file, doc);
  return written;
}

function removeMcp(file, botId, names) {
  const doc = readJson(file, null);
  if (!doc?.mcpServers) return { removed: [], kept: [] };
  const removed = [];
  const kept = [];
  for (const n of names) {
    const ex = doc.mcpServers[n];
    if (!ex?._grokbot?.stub) continue;
    ex._grokbot.bots = (ex._grokbot.bots || []).filter((b) => b !== botId);
    const untouched = ex.enabled === false && ex.command === STUB_COMMAND && !ex.url;
    if (!ex._grokbot.bots.length && untouched) {
      delete doc.mcpServers[n];
      removed.push(n);
    } else kept.push(n);
  }
  if (!Object.keys(doc.mcpServers).length && Object.keys(doc).length === 1) fs.unlinkSync(file);
  else writeJson(file, doc);
  return { removed, kept };
}

// ---------- plan ----------
/**
 * Build an install plan. Downloads the template into a temp staging dir (nothing else is written).
 * opts: { scope: "global"|"project", projectDir, schedule: bool, scheduler: auto|cron|systemd, persona: auto|true|false,
 *         mcp: bool, name, repo, refresh, piBin, force }
 */
export async function planInstall(target, opts = {}) {
  const scope = opts.scope === "project" ? "project" : "global";
  const projectDir = path.resolve(opts.projectDir || process.cwd());
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "grokbot-stage-"));
  let entry = null;
  let origin = "catalog";
  let liveMode = null;
  const notes = [];
  try {
    let catalog = null;
    try {
      catalog = await loadCatalog({ refresh: opts.refresh, repo: opts.repo });
    } catch (e) {
      notes.push(`Catalog unavailable: ${e.message}`);
    }
    if (catalog) {
      try {
        entry = resolveTemplate(catalog.templates, target);
      } catch (e) {
        if (e.code !== "NOT_FOUND") throw e;
      }
    }
    if (entry) {
      await downloadTemplate(entry, stage, { repo: opts.repo });
    } else {
      const looksLive = /^https?:\/\//.test(target) || /^[A-Za-z0-9_-]{18,24}$/.test(target) || target.endsWith(".json");
      if (!looksLive) throw new Error(`"${target}" is not in the catalog${catalog ? "" : " (catalog unavailable)"}; pass a share link or shareId to fetch it live.`);
      origin = "live";
      const r = await stageLiveTemplate(target, stage);
      liveMode = r.mode;
      if (liveMode === "metadata-only") notes.push("Live fetch returned metadata only (no Cursor login?): persona name + description, no skills/routines. Run `grokbot login cursor` for full recipes.");
    }
    const info = inspectTemplateDir(stage);
    const name = slugify(opts.name || entry?.slug || info.name);
    const botId = scope === "project" ? `${name}-p${crypto.createHash("sha1").update(projectDir).digest("hex").slice(0, 6)}` : name;
    const botDir = scope === "global" ? path.join(agentDir(), "grokbot", "bots", name) : path.join(projectDir, ".pi", "grokbot", name);
    const ledger = readLedger();
    const existing = ledger.bots[botId];
    if (existing && !opts.force) throw new Error(`"${botId}" is already installed (${existing.botDir}). Use --force to reinstall, or --name to install another copy.`);
    if (!existing && exists(botDir) && !opts.force) throw new Error(`${botDir} already exists and is not tracked by this tool. Remove it or use --force.`);

    const piBin = resolvePiBin(opts.piBin);
    if (!piBin) notes.push("`pi` was not found on PATH; skills/prompts will not be registered with `pi install` (set GROKBOT_PI_BIN).");

    const pFile = personaTarget(scope, projectDir);
    const others = otherPersonas(pFile, botId);
    let persona = opts.persona === undefined || opts.persona === "auto" ? (scope === "project" ? true : others.length === 0) : !!opts.persona;
    if (persona && others.length) notes.push(`${pFile} already holds persona(s) from: ${others.join(", ")}; personas will stack.`);
    if ((opts.persona === undefined || opts.persona === "auto") && !persona)
      notes.push(`Global persona skipped because ${others.join(", ")} already provides one; pass --persona to add anyway. Run the bot with: cd ${botDir} && pi`);

    const mcpFile = mcpTarget(scope, projectDir);
    const mcp = opts.mcp === false ? [] : planMcp(mcpFile, info.connectors);

    const wantSchedule = opts.schedule !== false;
    const sched = wantSchedule ? await detectScheduler(opts.scheduler || "auto") : { kind: "none", reason: "--no-schedule" };
    const schedules = [];
    const unscheduled = [];
    for (const r of info.routines) {
      if (!r.hasPrompt) {
        unscheduled.push({ ...r, reason: "no prompt template" });
        continue;
      }
      if (!r.cron) {
        unscheduled.push({ ...r, reason: "template has no machine-readable schedule" });
        continue;
      }
      if (!wantSchedule || sched.kind === "none") {
        unscheduled.push({ ...r, reason: wantSchedule ? sched.reason : "--no-schedule" });
        continue;
      }
      let kind = sched.kind;
      let onCalendar = null;
      if (kind === "systemd") {
        onCalendar = cronToOnCalendar(r.cron);
        if (!onCalendar) {
          unscheduled.push({ ...r, reason: `cron "${r.cron}" has no systemd OnCalendar equivalent; add it with --scheduler cron or by hand` });
          continue;
        }
      }
      schedules.push({ routine: r.routine, cron: r.cron, onCalendar, kind });
    }

    return {
      target,
      origin,
      liveMode,
      entry: entry
        ? { shareId: entry.shareId, slug: entry.slug, path: entry.path, section: sectionOf(entry), category: entry.category, tags: entry.tags, fidelity: entry.fidelity, url: entry.url }
        : null,
      catalogRepo: entry ? catalogRepo(opts.repo).repo : null,
      stage,
      info,
      name,
      botId,
      displayName: info.name,
      scope,
      projectDir: scope === "project" ? projectDir : null,
      botDir,
      piBin,
      piInstall: piBin ? { cmd: [piBin, "install", ...(scope === "project" ? ["-l", "--approve"] : []), botDir], cwd: scope === "project" ? projectDir : os.homedir() } : null,
      persona: persona ? { file: pFile } : null,
      mcp: { file: mcpFile, items: mcp },
      scheduler: sched.kind,
      schedulerReason: sched.reason,
      schedules,
      unscheduled,
      notes,
      force: !!opts.force,
      existing: existing || null,
    };
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw e;
  }
}

export function discardPlan(plan) {
  if (plan?.stage) fs.rmSync(plan.stage, { recursive: true, force: true });
}

export function formatPlan(plan) {
  const L = [];
  const e = plan.entry;
  L.push(`Install plan: ${plan.displayName} → ${plan.botId}`);
  L.push(`  source:   ${e ? `${plan.catalogRepo}/${e.path} (${e.section}/${e.category}${e.tags?.length ? `, tags ${e.tags.join(",")}` : ""}, fidelity ${e.fidelity})` : `live fetch of ${plan.target} (${plan.liveMode})`}`);
  L.push(`  scope:    ${plan.scope}${plan.projectDir ? ` (${plan.projectDir})` : ""}`);
  L.push(`  files:    ${plan.botDir}`);
  L.push(`  pi:       ${plan.piInstall ? `pi ${plan.piInstall.cmd.slice(1).join(" ")}` : "(skipped: pi not found)"}  → ${plan.info.skills.length} skills, ${plan.info.prompts.length} prompts`);
  L.push(`  persona:  ${plan.persona ? `AGENTS.md + MEMORY.md block in ${plan.persona.file}` : "not added (bot dir still has AGENTS.md / .pi/APPEND_SYSTEM.md)"}`);
  const add = plan.mcp.items.filter((x) => x.status !== "exists");
  L.push(`  mcp:      ${plan.mcp.items.length ? `${add.length} disabled stub(s) in ${plan.mcp.file}: ${plan.mcp.items.map((x) => `${x.name}${x.status === "exists" ? " (already configured, untouched)" : ""}`).join(", ")}` : "no connectors"}`);
  if (plan.schedules.length) {
    L.push(`  schedule: ${plan.schedules.length} ${plan.scheduler === "systemd" ? "systemd --user timer(s)" : "crontab line(s)"}:`);
    for (const s of plan.schedules) L.push(`    - /${s.routine}  cron "${s.cron}"${s.onCalendar ? `  OnCalendar=${s.onCalendar}` : ""}  (cd ${plan.botDir} && pi -p --approve "/${s.routine}")`);
  } else L.push(`  schedule: none${plan.schedulerReason ? ` (${plan.schedulerReason})` : ""}`);
  if (plan.unscheduled.length) {
    L.push(`  routines without a schedule (set one with: grokbot schedule ${plan.botId} <routine> "<M H DOM MON DOW>"):`);
    for (const u of plan.unscheduled) L.push(`    - /${u.routine}: ${u.reason}${u.cron ? ` [cron ${u.cron}]` : ""}${u.cadence ? ` — described as: ${u.cadence.slice(0, 140)}` : ""}`);
  }
  if (plan.existing) L.push(`  note: replaces the existing install of ${plan.botId}`);
  for (const n of plan.notes) L.push(`  note: ${n}`);
  return L.join("\n");
}

// ---------- apply ----------
export async function applyInstall(plan, { log = () => {} } = {}) {
  if (plan.existing) {
    log(`Removing previous install of ${plan.botId} ...`);
    await uninstall(plan.botId, { quiet: true });
  }
  const rec = {
    botId: plan.botId,
    name: plan.name,
    displayName: plan.displayName,
    origin: plan.origin,
    catalog: plan.entry ? { repo: plan.catalogRepo, ...plan.entry } : null,
    liveTarget: plan.origin === "live" ? plan.target : undefined,
    scope: plan.scope,
    projectDir: plan.projectDir,
    botDir: plan.botDir,
    installedAt: new Date().toISOString(),
    piPackage: null,
    persona: null,
    mcp: null,
    schedules: [],
    unscheduled: plan.unscheduled.map((u) => ({ routine: u.routine, reason: u.reason, cadence: u.cadence || null })),
    piBin: plan.piBin,
  };
  const ledger = readLedger();
  const save = () => {
    const l = readLedger();
    l.bots[plan.botId] = rec;
    writeLedger(l);
  };
  try {
    fs.rmSync(plan.botDir, { recursive: true, force: true });
    copyDir(plan.stage, plan.botDir);
    normalizePackage(plan.botDir, plan.info);
    save();
    log(`Copied template to ${plan.botDir}`);

    if (plan.piInstall) {
      const [bin, ...args] = plan.piInstall.cmd;
      const r = await run(bin, args, { cwd: plan.piInstall.cwd });
      if (r.code !== 0) throw new Error(`pi install failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
      rec.piPackage = { source: plan.botDir, local: plan.scope === "project", cwd: plan.piInstall.cwd };
      save();
      log(`Registered package with pi (${plan.scope})`);
    }

    if (plan.persona) {
      writePersonaBlock(plan.persona.file, plan.botId, buildPersonaBlock(plan.botId, plan.botDir, plan.info));
      rec.persona = { file: plan.persona.file };
      save();
      log(`Persona + memory added to ${plan.persona.file}`);
    }

    const mcpItems = plan.mcp.items.filter((x) => x.status !== "exists");
    if (mcpItems.length) {
      const names = applyMcp(plan.mcp.file, plan.botId, plan.displayName, mcpItems);
      rec.mcp = { file: plan.mcp.file, servers: names };
      save();
      log(`MCP stubs (disabled): ${names.join(", ")}`);
    }

    if (plan.schedules.length) {
      const byKind = {};
      for (const s of plan.schedules) (byKind[s.kind] ||= []).push(s);
      for (const [kind, list] of Object.entries(byKind)) {
        const done = await installSchedules(
          kind,
          { bot: plan.botId, botDir: plan.botDir, piBin: plan.piBin || "pi", pathEnv: scheduleEnvPath(plan.piBin), logDir: path.join(stateDir(), "logs", plan.botId), botName: plan.displayName },
          list,
        );
        rec.schedules.push(...done);
        save();
      }
      log(`Schedules: ${rec.schedules.map((s) => `/${s.routine} ${s.kind === "systemd" ? s.unit : `cron ${s.cron}`}`).join("; ")}`);
    }
    save();
    return rec;
  } catch (e) {
    e.partial = rec;
    throw e;
  } finally {
    discardPlan(plan);
    void ledger;
  }
}

/** Add or replace a schedule for one routine of an installed bot. */
export async function addSchedule(botId, routine, cron, { scheduler = "auto" } = {}) {
  const l = readLedger();
  const rec = l.bots[botId];
  if (!rec) throw new Error(`Not installed: ${botId}`);
  if (!validCron(cron)) throw new Error(`Invalid cron "${cron}" (need 5 fields: M H DOM MON DOW)`);
  if (!exists(path.join(rec.botDir, "prompts", `${routine}.md`))) throw new Error(`No prompt template /${routine} in ${rec.botDir}/prompts`);
  const sched = await detectScheduler(scheduler);
  if (sched.kind === "none") throw new Error(`No scheduler available: ${sched.reason}`);
  const onCalendar = sched.kind === "systemd" ? cronToOnCalendar(cron) : null;
  if (sched.kind === "systemd" && !onCalendar) throw new Error(`cron "${cron}" has no OnCalendar equivalent; use --scheduler cron`);
  const old = rec.schedules.filter((s) => s.routine === routine);
  if (old.length) await removeSchedules(botId, old, { routines: [routine] });
  const done = await installSchedules(
    sched.kind,
    { bot: botId, botDir: rec.botDir, piBin: rec.piBin || resolvePiBin() || "pi", pathEnv: scheduleEnvPath(rec.piBin || resolvePiBin()), logDir: path.join(stateDir(), "logs", botId), botName: rec.displayName },
    [{ routine, cron, onCalendar }],
  );
  rec.schedules = [...rec.schedules.filter((s) => s.routine !== routine), ...done];
  rec.unscheduled = (rec.unscheduled || []).filter((u) => u.routine !== routine);
  l.bots[botId] = rec;
  writeLedger(l);
  return done[0];
}

export function listInstalled() {
  return Object.values(readLedger().bots);
}

export function findInstalled(idOrName, { projectDir } = {}) {
  const bots = listInstalled();
  const exact = bots.find((b) => b.botId === idOrName);
  if (exact) return exact;
  const byName = bots.filter((b) => b.name === idOrName || b.catalog?.shareId === idOrName || b.catalog?.slug === idOrName);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    const here = byName.filter((b) => b.scope === "project" && b.projectDir === path.resolve(projectDir || process.cwd()));
    if (here.length === 1) return here[0];
    const glob = byName.filter((b) => b.scope === "global");
    if (glob.length === 1 && !here.length) return glob[0];
    throw new Error(`"${idOrName}" matches several installs: ${byName.map((b) => b.botId).join(", ")}`);
  }
  return null;
}

export function formatUninstallPlan(rec) {
  const L = [`Uninstall ${rec.botId} (${rec.displayName}, ${rec.scope})`];
  if (rec.schedules?.length) L.push(`  remove ${rec.schedules.length} schedule(s): ${rec.schedules.map((s) => (s.kind === "systemd" ? s.unit : `crontab /${s.routine}`)).join(", ")}`);
  if (rec.piPackage) L.push(`  pi remove ${rec.piPackage.local ? "-l --approve " : ""}${rec.piPackage.source}`);
  if (rec.persona) L.push(`  remove persona block from ${rec.persona.file}`);
  if (rec.mcp?.servers?.length) L.push(`  remove unused disabled MCP stubs from ${rec.mcp.file}: ${rec.mcp.servers.join(", ")}`);
  L.push(`  delete ${rec.botDir}`);
  return L.join("\n");
}

export async function uninstall(idOrName, { dryRun = false, keepFiles = false, projectDir } = {}) {
  const rec = findInstalled(idOrName, { projectDir });
  if (!rec) throw new Error(`Not installed: ${idOrName}`);
  if (dryRun) return { rec, dryRun: true, plan: formatUninstallPlan(rec) };
  const report = { botId: rec.botId, schedules: null, pi: null, persona: false, mcp: null, filesRemoved: false, errors: [] };
  report.schedules = await removeSchedules(rec.botId, rec.schedules || []);
  report.errors.push(...report.schedules.errors);
  if (rec.piPackage) {
    const bin = rec.piBin || resolvePiBin();
    if (bin) {
      const r = await run(bin, ["remove", ...(rec.piPackage.local ? ["-l", "--approve"] : []), rec.piPackage.source], { cwd: rec.piPackage.cwd });
      report.pi = r.code === 0 ? "removed" : `failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`;
      if (r.code !== 0) report.errors.push(`pi remove: ${report.pi}`);
    } else report.errors.push("pi not found; remove the package from settings.json by hand");
  }
  if (rec.persona) report.persona = removePersonaBlock(rec.persona.file, rec.botId);
  if (rec.mcp?.servers?.length) report.mcp = removeMcp(rec.mcp.file, rec.botId, rec.mcp.servers);
  if (!keepFiles) {
    fs.rmSync(rec.botDir, { recursive: true, force: true });
    report.filesRemoved = true;
    try {
      fs.rmdirSync(path.dirname(rec.botDir)); // only succeeds when empty
    } catch {
      /* not empty */
    }
  }
  const l = readLedger();
  delete l.bots[rec.botId];
  writeLedger(l);
  return report;
}
