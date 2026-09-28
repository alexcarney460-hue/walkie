// WALKIE-LIVE-2: hestia-wsl's roster churn. A health probe runs `grok -p "Reply with exactly PONG." --max-turns 1`
// every ~15 s; each run (a) was discovered as `grok-pid<N>` and swept a scan later, and (b) started a `walkie mcp` whose
// fallback name `agent-<ppid>` announced "Connected to Walkie" and was swept when it exited. Neither is a session.
import { afterEach, expect, test } from "bun:test";
import { UNNAMED_MIN_AGE_MS } from "../../src/daemon/discovery.ts";
import { announceDelayMs } from "../../src/mcp/server.ts";
import { ME, status, world } from "../helpers/discovery-world.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });
const TICK = 15_000;
const probe = (pid: number, startedAt: number) => ({ pid, ppid: 1, uid: ME, startedAt, command: "grok -p Reply with exactly PONG. --yolo --max-turns 1 --output-format plain --no-auto-update", cpuMs: 5 });

test("a one-shot unnamed run (the PONG probe) never gets a card; one that keeps running does", async () => {
  const w = world(cleanups);
  const d = w.disc({ unnamedMinAgeMs: UNNAMED_MIN_AGE_MS });
  // Four probes, each alive for a single scan.
  for (let i = 0; i < 4; i++) {
    const pid = 9_000 + i;
    w.fx.procs.push(probe(pid, w.clock.t - 3_000));
    await d.tick();
    w.fx.procs = w.fx.procs.filter((p) => p.pid !== pid);
    w.clock.t += TICK;
    await d.tick();
    expect(status(w.core, `grok-pid${pid}`)).toBeNull();
  }
  // A real unnamed session outlives the grace: reported on the first scan after it.
  w.fx.procs.push({ ...probe(9_100, w.clock.t - 3_000), command: "grok" });
  await d.tick();
  expect(status(w.core, "grok-pid9100")).toBeNull();
  w.clock.t += TICK;
  await d.tick();
  w.clock.t += TICK;
  await d.tick();
  expect(status(w.core, "grok-pid9100")?.state).toBe("idle");
});

test("named sessions are reported at once, however young (the grace is only for sessions with no name)", async () => {
  const w = world(cleanups);
  w.fx.procs = w.fx.procs.map((p) => (p.pid >= 100 ? { ...p, startedAt: w.clock.t - 1_000 } : p));
  const d = w.disc({ unnamedMinAgeMs: UNNAMED_MIN_AGE_MS });
  await d.tick();
  expect(status(w.core, "cc-5eed00")?.state).toBeDefined();
});

test("the MCP server waits before announcing only when it has no session name", () => {
  expect(announceDelayMs("cc-7777aa", true, {})).toBe(0);
  expect(announceDelayMs("agent-22myy", false, {})).toBeGreaterThanOrEqual(20_000);
  expect(announceDelayMs("agent-22myy", false, { WALKIE_MCP_ANNOUNCE_GRACE_MS: "750" })).toBe(750);
  expect(announceDelayMs("agent-22myy", false, { WALKIE_MCP_ANNOUNCE_GRACE_MS: "junk" })).toBeGreaterThanOrEqual(20_000);
});
