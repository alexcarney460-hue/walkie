// The phone's side of the mobile link (WALKIE-PWA-1): used by the phone app (src/mobile/pwa) and by the tests' headless
// phone. Connects to a relay room, runs the handshake, then sends requests and live-stream subscriptions over the
// encrypted channel. Browser and Bun alike (WebSocket + WebCrypto only).
import { decodeJson, encodeJson, MAX_HANDSHAKE, phoneFinish, phoneHello, ProtocolError, type Channel } from "./crypto.ts";
import { CLOSE, MAX_FRAME, type DaemonMsg, type PairInfo, type PhoneMsg } from "./wire.ts";

/** Frames received but not yet decrypted: past either bound the link is closed (a relay flooding the phone). */
export const QUEUE_MAX_BYTES = 4 * MAX_FRAME;
export const QUEUE_MAX_FRAMES = 256;

/** A request with no answer by then resolves as a 504 (and the link counts as stale). */
export const REQUEST_TIMEOUT_MS = 20_000;
/** A device link with no frame for this long (the daemon's heartbeat is every 15 s) is closed as stale. */
export const SILENCE_MS = 45_000;

export interface LinkOptions {
  /** ws(s)://host of the relay. */
  readonly relay: string;
  readonly room: string;
  /** "pair" in a pairing room, "d:<device id>" in the device's own room. */
  readonly kid: string;
  readonly psk: CryptoKey;
  readonly timeoutMs?: number;
  readonly WebSocket?: typeof WebSocket;
}

export interface LinkResponse<T = unknown> { readonly status: number; readonly body: T }
export type Registered = Extract<DaemonMsg, { op: "registered" }>;

/** Why a link ended, in words for a person. */
export function closeReason(code: number): string {
  switch (code) {
    case CLOSE.daemonOffline: return "Your computer is offline, asleep, or its Walkie daemon isn't running.";
    case CLOSE.daemonLeft: return "Your computer went offline.";
    case CLOSE.kicked: return "Your computer ended the connection (if this keeps happening, unpair this phone and pair it again).";
    case CLOSE.limit: return "Too many requests or connections; try again in a moment.";
    case CLOSE.roomTaken: return "Your computer reconnected; reconnecting.";
    case CLOSE.stale: return "No word from your computer for a while; reconnecting.";
    default: return "The connection to your computer was lost.";
  }
}

export class LinkError extends Error {
  constructor(message: string, readonly code: number | null, readonly revoked = false) { super(message); }
}

export class MobileLink {
  /** Called once when the link ends (after a successful open). */
  onClose: ((err: LinkError) => void) | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, (m: DaemonMsg) => void>();
  private readonly streams = new Map<number, { on: (type: string, data: unknown) => void; end: (err?: LinkError) => void }>();
  private registerWaiter: { resolve: (m: Registered) => void; reject: (e: LinkError) => void } | null = null;
  private infoWaiter: { resolve: (m: PairInfo) => void; reject: (e: LinkError) => void } | null = null;
  /** When the last authenticated frame arrived (heartbeats included). */
  lastFrameAt = Date.now();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private revoked = false;

  private constructor(private readonly ws: WebSocket, private readonly channel: Channel) {}

