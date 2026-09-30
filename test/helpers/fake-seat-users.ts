// A fake machine for ephemeral seat users (src/daemon/seats/admin.ts): tests can't create OS users, so this world
// fakes only the OS underneath the REAL helper logic (createSeatUser / destroySeatUser, with every verification):
// users live in a map, homes are directories under the test root, "the processes of a uid" are the processes whose
// environment carries that user's marker (WALKIE_SEAT_FAKE_UID, as src/daemon/seats/runner-uid.ts's test scope), and
// "the files a uid owns" are, for the REAL runner's sweep (runner-sweep.ts, run for the fake user with its marker),
// the entries in `outside/` named after that marker (and what is inside them, except `other-*`) and everything in
// its home but root's marker. The ledger is the real one (admin-ledger.ts) in the test root. A seat's own run is
// sandboxed (macOS) away from the daemon's Walkie home and every other seat user's home, as their permissions would.
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  SEATS_GROUP, SEAT_HOME_MARKER, createSeatUser, destroySeatUser, pendingSeatUsers, type AdminResult, type AdminSys, type AdminVerb,
} from "../../src/daemon/seats/admin.ts";
import { Ledger } from "../../src/daemon/seats/admin-ledger.ts";
import { readSeatPendingReadOnly } from "../../src/daemon/seats/admin-sys.ts";
import { runnerOp } from "../../src/daemon/seats/runner-child.ts";
import { SWEEP_ROOTS_ENV } from "../../src/daemon/seats/runner-sweep.ts";
import { fakePids } from "../../src/daemon/seats/runner-uid.ts";
import { listAcl, selfRunnerArgv, type OsUser } from "../../src/daemon/seats/seat-user.ts";

const SANDBOX = "/usr/bin/sandbox-exec";
export const canSandbox = process.platform === "darwin" && existsSync(SANDBOX);
const SEATS_GID = 599_999;

export interface FakeSeatWorld {
  root: string;
  homes: string;
  outside: string;
  schedulerFiles: { cron: [string, string]; at: [string, string] };
  users: Map<string, { uid: number; gid: number; gids: number[] }>;
  markers: Map<string, string>;
  /**
   * What to break: "destroy-files" (the user's sweep answers unverified), "services" / "schedules" (those stages fail),
   * "admin" (the call fails).
   */
  broken: Set<string>;
  created: string[];
  destroyed: string[];
  /** Mount points the fake users made (tests add them), those the helper unmounted, and the extra sweep roots. */
  mounts: Set<string>;
  /** Paths the fake stat reports as root's (a home whose creation was interrupted before it was handed over). */
  rootOwned: Set<string>;
  otherOwned: Set<string>;
  unstatable: Set<string>;
  /** Override st_dev for a retained entry without creating a real mount. */
  fakeDevices: Map<string, number>;
  vaults: Map<string, { uid: number; flags: number }>;
  unmounted: string[];
  extraRoots: string[];
  /** Every sweep the helper asked the (fake) seat user for, and what it answered. */
  sweeps: Array<{ name: string; verified: boolean; left: string[] }>;
  sys: AdminSys;
  admin: (verb: AdminVerb, n: number) => Promise<AdminResult>;
  lookup: (name: string) => OsUser | null;
  userSwitch: (user: string, runner: string[], purpose: string) => string[];
  /** Operations of the uid switch to fail (a broken sudo): "stop", "cont", "run". */
  failing: Set<string>;
}

