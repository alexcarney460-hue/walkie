// The daemon's side of the relay (WALKIE-PWA-1): one outbound connection (relay-socket.ts, our own WebSocket client),
// held only while there is a paired phone or a pairing in progress. It says which protocol it speaks, claims this
// daemon's rooms, reconnects with backoff, and hands each phone's frames to the manager by slot. It never sees
// plaintext either: the tunnel (tunnel.ts) encrypts before anything reaches it.
//
// The relay is untrusted, so it can cost the daemon only a bounded amount of work:
// - version: the daemon connects to /v1/daemon?v=<RELAY_PROTOCOL> and waits for the relay's `hello {v}`; an older
//   relay is reported ("the relay is older than this Walkie") and retried only slowly, never in a loop;
// - establishment: connect + TLS + upgrade within 15 s (the transport), then hello within 5 s; a stuck attempt ends
//   and the next one is scheduled as usual, so nothing waits on it;
// - liveness: a link that heard nothing for 30 s is pinged; no answer within 20 s ends it (a dead path is noticed);
// - inbound: every frame (not just every message) pays one budget per connection the moment its header arrives, in
//   count and bytes; controls are shape- and state-checked; frames and fragmented messages are size- and
//   fragment-checked by the transport before their payload is kept; one room's excess (joins, bytes, a bad frame)
//   ends that room's phone, never the link;
// - slots carry a generation: joins, leaves, kicks and frames name it, so nothing meant for a phone that left can
//   reach (or end) the phone that got its slot next;
// - outbound: the transport counts what the kernel hasn't taken; the relay must also echo `ping {n}` (every 256 KiB
//   and when data waits: TCP is ordered, so an echo proves it read everything before). Past the window a send is
//   refused (the phone gets a 429 or a resync, the link lives: an honest relay on a slow uplink is just slow); only a
//   real stall ends the link: data outstanding and no acknowledgement progress for max(20 s, outstanding / MIN_RATE).
//   This is deliberately lenient (round 7's rule, restored in round 10 after two stricter rules cut honest slow links
//   off): an honest phone on a bad link must never be cut off, and our own relay is the only relay. Stated plainly: a
//   hostile relay can hold up to the window (the hard ceiling) for a long time, since acknowledging a little now and
//   then resets the clock; memory stays bounded by the ceiling; detection of a black-holed relay may take minutes (a
//   full 8 MiB backlog at MIN_RATE is ~68 min). MIN_RATE is only the size of that allowance, not a rate the relay is
//   held to. TCP is ordered, so no probe can overtake the backlog; an idle link is pinged. A ping's position is where
//   it was *written* (frames wait in per-room lanes drained round-robin, so write order isn't send order), and each
//   room's bytes are released exactly up to the acknowledged position. The window W is 8 MiB, or more with many rooms: every room with a phone
//   has a share ((W - IDLE_HEADROOM) / N, never less than one full frame); what rooms hold above their share now
//   (sent while fewer rooms had phones, or by a room whose phone left) is added on top of W, up to 8 MiB more, so it
//   never eats into the rooms' shares; rooms with data outstanding stay out of the idle headroom, which only a room
//   with nothing outstanding may use; small messages (errors, stream ends) may pass a room's share by 16 KiB. So an
//   idle room can always send one full frame, and data sends reserve their room before the message is sealed; reserved
//   sends, controls and small unreserved messages (a handshake reply, `revoked`) are held only to the hard ceiling or
//   to what is outstanding, whichever is more, plus the control reserve, so rooms leaving never make them fail;
// - order: a kick or a room's close goes in that room's lane, after the room's data (a revoked phone gets `revoked`);
// - diagnostics: refusals are counted and summarised at most once a minute;
// - any violation (the relay's, or its transport's: bad framing, over budget) closes the link and waits at least
//   ~30 s before reconnecting; the backoff is reset only once a link has stayed up for a minute, so a relay that
//   accepts and drops again and again is retried ever more slowly.
import { b64u, ROOM_RE, roomOf } from "../../mobile/crypto.ts";
import { MAX_CONTROL, MAX_FRAME, MAX_SLOTS, RELAY_PROTOCOL, SLOT_HEADER, type DaemonCtl } from "../../mobile/wire.ts";
import type { Logger } from "../logger.ts";
import { RateLimiter, type BucketSpec } from "../ratelimit.ts";
import { RelaySocket } from "./relay-socket.ts";

export interface RelayHandlers {
  join(room: string, slot: number): void;
  leave(slot: number): void;
  data(slot: number, frame: Uint8Array): void;
  /** A frame from this slot broke the rules (size, or its room's budget): end that phone only. */
  badFrame(slot: number): void;
  /** A room that isn't claimed again (a pairing room) was refused or dropped by the relay. */
  lost?(room: string): void;
  /** The relay speaks an older protocol than this daemon (or a newer one): shown to the person. */
  incompatible?(message: string): void;
  /** The link went down: every slot is gone. */
  down(): void;
}

