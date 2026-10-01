// WALK-67 lane 8, Linux and WSL: scripts/enroll-ssh-linux.sh runs INSIDE the enrollment's one root batch, after the
// consent and before Ready, with no second sudo prompt. Every system command is a stub: no real sudo, sshd, apt or
// systemctl, and nothing in the person's home.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rootMarkerHelper, type RootHelperDeps } from "../../src/cli/commands/provision.ts";
import { describeRootBatch, planRootBatch, realRootBatch, runAdministratorStep, runRootBatchSync, shellQuote, SSH_INSTALL_EXIT, type RootBatchDeps, type RootBatchResult } from "../../src/cli/root-batch.ts";
import { runSshLinuxScript, SSH_LINUX_SCRIPT, type SshLinuxIo } from "../../src/daemon/ssh/enroll-linux.ts";
import { systemEnrollmentRoot } from "../../src/daemon/provision/root-marker.ts";

const HOME = "/home/arvid/.walkie";
const ARGV = ["/home/arvid/.local/bin/walkie"];

describe("what the one batch has to do", () => {
  const need = (marker: boolean, sshLinux: boolean, sshMacos: boolean) => ({ marker, sshLinux, sshMacos });
  test("nothing when the marker is there and no SSH service is needed: no sudo is run at all", () => {
    expect(planRootBatch({ markerPresent: true, carriesSsh: false, platform: "linux", serverAnswers: false })).toEqual(need(false, false, false));
    expect(planRootBatch({ markerPresent: true, carriesSsh: true, platform: "linux", serverAnswers: true })).toEqual(need(false, false, false));
    expect(planRootBatch({ markerPresent: true, carriesSsh: true, platform: "darwin", serverAnswers: true })).toEqual(need(false, false, false));
    const spawned: string[][] = [];
    const spawn = ((argv: string[]) => { spawned.push(argv); return { exitCode: 0 }; }) as unknown as typeof Bun.spawnSync;
    expect(runRootBatchSync(HOME, need(false, false, false), spawn, ARGV)).toEqual({ marker: true, ssh: "skipped" });
    expect(spawned).toEqual([]);
  });
  test("the marker, and on Linux the SSH service, only when the link carries a packet and no SSH server answers", () => {
    expect(planRootBatch({ markerPresent: false, carriesSsh: true, platform: "linux", serverAnswers: false })).toEqual(need(true, true, false));
    expect(planRootBatch({ markerPresent: false, carriesSsh: true, platform: "linux", serverAnswers: true })).toEqual(need(true, false, false));
    expect(planRootBatch({ markerPresent: false, carriesSsh: false, platform: "linux", serverAnswers: false })).toEqual(need(true, false, false));
    expect(planRootBatch({ markerPresent: true, carriesSsh: true, platform: "linux", serverAnswers: false })).toEqual(need(false, true, false));
  });
  test("macOS gets Walkie's own SSH service from the same batch (never Remote Login), by the same rule", () => {
    expect(planRootBatch({ markerPresent: false, carriesSsh: true, platform: "darwin", serverAnswers: false })).toEqual(need(true, false, true));
    expect(planRootBatch({ markerPresent: true, carriesSsh: true, platform: "darwin", serverAnswers: false })).toEqual(need(false, false, true));
    expect(planRootBatch({ markerPresent: false, carriesSsh: true, platform: "darwin", serverAnswers: true })).toEqual(need(true, false, false));
    expect(planRootBatch({ markerPresent: false, carriesSsh: false, platform: "darwin", serverAnswers: false })).toEqual(need(true, false, false));
  });
  test("what the person is told before the prompt names each thing the one sudo will do", () => {
    expect(describeRootBatch(need(true, true, false))).toBe("the root-owned company-machine marker, then Walkie's SSH service for the owner's key (it listens only on this machine and accepts only key logins)");
    expect(describeRootBatch(need(true, false, false))).toBe("the root-owned company-machine marker");
    expect(describeRootBatch(need(false, true, false))).toBe("Walkie's SSH service for the owner's key (it listens only on this machine and accepts only key logins)");
    expect(describeRootBatch(need(true, false, true))).toBe("the root-owned company-machine marker, then Walkie's SSH service for the owner's key (it listens only on this Mac and accepts only key logins; Remote Login is not used)");
  });
});

