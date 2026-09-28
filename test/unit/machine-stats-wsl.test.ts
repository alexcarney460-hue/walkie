// WALKIE-TEMP-WSL: the Windows thermal zones behind a WSL daemon's temperature (one fixed PowerShell query, sampled at
// most once a minute, backing off to 10 min after 3 failures), NVIDIA GPU temperatures, and the GPU standing in for
// the machine temperature when there is no CPU/board sensor.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statsDetail } from "../../src/cli/commands/team.ts";
import { parseGpuNow, readGpuNow } from "../../src/daemon/machine-stats/accel.ts";
import { linuxReader, type Reading } from "../../src/daemon/machine-stats/read.ts";
import { machineTemp, MachineStatsSampler, shouldPublish } from "../../src/daemon/machine-stats/sampler.ts";
import {
  automountConfig, automountRoot, findPowershell, findPowershellDetail, socketIdentity, type FindPowershellDeps, interopRoutes, isWsl, parseWindowsZones, POWERSHELL_PATH, POWERSHELL_QUERY, powershellArgv, WIN_BACKOFF_MS,
  ELEVATED_MARK, INTEGRITY_LABEL_PATTERN, isWindowsDriveMount, MAX_SOCKET_NAMES, onWindowsDrive, MAX_INTEROP_LAUNCHES, WIN_SESSION_TIMEOUT_SKIP_MS, WIN_KEEP_MS, WIN_SAMPLE_MS, WindowsThermal, type PathInfo, type Route,
} from "../../src/daemon/machine-stats/wsl.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { MachineStats } from "../../src/protocol/machine-stats.ts";
import { devString, mountOf, parseMountinfo, type MountInfo } from "../../src/daemon/machine-stats/wsl-mounts.ts";
import { PeerVvRes, type NodeView } from "../../src/protocol/schemas.ts";

const FIX = join(import.meta.dir, "..", "fixtures", "machine-stats");
const fx = (name: string): string => readFileSync(join(FIX, name), "utf8");
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
/**
 * Synthetic /proc/self/mountinfo from /proc/self/mounts-style lines ("source target type options"), mounted in that
 * order: each mount's parent is the mount its point resolves onto at that moment, as the kernel does; a root ext4 "/"
 * comes first unless the first line mounts "/". null stays null.
 */
function mi(mounts: string | null): string | null {
  if (mounts === null) return null;
  const records: MountInfo[] = [];
  const lines = mounts.split("\n").map((l) => l.split(" ")).filter((f) => f.length >= 4);
  if (lines[0]?.[1] !== "/") records.push({ id: "1", parent: "0", dev: "8:48", root: "/", mountPoint: "/", type: "ext4", source: "/dev/sdd", superOptions: "rw" });
  const raw: string[] = records.map(() => "1 0 8:48 / / rw - ext4 /dev/sdd rw");
  for (const f of lines) {
    const [src, target, type, opts] = f as [string, string, string, string];
    const id = String(records.length + 1);
    const point = target.replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(Number.parseInt(o, 8)));
    const parent = records.length ? mountOf(records, point)?.id ?? "0" : "0";
    const dev = `0:${100 + records.length}`;
    records.push({ id, parent, dev, root: "/", mountPoint: point, type, source: src, superOptions: opts });
    raw.push(`${id} ${parent} ${dev} / ${target} rw - ${type} ${src} ${opts}`);
  }
  return `${raw.join("\n")}\n`;
}

/** Adds a st_dev stub that answers what the kernel would for the synthetic mountinfo the deps read. */
function withDev(d: FindPowershellDeps): FindPowershellDeps {
  return {
    dev: async (p) => {
      const t = await d.readText?.("/proc/self/mountinfo");
      return t ? mountOf(parseMountinfo(t), p)?.dev ?? null : null;
    },
    ...d,
  };
}

const PLAIN: Route[] = [{ kind: "plain" }];
const sess = (pid: number): Route => ({ kind: "session", path: `/run/WSL/${pid}_interop` });
const MEM = { total: 16 * GiB, used: 8 * GiB, swap_used: 0, pressure: "normal" as const };

describe("PowerShell thermal-zone JSON", () => {
  test("a laptop (recorded on hestia): three zones in °C, \\_TZ. prefix removed", () => {
    expect(parseWindowsZones(fx("powershell-thermal-zones-laptop.json"))).toEqual([
      { name: "TZ00", c: 27.9 }, { name: "THM2", c: 54.1 }, { name: "THRM", c: 86.1 },
    ]);
  });

  test("a desktop (recorded on almond) and empty output: no zones", () => {
    expect(parseWindowsZones(fx("powershell-thermal-zones-desktop.json"))).toEqual([]);
    expect(parseWindowsZones("")).toEqual([]);
    expect(parseWindowsZones("  \r\n")).toEqual([]);
  });

  test("garbage, a failed run, or JSON of the wrong shape: null", () => {
    expect(parseWindowsZones(null)).toBeNull();
    expect(parseWindowsZones("Get-CimInstance : Access denied")).toBeNull();
    expect(parseWindowsZones("{not json")).toBeNull();
    expect(parseWindowsZones("42")).toBeNull();
    expect(parseWindowsZones('"text"')).toBeNull();
  });

  test("one zone as an object, a BOM, whole kelvins when there is no high-precision value, junk rows skipped", () => {
    expect(parseWindowsZones('﻿{"Name":"\\\\_TZ.CPUZ","HighPrecisionTemperature":3232}')).toEqual([{ name: "CPUZ", c: 50.1 }]);
    expect(parseWindowsZones('[{"Name":"\\\\_TZ.A","Temperature":333},null,7,{"Name":"B"},{"Name":"C","HighPrecisionTemperature":"3000"}]'))
      .toEqual([{ name: "A", c: 59.9 }]);
  });

  test("implausible values (outside 5-120 °C) are dropped; names sanitised; at most 16 zones", () => {
    expect(parseWindowsZones('[{"Name":"cold","HighPrecisionTemperature":2731},{"Name":"hot","HighPrecisionTemperature":4000},{"Name":"ok","HighPrecisionTemperature":3131}]'))
      .toEqual([{ name: "ok", c: 40 }]);
    expect(parseWindowsZones('[{"Name":"\\u0007\\u0000","HighPrecisionTemperature":3131},{"HighPrecisionTemperature":3131}]'))
      .toEqual([{ name: "zone0", c: 40 }, { name: "zone1", c: 40 }]);
    const many = JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ Name: `Z${i}`, HighPrecisionTemperature: 3131 })));
    expect(parseWindowsZones(many)).toHaveLength(16);
    const long = parseWindowsZones(JSON.stringify([{ Name: "x".repeat(200), HighPrecisionTemperature: 3131 }]))!;
    expect(long[0]!.name).toHaveLength(32);
  });

  test("the command is a fixed argv: no shell, no user input", () => {
    expect(powershellArgv(POWERSHELL_PATH)).toEqual([POWERSHELL_PATH, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_QUERY]);
    expect(POWERSHELL_QUERY).toContain("Win32_PerfFormattedData_Counters_ThermalZoneInformation");
    expect(POWERSHELL_QUERY).toContain("ManagementObjectSearcher");
  });
});

