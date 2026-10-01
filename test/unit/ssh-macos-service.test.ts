// WALK-67 lane 8, round 2 (review finding 2): on macOS Walkie never asks for Remote Login. Its own launchd system daemon,
// dev.walkie.sshd, listens only on this Mac (127.0.0.1 and ::1, port 22022) and accepts only key logins (the keys in the enrolled person's own authorized_keys).
// Everything here runs against a scratch directory with every system command stubbed: no real sudo, launchctl,
// ssh-keygen, sshd or Remote Login, and nothing under /Library or /etc.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installMacSshService, MAC_SSH_DIR, MAC_SSH_LABEL, MAC_SSH_PLIST, macSshdConfig, macSshdPlist, removeMacSshService, type MacSshIo } from "../../src/daemon/ssh/macos-service.ts";
import { MACOS_SSH_PORT } from "../../src/daemon/ssh/server.ts";
import { unenrollMacService } from "../../src/cli/commands/provision.ts";

const ME = process.getuid?.() ?? 0;
let scratch: string[] = [];
afterEach(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); scratch = []; });

/** The directive lines of a config (comments and blank lines dropped): what sshd would actually read. */
const directives = (text: string): string[] => text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

describe("the generated sshd_config", () => {
  test("every directive is pinned exactly: loopback only, key only, one person, its own keys and pid file", () => {
    expect(directives(macSshdConfig("arvid"))).toEqual([
      "Port 22022",
      "ListenAddress 127.0.0.1",
      "ListenAddress ::1",
      `HostKey "${MAC_SSH_DIR}/ssh_host_ed25519_key"`,
      `PidFile "${MAC_SSH_DIR}/sshd.pid"`,
      "PubkeyAuthentication yes",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "AuthenticationMethods publickey",
      "PermitRootLogin no",
      "UsePAM no",
      "StrictModes yes",
      "AllowUsers arvid",
      "AuthorizedKeysFile .ssh/authorized_keys",
      "Subsystem sftp internal-sftp",
    ]);
  });
  test("the port is the one documented constant, and never 22 (that is Remote Login's)", () => {
    expect(MACOS_SSH_PORT).toBe(22022);
    expect(directives(macSshdConfig("arvid"))).toContain(`Port ${MACOS_SSH_PORT}`);
    expect(macSshdConfig("arvid")).not.toMatch(/^Port 22$/m);
  });
  test("no address but the two loopback ones is ever listened on", () => {
    const listens = directives(macSshdConfig("arvid")).filter((l) => l.startsWith("ListenAddress"));
    expect(listens).toEqual(["ListenAddress 127.0.0.1", "ListenAddress ::1"]);
    expect(macSshdConfig("arvid")).not.toContain("0.0.0.0");
    expect(macSshdConfig("arvid")).not.toMatch(/ListenAddress\s+(\*|::)\s*$/m);
  });
  test("it names no path outside Walkie's own directory except the person's own authorized_keys", () => {
    const text = macSshdConfig("arvid");
    expect(text).not.toContain("/etc/ssh");
    expect(text).not.toContain("com.openssh");
    expect(text).not.toMatch(/Include/);
  });
  test("a login name that could change what the line means is refused, before anything is written", () => {
    for (const bad of ["", "a b", "a\nPermitRootLogin yes", "*", "!root", "a@b", "a?", "-x", "x".repeat(65), "a#b", "a\tb", "a,b", "root bob"]) {
      expect(() => macSshdConfig(bad), JSON.stringify(bad)).toThrow();
    }
    for (const fine of ["kiralee", "Kira.Lee", "_svc-1", "a", "kira2"]) expect(directives(macSshdConfig(fine))).toContain(`AllowUsers ${fine}`);
  });
  test("a directory with spaces is quoted for sshd, and a quote in it is refused", () => {
    expect(macSshdConfig("arvid", "/a b/ssh")).toContain('HostKey "/a b/ssh/ssh_host_ed25519_key"');
    expect(() => macSshdConfig("arvid", '/a"b')).toThrow();
    expect(() => macSshdConfig("arvid", "/a\nb")).toThrow();
  });
});

