// The roster authority chain (PROTOCOL §2 "Roster"). Exactly one node at a time, the authority,
// writes roster events; the roster is the fold of its roster events in ITS seq order, following
// `team.authority` transfers. There are no forks, no timestamps and no fixed points: the chain is an
// append-only log, so the fold is O(n) and the same on every replica that holds the same events.
//
// Anchoring (PROTOCOL §2 "Validity of other events"): every entry carries `wm`, the authority's
// version vector when it emitted the entry. A non-roster event (origin O, seq s) is judged against
// the roster just before its ANCHOR, the first entry whose prefix-max watermark covers it
// (prefixMaxWm[O] >= s), with nothing skipped; an event no entry covers yet is judged against the head.
import type { LicenseVerifier } from "../license/format.ts";
import type { BodyOf, Event } from "../protocol/schemas.ts";
import { EMPTY_ROSTER, ROSTER_KINDS, applyRosterEvent, validate, type Roster } from "./roster.ts";

/** Where the chain reads roster events from (the store, or an in-memory set in tests). */
export interface RosterSource {
  /** Full roster-kind events of `origin` with after < seq <= upto, ascending seq. */
  rows(origin: string, after: number, upto: number): readonly Event[];
  /** Highest contiguous seq held for `origin` (the chain never reads past a gap). */
  vv(origin: string): number;
}

export interface Decision { readonly ev: Event; readonly ok: boolean; readonly reason: string | null }
export interface ChainEntry { readonly idx: number; readonly ev: Event }

/**
 * Everything a transaction may have changed (FINAL Codex 2): taken before the store's outermost
 * transaction runs, put back if it rolls back, so the chain never runs ahead of the database.
 */
export interface ChainSnapshot {
  readonly length: number; readonly current: Roster; readonly auth: string | null; readonly link: string | null;
  readonly cursor: ReadonlyMap<string, number>; readonly checkpoints: number; readonly creations: number;
  readonly requests: ReadonlyMap<string, string>; readonly maxTs: number;
}

/** A roster is kept every CHECKPOINT_EVERY entries; `rosterBefore(k)` folds at most that many from one. */
const CHECKPOINT_EVERY = 32;
const VIEW_CACHE = 64;

/** Per origin: the chain indexes where its prefix-max watermark rose, and the new maxima (strictly increasing). */
interface Marks { readonly idx: number[]; readonly val: number[] }

/**
 * The signed watermark of a roster event (empty for team.create or a legacy entry). A `team.license`
 * or `team.integration` entry never anchors anything (PROTOCOL §2 "Licenses"): any `wm` it carries
 * counts for nothing, so neither can move the anchor, and so the verdict, of any event.
 */
export function wmOf(ev: Event): Readonly<Record<string, number>> {
  if (ev.kind === "team.create" || ev.kind === "team.license" || ev.kind === "team.integration") return {}; // an extra `wm` there counts for nothing
  const w = (ev.body as { wm?: unknown }).wm;
  return w && typeof w === "object" ? (w as Record<string, number>) : {};
}

export class Chain {
  private current: Roster = EMPTY_ROSTER;
  private auth: string | null = null;
  /** Id of the transfer the current authority's first roster event must name in `after`. */
  private link: string | null = null;
  /** Per origin: every roster event with seq <= cursor has been decided. */
  private readonly cursor = new Map<string, number>();
  private readonly entries: ChainEntry[] = [];
  private readonly marks = new Map<string, Marks>();
  /** checkpoints[i] = the roster before entry i * CHECKPOINT_EVERY (immutable once taken). */
  private readonly checkpoints: Roster[] = [];
  /** rosterBefore(k) for k < length never changes, so cached views never go stale. */
  private readonly views = new Map<number, Roster>();
  /** request_id → id of the chain entry that applied it (PROTOCOL §2 "Roster requests"). */
  private readonly requests = new Map<string, string>();
  /**
   * Channel creations in chain order: who requested them (null = the authority's own), when, the channel, and its
   * creator's handle (the requester, else the authority's member who signed it; PROJECTS-1 project ownership).
   */
  private readonly creations: { readonly by: string | null; readonly ts: number; readonly name: string; readonly creator: string; readonly project: boolean }[] = [];
  /** The latest `ts` of any entry: the plan-clock floor's only remote source (FINAL Fable 1). */
  private tsMax = 0;

  private readonly verifyLicense: LicenseVerifier | undefined;

  /** `verifyLicense` defaults to the production verifier (the embedded vendor key); tests inject their own. */
  constructor(readonly teamId: string, opts: { verifyLicense?: LicenseVerifier } = {}) {
    this.verifyLicense = opts.verifyLicense;
  }

