/**
 * Fetch Grok Bot share / marketplace templates and build a grokbot-bundle/v1.
 *
 * Paths:
 * 1. Cursor session present → GetGrokBotTemplateImportDetails + blobGetUrl → mode: full
 * 2. Else / on 401 → GetPublicGrokBotTemplate (or HTML scrape) → mode: metadata-only
 *
 * Confirmed APIs on https://api2.cursor.sh (ConnectRPC JSON):
 * - POST /aiserver.v1.GrokBotService/GetPublicGrokBotTemplate  (no auth)
 * - POST /aiserver.v1.GrokBotService/GetGrokBotTemplateImportDetails (Bearer session)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BUNDLE_FORMAT } from "./schema.mjs";
import {
  getAccessToken,
  getPublicGrokBotTemplate,
  getGrokBotTemplateImportDetails,
  downloadBlobGetUrl,
} from "./cursor-auth.mjs";

const XAI_SHARE_RE =
  /^https?:\/\/(?:www\.)?x\.ai\/bot\/([A-Za-z0-9_-]+)\/?(?:\?.*)?$/i;
const XAI_MARKETPLACE_RE =
  /^https?:\/\/(?:www\.)?x\.ai\/bot\/marketplace\/bots\/([A-Za-z0-9_-]+)\/?(?:\?.*)?$/i;
const GROKBOTTEMPLATES_RE =
  /^https?:\/\/(?:www\.)?grokbottemplates\.app\/t\/([A-Za-z0-9_-]+)\/?(?:\?.*)?$/i;
const GROKBOTTEMPLATES_API_RE =
  /^https?:\/\/(?:www\.)?grokbottemplates\.app\/api\/v1\/templates\/([A-Za-z0-9_-]+)(?:\.json)?\/?(?:\?.*)?$/i;
const DEEP_LINK_RE =
  /^grokbot:\/\/app\/v1\/bot-template\?(?:[^#]*&)?id=([A-Za-z0-9_-]+)/i;

const BOT_TEMPLATE_ESCAPED_RE =
  /\\"id\\":\\"([^"\\]+)\\",\\"ownerType\\":\\"([^"\\]+)\\",\\"sharerName\\":\\"(.*?)\\",\\"botName\\":\\"(.*?)\\",\\"description\\":\\"(.*?)\\",\\"addHref\\":\\"(.*?)\\",\\"color\\":\\"(.*?)\\",\\"shape\\":\\"(.*?)\\"/s;

const BOT_TEMPLATE_PLAIN_RE =
  /"id":"([^"]+)","ownerType":"([^"]+)","sharerName":"((?:[^"\\]|\\.)*)","botName":"((?:[^"\\]|\\.)*)","description":"((?:[^"\\]|\\.)*)","addHref":"((?:[^"\\]|\\.)*)","color":"((?:[^"\\]|\\.)*)","shape":"((?:[^"\\]|\\.)*)"/s;

const MARKETPLACE_TEMPLATE_ESCAPED_RE =
  /\\"template\\":\{\\"id\\":\\"([^"\\]+)\\",\\"name\\":\\"([^"\\]+)\\"(.*?)\\"addHref\\":\\"([^"\\]+)\\"/s;

const DEFAULT_FETCH_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  "User-Agent":
    "pi-grokbot-import/1.2 (+https://github.com/local; share import; credentials only when Cursor session present)",
};

function jsonUnescape(fragment) {
  return JSON.parse(`"${fragment}"`);
}

/** @returns {boolean} */
export function isGrokBotShareOrMarketplaceUrl(input) {
  const s = String(input || "").trim();
  if (!s) return false;
  if (DEEP_LINK_RE.test(s)) return true;
  if (XAI_MARKETPLACE_RE.test(s)) return true;
  if (GROKBOTTEMPLATES_RE.test(s) || GROKBOTTEMPLATES_API_RE.test(s)) return true;
  const m = s.match(XAI_SHARE_RE);
  if (m && m[1].toLowerCase() !== "marketplace") return true;
  return false;
}

/**
 * Normalize supported link shapes into a structured target.
 * Does not fetch.
 */