describe("the launchd plist", () => {
  test("label and program arguments are pinned: a system daemon running sshd -D with Walkie's own config", () => {
    const text = macSshdPlist();
    expect(MAC_SSH_LABEL).toBe("dev.walkie.sshd");
    expect(MAC_SSH_PLIST).toBe("/Library/LaunchDaemons/dev.walkie.sshd.plist");
    expect(text).toContain("<key>Label</key>\n\t<string>dev.walkie.sshd</string>");
    expect(text).toContain(["<array>", "\t\t<string>/usr/sbin/sshd</string>", "\t\t<string>-D</string>", "\t\t<string>-f</string>",
      `\t\t<string>${MAC_SSH_DIR}/sshd_config</string>`, "\t</array>"].join("\n"));
    expect(text).toContain("<key>RunAtLoad</key>\n\t<true/>");
    expect(text).toContain("<key>KeepAlive</key>\n\t<true/>");
    expect(text).not.toContain("com.openssh");
  });
  test("a path that XML would misread is escaped", () => {
    expect(macSshdPlist("/a&b/<c>")).toContain("<string>/a&amp;b/&lt;c&gt;/sshd_config</string>");
  });
  test.skipIf(!existsSync("/usr/bin/plutil"))("plutil accepts it (a read-only lint of a scratch file)", () => {
    const dir = mkdtempSync(join(tmpdir(), "walkie-plist-"));
    scratch.push(dir);
    const file = join(dir, "x.plist");
    writeFileSync(file, macSshdPlist());
    expect(Bun.spawnSync(["/usr/bin/plutil", "-lint", file]).exitCode).toBe(0);
  });
});

// ---- the install, against a scratch tree --------------------------------------------------------------------------------

interface Call { argv: string[] }
interface World { io: MacSshIo; calls: Call[]; dir: string; plist: string; daemons: string; root: string; seen: Record<string, string> }

type Script = (argv: string[], w: World) => { exitCode: number; stderr?: string; stdout?: string } | undefined;

function world(over: { answers?: () => Promise<boolean>; user?: string | null; script?: Script; euid?: number; platform?: NodeJS.Platform } = {}): World {
  const root = mkdtempSync(join(tmpdir(), "walkie-macssh-"));
  scratch.push(root);
  const parent = join(root, "Library", "Application Support", "Walkie");
  const dir = join(parent, "ssh");
  const daemons = join(root, "Library", "LaunchDaemons");
  mkdirSync(parent, { recursive: true, mode: 0o755 });
  mkdirSync(daemons, { recursive: true });
  const plist = join(daemons, "dev.walkie.sshd.plist");
  const calls: Call[] = [];
  const seen: Record<string, string> = {};
  const w = { calls, dir, plist, daemons, root, seen } as World;
  const spawn = ((argv: string[]) => {
    calls.push({ argv });
    const scripted = over.script?.(argv, w);
    if (scripted) return { exitCode: scripted.exitCode, stdout: Buffer.from(scripted.stdout ?? ""), stderr: Buffer.from(scripted.stderr ?? "") };
    if (argv[0] === "/usr/bin/ssh-keygen") {
      const file = argv[argv.indexOf("-f") + 1]!;
      writeFileSync(file, "PRIVATE KEY STUB\n", { mode: 0o600 });
      writeFileSync(`${file}.pub`, "ssh-ed25519 AAAA stub\n", { mode: 0o644 });
    }
    if (argv[0] === "/usr/sbin/sshd" && argv[1] === "-t") {
      const file = argv[argv.indexOf("-f") + 1]!;
      seen.configMode = (lstatSync(file).mode & 0o777).toString(8);
      seen.configFinalExisted = String(existsSync(join(dir, "sshd_config")));
      seen.configStaged = file;
    }
    if (argv[0] === "/usr/bin/plutil") seen.plistStaged = argv[2]!;
    return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
  }) as unknown as typeof Bun.spawnSync;
  w.io = { platform: over.platform ?? "darwin", euid: over.euid ?? 0, owner: ME, dir, plist, spawn,
    userName: () => (over.user === undefined ? "arvid" : over.user), chown: () => undefined,
    sleep: async () => undefined, answers: over.answers ?? (async () => true) };
  return w;
}
const argvs = (w: World): string[] => w.calls.map((c) => c.argv.join(" "));
const names = (d: string): string[] => readdirSync(d).sort();

