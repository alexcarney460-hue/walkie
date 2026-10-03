// walkie seats setup-user [--apply] [--accept-readable-home]  (PROTOCOL §11 "Seat users", SECURITY threat 13,
// INSTALL.md "Remote seats"). Prints what lets every seat run as a fresh OS user, made for it and destroyed after it
// by a root-owned helper (admin.ts): the seats' group, root-owned copies of walkie as the runner and the helper, the
// runtimes, and two sudo rules; with --apply runs it with the person's own sudo, checks the result, and points this
// machine's seats at it.
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { RELEASE_BUILD } from "../../license/service.ts";
import { defaultHome } from "../../daemon/paths.ts";
import { socketPath } from "../../client/index.ts";
import { canonicalPath, readSeatRegistration, seatRegistrationText, type SeatRegistration } from "../../daemon/seats/instance.ts";
import { pendingProbeProblem } from "../../daemon/seats/doctor.ts";
import { SEATS_GROUP } from "../../daemon/seats/admin.ts";
import { codexReleaseEnabled, downloadReal, fetchJsonReal, stageCodexRuntime } from "../../daemon/seats/codex-release.ts";
import {
  DEFAULT_ADMIN, DEFAULT_RUNNER, RUNTIMES_DIR, SEAT_ROOTS_FILE, adminGroupIds, checkSudoRules, detectSudo, homeProblem, lookupOsUser, runnerPathProblem, seatOwnerProblem, seatUserPlan,
  worldWritableDirs, type SudoInfo,
} from "../../daemon/seats/seat-user.ts";
import { isShim } from "../../switch/shims.ts";
import { bool, UsageError } from "../args.ts";
import { EXIT, type Ctx } from "../context.ts";
import { c } from "../format.ts";

/** A free group id for the seats' group (590000–599999, below the seat users' own ids), from dscl. */
function freeMacGroupId(): number {
  const used = new Set(Bun.spawnSync(["/usr/bin/dscl", ".", "-list", "/Groups", "PrimaryGroupID"], { stdout: "pipe", stderr: "ignore" })
    .stdout.toString().split("\n").map((l) => Number(l.trim().split(/\s+/).pop())));
  for (let id = 590_000; id < 600_000; id++) if (!used.has(id)) return id;
  throw new Error("no free group id between 590000 and 599999");
}

/**
 * A runtime on the person's PATH as a single native binary (copyable), or null (missing, or a script). Walkie's own
 * account shims (`walkie accounts shims install`: a script carrying SHIM_MARK, in ~/.walkie/bin) are passed over and
 * the search goes on down PATH to the native binary they start (PRE4 RC, Codex 4).
 */
export function nativeRuntime(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const headOf = (path: string): string => {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(256);
      return buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString("latin1");
    } finally { closeSync(fd); }
  };
  if (env.WALKIE_APP_AUTHORIZED === "1") {
    const provided = env[name === "claude" ? "WALKIE_APP_CLAUDE" : "WALKIE_APP_CODEX"];
    if (!provided) return null;
    try {
      if (!provided.startsWith("/") || realpathSync(provided) !== provided || !statSync(provided).isFile()) return null;
      if (isShim(provided) || headOf(provided).startsWith("#!")) return null;
      return provided;
    } catch { return null; }
  }
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    try {
      const path = join(dir, name);
      const real = realpathSync(path);
      if (!statSync(real).isFile()) continue;
      if (isShim(real)) continue;
      return headOf(real).startsWith("#!") ? null : real;
    } catch { /* not here */ }
  }
  return null;
}

