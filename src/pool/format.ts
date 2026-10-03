// Plain-language labels for local-model suggestions, shared by `walkie pool` and the dashboard (no zod here).
import { MAX_BASES, MAX_ORG_LOOKUPS, PRE_CANDIDATES } from "./hf/bounds.ts";
import { MIN_RESULTS } from "./hf/quality.ts";
import { CPU_MEMORY, IDLE_OS_BYTES } from "./capacity.ts";
import { CATALOG, compareModels, QUANT_LABEL, ratedPlace, type Catalog, type CatalogModel } from "./catalog.ts";
import type { PoolGroup } from "./group.ts";
import { UNMEASURED_RTT_MS, type CombinedPick } from "./combined.ts";
import type { GroupSuggestion, Pick, Placement, SpeedClass } from "./suggest.ts";

export const SPEED_LABEL: Record<SpeedClass, string> = { fast: "fast", usable: "usable", slow: "slow" };
export const SPEED_HINT: Record<SpeedClass, string> = {
  fast: "faster than you read",
  usable: "fine for chat, slow for long answers",
  slow: "a word every second or so",
};

/** "Qwen3 32B · 8-bit". */
export function pickTitle(p: Pick): string {
  return `${p.model.name} · ${QUANT_LABEL[p.quant].split(" ")[0]}`;
}

/** "fast, about 42 tokens/s (estimate)". */
export function speedText(p: Pick): string {
  const tps = p.tokensPerSec >= 10 ? Math.round(p.tokensPerSec) : Math.round(p.tokensPerSec * 10) / 10;
  return `${SPEED_LABEL[p.speed]}, about ${tps} tokens/s (estimate)`;
}

/**
 * Beside a speed estimate: when some part of the pick is timed at a GPU that Walkie's own runtime does not use there
 * (see `Placement.gpuSpeedOnly`), the speed needs a GPU build of llama.cpp that Walkie does not install. No host names:
 * the pick's own line names where it runs, so this stays safe in model-facing output.
 */
export function runtimeCaveat(p: { placement: readonly Placement[] }): string | null {
  if (!p.placement.some((x) => x.gpuSpeedOnly)) return null;
  return `assumes a GPU build of llama.cpp: Walkie's own runtime is counted as CPU only on ${p.placement.length === 1 ? "the machine it runs on" : "some of the machines it runs on"}`;
}

/** "me + lab", "rig (CPU)": a part that runs from system memory on the CPU says so. */
export function whereText(p: Pick): string {
  return p.placement.map((x) => (x.memory === CPU_MEMORY ? `${x.hostname} (CPU)` : x.hostname)).join(" + ");
}

/** What "if idle" means, for every surface that shows it (Walkie doesn't attribute memory to agents). */
export const IDLE_HINT = `if the machine were otherwise idle: only the OS and about ${IDLE_OS_BYTES / 1024 ** 3} GB of apps running`;

export function groupTitle(g: PoolGroup): string {
  if (g.kind === "local" && g.machines.length > 1) return `Local network · ${g.machines.length} machines`;
  if (g.kind === "local") return `${g.machines[0]?.hostname ?? "This machine"} (this machine)`;
  return g.machines[0]?.hostname ?? "?";
}

/**
 * What makes `a` rank above the pick it is offered next to: "Better" when it is rated (a quality ranking: only a rated model
 * can outrank anything), else what the unrated order is made of (release month, then size): "Newer", or "Larger" within a month.
 */
const rankWord = (a: CatalogModel, than: CatalogModel): string =>
  isRatedModel(a) ? "Better" : (a.released ?? "").slice(0, 7) > (than.released ?? "").slice(0, 7) ? "Newer" : "Larger";

/** The label of an alternative pick, the same on the dashboard and in `walkie pool`. "Better" means higher rated, not bigger. */
export function alternativeLabel(s: GroupSuggestion, a: Pick): string {
  if (a.fits && s.single?.placement[0]?.memory === CPU_MEMORY && a.placement[0]?.memory !== CPU_MEMORY && a.placement.length === 1) return "On the GPU";
  if (a.fits && s.single && compareModels(a.model, s.single.model) < 0) {
    const word = rankWord(a.model, s.single.model);
    return a.speed === "slow" ? `${word}, slow` : a.placement.some((x) => x.memory === CPU_MEMORY) ? `${word}, on CPU` : word;
  }
  return a.fits ? "Faster" : s.single || s.pooled ? "Next one up" : "Smallest";
}