describe("installing the service", () => {
  test("writes only Walkie's own files, in a private root directory, and loads the service", async () => {
    const w = world();
    const result = await installMacSshService(501, w.io);
    expect(result).toEqual({ ok: true });
    expect(names(w.dir)).toEqual(["ssh_host_ed25519_key", "ssh_host_ed25519_key.pub", "sshd_config"]);
    expect(names(w.daemons)).toEqual(["dev.walkie.sshd.plist"]);
    expect(lstatSync(w.dir).mode & 0o777).toBe(0o700);
    for (const f of ["ssh_host_ed25519_key", "ssh_host_ed25519_key.pub", "sshd_config"]) expect(lstatSync(join(w.dir, f)).mode & 0o777, f).toBe(0o600);
    expect(lstatSync(w.plist).mode & 0o777).toBe(0o644);
    expect(readFileSync(join(w.dir, "sshd_config"), "utf8")).toBe(macSshdConfig("arvid", w.dir));
    expect(readFileSync(w.plist, "utf8")).toBe(macSshdPlist(w.dir));
  });
  test("the order is: host key, validate the config, validate the plist, then enable, unload any old copy, load, and wait for the banner", async () => {
    const w = world();
    await installMacSshService(501, w.io);
    const keygen = argvs(w).findIndex((a) => a.startsWith("/usr/bin/ssh-keygen"));
    const sshdT = argvs(w).findIndex((a) => a.startsWith("/usr/sbin/sshd -t -f"));
    const lint = argvs(w).findIndex((a) => a.startsWith("/usr/bin/plutil -lint"));
    const enable = argvs(w).indexOf("/bin/launchctl enable system/dev.walkie.sshd");
    const bootout = argvs(w).indexOf("/bin/launchctl bootout system/dev.walkie.sshd");
    const bootstrap = argvs(w).indexOf(`/bin/launchctl bootstrap system ${w.plist}`);
    expect([keygen, sshdT, lint].every((i) => i >= 0)).toBe(true);
    expect(keygen).toBeLessThan(sshdT);
    expect(sshdT).toBeLessThan(lint);
    expect(lint).toBeLessThan(enable);
    expect(enable).toBeLessThan(bootout);
    expect(bootout).toBeLessThan(bootstrap);
    expect(argvs(w)[keygen]).toContain("-t ed25519");
    expect(argvs(w)[keygen]).toContain('-N ');
  });
  test("every system command is an absolute path, and none touches Remote Login, com.openssh.sshd, systemsetup or /etc/ssh", async () => {
    const w = world();
    await installMacSshService(501, w.io);
    for (const c of w.calls) expect(c.argv[0]!.startsWith("/"), c.argv[0]).toBe(true);
    const all = argvs(w).join("\n");
    for (const forbidden of ["com.openssh", "systemsetup", "/etc/ssh", "remotelogin", "sshd_config.d", "kickstart"]) expect(all).not.toContain(forbidden);
    for (const c of w.calls) expect(["/usr/bin/ssh-keygen", "/usr/sbin/sshd", "/usr/bin/plutil", "/bin/launchctl"]).toContain(c.argv[0]!);
  });
  test("files are written atomically: the config and the plist are checked as staged copies first, then renamed into place", async () => {
    const w = world();
    await installMacSshService(501, w.io);
    expect(w.seen.configStaged).not.toBe(join(w.dir, "sshd_config"));
    expect(w.seen.configStaged!.startsWith(`${w.dir}/`)).toBe(true); // in Walkie's own root-only directory, never TMPDIR
    expect(w.seen.configFinalExisted).toBe("false"); // nothing sat at the final path while the new bytes were still being checked
    expect(w.seen.configMode).toBe("600");
    expect(w.seen.plistStaged).not.toBe(w.plist);
    expect(w.seen.plistStaged!.endsWith(".plist")).toBe(false); // launchd scans *.plist: a staged copy must never look like one
    expect(w.seen.plistStaged!.startsWith(`${w.daemons}/`)).toBe(true);
    expect(existsSync(w.seen.configStaged!)).toBe(false);
    expect(existsSync(w.seen.plistStaged!)).toBe(false);
  });
  test("a reinstall keeps the host key (the owner's known_hosts stays valid), replaces only Walkie's own files and leaves everything else alone", async () => {
    const w = world();
    await installMacSshService(501, w.io);
    const key = readFileSync(join(w.dir, "ssh_host_ed25519_key"), "utf8");
    writeFileSync(join(w.daemons, "com.example.other.plist"), "somebody else's\n");
    writeFileSync(join(w.dir, "sshd_config"), "# hand edited\nAllowUsers arvid\n");
    w.calls.length = 0;
    expect(await installMacSshService(501, w.io)).toEqual({ ok: true });
    expect(argvs(w).some((a) => a.startsWith("/usr/bin/ssh-keygen"))).toBe(false);
    expect(readFileSync(join(w.dir, "ssh_host_ed25519_key"), "utf8")).toBe(key);
    expect(readFileSync(join(w.dir, "sshd_config"), "utf8")).toBe(macSshdConfig("arvid", w.dir));
    expect(readFileSync(join(w.daemons, "com.example.other.plist"), "utf8")).toBe("somebody else's\n");
    expect(names(w.dir)).toEqual(["ssh_host_ed25519_key", "ssh_host_ed25519_key.pub", "sshd_config"]);
  });
  test("a service already installed for another person is not taken over: nothing changes and the message names what to do", async () => {
    const w = world();
    mkdirSync(w.dir, { mode: 0o700 });
    writeFileSync(join(w.dir, "sshd_config"), macSshdConfig("kira", w.dir));
    const result = await installMacSshService(501, w.io);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.why).toContain("kira");
    expect(result.ok === false && result.why).toContain("un-enroll");
    expect(readFileSync(join(w.dir, "sshd_config"), "utf8")).toBe(macSshdConfig("kira", w.dir));
    expect(argvs(w).some((a) => a.startsWith("/bin/launchctl"))).toBe(false);
    expect(existsSync(w.plist)).toBe(false);
  });
  test("a config sshd rejects stops before anything is renamed or loaded, and the staged copies are removed", async () => {
    const w = world({ script: (argv) => (argv[0] === "/usr/sbin/sshd" ? { exitCode: 255, stderr: "line 3: Bad configuration option: Nope\n" } : undefined) });
    const result = await installMacSshService(501, w.io);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.why).toContain("Bad configuration option");
    expect(argvs(w).some((a) => a.startsWith("/bin/launchctl"))).toBe(false);
    expect(existsSync(w.plist)).toBe(false);
    expect(existsSync(join(w.dir, "sshd_config"))).toBe(false);
    expect(readdirSync(w.dir).filter((f) => f.startsWith(".")).length).toBe(0);
  });
  test("a plist plutil rejects stops before loading", async () => {
    const w = world({ script: (argv) => (argv[0] === "/usr/bin/plutil" ? { exitCode: 1, stderr: "Malformed\n" } : undefined) });
    const result = await installMacSshService(501, w.io);
    expect(result.ok).toBe(false);
    expect(argvs(w).some((a) => a.startsWith("/bin/launchctl"))).toBe(false);
    expect(existsSync(w.plist)).toBe(false);
  });
  test("launchd refusing the service leaves no plist behind (it would come back at every boot) and says why", async () => {
    const w = world({ script: (argv) => (argv[1] === "bootstrap" ? { exitCode: 5, stderr: "Bootstrap failed: 5: Input/output error\n" } : undefined) });
    const result = await installMacSshService(501, w.io);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.why).toContain("Bootstrap failed");
    expect(existsSync(w.plist)).toBe(false);
    expect(argvs(w).filter((a) => a === "/bin/launchctl bootout system/dev.walkie.sshd").length).toBeGreaterThanOrEqual(2); // the one before, and the undo
  });
  test("launchd still tearing down the copy that was just unloaded is waited out: a bootstrap that fails once and then succeeds installs", async () => {
    let tries = 0;
    const w = world({ script: (argv) => (argv[1] === "bootstrap" && ++tries === 1 ? { exitCode: 5, stderr: "Bootstrap failed: 5: Input/output error\n" } : undefined) });
    expect(await installMacSshService(501, w.io)).toEqual({ ok: true });
    expect(argvs(w).filter((a) => a.startsWith("/bin/launchctl bootstrap")).length).toBe(2);
    expect(existsSync(w.plist)).toBe(true);
  });
  test("a bootstrap that keeps failing is given up after three tries, and the plist is removed", async () => {
    const w = world({ script: (argv) => (argv[1] === "bootstrap" ? { exitCode: 5, stderr: "Bootstrap failed: 5\n" } : undefined) });
    expect((await installMacSshService(501, w.io)).ok).toBe(false);
    expect(argvs(w).filter((a) => a.startsWith("/bin/launchctl bootstrap")).length).toBe(3);
    expect(existsSync(w.plist)).toBe(false);
  });
  test("a service that loads but never answers an SSH banner is undone, and the message points at launchctl print", async () => {
    const w = world({ answers: async () => false });
    const result = await installMacSshService(501, w.io);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.why).toContain("127.0.0.1:22022");
    expect(result.ok === false && result.why).toContain("launchctl print system/dev.walkie.sshd");
    expect(existsSync(w.plist)).toBe(false);
  });
  test("it waits for the service to answer, not for a fixed time", async () => {
    let asked = 0;
    const w = world({ answers: async () => ++asked >= 4 });
    expect(await installMacSshService(501, w.io)).toEqual({ ok: true });
    expect(asked).toBe(4);
  });
  test("a host key that cannot be made stops everything", async () => {
    const w = world({ script: (argv) => (argv[0] === "/usr/bin/ssh-keygen" ? { exitCode: 1, stderr: "no space left\n" } : undefined) });
    const result = await installMacSshService(501, w.io);
    expect(result.ok).toBe(false);
    expect(argvs(w).some((a) => a.startsWith("/bin/launchctl"))).toBe(false);
    expect(readdirSync(w.dir).length).toBe(0);
  });
});

