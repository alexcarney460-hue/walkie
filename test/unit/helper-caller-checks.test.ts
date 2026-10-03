// WALK-104 / WALK-106: the root helper may treat a process as the registered daemon only when that
// process itself holds the daemon's listening socket, not merely a lock file the real daemon has flocked.
// Real processes, no sudo. On this Linux host `lsof -F` names a unix socket "<path> type=STREAM".
import { expect, test, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { callingSeatDaemon, callingTalkieClaimDaemon, callingTalkieDaemon, checkSeatInstance, holdsSeatInstanceLock, procNetSockets, setUnixDiagErrnoForTest, setUnixDiagUidForTest, unixDiagUidsForTest } from "../../src/daemon/seats/admin-sys.ts";
import { seatRegistrationText, type SeatRegistration } from "../../src/daemon/seats/instance.ts";

const ME = process.getuid?.() ?? 0;
const LOCK_MOD = join(import.meta.dir, "../../src/daemon/instance-lock.ts");
const dirs: string[] = [];
type Proc = Bun.Subprocess<"ignore", "pipe", "pipe">;
const kids: Proc[] = [];
const extraPids: number[] = [];

afterEach(async () => {
  setUnixDiagErrnoForTest(null);
  setUnixDiagUidForTest(undefined);
  for (const pid of extraPids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  for (const proc of kids.splice(0)) {
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    await proc.exited.catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "wcc-"));
  dirs.push(dir);
  return dir;
}

function track(proc: Proc): Proc {
  kids.push(proc);
  return proc;
}

async function firstChunk(proc: Proc): Promise<string> {
  const read = proc.stdout.getReader().read();
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("helper produced no output")), 8_000));
  const { value } = await Promise.race([read, timeout]);
  return new TextDecoder().decode(value).trim();
}

function spawnEval(script: string, args: string[]): Proc {
  return track(Bun.spawn([process.execPath, "-e", script, ...args], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  }));
}

const LISTEN_ONLY = `
  const server = Bun.listen({ unix: process.argv[1], socket: { data() {} } });
  process.stdout.write("ready\\n");
  await new Promise(() => {});
  server.stop(true);
`;

const FLOCK_ONLY = `
  const { acquireInstanceLock } = await import(process.argv[2]);
  const lock = acquireInstanceLock(process.argv[1]);
  process.stdout.write(String(process.pid) + "\\n");
  await new Promise(() => {});
  lock.release();
`;

const LISTEN_AND_LOCK = `
  const { acquireInstanceLock } = await import(process.argv[2]);
  const socket = process.argv[1];
  const lock = acquireInstanceLock(socket);
  const server = Bun.listen({ unix: socket, socket: { data() {} } });
  process.stdout.write("ready\\n");
  await new Promise(() => {});
  server.stop(true);
  lock.release();
`;

const LISTEN_LOCK_AND_UNLINKED = `
  const { acquireInstanceLock } = await import(process.argv[2]);
  const { openSync, unlinkSync, writeSync } = await import("node:fs");
  const socket = process.argv[1];
  const scratch = process.argv[3];
  const lock = acquireInstanceLock(socket);
  const server = Bun.listen({ unix: socket, socket: { data() {} } });
  const fd = openSync(scratch, "w");
  writeSync(fd, "x");
  unlinkSync(scratch);
  process.stdout.write("ready\\n");
  await new Promise(() => {});
  server.stop(true);
  lock.release();
  void fd;
`;

const LISTEN_LOCK_AND_CHILD = `
  const { acquireInstanceLock } = await import(process.argv[2]);
  const socket = process.argv[1];
  const lock = acquireInstanceLock(socket);
  const server = Bun.listen({ unix: socket, socket: { data() {} } });
  const kid = Bun.spawn([process.execPath, "-e", "process.stdout.write(String(process.pid)+'\\\\n'); await new Promise(() => {})"],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const chunk = new TextDecoder().decode((await kid.stdout.getReader().read()).value).trim();
  process.stdout.write(chunk + "\\n");
  await new Promise(() => {});
  server.stop(true);
  lock.release();
`;

