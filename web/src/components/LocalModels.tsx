// "What your team could run locally": the best model for the whole team (alone, split on one network, or across every
// machine), what ALL the team's machines could run together (WALKIE-POOL-2, with the split run itself:
// LocalModelsSplit.tsx), then the fast options: each machine's best model and a faster smaller one, and what each group
// of machines on one network could run split, from the memory they have free now (src/pool/). The models are ranked by
// their Hugging Face benchmark results (src/pool/hf/), from the list the daemon reads when someone opens this
// (lib/models.ts). A card on Mission Control and a fuller section on the Team page.
import { useMemo } from "react";
import { ArrowUpRight, Cpu } from "lucide-react";
import type { NodeView } from "../api/types.ts";
import { gb } from "../../../src/protocol/machine-stats-format.ts";
import { CATALOG, type Catalog } from "../../../src/pool/catalog.ts";
import {
  alternativeLabel, bestLabel, groupTitle, HOW_TEXT, hfUrl, IDLE_HINT, isStartable, listText, modelFacts, overallLabel, pickTitle, rankingNote, runtimeCaveat, SPEED_HINT, speedText, tpsText, whereText,
} from "../../../src/pool/format.ts";
import { bestOverall, type Overall } from "../../../src/pool/overall.ts";
import { suggestTeam, type GroupSuggestion, type MachineSuggestion, type Pick, type TeamSuggestion } from "../../../src/pool/suggest.ts";
import { hrefFor } from "../lib/route.ts";
import { useModels, type ModelsInput, type ModelsState } from "../lib/models.ts";
import { CombinedBlock, useCombined, useStartable } from "./LocalModelsSplit.tsx";
import { ServeBlock } from "./LocalModelsServe.tsx";

export function useTeamSuggestion(nodes: readonly NodeView[], cat: Catalog = CATALOG): TeamSuggestion {
  return useMemo(() => suggestTeam(nodes, { cat }), [nodes, cat]);
}

function SpeedTag({ pick }: { pick: Pick }) {
  if (!pick.fits) return <span className="lm-speed lm-speed-none">doesn't fit</span>;
  return <span className={`lm-speed lm-speed-${pick.speed}`} title={`${speedText(pick)}: ${SPEED_HINT[pick.speed]}`}>{pick.speed}</span>;
}

/** The model's name, a link to its Hugging Face page (built from a checked repository id, so it never leads off site). */
function ModelLink({ pick, className }: { pick: Pick; className?: string }) {
  const url = hfUrl(pick.model);
  return url
    ? <a className={className ? `text-link ${className}` : "text-link"} href={url} target="_blank" rel="noreferrer noopener">{pickTitle(pick)}</a>
    : <span className={className}>{pickTitle(pick)}</span>;
}

export function PickRow({ label, pick, cat }: { label: string; pick: Pick; cat?: Catalog }) {
  return (
    <li className={`lm-pick${pick.fits ? "" : " is-nofit"}${cat ? " has-meta" : ""}`}>
      <span className="lm-pick-label">{label}</span>
      <span className="lm-pick-main">
        <span className="lm-pick-model"><ModelLink pick={pick} /></span>
        <SpeedTag pick={pick} />
        {pick.fits && <span className="lm-pick-where mono">on {whereText(pick)}</span>}
      </span>
      <span className="lm-pick-why">{pick.why}{pick.fits ? ` · ${speedText(pick)}` : ""}{pick.fits && runtimeCaveat(pick) ? ` · ${runtimeCaveat(pick)}` : ""}</span>
      {cat && <span className="lm-pick-meta">{modelFacts(pick.model, cat)}</span>}
    </li>
  );
}

/** Group picks that the per-machine rows below do not already show. */
function picksOf(s: GroupSuggestion, each: boolean): Array<{ label: string; pick: Pick }> {
  const out: Array<{ label: string; pick: Pick }> = [];
  if (s.single && !each) out.push({ label: "On one machine", pick: s.single });
  if (s.pooled) out.push({ label: `Split across ${s.pooled.placement.length}`, pick: s.pooled });
  for (const a of s.alternatives) if (!(each && a === s.faster)) out.push({ label: alternativeLabel(s, a), pick: a });
  if (s.ifIdle) out.push({ label: "If idle", pick: s.ifIdle });
  return out;
}

const NOTHING = "Nothing in the catalog fits in the memory free right now.";