export function normalizeTemplateInput(input) {
  const raw = String(input || "").trim().replace(/^["']|["']$/g, "");
  if (!raw) throw new Error("Empty template URL / id");

  let m = raw.match(DEEP_LINK_RE);
  if (m) {
    return {
      kind: "share-id",
      id: m[1],
      url: `https://x.ai/bot/${m[1]}`,
      original: raw,
    };
  }

  m = raw.match(XAI_MARKETPLACE_RE);
  if (m) {
    return {
      kind: "marketplace",
      slug: m[1],
      url: `https://x.ai/bot/marketplace/bots/${m[1]}`,
      original: raw,
    };
  }

  m = raw.match(GROKBOTTEMPLATES_RE) || raw.match(GROKBOTTEMPLATES_API_RE);
  if (m) {
    return {
      kind: "grokbottemplates",
      slug: m[1],
      url: `https://grokbottemplates.app/t/${m[1]}`,
      apiUrl: `https://grokbottemplates.app/api/v1/templates/${m[1]}.json`,
      original: raw,
    };
  }

  m = raw.match(XAI_SHARE_RE);
  if (m && m[1].toLowerCase() !== "marketplace") {
    const id = m[1];
    return {
      kind: "share-id",
      id,
      url: `https://x.ai/bot/${id}`,
      original: raw,
    };
  }

  // Bare template id (share id, not a filesystem path)
  if (/^[A-Za-z0-9_-]{8,64}$/.test(raw) && !raw.includes("/") && !raw.includes(".")) {
    return {
      kind: "share-id",
      id: raw,
      url: `https://x.ai/bot/${raw}`,
      original: raw,
    };
  }

  throw new Error(
    `Unrecognized Grok Bot share/marketplace URL: ${raw}\n` +
      "Expected https://x.ai/bot/{id}, grokbot://app/v1/bot-template?id=…, " +
      "https://x.ai/bot/marketplace/bots/{slug}, or https://grokbottemplates.app/t/{slug}",
  );
}

/** Parse three common URL shapes into the same share id (sync, no network). */
export function parseShareIdFromUrl(input) {
  const n = normalizeTemplateInput(input);
  if (n.kind === "share-id") return n.id;
  throw new Error(
    `URL needs a network resolve step before an id is known (kind=${n.kind}): ${input}`,
  );
}

export function parseBotTemplateHtml(html) {
  if (!html || typeof html !== "string") return null;
  let m = html.match(BOT_TEMPLATE_ESCAPED_RE);
  let unescape = true;
  if (!m) {
    m = html.match(BOT_TEMPLATE_PLAIN_RE);
    unescape = false;
  }
  if (!m) return null;
  const take = (i) => (unescape ? jsonUnescape(m[i]) : jsonUnescape(m[i]));
  return {
    id: m[1],
    ownerType: m[2],
    sharerName: take(3),
    botName: take(4),
    description: take(5),
    addHref: take(6),
    color: m[7],
    shape: m[8],
  };
}

export function parseMarketplaceHtml(html) {
  if (!html || typeof html !== "string") return null;
  const m = html.match(MARKETPLACE_TEMPLATE_ESCAPED_RE);
  if (!m) {
    // Plain fallback
    const plain = html.match(
      /"template":\{"id":"([^"]+)","name":"([^"]+)"([\s\S]*?)"addHref":"([^"]+)"/,
    );
    if (!plain) return null;
    const block = plain[0];
    const descM = block.match(/"description":"((?:[^"\\]|\\.)*)"/);
    const creatorM = block.match(/"creatorName":"((?:[^"\\]|\\.)*)"/);
    const addHref = plain[4];
    const shareId = shareIdFromAddHref(addHref);
    return {
      slug: plain[1],
      name: plain[2],
      description: descM ? jsonUnescape(descM[1]) : "",
      creatorName: creatorM ? jsonUnescape(creatorM[1]) : "",
      addHref,
      shareId,
    };
  }
  const slug = m[1];
  const name = jsonUnescape(m[2]);
  const block = m[0];
  const descM = block.match(/\\"description\\":\\"(.*?)\\"/s);
  const creatorM = block.match(/\\"creatorName\\":\\"(.*?)\\"/s);
  const addHref = m[4];
  return {
    slug,
    name,
    description: descM ? jsonUnescape(descM[1]) : "",
    creatorName: creatorM ? jsonUnescape(creatorM[1]) : "",
    addHref,
    shareId: shareIdFromAddHref(addHref),
  };
}

export function shareIdFromAddHref(addHref) {
  if (!addHref) return null;
  const s = String(addHref).trim();
  let m = s.match(DEEP_LINK_RE);
  if (m) return m[1];
  m = s.match(/^\/bot\/([A-Za-z0-9_-]+)\/?$/i);
  if (m && m[1].toLowerCase() !== "marketplace") return m[1];
  m = s.match(XAI_SHARE_RE);
  if (m && m[1].toLowerCase() !== "marketplace") return m[1];
  return null;
}