describe("one sudo", () => {
  const need = (marker: boolean, sshLinux: boolean, sshMacos: boolean) => ({ marker, sshLinux, sshMacos });
  test("a single sudo of this walkie runs the marker and the SSH service together, on Linux and on macOS", () => {
    for (const [kind, n] of [["ssh-linux", need(true, true, false)], ["ssh-macos", need(true, false, true)]] as const) {
      const spawned: { argv: string[]; opts: unknown }[] = [];
      const spawn = ((argv: string[], opts: unknown) => { spawned.push({ argv, opts }); return { exitCode: 0 }; }) as unknown as typeof Bun.spawnSync;
      const r = runRootBatchSync(HOME, n, spawn, ARGV, () => true);
      expect(r).toEqual({ marker: true, ssh: "installed" });
      expect(spawned).toHaveLength(1); // no second prompt: one process
      expect(spawned[0]!.argv).toEqual(["sudo", ...ARGV, "provision", "root-marker", "install", resolve(HOME), kind]);
      expect(spawned[0]!.opts).toMatchObject({ stdin: "inherit" }); // the person's own terminal answers the prompt
      expect(spawned[0]!.argv).not.toContain("-n");
    }
  });
  test("a marker-only batch does not name an SSH service", () => {
    const spawned: string[][] = [];
    const spawn = ((argv: string[]) => { spawned.push(argv); return { exitCode: 0 }; }) as unknown as typeof Bun.spawnSync;
    expect(runRootBatchSync(HOME, need(true, false, false), spawn, ARGV, () => true)).toEqual({ marker: true, ssh: "skipped" });
    expect(spawned[0]).toEqual(["sudo", ...ARGV, "provision", "root-marker", "install", resolve(HOME)]);
  });
  test("exit statuses: the marker in place with the SSH install stopped is its own outcome; anything else did not finish", () => {
    const exits = (code: number) => ((() => ({ exitCode: code })) as unknown as typeof Bun.spawnSync);
    expect(runRootBatchSync(HOME, need(true, true, false), exits(SSH_INSTALL_EXIT), ARGV, () => true)).toMatchObject({ marker: true, ssh: "failed" });
    expect(runRootBatchSync(HOME, need(true, false, true), exits(SSH_INSTALL_EXIT), ARGV, () => true)).toMatchObject({ marker: true, ssh: "failed" });
    expect(runRootBatchSync(HOME, need(true, true, false), exits(1), ARGV, () => false)).toMatchObject({ marker: false, ssh: "failed", why: "the administrator step was not completed" });
    expect(runRootBatchSync(HOME, need(true, false, false), exits(1), ARGV, () => false)).toMatchObject({ marker: false, ssh: "skipped" });
  });
  test("a failed SSH half names the exact command that repeats just that step, quoted so it can be pasted", () => {
    const spawn = (() => ({ exitCode: SSH_INSTALL_EXIT })) as unknown as typeof Bun.spawnSync;
    const linux = runRootBatchSync(HOME, need(false, true, false), spawn, ARGV, () => true);
    expect(linux.rerun).toBe(`sudo ${ARGV[0]} provision root-marker install ${resolve(HOME)} ssh-linux`);
    const mac = runRootBatchSync("/Users/Kira Lee/it's/.walkie", need(false, false, true), spawn, ["/Users/Kira Lee/.local/bin/walkie"], () => true);
    expect(mac.rerun).toBe(`sudo '/Users/Kira Lee/.local/bin/walkie' provision root-marker install '/Users/Kira Lee/it'\\''s/.walkie' ssh-macos`);
    // The marker-only step has nothing to repeat for SSH.
    expect(runRootBatchSync(HOME, need(true, false, false), (() => ({ exitCode: 1 })) as unknown as typeof Bun.spawnSync, ARGV, () => false).rerun).toBeUndefined();
  });
  test("shellQuote survives a real shell for every awkward character: spaces, quotes, $(), backticks, ; and newlines", () => {
    for (const arg of ["plain/path-1.2", "a b", "it's", `say "hi"`, "$(echo pwned)", "`echo pwned`", "a;echo pwned", "back\\slash", "two\nlines", "*", "~", "-n"]) {
      const out = Bun.spawnSync(["/bin/sh", "-c", `printf '%s' ${shellQuote(arg)}`], { stdout: "pipe" }).stdout.toString();
      expect([arg, out]).toEqual([arg, arg]);
    }
  });
  test("the real batch reads the marker from disk and runs the same single sudo", async () => {
    const spawned: string[][] = [];
    const spawn = ((argv: string[]) => { spawned.push(argv); return { exitCode: 0 }; }) as unknown as typeof Bun.spawnSync;
    const batch = realRootBatch("/nonexistent-walkie-home-for-the-test", spawn, ARGV);
    expect(batch.markerPresent()).toBe(false); // no marker for a home that does not exist
    await batch.run(need(true, true, false));
    expect(spawned).toHaveLength(1);
  });
});