export interface RelayLinkOptions {
  /** Tests: the first re-claim delay of a lost device room (default 5 s, doubling to 60 s). */
  readonly reclaimMs?: number;
  /** Tests: how long outstanding data may go without acknowledgement progress (default 20 s). */
  readonly stallMs?: number;
  /** Tests: a CA to trust for a wss:// relay. */
  readonly ca?: string;
  /** Tests: how soon the relay must say hello (default 5 s). */
  readonly helloMs?: number;
  /** Tests: connect + TLS + upgrade deadline (default 15 s). */
  readonly establishMs?: number;
  /** Tests: a link that heard nothing for this long is pinged (default 30 s). */
  readonly liveMs?: number;
  /** Tests: one inbound frame must arrive within this (default 30 s). */
  readonly frameMs?: number;
  /** Tests: the slowest acknowledgement rate tolerated for a large backlog (default MIN_RATE). */
  readonly minRate?: number;
  /** Tests: how long a link must stay up before the reconnect backoff is reset (default 60 s). */
  readonly stableMs?: number;
}

/** Room held in the window for one message before it is sealed (see `reserve`). */
export interface Reservation {
  readonly bytes: number;
  /** The bytes still counted in the window for it (0 once released, or when its connection is gone). */
  counted(): number;
  release(): void;
}

/** Why a send didn't go out: the link is down, or its window is full (the relay is behind; try less, later). */
export type SendResult = "sent" | "full" | "down";

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** After a violation the next connect waits at least 2^5 s. */
const PENALTY_ATTEMPT = 5;
/** Joins the relay may announce: 4/s, bursts of 32. */
export const JOIN_RATE: BucketSpec = { capacity: 32, perSecond: 4 };
/** Every inbound message, controls and frames alike: 400/s, bursts of 1 000 (8 phones at their request rate fit). */
export const INBOUND_RATE: BucketSpec = { capacity: 1_000, perSecond: 400 };
/** Inbound bytes: 4 MiB/s, bursts of 8 MiB. */
export const INBOUND_BYTES: BucketSpec = { capacity: 8 * MAX_FRAME, perSecond: 4 * MAX_FRAME };
/** Joins per room: 1.5/s, bursts of 8 (past it that room's phone is turned away, never the whole link). */
export const ROOM_JOIN_RATE: BucketSpec = { capacity: 8, perSecond: 1.5 };
/** Inbound bytes per room: 1 MiB/s, bursts of 3 MiB (past it that phone is dropped, never the whole link). */
export const ROOM_INBOUND_BYTES: BucketSpec = { capacity: 3 * MAX_FRAME, perSecond: MAX_FRAME };
/** Bytes sent to the relay that it hasn't acknowledged (by echoing a ping): past this a data send is refused (see windowFor). */
export const OUT_UNACKED_MAX = 8 * MAX_FRAME;
/** Controls (kicks, claims, pings) and small messages may go this far beyond the data window. */
export const CONTROL_RESERVE = 64 * 1024;
/** A room's small messages (errors, stream ends) may pass its share by this much (N x this stays within the headroom). */
export const SMALL_EXTRA = 16 * 1024;
/** A ping every this many bytes sent. */
export const PING_EVERY = 256 * 1024;
/** Kept free of busy rooms' data: an idle room can always send one full frame. */
export const IDLE_HEADROOM = MAX_FRAME + CONTROL_RESERVE;
/** The least share a room with a phone gets: one full frame (a data send needs at most MAX_FRAME + the slot header). */
export const ROOM_SHARE_MIN = MAX_FRAME + SLOT_HEADER;

/**
 * The unacknowledged window with `rooms` rooms with phones: 8 MiB, or enough for every room's least share plus the idle
 * headroom. Rooms are the daemon's own: 8 devices and 3 open pairings (~12 MiB), briefly a few more while used
 * pairings finish registering (14 rooms: ~15 MiB); bytes above the shares add at most OUT_UNACKED_MAX on top
 * (RelayLink.capacity, RelayLink.ceiling).
 */
export function windowFor(rooms: number): number {
  return Math.max(OUT_UNACKED_MAX, Math.max(1, rooms) * ROOM_SHARE_MIN + IDLE_HEADROOM);
}
/** Outstanding data (or a ping) with no acknowledgement progress for this long: a stalled relay, or a dead path. */
const STALL_MS = 20_000;
/** ...or longer while a backlog drains: outstanding / MIN_RATE (a lenient allowance, not a rate the relay is held to). */
export const MIN_RATE = 2 * 1024;
/** After a message, a ping (when none is in flight) at most this often: every reply is soon acknowledgeable. */
const PING_GAP_MS = 100;
/** A link up this long resets the reconnect backoff. */
const STABLE_MS = 60_000;
/** A link that heard nothing for this long gets a ping (answered within STALL_MS, or the link ends). */
const LIVE_MS = 30_000;
/** The relay must say `hello` this soon after the connection opens. */
const HELLO_MS = 5_000;
/** Diagnostics about the relay are summarised at most this often. */
const SUMMARY_MS = 60_000;
/** Rooms given up recently: a relay reply about one of them is a race, not a violation. */
const RECENT_MAX = 64;

