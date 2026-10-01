// Local, non-replicated guest authority. Only token hashes and scrubbed audit fields are persisted.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const META = "guest_registry_v1";
const MAX_AUDIT = 5_000;
const MAX_TTL_MS = 60 * 60 * 1_000;
const GuestInput = z.object({
  owner: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/),
  node: z.string().regex(/^[0-9a-f]{16}$/),
  family: z.enum(["dots", "grokbot"]),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,32}$/),
  subject: z.string().min(1).max(200),
  cardIds: z.array(z.string().regex(/^[0-9a-f]{16}:[1-9][0-9]*$/)).min(1).max(32),
  tools: z.array(z.string().regex(/^walkie_[a-z_]+$/)).min(1).max(16),
}).strict();
export type GuestInput = z.infer<typeof GuestInput>;

export interface Guest extends GuestInput {
  id: string; agent: string; address: string; tokenHash: string; expiresAt: number; revoked: boolean;
}
export interface GuestAudit {
  at: number; kind: string; guest?: string; tool?: string; object?: string; event?: string; digest?: string;
  source?: string; status?: number; count?: number;
}
interface State { killed: boolean; guests: Guest[]; audit: GuestAudit[]; nonces?: { key: string; at: number }[] }
interface MetaStore { getMeta(key: string): string | null; setMeta(key: string, value: string): void }

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export class GuestRegistry {
  private readonly early = new Map<string, GuestAudit>();
  constructor(private readonly store: MetaStore, private readonly now: () => number = Date.now) {}

  private read(): State {
    const raw = this.store.getMeta(META);
    if (!raw) return { killed: false, guests: [], audit: [] };
    const value = JSON.parse(raw) as State;
    if (!Array.isArray(value.guests) || !Array.isArray(value.audit) || typeof value.killed !== "boolean") throw new Error("guest registry corrupt");
    return value;
  }
  private write(state: State): void { this.store.setMeta(META, JSON.stringify(state)); }
  list(): Omit<Guest, "tokenHash">[] {
    return this.read().guests.map(({ tokenHash: _hash, ...guest }) => guest);
  }
  killed(): boolean { return this.read().killed; }
  audit(): GuestAudit[] {
    return this.read().audit.map((entry) => {
      const live = this.early.get(this.earlyKey(entry));
      return live && live.at === entry.at ? { ...entry, count: live.count } : entry;
    });
  }

  private earlyKey(entry: GuestAudit): string {
    return `${Math.floor(entry.at / 60_000)}:${entry.source}:${entry.status}:${entry.kind}`;
  }

  private saveEarly(entries: GuestAudit[]): void {
    const state = this.read();
    let audit = state.audit;
    for (const entry of entries) {
      const key = this.earlyKey(entry);
      const found = audit.findIndex((row) => row.source !== undefined && this.earlyKey(row) === key);
      audit = found < 0 ? [...audit, entry].slice(-MAX_AUDIT)
        : audit.map((row, i) => i === found ? { ...row, count: entry.count } : row);
    }
    this.write({ ...state, audit });
  }

  /** Keep an exact live count, with logarithmic durable checkpoints and a final checkpoint on shutdown/window rollover. */
  recordEarly(kind: string, status: number, source: string): void {
    const at = this.now();
    const window = Math.floor(at / 60_000);
    const expired = [...this.early.entries()].filter(([key]) => !key.startsWith(`${window}:`));
    if (expired.length) {
      this.saveEarly(expired.map(([, entry]) => entry));
      for (const [key] of expired) this.early.delete(key);
    }
    const fresh: GuestAudit = { at, kind, source, status, count: 1 };
    const key = this.earlyKey(fresh);
    const prev = this.early.get(key);
    const entry = { ...fresh, at: prev?.at ?? at, count: (prev?.count ?? 0) + 1 };
    this.early.set(key, entry);
    if (entry.count === 1 || (entry.count & (entry.count - 1)) === 0) this.saveEarly([entry]);
  }

  flushEarly(): void {
    if (this.early.size) this.saveEarly([...this.early.values()]);
  }

  /** Reject tunnel assertion replay even when the daemon restarts inside the signature window. */
  consumeNonce(subject: string, nonce: string): boolean {
    const state = this.read();
    const key = hash(`${subject}:${nonce}`);
    const nonces = (state.nonces ?? []).filter((entry) => entry.at + 60_000 >= this.now());
    if (nonces.length >= 2_048 || nonces.some((entry) => entry.key === key)) return false;
    this.write({ ...state, nonces: [...nonces, { key, at: this.now() }] });
    return true;
  }

  record(entry: Omit<GuestAudit, "at">): void {
    const state = this.read();
    this.write({ ...state, audit: [...state.audit, { at: this.now(), ...entry }].slice(-MAX_AUDIT) });
  }

  issue(input: GuestInput, ttlMs: number): { token: string; guest: Omit<Guest, "tokenHash"> } {
    const b = GuestInput.parse(input);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_TTL_MS) throw new Error("guest token lifetime must be 1 second to 1 hour");
    const agent = `${b.family}-${b.name}`;
    const id = `${b.node}/${agent}`;
    const token = randomBytes(32).toString("base64url");
    const guest: Guest = { ...b, id, agent, address: `@${b.owner}/cloud/${agent}`, tokenHash: hash(token), expiresAt: this.now() + ttlMs, revoked: false,
      cardIds: [...new Set(b.cardIds)], tools: [...new Set(b.tools)] };
    const state = this.read();
    if (state.killed) throw new Error("guest gateway is off");
    if (state.guests.length >= 64 && !state.guests.some((row) => row.id === id)) throw new Error("guest limit reached");
    const guests = [...state.guests.filter((row) => row.id !== id), guest];
    this.write({ ...state, guests, audit: [...state.audit, { at: this.now(), kind: "issue", guest: id }].slice(-MAX_AUDIT) });
    const { tokenHash: _hash, ...publicGuest } = guest;
    return { token, guest: publicGuest };
  }

  authenticate(token: string, subject: string): Guest | null {
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) return null;
    const state = this.read();
    if (state.killed) return null;
    const digest = hash(token);
    return state.guests.find((guest) => !guest.revoked && guest.expiresAt > this.now() && guest.subject === subject && sameHash(guest.tokenHash, digest)) ?? null;
  }

  /** Recheck the current grant immediately before a guest side effect. */
  active(guest: Guest): boolean {
    const state = this.read();
    return !state.killed && state.guests.some((row) => row.id === guest.id && row.tokenHash === guest.tokenHash
      && !row.revoked && row.expiresAt > this.now());
  }

  revoke(id: string): void {
    const state = this.read();
    this.write({ ...state, guests: state.guests.map((guest) => guest.id === id ? { ...guest, revoked: true } : guest),
      audit: [...state.audit, { at: this.now(), kind: "revoke", guest: id }].slice(-MAX_AUDIT) });
  }
  killAll(killed: boolean): void {
    const state = this.read();
    this.write({ ...state, killed, audit: [...state.audit, { at: this.now(), kind: killed ? "global_kill" : "global_enable" }].slice(-MAX_AUDIT) });
  }
}
