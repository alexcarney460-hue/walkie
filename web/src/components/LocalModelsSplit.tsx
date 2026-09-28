// "With all our machines together" (WALKIE-POOL-2): the whole team's compute combined, where each part would run,
// this machine's sharing switch, and the split run itself (Run it split / status / Stop). Used by LocalModels.tsx.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Play, Share2, Square } from "lucide-react";
import type { NodeView } from "../api/types.ts";
import { friendlyError } from "../api/client.ts";
import { poolApi, type PoolLocalView, type RunView } from "../api/pool.ts";
import { suggestCombined, type CombinedPick, type CombinedSuggestion } from "../../../src/pool/combined.ts";
import { acrossText, perTokenText, pickTitle, SHARE_WARNING, SPEED_HINT, tpsText } from "../../../src/pool/format.ts";
import { CopyCommand } from "./primitives.tsx";

const GiB = 1024 ** 3;
const gbText = (b: number): string => (b / GiB >= 10 ? `${Math.round(b / GiB)} GB` : `${(Math.round((b / GiB) * 10) / 10).toFixed(1)} GB`);
const ACTIVE = new Set<RunView["state"]>(["downloading", "starting", "loading", "serving", "stopping"]);

export function useCombined(nodes: readonly NodeView[]): CombinedSuggestion {
  return useMemo(() => suggestCombined(nodes), [nodes]);
}

/** This machine's split-run state, polled: every 2 s while a run is active, else every 15 s. */
export function usePool(): { view: PoolLocalView | null; error: string | null; refresh: () => Promise<void>; setView: (v: PoolLocalView) => void } {
  const [view, setView] = useState<PoolLocalView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const v = await poolApi.get();
      if (alive.current) { setView(v); setError(null); }
    } catch (err) {
      if (alive.current) setError(friendlyError(err));
    }
  }, []);
  const active = !!view?.run && ACTIVE.has(view.run.state);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const t = setInterval(() => void refresh(), active ? 2_000 : 15_000);
    return () => { alive.current = false; clearInterval(t); };
  }, [refresh, active]);
  return { view, error, refresh, setView };
}

function Speed({ pick }: { pick: CombinedPick }) {
  return <span className={`lm-speed lm-speed-${pick.speed}`} title={SPEED_HINT[pick.speed]}>{pick.speed}</span>;
}

/** Where each part runs: host, GB, memory; who starts it; who hasn't turned sharing on. */
function Placement({ pick, notSharing }: { pick: CombinedPick; notSharing: readonly string[] }) {
  return (
    <ul className="lm-place" aria-label="Where each part would run">
      {pick.placement.map((pl) => (
        <li key={pl.node_id} className="lm-place-row">
          <span className="mono lm-place-host">{pl.hostname}</span>
          <span className="lm-place-gb tnum">{gbText(pl.bytes)}</span>
          <span className="lm-place-mem">{pl.memory}</span>
          {pl.node_id === pick.head.node_id && <span className="lm-tag">starts it</span>}
          {notSharing.includes(pl.hostname) && <span className="lm-tag lm-tag-off">not sharing</span>}
        </li>
      ))}
    </ul>
  );
}

function RunStatus({ run, onStop, busy }: { run: RunView; onStop: () => void; busy: boolean }) {
  const dl = run.download && run.state === "downloading" ? run.download : null;
  return (
    <div className={`lm-run lm-run-${run.state}`} role="status" aria-live="polite">
      <div className="lm-run-head">
        <span className={`lm-run-state lm-run-state-${run.state}`}>{run.state}</span>
        <span className="lm-run-model">{run.model.name}{run.model.quant ? ` · ${run.model.quant === "q8" ? "8-bit" : "4-bit"}` : ""}</span>
        {run.tokens_per_s !== null && <span className="lm-run-tps tnum">{run.tokens_per_s} tokens/s measured</span>}
        {ACTIVE.has(run.state) && run.state !== "stopping" && (
          <button type="button" className="btn btn-sm lm-run-stop" onClick={onStop} disabled={busy}>
            <Square size={12} strokeWidth={2} aria-hidden="true" /> Stop
          </button>
        )}
      </div>
      {dl && (
        <div className="lm-progress" aria-label={`Downloading ${gbText(dl.done)} of ${gbText(dl.total)}`}>
          <span className="lm-progress-bar" style={{ width: `${Math.min(100, (dl.done / Math.max(1, dl.total)) * 100)}%` }} />
          <span className="lm-progress-text tnum">{gbText(dl.done)} of {gbText(dl.total)}</span>
        </div>
      )}
      <ul className="lm-run-stages">
        {run.stages.map((s) => (
          <li key={s.node_id} className={`lm-run-stage is-${s.state}`}>
            <span className="mono">{s.hostname}</span>
            <span className="tnum">{gbText(s.bytes)}</span>
            <span className="lm-run-stage-state">{s.self ? "this machine" : s.state}</span>
          </li>
        ))}
      </ul>
      {run.error && <p className="lm-run-error">{run.error}</p>}
      {run.endpoint && (
        <div className="lm-run-endpoint">
          <p className="lm-run-note">Your agents on this machine can use it: an OpenAI-compatible API on this machine only (the key is in {run.api_key_file}).</p>
          {run.example && <CopyCommand command={run.example} label="Try it" prompt={false} />}
        </div>
      )}
    </div>
  );
}

