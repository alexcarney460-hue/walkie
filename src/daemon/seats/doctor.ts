// Whether this machine is ready to take seats (walkie seats doctor, seats-enable.ts's `enable`, and the join
// status, join-status.ts): pure fact-gathering and checks, kept out of the CLI layer so the daemon can run the
// same doctor in-process (no HTTP round trip) right after a machine joins a team.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RELEASE_BUILD } from "../../license/service.ts";
import type { SeatRuntime, SeatsLocalView } from "../../protocol/seats.ts";
import { helperVersion, helperVersionProblem, type HelperVersion, type HelperVersionDeps } from "./helper-version.ts";
import { DEFAULT_ADMIN, DEFAULT_RUNNER, RUNTIMES_DIR, SEAT_ROOTS_FILE, runnerPathProblem } from "./seat-user.ts";
import { VERSION } from "../version.ts";
import { redactSecrets } from "../../protocol/safety.ts";
import { safeTerm } from "../../cli/format.ts";
import { findRuntime } from "./runtime.ts";
import { readGrokVersion, seatToolPolicyActive, toolPolicyCheck, type GrokVersionProbe } from "./tool-policy.ts";

export type Check = { ok: boolean | "warn"; what: string; fix?: string };

/** What the doctor looks at on this machine besides the daemon's view (injectable for tests). */
export interface DoctorFacts {
  team: string | null;
  release: boolean;
  /** For seat users: the runner/helper paths' problems, sudo reaching the helper, the helper's roots file. */
  runnerProblem: string | null;
  helper: "ok" | string;
  rootsFile: "ok" | string;
  /** The runtimes seats would run: found or not. */
  runtimes: Record<"claude" | "codex", string | null>;
  /** The installed runner and helper's versions against this walkie (release builds with seat users; else absent). */
  helperVersion?: HelperVersion | null;
  /** `grok --version` when a tool policy is set and grok is enabled. Absent when there is nothing to enforce. */
  grokCli?: GrokVersionProbe;
}

