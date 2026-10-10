/**
 * Template catalog (catalog.json in the catalog repo): fetch + cache, search, resolve,
 * and per-template download (only that folder).
 *
 * The default catalog is public, so no GitHub login is needed: without a token, catalog.json and
 * template files come from raw.githubusercontent.com (no API rate limit) and the folder listing
 * costs one unauthenticated API call (or, if that is rate limited, the catalog site's manifest).
 * With a token (GH_TOKEN, `gh auth login`, or `grokbot login github`) the REST API is used, which
 * also works for a private fork.
 */
import fs from "node:fs";
import path from "node:path";
import { stateDir, readJson, writeJson, catalogRepo } from "./paths.mjs";
import { getGitHubToken } from "./github-auth.mjs";

const UA = "pi-grokbot-import";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function gh(url, { token, accept = "application/vnd.github+json", etag } = {}) {
  const headers = { "User-Agent": UA, Accept: accept, "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (etag) headers["If-None-Match"] = etag;
  const res = await fetch(url, { headers });
  if (res.status === 304) return { notModified: true };
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`GitHub API ${res.status} for ${url.replace(/\?.*$/, "")}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return { res };
}

const DEFAULT_SITE = { "Shixuuu/grokbot-pi-templates": "https://shixuuu.github.io/grokbot-pi-templates/" };

function authHint(repo, status, hadToken) {
  if (status === 404 || status === 401)
    return hadToken
      ? `Cannot read ${repo} (HTTP ${status}): check the repo name and that your GitHub token can read it.`
      : `Cannot read ${repo} (HTTP ${status}) without a login. If this catalog repo is private, log in with \`grokbot login github\` (reuses \`gh auth login\`) or set GH_TOKEN to a token that can read it.`;
  if (status === 403 || status === 429)
    return `GitHub refused the request for ${repo} (HTTP ${status}, likely the unauthenticated rate limit). Retry later, or log in with \`grokbot login github\` / set GH_TOKEN for a higher limit.`;
  return null;
}

async function raw(repo, ref, filePath, { etag } = {}) {
  const url = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref).replace(/%2F/g, "/")}/${filePath.split("/").map(encodeURIComponent).join("/")}`;
  const headers = { "User-Agent": UA };
  if (etag) headers["If-None-Match"] = etag;
  const res = await fetch(url, { headers });
  if (res.status === 304) return { notModified: true };
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${url}`);
    err.status = res.status;
    throw err;
  }
  return { res };
}

async function tokenOrNull() {
  const t = await getGitHubToken();
  return t?.token || null;
}

function cacheFile(repo, ref) {
  return path.join(stateDir(), "catalog-cache", `${repo.replace("/", "__")}@${ref.replace(/[^\w.-]/g, "_")}.json`);
}

export function sectionOf(t) {
  return t.official ? "official" : t.builtin || t.category === "builtin" ? "builtin" : "community";
}

/**
 * @returns {Promise<{repo, ref, fetchedAt, fromCache, templates: any[]}>}
 */
