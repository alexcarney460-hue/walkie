// One-time pairing codes for the phone app (WALKIE-PWA-1). `walkie mobile pair` (or Team → Devices) mints one: a relay
// room claimed with a random key only this daemon holds, and a 128-bit secret; the code `<room>.<secret>` is the
// fragment of https://getwalkie.vercel.app/m#pair=<code> in a QR code (a fragment is never sent to any server, the site
// included). The phone joins the room and derives the handshake PSK from the secret (src/mobile/crypto.ts
// pairingKeys); nobody holding the code can claim the room. It lives 10 minutes, is used once (consumed when the phone
// registers), and five failed handshakes in its room void it.
import { b64u, pairingKeys, PAIRING_SECRET_BYTES, randomBytes, roomOf } from "../../mobile/crypto.ts";

export const PAIR_TTL_MS = 10 * 60_000;
/** Outstanding pairings at once (the oldest is dropped). */
export const PAIR_MAX = 3;
/** Failed handshakes in a pairing's room before the pairing is voided. */
export const PAIR_MAX_FAILURES = 5;

export interface Pairing {
  /** `<room>.<secret>`: what the QR code carries and a person pastes. */
  readonly code: string;
  readonly room: string;
  /** The key the daemon claims the room with: random, never in the code. */
  readonly claimKey: Uint8Array;
  readonly psk: CryptoKey;
  readonly expires_at: number;
  failures: number;
}

export interface PairingOptions { now?: () => number }

export class PairingSecrets {
  private readonly byRoom = new Map<string, Pairing>();
  private readonly now: () => number;

  constructor(opts: PairingOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Called synchronously with the rooms of pairings that went away (evicted by a newer one, expired, voided, cleared),
   * so their relay rooms are given up. Not for a consumed pairing: its room stays until the registration answer is out.
   */
  onRemove: ((rooms: string[]) => void) | null = null;

  /** Live pairings (expired ones swept first). */
  get size(): number { this.sweep(); return this.byRoom.size; }

  async mint(): Promise<Pairing> {
    const claimKey = randomBytes(32);
    const room = await roomOf(claimKey);
    const code = `${room}.${b64u(randomBytes(PAIRING_SECRET_BYTES))}`;
    const { psk } = await pairingKeys(code);
    const p: Pairing = { code, room, claimKey, psk, expires_at: this.now() + PAIR_TTL_MS, failures: 0 };
    this.sweep();
    const keys = [...this.byRoom.keys()]; // insertion order: oldest first
    this.remove(keys.slice(0, Math.max(0, keys.length - PAIR_MAX + 1)));
    this.byRoom.set(p.room, p);
    return p;
  }

  /** The live pairing that owns `room`, if any. */
  get(room: string): Pairing | null {
    const p = this.byRoom.get(room);
    if (!p) return null;
    if (p.expires_at <= this.now()) { this.remove([room]); return null; }
    return p;
  }

  /** Uses the pairing up: true exactly once for a live one. (Its room is released after the answer is sent.) */
  consume(room: string): boolean {
    if (!this.get(room)) return false;
    this.byRoom.delete(room);
    return true;
  }

  /** A failed handshake in the room; true when that voided the pairing. */
  fail(room: string): boolean {
    const p = this.get(room);
    if (!p) return false;
    p.failures += 1;
    if (p.failures < PAIR_MAX_FAILURES) return false;
    this.remove([room]);
    return true;
  }

  rooms(): string[] { this.sweep(); return [...this.byRoom.keys()]; }

  clear(): void { this.remove([...this.byRoom.keys()]); }

  /** Withdraws one pairing (its room is given up). */
  drop(room: string): void { this.remove([room]); }

  /** Drops expired pairings; returns their rooms. */
  sweep(): string[] {
    const now = this.now();
    return this.remove([...this.byRoom].filter(([, p]) => p.expires_at <= now).map(([room]) => room));
  }

  /** The one way a pairing goes away (except consumption): forget it, then tell the owner. */
  private remove(rooms: string[]): string[] {
    const gone = rooms.filter((r) => this.byRoom.delete(r));
    if (gone.length) this.onRemove?.(gone);
    return gone;
  }
}
