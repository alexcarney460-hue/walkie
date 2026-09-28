// One phone connection, on the daemon (WALKIE-PWA-1): the handshake (src/mobile/crypto.ts), then the phone's
// requests, each checked against the phone allow-list, run through the local API as that device (a person, never an
// agent) and projected for the phone (projection.ts). The phone gets Mission Control and nothing else: who is working
// on which machine, open asks and the answer to them, channel posts and a reply box.
//
// The relay in front of this is untrusted, so every input is bounded before it costs anything: frame sizes by stage,
// the bytes queued per connection (and across all of them, via the manager), handshakes per second (ECDH work), an
// authentication deadline that holds until the phone's first valid encrypted message, and a registration deadline for
// pairing links. Concurrency and rates are per device (shared by all its connections), not per connection.
import {
  Channel, daemonReply, decodeJson, encodeJson, MAX_HANDSHAKE, ProtocolError, readHello,
} from "../../mobile/crypto.ts";
import { MAX_FRAME, MAX_REQUEST_ID, type DaemonMsg, type PairInfo, type PhoneMsg } from "../../mobile/wire.ts";
import type { BucketSpec, RateLimiter } from "../ratelimit.ts";
import type { Logger } from "../logger.ts";
import { PHONE_TEXT_MAX, projectedStatus, projectResponse, projectStream } from "./projection.ts";
import type { Reservation } from "./relay-link.ts";

/** What a phone may call: Mission Control's reads, and posting and answering. */
const MOBILE_ROUTES: readonly (readonly [string, RegExp])[] = [
  ["GET", /^\/v1\/(?:me|team|agents|peers|events|asks)$/],
  ["GET", /^\/v1\/events\/[0-9a-f]{16}:[1-9][0-9]{0,15}$/], // EventId
  ["POST", /^\/v1\/(?:post|answer)$/],
];

export function mobileRoute(method: string, path: string): boolean {
  return MOBILE_ROUTES.some(([m, re]) => m === method && re.test(path));
}

/** Live-stream message types a phone receives (everything else, `accounts` included, is dropped). */
export const STREAM_TYPES: ReadonlySet<string> = new Set(["hello", "event", "agents", "nodes", "hidden"]);

/** Requests and stream opens per device: 20/s, bursts of 60. */
export const DEVICE_RATE: BucketSpec = { capacity: 60, perSecond: 20 };
/** Encoded bytes sent to a device (answers and stream messages alike): 1 MiB/s, bursts of 4 MiB. */
export const DEVICE_BYTES: BucketSpec = { capacity: 4 * 1024 * 1024, perSecond: 1024 * 1024 };
/** Messages being encrypted or sent for one link at once; past this the phone (or the relay) isn't keeping up. */
export const MAX_PENDING_WRITES = 32;
/** Extra pending messages allowed for errors and stream ends only. */
const SMALL_RESERVE = 8;
/** Handshakes (ECDH + HKDF, well under a millisecond each) per second across all phones, bursts of 60. */
export const HANDSHAKE_RATE: BucketSpec = { capacity: 60, perSecond: 10 };
/** Handshakes per room: 1/s, bursts of 10. */
export const ROOM_HANDSHAKE_RATE: BucketSpec = { capacity: 10, perSecond: 1 };
/** Per device, across all its connections. */
export const MAX_INFLIGHT = 8;
export const MAX_STREAMS = 2;
/** A projected answer bigger than this (encoded bytes) answers 413 (ask for fewer items). */
export const MAX_RESPONSE = 256 * 1024;
/** A local API answer bigger than this (bytes) isn't even parsed. */
const MAX_RAW_RESPONSE = 4 * MAX_FRAME;
/**
 * Open asks are asked for bounded: texts cut to PHONE_TEXT_MAX and the list cut at this many encoded bytes by the local
 * API itself (so the raw answer stays small for any legal content), then projected and fitted to MAX_RESPONSE.
 */
const ASKS_RAW_BUDGET = 4 * MAX_RESPONSE;
/** `/v1/events?limit=` is capped at this for a phone. */
export const PHONE_EVENTS_LIMIT = 100;
/** A request body bigger than this (encoded bytes) is refused. */
const MAX_REQUEST = 64 * 1024;
const bytes = (s: string): number => new TextEncoder().encode(s).byteLength;

/**
 * The asks that fit the response cap, in order, and whether some were left out (here or already by the local API).
 * Sizes are the JSON-encoded (escaped) UTF-8 bytes each ask adds to the answer.
 */