/** Where the list came from, when, and why not a fresher one; a way to ask Hugging Face again. */
function SourceLine({ m }: { m: ModelsState }) {
  return (
    <p className="lm-source" role="status" aria-live="polite">
      {m.refreshing && <>Refreshing the bounded Hugging Face list… </>}
      <span>{listText(m.view)}.</span>
      {m.view.note && <span className="lm-source-note"> {m.view.note}</span>}
      {rankingNote(m.view.catalog) && <span className="lm-source-note lm-ranking-note"> {rankingNote(m.view.catalog)}.</span>}
      {m.error && <span className="lm-source-note"> {m.error}</span>}
      {" "}
      <button type="button" className="btn btn-sm lm-source-again" onClick={m.again} disabled={m.refreshing}>Check Hugging Face again</button>
    </p>
  );
}

/** The single best model the team could run, by its benchmark results; reuses the headline styles. */
function BestOverall({ o, cat }: { o: Overall; cat: Catalog }) {
  const p = o.pick;
  return (
    <div className="lm-all lm-best">
      <p className="lm-all-label">{overallLabel(p.model)}</p>
      <p className="lm-all-model">
        <ModelLink pick={p} className="lm-all-title" />
        <SpeedTag pick={p} />
        <span className="lm-all-speed tnum">{tpsText(p.tokensPerSec)}, on {whereText(p)}{p.placement.length > 1 ? `, ${HOW_TEXT[o.how]}` : ""}</span>
      </p>
      <p className="lm-all-note">{modelFacts(p.model, cat)}</p>
      {runtimeCaveat(p) && <p className="lm-all-note">Speed {runtimeCaveat(p)}.</p>}
    </div>
  );
}

/** Every pick a view shows, to tell whether any of them cannot be started by `walkie pool run`. */
function shownPicks(t: TeamSuggestion, o: Overall | null): Pick[] {
  return [
    ...t.suggestions.flatMap((s) => [s.single, s.pooled, s.faster, ...s.alternatives.filter((a) => a.fits)]),
    ...t.machines.flatMap((m) => [m.best, m.faster]), o?.pick ?? null,
  ].filter((p): p is Pick => !!p);
}

export const PINNED_UI = "Walkie starts only the models in its pinned list (each checked against a sha256); for any other pick, download its GGUF file from Hugging Face and start it with `walkie pool run --file`.";

/** Mission Control card: the best overall, the group that could run the best model, its picks, a link to the details. */
export function LocalModelsCard({ nodes, models }: { nodes: readonly NodeView[]; models?: ModelsInput }) {
  const m = useModels(models);
  const cat = m.view.catalog;
  const t = useTeamSuggestion(nodes, cat);
  const cs = useCombined(nodes, cat);
  const startable = useStartable(nodes, cat, cs);
  const overall = useMemo(() => bestOverall(t, cs), [t, cs]);
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
          <SourceLine m={m} />
          {overall && <BestOverall o={overall} cat={cat} />}
          <ServeBlock nodes={nodes} />
          <CombinedBlock cs={cs} startable={startable} />
          <p className="lm-fast-h">Fast options: one machine, or machines on one network</p>
          <p className="lm-card-meta">
            <span className="lm-group">{groupTitle(s.group)}</span>
            <span className="tnum"> · {gb(s.usable)} GB free for a model now</span>
            {reporting > s.group.machines.length && <span className="muted"> · best of {t.groups.length} groups</span>}
          </p>
          {s.group.machines.some((mc) => mc.backends.some((b) => !b.measured)) && (
            <p className="lm-card-note">Free GPU memory isn't measured on some machines: their GPUs count only if idle.</p>
          )}
          {picks.length ? (
            <ul className="lm-picks">
              {picks.map((p) => <PickRow key={`${p.model.id}-${p.quant}-${p.pooled}`} label={p.pooled ? `Split across ${p.placement.length}` : "On one machine"} pick={p} cat={cat} />)}
            </ul>
          ) : (
            <p className="lm-empty">
              {NOTHING}
              {s.ifIdle && <> <span title={IDLE_HINT}>If the machines were otherwise idle</span>: <strong>{pickTitle(s.ifIdle)}</strong> on {whereText(s.ifIdle)}.</>}
            </p>
          )}
          {shownPicks(t, overall).some((p) => !isStartable(p.model)) && <p className="lm-card-note">{PINNED_UI}</p>}
        </>
      )}
    </section>
  );
}

