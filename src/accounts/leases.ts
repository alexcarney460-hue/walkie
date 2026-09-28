// Local account state shared by the wrappers, the CLI and the daemon on one machine (ACCOUNTS-2). No secrets.
//   leases: ~/.walkie/leases/<id>.json — which wrapped session (wrapper pid, agent, session id) runs on which account
//           right now. A lease whose wrapper pid is gone is dropped on the next read. The daemon shares them with the
//           team (bounded, validated) on the `vv` answer; the selector counts them so terminals spread out.
//   marks:  ~/.walkie/account-marks.json — what a session learned about an account the meter cannot see (a limit hit
//           "until 4:10am", a refused token), kept until the time it names (at most 8 days).
import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { privateDir } from "./vault/vault.ts";
import { AccountUsage } from "../protocol/accounts.ts";

export const MAX_LOCAL_LEASES = 64;
const MARK_MAX_MS = 8 * 86_400_000;

export const Lease = z.object({
  id: z.string().regex(/^[0-9a-f]{16}$/),
  provider: z.enum(["claude", "codex"]),
  account: z.string().regex(/^[0-9a-f]{24}$/),
  /** The wrapper (or `walkie accounts exec`) process holding it. */
  pid: z.number().int().positive(),
  agent: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,47}$/).optional(),
  session: z.string().regex(/^[A-Za-z0-9-]{8,80}$/).optional(),
  since: z.number().int().nonnegative(),
  /** A token handed out by another machine's vault: that machine's node id (phase 3). */
  from_node: z.string().max(80).optional(),
  /** The account owner's handle when it is not this machine's owner (a teammate's shared account). */
  owner: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/).optional(),
  /** The owner-issued grant of a hand-out (reported with the lease so the owner can verify it). */
  grant: z.string().regex(/^[0-9a-f]{16}$/).optional(),
});
export type Lease = z.infer<typeof Lease>;

function leaseDir(walkieHome: string): string {
  return join(walkieHome, "leases");
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function writeLease(walkieHome: string, l: Omit<Lease, "id" | "since"> & { since?: number }): Lease {
  privateDir(walkieHome);
  privateDir(leaseDir(walkieHome), true);
  const lease = Lease.parse({ ...l, id: randomBytes(8).toString("hex"), since: l.since ?? Date.now() });
  writeJson(join(leaseDir(walkieHome), `${lease.id}.json`), lease);
  return lease;
}

export function updateLease(walkieHome: string, lease: Lease, patch: Partial<Pick<Lease, "session" | "agent">>): Lease {
  const next = Lease.parse({ ...lease, ...patch });
  const path = join(leaseDir(walkieHome), `${lease.id}.json`);
  if (existsSync(path)) writeJson(path, next);
  return next;
}

export function releaseLease(walkieHome: string, lease: Pick<Lease, "id">): void {
  try { rmSync(join(leaseDir(walkieHome), `${lease.id}.json`), { force: true }); } catch { /* gone */ }
}

/** Live leases on this machine; files of dead holders are removed. */
export function activeLeases(walkieHome: string, alive: (pid: number) => boolean = pidAlive): Lease[] {
  const dir = leaseDir(walkieHome);
  if (!existsSync(dir)) return [];
  const out: Lease[] = [];
  for (const name of readdirSync(dir).slice(0, 512)) {
    if (!/^[0-9a-f]{16}\.json$/.test(name)) continue;
    const path = join(dir, name);
    try {
      const l = Lease.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (!l.success || !alive(l.data.pid)) { rmSync(path, { force: true }); continue; }
      out.push(l.data);
    } catch { /* being written */ }
  }
  return out.sort((a, b) => a.since - b.since).slice(0, MAX_LOCAL_LEASES);
}

// ---- marks --------------------------------------------------------------------------

export const Mark = z.object({
  state: z.enum(["exhausted", "relogin"]),
  /** When it lifts (exhausted: the reset the provider named); null = until a new reading says otherwise (8 days max). */
  until: z.number().int().nullable(),
  at: z.number().int(),
  /** Which window hit its limit ("five_hour", "seven_day", …) or why the token was refused. */
  reason: z.string().max(40),
  /** The credential generation it is about (round 1, Codex 9): a replaced credential's marks no longer apply. */
  gen: z.string().max(40).optional(),
  /** A limit of one model only ("You've reached your Fable limit", round 5): the account stays usable for others. */
  model: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/).optional(),
  /**
   * relogin: how many refusals were seen (round 5): one refusal moves the session but excludes nothing; a second one
   * (within the mark's life) confirms it. A mark without the field (older) counts as confirmed.
   */
  strikes: z.number().int().min(1).max(10).optional(),
  /** RESET-CLOCK-1: `until` is the switcher's placeholder (the provider named no reset time), not a reported time. */
  guessed: z.boolean().optional(),
});
export type Mark = z.infer<typeof Mark>;
/** Marks are keyed by account id (an own account) or `owner:id` (a teammate's account used by borrowing, round 5). */
export const MARK_KEY_RE = /^(?:[a-z0-9][a-z0-9._-]{0,47}:)?[0-9a-f]{24}$/;
const Marks = z.object({ v: z.literal(1), marks: z.record(z.string().regex(MARK_KEY_RE), Mark) });