function fitAsks(out: { asks: unknown[] }, cut: boolean): { asks: unknown[]; truncated?: true } {
  const kept: unknown[] = [];
  let size = bytes(JSON.stringify({ asks: [], truncated: true }));
  for (const a of out.asks) {
    const n = bytes(JSON.stringify(a)) + 1; // the ask and its comma
    if (size + n > MAX_RESPONSE) return { asks: kept, truncated: true };
    kept.push(a);
    size += n;
  }
  return cut ? { asks: kept, truncated: true } : { asks: kept };
}
/** Bytes of frames queued (received, not yet handled) per connection. */
export const SESSION_QUEUE_BYTES = 2 * MAX_FRAME;
/** From the join until the phone's first valid encrypted message. */
export const AUTH_TIMEOUT_MS = 10_000;
/** A pairing link must register within this, from the join (the person reads who they are pairing with first). */
export const REGISTER_TIMEOUT_MS = 120_000;
/** An authenticated heartbeat on a device link. */
export const HEARTBEAT_MS = 15_000;

const PATH_RE = /^\/v1\/[A-Za-z0-9._~\-/%:]*(?:\?[A-Za-z0-9._~\-/%=&+,:@]*)?$/;

export type ServeAs = (req: Request, url: URL, credential: { signal: AbortSignal; expiresAt: number; rateKey: string }) => Promise<Response>;

/** Per-device accounting shared by all of a device's connections (the manager owns it). */
export interface DeviceUsage { inflight: number; streams: number }

export interface TunnelDeps {
  readonly kind: "pair" | "device";
  readonly room: string;
  /**
   * "down": this link no longer owns its slot, or the relay link is down; "full": the relay link's window is full (it
   * is behind: nothing was sent, try less later). `small` messages (errors, stream ends) may use the control reserve.
   */
  send(frame: Uint8Array, small?: boolean, reservation?: Reservation): "sent" | "full" | "down";
  /**
   * Holds this many bytes of the relay link's window (and of this room's share of it) before sealing, so no counter is
   * spent on a message that can't go; null: the link is behind for this room. Send with it, or release it.
   */
  reserve(bytes: number, small?: boolean): Reservation | null;
  kick(): void;
  /** The handshake PSK for this key id in this room, or null. */
  psk(kid: string): Promise<CryptoKey | null>;
  /** Pairing only: turns this session's pairing into a device (single use). */
  register(name: string): Promise<Extract<DaemonMsg, { op: "registered" }>>;
  /** After `registered` is sent: the pairing room can go. */
  registered(): void;
  /** Pairing only: who the phone is pairing with. */
  info(): PairInfo | null;
  /** A live device (and marks it used); false once revoked or expired. */
  touch(deviceId: string): boolean;
  /** A live device, not marking it used. */
  live(deviceId: string): boolean;
  expiresAt(deviceId: string): number | null;
  usage(deviceId: string): DeviceUsage;
  unpair(deviceId: string): void;
  handshakeFailed(): void;
  /** Reserves bytes of the manager's queue across all connections; false = over budget (a hostile relay). */
  queue(bytes: number): boolean;
  /** Posting from the phone never creates a channel (the local API would, as a roster change). */
  channelExists(name: string): boolean;
  serve: ServeAs;
  limiter: RateLimiter;
  log: Logger;
  /** Tests: shorter deadlines. */
  readonly timeouts?: { authMs?: number; registerMs?: number; heartbeatMs?: number; roomMs?: number };
  /** Tests: a smaller per-device byte budget. */
  readonly deviceBytes?: BucketSpec;
}

const err = (code: string, message: string) => ({ error: { code, message } });

