/**
 * Shared paths and config for pi-grokbot-import.
 * Everything lives under Pi's agent dir (PI_CODING_AGENT_DIR or ~/.pi/agent).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_CATALOG_REPO = "Shixuuu/grokbot-pi-templates";
export const DEFAULT_CATALOG_REF = "main";

export function homeDir() {
  return process.env.HOME || os.homedir();
}

export function agentDir() {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env) return env.startsWith("~/") ? path.join(homeDir(), env.slice(2)) : path.resolve(env);
  return path.join(homeDir(), ".pi", "agent");
}

export function stateDir() {
  return path.join(agentDir(), "grokbot-import");
}

export function configPath() {
  return path.join(stateDir(), "config.json");
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

export function readConfig() {
  return readJson(configPath(), {});
}

export function writeConfig(patch) {
  const cfg = { ...readConfig(), ...patch };
  for (const [k, v] of Object.entries(cfg)) if (v === null || v === undefined || v === "") delete cfg[k];
  writeJson(configPath(), cfg);
  return cfg;
}

/** Catalog repo: --repo flag > GROKBOT_CATALOG_REPO env > config.json > default. "owner/name[@ref]" */
export function catalogRepo(override) {
  const raw = override || process.env.GROKBOT_CATALOG_REPO || readConfig().catalogRepo || DEFAULT_CATALOG_REPO;
  const [repo, refFromRepo] = String(raw).split("@");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`Invalid catalog repo "${raw}" (expected owner/name or owner/name@ref)`);
  const ref = refFromRepo || process.env.GROKBOT_CATALOG_REF || readConfig().catalogRef || DEFAULT_CATALOG_REF;
  return { repo, ref };
}
