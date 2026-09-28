// "What your team could run locally": first what ALL the team's machines could run together (WALKIE-POOL-2, with
// the split run itself: LocalModelsSplit.tsx), then the fast options: the largest model each group of machines could
// run, from the memory they have free now (src/pool/). A card on Mission Control and a fuller section on the Team page.
import { useMemo } from "react";
import { ArrowUpRight, Cpu } from "lucide-react";
import type { NodeView } from "../api/types.ts";
import { gb } from "../../../src/protocol/machine-stats-format.ts";
import { CATALOG } from "../../../src/pool/catalog.ts";
import { alternativeLabel, groupTitle, IDLE_HINT, pickTitle, SPEED_HINT, speedText, whereText } from "../../../src/pool/format.ts";
import { suggestTeam, type GroupSuggestion, type Pick, type TeamSuggestion } from "../../../src/pool/suggest.ts";
import { hrefFor } from "../lib/route.ts";
import { CombinedBlock, useCombined } from "./LocalModelsSplit.tsx";
import { ServeBlock } from "./LocalModelsServe.tsx";

export function useTeamSuggestion(nodes: readonly NodeView[]): TeamSuggestion {
  return useMemo(() => suggestTeam(nodes), [nodes]);
}

function SpeedTag({ pick }: { pick: Pick }) {
  if (!pick.fits) return <span className="lm-speed lm-speed-none">doesn't fit</span>;
  return <span className={`lm-speed lm-speed-${pick.speed}`} title={`${speedText(pick)}: ${SPEED_HINT[pick.speed]}`}>{pick.speed}</span>;
}

export function PickRow({ label, pick, detail }: { label: string; pick: Pick; detail?: boolean }) {
  return (
    <li className={`lm-pick${pick.fits ? "" : " is-nofit"}`}>
      <span className="lm-pick-label">{label}</span>
      <span className="lm-pick-main">
        <span className="lm-pick-model">
          {detail ? <a className="text-link" href={pick.model.source} target="_blank" rel="noreferrer noopener">{pickTitle(pick)}</a> : pickTitle(pick)}
        </span>
        <SpeedTag pick={pick} />
        {pick.fits && <span className="lm-pick-where mono">on {whereText(pick)}</span>}
      </span>
      <span className="lm-pick-why">{pick.why}{pick.fits ? ` · ${speedText(pick)}` : ""}</span>
    </li>
  );
}

function picksOf(s: GroupSuggestion): Array<{ label: string; pick: Pick }> {
  const out: Array<{ label: string; pick: Pick }> = [];
  if (s.single) out.push({ label: "On one machine", pick: s.single });
  if (s.pooled) out.push({ label: `Split across ${s.pooled.placement.length}`, pick: s.pooled });
  for (const a of s.alternatives) out.push({ label: alternativeLabel(s, a), pick: a });
  if (s.ifIdle) out.push({ label: "If idle", pick: s.ifIdle });
  return out;
}

const NOTHING = "Nothing in the catalog fits in the memory free right now.";