test.skipIf(process.platform !== "linux")("linux: holding the lock file's flock is not enough without the listening socket", async () => {
  const socket = join(tmp(), "walkie.sock");
  const listener = spawnEval(LISTEN_ONLY, [socket]);
  expect(await firstChunk(listener)).toBe("ready");
  const holder = spawnEval(FLOCK_ONLY, [socket, LOCK_MOD]);
  const holderPid = Number(await firstChunk(holder));
  expect(holderPid).toBeGreaterThan(1);
  // The listener never took the flock, so it is not the daemon either.
  expect(holdsSeatInstanceLock(listener.pid, ME, socket)).toBe(false);
  // Base (before WALK-106) accepts the flock holder. The listening socket is in the other process.
  expect(holdsSeatInstanceLock(holderPid, ME, socket)).toBe(false);
}, 20_000);

test.skipIf(process.platform !== "linux")("linux: the process that listens and holds the flock is the daemon", async () => {
  const socket = join(tmp(), "walkie.sock");
  const daemon = spawnEval(LISTEN_AND_LOCK, [socket, LOCK_MOD]);
  expect(await firstChunk(daemon)).toBe("ready");
  expect(holdsSeatInstanceLock(daemon.pid, ME, socket)).toBe(true);
}, 20_000);

test("macOS lsof branch: a same-user process that only opens the lock file is not the daemon", async () => {
  const socket = join(tmp(), "walkie.sock");
  const daemon = spawnEval(LISTEN_AND_LOCK, [socket, LOCK_MOD]);
  expect(await firstChunk(daemon)).toBe("ready");
  // Spawned by this test, not by the daemon, so it does not inherit the listening fd. It only opens the lock.
  const opener = spawnEval(`
    const { openSync } = require("node:fs");
    openSync(process.argv[1], "r");
    process.stdout.write(String(process.pid) + "\\n");
    await new Promise(() => {});
  `, [`${socket}.lock`]);
  const openerPid = Number(await firstChunk(opener));
  expect(openerPid).toBeGreaterThan(1);
  // platform "darwin" forces the lsof branch on this Linux host (real lsof, real flock).
  expect(holdsSeatInstanceLock(openerPid, ME, socket, "darwin")).toBe(false);
  expect(holdsSeatInstanceLock(daemon.pid, ME, socket, "darwin")).toBe(true);
}, 20_000);

test("WalkieTalkie: an accepted connection does not hide the listening socket", async () => {
  const socket = join(tmp(), "walkie.sock");
  const instance = createHash("sha256").update(socket).digest("hex");
  const daemon = spawnEval(LISTEN_AND_LOCK, [socket, LOCK_MOD]);
  expect(await firstChunk(daemon)).toBe("ready");
  const client = await Bun.connect({ unix: socket, socket: { data() {} } });
  try {
    expect(callingTalkieDaemon(ME, instance, daemon.pid)).toEqual({ pid: daemon.pid, start: expect.any(String) });
  } finally { client.end(); }
}, 20_000);

test("WalkieTalkie: an unlinked file the daemon still has open does not fail the check", async () => {
  const dir = tmp();
  const socket = join(dir, "walkie.sock");
  const instance = createHash("sha256").update(socket).digest("hex");
  const daemon = spawnEval(LISTEN_LOCK_AND_UNLINKED, [socket, LOCK_MOD, join(dir, "scratch.bin")]);
  expect(await firstChunk(daemon)).toBe("ready");
  // lsof names that fd "<path> (deleted)". realpath of the raw name throws; the check must skip it.
  expect(callingTalkieDaemon(ME, instance, daemon.pid).pid).toBe(daemon.pid);
}, 20_000);

test("WalkieTalkie: a nearer same-user process cannot borrow an ancestor that holds the socket", async () => {
  const socket = join(tmp(), "walkie.sock");
  const instance = createHash("sha256").update(socket).digest("hex");
  const daemon = spawnEval(LISTEN_LOCK_AND_CHILD, [socket, LOCK_MOD]);
  const childPid = Number(await firstChunk(daemon));
  expect(childPid).toBeGreaterThan(1);
  extraPids.push(childPid);
  // The child is the nearest same-uid ancestor and does not hold the socket. The daemon parent must not count.
  expect(() => callingTalkieDaemon(ME, instance, childPid)).toThrow("the invoking daemon could not be identified");
}, 20_000);

function record(dir: string, socket: string, uid = ME): string {
  const path = join(dir, "seat-instance");
  const registration: SeatRegistration = { v: 1, user: "olive", uid, home: "/home/olive/.walkie", socket };
  writeFileSync(path, seatRegistrationText(registration));
  return path;
}

