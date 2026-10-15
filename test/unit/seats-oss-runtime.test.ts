import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { ossArgs, ossEnvironment, ossPolicy, ossSnapshot } from "../../src/daemon/seats/oss.ts";
import { binaryIdentity, boundedOssProbe as nativeBoundedOssProbe, darwinBeforeInventory, darwinInventoryFromPs, darwinProbeDescendantExists, darwinSessionAfterLookup, inspectOssConfig, OssProbeFailure, probeOssRuntime as nativeProbeOssRuntime, requireOssFixture } from "../../src/daemon/seats/oss-runtime.ts";
import type { DarwinProcess, DarwinProbeReaders } from "../../src/daemon/seats/oss-runtime.ts";
import { createWorkerRoot, markWorkerStarting, readWorkerProcess, removeWorkerRoot, workerRootOccupied } from "../../src/daemon/seats/worker-root.ts";
import { codexSeatArgs } from "../../src/daemon/seats/runtime.ts";
import { requiredWorkerAccount, bindWorkerAccount } from "../../src/daemon/seats/enrollment-account.ts";
import type { SeatsConfig } from "../../src/daemon/config.ts";
import type { SeatRunV2 } from "../../src/protocol/seats.ts";

const homes: string[] = [];
const linuxOnly = process.platform === "linux" ? test : test.skip;
const macOnly = process.platform === "darwin" ? test : test.skip;
async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (existsSync(path)) return;
    await Bun.sleep(5);
  }
  throw new Error(`fixture did not create ${path}`);
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "walkie-oss-"))); homes.push(home);
  return { home, root: createWorkerRoot(home, "0123456789abcdef:1", "oss") };
}
const run: SeatRunV2 = { op: "run", v: 2, runtime: "codex", local_provider: "ollama", model: "qwen3:8b", brief: "a".repeat(64), timeout_s: 60, max_concurrent: 1 };
const cfg: SeatsConfig = { allow: true, same_user: true, codex_oss_ollama: true };
const iso = { mode: "same_user" as const, problem: null };
const flags = "--oss --local-provider --model --ignore-user-config --sandbox --json --color --skip-git-repo-check";
const fixtureReaders: DarwinProbeReaders = { inventory: () => new Map(), session: () => null, identity: () => "source-fixture-leader" };
const boundedOssProbe = (binary: string, args: string[], env: Record<string, string>, signal: AbortSignal,
  timeoutMs = 3_000, maxBytes = 32_768) => nativeBoundedOssProbe(binary, args, env, signal, timeoutMs, maxBytes, fixtureReaders);
const probeOssRuntime = (binary: string, env: Record<string, string>, signal: AbortSignal, gate: () => void) =>
  nativeProbeOssRuntime(binary, env, signal, gate, fixtureReaders);
function processRow(pid: number, started: string, changes: Partial<DarwinProcess> = {}): DarwinProcess {
  return { pid, ppid: 1, pgid: pid, sess: pid, uid: process.getuid?.() ?? 0, stat: "S", started, ...changes };
}
function inspectDarwin(before: DarwinProcess[], after: DarwinProcess[], session: (pid: number) => number | null = () => 999,
  current: (pid: number) => string | null = (pid) => after.find((row) => row.pid === pid)?.started ?? null): boolean {
  return darwinProbeDescendantExists(new Map(before.map((row) => [row.pid, row])), 100,
    { inventory: () => new Map(after.map((row) => [row.pid, row])), session, identity: current }, "1000000.123456");
}

test("macOS unknown session custody ignores ESRCH but fails closed on EPERM and other errors", () => {
  const child = processRow(200, "1000001.000001", { sess: 0, pgid: 200 });
  expect(inspectDarwin([], [child], () => null)).toBe(false);
  for (const reason of ["EPERM", "EIO"]) {
    expect(() => inspectDarwin([], [child], () => { throw new Error(reason); })).toThrow(reason);
  }
});

test("macOS process becoming a zombie between inventory and session lookup is inert", () => {
  const child = processRow(200, "1000001.000001", { sess: 100 });
  const zombie = { ...child, stat: "Z" };
  expect(inspectDarwin([], [child], (pid) => darwinSessionAfterLookup(pid, -1, () => zombie))).toBe(false);
  expect(() => darwinSessionAfterLookup(200, -1, () => child)).toThrow("session lookup failed for live process");
});

test("macOS other-UID custody uses ps group and parent, not an unreadable session", () => {
  const child = processRow(200, "ps-identity-unavailable", { pgid: 200, sess: 0, uid: (process.getuid?.() ?? 0) + 1 });
  const readers: DarwinProbeReaders = { inventory: () => new Map([[child.pid, child]]),
    session: () => { throw new Error("foreign session must not be read"); },
    identity: (pid) => pid === 100 ? "1000000.123456" : (() => { throw new Error("foreign identity must not be read"); })() };
  expect(darwinProbeDescendantExists(new Map(), 100, readers, "1000000.123456")).toBe(false);
  const groupReaders = { ...readers, inventory: () => new Map([[child.pid, { ...child, pgid: 100 }]]) };
  expect(darwinProbeDescendantExists(new Map(), 100, groupReaders, "1000000.123456")).toBe(true);
});

