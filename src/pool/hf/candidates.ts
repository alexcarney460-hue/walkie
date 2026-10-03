// Which Hub models are candidates for "what could we run": quantization repositories collapse to their base model, and
// the base must be a current, original, chat-capable release from an established maker. Pure: no network.
// docs/plans/LOCAL-MODELS-HF-1.md "Candidates".
import type { BaseModels, ListItem } from "./schemas.ts";
import type { RepoRef } from "./ggufs.ts";

/** An organisation (not a person's account) with at least this many followers is an established maker. */
export const MIN_FOLLOWERS = 1000;
/** Models older than this many months are not current. */
export const CURRENT_MONTHS = 16;
/** Pipeline tags of chat-capable models (multimodal ones chat too; their GGUF text model is what is sized). */
export const CHAT_PIPELINES: ReadonlySet<string> = new Set(["text-generation", "image-text-to-text", "any-to-any"]);

export type Skip =
  | "not_established" | "derivative" | "not_chat" | "checkpoint" | "old" | "unavailable" | "bad_params"
  | "no_config" | "bad_config" | "no_gguf" | "gguf_mismatch" | "no_active" | "duplicate_id" | "invalid_model" | "budget" | "error";

export interface BaseGroup {
  base: string;
  /** Repositories that name the base as the model they quantize. */
  repos: RepoRef[];
  /** The maker's own `<name>-GGUF` repositories that carry no base_model tag. */
  own: RepoRef[];
  /** 30-day downloads of all of them: how much people run it locally. */
  downloads: number;
  /**
   * The earliest creation date among those repositories (ISO), when any has one. A model cannot be newer than its own
   * quantizations, so a base whose earliest one is older than the "current" cutoff is old without being looked up.
   */
  first?: string;
}

/** Base models behind a list of GGUF repositories (repeats across lists count once). */
export function collapse(items: readonly ListItem[]): Map<string, BaseGroup> {
  const out = new Map<string, BaseGroup>();
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const bm = item.baseModels;
    const named = bm?.relation === "quantized" ? bm.models[0]?.id : undefined;
    let base: string | undefined;
    let own = false;
    if (named) base = named;
    else if (!bm?.models.length) {
      const [owner, name] = item.id.split("/") as [string, string];
      if (/-gguf$/i.test(name) && name.length > 5) { base = `${owner}/${name.slice(0, -5)}`; own = true; }
    }
    if (!base) continue;
    const g = out.get(base) ?? { base, repos: [], own: [], downloads: 0 };
    const ref: RepoRef = { id: item.id, downloads: item.downloads ?? 0 };
    (own ? g.own : g.repos).push(ref);
    g.downloads += ref.downloads;
    if (item.createdAt && Number.isFinite(Date.parse(item.createdAt)) && (g.first === undefined || Date.parse(item.createdAt) < Date.parse(g.first))) g.first = item.createdAt;
    out.set(base, g);
  }
  return out;
}

export const isEstablished = (org: { readonly numFollowers: number; readonly name?: string } | null): boolean => !!org && org.numFollowers >= MIN_FOLLOWERS;

/** No base model, or only bases by the same author (the Hub's owner names are case-insensitive). */
export function isOriginal(base: BaseModels | undefined, owner: string): boolean {
  return (base?.models ?? []).every((m) => m.id.split("/")[0]!.toLowerCase() === owner.toLowerCase());
}

/**
 * A base whose name continues another maker's model name ("gemma-4-31B-it-scotoma-2" by ReadyArt after Google's
 * "gemma-4-31B-it") is that model's fine-tune, whatever its metadata says (many carry no base_model). `all` are the
 * base ids seen; the Hub's names are compared case-insensitively.
 */
export function continuesAnother(base: string, all: readonly string[]): boolean {
  const [owner, name] = base.toLowerCase().split("/") as [string, string];
  return all.some((other) => {
    const [o, n] = other.toLowerCase().split("/") as [string, string];
    return o !== owner && n.length >= 6 && name.startsWith(`${n}-`);
  });
}

/**
 * Not the chat model people run, by its name: a pre-trained checkpoint, a quantised copy, a speculative-decoding drafter
 * (Liquid AI's `LFM2.5-2.6B-DSpark` is a 0.33B drafter that no `base_model` rule catches, being its own maker's
 * fine-tune), or a text-diffusion model (its speed is not "the active weights once per token").
 */
export function nameIsCheckpoint(name: string): boolean {
  return /(?:^|[-_.])(?:base|pt|pretrain(?:ed)?)(?:[-_.]|$)/i.test(name)
    || /(?:^|[-_.])(?:qat|unquantized|gguf|awq|gptq|bnb|mlx|int4|int8|fp8|fp4|nvfp4|w4a16|w8a8|4bit|8bit)(?:[-_.]|$)/i.test(name)
    || /(?:^|[-_.])(?:draft|drafter|dflash|dspark|speculator)(?:[-_.]|$)/i.test(name)
    || /diffusion/i.test(name);
}

/**
 * The same, by the Hub's own tags (read with the record, for a drafter or a diffusion model whose name does not say so):
 * `draft-model` / `speculative-decoding`, or an architecture tag naming diffusion (`diffusion_gemma`; `diffusers` is the
 * image library and has no chat pipeline anyway).
 */
export function isNotPlainChat(tags: readonly string[] | undefined): boolean {
  return (tags ?? []).some((t) => /^(?:draft-model|speculative-decoding)$/i.test(t) || /diffusion/i.test(t));
}

export function isCurrent(createdAt: string, now: Date, months: number = CURRENT_MONTHS): boolean {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return false;
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return t >= cutoff.getTime();
}

/** A catalog id from a repository name: lower case, `[a-z0-9.-]`, at most 48 characters; null when nothing is left. */
export function idFor(name: string): string | null {
  const id = name.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
  return /^[a-z0-9][a-z0-9.-]{1,47}$/.test(id) ? id : null;
}

/** The licence a model declares in its tags (`license:apache-2.0`), cut down to plain characters. */
export function licenseOf(tags: readonly string[] | undefined): string {
  const tag = tags?.find((t) => t.startsWith("license:"));
  const text = (tag ?? "").slice("license:".length).replace(/[^A-Za-z0-9 ._:+-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return text.length >= 2 ? text : "see the model card";
}
