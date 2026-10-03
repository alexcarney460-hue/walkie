// "Best" is quality: Hugging Face evaluation results (self-reported benchmark scores in `.eval_results`) combined into one
// ability per model. Pure: no network. docs/plans/LOCAL-MODELS-HF-1.md "Best = quality, justified".
//
// A model is RATED when it has three or more admitted, varying benchmarks. The scores are combined by a one-factor fit:
// benchmark b says `value = c_b + s_b x ability`, every model has one ability, and the lines and the abilities are fitted
// together (alternating least squares) over the rated models. A benchmark that only strong models report, or one that
// is simply harder, gets its own line instead of unfairly lifting or sinking the models that report it, which averaging
// z-scores cannot do. Each ability starts from a prior of 0 (the average rated model) and moves toward what its results
// say, more with more results; the score ranked on is the ability minus half its standard error, so a model with few
// results does not beat one with many at the same strength. Everything else is unrated.
import type { ModelQuality } from "../catalog.ts";

export interface Benchmark { id: string; label: string }

/**
 * The benchmarks that count, a fixed and reviewable list (text models: knowledge, reasoning, coding, agents, maths,
 * instruction following). Any other dataset id in a model's results is ignored, so a hostile or odd entry cannot add a
 * benchmark. New official benchmarks need a line here.
 */
export const BENCHMARKS: readonly Benchmark[] = [
  { id: "TIGER-Lab/MMLU-Pro", label: "MMLU-Pro" },
  { id: "Idavidrein/gpqa", label: "GPQA" },
  { id: "cais/hle", label: "HLE" },
  { id: "SWE-bench/SWE-bench_Verified", label: "SWE-bench Verified" },
  { id: "ScaleAI/SWE-bench_Pro", label: "SWE-bench Pro" },
  { id: "harborframework/terminal-bench-2.1", label: "Terminal-Bench 2.1" },
  { id: "MathArena/aime_2026", label: "AIME 2026" },
  { id: "MathArena/hmmt_feb_2026", label: "HMMT Feb 2026" },
  { id: "LiquidAI/ifstruct-v1.0", label: "IFStruct" },
];
const LABEL = new Map(BENCHMARKS.map((b) => [b.id, b.label]));

/**
 * The admission rules a stored quality was produced under, stamped on every `quality` the pipeline writes so a stored one
 * (the built-in models.json, a cache file) can be checked offline against the rules in force. Bump it with any change to
 * what is admitted or rated (the minimum results, which duplicate counts, which results are ignored), then regenerate the
 * built-in ratings (scripts/refresh-pool-catalog.ts --ratings-only): a test fails until the stamps agree.
 *   1  two results are enough, the highest duplicate counts, results from Hub pull requests are admitted
 *   2  three results, the lowest duplicate, values in (1, 100], no result attached to a Hub pull request
 */
export const RATING_RULES = 2;

/** Results needed to be rated, and models that must report a benchmark for it to count. */
export const MIN_RESULTS = 3;
export const MIN_REPORTERS = 6;
/** Noise floor of a benchmark, in units of ability (a single benchmark never measures general ability better than this). */
const TAU_MIN = 0.45;
/** How many standard errors are taken off an ability. */
const CAUTION = 0.5;
const ITERATIONS = 40;

export interface BenchmarkResult {
  dataset: string;
  value: number;
  verified?: boolean;
  pullRequest?: number;
}

const percentage = (v: number): boolean => Number.isFinite(v) && v > 1 && v <= 100;

/**
 * Conservative self-report policy, not verification of model quality:
 * - PR-associated entries are excluded: the available record has no merge status.
 * - Missing/false verification is accepted as self-reporting, never treated as verified.
 * - Only (1, 100] is admitted; [0, 1] has ambiguous fraction/percentage units. Do not guess or multiply by 100.
 * - Use the minimum eligible duplicate, so repetition or a high duplicate cannot improve a rating.
 * This loses legitimate low percentages and merged-PR results, and can understate conflicting reports.
 */
export function benchmarkValues(rows: Iterable<BenchmarkResult>): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!LABEL.has(r.dataset) || !percentage(r.value) || r.pullRequest !== undefined) continue;
    if (r.verified !== undefined && typeof r.verified !== "boolean") continue;
    const have = out.get(r.dataset);
    if (have === undefined || r.value < have) out.set(r.dataset, r.value);
  }
  return out;
}

export interface Fit { scores: Map<string, number>; benchmarks: string[] }

const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
const sd = (xs: readonly number[]): number => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));