test("macOS before inventory prefers exact identity but retains ps identity on lookup failure", () => {
  const own = processRow(200, "ps-identity-unavailable", { psStarted: "same second" });
  const foreign = processRow(300, "ps-identity-unavailable", { psStarted: "same second", uid: own.uid + 1 });
  const before = darwinBeforeInventory({ inventory: () => new Map([[own.pid, own], [foreign.pid, foreign]]),
    session: () => null, identity: (pid) => {
      if (pid !== own.pid) throw new Error("foreign identity must not be read");
      return "1000001.000001";
    } });
  expect(before.get(own.pid)?.started).toBe("1000001.000001");
  expect(before.get(foreign.pid)?.started).toBe("ps-identity-unavailable");
  for (const identity of [() => null, () => { throw new Error("live own-UID identity failure"); }]) {
    expect(darwinBeforeInventory({ inventory: () => new Map([[own.pid, own]]), session: () => null,
      identity }).get(own.pid)).toEqual(own);
  }
});

test("macOS pre-existing identity lookup failures use ps identity for every UID", () => {
  const own = processRow(200, "1000001.000001", { psStarted: "same second" });
  const foreign = processRow(300, "ps-identity-unavailable", { psStarted: "same second", uid: own.uid + 1 });
  for (const row of [own, foreign]) {
    expect(darwinProbeDescendantExists(new Map([[row.pid, row]]), 100, {
      inventory: () => new Map([[row.pid, { ...row }]]),
      session: () => { throw new Error("pre-existing session lookup"); },
      identity: () => { throw new Error("pre-existing libproc lookup failed"); },
    })).toBe(false);
  }
  for (const [old, changed] of [[own, { ...own, uid: foreign.uid }],
    [foreign, { ...foreign, uid: own.uid }]] as const) {
    expect(darwinProbeDescendantExists(new Map([[old.pid, old]]), 100, {
      inventory: () => new Map([[changed.pid, changed]]),
      session: () => { throw new Error("pre-existing session lookup after UID change"); },
      identity: () => { throw new Error("pre-existing identity lookup after UID change"); },
    })).toBe(false);
  }
  const newOwn = processRow(400, "ps-identity-unavailable", { psStarted: "same second" });
  expect(() => darwinProbeDescendantExists(new Map(), 100, {
    inventory: () => new Map([[newOwn.pid, newOwn]]), session: () => 400,
    identity: () => { throw new Error("new same-UID libproc lookup failed"); },
  })).toThrow("new same-UID libproc lookup failed");
});

test("macOS same-UID PID reuse within one ps second is a new child and parent", () => {
  const old = processRow(200, "1000001.000001", { psStarted: "same second" });
  const child = processRow(200, "ps-identity-unavailable", { psStarted: "same second", pgid: 100, sess: 200 });
  expect(inspectDarwin([old], [child], () => 200, () => "1000001.000002")).toBe(true);
  const oldParent = processRow(300, "1000001.000001", { psStarted: "same second" });
  const newParent = processRow(300, "ps-identity-unavailable", { psStarted: "same second", ppid: 100 });
  const grandchild = processRow(400, "ps-identity-unavailable", { ppid: 300, pgid: 400, sess: 400 });
  expect(inspectDarwin([oldParent], [newParent, grandchild], () => 400,
    (pid) => pid === 100 ? "1000000.123456" : pid === 300 ? "1000001.000002" : "1000001.000003")).toBe(true);
});

test("macOS microsecond identity attributes same-second PID reuse precisely", () => {
  const old = processRow(200, "1000001.000001");
  const descendant = processRow(200, "1000001.000002", { pgid: 100, sess: 100 });
  const unrelated = processRow(200, "1000001.000003", { pgid: 200, sess: 200 });
  expect(inspectDarwin([old], [descendant])).toBe(true);
  expect(inspectDarwin([old], [unrelated])).toBe(false);
});

test("macOS live-process identity reader errors hold the probe", () => {
  const child = processRow(200, "1000001.000001");
  expect(() => inspectDarwin([], [child], () => 999, () => { throw new Error("libproc unavailable"); })).toThrow("libproc unavailable");
  expect(() => inspectDarwin([], [child], () => 999, () => "1000001.000002")).toThrow("identity changed");
});

test("macOS ancestry requires the recorded parent identity", () => {
  const parent = processRow(300, "1000001.000001", { ppid: 100 });
  const child = processRow(400, "1000001.000002", { ppid: 300 });
  expect(inspectDarwin([], [parent, child], () => 999,
    (pid) => pid === 100 ? "1000000.123456" : [parent, child].find((row) => row.pid === pid)?.started ?? null)).toBe(true);
  expect(() => inspectDarwin([], [parent, child], () => 999,
    (pid) => pid === 300 ? "1000001.000003" : pid === 100 ? "1000000.123456" : child.started)).toThrow("identity");
});