function ShareSwitch({ view, onChange, busy }: { view: PoolLocalView; onChange: (on: boolean, maxGb: number | null) => void; busy: boolean }) {
  const [max, setMax] = useState<string>(view.share.max_bytes ? String(Math.round((view.share.max_bytes / GiB) * 10) / 10) : "");
  const on = view.share.on;
  const maxGb = max.trim() === "" ? null : Number(max);
  const valid = maxGb === null || (Number.isFinite(maxGb) && maxGb > 0);
  return (
    <div className="lm-share">
      <label className="lm-share-toggle">
        <input type="checkbox" role="switch" checked={on} disabled={busy || !valid} onChange={(e) => onChange(e.target.checked, maxGb)} />
        <span>Share this machine with teammates' split runs</span>
      </label>
      <label className="lm-share-max">
        <span>up to</span>
        <input type="number" min="1" step="1" inputMode="decimal" placeholder="free" value={max} aria-label="Most memory a split run may use here, GB (empty: what is free)" onChange={(e) => setMax(e.target.value)} onBlur={() => { if (on && valid) onChange(true, maxGb); }} />
        <span>GB</span>
      </label>
      {!view.runtime.installed && <span className="lm-share-hint">needs the runtime: <code>walkie pool install</code></span>}
      <p className="lm-share-warn">{SHARE_WARNING}</p>
    </div>
  );
}

/** The headline: the whole team's compute combined, and the split run that goes with it. */
export function CombinedBlock({ cs, detail }: { cs: CombinedSuggestion; detail?: boolean }) {
  const pool = usePool();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try { await f(); await pool.refresh(); } catch (e) { setErr(friendlyError(e)); } finally { setBusy(false); }
  };
  const p = cs.pick;
  const run = pool.view?.run ?? null;
  const r = cs.runnable;
  return (
    <div className="lm-all">
      <p className="lm-all-label">With all our machines together</p>
      {!p ? (
        <p className="lm-empty">Nothing in the catalog fits in the memory the team has free right now.</p>
      ) : (
        <>
          <p className="lm-all-model">
            <span className="lm-all-title">{pickTitle(p)}</span>
            <Speed pick={p} />
            <span className="lm-all-speed tnum">{tpsText(p.tokensPerSec)}, {acrossText(p)}</span>
          </p>
          <Placement pick={p} notSharing={cs.notSharing} />
          <p className="lm-all-note">
            {perTokenText(p)} · estimate{!p.head.self && p.fromHere ? ` · started from this machine: ${tpsText(p.fromHere.tokensPerSec)}` : ""}
          </p>
          {detail && <p className="lm-all-note">{p.why}.</p>}
        </>
      )}
      {run && (ACTIVE.has(run.state) || run.state === "failed") ? (
        <RunStatus run={run} busy={busy} onStop={() => void act(() => poolApi.stop())} />
      ) : pool.view ? (
        <div className="lm-run-start">
          {r ? (
            <button type="button" className="btn btn-sm btn-primary lm-run-go" disabled={busy} onClick={() => void act(() => poolApi.run(r.model.id, r.quant))}>
              <Play size={12} strokeWidth={2} aria-hidden="true" />
              {r.placement.length > 1 ? `Run it split: ${pickTitle(r)} across ${r.placement.length}` : `Run ${pickTitle(r)} on this machine`}
            </button>
          ) : null}
          {r && <span className="lm-run-est tnum">{tpsText(r.tokensPerSec)} (estimate)</span>}
          {cs.runnableNote && <p className="lm-run-note">{cs.runnableNote}.</p>}
          {cs.sharing.length > 0 && <p className="lm-run-note"><Share2 size={11} strokeWidth={1.75} aria-hidden="true" /> Sharing now: {cs.sharing.join(", ")}.</p>}
        </div>
      ) : null}
      {pool.view && <ShareSwitch view={pool.view} busy={busy} onChange={(on, max) => void act(() => poolApi.share(on, max))} />}
      {(err ?? pool.error) && <p className="lm-run-error">{err ?? pool.error}</p>}
    </div>
  );
}