export async function loadCatalog({ refresh = false, repo: repoOverride, offline = false } = {}) {
  const { repo, ref } = catalogRepo(repoOverride);
  const file = cacheFile(repo, ref);
  const cached = readJson(file, null);
  const fresh = cached && Date.now() - Date.parse(cached.fetchedAt) < CACHE_TTL_MS;
  if (cached && (offline || (fresh && !refresh))) return { repo, ref, fetchedAt: cached.fetchedAt, fromCache: true, templates: cached.catalog.templates };
  const token = await tokenOrNull();
  try {
    const etag = refresh ? undefined : cached?.etag;
    const r = token
      ? await gh(`https://api.github.com/repos/${repo}/contents/catalog.json?ref=${encodeURIComponent(ref)}`, { token, accept: "application/vnd.github.raw", etag })
      : await raw(repo, ref, "catalog.json", { etag });
    if (r.notModified) {
      cached.fetchedAt = new Date().toISOString();
      writeJson(file, cached);
      return { repo, ref, fetchedAt: cached.fetchedAt, fromCache: true, templates: cached.catalog.templates };
    }
    const catalog = JSON.parse(await r.res.text());
    if (!Array.isArray(catalog?.templates)) throw new Error(`${repo}: catalog.json has no templates[]`);
    const entry = { repo, ref, fetchedAt: new Date().toISOString(), etag: r.res.headers.get("etag"), catalog };
    writeJson(file, entry);
    return { repo, ref, fetchedAt: entry.fetchedAt, fromCache: false, templates: catalog.templates };
  } catch (e) {
    if (cached) return { repo, ref, fetchedAt: cached.fetchedAt, fromCache: true, stale: true, error: e.message, templates: cached.catalog.templates };
    const hint = authHint(repo, e.status, !!token);
    throw hint ? Object.assign(new Error(hint), { status: e.status }) : e;
  }
}

const norm = (s) => String(s || "").toLowerCase();

function haystack(t) {
  return {
    name: norm(t.name),
    slug: norm(t.slug),
    description: norm(t.description),
    category: norm(t.category),
    section: sectionOf(t),
    tags: (t.tags || []).map(norm),
    creator: norm(`${t.creator || ""} ${t.creatorHandle || ""} @${t.creatorHandle || ""}`),
  };
}

/**
 * Search the catalog. query: free text; filters: section, category, tag, creator, includeDead.
 * Scores name/slug > tags/category/section > creator > description; every query word must match somewhere.
 */
export function searchCatalog(templates, query = "", { section, category, tag, creator, includeDead = false, limit = 20 } = {}) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  const out = [];
  for (const t of templates) {
    if (!includeDead && (t.status !== "live" || !t.path)) continue;
    const h = haystack(t);
    if (section && h.section !== norm(section) && !(norm(section) === "builtin" && t.builtin)) continue;
    if (category && h.category !== norm(category)) continue;
    if (tag && !h.tags.includes(norm(tag))) continue;
    if (creator && !h.creator.includes(norm(creator).replace(/^@/, ""))) continue;
    let score = 0;
    let ok = true;
    for (const w of words) {
      let s = 0;
      if (h.name === w || h.slug === w) s += 10;
      if (h.name.includes(w) || h.slug.includes(w)) s += 5;
      if (h.tags.some((x) => x.includes(w))) s += 4;
      if (h.category.includes(w) || h.section === w) s += 3;
      if (h.creator.includes(w)) s += 3;
      if (h.description.includes(w)) s += 1;
      if (!s) {
        ok = false;
        break;
      }
      score += s;
    }
    if (!ok) continue;
    if (t.official) score += 0.5;
    out.push({ score, t });
  }
  out.sort((a, b) => b.score - a.score || norm(a.t.name).localeCompare(norm(b.t.name)));
  return { total: out.length, results: out.slice(0, limit).map((x) => x.t) };
}

export function oneLiner(t, max = 90) {
  const d = String(t.description || "").replace(/\s+/g, " ").trim();
  return d.length > max ? d.slice(0, max - 1) + "…" : d;
}

export function formatRow(t) {
  const sec = sectionOf(t);
  const sub = (t.tags || []).filter((x) => x !== "trading");
  let where = t.category && t.category !== sec ? `${sec}/${t.category}` : sec;
  if (sub.length) where += `:${sub.join(",")}`;
  if (t.official && t.builtin) where += "+builtin";
  return `${t.slug}  [${where}]  skills:${t.skills ?? 0} routines:${t.routines ?? 0}  ${oneLiner(t)}${t.shareId ? `  (id ${t.shareId})` : ""}`;
}