/** Mission Control card: the group that could run the largest model, its best picks, a link to the details. */
export function LocalModelsCard({ nodes }: { nodes: readonly NodeView[] }) {
  const t = useTeamSuggestion(nodes);
  const cs = useCombined(nodes);
  const s = t.headline;
  const reporting = t.groups.reduce((n, g) => n + g.machines.length, 0);
  const picks = s ? [s.single, s.pooled].filter((p): p is Pick => !!p) : [];
  return (
    <section className="lm-card" aria-labelledby="lm-card-h">
      <header className="lm-card-head">
        <Cpu size={14} strokeWidth={1.75} aria-hidden="true" className="lm-icon" />
        <h2 className="lm-card-title" id="lm-card-h">What your team could run locally</h2>
        <span className="lm-est">estimate</span>
        <a className="lm-more" href={hrefFor({ view: "team", tab: "models" })}>Details <ArrowUpRight size={13} strokeWidth={1.75} aria-hidden="true" /></a>
      </header>
      {!s ? (
        <p className="lm-empty">No machine has reported its memory yet. Machines share it once they run a Walkie newer than v0.1.3.</p>
      ) : (
        <>
          <ServeBlock nodes={nodes} />
          <CombinedBlock cs={cs} />
          <p className="lm-fast-h">Fast options: one machine, or machines on one network</p>
          <p className="lm-card-meta">
            <span className="lm-group">{groupTitle(s.group)}</span>
            <span className="tnum"> · {gb(s.usable)} GB free for a model now</span>
            {reporting > s.group.machines.length && <span className="muted"> · best of {t.groups.length} groups</span>}
          </p>
          {s.group.machines.some((m) => m.backends.some((b) => !b.measured)) && (
            <p className="lm-card-note">Free GPU memory isn't measured on some machines: their GPUs count only if idle.</p>
          )}
          {picks.length ? (
            <ul className="lm-picks">
              {picks.map((p) => <PickRow key={`${p.model.id}-${p.quant}-${p.pooled}`} label={p.pooled ? `Split across ${p.placement.length}` : "On one machine"} pick={p} />)}
            </ul>
          ) : (
            <p className="lm-empty">
              {NOTHING}
              {s.ifIdle && <> <span title={IDLE_HINT}>If the machines were otherwise idle</span>: <strong>{pickTitle(s.ifIdle)}</strong> on {whereText(s.ifIdle)}.</>}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function GroupCard({ s }: { s: GroupSuggestion }) {
  const picks = picksOf(s);
  return (
    <article className="lm-group-card" aria-label={groupTitle(s.group)}>
      <header className="lm-group-head">
        <h3 className="lm-group-title">{groupTitle(s.group)}</h3>
        <span className="lm-group-free tnum">{gb(s.usable)} GB free now<span className="muted"> · {gb(s.usableIdle)} GB if idle</span></span>
      </header>
      <p className="lm-why">{s.group.why}.</p>
      <ul className="lm-machines">
        {s.group.machines.map((m) => (
          <li key={m.node_id} className="lm-machine">
            <span className="mono lm-machine-host">{m.hostname}</span>
            <span className="lm-machine-hw">{m.label}</span>
            <span className="lm-machine-free tnum">{gb(m.usable)} GB free now<span className="muted"> · {gb(m.usableIdle)} GB if idle</span></span>
            {m.notes.map((n) => <span key={n} className="lm-machine-note">{n}</span>)}
          </li>
        ))}
      </ul>
      {!s.single && !s.pooled && <p className="lm-empty">{NOTHING}</p>}
      {picks.length > 0 && (
        <ul className="lm-picks">
          {picks.map((p) => <PickRow key={`${p.label}-${p.pick.model.id}-${p.pick.quant}`} label={p.label} pick={p.pick} detail />)}
        </ul>
      )}
    </article>
  );
}

/** Team page: every group, its machines, picks and why. */
export function LocalModelsSection({ nodes }: { nodes: readonly NodeView[] }) {
  const t = useTeamSuggestion(nodes);
  const cs = useCombined(nodes);
  return (
    <div className="lm-section">
      {t.suggestions.length > 0 && <article className="lm-group-card lm-all-card"><ServeBlock nodes={nodes} /><CombinedBlock cs={cs} detail /></article>}
      <p className="lm-intro">
        Open-weight models your machines could run themselves, from the memory they have free now (memory already in
        use, by agents, apps or anything else, is left alone; on NVIDIA GPUs, the free VRAM each GPU reports). "If
        idle" means {IDLE_HINT}. A machine with a GPU is also considered running on its CPU from system memory
        (slower, but it may fit a bigger model). All the team's machines together can run a bigger model split
        across them (llama.cpp RPC through Walkie's encrypted connections): each machine joins only when its owner
        turns sharing on, and a person starts the run. Across sites every token waits for a round trip to each machine,
        so it is slower than one machine. Suggestions are estimates: nothing is downloaded or run until a person starts
        a split run.
      </p>
      {t.suggestions.length === 0 && <p className="lm-empty">No machine has reported its memory yet. Machines share it once they run a Walkie newer than v0.1.3.</p>}
      {t.suggestions.map((s) => <GroupCard key={s.group.machines.map((m) => m.node_id).join(",")} s={s} />)}
      {t.excluded.length > 0 && (
        <p className="lm-foot">Not counted: {t.excluded.map((e) => `${e.hostname} (${e.reason})`).join(", ")}.</p>
      )}
      <p className="lm-foot">
        Memory needed = the model's weights at 4 or 8 bits + a {Math.round(t.context / 1024)}K-token cache + {CATALOG.overhead_gib} GB.
        Speed is estimated from each machine's memory bandwidth and the network hops: fast = {SPEED_HINT.fast}, usable ={" "}
        {SPEED_HINT.usable}, slow = {SPEED_HINT.slow}. Catalog v{CATALOG.version} ({CATALOG.models.length} models, {CATALOG.updated}).
      </p>
    </div>
  );
}
