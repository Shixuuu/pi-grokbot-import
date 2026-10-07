#!/usr/bin/env node
/**
 * Export a Grok Bot from local agent-data into grokbot-bundle/v1 JSON.
 *
 * Usage:
 *   node export-grokbot.mjs <agentId> [--out path.json]
 *   node export-grokbot.mjs <agentId> --include-skill cheap-routines --include-skill design-grok-bot
 *
 * Never prints or embeds secrets from connector-secrets, box-secrets, host-secrets,
 * teach-queue-key, webhook-keys, auth tokens, or store.db encryption keys.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BUNDLE_FORMAT = "grokbot-bundle/v1";

const DEFAULT_AGENT_DATA =
  process.env.GROK_AGENT_DATA || "/home/box/agent-data";

const SECRET_LINE =
  /^(.*\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|secret|password|passwd|credential|webhook[_-]?key|encryption[_-]?key|private[_-]?key|authorization)\b\s*[:=]\s*)(.+)$/i;
const TOKENISH =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._\-+/=]{20,})\b/g;

function scrubText(input) {
  return input
    .split("\n")
    .map((line) => {
      const m = line.match(SECRET_LINE);
      if (m) return `${m[1]}[REDACTED]`;
      return line.replace(TOKENISH, "[REDACTED]");
    })
    .join("\n");
}

function filterPortableMemoryLines(text) {
  return text
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (/^\[episode\]/i.test(t) || /^\[note\]/i.test(t)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function toSkillSlug(name) {
  const s = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64);
  return s || "unnamed-skill";
}

function parseArgs(argv) {
  const args = { agentId: null, out: null, includeSkills: [], agentData: DEFAULT_AGENT_DATA };
  const rest = [...argv];
  while (rest.length) {
    const a = rest.shift();
    if (a === "--out") args.out = rest.shift();
    else if (a === "--agent-data") args.agentData = rest.shift();
    else if (a === "--include-skill") args.includeSkills.push(rest.shift());
    else if (a === "--help" || a === "-h") args.help = true;
    else if (!a.startsWith("-") && !args.agentId) args.agentId = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseSkillMd(raw, fallbackName, source) {
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  let name = fallbackName;
  let description = fallbackName;
  let body = raw;
  if (fm) {
    const meta = fm[1];
    body = fm[2];
    const nameMatch = meta.match(/^name:\s*(.+)$/m);
    const descMatch = meta.match(/^description:\s*(?:>-\s*)?([\s\S]*?)(?=^[a-zA-Z0-9_-]+:|\Z)/m);
    if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
    if (descMatch) {
      description = descMatch[1]
        .split("\n")
        .map((l) => l.replace(/^\s*>?\s?/, "").trim())
        .filter(Boolean)
        .join(" ")
        .replace(/^["']|["']$/g, "");
    }
  }
  return {
    name: toSkillSlug(name),
    description: scrubText(description).slice(0, 1024),
    body: scrubText(body.trim()),
    source,
  };
}

function loadSkillBySlug(agentData, slug) {
  const candidates = [
    path.join(agentData, "workflows", slug, "SKILL.md"),
    path.join(agentData, "managed-skills", "skills", slug, "SKILL.md"),
    path.join(agentData, "plugin-skills", slug, "SKILL.md"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return parseSkillMd(fs.readFileSync(c, "utf8"), slug, c);
    }
  }
  throw new Error(`Skill not found: ${slug}`);
}

function loadMemories(agentData, agentId) {
  const memories = [];
  const base = path.join(agentData, "user-memory", "by-agent", agentId);
  const profilePath = path.join(base, "profile.md");
  if (fs.existsSync(profilePath)) {
    const text = filterPortableMemoryLines(scrubText(fs.readFileSync(profilePath, "utf8")));
    if (text) memories.push({ kind: "profile", text, source: "user-memory/profile.md" });
  }
  const logDir = path.join(base, "log");
  if (fs.existsSync(logDir)) {
    for (const f of fs.readdirSync(logDir).filter((x) => x.endsWith(".md")).sort()) {
      const text = filterPortableMemoryLines(scrubText(fs.readFileSync(path.join(logDir, f), "utf8")));
      if (text) memories.push({ kind: "log", text, source: `user-memory/log/${f}` });
    }
  }
  return memories;
}

function loadRoutines(agentDir) {
  const routines = [];
  const autoDir = path.join(agentDir, "automations");
  if (!fs.existsSync(autoDir)) return routines;
  for (const entry of fs.readdirSync(autoDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      // Skip loose files; export-bot-template says don't copy automation.json raw
      continue;
    }
    const folder = path.join(autoDir, entry.name);
    const promptCandidates = ["prompt.md", "PROMPT.md", "job.md", "SKILL.md"];
    let prompt = "";
    for (const c of promptCandidates) {
      const p = path.join(folder, c);
      if (fs.existsSync(p)) {
        prompt = fs.readFileSync(p, "utf8");
        break;
      }
    }
    let schedule;
    let triggerSummary;
    const autoJson = path.join(folder, "automation.json");
    if (fs.existsSync(autoJson)) {
      try {
        const aj = readJson(autoJson);
        // Prefer schedule string; never copy webhook keys / secrets
        if (typeof aj.schedule === "string") schedule = aj.schedule;
        if (aj.trigger) {
          const t = aj.trigger;
          if (typeof t === "object" && t.type) {
            triggerSummary = `type=${t.type}` + (t.event ? ` event=${JSON.stringify(t.event)}` : "");
          } else {
            triggerSummary = "custom-trigger";
          }
        }
        if (!prompt && typeof aj.prompt === "string") prompt = aj.prompt;
        if (!prompt && typeof aj.instruction === "string") prompt = aj.instruction;
      } catch {
        // ignore malformed
      }
    }
    if (!prompt.trim()) continue;
    routines.push({
      name: toSkillSlug(entry.name),
      schedule,
      triggerSummary,
      prompt: scrubText(prompt.trim()),
    });
  }
  return routines;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.agentId) {
    console.log(`Usage: export-grokbot.mjs <agentId> [--out file.json] [--include-skill slug ...]
Agent data root: ${DEFAULT_AGENT_DATA} (override with --agent-data or GROK_AGENT_DATA)`);
    process.exit(args.help ? 0 : 1);
  }

  const agentDir = path.join(args.agentData, "agents", args.agentId);
  const profilePath = path.join(agentDir, "profile.json");
  if (!fs.existsSync(profilePath)) {
    console.error(`No profile.json at ${profilePath}`);
    process.exit(1);
  }

  const profile = readJson(profilePath);
  const omitted = [
    "connector-secrets / box-secrets / host-secrets / webhook-keys / teach-queue-key",
    "store.db contents (including any encryption keys in kv metadata)",
    "assets/ and attachments/ binaries",
    "custom MCP server configs with credentials",
    "[episode] and [note] memory lines",
    "automation.json raw files (schedules/prompts extracted when present under automations/<slug>/)",
  ];

  const skills = [];
  for (const slug of args.includeSkills) {
    skills.push(loadSkillBySlug(args.agentData, slug));
  }

  const bundle = {
    format: BUNDLE_FORMAT,
    exportedAt: new Date().toISOString(),
    source: {
      platform: "grok-bot",
      agentId: args.agentId,
      harness: profile.harness || undefined,
      serverId: profile.serverId || undefined,
    },
    persona: {
      name: profile.name || "Unnamed Bot",
      title: profile.title || "",
      description: scrubText(profile.description || ""),
      avatarShape: profile.avatarShape || undefined,
      avatarColor: profile.avatarColor || undefined,
    },
    memories: loadMemories(args.agentData, args.agentId),
    skills,
    routines: loadRoutines(agentDir),
    plugins: [],
    omitted,
  };

  // settings.json only has notify flags — skip unless useful later
  const outPath =
    args.out ||
    path.join(process.cwd(), `${toSkillSlug(bundle.persona.name)}.grokbot.json`);

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(bundle, null, 2) + "\n", "utf8");

  console.log(
    JSON.stringify(
      {
        wrote: outPath,
        name: bundle.persona.name,
        memories: bundle.memories.length,
        skills: bundle.skills.length,
        routines: bundle.routines.length,
      },
      null,
      2,
    ),
  );
}

main();
