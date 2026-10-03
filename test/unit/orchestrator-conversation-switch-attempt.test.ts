import { expect, test } from "bun:test";
import { rig, waitFor } from "./orchestrator-merge4-setup.ts";

test("successful full-access conversation switches do not exhaust restart attempts", async () => {
  const r = await rig();
  try {
    await r.alex.client("").orchestratorStart({ access: "full" });
    const host = r.host();
    await waitFor(() => host.child?.alive, { what: "first fake Claude launch" });

    // Seven different threads require six deliberate child switches, past the five-failure limit.
    for (let n = 0; n < 7; n++) {
      const message = host.say(`conversation ${n}`, undefined, { via: "cli" });
      await waitFor(() => host.state.gave_up || r.alex.d.core.store.orchMessages({ thread: message.thread, limit: 10 })
        .some((reply: { role: string }) => reply.role === "orchestrator"),
      { what: `reply or give-up on conversation ${n}`, timeoutMs: 15_000 });
      expect(host.state.gave_up).toBeFalsy();
      expect(r.alex.d.core.store.orchMessages({ thread: message.thread, limit: 10 })
        .some((reply: { role: string; text: string }) => reply.role === "orchestrator" && reply.text === `pong: conversation ${n}`)).toBe(true);
    }
    expect(r.rows().length).toBeGreaterThan(5);
    expect(host.attempt).toBeLessThanOrEqual(1);
  } finally {
    await r.c.close();
  }
}, 90_000);
