// Refreshes the model list built into Walkie (src/pool/models.json) and the GGUF files `walkie pool run` may download
// (src/pool/gguf.json) from the live Hugging Face Hub, with the very pipeline `walkie pool` runs when someone asks
// (src/pool/hf/build.ts): current original chat models from established makers, sized from trusted GGUF repositories,
// rated by their benchmark results. Every model gets its GGUF files pinned (repository revision, size, sha256) from the
// Hub's own file listing; nothing is downloaded. The 13 hand-checked models the list held before stay as they are (their
// numbers were checked by hand and by real runs) and get a release date and a rating from the same data.
//
//   bun scripts/refresh-pool-catalog.ts                          dry run: what would change
//   bun scripts/refresh-pool-catalog.ts --write                  rewrite src/pool/models.json and src/pool/gguf.json
//   bun scripts/refresh-pool-catalog.ts --ratings-only [--write] re-rate the models already in the list under the current
//                                                                rules (quality.ts RATING_RULES) and touch nothing else:
//                                                                same models, same order, no pin moves, gguf.json is not
//                                                                written (src/pool/hf/ratings.ts)
//
// docs/plans/LOCAL-MODELS-HF-1.md. Needs the network; run by a maintainer, not by the test suite.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rankModels, type Catalog, type CatalogModel } from "../src/pool/catalog.ts";
import { CatalogSchema } from "../src/pool/catalog-schema.ts";
import { buildCatalog } from "../src/pool/hf/build.ts";
import { HfClient } from "../src/pool/hf/client.ts";
import { rerate } from "../src/pool/hf/ratings.ts";
import { GgufPins } from "../src/pool/run/gguf.ts";

const root = join(import.meta.dir, "..");
const modelsPath = join(root, "src", "pool", "models.json");
const ggufPath = join(root, "src", "pool", "gguf.json");
const write = process.argv.includes("--write");
const ratingsOnly = process.argv.includes("--ratings-only");
const MAX_NEW = 60;

const current = JSON.parse(readFileSync(modelsPath, "utf8")) as Catalog;
const pins = GgufPins.parse(JSON.parse(readFileSync(ggufPath, "utf8")));
const repoOf = (m: CatalogModel): string => m.source.replace("https://huggingface.co/", "");
// The hand-checked models are the ones no repository was read for (a model built from Hugging Face names its `gguf_repo`).
const legacy = current.models.filter((m) => !m.gguf_repo);
const legacyIds = new Set(legacy.map((m) => m.id));

const client = new HfClient({ maxRequests: 520, deadline: Date.now() + 240_000 });
const now = new Date();
// --ratings-only reads every model already in the list as an extra repository, so each is rated in the same one fit as the
// freshly built ones (a model that was also built is counted once, build.ts).
const result = await buildCatalog({
  client, now, template: current, pins: true, extraRepos: (ratingsOnly ? current.models : legacy).map(repoOf),
  progress: (note) => console.error(`  ${note}`),
});
console.error(`Read Hugging Face: ${result.requests} requests, ${result.catalog.models.length} models built, skipped ${JSON.stringify(result.skipped)}`);

if (ratingsOnly) {
  const r = rerate(current, (repo) => result.extra.get(repo)?.quality, now);
  const checkedRatings = CatalogSchema.safeParse(r.catalog);
  if (!checkedRatings.success) throw new Error(`models.json would not be valid: ${JSON.stringify(checkedRatings.error.issues[0])}`);
  const rated = r.catalog.models.filter((m) => m.quality?.basis === "rated").length;
  console.log([
    `re-rated ${r.catalog.models.length} models under the current rules: rated ${rated}, unrated ${r.catalog.models.length - rated}, not read ${r.unread.length}${r.unread.length ? ` (${r.unread.join(", ")})` : ""}`,
    ...r.changes.map((c) => `  ${c.id.padEnd(32)} ${c.before}  ->  ${c.after}`),
  ].join("\n"));
  if (!write) { console.log("\nDry run: nothing written (--write rewrites src/pool/models.json only; gguf.json is never touched in this mode)."); process.exit(0); }
  writeFileSync(modelsPath, `${JSON.stringify(r.catalog, null, 2)}\n`);
  console.log("\nWrote src/pool/models.json (ratings only); src/pool/gguf.json untouched.");
  process.exit(0);
}

