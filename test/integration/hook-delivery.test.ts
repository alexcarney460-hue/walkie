// POST /v1/status with a hook delivery identity (src/protocol/hook-delivery.ts): one hook event that reaches the daemon
// twice is applied once, whatever configuration made it arrive twice, and nothing else is dropped.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { grokUpdate } from "../../src/hooks/grok.ts";
import type { HookDelivery } from "../../src/protocol/hook-delivery.ts";
import { Cluster, TEST_LIMITS, type TestNode } from "../helpers/cluster.ts";

let c: Cluster;
let node: TestNode;

beforeAll(async () => {
  c = new Cluster();
  // Every accepted status is signed at once (the default bucket would hold a burst back), so the log shows what was applied.
  node = await c.add({ name: "solo", login: "solo@example.com", hostname: "solo-mbp", limits: { ...TEST_LIMITS, status: { capacity: 1_000, perSecond: 1_000 } } });
  await node.client().init("acme", "solo");
});
afterAll(async () => { await c.close(); });

const signed = (agent: string) => node.d.core.store.db.query<{ n: number }, [string]>(
  "SELECT COUNT(*) AS n FROM events WHERE kind = 'agent.status' AND author_agent = ?").get(agent)?.n ?? 0;
// `repo` differs from report to report so that none is dropped by the daemon's older rule (an unchanged status within
// 2 s adds nothing): only the delivery identity can make a report a repeat here.
const status = (agent: string, repo: string) => ({ agent, state: "working", runtime: "other", runtime_name: "grok", repo });
const identity = (over: Partial<HookDelivery> = {}): HookDelivery => ({ session: "aaa111-0001", event: "PreToolUse", at: "2026-10-01T00:00:01Z", call: "t1", ...over });

describe("hook delivery identity on /v1/status", () => {
  test("a repeat of one delivery is applied once, even when the two reports differ", async () => {
    const agent = "grok-aaa111";
    const client = node.client(agent);
    const first = await client.status(status(agent, "first"), undefined, identity());
    expect(first.event).not.toBeNull();
    const second = await client.status(status(agent, "second"), undefined, identity());
    expect(second).toMatchObject({ event: null, duplicate: true });
    expect(signed(agent)).toBe(1);
  });

  test("a different event, time, call, turn or session is a different delivery", async () => {
    const agent = "grok-bbb222";
    const client = node.client(agent);
    const variants: Partial<HookDelivery>[] = [{}, { event: "PostToolUse" }, { at: "2026-10-01T00:00:02Z" }, { call: "t2" }, { call: undefined }, { turn: "p1" }, { session: "bbb222-0002" }];
    let n = 0;
    for (const v of variants) {
      const res = await client.status(status(agent, `step-${++n}`), undefined, identity(v));
      expect(res.event, JSON.stringify(v)).not.toBeNull();
    }
    expect(signed(agent)).toBe(variants.length);
  });

  test("the same identity from another agent is its own delivery", async () => {
    const a = "grok-ccc333", b = "grok-ddd444";
    expect((await node.client(a).status(status(a, "a-works"), undefined, identity())).event).not.toBeNull();
    expect((await node.client(b).status(status(b, "b-works"), undefined, identity())).event).not.toBeNull();
    expect(await node.client(a).status(status(a, "a-again"), undefined, identity())).toMatchObject({ duplicate: true });
  });

  test("a status with no identity, or a malformed one, is never dropped as a repeat", async () => {
    const agent = "grok-eee555";
    const client = node.client(agent);
    let n = 0;
    expect((await client.status(status(agent, "one"))).event).not.toBeNull();
    expect((await client.status(status(agent, "two"))).event).not.toBeNull();
    for (const bad of ["garbage", 7, [], { session: "", event: "Stop", at: "x" }]) {
      const res = await client.status(status(agent, `bad-${++n}`), undefined, bad as never);
      expect(res.event).not.toBeNull();
    }
    expect(signed(agent)).toBe(6);
  });

  test("two different notifications of one session in one second are two deliveries; the same one twice is one", async () => {
    const sid = "n0t111-0001";
    const env = { GROK_SESSION_ID: sid };
    const at = "2026-10-01T00:00:05Z";
    // Session-scoped: no promptId, and a notification carries no toolUseId (10-hooks.md), so only the type tells them apart.
    const note = (type: string) => JSON.stringify({ hook_event_name: "Notification", hookEventName: "notification", sessionId: sid, cwd: "/fixture", timestamp: at, notificationType: type, message: type });
    const send = async (type: string) => {
      const update = grokUpdate(note(type), env, { injected: [] }, { prompts: false, activity: false }, 1000, "claude")!;
      return node.client(update.body.agent).status(update.body, update.provenance, update.delivery);
    };
    const agent = "grok-n0t111";
    expect((await send("permission_prompt")).event).not.toBeNull();
    expect((await send("idle_prompt")).event).not.toBeNull(); // dropped as a repeat before the type was part of the identity
    expect(await send("idle_prompt")).toMatchObject({ event: null, duplicate: true });
    expect(await send("permission_prompt")).toMatchObject({ event: null, duplicate: true });
    expect(signed(agent)).toBe(2);
    const row = (await node.client().agents()).agents.find((a) => a.agent === agent);
    expect(row?.effective_state).toBe("idle"); // the later of the two real events decides
  });

  test("a refused status does not use up its delivery identity", async () => {
    const agent = "grok-fff666";
    // The agent in the body must match the caller's: this one is refused (403) before anything is remembered.
    await expect(node.client("grok-zzz999").status(status(agent, "not-mine"), undefined, identity())).rejects.toThrow();
    expect((await node.client(agent).status(status(agent, "mine"), undefined, identity())).event).not.toBeNull();
    expect(signed(agent)).toBe(1);
  });
});