/** Resolve slug | shareId | x.ai URL | section/slug | catalog path. Throws on ambiguity with candidates. */
export function resolveTemplate(templates, idOrSlug) {
  const q = String(idOrSlug || "").trim();
  if (!q) throw new Error("Missing template slug or shareId");
  const m = q.match(/x\.ai\/bot\/(?:marketplace\/)?([A-Za-z0-9_-]{10,})/);
  const key = m ? m[1] : q.replace(/^templates\//, "");
  let hits = templates.filter((t) => t.shareId && t.shareId === key);
  if (!hits.length) hits = templates.filter((t) => t.path && (t.path === `templates/${key}` || t.path.endsWith(`/${key}`) && key.includes("/")));
  if (!hits.length) hits = templates.filter((t) => t.slug && norm(t.slug) === norm(key));
  if (!hits.length) {
    const err = new Error(`No catalog template matches "${q}"`);
    err.code = "NOT_FOUND";
    throw err;
  }
  const live = hits.filter((t) => t.status === "live" && t.path);
  if (live.length > 1) {
    const err = new Error(
      `"${q}" is ambiguous; use a shareId or section path:\n` + live.map((t) => `  ${t.shareId || t.path}  ${t.path.replace(/^templates\//, "")}  ${oneLiner(t, 60)}`).join("\n"),
    );
    err.code = "AMBIGUOUS";
    err.candidates = live;
    throw err;
  }
  if (!live.length) {
    const err = new Error(`"${q}" is in the catalog but has no installable package (status: ${hits[0].status}${hits[0].note ? `, ${hits[0].note}` : ""})`);
    err.code = "DEAD";
    err.template = hits[0];
    throw err;
  }
  return live[0];
}

/** File list for one template folder: git trees API, or the catalog site's manifest when the API is unavailable. */
async function listTemplateFiles(repo, ref, entry, token) {
  const treeUrl = `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(`${ref}:${entry.path}`)}?recursive=1`;
  try {
    const tree = await (await gh(treeUrl, { token })).res.json();
    if (tree.truncated) throw new Error(`Template tree for ${entry.path} is truncated by GitHub; refusing partial download`);
    return (tree.tree || []).filter((x) => x.type === "blob").map((x) => ({ path: x.path, sha: x.sha }));
  } catch (e) {
    const site = process.env.GROKBOT_CATALOG_SITE || DEFAULT_SITE[repo];
    if (!token && site && (e.status === 403 || e.status === 429)) {
      const url = `${site.replace(/\/?$/, "/")}m/${entry.path.replace(/^templates\//, "").replace(/\//g, "__")}.json`;
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.ok) {
        const m = await res.json();
        if (Array.isArray(m.files)) return m.files.map((f) => ({ path: typeof f === "string" ? f : f.p }));
      }
    }
    const hint = authHint(repo, e.status, !!token);
    throw hint ? new Error(hint) : e;
  }
}

/**
 * Download one template folder (and nothing else). No clone, no full tarball.
 * With a token: git trees API + one blob request per file. Without: one tree call, files from raw.githubusercontent.com.
 */
export async function downloadTemplate(entry, destDir, { repo: repoOverride, onFile } = {}) {
  const { repo, ref } = catalogRepo(repoOverride);
  const token = await tokenOrNull();
  const files = await listTemplateFiles(repo, ref, entry, token);
  fs.mkdirSync(destDir, { recursive: true });
  const queue = files.slice();
  const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length) {
      const f = queue.shift();
      const rel = path.normalize(f.path);
      if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Unsafe path in tree: ${f.path}`);
      const r =
        token && f.sha
          ? await gh(`https://api.github.com/repos/${repo}/git/blobs/${f.sha}`, { token, accept: "application/vnd.github.raw" })
          : await raw(repo, ref, `${entry.path}/${f.path}`);
      const buf = Buffer.from(await r.res.arrayBuffer());
      const out = path.join(destDir, rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, buf);
      onFile?.(rel);
    }
  });
  await Promise.all(workers);
  return { files: files.map((f) => f.path), repo, ref };
}
