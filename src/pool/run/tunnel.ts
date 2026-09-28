// Byte tunnels for split runs (WALKIE-POOL-2, hardened in POOL-3). llama-server on the head speaks llama.cpp's RPC
// protocol to each rpc-server; neither side ever listens beyond 127.0.0.1. The bytes cross Walkie's authenticated
// peer transport:
//   Walkie Direct  one iroh QUIC bi-stream: read on demand, so QUIC flow control is the backpressure
//   Tailscale      a WebSocket on the existing peer API port. Bun 1.3's WebSockets can't stop reading their socket
//                  and the client's bufferedAmount doesn't track what is in flight, so flow control is a credit
//                  WINDOW: a sender may have at most WINDOW bytes the receiver hasn't consumed; the receiver sends
//                  "a<n>" text frames as it consumes n bytes. A sender that goes past the window (a head or worker
//                  ignoring credits) overruns the receiver's queue, which is then dropped and the tunnel closed:
//                  a peer can never grow this daemon's memory beyond WINDOW per tunnel.
// and a loopback TCP socket at each end (socket pause/resume: real backpressure). An End is one side; splice() pumps
// two Ends into each other until either closes, metering and filtering one direction.
import type { Socket } from "node:net";

export interface End {
  /** Next chunk; null once the side is closed. */
  read(): Promise<Uint8Array | null>;
  /** Resolves when the chunk is accepted (backpressure); rejects once the side is closed. */
  write(b: Uint8Array): Promise<void>;
  close(): void;
  /** Resolves once this side is closed, from either end (splice stops pumping in both directions then). */
  readonly done: Promise<void>;
}

/** Credit window of a WebSocket tunnel direction, and so the most one tunnel end ever queues. */
export const WINDOW = 8 * 1024 * 1024;
/** The receiver acknowledges consumed bytes at least this often. */
const ACK_EVERY = 512 * 1024;
/** TCP ends: pause the socket above HIGH_WATER queued bytes, resume below LOW_WATER. */
export const HIGH_WATER = 4 * 1024 * 1024;
export const LOW_WATER = 1024 * 1024;
const CHUNK = 64 * 1024;
/** Largest WebSocket frame a tunnel sends (the peer API accepts 1 MiB messages). */
const WS_FRAME = 256 * 1024;

class Closed extends Error { constructor() { super("tunnel closed"); } }

/** Why an end closed itself, for logs and tests; null = the other side or a normal close. */
export type EndFault = "receive_budget_exceeded" | "bad_credit" | null;

/** A queue of received chunks with a waiting reader; `limit` bytes queued at most (then onOverflow). */
class Inbox {
  private q: Uint8Array[] = [];
  bytes = 0;
  /** The most bytes ever queued at once (at most `limit` + one frame: the frame that overran it). */
  peak = 0;
  private waiter: ((b: Uint8Array | null) => void) | null = null;
  done = false;
  private high = false;
  constructor(private readonly h: { onHigh?: () => void; onLow?: () => void; onRead?: (n: number) => void; limit?: number; onOverflow?: () => void }) {}

  push(b: Uint8Array): void {
    if (this.done) return;
    if (this.waiter) { const w = this.waiter; this.waiter = null; this.h.onRead?.(b.byteLength); w(b); return; }
    this.q.push(b);
    this.bytes += b.byteLength;
    if (this.bytes > this.peak) this.peak = this.bytes;
    if (!this.high && this.bytes > HIGH_WATER && this.h.onHigh) { this.high = true; this.h.onHigh(); }
    if (this.h.limit !== undefined && this.bytes > this.h.limit) {
      this.q = [];
      this.bytes = 0;
      this.h.onOverflow?.();
    }
  }

  end(): void {
    this.done = true;
    this.q = [];
    this.bytes = 0;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w(null); }
  }

  read(): Promise<Uint8Array | null> {
    const b = this.q.shift();
    if (b) {
      this.bytes -= b.byteLength;
      if (this.high && this.bytes < LOW_WATER) { this.high = false; this.h.onLow?.(); }
      this.h.onRead?.(b.byteLength);
      return Promise.resolve(b);
    }
    if (this.done) return Promise.resolve(null);
    return new Promise((resolve) => { this.waiter = resolve; });
  }
}

