// Walkie Direct (PROTOCOL §4): the peer API over iroh. The endpoint runs on the node's own ed25519 key, so its
// endpoint id IS the node key in `team.node`, and every connection's remote key is authenticated by QUIC/TLS
// before a byte of HTTP is read. iroh hole-punches a direct UDP path and falls back to an encrypted relay (n0's
// public relays by default, `relays` in config.json otherwise); relays forward ciphertext only.
//
// Framing (ALPN "walkie/1"): one bi-stream per HTTP exchange.
//   request:  u32 BE n | n bytes JSON {m, p, h} | body… | FIN
//   response: u32 BE n | n bytes JSON {s, h}    | body… | FIN
// The server hands a standard Request to the peer API's handlers with the caller's authenticated key.
import type * as Iroh from "@number0/iroh";
import { nodeIdFromPubkey } from "../../protocol/ids.ts";
import type { Logger } from "../logger.ts";
import type { NodeKeys } from "../keys.ts";
import { endpointHex } from "../roster.ts";
import type { PeerAddr, PeerRequest, Transport } from "../transport.ts";
import { iroh } from "./iroh.ts";
import { sourceOf, type Source } from "./sources.ts";
import { irohEnd, type End } from "../../pool/run/tunnel.ts";

export const ALPN = "walkie/1";
const ALPN_BYTES = [...Buffer.from(ALPN)];
const HEAD_MAX = 16 * 1024;
const CHUNK = 64 * 1024;
/** Request bodies a server reads (the peer API's own cap is 1 MB; the rest is headroom for the frame). */
const REQUEST_MAX = 1024 * 1024 + 4096;
/** A request's head and body must arrive within this; a stalled stream is reset. */
const REQUEST_READ_MS = 30_000;
/**
 * Incoming connection budget (PROTOCOL §4 "Connection budget"). Every limit is checked before the work it bounds.
 *
 * Pending handshakes are budgeted before `accept()` starts any native work, by what iroh names without a handshake:
 * the SOURCE (an IPv4 address, an IPv6 /64, or on the relay path the relay-authenticated endpoint id), its network
 * PREFIX (IPv4 /24, IPv6 /48) and, on the relay path, the MEMBER owning an admitted endpoint id.
 * iroh 1.1's Node binding can't cancel a server handshake once `Accepting.connect()` runs (QUIC's idle timer, which
 * the sender resets with every packet, is the only thing that ends it), so NATIVE budgets are held until the native
 * handshake really settles: per source, per prefix, per member, per path (direct / relay stranger) and in total
 * (`maxNativeHandshakes`, the sum over every source, path and lane). At a native cap, a new attempt is refused before
 * any native work, so the number of native handshakes alive is bounded however long each one lives.
 * LANE slots (how many handshakes are in progress now) are given back at `handshakeCeilingMs` even if the native
 * handshake runs on, so stalled handshakes free the lane without freeing their native budgets.
 * Relay-path senders whose endpoint id is an admitted node's use their own lane (a stranger can't claim a member's
 * id: the relay authenticated it); relay-path strangers (joiners), whose ids are free to mint, share one bounded pool,
 * and the direct path may take only `maxPendingDirect` of the general lane, so relay joiners keep a few slots that
 * no set of IP addresses can take. Each path's native share is below the total, so the members' relay lane always
 * has native room. Above `retryAbove` pending, an unvalidated UDP source gets a QUIC Retry first, so a spoofed or
 * reply-blind sender never starts a handshake.
 */
export interface DirectLimits {
  /** Incoming connections held at once, pending handshakes included. */
  maxConnections: number;
  /** Of those, connections from keys that aren't admitted nodes (joiners, strangers). */
  maxUnadmitted: number;
  /** Connections one authenticated key may hold at once (a daemon dials each peer over one cached connection). */
  maxPerKey: number;
  /** General lane: handshakes in progress at once from sources not known to be members; more are refused unstarted. */
  maxPendingHandshakes: number;
  /** Of the general lane, what the direct (IP) path may take: the rest is kept for relay-path joiners. */
  maxPendingDirect: number;
  /** Member lane: handshakes in progress from relay-path senders whose endpoint id is an admitted node's. */
  maxPendingMembers: number;
  /** Native handshakes one source may have running at once (held until each really ends). */
  maxPendingPerSource: number;
  /** Native handshakes one IPv4 /24 or IPv6 /48 may have running at once (held until each really ends). */
  maxPendingPerPrefix: number;
  /** Native handshakes one member's admitted keys together may have running on the member lane (held likewise). */
  maxPendingPerMember: number;
  /** Native handshakes all relay-path strangers together may have running (held until each really ends). */
  maxPendingRelayStrangers: number;
  /** Native handshakes running at once, every source, path and lane together (held until each really ends). */
  maxNativeHandshakes: number;
  /** Of those, what direct-path (IP) sources may have running: the rest stays for relay strangers and members. */
  maxNativeDirect: number;
  /** Above this many general-lane handshakes, an unvalidated UDP source gets a QUIC Retry (address validation). */
  retryAbove: number;
  /** A handshake that hasn't completed by now is abandoned, and the connection closed if it completes later. */
  handshakeMs: number;
  /** A timed-out handshake gives its lane slot back at the latest now; its source slot waits for the native end. */
  handshakeCeilingMs: number;
  /** An unadmitted key's connection is closed after this. */
  unadmittedLifetimeMs: number;
}

