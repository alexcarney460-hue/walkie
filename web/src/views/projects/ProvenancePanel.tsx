// Read-only provenance for a card (WALK-77 Phase 0). Names come from cardProvenance, which reads signed authors
// of applied card ops and nothing an op says about itself. Order is the fold's order, not the signer's clock.
// This component has no controls: it cannot edit the card.
import type { TimelineEntry } from "../../api/types.ts";
import { ago, useNow } from "../../lib/time.ts";
import { cardProvenance, provenanceTimeKind, type ProvenanceAct, type ProvenanceColumn } from "../../../../src/protocol/projects/provenance.ts";

const NOTE = "Read from who signed each applied change. A name written in the card or a comment does not count, and a change the board did not apply is left out. The list follows the order the board applied the changes, not the clocks on those machines. A clock that cannot be shown is left unshown.";

function who(author: ProvenanceAct["author"]): string {
  return `@${author.handle}${author.agent ? `/${author.agent}` : ""}`;
}

function what(kind: "proposed" | "shaped" | "decided", act: ProvenanceAct): string {
  if (act.field === "create") return "created the card";
  if (act.field === "title") return "edited the title";
  if (act.field === "body") return "edited the description";
  if (kind === "decided") {
    const where = act.columnName ? ` (${act.columnName})` : "";
    const agent = act.author.agent ? " (agent)" : "";
    return `moved it to done${where}${agent}`;
  }
  return act.columnName ? `edited the column (${act.columnName})` : "edited the column";
}

/** A clock ahead of the reader, in the same short units as a past time, never collapsed to "now". */
function aheadOf(ts: number, now: number): string {
  const s = Math.max(1, Math.round((ts - now) / 1000));
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

function ProvTime({ ts }: { ts: number }) {
  const now = useNow();
  const kind = provenanceTimeKind(ts, now);
  if (kind === "unshown") return <time className="tnum prov-time" data-time="unshown">time not shown</time>;
  const exact = new Date(ts).toISOString();
  const rel = kind === "ahead" ? aheadOf(ts, now) : ago(ts, now);
  return (
    <time className="tnum prov-time" dateTime={exact} data-time={kind} aria-label={`Signed ${exact}`}>
      <span className="prov-rel">{rel}</span>
      {" · "}
      <span className="prov-exact">{exact}</span>
    </time>
  );
}

function ProvList({ kind, label, acts }: { kind: "proposed" | "shaped" | "decided"; label: string; acts: readonly ProvenanceAct[] }) {
  const standing = kind === "decided" ? acts.find((a) => a.decision === "stands") : undefined;
  const standingKind = kind !== "decided" ? undefined : !standing ? "none" : standing.author.agent ? "agent" : "person";
  return (
    <div data-provenance={kind} {...(standingKind ? { "data-standing": standingKind } : {})}>
      <h4 className="prov-label">{label}</h4>
      {acts.length === 0 ? <p className="prov-empty">Nobody yet.</p> : (
        <>
          <ul className="prov-acts">
            {acts.map((a) => (
              <li
                key={`${a.id}:${a.field}`}
                className="prov-act"
                data-author={who(a.author)}
                data-field={a.field}
                data-id={a.id}
                data-by={a.author.agent ? "agent" : "person"}
                {...(a.decision ? { "data-decision": a.decision } : {})}
              >
                <span className="mono prov-who">{who(a.author)}</span>
                <span className="prov-what">{what(kind, a)}</span>
                {a.decision && <span className="prov-mark">{a.decision}</span>}
                <ProvTime ts={a.ts} />
              </li>
            ))}
          </ul>
          {standingKind === "none" && <p className="prov-standing" data-standing-note="none">No decision stands.</p>}
          {standingKind === "agent" && <p className="prov-standing" data-standing-note="agent">A person has not decided.</p>}
        </>
      )}
    </div>
  );
}

export function ProvenanceSection({ status, timeline, columns }: {
  status: "loading" | "error" | "ready";
  timeline?: readonly TimelineEntry[];
  columns: readonly ProvenanceColumn[];
}) {
  const prov = status === "ready" ? cardProvenance(timeline ?? [], columns) : null;
  return (
    <section className="drawer-section card-provenance" data-provenance-panel={status} aria-labelledby="card-provenance-h" aria-busy={status === "loading" ? true : undefined}>
      <h3 id="card-provenance-h" className="drawer-h">Provenance</h3>
      <p className="card-provenance-note">{NOTE}</p>
      {status === "loading" && <p className="prov-status">Reading the signed history…</p>}
      {status === "error" && <p className="prov-status" role="status">The signed history did not load, so provenance is not shown.</p>}
      {prov && (
        <div className="prov-rows">
          <ProvList kind="proposed" label="Proposed by" acts={prov.proposed} />
          <ProvList kind="shaped" label="Shaped by" acts={prov.shaped} />
          <ProvList kind="decided" label="Decided by" acts={prov.decided} />
        </div>
      )}
    </section>
  );
}