describe("who may install it, and as whom", () => {
  test("only as root on macOS, for a real person, with a login name that is safe to write", async () => {
    const noWrite = (w: World) => expect(existsSync(w.dir) ? readdirSync(w.dir) : []).toEqual([]);
    const linux = world({ platform: "linux" });
    expect((await installMacSshService(501, linux.io)).ok).toBe(false);
    const person = world({ euid: 501 });
    expect((await installMacSshService(501, person.io)).ok).toBe(false);
    const asRoot = world();
    expect((await installMacSshService(0, asRoot.io)).ok).toBe(false);
    const unknown = world({ user: null });
    expect((await installMacSshService(501, unknown.io)).ok).toBe(false);
    for (const bad of ["a b", "x\nAllowUsers root", "*"]) {
      const hostile = world({ user: bad });
      const r = await installMacSshService(501, hostile.io);
      expect([bad, r.ok]).toEqual([bad, false]);
      noWrite(hostile);
      expect(hostile.calls).toEqual([]);
    }
    for (const w of [linux, person, asRoot, unknown]) { noWrite(w); expect(w.calls).toEqual([]); expect(existsSync(w.plist)).toBe(false); }
  });
  test("a directory that is not private and owned by root is refused, and a link is never followed", async () => {
    const open = world();
    mkdirSync(open.dir, { mode: 0o755 });
    // The mode is repaired (the directory is Walkie's own and empty of anyone else's files)...
    expect((await installMacSshService(501, open.io)).ok).toBe(true);
    expect(lstatSync(open.dir).mode & 0o777).toBe(0o700);
    // ...but a symlink where the directory should be is refused outright.
    const linked = world();
    const elsewhere = mkdtempSync(join(tmpdir(), "walkie-elsewhere-"));
    scratch.push(elsewhere);
    symlinkSync(elsewhere, linked.dir);
    const r = await installMacSshService(501, linked.io);
    expect(r.ok).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(linked.calls).toEqual([]);
  });
});

