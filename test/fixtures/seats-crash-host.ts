// A 2-machine team in THIS process, for test/integration/seats-crash.test.ts, which SIGKILLs it: alex launches a
// codex seat on arvid whose runtime (test/fixtures/fake-codex, "orphan-on-crash") backgrounds a `sleep` in its
// process group and exits once this process is gone. Prints one JSON line once the seat runs, then waits.
// With "paused", arvid first says he's using the machine (`seats busy --max 0`): the seat's group is SIGSTOPped
// when this process dies.
//   argv: <codex log file> [paused]
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Cluster, waitFor } from "../helpers/cluster.ts";
import { signInCodex } from "../helpers/fake-seat-users.ts";

const logFile = process.argv[2] ?? "";
const paused = process.argv[3] === "paused";
const c = new Cluster();
const home = join(c.root, "arvid-home");
mkdirSync(home, { recursive: true });
signInCodex(home);
const alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
const arvid = await c.add({
  name: "arvid", login: "arvid@example.com", hostname: "arvid-mac",
  seats: { flushMs: 100, env: { PATH: `${join(import.meta.dir, "fake-codex")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, FAKE_CODEX_LOG: logFile } },
});
await alex.client().init("aka", "alex");
await alex.client().invite("arvid@example.com", "arvid", "member");
await arvid.client().join(alex.peerAddr);
await arvid.client("").seatsConfig({ allow: true, same_user: true, env: ["FAKE_CODEX_LOG"] });
await waitFor(async () => (await alex.client().seats()).hosts.find((h) => h.hostname === "arvid-mac" && h.allows && h.member), { timeoutMs: 30_000, what: "arvid-mac takes seats" });
const res = await alex.client("").seatRun({ machine: "arvid-mac", runtime: "codex", prompt: "orphan-on-crash" });
await waitFor(async () => (await alex.client().seats(res.seat)).seats[0]?.state === "running", { timeoutMs: 30_000, what: "seat running" });
// The runtime has started its background child (and logged both pids).
await waitFor(() => existsSync(logFile) && readFileSync(logFile, "utf8").includes('"grandchild"'), { timeoutMs: 30_000, what: "the seat's child" });
if (paused) {
  await arvid.client("").seatsBusy({ max: 0 });
  await waitFor(async () => (await alex.client().seats(res.seat)).seats[0]?.state === "paused", { timeoutMs: 30_000, what: "seat paused" });
}
process.stdout.write(JSON.stringify({ root: c.root, arvidHome: arvid.home, seat: res.seat }) + "\n");
await new Promise(() => undefined);
