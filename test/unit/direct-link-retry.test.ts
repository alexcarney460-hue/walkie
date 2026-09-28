// DIRECT-FIX-1 (Opus MEDIUM 3): a Walkie Direct endpoint that fails to start at boot is retried with jittered
// backoff, like the Tailscale peer link, instead of leaving the node unreachable until a restart. The link also
// forwards roster changes to the endpoint (revoked keys lose their connections, net.ts).
import { afterEach, expect, test } from "bun:test";
import { DirectLink, type DirectLinkDeps } from "../../src/daemon/direct/link.ts";
import type { DirectNet } from "../../src/daemon/direct/net.ts";
import type { Logger } from "../../src/daemon/logger.ts";
import { makeCore } from "../helpers/core.ts";
import { tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function setup(failures: number) {
  const core = makeCore(tnode("alex", "direct:alex"), "0000000000000000", cleanups);
  const logs: { msg: string; fields?: Record<string, unknown> }[] = [];
  const log: Logger = { debug: () => undefined, info: (msg, fields) => logs.push({ msg, fields }), warn: () => undefined, error: (msg, fields) => logs.push({ msg, fields }) };
  let calls = 0;
  let rosterChanges = 0;
  const net = { endpoint: "ab", relayUrl: () => null, stop: async () => undefined, rosterChanged: () => { rosterChanges++; } } as unknown as DirectNet;
  const deps = {
    core, log, sync: { running: true, rosterChanged: () => undefined, start: () => undefined }, client: { transports: {} }, api: {},
    stopTailscale: () => undefined,
    startNet: async () => {
      calls++;
      if (calls <= failures) throw new Error(`bind failed #${calls}`);
      return net;
    },
  } as unknown as DirectLinkDeps;
  const link = new DirectLink(deps, { transport: "direct" }, { retryBaseMs: 10, retryMaxMs: 40, random: () => 0.5 });
  cleanups.push(() => void link.stop());
  return { link, logs, calls: () => calls, rosterChanges: () => rosterChanges };
}

test("a failed start at boot is retried with backoff until the endpoint comes up", async () => {
  const s = setup(3);
  await s.link.startWithRetry();
  expect(s.link.direct()).toBeNull();
  const deadline = Date.now() + 2_000;
  while (!s.link.direct() && Date.now() < deadline) await Bun.sleep(5);
  expect(s.calls()).toBe(4);
  expect(s.link.direct()).not.toBeNull();
  expect(s.link.mode()).toBe("direct");
  const failed = s.logs.filter((l) => l.msg === "direct_start_failed").map((l) => l.fields?.next_in_ms);
  console.log(`[evidence] direct_start_failed next_in_ms=${JSON.stringify(failed)}`);
  expect(failed).toEqual([10, 20, 40]); // base·2ⁿ, capped at the max (jitter 1.0 at random 0.5)
  expect(s.logs.some((l) => l.msg === "direct_started")).toBe(true);
});

test("stop() cancels a pending retry", async () => {
  const s = setup(100);
  await s.link.startWithRetry();
  await s.link.stop();
  const n = s.calls();
  await Bun.sleep(60);
  expect(s.calls()).toBe(n);
});

test("roster changes reach the running endpoint", async () => {
  const s = setup(0);
  await s.link.startWithRetry();
  s.link.rosterChanged();
  expect(s.rosterChanges()).toBe(1);
});