/** One machine's best model alone and a faster smaller one, under its hardware line (groups of machines on one network). */
function MachinePicks({ ms, cat }: { ms: MachineSuggestion | undefined; cat: Catalog }) {
  if (!ms) return null;
  if (!ms.best) return <p className="lm-empty lm-machine-picks">Nothing in the catalog fits in the memory free on this machine right now.</p>;
  return (
    <ul className="lm-picks lm-machine-picks">
      <PickRow label={bestLabel(ms.best.model)} pick={ms.best} cat={cat} />
      {ms.faster && <PickRow label="Faster" pick={ms.faster} cat={cat} />}
    </ul>
  );
}

function GroupCard({ s, machines, cat }: { s: GroupSuggestion; machines: readonly MachineSuggestion[]; cat: Catalog }) {
  const each = s.group.machines.length > 1;
  const picks = picksOf(s, each);
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
            {m.runtimeNote && <span className="lm-machine-note">{m.runtimeNote}</span>}
            {m.notes.map((n) => <span key={n} className="lm-machine-note">{n}</span>)}
            {each && <MachinePicks ms={machines.find((x) => x.machine.node_id === m.node_id)} cat={cat} />}
          </li>
        ))}
      </ul>
      {!s.single && !s.pooled && <p className="lm-empty">{NOTHING}</p>}
      {picks.length > 0 && (
        <ul className="lm-picks">
          {picks.map((p) => <PickRow key={`${p.label}-${p.pick.model.id}-${p.pick.quant}`} label={p.label} pick={p.pick} cat={cat} />)}
        </ul>
      )}
    </article>
  );
}

/** Team page: the best overall, every group, its machines, picks and why. */
export function LocalModelsSection({ nodes, models }: { nodes: readonly NodeView[]; models?: ModelsInput }) {
  const m = useModels(models);
  const cat = m.view.catalog;
  const t = useTeamSuggestion(nodes, cat);
  const cs = useCombined(nodes, cat);
  const startable = useStartable(nodes, cat, cs);
  const overall = useMemo(() => bestOverall(t, cs), [t, cs]);
  return (
    <div className="lm-section">
      <SourceLine m={m} />
      {t.suggestions.length > 0 && (
        <article className="lm-group-card lm-all-card">
          {overall && <BestOverall o={overall} cat={cat} />}
          <ServeBlock nodes={nodes} />
          <CombinedBlock cs={cs} startable={startable} detail />
        </article>
      )}
      <p className="lm-intro">
        The best open-weight model in the current list each of your machines could run itself, from the memory it has free now (memory already in
        use, by agents, apps or anything else, is left alone; on NVIDIA GPUs, the free VRAM each GPU reports; on a DGX
        Spark or another machine whose GPU shares the machine's memory, that memory). "Best" follows each model's
        self-reported benchmark results on Hugging Face within the current list, not its size. "If idle" means {IDLE_HINT}. A machine
        with a GPU is also considered running on its CPU from system memory (slower, but it may fit a bigger model). All the
        team's machines together can run a bigger model split across them (llama.cpp RPC through Walkie's encrypted
        connections): each machine joins only when its owner turns sharing on, and a person starts the run. Across sites
        every token waits for a round trip to each machine, so it is slower than one machine. Suggestions are estimates:
        nothing is downloaded or run until a person starts a split run.
      </p>
      {t.suggestions.length === 0 && <p className="lm-empty">No machine has reported its memory yet. Machines share it once they run a Walkie newer than v0.1.3.</p>}
      {t.suggestions.map((s, i) => <GroupCard key={s.group.machines.map((mc) => mc.node_id).join(",")} s={s} machines={t.machines.filter((x) => x.group === i)} cat={cat} />)}
      {t.excluded.length > 0 && (
        <p className="lm-foot">Not counted: {t.excluded.map((e) => `${e.hostname} (${e.reason})`).join(", ")}.</p>
      )}
      {shownPicks(t, overall).some((p) => !isStartable(p.model)) && <p className="lm-foot">{PINNED_UI}</p>}
      <p className="lm-foot">
        Memory needed = the model's weights at 4 or 8 bits (the file sizes on Hugging Face) + a {Math.round(t.context / 1024)}K-token cache (from the
        model's own layout) + {cat.overhead_gib} GB. Speed is estimated from each machine's memory bandwidth and the network hops: fast ={" "}
        {SPEED_HINT.fast}, usable = {SPEED_HINT.usable}, slow = {SPEED_HINT.slow}. {listText(m.view)}.
      </p>
    </div>
  );
}
