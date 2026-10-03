// Which Walkie on this machine owns its seat users (WALK-103). Seat users, the root helper's id ledger and the sudo
// rules are per person (sudo's SUDO_UID), but one person can run more than one Walkie daemon: a smoke test, a second
// `walkie daemon run` with HOME or WALKIE_HOME pointed elsewhere, a copy of ~/.walkie. Such a daemon used to list the
// person's real seat users through `seat-admin pending` and destroy every one, since none was in its own records.
//
// `walkie seats setup-user --apply` now records, root-owned, the Walkie it set seat users up for: its user and uid,
// its Walkie home, and its daemon socket (whose `<socket>.lock` the daemon holds for as long as it runs:
// instance-lock.ts). The root helper (admin.ts, admin-sys.ts) lists, makes and removes seat users only for the daemon
// that holds that socket's lock, and the daemon (host.ts) never asks the helper at all when the record names another
// Walkie. A setup from before this record existed is "legacy": the helper and daemon then keep the person's own seats
// working but never remove a seat user the daemon did not make itself, until setup-user --apply runs again: each seat
// user in seats.json is stamped with the socket of the daemon that made it (host.ts `made_by`), so a copied
// seats.json, or one from before the stamps, names no seat user this daemon destroys.
import { lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { SEAT_INSTANCE_FILE } from "./seat-user.ts";

/** The record setup-user installs (root:wheel/root, 0644). */
export { SEAT_INSTANCE_FILE };

export interface SeatRegistration {
  v: 1;
  /** The person whose daemon owns the seat users, and their uid (sudo's SUDO_UID for that daemon). */
  user: string;
  uid: number;
  /** That daemon's Walkie home (shown in messages) and its socket (what root binds the caller to). */
  home: string;
  socket: string;
}

export type RegistrationRead =
  | { state: "absent" }
  | { state: "invalid"; why: string }
  | { state: "present"; registration: SeatRegistration };

/**
 * What this daemon may do with the helper. `own`: the record names it; `other`: the record names another Walkie (or
 * can't be read), so it never asks the helper; `legacy`: nothing recorded (a setup from before WALK-103), so it never
 * removes a seat user it didn't make itself.
 */
export type SeatScope = { state: "own" } | { state: "other"; why: string } | { state: "legacy"; why: string };

/**
 * What the root helper found about the daemon that ran it through sudo (AdminSys.seatInstance). `unchecked`: the check
 * itself failed for a passing reason (ps or lsof timed out), as opposed to a daemon that isn't the registered one.
 */
export type SeatInstanceCheck = { state: "registered" } | { state: "other" | "unregistered" | "unchecked"; why: string };

const MAX_BYTES = 16 * 1024;

/**
 * A path as the daemon and lsof see it, with its directory's symlinks resolved (macOS /tmp → /private/tmp), so the
 * record, the daemon's own socket and root's view of an open file compare equal. The last component is kept as is.
 */
export function canonicalPath(path: string): string {
  const abs = resolve(path);
  try { return join(realpathSync(dirname(abs)), basename(abs)); } catch { return abs; }
}

export function seatRegistrationText(r: SeatRegistration): string {
  return `${JSON.stringify({ v: 1, user: r.user, uid: r.uid, home: r.home, socket: r.socket })}\n`;
}

const absolute = (p: unknown): p is string =>
  typeof p === "string" && p.length > 1 && p.length < 1024 && isAbsolute(p) && !p.includes("\0") && !p.includes("\n") && resolve(p) === p;

/** The record, or null when it isn't exactly one (every field present and plain). */
export function parseSeatRegistration(text: string): SeatRegistration | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || typeof r.user !== "string" || !/^[a-z_][a-z0-9._-]{0,31}$/.test(r.user)) return null;
  if (!Number.isSafeInteger(r.uid) || (r.uid as number) < 0) return null;
  if (!absolute(r.home) || !absolute(r.socket)) return null;
  return { v: 1, user: r.user, uid: r.uid as number, home: r.home, socket: r.socket };
}

/** Why `path` and every directory above it aren't root's alone (owned by root, writable by root only, no symlink). */
function rootOnlyProblem(path: string, stat: (p: string) => Stats): string | null {
  for (let p = path; ; p = dirname(p)) {
    const st = stat(p);
    if (st.isSymbolicLink()) return `${p} is a symlink`;
    if (st.uid !== 0) return `${p} is not owned by root`;
    if (st.mode & 0o022) return `${p} is writable by its group or other users`;
    if (p === dirname(p)) return null;
  }
}

/**
 * The record at `path`. `root`: it must be root's alone, its directories too (the real helper and daemon; tests read
 * a temporary one with `root` false). Anything but a missing file that can't be read as one record is `invalid`,
 * which fails closed like a record naming another Walkie.
 */
export function readSeatRegistration(path = SEAT_INSTANCE_FILE, root = true, stat: (p: string) => Stats = lstatSync): RegistrationRead {
  let st: Stats;
  try { st = stat(path); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    return { state: "invalid", why: `${path} can't be read (${(err as Error).message})` };
  }
  if (!st.isFile() || st.isSymbolicLink()) return { state: "invalid", why: `${path} is not a regular file` };
  if (st.size > MAX_BYTES) return { state: "invalid", why: `${path} is too large` };
  if (root) {
    let why: string | null;
    try { why = rootOnlyProblem(path, stat); } catch (err) { why = `can't check ${path} (${(err as Error).message})`; }
    if (why) return { state: "invalid", why: `${path} can't be trusted: ${why}` };
  }
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (err) { return { state: "invalid", why: `${path} can't be read (${(err as Error).message})` }; }
  const registration = parseSeatRegistration(text);
  return registration ? { state: "present", registration } : { state: "invalid", why: `${path} doesn't hold a Walkie seat registration` };
}

export const LEGACY_SCOPE_WHY = "this machine's seat users were set up by an earlier Walkie, which didn't record which Walkie on this machine owns them. "
  + "Until walkie seats setup-user --apply runs again from this Walkie: this Walkie removes only the seat users it made itself since this update; "
  + "seat users made before it, or by another Walkie here (a copied ~/.walkie included), are left as they are, never removed and their processes never stopped; "
  + "and the seat user helper installed then checks nothing itself, so an older Walkie started with another home could still remove them. "
  + "After setup-user --apply the helper lists, makes and removes seat users for this Walkie only";

export function otherScopeWhy(r: SeatRegistration): string {
  return `seat users on this machine are managed by another Walkie (${r.user}'s, home ${r.home}): this Walkie doesn't list, make or remove them. `
    + "To move them to this Walkie, run walkie seats setup-user --apply from it";
}

/** The daemon's side: whether the record names this daemon (`socket`: its own, `uid`: its own). */
export function seatScopeFor(read: RegistrationRead, socket: string, uid: number): SeatScope {
  if (read.state === "absent") return { state: "legacy", why: LEGACY_SCOPE_WHY };
  if (read.state === "invalid") return { state: "other", why: `${read.why}: Walkie doesn't use the seat user helper until walkie seats setup-user --apply records this Walkie again` };
  const r = read.registration;
  return r.uid === uid && r.socket === canonicalPath(socket) ? { state: "own" } : { state: "other", why: otherScopeWhy(r) };
}
