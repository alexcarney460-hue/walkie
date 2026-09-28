// The runner's `sweep` op (SEATS-FIX-6): run by the root helper's destroy AS the seat user, after every process of
// that user was stopped and before its account is deleted. It removes what the user owns under the places any user
// can write outside its home (macOS: /private/tmp, /private/var/tmp, /Users/Shared, /Library/Caches and its own
// per-user folder under /private/var/folders; Linux: /tmp, /var/tmp, /dev/shm, /run/user/<uid>) and empties its home,
// then verifies with the same walk (sweep.ts). Never as root, never as anyone but a seat user (a release build), or in
// a source build only inside a test's fake scope (runner-uid.ts), whose roots and ownership the test sets.
import { userInfo } from "node:os";
import { RELEASE_BUILD } from "../../license/service.ts";
import { SEAT_HOME_MARKER } from "./admin.ts";
import { selfTest } from "./fsat.ts";
import { fakeScope } from "./runner-uid.ts";
import { sweepVerified, type OwnedFn, type SweepRoot } from "./sweep.ts";

/** Tests only (never a release build): the roots a fake seat user's sweep walks, as a JSON array of paths. */
export const SWEEP_ROOTS_ENV = "WALKIE_SEAT_SWEEP_ROOTS";

export interface SweepAnswer { verified: boolean; left: number; removed: number; samples: string[]; notes: string[]; leftoverDirs: string[]; error?: string }

/**
 * Its own per-user folder under /private/var/folders (macOS), from confstr. A failure to tell is a problem, never a
 * folder silently left out (Codex r7 MEDIUM 5, Opus r7 7).
 */
export function darwinUserFolder(
  getconf: () => { exitCode: number | null; stdout: string } = () => {
    const r = Bun.spawnSync(["/usr/bin/getconf", "DARWIN_USER_DIR"], { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin" }, cwd: "/" });
    return { exitCode: r.exitCode, stdout: r.stdout.toString() };
  },
): { folder: string } | { problem: string } {
  const r = getconf();
  const m = /^(\/var\/folders\/[^/\n]+\/[^/\n]+)\/0\/?\n?$/.exec(r.stdout);
  if (r.exitCode === 0 && m) return { folder: `/private${m[1]}` };
  return { problem: `its per-user folder couldn't be found (getconf DARWIN_USER_DIR: exit ${r.exitCode}, ${JSON.stringify(r.stdout.slice(0, 80))})` };
}

/** Roots every seat user's sweep walks, besides those the helper adds (the world-writable ones setup found). */
export function realRoots(home: string, uid: number, extra: readonly string[] = []): { roots: SweepRoot[]; problems: string[] } {
  const more = extra.map((path) => ({ path }));
  if (process.platform === "darwin") {
    const f = darwinUserFolder();
    return {
      roots: [
        { path: "/private/tmp" }, { path: "/private/var/tmp" }, { path: "/Users/Shared" }, { path: "/Library/Caches" }, ...more,
        ...("folder" in f ? [{ path: f.folder, owned: true, sunlnk: true }] : []), { path: home, owned: true },
      ],
      problems: "problem" in f ? [f.problem] : [],
    };
  }
  return { roots: [{ path: "/tmp" }, { path: "/var/tmp" }, { path: "/dev/shm" }, ...more, { path: `/run/user/${uid}`, owned: true }, { path: home, owned: true }], problems: [] };
}

/** The extra roots a sweep request may name: absolute, normalized, at most 64. */
export function validRoots(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 64) return null;
  for (const p of v) if (typeof p !== "string" || !/^\/[^\0]{0,1023}$/.test(p) || p.split("/").some((c) => c === "." || c === "..") || /\/\/|\/$/.test(p)) return null;
  return v as string[];
}

/** A test's fake ownership: entries named after the fake user's marker, and what is inside them, except `other-*`. */
export function fakeOwned(marker: string, uid: number): OwnedFn {
  return (st, name, parentOwned) => {
    if (st.uid !== uid) return false;
    const n = Buffer.from(name).toString("utf8");
    if (n === SEAT_HOME_MARKER || n.startsWith("other-")) return false; // root's marker; another owner's file
    return n.startsWith(`${marker}-`) || parentOwned;
  };
}

export function sweepOp(home: string, env: NodeJS.ProcessEnv = process.env, extraRoots: readonly string[] = []): SweepAnswer {
  const uid = process.getuid?.() ?? -1;
  if (uid === 0) throw new Error("the seat sweep never runs as root");
  const scope = fakeScope(env);
  if (!scope && !RELEASE_BUILD) throw new Error("the seat sweep runs only as a seat user");
  const layout = selfTest();
  if (layout) return { verified: false, left: 0, removed: 0, samples: [], notes: [], leftoverDirs: [], error: layout };
  let roots: SweepRoot[];
  let owned: OwnedFn;
  let problems: string[] = [];
  if (scope) {
    let extra: string[] = [];
    try { extra = JSON.parse(env[SWEEP_ROOTS_ENV] ?? "[]") as string[]; } catch { extra = []; }
    roots = [...[...extra, ...extraRoots].filter((p) => typeof p === "string" && p.startsWith("/")).map((path) => ({ path })), { path: home, owned: true }];
    owned = fakeOwned(scope, uid);
  } else {
    ({ roots, problems } = realRoots(home || userInfo().homedir, uid, extraRoots));
    owned = (st) => st.uid === uid;
  }
  const r = sweepVerified(roots, owned);
  const bad = [...problems, ...r.left, ...r.problems];
  return {
    verified: r.verified && problems.length === 0, left: bad.length, removed: r.removed,
    samples: bad.slice(0, 10), notes: r.notes.slice(0, 10), leftoverDirs: r.leftoverDirs,
  };
}