async function fetchText(url, { headers } = {}) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { ...DEFAULT_FETCH_HEADERS, ...(headers || {}) },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, url: res.url, text, contentType: res.headers.get("content-type") || "" };
}

/** Adapt a fetch()-like or fetchText()-like impl to ConnectRPC (Response-like). */
export function asFetchResponse(fetchImpl) {
  const base = fetchImpl || fetch;
  return async (url, init = {}) => {
    const r = await base(url, init);
    // Already Response-like (has async text())
    if (r && typeof r.text === "function") return r;
    // fetchText-shaped { ok, status, text: string, contentType }
    if (r && typeof r.text === "string") {
      const body = r.text;
      return {
        ok: r.ok,
        status: r.status,
        url: r.url || url,
        headers: {
          get(name) {
            if (String(name).toLowerCase() === "content-type") return r.contentType || "";
            return null;
          },
        },
        text: async () => body,
        json: async () => JSON.parse(body),
      };
    }
    throw new Error("fetchImpl returned an unrecognized response shape");
  };
}

/** Adapt a fetch()-like impl to the { ok, status, text, contentType } shape used by HTML probes. */
export function asFetchText(fetchImpl) {
  if (!fetchImpl) return fetchText;
  return async (url, opts = {}) => {
    const r = await fetchImpl(url, {
      redirect: "follow",
      headers: { ...DEFAULT_FETCH_HEADERS, ...(opts.headers || {}) },
      ...opts,
    });
    if (r && typeof r.text === "string" && "contentType" in r) return r;
    const text = typeof r.text === "function" ? await r.text() : String(r.text ?? "");
    return {
      ok: Boolean(r.ok),
      status: r.status ?? 0,
      url: r.url || url,
      text,
      contentType:
        (typeof r.headers?.get === "function" && r.headers.get("content-type")) ||
        r.contentType ||
        "",
    };
  };
}


/**
 * Best-effort probe for a full recipe JSON. Never fabricates success.
 * Returns { ok:false, attempts:[…] } or { ok:true, data, url }.
 */
export async function tryAuthenticatedFullFetch(templateId, { fetchImpl } = {}) {
  const doFetch = fetchImpl || fetchText;
  const attempts = [];
  const candidates = [
    `https://x.ai/api/bot-template/${templateId}`,
    `https://x.ai/api/v1/bot-template/${templateId}`,
    `https://api.x.ai/v1/bot-template/${templateId}`,
    `https://x.ai/bot/api/template/${templateId}`,
    `https://x.ai/bot/${templateId}.json`,
    `https://x.ai/bot/${templateId}/export`,
    `https://x.ai/bot/${templateId}/bundle`,
  ];

  for (const url of candidates) {
    try {
      const res = await doFetch(url, {
        headers: { Accept: "application/json, text/plain;q=0.8, */*;q=0.5" },
      });
      const ct = res.contentType || "";
      const looksJson =
        /json/i.test(ct) ||
        (res.text.trim().startsWith("{") && !/<html/i.test(res.text.slice(0, 200)));
      let parsed = null;
      if (looksJson) {
        try {
          parsed = JSON.parse(res.text);
        } catch {
          parsed = null;
        }
      }
      const hasRecipe =
        parsed &&
        typeof parsed === "object" &&
        (Array.isArray(parsed.skills) ||
          Array.isArray(parsed.routines) ||
          Array.isArray(parsed.memories) ||
          parsed.format === BUNDLE_FORMAT ||
          parsed.persona ||
          parsed.profile);
      const skillBodies =
        hasRecipe &&
        Array.isArray(parsed.skills) &&
        parsed.skills.some(
          (s) => s && typeof s === "object" && (s.body || s.content || s.prompt || s.text),
        );
      attempts.push({
        url,
        status: res.status,
        ok: res.ok,
        looksJson,
        hasRecipe: Boolean(hasRecipe),
        skillBodies: Boolean(skillBodies),
      });
      // Only treat as full if we got non-empty skill/routine bodies (public marketplace
      // pages sometimes embed empty skills:[] arrays).
      if (res.ok && skillBodies) {
        return { ok: true, url, data: parsed, attempts };
      }
      if (
        res.ok &&
        hasRecipe &&
        parsed.format === BUNDLE_FORMAT &&
        Array.isArray(parsed.skills) &&
        parsed.skills.length > 0
      ) {
        return { ok: true, url, data: parsed, attempts };
      }
    } catch (err) {
      attempts.push({ url, error: String(err?.message || err) });
    }
  }
  return { ok: false, attempts };
}

/**
 * Scan well-known local cache dirs for a template payload. Read-only; no secrets printed.
 */