/** A socket path of exactly `bytes` under `parent`, ending in /walkie.sock. */
function socketOfLength(parent: string, bytes: number): string {
  const name = "walkie.sock";
  const pad = bytes - Buffer.byteLength(parent) - 1 - Buffer.byteLength(name) - 1;
  if (pad < 1) throw new Error(`cannot fit a ${bytes}-byte socket under ${parent}`);
  const dir = join(parent, "p".repeat(pad));
  mkdirSync(dir);
  const socket = join(dir, name);
  if (Buffer.byteLength(socket) !== bytes) throw new Error(`socket length ${Buffer.byteLength(socket)}`);
  return socket;
}

// Binds <directory>/<name> through /proc/self/fd/<n>/<name> and keeps that directory fd open,
// then takes an exclusive flock on the lock path. Bun's own listen closes the directory fd;
// this stand-in is what shows the fd is still the socket's directory.
const PROC_FD_LISTENER = `
import os, socket, sys, time, fcntl
directory, name, lock_path = sys.argv[1], sys.argv[2], sys.argv[3]
dirfd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
bound = "/proc/self/fd/%d/%s" % (dirfd, name)
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(bound)
s.listen(1)
fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
os.fchmod(fd, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
sys.stdout.write("ready\\n")
sys.stdout.flush()
while True:
    time.sleep(3600)
`;

function spawnPython(args: string[]): Proc {
  return track(Bun.spawn(["python3", "-u", "-c", PROC_FD_LISTENER, ...args], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  }));
}

test.skipIf(process.platform !== "linux")("linux: a 130-byte socket path is still the daemon that listens and holds the flock", async () => {
  const socket = socketOfLength(tmp(), 130);
  expect(Buffer.byteLength(socket)).toBe(130);
  const daemon = spawnEval(LISTEN_AND_LOCK, [socket, LOCK_MOD]);
  expect(await firstChunk(daemon)).toBe("ready");
  // Bun binds this through /proc/self/fd/<n>/walkie.sock and closes <n>. /proc/net/unix lists that
  // string. The holder was refused ("managed by another Walkie") for every seat create.
  expect(holdsSeatInstanceLock(daemon.pid, ME, socket)).toBe(true);
  const instance = createHash("sha256").update(socket).digest("hex");
  const client = await Bun.connect({ unix: socket, socket: { data() {} } });
  try {
    expect(callingTalkieDaemon(ME, instance, daemon.pid).pid).toBe(daemon.pid);
  } finally { client.end(); }
}, 20_000);

test.skipIf(process.platform !== "linux")("linux: a long socket whose directory fd is still open is the holder, and another directory is not", async () => {
  const socket = socketOfLength(tmp(), 130);
  const holder = spawnPython([dirname(socket), "walkie.sock", `${socket}.lock`]);
  expect(await firstChunk(holder)).toBe("ready");
  expect(holdsSeatInstanceLock(holder.pid, ME, socket)).toBe(true);

  const real = join(tmp(), "walkie.sock");
  const listener = spawnEval(LISTEN_ONLY, [real]);
  expect(await firstChunk(listener)).toBe("ready");
  const decoy = tmp();
  const other = spawnPython([decoy, "walkie.sock", `${real}.lock`]);
  expect(await firstChunk(other)).toBe("ready");
  // Same basename, bound through /proc/self/fd/<n>/walkie.sock, and it holds the registered lock.
  // The directory fd is a different directory, so it is not the registered daemon.
  expect(holdsSeatInstanceLock(other.pid, ME, real)).toBe(false);
  expect(holdsSeatInstanceLock(listener.pid, ME, real)).toBe(false);
  // No diag handler: these two keep their directory fd, so the text table can still decide. The holder is the
  // daemon, and the one bound in another directory is another Walkie (false, not "could not be checked").
  setUnixDiagErrnoForTest(-2);
  expect(holdsSeatInstanceLock(holder.pid, ME, socket)).toBe(true);
  expect(holdsSeatInstanceLock(other.pid, ME, real)).toBe(false);
}, 20_000);

