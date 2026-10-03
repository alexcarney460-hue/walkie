// From the Hub's answers to a catalog: discover what people run (GGUF repositories by downloads and trending), collapse
// them to base models, keep current original chat models from established makers, size each from its trusted GGUF
// files, read its architecture and active parameters, rate it by benchmark results, and say what was left out and why.
// The result is a `Catalog` (the type suggest.ts takes) plus, for the built-in list, the files to pin.
// docs/plans/LOCAL-MODELS-HF-1.md "Design".
import { z } from "zod";
import { MAX_BASES, MAX_ORG_LOOKUPS, PRE_CANDIDATES } from "./bounds.ts";
export { MAX_BASES } from "./bounds.ts";
import { CATALOG, memoryNeeded, rankModels, type Catalog, type CatalogModel, type ModelQuality } from "../catalog.ts";
import { CatalogModelSchema, CatalogSchema } from "../catalog-schema.ts";
import { activeFromCard } from "./card.ts";
import { collapse, CHAT_PIPELINES, continuesAnother, idFor, isCurrent, isEstablished, isNotPlainChat, isOriginal, licenseOf, nameIsCheckpoint, type BaseGroup, type Skip } from "./candidates.ts";
import { HF_ORIGIN, HfClient, HfError, isFatal, mapLimit, MAX } from "./client.ts";
import { activeFromName, readArch } from "./config.ts";
import { orderRepos, pickQuants, type GgufFile, type QuantFiles, type RepoRef } from "./ggufs.ts";
import { benchmarkValues, qualityOf, rateModels } from "./quality.ts";
import { BlobRecord, evalEntries, ListItem, makerName, ModelRecord, OrgOverview, parseItems } from "./schemas.ts";

/** What people run: GGUF repositories by 30-day downloads (three kinds of chat pipeline) and by trending. */
export const DISCOVERY: readonly { tag: string; sort: "downloads" | "trendingScore"; limit: number }[] = [
  { tag: "text-generation", sort: "downloads", limit: 300 },
  { tag: "image-text-to-text", sort: "downloads", limit: 300 },
  { tag: "any-to-any", sort: "downloads", limit: 150 },
  { tag: "text-generation", sort: "trendingScore", limit: 150 },
  { tag: "image-text-to-text", sort: "trendingScore", limit: 150 },
];
/** The most requests one base can take: its record, its quantization list, three file listings, a config and a card (each read is a redirect and an answer). */
const PER_BASE_REQUESTS = 9;
const MAX_MODELS = 100;
export const CONCURRENCY = 6;
/** The 4-bit file must be this share of "parameters x 4.89 bits": a wrong parameter count or a wrong repository shows here. */
const SIZE_RATIO = [0.5, 1.4] as const;
const EXPAND_RECORD = ["baseModels", "createdAt", "downloads", "likes", "gated", "pipeline_tag", "safetensors", "sha", "tags", "evalResults"] as const;
const GiB = 1024 ** 3;
const BLOB_MAX = 2 << 20;

export interface Pinned { repo: string; revision: string; q4: Required<GgufFile>[]; q8: Required<GgufFile>[] | null }

export interface BuildOptions {
  client: HfClient;
  now: Date;
  /** The constants of the memory formula (context, bits per weight, overhead): the shipped list's. */
  template?: Catalog;
  maxBases?: number;
  concurrency?: number;
  minModels?: number;
  /** The built-in list's generator: only files whose sha256 is known count, so every model can be pinned. */
  pins?: boolean;
  /** Other base repositories whose results join the rating (the built-in list's older models); returned in `extra`. */
  extraRepos?: readonly string[];
  progress?: (note: string) => void;
}

/** Discovery can leave a maker unqueried at the lookup cap; this says nothing about its standing. */
export type BuildSkip = Skip | "maker_unqueried";

export interface BuildResult {
  catalog: Catalog;
  pins: Map<string, Pinned>;
  skips: { repo: string; reason: BuildSkip }[];
  skipped: Partial<Record<BuildSkip, number>>;
  extra: Map<string, { released: string; downloads: number; quality: ModelQuality }>;
  requests: number;
}

const owner = (repo: string): string => repo.split("/")[0]!;
const nameOf = (repo: string): string => repo.split("/")[1]!;
const round = (x: number, digits: number): number => Math.round(x * 10 ** digits) / 10 ** digits;
const Items = z.unknown();

