// FIX-2 (single-writer roster authority, ALE-5156) on live clusters: re-audit #3 (blob provenance)
// and #4 (byte-budgeted pages), roster requests (concurrent, queued while the authority is offline),
// authority transfer, and member channel creation through the authority.
import { afterEach, describe, expect, test } from "bun:test";
import { signEvent } from "../../src/daemon/keys.ts";
import { sha256Hex } from "../../src/daemon/blobs.ts";
import { renderWho } from "../../src/cli/commands/team.ts";
import { PEER_PAGE_BUDGET, PROTOCOL_VERSION, type UnsignedEvent } from "../../src/protocol/schemas.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { signedPeerFetch } from "../helpers/signed-peer-fetch.ts";

let c: Cluster | null = null;
afterEach(async () => { await c?.close(); c = null; });

function forge(n: TestNode, over: Partial<UnsignedEvent> & Pick<UnsignedEvent, "kind" | "body">): ReturnType<typeof signEvent> {
  const k = n.d.core.keys;
  const seq = n.d.core.store.selfSeq(k.nodeId) + 1;
  return signEvent(k, {
    v: PROTOCOL_VERSION, team: n.d.core.teamId as string, id: `${k.nodeId}:${seq}`, origin: k.nodeId, seq, ts: Date.now(),
    author: { handle: n.d.core.myHandle() ?? "x", node: k.nodeId }, ...over,
  });
}

async function pushAs(from: TestNode, to: TestNode, events: unknown[]): Promise<{ accepted: number; rejected: { id: string; reason: string }[] }> {
  const res = await signedPeerFetch(from, to, "/peer/v1/events", { method: "POST", body: JSON.stringify({ events }) });
  return (await res.json()) as never;
}

function peerGet(from: TestNode, to: TestNode, path: string): Promise<Response> {
  return signedPeerFetch(from, to, path);
}

/** alex (authority/founder) + kira and bob, both owners, joined. */
async function owners(): Promise<{ alex: TestNode; kira: TestNode; bob: TestNode }> {
  c = new Cluster();
  const alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  const kira = await c.add({ name: "kira", login: "kira@example.com", hostname: "kiras-mbp" });
  const bob = await c.add({ name: "bob", login: "bob@example.com", hostname: "bob-mbp" });
  await alex.client().init("acme", "alex");
  await alex.client().invite("kira@example.com", "kira", "owner");
  await alex.client().invite("bob@example.com", "bob", "owner");
  if (!(await kira.client().join(alex.peerAddr)).admitted) throw new Error("kira join");
  if (!(await bob.client().join(kira.peerAddr)).admitted) throw new Error("bob join"); // redirected to the authority
  return { alex, kira, bob };
}

const rosterOf = (n: TestNode): string => JSON.stringify([...n.d.core.roster.members.values()].sort((a, b) => a.login.localeCompare(b.login)));

describe("re-audit #3: blob access follows (channel, hash) provenance", () => {
  test("a signed share announcement in another restricted channel doesn't unlock the bytes", async () => {
    const { alex, kira, bob } = await owners();
    await alex.client().channel({ name: "vault", members: ["alex"] });
    await alex.client().channel({ name: "project", members: ["alex", "kira"] });
    const secret = new TextEncoder().encode("vault-only bytes");
    const { event } = await alex.client().share(secret, { name: "v.txt", mime: "text/plain", channel: "vault" });
    const hash = (event.body as { hash: string }).hash;
    await waitFor(() => kira.d.core.roster.channels.has("project"), { what: "kira knows #project" });
    const announce = forge(kira, { kind: "artifact.share", channel: "project", body: { hash, name: "v.txt", size: secret.byteLength, mime: "text/plain" } });
    expect((await pushAs(kira, alex, [announce])).accepted).toBe(1);
    expect((await peerGet(kira, alex, `/peer/v1/blobs/${hash}?channel=project`)).status).toBe(404);
    expect((await peerGet(kira, alex, `/peer/v1/blobs/${hash}?channel=vault`)).status).toBe(404);
    await expect(kira.client().fetchArtifact(hash)).rejects.toMatchObject({ status: 404 });
    expect(new TextDecoder().decode(await alex.client().fetchArtifact(hash))).toBe("vault-only bytes");
    // A real share in #project carries provenance: kira fetches it, and then may serve it onward.
    const shared = await alex.client().share(new TextEncoder().encode("project bytes"), { name: "p.txt", mime: "text/plain", channel: "project" });
    const ph = (shared.event.body as { hash: string }).hash;
    await waitFor(() => kira.d.core.store.getRow(shared.event.id)?.status === "ok", { what: "share on kira" });
    expect(sha256Hex(await kira.client().fetchArtifact(ph))).toBe(ph);
    expect(kira.d.core.store.hasProvenance("project", ph)).toBe(true);
    expect((await peerGet(bob, kira, `/peer/v1/blobs/${ph}?channel=project`)).status).toBe(404); // bob can't see #project
  }, 20_000);
});

