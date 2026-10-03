// Parsing of lsof unix-socket names for the seat helper's caller check (WALK-104, WALK-106).
//
// macOS: lsof field output (`lsof -nP -a -p <pid> -Ffnti`) puts the bound socket's path alone in the NAME
// field, and names an accepted connection the same way (no inode). A connected peer is `->0x` plus a kernel
// address, never the path. The synthetic peer line below is `->` plus the path, which is also not a bound socket.
// The fixtures further down keep only the unix-socket lines from a macOS lsof capture.
//
// Linux sample: captured on this host from lsof 4.95.0 (`lsof -nP -a -p <pid> -Ffnti`) against a Bun unix
// listener. The NAME field is "<path> type=STREAM". "(LISTEN)" and "(CONNECTED)" appear only in lsof's default
// columns, not in -F, so a listening socket and an accepted connection on the same path look the same there.
// The listener is told apart by /proc/net/unix Flags bit 16 (0x10000) on this kernel (Linux 6.8); the connected
// line for the same path has Flags 0 and a different inode. The inode is the one named socket:[…] in
// /proc/<pid>/fd, not the inode stat() reports for the socket file. Paths below are sample paths, not a live home.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { acceptsPathNamedBoundSockets, lsofBoundSocketPath, lsofHoldsBoundSocket, mountDeviceForPath, parseLsofOpenFiles, procNetSocketsFromText, unixDiagVfsMatchesFile } from "../../src/daemon/seats/admin-sys.ts";

const MAC_BOUND = "/private/tmp/walkie-sample/walkie.sock";
/** Documented macOS lsof -F shape: the path is the whole NAME; the peer line starts with "->". */
const MAC_LSOF = [
  "p4321",
  "f3",
  "tunix",
  "i88001",
  `n${MAC_BOUND}`,
  "f4",
  "tREG",
  "i88002",
  `n${MAC_BOUND}.lock`,
  "f5",
  "tunix",
  "i88003",
  `n->${MAC_BOUND}`,
  "",
].join("\n");

/** Linux lsof 4.95.0 -F shape, from a listener that had also accepted one connection. */
const LINUX_LSOF = [
  "p4242",
  "f13",
  "tunix",
  "i40041449",
  "n/tmp/walkie-sample/walkie.sock type=STREAM",
  "f17",
  "tunix",
  "i40042056",
  "n/tmp/walkie-sample/walkie.sock type=STREAM",
  "f14",
  "tunix",
  "i40041451",
  "ntype=STREAM",
  "f12",
  "tREG",
  "i28836449",
  "n/tmp/walkie-sample/walkie.sock.lock",
  "",
].join("\n");

const PROC_NET_UNIX = [
  "Num       RefCount Protocol Flags    Type St Inode Path",
  "0000000000000000: 00000002 00000000 00010000 0001 01 40041449 /tmp/walkie-sample/walkie.sock",
  "0000000000000000: 00000003 00000000 00000000 0001 03 40042056 /tmp/walkie-sample/walkie.sock",
  "0000000000000000: 00000002 00000000 00010000 0001 01 40050001 /tmp/walkie-sample/other.sock",
  "",
].join("\n");

test("macOS lsof: the NAME column is the bound path, and a -> peer is not", () => {
  const files = parseLsofOpenFiles(MAC_LSOF, 4321);
  expect(files).not.toBeNull();
  expect(lsofBoundSocketPath(MAC_BOUND)).toBe(MAC_BOUND);
  expect(lsofBoundSocketPath(`->${MAC_BOUND}`)).toBeNull();
  expect(lsofHoldsBoundSocket(files ?? [], MAC_BOUND)).toBe(true);
  const peerOnly = (files ?? []).filter((f) => f.fd !== "3");
  expect(lsofHoldsBoundSocket(peerOnly, MAC_BOUND)).toBe(false);
  expect(parseLsofOpenFiles(MAC_LSOF, 1)).toBeNull();
});

test("Linux lsof: strip the type= suffix before hashing the socket path", () => {
  const raw = "/tmp/walkie-sample/walkie.sock type=STREAM";
  const path = lsofBoundSocketPath(raw);
  expect(path).toBe("/tmp/walkie-sample/walkie.sock");
  expect(createHash("sha256").update(raw).digest("hex")).not.toBe(createHash("sha256").update(path ?? "").digest("hex"));
  expect(lsofBoundSocketPath("type=STREAM")).toBeNull();
  expect(lsofBoundSocketPath("/tmp/walkie-sample/walkie.sock (deleted)")).toBe("/tmp/walkie-sample/walkie.sock");
  expect(lsofBoundSocketPath("/tmp/walkie-sample/walkie.sock (deleted) type=STREAM")).toBe("/tmp/walkie-sample/walkie.sock");
  expect(lsofBoundSocketPath("/tmp/walkie-sample/walkie.sock type=STREAM (deleted)")).toBe("/tmp/walkie-sample/walkie.sock");
  expect(lsofBoundSocketPath("/tmp/walkie-sample/walkie.sock (LISTEN)")).toBe("/tmp/walkie-sample/walkie.sock");
  expect(lsofBoundSocketPath("/tmp/walkie-sample/walkie.sock (CONNECTED)")).toBeNull();
  expect(lsofBoundSocketPath("/tmp/walkie-sample/walkie.sock type=STREAM (CONNECTED)")).toBeNull();
  const files = parseLsofOpenFiles(LINUX_LSOF, 4242);
  expect(lsofHoldsBoundSocket(files ?? [], "/tmp/walkie-sample/walkie.sock")).toBe(true);
  const nameless = (files ?? []).filter((f) => f.fd === "14");
  expect(lsofHoldsBoundSocket(nameless, "/tmp/walkie-sample/walkie.sock")).toBe(false);
});

