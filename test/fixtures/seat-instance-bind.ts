// WALK-103: root's binding of the daemon that ran the seat helper to the registered daemon socket, run for real (ps,
// /proc or lsof, flock) without sudo: the checking process stands in for the helper, its parent for the daemon.
//   check <owner> <socket>                  print callingSeatDaemon(owner, socket, <this process's parent>) as JSON
//   nest <own-socket> <owner> <socket> [open]
//                                           hold <own-socket> as a daemon would (lock, then listen), then run `check`
//                                           as its own child and print that answer (a second daemon started by one);
//                                           `open`: it also opens the registered lock file read-only, without the flock
//   held <path> [<dev> <ino>]               print instanceLockHeld(path, expect) as JSON (true/false or the error code)
import { mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { acquireInstanceLock, instanceLockHeld } from "../../src/daemon/instance-lock.ts";
import { callingSeatDaemon } from "../../src/daemon/seats/admin-sys.ts";

const [mode, ...rest] = process.argv.slice(2);
if (mode === "check") {
  const [owner, socket] = rest;
  try {
    const op = callingSeatDaemon(Number(owner), socket as string, process.ppid);
    process.stdout.write(`${JSON.stringify({ ok: true, pid: op.pid })}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, why: (err as Error).message })}\n`);
  }
  process.exit(0);
}
if (mode === "nest") {
  const [own, owner, socket, open] = rest as [string, string, string, string | undefined];
  mkdirSync(dirname(own), { recursive: true });
  const lock = acquireInstanceLock(own);
  const server = Bun.listen({ unix: own, socket: { data() { /* nothing */ } } });
  if (open === "open") openSync(`${socket}.lock`, "r"); // kept open; the registered daemon holds the flock
  const child = Bun.spawn([process.execPath, import.meta.path, "check", owner, socket], { stdout: "pipe", stderr: "inherit" });
  const out = await new Response(child.stdout).text();
  await child.exited;
  server.stop(true);
  lock.release();
  process.stdout.write(out);
  process.exit(0);
}
if (mode === "held") {
  const [path, dev, ino] = rest;
  try {
    const held = instanceLockHeld(path as string, dev && ino ? { dev: Number(dev), ino: Number(ino) } : undefined);
    process.stdout.write(`${JSON.stringify({ held })}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ error: (err as NodeJS.ErrnoException).code ?? (err as Error).message })}\n`);
  }
  process.exit(0);
}
process.stderr.write("usage: seat-instance-bind.ts check <owner> <socket> | nest <own-socket> <owner> <socket> [open] | held <path> [<dev> <ino>]\n");
process.exit(2);