  get roster(): Roster { return this.current; }
  get authority(): string | null { return this.auth; }
  get pendingLink(): string | null { return this.link; }
  get length(): number { return this.entries.length; }
  /** The latest ts any entry carries (0 for an empty chain). */
  get maxTs(): number { return this.tsMax; }
  entriesFrom(start: number): readonly ChainEntry[] { return this.entries.slice(start); }

  snapshot(): ChainSnapshot {
    return {
      length: this.entries.length, current: this.current, auth: this.auth, link: this.link, cursor: new Map(this.cursor),
      checkpoints: this.checkpoints.length, creations: this.creations.length, requests: new Map(this.requests), maxTs: this.tsMax,
    };
  }

  /** Puts the chain back to `s` (entries appended since are dropped, with their marks, views and requests). */
  restore(s: ChainSnapshot): void {
    if (this.entries.length < s.length) throw new Error("chain snapshot is ahead of the chain");
    this.entries.length = s.length;
    this.checkpoints.length = s.checkpoints;
    this.creations.length = s.creations;
    for (const [origin, m] of this.marks) {
      let keep = m.idx.length;
      while (keep > 0 && (m.idx[keep - 1] as number) >= s.length) keep--;
      if (keep === 0) this.marks.delete(origin);
      else { m.idx.length = keep; m.val.length = keep; }
    }
    this.views.clear();
    this.requests.clear();
    for (const [k, v] of s.requests) this.requests.set(k, v);
    this.cursor.clear();
    for (const [k, v] of s.cursor) this.cursor.set(k, v);
    this.current = s.current; this.auth = s.auth; this.link = s.link; this.tsMax = s.maxTs;
  }

  /** Starts the chain with an already validated team.create; the founder is the first authority. */
  start(create: Event): void {
    if (this.entries.length) return;
    this.append(create);
    this.auth = create.origin;
    this.cursor.set(create.origin, create.seq);
  }

  /** The verdict `ev` gets as the authority's next roster event (no state change). */
  decide(ev: Event, authoring = false): { ok: boolean; reason: string | null; links: boolean } {
    if (this.auth === null || ev.origin !== this.auth) return { ok: false, reason: "not_authority", links: false };
    const links = this.link !== null;
    if (links && (ev.body as { after?: unknown }).after !== this.link) return { ok: false, reason: "not_linked", links: false };
    const v = validate(ev, this.current, {
      teamId: this.teamId, verifySig: false, trusted: true, ...(this.verifyLicense ? { verifyLicense: this.verifyLicense } : {}),
      ...(authoring ? { authoring: true } : {}),
    });
    if (v.status !== "ok") return { ok: false, reason: v.reason, links };
    const reason = this.keepsAuthorityOwner(ev);
    return { ok: reason === null, reason, links };
  }

  /** The authority stays an admitted owner node: move authority before demoting or revoking it. */
  private keepsAuthorityOwner(ev: Event): string | null {
    const self = this.current.nodes.get(this.auth ?? "");
    if (ev.kind === "team.member") {
      const b = ev.body as BodyOf<"team.member">;
      if (b.login === self?.login && b.role !== "owner") return "authority_must_stay_owner";
    }
    if (ev.kind === "team.node") {
      const b = ev.body as BodyOf<"team.node">;
      if (b.node_id === this.auth && b.revoked === true) return "authority_must_stay_admitted";
    }
    return null;
  }

  /**
   * Decides the authority's undecided roster events in seq order, up to the first gap, following
   * transfers. Returns every decision (applied or not) so callers can store the verdicts.
   */
  advance(src: RosterSource): Decision[] {
    const out: Decision[] = [];
    for (let a = this.auth; a !== null; a = this.auth) {
      const upto = src.vv(a);
      const from = this.cursor.get(a) ?? 0;
      if (upto <= from) break;
      let moved = false;
      for (const ev of src.rows(a, from, upto)) {
        this.cursor.set(a, ev.seq);
        const d = this.decide(ev);
        if (d.links) this.link = null;
        if (d.ok) this.append(ev);
        out.push({ ev, ok: d.ok, reason: d.reason });
        if (this.auth !== a) { moved = true; break; }
      }
      if (!moved) { this.cursor.set(a, upto); break; }
    }
    return out;
  }

