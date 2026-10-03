// TALKIE-OPS-1 review fix: a scheduled turn ends, but its Claude child (and in full access its shell) can stay alive with the
// child's token, so a background job it started could write after the turn. The local API keeps holding that child to a scheduled
// turn's limits until a new child replaces it, and the next message, from a person or a schedule, always gets a new child with a
// new token. Real daemon and host, the fake Claude, platform and full access.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rig, waitFor, type Rig } from "./orchestrator-race-setup.ts";
import { ORCHESTRATOR_TOKEN_HEADER } from "../../src/protocol/orchestrator.ts";

let r: Rig;
beforeAll(async () => { r = await rig(); }, 60_000);
afterAll(async () => { await r.c.close(); });

/** A request as WalkieTalkie's child would make it: its agent name and the token from its environment. */
async function asChild(path: string, token: string, body: unknown): Promise<{ status: number; code?: string }> {
  const res = await fetch(`http://walkie${path}`, { unix: r.alex.socket, method: "POST",
    headers: { "content-type": "application/json", "X-Walkie-Agent": "orchestrator", [ORCHESTRATOR_TOKEN_HEADER]: token }, body: JSON.stringify(body) } as RequestInit);
  const answer = await res.json().catch(() => null) as { error?: { code?: string } } | null;
  return { status: res.status, ...(answer?.error?.code ? { code: answer.error.code } : {}) };
}

for (const access of ["platform", "full"] as const) {
  test(`${access} access: after a scheduled turn its child cannot act until replaced; the next message gets a new, unheld child`, async () => {
    await r.alex.client("").orchestratorStart({ access });
    const room = `planted-${access}`; // a channel nobody has made (the new child below may make it)
    const host = r.host();
    await waitFor(() => host.child?.alive && (access === "platform" || host.shellUser.active), { what: "the first child" });
    const scheduled = host.say("Scheduled check of the boards", undefined, { via: "schedule" });
    await waitFor(() => host.scheduleReplies.has(scheduled.id) && !host.turn, { what: "the scheduled reply" });
    const token = host.childToken as string;
    expect(host.child?.alive).toBe(true); // the child outlives its turn
    expect(host.scheduledTurnActive()).toBe(false);
    expect(host.scheduledChildActive()).toBe(true);
    // A job the scheduled turn left running keeps the token: still nothing but a post in an existing channel or a recommendation.
    expect(await asChild("/v1/channels", token, { name: room })).toMatchObject({ status: 403, code: "scheduled_turn_cannot_act" });
    expect(await asChild("/v1/post", token, { channel: room, text: "hello" })).toMatchObject({ status: 403, code: "scheduled_turn_cannot_act" });
    expect(await asChild("/v1/auth/rotate", token, {})).toMatchObject({ status: 403, code: "scheduled_turn_cannot_act" });
    expect(r.alex.d.core.roster.channels.has(room)).toBe(false);

    host.say("hello from the person", undefined, { via: "cli" });
    await waitFor(() => !!host.childToken && host.childToken !== token && host.child?.alive && !host.turn && host.phase === "idle",
      { what: "a new child for the person's message", timeoutMs: 30_000 });
    expect(host.scheduledChildActive()).toBe(false);
    // The old token is dead with its child; the new child is the person's conversation and is not held back.
    expect(await asChild("/v1/channels", token, { name: room })).toMatchObject({ status: 403, code: "forbidden" });
    expect((await asChild("/v1/channels", host.childToken as string, { name: room })).code).not.toBe("scheduled_turn_cannot_act");
    await r.alex.client("").orchestratorStop();
  }, 60_000);
}