export function fakeSeatWorld(root: string, walkieHome: string): FakeSeatWorld {
  const homes = join(root, "seat-users");
  const outside = join(root, "outside");
  const cache = join(root, "system-caches");
  mkdirSync(homes, { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(cache, { recursive: true });
  const schedulerFiles = { cron: [join(root, "cron.allow"), join(root, "cron.deny")] as [string, string], at: [join(root, "at.allow"), join(root, "at.deny")] as [string, string] };
  let ledger: Ledger | null = null;
  const users = new Map<string, { uid: number; gid: number; gids: number[] }>();
  const markers = new Map<string, string>();
  const seatUid = (name: string) => (/^walkie-s\d+$/.test(name) ? 600_000 + Number(name.slice(8)) : -1);
  const byUid = (uid: number) => [...users.entries()].find(([, u]) => u.uid === uid)?.[0] ?? [...markers.keys()].find((n) => Number(n.slice(8)) + 600_000 === uid);
  const broken = new Set<string>();
  const w: FakeSeatWorld = {
    root, homes, outside, schedulerFiles, users, markers, broken, created: [], destroyed: [], sweeps: [], failing: new Set(), mounts: new Set(), rootOwned: new Set([cache]), otherOwned: new Set(), unstatable: new Set(), fakeDevices: new Map(), vaults: new Map(), unmounted: [], extraRoots: [],
    sys: {
      platform: "darwin", homesDir: homes, cacheDir: cache, schedulerFiles,
      ledger: () => (ledger ??= new Ledger(join(root, "seat-admin.sqlite"))),
      pendingReadOnly: (owner) => readSeatPendingReadOnly(join(root, "seat-admin.sqlite"), owner, false),
      talkieLockPath: join(root, "seat-admin.sqlite.talkie.lock"),
      verifyEmptyTalkieUid: () => ({ ok: true, left: [] }),
      talkieGenerationStopped: async () => ({ ok: true }),
      caller: () => process.getuid?.() ?? -1,
      userMounts: () => { if (broken.has("mounts")) throw new Error("getmntinfo failed (broken)"); return [...w.mounts]; },
      unmount: (path) => { if (broken.has("unmount")) throw new Error("EBUSY (broken)"); w.mounts.delete(path); w.unmounted.push(path); },
      extraRoots: () => { if (broken.has("roots")) throw new Error("seat-roots.json is missing (broken)"); return [...w.extraRoots]; },
      nameTaken: (name) => users.has(name),
      idTaken: (id) => [...users.values()].some((u) => u.uid === id || u.gid === id),
      lookup: (name) => (name === SEATS_GROUP ? { uid: -1, gid: SEATS_GID, gids: [] } : users.get(name) ?? null),
      createUser: ({ name, uid }) => {
        users.set(name, { uid, gid: uid, gids: [uid, SEATS_GID] });
        markers.set(name, `${name}-${process.pid}-${Math.floor(Math.random() * 1e6)}`);
        w.created.push(name);
      },
      deleteUser: (name) => { if (users.delete(name)) w.destroyed.push(name); },
      makeHome: (home) => {
        mkdirSync(home, { mode: 0o700 });
        mkdirSync(join(home, "walkie-seats"), { mode: 0o700 });
        writeFileSync(join(home, SEAT_HOME_MARKER), "", { mode: 0o444 });
      },
      retireHome: (home, uid, name, retirement) => {
        const parent = join(homes, ".walkie-retired");
        const priorRecord = retirement.read();
        const destName = priorRecord?.tombstone ?? `${name}-${uid}-${createHash("sha256")
          .update(`${uid}\0${retirement.op.pid}\0${retirement.op.start}`).digest("hex").slice(0, 32)}`;
        const dest = join(parent, destName);
        const source = w.sys.stat(home);
        if (!source && !existsSync(parent)) {
          if (priorRecord) throw new Error("the recorded tombstone parent is missing");
          return null;
        }
        if (source) mkdirSync(parent, { mode: 0o700, recursive: true });
        if (!source) {
          if (!priorRecord) {
            if (readdirSync(parent).some((entry) => entry === `${name}-${uid}` || entry.startsWith(`${name}-${uid}-`)))
              throw new Error("an existing seat tombstone has no provenance");
            return null;
          }
          const prior = w.sys.stat(dest);
          if (!prior) throw new Error("the recorded tombstone is missing");
          const id = lstatSync(dest);
          if (priorRecord.uid !== uid || priorRecord.sourceDev !== id.dev || priorRecord.sourceIno !== id.ino)
            throw new Error("the existing tombstone does not match its provenance");
          if (!prior.dir || prior.symlink || prior.uid !== 0 || (prior.mode & 0o777) !== 0o700)
            throw new Error("the existing tombstone is not root-only");
          return { path: dest, bytes: id.size };
        }
        if (!source?.dir || source.symlink || source.uid !== uid || existsSync(dest)) throw new Error("the seat home cannot be retired");
        const id = lstatSync(home);
        retirement.prepare({ uid, sourceDev: id.dev, sourceIno: id.ino, tombstone: destName });
        chmodSync(home, 0o700);
        renameSync(home, dest);
        w.rootOwned.add(dest);
        const moved = w.sys.stat(dest);
        if (!moved?.dir || moved.symlink || moved.uid !== 0 || (moved.mode & 0o777) !== 0o700 || existsSync(home))
          throw new Error("the seat home tombstone cannot be verified");
        return { path: dest, bytes: lstatSync(dest).size };
      },
      verifyHomeResidue: (home, uid, proofs) => {
        const evidence = new Map(proofs.map((p) => [p.path, p]));
        if (evidence.size !== proofs.length || !proofs.length) return "invalid runner EPERM proof";
        const check = (dir: string, parentDev: number): string | null => {
          for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (name === SEAT_HOME_MARKER && dir === home) continue;
            if (w.unstatable.has(path)) return `${path} cannot be checked by root`;
            const st = lstatSync(path);
            const dev = w.fakeDevices.get(path) ?? st.dev;
            if (dev !== parentDev) return `${path} is on a different device than its parent`;
            const owner = w.rootOwned.has(path) ? 0 : w.otherOwned.has(path) ? uid + 1 : uid;
            if (owner !== uid) return `${path} is not owned by the seat uid`;
            if (st.isSymbolicLink()) return `${path} is a symbolic link`;
            if (st.isFile() && st.nlink !== 1) return `${path} has multiple hard links`;
            const proof = evidence.get(path);
            if (proof) {
              if (!proof.reason.startsWith("EPERM") || proof.dev !== undefined && (proof.dev !== dev || proof.ino !== st.ino))
                return `${path} has no matching runner EPERM proof`;
              evidence.delete(path);
              if (!proofs.some((p) => p.path.startsWith(`${path}/`))) continue;
            }
            if (!st.isDirectory()) return `${path} is a readable leftover`;
            const why = check(path, dev);
            if (why) return why;
            if (!proofs.some((p) => p.path.startsWith(`${path}/`))) return `${path} is a readable leftover directory`;
          }
          return null;
        };
        const why = check(home, lstatSync(home).dev);
        return why ?? (evidence.size ? "runner proof did not match a root-observed entry" : null);
      },
      acl: listAcl,
      // A seat user's home is that user's; root's marker is root's (the test runs as one user).
      stat: (path) => {
        let st: ReturnType<typeof lstatSync>;
        try { st = lstatSync(path); } catch (err) { if ((err as { code?: string }).code === "ENOENT") return null; throw err; }
        const name = path.split("/").pop() as string;
        const uid = name === SEAT_HOME_MARKER || w.rootOwned.has(path) ? 0
          : path.startsWith(`${homes}/`) && !path.slice(homes.length + 1).includes("/") ? users.get(name)?.uid ?? seatUid(name) : st.uid;
        return { uid, mode: st.mode, dir: st.isDirectory(), file: st.isFile(), symlink: st.isSymbolicLink() };
      },
      vaultStat: (path) => {
        let st: ReturnType<typeof lstatSync>;
        try { st = lstatSync(path); } catch (err) { if ((err as { code?: string }).code === "ENOENT") return null; throw err; }
        const vault = w.vaults.get(path);
        return { uid: vault?.uid ?? st.uid, flags: vault?.flags ?? 0, bytes: st.size, symlink: st.isSymbolicLink() };
      },
      denySchedulers: (name) => {
        for (const f of [schedulerFiles.cron[1], schedulerFiles.at[1]]) {
          const text = existsSync(f) ? readFileSync(f, "utf8") : "";
          if (!text.split("\n").includes(name)) writeFileSync(f, `${text}${name}\n`);
        }
      },
      readSchedulerFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
      procs: (uid) => {
        const name = byUid(uid);
        const marker = name ? markers.get(name) : undefined;
        if (!marker) return [];
        const pids = fakePids(marker);
        if (!pids.length) return [];
        const r = Bun.spawnSync(["ps", "-o", "pid=,stat=", "-p", pids.join(",")], { stdout: "pipe", env: { PATH: "/bin:/usr/bin" } });
        return r.stdout.toString().split("\n").map((l) => /^\s*(\d+)\s+(\S+)/.exec(l)).filter((m): m is RegExpExecArray => !!m && !(m[2] as string).startsWith("Z"))
          .map((m) => ({ pid: Number(m[1]), stat: m[2] as string }));
      },
      signal: (pid, sig) => process.kill(pid, sig),
      stopUserServices: () => (broken.has("services") ? "launchctl bootout failed (broken)" : null),
      removeSchedules: () => (broken.has("schedules") ? "scheduled jobs of it remain (broken)" : null),
      // The REAL runner's sweep, for the fake user (its marker scopes the fake ownership), through runnerOp.
      sweepAsUser: async (name, _uid, roots, residueFolders = []) => {
        if (broken.has("destroy-files")) return { ok: false, left: ["the sweep failed (broken)"] };
        const argv = ["/usr/bin/env", `WALKIE_SEAT_FAKE_UID=${markers.get(name) ?? "none"}`, `WALKIE_SEAT_RUNNER_HOME=${join(homes, name)}`,
          `${SWEEP_ROOTS_ENV}=${JSON.stringify([outside])}`, ...selfRunnerArgv()];
        const r = await runnerOp(argv, residueFolders.length ? "talkie-sweep" : "sweep", 60_000, { roots, residueFolders });
        w.sweeps.push({ name, verified: r?.verified ?? false, left: r?.samples ?? [] });
        return { ok: r?.verified === true, left: r?.verified ? [] : [...(r?.samples ?? []), ...(r?.why ? [r.why] : [])], leftoverDirs: r?.verified ? r.leftoverDirs : [], residuePaths: r?.verified ? r.residuePaths : [], residueProofs: r?.verified ? r.residueProofs : [] };
      },
      dropClaudeProjection: async (name) => {
        if (broken.has("projection")) return false;
        const argv = ["/usr/bin/env", `WALKIE_SEAT_FAKE_UID=${markers.get(name) ?? "none"}`, `WALKIE_SEAT_RUNNER_HOME=${join(homes, name)}`, ...selfRunnerArgv()];
        return (await runnerOp(argv, "drop-claude", 15_000))?.verified === true;
      },
      sleep: (ms) => Bun.sleep(ms),
    },
    admin: async (verb, n) => {
      if (broken.has("admin")) return { ok: false, why: "the helper failed" };
      if (verb === "pending") return pendingSeatUsers(w.sys);
      return verb === "create" ? createSeatUser(n, w.sys) : destroySeatUser(n, w.sys);
    },
    lookup: (name) => {
      if (name === SEATS_GROUP) return { name, uid: -1, gid: SEATS_GID, groups: [name], gids: [SEATS_GID] };
      const u = users.get(name);
      return u ? { name, uid: u.uid, gid: u.gid, groups: [name, SEATS_GROUP], gids: u.gids } : null;
    },
    userSwitch: (user, runner, purpose) => {
      if (w.failing.has(purpose)) return ["/usr/bin/false"];
      const home = join(homes, user);
      const denied = [walkieHome, ...readdirSync(homes).filter((d) => d !== user).map((d) => join(homes, d))]
        .filter((d) => existsSync(d)).map((d) => realpathSync(d));
      const profile = `(version 1)(allow default)${denied.map((d) => `(deny file-read* file-write* (subpath "${d}"))`).join("")}`
        + denied.map((d) => `(deny network-outbound (remote unix-socket (path-regex #"^${d}/")))`).join("");
      return ["/usr/bin/env", `WALKIE_SEAT_RUNNER_HOME=${home}`, `WALKIE_SEAT_FAKE_UID=${markers.get(user) ?? "none"}`,
        ...(canSandbox && purpose === "run" ? [SANDBOX, "-p", profile] : []), ...runner];
    },
  };
  return w;
}

/** The machine's own Codex sign-in, as `codex login` leaves it (a file seat users' runs are handed). */
export const FAKE_CODEX_AUTH_FILE = ('{"auth_mode":"chatgpt","OPENAI_API_KEY":"sk' + '-proj-not-for-seats","tokens":{"access_token":"the-machines-own-codex-login","refresh_token":"the-machines-codex-refresh","account_id":"acct-1"},"last_refresh":"2026-09-26T00:00:00Z"}');
/**
 * What a seat is handed of it: access token and account, never the refresh token or an API key (SEATS-FIX-8), with an
 * EMPTY refresh_token field (codex-cli 0.156.1 refuses the file without it).
 */
export const FAKE_CODEX_AUTH = '{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"access_token":"the-machines-own-codex-login","refresh_token":"","account_id":"acct-1"},"last_refresh":"2026-09-26T00:00:00Z"}';
export function signInCodex(home: string): void {
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "auth.json"), FAKE_CODEX_AUTH_FILE, { mode: 0o600 });
}