  private append(ev: Event): void {
    const idx = this.entries.length;
    if (idx % CHECKPOINT_EVERY === 0) this.checkpoints.push(this.current);
    if (ev.kind === "channel.upsert") {
      const b = ev.body as BodyOf<"channel.upsert">;
      if (!this.current.channels.has(b.name)) this.creations.push({ by: b.requested_by ?? null, ts: ev.ts, name: b.name, creator: b.requested_by ?? ev.author.handle, project: b.project === true });
    }
    this.current = applyRosterEvent(this.current, ev);
    this.entries.push({ idx, ev });
    if (ev.ts > this.tsMax) this.tsMax = ev.ts;
    for (const [origin, v] of Object.entries(wmOf(ev))) {
      if (typeof v !== "number") continue;
      const m = this.marks.get(origin);
      if (!m) this.marks.set(origin, { idx: [idx], val: [v] });
      else if (v > (m.val[m.val.length - 1] as number)) { m.idx.push(idx); m.val.push(v); }
    }
    const rid = (ev.body as { request_id?: unknown }).request_id;
    if (typeof rid === "string" && !this.requests.has(rid)) this.requests.set(rid, ev.id);
    if (ev.kind === "team.authority") {
      this.auth = (ev.body as BodyOf<"team.authority">).node_id;
      this.link = ev.id;
    }
  }

  /** Highest watermark any entry so far gives `origin` (0 if none). */
  maxWm(origin: string): number {
    const m = this.marks.get(origin);
    return m ? (m.val[m.val.length - 1] as number) : 0;
  }

  /** The prefix-max watermark of the whole chain, per origin (a copy). */
  wmSnapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [o, m] of this.marks) out[o] = m.val[m.val.length - 1] as number;
    return out;
  }

  /** The anchor of (origin, seq): the first entry whose prefix-max watermark covers it, or null. */
  anchor(origin: string, seq: number): number | null {
    const m = this.marks.get(origin);
    if (!m || (m.val[m.val.length - 1] as number) < seq) return null;
    let lo = 0, hi = m.val.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((m.val[mid] as number) >= seq) hi = mid; else lo = mid + 1;
    }
    return m.idx[lo] as number;
  }

  /** The roster just before entry k (the head for k >= length): a checkpoint plus < 32 folds. */
  rosterBefore(k: number): Roster {
    if (k >= this.entries.length) return this.current;
    const hit = this.views.get(k);
    if (hit) return hit;
    const base = Math.floor(k / CHECKPOINT_EVERY);
    let r = this.checkpoints[base] as Roster;
    for (let i = base * CHECKPOINT_EVERY; i < k; i++) r = applyRosterEvent(r, (this.entries[i] as ChainEntry).ev);
    if (this.views.size >= VIEW_CACHE) this.views.delete(this.views.keys().next().value as number);
    this.views.set(k, r);
    return r;
  }

  /** The roster a non-roster event (origin, seq) is judged against, and whether it is anchored. */
  rosterFor(origin: string, seq: number): { roster: Roster; anchored: boolean } {
    const k = this.anchor(origin, seq);
    return k === null ? { roster: this.current, anchored: false } : { roster: this.rosterBefore(k), anchored: true };
  }

  /** Id of the chain entry that applied a roster request, if any (survives authority transfers). */
  requestEvent(requestId: string): string | undefined { return this.requests.get(requestId); }

  /** Whether `channel` was created as a project channel (its first chain entry carried `project: true`). */
  createdAsProject(channel: string): boolean {
    for (const c of this.creations) if (c.name === channel) return c.project;
    return false;
  }

  /** The handle of the member who created `channel` (its first chain entry), or null. */
  creatorOf(channel: string): string | null {
    for (const c of this.creations) if (c.name === channel) return c.creator;
    return null;
  }

  /** Channels created in the chain on `handle`'s request with ts >= since. */
  creationsBy(handle: string, since: number): number {
    let n = 0;
    for (const c of this.creations) if (c.by === handle && c.ts >= since) n++;
    return n;
  }
}

/** Builds a chain from an in-memory event set (tests, tools): every given event counts as present. */
export function buildChain(events: readonly Event[], teamId: string, opts: { verifyLicense?: LicenseVerifier } = {}): Chain {
  const chain = new Chain(teamId, opts);
  const create = events.find((e) => e.kind === "team.create" && e.team === teamId);
  if (!create) return chain;
  chain.start(create);
  const byOrigin = new Map<string, Event[]>();
  for (const e of events) if (e.kind !== "team.create" && ROSTER_KINDS.has(e.kind)) byOrigin.set(e.origin, [...(byOrigin.get(e.origin) ?? []), e]);
  chain.advance({
    rows: (o, after, upto) => (byOrigin.get(o) ?? []).filter((e) => e.seq > after && e.seq <= upto).sort((a, b) => a.seq - b.seq),
    vv: () => Number.MAX_SAFE_INTEGER,
  });
  return chain;
}
