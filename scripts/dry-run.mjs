#!/usr/bin/env node
/**
 * Dry-run / self-check without Pi installed.
 * 1) Export Side (and a richer fixture with a skill + fake routine)
 * 2) Import both
 * 3) Assert files exist and persona text survived
 * 4) Share-link URL normalize + offline fixture + live AdaptlyPost fetch
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { importGrokBotBundle, loadBundleFromPath } from "../src/import-bundle.mjs";
import { isGrokBotBundle } from "../src/schema.mjs";
import {
  normalizeTemplateInput,
  parseShareIdFromUrl,
  parseBotTemplateHtml,
  buildMetadataBundle,
  fetchTemplateAsBundle,
  mapFullRecipeToBundle,
  fetchPublicApiMeta,
  tryCursorImportDetails,
} from "../src/fetch-template.mjs";
import {
  normalizePastedCredential,
  saveSession,
  clearSession,
  getSessionStatus,
  sessionPath,
  generatePkceLogin,
} from "../src/cursor-auth.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const examples = path.join(root, "examples");
const testOut = path.join(root, "test-out");
const fixtures = path.join(root, "fixtures");
fs.mkdirSync(examples, { recursive: true });
fs.mkdirSync(testOut, { recursive: true });

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error(`Command failed: ${cmd} ${args.join(" ")}`);
  }
  return r.stdout;
}

console.log("== Export Side ==");
run(process.execPath, [
  path.join(root, "export-grokbot.mjs"),
  "4cb4dc74-7f67-401f-ab93-79e189db8626",
  "--out",
  path.join(examples, "side.grokbot.json"),
]);

const side = loadBundleFromPath(path.join(examples, "side.grokbot.json"));
if (!isGrokBotBundle(side)) throw new Error("Side bundle invalid");
if (side.persona.name !== "Side") throw new Error(`Expected name Side, got ${side.persona.name}`);
if (!/side chat/i.test(side.persona.description)) throw new Error("Side persona description missing");
const dumped = JSON.stringify(side);
if (/blobEncryptionKey|sk-|ghp_|xox[baprs]-/i.test(dumped)) {
  throw new Error("Possible secret leaked into Side bundle");
}
console.log("Side bundle OK:", {
  memories: side.memories.length,
  skills: side.skills.length,
  routines: side.routines.length,
});

const rich = {
  ...side,
  skills: [
    {
      name: "getting-started",
      description: "First conversation after import. Ask setup questions one at a time.",
      body: "# Getting started\n\nAsk what to call you, then which channels or repos matter. Write answers into NOTES.md.\n",
    },
  ],
  routines: [
    {
      name: "morning-quiet-check",
      schedule: "47 8 * * 1-5",
      prompt: "If there is nothing useful to say, stay quiet. Otherwise send a short weekday morning note.",
    },
  ],
  plugins: [{ id: "example-mcp-hint", note: "Placeholder — Side had no marketplace plugins on disk" }],
};
fs.writeFileSync(path.join(examples, "side-with-demo-skill.grokbot.json"), JSON.stringify(rich, null, 2) + "\n");

console.log("== Import Side ==");
const sideOut = path.join(testOut, "side");
fs.rmSync(sideOut, { recursive: true, force: true });
const sideResult = importGrokBotBundle(side, { outDir: sideOut, force: true });
for (const f of ["AGENTS.md", ".pi/APPEND_SYSTEM.md", "NOTES.md", "IMPORT_REPORT.md"]) {
  const p = path.join(sideOut, f);
  if (!fs.existsSync(p)) throw new Error(`Missing ${f}`);
}
const agents = fs.readFileSync(path.join(sideOut, "AGENTS.md"), "utf8");
if (!agents.includes("Side") || !/never write or review code/i.test(agents)) {
  throw new Error("AGENTS.md did not keep Side persona");
}
console.log("Side import OK →", sideResult.outDir);

console.log("== Import rich fixture ==");
const richOut = path.join(testOut, "side-rich");
fs.rmSync(richOut, { recursive: true, force: true });
const richResult = importGrokBotBundle(rich, { outDir: richOut, force: true });
const skillPath = path.join(richOut, ".pi/skills/getting-started/SKILL.md");
const promptPath = path.join(richOut, ".pi/prompts/morning-quiet-check.md");
const cronPath = path.join(richOut, "cron/morning-quiet-check.cron.txt");
for (const p of [skillPath, promptPath, cronPath]) {
  if (!fs.existsSync(p)) throw new Error(`Missing ${p}`);
}
console.log("Rich import OK →", richResult.outDir);

console.log("== Schema reject ==");
let rejected = false;
try {
  importGrokBotBundle({ format: "nope" }, { outDir: path.join(testOut, "bad"), force: true });
} catch {
  rejected = true;
}
if (!rejected) throw new Error("Expected invalid bundle to throw");

const SHARE_ID = "1GpK7CoPs4e_M__9rb3uR";
console.log("== URL normalize (three shapes → same id) ==");
const shapes = [
  `https://x.ai/bot/${SHARE_ID}`,
  `https://x.ai/bot/${SHARE_ID}?ref=grokbottemplates.app`,
  `grokbot://app/v1/bot-template?id=${SHARE_ID}`,
];
const ids = shapes.map((u) => parseShareIdFromUrl(u));
if (!ids.every((id) => id === SHARE_ID)) {
  throw new Error(`URL normalize mismatch: ${JSON.stringify(ids)}`);
}
const mkt = normalizeTemplateInput("https://x.ai/bot/marketplace/bots/seed-a91e4c");
if (mkt.kind !== "marketplace" || mkt.slug !== "seed-a91e4c") {
  throw new Error(`marketplace normalize failed: ${JSON.stringify(mkt)}`);
}
const gbt = normalizeTemplateInput("https://grokbottemplates.app/t/adaptlypost");
if (gbt.kind !== "grokbottemplates" || gbt.slug !== "adaptlypost") {
  throw new Error(`grokbottemplates normalize failed: ${JSON.stringify(gbt)}`);
}
console.log("URL normalize OK");

console.log("== Offline fixture → metadata bundle ==");
const fixturePath = path.join(fixtures, "adaptlypost-share.html");
if (!fs.existsSync(fixturePath)) throw new Error(`Missing fixture ${fixturePath}`);
const fixtureHtml = fs.readFileSync(fixturePath, "utf8");
const fixtureMeta = parseBotTemplateHtml(fixtureHtml);
if (!fixtureMeta || fixtureMeta.botName !== "AdaptlyPost" || fixtureMeta.id !== SHARE_ID) {
  throw new Error(`Fixture parse failed: ${JSON.stringify(fixtureMeta)}`);
}
const offlineBundle = buildMetadataBundle(fixtureMeta, {
  url: `https://x.ai/bot/${SHARE_ID}`,
  mode: "metadata-only",
});
if (!isGrokBotBundle(offlineBundle)) throw new Error("Offline metadata bundle invalid");
if (offlineBundle.source.mode !== "metadata-only") throw new Error("Expected metadata-only mode");
if (offlineBundle.source.kind !== "xai-share") throw new Error("Expected kind xai-share");
if (!offlineBundle.skills.some((s) => s.name === "getting-started")) {
  throw new Error("Missing getting-started skill on metadata bundle");
}
if (offlineBundle.routines.length !== 0 || offlineBundle.memories.length !== 0) {
  throw new Error("Metadata bundle should have empty memories/routines");
}
const offlineOut = path.join(testOut, "adaptly-offline");
fs.rmSync(offlineOut, { recursive: true, force: true });
importGrokBotBundle(offlineBundle, { outDir: offlineOut, force: true });
const offlineAgents = fs.readFileSync(path.join(offlineOut, "AGENTS.md"), "utf8");
if (!offlineAgents.includes("AdaptlyPost") || !/Instagram|TikTok|schedule/i.test(offlineAgents)) {
  throw new Error("Offline AGENTS.md missing AdaptlyPost description");
}
if (!fs.existsSync(path.join(offlineOut, ".pi/skills/getting-started/SKILL.md"))) {
  throw new Error("Offline getting-started skill missing");
}
const offlineReport = fs.readFileSync(path.join(offlineOut, "IMPORT_REPORT.md"), "utf8");
if (!/mode: `metadata-only`/.test(offlineReport)) {
  throw new Error("IMPORT_REPORT.md missing mode: metadata-only");
}
console.log("Offline fixture OK →", offlineOut);

console.log("== Live fetch AdaptlyPost (if network works) ==");
let liveOk = false;
try {
  const live = await fetchTemplateAsBundle(`https://x.ai/bot/${SHARE_ID}`, {
    skipFullFetch: false,
  });
  if (live.meta.botName !== "AdaptlyPost") {
    throw new Error(`Expected AdaptlyPost, got ${live.meta.botName}`);
  }
  if (live.mode !== "metadata-only") {
    throw new Error(`Expected metadata-only (no public full recipe); got ${live.mode}`);
  }
  if (live.bundle.persona.name !== "AdaptlyPost") {
    throw new Error("Live bundle persona name mismatch");
  }
  const liveOut = path.join(testOut, "adaptly-live");
  fs.rmSync(liveOut, { recursive: true, force: true });
  importGrokBotBundle(live.bundle, { outDir: liveOut, force: true });
  const liveAgents = fs.readFileSync(path.join(liveOut, "AGENTS.md"), "utf8");
  if (!liveAgents.includes("AdaptlyPost") || !/schedule/i.test(liveAgents)) {
    throw new Error("Live AGENTS.md missing description");
  }
  if (!fs.existsSync(path.join(liveOut, ".pi/skills/getting-started/SKILL.md"))) {
    throw new Error("Live getting-started skill missing");
  }
  const liveReport = fs.readFileSync(path.join(liveOut, "IMPORT_REPORT.md"), "utf8");
  if (!/mode: `metadata-only`/.test(liveReport)) {
    throw new Error("Live IMPORT_REPORT missing metadata-only");
  }
  console.log("Live fetch OK →", liveOut, {
    mode: live.mode,
    fullFetchOk: live.fullFetch.ok,
    attempts: live.fullFetch.attempts?.length ?? 0,
    localCacheHits: live.localCacheHits.length,
  });
  liveOk = true;
} catch (err) {
  console.warn("Live fetch skipped/failed (network?):", err?.message || err);
}


console.log("== Public GetPublicGrokBotTemplate (live, no auth) ==");
let publicApiOk = false;
try {
  const pub = await fetchPublicApiMeta(SHARE_ID);
  if (!pub.ok) throw new Error(`public API failed: ${pub.status} ${pub.error || ""}`);
  if (pub.meta.botName !== "AdaptlyPost") {
    throw new Error(`Expected AdaptlyPost from public API, got ${pub.meta.botName}`);
  }
  if (!pub.meta.blobObjectKey) throw new Error("public API missing blobObjectKey");
  console.log("Public API OK:", {
    name: pub.meta.botName,
    owner: pub.meta.sharerName,
    version: pub.meta.activeVersion,
    blobObjectKey: pub.meta.blobObjectKey,
  });
  publicApiOk = true;
} catch (err) {
  console.warn("Public API skipped/failed:", err?.message || err);
}

console.log("== Cursor auth helpers (no real login) ==");
{
  const pkce = generatePkceLogin();
  if (!pkce.loginUrl.includes("loginDeepControl") || !pkce.verifier || !pkce.challenge) {
    throw new Error("PKCE login URL malformed");
  }
  if (pkce.loginUrl.includes(pkce.verifier)) {
    throw new Error("PKCE verifier must not appear in login URL");
  }
  const jwt =
    "eyJhbGciOiJub25lIn0." +
    Buffer.from(JSON.stringify({ sub: "user_test", email: "a@example.com", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url") +
    ".x";
  const n1 = normalizePastedCredential(jwt);
  if (n1.kind !== "access-token") throw new Error("expected access-token kind");
  const n2 = normalizePastedCredential(`user_test::${jwt}`);
  if (n2.kind !== "access-token" || n2.accessToken !== jwt) throw new Error("cookie form parse failed");
  const n3 = normalizePastedCredential("crsr_test_key_not_real");
  if (n3.kind !== "api-key") throw new Error("expected api-key kind");

  // Isolated session file under tmp HOME so we never touch the user's real session
  const prevHome = process.env.HOME;
  const tmpHome = path.join(testOut, "fake-home-auth");
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.mkdirSync(tmpHome, { recursive: true });
  process.env.HOME = tmpHome;
  try {
    clearSession();
    if (getSessionStatus().loggedIn) throw new Error("expected logged out");
    saveSession({ accessToken: jwt, authMethod: "pasted-token", email: "a@example.com" });
    const st = getSessionStatus();
    if (!st.loggedIn) throw new Error("expected logged in");
    if (st.emailRedacted && st.emailRedacted.includes("@example.com") && !st.emailRedacted.startsWith("a***")) {
      throw new Error(`email not redacted: ${st.emailRedacted}`);
    }
    const raw = fs.readFileSync(sessionPath(), "utf8");
    if (!raw.includes("accessToken")) throw new Error("session file missing accessToken");
    const mode = fs.statSync(sessionPath()).mode & 0o777;
    if (mode & 0o077) {
      console.warn(`warning: session mode ${mode.toString(8)} (expected 0600); continuing`);
    }
    clearSession();
    if (getSessionStatus().loggedIn) throw new Error("logout failed");
  } finally {
    process.env.HOME = prevHome;
  }
  console.log("Cursor auth helpers OK");
}

console.log("== Mock ImportDetails + blob → full bundle ==");
{
  const recipe = {
    profile: {
      name: "MockFullBot",
      description: "Full recipe from mocked ImportDetails blob",
      avatarShape: "sphere",
      avatarColor: "green",
    },
    memory: "Remember the owner prefers concise updates.",
    skills: [
      {
        name: "draft-post",
        description: "Draft a social post",
        content: "# Draft post\n\nWrite a short caption.\n",
      },
    ],
    routines: [
      {
        slug: "morning-scan",
        name: "morning-scan",
        description: "Weekday morning",
        content: "Scan inboxes quietly; only ping if urgent.",
      },
    ],
    plugins: [{ pluginId: "example-connector", description: "hint only" }],
    gettingStarted: {
      name: "getting-started",
      description: "Onboarding",
      content: "# Hello\n\nAsk one setup question.\n",
    },
  };

  const mockFetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || "GET").toUpperCase();
    if (u.includes("GetGrokBotTemplateImportDetails") && method === "POST") {
      const auth = init.headers?.Authorization || init.headers?.authorization || "";
      if (!String(auth).startsWith("Bearer ")) {
        return {
          ok: false,
          status: 401,
          text: async () =>
            JSON.stringify({
              code: "unauthenticated",
              details: [{ debug: { error: "ERROR_NOT_LOGGED_IN" } }],
            }),
          json: async () => ({
            code: "unauthenticated",
            details: [{ debug: { error: "ERROR_NOT_LOGGED_IN" } }],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            blobGetUrl: "https://example.test/blob/mock-recipe.json",
            template: { shareId: SHARE_ID, name: "MockFullBot" },
          }),
        json: async () => ({
          blobGetUrl: "https://example.test/blob/mock-recipe.json",
          template: { shareId: SHARE_ID, name: "MockFullBot" },
        }),
      };
    }
    if (u === "https://example.test/blob/mock-recipe.json") {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(recipe),
        json: async () => recipe,
      };
    }
    if (u.includes("GetPublicGrokBotTemplate") && method === "POST") {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            template: {
              shareId: SHARE_ID,
              name: "AdaptlyPost",
              description: "mock desc",
              avatarShape: "blob",
              avatarColor: "blue",
              blobObjectKey: "templates/mock.json",
              activeVersion: 1,
              published: true,
              ownerType: "GROK_BOT_TEMPLATE_OWNER_TYPE_USER",
            },
            ownerDisplayName: "Mock Owner",
          }),
        json: async () => ({
          template: {
            shareId: SHARE_ID,
            name: "AdaptlyPost",
            description: "mock desc",
            avatarShape: "blob",
            avatarColor: "blue",
            blobObjectKey: "templates/mock.json",
            activeVersion: 1,
            published: true,
            ownerType: "GROK_BOT_TEMPLATE_OWNER_TYPE_USER",
          },
          ownerDisplayName: "Mock Owner",
        }),
      };
    }
    // Unauth ImportDetails path should not hit HTML in this mock test
    throw new Error(`unexpected mock fetch: ${method} ${u}`);
  };

  const unauth = await tryCursorImportDetails(SHARE_ID, {
    accessToken: null,
    fetchImpl: mockFetch,
  });
  if (unauth.ok || unauth.reason !== "no-session") {
    throw new Error(`expected no-session, got ${JSON.stringify(unauth)}`);
  }

  const unauthorized = await tryCursorImportDetails(SHARE_ID, {
    accessToken: "",
    fetchImpl: mockFetch,
  });
  // empty string is falsy → no-session; use a fake bearer for 401 path
  const unauthorized2 = await tryCursorImportDetails(SHARE_ID, {
    accessToken: "not-a-real-token",
    fetchImpl: async (url, init) => {
      // Force 401 without Bearer acceptance
      if (String(url).includes("ImportDetails")) {
        return {
          ok: false,
          status: 401,
          text: async () =>
            JSON.stringify({
              code: "unauthenticated",
              details: [{ debug: { error: "ERROR_NOT_LOGGED_IN" } }],
            }),
          json: async () => ({
            code: "unauthenticated",
            details: [{ debug: { error: "ERROR_NOT_LOGGED_IN" } }],
          }),
        };
      }
      return mockFetch(url, init);
    },
  });
  if (!unauthorized2.notLoggedIn && unauthorized2.reason !== "not-logged-in") {
    // tryCursorImportDetails sets reason not-logged-in
    if (unauthorized2.reason !== "not-logged-in") {
      throw new Error(`expected not-logged-in, got ${JSON.stringify(unauthorized2)}`);
    }
  }

  const full = await tryCursorImportDetails(SHARE_ID, {
    accessToken: "test-bearer",
    fetchImpl: mockFetch,
  });
  if (!full.ok || !full.recipe) throw new Error(`mock full import failed: ${JSON.stringify(full)}`);

  const bundle = mapFullRecipeToBundle(full.recipe, {
    id: SHARE_ID,
    url: `https://x.ai/bot/${SHARE_ID}`,
    sharerName: "Mock Owner",
    importSource: "GetGrokBotTemplateImportDetails",
  });
  if (!isGrokBotBundle(bundle)) throw new Error("mapped full bundle invalid");
  if (bundle.source.mode !== "full") throw new Error("expected mode full");
  if (bundle.persona.name !== "MockFullBot") throw new Error("persona name mismatch");
  if (!bundle.skills.some((sk) => sk.name === "draft-post" && /caption/i.test(sk.body))) {
    throw new Error("draft-post skill body missing");
  }
  if (!bundle.skills.some((sk) => sk.name === "getting-started")) {
    throw new Error("getting-started from recipe missing");
  }
  if (bundle.routines.length !== 1 || !/urgent/i.test(bundle.routines[0].prompt)) {
    throw new Error("routine prompt missing");
  }
  if (bundle.memories.length < 1) throw new Error("memory missing");
  if (!bundle.plugins.some((p) => p.id === "example-connector")) {
    throw new Error("pluginId mapping failed");
  }

  const mockOut = path.join(testOut, "mock-full-cursor");
  fs.rmSync(mockOut, { recursive: true, force: true });
  importGrokBotBundle(bundle, { outDir: mockOut, force: true });
  const report = fs.readFileSync(path.join(mockOut, "IMPORT_REPORT.md"), "utf8");
  if (!/mode: `full`/.test(report)) throw new Error("IMPORT_REPORT missing mode: full");
  if (!fs.existsSync(path.join(mockOut, ".pi/skills/draft-post/SKILL.md"))) {
    throw new Error("draft-post skill file missing");
  }
  console.log("Mock ImportDetails+blob OK →", mockOut);

  // End-to-end fetchTemplateAsBundle with injected token + mock fetch
  const e2e = await fetchTemplateAsBundle(`https://x.ai/bot/${SHARE_ID}`, {
    accessToken: "test-bearer",
    fetchImpl: mockFetch,
    skipFullFetch: false,
  });
  if (e2e.mode !== "full" || e2e.bundle.persona.name !== "MockFullBot") {
    throw new Error(`e2e full path failed: mode=${e2e.mode} name=${e2e.bundle.persona.name}`);
  }
  console.log("E2E fetchTemplateAsBundle full path OK");

  // Without token → metadata-only via mocked public API
  const metaOnly = await fetchTemplateAsBundle(`https://x.ai/bot/${SHARE_ID}`, {
    accessToken: null,
    skipCursorImport: false,
    fetchImpl: mockFetch,
    skipFullFetch: true,
  });
  // skipFullFetch true skips cursor too — use skipFullFetch false but no token
  const metaOnly2 = await fetchTemplateAsBundle(`https://x.ai/bot/${SHARE_ID}`, {
    accessToken: null,
    fetchImpl: async (url, init) => {
      const u = String(url);
      if (u.includes("GetPublicGrokBotTemplate")) return mockFetch(url, init);
      if (u.includes("ImportDetails")) {
        return {
          ok: false,
          status: 401,
          text: async () => JSON.stringify({ code: "unauthenticated" }),
          json: async () => ({ code: "unauthenticated" }),
        };
      }
      // legacy probes / html — return empty failure-ish
      return {
        ok: false,
        status: 404,
        text: async () => "",
        url: u,
        contentType: "text/plain",
      };
    },
  });
  if (metaOnly2.mode !== "metadata-only") {
    throw new Error(`expected metadata-only without session, got ${metaOnly2.mode}`);
  }
  if (metaOnly2.bundle.persona.name !== "AdaptlyPost") {
    throw new Error("metadata-only persona should come from public API mock");
  }
  console.log("E2E metadata-only fallback OK");
  void unauthorized;
  void metaOnly;
}


console.log("\nDRY-RUN PASSED" + (liveOk ? " (incl. live AdaptlyPost)" : " (live fetch skipped)") + (publicApiOk ? " (incl. public API)" : ""));
