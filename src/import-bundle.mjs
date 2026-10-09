import fs from "node:fs";
import path from "node:path";
import { isGrokBotBundle, toBotSlug, toSkillSlug } from "./schema.mjs";

export const TRANSFER_MATRIX = [
  {
    grok: "Persona (profile.json name + description)",
    status: "imported",
    piEquivalent:
      "AGENTS.md + .pi/APPEND_SYSTEM.md (Pi loads AGENTS.md from cwd; APPEND_SYSTEM.md appends to the system prompt)",
  },
  {
    grok: "Memories (profile.md / portable log lines)",
    status: "imported",
    piEquivalent: "NOTES.md (read on demand)",
  },
  {
    grok: "Skills (SKILL.md workflows)",
    status: "imported",
    piEquivalent: ".pi/skills/<name>/SKILL.md — invoke with /skill:name",
  },
  {
    grok: "Routines (cron / event listeners)",
    status: "partial",
    piEquivalent:
      ".pi/prompts/ templates + cron/ and systemd/ sketches. Pi has no built-in scheduler. Event listeners (Slack/GitHub/email/webhook) do not transfer.",
  },
  {
    grok: "Marketplace plugins / MCP connectors",
    status: "partial",
    piEquivalent:
      "Names only in IMPORT_REPORT.md. Pi supports MCP via ~/.pi/agent/mcp.json, .pi/mcp.json, `pi mcp add`, and pi.registerMcpServer().",
  },
  {
    grok: "Shared box computer / browser desktop",
    status: "not-transferred",
    piEquivalent: "None — Pi uses the machine where you run it",
  },
  {
    grok: "Built-in X / Grok data tools",
    status: "not-transferred",
    piEquivalent: "None built-in",
  },
  {
    grok: "Channels (Slack, iMessage, email send-as-user)",
    status: "not-transferred",
    piEquivalent: "None built-in",
  },
  {
    grok: "Grok Bot team chat / multi-bot wake",
    status: "not-transferred",
    piEquivalent: "None — separate Pi sessions per bot folder",
  },
  {
    grok: "Secrets, tokens, connector credentials, encryption keys",
    status: "not-transferred",
    piEquivalent: "Intentionally excluded",
  },
];

