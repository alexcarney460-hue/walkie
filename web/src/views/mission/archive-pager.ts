// The Archive tab's paging cursor (WALKIE-MISSION-1 fix round 2, Codex r2 #11), pure so it can be tested: every query
// or archive revision starts a new generation and a response of an older one is dropped; one page request at a time;
// the cursor advances from the page the daemon answered (its offset + its rows), never from whatever it is by then.
export interface Pager {
  readonly gen: number;
  readonly next: number;
  readonly more: boolean;
  readonly total: number | null;
  /** The offset of the page being fetched, or null. */
  readonly inflight: number | null;
}

export interface Page { readonly rows: number; readonly offset?: number; readonly total?: number; readonly truncated?: boolean }

export const initialPager: Pager = { gen: 0, next: 0, more: false, total: null, inflight: null };

/** A new query or revision: a new generation, fetching page 0. */
export function restart(p: Pager): Pager {
  return { gen: p.gen + 1, next: 0, more: false, total: null, inflight: 0 };
}

/** "Load more": the offset to fetch and the pager meanwhile, or null (a page is already on its way, or none is left). */
export function beginMore(p: Pager): { pager: Pager; offset: number } | null {
  if (p.inflight !== null || !p.more) return null;
  return { pager: { ...p, inflight: p.next }, offset: p.next };
}

/** A page arrived for generation `gen`: the new pager, or null when it belongs to an older generation (drop it). */
export function accept(p: Pager, gen: number, requested: number, page: Page): Pager | null {
  if (gen !== p.gen) return null;
  const from = page.offset ?? requested;
  return { gen: p.gen, next: from + page.rows, more: page.truncated === true, total: page.total ?? p.total, inflight: null };
}

/** The view went away (unmount): every request still on its way is from an older generation now (Codex r3 #7). */
export function invalidate(p: Pager): Pager {
  return { ...p, gen: p.gen + 1, inflight: null };
}

/** A page request of generation `gen` failed: the request slot is free again (older generations are ignored). */
export function failed(p: Pager, gen: number): Pager {
  return gen === p.gen ? { ...p, inflight: null } : p;
}