/** "split across 5 machines", "on one machine". */
export function acrossText(p: Pick): string {
  return p.placement.length > 1 ? `split across ${p.placement.length} machines` : "on one machine";
}

/** "about 6.2 tokens/s". */
export function tpsText(tps: number): string {
  return `about ${tps >= 10 ? Math.round(tps) : Math.round(tps * 10) / 10} tokens/s`;
}

/**
 * Per token, in plain words: "12 ms compute + 128 ms network (4 round trips from alex-mac)"; says when a round trip
 * between two other machines was estimated through this one or not measured at all.
 */
export function perTokenText(p: CombinedPick): string {
  const n = p.hops.length;
  const via = p.hops.filter((h) => h.how === "via-this-machine").length;
  const unmeasured = p.hops.filter((h) => h.how === "unmeasured").length;
  const notes = [
    via ? `${via} estimated through this machine` : "",
    unmeasured ? `${unmeasured} not measured (${UNMEASURED_RTT_MS} ms assumed)` : "",
  ].filter(Boolean).join(", ");
  const network = n ? ` + ${Math.round(p.hopMs)} ms network (${n} round trip${n === 1 ? "" : "s"} from ${p.head.hostname}${notes ? `; ${notes}` : ""})` : "";
  return `${Math.round(p.computeMs)} ms compute${network} per token`;
}

/** "kira-mac 21 GB (unified memory)". */
export function placementText(pl: Placement): string {
  return `${pl.hostname} ${gbOf(pl.bytes)} GB (${pl.memory})`;
}

const gbOf = (b: number): string => (b / 1024 ** 3 >= 10 ? String(Math.round(b / 1024 ** 3)) : (Math.round((b / 1024 ** 3) * 10) / 10).toFixed(1));

/**
 * POOL-3: what a person is told before sharing their machine (CLI, dashboard switch, SECURITY.md). llama.cpp's RPC
 * server has had remote code execution bugs and one is open in the pinned build (docs/SECURITY.md "Split runs").
 */
export const SHARE_WARNING = "Sharing lets every non-observer teammate machine that heads a run send data to a program that has had code-execution bugs. Only share with people you trust with your computer.";

// ---- facts about a pick: maker, size, why it was chosen, where to read about it (LOCAL-MODELS-HF-1) ----

/** "27B", "3.6B": billions with one decimal below 10, whole above. */
const fmtB = (v: number): string => `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}B`;

/**
 * The size as people say it: the model name's own size when it agrees with the parameter count ("Qwen3.8-27B" is 27B
 * though its checkpoint holds 27.8B with the vision tower), else the count; a Mixture of Experts adds its active
 * parameters ("120B (5B active)"), a per-layer-embedding model its effective ones ("8B (4B effective)").
 */
