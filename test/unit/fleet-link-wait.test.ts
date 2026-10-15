import { afterEach, expect, spyOn, test } from "bun:test";
import { LINK_WAIT, startLinkWait, stopLinkWait } from "../../src/daemon/join.ts";
import { PeerCallError, type PeerClient } from "../../src/daemon/peer-client.ts";
import type { SyncManager } from "../../src/daemon/sync.ts";
import { makeCore } from "../helpers/core.ts";
import { tnode } from "../helpers/events.ts";
import { waitFor } from "../helpers/cluster.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); LINK_WAIT.intervalMs = 10_000; });

function waiting(failure: () => Error) {
  const self = tnode("new-machine");
  const core = makeCore(self, "0000000000000000", cleanups);
  const warn = spyOn(core.log, "warn");
  let calls = 0;
  const client = { join: async () => { calls++; throw failure(); } } as unknown as PeerClient;
  LINK_WAIT.intervalMs = 5;
  startLinkWait(core, {} as SyncManager, client, { ip: "", port: 7458, pubkey: tnode("owner").keys.pubkey }, "0000000000000000");
  cleanups.push(() => { stopLinkWait(core); warn.mockRestore(); });
  return { core, warn, calls: () => calls };
}

test("approval polling logs transport and unexpected failures and keeps retrying", async () => {
  for (const error of [new PeerCallError(0, "unreachable", "authority offline"), new Error("unexpected failure")]) {
    const w = waiting(() => error);
    await waitFor(() => w.calls() >= 2);
    expect(w.warn.mock.calls.some(([event, fields]) => event === "link_wait_failed" && fields?.err === error.message)).toBe(true);
    expect(w.core.store.getMeta("link_wait")).not.toBeNull();
    stopLinkWait(w.core);
  }
});

test("a declined machine logs the refusal, clears its wait state and stops polling", async () => {
  const w = waiting(() => new PeerCallError(403, "link_declined", "an owner declined this machine"));
  await waitFor(() => w.calls() >= 1);
  expect(w.warn.mock.calls.some(([event, fields]) => event === "link_wait_refused" && fields?.code === "link_declined")).toBe(true);
  expect(w.core.store.getMeta("link_wait")).toBeNull();
  await Bun.sleep(25);
  expect(w.calls()).toBe(1);
});
