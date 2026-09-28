// walkie-relay (WALKIE-PWA-1): forwards opaque, end-to-end encrypted frames between a daemon and its paired phones.
// No storage, no accounts, no logging of frames, rooms or addresses; everything lives in memory for as long as the
// sockets are open. It can't read or forge what it forwards (src/mobile/crypto.ts), so what it must protect is its
// own availability: every connection has a message and a byte budget, every address a connection cap and a connect
// rate, frames are capped at 1 MiB, a room holds at most 4 phones, and a slow reader is dropped at the backpressure
// limit instead of buffering without bound.
//
//   GET /healthz                       200 "ok"
//   WS  /v1/daemon                     a daemon; claims rooms with {t:"open", key}
//   WS  /v1/phone?room=<22 chars>      a phone, into a room a daemon holds (else closed 4404)
//
// Run: bun src/relay/server.ts (PORT, default 8080; RELAY_TRUST_FLY=1 on Fly to key limits on Fly-Client-IP).
import type { Server, ServerWebSocket } from "bun";
import { roomOf, ROOM_RE, unb64u } from "../mobile/crypto.ts";
import {
  CLOSE, MAX_CONTROL, MAX_FRAME, MAX_PHONES_PER_ROOM, MAX_ROOMS_PER_DAEMON, MAX_SLOTS, RELAY_PROTOCOL, SLOT_HEADER, type DaemonCtl, type RelayCtl,
} from "../mobile/wire.ts";

export interface Bucket { capacity: number; perSecond: number }

export interface RelayOptions {
  port?: number;
  hostname?: string;
  /** Header carrying the client address (set by the platform's proxy, e.g. "fly-client-ip"); null = the socket peer. */
  clientIpHeader?: string | null;
  /** Concurrent sockets per client address. */
  perIpConnections?: number;
  /** New sockets per client address (token bucket). */
  connectRate?: Bucket;
  /** Messages per phone socket (token bucket); a daemon socket gets DAEMON_SCALE times this. */
  messageRate?: Bucket;
  /** Bytes per phone socket (token bucket); a daemon socket gets DAEMON_SCALE times this. */
  byteRate?: Bucket;
  /** Sockets in total. */
  maxConnections?: number;
  maxPhonesPerRoom?: number;
  /** A socket this far behind its reader is closed (bytes). */
  backpressureLimit?: number;
  idleTimeoutS?: number;
  now?: () => number;
  /** Tests only: the room hash (a delay makes the claim/disconnect race deterministic). */
  roomOf?: (key: Uint8Array) => Promise<string>;
}

/** A daemon socket carries every phone it serves (up to MAX_SLOTS): its budgets are this many phones' worth. */
export const DAEMON_SCALE = 16;
/**
 * What the relay forwards to one daemon, in all and per room. Each sits below the daemon's matching link budget
 * (joins 32 burst / 4/s, messages 1 000 / 400/s, bytes 8 MiB / 4 MiB/s; per room joins 8 / 1.5/s, bytes 3 MiB /
 * 1 MiB/s), so an honest relay turns an abusive room's phones away before the daemon ever sees a violation.
 */
export const FORWARD_LIMITS = {
  joins: { capacity: 24, perSecond: 3 },
  msgs: { capacity: 600, perSecond: 300 },
  bytes: { capacity: 6 * MAX_FRAME, perSecond: 3 * MAX_FRAME },
  roomJoins: { capacity: 6, perSecond: 1 },
  roomMsgs: { capacity: 150, perSecond: 60 },
  roomBytes: { capacity: 2 * MAX_FRAME, perSecond: 0.75 * MAX_FRAME },
} as const;
/** Connect-rate buckets kept (least recently used dropped first). */
const MAX_BUCKETS = 10_000;

