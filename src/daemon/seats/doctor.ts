// Whether this machine is ready to take seats (walkie seats doctor, seats-enable.ts's `enable`, and the join
// status, join-status.ts): pure fact-gathering and checks, kept out of the CLI layer so the daemon can run the
// same doctor in-process (no HTTP round trip) right after a machine joins a team.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { RELEASE_BUILD } from "../../license/service.ts";
import type { SeatRuntime, SeatsLocalView } from "../../protocol/seats.ts";
import { helperVersion, helperVersionProblem, type HelperVersion, type HelperVersionDeps } from "./helper-version.ts";
import { DEFAULT_ADMIN, DEFAULT_RUNNER, RUNTIMES_DIR, SEAT_ROOTS_FILE, runnerPathProblem } from "./seat-user.ts";
import { VERSION } from "../version.ts";
import { redactSecrets } from "../../protocol/safety.ts";
import { safeTerm } from "../../cli/format.ts";

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
}

export function doctorChecks(local: SeatsLocalView, f: DoctorFacts): Check[] {
  const out: Check[] = [];
  out.push(f.team ? { ok: true, what: `in the team ${f.team}` } : { ok: false, what: "not in a team", fix: "walkie setup (or walkie join <invite>)" });
  out.push(local.allow ? { ok: true, what: "seats allowed" } : { ok: false, what: "seats are off here", fix: "walkie seats enable" });
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
    out.push({ ok: true, what: "every seat runs as a fresh OS user, removed after it" });
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
    out.push({ ok: "warn", what: "seats run as YOUR OS user (they can reach your Walkie and your files)", fix: "walkie seats setup-user --apply" });
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
  if (claudeBin && local.claude_login === "dedicated") out.push({ ok: "warn", what: "Claude seats use the token set for seats only; a running seat can read it" });
  const codexBin = f.runtimes.codex;
  out.push(!codexBin ? { ok: "warn", what: "Codex isn't installed where seats can run it (only Claude seats)", fix: local.ephemeral ? "install codex, then walkie seats setup-user --apply" : "install codex" }
    : local.codex_login === "unavailable" ? { ok: false, what: "Codex seats: not signed in where seat users can use it (no ~/.codex/auth.json)", fix: "codex login" }
    : { ok: true, what: "Codex seats: signed in (this machine's own sign-in)" });
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
  if (local.availability?.state === "busy") out.push({ ok: "warn", what: "this machine is busy (its person is using it): new seats queue", fix: "walkie seats resume" });
  if (!f.release && local.ephemeral) out.push({ ok: "warn", what: "a source build: its own runner and helper, not the installed ones (not checked)" });
  return out;
}

/** The facts the doctor needs, read from this machine (`versionDeps`: tests, a fake `version` run). */
export function doctorFacts(local: SeatsLocalView, team: string | null, versionDeps?: HelperVersionDeps): DoctorFacts {
  // A source build runs its own runner and helper (never the installed ones): those aren't checked.
  const installed = local.ephemeral && RELEASE_BUILD;
  const runner = DEFAULT_RUNNER;
  const runnerProblem = installed ? runnerPathProblem(runner) ?? runnerPathProblem(DEFAULT_ADMIN) : null;
  let helper: string = "ok";
  if (installed) {
    const p = Bun.spawnSync(["sudo", "-n", DEFAULT_ADMIN, "seat-admin", "pending"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", cwd: "/", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
    const out = p.stdout.toString().trim();
    helper = out.startsWith('{"ok":true') ? "ok" : `sudo -n ${DEFAULT_ADMIN} seat-admin pending didn't answer (${(out || p.stderr.toString().trim()).slice(0, 160)})`;
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
  return { team, release: RELEASE_BUILD, runnerProblem, helper, rootsFile, runtimes: { claude: found("claude"), codex: found("codex") },
    helperVersion: helperVersionFact };
}
