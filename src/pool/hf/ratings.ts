// Re-rating the list built into Walkie (scripts/refresh-pool-catalog.ts --ratings-only). Pure: no network, no files.
//
// The built-in models.json and gguf.json are generated together, but the rating rules (quality.ts, RATING_RULES) can
// change without any model or download pin changing. This takes the current list and a fresh quality for each model (read
// from Hugging Face with the same pipeline, in one fit) and returns the same list with ONLY each model's `quality`
// replaced (and the list's own version, date and origin). Every other field, the models' order and gguf.json are as
// they were: a download pin is a sha256 a person checked, not something a rating run may move.
import type { Catalog, CatalogModel, ModelQuality } from "../catalog.ts";
import { RATING_RULES } from "./quality.ts";

export interface RatingChange {
  id: string;
  /** "rated 0.791 (5 results)", "unrated (2 results)", "unrated (not read)". */
  before: string;
  after: string;
}

export interface RerateResult {
  catalog: Catalog;
  changes: RatingChange[];
  /** Models whose repository could not be read: they are left unrated, never kept on the old rules. */
  unread: string[];
}

export const repoOf = (m: CatalogModel): string => m.source.replace("https://huggingface.co/", "");

const describe = (q: ModelQuality | undefined): string => {
  const n = Object.keys(q?.scores ?? {}).length;
  const results = `${n} result${n === 1 ? "" : "s"}`;
  if (!q) return "no quality";
  return q.basis === "rated" ? `rated ${q.score} (${results})` : `unrated (${results})`;
};

/** An unread model has no evidence under the current rules: unrated, no scores, stamped with them. */
const UNREAD: ModelQuality = { basis: "unrated", rules: RATING_RULES };

export function rerate(current: Catalog, fresh: (repo: string) => ModelQuality | undefined, now: Date): RerateResult {
  const changes: RatingChange[] = [];
  const unread: string[] = [];
  const models = current.models.map((m): CatalogModel => {
    const q = fresh(repoOf(m));
    if (!q) unread.push(m.id);
    const quality = q ?? UNREAD;
    changes.push({ id: m.id, before: describe(m.quality), after: q ? describe(q) : "unrated (not read)" });
    return { ...m, quality };
  });
  return {
    catalog: { ...current, version: current.version + 1, updated: now.toISOString().slice(0, 10), origin: { kind: "built-in", at: now.toISOString() }, models },
    changes, unread,
  };
}
