// FIX-4 (ALE-5156) on live clusters: a padding-stripped roster request is never applied twice (hestia
// H3 / Fable F3), and an owner can't mint a machine under another member's login (Fable F4).
import { afterEach, describe, expect, test } from "bun:test";
import { generateKeys, signEvent } from "../../src/daemon/keys.ts";
import { signRequest } from "../../src/daemon/requests.ts";
import { eventId } from "../../src/protocol/ids.ts";
import { PROTOCOL_VERSION, type Event, type RosterRequest } from "../../src/protocol/schemas.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { signedPeerFetch } from "../helpers/signed-peer-fetch.ts";

let c: Cluster | null = null;
afterEach(async () => { await c?.close(); c = null; });

async function sendReq(caller: TestNode, to: TestNode, req: RosterRequest): Promise<{ status: number; json: { event?: { id: string } | null; error?: { code: string; message: string } } }> {
  const res = await signedPeerFetch(caller, to, "/peer/v1/roster-request", { method: "POST", body: JSON.stringify(req) });
  return { status: res.status, json: (await res.json()) as never };
}

/** alex (authority), kira (owner), mem (member), all joined, #general everywhere. */
async function team(): Promise<{ alex: TestNode; kira: TestNode; mem: TestNode }> {
  c = new Cluster();
  const alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  const kira = await c.add({ name: "kira", login: "kira@example.com", hostname: "kiras-mbp" });
  const mem = await c.add({ name: "mem", login: "mem@example.com", hostname: "mem-mbp" });
  await alex.client().init("acme", "alex");
  await alex.client().invite("kira@example.com", "kira", "owner");
  await alex.client().invite("mem@example.com", "mem", "member");
  for (const n of [kira, mem]) if (!(await n.client().join(alex.peerAddr)).admitted) throw new Error(`${n.spec.name} join`);
  await waitFor(() => [kira, mem].every((n) => n.d.core.roster.nodes.size === 3 && n.d.core.roster.channels.has("general")), { what: "synced" });
  return { alex, kira, mem };
}

describe("H3/F3: a re-encoded roster request signature neither bypasses dedup nor re-applies", () => {
  test("stripping the signature's padding after a demotion is refused; the original stays deduplicated", async () => {
    const { alex, kira } = await team();
    const q = signRequest(kira.d.core, "team.member", { login: "mem@example.com", handle: "mem", role: "owner" });
    const first = await sendReq(kira, alex, q);
    expect(first.status).toBe(200);
    await alex.client().setRole("mem", "member");
    const stripped = await sendReq(kira, alex, { ...q, sig: q.sig.replace(/=+$/, "") });
    expect(stripped.status).toBe(403);
    expect(alex.d.core.roster.members.get("mem@example.com")?.role).toBe("member");
    const retry = await sendReq(kira, alex, q);
    expect(retry.json.event?.id).toBe(first.json.event?.id as string);
    expect(alex.d.core.roster.members.get("mem@example.com")?.role).toBe("member");
  }, 30_000);
});

describe("F4: an owner's team.node request can't bind a key to another member's login", () => {
  test("the impersonation request is refused and a post signed by the minted key never shows as @mem", async () => {
    const { alex, kira, mem } = await team();
    const fake = generateKeys();
    const tn = signRequest(kira.d.core, "team.node", { node_id: fake.nodeId, login: "mem@example.com", hostname: "ghost", pubkey: fake.pubkey, ip: "127.0.0.1", port: 1 });
    const res = await sendReq(kira, alex, tn);
    expect(res.status).toBe(403);
    expect(res.json.error?.message).toContain("not_own_node");
    expect(alex.d.core.roster.nodes.has(fake.nodeId)).toBe(false);
    const forged: Event = signEvent(fake, {
      v: PROTOCOL_VERSION, team: alex.d.core.teamId as string, id: eventId(fake.nodeId, 1), origin: fake.nodeId, seq: 1, ts: Date.now(),
      author: { handle: "mem", node: fake.nodeId }, kind: "msg.post", channel: "general", body: { text: "I (mem) resign" },
    });
    const push = await signedPeerFetch(kira, alex, "/peer/v1/events", { method: "POST", body: JSON.stringify({ events: [forged] }) });
    expect(((await push.json()) as { accepted: number }).accepted).toBe(0);
    await Bun.sleep(1_000);
    expect((await mem.client().events({ channel: "general" })).events.find((e) => e.id === forged.id)).toBeUndefined();
    expect((await alex.client().events({ channel: "general" })).events.find((e) => e.id === forged.id)).toBeUndefined();
  }, 30_000);
});