export function sizeText(m: CatalogModel): string {
  const named = /(?<![A-Za-z0-9.])(\d+(?:\.\d+)?)[Bb](?![A-Za-z0-9])/.exec(m.name);
  const v = named ? Number(named[1]) : NaN;
  const total = Number.isFinite(v) && v >= m.params_b * 0.8 && v <= m.params_b * 1.2 ? `${named![1]}B` : fmtB(m.params_b);
  if (m.active_b === null) return total;
  return `${total} (${fmtB(m.active_b)} ${/(?:^|[-_.])E\d+(?:\.\d+)?B(?:[-_.]|$)/.test(m.name) ? "effective" : "active"})`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const releasedText = (m: CatalogModel): string | null => {
  const [y, mo] = (m.released ?? "").split("-");
  return y && mo && MONTHS[Number(mo) - 1] ? `${MONTHS[Number(mo) - 1]} ${y}` : null;
};

const scoreText = (v: number): string => String(v >= 10 ? Math.round(v) : Math.round(v * 10) / 10);

/** One plain sentence: why this model ranks where it does. */
export function reasonText(m: CatalogModel, cat: Catalog): string {
  const q = m.quality;
  const place = ratedPlace(cat, m);
  const top = Object.entries(q?.scores ?? {}).slice(0, 3).map(([k, v]) => `${k} ${scoreText(v)}`).join(", ");
  if (place) return `Rated #${place.place} of ${place.of} on Hugging Face benchmark results${top ? ` (${top})` : ""} in the current list (rated models only; self-reported benchmarks)`;
  const by = releasedText(m) ? `release date (${releasedText(m)}) and size` : "size";
  const n = Object.keys(q?.scores ?? {}).length;
  // Three admitted results are needed AND enough other models reporting the same benchmarks to compare against.
  if (n >= MIN_RESULTS) return `Not rated: its ${n} published results${top ? ` (${top})` : ""} cannot be compared fairly because too few other models report the same benchmarks; ranked within the current list by ${by}`;
  return `Not enough published benchmark results to rate (${n} of ${MIN_RESULTS} needed${top ? `: ${top}` : ""}; they are self-reported); ranked within the current list by ${by}`;
}

/** Whether a model has a rating: only then does "best" mean quality. */
export const isRatedModel = (m: CatalogModel): boolean => m.quality?.basis === "rated";

/** "Best" is a quality ranking; a model nobody could rate is only the newest that fits (compareModels: release month, size, adoption). */
export const bestLabel = (m: CatalogModel): string => (isRatedModel(m) ? "Best" : "Newest");
export const overallLabel = (m: CatalogModel): string => (isRatedModel(m) ? "Best overall" : "Newest overall");

/** Said at the top of every view of a list in which nothing is rated, so "best" is not read as quality. */
export const NO_RATING_NOTE = "No model here has enough published benchmark results to rate; showing the newest that fits, not the highest quality";
export const ratedCount = (cat: Catalog): number => cat.models.filter(isRatedModel).length;
export const rankingNote = (cat: Catalog): string | null => (ratedCount(cat) === 0 ? NO_RATING_NOTE : null);

/** Maker, size and the ranking within the current list, with self-reported benchmark numbers. */
export const modelFacts = (m: CatalogModel, cat: Catalog): string => `${m.maker} · ${sizeText(m)} · ${reasonText(m, cat)}`;

/** The model's Hugging Face page (validated https URL built from its repository id). */
export const hfUrl = (m: CatalogModel): string => m.source;

/**
 * Only models in Walkie's pinned list (gguf.json, one entry per built-in model) can be started by `walkie pool run`. A model
 * of a live list counts only when it is that built-in model: the same id from another Hugging Face repository is not.
 */
export const isStartable = (m: { id: string; source: string }): boolean => CATALOG.models.some((b) => b.id === m.id && b.source === m.source);

export const PINNED_NOTE = `walkie pool run starts only the models in Walkie's pinned list (${CATALOG.models.length} models, each checked against a sha256); for any other pick, download its GGUF file from Hugging Face and start it with: walkie pool run --file <path>.gguf`;

/** What the model list is and where it came from, for the header of `walkie pool` and the dashboard. */
export function listText(v: { source: "huggingface" | "built-in"; checkedAt: number | null; catalog: Catalog }): string {
  const scope = "Best and rankings refer only to the current list, not all Hub models";
  if (v.source === "huggingface") {
    const read = v.checkedAt === null ? "read time unknown" : `read ${new Date(v.checkedAt).toISOString().slice(0, 16).replace("T", " ")} UTC`;
    return `Models from Hugging Face, ${read} (${v.catalog.models.length} models). Bounded discovery from download and trending lists, ordered by downloads: up to ${PRE_CANDIDATES} candidates, ${MAX_ORG_LOOKUPS} maker lookups and ${MAX_BASES} base models; fewer may be examined. ${scope}`;
  }
  return `Built-in list (v${v.catalog.version}, updated ${v.catalog.updated}). ${scope}`;
}

/** What "best overall" means in words. */
export const HOW_TEXT: Record<"machine" | "group" | "team", string> = {
  machine: "on one machine",
  group: "split across machines on one network",
  team: "split across all the team's machines",
};