export const DEFAULT_DIRECT_LIMITS: Readonly<DirectLimits> = Object.freeze({
  maxConnections: 512, maxUnadmitted: 16, maxPerKey: 4,
  maxPendingHandshakes: 32, maxPendingDirect: 24, maxPendingMembers: 32,
  maxPendingPerSource: 4, maxPendingPerPrefix: 8, maxPendingPerMember: 8, maxPendingRelayStrangers: 16,
  maxNativeHandshakes: 128, maxNativeDirect: 64, retryAbove: 8,
  handshakeMs: 15_000, handshakeCeilingMs: 60_000, unadmittedLifetimeMs: 30_000,
});

/** Backoff after `acceptNext` fails: the loop logs, waits, and carries on (only a closed endpoint ends it). */
const ACCEPT_BACKOFF_MS = [50, 200, 1_000, 5_000] as const;

/**
 * A key that isn't an admitted node gets a short-lived connection with few concurrent streams (enough to join);
 * its requests share one rate-limit bucket in the peer API. Admitted on the connection, the limits lift; revoked
 * (or its member removed) while connected, the connection is closed.
 */
const UNADMITTED_STREAMS = 4;
const MAX_STREAMS_PER_CONNECTION = 64;
const NULL_BODY = new Set([101, 204, 205, 304]);

export interface DirectOptions {
  /** "n0" (default): n0's relays + address discovery. "minimal": neither (tests, closed LANs): dial by address book. */
  preset?: "n0" | "minimal";
  /** Relay URLs replacing n0's (config.json `relays`); [] disables relays. Discovery stays n0's with preset n0. */
  relays?: readonly string[];
  /** UDP socket to bind, "host:port" (default: any address, a random port). */
  bindAddr?: string;
  /** Known direct socket addresses per endpoint id (hex); tests fill it with each node's bound loopback address. */
  addressBook?: Map<string, string[]>;
  connectTimeoutMs?: number;
  /** Overrides of the incoming connection budget (tests). */
  limits?: Partial<DirectLimits>;
  /** Names an incoming attempt's source (tests: loopback proxies stand in for hosts on other networks). */
  sourceOf?: (addr: Iroh.IncomingAddr) => Source;
}

/** The peer API handler: a standard request plus the caller's QUIC-authenticated node key (base64). */
export type DirectHandler = (req: Request, remotePubkey: string) => Promise<Response>;

/**
 * WALKIE-POOL-2: a `CONNECT` stream (a split run's tunnel). Answers a refusal (status + JSON body), or `accept`,
 * which then owns the stream's bytes in both directions until it resolves.
 */
export type TunnelDecision = { refuse: Response } | { accept: (end: End) => Promise<void>; release: () => void };
export type DirectTunnelHandler = (path: string, headers: Record<string, string>, remotePubkey: string) => Promise<TunnelDecision>;

export interface DirectDeps {
  keys: NodeKeys; log: Logger; handler: DirectHandler;
  /** WALKIE-POOL-2: CONNECT streams; absent = refused (404). */
  tunnel?: DirectTunnelHandler;
  /** Whether a key is an admitted, non-revoked node (unadmitted keys get the small join budget). */
  admitted: (pubkey: string) => boolean;
  /**
   * The login of the member owning an admitted key, or null: the member lane budgets a member's keys together.
   * Default: each admitted key is its own member (tests).
   */
  memberOf?: (pubkey: string) => string | null;
}

class Abort extends Error { override name = "AbortError"; }

/** A peer refused a tunnel: its status and its error body (JSON, untrusted). */
export class TunnelRefused extends Error {
  constructor(readonly status: number, readonly body: string) { super(`tunnel refused (${status})`); }
}