function signal(): { done: Promise<void>; fire: () => void } {
  let fire: () => void = () => undefined;
  const done = new Promise<void>((resolve) => { fire = resolve; });
  return { done, fire };
}

/** A loopback TCP socket (llama-server's connection on the head, the rpc-server connection on a worker). */
export function tcpEnd(sock: Socket): End {
  const inbox = new Inbox({ onHigh: () => sock.pause(), onLow: () => sock.resume() });
  const sig = signal();
  let closed = false;
  const finish = (): void => { closed = true; inbox.end(); sig.fire(); };
  sock.on("data", (d: Buffer) => inbox.push(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)));
  sock.on("end", finish);
  sock.on("close", finish);
  sock.on("error", finish);
  sock.setNoDelay(true);
  return {
    done: sig.done,
    read: () => inbox.read(),
    write: (b) => new Promise<void>((resolve, reject) => {
      if (closed || sock.destroyed) { reject(new Closed()); return; }
      if (sock.write(b)) { resolve(); return; }
      const onDrain = (): void => { sock.off("close", onClose); resolve(); };
      const onClose = (): void => { sock.off("drain", onDrain); reject(new Closed()); };
      sock.once("drain", onDrain);
      sock.once("close", onClose);
    }),
    close: () => { if (!sock.destroyed) sock.destroy(); finish(); },
  };
}

/** The iroh stream types this needs (src/daemon/direct/net.ts hands them over). */
export interface IrohSend { writeAll(buf: number[]): Promise<void>; finish(): Promise<void>; reset(code: bigint): Promise<void> }
export interface IrohRecv { read(limit: number): Promise<number[]>; stop(code: bigint): Promise<void> }

/** One Walkie Direct bi-stream after its head frame. */
export function irohEnd(send: IrohSend, recv: IrohRecv): End {
  let closed = false;
  const sig = signal();
  const shut = (): void => { closed = true; sig.fire(); };
  return {
    done: sig.done,
    read: async () => {
      if (closed) return null;
      try {
        // A read pending when the stream is closed here may never settle in iroh 1.1: the close ends it.
        const a = await Promise.race([recv.read(CHUNK), sig.done.then(() => null)]);
        if (a && a.length) return Uint8Array.from(a);
      } catch { /* reset */ }
      shut();
      return null;
    },
    write: async (b) => {
      if (closed) throw new Closed();
      try {
        for (let off = 0; off < b.byteLength; off += CHUNK) {
          const w = await Promise.race([send.writeAll(Array.from(b.subarray(off, off + CHUNK))).then(() => true), sig.done.then(() => false)]);
          if (!w) throw new Closed();
        }
      } catch { shut(); throw new Closed(); }
    },
    close: () => {
      if (closed) return;
      shut();
      void send.reset(0n).catch(() => undefined);
      void recv.stop(0n).catch(() => undefined);
    },
  };
}

/** What a WebSocket end needs from either Bun's client WebSocket or a ServerWebSocket. */
export interface WsLike {
  sendBytes(b: Uint8Array): void;
  sendText(t: string): void;
  close(): void;
}

/**
 * One end of a Tailscale tunnel. The owner feeds it with message() / closed() (the socket's events). Sending: at most
 * WINDOW bytes the other side hasn't acknowledged. Receiving: consumed bytes are acknowledged ("a<n>"); a queue past
 * WINDOW means the sender ignored the window, and the tunnel is closed (fault "receive_budget_exceeded"). An ack for
 * more than was sent is a protocol error (fault "bad_credit").
 */
export class WsEnd implements End {
  readonly inbox: Inbox;
  private inFlight = 0;
  private unacked = 0;
  private isClosed = false;
  private wake: (() => void) | null = null;
  private readonly sig = signal();
  readonly done: Promise<void> = this.sig.done;
  /** Set when this end closed itself because the peer broke the credit protocol. */
  fault: EndFault = null;
  constructor(private readonly ws: WsLike, private readonly onFault?: (f: NonNullable<EndFault>) => void) {
    this.inbox = new Inbox({
      limit: WINDOW,
      onOverflow: () => this.faulted("receive_budget_exceeded"),
      onRead: (n) => {
        this.unacked += n;
        if (this.unacked >= ACK_EVERY || this.inbox.bytes === 0) this.ack();
      },
    });
  }