export class TunnelSession {
  private state: "hello" | "open" | "closed" = "hello";
  private authed = false;
  private channel: Channel | null = null;
  private deviceId: string | null = null;
  private registeredOnce = false;
  private queued = 0;
  private readonly streams = new Map<number, AbortController>();
  private readonly ended = new AbortController();
  private chain: Promise<void> = Promise.resolve();
  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: TunnelDeps) {
    this.timer(d.timeouts?.authMs ?? AUTH_TIMEOUT_MS, () => { if (!this.authed) this.fail(new ProtocolError("authentication timeout")); });
    if (d.kind === "pair") this.timer(d.timeouts?.registerMs ?? REGISTER_TIMEOUT_MS, () => { if (!this.registeredOnce) this.fail(new ProtocolError("registration timeout")); });
  }

  get device(): string | null { return this.deviceId; }
  inRoom(room: string): boolean { return this.d.room === room; }
  private get closed(): boolean { return this.state === "closed"; }
  get open(): boolean { return this.state === "open"; }

  private timer(ms: number, fn: () => void): void {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    this.timers.push(t);
  }

  /**
   * Frames are handled one at a time, in arrival order (the channel's counters demand it). Sizes and queued bytes are
   * checked before anything is copied.
   */
  onFrame(frame: Uint8Array): void {
    if (this.state === "closed") return;
    // Until the handshake is done nothing but a hello is valid: every frame then is held to the hello's size.
    const max = this.state === "hello" ? MAX_HANDSHAKE : MAX_FRAME;
    if (frame.byteLength > max) { this.fail(new ProtocolError("frame too large")); return; }
    if (this.queued + frame.byteLength > SESSION_QUEUE_BYTES) { this.fail(new ProtocolError("too many queued frames")); return; }
    if (!this.d.queue(frame.byteLength)) { this.fail(new ProtocolError("daemon queue full")); return; }
    this.queued += frame.byteLength;
    const copy = frame.slice();
    this.chain = this.chain
      .then(() => this.handle(copy))
      .catch((e) => this.fail(e))
      .finally(() => { this.queued -= copy.byteLength; this.d.queue(-copy.byteLength); });
  }

  /**
   * Ends everything at once (synchronously): no further frame is handled or sent, streams and requests abort. A pairing
   * link that ends without registering counts as a failed attempt: with a wrong secret only the phone can tell (the
   * confirmation fails there), so this is how the daemon counts them.
   */
  dispose(): void {
    if (this.state === "closed") return;
    if (this.d.kind === "pair" && !this.registeredOnce) this.d.handshakeFailed();
    this.state = "closed";
    for (const t of this.timers) clearTimeout(t);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ended.abort();
    for (const ac of this.streams.values()) ac.abort();
    this.streams.clear();
  }

  /**
   * The device was signed out. Everything stops now (synchronously); then, if the link was authenticated, the phone is
   * told over the encrypted channel (so it forgets its key), and the connection is closed.
   */
  async revoke(): Promise<void> {
    const channel = this.authed && this.state === "open" ? this.channel : null;
    this.dispose();
    if (channel) {
      try { this.d.send(await channel.seal(encodeJson({ op: "revoked" } satisfies DaemonMsg)), true); } catch { /* the link is going anyway */ }
    }
    this.d.kick();
  }

  /** The relay link saw a bad frame from this phone: end this link only. */
  refuse(reason: string): void { this.fail(new ProtocolError(reason)); }

  private fail(e: unknown): void {
    if (this.state === "closed") return;
    this.d.log.warn("mobile_link_refused", { stage: this.authed ? "session" : "handshake", kind: this.d.kind, err: e instanceof ProtocolError ? e.message : "error" });
    this.dispose(); // counts a pairing attempt that didn't register
    this.d.kick();
  }

  private async handle(frame: Uint8Array): Promise<void> {
    if (this.state === "closed") return;
    if (this.state === "hello") return this.handshake(frame);
    const msg = decodeJson(await (this.channel as Channel).open(frame)) as PhoneMsg;
    if (this.closed) return; // ended while decrypting
    if (!this.authed) this.authenticated();
    if (!msg || typeof msg !== "object" || typeof (msg as { op?: unknown }).op !== "string") throw new ProtocolError("bad message");
    if (msg.op === "ping") return;
    if (this.d.kind === "pair") return this.pairMessage(msg);
    if (!this.deviceId || !this.d.touch(this.deviceId)) return this.revoke();
    switch (msg.op) {
      case "req": this.spawn(this.request(msg)); return;
      case "stream": this.spawn(this.stream(msg)); return;
      case "cancel": this.streams.get(msg.id)?.abort(); return;
      case "unpair": this.d.unpair(this.deviceId); return;
      default: throw new ProtocolError("bad message");
    }
  }

  /** The phone proved it holds the PSK (its first frame decrypted): the deadline ends, the heartbeat starts. */
  private authenticated(): void {
    this.authed = true;
    clearTimeout(this.timers[0]);
    if (this.d.kind !== "device") return;
    this.heartbeat = setInterval(() => { void this.write({ op: "ping", ts: Date.now() }).catch(() => undefined); }, this.d.timeouts?.heartbeatMs ?? HEARTBEAT_MS);
    (this.heartbeat as { unref?: () => void }).unref?.();
  }

  private async handshake(frame: Uint8Array): Promise<void> {
    const hello = readHello(frame);
    const kindOk = this.d.kind === "pair" ? hello.kid === "pair" : hello.kid.startsWith("d:");
    if (!kindOk) throw new ProtocolError("wrong key id for this room");
    // Per room first (one phone, or one room's attacker, can't use up everyone's budget), then across all phones.
    if (!this.d.limiter.take(`mobile:handshake:${this.d.room}`, ROOM_HANDSHAKE_RATE)) throw new ProtocolError("too many handshakes in this room");
    if (!this.d.limiter.take("mobile:handshake", HANDSHAKE_RATE)) throw new ProtocolError("too many handshakes");
    const psk = await this.d.psk(hello.kid);
    if (!psk) throw new ProtocolError("unknown or revoked key");
    const { frame: reply, channel } = await daemonReply(hello, psk);
    if (this.state !== "hello") return;
    if (this.d.kind === "device") this.deviceId = hello.kid.slice(2);
    this.channel = channel;
    this.state = "open"; // authenticated only once the phone's first encrypted frame opens
    if (this.d.send(reply, true) !== "sent") this.dispose();
  }

  private infoSent = 0;

  private async pairMessage(msg: PhoneMsg): Promise<void> {
    if (msg.op === "info" && !this.registeredOnce && this.infoSent < 3) {
      this.infoSent += 1;
      const info = this.d.info();
      if (!info) throw new ProtocolError("not on a team");
      await this.write({ op: "info", ...info });
      return;
    }
    if (msg.op !== "register" || this.registeredOnce) throw new ProtocolError("a pairing link only asks who it pairs with and registers");
    this.registeredOnce = true;
    try {
      const out = await this.d.register(msg.name);
      await this.write(out);
    } finally {
      this.d.registered(); // the pairing room goes on every exit: after the answer, or when registration failed
    }
  }

  private spawn(p: Promise<void>): void {
    p.catch((e) => this.fail(e));
  }

  private pendingWrites = 0;

  /**
   * Sends one message. Answers and stream messages are charged, by their encoded size, to the device's byte budget
   * (one place for both). Outcomes: "sent"; "too_large" (wouldn't fit a frame; nothing sent); "over_budget" (the
   * device's bytes, or too many messages still being encrypted/sent: the phone or the relay isn't keeping up);
   * "closed". A signed-out device gets nothing.
   */
  private async write(msg: DaemonMsg): Promise<"sent" | "too_large" | "over_budget" | "closed"> {
    if (this.state !== "open" || !this.channel) return "closed";
    if (this.deviceId && !this.d.live(this.deviceId)) { void this.revoke(); return "closed"; }
    const pt = encodeJson(msg);
    if (pt.byteLength > MAX_FRAME - 64) return "too_large";
    const charged = msg.op === "res" || msg.op === "event";
    // The cap applies to every seal: a heartbeat is skipped (not queued) while anything is still pending.
    if (msg.op === "ping" && this.pendingWrites > 0) return "over_budget";
    if (this.pendingWrites >= MAX_PENDING_WRITES) return "over_budget";
    // A relay link that is behind (a slow uplink), or this room's share of it used up, refuses the send before
    // anything is sealed: the phone gets a 429 or a resync, and the link (and every other phone) carries on. The room
    // is held from here to the send, so a concurrent write can't take it in between.
    const hold = this.d.reserve(pt.byteLength + 64);
    if (!hold) return "over_budget";
    if (charged && this.deviceId && !this.d.limiter.take(`mobile-bytes:${this.deviceId}`, this.d.deviceBytes ?? DEVICE_BYTES, Date.now(), pt.byteLength + 25)) {
      hold.release();
      return "over_budget";
    }
    this.pendingWrites += 1;
    try {
      const frame = await this.channel.seal(pt);
      if (this.state !== "open") return "closed";
      const r = this.d.send(frame, false, hold);
      if (r === "down") { this.dispose(); return "closed"; } // lost the slot or the relay link
      // Can't happen with the room held; if it does, the counter moved, so this link can't continue.
      if (r === "full") { this.fail(new ProtocolError("relay link behind")); return "closed"; }
      return "sent";
    } finally {
      hold.release(); // a no-op once sent
      this.pendingWrites -= 1;
    }
  }

  private async reply(id: number, status: number, body: unknown): Promise<void> {
    const r = await this.write({ op: "res", id, status, body });
    if (r === "too_large") await this.write({ op: "res", id, status: 413, body: err("too_large", "too much for the phone link; ask for fewer items") });
    else if (r === "over_budget") await this.sendSmall({ op: "res", id, status: 429, body: err("rate_limited", "too much data too fast; slow down") });
  }

  /** A small control-like message that bypasses the byte budget (an error or a stream end), still size- and state-checked. */
  private async sendSmall(msg: DaemonMsg): Promise<void> {
    if (this.state !== "open" || !this.channel) return;
    // Errors and stream ends get a small reserve above the write cap; past that the link isn't being read: end it.
    const pt = encodeJson(msg);
    const hold = this.pendingWrites < MAX_PENDING_WRITES + SMALL_RESERVE ? this.d.reserve(pt.byteLength + 64, true) : null;
    if (!hold) { this.fail(new ProtocolError("too many pending messages")); return; }
    this.pendingWrites += 1;
    try {
      const frame = await this.channel.seal(pt);
      if (this.state === "open" && this.d.send(frame, true, hold) !== "sent") this.dispose();
    } finally {
      hold.release();
      this.pendingWrites -= 1;
    }
  }

  /** The request's URL, if it is a well-formed local API path (no other host, no fragment). */
  private target(path: unknown): URL | null {
    if (typeof path !== "string" || path.length > 2_048 || !PATH_RE.test(path)) return null;
    const url = new URL(path, "http://walkie.mobile");
    return url.host === "walkie.mobile" ? url : null;
  }

  private credential(signal: AbortSignal): { signal: AbortSignal; expiresAt: number; rateKey: string } {
    return { signal, expiresAt: this.d.expiresAt(this.deviceId as string) ?? Date.now(), rateKey: `phone:${this.deviceId}` };
  }

  /** The body a phone may send: rebuilt from known fields (no `raw`, no `artifacts`, nothing else). */
  private static body(path: string, b: unknown): Record<string, unknown> {
    const o = (b && typeof b === "object" && !Array.isArray(b) ? b : {}) as Record<string, unknown>;
    const keep = path === "/v1/post" ? ["channel", "text", "thread"] : ["ask", "text", "declined"];
    return Object.fromEntries(keep.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
  }

  private async request(msg: Extract<PhoneMsg, { op: "req" }>): Promise<void> {
    const id = msg.id;
    if (!Number.isInteger(id) || id < 1 || id > MAX_REQUEST_ID) throw new ProtocolError("bad request id");
    const url = this.target(msg.path);
    const method = msg.method;
    if (!url || (method !== "GET" && method !== "POST") || !mobileRoute(method, url.pathname)) {
      return this.reply(id, 403, err("forbidden", "not available on the phone"));
    }
    const dev = this.deviceId as string;
    const usage = this.d.usage(dev);
    if (usage.inflight >= MAX_INFLIGHT || !this.d.limiter.take(`mobile:${dev}`, DEVICE_RATE)) {
      return this.reply(id, 429, err("rate_limited", "too many requests; slow down"));
    }
    if (url.pathname === "/v1/asks") {
      // Cut a little past the phone's own cut, so a text the local API cut is still longer than PHONE_TEXT_MAX and the
      // projection cuts (and marks) it itself: the marker never comes from a body's own `truncated` field.
      url.searchParams.set("text_max", String(PHONE_TEXT_MAX + 2));
      url.searchParams.set("max_bytes", String(ASKS_RAW_BUDGET));
    }
    if (url.pathname === "/v1/events") {
      const limit = Number(url.searchParams.get("limit") ?? PHONE_EVENTS_LIMIT);
      url.searchParams.set("limit", String(Number.isInteger(limit) && limit > 0 ? Math.min(limit, PHONE_EVENTS_LIMIT) : PHONE_EVENTS_LIMIT));
    }
    const body = method === "POST" ? TunnelSession.body(url.pathname, msg.body) : undefined;
    if (body && url.pathname === "/v1/post" && (typeof body.channel !== "string" || !this.d.channelExists(body.channel.replace(/^#/, "")))) {
      return this.reply(id, 404, err("unknown_channel", "no such channel (the phone posts to existing channels only)"));
    }
    const json = body ? JSON.stringify(body) : undefined;
    if (json && bytes(json) > MAX_REQUEST) return this.reply(id, 413, err("too_large", "request too large"));
    usage.inflight += 1;
    try {
      const req = new Request(url, {
        method, signal: this.ended.signal,
        headers: json ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
        ...(json ? { body: json } : {}),
      });
      const res = await this.d.serve(req, url, this.credential(this.ended.signal));
      const text = await res.text();
      const tooBig = () => this.reply(id, 413, err("too_large", "too much for the phone link; ask for fewer items"));
      if (bytes(text) > MAX_RAW_RESPONSE) return tooBig();
      let parsed: unknown = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
      let out = projectResponse(url.pathname, res.status, parsed);
      // Open asks have no paging: keep as many (in order) as fit the cap and say the list was cut.
      if (url.pathname === "/v1/asks" && out) out = fitAsks(out as { asks: unknown[] }, (parsed as { truncated?: unknown } | null)?.truncated === true);
      // The cap is on what the phone would get (the projection), in encoded bytes.
      if (bytes(JSON.stringify(out ?? null)) > MAX_RESPONSE) return tooBig();
      return this.reply(id, projectedStatus(url.pathname, res.status, parsed), out);
    } finally {
      usage.inflight -= 1;
    }
  }

  private async stream(msg: Extract<PhoneMsg, { op: "stream" }>): Promise<void> {
    const id = msg.id;
    if (!Number.isInteger(id) || id < 1 || id > MAX_REQUEST_ID) throw new ProtocolError("bad request id");
    const url = this.target(msg.path);
    if (!url || url.pathname !== "/v1/stream") { await this.sendSmall({ op: "end", id, status: 403, body: err("forbidden", "not available on the phone") }); return; }
    const dev = this.deviceId as string;
    const usage = this.d.usage(dev);
    if (usage.streams >= MAX_STREAMS || this.streams.has(id) || !this.d.limiter.take(`mobile:${dev}`, DEVICE_RATE)) {
      await this.sendSmall({ op: "end", id, status: 429, body: err("rate_limited", "too many live streams") });
      return;
    }
    const ac = new AbortController();
    this.streams.set(id, ac);
    usage.streams += 1;
    const signal = AbortSignal.any([this.ended.signal, ac.signal]);
    try {
      const res = await this.d.serve(new Request(url, { signal, headers: { Accept: "text/event-stream" } }), url, this.credential(signal));
      if (!res.ok || !res.body) {
        let body: unknown = null;
        try { body = JSON.parse(await res.text()); } catch { body = null; }
        await this.sendSmall({ op: "end", id, status: res.status, body: projectResponse("/v1/stream", res.status, body) });
        return;
      }
      const ended = await this.pump(id, dev, res.body, signal);
      if (ended) await this.sendSmall({ op: "end", id });
    } finally {
      this.streams.delete(id);
      usage.streams -= 1;
    }
  }

  /** Reads SSE frames and forwards the allowed, projected message types, each as one encrypted message. */
  /** True when the stream ended by itself (the caller sends `end`); false when it was ended here or aborted. */
  private async pump(id: number, dev: string, body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<boolean> {
    const reader = body.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
    const stop = () => { reader.cancel().catch(() => undefined); };
    signal.addEventListener("abort", stop, { once: true });
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return !signal.aborted;
        if (signal.aborted) return false;
        if (!this.d.live(dev)) { void this.revoke(); return false; } // signed out while streaming
        buf += value;
        if (buf.length > MAX_FRAME) throw new ProtocolError("stream frame too large");
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let type = "message";
          const data: string[] = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) type = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          }
          if (!data.length || !STREAM_TYPES.has(type)) continue;
          let parsed: unknown;
          try { parsed = JSON.parse(data.join("\n")); } catch { continue; }
          const out = projectStream(type, parsed);
          if (out === null) continue;
          const r = await this.write({ op: "event", id, type: out.type, data: out.data }); // one too big for a frame is skipped
          if (r === "over_budget") {
            // The phone (or the relay) isn't keeping up: end this stream; the app reloads and resubscribes.
            await this.sendSmall({ op: "end", id, status: 429, body: err("resync", "live updates fell behind; reload") });
            this.streams.get(id)?.abort();
            return false;
          }
          if (r === "closed") return false;
        }
      }
    } catch (e) {
      if (!signal.aborted) throw e;
      return false;
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }
}
