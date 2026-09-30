// PRE5-INT (a): `walkie seats doctor` (and the daemon's seats view) tell a stale root-owned runner/helper. `walkie
// update` replaces walkie, never the copies in /usr/local/libexec/walkie, so pre.5's macOS seat-user fix (in the
// helper) isn't there until `walkie seats setup-user --apply` runs again. Read-only: `<copy> version`, no sudo.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { doctorLines } from "../../src/cli/commands/seats-enable.ts";
import { doctorChecks, type DoctorFacts } from "../../src/daemon/seats/doctor.ts";
import {
  HelperVersionCache, UNKNOWN_RETRY_MS, helperVersion, helperVersionAsync, helperVersionProblem, parseVersionLine, realRunVersion, realRunVersionAsync, VERSION_TIMEOUT_MS,
} from "../../src/daemon/seats/helper-version.ts";
import type { SeatsLocalView } from "../../src/protocol/seats.ts";

const RUNNER = "/fake/libexec/walkie/walkie-seat-runner";
const ADMIN = "/fake/libexec/walkie/walkie-seat-admin";
const ok = () => null;
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

describe("helper version", () => {
  test("parses exactly what `walkie version` prints", () => {
    expect(parseVersionLine("walkie 0.2.0-pre.4\n")).toBe("0.2.0-pre.4");
    expect(parseVersionLine("walkie 0.1.3")).toBe("0.1.3");
    expect(parseVersionLine(null)).toBeNull();
    expect(parseVersionLine("walkie: unknown command")).toBeNull();
    expect(parseVersionLine("walkie 0.2.0 extra")).toBeNull();
  });

  test("current, stale (older and newer), unknown", () => {
    const at = (v: Record<string, string | null>) => (p: string) => (v[p] === null ? null : `walkie ${v[p]}\n`);
    const cur = helperVersion([RUNNER, ADMIN], "0.2.0-pre.5", { pathProblem: ok, run: at({ [RUNNER]: "0.2.0-pre.5", [ADMIN]: "0.2.0-pre.5" }) });
    expect(cur.state).toBe("current");
    expect(helperVersionProblem(cur)).toBeNull();

    const old = helperVersion([RUNNER, ADMIN], "0.2.0-pre.5", { pathProblem: ok, run: at({ [RUNNER]: "0.2.0-pre.5", [ADMIN]: "0.2.0-pre.4" }) });
    expect(old.state).toBe("stale");
    expect(helperVersionProblem(old)).toBe("the seat helper is from an older Walkie (walkie-seat-runner 0.2.0-pre.5, walkie-seat-admin 0.2.0-pre.4; this walkie is 0.2.0-pre.5)");

    const newer = helperVersion([RUNNER, ADMIN], "0.2.0-pre.4", { pathProblem: ok, run: at({ [RUNNER]: "0.2.0-pre.5", [ADMIN]: "0.2.0-pre.5" }) });
    expect(newer.state).toBe("stale");
    expect(helperVersionProblem(newer)).toContain("from a newer Walkie");

    // A copy whose output isn't a version, or one that can't be trusted to run, is unknown: never current.
    const silent = helperVersion([RUNNER, ADMIN], "0.2.0-pre.5", { pathProblem: ok, run: at({ [RUNNER]: "0.2.0-pre.5", [ADMIN]: null }) });
    expect(silent.state).toBe("unknown");
    expect(helperVersionProblem(silent)).toContain("the seat helper's version is unknown (walkie-seat-runner 0.2.0-pre.5, walkie-seat-admin unknown");
    let ran = 0;
    const untrusted = helperVersion([RUNNER], "0.2.0-pre.5", { pathProblem: (p) => `${p} is not owned by root (uid 501)`, run: () => { ran++; return "walkie 0.2.0-pre.5"; } });
    expect(untrusted.state).toBe("unknown");
    expect(ran).toBe(0); // never runs a copy that isn't root's
    expect(untrusted.copies[0]!.why).toContain("not owned by root");
  });

  test("the default path check refuses a copy that isn't root's (this test's own file): unknown, not run", () => {
    const d = mkdtempSync("/tmp/walkie-hv-");
    cleanups.push(() => rmSync(d, { recursive: true, force: true }));
    const copy = join(d, "walkie-seat-runner");
    writeFileSync(copy, "#!/bin/sh\necho 'walkie 0.2.0-pre.5'\n");
    chmodSync(copy, 0o755);
    const v = helperVersion([copy], "0.2.0-pre.5", {});
    expect(v.state).toBe("unknown");
    expect(v.copies[0]!.why).toMatch(/not owned by root|is a symlink/);
  });

  test("the real run: `<copy> version` from /, with an empty environment, its stdout only", () => {
    const d = mkdtempSync("/tmp/walkie-hv-");
    cleanups.push(() => rmSync(d, { recursive: true, force: true }));
    const copy = join(d, "walkie");
    writeFileSync(copy, "#!/bin/sh\necho \"walkie 0.2.0-pre.5 [$1] [$(pwd)] [${HOME:-nohome}]\"\necho noise >&2\n");
    chmodSync(copy, 0o755);
    expect(realRunVersion(copy)).toBe("walkie 0.2.0-pre.5 [version] [/] [nohome]\n");
    const failing = join(d, "failing");
    writeFileSync(failing, "#!/bin/sh\necho 'walkie 0.2.0-pre.5'\nexit 3\n");
    chmodSync(failing, 0o755);
    expect(realRunVersion(failing)).toBeNull();
    expect(realRunVersion(join(d, "missing"))).toBeNull();
  });

  test("the daemon's cache: checked in the background (never blocking), again when a copy changes, an unknown one after a minute", async () => {
    let runs = 0;
    let version = "0.2.0-pre.4";
    let mtime = 1;
    let now = 1_000;
    let release: (() => void) | null = null;
    let gate = false;
    const cache = new HelperVersionCache({
      pathProblem: ok,
      runAsync: async () => {
        runs++;
        if (gate) await new Promise<void>((r) => { release = r; });
        return version ? `walkie ${version}` : null;
      },
      stat: () => ({ ino: 7, size: 100, mtimeMs: mtime, ctimeMs: mtime }), now: () => now,
    });
    const peek = () => cache.peek([RUNNER], "0.2.0-pre.5")?.state ?? null;
    expect(peek()).toBeNull(); // the first check runs in the background
    await cache.settled();
    expect(peek()).toBe("stale");
    expect(runs).toBe(1); // cached: no second run
    version = "0.2.0-pre.5";
    mtime = 2; // walkie seats setup-user --apply reinstalled it
    gate = true;
    expect(peek()).toBeNull(); // the old answer isn't shown for the new copy
    expect(peek()).toBeNull();
    expect(runs).toBe(2); // one check in flight, not one per read
    (release as unknown as () => void)();
    await cache.settled();
    gate = false;
    expect(peek()).toBe("current");
    version = "";
    mtime = 3;
    peek();
    await cache.settled();
    expect(peek()).toBe("unknown");
    version = "0.2.0-pre.5";
    now += UNKNOWN_RETRY_MS - 1;
    expect(peek()).toBe("unknown");
    await cache.settled();
    expect(runs).toBe(3);
    now += 1;
    expect(peek()).toBe("unknown"); // the retry started; its answer comes next
    await cache.settled();
    expect(peek()).toBe("current");
    expect(runs).toBe(4);
  });

  test("the async run: `<copy> version` without blocking, its stdout only; a copy that hangs is killed at the timeout", async () => {
    const d = mkdtempSync("/tmp/walkie-hv-");
    cleanups.push(() => rmSync(d, { recursive: true, force: true }));
    const copy = join(d, "walkie");
    writeFileSync(copy, "#!/bin/sh\necho \"walkie 0.2.0-pre.5 [$1] [$(pwd)] [${HOME:-nohome}]\"\necho noise >&2\n");
    chmodSync(copy, 0o755);
    expect(await realRunVersionAsync(copy)).toBe("walkie 0.2.0-pre.5 [version] [/] [nohome]\n");
    expect(await realRunVersionAsync(join(d, "missing"))).toBeNull();
    const clean = join(d, "clean");
    writeFileSync(clean, "#!/bin/sh\necho 'walkie 0.2.0-pre.5'\n");
    chmodSync(clean, 0o755);
    expect((await helperVersionAsync([clean], "0.2.0-pre.5", { pathProblem: ok })).state).toBe("current");
    const hangs = join(d, "hangs");
    writeFileSync(hangs, "#!/bin/sh\nexec sleep 60\n");
    chmodSync(hangs, 0o755);
    const t0 = Date.now();
    expect(await realRunVersionAsync(hangs)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(VERSION_TIMEOUT_MS + 3_000);
  }, 15_000);
});

describe("walkie seats doctor", () => {
  const local = {
    allow: true, launchers: [], runtimes: ["claude", "codex"], max: 3, dir: "~/walkie-seats", channel: "seats-x", channel_ok: true,
    ephemeral: true, same_user: false, readable_home: false, claude_login: "dedicated", codex_login: "machine",
    running: 0, paused: 0, queued: 0, availability: { state: "available" },
  } as SeatsLocalView;
  const facts: DoctorFacts = { team: "aka", release: true, runnerProblem: null, helper: "ok", rootsFile: "ok", runtimes: { claude: "/x/claude", codex: "/x/codex" } };
  const hv = (a: string, want = "0.2.0-pre.5") => helperVersion([RUNNER, ADMIN], want, { pathProblem: ok, run: (p) => (p === ADMIN ? `walkie ${a}` : `walkie ${want}`) });

  test("an ambiguous machine launcher is a warning with a concrete fix", () => {
    const checks = doctorChecks({ ...local, ambiguous_launchers: ["@alex/alex-mbp"] }, facts);
    expect(checks).toContainEqual({ ok: "warn", what: "@alex/alex-mbp matches multiple admitted machines and allows none of them", fix: "rename one machine or use @alex" });
    expect(plain(doctorLines(checks))).toContain("! @alex/alex-mbp matches multiple admitted machines");
  });

  test("a stale helper is a failed check naming the fix; the machine isn't ready", () => {
    const checks = doctorChecks(local, { ...facts, helperVersion: hv("0.2.0-pre.4") });
    const bad = checks.find((k) => k.what.startsWith("the seat helper is from an older Walkie"));
    expect(bad).toEqual({ ok: false, what: expect.stringContaining("walkie-seat-admin 0.2.0-pre.4; this walkie is 0.2.0-pre.5"), fix: "walkie seats setup-user --apply" });
    const text = plain(doctorLines(checks));
    expect(text).toContain("✗ the seat helper is from an older Walkie");
    expect(text).toContain("→ walkie seats setup-user --apply");
    expect(text).toContain("Not ready: fix the item marked ✗.");
  });

  test("current: a passing check; unknown: a warning, never ok", () => {
    const cur = doctorChecks(local, { ...facts, helperVersion: hv("0.2.0-pre.5") });
    expect(cur.find((k) => k.what === "the runner and user helper are this Walkie's (0.2.0-pre.5)")?.ok).toBe(true);
    expect(plain(doctorLines(cur))).toContain("Ready: the team can start Claude and Codex seats on this machine.");
    const unknown = helperVersion([RUNNER, ADMIN], "0.2.0-pre.5", { pathProblem: ok, run: () => null });
    const checks = doctorChecks(local, { ...facts, helperVersion: unknown });
    const k = checks.find((x) => x.what.startsWith("the seat helper's version is unknown"));
    expect(k?.ok).toBe("warn");
    expect(k?.fix).toBe("walkie seats setup-user --apply");
  });

  test("not checked: a source build, seats as the person, or a runner path already failing", () => {
    const stale = hv("0.2.0-pre.4");
    const has = (c: ReturnType<typeof doctorChecks>) => c.some((k) => /seat helper|this Walkie's/.test(k.what));
    expect(has(doctorChecks(local, { ...facts, release: false, helperVersion: stale }))).toBe(false);
    expect(has(doctorChecks({ ...local, ephemeral: false, same_user: true }, { ...facts, helperVersion: stale }))).toBe(false);
    expect(has(doctorChecks(local, { ...facts, runnerProblem: "/usr/local/libexec/walkie doesn't exist", helperVersion: stale }))).toBe(false);
    expect(has(doctorChecks(local, facts))).toBe(false); // older callers without the fact
  });
});
