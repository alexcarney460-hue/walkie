// The Agent archive (WALKIE-MISSION-1): idle and ended agents, per machine, searchable, with their last title and
// when they were last seen. Recently idle / ended agents come from the live stream; older ones are fetched from the
// daemon (GET /v1/agents?scope=archive), which filters by machine, search and state BEFORE it cuts a page (fix round 1,
// Codex 6), a page at a time ("Load more"), and again whenever the daemon's archive revision changes (Codex 7: a
// count can stay the same while the contents change).
import { useEffect, useMemo, useRef, useState } from "react";
import { accept, beginMore, failed, initialPager, invalidate, restart, type Pager } from "./archive-pager.ts";
import { Archive as ArchiveIcon, GitBranch, Search } from "lucide-react";
import { api, friendlyError } from "../../api/client.ts";
import type { AgentView } from "../../api/types.ts";
import { EmptyState, ErrorState, RuntimeBadge, SkeletonRows, StatePill } from "../../components/primitives.tsx";
import { getRoute, hrefFor, navigate } from "../../lib/route.ts";
import { agoLong, useNow } from "../../lib/time.ts";
import { useActions, useStore } from "../../state/store.tsx";
import { archiveCountText, countByNode, isArchived, matchesSearch, shownByDefault } from "../../../../src/protocol/agent-roster.ts";

type StateFilter = "all" | "idle" | "offline";
const STATE_FILTERS: Array<{ id: StateFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "idle", label: "Idle" },
  { id: "offline", label: "Offline" },
];

/** Recently idle / ended agents (live stream) plus the loaded archive, newest first, one entry per agent. */
export function archiveEntries(live: readonly AgentView[], archived: readonly AgentView[], now: number): AgentView[] {
  const byId = new Map<string, AgentView>();
  for (const a of archived) byId.set(a.id, a);
  for (const a of live) if (!shownByDefault(a)) byId.set(a.id, { ...a, archived: isArchived(a, now) });
  // An archived agent that reported again is live: the stream's copy wins and shownByDefault drops it here.
  for (const a of live) if (shownByDefault(a)) byId.delete(a.id);
  return [...byId.values()].sort((x, y) => y.updated_at - x.updated_at);
}

export const ARCHIVE_PAGE = 200;

interface ArchiveQuery { machine?: string; q: string; state: StateFilter }

/**
 * The loaded archive for a query: the first page, then more on request. A new archive revision does not throw the
 * loaded pages away (Opus r3 #7): it shows "new entries" and reloads when asked. Requests of an unmounted view or an
 * older query are dropped (Codex r3 #7).
 */