/** Resolves p, or rejects when the signal aborts (the caller then resets the stream). */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Abort("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Abort("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener("abort", onAbort); reject(e); });
  });
}

function frame(head: unknown): number[] {
  const json = Buffer.from(JSON.stringify(head), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length);
  return [...len, ...json];
}

async function readHead(recv: Iroh.RecvStream): Promise<unknown> {
  const n = Buffer.from(await recv.readExact(4)).readUInt32BE(0);
  if (n === 0 || n > HEAD_MAX) throw new Error("bad frame head");
  return JSON.parse(Buffer.from(await recv.readExact(n)).toString("utf8")) as unknown;
}

async function writeBody(send: Iroh.SendStream, bytes: Uint8Array): Promise<void> {
  for (let off = 0; off < bytes.byteLength; off += CHUNK) {
    await send.writeAll(Array.from(bytes.subarray(off, off + CHUNK)));
  }
}

function headersOf(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof h !== "object" || h === null) return out;
  for (const [k, v] of Object.entries(h)) if (typeof v === "string" && k.length <= 64 && v.length <= 4096) out[k] = v;
  return out;
}

/** Close codes this server uses (the reason bytes say the same in ASCII). */
const CLOSE = { lifetime: 0n, alpn: 1n, busy: 2n, timeout: 3n, revoked: 4n, replaced: 5n } as const;

interface Incoming {
  readonly pubkey: string; readonly conn: Iroh.Connection;
  admitted: boolean; lifetime: ReturnType<typeof setTimeout> | null;
  /** Streams being served now, and when the last one started or ended (for evicting the stalest idle one). */
  streams: number; active: number;
}

/** Scheduling lanes: relay-path members; the general lane's direct (IP) and relay-stranger shares. */
type Lane = "member" | "direct" | "relay";

/**
 * What one pending handshake holds: a lane slot (given back at the ceiling) and native budgets (source, prefix,
 * member, its path's share and the total), given back only when the native handshake ends.
 */
interface Reservation {
  readonly lane: Lane; readonly source: string; readonly prefix: string | null; readonly member: string | null;
  laneHeld: boolean;
}

/** Adds `d` to a counter map entry, dropping it at zero. */
function bump(m: Map<string, number>, k: string, d: number): void {
  const n = (m.get(k) ?? 0) + d;
  if (n > 0) m.set(k, n); else m.delete(k);
}

export class DirectNet implements Transport {
  readonly kind = "direct" as const;
  private readonly conns = new Map<string, Promise<Iroh.Connection>>();
  private readonly incoming = new Set<Incoming>();
  private readonly byKey = new Map<string, Set<Incoming>>();
  /** Lane slots held by handshakes (in progress, or timed out and still settling natively, up to the ceiling). */
  private readonly lanes: Record<Lane, number> = { member: 0, direct: 0, relay: 0 };
  /** Native handshakes running (each held until it settles): per path, per source, per prefix, per member. */
  private readonly native: Record<Lane, number> = { member: 0, direct: 0, relay: 0 };
  private readonly bySource = new Map<string, number>();
  private readonly byPrefix = new Map<string, number>();
  private readonly byMember = new Map<string, number>();
  private stopped = false;
  private readonly limits: DirectLimits;

  private constructor(private readonly ep: Iroh.Endpoint, private readonly d: DirectDeps, private readonly opts: DirectOptions) {
    this.limits = { ...DEFAULT_DIRECT_LIMITS, ...opts.limits };
  }

  /** Binds the endpoint on the node key and starts serving the peer API on it. */
  static async start(d: DirectDeps, opts: DirectOptions = {}): Promise<DirectNet> {
    const { Endpoint, RelayMode } = iroh();
    const b = Endpoint.builder();
    if (opts.preset === "minimal") b.applyMinimal(); else b.applyN0();
    if (opts.relays) b.relayMode(opts.relays.length ? RelayMode.customFromUrls([...opts.relays]) : RelayMode.disabled());
    if (opts.preset === "minimal" && !opts.relays) b.relayMode(RelayMode.disabled());
    b.secretKey([...d.keys.secretSeed()]);
    b.alpns([ALPN_BYTES]);
    if (opts.bindAddr) b.bindAddr(opts.bindAddr);
    const ep = await b.bind();
    const net = new DirectNet(ep, d, opts);
    if (Buffer.from(ep.id().toBytes()).toString("base64") !== d.keys.pubkey) {
      await ep.close();
      throw new Error("iroh endpoint id does not match the node key");
    }
    opts.addressBook?.set(net.endpoint, ep.boundSockets().map((s) => s.replace(/^0\.0\.0\.0:/, "127.0.0.1:").replace(/^\[::\]:/, "[::1]:")));
    void net.acceptLoop();
    d.log.info("direct_enabled", { endpoint: net.endpoint, preset: opts.preset ?? "n0", relays: opts.relays ? opts.relays.length : "n0" });
    return net;
  }

