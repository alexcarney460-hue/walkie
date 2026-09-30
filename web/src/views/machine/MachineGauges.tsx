// The machine page's live stats: soft ring gauges for memory, CPU load and temperature, plus the accelerator card.
// Values are what the machine last published (PROTOCOL §3 "Machine stats"); an offline machine's are greyed as last
// known. Disk is not reported by the daemon, so there is no disk card.
import { Cpu, MemoryStick, Thermometer, Zap } from "lucide-react";
import type { ReactNode } from "react";
import type { NodeView } from "../../api/types.ts";
import type { MachineStats } from "../../../../src/protocol/machine-stats.ts";
import { gb, tempLevel } from "../../../../src/protocol/machine-stats-format.ts";
import { agoLong, useNow } from "../../lib/time.ts";
import { tempSource, tempSourceLong } from "../../components/MachineStats.tsx";

export type Level = "normal" | "warn" | "critical";
const PRESSURE: Record<Level, string> = { normal: "normal", warn: "elevated", critical: "critical" };
const R = 27;
const CIRC = 2 * Math.PI * R;

/** Memory in use as a share, and its level: the OS pressure when reported, else from the share. */
export function memoryLevel(mem: NonNullable<MachineStats["mem"]>): { pct: number; level: Level } {
  const pct = mem.total > 0 ? Math.min(100, Math.max(0, (mem.used / mem.total) * 100)) : 0;
  return { pct, level: mem.pressure ?? (pct >= 90 ? "critical" : pct >= 75 ? "warn" : "normal") };
}

/** The 1-minute load average per logical CPU, as a share of the machine (capped at 100 %). */
export function cpuLevel(sys: NonNullable<MachineStats["sys"]>): { pct: number; level: Level } | null {
  if (sys.load1 === null) return null;
  const ratio = sys.load1 / sys.cpus;
  return { pct: Math.min(100, ratio * 100), level: ratio >= 1.5 ? "critical" : ratio >= 0.9 ? "warn" : "normal" };
}