export function probeLocalTemplateCaches(templateId) {
  const homes = [process.env.HOME || os.homedir(), "/home/box"].filter(Boolean);
  const hits = [];
  const roots = [];
  for (const home of homes) {
    roots.push(
      path.join(home, ".grokbot"),
      path.join(home, ".grok"),
      path.join(home, ".cursor"),
      path.join(home, "agent-data"),
      path.join(home, "sand-data"),
    );
  }
  const seen = new Set();
  for (const root of roots) {
    if (!root || seen.has(root) || !fs.existsSync(root)) continue;
    seen.add(root);
    try {
      walkLimited(root, 4, (filePath) => {
        const base = path.basename(filePath).toLowerCase();
        if (
          !(
            base.includes("template") ||
            base.includes("bot-share") ||
            base.endsWith(".grokbot.json") ||
            base.includes("share-json")
          )
        ) {
          return;
        }
        if (templateId) {
          try {
            const text = fs.readFileSync(filePath, "utf8");
            if (!text.includes(templateId)) return;
            // Avoid treating secrets stores as hits
            if (/secret|token|credential/i.test(filePath)) return;
            hits.push(filePath);
          } catch {
            /* ignore unreadable */
          }
        }
      });
    } catch {
      /* ignore */
    }
  }
  return hits;
}

function walkLimited(dir, depthLeft, onFile) {
  if (depthLeft < 0) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "browser-data") continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkLimited(full, depthLeft - 1, onFile);
    else if (ent.isFile()) onFile(full);
  }
}

function gettingStartedSkill({ url, sharerName, botName, mode }) {
  const sharer = sharerName || "(unknown sharer)";
  return {
    name: "getting-started",
    description:
      "Explain that this Pi import came from a public Grok Bot share link (metadata only) and how to obtain the full recipe.",
    body: `# Getting started (metadata-only import)

This agent folder was imported from a **public Grok Bot share / marketplace link**, not from a full \`grokbot-bundle/v1\` export.

- **Bot name:** ${botName}
- **Shared by:** ${sharer}
- **Original URL:** ${url}
- **Import mode:** \`${mode}\`

## Hard limitation

SpaceXAI does **not** publish skill bodies, routine prompts, memories, or plugin configs on the public share page (\`https://x.ai/bot/{id}\`). The page only dehydrates React Query key \`["bot-template", id]\` with metadata: id, ownerType, sharerName, botName, description, addHref, color, shape.

So this import has **persona name + description only**, plus this skill. Empty \`memories\`, \`skills\` (aside from this note), \`routines\`, and \`plugins\` arrays are expected — not a bug in the importer.

## How to get the full recipe

**Preferred (Pi extension):** sign into a free Cursor account, then re-import:

\`\`\`text
/grokbot-cursor-login
/import-grokbot ${url} --force
\`\`\`

That calls Cursor \`GetGrokBotTemplateImportDetails\` and downloads the recipe blob (skills, routines, memory, plugins).

**Alternative:** Add the template in the Grok Bot app, then on that box:

\`\`\`bash
node export-grokbot.mjs <new-agent-id> --out ./full-bot.grokbot.json
\`\`\`

Until then, treat this folder as a **stub persona**, not a complete clone.
`,
    source: "pi-grokbot-import:metadata-only",
  };
}

export function buildMetadataBundle(meta, { url, mode = "metadata-only", marketplaceSlug } = {}) {
  const id = meta.id;
  const botName = meta.botName || meta.name || "Imported Bot";
  const description = meta.description || "";
  const sharerName = meta.sharerName || meta.creatorName || "";
  const resolvedUrl = url || `https://x.ai/bot/${id}`;
  const skill = gettingStartedSkill({
    url: resolvedUrl,
    sharerName,
    botName,
    mode,
  });

  return {
    format: BUNDLE_FORMAT,
    exportedAt: new Date().toISOString(),
    source: {
      platform: "grok-bot",
      agentId: id,
      kind: "xai-share",
      id,
      url: resolvedUrl,
      sharerName,
      mode,
      ownerType: meta.ownerType || undefined,
      marketplaceSlug: marketplaceSlug || undefined,
      color: meta.color || undefined,
      shape: meta.shape || undefined,
      addHref: meta.addHref || undefined,
    },
    persona: {
      name: botName,
      title: "",
      description,
      avatarShape: meta.shape || "",
      avatarColor: meta.color || "",
    },
    memories: [],
    skills: [skill],
    routines: [],
    plugins: [],
    omitted: [
      "Public share/marketplace pages do not include skill bodies, routine prompts, memories, or plugin configs",
      "Full recipe: /grokbot-cursor-login then re-run /import-grokbot (or Add in Grok Bot + export-grokbot.mjs)",
      "connector-secrets / tokens / credentials (never fetched)",
    ],
  };
}