test.skipIf(process.platform !== "linux")("linux: a socket path with two spaces in a row is the listening socket", async () => {
  const dir = join(tmp(), "aa  bb");
  mkdirSync(dir);
  const socket = join(dir, "walkie.sock");
  expect(socket.includes("  ")).toBe(true);
  expect(Buffer.byteLength(socket)).toBeLessThan(108);
  const daemon = spawnEval(LISTEN_AND_LOCK, [socket, LOCK_MOD]);
  expect(await firstChunk(daemon)).toBe("ready");
  expect(holdsSeatInstanceLock(daemon.pid, ME, socket)).toBe(true);
}, 20_000);

test.skipIf(process.platform !== "linux")("linux: WalkieTalkie recognises a socket path that contains a space", async () => {
  const dir = join(tmp(), "a b");
  mkdirSync(dir);
  const socket = join(dir, "walkie.sock");
  expect(socket.includes(" ")).toBe(true);
  const instance = createHash("sha256").update(socket).digest("hex");
  const daemon = spawnEval(LISTEN_AND_LOCK, [socket, LOCK_MOD]);
  expect(await firstChunk(daemon)).toBe("ready");
  // lsof 4.95 cuts a unix NAME at the first space, so the talkie check used to miss this daemon.
  expect(holdsSeatInstanceLock(daemon.pid, ME, socket)).toBe(true);
  expect(callingTalkieDaemon(ME, instance, daemon.pid).pid).toBe(daemon.pid);
}, 20_000);

/** Inode of the daemon's accepted connection for `socket` (flags 0 in the text table), not the listener. */
function acceptedInode(pid: number, socket: string): string | null {
  const open = new Set<string>();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    let link = "";
    try { link = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
    const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
    if (inode) open.add(inode);
  }
  for (const line of readFileSync("/proc/net/unix", "utf8").split("\n")) {
    if (!line.endsWith(` ${socket}`)) continue;
    const parts = line.trim().split(/\s+/);
    const inode = parts[6];
    if (parts[3] === "00000000" && inode && inode !== "0" && open.has(inode)) return inode;
  }
  return null;
}

test.skipIf(process.platform !== "linux")("linux: a newline in another process's bind path does not hide the daemon", async () => {
  const dir = tmp();
  const socket = join(dir, "walkie.sock");
  const instance = createHash("sha256").update(socket).digest("hex");
  const daemon = spawnEval(LISTEN_AND_LOCK, [socket, LOCK_MOD]);
  expect(await firstChunk(daemon)).toBe("ready");
  const client = await Bun.connect({ unix: socket, socket: { data() {} } });
  client.write("x"); // Bun accepts once a byte arrives; until then the inode is not in the daemon's fd table.
  let inode: string | null = null;
  for (let i = 0; i < 50 && !inode; i++) {
    inode = acceptedInode(daemon.pid, socket);
    if (!inode) await Bun.sleep(20);
  }
  if (!inode) throw new Error("the daemon's accepted connection is not in the unix table");
  try {
    // The text table prints this path raw. The newline becomes a fake "listening" line for the
    // accepted connection's inode, which used to make the exactly-one listener count fail.
    const forged = `${dir}/a\n0: 0 0 10000 1 1 ${inode} ${socket}`;
    mkdirSync(dirname(forged), { recursive: true });
    const decoy = track(Bun.spawn([process.execPath, "-e", `
      const server = Bun.listen({ unix: process.argv[1], socket: { data() {} } });
      process.stdout.write("ready\\n");
      await new Promise(() => {});
      server.stop(true);
    `, forged], { stdin: "ignore", stdout: "pipe", stderr: "pipe" }));
    expect(await firstChunk(decoy)).toBe("ready");
    expect(holdsSeatInstanceLock(daemon.pid, ME, socket)).toBe(true);
    expect(callingTalkieDaemon(ME, instance, daemon.pid).pid).toBe(daemon.pid);
  } finally { client.end(); }
  expect(callingTalkieDaemon(ME, instance, daemon.pid).pid).toBe(daemon.pid);
}, 20_000);

const SOCKET_FLOOD = `
import os, resource, socket, sys, time
n = int(sys.argv[1])
root = sys.argv[2]
soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
want = min(hard, n + 64)
resource.setrlimit(resource.RLIMIT_NOFILE, (want, hard))
decoy = os.path.join(root, "decoy")
os.mkdir(decoy)
dfd = os.open(decoy, os.O_RDONLY | os.O_DIRECTORY)
held = []
listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
listener.bind("/proc/self/fd/%d/walkie.sock" % dfd)
listener.listen(1)
os.close(dfd)
held.append(listener)
for i in range(n):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(("\\0wccflood-%06d-" % i).ljust(100, "x"))
    held.append(s)
sys.stdout.write("ready %d\\n" % len(held))
sys.stdout.flush()
while True:
    time.sleep(3600)
`;

