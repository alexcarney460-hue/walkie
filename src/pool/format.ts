// Plain-language labels for local-model suggestions, shared by `walkie pool` and the dashboard (no zod here).
import { CPU_MEMORY, IDLE_OS_BYTES } from "./capacity.ts";
import { QUANT_LABEL } from "./catalog.ts";
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

/** The label of an alternative pick, the same on the dashboard and in `walkie pool`. */
export function alternativeLabel(s: GroupSuggestion, a: Pick): string {
  return a.fits ? "Faster" : s.single || s.pooled ? "Next size up" : "Smallest";
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
