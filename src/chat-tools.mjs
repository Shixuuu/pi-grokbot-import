/**
 * Shared logic for the Pi tools / slash commands (kept in .mjs so tests can drive it without Pi).
 * Chat installs are two-step: preview → user approval → apply.
 *  - With a UI (interactive Pi): ctx.ui.confirm() shows the plan; nothing is written unless the user accepts.
 *  - Without a UI (print/RPC mode): the preview returns a one-time confirmToken; applying needs
 *    confirmed:true + that token, AND (when the session is visible) a user message after the preview.
 */
import crypto from "node:crypto";
import path from "node:path";
import { stateDir, readJson, writeJson, catalogRepo } from "./paths.mjs";
import { loadCatalog, searchCatalog, formatRow, resolveTemplate, sectionOf } from "./catalog.mjs";
import { planInstall, formatPlan, applyInstall, discardPlan, listInstalled, uninstall, findInstalled, formatUninstallPlan } from "./installer.mjs";
import { githubStatus } from "./github-auth.mjs";
import { getSessionStatus } from "./cursor-auth.mjs";

const TTL = 60 * 60 * 1000;
const pendingPath = () => path.join(stateDir(), "pending-confirmations.json");

function issueToken(kind, params) {
  const all = readJson(pendingPath(), {});
  const now = Date.now();
  for (const [k, v] of Object.entries(all)) if (now - v.at > TTL) delete all[k];
  const token = crypto.randomBytes(5).toString("hex");
  all[token] = { kind, params, at: now };
  writeJson(pendingPath(), all);
  return token;
}

function takeToken(token, kind) {
  const all = readJson(pendingPath(), {});
  const v = all[token];
  if (!v || v.kind !== kind || Date.now() - v.at > TTL) return null;
  delete all[token];
  writeJson(pendingPath(), all);
  return v.params;
}

/** True when a user message exists in the session after the message that carried the token. */
function userApprovedAfter(ctx, token) {
  const sm = ctx?.sessionManager;
  const entries = (sm?.getBranch?.() || sm?.getEntries?.() || []).filter((e) => e?.type === "message" || e?.message);
  if (!entries.length) return { known: false };
  // First occurrence = the preview tool result (later ones are the model's own confirm call).
  const idx = entries.findIndex((e) => e.message?.role !== "user" && e.message?.role !== "assistant" && JSON.stringify(e.message?.content ?? "").includes(token));
  if (idx < 0) return { known: true, ok: false, why: "preview not found in this session" };
  const ok = entries.slice(idx + 1).some((e) => e.message?.role === "user");
  return { known: true, ok, why: ok ? "" : "no user reply after the preview" };
}

const text = (t, details) => ({ content: [{ type: "text", text: t }], details: details || {} });

export async function toolSearch(p) {
  const cat = await loadCatalog({ refresh: !!p.refresh });
  const { total, results } = searchCatalog(cat.templates, p.query || "", { section: p.section, category: p.category, tag: p.tag, creator: p.creator, limit: Math.min(Number(p.limit || 10), 50) });
  const rows = results.map(formatRow);
  return text(
    total
      ? `${results.length} of ${total} matching templates in ${cat.repo}:\n${rows.join("\n")}\n\nInstall with grokbot_install (id = slug, or shareId when a slug is ambiguous).`
      : `No templates match "${p.query || ""}".`,
    { total, results: results.map((t) => ({ slug: t.slug, shareId: t.shareId, section: sectionOf(t), category: t.category, tags: t.tags, skills: t.skills, routines: t.routines })) },
  );
}

export async function toolInfo(p) {
  const cat = await loadCatalog({});
  const t = resolveTemplate(cat.templates, p.id);
  const inst = listInstalled().filter((b) => b.catalog?.path === t.path).map((b) => b.botId);
  return text(
    [
      `${t.name} [${t.slug}] — ${sectionOf(t)}/${t.category}${t.tags?.length ? ` (${t.tags.join(", ")})` : ""}`,
      `creator: ${t.creator || "?"}${t.creatorHandle ? ` @${t.creatorHandle}` : ""}; shareId ${t.shareId || "-"}; fidelity ${t.fidelity}`,
      `skills ${t.skills}, routines ${t.routines} (with schedule: ${t.scheduledRoutines ?? "?"}), memories ${t.memories}`,
      t.connectors?.length ? `connectors: ${t.connectors.join(", ")}` : "connectors: none",
      inst.length ? `installed as: ${inst.join(", ")}` : "not installed",
      "",
      t.description || "",
    ].join("\n"),
    t,
  );
}

function installOpts(p, ctx) {
  return {
    scope: p.scope === "project" ? "project" : "global",
    projectDir: ctx?.cwd || process.cwd(),
    schedule: p.schedule !== false,
    scheduler: p.scheduler || "auto",
    persona: p.persona === undefined ? "auto" : !!p.persona,
    mcp: p.mcp !== false,
    name: p.name,
  };
}

