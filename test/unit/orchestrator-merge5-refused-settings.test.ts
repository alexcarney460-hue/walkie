// ROUND 5 (Opus round-4 HIGH): a settings request that is refused before anything is torn down is not a failure. It must
// never count toward the five-failure give-up, and a reply that ends after a give-up must never make the view healthy.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { HttpError } from "../../src/daemon/http.ts";
import { rig, waitFor, type Rig } from "./orchestrator-merge4-setup.ts";

let r: Rig;
let waiting: Rig;
beforeAll(async () => { r = await rig(); waiting = await rig(); }, 60_000);
afterAll(async () => { await r.c.close(); await waiting.c.close(); });

const replied = (rg: Rig, thread: string) => rg.alex.d.core.store.orchMessages({ thread, limit: 20 }).some((m: any) => m.role === "orchestrator");
const refusals = {
  "login required": (host: any) => { host.prepareShellUser = async () => { throw new HttpError(409, "talkie_login_required", "probe: no Claude token"); }; },
  "seat helper missing": (host: any) => { host.shellUser.assertInstalled = () => { throw new HttpError(409, "seat_helper_required", "probe: helper missing"); }; },
} as const;

for (const [name, refuse] of Object.entries(refusals)) {
  test(`six refused access full requests (${name}) leave a healthy platform run alone`, async () => {
    await r.alex.client("").orchestratorStart({ access: "platform" });
    const host = r.host();
    await waitFor(() => host.child?.alive, { what: "platform child" });
    const child = host.child;
    refuse(host);
    try {
      for (let i = 1; i <= 6; i++) {
        await expect(host.setAccess("full")).rejects.toThrow("probe:");
        expect(host.restartTimer).toBeNull();
        expect(host.restarts).toBe(0);
        expect(host.attempt).toBe(0);
      }
      await Bun.sleep(400);
    } finally { delete host.prepareShellUser; delete host.shellUser.assertInstalled; }
    expect(host.state.gave_up).toBeUndefined();
    expect(host.phase).toBe("idle");
    expect(host.view().state).toBe("idle");
    expect(host.child).toBe(child);
    expect(child.alive).toBe(true);
    expect(host.state.access).toBe("platform");
    const m = host.say("hello after refusals", undefined, { via: "cli" });
    await waitFor(() => replied(r, m.thread), { what: "a reply after the refusals" });
  }, 60_000);
}

test("refused access full requests during a reply do not give up, and the next message is answered", async () => {
  await r.alex.client("").orchestratorStart({ access: "platform" });
  const host = r.host();
  await waitFor(() => host.child?.alive, { what: "platform child" });
  const child = host.child;
  const m1 = host.say("slow answer please", undefined, { via: "cli" });
  await waitFor(() => host.turn, { what: "reply in progress" });
  refusals["login required"](host);
  try {
    for (let i = 1; i <= 6; i++) {
      await expect(host.setAccess("full")).rejects.toThrow("probe:");
      expect(host.attempt).toBe(0);
      expect(host.phase).toBe("working");
    }
  } finally { delete host.prepareShellUser; }
  expect(host.state.gave_up).toBeUndefined();
  host.stopReply(m1.thread);
  await waitFor(() => !host.turn, { what: "the reply ends", timeoutMs: 15_000 });
  expect(host.phase).toBe("idle");
  expect(host.view().state).toBe("idle");
  expect(host.child).toBe(child);
  const m2 = host.say("are you there?", undefined, { via: "cli" });
  await waitFor(() => replied(r, m2.thread), { what: "a reply to the next message" });
}, 60_000);

test("a reply that ends after the give-up never moves the phase out of failed", async () => {
  await r.alex.client("").orchestratorStart({ access: "platform" });
  const host = r.host();
  await waitFor(() => host.child?.alive, { what: "platform child" });
  const first = host.say("slow answer please", undefined, { via: "cli" });
  await waitFor(() => host.turn, { what: "reply in progress" });
  const second = host.say("queued behind it", undefined, { via: "cli" });
  // A give-up that (by a bug elsewhere) left the child and its turn running: the reply's end must not undo it.
  host.phase = "failed";
  host.state = { ...host.state, gave_up: true };
  host.finishTurn({ kind: "result", ok: true, subtype: "success", text: "done" });
  expect(host.phase).toBe("failed");
  expect(host.view().state).toBe("failed");
  expect(host.turn).toBeNull();
  expect(host.queue.map((i: any) => i.id)).toEqual([second.id]);
  expect(replied(r, first.thread)).toBe(true);
}, 60_000);

test("a Claude crash still restarts through the real exit handler", async () => {
  await r.alex.client("").orchestratorStart({ access: "platform" });
  const host = r.host();
  await waitFor(() => host.child?.alive, { what: "platform child" });
  const first = host.child;
  first.terminate();
  await waitFor(() => host.restarts >= 1, { what: "a restart is scheduled" });
  expect(host.lastError).toContain("claude exited");
  expect(host.attempt).toBe(1);
  await waitFor(() => host.child?.alive && host.child !== first, { what: "a new child" });
  expect(host.state.gave_up).toBeUndefined();
}, 60_000);

test("a model switch refused while waiting for the lease schedules no restart", async () => {
  const host = waiting.host();
  const acquire = host.leadership.acquire.bind(host.leadership);
  let n = 0;
  // startNow gets the lease; boot and its resumes find none (phase stays stopped with the resume timer armed).
  host.leadership.acquire = async () => {
    if (n++ === 0) return acquire();
    Object.defineProperty(host.leadership, "valid", { get: () => false, configurable: true });
    return false;
  };
  await waiting.alex.client("").orchestratorStart({ access: "platform" }).catch(() => undefined);
  await waitFor(() => host.phase === "stopped" && host.state?.active, { what: "waiting for the lease" });
  for (let i = 1; i <= 6; i++) {
    await expect(host.setModel("sonnet")).rejects.toMatchObject({ code: "orchestrator_not_running" });
    expect(host.restartTimer).toBeNull();
    expect(host.attempt).toBe(0);
  }
  await Bun.sleep(400);
  expect(host.state.gave_up).toBeUndefined();
  expect(host.phase).toBe("stopped");
}, 60_000);