function shell(argv: string[]): string {
  return argv.map((a) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");
}

export async function setupUser(ctx: Ctx): Promise<number> {
  const r = await seatUserSetup(ctx, { apply: bool(ctx.args, "apply"), accept: bool(ctx.args, "accept-readable-home"), plan: true });
  return r.ok ? EXIT.ok : EXIT.error;
}

/** The app's root transaction must keep the daemon's actual user and home. */
export function desktopSeatOwner(uid: number | undefined, env: NodeJS.ProcessEnv): { username: string; homedir: string } | null {
  if (env.WALKIE_APP_AUTHORIZED !== "1") return null;
  const username = env.WALKIE_APP_SEAT_OWNER ?? "";
  const homedir = env.HOME ?? "";
  if (uid !== 0 || !/^[a-z_][a-z0-9_-]{0,30}$/.test(username) || !homedir.startsWith("/") || homedir === "/" || homedir.includes("/../")) {
    throw new UsageError("the desktop seat owner or home is invalid");
  }
  return { username, homedir };
}

/**
 * Plans (and with `apply` runs, with the person's own sudo, then checks) what lets every seat run as a fresh OS user.
 * `plan`: print the plan first (setup-user does; `walkie seats enable` prints only the steps as it runs them).
 * `sudo`: the sudo to plan for (tests; the container check): this machine's own is looked up when it isn't given.
 * `ok` false with `why` when it was refused or failed (already printed).
 */
export async function seatUserSetup(ctx: Ctx, o: { apply: boolean; accept: boolean; plan: boolean; sudo?: SudoInfo }): Promise<{ ok: boolean; applied: boolean; why?: string }> {
  const { apply, accept } = o;
  const local = await ctx.client().seats().then((v) => v.local).catch(() => null);
  // A signed desktop app may run this fixed transaction as root after one macOS authorization dialog.
  // The daemon and seat owner remain the logged-in person, never root.
  const rootOwner = desktopSeatOwner(process.getuid?.(), process.env);
  const me = rootOwner ? { ...userInfo(), ...rootOwner } : userInfo();
  const groupExists = Bun.spawnSync(process.platform === "darwin" ? ["/usr/bin/dscl", ".", "-read", `/Groups/${SEATS_GROUP}`] : ["getent", "group", SEATS_GROUP], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  const tmp = mkdtempSync(join(tmpdir(), "walkie-sudoers-"));
  try {
    const taken = seatOwnerProblem(me.username, (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } });
    if (taken) { ctx.err(c.red(`not set up: ${taken}`)); return { ok: false, applied: false, why: taken }; }
    const runtimes = Object.fromEntries(["claude", "codex"].map((r) => [r, nativeRuntime(r)]));
    // --codex-release / WALKIE_CODEX_RELEASE=1 (WALK-50, OCJ-D): the OFFICIAL standalone Codex release, checksum-
    // verified against its own published checksums, in place of whatever `codex` a Homebrew/npm install left on
    // PATH. Off by default: nativeRuntime("codex") above keeps deciding it. Never fatal by itself — a failure here
    // (offline, no matching asset, a bad checksum) falls back to nativeRuntime and is only a warning.
    const codexRelease = codexReleaseEnabled(process.env, bool(ctx.args, "codex-release"));
    if (codexRelease) {
      try {
        const staged = await stageCodexRuntime({ destDir: join(tmp, "codex-release"), fetchJson: fetchJsonReal, download: downloadReal });
        runtimes.codex = staged.path;
        ctx.out(c.dim(`codex from the official release: ${staged.version} (${staged.tag}, ${staged.asset}), checksum-verified`));
      } catch (err) {
        ctx.out(c.yellow(`note: the official Codex release could not be staged (${(err as Error).message}); `
          + (runtimes.codex ? `using ${runtimes.codex} found on PATH instead` : "and no codex on PATH either: Codex seats won't run")));
      }
    }
    const extraRoots = worldWritableDirs(); // swept too (Opus r7 6)
    // WALK-103: the Walkie these seat users are for (this daemon: the socket this command talks to), recorded root-owned
    // so the helper serves only it and no second daemon of this person's (a test, another WALKIE_HOME) can remove them.
    const uid = rootOwner ? lookupOsUser(me.username)?.uid : process.getuid?.();
    if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
      const why = `can't tell ${me.username}'s user id: not set up`;
      ctx.err(c.red(why));
      return { ok: false, applied: false, why };
    }
    const walkieHome = process.env.WALKIE_HOME ?? defaultHome();
    const registration: SeatRegistration = { v: 1, user: me.username, uid, home: resolve(walkieHome), socket: canonicalPath(socketPath()) };
    const plan = seatUserPlan({
      platform: process.platform, daemonUser: me.username, source: RELEASE_BUILD ? process.execPath : "<the walkie release binary>",
      groupId: process.platform === "darwin" && !groupExists ? freeMacGroupId() : 0, walkieHome,
      sudoersTmp: join(tmp, "walkie-seats"), runtimes, home: me.homedir,
      homeProblem: homeProblem(me.homedir, statSync(me.homedir), []), acceptReadableHome: accept,
      extraRoots, rootsTmp: join(tmp, SEAT_ROOTS_FILE), ownerTmp: join(tmp, "seat-owner"),
      instanceTmp: join(tmp, "seat-instance"), instanceHome: registration.home,
      sudo: o.sudo ?? detectSudo(), codexReleaseTried: codexRelease,
    });
    writeFileSync(join(tmp, "seat-owner"), `${me.username}\n`, { mode: 0o644 });
    writeFileSync(join(tmp, "seat-instance"), seatRegistrationText(registration), { mode: 0o644 });
    const before = readSeatRegistration();
    if (before.state === "present" && before.registration.socket !== registration.socket) {
      ctx.out(c.yellow(`note: this machine's seat users belong to the Walkie at ${before.registration.home} now; applying moves them to this one (${registration.home}), and that Walkie stops listing, making or removing them`));
    }
    writeFileSync(join(tmp, "walkie-seats"), plan.sudoers, { mode: 0o644 });
    writeFileSync(join(tmp, SEAT_ROOTS_FILE), `${JSON.stringify(extraRoots)}\n`, { mode: 0o644 });
    const steps = plan.steps.filter((s) => !s.group || !groupExists);
    if (o.plan) {
      if (ctx.json && !apply) { ctx.out(JSON.stringify({ ...plan, steps })); return { ok: true, applied: false }; }
      ctx.out(c.bold("Every seat as a fresh OS user of its own, made for it and destroyed after it (never reused)"));
      ctx.out(c.dim("A seat then can't reach your Walkie (its socket and token stay in your 0700 ~/.walkie), your home (closed to other"));
      ctx.out(c.dim("users), another seat, or a later one: its user, with every process, schedule, service and file of it, is removed."));
      for (const s of steps) ctx.out(`  ${s.sudo ? "sudo " : ""}${shell(s.argv)}  ${c.dim(`# ${s.what}`)}`);
      ctx.out(c.dim(`  ${plan.sudoNote}`));
      ctx.out(c.dim(`  the sudo rules (${plan.sudoersPath}):`));
      for (const l of plan.sudoers.trim().split("\n")) ctx.out(c.dim(`    ${l}`));
      ctx.out(c.dim(`Seats run the root-owned runtime copies in ${RUNTIMES_DIR}; re-run --apply after updating walkie, claude or codex.`));
    } else {
      ctx.out(c.dim(plan.sudoNote));
    }
    for (const w of plan.warnings) ctx.out(c.yellow(`note: ${w}`));
    // Not overridable like the readable home: rules this sudo can't match would only refuse every seat, later and more confusingly.
    if (plan.sudoProblem) {
      ctx.err(c.red(`not applied: ${plan.sudoProblem}`));
      return { ok: !apply, applied: false, why: plan.sudoProblem };
    }
    if (plan.blocked) {
      ctx.err(c.red(`not applied: ${plan.blocked}`));
      ctx.err(c.dim("Close it (chmod 700 ~) and run this again, or accept that seat users read it: --accept-readable-home"));
      return { ok: !apply, applied: false, why: plan.blocked };
    }
    if (!apply) {
      ctx.out(`Run it: walkie seats setup-user --apply ${c.dim("(asks for your password through sudo)")}`);
      return { ok: true, applied: false };
    }
    if (!RELEASE_BUILD) {
      const why = "seat users are set up by an installed walkie (walkie seats setup-user --apply installs its release binary as the runner and helper): run it from an installed walkie, not from source";
      ctx.err(c.red(why));
      return { ok: false, applied: false, why };
    }
    // AGENT-ADMIN-1: no terminal (an agent, a remote admin run) means no password prompt: sudo must work without one
    // (a NOPASSWD rule for this user), checked up front so nothing is half-applied.
    const unattended = process.stdin.isTTY !== true;
    if (unattended && steps.some((s) => s.sudo) && !desktopSeatOwner(process.getuid?.(), process.env) && Bun.spawnSync(["/usr/bin/sudo", "-n", "true"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exitCode !== 0) {
      const why = "setting up seat users needs root, and sudo here asks for a password with no terminal to type it in. This is the one step root must approve once: someone at this machine runs walkie seats setup-user --apply in a terminal (or this user gets passwordless sudo); nothing was changed. Seats as this OS user need no root: walkie seats enable --yes --same-user";
      ctx.err(c.red(why));
      return { ok: false, applied: false, why };
    }
    for (const s of steps) {
      ctx.err(c.dim(`→ ${s.what}`));
      const tool = process.platform === "darwin" ? ({ dscl: "/usr/bin/dscl", install: "/usr/bin/install", chown: "/usr/sbin/chown", mkdir: "/bin/mkdir", chmod: "/bin/chmod", visudo: "/usr/sbin/visudo", sudo: "/usr/bin/sudo" } as Record<string, string>)[s.argv[0] as string] : undefined;
      const argv = tool ? [tool, ...s.argv.slice(1)] : s.argv;
      const full = s.sudo && process.getuid?.() !== 0 ? ["/usr/bin/sudo", ...(unattended ? ["-n"] : []), ...argv] : argv;
      const stdin = unattended ? "ignore" : "inherit";
      let ok: boolean;
      if (s.sudoersCheck) {
        // A sudo that doesn't know `requiretty` (sudo-rs) says so; then, and only then, the rules are written again without it.
        const capture = () => Bun.spawnSync(full, { stdin, stdout: "pipe", stderr: "pipe" });
        const last: { p: ReturnType<typeof capture> | null } = { p: null };
        const without = plan.sudoersWithoutRequiretty;
        const rules = checkSudoRules(
          () => { const p = capture(); last.p = p; return { ok: p.exitCode === 0, output: `${p.stdout}${p.stderr}` }; },
          without === null ? null : () => writeFileSync(join(tmp, "walkie-seats"), without, { mode: 0o644 }),
        );
        if (rules.regenerated) ctx.out(c.yellow("note: this sudo doesn't know the requiretty setting (it is sudo-rs): the sudo rules were written again without it"));
        if (last.p?.stdout.length) ctx.out(last.p.stdout.toString().trimEnd());
        if (last.p?.stderr.length) ctx.err(last.p.stderr.toString().trimEnd());
        ok = rules.ok;
      } else {
        ok = Bun.spawnSync(full, { stdin, stdout: "inherit", stderr: "inherit" }).exitCode === 0;
      }
      if (!ok) { ctx.err(c.red(`failed: ${s.sudo ? "sudo " : ""}${shell(s.argv)}`)); return { ok: false, applied: false, why: `failed: ${s.what}` }; }
    }
    // Checked, not assumed: the runner's and helper's whole paths are root's, the admin groups can be read, and sudo
    // reaches the helper without a password (its answer to `pending` is the point).
    for (const path of [DEFAULT_RUNNER, DEFAULT_ADMIN]) {
      const why = runnerPathProblem(path);
      if (why) { ctx.err(c.red(`${path} isn't protected: ${why}`)); return { ok: false, applied: false, why }; }
    }
    if (adminGroupIds() === null) { ctx.err(c.red("the administrative groups can't be read: seats would not run")); return { ok: false, applied: false, why: "administrative groups unreadable" }; }
    const owner = desktopSeatOwner(process.getuid?.(), process.env);
    const asOwner = (argv: string[]) => (owner ? ["/usr/bin/sudo", "-u", owner.username, ...argv] : argv);
    const probe = Bun.spawnSync(asOwner(["/usr/bin/sudo", "-n", DEFAULT_ADMIN, "seat-admin", "pending"]), { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    if (!probe.stdout.toString().startsWith("{")) {
      const why = `sudo -n ${DEFAULT_ADMIN} seat-admin didn't answer: check ${plan.sudoersPath} (${probe.stderr.toString().trim().slice(0, 200)})`;
      ctx.err(c.red(why));
      return { ok: false, applied: false, why };
    }
    // This command isn't the daemon, so the helper refuses to list for it (WALK-103) but says whether its ledger reads.
    const ledger = pendingProbeProblem(probe.stdout.toString().trim());
    if (ledger !== null && ledger !== "no answer") {
      const why = `${DEFAULT_ADMIN} answered, but ${ledger}`;
      ctx.err(c.red(why));
      return { ok: false, applied: false, why };
    }
    // `pending` takes no argument, the helper's other commands do (`create <n>`): run one with an argument the helper refuses (0 is no
    // id: it answers {"ok":false,…} and does nothing). A sudo that parses the rules and still refuses them (sudo-rs before 0.2.13)
    // would otherwise look ready. -k: not on a password cached from the steps above.
    const create = Bun.spawnSync(asOwner(["/usr/bin/sudo", "-k", "-n", DEFAULT_ADMIN, "seat-admin", "create", "0"]), { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    if (!create.stdout.toString().startsWith("{")) {
      const why = `sudo here won't run ${DEFAULT_ADMIN} seat-admin create <n> without a password (${create.stderr.toString().trim().slice(0, 200) || "no answer"}): ${plan.sudoersPath} is installed, but no seat user could be made through it. If this is sudo-rs older than 0.2.13, update it; or run seats as your own user: walkie seats enable --same-user`;
      ctx.err(c.red(why));
      return { ok: false, applied: false, why };
    }
    const { local: after } = await ctx.client().seatsConfig({
      allow: local?.allow ?? false, ephemeral: true, admin: DEFAULT_ADMIN, runner: DEFAULT_RUNNER, runtime_dir: RUNTIMES_DIR,
      ...(accept ? { accept_readable_home: true } : {}),
    });
    if (o.plan) ctx.out(`${c.green("done")}: every seat on this machine runs as a fresh user${after.allow ? "" : " once you allow seats (walkie seats allow)"}`);
    return { ok: true, applied: true };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
