/**
 * Cursor session for api2.cursor.sh (Grok Bot template import).
 *
 * Auth model (cited):
 * - Cursor CLI browser login: https://cursor.com/docs/cli/reference/authentication
 *   (`agent login` → loginDeepControl PKCE + poll api2.cursor.sh/auth/poll)
 * - Same PKCE shape used by open-source clients (e.g. loginDeepControl?challenge&uuid,
 *   then GET/POST /auth/poll with verifier) — see Cursor SDK login-flow and
 *   community ports such as lidge-jun/opencodex src/oauth/cursor.ts
 * - api2.cursor.sh ConnectRPC uses Authorization: Bearer <accessToken>
 *   (WorkosCursorSessionToken cookie is for cursor.com web dashboard only)
 * - Optional: Dashboard User API Key → POST /auth/exchange_user_api_key
 *   (https://cursor.com/docs/rollouts)
 *
 * xAI OAuth is NOT used. A free Cursor account is enough for public templates.
 * Never log or print access/refresh tokens.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

export const CURSOR_API2 = "https://api2.cursor.sh";
export const CURSOR_LOGIN_PAGE = "https://cursor.com/loginDeepControl";
export const CURSOR_AUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";

const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY_MS = 1000;
const POLL_MAX_DELAY_MS = 10_000;
const POLL_BACKOFF = 1.2;
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

export function sessionDir() {
  const home = process.env.HOME || os.homedir();
  return path.join(home, ".pi", "agent", "grokbot-import");
}

export function sessionPath() {
  return path.join(sessionDir(), "cursor-session.json");
}

function ensureSessionDir() {
  const dir = sessionDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* ignore */
  }
  return dir;
}

function base64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function generatePkceLogin() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier, "utf8").digest());
  const uuid = crypto.randomUUID();
  const params = new URLSearchParams({
    challenge,
    uuid,
    mode: "login",
    redirectTarget: "cli",
  });
  return {
    verifier,
    challenge,
    uuid,
    loginUrl: `${CURSOR_LOGIN_PAGE}?${params.toString()}`,
  };
}

function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function accessTokenExpiryMs(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  if (payload && typeof payload.exp === "number") {
    return payload.exp * 1000 - EXPIRY_SKEW_MS;
  }
  return Date.now() + 60 * 60 * 1000;
}

