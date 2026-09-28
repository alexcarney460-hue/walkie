// A daemon in its own process, for test/integration/orchestrator-crash.test.ts (ORCH-FIX-13): the test kills it by its
// exact PID (SIGKILL: no shutdown runs) and starts it again on the same home.
//   bun test/fixtures/orch-crash-daemon.ts <home> first    init a team, start the orchestrator (the fake claude), ask
//                                                          it to "spawn and hang"; prints {"pid","grandchild"} once the
//                                                          tool's process is up
//   bun test/fixtures/orch-crash-daemon.ts <home> again    start on the same home; prints {"pid","ready":true} once the
//                                                          orchestrator resumed (and ended what the first left behind)
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WalkieClient } from "../../src/client/index.ts";
import { FakeIdentity } from "../../src/daemon/identity.ts";
import { startDaemon } from "../../src/daemon/main.ts";

const [home, mode] = process.argv.slice(2) as [string, "first" | "again"];
const fake = join(import.meta.dir, "fake-claude");
const state = join(home, "fake-state");
const log = join(home, "fake-launches.jsonl");
mkdirSync(state, { recursive: true });

const d = await startDaemon({
  home, socket: join(home, "walkie.sock"), identity: new FakeIdentity({ ip: "127.0.0.1", login: "alex@example.com", nodeName: "alex-mbp" }, new Map()),
  peerHost: "127.0.0.1", peerPort: 0, localPort: false, hostname: "alex-mbp", env: false, webDir: join(home, "no-web"),
  integrations: { autoRun: false }, licenseRenew: false, discovery: false, machineStats: false, accounts: false,
  licenseService: { fetch: async () => { throw new Error("no license service"); } },
  orchestrator: { autoCheckMs: 150, restartBaseMs: 50, restartMaxMs: 200, statusThrottleMs: 50, env: { ...process.env, PATH: "/usr/bin:/bin", FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_LOG: log } },
});
const person = new WalkieClient({ socket: d.socket, agent: "", timeoutMs: 15_000 });

async function until<T>(fn: () => T | null | undefined | Promise<T | null | undefined>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(50);
  }
}
const logged = (): Record<string, unknown>[] => existsSync(log)
  ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];

if (mode === "first") {
  await person.init("acme", "alex");
  await person.orchestratorStart({ cwd: home, path: `${fake}:${process.env.PATH ?? "/usr/bin:/bin"}` });
  await until(async () => (await person.orchestrator()).local.state === "idle");
  await person.orchestratorSay("spawn and hang");
  const grandchild = await until(() => logged().find((l) => typeof l.grandchild === "number")?.grandchild as number | undefined);
  process.stdout.write(JSON.stringify({ pid: process.pid, grandchild }) + "\n");
} else {
  await until(async () => (await person.orchestrator()).local.state === "idle");
  process.stdout.write(JSON.stringify({ pid: process.pid, ready: true }) + "\n");
}
await new Promise(() => undefined); // until the test kills this process
