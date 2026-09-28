// The dashboard's live connection to GET /v1/stream (WALKIE-LIVE-1), outside React so it can be tested.
// - The agent roster arrives as one snapshot, then deltas chained by revision; a broken chain reconnects (the new
//   stream starts with a fresh snapshot), so a missed delta can't leave a row stale.
// - "Live" means data is arriving: the daemon sends a heartbeat every 15 s, so a stream silent for STALL_MS is
//   treated as dead and replaced, instead of showing Live over a connection that no longer delivers.
// - Reconnects back off (jittered, exponential); a 401 means the session ended, which retrying can't fix.
import { ApiError } from "../api/client.ts";
import type { BoardDelta, Event, StreamMessage } from "../api/types.ts";
import type { Action, ConnReason } from "./reducer.ts";

/** Three missed daemon heartbeats (15 s apart) and a little slack. */
export const STALL_MS = 35_000;
const CHECK_MS = 5_000;
/**
 * A connection counts as healthy (backoff starts over) only after it stayed open this long: a daemon that accepts and
 * drops the stream at once must not get a retry every second from every dashboard (Codex r1 #6).
 */
export const STABLE_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export function backoff(attempt: number): number {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(exp * (0.8 + Math.random() * 0.4));
}

export type StreamFn = (onOpen: () => void, onMessage: (type: string, data: string) => void, onData: () => void, signal: AbortSignal) => Promise<void>;

export interface LiveDeps {
  stream: StreamFn;
  dispatch: (a: Action) => void;
  /** After a reconnect: refetch what the stream doesn't resend (the stream's first frames carry roster and nodes). */
  resync: () => Promise<void>;
  /** Resolves while the session is good; rejects with a 401 ApiError when it ended. */
  checkSession: () => Promise<unknown>;
  onSignedOut: (err: ApiError) => void;
  onEvent?: (e: Event) => void;
  onNoTeam?: () => void;
  /** A project's board changed (WALKIE-PROJECTS-1): forwarded to state/projects.ts. */
  onBoard?: (d: BoardDelta) => void;
  now?: () => number;
  stallMs?: number;
  checkMs?: number;
  backoff?: (attempt: number) => number;
  stableMs?: number;
}

export class LiveStream {
  private ac: AbortController | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private attempt = 0;
  /** When the current stream was accepted (null: none open). */
  private openedAt: number | null = null;
  private closed = false;
  private hadConnection = false;
  private live = false;
  private lastData = 0;
  /** The roster revision this client holds (null: none yet on this stream). */
  private rev: number | null = null;
  /** Gaps since a delta last applied: a daemon that keeps breaking the chain gets backoff, not a hot loop. */
  private gaps = 0;
  private readonly now: () => number;
  private readonly stallMs: number;
  private readonly delay: (attempt: number) => number;

  constructor(private readonly d: LiveDeps) {
    this.now = d.now ?? Date.now;
    this.stallMs = d.stallMs ?? STALL_MS;
    this.delay = d.backoff ?? backoff;
  }

  start(): void {
    this.connect();
    this.watchdog = setInterval(() => this.check(), this.d.checkMs ?? CHECK_MS);
  }

