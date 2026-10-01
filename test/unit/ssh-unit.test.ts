// Final review C, F1 (HIGH). Whether a server that answers on 127.0.0.1:22 is WALKIE's was decided with existsSync() on
// /etc/systemd/system/walkie-sshd.service, run as the unprivileged person. The install script had made /etc/systemd/system root-only
// (0700), so Walkie's own running service read as "not Walkie's": the Windows enrollment dropped owner SSH on a healthy machine and
// `walkie ssh enable` told a working machine "owner SSH stays off". The CLI now asks systemd, which any user may do
// (`systemctl show walkie-sshd.service -p LoadState -p ActiveState -p FragmentPath`), and trusts only a unit that is LOADED from the
// one file Walkie's root step writes and ACTIVE. These tests stub systemctl's output; nothing here starts systemd.
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SshStatus } from "../../src/cli/commands/doctor.ts";
import { realSshStepDeps } from "../../src/cli/ssh-enroll.ts";
import { foreignSshServer } from "../../src/cli/ssh-foreign.ts";
import { readWalkieSshUnit, walkieSshUnitFrom, walkieUnitHints } from "../../src/cli/ssh-unit.ts";
import { WALKIE_SSH_UNIT_PATH } from "../../src/daemon/ssh/enroll-linux.ts";
import { realServerProbe, sshServerStatus } from "../../src/daemon/ssh/server.ts";
import { SERVICES, showOf, systemctlSays } from "../helpers/systemctl-show.ts";

const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => { for (const s of servers) s.stop(true); servers.length = 0; });

const nothing = { installed: false, running: false };

describe("what systemd says about Walkie's unit", () => {
  test("it asks for exactly three properties of walkie-sshd.service", () => {
    const seen: string[][] = [];
    readWalkieSshUnit(systemctlSays(SERVICES.walkies, seen));
    expect(seen).toEqual([["show", "walkie-sshd.service", "-p", "LoadState", "-p", "ActiveState", "-p", "FragmentPath"]]);
    expect(WALKIE_SSH_UNIT_PATH).toBe("/etc/systemd/system/walkie-sshd.service");
  });

  test("Walkie's own service, loaded from its own file and active: installed and running", () => {
    expect(readWalkieSshUnit(systemctlSays(SERVICES.walkies))).toEqual({ installed: true, running: true });
  });

  test("Walkie's own service that is not active (stopped, failed, starting, stopping): installed, not running", () => {
    for (const active of ["inactive", "failed", "activating", "deactivating"]) {
      expect([active, readWalkieSshUnit(systemctlSays(showOf("loaded", active, WALKIE_SSH_UNIT_PATH)))]).toEqual([active, { installed: true, running: false }]);
    }
    expect(readWalkieSshUnit(systemctlSays(SERVICES.stopped))).toEqual({ installed: true, running: false });
  });

  test("a unit of that name loaded from anywhere else is not Walkie's, however active it is", () => {
    expect(readWalkieSshUnit(systemctlSays(SERVICES.foreign))).toEqual(nothing);
    for (const fragment of ["/run/systemd/system/walkie-sshd.service", "/usr/lib/systemd/system/walkie-sshd.service", "/home/arvid/walkie-sshd.service",
      "/tmp/etc/systemd/system/walkie-sshd.service", "/etc/systemd/system/walkie-sshd.service.bak", "/etc/systemd/system//walkie-sshd.service"]) {
      expect([fragment, readWalkieSshUnit(systemctlSays(showOf("loaded", "active", fragment)))]).toEqual([fragment, nothing]);
    }
  });

  test("no such unit, a masked one, or one that did not load: not installed", () => {
    expect(readWalkieSshUnit(systemctlSays(SERVICES.missing))).toEqual(nothing);
    expect(readWalkieSshUnit(systemctlSays(showOf("masked", "inactive", "/dev/null")))).toEqual(nothing);
    expect(readWalkieSshUnit(systemctlSays(showOf("error", "failed", WALKIE_SSH_UNIT_PATH)))).toEqual(nothing);
    expect(readWalkieSshUnit(systemctlSays(showOf("bad-setting", "inactive", WALKIE_SSH_UNIT_PATH)))).toEqual(nothing);
  });

  test("whatever systemctl cannot establish reads as not Walkie's: no systemctl, a failed run, a throw, empty or garbled output", () => {
    expect(readWalkieSshUnit(systemctlSays(null))).toEqual(nothing);
    expect(readWalkieSshUnit(() => { throw new Error("spawn failed"); })).toEqual(nothing);
    for (const text of ["", "\n", "garbage", "LoadState\nActiveState\nFragmentPath", "=loaded\n=active\n=/x", "ActiveState=active\n", `FragmentPath=${WALKIE_SSH_UNIT_PATH}\nActiveState=active\n`]) {
      expect([text, readWalkieSshUnit(systemctlSays(text))]).toEqual([text, nothing]);
    }
  });

  test("the order of the properties, extra ones, blank lines and CRLF do not matter", () => {
    expect(walkieSshUnitFrom(`FragmentPath=${WALKIE_SSH_UNIT_PATH}\nActiveState=active\nLoadState=loaded\n`)).toEqual({ installed: true, running: true });
    expect(walkieSshUnitFrom(`Id=walkie-sshd.service\r\nLoadState=loaded\r\n\r\nActiveState=active\r\nSubState=running\r\nFragmentPath=${WALKIE_SSH_UNIT_PATH}\r\n`)).toEqual({ installed: true, running: true });
  });
});

