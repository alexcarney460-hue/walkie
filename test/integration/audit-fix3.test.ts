// FIX-3 (ALE-5156) on live clusters: roster-request idempotency survives an authority transfer
// (hestia C5), and a topic-only channel update keeps a restricted channel restricted (Fable F4 / E3).
import { afterEach, describe, expect, test } from "bun:test";
import { signRequest } from "../../src/daemon/requests.ts";
import type { RosterRequest } from "../../src/protocol/schemas.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

let c: Cluster | null = null;
afterEach(async () => { await c?.close(); c = null; });

async function sendReq(caller: TestNode, to: TestNode, req: RosterRequest): Promise<{ status: number; json: { event?: { id: string } | null } }> {
  const res = await fetch(`http://127.0.0.1:${to.peerPort}/peer/v1/roster-request`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-walkie-node": caller.d.nodeId, "x-walkie-team": to.d.core.teamId as string },
    body: JSON.stringify(req),
  });
  return { status: res.status, json: (await res.json()) as never };
}

/** alex (authority/founder), kira and bob (owners), mem (member), all joined. */
async function team(): Promise<{ alex: TestNode; kira: TestNode; bob: TestNode; mem: TestNode }> {
  c = new Cluster();
  const alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  const kira = await c.add({ name: "kira", login: "kira@example.com", hostname: "kiras-mbp" });
  const bob = await c.add({ name: "bob", login: "bob@example.com", hostname: "bob-mbp" });
  const mem = await c.add({ name: "mem", login: "mem@example.com", hostname: "mem-mbp" });
  await alex.client().init("acme", "alex");
  await alex.client().invite("kira@example.com", "kira", "owner");
  await alex.client().invite("bob@example.com", "bob", "owner");
  await alex.client().invite("mem@example.com", "mem", "member");
  for (const n of [kira, bob, mem]) if (!(await n.client().join(alex.peerAddr)).admitted) throw new Error(`${n.spec.name} join`);
  await waitFor(() => [kira, bob, mem].every((n) => n.d.core.roster.nodes.size === 4), { what: "roster synced" });
  return { alex, kira, bob, mem };
}

describe("C5: roster requests stay idempotent across an authority transfer", () => {
  test("a retried promotion after a demotion and a transfer returns the original event and changes nothing", async () => {
    const { alex, kira, bob, mem } = await team();
    const q = signRequest(bob.d.core, "team.member", { login: "mem@example.com", handle: "mem", role: "owner" });
    const first = await sendReq(bob, alex, q);
    expect(first.status).toBe(200);
    const original = first.json.event?.id as string;
    expect(alex.d.core.roster.members.get("mem@example.com")?.role).toBe("owner");
    await alex.client().setRole("mem", "member"); // demoted afterwards
    await alex.client().setAuthority("kiras-mbp");
    await waitFor(() => [alex, kira, bob, mem].every((n) => n.d.core.authority === kira.d.nodeId
      && n.d.core.roster.members.get("mem@example.com")?.role === "member"), { what: "transfer + demotion everywhere" });
    const retry = await sendReq(bob, kira, q); // e.g. bob lost the first response
    expect(retry.status).toBe(200);
    expect(retry.json.event?.id).toBe(original);
    expect(kira.d.core.roster.members.get("mem@example.com")?.role).toBe("member");
    const again = await sendReq(bob, kira, q);
    expect(again.json.event?.id).toBe(original);
  }, 30_000);
});

describe("F4 (E3): a topic-only update keeps a restricted channel restricted", () => {
  test("members are carried over; a non-member never gets the restricted history", async () => {
    const { alex, kira, mem } = await team();
    await alex.client().channel({ name: "vault", members: ["alex", "kira"] });
    const { event } = await alex.client().post({ channel: "vault", text: "restricted history" });
    await waitFor(() => mem.d.core.store.getRow(event.id)?.redacted === 1, { what: "mem holds a stub" });
    const up = await alex.client().channel({ name: "vault", topic: "renamed topic" });
    expect((up.event.body as { members?: string[] }).members).toEqual(["alex", "kira"]);
    await waitFor(() => mem.d.core.roster.channels.get("vault")?.topic === "renamed topic", { what: "topic replicated" });
    expect(mem.d.core.roster.channels.get("vault")?.members).toEqual(["alex", "kira"]);
    await Bun.sleep(1_500); // a sync round in which a declassified stub would be filled
    expect((await mem.client().events({ channel: "vault" })).events).toEqual([]);
    expect(mem.d.core.store.getRow(event.id)?.redacted).toBe(1);
    // Opening it is an explicit owner act.
    await alex.client().channel({ name: "vault", public: true });
    await waitFor(() => mem.d.core.roster.channels.get("vault")?.members === undefined, { what: "vault public" });
    await waitFor(async () => (await mem.client().events({ channel: "vault" })).events.length === 1 || null, { what: "mem filled the stub" });
    void kira;
  }, 30_000);
});