function mapMemoryField(memory) {
  if (memory == null) return [];
  if (typeof memory === "string") {
    const t = memory.trim();
    return t ? [{ kind: "profile", text: t, source: "cursor-import" }] : [];
  }
  if (Array.isArray(memory)) {
    return memory.map((m) =>
      typeof m === "string"
        ? { kind: "log", text: m, source: "cursor-import" }
        : {
            kind: m.kind || "log",
            text: m.text || m.content || "",
            source: m.source || "cursor-import",
          },
    );
  }
  if (typeof memory === "object") {
    const text =
      memory.text ||
      memory.content ||
      memory.profile ||
      (typeof memory.md === "string" ? memory.md : "") ||
      "";
    if (String(text).trim()) {
      return [{ kind: memory.kind || "profile", text: String(text), source: "cursor-import" }];
    }
  }
  return [];
}

/**
 * Map CreateBotShareJson-style recipe (or grokbot-bundle/v1) into grokbot-bundle/v1.
 * Recipe fields: profile, memory, skills[{name,description?,content}],
 * routines[{slug,name?,description,content}], plugins[{pluginId,...}], gettingStarted?
 */
export function mapFullRecipeToBundle(data, { id, url, sharerName, importSource } = {}) {
  if (data?.format === BUNDLE_FORMAT && data.persona) {
    return {
      ...data,
      source: {
        ...(data.source || {}),
        platform: "grok-bot",
        agentId: data.source?.agentId || id,
        kind: "xai-share",
        id,
        url,
        sharerName: sharerName || data.source?.sharerName || "",
        mode: "full",
        importSource: importSource || data.source?.importSource,
      },
    };
  }

  const persona = data.persona || data.profile || {};
  const name =
    persona.name || data.botName || data.name || data.template?.name || "Imported Bot";
  const description =
    persona.description || data.description || data.template?.description || "";
  const memories = Array.isArray(data.memories)
    ? data.memories.map((m) =>
        typeof m === "string"
          ? { kind: "log", text: m, source: "cursor-import" }
          : {
              kind: m.kind || "log",
              text: m.text || m.content || "",
              source: m.source || "cursor-import",
            },
      )
    : mapMemoryField(data.memory);

  const skills = Array.isArray(data.skills) ? [...data.skills] : [];
  if (data.gettingStarted && typeof data.gettingStarted === "object") {
    const gs = data.gettingStarted;
    skills.unshift({
      name: gs.name || "getting-started",
      description: gs.description || "Getting started",
      content: gs.content || gs.body || gs.text || "",
    });
  } else if (typeof data.gettingStarted === "string" && data.gettingStarted.trim()) {
    skills.unshift({
      name: "getting-started",
      description: "Getting started",
      content: data.gettingStarted,
    });
  }

  const routines = Array.isArray(data.routines) ? data.routines : [];
  const plugins = Array.isArray(data.plugins) ? data.plugins : [];

  return {
    format: BUNDLE_FORMAT,
    exportedAt: new Date().toISOString(),
    source: {
      platform: "grok-bot",
      agentId: id,
      kind: "xai-share",
      id,
      url,
      sharerName: sharerName || "",
      mode: "full",
      importSource: importSource || "cursor-import-details",
    },
    persona: {
      name,
      title: persona.title || "",
      description,
      avatarShape: persona.avatarShape || persona.shape || data.shape || data.avatarShape || "",
      avatarColor: persona.avatarColor || persona.color || data.color || data.avatarColor || "",
    },
    memories,
    skills: skills.map((s) => ({
      name: s.name || s.slug || "skill",
      description: s.description || s.name || "",
      body: s.body || s.content || s.text || "",
      source: s.source || "cursor-import-details",
    })),
    routines: routines.map((r) => ({
      name: r.name || r.slug || "routine",
      schedule: r.schedule,
      triggerSummary: r.triggerSummary || r.description || undefined,
      prompt: r.prompt || r.body || r.content || "",
    })),
    plugins: plugins.map((p) =>
      typeof p === "string"
        ? { id: p }
        : {
            id: p.pluginId || p.id || p.name,
            note: p.note || p.description || undefined,
          },
    ),
    omitted: Array.isArray(data.omitted)
      ? data.omitted
      : [
          "Shared box computer / browser desktop",
          "Grok channels / send-on-behalf",
          "Connector secrets and credentials",
        ],
  };
}

