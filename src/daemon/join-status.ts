// JOIN-STATUS-1 (WALK-50 "Doctor, recovery"): once this machine is admitted to a team, one plain status posted to
// #general as `walkie-admin` — this machine's Walkie version, its seat capacity, and whether Claude Code / Codex
// are ready to run seats here. The seats doctor (seats/doctor.ts) supplies the Claude/Codex facts; a few cheap
// local checks (borrowed from `walkie doctor`'s own: socket/key permissions, DB integrity) stand in for "basic
// health" — no HTTP round trip, no subprocess beyond what the seats doctor itself may run.
//
// A fresh join often outraces the team's #general channel being synced here, so posting is retried on every
// roster change (JoinStatusReporter.rosterChanged, called from core.onRosterChange like every other subsystem
// that follows the roster) until it succeeds. A marker file in the Walkie home, written only after a confirmed
// post, then makes it post at most once per admission: a crash between posting and marking, or this node
// re-joining to re-pin its own IP (join.ts `adopt`, called again for an already-admitted node), never doubles it.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SeatsLocalView } from "../protocol/seats.ts";
import { redactSecrets } from "../protocol/safety.ts";
import { ADMIN_AGENT, AUDIT_CHANNEL } from "./admin/audit.ts";
import type { Core } from "./core.ts";
import type { Logger } from "./logger.ts";
import { doctorFacts, type DoctorFacts } from "./seats/doctor.ts";
import { seatsFor } from "./seats/host.ts";
import { VERSION } from "./version.ts";

const MARKER_FILE = "join-status-posted-v1";
/** Mirrors admin/audit.ts's own line cap: a post here never grows unbounded either. */
const MAX_TEXT = 600;

export interface RuntimeReadiness { ready: boolean; why?: string }

/** Claude/Codex readiness from the seats doctor's own facts — independent of whether seats are enabled here. */
export function runtimeReadiness(local: SeatsLocalView, facts: DoctorFacts): { claude: RuntimeReadiness; codex: RuntimeReadiness } {
  const claude: RuntimeReadiness = !facts.runtimes.claude
    ? { ready: false, why: "Claude Code not installed" }
    : local.claude_login === "unavailable"
    ? { ready: false, why: "Claude Code not signed in" }
    : { ready: true };
  const codex: RuntimeReadiness = !facts.runtimes.codex
    ? { ready: false, why: "Codex not installed" }
    : local.codex_login === "unavailable"
    ? { ready: false, why: "Codex not signed in" }
    : { ready: true };
  return { claude, codex };
}

export interface HealthFact { ok: boolean; why?: string }

/** A few cheap local checks (`walkie doctor`'s own): world-readable secrets, a corrupt database. */
export function basicHealth(paths: { socket: string; key: string; db: string }): HealthFact {
  for (const [path, label] of [[paths.socket, "the local socket"], [paths.key, "the node key"]] as const) {
    if (existsSync(path) && statSync(path).mode & 0o077) return { ok: false, why: `${label}'s permissions are too open` };
  }
  if (existsSync(paths.db)) {
    try {
      const db = new Database(paths.db, { readonly: true });
      const r = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
      db.close();
      if (r?.integrity_check !== "ok") return { ok: false, why: "the local database failed its integrity check" };
    } catch {
      return { ok: false, why: "the local database is unreadable" };
    }
  }
  return { ok: true };
}

export interface JoinStatusFacts {
  handle: string;
  machine: string;
  version: string;
  seats: { running: number; max: number };
  disabled_reason?: string;
  claude: RuntimeReadiness;
  codex: RuntimeReadiness;
  health: HealthFact;
}

/** "Ready: @handle's machine, Walkie x.y.z, seats n/max, Claude/Codex ready", or a partial status naming what isn't. */
export function joinStatusText(f: JoinStatusFacts): string {
  const base = `@${f.handle}'s ${f.machine}, Walkie ${f.version}, seats ${f.seats.running}/${f.seats.max}`;
  const problems: string[] = [];
  if (f.disabled_reason) problems.push(`seats unavailable: ${f.disabled_reason}`);
  if (!f.health.ok) problems.push(f.health.why ?? "a local health check failed");
  if (!f.claude.ready) problems.push(f.claude.why ?? "Claude Code not ready");
  if (!f.codex.ready) problems.push(f.codex.why ?? "Codex not ready");
  return problems.length ? `Partial: ${base} — missing: ${problems.join("; ")}` : `Ready: ${base}, Claude/Codex ready`;
}

function markerPath(core: Pick<Core, "paths">): string {
  return join(core.paths.home, MARKER_FILE);
}

/** Whether this admission (this team id) already got its post, from a previous run of this daemon. */
function alreadyPosted(core: Pick<Core, "paths" | "teamId">): boolean {
  try { return readFileSync(markerPath(core), "utf8").trim() === core.teamId; } catch { return false; }
}

function markPosted(core: Core): void {
  try { writeFileSync(markerPath(core), `${core.teamId ?? ""}\n`, { mode: 0o600 }); }
  catch (err) { core.log.warn("join_status_mark_failed", { error: (err as Error).message }); }
}

function gatherFacts(core: Core): JoinStatusFacts | null {
  const handle = core.myHandle();
  const local = seatsFor(core)?.view();
  if (!handle || !local) return null; // not admitted yet, or the seats host isn't wired: retried on the next roster change
  const facts = doctorFacts(local, core.roster.team?.name ?? null);
  const { claude, codex } = runtimeReadiness(local, facts);
  return {
    handle, machine: core.hostname, version: VERSION, seats: { running: local.running, max: local.max },
    ...(local.disabled_reason ? { disabled_reason: local.disabled_reason } : {}),
    claude, codex, health: basicHealth(core.paths),
  };
}

/** Posts the join status as `walkie-admin` in #general; true only once the post is confirmed emitted. */
function tryPost(core: Core, text: string): boolean {
  if (!core.teamId || !core.me() || !core.roster.channels.has(AUDIT_CHANNEL)) return false;
  const cut = redactSecrets(text).text;
  try {
    core.emit("msg.post", { text: cut.length > MAX_TEXT ? `${cut.slice(0, MAX_TEXT - 1)}…` : cut }, { channel: AUDIT_CHANNEL, agent: ADMIN_AGENT });
    return true;
  } catch (err) {
    core.log.warn("join_status_post_failed", { error: (err as Error).message });
    return false;
  }
}

/**
 * Retries the join status post on every roster change until #general exists and the post itself succeeds, then
 * never again for this admission (durable across restarts: the marker names the team id).
 */
export class JoinStatusReporter {
  private posted: boolean;

  constructor(private readonly core: Core, private readonly log: Logger) {
    this.posted = alreadyPosted(core);
  }

  rosterChanged(): void {
    if (this.posted || !this.core.teamId || !this.core.roster.channels.has(AUDIT_CHANNEL)) return;
    const facts = gatherFacts(this.core);
    if (!facts) return;
    if (!tryPost(this.core, joinStatusText(facts))) return;
    this.posted = true;
    markPosted(this.core);
    this.log.info("join_status_posted", { team: this.core.teamId });
  }
}