test("proc net fallback keeps the path bytes and the listening flag for the inodes it was given", () => {
  // The kernel prints one space after the inode, then the path bytes. The fallback parser is what
  // the live check uses; it does not collapse spaces and it does not decide which path matches.
  const doubled = "/tmp/walkie  sample/walkie.sock";
  const trailing = "/tmp/walkie-sample/walkie.sock ";
  const header = "Num       RefCount Protocol Flags    Type St Inode Path\n";
  const line = (inode: string, flags: string, path: string) =>
    `0000000000000000: 00000002 00000000 ${flags} 0001 01 ${inode} ${path}\n`;
  const records = procNetSocketsFromText(PROC_NET_UNIX, new Set([40041449, 40042056, 40050001]));
  expect(records.get(40041449)).toEqual({ state: 10, name: "/tmp/walkie-sample/walkie.sock", vfs: null, uid: null });
  expect(records.get(40042056)).toEqual({ state: 0, name: "/tmp/walkie-sample/walkie.sock", vfs: null, uid: null });
  expect(records.get(40050001)?.name).toBe("/tmp/walkie-sample/other.sock");
  expect(procNetSocketsFromText(header, new Set([40041449])).size).toBe(0);
  const spaced = procNetSocketsFromText(header + line("40041449", "00010000", doubled), new Set([40041449]));
  expect(spaced.get(40041449)?.name).toBe(doubled);
  expect(spaced.get(40041449)?.name).not.toBe("/tmp/walkie sample/walkie.sock");
  expect(procNetSocketsFromText(header + line("40041450", "00010000", trailing), new Set([40041450])).get(40041450)?.name).toBe(trailing);
  // A long bind is stored as /proc/self/fd/<n>/<name>. That string is not resolved here, and there is no file identity.
  const procFd = header + line("40041449", "00010000", "/proc/self/fd/12/walkie.sock");
  expect(procNetSocketsFromText(procFd, new Set([40041449])).get(40041449)).toEqual({
    state: 10, name: "/proc/self/fd/12/walkie.sock", vfs: null, uid: null,
  });
});

test("proc net fallback: a newline in a bind path, or a unix line that names a tcp inode, cannot be decided", () => {
  const header = "Num       RefCount Protocol Flags    Type St Inode Path\n";
  // A bind path that contains a newline is two lines of this table. The second line names the same inode.
  const splitByNewline = header
    + "0000000000000000: 00000002 00000000 00000000 0001 01 40041449 /tmp/a\n"
    + "0000000000000000: 00000002 00000000 00010000 0001 01 40041449 /tmp/walkie-sample/walkie.sock\n";
  expect(() => procNetSocketsFromText(splitByNewline, new Set([40041449]))).toThrow("could not be checked");
  // The forged line is the only unix line for a TCP inode, so a duplicate-inode guard would not see it.
  const forgedTcp = header + "0000000000000000: 00000002 00000000 00010000 0001 01 555 /tmp/walkie-sample/walkie.sock\n";
  expect(() => procNetSocketsFromText(forgedTcp, new Set([555]), new Set([555]))).toThrow("could not be checked");
  // The daemon's own TCP socket has no unix line at all. It is not a forgery and must not make the check busy.
  expect(procNetSocketsFromText(header, new Set([555]), new Set([555])).size).toBe(0);
  const genuine = header + "0000000000000000: 00000002 00000000 00010000 0001 01 40041449 /tmp/walkie-sample/walkie.sock\n";
  const withTcp = procNetSocketsFromText(genuine, new Set([40041449, 555]), new Set([555]));
  expect(withTcp.get(40041449)?.state).toBe(10);
  expect(withTcp.has(555)).toBe(false);
  // An inode the caller did not ask about stays out of the result, TCP table or not.
  expect(procNetSocketsFromText(forgedTcp, new Set([40041449]), new Set([555])).size).toBe(0);
  // A path with a carriage return is not a trustworthy path: the line is skipped, not read as a shorter path.
  const withCr = header + "0000000000000000: 00000002 00000000 00010000 0001 01 40041449 /tmp/walkie-sample/walkie.sock\rx\n";
  expect(procNetSocketsFromText(withCr, new Set([40041449])).size).toBe(0);
});