describe("removing the service (un-enroll)", () => {
  const gone: Script = (argv) => (argv[1] === "print" ? { exitCode: 113, stderr: "Could not find service" } : undefined);
  test("stops it, removes its plist and its directory, and says it removed something", async () => {
    const w = world({ script: gone });
    await installMacSshService(501, w.io);
    writeFileSync(join(w.daemons, "com.example.other.plist"), "keep\n");
    w.calls.length = 0;
    const r = removeMacSshService(w.io);
    expect(r).toEqual({ removed: true });
    expect(existsSync(w.plist)).toBe(false);
    expect(existsSync(w.dir)).toBe(false);
    expect(readFileSync(join(w.daemons, "com.example.other.plist"), "utf8")).toBe("keep\n");
    expect(argvs(w)).toEqual(["/bin/launchctl bootout system/dev.walkie.sshd", "/bin/launchctl print system/dev.walkie.sshd"]);
  });
  test("a service installed for ANOTHER person is left in place: one person's un-enroll never cuts off another's SSH", async () => {
    const w = world({ script: gone, user: "kira" });
    await installMacSshService(502, w.io); // installed for kira
    const asArvid = { ...w.io, userName: () => "arvid" };
    w.calls.length = 0;
    const r = removeMacSshService(asArvid, 501);
    expect(r.removed).toBe(false);
    expect(r.kept).toContain("kira");
    expect(existsSync(w.plist)).toBe(true);
    expect(existsSync(w.dir)).toBe(true);
    expect(w.calls).toEqual([]); // not even stopped
    // The person it was installed for removes it as before.
    expect(removeMacSshService({ ...w.io, userName: () => "kira" }, 502)).toEqual({ removed: true });
    expect(existsSync(w.plist)).toBe(false);
  });
  test("a machine with no service has nothing to remove and nothing to say", () => {
    const w = world({ script: gone });
    expect(removeMacSshService(w.io)).toEqual({ removed: false });
  });
  test("a service that will not stop is left in place, with the reason, so the person can retry", () => {
    const stuck = world({ script: (argv) => (argv[1] === "print" ? { exitCode: 0, stdout: "state = running\n" } : argv[1] === "bootout" ? { exitCode: 5, stderr: "Boot-out failed: 5\n" } : undefined) });
    mkdirSync(stuck.dir, { mode: 0o700 });
    writeFileSync(stuck.plist, "x");
    const r = removeMacSshService(stuck.io);
    expect(r.removed).toBe(false);
    expect(r.why).toContain("Boot-out failed");
    expect(existsSync(stuck.plist)).toBe(true);
    expect(existsSync(stuck.dir)).toBe(true);
  });
  test("only as root on macOS, and a symlinked directory is never followed", () => {
    expect(removeMacSshService(world({ platform: "linux" }).io)).toMatchObject({ removed: false });
    expect(removeMacSshService(world({ euid: 501 }).io).removed).toBe(false);
    const w = world({ script: gone });
    const elsewhere = mkdtempSync(join(tmpdir(), "walkie-elsewhere-"));
    scratch.push(elsewhere);
    writeFileSync(join(elsewhere, "precious"), "keep");
    symlinkSync(elsewhere, w.dir);
    const r = removeMacSshService(w.io);
    expect(r.removed).toBe(false);
    expect(readFileSync(join(elsewhere, "precious"), "utf8")).toBe("keep");
  });
});

