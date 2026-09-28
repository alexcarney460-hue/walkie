import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostFor } from "../../src/daemon/orchestrator/host.ts";
import { Cluster, waitFor } from "../helpers/cluster.ts";

const cluster = new Cluster();
afterAll(async () => { await cluster.close(); });

test("replaced Claude is re-probed, unknown flags get one retry, and repeated failures stop", async () => {
  const bin = join(cluster.root, "claude"), log = join(cluster.root, "launches");
  const install = (help: boolean, mode: "live" | "unknown" | "unknown-settings" | "fail") => {
    const next = `${bin}.next`;
    writeFileSync(next, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '${help ? "--permission-prompts" : "Usage: claude"}'; exit 0; fi
prompt=0
settings=0
for arg in "$@"; do
  if [ "$arg" = "--permission-prompts" ]; then prompt=1; fi
  if [ "$arg" = "--settings" ]; then settings=1; fi
done
echo "$prompt:$settings" >> "$FAKE_LAUNCH_LOG"
${mode === "unknown" ? "if [ \"$prompt\" = 1 ]; then echo \"error: unknown option '--permission-prompts'\" >&2; exit 1; fi" : ""}
${mode === "unknown-settings" ? "if [ \"$settings\" = 1 ]; then echo \"error: unknown option '--settings'\" >&2; exit 1; fi" : ""}
${mode === "fail" ? "echo 'fatal: test binary cannot start' >&2; exit 1" : "exec /bin/sleep 60"}
`);
    chmodSync(next, 0o755);
    renameSync(next, bin);
  };
  const launches = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
  install(true, "live");
  const node = await cluster.add({ name: "crashloop", login: "crashloop@example.com", orchestrator: {
    auto: false, restartBaseMs: 20, restartMaxMs: 50, logins: async () => ({ found: ["claude"], claude: "cli" }),
    env: { ...process.env, PATH: "/usr/bin:/bin", FAKE_LAUNCH_LOG: log },
  } });
  await node.client().init("crashloop-test", "crashloop");
  hostFor(node.d.core)?.setLeadEligible(true); // test node runs on WSL; this isolated VM is the only owner
  const start = () => waitFor(() => node.client("").orchestratorStart({ claude: bin, cwd: cluster.root }),
    { what: "authority lease for test start" });

  await start();
  await waitFor(() => launches().length === 1, { what: "first launch" });
  expect(launches()[0]).toBe("1:1");

  install(false, "live"); // same path, different inode and --help capability
  await start();
  await waitFor(() => launches().length === 2, { what: "old Claude launch" });
  expect(launches()[1]).toBe("0:1");

  install(true, "unknown"); // --help lies; stderr must reach the host for the one-time fallback
  await start();
  await waitFor(() => launches().length >= 4, { what: "unsupported flag retry" });
  expect(launches()[2]).toBe("1:1");
  expect(launches()[3]).toBe("0:1");
  await Bun.sleep(200);
  expect(launches()).toHaveLength(4);

  install(false, "unknown-settings"); // the supervisor appends this hook flag after the host's argv
  await start();
  await waitFor(async () => (await node.client("").orchestrator()).local.state === "failed", { what: "old Claude setting hook is terminal" });
  expect(launches()[4]).toBe("0:1");
  expect(launches()).toHaveLength(5);
  expect((await node.client("").orchestrator()).local.last_error).toContain("this Claude is too old for WalkieTalkie: --settings; update Claude");

  install(false, "fail");
  await start();
  await waitFor(async () => (await node.client("").orchestrator()).local.state === "failed", { what: "terminal crash status", timeoutMs: 10_000 });
  const failed = (await node.client("").orchestrator()).local;
  expect(failed.running).toBe(false);
  expect(failed.last_error).toContain("WalkieTalkie keeps failing: claude exited (code 1): fatal: test binary cannot start");
  expect(failed.restarts).toBe(4); // four respawns after the initial failure, then a hard stop
  expect(launches()).toHaveLength(10);
  await Bun.sleep(250);
  expect(launches()).toHaveLength(10);

  install(true, "live");
  await node.client("").orchestratorAuto();
  await waitFor(() => launches().length === 11, { what: "auto recovers failed host", timeoutMs: 15_000 });
  expect((await node.client("").orchestrator()).local.running).toBe(true);
}, 30_000);

test("automatic mode: after five rapid failures the periodic auto check never restarts it", async () => {
  const bin = join(cluster.root, "claude-auto"), log = join(cluster.root, "launches-auto");
  writeFileSync(bin, `#!/bin/sh
if [ "$1" = "--help" ]; then echo 'Usage: claude'; exit 0; fi
echo launch >> '${log}'
echo 'fatal: test binary cannot start' >&2; exit 1
`); // the log path is baked in: Claude's environment is rebuilt (childEnv), so an env var would not reach it
  chmodSync(bin, 0o755);
  const launches = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
  const node = await cluster.add({ name: "crashloop-auto", login: "crashloop-auto@example.com", orchestrator: {
    // autoCheckMs also sets the lease renewal (lease = 2x): at 50 ms a spawn hiccup lapsed it and restarted the host.
    auto: true, autoCheckMs: 300, restartBaseMs: 20, restartMaxMs: 50,
    logins: async () => ({ found: ["claude"], claude: "cli" }),
    env: { ...process.env, PATH: "/usr/bin:/bin", FAKE_LAUNCH_LOG: log },
  } });
  await node.client().init("crashloop-auto-test", "crashloop-auto");
  hostFor(node.d.core)?.setLeadEligible(true);
  await waitFor(() => node.client("").orchestratorStart({ claude: bin, cwd: cluster.root }), { what: "authority lease for auto test" });
  await waitFor(async () => (await node.client("").orchestrator()).local.state === "failed", { what: "failed after five", timeoutMs: 20_000 });
  // Whichever binary auto mode resolved (ours or none on this PATH), the failed state must hold across auto checks:
  // no further launches of our binary and no further restarts.
  const launched = launches().length;
  expect(launched).toBeGreaterThan(0);
  // The give-up is persisted: a daemon restart (the state is still active) neither boots Claude nor lets the auto
  // check start it.
  await node.restart();
  await Bun.sleep(2_000); // six auto checks
  expect((await node.client("").orchestrator()).local.state).toBe("failed");
  expect(launches()).toHaveLength(launched);
  // A lease loss halts it to "stopped"; the give-up must survive that too.
  const before = (await node.client("").orchestrator()).local;
  (hostFor(node.d.core) as unknown as { leaseLost(): void }).leaseLost();
  await Bun.sleep(2_000);
  const later = (await node.client("").orchestrator()).local;
  expect(later.state).toBe("failed");
  expect(later.restarts).toBe(before.restarts);
  expect(launches()).toHaveLength(launched);
  // A person's `walkie talkie auto` is a fresh try: Claude launches again.
  await waitFor(() => node.client("").orchestratorAuto(), { what: "auto by a person" });
  await waitFor(() => launches().length > launched, { what: "a fresh launch after auto", timeoutMs: 20_000 });
}, 60_000);

test("automatic mode: lease losses in the middle of a crash loop do not reset the five-failure count", async () => {
  const log = join(cluster.root, "launches-blip"), bin = join(cluster.root, "claude-blip");
  writeFileSync(bin, `#!/bin/sh
if [ "$1" = "--help" ]; then echo 'Usage: claude'; exit 0; fi
echo launch >> '${log}'
echo 'fatal: test binary cannot start' >&2; exit 1
`);
  chmodSync(bin, 0o755);
  const launches = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0;
  const node = await cluster.add({ name: "crashloop-blip", login: "crashloop-blip@example.com", orchestrator: {
    auto: true, autoCheckMs: 300, restartBaseMs: 400, restartMaxMs: 800,
    logins: async () => ({ found: ["claude"], claude: "cli" }), env: { ...process.env, PATH: "/usr/bin:/bin" },
  } });
  await node.client().init("crashloop-blip-test", "crashloop-blip");
  const host = hostFor(node.d.core)!;
  host.setLeadEligible(true);
  await waitFor(() => node.client("").orchestratorStart({ claude: bin, cwd: cluster.root }), { what: "authority lease for blip test" });
  // Each lease loss lands in the backoff after a counted failure (no Claude running), so every launch is a failure:
  // with the count carried on it gives up at five launches; a reset per lease loss would need 2 + 5.
  for (const n of [1, 2]) {
    await waitFor(async () => launches() >= n && (await node.client("").orchestrator()).local.state === "restarting", { what: `backoff after launch ${n}`, timeoutMs: 15_000 });
    (host as unknown as { leaseLost(): void }).leaseLost(); // the auto check restarts it; the count must carry on
  }
  await waitFor(async () => (await node.client("").orchestrator()).local.state === "failed", { what: "failed after five", timeoutMs: 30_000 });
  expect(launches()).toBeLessThanOrEqual(5);
}, 60_000);