// Unix-socket lines only, from a macOS lsof -F capture. The bound name is a sample under /tmp.
// A peer is `->0x` plus an address. The cwd and library lines from that capture are not in the fixture.
const MAC_SOCK = "/tmp/rv106.0ROY/s.sock";
const macLsof = (name: string) => readFileSync(join(import.meta.dir, "../fixtures", name), "utf8");

test("macOS lsof sample: the binder has one or more path-named sockets, a client has none", () => {
  const server = parseLsofOpenFiles(macLsof("mac-lsof-server.txt"), 22244);
  const client = parseLsofOpenFiles(macLsof("mac-lsof-client.txt"), 22246);
  expect(server).not.toBeNull();
  expect(client).not.toBeNull();
  // The listening socket and the accepted connection are both named with the path, and neither has an inode.
  const serverPaths = (server ?? []).filter((f) => f.type === "unix" && f.name === MAC_SOCK);
  expect(serverPaths.map((f) => f.fd)).toEqual(["3", "6"]);
  expect(serverPaths.every((f) => f.inode === "")).toBe(true);
  // Requiring exactly one path-named socket refuses this daemon as soon as a client is connected.
  expect(acceptsPathNamedBoundSockets(server ?? [], MAC_SOCK)).toBe(true);
  const clientUnix = (client ?? []).filter((f) => f.type === "unix");
  expect(clientUnix.length).toBeGreaterThan(0);
  expect(clientUnix.every((f) => /^->0x[0-9a-f]+$/.test(f.name))).toBe(true);
  expect(acceptsPathNamedBoundSockets(client ?? [], MAC_SOCK)).toBe(false);
  expect(lsofHoldsBoundSocket(client ?? [], MAC_SOCK)).toBe(false);
});

test("unix_diag device is the mount's major:minor, not stat's anonymous device", () => {
  // A btrfs subvolume: stat() reports an anonymous device (here 0:99) while unix_diag stores the
  // superblock device from the mount (0:55 on /, 259:2 on /home). Overlay and a space in the mount
  // point are the same kind of split. The longer mount point wins, and \040 is a space.
  const mountinfo = [
    "36 1 0:55 / / rw - btrfs /dev/sda1 rw",
    "37 36 259:2 / /home rw - btrfs /dev/sda1 rw",
    "38 36 0:40 / /home/a\\040b rw - overlay overlay rw",
    "",
  ].join("\n");
  expect(mountDeviceForPath(mountinfo, "/tmp/walkie.sock")).toEqual({ major: 0, minor: 55 });
  expect(mountDeviceForPath(mountinfo, "/home/olive/walkie.sock")).toEqual({ major: 259, minor: 2 });
  expect(mountDeviceForPath(mountinfo, "/home2/walkie.sock")).toEqual({ major: 0, minor: 55 });
  expect(mountDeviceForPath(mountinfo, "/home/a b/walkie.sock")).toEqual({ major: 0, minor: 40 });
  expect(mountDeviceForPath(mountinfo, "walkie.sock")).toBeNull();
  // Two mounts on the same directory: mountinfo lists the lower one first. The later line is the one on top.
  const stacked = [
    "36 1 0:55 / / rw - ext4 /dev/sda1 rw",
    "90 36 0:99 / / rw - overlay overlay rw",
    "",
  ].join("\n");
  expect(mountDeviceForPath(stacked, "/tmp/walkie.sock")).toEqual({ major: 0, minor: 99 });
  const stackedThree = [
    "36 1 0:55 / /srv rw - ext4 /dev/sda1 rw",
    "90 36 0:99 / /srv rw - overlay overlay rw",
    "91 36 0:77 / /srv rw - tmpfs tmpfs rw",
    "",
  ].join("\n");
  expect(mountDeviceForPath(stackedThree, "/srv/w/walkie.sock")).toEqual({ major: 0, minor: 77 });
  // A later, shorter mount does not replace a longer prefix that still matches.
  const laterShorter = [
    "37 36 259:2 / /home rw - btrfs /dev/sda1 rw",
    "36 1 0:55 / / rw - btrfs /dev/sda1 rw",
    "",
  ].join("\n");
  expect(mountDeviceForPath(laterShorter, "/home/olive/walkie.sock")).toEqual({ major: 259, minor: 2 });
  const fileIno = 40041449;
  const superDev = 55;
  const anonDev = 99;
  const mount = { major: 0, minor: 55 };
  expect(unixDiagVfsMatchesFile({ ino: fileIno, dev: superDev }, fileIno, mount)).toBe(true);
  expect(unixDiagVfsMatchesFile({ ino: fileIno, dev: anonDev }, fileIno, mount)).toBe(false);
  expect(unixDiagVfsMatchesFile({ ino: fileIno + 1, dev: superDev }, fileIno, mount)).toBe(false);
  expect(unixDiagVfsMatchesFile({ ino: fileIno, dev: anonDev }, fileIno, null)).toBe(true);
  expect(unixDiagVfsMatchesFile({ ino: 1, dev: superDev }, 0x1_0000_0000, mount)).toBe(false);
});