/**
 * Prefer Cursor GetPublicGrokBotTemplate (no auth) over HTML scrape.
 */
export async function fetchPublicApiMeta(shareId, { fetchImpl } = {}) {
  const res = await getPublicGrokBotTemplate(shareId, { fetchImpl });
  if (!res.ok || !res.json?.template) {
    return { ok: false, status: res.status, error: res.json?.message || res.text?.slice(0, 200) };
  }
  const t = res.json.template;
  return {
    ok: true,
    meta: {
      id: t.shareId || shareId,
      ownerType: t.ownerType || "",
      sharerName: res.json.ownerDisplayName || "",
      botName: t.name || "",
      description: t.description || "",
      addHref: `grokbot://app/v1/bot-template?id=${t.shareId || shareId}`,
      color: t.avatarColor || "",
      shape: t.avatarShape || "",
      blobObjectKey: t.blobObjectKey,
      activeVersion: t.activeVersion,
      published: t.published,
    },
    raw: res.json,
  };
}

/**
 * Full recipe via Cursor session: ImportDetails → blobGetUrl → recipe JSON.
 */
export async function tryCursorImportDetails(shareId, { accessToken, fetchImpl } = {}) {
  const attempts = [];
  if (!accessToken) {
    return { ok: false, reason: "no-session", attempts };
  }
  const details = await getGrokBotTemplateImportDetails(shareId, { accessToken, fetchImpl });
  attempts.push({
    step: "GetGrokBotTemplateImportDetails",
    status: details.status,
    ok: details.ok,
    notLoggedIn: details.notLoggedIn,
  });
  if (details.notLoggedIn) {
    return { ok: false, reason: "not-logged-in", attempts, status: details.status };
  }
  if (!details.ok) {
    return {
      ok: false,
      reason: "import-details-failed",
      attempts,
      status: details.status,
      message: details.json?.message || details.text?.slice(0, 200),
    };
  }
  const blobGetUrl =
    details.json?.blobGetUrl ||
    details.json?.blob_get_url ||
    details.json?.template?.blobGetUrl;
  if (!blobGetUrl || typeof blobGetUrl !== "string") {
    return {
      ok: false,
      reason: "missing-blobGetUrl",
      attempts,
      detailsKeys: details.json ? Object.keys(details.json) : [],
    };
  }
  try {
    const recipe = await downloadBlobGetUrl(blobGetUrl, { fetchImpl });
    attempts.push({ step: "blobGetUrl", ok: true });
    return {
      ok: true,
      recipe,
      blobGetUrl: "(redacted)",
      details: details.json,
      attempts,
    };
  } catch (err) {
    attempts.push({ step: "blobGetUrl", ok: false, error: String(err?.message || err) });
    return { ok: false, reason: "blob-download-failed", attempts, error: String(err?.message || err) };
  }
}

/**
 * Resolve any supported input into a grokbot-bundle/v1.
 * @returns {Promise<{ bundle: object, mode: "metadata-only"|"full", meta: object, fullFetch: object, localCacheHits: string[] }>}
 */