test("macOS ancestry ends at an exact same-UID process already present before the probe", () => {
  const old = processRow(300, "old-parent", { ppid: 100 });
  const child = processRow(400, "new-child", { ppid: 300, pgid: 400, sess: 400 });
  expect(darwinProbeDescendantExists(new Map([[old.pid, old]]), 100, {
    inventory: () => new Map([[old.pid, old], [child.pid, child]]),
    session: () => 400,
    identity: (pid) => {
      if (pid === old.pid) return old.started;
      return pid === child.pid ? child.started : "1000000.123456";
    },
  }, "1000000.123456")).toBe(false);
});

test("macOS attributes an unreadable other-UID child through the recorded probe parent", () => {
  const child = processRow(400, "ps-identity-unavailable", { ppid: 100, pgid: 400, sess: 0,
    uid: (process.getuid?.() ?? 0) + 1 });
  expect(darwinProbeDescendantExists(new Map(), 100, {
    inventory: () => new Map([[child.pid, child]]),
    session: () => { throw new Error("foreign session must come from ps"); },
    identity: (pid) => {
      if (pid === child.pid) throw new Error("libproc denied another UID");
      return "1000000.123456";
    },
  }, "1000000.123456")).toBe(true);
});

test("macOS custody outcome table fails closed for every live unknown", () => {
  const unavailable = "ps-identity-unavailable";
  const child = processRow(200, "1000001.000001", { ppid: 1, pgid: 200, sess: 999 });
  const probe = processRow(100, "1000000.123456", { pgid: 900, sess: 900 });
  const cases: Array<{ name: string; after: DarwinProcess[]; session?: (pid: number) => number | null;
    identity?: (pid: number) => string | null; verdict: "absent" | "present" | "hold" }> = [
    { name: "gone at identity lookup", after: [child], identity: () => null, verdict: "absent" },
    { name: "zombie in inventory", after: [{ ...child, stat: "Z" }], verdict: "absent" },
    { name: "zombie after session lookup", after: [child], session: () => null, verdict: "absent" },
    ...["EPERM", "EIO", "libproc unavailable"].map((error) => ({
      name: `live identity lookup ${error}`, after: [child],
      identity: () => { throw new Error(error); }, verdict: "hold" as const,
    })),
    { name: "live session lookup EPERM", after: [child], session: () => { throw new Error("EPERM"); }, verdict: "hold" },
    { name: "identity mismatch", after: [child], identity: () => "1000001.000002", verdict: "hold" },
    { name: "same UID ps-only lookup failure", after: [{ ...child, started: unavailable }],
      identity: () => { throw new Error("libproc failed for live same-UID process"); }, verdict: "hold" },
    { name: "other UID ps-only unrelated", after: [{ ...child, uid: child.uid + 1, started: unavailable }],
      identity: () => { throw new Error("libproc denied another UID"); }, verdict: "absent" },
    { name: "other UID ps-only group member", after: [{ ...child, uid: child.uid + 1, started: unavailable, pgid: 100 }],
      identity: () => { throw new Error("libproc denied another UID"); }, verdict: "present" },
    { name: "other UID readable session match", after: [{ ...child, uid: child.uid + 1, started: unavailable, sess: 100 }],
      identity: () => { throw new Error("foreign identity must not be read"); }, verdict: "present" },
    { name: "ps-only live lookup returns unknown", after: [{ ...child, started: unavailable }],
      identity: () => unavailable, verdict: "hold" },
    { name: "ps-only gone at lookup", after: [{ ...child, started: unavailable }], identity: () => null, verdict: "absent" },
    { name: "reused probe PID cannot establish precise ancestry", after: [{ ...probe, started: "new-probe" },
      { ...child, ppid: 100 }], verdict: "absent" },
    { name: "reused probe PID with ps-only child is unknown", after: [{ ...probe, started: "new-probe" },
      { ...child, ppid: 100, started: unavailable }], verdict: "hold" },
    { name: "reused probe PID still permits group attribution", after: [{ ...probe, started: "new-probe" },
      { ...child, ppid: 100, pgid: 100 }], verdict: "present" },
  ];
  for (const row of cases) {
    const inspect = () => inspectDarwin([], row.after, row.session, row.identity);
    if (row.verdict === "hold") expect(inspect, row.name).toThrow();
    else expect(inspect(), row.name).toBe(row.verdict === "present");
  }
});