test.skipIf(process.platform !== "linux")("linux: another process's sockets cannot make the genuine daemon's seat check fail", async () => {
  const dir = tmp();
  const socket = join(dir, "walkie.sock");
  expect(Buffer.byteLength(socket)).toBeLessThan(108);
  const daemon = spawnEval(LISTEN_AND_LOCK, [socket, LOCK_MOD]);
  expect(await firstChunk(daemon)).toBe("ready");
  expect(holdsSeatInstanceLock(daemon.pid, ME, socket)).toBe(true);
  const flood = track(Bun.spawn(["python3", "-u", "-c", SOCKET_FLOOD, "20000", dir], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  }));
  const ready = await firstChunk(flood);
  expect(ready.startsWith("ready ")).toBe(true);
  // The decoy listens on /proc/self/fd/<n>/walkie.sock and then holds 20,000 abstract sockets.
  // A full dump of every socket used to throw, and every seat create, destroy and pending
  // answered busy for as long as those sockets stayed open.
  expect(holdsSeatInstanceLock(daemon.pid, ME, socket)).toBe(true);
}, 90_000);

test("a first WalkieTalkie claim follows the seat record when one exists, and the caller's hash when it doesn't", async () => {
  const dir = tmp();
  const socket = join(dir, "walkie.sock");
  const other = join(dir, "other.sock");
  const instance = createHash("sha256").update(socket).digest("hex");
  const daemon = spawnEval(LISTEN_AND_LOCK, [socket, LOCK_MOD]);
  expect(await firstChunk(daemon)).toBe("ready");
  const missing = join(dir, "missing-record");
  expect(callingTalkieClaimDaemon(ME, instance, daemon.pid, missing, false).pid).toBe(daemon.pid);
  const path = record(dir, socket);
  expect(callingTalkieClaimDaemon(ME, instance, daemon.pid, path, false).pid).toBe(daemon.pid);
  expect(() => callingTalkieClaimDaemon(ME, "0".repeat(64), daemon.pid, path, false)).toThrow("could not be identified");
  writeFileSync(path, seatRegistrationText({ v: 1, user: "olive", uid: ME, home: "/home/olive/.walkie", socket: other }));
  expect(() => callingTalkieClaimDaemon(ME, instance, daemon.pid, path, false)).toThrow("could not be identified");
  writeFileSync(path, seatRegistrationText({ v: 1, user: "maren", uid: ME + 1, home: "/home/maren/.walkie", socket }));
  expect(() => callingTalkieClaimDaemon(ME, instance, daemon.pid, path, false)).toThrow("another Walkie daemon owns shell access");
  writeFileSync(path, "{");
  expect(() => callingTalkieClaimDaemon(ME, instance, daemon.pid, path, false)).toThrow("can't be trusted");
}, 20_000);

const LISTEN_LOCK_AND_TCP = `
  const { acquireInstanceLock } = await import(process.argv[2]);
  const socket = process.argv[1];
  const lock = acquireInstanceLock(socket);
  const server = Bun.listen({ unix: socket, socket: { data() {} } });
  const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  process.stdout.write("ready " + tcp.port + "\\n");
  await new Promise(() => {});
  server.stop(true);
  tcp.stop(true);
  lock.release();
`;

/** registered = accepted, unchecked = busy (ask again), anything else = another Walkie. */
function seatVerdict(pid: number, socket: string, dir: string): "accepted" | "busy" | "other" {
  const path = record(dir, socket);
  const result = checkSeatInstance(ME, path, (owner, sock) => callingSeatDaemon(owner, sock, pid), false);
  if (result.state === "registered") return "accepted";
  if (result.state === "unchecked") return "busy";
  return "other";
}

