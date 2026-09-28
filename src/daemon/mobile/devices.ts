// Paired phones (WALKIE-PWA-1). Pairing gives the phone a 256-bit device key (the PSK of every later handshake,
// src/mobile/crypto.ts); the phone keeps it as a non-extractable CryptoKey, this daemon keeps it in
// ~/.walkie/mobile/devices.json (0600 in a 0700 directory, like node.key and local.token). A device key is a
// credential for the phone's allow-list only (tunnel.ts), ends 30 days after its last use and 90 days after pairing at
// the latest, and is revocable (`walkie mobile revoke`, Team → Devices, the phone's own "Unpair").
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { b64u } from "../../mobile/crypto.ts";
import type { DeviceView } from "../../mobile/views.ts";

export type { DeviceView };

/** A device ends after this long unused... */
export const DEVICE_IDLE_MS = 30 * 24 * 60 * 60_000;
/** ...and this long after pairing, whatever its use. */
export const DEVICE_MAX_MS = 90 * 24 * 60 * 60_000;
/** Paired devices at once (pairing another drops the least recently used). */
export const DEVICE_MAX = 8;
/** last_seen is written to disk at most this often per device. */
const PERSIST_EVERY_MS = 60 * 60_000;

const DeviceRec = z.object({
  id: z.string().regex(/^[0-9a-f]{12}$/),
  key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  name: z.string().max(40),
  created_at: z.number().int(),
  last_seen: z.number().int(),
  expires_at: z.number().int(),
});
type DeviceRec = z.infer<typeof DeviceRec>;


export interface DeviceOptions { now?: () => number }

/** A readable device name: printable, one line, at most 40 characters. */
export function deviceName(raw: unknown): string {
  const s = typeof raw === "string" ? raw.normalize("NFKC").replace(/[\p{C}<>]/gu, " ").replace(/\s+/g, " ").trim() : "";
  return s.slice(0, 40) || "Phone";
}

export type RemovalReason = "revoked" | "expired" | "evicted";

export class DeviceSessions {
  private recs: DeviceRec[];
  private readonly persisted = new Map<string, number>();
  private readonly now: () => number;
  /**
   * Called synchronously with every device that leaves the store, whatever the path (revoke, revoke all, expiry
   * found by any read, eviction by a newer pairing), so the owner of the sessions can end them at once.
   */
  onRemove: ((ids: string[], reason: RemovalReason) => void) | null = null;

  constructor(private readonly file: string, opts: DeviceOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.recs = load(file);
    for (const r of this.recs) this.persisted.set(r.id, r.last_seen);
    this.sweep();
  }

  /** Pairs a device: a new id and 256-bit key (returned once to the phone over the encrypted channel). */
  create(name: string): { key: string; device: DeviceView; evicted: string[] } {
    this.sweep();
    const now = this.now();
    const rec: DeviceRec = {
      id: randomBytes(6).toString("hex"), key: b64u(new Uint8Array(randomBytes(32))), name: deviceName(name),
      created_at: now, last_seen: now, expires_at: now + DEVICE_MAX_MS,
    };
    const evicted: string[] = [];
    let recs = [...this.recs, rec];
    while (recs.length > DEVICE_MAX) {
      const lru = recs.filter((r) => r.id !== rec.id).reduce((a, r) => (r.last_seen < a.last_seen ? r : a));
      recs = recs.filter((r) => r.id !== lru.id);
      evicted.push(lru.id);
    }
    this.recs = recs;
    this.save();
    if (evicted.length) this.removed(evicted, "evicted");
    return { key: rec.key, device: view(rec), evicted };
  }

  /** The key of a live device (for its handshake), or null. */
  keyOf(id: string): string | null {
    const rec = this.live(id);
    return rec ? rec.key : null;
  }

  /** A live device, without marking it used. */
  has(id: string): boolean { return this.live(id) !== null; }

  /** Marks a live device as used now; false when it is gone (revoked or expired). */
  touch(id: string): boolean {
    const rec = this.live(id);
    if (!rec) return false;
    const now = this.now();
    this.recs = this.recs.map((r) => (r.id === id ? { ...r, last_seen: now } : r));
    if (now - (this.persisted.get(id) ?? 0) >= PERSIST_EVERY_MS) this.save();
    return true;
  }

  /** The device's absolute end (its sessions close then). */
  expiresAt(id: string): number | null { return this.live(id)?.expires_at ?? null; }

  list(): DeviceView[] {
    this.sweep();
    return this.recs.map(view).sort((a, b) => b.last_seen - a.last_seen);
  }

  get size(): number { return this.recs.length; }

  revoke(id: string): boolean {
    return this.remove([id], "revoked").length === 1;
  }

  revokeAll(): number {
    return this.remove(this.recs.map((r) => r.id), "revoked").length;
  }

  /** Drops expired devices; returns their ids. */
  sweep(): string[] {
    return this.remove(this.recs.filter((r) => this.expired(r)).map((r) => r.id), "expired");
  }

  /** The one way out of the store: persist, then tell the owner. */
  private remove(ids: string[], reason: RemovalReason): string[] {
    const gone = ids.filter((id) => this.recs.some((r) => r.id === id));
    if (!gone.length) return [];
    this.recs = this.recs.filter((r) => !gone.includes(r.id));
    for (const id of gone) this.persisted.delete(id);
    this.save();
    this.removed(gone, reason);
    return gone;
  }

  private removed(ids: string[], reason: RemovalReason): void {
    this.onRemove?.(ids, reason);
  }

  private live(id: string): DeviceRec | null {
    const rec = this.recs.find((r) => r.id === id);
    if (!rec) return null;
    if (this.expired(rec)) { this.remove([id], "expired"); return null; }
    return rec;
  }

  private expired(r: DeviceRec): boolean {
    const now = this.now();
    return now >= r.expires_at || now - r.last_seen >= DEVICE_IDLE_MS;
  }

  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ devices: this.recs }, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
    for (const r of this.recs) this.persisted.set(r.id, r.last_seen);
  }
}

function view(r: DeviceRec): DeviceView {
  return { id: r.id, name: r.name, created_at: r.created_at, last_seen: r.last_seen, expires_at: r.expires_at };
}

/** Reads the device file; a malformed file or entry is dropped (those phones pair again), never trusted. */
function load(file: string): DeviceRec[] {
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { devices?: unknown };
    const list = Array.isArray(raw.devices) ? raw.devices : [];
    return list.flatMap((d) => {
      const r = DeviceRec.safeParse(d);
      return r.success ? [r.data] : [];
    }).slice(0, DEVICE_MAX);
  } catch {
    return [];
  }
}