describe("re-audit #4: byte-budgeted pages", () => {
  test("34 posts of 32,000 characters replicate to a late joiner; each page stays under the budget", async () => {
    const { alex, kira } = await owners();
    for (let i = 0; i < 34; i++) await alex.client().post({ channel: "general", text: `${i} ${"x".repeat(31_990)}`, raw: true });
    const res = await peerGet(kira, alex, `/peer/v1/events?origin=${alex.d.nodeId}&after=0&limit=500`);
    const raw = await res.arrayBuffer();
    expect(res.status).toBe(200);
    expect(raw.byteLength).toBeLessThanOrEqual(PEER_PAGE_BUDGET);
    const page = (JSON.parse(new TextDecoder().decode(raw)) as { events: unknown[] }).events.length;
    console.log(`[metric] first page: ${page} of ${alex.d.core.store.vvOf(alex.d.nodeId)} events, ${raw.byteLength} bytes`);
    expect(page).toBeLessThan(alex.d.core.store.vvOf(alex.d.nodeId)); // the budget, not the 500 limit, ended it
    const late = await c?.add({ name: "dan", login: "kira@example.com", hostname: "kiras-pi" });
    if (!late) throw new Error("no cluster");
    expect(await late.client().join(alex.peerAddr)).toMatchObject({ admitted: false, reason: "pending_approval" });
    await alex.client().request("POST", "/v1/team/admit", { node_id: late.d.nodeId, approve: true });
    expect((await late.client().join(alex.peerAddr)).admitted).toBe(true);
    await waitFor(() => late.d.core.store.vvOf(alex.d.nodeId) >= alex.d.core.store.vvOf(alex.d.nodeId), { what: "late joiner caught up", timeoutMs: 10_000 });
  }, 30_000);
});