describe("WSL detection", () => {
  const no = async (): Promise<boolean> => false;
  test("WSL_DISTRO_NAME is enough", async () => {
    expect(await isWsl({ env: { WSL_DISTRO_NAME: "Ubuntu" }, exists: no, readText: async () => null })).toBe(true);
  });
  test("the WSLInterop binfmt entry (also -late), without the variable (a service's environment)", async () => {
    expect(await isWsl({ env: {}, exists: async (p) => p === "/proc/sys/fs/binfmt_misc/WSLInterop", readText: async () => null })).toBe(true);
    expect(await isWsl({ env: {}, exists: async (p) => p === "/proc/sys/fs/binfmt_misc/WSLInterop-late", readText: async () => null })).toBe(true);
  });
  test("/proc/version naming a Microsoft kernel is the fallback; a plain Linux kernel is not WSL", async () => {
    const wsl2 = "Linux version 6.18.33.2-microsoft-standard-WSL2 (root@f1bbfb02316b) (gcc (GCC) 13.2.0)";
    expect(await isWsl({ env: {}, exists: no, readText: async () => wsl2 })).toBe(true);
    expect(await isWsl({ env: {}, exists: no, readText: async () => "Linux version 6.8.0-45-generic (buildd@lcy02)" })).toBe(false);
    expect(await isWsl({ env: {}, exists: async () => { throw new Error("EACCES"); }, readText: async () => null })).toBe(false);
  });
  test("PowerShell: fixed absolute paths only (standard, then the wsl.conf automount root), never PATH", async () => {
    const MOUNTS = "C:\\134 /mnt/c 9p rw,noatime,aname=drvfs;path=C:\\ 0 0\nC:\\134 /win/c 9p rw,aname=drvfs;path=C:\\ 0 0\n";
    const same = async (p: string) => p; // fake paths: no symlinks to resolve
    const conf = async (p: string) => (p === "/etc/wsl.conf" ? "[boot]\nsystemd=true\n[automount]\nroot = /win/\n" : p === "/proc/self/mountinfo" ? mi(MOUNTS) : null);
    const winPs = "/win/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
    expect(await findPowershell(withDev({ exists: async (p) => p === POWERSHELL_PATH, readText: conf, realpath: same }))).toBe(POWERSHELL_PATH);
    expect(await findPowershell(withDev({ exists: async (p) => p === winPs, readText: conf, realpath: same }))).toBe(winPs);
    expect(await findPowershell(withDev({ exists: async (p) => p === winPs, readText: async (p) => (p === "/proc/self/mountinfo" ? mi(MOUNTS) : null), realpath: same }))).toBeNull();
    // the drive must be a Windows mount (9p or drvfs), not a directory someone made
    const noMount = async (p: string) => (p === "/etc/wsl.conf" ? "[automount]\nroot = /win/\n" : p === "/proc/self/mountinfo" ? mi("/dev/sdc / ext4 rw 0 0\ntmpfs /win/c tmpfs rw 0 0\n") : null);
    expect(await findPowershell(withDev({ exists: async () => true, readText: noMount, realpath: same }))).toBeNull();
    expect(await findPowershell(withDev({ exists: no, readText: conf, realpath: same }))).toBeNull();
    const oldPath = process.env.PATH;
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
    const d = mkdtempSync(join(tmpdir(), "walkie-ps-path-"));
    try {
      writeFileSync(join(d, "powershell.exe"), "#!/bin/sh\n");
      chmodSync(join(d, "powershell.exe"), 0o755);
      process.env.PATH = `${d}:${oldPath}`;
      expect(await findPowershell(withDev({ exists: async (p) => p === join(d, "powershell.exe"), readText: async () => null, realpath: same }))).toBeNull();
      expect(await findPowershell(withDev({ readText: async () => null, realpath: same }))).toBeNull(); // a powershell.exe on PATH is never used
    } finally {
      process.env.PATH = oldPath;
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("Codex r2: an unmounted custom root, automount disabled, a symlinked path or unreadable mounts find nothing", async () => {
    const same = async (p: string) => p;
    const tmpPs = "/tmp/win/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
    const conf = "[automount]\nroot = /tmp/win/\n";
    const realMounts = "C:\\134 /mnt/c 9p rw,aname=drvfs;path=C:\\ 0 0\n";
    const rt = (conf: string, mounts: string | null) => async (p: string) => (p === "/etc/wsl.conf" ? conf : p === "/proc/self/mountinfo" ? mi(mounts) : null);
    // the file exists under the custom root, but /tmp/win/c is no Windows mount: a directory a user made
    expect(await findPowershell(withDev({ exists: async (p) => p === tmpPs, readText: rt(conf, realMounts), realpath: same }))).toBeNull();
    // /tmp/win/c mounted as tmpfs (or anything but 9p/drvfs) is not a Windows drive either
    expect(await findPowershell(withDev({ exists: async (p) => p === tmpPs, readText: rt(conf, `${realMounts}tmpfs /tmp/win/c tmpfs rw 0 0\n`), realpath: same }))).toBeNull();
    // it is a 9p mount: found
    const winMounts = `${realMounts}C:\\134 /tmp/win/c 9p rw,aname=drvfs;path=C:\\ 0 0\n`;
    expect(await findPowershell(withDev({ exists: async (p) => p === tmpPs, readText: rt(conf, winMounts), realpath: same }))).toBe(tmpPs);
    // automount disabled: no lookup at all, even though /mnt/c looks mounted and the file exists
    expect(await findPowershell(withDev({ exists: async () => true, readText: rt("[automount]\nenabled = false\nroot = /tmp/win/\n", winMounts), realpath: same }))).toBeNull();
    expect(await findPowershell(withDev({ exists: async () => true, readText: rt("[automount]\nenabled=FALSE\n", winMounts), realpath: same }))).toBeNull();
    expect(await findPowershell(withDev({ exists: async (p) => p === POWERSHELL_PATH, readText: rt("[automount]\nenabled = true\n", winMounts), realpath: same }))).toBe(POWERSHELL_PATH);
    // a symlink somewhere in the path (realpath differs): refused
    expect(await findPowershell(withDev({ exists: async (p) => p === tmpPs, readText: rt(conf, winMounts), realpath: async (p) => p.replace("/tmp/win/", "/home/eve/win/") }))).toBeNull();
    expect(await findPowershell(withDev({ exists: async (p) => p === tmpPs, readText: rt(conf, winMounts), realpath: async () => null }))).toBeNull();
    // /proc/self/mountinfo unreadable: fail closed
    expect(await findPowershell(withDev({ exists: async () => true, readText: rt(conf, null), realpath: same }))).toBeNull();
    expect(automountConfig("[automount]\nenabled = false\n")).toEqual({ enabled: false, root: null });
    expect(automountConfig("[interop]\nenabled = false\n")).toEqual({ enabled: true, root: null });
  });

  test("Opus r3: virtiofs drive mode and enabled=0 find nothing, with a reason for the log", async () => {
    const same = async (p: string) => p;
    const rt = (conf: string | null, mounts: string) => async (p: string) => (p === "/etc/wsl.conf" ? conf : p === "/proc/self/mountinfo" ? mi(mounts) : null);
    const virtio = await findPowershellDetail(withDev({ exists: async () => true, realpath: same, readText: rt(null, "drvfsa /mnt/c virtiofs rw 0 0\n") }));
    expect(virtio).toEqual({ bin: null, why: "temperature: Windows drive not reachable in this WSL drive mode (virtiofs)" });
    const off = await findPowershellDetail(withDev({ exists: async () => true, realpath: same, readText: rt("[automount]\nenabled=0\n", "C:\\134 /mnt/c 9p rw,aname=drvfs;path=C:\\ 0 0\n") }));
    expect(off.bin).toBeNull();
    expect(off.why).toContain("enabled = false");
    for (const v of ["0", "no", "off", "False"]) expect(automountConfig(`[automount]\nenabled=${v}\n`).enabled).toBe(false);
    expect(automountConfig("[automount]\nenabled=1\n").enabled).toBe(true);
    // the reason becomes the backoff note
    let now = 0;
    const t = new WindowsThermal({ run: async () => null, clock: () => now, powershell: async () => virtio, interop: async () => PLAIN });
    for (let i = 0; i < 3; i++) { await t.read(); now += WIN_SAMPLE_MS; }
    expect((await t.read()).note).toBe("temperature: Windows drive not reachable in this WSL drive mode (virtiofs) (retrying every 10 min)");
  });

  test("Codex r4 HIGH: a tmpfs mounted later over a parent of the C: drive hides it; the planted powershell.exe is not run", async () => {
    // /mnt/c unavailable; root /tmp/win/; C: at /tmp/win/c; then an admin mounts a writable, exec tmpfs over /tmp/win
    const conf = "[automount]\nroot = /tmp/win/\n";
    const tmpPs = "/tmp/win/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
    const before = [
      "82 67 8:48 / / rw,relatime - ext4 /dev/sdd rw",
      "134 82 0:71 / /tmp rw,nosuid,nodev - tmpfs tmpfs rw",
      "150 134 0:69 / /tmp/win/c rw,noatime - 9p C:\\134 rw,aname=drvfs;path=C:\\;uid=1000",
    ].join("\n");
    const after = `${before}\n160 134 0:90 / /tmp/win rw,relatime - tmpfs none rw,mode=1777`;
    const kernel = (tmpfsOn: boolean) => async (p: string) => (tmpfsOn && p.startsWith("/tmp/win") ? "0:90" : p.startsWith("/tmp/win/c") ? "0:69" : "8:48");
    const deps = (info: string, tmpfsOn: boolean): FindPowershellDeps => ({
      exists: async (p) => p === tmpPs, realpath: async (p) => p, dev: kernel(tmpfsOn),
      readText: async (p) => (p === "/etc/wsl.conf" ? conf : p === "/proc/self/mountinfo" ? info : null),
    });
    expect(await findPowershell(deps(before, false))).toBe(tmpPs); // the real drive: found
    expect(await findPowershell(deps(after, true))).toBeNull(); // covered: the planted file is on the tmpfs
    // the same table with the lines in a misleading order (mountinfo order isn't mount order): still refused
    const shuffled = after.split("\n").reverse().join("\n");
    expect(await findPowershell(deps(shuffled, true))).toBeNull();
    // and even a table that still looks right is refused when stat says the file is on another device
    expect(await findPowershell({ ...deps(before, false), dev: async (p) => (p === tmpPs ? "0:90" : "0:69") })).toBeNull();
    expect(await findPowershell({ ...deps(before, false), dev: async () => null })).toBeNull(); // stat failed: fail closed
  });

  test("Opus r5: the log says what actually happened", async () => {
    const ps = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
    const why = async (info: string, extra: Partial<FindPowershellDeps> = {}) => (await findPowershellDetail({
      exists: async () => true, realpath: async (p) => p, dev: async () => "0:69",
      readText: async (p) => (p === "/proc/self/mountinfo" ? info : null), ...extra,
    })).why;
    const root = "1 0 8:48 / / rw - ext4 /dev/sdd rw";
    const c = "2 1 0:69 / /mnt/c rw - 9p C:\\134 rw,aname=drvfs;path=C:\\";
    expect(await why(root)).toBe("temperature: C: drive mount not found at /mnt/c (found ext4 at /)");
    expect(await why(`${root}\n3 1 0:90 / /mnt rw - tmpfs none rw`)).toBe("temperature: C: drive mount not found at /mnt/c (found tmpfs at /mnt)");
    expect(await why(`${root}\n2 1 0:69 /Users/eve /mnt/c rw - 9p C:\\134 rw,aname=drvfs;path=C:\\`)).toBe("temperature: the 9p mount at /mnt/c is not the whole C: drive");
    expect(await why(`${root}\n2 1 0:70 / /mnt/c rw - virtiofs drvfsa rw`)).toBe("temperature: Windows drive not reachable in this WSL drive mode (virtiofs)");
    expect(await why(`${root}\n${c}\n4 2 0:91 / /mnt/c/Windows rw - tmpfs none rw`)).toBe("temperature: the C: drive at /mnt/c is covered by a tmpfs mount at /mnt/c/Windows");
    expect(await why(`${root}\n${c}`, { exists: async () => false })).toBe(`temperature: powershell.exe not found at ${ps}`);
    expect(await why(`${root}\n${c}`, { realpath: async () => "/elsewhere" })).toBe(`temperature: ${ps} goes through a symlink`);
    expect(await why(`${root}\n${c}`, { dev: async (p) => (p === ps ? "0:90" : "0:69") })).toBe(`temperature: ${ps} is not on the C: drive mount at /mnt/c (device 0:90, mount 0:69)`);
    expect(await why(`${root}\n${c}`)).toBeUndefined(); // found: no reason
  });

  test("Codex r4: a bind mount of a folder ON the C: drive is not the drive", async () => {
    const info = [
      "1 0 8:48 / / rw - ext4 /dev/sdd rw",
      "2 1 0:69 /Users/eve/fake /mnt/c rw - 9p C:\\134 rw,aname=drvfs;path=C:\\",
    ].join("\n");
    expect(isWindowsDriveMount(info, "/mnt/c")).toBe(false);
    expect(await findPowershell({ exists: async () => true, realpath: async (p) => p, dev: async () => "0:69", readText: async (p) => (p === "/proc/self/mountinfo" ? info : null) })).toBeNull();
  });

  test("hestia's real /proc/self/mountinfo (root listed after some of its children): /mnt/c is the C: drive", async () => {
    const info = fx("mountinfo-hestia-wsl.txt");
    expect(isWindowsDriveMount(info, "/mnt/c")).toBe(true);
    expect(onWindowsDrive(info, "/mnt/c", POWERSHELL_PATH)).toBe(true);
    expect(isWindowsDriveMount(info, "/usr/lib/wsl/drivers")).toBe(false); // the drivers 9p share
    expect(devString(69)).toBe("0:69"); // stat -c %d of powershell.exe on hestia was 69; mountinfo says 0:69
    expect(await findPowershell({ exists: async () => true, realpath: async (p) => p, dev: async () => "0:69", readText: async (p) => (p === "/proc/self/mountinfo" ? info : null) })).toBe(POWERSHELL_PATH);
  });

  test("Windows drive mounts: 9p or drvfs at exactly that directory, with /proc/self/mounts escapes", () => {
    const m = "C:\\134 /mnt/c 9p rw,aname=drvfs;path=C:\\ 0 0\nC:\\134 /mnt/d drvfs rw 0 0\nx /mnt/e ext4 rw 0 0\ny /my\\040drives/c 9p rw,aname=drvfs;path=C:\\ 0 0\ndrivers /mnt/f 9p rw,aname=drivers 0 0\nD:\\134 /mnt/g 9p rw,aname=drvfs;path=D:\\ 0 0\n";
    expect(isWindowsDriveMount(mi(m), "/mnt/c")).toBe(true);
    expect(isWindowsDriveMount(mi(m), "/mnt/d")).toBe(true); // WSL1 drvfs from C:\\
    expect(isWindowsDriveMount(mi(m), "/mnt/f")).toBe(false); // another 9p share (the GPU drivers), not the C: drive
    expect(isWindowsDriveMount(mi(m), "/mnt/g")).toBe(false); // D:, not C:
    expect(isWindowsDriveMount(mi(`${m}none /mnt/c tmpfs rw 0 0\n`), "/mnt/c")).toBe(false); // hidden under a later overmount
    const ps = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
    expect(onWindowsDrive(mi(m), "/mnt/c", ps)).toBe(true);
    expect(onWindowsDrive(mi(`${m}none /mnt/c/Windows tmpfs rw 0 0\n`), "/mnt/c", ps)).toBe(false); // a directory on the way overmounted
    expect(onWindowsDrive(mi(`${m}none /mnt/c/Windows/System32/WindowsPowerShell/v1.0 tmpfs rw 0 0\n`), "/mnt/c", ps)).toBe(false);
    expect(onWindowsDrive(mi(`${m}none /mnt/cc tmpfs rw 0 0\n`), "/mnt/c", ps)).toBe(true); // a sibling prefix is not on the path
    // Opus r4: a later mount over a PARENT of /mnt/c (or over /) hides the drive
    expect(onWindowsDrive(mi(`${m}none /mnt tmpfs rw 0 0\n`), "/mnt/c", ps)).toBe(false);
    expect(onWindowsDrive(mi(`${m}none / tmpfs rw 0 0\n`), "/mnt/c", ps)).toBe(false);
    expect(isWindowsDriveMount(mi(`${m}none /mnt tmpfs rw 0 0\n`), "/mnt/c")).toBe(false);
    // a parent mounted BEFORE the drive (the normal order: / first, then /mnt/c) doesn't hide it
    expect(onWindowsDrive(mi(`/dev/sdc / ext4 rw 0 0\nnone /mnt tmpfs rw 0 0\n${m}`), "/mnt/c", ps)).toBe(true);
    expect(isWindowsDriveMount(mi(m), "/mnt/e")).toBe(false);
    expect(isWindowsDriveMount(mi(m), "/mnt")).toBe(false);
    expect(isWindowsDriveMount(mi(m), "/my drives/c")).toBe(true);
    expect(isWindowsDriveMount(null, "/mnt/c")).toBe(false);
  });

  test("the query uses no cmdlets (no module auto-load) and refuses to run at High integrity or above", () => {
    expect(POWERSHELL_QUERY).not.toMatch(/Get-CimInstance|ConvertTo-Json|Select-Object|New-Object|Add-Type|Import-Module|ForEach-Object|IsInRole/);
    expect(POWERSHELL_QUERY.indexOf("whoami.exe")).toBeLessThan(POWERSHELL_QUERY.indexOf("ManagementObjectSearcher"));
    expect(POWERSHELL_QUERY).toContain("S-1-16-");
    expect(POWERSHELL_QUERY).toContain("-ge 12288");
    expect(POWERSHELL_QUERY).toContain("[Environment]::SystemDirectory"); // System32's whoami.exe, not one on PATH
    expect(POWERSHELL_QUERY).toContain(`'${INTEGRITY_LABEL_PATTERN}'`);
  });

  test("Opus r4: the integrity level comes from the label row, not the first S-1-16- anywhere", () => {
    const level = (whoami: string): number | null => {
      const m = new RegExp(INTEGRITY_LABEL_PATTERN).exec(whoami);
      return m ? Number(m[1]) : null;
    };
    const rows = (label: string) => [
      '"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"',
      '"HESTIA\\S-1-16-8192 ""Label"",""S-1-16-8192""","Alias","S-1-5-21-1-2-3-1001","Mandatory group, Enabled by default, Enabled group"',
      '"BUILTIN\\Administrators","Alias","S-1-5-32-544","Mandatory group, Enabled by default, Enabled group, Group owner"',
      `"Mandatory Label\\${label}","Label","S-1-16-${label === "High Mandatory Level" ? 12288 : 8192}",""`,
    ].join("\n");
    // a group NAME containing S-1-16-8192 (even with CSV-escaped quotes) comes first; the label row decides
    expect(level(rows("High Mandatory Level"))).toBe(12288);
    expect(level(rows("Medium Mandatory Level"))).toBe(8192);
    expect(level('"Everyone","Well-known group","S-1-1-0",""')).toBeNull(); // no label row: the query refuses
    expect(POWERSHELL_QUERY).toContain(ELEVATED_MARK);
    expect(parseWindowsZones(ELEVATED_MARK)).toBeNull();
  });

  test("wsl.conf automount root: parsed from its section only, quotes and comments allowed, odd paths refused", () => {
    expect(automountRoot("[automount]\nroot = /win/")).toBe("/win/");
    expect(automountRoot("[automount]\r\nenabled=true\r\nroot=\"/drives\"  # custom\r\n")).toBe("/drives/");
    expect(automountRoot("[Automount]\nRoot = '/x'\n")).toBe("/x/");
    expect(automountRoot("[boot]\nroot = /win/\n")).toBeNull();
    expect(automountRoot("[automount]\nroot = win/\n")).toBeNull();
    expect(automountRoot("[automount]\nroot = /a/../etc/\n")).toBeNull();
    expect(automountRoot("[automount]\nroot = /a b/\n")).toBeNull();
    expect(automountRoot("[automount]\nroot = /$(id)/\n")).toBeNull();
    expect(automountRoot(null)).toBeNull();
    expect(automountRoot("garbage")).toBeNull();
  });
});

describe("Windows thermal sampling cadence", () => {
  const ZONES = fx("powershell-thermal-zones-laptop.json");
  const setup = (out: () => string | null) => {
    let now = 0;
    const calls: string[][] = [];
    const t = new WindowsThermal({
      run: async (cmd) => { calls.push(cmd); return out(); }, clock: () => now, powershell: async () => "/fake/powershell.exe", interop: async () => PLAIN,
    });
    return { t, calls, advance: (ms: number) => { now += ms; } };
  };

  test("at most once per 60 s; between samples the last zones are returned", async () => {
    const { t, calls, advance } = setup(() => ZONES);
    expect((await t.read()).zones).toHaveLength(3);
    advance(30_000);
    expect((await t.read()).zones).toHaveLength(3);
    expect(calls).toHaveLength(1);
    advance(WIN_SAMPLE_MS - 30_000);
    await t.read();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(powershellArgv("/fake/powershell.exe"));
  });

  test("concurrent reads share one PowerShell run", async () => {
    let release!: (s: string) => void;
    const gate = new Promise<string>((r) => { release = r; });
    let n = 0;
    const t = new WindowsThermal({ run: async () => { n++; return gate; }, clock: () => 0, powershell: async () => "/p", interop: async () => PLAIN });
    const a = t.read(), b = t.read();
    release(ZONES);
    expect((await a).zones).toEqual((await b).zones);
    expect(n).toBe(1);
  });

  test("3 failures in a row back off to every 10 min, with a note; a success resets", async () => {
    let out: string | null = null;
    const { t, calls, advance } = setup(() => out);
    for (let i = 0; i < 3; i++) {
      expect((await t.read()).zones).toBeNull();
      advance(WIN_SAMPLE_MS);
    }
    expect(calls).toHaveLength(3);
    expect(t.failures).toBe(3);
    const backedOff = await t.read();
    expect(backedOff.note).toContain("every 10 min");
    expect(calls).toHaveLength(3);
    advance(WIN_BACKOFF_MS - WIN_SAMPLE_MS - 1);
    await t.read();
    expect(calls).toHaveLength(3);
    out = ZONES;
    advance(1);
    const ok = await t.read();
    expect(calls).toHaveLength(4);
    expect(ok.zones).toHaveLength(3);
    expect(ok.note).toBeUndefined();
    expect(t.failures).toBe(0);
  });

  test("no zones ([] on a desktop), garbage, a throwing runner or no PowerShell all count as failures", async () => {
    for (const out of ["[]", "garbage"]) {
      const { t } = setup(() => out);
      await t.read();
      expect(t.failures).toBe(1);
    }
    const thrower = new WindowsThermal({ run: async () => { throw new Error("spawn"); }, clock: () => 0, powershell: async () => "/p", interop: async () => PLAIN });
    expect((await thrower.read()).zones).toBeNull();
    expect(thrower.failures).toBe(1);
    let ran = false;
    const none = new WindowsThermal({ run: async () => { ran = true; return ZONES; }, clock: () => 0, powershell: async () => null, interop: async () => PLAIN });
    expect((await none.read()).zones).toBeNull();
    expect(ran).toBe(false);
  });

  test("failed samples keep the last good zones for up to 3 minutes, then drop them (no flicker to the GPU)", async () => {
    let out: string | null = ZONES;
    const { t, advance } = setup(() => out);
    expect((await t.read()).zones).toHaveLength(3);
    out = null;
    advance(WIN_SAMPLE_MS);
    expect((await t.read()).zones).toHaveLength(3);
    advance(WIN_SAMPLE_MS);
    expect((await t.read()).zones).toHaveLength(3);
    expect(t.failures).toBe(2);
    advance(WIN_KEEP_MS - 2 * WIN_SAMPLE_MS + 1);
    expect((await t.read()).zones).toBeNull();
  });

  test("Codex r2: cached zones expire 3 minutes after the good read even on the cadence shortcut", async () => {
    let out: string | null = ZONES;
    let now = 0;
    const t = new WindowsThermal({ run: async () => out, clock: () => now, powershell: async () => "/p", interop: async () => PLAIN });
    expect((await t.read()).zones).toHaveLength(3);
    out = null;
    now = 179_000; // a delayed failed sample: still within the keep window
    expect((await t.read()).zones).toHaveLength(3);
    now = 181_000; // no sample due (cadence shortcut), but the zones are older than 3 min
    expect((await t.read()).zones).toBeNull();
  });

  test("a stale good reading older than 3 minutes is not kept after one failure", async () => {
    let out: string | null = ZONES;
    let now = 0;
    const t = new WindowsThermal({ run: async () => out, clock: () => now, powershell: async () => "/p", interop: async () => PLAIN });
    await t.read();
    out = "[]";
    now = WIN_KEEP_MS + 1;
    expect((await t.read()).zones).toBeNull();
  });

  test("Codex r3: a timeout on the plain route backs off 10 min; nothing turns the query off for good", async () => {
    let now = 0;
    let calls = 0;
    let hang = true;
    const t = new WindowsThermal({
      run: async (_cmd, o) => { calls++; if (hang) { o.onTimeout(); return null; } return ZONES; }, interop: async () => PLAIN,
      clock: () => now, powershell: async () => "/p",
    });
    await t.read();
    expect(calls).toBe(1);
    now += WIN_SAMPLE_MS;
    await t.read();
    now += WIN_SAMPLE_MS;
    await t.read();
    expect(calls).toBe(1); // the hung plain route is skipped for 10 min, not asked every minute
    hang = false;
    now = WIN_SESSION_TIMEOUT_SKIP_MS + WIN_BACKOFF_MS; // past the skip and the 3-failure backoff
    expect((await t.read()).zones).toHaveLength(3); // back, never off for good
    expect(calls).toBe(2);
  });

  test("a PowerShell lookup that finds nothing is retried on the next sample", async () => {
    let now = 0;
    let found: string | null = null;
    let lookups = 0;
    const t = new WindowsThermal({ run: async () => ZONES, clock: () => now, powershell: async () => { lookups++; return found; }, interop: async () => PLAIN });
    expect((await t.read()).zones).toBeNull();
    found = "/p";
    now += WIN_SAMPLE_MS;
    expect((await t.read()).zones).toHaveLength(3);
    now += WIN_SAMPLE_MS;
    await t.read();
    expect(lookups).toBe(3); // looked up again before every launch (Codex r3), never cached
  });

  test("Codex r3: the PowerShell is re-validated before every launch; a drive unmounted later stops the launches", async () => {
    let now = 0;
    const MOUNTS = "C:\\134 /tmp/win/c 9p rw,aname=drvfs;path=C:\\;uid=1000 0 0\n";
    let mounts: string | null = MOUNTS;
    const tmpPs = "/tmp/win/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
    const lookup = () => findPowershellDetail(withDev({
      exists: async (p) => p === tmpPs, realpath: async (p) => p,
      readText: async (p) => (p === "/etc/wsl.conf" ? "[automount]\nroot = /tmp/win/\n" : p === "/proc/self/mountinfo" ? mi(mounts) : null),
    }));
    const ran: string[] = [];
    const t = new WindowsThermal({ run: async (cmd) => { ran.push(cmd[0] as string); return ZONES; }, clock: () => now, powershell: lookup, interop: async () => PLAIN });
    expect((await t.read()).zones).toHaveLength(3);
    expect(ran).toEqual([tmpPs]);
    mounts = ""; // the drive is unmounted: a user could now create /tmp/win/c/... themselves
    now += WIN_SAMPLE_MS;
    await t.read();
    expect(ran).toEqual([tmpPs]); // not launched again
    mounts = `${MOUNTS}tmpfs /tmp/win/c tmpfs rw 0 0\n`; // or overmounted
    now += WIN_SAMPLE_MS;
    await t.read();
    expect(ran).toEqual([tmpPs]);
  });
});

describe("interop routes (the systemd service has no WSL_INTEROP)", () => {
  // A /run/WSL listing like hestia's under systemd-run --user (daemon uid 1000).
  const listing = ["1_interop", "2_interop", "784190_interop", "2459744_interop", "3043279_interop", "600_interop", "601_interop", "602_interop", "603_interop", "604_interop", "evil;rm_interop", "../x_interop", "notes"];
  const sock = (uid: number, mtimeMs: number, extra: Partial<PathInfo> = {}): PathInfo => ({ socket: true, symlink: false, uid, mtimeMs, ...extra });
  const files: Record<string, PathInfo> = {
    "/run/WSL/1_interop": sock(0, 1, { socket: false, symlink: true }),
    "/run/WSL/2_interop": sock(0, 2),
    "/run/WSL/784190_interop": sock(0, 50),
    "/run/WSL/2459744_interop": sock(0, 40),
    "/run/WSL/3043279_interop": sock(0, 30),
    "/run/WSL/600_interop": sock(1000, 90), // planted by a user: not root's
    "/run/WSL/601_interop": sock(0, 91, { socket: false }), // a regular file
    "/run/WSL/602_interop": sock(0, 92), // pid is a user's process
    "/run/WSL/603_interop": sock(0, 93), // relay of a root session
    "/run/WSL/604_interop": sock(0, 94), // pid gone
  };
  const procs: Record<string, { uid: number; comm: string }> = {
    "1": { uid: 0, comm: "systemd" }, "2": { uid: 0, comm: "init-systemd(Ub" },
    "784190": { uid: 0, comm: "Relay(784191)" }, "784191": { uid: 1000, comm: "bash" },
    "2459744": { uid: 0, comm: "Relay(2459745)" }, "2459745": { uid: 1000, comm: "sleep" },
    "3043279": { uid: 0, comm: "Relay(3043283)" }, "3043283": { uid: 1000, comm: "node" },
    "602": { uid: 1000, comm: "Relay(784191)" },
    "603": { uid: 0, comm: "Relay(6030)" }, "6030": { uid: 0, comm: "bash" },
  };
  const deps = (env: Record<string, string | undefined>) => ({
    env, uid: 1000, list: async () => listing, lstat: async (p: string) => files[p] ?? null,
    procUid: async (pid: string) => procs[pid]?.uid ?? null, comm: async (pid: string) => procs[pid]?.comm ?? null,
  });

  const strip = (rs: Route[]): Route[] => rs.map(({ kind, path }) => (path ? { kind, path } : { kind }));
  test("own WSL_INTEROP, then plain, then borrowed sessions newest first", async () => {
    expect(strip(await interopRoutes(deps({})))).toEqual([{ kind: "plain" }, sess(784190), sess(2459744), sess(3043279)]);
    expect(strip(await interopRoutes(deps({ WSL_INTEROP: "/run/WSL/2459744_interop" }))))
      .toEqual([{ kind: "own", path: "/run/WSL/2459744_interop" }, { kind: "plain" }, sess(784190), sess(3043279)]);
    expect(await interopRoutes({ env: {}, uid: 1000, list: async () => [] })).toEqual([{ kind: "plain" }]);
  });

  test("refused: planted or non-socket files, symlinks, non-root or non-relay pids, root sessions, dead pids, odd names", async () => {
    const paths = (await interopRoutes(deps({}))).map((r) => r.path).filter(Boolean);
    for (const bad of ["1_interop", "2_interop", "600_interop", "601_interop", "602_interop", "603_interop", "604_interop"]) {
      expect(paths).not.toContain(`/run/WSL/${bad}`);
    }
    // a WSL_INTEROP that is not a root socket, or not a /run/WSL name, is not used as "own"
    expect((await interopRoutes(deps({ WSL_INTEROP: "/run/WSL/600_interop" })))[0]).toEqual({ kind: "plain" });
    expect((await interopRoutes(deps({ WSL_INTEROP: "/tmp/../run/WSL/2459744_interop" })))[0]).toEqual({ kind: "plain" });
    // another uid's daemon borrows only its own user's sessions
    expect((await interopRoutes({ ...deps({}), uid: 1001 })).map((r) => r.kind)).toEqual(["plain"]);
  });

  test("a sample tries routes until one reaches Windows (at most 4), then prefers it; reports the route", async () => {
    let now = 0;
    const tried: (string | undefined)[] = [];
    const t = new WindowsThermal({
      run: async (_c, o) => { tried.push(o.interop); return o.interop === sess(2459744).path ? fx("powershell-thermal-zones-laptop.json") : null; },
      clock: () => now, powershell: async () => "/p",
      interop: async () => [{ kind: "plain" }, sess(784190), sess(2459744), sess(3043279)],
    });
    const first = await t.read();
    expect(first.zones).toHaveLength(3);
    expect(first.route).toBe("session");
    expect(tried).toEqual([undefined, sess(784190).path, sess(2459744).path]);
    tried.length = 0;
    now += WIN_SAMPLE_MS;
    await t.read();
    expect(tried).toEqual([sess(2459744).path]);
    const never = new WindowsThermal({ run: async (_c, o) => { tried.push(o.interop); return null; }, clock: () => 0, powershell: async () => "/p", interop: async () => [0, 1, 2, 3, 4, 5, 6].map(sess) });
    tried.length = 0;
    await never.read();
    expect(tried).toHaveLength(4);
  });

  test("Codex r2: the candidate list rotates across failed samples, so a working 5th route is reached", async () => {
    let now = 0;
    const tried: (string | undefined)[] = [];
    const D = sess(4);
    const t = new WindowsThermal({
      run: async (_c, o) => { tried.push(o.interop); return o.interop === D.path ? fx("powershell-thermal-zones-laptop.json") : null; },
      clock: () => now, powershell: async () => "/p", interop: async () => [{ kind: "plain" }, sess(1), sess(2), sess(3), D],
    });
    expect((await t.read()).zones).toBeNull();
    expect(tried).toEqual([undefined, sess(1).path, sess(2).path, sess(3).path]);
    tried.length = 0;
    now += WIN_SAMPLE_MS;
    expect((await t.read()).zones).toHaveLength(3);
    expect(tried).toEqual([D.path]);
    tried.length = 0;
    now += WIN_SAMPLE_MS;
    await t.read();
    expect(tried).toEqual([D.path]); // remembered
  });

  test("an elevated session is refused for good and the next route used; elevated everywhere is a failure with a note", async () => {
    let now = 0;
    const tried: (string | undefined)[] = [];
    const t = new WindowsThermal({
      run: async (_c, o) => { tried.push(o.interop); return o.interop === sess(784190).path ? ELEVATED_MARK : fx("powershell-thermal-zones-laptop.json"); },
      clock: () => now, powershell: async () => "/p", interop: async () => [sess(784190), sess(2459744)],
    });
    expect((await t.read()).route).toBe("session");
    expect(tried).toEqual([sess(784190).path, sess(2459744).path]);
    tried.length = 0;
    now += WIN_SAMPLE_MS;
    await t.read();
    expect(tried).toEqual([sess(2459744).path]);
    let n = 0;
    const all = new WindowsThermal({ run: async () => { n++; return `${ELEVATED_MARK}\r\n`; }, clock: () => now, powershell: async () => "/p", interop: async () => PLAIN });
    for (let i = 0; i < 3; i++) { expect((await all.read()).zones).toBeNull(); now += WIN_SAMPLE_MS; }
    expect((await all.read()).note).toContain("elevated");
    expect(n).toBe(1); // the elevated plain route is refused after its one answer (Codex r3)
  });

  test("elevated sessions don't use up tries (hestia: 4 admin SSH sessions newer than the usable one), but launches are capped", async () => {
    const tried: (string | undefined)[] = [];
    const elevated = [799279, 782592, 780867, 778998].map(sess);
    const t = new WindowsThermal({
      run: async (_c, o) => { tried.push(o.interop); return o.interop === undefined ? null : o.interop === sess(2459744).path ? fx("powershell-thermal-zones-laptop.json") : ELEVATED_MARK; },
      clock: () => 0, powershell: async () => "/p", interop: async () => [{ kind: "plain" }, ...elevated, sess(2459744)],
    });
    const r = await t.read();
    expect(r.zones).toHaveLength(3);
    expect(r.route).toBe("session");
    expect(tried).toHaveLength(6);
    let n = 0;
    const many = new WindowsThermal({ run: async () => { n++; return ELEVATED_MARK; }, clock: () => 0, powershell: async () => "/p", interop: async () => Array.from({ length: 20 }, (_, i) => sess(100 + i)) });
    await many.read();
    expect(n).toBe(MAX_INTEROP_LAUNCHES);
  });

  test("a timeout on any route stops the sample and skips that route for 10 min, never more", async () => {
    let n = 0;
    const plain = new WindowsThermal({ run: async (_c, o) => { n++; o.onTimeout(); return null; }, clock: () => 0, powershell: async () => "/p", interop: async () => [{ kind: "plain" }, sess(5)] });
    await plain.read();
    expect(n).toBe(1);
    let now = 0;
    const tried: (string | undefined)[] = [];
    const borrowed = new WindowsThermal({
      run: async (_c, o) => { tried.push(o.interop); if (o.interop === sess(5).path) { o.onTimeout(); return null; } return null; },
      clock: () => now, powershell: async () => "/p", interop: async () => [sess(5), sess(6)], socketId: async () => "live",
    });
    await borrowed.read();
    now += WIN_SAMPLE_MS;
    await borrowed.read();
    now += WIN_SAMPLE_MS;
    await borrowed.read();
    expect(tried.filter((p) => p === sess(5).path)).toHaveLength(1); // the hung session is skipped for 10 min
    expect(tried.filter((p) => p === sess(6).path)).toHaveLength(2);
    now = 2 * WIN_SAMPLE_MS + WIN_BACKOFF_MS; // past the skip (and the 3-failure backoff)
    expect(now).toBeGreaterThan(WIN_SESSION_TIMEOUT_SKIP_MS);
    await borrowed.read();
    expect(tried.filter((p) => p === sess(5).path)).toHaveLength(2); // then asked again
  });

  test("Codex r3: an elevated answer on the plain or own route is refused too (no elevated PowerShell every sample)", async () => {
    let now = 0;
    let n = 0;
    const t = new WindowsThermal({
      run: async (_c, o) => { n++; return o.interop === sess(9).path ? fx("powershell-thermal-zones-laptop.json") : ELEVATED_MARK; },
      clock: () => now, powershell: async () => "/p", interop: async () => [{ kind: "own", path: "/run/WSL/1234_interop" }, { kind: "plain" }, sess(9)],
    });
    expect((await t.read()).route).toBe("session");
    expect(n).toBe(3);
    n = 0;
    now += WIN_SAMPLE_MS;
    await t.read();
    expect(n).toBe(1); // only the working session; own and plain stay refused
  });

  test("Opus r4: a refusal is kept while its socket exists, even when the socket drops out of the listing", async () => {
    let now = 0;
    let n = 0;
    const E = { ...sess(4242), id: "77:1" };
    let listed: Route[] = [E];
    let onDisk: string | null = "77:1";
    const t = new WindowsThermal({
      run: async () => { n++; return ELEVATED_MARK; }, clock: () => now, powershell: async () => "/p",
      interop: async () => listed, socketId: async (p) => (p === E.path ? onDisk : null),
    });
    await t.read();
    expect(n).toBe(1);
    expect(t.refusedCount).toBe(1);
    listed = []; // hidden: a failed check, or past the listing cap, for one sample
    now += WIN_BACKOFF_MS;
    await t.read();
    expect(t.refusedCount).toBe(1); // kept: the socket itself is unchanged
    listed = [E];
    now += WIN_BACKOFF_MS;
    await t.read();
    expect(n).toBe(1); // back in the listing: still refused, no second elevated PowerShell
    onDisk = "78:2"; // the socket was replaced (a new session at that pid; not listed yet)
    listed = [];
    now += WIN_BACKOFF_MS;
    await t.read();
    expect(t.refusedCount).toBe(0); // the old socket's refusal goes with it
    // and a refusal whose socket is simply gone is dropped too
    const G = { ...sess(4343), id: "90:9" };
    let present = true;
    const g = new WindowsThermal({
      run: async () => ELEVATED_MARK, clock: () => now, powershell: async () => "/p",
      interop: async () => (present ? [G] : []), socketId: async () => (present ? "90:9" : null),
    });
    await g.read();
    expect(g.refusedCount).toBe(1);
    present = false;
    now += WIN_BACKOFF_MS;
    await g.read();
    expect(g.refusedCount).toBe(0);
  });

  test("Opus r4: junk names don't count toward the listing cap", async () => {
    const junk = Array.from({ length: 5000 }, (_, i) => `junk${i}`);
    const files: Record<string, PathInfo> = { "/run/WSL/2459744_interop": { socket: true, symlink: false, uid: 0, mtimeMs: 1 } };
    const procs: Record<string, { uid: number; comm: string }> = { "2459744": { uid: 0, comm: "Relay(2459745)" }, "2459745": { uid: 1000, comm: "sleep" } };
    const routes = await interopRoutes({
      env: {}, uid: 1000, list: async () => [...junk, "2459744_interop"], lstat: async (p) => files[p] ?? null,
      procUid: async (pid) => procs[pid]?.uid ?? null, comm: async (pid) => procs[pid]?.comm ?? null,
    });
    expect(routes.map((r) => r.path)).toContain("/run/WSL/2459744_interop");
    let lstats = 0;
    const many = Array.from({ length: MAX_SOCKET_NAMES + 500 }, (_, i) => `${100_000 + i}_interop`);
    await interopRoutes({ env: {}, uid: 1000, list: async () => many, lstat: async () => { lstats++; return null; } });
    expect(lstats).toBe(MAX_SOCKET_NAMES); // bounded work per listing
  });

  test("Codex r4: three hanging routes ahead of a healthy one can't starve it (30 s polling, 5 s deadlines)", async () => {
    let now = 0;
    const H = [sess(1), sess(2), sess(3)];
    const OK = sess(4);
    const tried: (string | undefined)[] = [];
    const t = new WindowsThermal({
      run: async (_c, o) => {
        tried.push(o.interop);
        if (o.interop !== OK.path) { now += 5_000; o.onTimeout(); return null; }
        return fx("powershell-thermal-zones-laptop.json");
      },
      clock: () => now, powershell: async () => "/p", interop: async () => [...H, OK], socketId: async () => "live",
    });
    let reachedAt: number | null = null;
    while (now < 80 * 60_000 && reachedAt === null) {
      const r = await t.read();
      if (r.zones) reachedAt = now;
      now += 30_000;
    }
    expect(reachedAt).not.toBeNull();
    expect(reachedAt as number).toBeLessThan(20 * 60_000);
    expect(tried.filter((p) => p === OK.path).length).toBeGreaterThan(0);
  });

  test("Codex r4: a refused session hidden by a truncated listing keeps its refusal and isn't relaunched", async () => {
    let now = 0;
    const all: Route[] = Array.from({ length: 258 }, (_, i) => ({ ...sess(30_000 + i), id: `x${i}` }));
    let visible = all.slice(0, 256);
    const launched: (string | undefined)[] = [];
    const t = new WindowsThermal({
      run: async (_c, o) => { launched.push(o.interop); return ELEVATED_MARK; }, clock: () => now, powershell: async () => "/p",
      interop: async () => visible, socketId: async (p) => all.find((r) => r.path === p)?.id ?? null, // every socket stays alive
    });
    for (let i = 0; i < 40 && t.refusedCount < 256; i++) { await t.read(); now += WIN_BACKOFF_MS; }
    expect(t.refusedCount).toBe(256);
    visible = all.slice(2); // two new sessions push two refused ones out of the (truncated) listing; none ended
    launched.length = 0;
    now += WIN_BACKOFF_MS;
    await t.read();
    expect(t.refusedCount).toBe(256); // nothing pruned: the hidden sockets still exist
    expect(launched).toEqual([]); // full store: the two new ones are not launched (fail closed)
    visible = all.slice(0, 256); // the hidden two come back unchanged
    now += WIN_BACKOFF_MS;
    await t.read();
    expect(launched).toEqual([]); // still refused: no second elevated PowerShell
  });

  // Opus r5 churn probe (scratchpad opus-temp5-probe/tests/probe-rot.test.ts): a short-lived session keeps appearing
  // ahead of an older healthy one, hangs when asked, and is gone by the next sample.
  const churn = async (idOf: (gen: number) => string | undefined, healthyId: string | undefined) => {
    let now = 0;
    let gen = 100;
    const healthy: Route = { ...sess(5), ...(healthyId ? { id: healthyId } : {}) };
    let cur: Route = { ...sess(gen), ...(idOf(gen) ? { id: idOf(gen) } : {}) };
    const listing = (): Route[] => [{ kind: "plain" }, cur, healthy];
    const t = new WindowsThermal({
      clock: () => now, powershell: async () => "/p", interop: async () => listing(),
      socketId: async (p) => listing().find((r) => r.path === p)?.id ?? (p === cur.path ? "live" : null),
      run: async (_c, o) => {
        if (!o.interop) return null; // plain fails fast
        if (o.interop === healthy.path) return fx("powershell-thermal-zones-laptop.json");
        o.onTimeout(); // the short-lived session hangs, then ends; a new one appears ahead
        gen += 1;
        cur = { ...sess(gen), ...(idOf(gen) ? { id: idOf(gen) } : {}) };
        return null;
      },
    });
    let samples = 0;
    for (let tick = 0; tick <= 240 * 2; tick++) {
      now = tick * 30_000;
      const before = t.failures;
      const r = await t.read();
      if (t.failures !== before || r.zones) samples += 1;
      if (r.zones) return samples;
    }
    return null;
  };

  test("Opus r5: when the cursor's session has left the listing, the next sample continues after it (mtime order)", async () => {
    // real-shaped ids: newer sessions have larger mtimes and are listed first
    const samples = await churn((g) => `${g}:${1_000_000 + g}`, "5:1000");
    expect(samples).not.toBeNull();
    expect(samples as number).toBeLessThanOrEqual(2);
  });

  test("Opus r5: ... and by its old position when ids carry no mtime", async () => {
    const samples = await churn(() => undefined, undefined);
    expect(samples).not.toBeNull();
    expect(samples as number).toBeLessThanOrEqual(2);
  });

  test("Opus r5: prune keeps a refusal when lstat fails for any reason but 'absent'", async () => {
    let now = 0;
    let n = 0;
    const E = { ...sess(6060), id: "60:1" };
    let answer: () => Promise<string | null> = async () => "60:1";
    const t = new WindowsThermal({
      run: async () => { n++; return ELEVATED_MARK; }, clock: () => now, powershell: async () => "/p",
      interop: async () => [E], socketId: () => answer(),
    });
    await t.read();
    expect(t.refusedCount).toBe(1);
    answer = async () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
    now += WIN_BACKOFF_MS;
    await t.read();
    expect(t.refusedCount).toBe(1); // unknown: kept
    expect(n).toBe(1); // and not launched again
    answer = async () => null; // definitely absent
    now += WIN_BACKOFF_MS;
    await t.read();
    expect(n).toBe(2); // the refusal went; E is still listed here (a stub), so it is asked again and refused again
  });

  test("Opus r5: socketIdentity: absent is null, another file is a changed identity, an unreadable path throws", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, realpathSync } = await import("node:fs");
    const d = mkdtempSync(join(realpathSync(tmpdir()), "walkie-sockid-"));
    try {
      expect(await socketIdentity(join(d, "nope_interop"))).toBeNull(); // ENOENT
      writeFileSync(join(d, "file"), "x");
      expect(await socketIdentity(join(d, "file", "under"))).toBeNull(); // ENOTDIR
      expect(await socketIdentity(join(d, "file"))).toMatch(/^not-a-socket:\d+$/); // something else is there now
      const locked = join(d, "locked");
      mkdirSync(locked);
      writeFileSync(join(locked, "s"), "x");
      chmodSync(locked, 0o000);
      if (process.getuid?.() !== 0) await expect(socketIdentity(join(locked, "s"))).rejects.toThrow(); // EACCES: unknown
      chmodSync(locked, 0o755);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("Codex r3: a full refusal store fails closed: an unrecorded session is not launched, a refusal is never dropped", async () => {
    let now = 0;
    const launched: (string | undefined)[] = [];
    let routes: Route[] = Array.from({ length: 256 }, (_, i) => ({ ...sess(20_000 + i), id: `i${i}` }));
    const t = new WindowsThermal({
      run: async (_c, o) => { launched.push(o.interop); return ELEVATED_MARK; }, clock: () => now, powershell: async () => "/p", interop: async () => routes,
      socketId: async (p) => routes.find((r) => r.path === p)?.id ?? null, // a socket exists while it is listed here
    });
    for (let i = 0; i < 40 && t.refusedCount < 256; i++) { await t.read(); now += WIN_BACKOFF_MS; }
    expect(t.refusedCount).toBe(256);
    // every one of the 256 is still listed (still live), and a 257th elevated session appears
    routes = [{ ...sess(99_999), id: "new" }, ...routes];
    launched.length = 0;
    now += WIN_BACKOFF_MS;
    await t.read();
    expect(launched).toEqual([]); // nothing launched: no room to record a refusal, and every recorded one holds
    expect(t.refusedCount).toBe(256);
    // one session ends: pruned, room for the new one
    routes = routes.slice(0, -1);
    now += WIN_BACKOFF_MS;
    await t.read();
    expect(launched).toEqual([sess(99_999).path]);
  });

  test("Opus r3: a remembered route is used only while it is still in the freshly verified list", async () => {
    let now = 0;
    const calls: (string | undefined)[] = [];
    let routes: Route[] = [{ kind: "plain" }, { ...sess(500), id: "11:100" }];
    const t = new WindowsThermal({
      run: async (_c, o) => { calls.push(o.interop); return o.interop ? fx("powershell-thermal-zones-laptop.json") : null; },
      clock: () => now, powershell: async () => "/p", interop: async () => routes,
    });
    await t.read();
    expect(calls).toEqual([undefined, sess(500).path]);
    // the socket is no longer verified (gone, user-owned, relay child now another uid): not used on memory
    routes = [{ kind: "plain" }];
    calls.length = 0;
    now += WIN_SAMPLE_MS;
    expect((await t.read()).zones).toHaveLength(3); // kept zones (within 3 min), but no call to the dropped socket
    expect(calls).toEqual([undefined]);
    // Codex r3 probe: the candidate list becomes empty; the remembered socket is not called
    routes = [];
    calls.length = 0;
    now += WIN_SAMPLE_MS;
    await t.read();
    expect(calls).toEqual([]);
    // same path, different inode (replaced): a new route, not the remembered one
    routes = [{ kind: "plain" }, { ...sess(500), id: "12:200" }];
    calls.length = 0;
    now += WIN_SAMPLE_MS;
    await t.read();
    expect(calls.at(-1)).toBe(sess(500).path); // reached as a freshly verified route (rotation), and it answers
    expect((await t.read()).route).toBe("session");
  });

  test("Opus r3: refusals are keyed by socket identity and pruned when the socket goes", async () => {
    let now = 0;
    let routes: Route[] = [{ ...sess(777), id: "1:1" }];
    let elevated = true;
    const t = new WindowsThermal({
      run: async () => (elevated ? ELEVATED_MARK : fx("powershell-thermal-zones-laptop.json")),
      clock: () => now, powershell: async () => "/p", interop: async () => routes,
      socketId: async (p) => routes.find((r) => r.path === p)?.id ?? null,
    });
    await t.read();
    expect(t.refusedCount).toBe(1);
    // pid reused by a new, non-elevated session: same path, new inode -> asked again, and it works
    elevated = false;
    routes = [{ ...sess(777), id: "2:2" }];
    now += WIN_BACKOFF_MS;
    expect((await t.read()).zones).toHaveLength(3);
    expect(t.refusedCount).toBe(0); // the old socket's refusal was pruned
  });

  test("a remembered route is forgotten after one failure or unparseable output", async () => {
    let now = 0;
    let bad: string | null = null;
    const tried: (string | undefined)[] = [];
    const r = new WindowsThermal({
      run: async (_c, o) => { tried.push(o.interop); return o.interop === sess(7).path ? bad : null; },
      clock: () => now, powershell: async () => "/p", interop: async () => [sess(8), sess(7)],
    });
    bad = fx("powershell-thermal-zones-laptop.json");
    tried.length = 0;
    await r.read();
    expect(tried).toEqual([sess(8).path, sess(7).path]);
    bad = "garbage";
    tried.length = 0;
    now += WIN_SAMPLE_MS;
    await r.read();
    expect(tried).toEqual([sess(7).path, sess(8).path]); // tried first, failed, the others follow
    bad = fx("powershell-thermal-zones-laptop.json");
    tried.length = 0;
    now += WIN_SAMPLE_MS;
    await r.read();
    expect(tried).toEqual([sess(7).path]); // no longer remembered; rotation continues past the routes just tried, and 7 answers
  });
});

describe("the Linux reader on WSL", () => {
  const noTemp: Reading = { mem: MEM, temp_c: null };
  test("no Linux sensor + WSL: the hottest Windows zone, with every zone", async () => {
    const r = await linuxReader({
      read: async () => noTemp, wsl: async () => true,
      windows: async () => ({ zones: parseWindowsZones(fx("powershell-thermal-zones-laptop.json")) }),
    })();
    expect(r.temp_c).toBe(86.1);
    expect(r.temp_zones?.map((z) => z.name)).toEqual(["TZ00", "THM2", "THRM"]);
    expect(r.mem).toEqual(MEM);
  });

  test("a Linux sensor wins and Windows is never asked; outside WSL Windows is never asked", async () => {
    let asked = 0;
    const windows = async () => { asked++; return { zones: [{ name: "X", c: 99 }] }; };
    expect((await linuxReader({ read: async () => ({ mem: MEM, temp_c: 55 }), wsl: async () => true, windows })()).temp_c).toBe(55);
    let detected = 0;
    const native = linuxReader({ read: async () => noTemp, wsl: async () => { detected++; return false; }, windows });
    expect((await native()).temp_c).toBeNull();
    await native();
    expect(asked).toBe(0);
    expect(detected).toBe(1); // detection runs once
  });

  test("no zones: temperature stays null and the backoff note is passed on", async () => {
    const r = await linuxReader({ read: async () => noTemp, wsl: async () => true, windows: async () => ({ zones: null, note: "backing off" }) })();
    expect(r.temp_c).toBeNull();
    expect(r.temp_zones).toBeUndefined();
    expect(r.note).toBe("backing off");
    const failing = await linuxReader({ read: async () => noTemp, wsl: async () => true, windows: async () => { throw new Error("x"); } })();
    expect(failing.temp_c).toBeNull();
  });
});

describe("NVIDIA GPU temperature", () => {
  test("nvidia-smi memory.free,temperature.gpu (recorded on almond): free VRAM and °C per GPU", () => {
    expect(parseGpuNow(fx("nvidia-smi-free-temp-rtx5070.txt"), 1)).toEqual({ free: [11689 * MiB], temp: [34] });
    expect(parseGpuNow("7891, 61\n2048, 70\n", 2)).toEqual({ free: [7891 * MiB, 2048 * MiB], temp: [61, 70] });
  });

  test("[N/A], implausible or garbage temperatures are null; a count mismatch or no output is nothing", () => {
    expect(parseGpuNow("7891, [N/A]\n", 1)).toEqual({ free: [7891 * MiB], temp: null });
    expect(parseGpuNow("7891, [N/A]\n100, 55\n", 2)).toEqual({ free: [7891 * MiB, 100 * MiB], temp: [null, 55] });
    expect(parseGpuNow("7891, 0\n", 1).temp).toBeNull();
    expect(parseGpuNow("7891, 400\n", 1).temp).toBeNull();
    expect(parseGpuNow("7891, 6e1\n", 1).temp).toBeNull();
    expect(parseGpuNow("7891\n", 1)).toEqual({ free: [7891 * MiB], temp: null });
    expect(parseGpuNow("7891, 50\n", 2)).toEqual({ free: null, temp: null });
    expect(parseGpuNow(null, 1)).toEqual({ free: null, temp: null });
    expect(parseGpuNow("NVIDIA-SMI has failed\n", 1)).toEqual({ free: null, temp: null });
  });

  test("one nvidia-smi call per sample, at WSL's path", async () => {
    const argvs: string[][] = [];
    const r = await readGpuNow(1, { exists: async (p) => p === "/usr/lib/wsl/lib/nvidia-smi", run: async (cmd) => { argvs.push(cmd); return "11689, 34\n"; } });
    expect(r).toEqual({ free: [11689 * MiB], temp: [34] });
    expect(argvs).toEqual([["/usr/lib/wsl/lib/nvidia-smi", "--query-gpu=memory.free,temperature.gpu", "--format=csv,noheader,nounits"]]);
    expect(await readGpuNow(0, { exists: async () => true, run: async () => "1, 2\n" })).toEqual({ free: null, temp: null });
    expect(await readGpuNow(1, { exists: async () => false, run: async () => "1, 2\n" })).toEqual({ free: null, temp: null });
  });
});

describe("machine temperature source", () => {
  test("CPU/board when there is one, else the hottest GPU, else none", () => {
    expect(machineTemp(60, [70])).toEqual({ temp_c: 60, temp_src: "cpu" });
    expect(machineTemp(null, [null, 41, 38])).toEqual({ temp_c: 41, temp_src: "gpu" });
    expect(machineTemp(null, [null])).toEqual({ temp_c: null });
    expect(machineTemp(null, null)).toEqual({ temp_c: null });
  });

  const accel = { chip: "AMD Ryzen", unified: false, gpu_limit: null, gpus: [{ name: "NVIDIA GeForce RTX 5070", vram: 12 * GiB }] };

  test("a desktop under WSL (almond): no zones, the GPU stands in and is labelled gpu", async () => {
    const published: MachineStats[] = [];
    const s = new MachineStatsSampler((x) => published.push(x), createLogger({}), {
      read: async () => ({ mem: MEM, temp_c: null }), readAccel: async () => accel,
      readGpu: async () => ({ free: [11 * GiB], temp: [34] }), clock: () => 1_000,
    });
    expect(await s.tick()).toBe(true);
    expect(published[0]).toMatchObject({ temp_c: 34, temp_src: "gpu", gpu_temp: [34], gpu_free: [11 * GiB] });
    expect(published[0]!.temp_zones).toBeUndefined();
    expect(MachineStats.parse(published[0])).toEqual(published[0]!);
  });

  test("a laptop under WSL (hestia): the hottest zone, its zones, and the GPU temperature alongside", async () => {
    const published: MachineStats[] = [];
    const zones = parseWindowsZones(fx("powershell-thermal-zones-laptop.json"))!;
    const s = new MachineStatsSampler((x) => published.push(x), createLogger({}), {
      read: async () => ({ mem: MEM, temp_c: 86.1, temp_zones: zones }), readAccel: async () => accel,
      readGpu: async () => ({ free: [7 * GiB], temp: [61] }), clock: () => 1_000,
    });
    await s.tick();
    expect(published[0]).toMatchObject({ temp_c: 86.1, temp_src: "cpu", temp_zones: zones, gpu_temp: [61] });
    expect(MachineStats.parse(published[0])).toEqual(published[0]!);
  });

  test("the route that produced the zones is published with them (a borrowed session says so)", async () => {
    const zones = parseWindowsZones(fx("powershell-thermal-zones-laptop.json"))!;
    const r = await linuxReader({ read: async () => ({ mem: MEM, temp_c: null }), wsl: async () => true, windows: async () => ({ zones, route: "session" }) })();
    expect(r.temp_route).toBe("session");
    const published: MachineStats[] = [];
    const s = new MachineStatsSampler((x) => published.push(x), createLogger({}), { read: async () => r, readAccel: async () => null, clock: () => 1 });
    await s.tick();
    expect(published[0]).toMatchObject({ temp_c: 86.1, temp_src: "cpu", temp_route: "session" });
    expect(MachineStats.parse(published[0]).temp_route).toBe("session");
    expect(MachineStats.parse({ at: 1, mem: null, temp_c: 40, temp_route: "/run/WSL/1_interop" }).temp_route).toBeUndefined();
  });

  test("the source changing, or the GPU temperature moving ≥ 2 °C, publishes", () => {
    const prev: MachineStats = { at: 0, mem: MEM, temp_c: 50, temp_src: "cpu", gpu_temp: [40] };
    expect(shouldPublish(prev, { mem: MEM, temp_c: 50, temp_src: "cpu", gpu_temp: [41] }, 1)).toBe(false);
    expect(shouldPublish(prev, { mem: MEM, temp_c: 50, temp_src: "gpu", gpu_temp: [41] }, 1)).toBe(true);
    expect(shouldPublish(prev, { mem: MEM, temp_c: 50, temp_src: "cpu", gpu_temp: [42] }, 1)).toBe(true);
    expect(shouldPublish(prev, { mem: MEM, temp_c: 50, temp_src: "cpu", gpu_temp: null }, 1)).toBe(true);
  });

  test("oversized peer arrays and strings are refused before any element is looked at (Codex r1)", () => {
    let touched = 0;
    const spy = { get name() { touched++; return "Z"; }, get c() { touched++; return 40; } };
    const base = { at: 1, mem: null, temp_c: 40 };
    const big = MachineStats.parse({ ...base, temp_zones: Array(300_000).fill(spy), gpu_temp: Array(300_000).fill(40), gpu_free: Array(300_000).fill(1) });
    expect(big.temp_zones).toBeUndefined();
    expect(big.gpu_temp).toBeUndefined();
    expect(big.gpu_free).toBeUndefined();
    expect(big.at).toBe(1);
    expect(touched).toBe(0);
    MachineStats.parse({ ...base, temp_zones: [spy] });
    expect(touched).toBe(2); // within the cap, elements are validated as before
    const accel = { chip: "x".repeat(1_000_000), unified: false, gpu_limit: null, gpus: Array(100_000).fill({ name: "G", vram: 1 }) };
    expect(MachineStats.parse({ ...base, accel }).accel).toBeUndefined();
    expect(MachineStats.parse({ ...base, temp_zones: [{ name: "x".repeat(1_000_000), c: 40 }] }).temp_zones).toBeUndefined();
    expect(MachineStats.parse({ ...base, accel: { chip: "Apple M5", unified: true, gpu_limit: null, gpus: [] } }).accel?.chip).toBe("Apple M5");
  });

  test("the wire schema: new fields optional, a malformed one dropped without dropping the stats", () => {
    const base = { at: 1, mem: null, temp_c: 40 };
    expect(MachineStats.parse(base).temp_src).toBeUndefined();
    expect(MachineStats.parse({ ...base, temp_src: "board" }).temp_src).toBeUndefined();
    expect(MachineStats.parse({ ...base, temp_zones: [{ name: "TZ00", c: 500 }] }).temp_zones).toBeUndefined();
    expect(MachineStats.parse({ ...base, temp_zones: Array(17).fill({ name: "Z", c: 40 }) }).temp_zones).toBeUndefined();
    expect(MachineStats.parse({ ...base, temp_zones: [{ name: "bad\n", c: 40 }] }).temp_zones).toBeUndefined();
    expect(MachineStats.parse({ ...base, gpu_temp: [null, 50] }).gpu_temp).toEqual([null, 50]);
    expect(MachineStats.parse({ ...base, gpu_temp: ["hot"] }).gpu_temp).toBeUndefined();
    const full = { ...base, temp_src: "gpu", temp_zones: [{ name: "TZ00", c: 40 }], gpu_temp: [40] };
    expect(PeerVvRes.parse({ node: "n", vv: {}, ts: 1, stats: full }).stats).toEqual(full as MachineStats);
  });

  test("walkie who labels a GPU-sourced temperature", () => {
    const node = { node_id: "a1b2c3d4e5f60718", handle: "alex", hostname: "almond", ip: "100.64.0.1", online: true, last_seen: 1, rtt_ms: 3, self: false, sync: { behind: 0, last_sync: 1 } };
    expect(statsDetail({ ...node, stats: { at: 1, mem: null, temp_c: 34, temp_src: "gpu" } } as NodeView)).toBe("mem n/a · 34 °C GPU");
    expect(statsDetail({ ...node, stats: { at: 1, mem: null, temp_c: 86.1, temp_src: "cpu" } } as NodeView)).toBe("mem n/a · 86 °C");
  });
});
