// A machine's memory bar and temperature readout (sidebar machines list, Team page). Values are what the machine last
// published (PROTOCOL §3 "Machine stats"); an offline machine's are greyed as last known, a missing reading is "n/a".
import type { NodeView } from "../api/types.ts";
import type { MachineStats } from "../../../src/protocol/machine-stats.ts";
import { gb, memText, tempLevel, tempText } from "../../../src/protocol/machine-stats-format.ts";
import { agoLong, useNow } from "../lib/time.ts";

type Level = "normal" | "warn" | "critical";
const PRESSURE_LABEL: Record<Level, string> = { normal: "normal", warn: "elevated", critical: "critical" };

/** Tooltip: memory, swap, pressure, temperature and when the values were sampled. */
export function statsTitle(hostname: string, stats: MachineStats | undefined, online: boolean, now: number): string {
  if (!stats) return `${hostname}: no memory or temperature reported (turned off, or an older Walkie)`;
  const m = stats.mem;
  const lines = [
    m ? `Memory ${gb(m.used)} of ${gb(m.total)} GB used${m.pressure ? ` · pressure ${PRESSURE_LABEL[m.pressure]}` : ""}` : "Memory n/a",
    m ? `Swap ${gb(m.swap_used)} GB used` : null,
    `Temperature ${stats.temp_c === null ? "n/a" : `${stats.temp_c.toFixed(1)} °C (${tempSourceLong(stats)})`}`,
    stats.temp_zones?.length ? `Windows thermal zones: ${stats.temp_zones.map((z) => `${z.name} ${Math.round(z.c)} °C`).join(", ")}` : null,
    stats.gpu_temp?.some((t) => t !== null) && stats.temp_src !== "gpu"
      ? `GPU ${stats.gpu_temp.map((t) => (t === null ? "n/a" : `${Math.round(t)} °C`)).join(", ")}` : null,
    online ? `Updated ${agoLong(stats.at, now)}` : `Last known (machine offline), sampled ${agoLong(stats.at, now)}`,
    stats.discovery?.incomplete ? `Agent discovery incomplete: ${stats.discovery.unreported} running session(s) not examined in the last scan keep their last status` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

/** "CPU" or "GPU": where the machine temperature came from (older daemons report CPU/board sensors only). */
export function tempSource(stats: Pick<MachineStats, "temp_src"> | undefined): "CPU" | "GPU" {
  return stats?.temp_src === "gpu" ? "GPU" : "CPU";
}

/** The source in words, for tooltips and the machine page. */
export function tempSourceLong(stats: Pick<MachineStats, "temp_src" | "temp_zones" | "temp_route">): string {
  if (stats.temp_src === "gpu") return "GPU; no CPU or board sensor";
  if (!stats.temp_zones?.length) return "hottest CPU/board sensor";
  return `hottest Windows thermal zone, CPU/board${stats.temp_route === "session" ? ", read through another WSL session" : ""}`;
}

function levelClass(level: Level | null | undefined): string {
  return level ? `ms-lv-${level}` : "ms-lv-none";
}

function MemBar({ mem, compact }: { mem: MachineStats["mem"] | undefined; compact?: boolean }) {
  if (!mem) return <span className="ms-mem ms-lv-none"><span className="ms-na">{compact ? "mem n/a" : "n/a"}</span></span>;
  const pct = mem.total > 0 ? Math.min(100, Math.max(0, (mem.used / mem.total) * 100)) : 0;
  return (
    <span className={`ms-mem ${levelClass(mem.pressure)}`}>
      <span className="ms-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}
        aria-label={`Memory ${gb(mem.used)} of ${gb(mem.total)} GB used${mem.pressure ? `, pressure ${PRESSURE_LABEL[mem.pressure]}` : ""}`}>
        <span className="ms-fill" style={{ width: `${pct.toFixed(1)}%` }} />
      </span>
      <span className="ms-text tnum">{memText(mem)}</span>
    </span>
  );
}

function TempReadout({ stats }: { stats: MachineStats | undefined }) {
  const c = stats?.temp_c;
  const level = tempLevel(c ?? null);
  return (
    <span className={`ms-temp tnum ${levelClass(level)}`}>
      {c === null || c === undefined ? <span className="ms-na">temp n/a</span>
        : <>{tempText(c)} <span className="ms-src" data-testid="temp-src">{tempSource(stats)}</span></>}
    </span>
  );
}

/**
 * Memory bar and/or temperature for one machine, with the tooltip (swap, pressure, last updated) and greyed values
 * while it is offline. `rail`: a sidebar row; `cell`: a line under the machine name in the Team table.
 */
export function MachineStatsLine({ node, part = "rail" }: { node: NodeView; part?: "rail" | "cell" }) {
  const now = useNow();
  return (
    <span className={`ms ms-${part}${node.online ? "" : " ms-stale"}`} title={statsTitle(node.hostname, node.stats, node.online, now)}>
      <MemBar mem={node.stats?.mem} compact />
      <TempReadout stats={node.stats} />
      {node.stats?.discovery?.incomplete && <span className="ms-disc" data-testid="discovery-incomplete">discovery incomplete</span>}
      {!node.online && node.stats && <span className="sr-only"> (last known, machine offline)</span>}
    </span>
  );
}