const recordPath = (repo: string): string => `/api/models/${repo}?${EXPAND_RECORD.map((e) => `expand[]=${e}`).join("&")}`;
const listPath = (d: (typeof DISCOVERY)[number]): string => `/api/models?filter=gguf&pipeline_tag=${d.tag}&sort=${d.sort}&limit=${d.limit}&expand[]=baseModels&expand[]=downloads&expand[]=createdAt`;
const quantsPath = (base: string): string => `/api/models?filter=base_model:quantized:${base}&filter=gguf&sort=downloads&limit=50&expand[]=downloads`;
const blobsPath = (repo: string): string => `/api/models/${repo}?blobs=true&expand[]=siblings&expand[]=sha&expand[]=downloads`;

interface Built { model: CatalogModel; values: Map<string, number>; pinned: Pinned | null }
type Outcome = { built: Built } | { skip: Skip };

export async function buildCatalog(opts: BuildOptions): Promise<BuildResult> {
  const { client, now } = opts;
  const template = opts.template ?? CATALOG;
  const limit = opts.concurrency ?? CONCURRENCY;
  const note = opts.progress ?? (() => undefined);
  const skips: { repo: string; reason: BuildSkip }[] = [];
  const skip = (repo: string, reason: BuildSkip): void => { skips.push({ repo, reason }); };

  // 1. What people run.
  note("Looking at what people run on Hugging Face");
  const lists = await mapLimit(DISCOVERY, limit, async (d) => {
    try {
      const raw = await client.json(listPath(d), Items, MAX.list);
      return parseItems(raw, ListItem, d.limit).items;
    } catch (err) {
      if (isFatal(err)) throw err;
      return null;
    }
  });
  const ok = lists.filter((l): l is z.infer<typeof ListItem>[] => l !== null);
  if (ok.length === 0) throw new HfError("malformed", "Hugging Face's lists of GGUF models could not be read");
  const bases = [...collapse(ok.flat()).values()];
  const seen = bases.map((g) => g.base);
  for (const g of bases) if (nameIsCheckpoint(nameOf(g.base))) skip(g.base, "checkpoint");
  const groups = bases
    .filter((g) => !nameIsCheckpoint(nameOf(g.base)))
    .filter((g) => { const d = continuesAnother(g.base, seen); if (d) skip(g.base, "derivative"); return !d; })
    .filter((g) => { const old = g.first !== undefined && !isCurrent(g.first, now); if (old) skip(g.base, "old"); return !old; })
    .sort((a, b) => b.downloads - a.downloads || a.base.localeCompare(b.base))
    .slice(0, PRE_CANDIDATES);

  // 2. Established makers.
  note("Checking who made them");
  const owners = [...new Set(groups.map((g) => owner(g.base)))].slice(0, MAX_ORG_LOOKUPS);
  const orgs = new Map<string, z.infer<typeof OrgOverview> | null>();
  await mapLimit(owners, limit, async (o) => {
    try { orgs.set(o, await client.json(`/api/organizations/${o}/overview`, OrgOverview, 64 << 10)); } catch (err) { if (isFatal(err)) throw err; orgs.set(o, null); }
  });
  const established = groups.filter((g) => {
    if (!orgs.has(owner(g.base))) { skip(g.base, "maker_unqueried"); return false; }
    const ok2 = isEstablished(orgs.get(owner(g.base)) ?? null);
    if (!ok2) skip(g.base, "not_established");
    return ok2;
  }).slice(0, opts.maxBases ?? MAX_BASES);

  // 3. Each base: record, then quantization files, config and card.
  note(`Reading ${established.length} models`);
  // The bases are in order of how many people run them. When the request budget runs short the rest are left out (and
  // counted) instead of failing the refresh: what was read is a good list, and the ones left are the least run.
  const reserve = limit * PER_BASE_REQUESTS + (opts.extraRepos?.length ?? 0);
  const outcomes = await mapLimit(established, limit, async (g): Promise<Outcome> => {
    if (client.remaining < reserve) return { skip: "budget" };
    try { return await examine(client, g, orgs.get(owner(g.base))!, now, template, opts.pins === true); } catch (err) { if (isFatal(err)) throw err; return { skip: "error" }; }
  });
  const built: Built[] = [];
  const ids = new Set<string>();
  established.forEach((g, i) => {
    const o = outcomes[i]!;
    if ("skip" in o) { skip(g.base, o.skip); return; }
    if (ids.has(o.built.model.id)) { skip(g.base, "duplicate_id"); return; }
    ids.add(o.built.model.id);
    built.push(o.built);
  });

  // 4. Quality: one fit over every model with results (and the extra repositories asked for).
  const extraRecords = new Map<string, ModelRecord>();
  await mapLimit(opts.extraRepos ?? [], limit, async (repo) => {
    try {
      const rec = await client.json(recordPath(repo), ModelRecord, MAX.record);
      if (rec) extraRecords.set(repo, rec);
    } catch (err) { if (isFatal(err)) throw err; }
  });
  const obs = new Map<string, Map<string, number>>();
  for (const b of built) obs.set(b.model.source, b.values);
  // An extra repository that was also built is that same model: counting it again would weigh it double in the fit.
  const builtSources = new Set(built.map((b) => b.model.source));
  const keyOf = (repo: string): string => (builtSources.has(`${HF_ORIGIN}/${repo}`) ? `${HF_ORIGIN}/${repo}` : `extra:${repo}`);
  for (const [repo, rec] of extraRecords) if (keyOf(repo).startsWith("extra:")) obs.set(keyOf(repo), valuesOf(rec));
  const { scores } = rateModels(obs);
  const admitted: CatalogModel[] = [];
  for (const b of built) {
    const model = { ...b.model, quality: qualityOf(b.values, scores.get(b.model.source)) };
    if (!CatalogModelSchema.safeParse(model).success) {
      skip(b.model.source.slice("https://huggingface.co/".length), "invalid_model");
      continue;
    }
    admitted.push(model);
  }
  const models = rankModels(admitted).slice(0, MAX_MODELS);
  const extra = new Map<string, { released: string; downloads: number; quality: ModelQuality }>();
  for (const [repo, rec] of extraRecords) {
    extra.set(repo, { released: rec.createdAt.slice(0, 10), downloads: rec.downloads ?? 0, quality: qualityOf(valuesOf(rec), scores.get(keyOf(repo))) });
  }

  const minModels = opts.minModels ?? 5;
  if (models.length < minModels) throw new HfError("malformed", `too few usable models on Hugging Face (${models.length} of the ${minModels} needed)`);
  const catalog: Catalog = {
    ...template, version: template.version, updated: now.toISOString().slice(0, 10), origin: { kind: "huggingface", at: now.toISOString() }, models,
  };
  const valid = CatalogSchema.safeParse(catalog);
  if (!valid.success) throw new HfError("malformed", `the list built from Hugging Face is not valid (${valid.error.issues[0]?.message ?? "unknown"})`);
  const kept = new Set(models.map((m) => m.id));
  const pins = new Map([...built].filter((b) => kept.has(b.model.id) && b.pinned).map((b) => [b.model.id, b.pinned!] as const));
  const skipped: Partial<Record<BuildSkip, number>> = {};
  for (const s of skips) skipped[s.reason] = (skipped[s.reason] ?? 0) + 1;
  return { catalog, pins, skips, skipped, extra, requests: client.requests };
}