export function doctorChecks(local: SeatsLocalView, f: DoctorFacts): Check[] {
  const out: Check[] = [];
  out.push(f.team ? { ok: true, what: `in the team ${f.team}` } : { ok: false, what: "not in a team", fix: "walkie setup (or walkie join <invite>)" });
  out.push(local.allow ? { ok: true, what: "seats allowed" } : { ok: false, what: "seats are off here", fix: "walkie seats enable" });
  const tools = toolPolicyCheck(local, f.grokCli);
  if (tools) out.push(tools);
  if (local.disabled_reason) out.push({ ok: false, what: `seats don't run: ${local.disabled_reason}` });
  for (const entry of local.ambiguous_launchers ?? []) {
    out.push({ ok: "warn", what: `${entry} matches multiple admitted machines and allows none of them`, fix: `rename one machine or use @${entry.slice(1).split("/")[0]}` });
  }
  if (local.allow && !local.channel_ok) {
    const waiting = /offline|queued|waiting/i.test(local.channel_error ?? "waiting");
    out.push(waiting
      ? { ok: "warn", what: `the seats channel waits for the team's roster authority: ${local.channel_error ?? "waiting"}`, fix: "nothing to do: it completes when an owner's machine is online" }
      : { ok: false, what: `the seats channel isn't ready: ${local.channel_error}` });
  }
  if (local.ephemeral) {
    out.push({ ok: true, what: "mode: seat users (each seat runs as a fresh OS user)" });
    out.push({ ok: "warn", what: "migration to company same-user mode needs a local inventory and consent", fix: "walkie seats migration-preflight" });
    if (f.release) out.push(f.runnerProblem ? { ok: false, what: `the seat runner and helper: ${f.runnerProblem}`, fix: "walkie seats setup-user --apply" } : { ok: true, what: "the runner and user helper are root's" });
    if (f.release) out.push(f.helper === "ok" ? { ok: true, what: "sudo reaches the user helper without a password" } : { ok: false, what: `the user helper: ${f.helper}`, fix: "walkie seats setup-user --apply" });
    if (f.release) out.push(f.rootsFile === "ok" ? { ok: true, what: "the helper knows this machine's world-writable directories" } : { ok: false, what: f.rootsFile, fix: "walkie seats setup-user --apply" });
    // `walkie update` replaces walkie, never the root-owned copies: a stale one lacks this release's helper fixes.
    if (f.release && !f.runnerProblem && f.helperVersion) {
      const v = f.helperVersion;
      const problem = helperVersionProblem(v);
      out.push(!problem ? { ok: true, what: `the runner and user helper are this Walkie's (${v.want})` }
        : { ok: v.state === "stale" ? false : "warn", what: problem, fix: "walkie seats setup-user --apply" });
    }
  } else if (local.same_user) {
    out.push({ ok: "warn", what: "mode: same user (seats can reach your Walkie, files and keys)" });
  } else {
    out.push({ ok: false, what: "no seat users set up", fix: "walkie seats enable" });
  }
  const claudeBin = f.runtimes.claude;
  const claudeLogin = local.claude_login === "dedicated" ? "a token set for seats only"
    : local.claude_login === "machine" ? "this machine's login" : null;
  out.push(!claudeBin ? { ok: false, what: "Claude Code isn't installed where seats can run it", fix: local.ephemeral ? "install claude, then walkie seats setup-user --apply" : "install claude" }
    : claudeLogin ? { ok: true, what: `Claude seats: using ${claudeLogin}` }
    : { ok: false, what: "Claude seats: this machine has no usable access token or it is near expiry", fix: "use Claude Code on this machine to refresh its login, then retry; walkie seats token set is an override" });
  if (claudeBin && local.claude_login === "machine") out.push({ ok: "warn", what: local.ephemeral
    ? "Claude seats use this machine's Claude subscription; a running seat can read this machine's short-lived Claude access token, never the refresh token. Near expiry, use Claude Code here to refresh its login"
    : "Claude seats run as your user and can read everything you can, including your full Claude login" });
  if (claudeBin && local.claude_projection_near_expiry) out.push({ ok: "warn", what: "Claude's projected access-only login is near expiry; a long seat may be refused unless a selected worker login can refresh", fix: "use Claude Code here to refresh its login before a long seat" });
  if (claudeBin && local.claude_login === "dedicated") out.push({ ok: "warn", what: "Claude seats use the token set for seats only; a running seat can read it" });
  const codexBin = f.runtimes.codex;
  out.push(!codexBin ? { ok: "warn", what: "Codex isn't installed where seats can run it (only Claude seats)", fix: local.ephemeral ? "install codex, then walkie seats setup-user --apply" : "install codex" }
    : local.codex_login === "unavailable" ? { ok: false, what: `Codex seats: ${local.codex_login_reason ?? "not signed in where seat users can use it (no ~/.codex/auth.json)"}`, fix: local.codex_login_reason ? undefined : "codex login" }
    : { ok: true, what: "Codex seats: signed in (this machine's own sign-in)" });
  // WALK-103: the root-owned record of which Walkie on this machine owns its seat users.
  if (local.seat_scope?.state === "other") out.push({ ok: false, what: local.seat_scope.why, fix: "walkie seats setup-user --apply, run from this Walkie, moves this machine's seat users to it" });
  if (local.seat_scope?.state === "legacy") out.push({ ok: "warn", what: local.seat_scope.why, fix: "walkie seats setup-user --apply" });
  if (local.foreign_users?.length) {
    const users = local.foreign_users;
    out.push({ ok: "warn", what: `${users.length} seat user${users.length === 1 ? "" : "s"} here ${users.length === 1 ? "isn't" : "aren't"} this Walkie's to remove (${users.slice(0, 5).join(", ")}${users.length > 5 ? " …" : ""}): made before this update, or by another Walkie on this machine; Walkie leaves ${users.length === 1 ? "it" : "them"} and every process of ${users.length === 1 ? "it" : "them"} as they are`,
      fix: local.seat_scope?.state === "other" ? "the Walkie that owns this machine's seat users removes them" : "walkie seats setup-user --apply, then restart the Walkie daemon: it removes them once nothing of them runs, and ends a seat card left running from before the update" });
  }
  for (const user of local.leftovers_running ?? []) {
    out.push({ ok: "warn", what: `${user} is a leftover seat user that still runs processes no current seat of this Walkie started: it holds a seat slot until those processes end, then Walkie removes it`,
      fix: `to end it now: sudo pkill -KILL -u ${user} (Walkie removes the user at its next retry)` });
  }
  if (local.reconcile_error) out.push({ ok: false, what: `new seats wait: the seat users the helper still holds couldn't be listed (${local.reconcile_error})`, fix: "walkie seats setup-user --apply (reinstalls the helper and its sudo rule); Walkie retries by itself every 30 s, no restart needed" });
  if (local.cleanup_in_flight && Date.now() - local.cleanup_in_flight.since >= 60_000) {
    const h = local.cleanup_in_flight;
    out.push({ ok: "warn", what: `walkie-s${h.user} cleanup has been running since ${new Date(h.since).toLocaleString()}` });
  }
  if (local.cleanup_helper_unfinished_since) {
    out.push({ ok: false, what: `a cleanup helper did not finish (since ${new Date(local.cleanup_helper_unfinished_since).toLocaleString()})`,
      fix: "Walkie retries the seat user cleanup with backoff; its ledger claim remains pending" });
  }
  if (local.cleanup_helper_busy_since) {
    out.push({ ok: false, what: `a cleanup helper is still running (since ${new Date(local.cleanup_helper_busy_since).toLocaleString()})`,
      fix: "Walkie retries the seat user cleanup with backoff" });
  }
  if (local.retired_residue) {
    const r = local.retired_residue;
    out.push({ ok: true, what: `${r.homes} retired seat home${r.homes === 1 ? "" : "s"} hold protected macOS files; Walkie cannot read them. `
      + `${r.vaults} Apple cache vault entr${r.vaults === 1 ? "y" : "ies"} remain; known entry size ${r.knownBytes} B (opaque contents cannot be measured)` });
  }
  if (local.quarantined?.length) {
    const count = local.quarantined.length;
    const names = [...local.quarantined].sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
    const reasons = new Map<string, number>();
    for (const name of local.quarantined) {
      const reason = local.quarantine_why?.[name];
      if (reason) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    const common = [...reasons].sort((a, b) => b[1] - a[1])[0];
    const reason = common ? `; ${common[1]} × ${safeTerm(redactSecrets(common[0]).text).slice(0, 140)}` : "";
    out.push({ ok: false, what: `${count} seat user${count === 1 ? "" : "s"} awaiting cleanup (hold slots after their seats end${reason}): ${names.slice(0, 5).join(", ")}${count > 5 ? " …" : ""}`,
      fix: "see walkie seats (the reason), https://github.com/alexcarney460-hue/walkie/blob/main/docs/INSTALL.md#8-remote-seats-optional" });
    if (count >= 10) out.push({ ok: "warn", what: `large cleanup backlog: ${count} seat users awaiting cleanup`, fix: "inspect walkie seats for the reason summary" });
  }
  if (local.pending_worker_roots?.length) {
    const roots = local.pending_worker_roots;
    out.push({ ok: "warn", what: `${roots.length} pending worker root${roots.length === 1 ? "" : "s"} retained for review`, fix: "the machine's person can run walkie seats cleanup-root <root-key> at this terminal; process absence is best effort, and a process that left its group cannot be ruled out" });
    for (const root of roots) out.push({ ok: "warn", what: `worker root ${root.id}: ${root.age_s}s old; ${root.reason}` });
  }
  if (local.availability?.state === "busy") out.push({ ok: "warn", what: "this machine is busy (its person is using it): new seats queue", fix: "walkie seats resume" });
  if (!f.release && local.ephemeral) out.push({ ok: "warn", what: "a source build: its own runner and helper, not the installed ones (not checked)" });
  return out;
}

/**
 * The helper's answer to the doctor's (or setup's) own `pending` probe: null when it answered and its id ledger reads,
 * "no answer" when it didn't answer as the helper, else what's wrong. The probe isn't the registered daemon, so since
 * WALK-103 the helper refuses to list for it, and says whether the ledger reads (`ledger`) without saying what it holds.
 */
export function pendingProbeProblem(out: string): string | null {
  let r: { ok?: unknown; scope?: unknown; ledger?: unknown };
  try { r = JSON.parse(out) as typeof r; } catch { return "no answer"; }
  if (typeof r !== "object" || r === null) return "no answer";
  if (r.ok === true) return null;
  if (r.scope !== "other" && r.scope !== "unregistered" && r.scope !== "unchecked") return "no answer";
  return r.ledger === undefined || r.ledger === "ok" ? null : String(r.ledger).slice(0, 300);
}

/** The facts the doctor needs, read from this machine (`versionDeps`: tests, a fake `version` run). */
export async function doctorFacts(local: SeatsLocalView, team: string | null, versionDeps?: HelperVersionDeps): Promise<DoctorFacts> {
  // A source build runs its own runner and helper (never the installed ones): those aren't checked.
  const installed = local.ephemeral && RELEASE_BUILD;
  const runner = DEFAULT_RUNNER;
  const runnerProblem = installed ? runnerPathProblem(runner) ?? runnerPathProblem(DEFAULT_ADMIN) : null;
  let helper: string = "ok";
  if (installed) {
    const p = Bun.spawnSync(["sudo", "-n", DEFAULT_ADMIN, "seat-admin", "pending"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", cwd: "/", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
    const out = p.stdout.toString().trim();
    // This probe runs from the doctor, not from the registered daemon (WALK-103): the helper's refusal to list for it
    // still shows sudo reaches the helper; whether this Walkie is the registered one is local.seat_scope's to say.
    const problem = pendingProbeProblem(out);
    helper = problem === null ? "ok" : problem === "no answer"
      ? `sudo -n ${DEFAULT_ADMIN} seat-admin pending didn't answer (${(out || p.stderr.toString().trim()).slice(0, 160)})`
      : `sudo -n ${DEFAULT_ADMIN} seat-admin pending answered, but ${problem}`;
  }
  let rootsFile = "ok";
  if (installed) {
    const f = join(DEFAULT_ADMIN.replace(/\/[^/]+$/, ""), SEAT_ROOTS_FILE);
    try { JSON.parse(readFileSync(f, "utf8")); } catch { rootsFile = `${f} is missing or unreadable`; }
  }
  const found = (r: SeatRuntime): string | null => {
    if (installed) { const p = join(RUNTIMES_DIR, r); return existsSync(p) ? p : null; }
    for (const d of (process.env.PATH ?? "").split(":")) { const p = join(d, r); try { if (statSync(p).isFile()) return p; } catch { /* next */ } }
    return null;
  };
  const helperVersionFact = installed && !runnerProblem ? helperVersion([runner, DEFAULT_ADMIN], VERSION, versionDeps) : null;
  // findRuntime is what a same-user launch uses (executable bit, then the usual install directories). A file that
  // is not executable is not grok. A Grok seat does not use the seat-user runtime dir. A Grok seat with no tool
  // policy does not run `grok --version`.
  let grokCli: GrokVersionProbe | undefined;
  if (seatToolPolicyActive(local.tools) && (local.runtimes ?? []).includes("grok")) {
    const bin = findRuntime("grok", process.env.PATH, process.env.HOME || homedir());
    grokCli = bin ? await readGrokVersion(bin) : { kind: "missing" };
  }
  return { team, release: RELEASE_BUILD, runnerProblem, helper, rootsFile, runtimes: { claude: found("claude"), codex: found("codex") },
    helperVersion: helperVersionFact, ...(grokCli !== undefined ? { grokCli } : {}) };
}
