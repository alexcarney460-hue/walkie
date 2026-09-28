// Dashboard login sessions (WALKIE-SEC-COOKIE-1/2). The session is never the durable local.token, and never a
// cookie: browsers send 127.0.0.1 cookies to every port (RFC 6265 §8.5), so a cookie reaches any other loopback
// listener. The login hands the value to the page in the URL fragment; the page keeps it in its own origin's
// storage (port-isolated) and sends it as X-Walkie-Session. Stored by sha256, so the values themselves never sit in the
// daemon's heap map or on disk. With `persist` (the daemon: the store's meta, LIVE-2), the hashes survive a daemon
// restart (an upgrade no longer signs every dashboard out); logout and token rotation still end them all, on disk too.
import { createHash, randomBytes } from "node:crypto";

/** A session ends after this long without a request (while no dashboard stream is open). */
export const SESSION_IDLE_MS = 12 * 60 * 60_000;
/** ...and this long after login, whatever its use. */
export const SESSION_MAX_MS = 7 * 24 * 60 * 60_000;
const SESSION_MAX = 64;

export interface Session {
  /** The Host header the session was issued for; it is only accepted on that Host. */
  readonly host: string;
  readonly createdAt: number;
  /** createdAt + SESSION_MAX_MS: the session is over at this instant, whatever its use or open streams. */
  readonly expiresAt: number;
  /** Aborted when the session ends (logout, expiry, rotation): open streams close with it. */
  readonly signal: AbortSignal;
}

interface Entry extends Session {
  lastSeen: number;
  streams: number;
  readonly abort: AbortController;
}

/** Where the sessions' hashes are kept between daemon runs (one JSON value; null clears it). */
export interface SessionPersistence {
  load(): string | null;
  save(value: string | null): void;
}

export interface SessionOptions {
  now?: () => number; max?: number; persist?: SessionPersistence;
  /**
   * The credential generation the saved sessions belong to (the daemon: a fingerprint of local.token). Saved sessions
   * of another generation are never restored, so a token rotation ends them even if clearing them on disk failed
   * (Codex r1 #2).
   */
  generation?: string;
}

/** A session's lastSeen is written back at most this often (a request per second must not mean a write per second). */
export const SESSION_PERSIST_EVERY_MS = 60_000;
/**
 * A session with an open stream counts as in use: its saved lastSeen is moved to now at least this often (sweep) and at
 * shutdown, so a dashboard left open all day isn't signed out by the next restart for looking 12 h idle (LIVE-3).
 */
export const SESSION_STREAM_REFRESH_MS = 10 * 60_000;

interface Saved { h: string; host: string; c: number; e: number; l: number }

const hash = (v: string): string => createHash("sha256").update(v).digest("hex");

export class DashboardSessions {
  private readonly byHash = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly max: number;
  private readonly persist: SessionPersistence | null;
  private generation: string;
  /** When each session's lastSeen was last written (by hash). */
  private readonly savedSeen = new Map<string, number>();

  constructor(opts: SessionOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.max = opts.max ?? SESSION_MAX;
    this.persist = opts.persist ?? null;
    this.generation = opts.generation ?? "";
    this.restore();
  }

  /** Sessions a previous daemon run saved: well-formed, unexpired ones only (a bad value is dropped, not trusted). */
  private restore(): void {
    if (!this.persist) return;
    let list: unknown = [];
    try {
      const saved = JSON.parse(this.persist.load() ?? "null") as { g?: unknown; s?: unknown } | null;
      // Only this credential generation's sessions (anything else, or an unknown shape, restores nothing).
      if (saved && typeof saved === "object" && !Array.isArray(saved) && saved.g === this.generation) list = saved.s;
    } catch {
      list = [];
    }
    const now = this.now();
    for (const r of Array.isArray(list) ? (list as Partial<Saved>[]).slice(-this.max) : []) {
      const ok = typeof r?.h === "string" && /^[0-9a-f]{64}$/.test(r.h) && typeof r.host === "string" && r.host.length <= 300
        && Number.isFinite(r.c) && Number.isFinite(r.e) && Number.isFinite(r.l) && (r.e as number) <= (r.c as number) + SESSION_MAX_MS;
      if (!ok) continue;
      const abort = new AbortController();
      const e: Entry = { host: r.host as string, createdAt: r.c as number, expiresAt: r.e as number, lastSeen: r.l as number, streams: 0, abort, signal: abort.signal };
      if (this.expired(e)) continue;
      this.byHash.set(r.h as string, e);
      this.savedSeen.set(r.h as string, e.lastSeen);
    }
    this.save(true);
  }