test.skipIf(process.platform !== "linux")("linux: a kernel with no unix diag handler accepts a short path and does not call a long path another Walkie", async () => {
  const shortDir = tmp();
  const short = socketOfLength(shortDir, 34);
  expect(Buffer.byteLength(short)).toBe(34);
  const shortDaemon = spawnEval(LISTEN_AND_LOCK, [short, LOCK_MOD]);
  expect(await firstChunk(shortDaemon)).toBe("ready");
  const long = socketOfLength(tmp(), 130);
  expect(Buffer.byteLength(long)).toBe(130);
  const longDaemon = spawnEval(LISTEN_AND_LOCK, [long, LOCK_MOD]);
  expect(await firstChunk(longDaemon)).toBe("ready");
  // -2 is ENOENT, the answer a kernel with no unix diag handler gives for every inode, including one that exists.
  setUnixDiagErrnoForTest(-2);
  const shortVerdict = seatVerdict(shortDaemon.pid, short, shortDir);
  const longDir = dirname(dirname(long));
  const longVerdict = seatVerdict(longDaemon.pid, long, longDir);
  expect(shortVerdict).not.toBe("other");
  expect(longVerdict).not.toBe("other");
  // The short path is in the text table under its own name, and this daemon has no TCP socket, so it can be decided.
  expect(shortVerdict).toBe("accepted");
  // Bun closes the directory fd. The text table only has /proc/self/fd/<n>/walkie.sock and no file identity.
  expect(longVerdict).toBe("busy");
  // WalkieTalkie: the short daemon is identified, the long one is "could not be checked", never "could not be identified".
  const shortInstance = createHash("sha256").update(short).digest("hex");
  const longInstance = createHash("sha256").update(long).digest("hex");
  expect(callingTalkieDaemon(ME, shortInstance, shortDaemon.pid).pid).toBe(shortDaemon.pid);
  expect(() => callingTalkieDaemon(ME, longInstance, longDaemon.pid)).toThrow("could not be checked");
  setUnixDiagErrnoForTest(-22); // EINVAL
  expect(seatVerdict(shortDaemon.pid, short, shortDir)).toBe("accepted");
  setUnixDiagErrnoForTest(-95); // EOPNOTSUPP
  expect(seatVerdict(shortDaemon.pid, short, shortDir)).not.toBe("other");
}, 20_000);