describe("the administrator step both company flows share", () => {
  const need = (marker: boolean, sshLinux: boolean, sshMacos: boolean) => ({ marker, sshLinux, sshMacos });
  function step(over: { markerPresent?: boolean; result?: Partial<RootBatchResult>; carriesSsh?: boolean; platform?: NodeJS.Platform; answers?: boolean } = {}) {
    const said: string[] = []; const ran: unknown[] = []; let asked = 0;
    const root: RootBatchDeps = {
      markerPresent: () => over.markerPresent ?? false,
      run: async (n) => { ran.push(n); return { marker: true, ssh: n.sshLinux || n.sshMacos ? "installed" : "skipped", ...over.result }; },
    };
    const result = runAdministratorStep((l) => said.push(l), root, { carriesSsh: over.carriesSsh ?? true, platform: over.platform ?? "linux", serverAnswers: async () => { asked++; return over.answers ?? false; } });
    return { result, said, ran, asked: () => asked };
  }
  test("announces what the one sudo will do, runs it once, and is done", async () => {
    const s = step({ platform: "darwin" });
    expect(await s.result).toEqual({ ok: true });
    expect(s.ran).toEqual([need(true, false, true)]);
    expect(s.said).toEqual(["one administrator step (sudo asks for your password once): the root-owned company-machine marker, then Walkie's SSH service for the owner's key (it listens only on this Mac and accepts only key logins; Remote Login is not used)"]);
  });
  test("nothing to do is silent and runs no sudo, and the server is only asked about when the link carries a packet", async () => {
    const s = step({ markerPresent: true, answers: true });
    expect(await s.result).toEqual({ ok: true });
    expect([s.ran, s.said, s.asked()]).toEqual([[], [], 1]);
    const plain = step({ markerPresent: true, carriesSsh: false });
    await plain.result;
    expect(plain.asked()).toBe(0);
    const windows = step({ markerPresent: true, platform: "win32" });
    await windows.result;
    expect(windows.asked()).toBe(0);
  });
  test("a marker that was not installed stops it, with the plain reason", async () => {
    const s = step({ result: { marker: false, ssh: "skipped", why: "the administrator step was not completed" } });
    expect(await s.result).toEqual({ ok: false, why: "the administrator step was not completed" });
  });
  test("an SSH half that failed stops BEFORE anything is recorded, with the exact command that repeats it and the same-command retry", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      const rerun = `sudo ${ARGV[0]} provision root-marker install ${HOME} ssh-${platform === "linux" ? "linux" : "macos"}`;
      const s = step({ platform, result: { marker: true, ssh: "failed", why: "the SSH service install stopped; its messages are above", rerun } });
      const r = await s.result;
      expect(r.ok).toBe(false);
      const why = r.ok ? "" : r.why;
      expect(why).toContain("the SSH service was not installed");
      expect(why).toContain("the SSH service install stopped; its messages are above");
      expect(why).toContain("run the same command again");
      expect(why).toContain("the same link still works");
      expect(why).toContain(rerun);
      expect(why).not.toContain("systemctl"); // never a unit that was not created
      expect(why).not.toContain("walkie-sshd");
    }
  });
});