function Ring({ pct, level, label, children }: { pct: number | null; level: Level | null; label: string; children: ReactNode }) {
  const off = pct === null ? CIRC : CIRC * (1 - pct / 100);
  return (
    <div className={`mg-ring mg-lv-${level ?? "none"}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct === null ? undefined : Math.round(pct)}>
      <svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
        <circle className="mg-track" cx="32" cy="32" r={R} />
        <circle className="mg-arc" cx="32" cy="32" r={R} strokeDasharray={CIRC} strokeDashoffset={off} />
      </svg>
      <span className="mg-ring-in" aria-hidden="true">{children}</span>
    </div>
  );
}

function Gauge({ icon, title, ring, value, sub }: { icon: ReactNode; title: string; ring: ReactNode; value: ReactNode; sub: ReactNode }) {
  return (
    <div className="mg-card">
      {ring}
      <div className="mg-text">
        <span className="mg-title">{icon}{title}</span>
        <span className="mg-value tnum">{value}</span>
        <span className="mg-sub">{sub}</span>
      </div>
    </div>
  );
}

function MemoryGauge({ mem }: { mem: MachineStats["mem"] | undefined }) {
  const icon = <MemoryStick size={13} strokeWidth={1.75} aria-hidden="true" />;
  if (!mem) return <Gauge icon={icon} title="Memory" ring={<Ring pct={null} level={null} label="Memory not reported">–</Ring>} value="n/a" sub="Not reported on this platform" />;
  const { pct, level } = memoryLevel(mem);
  return (
    <Gauge
      icon={icon} title="Memory"
      ring={<Ring pct={pct} level={level} label={`Memory ${Math.round(pct)} % used`}>{Math.round(pct)}<small>%</small></Ring>}
      value={<>{gb(mem.used)} <span className="muted">of {gb(mem.total)} GB</span></>}
      sub={<>{gb(Math.max(0, mem.total - mem.used))} GB free · swap {gb(mem.swap_used)} GB{mem.pressure ? ` · pressure ${PRESSURE[mem.pressure]}` : ""}</>}
    />
  );
}

function CpuGauge({ stats }: { stats: MachineStats | undefined }) {
  const icon = <Cpu size={13} strokeWidth={1.75} aria-hidden="true" />;
  const chip = stats?.accel?.chip ?? null;
  const sys = stats?.sys;
  const cpu = sys ? cpuLevel(sys) : null;
  if (!sys || !cpu) {
    return (
      <Gauge icon={icon} title="CPU" ring={<Ring pct={null} level={null} label="CPU load not reported">–</Ring>}
        value={chip ?? "n/a"} sub={sys ? `${sys.cpus} cores · no load average on this OS` : "Load not reported (an older Walkie)"} />
    );
  }
  return (
    <Gauge
      icon={icon} title="CPU"
      ring={<Ring pct={sys.cpu_busy_pct ?? cpu.pct} level={cpu.level} label={sys.cpu_busy_pct === undefined || sys.cpu_busy_pct === null
        ? `CPU load ${Math.round(cpu.pct)} % of ${sys.cpus} cores` : `CPU busy ${sys.cpu_busy_pct} %`}>
        {Math.round(sys.cpu_busy_pct ?? cpu.pct)}<small>%</small></Ring>}
      value={<>{[sys.load1, sys.load5, sys.load15].map((n) => n?.toFixed(2) ?? "n/a").join(" / ")} <span className="muted">load 1/5/15</span></>}
      sub={<>{sys.cpus} cores{chip ? ` · ${chip}` : ""} · CPU busy {sys.cpu_busy_pct === undefined || sys.cpu_busy_pct === null ? "n/a" : `${sys.cpu_busy_pct}%`}</>}
    />
  );
}

function TempGauge({ stats }: { stats: MachineStats | undefined }) {
  const icon = <Thermometer size={13} strokeWidth={1.75} aria-hidden="true" />;
  const c = stats?.temp_c;
  if (!stats || c === null || c === undefined) {
    return <Gauge icon={icon} title="Temperature" ring={<Ring pct={null} level={null} label="Temperature not available">–</Ring>} value="n/a" sub="No readable sensor (VMs, Intel Macs)" />;
  }
  const zones = stats.temp_zones ?? [];
  const pct = Math.min(100, Math.max(0, ((c - 30) / 70) * 100));
  return (
    <Gauge
      icon={icon} title="Temperature"
      ring={<Ring pct={pct} level={tempLevel(c)} label={`Temperature ${Math.round(c)} degrees, ${tempSource(stats)}`}>{Math.round(c)}<small>°</small></Ring>}
      value={<>{c.toFixed(1)} <span className="muted">°C · {tempSource(stats)}</span></>}
      sub={<>
        {tempSourceLong(stats).replace(/^./, (x) => x.toUpperCase())}
        {zones.length > 1 ? ` · ${zones.map((z) => `${z.name} ${Math.round(z.c)}°`).join(", ")}` : ""}
      </>}
    />
  );
}

function AccelCard({ stats }: { stats: MachineStats | undefined }) {
  const accel = stats?.accel;
  const gpus = accel?.gpus ?? [];
  return (
    <div className="mg-card mg-accel">
      <div className="mg-text">
        <span className="mg-title"><Zap size={13} strokeWidth={1.75} aria-hidden="true" />Accelerator</span>
        {!accel ? (
          <span className="mg-sub">Not reported (an older Walkie)</span>
        ) : gpus.length === 0 ? (
          <>
            <span className="mg-value">{accel.unified ? "Unified memory" : "No discrete GPU"}</span>
            <span className="mg-sub">
              {accel.unified ? `The GPU shares system memory${accel.gpu_limit ? ` · GPU limit ${gb(accel.gpu_limit)} GB` : ""}` : "Local models would run on the CPU"}
            </span>
          </>
        ) : (
          <ul className="mg-gpus">
            {gpus.map((g, i) => {
              const free = stats?.gpu_free?.[i];
              const usedPct = free === undefined || g.vram <= 0 ? null : Math.min(100, Math.max(0, ((g.vram - free) / g.vram) * 100));
              return (
                <li key={`${g.name}-${i}`}>
                  <span className="mg-gpu-name">{g.name}</span>
                  <span className="mg-bar" role="meter" aria-label={`${g.name} memory ${usedPct === null ? "use not reported" : `${Math.round(usedPct)} % used`}`}
                    aria-valuemin={0} aria-valuemax={100} aria-valuenow={usedPct === null ? undefined : Math.round(usedPct)}>
                    <span style={{ width: `${(usedPct ?? 0).toFixed(1)}%` }} />
                  </span>
                  <span className="mg-sub tnum">
                    {free === undefined ? `${gb(g.vram)} GB VRAM` : `${gb(free)} of ${gb(g.vram)} GB free`}
                    {typeof stats?.gpu_temp?.[i] === "number" ? ` · ${Math.round(stats.gpu_temp[i] as number)} °C` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Memory, CPU, temperature and accelerator cards, with when they were sampled. */
export function MachineGauges({ node }: { node: NodeView }) {
  const now = useNow();
  const stats = node.stats;
  return (
    <section className={`mg${node.online ? "" : " is-stale"}`} aria-labelledby="mg-h">
      <header className="section-head">
        <h2 className="section-title" id="mg-h">Live stats</h2>
        <span className="section-meta">
          {!stats ? "not reported (turned off, or an older Walkie)" : node.online ? `updated ${agoLong(stats.at, now)}` : `last known · sampled ${agoLong(stats.at, now)}`}
        </span>
      </header>
      <div className="mg-grid">
        <MemoryGauge mem={stats?.mem} />
        <CpuGauge stats={stats} />
        <TempGauge stats={stats} />
        <AccelCard stats={stats} />
      </div>
      {stats?.discovery?.incomplete && (
        <p className="mg-note">{stats.discovery.stale
          ? "The process list is unavailable. Agent counts and cards reflect the last successful scan."
          : `${stats.discovery.unreported} agent session(s) have details pending or exceed the reporting cap. Process-only sessions still appear as working.`}</p>
      )}
    </section>
  );
}
