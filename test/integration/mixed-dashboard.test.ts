// v0.2.0-pre.2 integration smoke: main's dashboard sessions (X-Walkie-Session, no cookie authority) on a mixed team.
//   alex   Tailscale (fake tailnet) + Walkie Direct after `walkie direct enable` (dual), the roster authority
//   arvid  Walkie Direct only, joined with an invite code alex's DASHBOARD minted (POST /v1/team/invite-code)
// Both exchange posts, and every route the dashboard's client (web/src/api/client.ts) reads loads with a session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

let c: Cluster;
let alex: TestNode, arvid: TestNode;

beforeAll(async () => {
  c = new Cluster();
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", dual: true });
  arvid = await c.add({ name: "arvid", login: "-", hostname: "arvid-mbp", direct: true });
}, 30_000);
afterAll(async () => { await c.close(); });

const base = (n: TestNode) => `http://127.0.0.1:${n.d.localPort as number}`;

/** `walkie dashboard` on node n: a nonce over the unix socket, exchanged at /auth for a session in the fragment. */
async function session(n: TestNode): Promise<Record<string, string>> {
  const { nonce } = await n.client().authNonce();
  const res = await fetch(`${base(n)}/auth?nonce=${nonce}`, { redirect: "manual" });
  const value = /#s=([0-9a-f]{64})$/.exec(res.headers.get("location") ?? "")?.[1] ?? "";
  expect(value).toMatch(/^[0-9a-f]{64}$/);
  return { "X-Walkie-Session": value };
}

const post = (n: TestNode, h: Record<string, string>, path: string, body: unknown) => fetch(`${base(n)}${path}`, {
  method: "POST", headers: { ...h, Origin: base(n), "Content-Type": "application/json" }, body: JSON.stringify(body),
});

const texts = async (n: TestNode, h: Record<string, string>) => {
  const res = await fetch(`${base(n)}/v1/events?channel=general&kinds=msg.post`, { headers: h });
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: { body: { text?: string } }[] }).events.map((e) => e.body.text);
};

/** The GETs the dashboard makes on load (web/src/api/client.ts), plus the SSE stream's first bytes. */
async function dashboardLoads(n: TestNode, h: Record<string, string>): Promise<Record<string, number>> {
  const paths = ["/v1/me", "/v1/team", "/v1/agents", "/v1/peers", "/v1/accounts", "/v1/events?channel=general",
    "/v1/asks?state=open", "/v1/team/pending", "/v1/license", "/v1/integrations", "/v1/linear/issues?keys=ALE-1"];
  const out: Record<string, number> = {};
  for (const p of paths) out[p] = (await fetch(`${base(n)}${p}`, { headers: h })).status;
  const ac = new AbortController();
  const s = await fetch(`${base(n)}/v1/stream`, { headers: { ...h, Accept: "text/event-stream" }, signal: ac.signal });
  out["/v1/stream"] = s.status;
  if (s.ok) {
    const first = await s.body!.getReader().read();
    expect(new TextDecoder().decode(first.value)).toContain("hello");
  }
  ac.abort();
  return out;
}

describe("mixed team + dashboard sessions (v0.2.0-pre.2 smoke)", () => {
  test("the authority's dashboard mints an invite code; a Direct-only machine joins with it", async () => {
    await alex.client().init("aka", "alex");
    await alex.client().request("POST", "/v1/direct/enable", {});
    const h = await session(alex);
    // /v1/direct/enable changes config: never reachable with a dashboard session
    expect((await post(alex, h, "/v1/direct/enable", {})).status).toBe(403);
    const res = await post(alex, h, "/v1/team/invite-code", { handle: "arvid", role: "member" });
    expect(res.status).toBe(200);
    const { code } = (await res.json()) as { code: string };
    expect(code.startsWith("wk1")).toBe(true);
    expect(await arvid.client().join(code)).toMatchObject({ admitted: true, handle: "arvid" });
  }, 30_000);

  test("posts cross both ways, sent and read through dashboard sessions", async () => {
    const ha = await session(alex);
    const hj = await session(arvid);
    expect((await post(alex, ha, "/v1/post", { channel: "general", text: "alex (dual) → arvid" })).status).toBe(200);
    expect((await post(arvid, hj, "/v1/post", { channel: "general", text: "arvid (direct) → alex" })).status).toBe(200);
    await waitFor(async () => (await texts(arvid, hj)).includes("alex (dual) → arvid"), { timeoutMs: 10_000, what: "arvid sees alex's post" });
    await waitFor(async () => (await texts(alex, ha)).includes("arvid (direct) → alex"), { timeoutMs: 10_000, what: "alex sees arvid's post" });
  }, 30_000);

  test("the dashboard loads on both machines with no 401/403", async () => {
    for (const n of [alex, arvid]) {
      const statuses = await dashboardLoads(n, await session(n));
      console.log(`[smoke] ${n.spec.name} dashboard: ${JSON.stringify(statuses)}`);
      for (const [p, s] of Object.entries(statuses)) expect([p, s]).toEqual([p, 200]);
    }
    const peers = (await (await fetch(`${base(alex)}/v1/peers`, { headers: await session(alex) })).json()) as { nodes: { hostname: string; transports?: string[] }[] };
    expect(peers.nodes.find((x) => x.hostname === "arvid-mbp")?.transports).toEqual(["direct"]);
  }, 30_000);
});
