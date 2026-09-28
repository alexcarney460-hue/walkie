// The daemon's WebSocket client for the relay (WALKIE-PWA-1), on Bun.connect, so every byte in and out is ours to
// bound. Bun's built-in client WebSocket answers native pings, reassembles fragmented messages and buffers sends where
// the application can't see or limit them (and reports no backpressure: bufferedAmount stays 0); a hostile relay could
// use any of them to grow the daemon's memory. Here:
// - establishment: TCP connect, TLS (chain and host name) and the upgrade answer must all finish within a deadline;
// - outbound: every frame (data, controls, pongs, close) goes through one bounded queue; bytes the kernel hasn't taken
//   yet are counted, and `send` refuses anything that would take the queue past `maxQueued`. Frames wait in lanes (one
//   per room, one for controls) drained round-robin, so one room's backlog doesn't delay another's next message; each
//   frame can report when the kernel took its last byte (the link's acknowledgement positions follow write order);
// - inbound: received chunks are kept as a list (never re-copied); each frame is charged to the caller's budget the
//   moment its header arrives; its header is validated (RFC 6455: known opcodes, clear reserved bits, no mask, canonical
//   lengths, small unfragmented controls); a data message may have at most MAX_FRAGMENTS fragments, no empty non-final
//   one, and a total under the limit, judged from headers before any payload is kept; payloads are copied straight into
//   one growing buffer per message; a frame (and a message) must arrive within a deadline;
// - the upgrade answer must be 101 with `Upgrade: websocket`, `Connection: upgrade`, the right Sec-WebSocket-Accept and
//   no extension or subprotocol we didn't ask for (another status, e.g. a proxy's 502, is an ordinary failure, not a
//   violation); a Close frame must carry a valid (registered or private-use) code and a UTF-8 reason;
// - wss://: Bun.connect reports certificate errors only to the handshake callback (and doesn't check the host name at
//   all), so both are checked there before a byte of the upgrade is sent.
import { createHash, randomBytes } from "node:crypto";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import type { Socket } from "bun";
import { RateLimiter, type BucketSpec } from "../ratelimit.ts";

export interface RelaySocketHandlers {
  open(): void;
  text(s: string): void;
  binary(b: Uint8Array): void;
  /**
   * Once, however the connection ends. `violation`: the peer broke the protocol or a limit (the caller treats it like
   * any other relay violation, with the reconnect penalty).
   */
  close(code: number, reason: string, violation: boolean): void;
}

