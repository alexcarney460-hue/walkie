import { afterAll, beforeAll, expect, test } from "bun:test";
import { rig, waitFor, type Rig } from "./orchestrator-merge4-setup.ts";

let r: Rig;
beforeAll(async () => { r = await rig(); }, 60_000);
afterAll(async () => { await r.c.close(); });

// A refused settings request no longer reaches the give-up (orchestrator-merge5-refused-settings), so this drives the
// give-up itself: whatever path reaches it, no Claude and no reply may be left running once WalkieTalkie reports failed.
test("give-up closes a live platform child and drops its turn", async () => {
  await r.alex.client("").orchestratorStart({ access: "platform" });
  const host = r.host();
  await waitFor(() => host.child?.alive, { what: "platform child" });
  const child = host.child;
  const item = host.say("keep working", undefined, { via: "cli" });
  await waitFor(() => host.turn?.item.id === item.id, { what: "live turn" });
  host.attempt = 4;
  host.scheduleRestart();
  expect(host.phase).toBe("failed");
  await waitFor(() => host.phase === "failed", { what: "give-up" });
  await waitFor(() => !child.alive, { what: "child closed" });
  expect(host.child).toBeNull();
  expect(host.turn).toBeNull();
  expect(r.alex.d.core.store.orchMessage(item.id)?.state).toBe("dropped");
  expect(host.phase).toBe("failed");
  expect(host.leadership.valid).toBe(true);
}, 60_000);