/** The address limits are keyed on: an IPv4 address, or an IPv6 address's /64 (one subscriber's block). */
export function ipKey(ip: string): string {
  const v = ip.startsWith("::ffff:") && ip.includes(".") ? ip.slice(7) : ip;
  if (!v.includes(":")) return v;
  const [head = "", tail = ""] = v.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const full = v.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return `${full.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

const DEFAULTS = {
  perIpConnections: 16,
  connectRate: { capacity: 20, perSecond: 1 },
  messageRate: { capacity: 200, perSecond: 50 },
  byteRate: { capacity: 8 * MAX_FRAME, perSecond: 2 * MAX_FRAME },
  maxConnections: 5_000,
  backpressureLimit: 4 * MAX_FRAME,
  idleTimeoutS: 120,
};

class TokenBucket {
  private tokens: number;
  private at: number;
  constructor(private readonly spec: Bucket, private readonly now: () => number) {
    this.tokens = spec.capacity;
    this.at = now();
  }
  take(n = 1): boolean {
    const t = this.now();
    this.tokens = Math.min(this.spec.capacity, this.tokens + ((t - this.at) / 1000) * this.spec.perSecond);
    this.at = t;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

interface DaemonConn {
  rooms: Set<string>; phones: Map<number, WS>; ops: Promise<void>;
  /** What this relay forwards to one daemon, kept below the daemon's own link budgets (relay-link.ts). */
  joins: TokenBucket; fwdMsgs: TokenBucket; fwdBytes: TokenBucket;
  /** The same per room, so one room's phones are turned away before they cost any other room anything. */
  roomBuckets: Map<string, { joins: TokenBucket; msgs: TokenBucket; bytes: TokenBucket; recent: number; at: number }>;
  /** Slot generations: every phone that takes a slot gets the next one. */
  gen: number;
}
interface ConnData {
  role: "daemon" | "phone";
  /** Set when the socket closes: anything that resumes after an await re-checks it. */
  closed: boolean;
  ip: string;
  msgs: TokenBucket;
  bytes: TokenBucket;
  daemon?: DaemonConn;
  room?: string;
  slot?: number;
  gen?: number;
  owner?: WS;
}
type WS = ServerWebSocket<ConnData>;

export interface RelayHandle {
  readonly port: number;
  stop(): void;
  /** Counts only (tests, health): never a room id or an address. */
  stats(): { connections: number; rooms: number; phones: number };
}

export function startRelay(opts: RelayOptions = {}): RelayHandle {
  const now = opts.now ?? Date.now;
  const cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) } as typeof DEFAULTS & RelayOptions;
  const maxPhones = opts.maxPhonesPerRoom ?? MAX_PHONES_PER_ROOM;
  const rooms = new Map<string, WS>(); // room -> the daemon socket holding it (first claimant only)
  const perIp = new Map<string, number>();
  const connectBuckets = new Map<string, TokenBucket>();
  let connections = 0;

  const hashRoom = opts.roomOf ?? roomOf;
  const clientIp = (req: Request, server: Server<ConnData>): string => {
    const h = cfg.clientIpHeader ? req.headers.get(cfg.clientIpHeader)?.trim() : null;
    return ipKey(h || server.requestIP(req)?.address || "unknown");
  };

  const send = (ws: WS, msg: RelayCtl): void => { ws.send(JSON.stringify(msg)); };

  const roomBudget = (d: DaemonConn, room: string) => {
    let b = d.roomBuckets.get(room);
    if (!b) {
      b = {
        joins: new TokenBucket(FORWARD_LIMITS.roomJoins, now), msgs: new TokenBucket(FORWARD_LIMITS.roomMsgs, now),
        bytes: new TokenBucket(FORWARD_LIMITS.roomBytes, now), recent: 0, at: now(),
      };
      d.roomBuckets.set(room, b);
    }
    return b;
  };

  /** Bytes a room sent lately (decaying with a ~2 s half-life). */
  const decayed = (b: { recent: number; at: number }): number => b.recent * 0.5 ** ((now() - b.at) / 2_000);
  const recentBytes = (b: { recent: number; at: number }, n: number): void => { b.recent = decayed(b) + n; b.at = now(); };
  const heaviestRoom = (d: DaemonConn): string | null => {
    let best: string | null = null;
    let most = 0;
    for (const [room, b] of d.roomBuckets) { const r = decayed(b); if (r > most) { most = r; best = room; } }
    return best;
  };

  const dropRoom = (room: string, code: number, reason: string): void => {
    const owner = rooms.get(room);
    if (!owner?.data.daemon) return;
    rooms.delete(room);
    owner.data.daemon.rooms.delete(room);
    owner.data.daemon.roomBuckets.delete(room);
    for (const [slot, phone] of [...owner.data.daemon.phones]) {
      if (phone.data.room !== room) continue;
      owner.data.daemon.phones.delete(slot);
      phone.close(code, reason);
    }
  };

  const onDaemonText = async (ws: WS, text: string): Promise<void> => {
    if (ws.data.closed) return;
    let msg: DaemonCtl;
    try {
      msg = JSON.parse(text) as DaemonCtl;
    } catch {
      ws.close(CLOSE.bad, "bad control message");
      return;
    }
    const d = ws.data.daemon as DaemonConn;
    if (msg.t === "open" && typeof msg.key === "string") {
      let key: Uint8Array;
      try { key = unb64u(msg.key); } catch { key = new Uint8Array(0); }
      if (key.byteLength !== 32) { ws.close(CLOSE.bad, "bad room key"); return; }
      const room = await hashRoom(key);
      if (ws.data.closed) return; // the socket went while hashing: claim nothing
      if (d.rooms.has(room)) { send(ws, { t: "opened", room }); return; }
      if (d.rooms.size >= MAX_ROOMS_PER_DAEMON) { send(ws, { t: "error", message: "too many rooms", room }); return; }
      if (rooms.get(room)) {
        // A held room is never handed to a second claimant: it frees when its holder's socket closes (a restarted
        // daemon claims again until then).
        send(ws, { t: "error", message: "room held", room });
        return;
      }
      rooms.set(room, ws);
      d.rooms.add(room);
      send(ws, { t: "opened", room });
    } else if (msg.t === "close" && typeof msg.room === "string") {
      if (d.rooms.has(msg.room)) dropRoom(msg.room, CLOSE.daemonLeft, "room closed");
    } else if (msg.t === "ping" && typeof msg.n === "string" && msg.n.length <= 64) {
      // Everything the daemon sent before this ping has been read: echo it (the daemon's outbound bound, relay-link.ts).
      send(ws, { t: "pong", n: msg.n });
    } else if (msg.t === "kick" && Number.isInteger(msg.slot) && Number.isInteger(msg.gen)) {
      // Only the phone the daemon meant: a kick for a generation that already left is dropped.
      const phone = d.phones.get(msg.slot);
      if (phone && phone.data.gen === msg.gen) { d.phones.delete(msg.slot); phone.close(CLOSE.kicked, "ended by the daemon"); }
    } else {
      ws.close(CLOSE.bad, "bad control message");
    }
  };

  const server = Bun.serve<ConnData>({
    port: opts.port ?? 8080,
    hostname: opts.hostname ?? "0.0.0.0",
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") return new Response("ok", { headers: { "Cache-Control": "no-store" } });
      const role = url.pathname === "/v1/daemon" ? "daemon" : url.pathname === "/v1/phone" ? "phone" : null;
      if (!role) return new Response("not found", { status: 404 });
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("websocket only", { status: 426 });
      const ip = clientIp(req, srv);
      if (connections >= cfg.maxConnections || (perIp.get(ip) ?? 0) >= cfg.perIpConnections) return new Response("too many connections", { status: 429 });
      let bucket = connectBuckets.get(ip);
      connectBuckets.delete(ip); // re-inserted below: Map order is the LRU order
      if (!bucket) bucket = new TokenBucket(cfg.connectRate, now);
      connectBuckets.set(ip, bucket);
      while (connectBuckets.size > MAX_BUCKETS) connectBuckets.delete(connectBuckets.keys().next().value as string);
      if (!bucket.take()) return new Response("slow down", { status: 429 });
      if (role === "daemon" && url.searchParams.get("v") !== String(RELAY_PROTOCOL)) {
        // A daemon of another protocol gets a clear refusal (it says so to its person), not a connection it can't use.
        return new Response(`walkie-relay speaks protocol ${RELAY_PROTOCOL}`, { status: 426, headers: { "X-Walkie-Relay-Protocol": String(RELAY_PROTOCOL) } });
      }
      let room: string | undefined;
      if (role === "phone") {
        room = url.searchParams.get("room") ?? "";
        if (!ROOM_RE.test(room)) return new Response("bad room", { status: 400 });
      }
      const scale = (b: Bucket, k: number): Bucket => ({ capacity: b.capacity * k, perSecond: b.perSecond * k });
      const k = role === "daemon" ? DAEMON_SCALE : 1;
      const data: ConnData = {
        role, ip, closed: false, msgs: new TokenBucket(scale(cfg.messageRate, k), now), bytes: new TokenBucket(scale(cfg.byteRate, k), now),
        ...(role === "daemon"
          ? {
            daemon: {
              rooms: new Set<string>(), phones: new Map<number, WS>(), ops: Promise.resolve(),
              joins: new TokenBucket(FORWARD_LIMITS.joins, now), fwdMsgs: new TokenBucket(FORWARD_LIMITS.msgs, now),
              fwdBytes: new TokenBucket(FORWARD_LIMITS.bytes, now), roomBuckets: new Map(), gen: 0,
            },
          }
          : { room }),
      };
      return srv.upgrade(req, { data }) ? undefined : new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      maxPayloadLength: MAX_FRAME + SLOT_HEADER,
      backpressureLimit: cfg.backpressureLimit,
      closeOnBackpressureLimit: true,
      idleTimeout: cfg.idleTimeoutS,
      sendPings: true,
      open(ws) {
        connections += 1;
        perIp.set(ws.data.ip, (perIp.get(ws.data.ip) ?? 0) + 1);
        if (ws.data.role === "daemon") { send(ws, { t: "hello", v: RELAY_PROTOCOL }); return; }
        const room = ws.data.room as string;
        const owner = rooms.get(room);
        if (!owner?.data.daemon) { ws.close(CLOSE.daemonOffline, "the computer is offline"); return; }
        const inRoom = [...owner.data.daemon.phones.values()].filter((p) => p.data.room === room).length;
        if (inRoom >= maxPhones) { ws.close(CLOSE.limit, "room full"); return; }
        const rb = roomBudget(owner.data.daemon, room);
        if (!rb.joins.take() || !owner.data.daemon.joins.take()) { ws.close(CLOSE.limit, "too many connections to this computer"); return; }
        let slot = 0;
        while (owner.data.daemon.phones.has(slot) && slot < MAX_SLOTS) slot++;
        if (slot >= MAX_SLOTS) { ws.close(CLOSE.limit, "daemon full"); return; }
        owner.data.daemon.gen = (owner.data.daemon.gen % 0xffffffff) + 1;
        owner.data.daemon.phones.set(slot, ws);
        ws.data.slot = slot;
        ws.data.gen = owner.data.daemon.gen;
        ws.data.owner = owner;
        send(owner, { t: "join", room, slot, gen: ws.data.gen });
      },
      message(ws, message) {
        const size = typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
        if (!ws.data.msgs.take() || !ws.data.bytes.take(size)) { ws.close(CLOSE.limit, "rate limit"); return; }
        if (ws.data.role === "daemon") {
          if (typeof message === "string") {
            if (size > MAX_CONTROL) { ws.close(CLOSE.bad, "control message too large"); return; }
            // One control at a time per daemon, in order (a room claim awaits a hash).
            const d = ws.data.daemon as DaemonConn;
            d.ops = d.ops.then(() => onDaemonText(ws, message)).catch(() => undefined);
            return;
          }
          // A daemon frame is a slot, its generation and 1 .. MAX_FRAME bytes for that phone; a frame for a phone that
          // left (another generation) is dropped, never delivered to the phone that has the slot now.
          if (message.byteLength < SLOT_HEADER + 1 || message.byteLength > MAX_FRAME + SLOT_HEADER) { ws.close(CLOSE.bad, "bad frame size"); return; }
          const slot = message[0] as number;
          const gen = new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(1);
          const phone = ws.data.daemon?.phones.get(slot);
          if (phone && phone.data.gen === gen) phone.send(message.subarray(SLOT_HEADER));
          return;
        }
        if (typeof message === "string") { ws.close(CLOSE.bad, "binary frames only"); return; }
        // A phone frame is 1 .. MAX_FRAME bytes: anything else closes that phone, before it reaches the daemon.
        if (message.byteLength < 1 || message.byteLength > MAX_FRAME) { ws.close(CLOSE.bad, "bad frame size"); return; }
        const owner = ws.data.owner;
        if (!owner?.data.daemon || ws.data.slot === undefined) return;
        // The daemon's budgets are shared by all its phones: this phone's room pays first, then the daemon's total,
        // and a daemon that isn't reading fast enough costs this phone its link, never the daemon its connection.
        const d = owner.data.daemon;
        const rb = roomBudget(d, ws.data.room as string);
        const fits = rb.msgs.take() && rb.bytes.take(message.byteLength) && d.fwdMsgs.take() && d.fwdBytes.take(message.byteLength);
        if (!fits) { ws.close(CLOSE.limit, "slow down"); return; }
        recentBytes(rb, message.byteLength);
        const behind = owner.getBufferedAmount() + message.byteLength + SLOT_HEADER; // as it would be after this frame
        if (behind > cfg.backpressureLimit / 2) {
          // The computer isn't reading fast enough: the room that sent the most lately loses its phones first.
          const heavy = heaviestRoom(d);
          if (heavy) for (const [slot, p] of [...d.phones]) if (p.data.room === heavy) { d.phones.delete(slot); send(owner, { t: "leave", slot, gen: p.data.gen as number }); p.close(CLOSE.limit, "slow down"); }
          if (heavy === ws.data.room || behind > (cfg.backpressureLimit * 3) / 4) { if (!ws.data.closed) ws.close(CLOSE.limit, "slow down"); return; }
        }
        const out = new Uint8Array(message.byteLength + SLOT_HEADER);
        out[0] = ws.data.slot;
        new DataView(out.buffer).setUint32(1, ws.data.gen as number);
        out.set(message, SLOT_HEADER);
        owner.send(out);
      },
      close(ws) {
        ws.data.closed = true;
        connections -= 1;
        const n = (perIp.get(ws.data.ip) ?? 1) - 1;
        if (n <= 0) perIp.delete(ws.data.ip); else perIp.set(ws.data.ip, n);
        if (ws.data.role === "daemon") {
          for (const room of [...(ws.data.daemon?.rooms ?? [])]) if (rooms.get(room) === ws) dropRoom(room, CLOSE.daemonLeft, "the computer left");
          return;
        }
        const owner = ws.data.owner;
        const slot = ws.data.slot;
        if (owner?.data.daemon && slot !== undefined && owner.data.daemon.phones.get(slot) === ws) {
          owner.data.daemon.phones.delete(slot);
          send(owner, { t: "leave", slot, gen: ws.data.gen as number });
        }
      },
    },
  });

  return {
    port: server.port as number,
    stop: () => server.stop(true),
    stats: () => ({
      connections, rooms: rooms.size,
      phones: [...new Set(rooms.values())].reduce((n, d) => n + (d.data.daemon?.phones.size ?? 0), 0),
    }),
  };
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8080);
  const r = startRelay({ port, clientIpHeader: process.env.RELAY_TRUST_FLY === "1" ? "fly-client-ip" : null });
  process.stdout.write(`walkie-relay listening on :${r.port}\n`);
}