describe("roster requests to the authority", () => {
  test("two owners requesting concurrently get one linear result on every replica", async () => {
    const { alex, kira, bob } = await owners();
    const results = await Promise.allSettled([
      kira.client().invite("carol@example.com", "carol", "member"),
      bob.client().invite("carol@example.com", "caz", "member"),
      kira.client().channel({ name: "k-room" }),
      bob.client().channel({ name: "b-room", topic: "bob" }),
    ]);
    const invites = results.slice(0, 2);
    expect(invites.filter((r) => r.status === "fulfilled").length).toBe(1);
    const lost = invites.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ status: 403 });
    expect(results.slice(2).every((r) => r.status === "fulfilled")).toBe(true);
    const handle = alex.d.core.roster.members.get("carol@example.com")?.handle;
    await waitFor(() => [kira, bob].every((n) => rosterOf(n) === rosterOf(alex) && n.d.core.roster.channels.has("b-room") && n.d.core.roster.channels.has("k-room")),
      { what: "replicas converge", timeoutMs: 8_000 });
    for (const n of [kira, bob]) expect(n.d.core.roster.members.get("carol@example.com")?.handle).toBe(handle as string);
    const bobInvite = (results[1] as PromiseFulfilledResult<{ event: { body: { requested_by?: string } } }>);
    if (bobInvite.status === "fulfilled") expect(bobInvite.value.event.body.requested_by).toBe("bob");
  }, 20_000);

  test("a request made while the authority is offline is queued (202) and applied when it returns", async () => {
    const { alex, kira } = await owners();
    await alex.stop();
    const res = await kira.client().request<{ queued?: boolean; request_id?: string }>("POST", "/v1/team/invite", { login: "dave@example.com", handle: "dave", role: "member" });
    expect(res.queued).toBe(true);
    const pending = await kira.client().request<{ roster_requests: { id: string; kind: string }[] }>("GET", "/v1/team/pending");
    expect(pending.roster_requests.map((r) => r.kind)).toEqual(["team.member"]);
    await expect(kira.client().post({ channel: "fresh", text: "hi" })).rejects.toMatchObject({ status: 409 });
    await alex.start();
    await waitFor(() => kira.d.core.roster.members.get("dave@example.com")?.handle === "dave", { what: "applied after the authority returns", timeoutMs: 10_000 });
    await waitFor(() => kira.d.core.roster.channels.has("fresh"), { what: "queued channel creation applied", timeoutMs: 10_000 });
    // The replicated event lands on kira (via the request's catch-up or plain anti-entropy) BEFORE
    // flushRequests dequeues the row, so the queue empties strictly after the roster shows the change.
    const after = await waitFor(async () => {
      const p = await kira.client().request<{ roster_requests: unknown[] }>("GET", "/v1/team/pending");
      return p.roster_requests.length === 0 ? p : null;
    }, { what: "queued requests dequeued after they applied", timeoutMs: 10_000 });
    expect(after.roster_requests).toEqual([]);
    expect(alex.d.core.roster.members.get("dave@example.com")?.handle).toBe("dave");
  }, 30_000);

  test("a member creates a new public channel by posting to it (through the authority)", async () => {
    const { alex } = await owners();
    const mem = await c?.add({ name: "mem", login: "m@example.com", hostname: "mem-mbp" });
    if (!mem) throw new Error("no cluster");
    await alex.client().invite("m@example.com", "mem", "member");
    expect((await mem.client().join(alex.peerAddr)).admitted).toBe(true);
    const { event } = await mem.client().post({ channel: "ideas", text: "first!" });
    expect(mem.d.core.roster.channels.has("ideas")).toBe(true);
    await waitFor(() => alex.d.core.store.getRow(event.id)?.status === "ok", { what: "post accepted on the authority" });
    await expect(mem.client().channel({ name: "ideas", members: ["mem"] })).rejects.toMatchObject({ status: 403 });
  }, 20_000);
});

describe("authority transfer", () => {
  test("after a transfer the old authority's roster events are rejected; the new one writes; joins redirect", async () => {
    const { alex, kira, bob } = await owners();
    const moved = await alex.client().setAuthority("kiras-mbp");
    expect("event" in moved && moved.event?.kind).toBe("team.authority");
    await waitFor(() => [alex, kira, bob].every((n) => n.d.core.authority === kira.d.nodeId), { what: "all see kira as authority" });
    const inv = await kira.client().invite("erin@example.com", "erin", "member");
    expect((inv.event.body as { after?: string }).after).toBe(moved && "event" in moved ? moved.event?.id : "");
    const stale = forge(alex, { kind: "team.member", body: { login: "mallory@example.com", handle: "mallory", role: "owner" } });
    expect((await pushAs(alex, bob, [stale])).rejected.map((r) => r.reason)).toEqual(["not_authority"]);
    expect(bob.d.core.roster.members.has("mallory@example.com")).toBe(false);
    // The old authority keeps its owner powers through requests.
    const viaRequest = await alex.client().invite("finn@example.com", "finn", "member");
    expect(viaRequest.event.origin).toBe(kira.d.nodeId);
    expect((viaRequest.event.body as { requested_by?: string }).requested_by).toBe("alex");
    // Joins through the old authority are redirected to the new one.
    const erin = await c?.add({ name: "erin", login: "erin@example.com", hostname: "erin-mbp" });
    if (!erin) throw new Error("no cluster");
    expect((await erin.client().join(alex.peerAddr)).admitted).toBe(true);
    const team = await bob.client().team();
    expect(team.authority).toBe(kira.d.nodeId);
    expect(renderWho(team, [])).toContain("roster authority");
  }, 20_000);
});