const valuesOf = (rec: ModelRecord): Map<string, number> => benchmarkValues(evalEntries(rec).entries.map((e) => ({ dataset: e.data.dataset.id, value: e.data.value, verified: e.verified, pullRequest: e.pullRequest })));

/** One base model through the checks; each step is only taken when the cheaper ones before it passed. */
async function examine(client: HfClient, g: BaseGroup, org: z.infer<typeof OrgOverview>, now: Date, template: Catalog, pins: boolean): Promise<Outcome> {
  const base = g.base;
  const rec = await client.json(recordPath(base), ModelRecord, MAX.record);
  if (!rec) return { skip: "unavailable" };
  if (!CHAT_PIPELINES.has(rec.pipeline_tag ?? "") || isNotPlainChat(rec.tags)) return { skip: "not_chat" };
  if (!isOriginal(rec.baseModels, owner(base))) return { skip: "derivative" };
  if (!isCurrent(rec.createdAt, now)) return { skip: "old" };
  const total = rec.safetensors?.total ?? 0;
  const paramsB = round(total / 1e9, 2);
  if (!(paramsB >= 0.1)) return { skip: "bad_params" };

  // The 4-bit (and 8-bit) files from the maker's or a trusted quantizer's repository.
  const found = await client.json(quantsPath(base), Items, MAX.list).then((raw) => parseItems(raw, ListItem, 50).items).catch((err) => { if (isFatal(err)) throw err; return [] as z.infer<typeof ListItem>[]; });
  const repos = orderRepos(owner(base), found.map((i): RepoRef => ({ id: i.id, downloads: i.downloads ?? 0 })), g.own);
  let chosen: { repo: string; sha: string; quants: { q4: QuantFiles; q8: QuantFiles | null } } | null = null;
  for (const repo of repos) {
    const blob = await client.json(blobsPath(repo), BlobRecord, BLOB_MAX).catch((err) => { if (isFatal(err)) throw err; return null; });
    if (!blob) continue;
    const q = pickQuants(blob.siblings);
    const q4 = q.q4;
    if (!q4 || (pins && q4.files.some((f) => f.sha256 === null))) continue;
    const q8 = q.q8 && (!pins || q.q8.files.every((f) => f.sha256 !== null)) ? q.q8 : null;
    chosen = { repo, sha: blob.sha, quants: { q4, q8 } };
    break;
  }
  if (!chosen) return { skip: "no_gguf" };
  const ratio = chosen.quants.q4.bytes / ((paramsB * 1e9 * template.bits_per_weight.q4) / 8);
  if (ratio < SIZE_RATIO[0] || ratio > SIZE_RATIO[1]) return { skip: "gguf_mismatch" };

  // Layers, KV heads, head size.
  const text = await client.text(`/${base}/resolve/main/config.json`, MAX.text);
  if (text === null) return { skip: "no_config" };
  let config: unknown;
  try { config = JSON.parse(text); } catch { return { skip: "bad_config" }; }
  const arch = readArch(config);
  if (!arch.ok) return { skip: "bad_config" };

  // Active parameters: the maker's name token, else the model card for a Mixture of Experts, else it is dense.
  const token = activeFromName(nameOf(base));
  let active: number | null = token;
  let from = "the model name";
  if (active === null && arch.moe) {
    const card = await client.text(`/${base}/resolve/main/README.md`, MAX.text);
    active = card === null ? null : activeFromCard(card, paramsB);
    from = "the model card";
    if (active === null) return { skip: "no_active" };
  }
  if (active !== null && !(active < paramsB)) return { skip: "no_active" };

  const id = idFor(nameOf(base));
  if (!id) return { skip: "error" };
  const q4Gib = round(chosen.quants.q4.bytes / GiB, 2);
  const q8Gib = chosen.quants.q8 ? round(chosen.quants.q8.bytes / GiB, 2) : null;
  const draft: CatalogModel = {
    id, name: nameOf(base), maker: makerName(org.fullname, owner(base)), params_b: paramsB, active_b: active, arch: arch.arch,
    weights_gib: { q4: q4Gib, q8: q8Gib }, mem_gib: { q4: null, q8: null }, license: licenseOf(rec.tags),
    released: rec.createdAt.slice(0, 10), downloads: g.downloads, gguf_repo: chosen.repo,
    source: `https://huggingface.co/${base}`, config_source: `https://huggingface.co/${base}/blob/main/config.json`, verified: true,
    note: noteFor(paramsB, active, arch.moe, from, arch.arch),
  };
  const fig = (q: "q4" | "q8"): number | null => { const n = memoryNeeded(draft, q, template.context_tokens, template); return n === null ? null : round(n / GiB, 2); };
  const model: CatalogModel = { ...draft, mem_gib: { q4: fig("q4"), q8: fig("q8") } };
  if (!CatalogModelSchema.safeParse(model).success) return { skip: "invalid_model" };
  const pinned: Pinned | null = pins ? { repo: chosen.repo, revision: chosen.sha, q4: chosen.quants.q4.files as Required<GgufFile>[], q8: chosen.quants.q8 ? (chosen.quants.q8.files as Required<GgufFile>[]) : null } : null;
  return { built: { model, values: valuesOf(rec), pinned } };
}

function noteFor(paramsB: number, active: number | null, moe: boolean, from: string, arch: CatalogModel["arch"]): string | undefined {
  const parts: string[] = [];
  if (active !== null) {
    parts.push(moe
      ? `Mixture of experts, ${paramsB}B total / ${active}B active (from ${from}): a token reads only the active share of the weights.`
      : `${active}B effective parameters (from ${from}); the files hold all ${paramsB}B.`);
  }
  if (arch.hybrid) {
    const s = arch.hybrid.sliding;
    parts.push(`Memory follows the config: ${arch.hybrid.full_layers} of ${arch.layers} layers hold a KV cache${s ? `, ${s.layers} more only over a window of ${s.window} tokens` : ""}.`);
  }
  return parts.length ? parts.join(" ").slice(0, 600) : undefined;
}
