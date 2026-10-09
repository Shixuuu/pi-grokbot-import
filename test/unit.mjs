#!/usr/bin/env node
// Offline unit tests (synthetic data only; no catalog content, no network, sandboxed HOME + fake crontab).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sbx = fs.mkdtempSync(path.join(os.tmpdir(), "grokbot-unit-"));
process.env.HOME = path.join(sbx, "home");
delete process.env.PI_CODING_AGENT_DIR;
process.env.GROKBOT_CRONTAB_BIN = path.join(here, "shims", "crontab");
process.env.SANDBOX_CRONTAB_FILE = path.join(sbx, "crontab.txt");
fs.mkdirSync(process.env.HOME, { recursive: true });

const S = await import("../src/scheduler.mjs");
const C = await import("../src/catalog.mjs");
const P = await import("../src/paths.mjs");
let n = 0;
const t = (name, fn) => Promise.resolve(fn()).then(() => (n++, console.log(`ok  ${name}`)));

await t("parseCronFile: cron line", () => assert.deepEqual(S.parseCronFile('# c\n30 8 * * 1-5 cd /x && pi -p "/r"\n'), { cron: "30 8 * * 1-5", cadence: null }));
await t("parseCronFile: commented cadence", () =>
  assert.deepEqual(S.parseCronFile("# Cadence described in the template: every weekday morning\n# M H DOM MON DOW pi\n"), { cron: null, cadence: "every weekday morning" }));
await t("cronToOnCalendar", () => {
  assert.equal(S.cronToOnCalendar("30 8 * * 1-5"), "Mon..Fri *-*-* 08:30:00");
  assert.equal(S.cronToOnCalendar("*/15 * * * *"), "*-*-* *:00/15:00");
  assert.equal(S.cronToOnCalendar("0 9 1 * *"), "*-*-01 09:00:00");
  assert.equal(S.cronToOnCalendar("0 9 1 * 1"), null);
  assert.equal(S.cronToOnCalendar("0 6 * * 5-1"), null);
});
await t("catalogRepo config precedence", () => {
  assert.equal(P.catalogRepo().repo, "Shixuuu/grokbot-pi-templates");
  process.env.GROKBOT_CATALOG_REPO = "me/other@dev";
  assert.deepEqual(P.catalogRepo(), { repo: "me/other", ref: "dev" });
  delete process.env.GROKBOT_CATALOG_REPO;
  P.writeConfig({ catalogRepo: "me/cfg" });
  assert.equal(P.catalogRepo().repo, "me/cfg");
  assert.equal(P.catalogRepo("x/y").repo, "x/y");
  P.writeConfig({ catalogRepo: null });
});
const fake = [
  { shareId: "AAAAAAAAAAAAAAAAAAAA1", slug: "alpha", name: "Alpha", description: "Stock trading desk", category: "trading-investing", tags: ["trading", "stocks"], official: false, status: "live", path: "templates/community/trading-investing/alpha", creator: "Ann", creatorHandle: "ann" },
  { shareId: "AAAAAAAAAAAAAAAAAAAA2", slug: "alpha", name: "Alpha", description: "Inbox helper", category: "personal-admin", official: false, status: "live", path: "templates/community/personal-admin/alpha" },
  { shareId: "AAAAAAAAAAAAAAAAAAAA3", slug: "beta", name: "Beta", description: "Official helper", category: "official", official: true, builtin: true, status: "live", path: "templates/official/beta", creator: "Bob" },
  { shareId: "AAAAAAAAAAAAAAAAAAAA4", slug: "gone", name: "Gone", description: "dead", category: "x", status: "dead" },
];
await t("search: text, tag, section, creator", () => {
  assert.equal(C.searchCatalog(fake, "trading").total, 1);
  assert.equal(C.searchCatalog(fake, "", { tag: "stocks" }).results[0].shareId, "AAAAAAAAAAAAAAAAAAAA1");
  assert.equal(C.searchCatalog(fake, "", { section: "builtin" }).results[0].slug, "beta");
  assert.equal(C.searchCatalog(fake, "", { creator: "@ann" }).total, 1);
  assert.equal(C.searchCatalog(fake, "dead").total, 0);
});
await t("resolve: ambiguous slug, shareId, path, dead", () => {
  assert.throws(() => C.resolveTemplate(fake, "alpha"), /ambiguous/);
  assert.equal(C.resolveTemplate(fake, "AAAAAAAAAAAAAAAAAAAA2").category, "personal-admin");
  assert.equal(C.resolveTemplate(fake, "community/trading-investing/alpha").shareId, "AAAAAAAAAAAAAAAAAAAA1");
  assert.equal(C.resolveTemplate(fake, "https://x.ai/bot/AAAAAAAAAAAAAAAAAAAA3").slug, "beta");
  assert.throws(() => C.resolveTemplate(fake, "gone"), /no installable package/);
});
await t("cron install/remove keeps foreign lines", async () => {
  fs.writeFileSync(process.env.SANDBOX_CRONTAB_FILE, "0 1 * * * echo mine\n");
  const ctx = { bot: "b1", botDir: "/tmp/b 1", piBin: "/usr/bin/pi", pathEnv: "/usr/bin", logDir: path.join(sbx, "logs") };
  await S.installSchedules("cron", ctx, [{ routine: "r1", cron: "0 9 * * *" }, { routine: "r2", cron: "5 10 * * 1" }]);
  await S.installSchedules("cron", { ...ctx, bot: "b2" }, [{ routine: "r1", cron: "0 7 * * *" }]);
  let tab = fs.readFileSync(process.env.SANDBOX_CRONTAB_FILE, "utf8");
  assert.equal((tab.match(/grokbot-import:b1:/g) || []).length, 2);
  assert.match(tab, /cd '\/tmp\/b 1' &&/);
  const r = await S.removeSchedules("b1", [{ kind: "cron", routine: "r1" }]);
  assert.equal(r.removed.length, 2);
  tab = fs.readFileSync(process.env.SANDBOX_CRONTAB_FILE, "utf8");
  assert.match(tab, /echo mine/);
  assert.match(tab, /grokbot-import:b2:r1/);
  assert.doesNotMatch(tab, /grokbot-import:b1:/);
});
fs.rmSync(sbx, { recursive: true, force: true });
console.log(`\n${n} unit tests passed`);
