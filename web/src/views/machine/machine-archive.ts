// The machine page's archive section (UI-POLISH-2): one machine's archived agents, a page at a time. A refresh (the
// section opening again, Retry, or the daemon's archive revision changing) REPLACES the loaded snapshot, so titles
// and activity that changed or stopped being shared never linger from an earlier load; "Show more" appends the next
// page, the newer copy of an agent winning. The loader is plain code (tested without a DOM); the hook wires it to
// React and the store.
import { useEffect, useMemo, useState } from "react";
import { api, friendlyError } from "../../api/client.ts";
import type { AgentsPayload, AgentView } from "../../api/types.ts";
import { useActions, useStore } from "../../state/store.tsx";

export const MACHINE_ARCHIVE_PAGE = 50;
/** The daemon's largest page (src/daemon/views.ts ARCHIVE_PAGE_MAX). */
const PAGE_MAX = 1_000;

/** A fresh first load replaces everything; a further page updates known agents in place and adds the rest. */
export function mergeArchivePage(prev: readonly AgentView[], page: readonly AgentView[], replace: boolean): AgentView[] {
  if (replace) return [...page];
  const incoming = new Map(page.map((a) => [a.id, a]));
  const kept = prev.map((a) => incoming.get(a.id) ?? a);
  const known = new Set(prev.map((a) => a.id));
  return [...kept, ...page.filter((a) => !known.has(a.id))];
}

/** How many rows a refresh asks for: what is shown now (at least one page), within the daemon's cap. */
export function refreshLimit(shown: number): number {
  return Math.min(PAGE_MAX, Math.max(MACHINE_ARCHIVE_PAGE, shown));
}

export interface ArchiveSnapshot {
  readonly rows: readonly AgentView[];
  readonly total: number | null;
  readonly more: boolean;
  readonly loading: boolean;
  readonly error: string | null;
}
export const EMPTY_ARCHIVE: ArchiveSnapshot = { rows: [], total: null, more: false, loading: false, error: null };

type Fetch = (p: { offset: number; limit: number }) => Promise<Pick<AgentsPayload, "agents" | "total" | "truncated">>;

/** Sequences page requests for one machine; only the newest request's answer is applied. */
export function createArchiveLoader(fetchPage: Fetch, onChange: (s: ArchiveSnapshot) => void) {
  let snap: ArchiveSnapshot = EMPTY_ARCHIVE;
  let gen = 0;
  const set = (next: ArchiveSnapshot) => { snap = next; onChange(next); };
  const run = (offset: number, limit: number, replace: boolean): Promise<void> => {
    const my = ++gen;
    set({ ...snap, loading: true, error: null });
    return fetchPage({ offset, limit }).then(
      (r) => {
        if (my !== gen) return; // superseded or cancelled
        set({ rows: mergeArchivePage(snap.rows, r.agents, replace), total: r.total ?? null, more: !!r.truncated, loading: false, error: null });
      },
      (err: unknown) => { if (my === gen) set({ ...snap, loading: false, error: friendlyError(err) }); },
    );
  };
  return {
    get snapshot(): ArchiveSnapshot { return snap; },
    /** Reload from the first row, as many rows as are shown now, replacing the snapshot. */
    refresh: () => run(0, refreshLimit(snap.rows.length), true),
    /** The next page after what is shown (no-op while loading or when nothing remains). */
    loadMore: () => (snap.loading || !snap.more ? Promise.resolve() : run(snap.rows.length, MACHINE_ARCHIVE_PAGE, false)),
    /** Drop any answer still in flight (the section closed or the page went away). */
    cancel: () => { gen += 1; if (snap.loading) set({ ...snap, loading: false }); },
  };
}

export function useMachineArchive(nodeId: string, open: boolean, count: number): ArchiveSnapshot & { loadMore: () => void; retry: () => void } {
  const { archive, archiveRev } = useStore();
  const { archiveLoaded } = useActions();
  const [snap, setSnap] = useState<ArchiveSnapshot>(EMPTY_ARCHIVE);
  const [nonce, setNonce] = useState(0);
  const loader = useMemo(() => createArchiveLoader(
    (p) => api.agents({ scope: "archive", node: nodeId, limit: p.limit, ...(p.offset ? { offset: p.offset } : {}) }),
    (s) => {
      setSnap(s);
      // The agent drawer opens archived agents from the store: give it exactly this snapshot.
      if (!s.loading && !s.error) archiveLoaded([...s.rows]);
    },
  ), [nodeId, archiveLoaded]);
  // An older daemon has no revision: its counts are the best change signal it gives.
  const revision = String(archiveRev ?? archive.map((c) => `${c.node}:${c.idle}:${c.offline}`).sort().join("|"));
  useEffect(() => {
    if (!open || count === 0) return;
    void loader.refresh();
    return () => loader.cancel();
  }, [open, count, revision, nonce, loader]);
  return { ...snap, loadMore: () => void loader.loadMore(), retry: () => setNonce((n) => n + 1) };
}