export function rateModels(obs: ReadonlyMap<string, ReadonlyMap<string, number>>, opts: { minResults?: number; minReporters?: number } = {}): Fit {
  const minResults = opts.minResults ?? MIN_RESULTS;
  const minReporters = opts.minReporters ?? MIN_REPORTERS;
  const empty = (): Fit => ({ scores: new Map(), benchmarks: [] });
  if (!Number.isInteger(minResults) || minResults < 2 || !Number.isInteger(minReporters) || minReporters < 3) return empty();
  // Validate direct callers too; only admitted percentages on known benchmarks inform the fit.
  const admitted = new Map([...obs].map(([m, row]) => [m, new Map([...row].filter(([b, v]) => LABEL.has(b) && percentage(v)))]));
  // Prune to a fixed point: removing a model can make a benchmark sparse or constant, and vice versa.
  let models = [...admitted.keys()].filter((m) => admitted.get(m)!.size >= minResults).sort();
  let benches: string[] = [];
  while (true) {
    const reporters = new Map<string, number[]>();
    for (const m of models) for (const [b, v] of admitted.get(m)!) {
      const values = reporters.get(b) ?? [];
      reporters.set(b, [...values, v]);
    }
    const next = [...reporters].filter(([, vs]) => vs.length >= minReporters && sd(vs) > 1e-6).map(([b]) => b).sort();
    const keep = models.filter((m) => [...admitted.get(m)!.keys()].filter((b) => next.includes(b)).length >= minResults);
    if (next.length === benches.length && keep.length === models.length) { benches = next; break; }
    benches = next;
    models = keep;
  }
  if (benches.length < 2 || models.length < 3) return { scores: new Map(), benchmarks: [] };

  // values[i]: model i's results as (benchmark index, value).
  const values: { j: number; v: number }[][] = models.map((m) => benches.flatMap((b, j) => { const v = admitted.get(m)!.get(b); return v === undefined ? [] : [{ j, v }]; }));

  // Start from the average z-score of each model's results.
  const byBench = benches.map((_, j) => values.flatMap((r, i) => r.filter((x) => x.j === j).map((x) => ({ i, v: x.v }))));
  const mu = byBench.map((xs) => mean(xs.map((x) => x.v)));
  const sg = byBench.map((xs) => Math.max(sd(xs.map((x) => x.v)), 1));
  let theta = values.map((r) => mean(r.map((x) => (x.v - mu[x.j]!) / sg[x.j]!)));
  let se = values.map(() => 1);
  const c = [...mu];
  const s = [...sg];
  const sigma = benches.map(() => 1);

  for (let it = 0; it < ITERATIONS; it++) {
    // Each benchmark's line: a least-squares fit of its values on the current abilities.
    byBench.forEach((xs, j) => {
      const xt = xs.map((x) => theta[x.i]!);
      const mx = mean(xt);
      const my = mean(xs.map((x) => x.v));
      const vx = xt.reduce((a, x) => a + (x - mx) ** 2, 0);
      const slope = vx > 1e-9 ? xs.reduce((a, x, k) => a + (xt[k]! - mx) * (x.v - my), 0) / vx : 1;
      s[j] = Math.max(slope, 0.05 * sg[j]!);
      c[j] = my - s[j]! * mx;
      const resid = xs.reduce((a, x, k) => a + (x.v - c[j]! - s[j]! * xt[k]!) ** 2, 0) / Math.max(xs.length - 2, 1);
      sigma[j] = Math.max(Math.sqrt(resid), TAU_MIN * s[j]!);
    });
    // Each model's ability: a prior of 0 (variance 1) and what each of its results implies, weighted by its precision.
    const next = values.map((r) => {
      let prec = 1;
      let num = 0;
      for (const x of r) {
        const w = (s[x.j]! / sigma[x.j]!) ** 2;
        prec += w;
        num += w * ((x.v - c[x.j]!) / s[x.j]!);
      }
      return { t: num / prec, se: 1 / Math.sqrt(prec) };
    });
    const m0 = mean(next.map((x) => x.t));
    const s0 = sd(next.map((x) => x.t));
    // No distinguishable ability: do not turn a zero spread into an enormous uncertainty penalty.
    if (!Number.isFinite(s0) || s0 <= 1e-6) return empty();
    theta = next.map((x) => (x.t - m0) / s0);
    se = next.map((x) => x.se / s0);
  }
  const scores = new Map<string, number>();
  models.forEach((m, i) => {
    const score = theta[i]! - CAUTION * se[i]!;
    // Outside the catalog's representable range is unrated, not a fabricated clamped rating.
    if (Number.isFinite(score) && Math.abs(score) <= 20) scores.set(m, score);
  });
  return { scores, benchmarks: benches };
}

/** A model's quality for the catalog: rated with its score and values by label, or unrated with what it has. */
export function qualityOf(values: ReadonlyMap<string, number>, score: number | undefined): ModelQuality {
  const scores: Record<string, number> = {};
  for (const b of BENCHMARKS) {
    const v = values.get(b.id);
    if (v !== undefined && percentage(v)) scores[b.label] = Math.round(v * 10) / 10;
  }
  const has = Object.keys(scores).length > 0;
  return score === undefined || !Number.isFinite(score) || Math.abs(score) > 20
    ? { basis: "unrated", ...(has ? { scores } : {}), rules: RATING_RULES }
    : { basis: "rated", score: Math.round(score * 1000) / 1000, scores, rules: RATING_RULES };
}