  /** This node's endpoint id (hex of its public key). */
  get endpoint(): string { return Buffer.from(this.ep.id().toBytes()).toString("hex"); }

  /** The home relay this endpoint is connected to, if any yet. */
  relayUrl(): string | null {
    try { return this.ep.addr().relayUrl(); } catch { return null; }
  }

  /** Waits until a home relay is connected (for an invite's relay hint), at most `ms`. */
  async online(ms: number): Promise<string | null> {
    if (this.opts.preset === "minimal" || (this.opts.relays && !this.opts.relays.length)) return null;
    await Promise.race([this.ep.online(), Bun.sleep(ms)]);
    return this.relayUrl();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.conns.clear();
    await this.ep.close().catch(() => undefined);
  }

  // ---- client ------------------------------------------------------------------------------------

  private dial(pubkey: string, relay: string | undefined, signal: AbortSignal): Promise<Iroh.Connection> {
    const hex = endpointHex(pubkey);
    const cached = this.conns.get(hex);
    if (cached) return cached;
    const { EndpointAddr, EndpointId } = iroh();
    const addr = new EndpointAddr(EndpointId.fromBytes([...Buffer.from(pubkey, "base64")]), relay ?? null, this.opts.addressBook?.get(hex) ?? []);
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(this.opts.connectTimeoutMs ?? 20_000)]);
    const p = abortable(this.ep.connect(addr, ALPN_BYTES), timeout).then((conn) => {
      const peer = nodeIdFromPubkey(pubkey);
      // Which path carries the connection (relay, or a hole-punched direct UDP path), logged as it changes.
      let last = "";
      const note = (paths: Iroh.PathSnapshot[]): void => {
        const sel = paths.find((x) => x.isSelected);
        const via = sel ? (sel.isRelay ? "relay" : "direct") : "none";
        if (via === last) return;
        last = via;
        this.d.log.info("direct_path", { peer, via, ...(sel ? { rtt_ms: Math.round(sel.rttMs) } : {}) });
      };
      // Sampled (the SDK's watchPaths panics outside its runtime in 1.1.0): at connect, then as hole-punching settles.
      const sample = (): void => { try { note(conn.paths()); } catch { /* closed */ } };
      sample();
      const timers = [3_000, 15_000].map((ms) => setTimeout(sample, ms));
      for (const t of timers) (t as { unref?: () => void }).unref?.();
      void conn.closed().catch(() => undefined).then(() => {
        for (const t of timers) clearTimeout(t);
        if (this.conns.get(hex) === p) this.conns.delete(hex);
      });
      return conn;
    });
    this.conns.set(hex, p);
    p.catch(() => { if (this.conns.get(hex) === p) this.conns.delete(hex); });
    return p;
  }

  private async openStream(addr: PeerAddr & { pubkey: string }, signal: AbortSignal): Promise<Iroh.BiStream> {
    for (let attempt = 0; ; attempt++) {
      const hex = endpointHex(addr.pubkey);
      const conn = await this.dial(addr.pubkey, addr.relay, signal);
      const cached = this.conns.get(hex);
      try {
        return await abortable(conn.openBi(), signal);
      } catch (err) {
        // This request's own deadline: the shared connection is fine, other requests are still using it.
        if (signal.aborted) throw err;
        // A cached connection that died since: close it, forget it and dial once more. Closed first, so the redial
        // starts clean (iroh reuses an open connection's path state, and the redial went out direct-only). Only the
        // entry this attempt used is forgotten, so a concurrent fresh redial is kept.
        try { conn.close(CLOSE.replaced, [...Buffer.from("stale")]); } catch { /* already closed */ }
        if (this.conns.get(hex) === cached) this.conns.delete(hex);
        if (attempt >= 1) throw err;
      }
    }
  }

  async request(addr: PeerAddr, r: PeerRequest): Promise<Response> {
    if (this.stopped) throw new Error("Walkie Direct is stopped");
    if (!addr.pubkey) throw new Error("no node key to dial");
    const bi = await this.openStream({ ...addr, pubkey: addr.pubkey }, r.signal);
    const { send, recv } = bi;
    const reset = (): void => { void send.reset(0n).catch(() => undefined); void recv.stop(0n).catch(() => undefined); };
    try {
      await abortable((async () => {
        await send.writeAll(frame({ m: r.method, p: r.path, h: r.headers }));
        if (r.body !== undefined) await writeBody(send, Buffer.from(r.body, "utf8"));
        await send.finish();
      })(), r.signal);
      const head = await abortable(readHead(recv), r.signal) as { s?: unknown; h?: unknown };
      const status = typeof head.s === "number" && Number.isInteger(head.s) && head.s >= 200 && head.s <= 599 ? head.s : 502;
      if (NULL_BODY.has(status)) return new Response(null, { status, headers: headersOf(head.h) });
      const body = new ReadableStream<Uint8Array>({
        pull: async (ctl) => {
          try {
            const chunk = await abortable(recv.read(CHUNK), r.signal);
            if (!chunk.length) ctl.close(); else ctl.enqueue(Uint8Array.from(chunk));
          } catch (err) {
            reset();
            ctl.error(err);
          }
        },
        cancel: () => reset(),
      });
      return new Response(body, { status, headers: headersOf(head.h) });
    } catch (err) {
      reset();
      throw err;
    }
  }

  /**
   * WALKIE-POOL-2: opens a tunnel stream: a `CONNECT` head frame, the answer's head, then raw bytes both ways (the
   * stream is not finished). A refusal rejects with the status and the server's JSON error.
   */
  async openTunnel(addr: PeerAddr, path: string, headers: Record<string, string>, signal: AbortSignal): Promise<End> {
    if (this.stopped) throw new Error("Walkie Direct is stopped");
    if (!addr.pubkey) throw new Error("no node key to dial");
    const { send, recv } = await this.openStream({ ...addr, pubkey: addr.pubkey }, signal);
    const reset = (): void => { void send.reset(0n).catch(() => undefined); void recv.stop(0n).catch(() => undefined); };
    try {
      await abortable(send.writeAll(frame({ m: "CONNECT", p: path, h: headers })), signal);
      const head = await abortable(readHead(recv), signal) as { s?: unknown };
      if (head.s !== 200) {
        const body = await abortable(recv.readToEnd(16 * 1024), signal).catch(() => [] as number[]);
        reset();
        throw new TunnelRefused(typeof head.s === "number" ? head.s : 502, Buffer.from(body).toString("utf8"));
      }
      return irohEnd(send, recv);
    } catch (err) {
      reset();
      throw err;
    }
  }

  // ---- server ------------------------------------------------------------------------------------

  private async acceptLoop(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      let inc: Iroh.Incoming | null;
      try {
        inc = await this.ep.acceptNext();
      } catch (err) {
        if (this.stopped) return;
        // One failed accept must not stop the server for good: log, back off, carry on.
        const wait = ACCEPT_BACKOFF_MS[Math.min(failures, ACCEPT_BACKOFF_MS.length - 1)] as number;
        failures++;
        this.d.log.warn("direct_accept_failed", { err: (err as Error).message, retry_ms: wait, failures });
        await Bun.sleep(wait);
        continue;
      }
      if (!inc) return; // endpoint closed
      failures = 0;
      void this.accept(inc).catch((err: unknown) => this.d.log.debug("direct_incoming_failed", { err: (err as Error).message }));
    }
  }

  /** Running native handshakes, all paths together. */
  private nativeTotal(): number { return this.native.member + this.native.direct + this.native.relay; }

  /**
   * Pending handshakes (lane slots: `pending` is the general lane), native handshakes running (in total, from relay
   * strangers, per source / prefix / member), incoming connections held (tests, diagnostics).
   */
  stats(): {
    connections: number; pending: number; pendingMembers: number; native: number; relayStrangers: number;
    pendingBySource: Map<string, number>; pendingByPrefix: Map<string, number>; pendingByMember: Map<string, number>;
    admittedByKey: Map<string, number>;
  } {
    const admittedByKey = new Map<string, number>();
    for (const rec of this.incoming) if (rec.admitted) admittedByKey.set(rec.pubkey, (admittedByKey.get(rec.pubkey) ?? 0) + 1);
    return {
      connections: this.incoming.size, pending: this.lanes.direct + this.lanes.relay, pendingMembers: this.lanes.member,
      native: this.nativeTotal(), relayStrangers: this.native.relay, pendingBySource: new Map(this.bySource),
      pendingByPrefix: new Map(this.byPrefix), pendingByMember: new Map(this.byMember), admittedByKey,
    };
  }

  /**
   * The roster changed: every held connection's key is judged again. A key that is no longer admitted (its node
   * revoked, its member removed) loses its connections at once, idle ones included; a key admitted since gets the
   * member limits on the connections it already holds.
   */
  rosterChanged(): void {
    for (const rec of [...this.incoming]) {
      const admitted = this.d.admitted(rec.pubkey);
      if (rec.admitted && !admitted) this.drop(rec, "revoked");
      else if (!rec.admitted && admitted) this.promote(rec);
    }
  }

  /**
   * One incoming attempt: its source is budgeted before any native handshake work. Over a limit, a validated source
   * is refused (it learns at once); an unvalidated one is ignored (no packet goes to an address that may be spoofed;
   * a real sender retransmits and is judged again). Under load, an unvalidated UDP source is sent a QUIC Retry.
   */
  private async accept(inc: Iroh.Incoming): Promise<void> {
    if (this.stopped) { await inc.refuse().catch(() => undefined); return; }
    let src: Source;
    let validated: boolean;
    try {
      const [addr, v] = await Promise.all([inc.remoteAddr(), inc.remoteAddrValidated()]);
      src = (this.opts.sourceOf ?? sourceOf)(addr);
      validated = v;
    } catch {
      await inc.ignore().catch(() => undefined);
      return;
    }
    // Everything from here to the reservation is synchronous, so concurrent attempts can't overshoot a limit.
    const member = this.memberOf(src);
    const lane: Lane = member !== null ? "member" : src.via === "relay" ? "relay" : "direct";
    if (this.stopped || !this.fits(lane, src, member)) {
      await (validated || src.via !== "ip" ? inc.refuse() : inc.ignore()).catch(() => undefined);
      return;
    }
    const general = this.lanes.direct + this.lanes.relay;
    if (lane === "direct" && src.via === "ip" && !validated && general >= this.limits.retryAbove) {
      await inc.retry().catch(() => inc.ignore().catch(() => undefined));
      return;
    }
    const res: Reservation = { lane, source: src.key, prefix: src.prefix, member, laneHeld: true };
    this.lanes[lane]++;
    this.native[lane]++;
    bump(this.bySource, src.key, 1);
    if (src.prefix !== null) bump(this.byPrefix, src.prefix, 1);
    if (member !== null) bump(this.byMember, member, 1);
    const conn = await this.handshake(inc, res);
    if (!conn) return; // handshake() releases the reservation, at once or when the native handshake ends
    await this.serveConnection(conn);
  }

  /** The member owning a relay sender's (relay-authenticated) endpoint id, if it is an admitted node's; else null. */
  private memberOf(src: Source): string | null {
    if (!src.endpoint) return null;
    const pubkey = Buffer.from(src.endpoint, "hex").toString("base64");
    if (!this.d.admitted(pubkey)) return null;
    return this.d.memberOf ? this.d.memberOf(pubkey) : pubkey;
  }

  /** Whether a new handshake on `lane` from `src` fits every lane slot and native budget (checked before native work). */
  private fits(lane: Lane, src: Source, member: string | null): boolean {
    const L = this.limits;
    const general = this.lanes.direct + this.lanes.relay;
    const laneOk = lane === "member" ? this.lanes.member < L.maxPendingMembers
      : general < L.maxPendingHandshakes && (lane === "relay" || this.lanes.direct < L.maxPendingDirect);
    const pathOk = lane === "direct" ? this.native.direct < L.maxNativeDirect
      : lane === "relay" ? this.native.relay < L.maxPendingRelayStrangers
      : (this.byMember.get(member as string) ?? 0) < L.maxPendingPerMember;
    return laneOk && pathOk
      && (this.bySource.get(src.key) ?? 0) < L.maxPendingPerSource
      && (src.prefix === null || (this.byPrefix.get(src.prefix) ?? 0) < L.maxPendingPerPrefix)
      && this.nativeTotal() < L.maxNativeHandshakes
      && this.incoming.size + this.nativeTotal() < L.maxConnections;
  }

  private releaseLane(res: Reservation): void {
    if (!res.laneHeld) return;
    res.laneHeld = false;
    this.lanes[res.lane]--;
  }

  /** The native handshake has ended (either way): its native budgets, and a lane slot still held, go back. */
  private releaseNative(res: Reservation): void {
    this.releaseLane(res);
    this.native[res.lane]--;
    bump(this.bySource, res.source, -1);
    if (res.prefix !== null) bump(this.byPrefix, res.prefix, -1);
    if (res.member !== null) bump(this.byMember, res.member, -1);
  }

  /**
   * Runs the native handshake under the reservation accept() took. Resolves the connection (reservation released:
   * it is counted as a connection from then on), or null: at once on failure (all released); on timeout, the lane slot is
   * given back when the native handshake settles or at the ceiling, whichever is first, and the native budgets only
   * when it settles (a connection that completes late is closed).
   */
  private handshake(inc: Iroh.Incoming, res: Reservation): Promise<Iroh.Connection | null> {
    const L = this.limits;
    return new Promise((resolve) => {
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; resolve(null); }, L.handshakeMs);
      const ceiling = setTimeout(() => this.releaseLane(res), Math.max(L.handshakeCeilingMs, L.handshakeMs));
      (ceiling as { unref?: () => void }).unref?.();
      const settle = (): void => { clearTimeout(timer); clearTimeout(ceiling); };
      (async () => (await inc.accept()).connect())().then((conn) => {
        settle();
        if (timedOut || this.stopped) {
          this.releaseNative(res);
          try { conn.close(CLOSE.timeout, [...Buffer.from("timeout")]); } catch { /* already closed */ }
          resolve(null);
          return;
        }
        this.releaseNative(res); // the handshake is over: the connection is budgeted as one from here
        resolve(conn);
      }, () => {
        settle();
        this.releaseNative(res);
        resolve(null); // handshake failed
      });
    });
  }

  private async serveConnection(conn: Iroh.Connection): Promise<void> {
    const L = this.limits;
    if (Buffer.from(conn.alpn()).toString() !== ALPN) { conn.close(CLOSE.alpn, [...Buffer.from("alpn")]); return; }
    const pubkey = Buffer.from(conn.remoteId().toBytes()).toString("base64");
    const admitted = this.d.admitted(pubkey);
    // A member at its cap reconnecting: its stalest idle connection (a dead one QUIC hasn't timed out yet, say)
    // makes room, so a member is never locked out by its own leftovers. Still at most maxPerKey per key.
    if (admitted && (this.byKey.get(pubkey)?.size ?? 0) >= L.maxPerKey) this.evictIdle(pubkey);
    const mine = this.byKey.get(pubkey);
    const unadmitted = admitted ? 0 : [...this.incoming].filter((c) => !c.admitted).length;
    if ((mine?.size ?? 0) >= L.maxPerKey || (!admitted && unadmitted >= L.maxUnadmitted) || this.incoming.size >= L.maxConnections) {
      conn.close(CLOSE.busy, [...Buffer.from("busy")]);
      return;
    }
    const rec: Incoming = { pubkey, conn, admitted, lifetime: null, streams: 0, active: Date.now() };
    this.incoming.add(rec);
    this.byKey.set(pubkey, (mine ?? new Set<Incoming>()).add(rec));
    if (!admitted) rec.lifetime = setTimeout(() => this.drop(rec, "lifetime"), L.unadmittedLifetimeMs);
    try {
      conn.setMaxConcurrentBiStreams(BigInt(admitted ? MAX_STREAMS_PER_CONNECTION : UNADMITTED_STREAMS));
      while (!this.stopped) {
        let bi: Iroh.BiStream;
        try { bi = await conn.acceptBi(); } catch { break; } // connection closed
        const now = this.d.admitted(pubkey);
        if (rec.admitted && !now) { this.drop(rec, "revoked"); break; } // revoked since: no more requests on it
        if (!rec.admitted && now) this.promote(rec); // joined on this very connection: it carries on as a member's
        rec.streams++;
        rec.active = Date.now();
        void this.serve(bi, pubkey).finally(() => { rec.streams--; rec.active = Date.now(); });
      }
    } finally {
      this.forget(rec);
    }
  }

  /** Takes a held connection off the books (idempotent); its slot is free at once. */
  private forget(rec: Incoming): void {
    if (rec.lifetime) clearTimeout(rec.lifetime);
    rec.lifetime = null;
    this.incoming.delete(rec);
    const set = this.byKey.get(rec.pubkey);
    set?.delete(rec);
    if (set && !set.size) this.byKey.delete(rec.pubkey);
  }

  /** Closes `pubkey`'s least recently active connection with no stream in flight, if it has one. */
  private evictIdle(pubkey: string): void {
    let stalest: Incoming | null = null;
    for (const rec of this.byKey.get(pubkey) ?? []) if (rec.streams === 0 && (!stalest || rec.active < stalest.active)) stalest = rec;
    if (!stalest) return;
    this.forget(stalest);
    this.d.log.info("direct_connection_closed", { peer: nodeIdFromPubkey(pubkey), reason: "replaced" });
    try { stalest.conn.close(CLOSE.replaced, [...Buffer.from("replaced")]); } catch { /* already closed */ }
  }

  private promote(rec: Incoming): void {
    rec.admitted = true;
    if (rec.lifetime) clearTimeout(rec.lifetime);
    rec.lifetime = null;
    try { rec.conn.setMaxConcurrentBiStreams(BigInt(MAX_STREAMS_PER_CONNECTION)); } catch { /* closed */ }
  }

  /** Closes a held connection; its accept loop then ends and frees the slot. */
  private drop(rec: Incoming, why: "revoked" | "lifetime"): void {
    rec.admitted = false;
    if (why === "revoked") this.d.log.info("direct_connection_closed", { peer: nodeIdFromPubkey(rec.pubkey), reason: why });
    try { rec.conn.close(why === "revoked" ? CLOSE.revoked : CLOSE.lifetime, why === "revoked" ? [...Buffer.from("revoked")] : []); } catch { /* already closed */ }
  }

  /** WALKIE-POOL-2: a CONNECT stream: the tunnel handler refuses it (a normal response) or takes its bytes over. */
  private async serveTunnel(send: Iroh.SendStream, recv: Iroh.RecvStream, path: string, headers: Record<string, string>, pubkey: string): Promise<void> {
    let decision: TunnelDecision;
    try {
      decision = this.d.tunnel ? await this.d.tunnel(path, headers, pubkey) : { refuse: new Response('{"error":{"code":"not_found","message":"not found"}}', { status: 404 }) };
    } catch (err) {
      this.d.log.debug("direct_tunnel_failed", { err: (err as Error).message });
      decision = { refuse: new Response('{"error":{"code":"internal","message":"internal error"}}', { status: 500 }) };
    }
    if ("refuse" in decision) {
      const body = Buffer.from(await decision.refuse.arrayBuffer());
      await send.writeAll(frame({ s: decision.refuse.status, h: { "content-type": "application/json" } })).catch(() => undefined);
      await writeBody(send, body.subarray(0, 16 * 1024)).catch(() => undefined);
      await send.finish().catch(() => undefined);
      return;
    }
    try {
      await send.writeAll(frame({ s: 200, h: {} }));
    } catch (err) {
      decision.release(); // the slot the grant reserved goes back
      throw err;
    }
    await decision.accept(irohEnd(send, recv));
  }

  private async serve(bi: Iroh.BiStream, pubkey: string): Promise<void> {
    const { send, recv } = bi;
    let req: Request;
    try {
      const read = (async () => {
        const head = await readHead(recv) as { m?: unknown; p?: unknown; h?: unknown };
        const method = typeof head.m === "string" && /^[A-Z]{3,7}$/.test(head.m) ? head.m : "";
        const path = typeof head.p === "string" && head.p.startsWith("/") && head.p.length <= 2048 ? head.p : "";
        if (!method || !path) throw new Error("bad request head");
        if (method === "CONNECT") return { tunnel: true as const, path, headers: headersOf(head.h) };
        const body = await recv.readToEnd(REQUEST_MAX);
        return new Request(`http://walkie.direct${path}`, {
          method, headers: headersOf(head.h), ...(method === "GET" || method === "HEAD" ? {} : { body: Uint8Array.from(body) }),
        });
      })();
      const got = await abortable(read, AbortSignal.timeout(REQUEST_READ_MS));
      if ("tunnel" in got) {
        await this.serveTunnel(send, recv, got.path, got.headers, pubkey).catch((err: unknown) => {
          this.d.log.debug("direct_tunnel_failed", { err: (err as Error).message });
          void send.reset(0n).catch(() => undefined);
        });
        return;
      }
      req = got;
    } catch {
      void send.reset(0n).catch(() => undefined);
      void recv.stop(0n).catch(() => undefined);
      return;
    }
    try {
      const res = await this.d.handler(req, pubkey);
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { if (k !== "content-length") headers[k] = v; });
      await send.writeAll(frame({ s: res.status, h: headers }));
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          await writeBody(send, value);
        }
      }
      await send.finish();
    } catch (err) {
      this.d.log.debug("direct_stream_failed", { err: (err as Error).message });
      void send.reset(0n).catch(() => undefined);
    }
  }
}