  stop(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.watchdog) clearInterval(this.watchdog);
    const ac = this.ac;
    this.ac = null;
    ac?.abort();
  }

  /** The network came back: connect now instead of waiting out the backoff. */
  wake(): void {
    if (this.closed || this.ac) return;
    if (this.retry) clearTimeout(this.retry);
    this.connect();
  }

  /** Replaces a stream that has gone silent (also run when a hidden page becomes visible again). */
  check(): void {
    if (!this.closed && this.live && this.now() - this.lastData > this.stallMs) this.restart("stalled");
  }

  private restart(reason: ConnReason): void {
    const old = this.ac;
    this.ac = null;
    this.live = false;
    this.rev = null;
    this.openedAt = null;
    old?.abort();
    if (this.retry) clearTimeout(this.retry);
    if (reason === "gap" && ++this.gaps > 1) {
      const delay = this.delay(this.gaps - 2);
      this.d.dispatch({ type: "conn", conn: { status: "reconnecting", attempt: this.attempt, retryAt: this.now() + delay, reason } });
      this.retry = setTimeout(() => this.connect(reason), delay);
      return;
    }
    this.connect(reason);
  }

  private connect(reason?: ConnReason): void {
    if (this.closed) return;
    const first = this.attempt === 0 && !this.hadConnection;
    this.d.dispatch({ type: "conn", conn: { status: first ? "connecting" : "reconnecting", attempt: this.attempt, retryAt: null, ...(reason ? { reason } : {}) } });
    const mine = new AbortController();
    this.ac = mine;
    const current = () => this.ac === mine && !this.closed;
    const onOpen = () => {
      if (!current()) return;
      if (this.hadConnection || this.attempt > 0) void this.d.resync().catch(() => { /* the next reconnect tries again */ });
      this.hadConnection = true;
      this.openedAt = this.now();
      this.live = true;
      this.lastData = this.now();
      this.d.dispatch({ type: "conn", conn: { status: "live", attempt: 0, retryAt: null } });
    };
    const onData = () => { if (current()) this.lastData = this.now(); };
    const onMessage = (_type: string, data: string) => { if (current()) this.handle(data); };
    const ended = (err: unknown) => {
      if (!current()) return; // replaced (stall, gap) or stopped: that path already moved on
      this.ac = null;
      this.live = false;
      this.rev = null;
      if (this.signedOut(err)) return;
      const opened = this.openedAt;
      this.openedAt = null;
      if (opened !== null && this.now() - opened >= (this.d.stableMs ?? STABLE_MS)) this.attempt = 0; // it was healthy
      const delay = this.delay(this.attempt);
      this.attempt += 1;
      this.d.dispatch({ type: "conn", conn: { status: "reconnecting", attempt: this.attempt, retryAt: this.now() + delay, reason: err ? "error" : "closed" } });
      this.retry = setTimeout(() => this.connect(), delay);
      void this.d.checkSession().catch((e) => this.signedOut(e));
    };
    this.d.stream(onOpen, onMessage, onData, mine.signal).then(() => ended(null), ended);
  }

  /** A signed-out or expired session won't come back by retrying: stop and say so. */
  private signedOut(err: unknown): boolean {
    if (this.closed || !(err instanceof ApiError) || err.status !== 401) return false;
    this.stop();
    this.d.onSignedOut(err);
    return true;
  }

  private handle(data: string): void {
    let msg: StreamMessage;
    try {
      msg = JSON.parse(data) as StreamMessage;
    } catch {
      return;
    }
    const { dispatch } = this.d;
    switch (msg.type) {
      case "event":
        dispatch({ type: "events", events: [msg.event] });
        this.d.onEvent?.(msg.event);
        return;
      case "agents":
        this.rev = msg.rev ?? null;
        dispatch({ type: "agents", agents: msg.agents, archive: msg.archive ?? [], archiveRev: msg.archive_rev ?? null });
        return;
      case "agents.delta":
        // A delta applies only to the revision it was computed from; anything else means a frame was missed.
        if (this.rev === null || msg.base !== this.rev) { this.restart("gap"); return; }
        this.rev = msg.rev;
        this.gaps = 0;
        dispatch({ type: "agents/delta", upsert: msg.upsert, remove: msg.remove, archive: msg.archive, archiveRev: msg.archive_rev ?? null });
        return;
      case "nodes":
        dispatch({ type: "nodes", nodes: msg.nodes });
        return;
      case "accounts":
        dispatch({ type: "accounts", accounts: msg.accounts });
        return;
      // This machine's orchestrator (dashboard sessions only: the hub's publishLocal).
      case "orchestrator":
        dispatch({ type: "orch/live", live: msg.live });
        return;
      case "orchestrator_message":
        dispatch({ type: "orch/messages", messages: [msg.message] });
        return;
      case "hidden":
        dispatch({ type: "events/hidden", ids: msg.ids });
        return;
      case "board":
        this.d.onBoard?.(msg);
        return;
      case "hello":
        dispatch({ type: "me", me: msg.me });
        if (!msg.me.team) this.d.onNoTeam?.();
        return;
      default:
        return;
    }
  }
}