describe("the root helper the sudo runs", () => {
  const base = (over: Partial<RootHelperDeps> & { order?: string[] } = {}): RootHelperDeps => ({
    euid: 0, sudoUid: 1000, ownerOf: () => 1000,
    writeMarker: () => { over.order?.push("marker"); },
    runSsh: async (kind, uid) => { over.order?.push(`${kind}:${uid}`); return { ok: true }; },
    err: () => undefined, ...over,
  });
  test("marker first, then the SSH service from the same root process", async () => {
    const order: string[] = [];
    expect(await rootMarkerHelper(["root-marker", "install", HOME, "ssh-linux"], base({ order }))).toBe(0);
    expect(order).toEqual(["marker", "ssh-linux:1000"]);
  });
  test("on macOS the same one process installs the marker and then Walkie's own SSH service, for the person who ran sudo", async () => {
    const order: string[] = [];
    expect(await rootMarkerHelper(["root-marker", "install", HOME, "ssh-macos"], base({ order, sudoUid: 501, ownerOf: () => 501 }))).toBe(0);
    expect(order).toEqual(["marker", "ssh-macos:501"]);
  });
  test("without an ssh argument nothing about SSH runs", async () => {
    const order: string[] = [];
    expect(await rootMarkerHelper(["root-marker", "install", HOME], base({ order }))).toBe(0);
    expect(order).toEqual(["marker"]);
  });
  test("the SSH install failing leaves the marker in place and says so with its own status and message", async () => {
    for (const kind of ["ssh-linux", "ssh-macos"] as const) {
      const order: string[] = []; const said: string[] = [];
      const status = await rootMarkerHelper(["root-marker", "install", HOME, kind], base({ order, runSsh: async () => { order.push("ssh"); return { ok: false, why: "an SSH server is already configured" }; }, err: (l) => said.push(l) }));
      expect(status).toBe(SSH_INSTALL_EXIT);
      expect(order).toEqual(["marker", "ssh"]);
      expect(said.join("")).toContain("an SSH server is already configured");
    }
  });
  test("a marker that cannot be written stops before any SSH change", async () => {
    for (const kind of ["ssh-linux", "ssh-macos"] as const) {
      const order: string[] = [];
      await expect(rootMarkerHelper(["root-marker", "install", HOME, kind], base({ order, writeMarker: () => { throw new Error("read-only"); } }))).rejects.toThrow("read-only");
      expect(order).toEqual([]);
    }
  });
  test("only root, for the machine person's own home, with nothing but install or install ssh-linux|ssh-macos", async () => {
    for (const [pos, over] of [
      [["root-marker", "install", HOME, "ssh-linux"], { euid: 1000 }],
      [["root-marker", "install", HOME, "ssh-macos"], { euid: 1000 }],
      [["root-marker", "install", HOME, "ssh-linux"], { sudoUid: Number.NaN }],
      [["root-marker", "install", HOME, "ssh-macos"], { ownerOf: () => 0 }],
      [["root-marker", "install", "relative/home", "ssh-linux"], {}],
      [["root-marker", "remove", HOME, "ssh-linux"], {}],
      [["root-marker", "install", HOME, "rm -rf /"], {}],
      [["root-marker", "install", HOME, "ssh-windows"], {}],
    ] as const) {
      const order: string[] = [];
      await expect(rootMarkerHelper(pos as readonly string[], base({ ...over, order }))).rejects.toThrow("root marker helper requires sudo");
      expect(order).toEqual([]);
    }
  });
});