export async function fetchTemplateAsBundle(input, options = {}) {
  const {
    html: providedHtml,
    skipFullFetch = false,
    fetchImpl,
    accessToken: optionAccessToken = null,
    skipCursorImport = false,
  } = options;
  const doFetch = asFetchText(fetchImpl);
  const doFetchResponse = asFetchResponse(fetchImpl);

  let target = normalizeTemplateInput(input);
  let marketplaceSlug;
  let resolvedFrom;

  if (target.kind === "grokbottemplates") {
    const api = await doFetch(target.apiUrl, {
      headers: { Accept: "application/json" },
    });
    let shareUrl = null;
    if (api.ok) {
      try {
        const j = JSON.parse(api.text);
        shareUrl = j.share_url || j.shareUrl || null;
        if (!shareUrl && j.add_href) {
          const sid = shareIdFromAddHref(j.add_href);
          if (sid) shareUrl = `https://x.ai/bot/${sid}`;
        }
      } catch {
        /* fall through to HTML */
      }
    }
    if (!shareUrl) {
      const page = await doFetch(target.url);
      if (!page.ok) {
        throw new Error(
          `Failed to resolve grokbottemplates.app slug ${target.slug}: API HTTP ${api.status}, page HTTP ${page.status}`,
        );
      }
      const m = page.text.match(/https:\/\/x\.ai\/bot\/[A-Za-z0-9_-]+/);
      if (!m) {
        throw new Error(
          `grokbottemplates.app page for ${target.slug} had no x.ai/bot share_url`,
        );
      }
      shareUrl = m[0];
    }
    resolvedFrom = { kind: "grokbottemplates", slug: target.slug, shareUrl };
    target = normalizeTemplateInput(shareUrl.split("?")[0]);
  }

  if (target.kind === "marketplace") {
    marketplaceSlug = target.slug;
    const page = await doFetch(target.url);
    if (!page.ok) {
      throw new Error(`Failed to fetch marketplace page: HTTP ${page.status} ${target.url}`);
    }
    const listing = parseMarketplaceHtml(page.text);
    if (!listing?.shareId) {
      throw new Error(
        `Marketplace page ${target.url} did not include a resolvable addHref / share id`,
      );
    }
    resolvedFrom = { kind: "marketplace", slug: listing.slug, addHref: listing.addHref };
    target = {
      kind: "share-id",
      id: listing.shareId,
      url: `https://x.ai/bot/${listing.shareId}`,
      original: input,
      marketplaceMeta: listing,
    };
  }

  if (target.kind !== "share-id") {
    throw new Error(`Internal error: unresolved target kind ${target.kind}`);
  }

  const shareUrl = target.url;
  let meta;
  let metaSource = "html";

  if (providedHtml) {
    meta = parseBotTemplateHtml(providedHtml);
    if (!meta) throw new Error("Provided HTML did not contain dehydrated bot-template data");
    metaSource = "provided-html";
  } else {
    // Prefer ConnectRPC public metadata (no auth)
    const apiMeta = await fetchPublicApiMeta(target.id, { fetchImpl: doFetchResponse });
    if (apiMeta.ok) {
      meta = apiMeta.meta;
      metaSource = "GetPublicGrokBotTemplate";
    } else {
      const page = await doFetch(shareUrl);
      if (!page.ok) {
        throw new Error(
          `Failed to fetch share metadata: public API HTTP ${apiMeta.status}, page HTTP ${page.status} ${shareUrl}`,
        );
      }
      meta = parseBotTemplateHtml(page.text);
      if (!meta) {
        if (target.marketplaceMeta) {
          meta = {
            id: target.id,
            ownerType: "USER",
            sharerName: target.marketplaceMeta.creatorName || "",
            botName: target.marketplaceMeta.name,
            description: target.marketplaceMeta.description || "",
            addHref: target.marketplaceMeta.addHref,
            color: "",
            shape: "",
          };
          metaSource = "marketplace-listing";
        } else {
          throw new Error(
            `Share page ${shareUrl} did not contain dehydrated ["bot-template", id] metadata` +
              ` (public API HTTP ${apiMeta.status})`,
          );
        }
      } else {
        metaSource = "html";
      }
    }
  }

  if (meta.id && meta.id !== target.id) {
    target = { ...target, id: meta.id, url: `https://x.ai/bot/${meta.id}` };
  }

  const localCacheHits = probeLocalTemplateCaches(target.id);

  let fullFetch = {
    ok: false,
    attempts: [],
    skipped: Boolean(skipFullFetch),
    cursorImport: null,
  };

  // 1) Cursor session → ImportDetails + blob (authoritative full path)
  if (!skipFullFetch && !skipCursorImport) {
    let accessToken = optionAccessToken || null;
    if (!accessToken) {
      try {
        accessToken = await getAccessToken();
      } catch {
        accessToken = null;
      }
    }
    const cursor = await tryCursorImportDetails(target.id, { accessToken, fetchImpl: doFetchResponse });
    fullFetch.cursorImport = {
      attempted: Boolean(accessToken),
      reason: cursor.reason || (cursor.ok ? "ok" : "failed"),
      attempts: cursor.attempts,
    };
    if (cursor.ok && cursor.recipe) {
      const bundle = mapFullRecipeToBundle(cursor.recipe, {
        id: target.id,
        url: shareUrl,
        sharerName: meta.sharerName,
        importSource: "GetGrokBotTemplateImportDetails",
      });
      if (marketplaceSlug) bundle.source.marketplaceSlug = marketplaceSlug;
      if (resolvedFrom) bundle.source.resolvedFrom = resolvedFrom;
      bundle.source.metaSource = metaSource;
      fullFetch.ok = true;
      fullFetch.data = cursor.recipe;
      fullFetch.url = "cursor:ImportDetails+blob";
      return {
        bundle,
        mode: "full",
        meta,
        fullFetch,
        localCacheHits,
      };
    }
  }

  // 2) Legacy best-effort public JSON probes (usually empty)
  if (!skipFullFetch) {
    const legacy = await tryAuthenticatedFullFetch(target.id, { fetchImpl: doFetch });
    fullFetch.attempts = legacy.attempts || [];
    if (legacy.ok && legacy.data) {
      fullFetch.ok = true;
      fullFetch.data = legacy.data;
      fullFetch.url = legacy.url;
      const bundle = mapFullRecipeToBundle(legacy.data, {
        id: target.id,
        url: shareUrl,
        sharerName: meta.sharerName,
        importSource: "legacy-probe",
      });
      if (marketplaceSlug) bundle.source.marketplaceSlug = marketplaceSlug;
      if (resolvedFrom) bundle.source.resolvedFrom = resolvedFrom;
      bundle.source.metaSource = metaSource;
      return {
        bundle,
        mode: "full",
        meta,
        fullFetch,
        localCacheHits,
      };
    }
  }

  // Local cache hit with parseable full bundle?
  for (const hit of localCacheHits) {
    try {
      const data = JSON.parse(fs.readFileSync(hit, "utf8"));
      if (
        data?.format === BUNDLE_FORMAT &&
        Array.isArray(data.skills) &&
        data.skills.some((s) => s?.body && s.name !== "getting-started")
      ) {
        const bundle = mapFullRecipeToBundle(data, {
          id: target.id,
          url: shareUrl,
          sharerName: meta.sharerName,
        });
        bundle.source.localCachePath = hit;
        if (marketplaceSlug) bundle.source.marketplaceSlug = marketplaceSlug;
        return {
          bundle,
          mode: "full",
          meta,
          fullFetch,
          localCacheHits,
        };
      }
    } catch {
      /* ignore */
    }
  }

  const bundle = buildMetadataBundle(meta, {
    url: shareUrl + (String(input).includes("?ref=") ? "" : ""),
    mode: "metadata-only",
    marketplaceSlug,
  });
  bundle.source.url = shareUrl;
  bundle.source.originalInput = String(input).trim();
  bundle.source.metaSource = metaSource;
  if (resolvedFrom) bundle.source.resolvedFrom = resolvedFrom;
  if (fullFetch.cursorImport) {
    bundle.source.cursorImport = fullFetch.cursorImport;
    if (!fullFetch.cursorImport.attempted) {
      bundle.omitted.push(
        "No Cursor session — run /grokbot-cursor-login for a full recipe import via GetGrokBotTemplateImportDetails",
      );
    } else if (fullFetch.cursorImport.reason === "not-logged-in") {
      bundle.omitted.push(
        "Cursor session returned ERROR_NOT_LOGGED_IN — run /grokbot-cursor-login again",
      );
    } else if (fullFetch.cursorImport.reason && fullFetch.cursorImport.reason !== "ok") {
      bundle.omitted.push(
        `Cursor ImportDetails did not return a full recipe (${fullFetch.cursorImport.reason})`,
      );
    }
  }
  if (localCacheHits.length === 0) {
    bundle.omitted.push(
      "No local Grok Bot / Cursor cache under $HOME contained a full template payload for this id",
    );
  }

  return {
    bundle,
    mode: "metadata-only",
    meta,
    fullFetch,
    localCacheHits,
  };
}

