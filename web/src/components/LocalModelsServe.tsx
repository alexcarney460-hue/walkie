// "Serve on one machine" (POOL-REAL-1): a model that fits one machine's GPU runs there whole, at that GPU's speed,
// and every member machine can use it through Walkie. Shows what the team serves now (Connect / Disconnect, the
// endpoint and key file on this machine), what this machine serves (clients, Stop), and the best model to serve
// (Serve it). Used by LocalModels.tsx above the split-run block.
import { useMemo, useState } from "react";
import { Link2, Play, Square, Unlink } from "lucide-react";
import type { NodeView } from "../api/types.ts";
import { friendlyError } from "../api/client.ts";
import { poolApi, type ConnectionView, type ServeView } from "../api/pool.ts";
import { machineCapacity } from "../../../src/pool/capacity.ts";
import { bestServe } from "../../../src/pool/run/plan.ts";
import { SPEED_HINT, tpsText } from "../../../src/pool/format.ts";
import { CopyCommand } from "./primitives.tsx";
import { usePool } from "./LocalModelsSplit.tsx";

const GiB = 1024 ** 3;
const gbText = (b: number): string => (b / GiB >= 10 ? `${Math.round(b / GiB)} GB` : `${(Math.round((b / GiB) * 10) / 10).toFixed(1)} GB`);
const quant = (q: "q4" | "q8" | null): string => (q ? ` · ${q === "q8" ? "8-bit" : "4-bit"}` : "");
const LIVE = new Set<ServeView["state"]>(["downloading", "loading", "serving", "stopping"]);

function Endpoint({ endpoint, keyFile, example }: { endpoint: string; keyFile: string; example: string | null }) {
  return (
    <div className="lm-run-endpoint">
      <p className="lm-run-note">
        OpenAI-compatible endpoint on this machine: <code>{endpoint}</code> · key in <code>{keyFile}</code>. Any agent or
        app here can use it.
      </p>
      {example && <CopyCommand command={example} label="Try it" prompt={false} />}
    </div>
  );
}

function MyServe({ s, busy, onStop }: { s: ServeView; busy: boolean; onStop: () => void }) {
  const dl = s.download && s.state === "downloading" ? s.download : null;
  return (
    <div className={`lm-run lm-run-${s.state}`} role="status" aria-live="polite">
      <div className="lm-run-head">
        <span className={`lm-run-state lm-run-state-${s.state}`}>{s.state}</span>
        <span className="lm-run-model">{s.model.name}{quant(s.model.quant)} on this machine's GPU</span>
        {s.tokens_per_s !== null && <span className="lm-run-tps tnum">{s.tokens_per_s} tokens/s measured</span>}
        {LIVE.has(s.state) && s.state !== "stopping" && (
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
      {s.started_by && <p className="lm-run-note">Started from {s.started_by.hostname}.</p>}
      {s.clients.length > 0 && <p className="lm-run-note">Connected: {s.clients.map((c) => `${c.hostname} (${c.requests} request${c.requests === 1 ? "" : "s"})`).join(", ")}.</p>}
      {s.error && <p className="lm-run-error">{s.error}</p>}
      {s.endpoint && s.api_key_file && <Endpoint endpoint={s.endpoint} keyFile={s.api_key_file} example={s.example} />}
      {s.state === "serving" && <p className="lm-run-note">It stops by itself after 30 minutes without a request.</p>}
    </div>
  );
}

function Remote({ n, conn, busy, onConnect, onDisconnect }: {
  n: NodeView; conn: ConnectionView | null; busy: boolean; onConnect: () => void; onDisconnect: () => void;
}) {
  const sv = n.pool!.serving!;
  const connected = conn?.state === "connected" && conn.id === sv.id;
  return (
    <div className={`lm-run lm-run-${sv.state}`}>
      <div className="lm-run-head">
        <span className={`lm-run-state lm-run-state-${sv.state}`}>{sv.state}</span>
        <span className="lm-run-model">{sv.model}{quant(sv.quant)} on <span className="mono">{n.hostname}</span></span>
        {sv.tokens_per_s !== null && <span className="lm-run-tps tnum">{sv.tokens_per_s} tokens/s measured there</span>}
        {connected ? (
          <button type="button" className="btn btn-sm" onClick={onDisconnect} disabled={busy}><Unlink size={12} strokeWidth={2} aria-hidden="true" /> Disconnect</button>
        ) : sv.open ? (
          <button type="button" className="btn btn-sm btn-primary" onClick={onConnect} disabled={busy}><Link2 size={12} strokeWidth={2} aria-hidden="true" /> Connect</button>
        ) : (
          <span className="lm-tag lm-tag-off">not shared</span>
        )}
      </div>
      {conn?.state === "lost" && conn.error && <p className="lm-run-error">{conn.error}</p>}
      {connected && <Endpoint endpoint={conn.endpoint} keyFile={conn.api_key_file} example={conn.example} />}
    </div>
  );
}

export function ServeBlock({ nodes }: { nodes: readonly NodeView[] }) {
  const pool = usePool();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pick = useMemo(() => bestServe(nodes), [nodes]);
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try { await f(); await pool.refresh(); } catch (e) { setErr(friendlyError(e)); } finally { setBusy(false); }
  };
  const mine = pool.view?.serve ?? null;
  const conns = pool.view?.connections ?? [];
  const remote = nodes.filter((n) => !n.self && n.online && n.pool?.serving);
  const serving = !!mine && LIVE.has(mine.state);
  return (
    <div className="lm-all lm-serve">
      <p className="lm-all-label">Serve on one machine · every layer on its GPU, the fastest way to run a model that fits</p>
      {nodes.filter((n) => n.self || (n.online && n.pool?.share)).map((n) => {
        const note = machineCapacity(n)?.runtimeNote;
        return note ? <p key={n.node_id} className="lm-run-note">{n.hostname}: {note}</p> : null;
      })}
      {remote.map((n) => (
        <Remote key={n.node_id} n={n} conn={conns.find((c) => c.node_id === n.node_id) ?? null} busy={busy}
          onConnect={() => void act(() => poolApi.connect(n.node_id))} onDisconnect={() => void act(() => poolApi.disconnect(n.node_id))} />
      ))}
      {mine && (serving || mine.state === "failed") && <MyServe s={mine} busy={busy} onStop={() => void act(() => poolApi.serveStop())} />}
      {!serving && pick && (
        <div className="lm-run-start">
          <button type="button" className="btn btn-sm btn-primary lm-run-go" disabled={busy || !pool.view}
            onClick={() => void act(() => poolApi.serve(pick.model.id, pick.quant, pick.host.node.node_id))}>
            <Play size={12} strokeWidth={2} aria-hidden="true" /> Serve {pick.model.name} · {pick.quant === "q8" ? "8-bit" : "4-bit"} on {pick.host.node.self ? "this machine" : pick.host.node.hostname}
          </button>
          <span className="lm-run-est tnum" title={SPEED_HINT[pick.speed]}>{tpsText(pick.tokensPerSec)} (estimate) · {gbText(pick.need)} of {gbText(pick.host.usable)} GPU memory free</span>
          {!pick.host.node.self && <p className="lm-run-note">It runs on {pick.host.node.hostname} (its owner shares it); this machine gets an endpoint through Walkie.</p>}
        </div>
      )}
      {!serving && !pick && remote.length === 0 && (
        <p className="lm-run-note">No GPU here or on a sharing machine has room for a catalog model now: split one across machines below.</p>
      )}
      {(err ?? pool.error) && <p className="lm-run-error">{err ?? pool.error}</p>}
    </div>
  );
}