function ensureEmptyDir(dir, force) {
  if (fs.existsSync(dir)) {
    const entries = fs.readdirSync(dir);
    if (entries.length > 0 && !force) {
      throw new Error(`Output directory not empty: ${dir} (pass --force to overwrite)`);
    }
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function buildPersonaMarkdown(bundle) {
  const { persona } = bundle;
  const lines = [`# ${persona.name}`, "", "You are this agent. Follow this persona exactly.", ""];
  if (persona.title?.trim()) lines.push(`**Title:** ${persona.title.trim()}`, "");
  lines.push(persona.description.trim(), "");
  lines.push(
    "## Harness notes",
    "",
    "You are running inside Pi, not Grok Bot. Use Pi tools (read, bash, edit, write, and any configured MCP tools).",
    "Do not assume a shared box computer, browser desktop, or built-in social connectors.",
    "",
  );
  if (bundle.memories.length > 0) {
    lines.push(
      "Durable facts about the owner may be in `NOTES.md` in this folder. Read it when relevant.",
      "",
    );
  }
  return lines.join("\n");
}

function buildNotesMarkdown(bundle) {
  if (bundle.memories.length === 0) {
    return `# Notes\n\n_No portable memories were in the bundle._\n`;
  }
  const lines = [`# Notes for ${bundle.persona.name}`, ""];
  for (const m of bundle.memories) {
    lines.push(`## ${m.kind}${m.source ? ` (${m.source})` : ""}`, "", m.text.trim(), "");
  }
  return lines.join("\n");
}

function buildSkillMd(skill) {
  const name = toSkillSlug(skill.name);
  const desc = (skill.description || skill.name).slice(0, 1024).replace(/\s+/g, " ").trim();
  // Recipe skill bodies often carry their own frontmatter; drop it so the file has exactly one block.
  const body = String(skill.body || "").replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  // JSON strings are valid YAML double-quoted scalars, so colons/quotes in descriptions stay safe.
  return `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${body}\n`;
}

function buildPromptTemplate(routine) {
  const parts = [
    "---",
    `description: ${JSON.stringify(`Imported Grok Bot routine: ${routine.name}`)}`,
    'argument-hint: "[extra context]"',
    "---",
    "",
  ];
  if (routine.schedule) parts.push(`_Original schedule (Grok Bot): \`${routine.schedule}\`_`, "");
  if (routine.triggerSummary) parts.push(`_Original trigger: ${routine.triggerSummary}_`, "");
  parts.push(routine.prompt.trim(), "", "${@:-}", "");
  return parts.join("\n");
}

function buildCronSnippet(routine, botDir) {
  const schedule = routine.schedule?.trim() || "0 9 * * 1-5";
  const slug = toSkillSlug(routine.name);
  return `# Cron snippet for routine "${routine.name}"
# Pi has no built-in scheduler — paste into crontab -e if you want OS scheduling.
# ${schedule}  cd ${botDir} && pi -p "Run imported routine ${slug}. Follow .pi/prompts/${slug}.md"
#
# Original five-field cron: ${schedule}
`;
}

function buildSystemdUnit(routine, botDir) {
  const slug = toSkillSlug(routine.name);
  const schedule = routine.schedule?.trim() || "0 9 * * 1-5";
  return `# systemd user unit sketch for "${routine.name}" (cron was: ${schedule})
# Convert OnCalendar yourself; example enable:
#   cp ${slug}.service ${slug}.timer ~/.config/systemd/user/ && systemctl --user enable --now ${slug}.timer

# --- ${slug}.service ---
[Unit]
Description=Pi imported routine ${slug}

[Service]
Type=oneshot
WorkingDirectory=${botDir}
ExecStart=/usr/bin/env pi -p Run imported routine ${slug}. Follow .pi/prompts/${slug}.md

# --- ${slug}.timer ---
[Unit]
Description=Timer for Pi routine ${slug}

[Timer]
OnCalendar=*-*-* 09:00:00
Persistent=true

[Install]
WantedBy=timers.target
`;
}

function buildReport(bundle, outDir) {
  const mode = bundle.source?.mode || (bundle.source?.kind === "xai-share" ? "metadata-only" : "full");
  const lines = [
    `# Import report: ${bundle.persona.name}`,
    "",
    `- Bundle format: \`${bundle.format}\``,
    `- mode: \`${mode}\``,
    `- Source agent id: \`${bundle.source.agentId}\``,
    `- Source kind: \`${bundle.source?.kind || "local-export"}\``,
  ];
  if (bundle.source?.url) lines.push(`- Source URL: ${bundle.source.url}`);
  if (bundle.source?.sharerName) lines.push(`- Sharer: ${bundle.source.sharerName}`);
  if (bundle.source?.marketplaceSlug) {
    lines.push(`- Marketplace slug: \`${bundle.source.marketplaceSlug}\``);
  }
  lines.push(
    `- Exported at: ${bundle.exportedAt}`,
    `- Written to: \`${outDir}\``,
    "",
  );
  if (mode === "metadata-only") {
    lines.push(
      "> **Metadata-only import:** SpaceXAI does not publish skill/routine bodies on public share pages.",
      "> Add the template in the Grok Bot app, run `export-grokbot.mjs`, then re-import the JSON for a full recipe.",
      "",
    );
  }
  lines.push(
    "## What was written",
    "",
    "| Piece | Count / status |",
    "| --- | --- |",
    `| Persona → AGENTS.md + .pi/APPEND_SYSTEM.md | yes |`,
    `| Memories → NOTES.md | ${bundle.memories.length} |`,
    `| Skills → .pi/skills/*/SKILL.md | ${bundle.skills.length} |`,
    `| Routines → .pi/prompts + cron/systemd sketches | ${bundle.routines.length} |`,
    `| Plugin hints (names only) | ${bundle.plugins.length} |`,
    "",
    "## Transfer matrix",
    "",
    "| Grok Bot capability | Status | Pi equivalent |",
    "| --- | --- | --- |",
  );
  for (const row of TRANSFER_MATRIX) {
    lines.push(`| ${row.grok} | ${row.status} | ${row.piEquivalent} |`);
  }
  if (bundle.omitted?.length) {
    lines.push("", "## Omitted by exporter", "");
    for (const o of bundle.omitted) lines.push(`- ${o}`);
  }
  if (bundle.plugins.length) {
    lines.push("", "## Plugin / connector hints (re-add in Pi MCP yourself)", "");
    for (const p of bundle.plugins) {
      lines.push(`- **${p.id}**${p.note ? `: ${p.note}` : ""}`);
    }
    lines.push(
      "",
      "Pi MCP: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md",
      "Example: `pi mcp add my-server -- npx -y some-mcp-server`",
    );
  }
  lines.push(
    "",
    "## How to run this bot in Pi",
    "",
    "```bash",
    `cd ${outDir}`,
    "pi",
    "```",
    "",
    "Pi loads `AGENTS.md` from the working directory and discovers `.pi/skills/` and `.pi/prompts/`.",
    "",
  );
  return lines.join("\n");
}

export function importGrokBotBundle(bundle, options) {
  if (!isGrokBotBundle(bundle)) throw new Error("Invalid grokbot-bundle/v1 document");
  const slug = toBotSlug(bundle.persona.name);
  const outDir = path.resolve(options.outDir);
  ensureEmptyDir(outDir, Boolean(options.force));

  const personaMd = buildPersonaMarkdown(bundle);
  writeFile(path.join(outDir, "AGENTS.md"), personaMd);
  writeFile(path.join(outDir, ".pi", "APPEND_SYSTEM.md"), personaMd);
  writeFile(path.join(outDir, "NOTES.md"), buildNotesMarkdown(bundle));

  for (const skill of bundle.skills) {
    const name = toSkillSlug(skill.name);
    writeFile(path.join(outDir, ".pi", "skills", name, "SKILL.md"), buildSkillMd(skill));
  }

  for (const routine of bundle.routines) {
    const name = toSkillSlug(routine.name);
    writeFile(path.join(outDir, ".pi", "prompts", `${name}.md`), buildPromptTemplate(routine));
    writeFile(path.join(outDir, "cron", `${name}.cron.txt`), buildCronSnippet(routine, outDir));
    writeFile(path.join(outDir, "systemd", `${name}.units.txt`), buildSystemdUnit(routine, outDir));
  }

  const reportText = buildReport(bundle, outDir);
  const reportPath = path.join(outDir, "IMPORT_REPORT.md");
  writeFile(reportPath, reportText);
  writeFile(
    path.join(outDir, ".grokbot-import.json"),
    JSON.stringify(
      {
        format: bundle.format,
        agentId: bundle.source.agentId,
        name: bundle.persona.name,
        mode: bundle.source?.mode || (bundle.source?.kind === "xai-share" ? "metadata-only" : "full"),
        kind: bundle.source?.kind || "local-export",
        url: bundle.source?.url || undefined,
        importedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );

  return {
    outDir,
    slug,
    imported: {
      persona: true,
      memories: bundle.memories.length,
      skills: bundle.skills.length,
      routines: bundle.routines.length,
      pluginsNoted: bundle.plugins.length,
    },
    reportPath,
    reportText,
  };
}

export function loadBundleFromPath(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!isGrokBotBundle(data)) throw new Error(`Not a valid grokbot-bundle/v1 file: ${filePath}`);
  return data;
}