/** Socket inodes a process has open. */
function openSocketInodes(pid: number): Set<number> {
  const open = new Set<number>();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const inode = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`))?.[1];
      if (inode) open.add(Number(inode));
    } catch { /* closed */ }
  }
  return open;
}

/** The inode of a TCP socket the process has open, from the world-readable /proc/net/tcp tables. */
function tcpInodeOf(pid: number): number {
  const open = openSocketInodes(pid);
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const raw = line.trim().split(/\s+/)[9];
      if (raw && /^\d+$/.test(raw) && open.has(Number(raw))) return Number(raw);
    }
  }
  throw new Error("the daemon has no tcp socket in /proc/net/tcp");
}

/** A listener bound to a path with a newline in it: /proc/net/unix prints the second half as a line of its own. */
async function forgeUnixLine(dir: string, socket: string, inode: number, tag: string): Promise<Proc> {
  const forged = `${dir}/${tag}\n0: 0 0 10000 1 1 ${inode} ${socket}`;
  mkdirSync(dirname(forged), { recursive: true });
  const decoy = spawnEval(LISTEN_ONLY, [forged]);
  expect(await firstChunk(decoy)).toBe("ready");
  return decoy;
}

const LISTEN_LOCK_AND_LONG_OTHER = `
  const { acquireInstanceLock } = await import(process.argv[2]);
  const socket = process.argv[1];
  const lock = acquireInstanceLock(socket);
  const server = Bun.listen({ unix: socket, socket: { data() {} } });
  const other = Bun.listen({ unix: process.argv[3], socket: { data() {} } });
  process.stdout.write("ready\\n");
  await new Promise(() => {});
  server.stop(true);
  other.stop(true);
  lock.release();
`;

test.skipIf(process.platform !== "linux")("linux: with no diag handler, another long listener of the daemon's does not make the WalkieTalkie check busy", async () => {
  const dir = tmp();
  const socket = join(dir, "walkie.sock");
  const instance = createHash("sha256").update(socket).digest("hex");
  const longOther = join(dirname(socketOfLength(tmp(), 130)), "other.sock");
  expect(Buffer.byteLength(longOther)).toBeGreaterThanOrEqual(108);
  const daemon = spawnEval(LISTEN_LOCK_AND_LONG_OTHER, [socket, LOCK_MOD, longOther]);
  expect(await firstChunk(daemon)).toBe("ready");
  expect(callingTalkieDaemon(ME, instance, daemon.pid).pid).toBe(daemon.pid);
  // Bun closed the directory fd of the long listener, so the text table lists it as /proc/self/fd/<n>/other.sock.
  setUnixDiagErrnoForTest(-2);
  expect(callingTalkieDaemon(ME, instance, daemon.pid).pid).toBe(daemon.pid);
  expect(seatVerdict(daemon.pid, socket, dir)).toBe("accepted");
}, 20_000);

test.skipIf(process.platform !== "linux")("linux: a daemon with a tcp socket is accepted with no diag handler, and a forged unix line for that tcp inode is busy", async () => {
  const dir = tmp();
  const socket = join(dir, "walkie.sock");
  const instance = createHash("sha256").update(socket).digest("hex");
  const daemon = spawnEval(LISTEN_LOCK_AND_TCP, [socket, LOCK_MOD]);
  expect((await firstChunk(daemon)).startsWith("ready ")).toBe(true);
  // Diag answers ENOENT for the TCP inode. With the handler present that stays "not a unix socket".
  expect(holdsSeatInstanceLock(daemon.pid, ME, socket)).toBe(true);
  expect(callingTalkieDaemon(ME, instance, daemon.pid).pid).toBe(daemon.pid);
  // A kernel with no handler answers ENOENT for every inode. The TCP socket is the daemon's own and has no unix line.
  setUnixDiagErrnoForTest(-2);
  expect(seatVerdict(daemon.pid, socket, dir)).toBe("accepted");
  expect(callingTalkieDaemon(ME, instance, daemon.pid).pid).toBe(daemon.pid);
  const decoy = await forgeUnixLine(dir, socket, tcpInodeOf(daemon.pid), "a");
  // /proc/net/tcp is world-readable, so anyone can name that inode. The unix table lists it once, as a listener
  // on the registered path, so the duplicate-inode guard never fires: it has to be "ask again".
  expect(seatVerdict(daemon.pid, socket, dir)).toBe("busy");
  expect(() => callingTalkieDaemon(ME, instance, daemon.pid)).toThrow("could not be checked");
  // The same forged line is never read when the kernel does answer.
  setUnixDiagErrnoForTest(null);
  expect(seatVerdict(daemon.pid, socket, dir)).toBe("accepted");
  expect(callingTalkieDaemon(ME, instance, daemon.pid).pid).toBe(daemon.pid);
  decoy.kill("SIGKILL");
  await decoy.exited.catch(() => undefined);
}, 20_000);

test.skipIf(process.platform !== "linux")("linux: procNetSockets reads the real tables: a tcp socket is no record, a newline path and a tcp forgery are not decided", async () => {
  const dir = tmp();
  const socket = join(dir, "walkie.sock");
  const daemon = spawnEval(LISTEN_LOCK_AND_TCP, [socket, LOCK_MOD]);
  expect((await firstChunk(daemon)).startsWith("ready ")).toBe(true);
  const inodes = openSocketInodes(daemon.pid);
  const tcp = tcpInodeOf(daemon.pid);
  expect(inodes.has(tcp)).toBe(true);
  const records = procNetSockets(inodes);
  const listeners = [...records].filter(([, rec]) => rec.state === 10 && rec.name === socket);
  expect(listeners.length).toBe(1);
  expect(records.has(tcp)).toBe(false);
  const listenerInode = listeners[0]![0];
  // Another process's bind path with a newline names the listener's own inode: it is on two lines.
  const dup = await forgeUnixLine(dir, socket, listenerInode, "b");
  expect(() => procNetSockets(inodes)).toThrow("could not be checked");
  dup.kill("SIGKILL");
  await dup.exited.catch(() => undefined);
  expect(procNetSockets(inodes).get(listenerInode)?.name).toBe(socket);
  // The same trick with the daemon's TCP inode puts it on one unix line only.
  const forged = await forgeUnixLine(dir, socket, tcp, "c");
  expect(() => procNetSockets(inodes)).toThrow("could not be checked");
  forged.kill("SIGKILL");
  await forged.exited.catch(() => undefined);
  expect(procNetSockets(inodes).has(tcp)).toBe(false);
}, 20_000);

test.skipIf(process.platform !== "linux")("linux: the diag reply's uid has to be the calling process, and a missing uid keeps the old check", async () => {
  const socket = join(tmp(), "walkie.sock");
  const daemon = spawnEval(LISTEN_AND_LOCK, [socket, LOCK_MOD]);
  expect(await firstChunk(daemon)).toBe("ready");
  expect(holdsSeatInstanceLock(daemon.pid, ME, socket)).toBe(true);
  const uids = unixDiagUidsForTest();
  expect(uids.length).toBeGreaterThan(0);
  expect(uids.every((uid) => uid === ME)).toBe(true);
  setUnixDiagUidForTest(null);
  expect(holdsSeatInstanceLock(daemon.pid, ME, socket)).toBe(true);
  setUnixDiagUidForTest(ME + 1);
  let verdict: "accepted" | "busy" | "other" = "other";
  try {
    verdict = holdsSeatInstanceLock(daemon.pid, ME, socket) ? "accepted" : "other";
  } catch (err) {
    verdict = (err as Error).message.includes("could not be checked") ? "busy" : "other";
  }
  expect(verdict).toBe("busy");
  const instance = createHash("sha256").update(socket).digest("hex");
  expect(() => callingTalkieDaemon(ME, instance, daemon.pid)).toThrow("could not be checked");
  setUnixDiagUidForTest(undefined);
  expect(callingTalkieDaemon(ME, instance, daemon.pid).pid).toBe(daemon.pid);
}, 20_000);

test.skipIf(process.platform !== "linux")("linux: WalkieTalkie finds other lock holders from /proc and does not run lsof -u", async () => {
  const socket = join(tmp(), "walkie.sock");
  const instance = createHash("sha256").update(socket).digest("hex");
  const daemon = spawnEval(LISTEN_AND_LOCK, [socket, LOCK_MOD]);
  expect(await firstChunk(daemon)).toBe("ready");
  const orig = Bun.spawnSync;
  let lsofUser = false;
  Bun.spawnSync = ((...args: Parameters<typeof Bun.spawnSync>) => {
    const argv = args[0];
    const list = Array.isArray(argv) ? argv.map(String) : [];
    if (list[0] === "lsof" && list.includes("-u")) lsofUser = true;
    return orig(...args);
  }) as typeof Bun.spawnSync;
  try {
    expect(callingTalkieDaemon(ME, instance, daemon.pid).pid).toBe(daemon.pid);
    expect(lsofUser).toBe(false);
  } finally {
    Bun.spawnSync = orig;
  }
  const opener = spawnEval(`
    const { openSync } = require("node:fs");
    openSync(process.argv[1], "r");
    process.stdout.write(String(process.pid) + "\\n");
    await new Promise(() => {});
  `, [`${socket}.lock`]);
  const openerPid = Number(await firstChunk(opener));
  expect(openerPid).toBeGreaterThan(1);
  expect(() => callingTalkieDaemon(ME, instance, daemon.pid)).toThrow("another live holder");
}, 20_000);

test.skipIf(process.platform !== "linux")("linux: an unlinked old lock still held by the first daemon is found from /proc, by its old name, without lsof", async () => {
  const dir = tmp();
  const socket = join(dir, "walkie.sock");
  const instance = createHash("sha256").update(socket).digest("hex");
  const first = spawnEval(LISTEN_AND_LOCK, [socket, LOCK_MOD]);
  expect(await firstChunk(first)).toBe("ready");
  rmSync(socket);
  rmSync(`${socket}.lock`);
  // The second daemon makes a new lock file and socket at the same names. The first keeps the old lock inode open,
  // which /proc names "<socket>.lock (deleted)" and which is not the inode of the file now on disk.
  const second = spawnEval(LISTEN_AND_LOCK, [socket, LOCK_MOD]);
  expect(await firstChunk(second)).toBe("ready");
  const orig = Bun.spawnSync;
  let lsofUser = false;
  Bun.spawnSync = ((...args: Parameters<typeof Bun.spawnSync>) => {
    const argv = args[0];
    if (Array.isArray(argv) && argv[0] === "lsof" && argv.map(String).includes("-u")) lsofUser = true;
    return orig(...args);
  }) as typeof Bun.spawnSync;
  try {
    expect(() => callingTalkieDaemon(ME, instance, second.pid)).toThrow("another live holder");
    expect(lsofUser).toBe(false);
  } finally {
    Bun.spawnSync = orig;
  }
}, 20_000);
