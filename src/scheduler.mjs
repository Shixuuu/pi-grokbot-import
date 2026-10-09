/**
 * Routine schedules: user crontab or systemd --user timers.
 * Every entry is tagged so uninstall removes exactly what we added:
 *   cron:    trailing comment  "# grokbot-import:<bot>:<routine>"
 *   systemd: unit files        "grokbot-<bot>-<routine>.{service,timer}" with a marker comment
 *
 * Binaries can be overridden for sandboxes/tests: GROKBOT_CRONTAB_BIN, GROKBOT_SYSTEMCTL_BIN.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { homeDir } from "./paths.mjs";

const MARK = "grokbot-import";

function run(cmd, args, { input, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        missing: err?.code === "ENOENT",
      });
    });
    child.stdin?.on("error", () => {});
    if (input !== undefined) child.stdin?.end(input);
  });
}

const crontabBin = () => process.env.GROKBOT_CRONTAB_BIN || "crontab";
const systemctlBin = () => process.env.GROKBOT_SYSTEMCTL_BIN || "systemctl";

export function systemdUserDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(homeDir(), ".config");
  return path.join(base, "systemd", "user");
}

/** Pick a scheduler for this platform. pref: auto | cron | systemd | none */
export async function detectScheduler(pref = "auto") {
  if (pref === "none") return { kind: "none", reason: "disabled" };
  const canSystemd = async () => {
    if (process.platform !== "linux") return false;
    const r = await run(systemctlBin(), ["--user", "show-environment"]);
    return !r.missing && r.code === 0;
  };
  const canCron = async () => {
    const r = await run(crontabBin(), ["-l"]);
    if (r.missing) return false;
    return r.code === 0 || /no crontab/i.test(r.stderr);
  };
  if (pref === "systemd") return (await canSystemd()) ? { kind: "systemd" } : { kind: "none", reason: "systemctl --user is not available" };
  if (pref === "cron") return (await canCron()) ? { kind: "cron" } : { kind: "none", reason: "crontab is not available" };
  if (await canSystemd()) return { kind: "systemd" };
  if (await canCron()) return { kind: "cron" };
  return { kind: "none", reason: "neither systemctl --user nor crontab is available" };
}

/** Parse a template cron/<routine>.cron file. */
export function parseCronFile(text) {
  const lines = String(text || "").split(/\r?\n/);
  let cron = null;
  let cadence = null;
  for (const l of lines) {
    const t = l.trim();
    if (!t) continue;
    if (t.startsWith("#")) {
      const m = t.match(/Cadence described in the template:\s*(.+)$/i);
      if (m) cadence = m[1].trim();
      continue;
    }
    const f = t.split(/\s+/);
    if (f.length >= 6 && validCron(f.slice(0, 5).join(" "))) {
      cron = f.slice(0, 5).join(" ");
      break;
    }
  }
  return { cron, cadence };
}