const isSlot = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < MAX_SLOTS;
const isGen = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 0xffffffff;

export class RelayLink {
  private sock: RelaySocket | null = null;
  /** room -> key: the rooms to hold, re-claimed on every (re)connect. */
  private readonly keys = new Map<string, Uint8Array>();
  /** Rooms the relay confirmed on this connection. */
  private readonly confirmed = new Set<string>();
  /** Rooms this daemon gave up lately (bounded, oldest first). */
  private readonly recent = new Set<string>();
  /** Rooms to claim again when refused or lost (paired devices), and their pending re-claims. */
  private readonly persistent = new Set<string>();
  private readonly reclaims = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reclaimTries = new Map<string, number>();
  /** Waiting for a room's confirmation: resolved true on `opened`, false on `error`/`closed`/a drop. */
  private readonly waiters = new Map<string, ((ok: boolean) => void)[]>();
  /** Joined slots: their room and generation (the relay closes a room's phones without a `leave` when it goes). */
  private readonly slots = new Map<number, { room: string; gen: number }>();
  /** Budgets, fresh per connection (a reconnect after a violation waits out the penalty first). */
  private limiter = new RateLimiter();
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private wanted = false;
  /** The relay said hello with our protocol: claims and data may flow. */
  private open = false;
  /** Relay refusals and oddities since the last summary (never logged one by one). */
  private counts: Record<string, number> = {};
  private lastSummary = 0;
  /** Violations seen (tests, status). */
  violations = 0;
  /**
   * Outbound accounting for this connection (see the header): bytes queued (`sent`), bytes the kernel took, in write
   * order (`written`), and the written position the relay proved it read (`acked`).
   */
  private sent = 0;
  private written = 0;
  private acked = 0;
  private lastPingAt = 0;
  private lastPingTime = 0;
  private lastSendAt = 0;
  /** When this connection said hello (the backoff resets once it has been up STABLE_MS). */
  private upAt = 0;
  /** When acknowledgements last advanced, or outstanding data last started from none. */
  private progressAt = 0;
  /** Pings in flight, in write order: `at` is the written position just past the ping, -1 until the kernel has taken it. */
  private readonly pings = new Map<string, { at: number; time: number }>();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  /** When the relay was last heard from (any frame). */
  private heardAt = 0;
  /** Reserved, not yet sent: in total and per room (this connection only: `epoch` tells stale reservations apart). */
  private reserved = 0;
  private readonly roomReserved = new Map<string, number>();
  /** Queued or written, not yet acknowledged, per room; and the ledger (written ranges) that settles it. */
  private readonly roomOut = new Map<string, number>();
  private ledger: { start: number; end: number; room: string }[] = [];
  private ledgerHead = 0;
  private epoch = 0;

  constructor(private readonly url: string, private readonly h: RelayHandlers, private readonly log: Logger, private readonly opts: RelayLinkOptions = {}) {}

  get connected(): boolean { return this.open; }
  get rooms(): number { return this.keys.size; }
  held(room: string): boolean { return this.keys.has(room); }
  /** Bytes sent and not yet acknowledged (tests). */
  get unacked(): number { return this.sent - this.acked; }
  /** A room's bytes queued or sent and not yet acknowledged (tests). */
  outstanding(room: string): number { return this.roomOut.get(room) ?? 0; }

  /** Holds `key`'s room (connecting if needed); returns the room id. */
  async hold(key: Uint8Array, persistent = false): Promise<string> {
    const room = await roomOf(key);
    this.holdRoom(room, key, persistent);
    return room;
  }

  /**
   * Holds a room whose id the caller already computed (no await between the caller's checks and the claim).
   * `persistent` rooms (paired devices) are claimed again, with backoff, whenever the relay refuses or drops them.
   */
  holdRoom(room: string, key: Uint8Array, persistent = false): void {
    this.keys.set(room, key);
    if (persistent) this.persistent.add(room); else this.persistent.delete(room);
    this.recent.delete(room);
    if (this.open) this.ctl({ t: "open", key: b64u(key) });
    else this.start();
  }