// Final review A (LOW): one person's un-enroll must never remove another person's service. The guard reads the config's
// AllowUsers; when that cannot be read (the config or the directory is a link, a directory, unreadable, or says nobody), it
// used to be skipped and the service was removed. Now whose it is must be established, or it is left in place with the reason
// and the exact commands to remove it by hand.
describe("a service whose owner cannot be established is left in place (final review A, LOW)", () => {
  const gone: Script = (argv) => (argv[1] === "print" ? { exitCode: 113, stderr: "Could not find service" } : undefined);
  /** kira's service, installed for real in the scratch tree, which arvid (uid 501) then tries to un-enroll. */
  async function kirasService() {
    const w = world({ script: gone, user: "kira" });
    expect(await installMacSshService(502, w.io)).toEqual({ ok: true });
    w.calls.length = 0;
    return { w, asArvid: { ...w.io, userName: () => "arvid" } as MacSshIo, config: join(w.dir, "sshd_config") };
  }
  const MANUAL = ["sudo launchctl bootout system/dev.walkie.sshd", "sudo rm /Library/LaunchDaemons/dev.walkie.sshd.plist", "sudo rm -r '/Library/Application Support/Walkie/ssh'"];

  function expectLeftAlone(w: World, r: ReturnType<typeof removeMacSshService>, why: RegExp): void {
    expect(r.removed).toBe(false);
    expect(r.why ?? "").toMatch(why);
    expect(r.kept).toBeUndefined();
    expect(existsSync(w.plist)).toBe(true);
    expect(existsSync(w.dir)).toBe(true);
    expect(w.calls).toEqual([]); // not even stopped
    const said = unenrollMacService("darwin", () => r) ?? "";
    expect(said).toContain("could not be removed");
    expect(said).toContain("cannot be read to confirm it is yours");
    for (const command of MANUAL) expect(said).toContain(command); // the exact manual commands
  }

  test("the config is a directory", async () => {
    const { w, asArvid, config } = await kirasService();
    rmSync(config);
    mkdirSync(config);
    expectLeftAlone(w, removeMacSshService(asArvid, 501), /sshd_config is not a regular file/);
  });
  test("the config is a symlink, even to a file that names the caller", async () => {
    const { w, asArvid, config } = await kirasService();
    const elsewhere = mkdtempSync(join(tmpdir(), "walkie-elsewhere-"));
    scratch.push(elsewhere);
    writeFileSync(join(elsewhere, "sshd_config"), "AllowUsers arvid\n");
    rmSync(config);
    symlinkSync(join(elsewhere, "sshd_config"), config);
    expectLeftAlone(w, removeMacSshService(asArvid, 501), /sshd_config is not a regular file/);
    expect(readFileSync(join(elsewhere, "sshd_config"), "utf8")).toBe("AllowUsers arvid\n");
  });
  test("the config has no AllowUsers line (kira's name only in a comment): nobody is named, so whose it is is unknown", async () => {
    const { w, asArvid, config } = await kirasService();
    writeFileSync(config, "Port 22022\nListenAddress 127.0.0.1\n# AllowUsers kira\n");
    expectLeftAlone(w, removeMacSshService(asArvid, 501), /has no AllowUsers line/);
  });
  test.skipIf(process.getuid?.() === 0)("the config cannot be read", async () => {
    const { w, asArvid, config } = await kirasService();
    chmodSync(config, 0o000);
    try { expectLeftAlone(w, removeMacSshService(asArvid, 501), /cannot be read/); }
    finally { chmodSync(config, 0o600); }
  });
  test("the service directory is a link: nothing behind it is read, followed or removed", async () => {
    const { w, asArvid } = await kirasService();
    const elsewhere = mkdtempSync(join(tmpdir(), "walkie-elsewhere-"));
    scratch.push(elsewhere);
    writeFileSync(join(elsewhere, "sshd_config"), "AllowUsers arvid\n");
    writeFileSync(join(elsewhere, "precious"), "keep");
    rmSync(w.dir, { recursive: true });
    symlinkSync(elsewhere, w.dir);
    const r = removeMacSshService(asArvid, 501);
    expect(r.removed).toBe(false);
    expect(r.why ?? "").toMatch(/is not a plain directory owned by root/);
    expect(existsSync(w.plist)).toBe(true);
    expect(w.calls).toEqual([]);
    expect(readFileSync(join(elsewhere, "precious"), "utf8")).toBe("keep");
    expect(readFileSync(join(elsewhere, "sshd_config"), "utf8")).toBe("AllowUsers arvid\n");
  });
  test("a second AllowUsers line that names another person keeps the service too", async () => {
    const { w, asArvid, config } = await kirasService();
    writeFileSync(config, `${macSshdConfig("arvid", w.dir)}AllowUsers kira\n`);
    const r = removeMacSshService(asArvid, 501);
    expect(r.removed).toBe(false);
    expect(r.kept).toContain("kira");
    expect(existsSync(w.plist)).toBe(true);
    expect(w.calls).toEqual([]);
  });
  test("what stays as it was: the caller's own config goes, another person's is kept, and no config at all serves no one (its leftovers go)", async () => {
    const own = await kirasService();
    expect(removeMacSshService({ ...own.w.io, userName: () => "kira" }, 502)).toEqual({ removed: true });
    expect(existsSync(own.w.plist) || existsSync(own.w.dir)).toBe(false);
    const other = await kirasService();
    expect(removeMacSshService(other.asArvid, 501).kept).toContain("kira");
    const none = await kirasService();
    rmSync(none.config);
    expect(removeMacSshService(none.asArvid, 501)).toEqual({ removed: true });
    expect(existsSync(none.w.plist) || existsSync(none.w.dir)).toBe(false);
  });
});