test("macOS inventory uses ps fields and records exact same-UID pre-existing identities", () => {
  const uid = process.getuid?.() ?? 501;
  const started = "Sun Oct  4 11:13:19 2026";
  const lines = (stat: string, rowUid = uid) => `200 1 200 200 ${rowUid} ${stat} ${started}\n`;
  for (const rowUid of [uid, uid + 1]) {
    expect(darwinInventoryFromPs(lines("S", rowUid)).get(200)).toMatchObject({ pid: 200, ppid: 1, pgid: 200,
      sess: 200, uid: rowUid, started: "ps-identity-unavailable", psStarted: started });
    expect(darwinInventoryFromPs(lines("Z", rowUid)).size).toBe(0);
  }
  expect(() => darwinInventoryFromPs("malformed\n")).toThrow("inventory failed");
  const old = darwinBeforeInventory({
    inventory: () => darwinInventoryFromPs(lines("S")), session: () => null,
    identity: () => "1000001.000001",
  });
  expect(darwinProbeDescendantExists(old, 100, {
    inventory: () => darwinInventoryFromPs(lines("S")),
    session: () => { throw new Error("pre-existing session lookup"); },
    identity: () => "1000001.000001",
  })).toBe(false);
});

test("macOS ignores a new ps row only when its PID has exited or been reused", () => {
  const row = { ...processRow(200, "ps-identity-unavailable"), psStarted: "first" };
  let reads = 0;
  expect(darwinProbeDescendantExists(new Map(), 100, {
    inventory: () => ++reads === 1 ? new Map([[row.pid, row]]) : new Map([[row.pid, { ...row, psStarted: "second" }]]),
    session: () => { throw new Error("stale row must not reach session lookup"); },
    identity: () => { throw new OssProbeFailure("OSS probe libproc process lookup failed for live process 200"); },
  })).toBe(false);
  expect(reads).toBe(2);
});
function binary(home: string, body = `if [ "$1" = --version ]; then echo 'codex-cli 0.160.0'; else echo '${flags}'; fi`) {
  const file = join(home, "fake-codex"); writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o700 }); return file;
}

test("host matrix requires separate consent and explicit same-user, with no enrollment exemption", () => {
  expect(ossPolicy(run, cfg, iso)).toBeNull();
  for (const change of [{ codex_oss_ollama: false }, { same_user: false }, { same_user: undefined }, { ephemeral: true },
    { mode: "seat_users" as const }, { allow: false }, { inherit_person_config: true }, { tools: { allow: [] } }])
    expect(ossPolicy(run, { ...cfg, ...change }, iso)).not.toBeNull();
  for (const mode of ["none", "ephemeral"] as const) expect(ossPolicy(run, cfg, { mode, problem: null })).not.toBeNull();
  expect(requiredWorkerAccount(null, run, Date.now(), false)).toBeNull();
  expect(requiredWorkerAccount(null, run, Date.now(), true)).toContain("enrollment");
  const grant = { worker_accounts: { codex: `alex:${"a".repeat(24)}` } } as never;
  expect(requiredWorkerAccount(grant, run, Date.now(), true)).toContain("enrollment");
  expect(bindWorkerAccount(grant, run)).toEqual(run);
});

test("finite clean env and exclusively created empty roots contain no provider config/auth or symlinks", () => {
  const { root, home } = fixture();
  const env = ossEnvironment(root, "/usr/bin:/bin");
  expect(Object.keys(env).sort()).toEqual(["PATH", "LANG", "LC_ALL", "TERM", "HOME", "CODEX_HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"].sort());
  for (const name of readdirSync(root.root)) {
    const path = join(root.root, name);
    expect(lstatSync(path).mode & 0o777).toBe(0o700);
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readdirSync(path)).toEqual([]);
  }
  expect(existsSync(join(root.codex, "auth.json"))).toBe(false);
  expect(() => ossEnvironment(root, "relative:/bin")).toThrow();
  expect(() => ossEnvironment(root, ":/bin")).toThrow();
  const second = createWorkerRoot(home, "0123456789abcdef:1", "oss");
  expect(second.root).not.toBe(root.root);
  markWorkerStarting(home, root.key);
  expect(readWorkerProcess(home, root.key)).toEqual({ uncertain: true });
  removeWorkerRoot(home, root.key);
  expect(existsSync(second.root)).toBe(true);
});

test("symlinked root parent refuses without touching the destination", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "walkie-oss-link-"))); homes.push(home);
  const external = join(home, "external"); mkdirSync(external);
  symlinkSync(external, join(home, ".walkie-workers"));
  expect(() => createWorkerRoot(home, "0123456789abcdef:1", "oss")).toThrow();
  expect(readdirSync(external)).toEqual([]);
});

test("local argv retains all three sandbox modes and never changes authenticated argv", () => {
  for (const mode of ["default", "acceptEdits", "bypassPermissions"] as const) {
    const base = codexSeatArgs({ cwd: "/work", mode, model: run.model });
    const args = ossArgs("/work", mode, run.model!);
    expect(args.slice(0, base.length - 1)).toEqual(base.slice(0, -1));
    expect(args.slice(base.length - 1)).toEqual(["--oss", "--local-provider", "ollama", "--ignore-user-config", "-c", 'cli_auth_credentials_store="file"', "-"]);
    expect(args).not.toContain("--ignore-rules");
    expect(base).not.toContain("--oss");
  }
});

