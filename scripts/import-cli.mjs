#!/usr/bin/env node
import path from "node:path";
import { importGrokBotBundle } from "../src/import-bundle.mjs";
import { toBotSlug } from "../src/schema.mjs";
import { loadBundleFromSource } from "../src/fetch-template.mjs";

function parseArgs(argv) {
  const out = { source: null, outDir: null, force: false, skipFullFetch: false };
  const rest = [...argv];
  while (rest.length) {
    const a = rest.shift();
    if (a === "--out") out.outDir = rest.shift();
    else if (a === "--force") out.force = true;
    else if (a === "--skip-full-fetch") out.skipFullFetch = true;
    else if (!a.startsWith("-") && !out.source) out.source = a;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.source) {
  console.error(
    "Usage: import-cli.mjs <bundle.json|share-url> [--out dir] [--force] [--skip-full-fetch]\n" +
      "  share-url examples:\n" +
      "    https://x.ai/bot/1GpK7CoPs4e_M__9rb3uR\n" +
      "    grokbot://app/v1/bot-template?id=1GpK7CoPs4e_M__9rb3uR\n" +
      "    https://x.ai/bot/marketplace/bots/seed-a91e4c\n" +
      "    https://grokbottemplates.app/t/adaptlypost",
  );
  process.exit(1);
}

const bundle = await loadBundleFromSource(args.source, {
  baseDir: process.cwd(),
  skipFullFetch: args.skipFullFetch,
});
const slug = toBotSlug(bundle.persona.name);
const outDir = path.resolve(args.outDir || path.join(process.cwd(), "imported-bots", slug));
const result = importGrokBotBundle(bundle, { outDir, force: args.force });
console.log(result.reportText);
console.log("\n---");
console.log(
  JSON.stringify(
    {
      outDir: result.outDir,
      imported: result.imported,
      mode: bundle.source?.mode || "full",
      kind: bundle.source?.kind || "local-export",
      url: bundle.source?.url,
    },
    null,
    2,
  ),
);
