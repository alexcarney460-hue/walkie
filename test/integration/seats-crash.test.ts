// Opus MEDIUM 4: a host daemon that dies (kill -9) while a seat runs, whose runtime then exits on its own and leaves
// a background child in its process group. The next daemon start must end every survivor of that group, not only a
// group whose leader is still alive. The crashing daemon runs in a child process (test/fixtures/seats-crash-host.ts).
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Cluster, TestNode, waitFor } from "../helpers/cluster.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "seats-crash-host.ts");
const cleanup: Array<() => void | Promise<void>> = [];
afterAll(async () => { for (const f of cleanup.reverse()) await f(); });

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function firstLine(stream: ReadableStream<Uint8Array>, timeoutMs: number): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (!buf.includes("\n")) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("the crash host printed nothing");
    const r = await Promise.race([reader.read(), Bun.sleep(left).then(() => null)]);
    if (!r || r.done) throw new Error(`the crash host ended early: ${buf}`);
    buf += dec.decode(r.value, { stream: true });
  }
  reader.releaseLock();
  return buf.slice(0, buf.indexOf("\n"));
}

test("after a kill -9 of the host daemon, its next start kills every survivor of a seat's process group", async () => {
  const log = join(await Bun.$`mktemp -d /tmp/walkie-crash-XXXXXX`.text().then((s) => s.trim()), "codex.jsonl");
  cleanup.push(() => rmSync(join(log, ".."), { recursive: true, force: true }));
  const host = Bun.spawn([process.execPath, FIXTURE, log], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  cleanup.push(() => { host.kill("SIGKILL"); });
  const info = JSON.parse(await firstLine(host.stdout as ReadableStream<Uint8Array>, 60_000)) as { root: string; arvidHome: string; seat: string };
  cleanup.push(() => rmSync(info.root, { recursive: true, force: true }));
  const entry = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => typeof l.grandchild === "number");
  const grandchild = entry?.grandchild as number;
  const leader = entry?.leader as number;
  cleanup.push(() => { if (alive(grandchild)) process.kill(grandchild, "SIGKILL"); });
  expect(alive(leader) && alive(grandchild)).toBe(true);

  host.kill("SIGKILL"); // the daemon crashes: nothing of it stops the seat
  await host.exited;
  await waitFor(() => !alive(leader), { what: "the runtime to exit after its host died", timeoutMs: 10_000 });
  expect(alive(grandchild)).toBe(true); // its background child is left in the seat's process group
  expect(existsSync(join(info.arvidHome, "seats.json"))).toBe(true);

  // arvid's daemon starts again on the same home.
  const c = new Cluster();
  const node = new TestNode(c, { name: "arvid", login: "arvid@example.com", hostname: "arvid-mac" }, info.arvidHome, 0);
  await node.start();
  cleanup.push(async () => { await node.stop(); await c.close(); });
  await waitFor(() => !alive(grandchild), { what: "the leftover group member killed", timeoutMs: 5_000 });
  const s = await waitFor(async () => (await node.client().seats(info.seat)).seats[0], { what: "the seat's state" });
  expect(s.state).toBe("failed");
  expect(s.reason).toBe("the host's Walkie daemon restarted while it ran (its processes were stopped)");
}, 120_000);

/** `ps -o stat=`: "T…" while stopped; "" once the process is gone. */
function stat(pid: number): string {
  return Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
}

test("a host daemon killed while a seat is paused (busy): the next start kills the stopped group and reports it", async () => {
  const log = join(await Bun.$`mktemp -d /tmp/walkie-crash-XXXXXX`.text().then((s) => s.trim()), "codex.jsonl");
  cleanup.push(() => rmSync(join(log, ".."), { recursive: true, force: true }));
  const host = Bun.spawn([process.execPath, FIXTURE, log, "paused"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  cleanup.push(() => { host.kill("SIGKILL"); });
  const info = JSON.parse(await firstLine(host.stdout as ReadableStream<Uint8Array>, 60_000)) as { root: string; arvidHome: string; seat: string };
  cleanup.push(() => rmSync(info.root, { recursive: true, force: true }));
  const entry = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => typeof l.grandchild === "number");
  const grandchild = entry?.grandchild as number;
  const leader = entry?.leader as number;
  cleanup.push(() => { for (const p of [leader, grandchild]) if (alive(p)) { process.kill(p, "SIGCONT"); process.kill(p, "SIGKILL"); } });
  expect(stat(leader)).toStartWith("T");
  expect(stat(grandchild)).toStartWith("T");

  host.kill("SIGKILL"); // the daemon crashes while the seat is stopped: nothing continues or ends it
  await host.exited;
  await Bun.sleep(500);
  expect(stat(leader)).toStartWith("T"); // still there, still stopped (it can't even notice its host is gone)
  expect(stat(grandchild)).toStartWith("T");
  const saved = JSON.parse(readFileSync(join(info.arvidHome, "seats.json"), "utf8")) as { busy?: { max: number }; running: Array<{ pid?: number }> };
  expect(saved.busy?.max).toBe(0);
  expect(saved.running.map((r) => r.pid)).toEqual([leader]);

  const c = new Cluster();
  const node = new TestNode(c, { name: "arvid", login: "arvid@example.com", hostname: "arvid-mac" }, info.arvidHome, 0);
  await node.start();
  cleanup.push(async () => { await node.stop(); await c.close(); });
  await waitFor(() => !alive(leader) && !alive(grandchild), { what: "the stopped group killed", timeoutMs: 5_000 });
  const s = await waitFor(async () => (await node.client().seats(info.seat)).seats[0], { what: "the seat's state" });
  expect(s.state).toBe("failed");
  expect(s.reason).toBe("the host's Walkie daemon restarted while it ran (its processes were stopped)");
  // The person is still at the machine after the restart.
  expect((await node.client("").seats()).local.availability).toMatchObject({ state: "busy", max: 0 });
}, 120_000);