export function validCron(expr) {
  const f = String(expr || "").trim().split(/\s+/);
  return f.length === 5 && f.every((x) => /^[\d*,\-/]+$/.test(x) || /^[A-Za-z]{3}(-[A-Za-z]{3})?(,[A-Za-z]{3})*$/.test(x));
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function convPart(part, { dow = false } = {}) {
  const fmt = (n) => {
    if (!/^\d+$/.test(n)) return null;
    if (dow) return DOW[Number(n)] ?? null;
    return String(n).padStart(2, "0");
  };
  const items = part.split(",").map((p) => {
    let m;
    if (p === "*") return "*";
    if ((m = p.match(/^\*\/(\d+)$/))) return dow ? null : `00/${m[1]}`;
    if ((m = p.match(/^(\d+)\/(\d+)$/))) return dow ? null : `${fmt(m[1])}/${m[2]}`;
    if ((m = p.match(/^(\d+)-(\d+)$/))) {
      if (Number(m[1]) > Number(m[2])) return null;
      const a = fmt(m[1]);
      const b = fmt(m[2]);
      return a && b ? `${a}..${b}` : null;
    }
    return fmt(p);
  });
  if (items.some((x) => x === null)) return null;
  if (items.includes("*") && items.length > 1) return null;
  return items.join(",");
}

/** Convert a 5-field cron expression to a systemd OnCalendar value, or null if not representable. */
export function cronToOnCalendar(expr) {
  if (!validCron(expr)) return null;
  const [mi, h, dom, mon, dow] = expr.trim().split(/\s+/);
  if (dom !== "*" && dow !== "*") return null; // cron ORs these; systemd ANDs them
  if ([mi, h, dom, mon, dow].some((x) => /[A-Za-z]/.test(x))) return null;
  const M = convPart(mi);
  const H = convPart(h);
  const D = convPart(dom);
  const MO = convPart(mon);
  const W = dow === "*" ? "" : convPart(dow, { dow: true });
  if ([M, H, D, MO, W].some((x) => x === null)) return null;
  return `${W ? `${W} ` : ""}*-${MO}-${D} ${H}:${M}:00`;
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function cronLine({ cron, bot, routine, botDir, piBin, pathEnv, logFile }) {
  const esc = (s) => String(s).replace(/%/g, "\\%");
  const cmd = `cd ${shq(botDir)} && PATH=${shq(pathEnv)} ${shq(piBin)} -p --approve ${shq(`/${routine}`)} < /dev/null >> ${shq(logFile)} 2>&1`;
  return `${cron} ${esc(cmd)} # ${MARK}:${bot}:${routine}`;
}

export function unitBase(bot, routine) {
  return `grokbot-${bot}-${routine}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 200);
}

export function systemdUnits({ onCalendar, bot, routine, botDir, piBin, pathEnv, logFile, botName }) {
  const q = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const service = `# ${MARK}:${bot}:${routine}
[Unit]
Description=Grok Bot routine ${routine} (${botName || bot}) via Pi

[Service]
Type=oneshot
WorkingDirectory=${botDir}
Environment=${q(`PATH=${pathEnv}`)}
StandardInput=null
StandardOutput=append:${logFile}
StandardError=append:${logFile}
ExecStart=${q(piBin)} -p --approve ${q(`/${routine}`)}
`;
  const timer = `# ${MARK}:${bot}:${routine}
[Unit]
Description=Schedule for Grok Bot routine ${routine} (${botName || bot})

[Timer]
OnCalendar=${onCalendar}
Persistent=true

[Install]
WantedBy=timers.target
`;
  return { service, timer };
}

export async function readCrontab() {
  const r = await run(crontabBin(), ["-l"]);
  if (r.missing) throw new Error("crontab not found");
  if (r.code !== 0) {
    if (/no crontab/i.test(r.stderr)) return "";
    throw new Error(`crontab -l failed: ${r.stderr.trim()}`);
  }
  return r.stdout;
}

async function writeCrontab(text) {
  const r = await run(crontabBin(), ["-"], { input: text });
  if (r.code !== 0) throw new Error(`crontab - failed: ${r.stderr.trim()}`);
}

const tagFor = (bot, routine) => `# ${MARK}:${bot}:${routine}`;

/** Install schedule entries. entries: [{routine, cron, onCalendar}] already resolved. */
export async function installSchedules(kind, { bot, botDir, piBin, pathEnv, logDir, botName }, entries) {
  fs.mkdirSync(logDir, { recursive: true });
  const done = [];
  if (kind === "cron") {
    const lines = (await readCrontab()).split("\n").filter((l, i, a) => !(l === "" && i === a.length - 1));
    const keep = lines.filter((l) => !entries.some((e) => l.endsWith(tagFor(bot, e.routine))));
    for (const e of entries) {
      const line = cronLine({ cron: e.cron, bot, routine: e.routine, botDir, piBin, pathEnv, logFile: path.join(logDir, `${e.routine}.log`) });
      keep.push(line);
      done.push({ kind: "cron", routine: e.routine, cron: e.cron });
    }
    await writeCrontab(keep.join("\n") + "\n");
  } else if (kind === "systemd") {
    const dir = systemdUserDir();
    fs.mkdirSync(dir, { recursive: true });
    for (const e of entries) {
      const base = unitBase(bot, e.routine);
      const u = systemdUnits({ onCalendar: e.onCalendar, bot, routine: e.routine, botDir, piBin, pathEnv, logFile: path.join(logDir, `${e.routine}.log`), botName });
      fs.writeFileSync(path.join(dir, `${base}.service`), u.service);
      fs.writeFileSync(path.join(dir, `${base}.timer`), u.timer);
      done.push({ kind: "systemd", routine: e.routine, cron: e.cron, onCalendar: e.onCalendar, unit: `${base}.timer`, files: [path.join(dir, `${base}.service`), path.join(dir, `${base}.timer`)] });
    }
    const rl = await run(systemctlBin(), ["--user", "daemon-reload"]);
    if (rl.code !== 0) throw new Error(`systemctl --user daemon-reload failed: ${rl.stderr.trim()}`);
    for (const d of done) {
      const r = await run(systemctlBin(), ["--user", "enable", "--now", d.unit]);
      if (r.code !== 0) throw new Error(`systemctl --user enable --now ${d.unit} failed: ${r.stderr.trim()}`);
    }
  }
  return done;
}

/** Remove schedule entries for a bot (all, or only the listed routines). */
export async function removeSchedules(bot, recorded = [], { routines } = {}) {
  const want = (r) => !routines || routines.includes(r);
  const removed = [];
  const errors = [];
  const hadCron = recorded.some((s) => s.kind === "cron");
  try {
    const tab = await readCrontab();
    const lines = tab.split("\n");
    const prefix = `# ${MARK}:${bot}:`;
    const keep = lines.filter((l) => {
      const i = l.lastIndexOf(prefix);
      if (i < 0) return true;
      const routine = l.slice(i + prefix.length).trim();
      if (!want(routine) || /\s/.test(routine)) return true;
      removed.push({ kind: "cron", routine });
      return false;
    });
    if (keep.length !== lines.length) {
      const body = keep.filter((l) => l !== "").length ? keep.join("\n").replace(/\n*$/, "\n") : "";
      await writeCrontab(body);
    }
  } catch (e) {
    if (hadCron) errors.push(e.message);
  }
  const units = recorded.filter((s) => s.kind === "systemd" && want(s.routine));
  if (units.length) {
    for (const u of units) {
      const r = await run(systemctlBin(), ["--user", "disable", "--now", u.unit]);
      if (r.code !== 0 && !r.missing) errors.push(`disable ${u.unit}: ${r.stderr.trim()}`);
      for (const f of u.files || []) {
        try {
          fs.unlinkSync(f);
        } catch {
          /* already gone */
        }
      }
      removed.push({ kind: "systemd", routine: u.routine, unit: u.unit });
    }
    await run(systemctlBin(), ["--user", "daemon-reload"]);
  }
  return { removed, errors };
}