test("system, ancestor, project, linked common-dir configuration and symlinks refuse", () => {
  const { home } = fixture(); const work = join(home, "repo", "nested"); mkdirSync(work, { recursive: true });
  const system = join(home, "managed");
  const inspect = () => inspectOssConfig(work, [system], { metadata: (p) => {
    if (!p.startsWith(home + "/") && p !== home) return null;
    try { return lstatSync(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }, readText: (p) => readFileSync(p, "utf8") });
  inspect();
  writeFileSync(system, "policy"); expect(() => inspect()).toThrow(); rmSync(system);
  for (const p of [join(work, ".codex"), join(home, ".codex"), join(home, "repo", ".codex")]) {
    mkdirSync(p); expect(() => inspect()).toThrow(); rmSync(p, { recursive: true });
  }
  const common = join(home, "common"); mkdirSync(common); mkdirSync(join(common, ".codex"));
  const gitdir = join(home, "metadata"); mkdirSync(gitdir);
  writeFileSync(join(work, ".git"), `gitdir: ${gitdir}\n`); writeFileSync(join(gitdir, "commondir"), "../common\n");
  expect(() => inspect()).toThrow(); rmSync(join(common, ".codex"), { recursive: true });
  symlinkSync(common, join(work, ".codex")); expect(() => inspect()).toThrow();
});

test("exact fake version/help accepted only as source evidence, identity replacement invalidates cache", async () => {
  const { root, home } = fixture(); const env = ossEnvironment(root, "/usr/bin:/bin"); const bin = binary(home);
  const signal = new AbortController().signal; let checks = 0;
  const identity = await probeOssRuntime(bin, env, signal, () => { checks++; });
  expect(identity).toBe(binaryIdentity(bin)); expect(checks).toBeGreaterThan(2);
  binary(home, "echo codex-cli 0.161.0"); expect(binaryIdentity(bin)).not.toBe(identity);
  await expect(probeOssRuntime(bin, env, signal, () => {})).rejects.toThrow("version");
  binary(home, "if [ \"$1\" = --version ]; then echo 'codex-cli 0.160.0'; else echo --oss; fi");
  await expect(probeOssRuntime(bin, env, signal, () => {})).rejects.toThrow("flags");
  expect(() => requireOssFixture()).toThrow("UNVERIFIED");
  expect(ossSnapshot(cfg)).toMatchObject({ native: "UNVERIFIED", ready: false, service: "unknown", resources: "unknown" });
}, 15_000);

test("probe timeout, flood, cancellation, policy change and binary replacement fail closed", async () => {
  const { root, home } = fixture(); const env = ossEnvironment(root, "/usr/bin:/bin"); const signal = new AbortController().signal;
  await expect(boundedOssProbe(binary(home, "sleep 30"), ["--version"], env, signal, 30)).rejects.toThrow("timed out");
  await expect(boundedOssProbe(binary(home, "while :; do echo flooding-output; done"), ["--version"], env, signal, 1000, 128)).rejects.toThrow("bound");
  const controller = new AbortController(); controller.abort();
  await expect(boundedOssProbe(binary(home), ["--version"], env, controller.signal)).rejects.toThrow("cancelled");
  let checks = 0;
  await expect(probeOssRuntime(binary(home), env, signal, () => { if (++checks > 1) throw new Error("policy revoked"); })).rejects.toThrow("policy revoked");
  checks = 0;
  await expect(probeOssRuntime(binary(home), env, signal, () => { if (++checks > 1) binary(home, "echo replaced"); })).rejects.toThrow("replaced");
});

macOnly("unrelated launchd-adopted processes do not invalidate a probe, repeatedly", async () => {
  const { root, home } = fixture(), env = ossEnvironment(root, "/usr/bin:/bin");
  const bin = binary(home, `: > "${home}/ready"
while [ ! -f "${home}/release" ]; do sleep 0.01; done
printf 'codex-cli 0.160.0\\n'`);
  for (let i = 0; i < 20; i++) {
    rmSync(join(home, "ready"), { force: true });
    rmSync(join(home, "release"), { force: true });
    const marker = join(home, `unrelated-${i}`);
    const controller = new AbortController();
    const probe = boundedOssProbe(bin, [], env, controller.signal).then(
      (result) => ({ result }), (error) => ({ error }),
    );
    try {
      await waitForFile(join(home, "ready"));
      // Two forks leave a live, unrelated same-user process under launchd.
      const fork = spawnSync("/usr/bin/python3", ["-c", `import os, time
p = os.fork()
if p:
 os.waitpid(p, 0)
else:
 p = os.fork()
 if p: os._exit(0)
 while os.getppid() != 1: time.sleep(0.001)
 open(${JSON.stringify(marker)}, 'w').write(str(os.getpid()))
 time.sleep(2)
`], { stdio: "ignore" });
      expect(fork.status).toBe(0);
      await waitForFile(marker);
      writeFileSync(join(home, "release"), "go");
      expect(await probe).toEqual({ result: "codex-cli 0.160.0\n" });
    } finally {
      controller.abort();
      await probe;
    }
  }
}, 60_000);

macOnly("probe child in a new group but the probe session remains attributable", async () => {
  const { root, home } = fixture(), env = ossEnvironment(root, "/usr/bin:/bin");
  const script = join(home, "session-child.py"), holder = join(home, "session-holder.py"), marker = join(home, "session-child");
  writeFileSync(holder, `import os, time
open(${JSON.stringify(marker)}, 'w').write(f'{os.getpid()} {os.getpgrp()} {os.getsid(0)}')
time.sleep(2)
`);
  writeFileSync(script, `import os, time
p = os.fork()
if p:
 while not os.path.exists(${JSON.stringify(marker)}): time.sleep(0.001)
 print('codex-cli 0.160.0')
else:
 os.setpgid(0, 0)
 os.chdir('/')
 fd = os.open('/dev/null', os.O_RDWR)
 for n in (0, 1, 2): os.dup2(fd, n)
 os.execve('/usr/bin/python3', ['/usr/bin/python3', ${JSON.stringify(holder)}], {})
`);
  const bin = binary(home, `exec /usr/bin/python3 "${script}"`);
  const readers: DarwinProbeReaders = { ...fixtureReaders, inventory: () => {
    if (!existsSync(marker)) return new Map();
    const [pid, pgid, sess] = readFileSync(marker, "utf8").split(" ").map(Number);
    return new Map([[pid!, processRow(pid!, "source-fixture-child", { pgid, sess })]]);
  }, session: () => Number(readFileSync(marker, "utf8").split(" ")[2]),
  identity: (pid) => existsSync(marker) && pid === Number(readFileSync(marker, "utf8").split(" ")[0]) ?
    "source-fixture-child" : "source-fixture-leader" };
  const outcome = await nativeBoundedOssProbe(bin, [], env, new AbortController().signal, 3_000, 32_768, readers).catch((error) => error);
  const [pid, pgid, sess] = readFileSync(marker, "utf8").split(" ").map(Number);
  expect(pgid).toBe(pid);
  expect(sess).not.toBe(pid);
  expect(workerRootOccupied(dirname(env.HOME!))).toBe(false);
  expect(outcome).toBeInstanceOf(OssProbeFailure);
  expect((outcome as OssProbeFailure).message).toContain("descendant cleanup failed");
});

macOnly("probe group child outliving its parent fails custody", async () => {
  const { root, home } = fixture(), env = ossEnvironment(root, "/usr/bin:/bin");
  const script = join(home, "group-child.py"), holder = join(home, "group-holder.py"), marker = join(home, "group-child");
  writeFileSync(holder, `import os, time
open(${JSON.stringify(marker)}, 'w').write(f'{os.getpid()} {os.getpgrp()} {os.getsid(0)}')
time.sleep(2)
`);
  writeFileSync(script, `import os, time
p = os.fork()
if p:
 while not os.path.exists(${JSON.stringify(marker)}): time.sleep(0.001)
 print('codex-cli 0.160.0')
else:
 os.chdir('/')
 fd = os.open('/dev/null', os.O_RDWR)
 for n in (0, 1, 2): os.dup2(fd, n)
 os.execve('/usr/bin/python3', ['/usr/bin/python3', ${JSON.stringify(holder)}], {})
`);
  const bin = binary(home, `exec /usr/bin/python3 "${script}"`);
  const outcome = await boundedOssProbe(bin, [], env, new AbortController().signal).catch((error) => error);
  const [pid, pgid, sess] = readFileSync(marker, "utf8").split(" ").map(Number);
  expect(pid).not.toBe(pgid);
  expect(pgid).toBe(sess);
  expect(workerRootOccupied(dirname(env.HOME!))).toBe(false);
  expect(outcome).toBeInstanceOf(OssProbeFailure);
});

macOnly("real macOS readers accept harmless native probes ten times", async () => {
  const { root } = fixture(), env = ossEnvironment(root, "/usr/bin:/bin");
  for (let i = 0; i < 10; i++) {
    expect(await nativeBoundedOssProbe("/bin/echo", ["native-ok"], env, new AbortController().signal)).toBe("native-ok\n");
  }
}, 60_000);

macOnly("real macOS readers reject a surviving group child ten times", async () => {
  const { root, home } = fixture(), env = ossEnvironment(root, "/usr/bin:/bin");
  const script = join(home, "native-group-child.py"), marker = join(home, "native-group-child");
  writeFileSync(script, `import os, time
p = os.fork()
if p:
 while not os.path.exists(${JSON.stringify(marker)}): time.sleep(0.001)
 print('native-parent-ok')
else:
 os.chdir('/')
 fd = os.open('/dev/null', os.O_RDWR)
 for n in (0, 1, 2): os.dup2(fd, n)
 open(${JSON.stringify(marker)}, 'w').write(str(os.getpid()))
 time.sleep(1)
`);
  for (let i = 0; i < 10; i++) {
    rmSync(marker, { force: true });
    const outcome = await nativeBoundedOssProbe("/usr/bin/python3", [script], env, new AbortController().signal).catch((error) => error);
    expect(existsSync(marker)).toBe(true);
    expect(outcome).toBeInstanceOf(OssProbeFailure);
    expect((outcome as OssProbeFailure).message).toMatch(/(?:group|descendant) cleanup failed/);
    await Bun.sleep(1_000);
  }
}, 60_000);


test("inspection errors and unknown config knowledge remain held", () => {
  expect(() => inspectOssConfig("/synthetic/work", ["/synthetic/system"], {
    metadata: () => { throw new Error("unreadable managed policy"); }, readText: () => { throw new Error("must not read credentials"); },
  })).toThrow("unreadable");
  expect(() => requireOssFixture({ evidence: "fake-runtime-only", configKnowledge: "unknown" } as never)).toThrow("UNVERIFIED");
});

// Linux-only adversarial fixtures: setsid escapes the probe group while retaining its pipes.
function startIdentity(pid: number): string | undefined {
  try { const raw = readFileSync(`/proc/${pid}/stat`, "utf8"); return raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19]; }
  catch { return undefined; }
}
function reapFixture(marker: string): void {
  if (!existsSync(marker)) return;
  const raw = readFileSync(marker, "utf8"), pid = Number(raw.slice(0, raw.indexOf(" ")));
  const start = raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19];
  const current = startIdentity(pid);
  if (current === start) process.kill(pid, "SIGKILL"); // only this synthetic holder's PID/start identity
  console.log(JSON.stringify({ owned_pipe_holder: { pid, start }, signalled: current === start }));
}
linuxOnly("successful probe accounts for a detached-stdio descendant in its process group (Linux /proc identity)", async () => {
  const { root, home } = fixture(), marker = join(home, "group-holder");
  const env = ossEnvironment(root, "/usr/bin:/bin");
  const bin = binary(home, `/bin/sh -c 'cat /proc/$$/stat > "${marker}"; exec /bin/sleep 5' </dev/null >/dev/null 2>&1 &
while [ ! -s "${marker}" ]; do sleep 0.01; done
printf 'codex-cli 0.160.0\\n'`);
  try {
    const result = await boundedOssProbe(bin, ["--version"], env, new AbortController().signal).catch((error) => error);
    const raw = readFileSync(marker, "utf8"), pid = Number(raw.slice(0, raw.indexOf(" ")));
    const start = raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19];
    const current = startIdentity(pid);
    const stat = current === start ? readFileSync(`/proc/${pid}/stat`, "utf8") : "";
    const state = stat ? stat.slice(stat.lastIndexOf(")") + 2)[0] : undefined;
    console.log(JSON.stringify({ result: result instanceof Error ? result.message : result, descendant_state: state }));
    expect(state === undefined || state === "Z" || result instanceof OssProbeFailure).toBe(true);
    if (result instanceof OssProbeFailure) expect(result.cleanupUncertain).toBe(true);
  } finally { reapFixture(marker); }
});
linuxOnly("successful probe keeps custody when a detached descendant escapes its group (Linux setsid and /proc)", async () => {
  const { root, home } = fixture(), marker = join(home, "escaped-holder");
  const env = ossEnvironment(root, "/usr/bin:/bin");
  const bin = binary(home, `/usr/bin/setsid /bin/sh -c 'cat /proc/$$/stat > "${marker}"; exec /bin/sleep 5' </dev/null >/dev/null 2>&1 &
while [ ! -s "${marker}" ]; do sleep 0.01; done
printf 'codex-cli 0.160.0\\n'`);
  try {
    const result = await boundedOssProbe(bin, ["--version"], env, new AbortController().signal).catch((error) => error);
    const raw = readFileSync(marker, "utf8"), pid = Number(raw.slice(0, raw.indexOf(" ")));
    const start = raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19];
    expect(startIdentity(pid)).toBe(start);
    expect(result).toBeInstanceOf(OssProbeFailure);
    expect((result as OssProbeFailure).cleanupUncertain).toBe(true);
  } finally { reapFixture(marker); }
});
linuxOnly("clean-environment detached probe child keeps custody (Linux /proc environment and cwd)", async () => {
  const { root, home } = fixture(), marker = join(home, "clean-escaped-holder");
  const env = ossEnvironment(root, "/usr/bin:/bin");
  const bin = join(home, "clean-probe");
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const child = require('node:child_process').spawn('/bin/sleep', ['5'], { detached: true, env: {}, cwd: '/', stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(marker)}, fs.readFileSync('/proc/' + child.pid + '/stat'));
child.unref();
console.log('codex-cli 0.160.0');
`, { mode: 0o700 });
  try {
    const result = await boundedOssProbe(bin, ["--version"], env, new AbortController().signal).catch((error) => error);
    const raw = readFileSync(marker, "utf8"), pid = Number(raw.slice(0, raw.indexOf(" ")));
    console.log(JSON.stringify({ result: result instanceof Error ? result.message : result, child_env_bytes: readFileSync(`/proc/${pid}/environ`).length }));
    expect(startIdentity(pid)).toBe(raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19]);
    expect(readFileSync(`/proc/${pid}/environ`).length).toBe(0);
    expect(readlinkSync(`/proc/${pid}/cwd`)).toBe("/");
    expect(result).toBeInstanceOf(OssProbeFailure);
  } finally { reapFixture(marker); }
});
for (const cause of ["timeout", "abort", "flood"] as const) linuxOnly(`escaped probe pipes cannot delay ${cause}; cleanup remains uncertain (Linux setsid and /proc)`, async () => {
  const { root, home } = fixture(), marker = join(home, "holder");
  const env = ossEnvironment(root, "/usr/bin:/bin"), controller = new AbortController();
  const bin = binary(home, `/usr/bin/setsid /bin/sh -c 'cat /proc/$$/stat > "${marker}"; exec /bin/sleep 2' &
while [ ! -s "${marker}" ]; do sleep 0.01; done
${cause === "flood" ? "printf 0123456789; printf abcdefghij >&2" : "printf partial"}
exit 0`);
  const aborter = cause === "abort" ? setInterval(() => { if (existsSync(marker) && readFileSync(marker, "utf8")) controller.abort(); }, 5) : null;
  const at = performance.now();
  try {
    const error = await boundedOssProbe(bin, [], env, controller.signal, 80, cause === "flood" ? 16 : 128).catch((e) => e);
    const elapsed = performance.now() - at;
    console.log(JSON.stringify({ cause, elapsed_ms: elapsed, message: error.message }));
    expect(error.message).toContain(cause === "timeout" ? "timed out" : cause === "abort" ? "cancelled" : "bound");
    expect(elapsed).toBeLessThan(500);
    expect(error.cleanupUncertain).toBe(true);
    expect(readFileSync(marker, "utf8")).not.toBe("");
  } finally { if (aborter) clearInterval(aborter); reapFixture(marker); }
});

test("completed probe preserves exact UTF-8 output", async () => {
  const { root, home } = fixture(), env = ossEnvironment(root, "/usr/bin:/bin");
  expect(await boundedOssProbe(binary(home, "printf '\\342'; sleep 0.02; printf '\\202\\254 done\\n'"), [], env, new AbortController().signal)).toBe("€ done\n");
});
linuxOnly("failed proof is never cached (Linux setsid and /proc holder)", async () => {
  const { root, home } = fixture(), env = ossEnvironment(root, "/usr/bin:/bin");
  const marker = join(home, "holder"), counted = join(home, "count");
  const bin = binary(home, `echo "$1" >> "${counted}"
if [ "$1" = --version ]; then
 echo 'codex-cli 0.160.0'
 if [ ! -f "${marker}" ]; then
  /usr/bin/setsid /bin/sh -c 'cat /proc/$$/stat > "${marker}"; exec /bin/sleep 2' &
  while [ ! -s "${marker}" ]; do sleep 0.01; done
 fi
else echo '${flags}'; fi`);
  const controller = new AbortController();
  const timer = setInterval(() => { if (existsSync(marker) && readFileSync(marker, "utf8")) controller.abort(); }, 5);
  try { await expect(probeOssRuntime(bin, env, controller.signal, () => {})).rejects.toThrow("cancelled"); }
  finally { clearInterval(timer); reapFixture(marker); }
  const signal = new AbortController().signal;
  await probeOssRuntime(bin, env, signal, () => {});
  const calls = readFileSync(counted, "utf8");
  expect(calls).toBe("--version\n--version\nexec\n");
  await probeOssRuntime(bin, env, signal, () => {});
  expect(readFileSync(counted, "utf8")).toBe(calls);
});


test("probe decodes split UTF-8 independently across stdout and stderr with one shared byte cap", async () => {
  const { root, home } = fixture(), env = ossEnvironment(root, "/usr/bin:/bin");
  const bin = binary(home, "printf '\\342'; sleep 0.02; printf 'stderr\\n' >&2; sleep 0.02; printf '\\202\\254 stdout\\n'");
  const output = await boundedOssProbe(bin, [], env, new AbortController().signal, 500);
  expect(output).toContain("€ stdout\n"); expect(output).toContain("stderr\n"); expect(output).not.toContain("�");
  const reverse = binary(home, "printf '\\342' >&2; sleep 0.02; printf 'stdout\\n'; sleep 0.02; printf '\\202\\254 stderr\\n' >&2");
  const other = await boundedOssProbe(reverse, [], env, new AbortController().signal, 500);
  expect(other).toContain("€ stderr\n"); expect(other).toContain("stdout\n"); expect(other).not.toContain("�");
  await expect(boundedOssProbe(reverse, [], env, new AbortController().signal, 500, 10)).rejects.toThrow("bound");
  expect(await boundedOssProbe(binary(home, "printf 'plain exact\\n'; printf 'error exact\\n' >&2"), [], env, new AbortController().signal)).toBe("plain exact\nerror exact\n");
});