  /** Resolves once the relay confirmed `room` (true), refused it or the link dropped (false), or after `ms` (false). */
  opened(room: string, ms: number): Promise<boolean> {
    if (this.confirmed.has(room)) return Promise.resolve(true);
    if (!this.keys.has(room)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const t = setTimeout(() => done(false), ms);
      const done = (ok: boolean) => { clearTimeout(t); resolve(ok); };
      this.waiters.set(room, [...(this.waiters.get(room) ?? []), done]);
    });
  }

  private settle(room: string, ok: boolean): void {
    const ws = this.waiters.get(room);
    this.waiters.delete(room);
    for (const w of ws ?? []) w(ok);
  }

  /** Gives a room up. */
  release(room: string): void {
    this.persistent.delete(room);
    const r = this.reclaims.get(room);
    if (r) { clearTimeout(r); this.reclaims.delete(room); }
    this.reclaimTries.delete(room);
    if (!this.keys.delete(room)) return;
    this.confirmed.delete(room);
    this.recent.add(room);
    while (this.recent.size > RECENT_MAX) this.recent.delete(this.recent.values().next().value as string);
    if (this.open) this.ctl({ t: "close", room }, room); // after the room's queued data (its phones' last messages)
    this.settle(room, false);
    this.forgetRoom(room);
  }

  /** The relay closes a released (or taken) room's phones itself: their slots are free again. */
  private forgetRoom(room: string): void {
    for (const [slot, s] of [...this.slots]) {
      if (s.room !== room) continue;
      this.slots.delete(slot);
      this.h.leave(slot);
    }
  }

  /** Whether `slot` is joined now (callers check ownership before sending or kicking). */
  joined(slot: number): boolean { return this.slots.has(slot); }

  /**
   * Sends a frame to a slot's current phone (its generation goes along: a frame for a phone that left is dropped by
   * the relay, never delivered to the next one). "full": the window is full (the relay is behind), nothing was sent;
   * `small` messages (errors, stream ends) may use the control reserve.
   */
  send(slot: number, frame: Uint8Array, small = false, reservation?: Reservation): SendResult {
    try {
      return this.sendHeld(slot, frame, small, reservation);
    } finally {
      reservation?.release(); // after the send: until then its bytes keep the window (and the transport's cap) open for it
    }
  }

  private sendHeld(slot: number, frame: Uint8Array, small: boolean, reservation?: Reservation): SendResult {
    const s = this.slots.get(slot);
    if (!this.sock || !this.open || !s) return "down";
    const out = new Uint8Array(frame.byteLength + SLOT_HEADER);
    out[0] = slot;
    new DataView(out.buffer).setUint32(1, s.gen);
    out.set(frame, SLOT_HEADER);
    // A reserved send was admitted already, and a small unreserved one (a handshake reply, `revoked`) is control-like:
    // both are held only to the hard ceiling, or to what is outstanding if more (so a window that shrank since, when
    // rooms left, can't make them fail), plus the control reserve. A data send without a reservation (never a room's
    // share) is held to the plain window.
    const limit = reservation || small ? this.controlLimit() : this.window();
    return this.raw(out, limit, s.room, s.room, reservation?.counted() ?? 0);
  }

  /** Rooms with a phone now. */
  private phoneRooms(): Set<string> { return new Set([...this.slots.values()].map((s) => s.room)); }

  /** The unacknowledged window now (windowFor the rooms with phones). */
  window(): number { return windowFor(this.phoneRooms().size); }

  /** A room's share of the window now: (window - IDLE_HEADROOM) / N for N rooms with phones, at least one full frame. */
  share(): number {
    return Math.floor((this.window() - IDLE_HEADROOM) / Math.max(1, this.phoneRooms().size));
  }

  /**
   * Bytes rooms hold above their share now, at most OUT_UNACKED_MAX: a room with a phone, what it has past its share
   * (sent while fewer rooms had phones); a room without one (its phone left), all it holds.
   */
  excess(): number {
    const phones = this.phoneRooms();
    const share = Math.floor((windowFor(phones.size) - IDLE_HEADROOM) / Math.max(1, phones.size));
    let over = 0;
    for (const room of new Set([...this.roomOut.keys(), ...this.roomReserved.keys()])) {
      const mine = (this.roomOut.get(room) ?? 0) + (this.roomReserved.get(room) ?? 0);
      over += phones.has(room) ? Math.max(0, mine - share) : mine;
    }
    return Math.min(over, OUT_UNACKED_MAX);
  }

  /** What may be outstanding now: the window, plus what rooms hold above their shares (so it never eats the shares). */
  capacity(): number { return this.window() + this.excess(); }

  /** The hard ceiling: nothing but controls ever goes past it (the transport's queue cap follows it). */
  ceiling(): number { return this.window() + OUT_UNACKED_MAX; }

  /** Controls, reserved sends and small unreserved ones: the hard ceiling, or what is outstanding if more, plus the reserve. */
  private controlLimit(): number { return Math.max(this.ceiling(), this.sent - this.acked + this.reserved) + CONTROL_RESERVE; }

  /** Whether `bytes` more (plus the slot header) fit under `limit` and the transport right now. */
  private fits(need: number, limit: number): boolean {
    const sock = this.sock;
    if (!sock || !this.open) return false;
    return this.sent - this.acked + this.reserved + need <= limit && sock.queued + this.reserved + need + 64 <= this.ceiling() + 2 * CONTROL_RESERVE;
  }

  /**
   * Holds room for one message to `slot` before it is sealed: in the window and in the slot's room's share. null: the
   * link is behind for this room (or down); nothing was held. Checking and holding happen together, so concurrent
   * senders can't both pass one check; the holder sends with the reservation (or releases it).
   */
  reserve(slot: number, bytes: number, small = false): Reservation | null {
    const s = this.slots.get(slot);
    if (!s) return null;
    const need = bytes + SLOT_HEADER;
    const mine = (this.roomOut.get(s.room) ?? 0) + (this.roomReserved.get(s.room) ?? 0);
    const capacity = this.capacity();
    // Every room, its first frame included, stays within its share (at least one full frame; small messages may pass
    // it by SMALL_EXTRA); rooms with data outstanding together stay out of the idle headroom, which only a room with
    // nothing outstanding may use. What rooms hold above their shares is on top of the window (capacity), so every
    // other room being within its share, an idle room's share is always free: one full frame always fits.
    if (mine + need > this.share() + (small ? SMALL_EXTRA : 0)) { this.note("room share full"); return null; }
    const limit = small ? capacity + CONTROL_RESERVE : mine > 0 ? capacity - IDLE_HEADROOM : capacity;
    if (!this.fits(need, limit)) { this.note("window full"); return null; }
    this.reserved += need;
    this.roomReserved.set(s.room, (this.roomReserved.get(s.room) ?? 0) + need);
    const epoch = this.epoch;
    const room = s.room;
    let held = true;
    return {
      bytes: need,
      counted: () => (held && epoch === this.epoch ? need : 0),
      release: () => {
        if (!held) return;
        held = false;
        if (epoch !== this.epoch) return; // the connection it was made on is gone (and its accounting with it)
        this.reserved -= need;
        const left = (this.roomReserved.get(room) ?? 0) - need;
        if (left > 0) this.roomReserved.set(room, left); else this.roomReserved.delete(room);
      },
    };
  }

  kick(slot: number): void {
    const s = this.slots.get(slot);
    if (!s) return;
    this.slots.delete(slot);
    // In the room's lane: after what was queued for the room (a revoked phone reads `revoked` before it is kicked).
    if (this.open) this.ctl({ t: "kick", slot, gen: s.gen }, s.room);
  }

  /**
   * Every send goes through here: counted, held to the acknowledged window, queued in its room's lane. A ping follows
   * every PING_EVERY bytes, and after a phone message whenever none is in flight (at most every PING_GAP_MS), so even
   * one large reply on a slow uplink is acknowledged as soon as it is read.
   */
  private raw(data: Uint8Array | string, limit: number, room?: string, lane = room ?? "", held = 0): SendResult {
    const sock = this.sock;
    if (!sock || !sock.isOpen) return "down";
    const size = typeof data === "string" ? data.length : data.byteLength; // controls are ASCII JSON
    // `held`: this send's own reservation, still counted in `reserved` until the send returns (not counted twice).
    if (this.sent - this.acked + this.reserved - held + size > limit) { this.note("window full"); return "full"; }
    const epoch = this.epoch;
    if (!sock.send(data, lane, () => { if (epoch === this.epoch) this.wrote(size, room); })) { this.note("transport full"); return "full"; }
    const now = Date.now();
    if (this.sent === this.acked) this.progressAt = now; // outstanding data starts now
    this.sent += size;
    if (room) this.roomOut.set(room, (this.roomOut.get(room) ?? 0) + size);
    this.lastSendAt = now;
    if (this.sent - this.lastPingAt >= PING_EVERY || (room && !this.pings.size && now - this.lastPingTime >= PING_GAP_MS)) this.ping();
    return "sent";
  }

  private ping(): void {
    const sock = this.sock;
    if (!sock || !this.open || this.pings.size >= 64) return;
    const n = b64u(globalThis.crypto.getRandomValues(new Uint8Array(12)));
    const text = JSON.stringify({ t: "ping", n } satisfies DaemonCtl);
    const epoch = this.epoch;
    // Its position is fixed when the kernel takes it (write order): until then a pong for it is a violation.
    this.pings.set(n, { at: -1, time: Date.now() });
    const ok = sock.send(text, "", () => {
      if (epoch !== this.epoch) return;
      this.wrote(text.length);
      const p = this.pings.get(n);
      if (p) p.at = this.written;
    });
    if (!ok) { this.pings.delete(n); return; } // the transport is full: the stall check decides
    if (this.sent === this.acked) this.progressAt = Date.now(); // outstanding starts now
    this.sent += text.length;
    this.lastPingAt = this.sent;
    this.lastPingTime = Date.now();
  }

  /** The kernel took `size` more bytes; a room's range is recorded for settling (adjacent ranges of one room merge). */
  private wrote(size: number, room?: string): void {
    const start = this.written;
    this.written += size;
    if (!room) return;
    const last = this.ledger[this.ledger.length - 1];
    if (last && this.ledger.length > this.ledgerHead && last.room === room && last.end === start) { last.end = this.written; return; }
    this.ledger.push({ start, end: this.written, room });
  }

  /** The relay read everything up to written position `at`: each room's bytes before it are released, exactly. */
  private settleLedger(at: number): void {
    while (this.ledgerHead < this.ledger.length) {
      const e = this.ledger[this.ledgerHead] as { start: number; end: number; room: string };
      if (e.start >= at) break;
      const upto = Math.min(e.end, at);
      const left = (this.roomOut.get(e.room) ?? 0) - (upto - e.start);
      if (left > 0) this.roomOut.set(e.room, left); else this.roomOut.delete(e.room);
      if (upto < e.end) { e.start = upto; break; } // partly read: the rest stays charged
      this.ledgerHead += 1;
    }
    if (this.ledgerHead > 1024 && this.ledgerHead * 2 > this.ledger.length) {
      this.ledger = this.ledger.slice(this.ledgerHead);
      this.ledgerHead = 0;
    }
  }

  /**
   * Once a second: outstanding data with no acknowledgement progress for max(STALL_MS, outstanding / MIN_RATE) ends
   * the link: a violation while phone data is held (the relay made us keep it), else a dead path (plain reconnect).
   * Idle data gets a ping, and so does a link that heard nothing for LIVE_MS (liveness).
   */
  private check(): void {
    if (!this.open) return;
    const now = Date.now();
    if (this.attempt && now - this.upAt >= (this.opts.stableMs ?? STABLE_MS)) this.attempt = 0; // a stable link
    const out = this.sent - this.acked;
    const allowed = Math.max(this.opts.stallMs ?? STALL_MS, (out * 1000) / (this.opts.minRate ?? MIN_RATE));
    if (out > 0 && now - this.progressAt > allowed) {
      if (this.roomOut.size) this.violation("relay stopped reading"); // phone data held: the relay made us keep it
      else this.dead("relay stopped answering"); // only controls or pings: a dead path
      return;
    }
    if (!this.pings.size && this.sent > this.acked && now - this.lastSendAt > 500) this.ping();
    else if (!this.pings.size && now - this.heardAt >= (this.opts.liveMs ?? LIVE_MS)) this.ping();
  }

  /** The path went quiet (no answer to a ping): drop the link and reconnect with the usual backoff. */
  private dead(reason: string): void {
    this.log.warn("mobile_relay_down", { reason });
    const sock = this.sock;
    this.sock = null;
    this.drop();
    sock?.close(1001, reason);
    this.retry();
  }

  /** The relay broke the protocol: drop the link, forget its slots, and come back no sooner than the penalty. */
  violation(reason: string): void {
    const sock = this.sock;
    this.sock = null;
    this.drop();
    sock?.close(4400, "protocol violation");
    this.penalize(reason);
  }

  /** Counts a violation (at most once per connection: the link ends with it) and holds the next connect back. */
  private penalize(reason: string): void {
    this.violations += 1;
    this.log.warn("mobile_relay_violation", { reason });
    this.attempt = Math.max(this.attempt, PENALTY_ATTEMPT);
    this.retry();
  }

  /** Closes the link and stops reconnecting (until the next hold). */
  stop(): void {
    this.wanted = false;
    this.keys.clear();
    this.persistent.clear();
    for (const r of this.reclaims.values()) clearTimeout(r);
    this.reclaims.clear();
    this.reclaimTries.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const sock = this.sock;
    this.sock = null;
    this.drop();
    sock?.close(1000, "done");
  }

  private drop(): void {
    const was = this.open;
    this.open = false;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    this.pings.clear();
    this.sent = 0;
    this.written = 0;
    this.acked = 0;
    this.lastPingAt = 0;
    this.lastPingTime = 0;
    this.epoch += 1;
    this.reserved = 0;
    this.roomReserved.clear();
    this.roomOut.clear();
    this.ledger = [];
    this.ledgerHead = 0;
    this.slots.clear();
    this.confirmed.clear();
    for (const room of [...this.waiters.keys()]) this.settle(room, false);
    this.summarize(); // the once-a-minute limit holds across drops; counts carry over to the next summary
    if (was) this.h.down();
  }

  /** Counts a relay oddity; one summary line at most every minute. */
  private note(kind: string): void {
    this.counts[kind] = (this.counts[kind] ?? 0) + 1;
    this.summarize();
  }

  private summarize(): void {
    const now = Date.now();
    if (!Object.keys(this.counts).length || now - this.lastSummary < SUMMARY_MS) return;
    this.lastSummary = now;
    this.log.warn("mobile_relay_notes", { ...this.counts });
    this.counts = {};
  }

  private start(): void {
    this.wanted = true;
    if (this.sock || this.timer) return;
    this.connect();
  }

  private connect(): void {
    this.timer = null;
    if (!this.wanted) return;
    this.limiter = new RateLimiter();
    const sock: RelaySocket = RelaySocket.connect(`${this.url}/v1/daemon?v=${RELAY_PROTOCOL}`, {
      open: () => {
        if (this.sock !== sock) return;
        // The relay must say which protocol it speaks before anything else.
        this.helloTimer = setTimeout(() => this.incompatible("the relay didn't say which protocol it speaks: it is older than this Walkie"), this.opts.helloMs ?? HELLO_MS);
        (this.helloTimer as { unref?: () => void }).unref?.();
      },
      text: (s) => { if (this.sock === sock) this.onCtl(s); },
      binary: (b) => { if (this.sock === sock) this.onFrame(b); },
      close: (code, reason, violation) => {
        if (this.sock !== sock) return;
        this.sock = null;
        const wasOpen = this.open;
        this.drop();
        if (code === 4426) { this.incompatible("the relay refused this Walkie's protocol version: it is newer or older than this Walkie"); return; }
        // The transport ended it for the relay's misbehaviour (framing, sizes, the frame budget): same penalty as ours.
        if (violation) { this.penalize(`transport: ${reason}`); return; }
        if (this.wanted) {
          if (wasOpen) this.log.warn("mobile_relay_down", { code });
          this.retry();
        }
      },
    }, {
      maxText: MAX_CONTROL, maxBinary: MAX_FRAME + SLOT_HEADER,
      maxQueued: () => Math.max(this.ceiling(), this.sent - this.acked + this.reserved) + 2 * CONTROL_RESERVE,
      // Every frame pays the connection's budget as its header arrives (count and bytes), before any payload is kept.
      onFrame: (size) => this.sock === sock && this.budget(size),
      ...(this.opts.establishMs ? { establishMs: this.opts.establishMs } : {}),
      ...(this.opts.frameMs ? { frameMs: this.opts.frameMs } : {}),
      ...(this.opts.ca ? { ca: this.opts.ca } : {}),
    });
    this.sock = sock;
  }

  /** The relay speaks another protocol: say so, and try again only slowly (a relay upgrade fixes it). */
  private incompatible(message: string): void {
    this.log.warn("mobile_relay_incompatible", { message });
    this.h.incompatible?.(message);
    const sock = this.sock;
    this.sock = null;
    this.drop();
    sock?.close(1000, "incompatible");
    this.attempt = Math.max(this.attempt, 6); // ≥ 60 s between tries
    this.retry();
  }

  /** Every inbound frame pays before its payload is kept (false: the transport ends the link as a violation). */
  private budget(size: number): boolean {
    this.heardAt = Date.now();
    return this.limiter.take("in", INBOUND_RATE) && this.limiter.take("in-bytes", INBOUND_BYTES, this.heardAt, size);
  }

  private onFrame(data: Uint8Array): void {
    if (!this.open) { this.violation("data before hello"); return; }
    if (data.byteLength < SLOT_HEADER) { this.violation("frame without a slot header"); return; }
    const slot = data[0] as number;
    const gen = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1);
    const s = this.slots.get(slot);
    if (!s || s.gen !== gen) { this.note("frame for no slot"); return; } // a phone that left: dropped, never copied
    const payload = data.subarray(SLOT_HEADER);
    if (payload.byteLength < 1 || payload.byteLength > MAX_FRAME) { this.h.badFrame(slot); return; } // that phone only
    if (!this.limiter.take(`in-bytes:${s.room}`, ROOM_INBOUND_BYTES, Date.now(), payload.byteLength)) {
      this.note("room byte limit");
      this.h.badFrame(slot); // that room's phone, not the link
      return;
    }
    this.h.data(slot, payload);
  }

  private retry(): void {
    if (!this.wanted || this.timer) return;
    const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt++);
    this.timer = setTimeout(() => this.connect(), Math.round(exp * (0.8 + Math.random() * 0.4)));
    (this.timer as { unref?: () => void }).unref?.();
  }

  /**
   * The relay refused or dropped a room we hold (another holder, or a limit). A paired device's room is claimed again
   * with backoff (5 s doubling to 60 s) and the loss is reported in the summary; any other room is let go.
   */
  private lost(room: string, why: string): void {
    this.confirmed.delete(room);
    this.forgetRoom(room);
    this.settle(room, false);
    this.note(why);
    if (!this.keys.has(room) || !this.persistent.has(room)) {
      const had = this.keys.delete(room);
      this.persistent.delete(room);
      if (had) this.h.lost?.(room);
      return;
    }
    if (this.reclaims.has(room)) return;
    const n = this.reclaimTries.get(room) ?? 0;
    this.reclaimTries.set(room, n + 1);
    const timer = setTimeout(() => {
      this.reclaims.delete(room);
      const key = this.keys.get(room);
      if (key && this.open) this.ctl({ t: "open", key: b64u(key) });
    }, Math.min(60_000, (this.opts.reclaimMs ?? 5_000) * 2 ** n));
    (timer as { unref?: () => void }).unref?.();
    this.reclaims.set(room, timer);
  }

  /** A room the relay may talk about: held now, or given up a moment ago. */
  private known(room: string): boolean { return this.keys.has(room) || this.recent.has(room); }

  private onCtl(text: string): void {
    let m: Record<string, unknown>;
    try {
      const v = JSON.parse(text) as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
      m = v as Record<string, unknown>;
    } catch {
      this.violation("control not JSON");
      return;
    }
    if (!this.open) {
      if (m.t !== "hello") { this.violation("control before hello"); return; }
      if (m.v !== RELAY_PROTOCOL) {
        this.incompatible(typeof m.v === "number" && m.v < RELAY_PROTOCOL
          ? "the relay is older than this Walkie: update the relay"
          : "the relay is newer than this Walkie: update Walkie (walkie update)");
        return;
      }
      if (this.helloTimer) clearTimeout(this.helloTimer);
      this.helloTimer = null;
      this.open = true;
      this.pings.clear();
      this.heardAt = Date.now();
      this.upAt = this.heardAt;
      this.watchdog = setInterval(() => this.check(), 1_000);
      (this.watchdog as { unref?: () => void }).unref?.();
      this.log.info("mobile_relay_up", { rooms: this.keys.size });
      for (const key of this.keys.values()) this.ctl({ t: "open", key: b64u(key) });
      return;
    }
    const room = typeof m.room === "string" && ROOM_RE.test(m.room) ? m.room : null;
    switch (m.t) {
      case "join": {
        if (!room || !isSlot(m.slot) || !isGen(m.gen)) { this.violation("bad join"); return; }
        if (this.slots.has(m.slot)) { this.violation("join for a slot in use"); return; }
        if (!this.known(room)) { this.violation("join for a room never held"); return; }
        if (!this.limiter.take("join", JOIN_RATE)) { this.violation("too many joins"); return; }
        this.slots.set(m.slot, { room, gen: m.gen });
        // One room's churn is that room's problem: its phone is turned away, the link and other rooms carry on.
        if (!this.limiter.take(`join:${room}`, ROOM_JOIN_RATE)) { this.note("room join limit"); this.kick(m.slot); return; }
        // A room given up a moment ago (release racing a phone's connect): turn the phone away.
        if (this.keys.has(room)) this.h.join(room, m.slot); else this.kick(m.slot);
        return;
      }
      case "leave": {
        if (!isSlot(m.slot) || !isGen(m.gen)) { this.violation("bad leave"); return; }
        const s = this.slots.get(m.slot);
        if (s && s.gen === m.gen) { this.slots.delete(m.slot); this.h.leave(m.slot); } else this.note("leave for no slot");
        return;
      }
      case "pong": {
        const at = typeof m.n === "string" ? this.pings.get(m.n)?.at : undefined;
        if (at === undefined || at < 0) { this.violation("pong for no ping"); return; } // unknown, or not even written
        if (at > this.acked) { this.acked = at; this.progressAt = Date.now(); this.settleLedger(at); }
        for (const [n, p] of [...this.pings]) { if (p.at < 0 || p.at > at) break; this.pings.delete(n); }
        return;
      }
      case "opened": {
        if (!room || !this.known(room)) { this.violation("opened for a room never held"); return; }
        // (the reconnect backoff resets only once the link has stayed up: see check())
        if (this.keys.has(room)) { this.confirmed.add(room); this.reclaimTries.delete(room); this.settle(room, true); }
        return;
      }
      case "closed": {
        if (!room || !this.known(room)) { this.violation("closed for a room never held"); return; }
        this.lost(room, "room closed by the relay");
        return;
      }
      case "error": {
        if (m.room !== undefined && (!room || !this.known(room))) { this.violation("error for a room never held"); return; }
        if (room) this.lost(room, "room refused by the relay"); else this.note("relay error");
        return;
      }
      default:
        this.violation("unknown control");
    }
  }

  /**
   * Controls go through the same accounting, with the reserve on top of the hard ceiling (or of what is outstanding, if
   * more: a kick or a close is never refused because rooms left); slot- or room-scoped ones in that room's lane.
   */
  private ctl(msg: DaemonCtl, lane = ""): void {
    if (this.raw(JSON.stringify(msg), this.controlLimit(), undefined, lane) === "full") this.note(`${msg.t} not sent`);
  }
}
