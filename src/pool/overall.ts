// "The single best overall": the best rated model the team could run, whether on one machine alone, split across the
// machines of one local network, or across all online machines together. Pure; dashboard and CLI.
import { compareModels } from "./catalog.ts";
import type { CombinedSuggestion } from "./combined.ts";
import type { Pick, TeamSuggestion } from "./suggest.ts";

export interface Overall {
  pick: Pick;
  /** "machine": one machine alone; "group": split across machines on one network; "team": across all online machines. */
  how: "machine" | "group" | "team";
}

const HOW_RANK: Record<Overall["how"], number> = { machine: 0, group: 1, team: 2 };

export function bestOverall(t: TeamSuggestion, cs: CombinedSuggestion | null): Overall | null {
  const all: Overall[] = [];
  for (const m of t.machines) if (m.best) all.push({ pick: m.best, how: "machine" });
  for (const s of t.suggestions) if (s.pooled) all.push({ pick: s.pooled, how: "group" });
  if (cs?.pick) all.push({ pick: cs.pick, how: cs.pick.pooled ? "team" : "machine" });
  // The best rated model; the same model: the faster run, then the simpler way (one machine before a split).
  return all.sort((a, b) => compareModels(a.pick.model, b.pick.model) || b.pick.tokensPerSec - a.pick.tokensPerSec || HOW_RANK[a.how] - HOW_RANK[b.how])[0] ?? null;
}