  private faulted(f: NonNullable<EndFault>): void {
    if (this.fault) return;
    this.fault = f;
    this.onFault?.(f);
    this.close();
  }

  private ack(): void {
    if (this.isClosed || this.unacked === 0) return;
    const n = this.unacked;
    this.unacked = 0;
    try { this.ws.sendText(`a${n}`); } catch { /* closing */ }
  }

  message(data: string | Uint8Array | ArrayBuffer): void {
    if (typeof data === "string") {
      const m = /^a(\d{1,10})$/.exec(data);
      const n = m ? Number(m[1]) : NaN;
      if (!Number.isSafeInteger(n) || n > this.inFlight) { this.faulted("bad_credit"); return; }
      this.inFlight -= n;
      const w = this.wake;
      this.wake = null;
      w?.();
      return;
    }
    this.inbox.push(data instanceof Uint8Array ? data : new Uint8Array(data));
  }

  closed(): void {
    this.isClosed = true;
    this.inbox.end();
    const w = this.wake;
    this.wake = null;
    w?.();
    this.sig.fire();
  }

  read(): Promise<Uint8Array | null> { return this.inbox.read(); }

  async write(b: Uint8Array): Promise<void> {
    // Frames stay well under the server's 1 MiB message limit, whatever size the socket handed us.
    for (let off = 0; off < b.byteLength; off += WS_FRAME) {
      const frame = b.byteLength <= WS_FRAME ? b : b.subarray(off, off + WS_FRAME);
      while (!this.isClosed && this.inFlight + frame.byteLength > WINDOW) {
        await new Promise<void>((resolve) => { this.wake = resolve; });
      }
      if (this.isClosed) throw new Closed();
      this.inFlight += frame.byteLength;
      this.ws.sendBytes(frame);
    }
  }

  close(): void {
    if (this.isClosed) return;
    this.closed();
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

/** A byte budget: `burst` at once, refilled at `perSecond`; take() waits (backpressure) rather than failing. */
export class ByteBucket {
  private tokens: number;
  private at = performance.now();
  constructor(readonly burst: number, readonly perSecond: number) { this.tokens = burst; }
  async take(n: number): Promise<void> {
    const now = performance.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.perSecond);
    this.at = now;
    this.tokens -= n;
    if (this.tokens < 0) await Bun.sleep(Math.ceil((-this.tokens / this.perSecond) * 1000));
  }
}

/** Rewrites or holds back a direction's bytes (the worker's RPC guard); throws to close the tunnel. */
export type Transform = (b: Uint8Array) => Uint8Array[];

async function pump(from: End, to: End, meter?: (n: number) => Promise<void>, transform?: Transform): Promise<number> {
  let total = 0;
  for (;;) {
    const b = await from.read();
    if (!b) return total;
    if (meter) await meter(b.byteLength);
    for (const x of transform ? transform(b) : [b]) if (x.byteLength) await to.write(x);
    total += b.byteLength;
  }
}

export interface SpliceResult { up: number; down: number; error: string | null }

/**
 * Pumps a <-> b until either side closes (even while a pump is blocked writing to the other one), then closes both.
 * `meterAtoB` / `transformAtoB` apply to bytes going from a to b (on a worker: the tunnel into rpc-server).
 */
export async function splice(a: End, b: End, meterAtoB?: (n: number) => Promise<void>, transformAtoB?: Transform, countBtoA?: (n: number) => void): Promise<SpliceResult> {
  let up = 0;
  let down = 0;
  let error: string | null = null;
  const note = (e: unknown): void => { if (!(e instanceof Closed) && !error) error = (e as Error).message; };
  const ab = pump(a, b, meterAtoB, transformAtoB).then((n) => { up = n; }, note);
  const ba = pump(b, a, countBtoA ? async (n) => { countBtoA(n); } : undefined).then((n) => { down = n; }, note);
  await Promise.race([ab, ba, a.done, b.done]);
  a.close();
  b.close();
  await Promise.allSettled([ab, ba]);
  return { up, down, error };
}