describe("the embedded SSH script", () => {
  let dirs: string[] = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
  const stageRoot = (): string => { const d = mkdtempSync(join(tmpdir(), "walkie-stage-root-")); dirs.push(d); return d; };
  const ME = process.getuid?.() ?? 0;
  const io = (over: Partial<SshLinuxIo> = {}): Omit<SshLinuxIo, "spawn"> => ({ platform: "linux", euid: 0, owner: ME, ...over, stageRoot: over.stageRoot ?? stageRoot() });

  test("is exactly scripts/enroll-ssh-linux.sh: the walkie binary carries the script the repo reviews", () => {
    expect(SSH_LINUX_SCRIPT).toBe(readFileSync(resolve(import.meta.dir, "../../scripts/enroll-ssh-linux.sh"), "utf8"));
  });
  test("runs once as bash from a private staging directory under the ROOT-OWNED enrollment directory, then removes it; never prompts", () => {
    const root = stageRoot();
    const seen: { argv: string[]; mode: number; dirMode: number; body: string; stdin: unknown }[] = [];
    const spawn = ((argv: string[], opts: { stdin: unknown }) => {
      seen.push({ argv, mode: statSync(argv[1]!).mode & 0o777, dirMode: statSync(join(argv[1]!, "..")).mode & 0o777, body: readFileSync(argv[1]!, "utf8"), stdin: opts.stdin });
      return { exitCode: 0 };
    }) as unknown as typeof Bun.spawnSync;
    expect(runSshLinuxScript({ ...io({ stageRoot: root }), spawn })).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.argv[0]).toBe("/bin/bash");
    expect(seen[0]!.argv).toHaveLength(2);
    expect(seen[0]!.argv[1]!.startsWith(`${root}/`)).toBe(true);
    expect(seen[0]!.mode).toBe(0o700);
    expect(seen[0]!.dirMode).toBe(0o700);
    expect(seen[0]!.body).toBe(SSH_LINUX_SCRIPT);
    expect(seen[0]!.stdin).toBe("ignore"); // no second password, no question
    expect(existsSync(seen[0]!.argv[1]!)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
  test("review finding 7: the staging place is never TMPDIR, whatever the caller's environment says", () => {
    const attacker = stageRoot();
    const root = stageRoot();
    const before = process.env.TMPDIR;
    process.env.TMPDIR = attacker;
    try {
      let file = "";
      const spawn = ((argv: string[]) => { file = argv[1]!; return { exitCode: 0 }; }) as unknown as typeof Bun.spawnSync;
      expect(runSshLinuxScript({ ...io({ stageRoot: root }), spawn })).toEqual({ ok: true });
      expect(file.startsWith(`${root}/`)).toBe(true);
      expect(file.startsWith(`${attacker}/`)).toBe(false);
      expect(readdirSync(attacker)).toEqual([]);
    } finally { if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before; }
  });
  test("the real staging root is the system enrollment directory, not an environment-chosen one", () => {
    expect(systemEnrollmentRoot()).toBe(process.platform === "darwin" ? "/Library/Application Support/Walkie" : "/var/lib/walkie");
  });
  test("a staging root somebody else could write to, a link, or one root does not own is refused before anything is written", () => {
    const spawn = (() => { throw new Error("must not run"); }) as unknown as typeof Bun.spawnSync;
    const open = stageRoot();
    require("node:fs").chmodSync(open, 0o777);
    expect(runSshLinuxScript({ ...io({ stageRoot: open }), spawn })).toMatchObject({ ok: false });
    expect(readdirSync(open)).toEqual([]);
    const elsewhere = stageRoot();
    const link = join(stageRoot(), "link");
    symlinkSync(elsewhere, link);
    expect(runSshLinuxScript({ ...io({ stageRoot: link }), spawn })).toMatchObject({ ok: false });
    expect(readdirSync(elsewhere)).toEqual([]);
    const notRoots = stageRoot();
    expect(runSshLinuxScript({ ...io({ stageRoot: notRoots, owner: ME + 1 }), spawn })).toMatchObject({ ok: false });
    expect(readdirSync(notRoots)).toEqual([]);
  });
  test("a missing staging root is made 0755 (the marker's own directory), not world-writable", () => {
    const parent = stageRoot();
    const root = join(parent, "walkie");
    const spawn = (() => ({ exitCode: 0 })) as unknown as typeof Bun.spawnSync;
    expect(runSshLinuxScript({ ...io({ stageRoot: root }), spawn })).toEqual({ ok: true });
    expect(lstatSync(root).mode & 0o777).toBe(0o755);
  });
  test("a failing script is reported and its file is still removed", () => {
    let file = "";
    const root = stageRoot();
    const spawn = ((argv: string[]) => { file = argv[1]!; return { exitCode: 1 }; }) as unknown as typeof Bun.spawnSync;
    const r = runSshLinuxScript({ ...io({ stageRoot: root }), spawn });
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.why).toContain("exit 1");
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
  test("refuses outside Linux and outside root, before writing anything", () => {
    const spawn = (() => { throw new Error("must not run"); }) as unknown as typeof Bun.spawnSync;
    for (const over of [{ platform: "darwin" as const }, { euid: 1000 }, { euid: undefined }]) {
      const root = stageRoot();
      expect(runSshLinuxScript({ ...io({ ...over, stageRoot: root }), spawn })).toMatchObject({ ok: false });
      expect(readdirSync(root)).toEqual([]);
    }
  });
  test("the script itself is only ever run as root on Linux, and installs a loopback-only service", () => {
    expect(SSH_LINUX_SCRIPT).toContain("run as root on Linux/WSL in the installer root batch");
    expect(SSH_LINUX_SCRIPT).toContain("ListenAddress 127.0.0.1");
  });
});

describe("the CLI refuses the root helper outside a root batch, and the bootstrap grant outside WSL", () => {
  async function cli(args: string[], stdin: string | null = null) {
    const child = Bun.spawn([process.execPath, "src/cli/main.ts", ...args], { cwd: process.cwd(), stdin: stdin === null ? "ignore" : new Response(stdin), stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: "/tmp/walkie-no-such-home", WALKIE_SOCKET: "/tmp/walkie-no-such-home/none.sock" } });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, err, code };
  }
  test("root-marker accepts only install, optionally followed by ssh-linux or ssh-macos, and only as root", async () => {
    for (const kind of ["ssh-linux", "ssh-macos"]) {
      const asPerson = await cli(["provision", "root-marker", "install", "/tmp", kind]);
      expect([asPerson.code, asPerson.err]).toEqual([1, expect.stringContaining("root marker helper requires sudo")]);
    }
    for (const bad of [["install", "/tmp", "rm"], ["install", "/tmp", "ssh-linux", "extra"], ["install", "/tmp", "ssh-macos", "extra"], ["install", "/tmp", "ssh-windows"], ["remove", "/tmp"], ["install", "relative"]]) {
      const r = await cli(["provision", "root-marker", ...bad]);
      expect([bad.join(" "), r.code, r.err.includes("root-marker permits install, optionally followed by ssh-linux or ssh-macos, only")]).toEqual([bad.join(" "), 1, true]);
    }
  });
  test("grant-bootstrap takes nothing on its command line and reads its input from stdin only inside WSL", async () => {
    const extra = await cli(["provision", "grant-bootstrap", "--owner-ssh", "x"]);
    expect([extra.code, extra.err.includes("takes its input on stdin")]).toEqual([1, true]);
    const outside = await cli(["provision", "grant-bootstrap"], "{}");
    expect(outside.code).toBe(1);
    expect(outside.err).toMatch(/inside WSL|not the expected JSON/);
    expect(outside.out).toBe("");
  });
});