function useArchive(query: ArchiveQuery): { loading: boolean; error: string | null; total: number | null; more: boolean; loadingMore: boolean; changed: boolean; loadMore: () => void; retry: () => void } {
  const { archive, archiveRev } = useStore();
  const { archiveLoaded } = useActions();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // The cursor lives in a ref (two clicks in one frame see the same, updated value); `view` re-renders on change.
  const pager = useRef<Pager>(initialPager);
  const mounted = useRef(true);
  const [view, setView] = useState<Pager>(initialPager);
  const set = (p: Pager) => { pager.current = p; if (mounted.current) setView(p); };
  // An older daemon has no revision: its counts are the best signal it gives.
  const revision = String(archiveRev ?? archive.map((c) => `${c.node}:${c.idle}:${c.offline}`).sort().join("|"));
  const loadedAt = useRef<string | null>(null);
  const changed = loadedAt.current !== null && loadedAt.current !== revision;
  const params = (offset: number) => ({
    scope: "archive" as const, limit: ARCHIVE_PAGE, ...(offset ? { offset } : {}),
    ...(query.machine ? { node: query.machine } : {}), ...(query.q.trim() ? { q: query.q.trim() } : {}),
    ...(query.state !== "all" ? { states: query.state } : {}),
  });
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pager.current = invalidate(pager.current); };
  }, []);
  useEffect(() => {
    const started = restart(pager.current);
    set(started);
    setError(null);
    const at = revision;
    const t = setTimeout(() => {
      api.agents(params(0))
        .then((r) => {
          const next = accept(pager.current, started.gen, 0, { rows: r.agents.length, offset: r.offset, total: r.total, truncated: r.truncated });
          if (!next || !mounted.current) return; // an older query's answer, or the view is gone
          archiveLoaded(r.agents);
          loadedAt.current = at;
          set(next);
          setLoading(false);
        })
        .catch((err) => { if (mounted.current && pager.current.gen === started.gen) { set(failed(pager.current, started.gen)); setError(friendlyError(err)); setLoading(false); } });
    }, query.q ? 250 : 0); // typing: one request once it pauses
    return () => { clearTimeout(t); pager.current = invalidate(pager.current); };
    // The revision is NOT a dependency: a changed archive shows "new entries" instead of jumping back to page one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, archiveLoaded, query.machine, query.q, query.state]);
  const loadMore = () => {
    const begun = beginMore(pager.current);
    if (!begun) return; // one page at a time
    set(begun.pager);
    const gen = begun.pager.gen;
    api.agents(params(begun.offset))
      .then((r) => {
        const next = accept(pager.current, gen, begun.offset, { rows: r.agents.length, offset: r.offset, total: r.total, truncated: r.truncated });
        if (!next || !mounted.current) return;
        archiveLoaded(r.agents, true);
        set(next);
      })
      .catch((err) => { if (mounted.current && pager.current.gen === gen) { set(failed(pager.current, gen)); setError(friendlyError(err)); } });
  };
  return { loading, error, total: view.total, more: view.more, loadingMore: view.inflight !== null && view.inflight > 0, changed, loadMore, retry: () => setNonce((n) => n + 1) };
}

export function ArchiveView({ machine }: { machine?: string }) {
  const { agents, archivedAgents, archive, nodes, team } = useStore();
  const now = useNow();
  const [q, setQ] = useState("");
  const [state, setState] = useState<StateFilter>("all");
  const { loading, error, more, loadingMore, changed, loadMore, retry } = useArchive({ machine, q, state });
  const entries = useMemo(() => archiveEntries(agents, archivedAgents, Math.floor(now / 30_000) * 30_000), [agents, archivedAgents, now]);
  const shown = entries
    .filter((a) => !machine || a.hostname === machine)
    .filter((a) => state === "all" || a.effective_state === state)
    .filter((a) => matchesSearch(a, q));
  const hosts = [...new Set(shown.map((a) => a.hostname))];
  const machineNames = [...new Set(nodes.map((n) => n.hostname))].sort();
  const open = (id: string) => navigate({ ...getRoute(), agent: id });
  // Counts: the live roster's idle / ended agents plus the daemon's archive counts (a loaded page may be partial).
  const nodeIds = new Set(nodes.filter((n) => !machine || n.hostname === machine).map((n) => n.node_id));
  const count = (f: StateFilter) => {
    const live = agents.filter((a) => !shownByDefault(a) && !isArchived(a, now) && (!machine || a.hostname === machine) && (f === "all" || a.effective_state === f)).length;
    const held = archive.filter((c) => nodeIds.has(c.node)).reduce((n, c) => n + (f === "offline" ? 0 : c.idle) + (f === "idle" ? 0 : c.offline), 0);
    return live + held;
  };

  return (
    <div className="archive" data-testid="archive-view">
      <p className="mission-lede">
        Agents that are idle or have ended. They come back to Live the moment they start working again. Kept for 7 days,
        the newest 200 per machine.
      </p>
      <div className="filters archive-filters" role="toolbar" aria-label="Filter the archive">
        <label className="archive-search">
          <Search size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="sr-only">Search the archive</span>
          <input className="input" type="search" placeholder="Search name, title, task, repo" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="archive-machine">
          <span className="sr-only">Machine</span>
          <select className="select" value={machine ?? ""} onChange={(e) => navigate({ view: "mission", tab: "archive", ...(e.target.value ? { machine: e.target.value } : {}) })}>
            <option value="">All machines</option>
            {machineNames.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
        </label>
        <div className="segmented" role="radiogroup" aria-label="State">
          {STATE_FILTERS.map((f) => (
            <button key={f.id} type="button" role="radio" aria-checked={state === f.id} className={state === f.id ? "seg is-on" : "seg"} onClick={() => setState(f.id)}>
              {f.label}
              <span className="seg-n tnum">{count(f.id)}</span>
            </button>
          ))}
        </div>
      </div>

      {changed && (
        <p className="archive-foot">
          <button type="button" className="btn btn-sm" onClick={retry} data-testid="archive-refresh">New entries — refresh</button>
        </p>
      )}
      {error && <ErrorState message={`Couldn't load older agents: ${error}`} onRetry={retry} compact />}
      {loading && !entries.length ? (
        <SkeletonRows rows={4} />
      ) : shown.length === 0 ? (
        <EmptyState icon={<ArchiveIcon size={18} strokeWidth={1.75} />} title={entries.length ? "Nothing in the archive matches" : "The archive is empty"}>
          {(q || state !== "all" || machine) && (
            <button type="button" className="btn btn-sm" onClick={() => { setQ(""); setState("all"); navigate({ view: "mission", tab: "archive" }); }}>Clear filters</button>
          )}
        </EmptyState>
      ) : (
        hosts.map((host) => {
          const list = shown.filter((a) => a.hostname === host);
          const c = countByNode(list)[0];
          const handle = list[0]?.handle ?? "";
          const who = team?.members.find((m) => m.handle === handle);
          return (
            <section key={host} className="archive-machine-group" aria-label={`${host} archive`}>
              <header className="archive-head">
                <span className="machine-name mono">{host}</span>
                <span className="muted">{who?.display_name ?? `@${handle}`}</span>
                <span className="archive-count tnum">{c ? archiveCountText(c) : ""}</span>
              </header>
              <ul className="archive-list">
                {list.map((a) => (
                  <li key={a.id}>
                    <button type="button" className="archive-row" onClick={() => open(a.id)} aria-label={`${a.agent} on ${a.hostname}: ${a.effective_state}, last seen ${agoLong(a.updated_at, now)}`}>
                      <StatePill state={a.effective_state} />
                      <span className="archive-agent mono truncate">{a.agent}</span>
                      <RuntimeBadge runtime={a.status.runtime} runtime_name={a.status.runtime_name} launch={a.status.launch} />
                      <span className="archive-title truncate">{a.status.title ?? <span className="muted">No status title</span>}</span>
                      <span className="archive-repo mono truncate">
                        {a.status.repo && <><GitBranch size={11} strokeWidth={1.75} aria-hidden="true" />{a.status.repo}{a.status.branch ? `@${a.status.branch}` : ""}</>}
                      </span>
                      <span className="archive-seen tnum muted">{agoLong(a.updated_at, now)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
      {more && (
        <p className="archive-foot">
          <button type="button" className="btn btn-sm" onClick={loadMore} disabled={loadingMore} aria-busy={loadingMore} data-testid="archive-more">{loadingMore ? "Loading…" : "Load more"}</button>
        </p>
      )}
      {machine && <p className="archive-foot"><a href={hrefFor({ view: "mission" })}>Back to Live</a></p>}
    </div>
  );
}