describe("the unit hints the real step deps give", () => {
  test("Linux: walkieUnit is 'installed' and walkieActive is 'running', each read from systemd", () => {
    for (const [name, text, installed, running] of [["walkies", SERVICES.walkies, true, true], ["stopped", SERVICES.stopped, true, false],
      ["foreign", SERVICES.foreign, false, false], ["missing", SERVICES.missing, false, false]] as const) {
      const hints = walkieUnitHints("linux", systemctlSays(text));
      expect([name, hints.walkieUnit(), hints.walkieActive()]).toEqual([name, installed, running]);
    }
  });

  test("macOS and Windows have no such unit, and systemd is never asked", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const seen: string[][] = [];
      const hints = walkieUnitHints(platform, systemctlSays(SERVICES.walkies, seen));
      expect([platform, hints.walkieUnit(), hints.walkieActive(), seen]).toEqual([platform, false, false, []]);
    }
  });

  test("the real step deps carry both hints (off Linux they claim no unit)", () => {
    const deps = realSshStepDeps({ request: async () => ({}) } as never);
    expect(typeof deps.walkieUnit).toBe("function");
    expect(typeof deps.walkieActive).toBe("function");
    if (process.platform !== "linux") expect([deps.walkieUnit?.(), deps.walkieActive?.()]).toEqual([false, false]);
  });
});

describe("a server that answers on 22 is Walkie's only by systemd's word (read through the daemon's own Linux probe)", () => {
  /** A loopback listener with a stock OpenSSH banner standing in for port 22, read as GET /v1/ssh/status reads it on Linux. */
  async function answering(): Promise<() => Promise<SshStatus>> {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(s) { s.write("SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13\r\n"); }, data() {}, close() {}, error() {} } });
    servers.push(server);
    const server_ = await sshServerStatus(server.port, { ...realServerProbe, platform: "linux" });
    return async () => ({ owner_key_present: false, tunnel_allowed: false, reason: "grant_absent", server: server_ });
  }
  const verdict = async (read: () => Promise<SshStatus>, text: string | null) =>
    foreignSshServer({ platform: "linux", read, ...walkieUnitHints("linux", systemctlSays(text)) });

  test("Walkie's own running service is Walkie's: not foreign", async () => {
    expect(await verdict(await answering(), SERVICES.walkies)).toBe(false);
  });
  test("a stopped Walkie service, another unit of that name, no unit, or no answer from systemd: whatever answers is not Walkie's", async () => {
    const read = await answering();
    for (const [name, text] of [["stopped", SERVICES.stopped], ["foreign", SERVICES.foreign], ["missing", SERVICES.missing], ["no systemctl", null]] as const) {
      expect([name, await verdict(read, text)]).toEqual([name, true]);
    }
  });
  test("nothing answering is never a foreign server, whatever systemd says", async () => {
    const quiet = async (): Promise<SshStatus> => ({ owner_key_present: false, tunnel_allowed: false, reason: "grant_absent", server: { enabled: false, detail: "no SSH server on 127.0.0.1" } });
    for (const text of [SERVICES.walkies, SERVICES.stopped, SERVICES.foreign, SERVICES.missing, null]) expect(await verdict(quiet, text)).toBe(false);
  });
});

test("no CLI code reads Walkie's unit file as the person: it sits behind a directory only root may search", () => {
  const root = join(import.meta.dir, "../../src/cli");
  const files = readdirSync(root, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
  expect(files.length).toBeGreaterThan(10);
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    expect([file, /\b(existsSync|statSync|lstatSync|accessSync|readFileSync|openSync)\(\s*WALKIE_SSH_UNIT_PATH/.test(text)]).toEqual([file, false]);
  }
});