  /** Connects and runs the handshake; rejects with a LinkError a person can read. */
  static open(o: LinkOptions): Promise<MobileLink> {
    const WS = o.WebSocket ?? globalThis.WebSocket;
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WS(`${o.relay}/v1/phone?room=${encodeURIComponent(o.room)}`);
      } catch {
        reject(new LinkError("Can't reach the Walkie relay.", null));
        return;
      }
      ws.binaryType = "arraybuffer";
      let settled = false;
      let link: MobileLink | null = null;
      let state: Awaited<ReturnType<typeof phoneHello>>["state"] | null = null;
      const fail = (err: LinkError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (link) { link.onClose = null; link.close(err.code ?? 1000); } // a half-open link is closed, not leaked
        try { ws.close(1000); } catch { /* already closed */ }
        reject(err);
      };
      const timer = setTimeout(() => fail(new LinkError("Your computer didn't answer. Is it awake and online?", null)), o.timeoutMs ?? 15_000);
      ws.onopen = async () => {
        try {
          const h = await phoneHello(o.kid);
          state = h.state;
          ws.send(h.frame);
        } catch {
          fail(new LinkError("Couldn't start a secure connection.", null));
        }
      };
      ws.onmessage = (ev: MessageEvent) => {
        // Text is never valid on the phone link, and sizes are checked before anything else, whatever the stage.
        if (typeof ev.data === "string") { if (link && settled) link.close(CLOSE.bad); else fail(new LinkError("Couldn't start a secure connection.", CLOSE.bad)); return; }
        if (link) { link.receive(ev.data); return; } // the channel exists (the open may still await its ping)
        if (settled) return;
        const size = (ev.data as ArrayBuffer).byteLength;
        // Until the handshake is done only the daemon's reply is valid: anything bigger, or anything more, ends it.
        if (size > MAX_HANDSHAKE || !state) { fail(new LinkError("Couldn't start a secure connection.", CLOSE.bad)); return; }
        const s = state;
        state = null;
        phoneFinish(s, new Uint8Array(ev.data as ArrayBuffer), o.psk).then((channel) => {
          if (settled) return;
          const l = new MobileLink(ws, channel);
          link = l;
          // Prove the key at once (the daemon drops a link without a valid encrypted frame by its deadline); the open
          // settles only when that ping is out: a close or failure meanwhile rejects and closes.
          l.send({ op: "ping" }).then(() => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(l);
          }, () => fail(new LinkError("Couldn't start a secure connection.", null)));
        }, (err: unknown) => fail(new LinkError(err instanceof ProtocolError ? "This pairing isn't valid any more. Pair the phone again." : "Couldn't start a secure connection.", null)));
      };
      ws.onclose = (ev: CloseEvent) => {
        if (link && settled) { link.socketClosed(ev.code); return; }
        fail(new LinkError(closeReason(ev.code), ev.code));
      };
      ws.onerror = () => undefined; // onclose follows
    });
  }

  get isOpen(): boolean { return !this.closed; }

  /**
   * Device links: close the link when nothing authenticated arrived for `silenceMs` (a relay that swallows frames
   * while keeping the socket open would otherwise leave the app showing old data as live).
   */
  watch(silenceMs = SILENCE_MS): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastFrameAt > silenceMs) this.close(CLOSE.stale);
    }, Math.min(5_000, silenceMs / 3));
  }

  /** A local API call (only the phone's allow-list answers anything but 403). No answer in time: a 504. */
  async request<T = unknown>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<LinkResponse<T>> {
    const id = this.nextId++;
    const reply = new Promise<DaemonMsg>((resolve) => this.pending.set(id, resolve));
    await this.send({ op: "req", id, method, path, ...(body !== undefined ? { body } : {}) });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<DaemonMsg>((resolve) => {
      timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ op: "res", id, status: 504, body: { error: { code: "timeout", message: "Your computer didn't answer in time." } } });
      }, timeoutMs);
    });
    const m = await Promise.race([reply, late]).finally(() => clearTimeout(timer));
    if (m.op !== "res") throw new LinkError("unexpected answer", null);
    return { status: m.status, body: m.body as T };
  }

  /** Pairing links: who this pairs with (team, person, computer), for the person to confirm before registering. */
  async info(): Promise<PairInfo> {
    const reply = new Promise<PairInfo>((resolve, reject) => { this.infoWaiter = { resolve, reject }; });
    await this.send({ op: "info" });
    return reply;
  }

  /** The live stream: `on` per message until `end`; the returned function cancels it. */
  stream(path: string, on: (type: string, data: unknown) => void, end: (err?: LinkError) => void): () => void {
    const id = this.nextId++;
    this.streams.set(id, { on, end });
    void this.send({ op: "stream", id, path }).catch((err: unknown) => {
      this.streams.delete(id);
      end(err instanceof LinkError ? err : new LinkError("stream failed", null));
    });
    return () => {
      if (!this.streams.delete(id)) return;
      void this.send({ op: "cancel", id }).catch(() => undefined);
    };
  }

  /** Pairing links only: become a device. */
  async register(name: string): Promise<Registered> {
    const reply = new Promise<Registered>((resolve, reject) => { this.registerWaiter = { resolve, reject }; });
    await this.send({ op: "register", name });
    return reply;
  }

  /** Asks the daemon to revoke this device (the phone forgets its key either way). */
  async unpair(): Promise<void> {
    await this.send({ op: "unpair" }).catch(() => undefined);
  }

  close(code = 1000): void {
    if (this.closed) return;
    try { this.ws.close(1000, "bye"); } catch { /* ignore */ }
    this.ended(code);
  }

  private async send(msg: PhoneMsg): Promise<void> {
    if (this.closed) throw new LinkError("not connected", null);
    const frame = await this.channel.seal(encodeJson(msg));
    if (this.closed) throw new LinkError("not connected", null);
    this.ws.send(frame);
  }

  private queuedBytes = 0;
  private queuedFrames = 0;

  /** Size and queue limits apply before a frame is kept; decryption happens in order after that. */
  receive(data: unknown): void {
    if (this.closed || typeof data === "string") return;
    const size = (data as ArrayBuffer).byteLength;
    if (size < 1 || size > MAX_FRAME) { this.close(CLOSE.bad); return; }
    if (this.queuedFrames + 1 > QUEUE_MAX_FRAMES || this.queuedBytes + size > QUEUE_MAX_BYTES) { this.close(CLOSE.limit); return; }
    this.queuedFrames += 1;
    this.queuedBytes += size;
    const bytes = new Uint8Array(data as ArrayBuffer);
    this.chain = this.chain.then(async () => {
      this.queuedFrames -= 1;
      this.queuedBytes -= size;
      if (this.closed) return;
      let msg: DaemonMsg;
      try {
        msg = decodeJson(await this.channel.open(bytes)) as DaemonMsg;
      } catch {
        this.close(); // a frame that fails authentication ends the link
        return;
      }
      this.lastFrameAt = Date.now();
      this.dispatch(msg);
    });
  }

  private dispatch(m: DaemonMsg): void {
    switch (m.op) {
      case "res": { const r = this.pending.get(m.id); this.pending.delete(m.id); r?.(m); return; }
      case "event": this.streams.get(m.id)?.on(m.type, m.data); return;
      case "end": {
        const s = this.streams.get(m.id);
        this.streams.delete(m.id);
        s?.end(m.status ? new LinkError(errorMessage(m.body) ?? `stream refused (${m.status})`, m.status) : undefined);
        return;
      }
      case "registered": { const w = this.registerWaiter; this.registerWaiter = null; w?.resolve(m); return; }
      case "info": { const w = this.infoWaiter; this.infoWaiter = null; w?.resolve({ team: m.team, handle: m.handle, host: m.host }); return; }
      case "revoked": this.revoked = true; return;
      case "ping": return; // lastFrameAt already moved
    }
  }

  /** The socket closed: frames already received are handled first (a daemon may answer, then close). */
  socketClosed(code: number): void {
    this.chain = this.chain.then(() => this.ended(code));
  }

  private ended(code: number): void {
    if (this.closed) return;
    this.closed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.registerWaiter?.reject(new LinkError(closeReason(code), code));
    this.registerWaiter = null;
    this.infoWaiter?.reject(new LinkError(closeReason(code), code));
    this.infoWaiter = null;
    const err = new LinkError(this.revoked ? "This phone was signed out from your computer." : closeReason(code), code, this.revoked);
    for (const r of this.pending.values()) r({ op: "res", id: 0, status: 503, body: { error: { code: "offline", message: err.message } } });
    this.pending.clear();
    for (const s of this.streams.values()) s.end(err);
    this.streams.clear();
    this.onClose?.(err);
  }
}

function errorMessage(body: unknown): string | null {
  const e = (body as { error?: { message?: unknown } } | null)?.error;
  return typeof e?.message === "string" ? e.message : null;
}
