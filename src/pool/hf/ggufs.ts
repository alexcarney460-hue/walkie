// Sizing a model from the GGUF files of a quantization repository: the 4-bit file (Q4_K_M, Unsloth's dynamic UD-Q4_K_M, or
// a native MXFP4 release) and the 8-bit one (Q8_0), split files summed and checked complete, side files (draft models,
// vision projectors, importance matrices) left out. The sizes are the Hub's file sizes, so memory is measured, not
// estimated. Pure: no network. docs/plans/LOCAL-MODELS-HF-1.md "Candidates" 6.

/** Quantizers whose repositories may size (or, in the built-in list, pin) a model besides the maker's own. */
export const TRUSTED_QUANTIZERS = ["unsloth", "bartowski", "lmstudio-community", "ggml-org"] as const;
/** At most this many repositories are looked into per model. */
export const MAX_REPOS = 3;

/** An entry of `siblings` in `/api/models/<repo>?blobs=true`. */
export interface Sibling { rfilename: string; size?: number; lfs?: { sha256?: string; size?: number } }
export interface GgufFile { path: string; size: number; sha256: string | null }
export type QuantKind = "Q4_K_M" | "UD-Q4_K_M" | "MXFP4" | "Q8_0";
export interface QuantFiles { kind: QuantKind; files: GgufFile[]; bytes: number }
export interface Quants { q4: QuantFiles | null; q8: QuantFiles | null }

/** The path rule the pinned list (src/pool/run/gguf.ts) applies, so a file found here can be pinned there. */
const SAFE_PATH = /^[\w.-]+(?:\/[\w.-]+)*\.gguf$/;
const MAX_FILE_BYTES = 2e12;
const SIDE_FILE = /^(?:mtp|dflash|eagle\d*|mmproj|imatrix|draft)(?:[-_.]|$)/i;
const SIDE_DIR = /(?:^|\/)(?:mtp|draft|mmproj)\//i;
const SHARD = /^(.*)-(\d{5})-of-(\d{5})$/;

function kindOf(stem: string): QuantKind | null {
  if (/(?:^|[-_.])UD-Q4_K_M$/i.test(stem)) return "UD-Q4_K_M";
  if (/(?:^|[-_.])Q4_K_M$/i.test(stem)) return "Q4_K_M";
  if (/(?:^|[-_.])MXFP4(?:_MOE)?$/i.test(stem)) return "MXFP4";
  if (/(?:^|[-_.])Q8_0$/i.test(stem)) return "Q8_0";
  return null;
}

interface Shard { index: number; total: number; file: GgufFile }

function groups(siblings: readonly Sibling[]): Map<string, { kind: QuantKind; shards: Shard[] }> {
  const out = new Map<string, { kind: QuantKind; shards: Shard[] }>();
  for (const s of siblings) {
    const path = s.rfilename;
    if (typeof path !== "string" || path.length > 300 || !SAFE_PATH.test(path) || path.split("/").includes("..")) continue;
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (SIDE_FILE.test(name) || SIDE_DIR.test(path)) continue;
    const base = name.slice(0, -".gguf".length);
    const sh = SHARD.exec(base);
    const stem = sh ? sh[1]! : base;
    const kind = kindOf(stem);
    if (!kind) continue;
    const size = s.size ?? s.lfs?.size;
    if (typeof size !== "number" || !Number.isInteger(size) || size <= 0 || size > MAX_FILE_BYTES) continue;
    const sha = s.lfs?.sha256;
    const file: GgufFile = { path, size, sha256: typeof sha === "string" && /^[0-9a-f]{64}$/.test(sha) ? sha : null };
    const key = `${dir}\0${stem}\0${kind}`;
    const g = out.get(key) ?? { kind, shards: [] };
    g.shards.push({ index: sh ? Number(sh[2]) : 1, total: sh ? Number(sh[3]) : 1, file });
    out.set(key, g);
  }
  return out;
}

/** The shards of a group in order when they are all there exactly once, else null. */
function complete(shards: Shard[]): QuantFiles["files"] | null {
  const total = shards[0]!.total;
  if (shards.some((s) => s.total !== total) || shards.length !== total) return null;
  const sorted = [...shards].sort((a, b) => a.index - b.index);
  return sorted.every((s, i) => s.index === i + 1) ? sorted.map((s) => s.file) : null;
}

function best(found: readonly { kind: QuantKind; files: GgufFile[] }[], order: readonly QuantKind[]): QuantFiles | null {
  for (const kind of order) {
    const hit = found.filter((f) => f.kind === kind).sort((a, b) => a.files[0]!.path.localeCompare(b.files[0]!.path))[0];
    if (hit) return { kind, files: hit.files, bytes: hit.files.reduce((s, f) => s + f.size, 0) };
  }
  return null;
}

/** The 4-bit and 8-bit files of a repository, or null for a format it does not have in full. */
export function pickQuants(siblings: readonly Sibling[]): Quants {
  const found: { kind: QuantKind; files: GgufFile[] }[] = [];
  for (const g of groups(siblings).values()) {
    const files = complete(g.shards);
    if (files) found.push({ kind: g.kind, files });
  }
  return { q4: best(found, ["Q4_K_M", "UD-Q4_K_M", "MXFP4"]), q8: best(found, ["Q8_0"]) };
}

export interface RepoRef { id: string; downloads: number }

const REPO = /^[\w.-]+\/[\w.-]+$/;

/**
 * Which repositories may size a model, best first: the base model's own maker and the trusted quantizers, by 30-day
 * downloads, at most MAX_REPOS. Every other account's copy is skipped: an "uncensored" or special-format upload that
 * names the model as its base is not the model. `extras` are repositories found some other way (a maker's own
 * `<name>-GGUF` that carries no base_model tag).
 */
export function orderRepos(baseOwner: string, quants: readonly RepoRef[], extras: readonly RepoRef[]): string[] {
  const trusted = new Set<string>([baseOwner.toLowerCase(), ...TRUSTED_QUANTIZERS]);
  const seen = new Set<string>();
  const out: RepoRef[] = [];
  for (const r of [...quants, ...extras]) {
    if (!REPO.test(r.id) || seen.has(r.id) || !trusted.has(r.id.split("/")[0]!.toLowerCase())) continue;
    seen.add(r.id);
    out.push(r);
  }
  // A repository that carries multi-token-prediction heads ("-MTP-") is tried after the plain ones: the pinned runtime
  // should load an ordinary file first (the heads are extra tensors for speculative decoding, not needed to chat).
  const mtp = (r: RepoRef): number => (/(?:^|[-_.])mtp(?:[-_.]|$)/i.test(r.id.split("/")[1]!) ? 1 : 0);
  return out.sort((a, b) => mtp(a) - mtp(b) || b.downloads - a.downloads || a.id.localeCompare(b.id)).slice(0, MAX_REPOS).map((r) => r.id);
}