function summarizeInstall(rec) {
  return [
    `Installed ${rec.displayName} as ${rec.botId} (${rec.scope}).`,
    `Files: ${rec.botDir}`,
    `Schedules: ${rec.schedules.length ? rec.schedules.map((s) => `/${s.routine} (${s.kind === "systemd" ? s.onCalendar : s.cron})`).join(", ") : "none"}`,
    rec.unscheduled?.length ? `Routines needing a schedule: ${rec.unscheduled.map((u) => `/${u.routine}`).join(", ")} (grokbot schedule ${rec.botId} <routine> "<cron>")` : "",
    rec.mcp?.servers?.length ? `Disabled MCP stubs to configure: ${rec.mcp.servers.join(", ")} in ${rec.mcp.file}` : "",
    "Skills/prompts load on the next Pi session (/reload or restart).",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function toolInstall(p, ctx) {
  if (p.confirmed) {
    if (!p.confirmToken) return text("Refused: confirmed installs need the confirmToken from a preview the user approved. Call grokbot_install without confirmed first.");
    const chk = userApprovedAfter(ctx, p.confirmToken);
    if (chk.known && !chk.ok) return text(`Refused: ${chk.why}. Show the plan to the user and wait for their explicit yes before confirming.`);
    const saved = takeToken(p.confirmToken, "install");
    if (!saved) return text("Refused: unknown or expired confirmToken. Preview again with grokbot_install (without confirmed).");
    const plan = await planInstall(saved.id, saved.opts);
    const rec = await applyInstall(plan);
    return text(summarizeInstall(rec), rec);
  }
  const opts = installOpts(p, ctx);
  const plan = await planInstall(p.id, opts);
  const planText = formatPlan(plan);
  if (ctx?.hasUI && ctx.ui?.confirm) {
    const ok = await ctx.ui.confirm(`Install Grok Bot "${plan.displayName}"?`, planText);
    if (!ok) {
      discardPlan(plan);
      return text(`The user declined the install.\n\n${planText}`, { declined: true });
    }
    const rec = await applyInstall(plan);
    return text(`${summarizeInstall(rec)}\n\n(user approved the plan in the confirmation dialog)`, rec);
  }
  discardPlan(plan);
  const token = issueToken("install", { id: p.id, opts });
  return text(
    `${planText}\n\nNOT INSTALLED YET. Show this plan to the user (including the schedules) and ask whether to proceed. Only after they say yes, call grokbot_install again with confirmed: true and confirmToken: "${token}".`,
    { pending: true, confirmToken: token },
  );
}

export async function toolUninstall(p, ctx) {
  const rec = findInstalled(p.id, { projectDir: ctx?.cwd });
  if (!rec) return text(`Not installed: ${p.id}. Installed: ${listInstalled().map((b) => b.botId).join(", ") || "none"}`);
  const planText = formatUninstallPlan(rec);
  if (p.confirmed) {
    if (!p.confirmToken) return text("Refused: confirmed uninstalls need the confirmToken from a preview the user approved.");
    const chk = userApprovedAfter(ctx, p.confirmToken);
    if (chk.known && !chk.ok) return text(`Refused: ${chk.why}.`);
    const saved = takeToken(p.confirmToken, "uninstall");
    if (!saved || saved.botId !== rec.botId) return text("Refused: unknown or expired confirmToken. Preview again.");
  } else if (ctx?.hasUI && ctx.ui?.confirm) {
    if (!(await ctx.ui.confirm(`Uninstall ${rec.botId}?`, planText))) return text("The user declined the uninstall.", { declined: true });
  } else {
    const token = issueToken("uninstall", { botId: rec.botId });
    return text(`${planText}\n\nNOT REMOVED YET. Ask the user to confirm; then call grokbot_uninstall with confirmed: true and confirmToken: "${token}".`, { pending: true, confirmToken: token });
  }
  const r = await uninstall(rec.botId);
  return text(
    `Uninstalled ${r.botId}: removed ${r.schedules.removed.length} schedule(s), pi package ${r.pi || "n/a"}, persona ${r.persona ? "removed" : "n/a"}, MCP stubs removed ${r.mcp?.removed?.length || 0}.${r.errors.length ? `\nProblems: ${r.errors.join("; ")}` : ""}`,
    r,
  );
}

export async function toolList() {
  const bots = listInstalled();
  if (!bots.length) return text("No Grok Bot templates installed.");
  return text(
    bots
      .map(
        (b) =>
          `${b.botId} (${b.scope}${b.projectDir ? ` ${b.projectDir}` : ""}): ${b.displayName}; schedules: ${b.schedules.length ? b.schedules.map((s) => `/${s.routine} ${s.kind === "systemd" ? s.onCalendar : s.cron}`).join(", ") : "none"}${b.unscheduled?.length ? `; unscheduled: ${b.unscheduled.map((u) => `/${u.routine}`).join(", ")}` : ""}`,
      )
      .join("\n"),
    { bots },
  );
}

export async function statusText() {
  const g = await githubStatus();
  const c = getSessionStatus();
  const { repo, ref } = catalogRepo();
  return [
    `Catalog: ${repo}@${ref}`,
    `GitHub: ${g.loggedIn ? `logged in as ${g.login} (via ${g.source})` : "not logged in (optional: the default catalog is public; for a private catalog run `gh auth login --web` or `grokbot login github`, or set GH_TOKEN)"}`,
    `Cursor: ${c.loggedIn ? `${c.expired ? "expired" : "logged in"}, expires ${c.expiresAt}` : "not logged in (optional; /grokbot-cursor-login)"}`,
    `Installed: ${listInstalled().map((b) => b.botId).join(", ") || "none"}`,
  ].join("\n");
}
