// Walkie on your phone (WALKIE-PWA-1). The phone app is a static page on the Walkie site; it reaches this daemon
// through a relay that forwards end-to-end encrypted frames (src/relay/server.ts, src/mobile/crypto.ts). Off by
// default: the daemon connects to the relay only while a phone is paired or a pairing is in progress, and no local
// listener is added or exposed.
//
//   pair()      mints a 10-minute single-use secret; the QR code is <app>#pair=<secret>; the daemon claims that
//               pairing's relay room and waits for the phone's handshake
//   register    (the phone, over the pairing link) becomes a device with its own key and moves to its own room
//               (one per device, keyed from a secret that never leaves the daemon), so a signed-out phone knows
//               no room that is still held and can't take another phone's slots
//   revoke      ends a device's key and its open connection, and gives up its room
import { hkdfSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { b64u, hkdfKey, randomBytes, roomOf, unb64u } from "../../mobile/crypto.ts";
import type { DaemonMsg, PairInfo } from "../../mobile/wire.ts";
import { RELEASE_BUILD } from "../../license/service.ts";
import { SITE_ORIGIN } from "../../license/site.ts";
import type { Core } from "../core.ts";
import { HttpError } from "../http.ts";
import type { Logger } from "../logger.ts";
import type { MobileStatus, PairView } from "../../mobile/views.ts";
import { DeviceSessions, type DeviceOptions } from "./devices.ts";

export type { MobileStatus, PairView };
import { PairingSecrets, type PairingOptions } from "./pairing.ts";
import { qrRows } from "./qr.ts";
import { RelayLink } from "./relay-link.ts";
import { TunnelSession, type DeviceUsage, type ServeAs } from "./tunnel.ts";
import type { BucketSpec } from "../ratelimit.ts";
import { MAX_FRAME, MAX_PHONES_PER_ROOM, MAX_SLOTS } from "../../mobile/wire.ts";

/** The relay Walkie runs (Fly app `walkie-relay`). */
export const RELAY_URL = "wss://walkie-relay.fly.dev";
/** The phone app (a static page on the Walkie site). */
export const APP_URL = `${SITE_ORIGIN}/m`;
const SWEEP_MS = 30_000;
/** Bytes of phone frames queued across every connection before the relay link counts as abusive. */
export const GLOBAL_QUEUE_BYTES = 8 * MAX_FRAME;

/**
 * Source runs only (WALKIE_DEV=1, never a release binary): a loopback relay and app for local testing, like the
 * license service override (src/license/service.ts).
 */
export function mobileUrlsFromEnv(env: Record<string, string | undefined> = process.env, release = RELEASE_BUILD): { relayUrl: string; appUrl: string } {
  const out = { relayUrl: RELAY_URL, appUrl: APP_URL };
  if (release || env.WALKIE_DEV !== "1") return out;
  const loop = (v: string | undefined, protocol: string): string | null => {
    try {
      const u = new URL(v ?? "");
      return u.protocol === protocol && (u.hostname === "127.0.0.1" || u.hostname === "localhost") && !u.username ? `${u.origin}${u.pathname.replace(/\/$/, "")}` : null;
    } catch { return null; }
  };
  return { relayUrl: loop(env.WALKIE_RELAY_URL, "ws:") ?? out.relayUrl, appUrl: loop(env.WALKIE_MOBILE_APP_URL, "http:") ?? out.appUrl };
}

const State = z.object({ room_key: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional() });
type State = z.infer<typeof State>;

export interface MobileOptions {
  relayUrl?: string;
  appUrl?: string;
  /** Honour the WALKIE_DEV relay/app override (source runs; default true, tests pass false). */
  env?: boolean;
  devices?: DeviceOptions;
  pairing?: PairingOptions;
  sweepMs?: number;
  /** Tests: the authentication and registration deadlines of a phone link (tunnel.ts). */
  timeouts?: { authMs?: number; registerMs?: number; heartbeatMs?: number; roomMs?: number };
  /** Tests: a smaller per-device byte budget (tunnel.ts DEVICE_BYTES). */
  deviceBytes?: BucketSpec;
  /** Tests: how long outstanding data may go without acknowledgement progress. */
  stallMs?: number;
}

interface Deps { core: Core; log: Logger; home: string; serve: ServeAs }

export class MobileManager {
  readonly devices: DeviceSessions;
  readonly pairing: PairingSecrets;
  private readonly link: RelayLink;
  private readonly sessions = new Map<number, TunnelSession>();
  private readonly stateFile: string;
  private readonly relayUrl: string;
  private readonly appUrl: string;
  /** Held device rooms: room -> device id, and back. */
  private readonly roomDevice = new Map<string, string>();
  private readonly deviceRoom = new Map<string, string>();
  /** Per-device concurrency, shared by all of a device's connections. */
  private readonly usage = new Map<string, DeviceUsage>();
  /** Goodbyes in flight (a signed-out phone being told, then its room given up). */
  private readonly ending = new Set<Promise<void>>();
  private queued = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Something the person should know (a pairing code withdrawn by the relay); cleared by the next pairing. */
  private notice: string | null = null;

  constructor(private readonly d: Deps, private readonly opts: MobileOptions = {}) {
    const dir = join(d.home, "mobile");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.stateFile = join(dir, "state.json");
    this.devices = new DeviceSessions(join(dir, "devices.json"), opts.devices);
    this.devices.onRemove = (ids) => { for (const id of ids) this.deviceGone(id); };
    this.pairing = new PairingSecrets(opts.pairing);
    this.pairing.onRemove = (rooms) => { for (const room of rooms) this.link?.release(room); };
    const env = opts.env === false ? { relayUrl: RELAY_URL, appUrl: APP_URL } : mobileUrlsFromEnv();
    this.relayUrl = opts.relayUrl ?? env.relayUrl;
    this.appUrl = opts.appUrl ?? env.appUrl;
    this.link = new RelayLink(this.relayUrl, {
      join: (room, slot) => this.join(room, slot),
      leave: (slot) => { this.sessions.get(slot)?.dispose(); this.sessions.delete(slot); },
      data: (slot, frame) => this.sessions.get(slot)?.onFrame(frame),
      badFrame: (slot) => this.sessions.get(slot)?.refuse("bad frame size"),
      lost: (room) => {
        // A pairing room the relay refused or dropped can't work: withdraw the code and say so.
        if (!this.pairing.get(room)) return;
        this.pairing.drop(room);
        this.notice = "The relay dropped a pairing code's room: that code no longer works. Make a new one.";
        this.d.log.warn("mobile_pairing_lost", {});
        this.idle();
      },
      down: () => { for (const s of this.sessions.values()) s.dispose(); this.sessions.clear(); },
      incompatible: (message) => { this.notice = `Walkie on your phone is unavailable: ${message}.`; },
    }, d.log, { ...(opts.stallMs ? { stallMs: opts.stallMs } : {}) });
  }

  /** At daemon start: link up again if a phone is paired. */
  start(): void {
    this.rosterChanged();
    if (this.d.core.me()) for (const dev of this.devices.list()) void this.holdDevice(dev.id);
    this.timer = setInterval(() => this.sweep(), this.opts.sweepMs ?? SWEEP_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
    this.unlink();
  }

  status(): MobileStatus {
    return {
      linked: this.link.connected, relay: new URL(this.relayUrl).host, pairing: this.pairing.size, devices: this.devices.list(),
      connected: [...this.sessions.values()].filter((s) => s.device !== null).length,
      notice: this.notice,
    };
  }

  /** Relay protocol violations seen (tests). */
  get violations(): number { return this.link.violations; }
  /** Phone links open right now, authenticated or not (tests). */
  get sessionCount(): number { return this.sessions.size; }

  /** A one-time pairing link and QR code (10 minutes, single use). */
  async pair(): Promise<PairView> {
    if (!this.d.core.teamId) throw new HttpError(409, "no_team", "not in a team yet (run: walkie init or walkie join)");
    if (!this.d.core.me()) throw new HttpError(403, "forbidden", "this node is not an admitted member");
    this.notice = null;
    const p = await this.pairing.mint(); // an evicted older pairing gives its room up (onRemove)
    this.link.holdRoom(p.room, p.claimKey);
    // Advertise only a room the relay holds for us: otherwise the code could never work.
    if (!(await this.link.opened(p.room, 5_000))) {
      this.pairing.drop(p.room);
      this.idle();
      throw new HttpError(503, "relay_unavailable", "the Walkie relay is unreachable or refused the pairing; try again in a moment");
    }
    // A development relay rides along in the fragment; the phone app accepts it only when served from loopback.
    const dev = this.relayUrl !== RELAY_URL ? `&relay=${encodeURIComponent(this.relayUrl)}` : "";
    const url = `${this.appUrl}#pair=${p.code}${dev}`;
    this.d.log.info("mobile_pairing_opened", { expires_at: p.expires_at });
    return { url, code: p.code, expires_at: p.expires_at, qr: qrRows(url) };
  }

  /** Signs a device out: its key stops working, its open links end at once (told, then closed), its room goes. */
  async revoke(id: string): Promise<boolean> {
    if (!this.devices.revoke(id)) return false; // → deviceGone(id), synchronously
    this.d.log.info("mobile_revoked", { device: id });
    await this.settled();
    return true;
  }

  async revokeAll(): Promise<number> {
    for (const room of this.pairing.rooms()) this.link.release(room);
    this.pairing.clear();
    const n = this.devices.revokeAll(); // → deviceGone for each, synchronously
    if (n) this.d.log.info("mobile_revoked_all", { devices: n });
    await this.settled();
    this.idle();
    return n;
  }

  /** After a roster change: a machine that no longer belongs to a current member signs every phone out. */
  rosterChanged(): void {
    if (this.d.core.teamId && !this.d.core.me() && (this.devices.size > 0 || this.pairing.size > 0)) {
      this.d.log.warn("mobile_owner_gone", { devices: this.devices.size });
      void this.revokeAll();
    }
  }

  private sweep(): void {
    for (const room of this.pairing.sweep()) this.link.release(room);
    this.devices.sweep(); // → deviceGone for each expired device
    this.idle();
  }

  private async settled(): Promise<void> {
    while (this.ending.size) await Promise.all([...this.ending]);
  }

  /**
   * The one place a device's presence ends, whatever removed it (revoke, expiry, eviction by a newer pairing).
   * Synchronously: its room stops admitting anyone and every open link of it stops (streams and requests abort).
   * Then each link is told over its encrypted channel, closed, and the room is given up at the relay.
   */
  private deviceGone(id: string): void {
    const room = this.deviceRoom.get(id);
    if (room) this.roomDevice.delete(room);
    this.deviceRoom.delete(id);
    this.usage.delete(id);
    const goodbyes: Promise<void>[] = [];
    for (const s of [...this.sessions.values()]) {
      if (s.device !== id && !(room && s.inRoom(room))) continue;
      // Stays in the slot table until its goodbye is out (the kick removes it), so its send/kick still own the slot;
      // if the phone leaves meanwhile, the slot's new owner is safe: send and kick check ownership first.
      goodbyes.push(s.revoke()); // synchronous stop, then the goodbye
    }
    const done = Promise.all(goodbyes).then(() => {
      if (room) this.link.release(room);
      this.idle();
    }).finally(() => { this.ending.delete(done); });
    this.ending.add(done);
  }

  /** Nothing paired and nothing pairing: drop the relay connection. */
  private idle(): void {
    if (this.devices.size === 0 && this.pairing.size === 0 && this.ending.size <= 1) this.unlink();
  }

  private unlink(): void {
    this.link.stop();
    this.roomDevice.clear();
    this.deviceRoom.clear();
  }

  private baseKey(): Uint8Array {
    let state: State = {};
    try {
      if (existsSync(this.stateFile)) state = State.parse(JSON.parse(readFileSync(this.stateFile, "utf8")));
    } catch { state = {}; }
    if (state.room_key) return unb64u(state.room_key);
    const key = randomBytes(32);
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ room_key: b64u(key) }) + "\n", { mode: 0o600 });
    renameSync(tmp, this.stateFile);
    return key;
  }

  /** The relay key of a device's own room (derived from a secret that stays on this machine). */
  private deviceRoomKey(id: string): Uint8Array {
    return new Uint8Array(hkdfSync("sha256", this.baseKey(), new Uint8Array(0), `walkie-mobile-v1 device room ${id}`, 32));
  }

  private async holdDevice(id: string): Promise<string> {
    const known = this.deviceRoom.get(id);
    if (known) return known;
    const key = this.deviceRoomKey(id);
    const room = await roomOf(key);
    // No await between this check and the claim: a device removed while hashing never gets its room claimed.
    if (!this.devices.has(id) || this.deviceRoom.has(id)) return this.deviceRoom.get(id) ?? room;
    this.roomDevice.set(room, id);
    this.deviceRoom.set(id, room);
    this.link.holdRoom(room, key, true); // re-claimed if the relay ever refuses or drops it
    return room;
  }

  /** Bytes queued across every phone link; over budget the relay is misbehaving and the link is dropped. */
  private queue(bytes: number): boolean {
    if (bytes > 0 && this.queued + bytes > GLOBAL_QUEUE_BYTES) { this.link.violation("daemon queue full"); return false; }
    this.queued = Math.max(0, this.queued + bytes);
    return true;
  }

  private usageOf(id: string): DeviceUsage {
    let u = this.usage.get(id);
    if (!u) { u = { inflight: 0, streams: 0 }; this.usage.set(id, u); }
    return u;
  }

  private join(room: string, slot: number): void {
    const deviceId = this.roomDevice.get(room) ?? null;
    const kind = deviceId ? "device" : this.pairing.get(room) ? "pair" : null;
    if (!kind) { this.link.kick(slot); return; }
    // The relay enforces these too; a relay that doesn't is misbehaving.
    const inRoom = [...this.sessions.values()].filter((s) => s.inRoom(room)).length;
    if (inRoom >= MAX_PHONES_PER_ROOM || this.sessions.size >= MAX_SLOTS) { this.link.violation("too many phones"); return; }
    const session: TunnelSession = new TunnelSession({
      kind, room,
      // Bound to this connection: once the slot belongs to another session (or none), these do nothing.
      send: (frame, small, reservation) => {
        if (this.sessions.get(slot) === session) return this.link.send(slot, frame, small, reservation);
        reservation?.release();
        return "down";
      },
      reserve: (bytes, small) => (this.sessions.get(slot) === session ? this.link.reserve(slot, bytes, small) : null),
      kick: () => {
        if (this.sessions.get(slot) !== session) return;
        this.sessions.delete(slot);
        this.link.kick(slot);
      },
      psk: async (kid) => {
        if (kind === "pair") return this.pairing.get(room)?.psk ?? null;
        if (kid !== `d:${deviceId}` || this.roomDevice.get(room) !== deviceId) return null; // a device's room admits only it
        const key = this.devices.keyOf(deviceId as string);
        return key ? hkdfKey(unb64u(key)) : null;
      },
      register: (name) => this.register(room, name),
      registered: () => { this.link.release(room); },
      info: () => this.info(),
      touch: (id) => this.devices.touch(id),
      live: (id) => this.devices.has(id),
      expiresAt: (id) => this.devices.expiresAt(id),
      usage: (id) => this.usageOf(id),
      unpair: (id) => { void this.revoke(id); },
      handshakeFailed: () => {
        if (kind === "pair" && this.pairing.fail(room)) { this.link.release(room); this.idle(); }
      },
      queue: (bytes) => this.queue(bytes),
      ...(this.opts.deviceBytes ? { deviceBytes: this.opts.deviceBytes } : {}),
      ...(this.opts.timeouts ? { timeouts: this.opts.timeouts } : {}),
      channelExists: (name) => this.d.core.roster.channels.has(name),
      serve: this.d.serve,
      limiter: this.d.core.limiter,
      log: this.d.log,
    });
    this.sessions.set(slot, session);
  }

  /** Who a phone pairs with: the team, this machine's person and this machine. */
  private info(): PairInfo | null {
    const me = this.d.core.me();
    const teamId = this.d.core.teamId;
    const name = teamId ? this.d.core.roster.team?.name ?? "" : "";
    return me && teamId ? { team: { id: teamId, name }, handle: me.handle, host: this.d.core.hostname } : null;
  }

  private async register(room: string, name: string): Promise<Extract<DaemonMsg, { op: "registered" }>> {
    const info = this.info();
    if (!info || !this.pairing.consume(room)) throw new HttpError(409, "pairing_used", "this pairing link was used or has expired");
    const { key, device } = this.devices.create(name); // an evicted device ends here too (deviceGone)
    const home = await this.holdDevice(device.id);
    // The phone moves to its room right after this answer: the relay must hold it by then.
    if (!(await this.link.opened(home, this.opts.timeouts?.roomMs ?? 5_000))) {
      this.devices.revoke(device.id);
      throw new HttpError(503, "relay_refused", "the relay did not accept this phone's room; pair again");
    }
    this.d.log.info("mobile_paired", { device: device.id, name: device.name });
    return { op: "registered", device: { id: device.id, name: device.name }, room: home, key, expires_at: device.expires_at, ...info };
  }
}