export async function loadBundleFromSource(source, { baseDir, skipFullFetch } = {}) {
  const trimmed = String(source || "").trim().replace(/^["']|["']$/g, "");
  if (!trimmed) throw new Error("Missing bundle path or Grok Bot share URL");

  if (isGrokBotShareOrMarketplaceUrl(trimmed) || DEEP_LINK_RE.test(trimmed)) {
    const result = await fetchTemplateAsBundle(trimmed, { skipFullFetch });
    return result.bundle;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const res = await fetch(trimmed, { headers: DEFAULT_FETCH_HEADERS, redirect: "follow" });
    if (!res.ok) throw new Error(`Failed to fetch: HTTP ${res.status}`);
    const ct = res.headers.get("content-type") || "";
    const text = await res.text();
    if (/json/i.test(ct) || text.trim().startsWith("{")) {
      const data = JSON.parse(text);
      if (data?.format === BUNDLE_FORMAT) return data;
    }
    // Maybe an HTML share page we didn't classify (e.g. unexpected host path)
    const meta = parseBotTemplateHtml(text);
    if (meta) {
      return buildMetadataBundle(meta, { url: trimmed, mode: "metadata-only" });
    }
    throw new Error("URL did not return a grokbot-bundle/v1 document or recognizable share page");
  }

  const resolved = path.resolve(baseDir || process.cwd(), trimmed);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
  const data = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (data?.format !== BUNDLE_FORMAT) {
    throw new Error(`Not a valid grokbot-bundle/v1 file: ${resolved}`);
  }
  return data;
}
