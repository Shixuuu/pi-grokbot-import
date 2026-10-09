#!/usr/bin/env node
// Print what Pi's resource loader sees for a cwd: skills, prompts, AGENTS files, appended system prompt.
// Usage: node test/verify-load.mjs <cwd>
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const cwd = path.resolve(process.argv[2] || process.cwd());
const piBin = fs.realpathSync(execFileSync("sh", ["-c", "command -v pi"]).toString().trim());
const piHome = path.resolve(path.dirname(piBin), "..", "..");
const sdk = await import(path.join(piHome, "dist", "index.js"));
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME, ".pi", "agent");
const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, noExtensions: true, settingsManager: sdk.SettingsManager.create(cwd, agentDir) });
await loader.reload({ resolveProjectTrust: async () => true });
const skills = loader.getSkills();
const prompts = loader.getPrompts();
const agents = loader.getAgentsFiles();
const append = loader.getAppendSystemPrompt();
const pick = (x) => (Array.isArray(x) ? x : x?.skills || x?.prompts || x?.agentsFiles || []);
const out = {
  cwd,
  skills: pick(skills).map((s) => s.name),
  skillDiagnostics: (skills.diagnostics || []).map((d) => d.message || String(d)),
  prompts: pick(prompts).map((p) => p.name),
  agentsFiles: pick(agents).map((a) => a.path),
  appendSystemPrompt: Array.isArray(append) ? append.map((a) => String(a).slice(0, 160)) : String(append || "").slice(0, 160),
};
console.log(JSON.stringify(out, null, 2));
