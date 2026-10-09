/**
 * GitHub access for the (private) template catalog repo.
 *
 * Token lookup order (first hit wins):
 *   1. GH_TOKEN / GITHUB_TOKEN env vars
 *   2. GitHub CLI: `gh auth token` (reuses an existing `gh auth login`)
 *   3. Token saved by this tool (device-flow login or pasted token), mode 0600:
 *      <agentDir>/grokbot-import/github-token.json
 *
 * Web login:
 *   - `gh auth login --web` when the GitHub CLI is installed (default).
 *   - GitHub OAuth device flow when YOU provide your own OAuth App client id
 *     (GROKBOT_GITHUB_CLIENT_ID or `grokbot config set github-client-id <id>`).
 *     This package deliberately ships no client id; see README "GitHub device flow".
 *   - Pasting a fine-grained token is the fallback.
 *
 * Tokens are never printed or logged.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { stateDir, readJson, writeJson, readConfig } from "./paths.mjs";

const UA = "pi-grokbot-import";

export function githubTokenPath() {
  return path.join(stateDir(), "github-token.json");
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || ""), missing: err?.code === "ENOENT" });
    });
  });
}

export async function ghInstalled() {
  const r = await run(process.env.GROKBOT_GH_BIN || "gh", ["--version"]);
  return !r.missing && r.code === 0;
}

async function ghToken() {
  const r = await run(process.env.GROKBOT_GH_BIN || "gh", ["auth", "token", "--hostname", "github.com"]);
  const t = r.code === 0 ? r.stdout.trim() : "";
  return t || null;
}

/** @returns {Promise<{token: string, source: string} | null>} */
export async function getGitHubToken() {
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    if (process.env[name]) return { token: process.env[name].trim(), source: `env:${name}` };
  }
  const gh = await ghToken();
  if (gh) return { token: gh, source: "gh-cli" };
  const saved = readJson(githubTokenPath(), null);
  if (saved?.token) return { token: saved.token, source: `saved:${saved.method || "token"}` };
  return null;
}

export async function githubUser(token) {
  const res = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": UA, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j?.login || null;
}

export async function githubStatus() {
  const t = await getGitHubToken();
  if (!t) return { loggedIn: false };
  const login = await githubUser(t.token).catch(() => null);
  return { loggedIn: !!login, login, source: t.source, invalid: !login };
}

export function saveGitHubToken(token, method = "token") {
  const clean = String(token || "").trim();
  if (!clean) throw new Error("Empty token");
  writeJson(githubTokenPath(), { token: clean, method, savedAt: new Date().toISOString() }, 0o600);
  try {
    fs.chmodSync(githubTokenPath(), 0o600);
  } catch {
    /* ignore */
  }
}

export function clearGitHubToken() {
  try {
    fs.unlinkSync(githubTokenPath());
    return true;
  } catch {
    return false;
  }
}

export function githubClientId() {
  return process.env.GROKBOT_GITHUB_CLIENT_ID || readConfig().githubClientId || null;
}

/** Interactive `gh auth login --web` (needs a terminal). */
export function ghWebLogin() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.GROKBOT_GH_BIN || "gh", ["auth", "login", "--web", "--hostname", "github.com", "--git-protocol", "https"], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`gh auth login exited with ${code}`))));
  });
}

/**
 * GitHub OAuth device flow with the user's OWN OAuth App client id.
 * onCode({verificationUri, userCode}) is called so the caller can show/open it.
 */
export async function deviceFlowLogin({ clientId, onCode, openBrowser, scope = "repo", signal } = {}) {
  clientId = clientId || githubClientId();
  if (!clientId) throw new Error("No OAuth client id configured (GROKBOT_GITHUB_CLIENT_ID). See README: GitHub device flow.");
  const form = (o) => new URLSearchParams(o).toString();
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: form({ client_id: clientId, scope }),
  });
  const code = await res.json();
  if (!res.ok || !code.device_code) throw new Error(`Device code request failed: ${code.error_description || code.error || res.status}`);
  await onCode?.({ verificationUri: code.verification_uri, userCode: code.user_code, expiresIn: code.expires_in });
  if (openBrowser) await openBrowser(code.verification_uri).catch(() => {});
  let interval = (code.interval || 5) * 1000;
  const deadline = Date.now() + (code.expires_in || 900) * 1000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Login cancelled");
    await new Promise((r) => setTimeout(r, interval));
    const p = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
      body: form({ client_id: clientId, device_code: code.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    });
    const j = await p.json().catch(() => ({}));
    if (j.access_token) {
      saveGitHubToken(j.access_token, "device-flow");
      return { ok: true };
    }
    if (j.error === "slow_down") interval += 5000;
    else if (j.error && j.error !== "authorization_pending") throw new Error(`Device flow failed: ${j.error_description || j.error}`);
  }
  throw new Error("Device flow timed out");
}

export async function openInBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  await new Promise((resolve) => {
    try {
      const c = spawn(cmd, args, { stdio: "ignore", detached: true });
      c.on("error", () => resolve());
      c.unref();
      resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Web-first GitHub login.
 * mode: "auto" (existing auth → gh --web → device flow), "gh", "device".
 * interactive: whether we own a terminal (gh --web needs one).
 */
export async function loginGitHub({ mode = "auto", interactive = !!process.stdin.isTTY, onCode, log = () => {} } = {}) {
  if (mode === "auto") {
    const st = await githubStatus();
    if (st.loggedIn) return { already: true, ...st };
  }
  const hasGh = await ghInstalled();
  if ((mode === "auto" || mode === "gh") && hasGh && interactive) {
    log("Opening GitHub web login via `gh auth login --web` ...");
    await ghWebLogin();
    return { ...(await githubStatus()), method: "gh" };
  }
  if ((mode === "auto" || mode === "device") && githubClientId()) {
    await deviceFlowLogin({ onCode, openBrowser: openInBrowser });
    return { ...(await githubStatus()), method: "device-flow" };
  }
  const hints = [];
  if (hasGh) hints.push("run `gh auth login --web` in a terminal");
  else hints.push("install the GitHub CLI (https://cli.github.com) and run `gh auth login --web`");
  hints.push("or set GH_TOKEN to a fine-grained token with read access to the catalog repo (Contents: read)");
  hints.push("or run `grokbot login github --token` and paste such a token");
  hints.push("or configure your own OAuth App client id for device flow (GROKBOT_GITHUB_CLIENT_ID)");
  throw new Error(`GitHub login needed: ${hints.join("; ")}.`);
}
