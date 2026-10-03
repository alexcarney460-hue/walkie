// The model list a report or the dashboard ranks from, and where it came from. Types only, no imports of node modules:
// the dashboard bundle imports this (src/pool/hf/source.ts, which reads and writes the cache, stays on the daemon side).
import type { Catalog } from "../catalog.ts";

export interface ModelsView {
  catalog: Catalog;
  source: "huggingface" | "built-in";
  /** "fresh": read within a day; "stale": an older Hugging Face list kept; "built-in": the list shipped with Walkie. */
  state: "fresh" | "stale" | "built-in";
  /** When the Hugging Face list was read (ms epoch); null for the built-in list. */
  checkedAt: number | null;
  /** Why this list and not a fresher one; null when nothing went wrong. */
  note: string | null;
  stats?: { requests: number; models: number; skipped: Record<string, number> };
}