export function redactEmail(email) {
  if (!email || typeof email !== "string") return null;
  const at = email.indexOf("@");
  if (at <= 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/**
 * Normalize pasted secrets: bare JWT, WorkosCursorSessionToken (userId::jwt),
 * or User API key (crsr_…).
 * Never returns the raw input in error messages beyond a short kind label.
 */
export function normalizePastedCredential(raw) {
  let s = String(raw || "").trim();
  if (!s) throw new Error("Empty token");

  // Cookie header form
  const cookieM = s.match(/WorkosCursorSessionToken=([^;\s]+)/i);
  if (cookieM) s = decodeURIComponent(cookieM[1]);

  // userId%3A%3Ajwt or userId::jwt
  if (/%3A%3A/i.test(s)) s = decodeURIComponent(s);
  const sep = s.indexOf("::");
  if (sep > 0) {
    const maybeJwt = s.slice(sep + 2);
    if (maybeJwt.split(".").length === 3) {
      return { kind: "access-token", accessToken: maybeJwt };
    }
  }

  if (/^crsr_/i.test(s) || /^key_/i.test(s)) {
    return { kind: "api-key", apiKey: s };
  }

  if (s.split(".").length === 3) {
    return { kind: "access-token", accessToken: s };
  }

  throw new Error(
    "Unrecognized token. Paste a Cursor access JWT, WorkosCursorSessionToken value, or Dashboard User API key (crsr_…).",
  );
}

export async function exchangeUserApiKey(apiKey) {
  const res = await fetch(`${CURSOR_API2}/auth/exchange_user_api_key`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!res.ok) {
    throw new Error(`API key exchange failed (HTTP ${res.status})`);
  }
  const data = await res.json();
  if (!data?.accessToken) throw new Error("API key exchange returned no accessToken");
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || null,
  };
}

/**
 * Refresh via Auth0-style /oauth/token when we have a refresh token.
 * Also try exchange_user_api_key with the refresh token as some CLI builds do.
 */
export async function refreshAccessToken(session) {
  if (!session?.refreshToken) {
    throw new Error("No refresh token stored; run /grokbot-cursor-login again");
  }
  // Preferred: OAuth refresh
  try {
    const res = await fetch(`${CURSOR_API2}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cursor-client-type": "cli",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CURSOR_AUTH_CLIENT_ID,
        refresh_token: session.refreshToken,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      const accessToken = data.accessToken || data.access_token;
      const refreshToken = data.refreshToken || data.refresh_token || session.refreshToken;
      if (accessToken) {
        return { accessToken, refreshToken };
      }
    }
  } catch {
    /* fall through */
  }

  // Fallback used by some open-source Cursor OAuth ports
  const res2 = await fetch(`${CURSOR_API2}/auth/exchange_user_api_key`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.refreshToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!res2.ok) {
    throw new Error(`Token refresh failed (HTTP ${res2.status}); run /grokbot-cursor-login again`);
  }
  const data2 = await res2.json();
  if (!data2?.accessToken) throw new Error("Token refresh returned no accessToken");
  return {
    accessToken: data2.accessToken,
    refreshToken: data2.refreshToken || session.refreshToken,
  };
}

export function saveSession( partial ) {
  ensureSessionDir();
  const file = sessionPath();
  const prev = loadSessionRaw() || {};
  const next = {
    ...prev,
    ...partial,
    updatedAt: new Date().toISOString(),
  };
  if (!next.accessToken) throw new Error("Cannot save session without accessToken");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* ignore */
  }
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
  return statusFromSession(next);
}

function loadSessionRaw() {
  const file = sessionPath();
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || typeof data !== "object" || !data.accessToken) return null;
    return data;
  } catch {
    return null;
  }
}

export function clearSession() {
  const file = sessionPath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

export function statusFromSession(session) {
  if (!session?.accessToken) {
    return { loggedIn: false, path: sessionPath() };
  }
  const payload = decodeJwtPayload(session.accessToken) || {};
  const email =
    (typeof session.email === "string" && session.email) ||
    (typeof payload.email === "string" && payload.email) ||
    null;
  const expMs = accessTokenExpiryMs(session.accessToken);
  return {
    loggedIn: true,
    path: sessionPath(),
    authMethod: session.authMethod || "unknown",
    emailRedacted: redactEmail(email),
    expired: Date.now() >= expMs,
    expiresAt: new Date(expMs + EXPIRY_SKEW_MS).toISOString(),
  };
}

export function getSessionStatus() {
  return statusFromSession(loadSessionRaw());
}

/**
 * Return a usable Bearer access token, refreshing if near expiry.
 * @returns {Promise<string|null>}
 */
export async function getAccessToken({ allowRefresh = true } = {}) {
  let session = loadSessionRaw();
  if (!session?.accessToken) return null;
  if (Date.now() < accessTokenExpiryMs(session.accessToken)) {
    return session.accessToken;
  }
  if (!allowRefresh || !session.refreshToken) {
    return session.accessToken; // let the API 401; caller falls back
  }
  try {
    const refreshed = await refreshAccessToken(session);
    saveSession({
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      authMethod: session.authMethod || "pkce",
      email: session.email,
    });
    return refreshed.accessToken;
  } catch {
    return session.accessToken;
  }
}

export function authHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1",
  };
}

async function sleep(ms, signal) {
  if (signal?.aborted) throw new Error("Login cancelled");
  await new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("Login cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Poll until browser completes loginDeepControl.
 * Tries POST /auth/poll (body) first, then GET ?uuid&verifier (CLI-compatible).
 */
export async function pollForLoginTokens(uuid, verifier, { signal, maxAttempts = POLL_MAX_ATTEMPTS } = {}) {
  let delay = POLL_BASE_DELAY_MS;
  let consecutiveErrors = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(delay, signal);
    try {
      let res = await fetch(`${CURSOR_API2}/auth/poll`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-cursor-client-type": "cli",
        },
        body: JSON.stringify({ uuid, verifier }),
        signal,
      });

      // Older backends: POST may 404 as route-not-found — fall back to GET once sticky.
      if (res.status === 404 || res.status === 405) {
        const getUrl = `${CURSOR_API2}/auth/poll?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`;
        res = await fetch(getUrl, {
          method: "GET",
          headers: { "x-cursor-client-type": "cli" },
          signal,
        });
      }

      if (res.status === 404) {
        consecutiveErrors = 0;
        delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_DELAY_MS);
        continue;
      }

      if (res.ok) {
        const data = await res.json();
        const accessToken = data.accessToken || data.access_token;
        const refreshToken = data.refreshToken || data.refresh_token || null;
        if (!accessToken) throw new Error("Login poll returned no accessToken");
        return { accessToken, refreshToken };
      }

      if ([400, 401, 403, 410].includes(res.status)) {
        throw new Error(`Login rejected by Cursor (HTTP ${res.status}); start a new /grokbot-cursor-login`);
      }

      throw new Error(`Login poll failed (HTTP ${res.status})`);
    } catch (err) {
      if (signal?.aborted) throw err;
      if (/Login rejected|Login poll failed|no accessToken/.test(String(err?.message || err))) {
        throw err;
      }
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        throw new Error("Too many consecutive errors while waiting for Cursor login");
      }
      delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_DELAY_MS);
    }
  }
  throw new Error("Cursor login timed out — open the URL again or use /grokbot-cursor-login-token");
}

export function tryOpenBrowser(url) {
  if (process.env.NO_OPEN_BROWSER === "1") return false;
  const platform = process.platform;
  let cmd;
  let args;
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Full browser PKCE login; blocks until complete or timeout.
 */
export async function loginWithBrowser({ signal, openBrowser = true, onLoginUrl } = {}) {
  const { verifier, uuid, loginUrl } = generatePkceLogin();
  if (typeof onLoginUrl === "function") onLoginUrl(loginUrl);
  let opened = false;
  if (openBrowser) opened = tryOpenBrowser(loginUrl);
  const tokens = await pollForLoginTokens(uuid, verifier, { signal });
  const payload = decodeJwtPayload(tokens.accessToken) || {};
  const status = saveSession({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    authMethod: "pkce",
    email: typeof payload.email === "string" ? payload.email : undefined,
  });
  return { status, loginUrl, opened };
}

/**
 * Accept a pasted credential and persist a session.
 */
export async function loginWithPastedToken(raw) {
  const norm = normalizePastedCredential(raw);
  let accessToken;
  let refreshToken = null;
  let authMethod;

  if (norm.kind === "api-key") {
    const exchanged = await exchangeUserApiKey(norm.apiKey);
    accessToken = exchanged.accessToken;
    refreshToken = exchanged.refreshToken;
    authMethod = "api-key";
  } else {
    accessToken = norm.accessToken;
    authMethod = "pasted-token";
  }

  const payload = decodeJwtPayload(accessToken) || {};
  return saveSession({
    accessToken,
    refreshToken,
    authMethod,
    email: typeof payload.email === "string" ? payload.email : undefined,
  });
}

/**
 * ConnectRPC JSON call to api2.cursor.sh with optional Bearer.
 */
export async function cursorConnectRpc(serviceMethod, body, { accessToken, fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch;
  const headers = {
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1",
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await doFetch(`${CURSOR_API2}/${serviceMethod}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {
    ok: res.ok,
    status: res.status,
    json,
    text,
    notLoggedIn:
      res.status === 401 ||
      json?.code === "unauthenticated" ||
      /ERROR_NOT_LOGGED_IN/.test(text || ""),
  };
}

export async function getPublicGrokBotTemplate(shareId, { fetchImpl } = {}) {
  return cursorConnectRpc(
    "aiserver.v1.GrokBotService/GetPublicGrokBotTemplate",
    { shareId },
    { fetchImpl },
  );
}

export async function getGrokBotTemplateImportDetails(shareId, { accessToken, fetchImpl } = {}) {
  if (!accessToken) {
    return {
      ok: false,
      status: 401,
      json: null,
      text: "",
      notLoggedIn: true,
    };
  }
  return cursorConnectRpc(
    "aiserver.v1.GrokBotService/GetGrokBotTemplateImportDetails",
    { shareId },
    { accessToken, fetchImpl },
  );
}

/**
 * Download recipe blob. Uses redirect: 'error' semantics (no automatic follow).
 */
export async function downloadBlobGetUrl(blobGetUrl, { fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch;
  let res;
  try {
    res = await doFetch(blobGetUrl, { method: "GET", redirect: "error" });
  } catch (err) {
    const msg = String(err?.message || err);
    if (/redirect/i.test(msg)) {
      throw new Error(
        "blobGetUrl returned a redirect; refusing to follow (redirect: error). Re-fetch ImportDetails for a fresh URL.",
      );
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`blobGetUrl HTTP ${res.status}`);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("blobGetUrl body was not JSON");
  }
  return json;
}