  /**
   * Writes the sessions. A failure throws (a logout or token rotation must not report success while the hashes stay on
   * disk: Opus r1 LOW); `quiet` only for startup, the background sweep and shutdown, where there is no caller to tell.
   */
  private save(quiet = false): void {
    if (!this.persist) return;
    const list: Saved[] = [...this.byHash].map(([h, e]) => ({ h, host: e.host, c: e.createdAt, e: e.expiresAt, l: e.lastSeen }));
    try {
      this.persist.save(list.length ? JSON.stringify({ g: this.generation, s: list }) : null);
    } catch (err) {
      if (!quiet) throw err;
      return;
    }
    for (const r of list) this.savedSeen.set(r.h, r.l);
  }

  get size(): number { return this.byHash.size; }

  /** The stored keys (hashes), for tests: the session values are never among them. */
  storedKeys(): string[] { return [...this.byHash.keys()]; }

  /** A new session for `host`: 256 random bits, hex. The oldest session is dropped beyond the cap. */
  create(host: string): string {
    this.sweep();
    while (this.byHash.size >= this.max) this.end(this.byHash.keys().next().value as string);
    const value = randomBytes(32).toString("hex");
    const now = this.now();
    const abort = new AbortController();
    this.byHash.set(hash(value), { host, createdAt: now, expiresAt: now + SESSION_MAX_MS, lastSeen: now, streams: 0, abort, signal: abort.signal });
    this.save();
    return value;
  }

  /** The live session for this value on this Host (and slides its idle window), or null. */
  check(value: string, host: string): Session | null {
    if (!/^[0-9a-f]{64}$/.test(value)) return null;
    const key = hash(value);
    const e = this.byHash.get(key);
    if (!e) return null;
    if (this.expired(e)) { this.end(key); return null; }
    if (e.host !== host) return null;
    e.lastSeen = this.now();
    if (this.persist && e.lastSeen - (this.savedSeen.get(key) ?? 0) >= SESSION_PERSIST_EVERY_MS) this.save();
    return e;
  }

  /** Marks a long-lived response (SSE) open on the session; the returned function marks it closed. */
  openStream(s: Session): () => void {
    const e = s as Entry;
    e.streams += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      e.streams -= 1;
      e.lastSeen = this.now();
    };
  }

  revoke(value: string): boolean {
    const key = hash(value);
    if (!this.byHash.has(key)) return false;
    this.end(key);
    return true;
  }

  /** The credential changed (token rotation): sessions saved from now on belong to `g`; call revokeAll after. */
  setGeneration(g: string): void {
    this.generation = g;
  }

  revokeAll(): number {
    const n = this.byHash.size;
    for (const key of [...this.byHash.keys()]) this.end(key, false);
    this.save();
    return n;
  }

  /**
   * The daemon is stopping: open streams end, but saved sessions stay valid for the next run (their lastSeen is written
   * first). Without persistence this is revokeAll.
   */
  close(): void {
    const now = this.now();
    for (const e of this.byHash.values()) if (e.streams > 0) e.lastSeen = now; // open right up to the restart: in use
    this.save(true);
    for (const e of this.byHash.values()) e.abort.abort();
    this.byHash.clear();
  }

  /** Ends expired sessions (and their open streams). */
  sweep(): void {
    let changed = false;
    const now = this.now();
    for (const [key, e] of [...this.byHash]) {
      if (this.expired(e)) { this.end(key, false); changed = true; continue; }
      if (e.streams > 0 && now - (this.savedSeen.get(key) ?? 0) >= SESSION_STREAM_REFRESH_MS) { e.lastSeen = now; changed = true; }
    }
    if (changed) this.save(true);
  }

  private expired(e: Entry): boolean {
    const now = this.now();
    if (now >= e.expiresAt) return true;
    return e.streams === 0 && now - e.lastSeen >= SESSION_IDLE_MS;
  }

  private end(key: string, persist = true): void {
    const e = this.byHash.get(key);
    this.byHash.delete(key);
    this.savedSeen.delete(key);
    e?.abort.abort();
    if (persist) this.save();
  }
}