// The older hand-checked models keep their numbers; they gain a date and a rating.
const kept: CatalogModel[] = legacy.map((m) => {
  const e = result.extra.get(repoOf(m));
  return e ? { ...m, released: e.released, quality: e.quality } : m;
});
const fresh = rankModels(result.catalog.models.filter((m) => !legacyIds.has(m.id))).slice(0, MAX_NEW);
const models = rankModels([...kept, ...fresh]).map((m): CatalogModel => ({ ...m, ...(m.downloads === undefined ? {} : { downloads: m.downloads }) }));
const next: Catalog = {
  ...current, version: current.version + 1, updated: now.toISOString().slice(0, 10), origin: { kind: "built-in", at: now.toISOString() }, models,
};
const checked = CatalogSchema.safeParse(next);
if (!checked.success) throw new Error(`models.json would not be valid: ${JSON.stringify(checked.error.issues[0])}`);

// `pins: true` keeps only files whose sha256 the Hub gave; this narrows the type and fails loudly if that ever stops holding.
const withHashes = (id: string, files: readonly { path: string; size: number; sha256: string | null }[]): { path: string; size: number; sha256: string }[] =>
  files.map((f) => {
    if (f.sha256 === null) throw new Error(`no sha256 for ${f.path} of ${id}`);
    return { path: f.path, size: f.size, sha256: f.sha256 };
  });
// The hand-checked models keep their pins as they are; every other pin is rebuilt from the Hub with the list, so a model
// the rules now leave out does not leave its pin behind.
const nextPins: GgufPins = { ...pins, updated: next.updated, models: Object.fromEntries(Object.entries(pins.models).filter(([id]) => legacyIds.has(id))) };
for (const m of fresh) {
  const p = result.pins.get(m.id);
  if (!p) throw new Error(`no pin for ${m.id}`);
  nextPins.models[m.id] = { repo: p.repo, revision: p.revision, files: { q4: withHashes(m.id, p.q4), q8: p.q8 && withHashes(m.id, p.q8) } };
}
const sortedPins: GgufPins = { ...nextPins, models: Object.fromEntries(Object.entries(nextPins.models).sort(([a], [b]) => a.localeCompare(b))) };
GgufPins.parse(sortedPins);
const ids = new Set(models.map((m) => m.id));
const missing = Object.keys(sortedPins.models).filter((id) => !ids.has(id));
if (missing.length || models.some((m) => !(m.id in sortedPins.models))) throw new Error(`the list and the pins disagree (${missing.join(", ")})`);

const summary = [
  `models: ${current.models.length} -> ${models.length} (${legacy.length} kept as they were, ${fresh.length} new)`,
  `rated ${models.filter((m) => m.quality?.basis === "rated").length}, unrated ${models.filter((m) => m.quality?.basis !== "rated").length}`,
  ...models.slice(0, 12).map((m, i) => `  ${String(i + 1).padStart(2)}. ${m.id} (${m.maker}, ${m.params_b}B${m.active_b ? `, ${m.active_b}B active` : ""}) ${m.quality?.basis === "rated" ? `score ${m.quality.score}` : "unrated"} ${m.released ?? ""}`),
];
console.log(summary.join("\n"));
if (!write) { console.log("\nDry run: nothing written (--write rewrites src/pool/models.json and src/pool/gguf.json)."); process.exit(0); }
writeFileSync(modelsPath, `${JSON.stringify(next, null, 2)}\n`);
writeFileSync(ggufPath, `${JSON.stringify(sortedPins, null, 1)}\n`);
console.log("\nWrote src/pool/models.json and src/pool/gguf.json.");