/** The marks key of an account: its id when it is the caller's own, `owner:id` for a borrowed one. */
export function markKey(a: { id: string; own: boolean; owner: string | null }): string {
  return a.own || !a.owner ? a.id : `${a.owner}:${a.id}`;
}

/** How long a reading must postdate a limit mark before it can lift it (round 5, Opus 5: hysteresis). */
export const MARK_HYSTERESIS_MS = 10 * 60_000;

function marksPath(walkieHome: string): string {
  return join(walkieHome, "account-marks.json");
}

export function readMarks(walkieHome: string, now = Date.now()): Record<string, Mark> {
  const path = marksPath(walkieHome);
  if (!existsSync(path)) return {};
  try {
    const p = Marks.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!p.success) return {};
    return Object.fromEntries(Object.entries(p.data.marks).filter(([, m]) => (m.until ?? m.at + MARK_MAX_MS) > now && now - m.at < MARK_MAX_MS));
  } catch {
    return {};
  }
}

/** Whether a mark is about this credential (a mark from before generations applies until it lapses). */
export function markApplies(m: Mark | undefined, gen: string | undefined): m is Mark {
  // Round 2 (Codex 8): the generations must match exactly (both absent only for credentials without one).
  return !!m && (m.gen ?? null) === (gen ?? null);
}

/** Whether a mark keeps its account out: a relogin mark needs a confirmed refusal (two strikes, round 5, Opus 6). */
export function markExcludes(m: Mark, model: string | null | undefined): boolean {
  if (m.state === "relogin") return (m.strikes ?? 2) >= 2;
  // A model-scoped limit keeps the account out only for that model (or when the model is not known).
  if (m.model && model && !model.toLowerCase().includes(m.model.toLowerCase())) return false;
  return true;
}

/**
 * Whether a reading lifts a limit mark (round 5, Opus 5): only a reading taken at least MARK_HYSTERESIS_MS after the
 * mark, known (not "unknown"), not exhausted, whose relevant windows (the model's own for a model-scoped mark, else all)
 * are all below 100 %. A refused-token mark is never lifted by a reading.
 */
export function markLifted(m: Mark, u: AccountUsage | null | undefined): boolean {
  if (m.state !== "exhausted" || !u || u.state === "unknown" || u.state === "exhausted" || u.state === "relogin") return false;
  if (u.at < m.at + MARK_HYSTERESIS_MS) return false;
  const model = m.model?.toLowerCase();
  const ws = model ? u.windows.filter((w) => w.kind === "weekly_model" && (w.scope ?? "").toLowerCase().includes(model)) : u.windows;
  if (!ws.length && model) return u.windows.length > 0 && u.windows.every((w) => w.used_pct < 100);
  return ws.length > 0 && ws.every((w) => w.used_pct < 100);
}

export function writeMark(walkieHome: string, account: string, mark: Mark | null, now = Date.now()): void {
  privateDir(walkieHome);
  const cur = readMarks(walkieHome, now);
  const next = { ...cur };
  if (mark) next[account] = Mark.parse(mark); else delete next[account];
  writeJson(marksPath(walkieHome), { v: 1, marks: next });
}

// ---- session readings -------------------------------------------------------------------

/**
 * ~/.walkie/session-readings.json — the usage a wrapped session itself reported for its account (Codex writes its
 * rate limits into the session after every turn). A vault Codex home shares sessions/ with the user's own login, so
 * the poller cannot read these passively; the wrapper records them here for the selector and the daemon.
 */
const SessionReadings = z.object({ v: z.literal(1), readings: z.record(z.string().regex(/^[0-9a-f]{24}$/), AccountUsage) });
const READING_KEEP_MS = 8 * 86_400_000;

function readingsPath(walkieHome: string): string {
  return join(walkieHome, "session-readings.json");
}

export function readSessionReadings(walkieHome: string, now = Date.now()): Record<string, AccountUsage> {
  const path = readingsPath(walkieHome);
  if (!existsSync(path)) return {};
  try {
    const p = SessionReadings.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return p.success ? Object.fromEntries(Object.entries(p.data.readings).filter(([, r]) => now - r.at < READING_KEEP_MS)) : {};
  } catch {
    return {};
  }
}

export function writeSessionReading(walkieHome: string, account: string, reading: AccountUsage, now = Date.now()): void {
  const r = AccountUsage.safeParse(reading);
  if (!r.success) return;
  privateDir(walkieHome);
  const cur = readSessionReadings(walkieHome, now);
  if (cur[account] && cur[account].at >= r.data.at) return;
  writeJson(readingsPath(walkieHome), { v: 1, readings: { ...cur, [account]: r.data } });
}