export interface RelaySocketOptions {
  /** Largest text message accepted (bytes). */
  readonly maxText: number;
  /** Largest binary message accepted (bytes). */
  readonly maxBinary: number;
  /** Outbound bytes the kernel hasn't taken yet: `send` refuses past this (a function: read at each send). */
  readonly maxQueued: number | (() => number);
  /** Charged for every frame as its header arrives (count and wire bytes); false ends the connection (a violation). */
  readonly onFrame?: (bytes: number) => boolean;
  /** Native pings the relay may send (we answer each with a pong). */
  readonly pingRate?: BucketSpec;
  /** Connect + TLS + upgrade answer, in all (default 15 s). */
  readonly establishMs?: number;
  /** One frame's bytes must all arrive within this (default 30 s); a fragmented message within twice that. */
  readonly frameMs?: number;
  /** Tests: a CA to trust for wss:// (a self-signed test relay). */
  readonly ca?: string;
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_HEAD = 16 * 1024;
/** Fragments one message may have. */
export const MAX_FRAGMENTS = 64;
const DEFAULT_PING_RATE: BucketSpec = { capacity: 10, perSecond: 1 };
const ESTABLISH_MS = 15_000;
const FRAME_MS = 30_000;

const OP = { cont: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const;

/** Close codes a peer may send (RFC 6455 §7.4 and the IANA registry: 1012 restart, 1013 try later, 1014 bad gateway). */
function validCloseCode(c: number): boolean {
  return (c >= 1000 && c <= 1003) || (c >= 1007 && c <= 1014) || (c >= 3000 && c <= 4999);
}

/** `reason` as UTF-8, cut to at most `max` bytes on a character boundary (a Close reason is at most 123 bytes). */
export function utf8Cut(reason: string, max: number): Uint8Array {
  const b = new TextEncoder().encode(reason);
  if (b.byteLength <= max) return b;
  let n = max;
  while (n > 0 && ((b[n] as number) & 0xc0) === 0x80) n -= 1; // back off to the start of a character
  return b.subarray(0, n);
}

/** A frame waiting for the kernel, and who to tell once it's all written. */
interface Out { f: Uint8Array; done?: () => void }

/** A frame being received: its header is known, its payload is arriving. */
interface Frame { fin: boolean; op: number; len: number; got: number; control: Uint8Array | null }
/** A data message being reassembled (all its fragments go into one buffer). */
interface Message { op: number; buf: Uint8Array; size: number; fragments: number; timer: ReturnType<typeof setTimeout> | null }

export class RelaySocket {
  private socket: Socket<undefined> | null = null;
  /** Waiting frames per lane (a lane is non-empty while it is in `rr`), drained round-robin; `urgent` (close) first. */
  private readonly lanes = new Map<string, Out[]>();
  private readonly rr: string[] = [];
  private urgent: Out | null = null;
  /** The frame being written (a frame is never interleaved with another). */
  private current: Out | null = null;
  private outBytes = 0;
  private head: Uint8Array | null = new Uint8Array(0); // the HTTP answer, until the upgrade is done
  /** Received bytes not yet parsed, as the chunks they arrived in. */
  private readonly chunks: Uint8Array[] = [];
  private avail = 0;
  private frame: Frame | null = null;
  private msg: Message | null = null;
  private readonly limiter = new RateLimiter();
  private readonly key = randomBytes(16).toString("base64");
  private readonly hostname: string;
  private establish: ReturnType<typeof setTimeout> | null = null;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private ended = false;
  private opened = false;

  private constructor(private readonly url: URL, private readonly h: RelaySocketHandlers, private readonly o: RelaySocketOptions) {
    // URL keeps an IPv6 literal in brackets; connecting and certificate checks want the bare address.
    this.hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  }

  static connect(url: string, h: RelaySocketHandlers, o: RelaySocketOptions): RelaySocket {
    const s = new RelaySocket(new URL(url), h, o);
    s.start();
    return s;
  }

  /** Outbound bytes not yet taken by the kernel. */
  get queued(): number { return this.outBytes; }
  get isOpen(): boolean { return this.opened && !this.ended; }

  /**
   * Sends one message in `lane` (lanes are drained round-robin); `written` is called once the kernel has taken all of
   * it (never if the connection ends first). false (nothing queued) when the connection isn't open or the queue would
   * pass `maxQueued`.
   */
  send(data: string | Uint8Array, lane = "", written?: () => void): boolean {
    if (!this.isOpen) return false;
    const payload = typeof data === "string" ? new TextEncoder().encode(data) : data;
    return this.write(typeof data === "string" ? OP.text : OP.binary, payload, false, lane, written);
  }

  close(code = 1000, reason = ""): void {
    this.end(code, reason, false);
  }

  private end(code: number, reason: string, violation: boolean): void {
    if (this.ended) return;
    if (this.opened) {
      const r = utf8Cut(reason, 123);
      const p = new Uint8Array(2 + r.byteLength);
      new DataView(p.buffer).setUint16(0, code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 && code !== 1015 ? code : 1002);
      p.set(r, 2);
      this.write(OP.close, p, true);
    }
    this.finish(code, reason, violation);
  }

  private violation(code: number, reason: string): void {
    this.end(code, reason, true);
  }

  private start(): void {
    const tls = this.url.protocol === "wss:";
    const port = Number(this.url.port) || (tls ? 443 : 80);
    this.establish = setTimeout(() => this.finish(1006, "the relay didn't answer in time", false), this.o.establishMs ?? ESTABLISH_MS);
    Bun.connect({
      hostname: this.hostname,
      port,
      ...(tls ? { tls: { serverName: this.hostname, ...(this.o.ca ? { ca: this.o.ca } : {}) } } : {}),
      socket: {
        open: (socket) => {
          this.socket = socket as Socket<undefined>;
          if (this.ended) { socket.terminate(); return; }
          if (!tls) this.upgrade(); // over TLS: once the handshake verified the certificate
        },
        // Bun reports a failed certificate verification here (and still says ok, and authorized): check both the
        // chain and the name ourselves, and speak only to a relay that passes.
        handshake: (socket, _ok, err) => {
          if (err) { this.finish(1015, `tls: ${(err as Error).message ?? "certificate not trusted"}`, false); return; }
          const peer = (socket as unknown as { getPeerCertificate?: () => PeerCertificate }).getPeerCertificate?.();
          const bad = peer ? checkServerIdentity(this.hostname, peer) : new Error("no certificate");
          if (bad) { this.finish(1015, `tls: ${bad.message}`, false); return; }
          this.upgrade();
        },
        data: (_socket, chunk) => this.onData(new Uint8Array(chunk)),
        drain: () => this.flush(),
        close: () => this.finish(1006, "connection closed", false),
        error: () => this.finish(1006, "connection error", false),
        connectError: () => this.finish(1006, "can't connect", false),
        end: () => this.finish(1006, "connection ended", false),
      },
    }).catch(() => this.finish(1006, "can't connect", false));
  }

  private upgrade(): void {
    const socket = this.socket;
    if (!socket || this.ended) return;
    const path = `${this.url.pathname}${this.url.search}`;
    socket.write(`GET ${path} HTTP/1.1\r\nHost: ${this.url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
      + `Sec-WebSocket-Key: ${this.key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  }

  private finish(code: number, reason: string, violation: boolean): void {
    if (this.ended) return;
    this.ended = true;
    if (this.establish) clearTimeout(this.establish);
    if (this.frameTimer) clearTimeout(this.frameTimer);
    if (this.msg?.timer) clearTimeout(this.msg.timer);
    const s = this.socket;
    if (s) {
      try { s.end(); } catch { /* gone */ }
      setTimeout(() => { try { s.terminate(); } catch { /* gone */ } }, 1_000).unref?.();
    }
    this.lanes.clear();
    this.rr.length = 0;
    this.urgent = null;
    this.current = null;
    this.outBytes = 0;
    this.chunks.length = 0;
    this.avail = 0;
    this.frame = null;
    this.msg = null;
    this.h.close(code, reason, violation);
  }

  // ---- outbound ------------------------------------------------------------------------------------------------------

  /** A masked client frame, queued in its lane; `force` (close frames) skips the queue cap and goes next. */
  private write(op: number, payload: Uint8Array, force: boolean, lane = "", done?: () => void): boolean {
    const n = payload.byteLength;
    const len = n < 126 ? 0 : n < 65536 ? 2 : 8;
    const f = new Uint8Array(2 + len + 4 + n);
    f[0] = 0x80 | op;
    f[1] = 0x80 | (len === 0 ? n : len === 2 ? 126 : 127);
    const dv = new DataView(f.buffer);
    if (len === 2) dv.setUint16(2, n);
    else if (len === 8) dv.setBigUint64(2, BigInt(n));
    const mask = randomBytes(4);
    const at = 2 + len;
    f.set(mask, at);
    for (let i = 0; i < n; i++) f[at + 4 + i] = (payload[i] as number) ^ (mask[i & 3] as number);
    const maxQueued = typeof this.o.maxQueued === "function" ? this.o.maxQueued() : this.o.maxQueued;
    if (!force && this.outBytes + f.byteLength > maxQueued) return false;
    const o: Out = done ? { f, done } : { f };
    if (force) this.urgent = o;
    else {
      const q = this.lanes.get(lane);
      if (q) q.push(o);
      else { this.lanes.set(lane, [o]); this.rr.push(lane); }
    }
    this.outBytes += f.byteLength;
    this.flush();
    return true;
  }

  /** The next frame to write: a close first, then one frame from each lane in turn. */
  private next(): Out | null {
    if (this.urgent) { const u = this.urgent; this.urgent = null; return u; }
    const lane = this.rr.shift();
    if (lane === undefined) return null;
    const q = this.lanes.get(lane) as Out[];
    const o = q.shift() as Out;
    if (q.length) this.rr.push(lane); else this.lanes.delete(lane);
    return o;
  }

  private flush(): void {
    const s = this.socket;
    if (!s) return;
    for (;;) {
      const c = this.current ?? this.next();
      if (!c) return;
      this.current = c;
      const wrote = s.write(c.f);
      if (wrote <= 0) return; // the kernel is full: drain() calls again
      this.outBytes -= wrote;
      if (wrote < c.f.byteLength) { c.f = c.f.subarray(wrote); return; }
      this.current = null;
      c.done?.();
    }
  }

  // ---- inbound -------------------------------------------------------------------------------------------------------

  private onData(chunk: Uint8Array): void {
    if (this.ended) return;
    if (this.head) {
      const at = this.handshakeAnswer(chunk);
      if (at === null || this.ended) return;
      chunk = chunk.subarray(at); // frames may follow the answer in the same chunk
      if (!chunk.byteLength) return;
    }
    this.chunks.push(chunk);
    this.avail += chunk.byteLength;
    this.parse();
    // A frame (or its header) is part-way in: it must finish within the frame deadline (a slow drip is closed).
    if ((this.frame || this.avail) && !this.frameTimer && !this.ended) {
      this.frameTimer = setTimeout(() => this.violation(1008, "frame too slow"), this.o.frameMs ?? FRAME_MS);
      (this.frameTimer as { unref?: () => void }).unref?.();
    }
  }

  /** Reads the upgrade answer; once it is complete and valid, the offset in `chunk` where frames start (else null). */
  private handshakeAnswer(chunk: Uint8Array): number | null {
    const prev = this.head as Uint8Array;
    const room = MAX_HEAD - prev.byteLength;
    const head = new Uint8Array(prev.byteLength + Math.min(chunk.byteLength, room));
    head.set(prev);
    head.set(chunk.subarray(0, room), prev.byteLength);
    const text = new TextDecoder("latin1").decode(head);
    const end = text.indexOf("\r\n\r\n");
    if (end < 0) {
      if (head.byteLength >= MAX_HEAD) { this.finish(1002, "bad upgrade answer", true); return null; }
      this.head = head;
      return null;
    }
    const lines = text.slice(0, end).split("\r\n");
    const header = (name: string) => lines.slice(1)
      .filter((l) => l.toLowerCase().startsWith(`${name}:`))
      .map((l) => l.slice(name.length + 1).trim());
    const accept = createHash("sha1").update(this.key + GUID).digest("base64");
    const status = lines[0] ?? "";
    if (/^HTTP\/1\.1 426 /.test(status)) { this.finish(4426, status, false); return null; }
    const ok = /^HTTP\/1\.1 101 /.test(status)
      && header("upgrade").some((v) => v.toLowerCase() === "websocket")
      && header("connection").some((v) => v.toLowerCase().split(",").map((t) => t.trim()).includes("upgrade"))
      && header("sec-websocket-accept")[0] === accept
      // we asked for no extension and no subprotocol: an answer that picks one is refused
      && !header("sec-websocket-extensions").length && !header("sec-websocket-protocol").length;
    // Only a 101 with bad headers is the relay's misbehaviour; any other status (a proxy's 502, a 503 while the relay
    // restarts, a 404) is an ordinary failed attempt, retried with the usual backoff.
    if (!ok) { this.finish(/^HTTP\/1\.1 101 /.test(status) ? 1002 : 1006, `bad upgrade answer: ${status.slice(0, 60)}`, /^HTTP\/1\.1 101 /.test(status)); return null; }
    this.head = null;
    this.opened = true;
    if (this.establish) clearTimeout(this.establish);
    this.establish = null;
    this.h.open();
    return end + 4 - prev.byteLength;
  }

  /** Copies the next `n` received bytes into `dst` at `at` (n ≤ avail), dropping consumed chunks. */
  private take(n: number, dst?: Uint8Array, at = 0): void {
    let left = n;
    let off = at;
    while (left > 0) {
      const c = this.chunks[0] as Uint8Array;
      const k = Math.min(c.byteLength, left);
      if (dst) dst.set(c.subarray(0, k), off);
      off += k;
      left -= k;
      this.avail -= k;
      if (k === c.byteLength) this.chunks.shift(); else this.chunks[0] = c.subarray(k);
    }
  }

  /** The first `n` received bytes, without consuming them (n ≤ 14: a frame header). */
  private peek(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let off = 0;
    for (const c of this.chunks) {
      const k = Math.min(c.byteLength, n - off);
      out.set(c.subarray(0, k), off);
      off += k;
      if (off === n) break;
    }
    return out;
  }

  private parse(): void {
    while (!this.ended) {
      if (!this.frame) {
        if (!this.header()) return;
        continue;
      }
      if (!this.payload()) return;
    }
  }

  /** Reads and validates one frame header (false: not enough bytes yet, or the connection ended). */
  private header(): boolean {
    if (this.avail < 2) return false;
    const b2 = this.peek(2);
    const b0 = b2[0] as number;
    const b1 = b2[1] as number;
    const fin = (b0 & 0x80) !== 0;
    const op = b0 & 0x0f;
    const short = b1 & 0x7f;
    const hlen = short === 126 ? 4 : short === 127 ? 10 : 2;
    if (this.avail < hlen) return false;
    const hb = this.peek(hlen);
    let len = short;
    if (short === 126) len = new DataView(hb.buffer).getUint16(2);
    else if (short === 127) {
      const big = new DataView(hb.buffer).getBigUint64(2);
      if (big > BigInt(this.o.maxBinary) || big < 65536n) { this.violation(big < 65536n ? 1002 : 1009, big < 65536n ? "non-canonical length" : "message too big"); return false; }
      len = Number(big);
    }
    if (short === 126 && len < 126) { this.violation(1002, "non-canonical length"); return false; }
    this.take(hlen);
    // Every frame pays the caller's inbound budget the moment its header is in (count and wire bytes).
    if (this.o.onFrame && !this.o.onFrame(hlen + len)) { this.violation(1008, "too many frames"); return false; }
    if (b0 & 0x70) { this.violation(1002, "reserved bits"); return false; }
    if (b1 & 0x80) { this.violation(1002, "masked frame from the server"); return false; }
    const control = op >= 8;
    if (control) {
      if (op !== OP.close && op !== OP.ping && op !== OP.pong) { this.violation(1002, "reserved control opcode"); return false; }
      if (!fin || len > 125) { this.violation(1002, "bad control frame"); return false; }
    } else {
      if (op !== OP.cont && op !== OP.text && op !== OP.binary) { this.violation(1002, "reserved opcode"); return false; }
      if (op === OP.cont && !this.msg) { this.violation(1002, "continuation without a message"); return false; }
      if (op !== OP.cont && this.msg) { this.violation(1002, "new message inside a fragmented one"); return false; }
      if (!fin && len === 0) { this.violation(1002, "empty fragment"); return false; }
      const kind = this.msg ? this.msg.op : op;
      const max = kind === OP.text ? this.o.maxText : this.o.maxBinary;
      const size = (this.msg?.size ?? 0) + len;
      if (size > max) { this.violation(1009, "message too big"); return false; }
      if (this.msg && this.msg.fragments + 1 > MAX_FRAGMENTS) { this.violation(1009, "too many fragments"); return false; }
      if (!this.msg) {
        // A fragmented message must finish within twice the frame deadline.
        const timer = fin ? null : setTimeout(() => this.violation(1008, "message too slow"), 2 * (this.o.frameMs ?? FRAME_MS));
        (timer as { unref?: () => void } | null)?.unref?.();
        // The buffer grows from the running size (doubling, capped at the limit): fragments are never kept one by one.
        // The first buffer is the declared length (already within the limit and charged to the budget); it grows by
        // doubling as fragments arrive (at most 64 of them).
        this.msg = { op, buf: new Uint8Array(len), size: 0, fragments: 0, timer };
      } else {
        this.grow(size, max);
      }
      this.msg.fragments += 1;
    }
    this.frame = { fin, op, len, got: 0, control: control ? new Uint8Array(len) : null };
    return true;
  }

  private grow(size: number, max: number): void {
    const m = this.msg as Message;
    if (size <= m.buf.byteLength) return;
    const next = new Uint8Array(Math.min(max, Math.max(size, m.buf.byteLength * 2, 1_024)));
    next.set(m.buf.subarray(0, m.size));
    m.buf = next;
  }

  /** Moves arrived payload bytes of the current frame into place (false: waiting for more, or ended). */
  private payload(): boolean {
    const f = this.frame as Frame;
    const n = Math.min(f.len - f.got, this.avail);
    if (f.control) this.take(n, f.control, f.got);
    else { const m = this.msg as Message; this.take(n, m.buf, m.size); m.size += n; }
    f.got += n;
    if (f.got < f.len) return false;
    this.frame = null;
    if (this.frameTimer) { clearTimeout(this.frameTimer); this.frameTimer = null; }
    if (f.control) { this.control(f.op, f.control); return !this.ended; }
    if (!f.fin) return true;
    const m = this.msg as Message;
    if (m.timer) clearTimeout(m.timer);
    this.msg = null;
    const whole = m.buf.byteLength === m.size ? m.buf : m.buf.slice(0, m.size);
    if (m.op === OP.text) {
      let s: string;
      try { s = new TextDecoder("utf-8", { fatal: true }).decode(whole); } catch { this.violation(1007, "bad text"); return false; }
      this.h.text(s);
    } else {
      this.h.binary(whole);
    }
    return !this.ended;
  }

  private control(op: number, payload: Uint8Array): void {
    if (op === OP.close) {
      if (payload.byteLength === 1) { this.violation(1002, "bad close frame"); return; }
      if (payload.byteLength >= 2) {
        const code = new DataView(payload.buffer, payload.byteOffset).getUint16(0);
        if (!validCloseCode(code)) { this.violation(1002, "bad close code"); return; }
        try { new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(2)); } catch { this.violation(1007, "bad close reason"); return; }
        this.close(1000, `closed by the relay (${code})`);
        return;
      }
      this.close(1000, "closing");
      return;
    }
    if (op === OP.pong) return; // we never send native pings: an unsolicited pong is ignored (its frame already paid)
    // Native pings are answered (the answer goes through the bounded queue) but only at a modest rate.
    if (!this.limiter.take("ping", this.o.pingRate ?? DEFAULT_PING_RATE)) { this.violation(1008, "too many pings"); return; }
    if (!this.write(OP.pong, payload, false)) this.violation(1008, "relay stopped reading");
  }
}
