import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { dispatch, type RouteCtx } from "../../src/daemon/local-routes.ts";
import { flushRequests } from "../../src/daemon/requests.ts";

setDefaultTimeout(60_000);
let cluster: Cluster;
let owner: TestNode;
let forwardingOwner: TestNode;
let member: TestNode;

beforeAll(async () => {
  cluster = new Cluster();
  owner = await cluster.add({ name: "owner", login: "-", direct: true });
  forwardingOwner = await cluster.add({ name: "forwarder", login: "-", direct: true });
  member = await cluster.add({ name: "member", login: "-", direct: true });
  await owner.client().init("fixture", "owner");
  await forwardingOwner.client().join((await owner.client().inviteCode("forwarder", "owner")).code);
  await member.client().join((await owner.client().inviteCode("member", "member")).code);
  await waitFor(() => forwardingOwner.d.core.roster.members.has("direct:member"));
});

afterAll(async () => { await cluster?.close(); });

async function session(node: TestNode) {
  const origin = `http://127.0.0.1:${node.d.localPort}`;
  const { nonce } = await node.client().authNonce();
  const response = await fetch(`${origin}/auth?nonce=${nonce}`, { redirect: "manual" });
  const value = /#s=([0-9a-f]{64})$/.exec(response.headers.get("location") ?? "")?.[1];
  expect(Boolean(value)).toBe(true);
  return { origin, headers: { "X-Walkie-Session": value!, Origin: origin, "Content-Type": "application/json" } };
}

type Decision = { node_id: string; link: string; generation: string; approve: boolean };
type BrowserSession = Awaited<ReturnType<typeof session>>;

function decide(browser: BrowserSession, body: Decision, headers = browser.headers) {
  return fetch(`${browser.origin}/v1/team/admit-link`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
}

for (const forwarded of [false, true]) test(`an ended ${forwarded ? "forwarded" : "authority"} dashboard credential cannot decide a pending fleet join`, async () => {
  const decider = forwarded ? forwardingOwner : owner;
  const link = await owner.client().mintLink({ for: "owner", owner_machines: true, approve: true });
  const waiter = await cluster.add({ name: `ended-session-waiter-${Number(forwarded)}`, login: "-", direct: true });
  expect((await waiter.client().joinLink(link.token)).reason).toBe("pending_approval");
  const row = (await decider.client().links()).uses.find((use) => use.node_id === waiter.d.nodeId && use.state === "pending")!;
  const pending = owner.d.core.store.joinRequest(waiter.d.nodeId);
  const credential = new AbortController();
  credential.abort();

  for (const [path, body] of [
    ["/v1/team/admit-link", { node_id: row.node_id, link: row.link, generation: row.generation, approve: true }],
    ["/v1/team/admit", { node_id: row.node_id, approve: true }],
  ] as const) {
    const req = new Request(`http://127.0.0.1${path}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    const ctx: RouteCtx = {
      core: decider.d.core, sync: decider.d.sync, client: decider.d.client, req, url: new URL(req.url),
      via: "dashboard", listener: "tcp", dashboard: true, credentialSignal: credential.signal, noTimeout: () => {},
    };
    await expect(dispatch(ctx)).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(owner.d.core.store.joinRequest(waiter.d.nodeId)).toEqual(pending);
    expect(owner.d.core.roster.nodes.has(waiter.d.nodeId)).toBe(false);
  }
});

test("a forwarded dashboard approval is not replayed after its session ends", async () => {
  const link = await owner.client().mintLink({ for: "owner", owner_machines: true, approve: true });
  const waiter = await cluster.add({ name: "queued-session-waiter", login: "-", direct: true });
  expect((await waiter.client().joinLink(link.token)).reason).toBe("pending_approval");
  const row = (await forwardingOwner.client().links()).uses.find((use) => use.node_id === waiter.d.nodeId && use.state === "pending")!;
  const credential = new AbortController();
  const req = new Request("http://127.0.0.1/v1/team/admit-link", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_id: row.node_id, link: row.link, generation: row.generation, approve: true }),
  });
  const unavailableClient = new Proxy(forwardingOwner.d.client, {
    get(target, property, receiver) {
      if (property === "addrOf") return () => null;
      return Reflect.get(target, property, receiver);
    },
  });
  const ctx: RouteCtx = {
    core: forwardingOwner.d.core, sync: forwardingOwner.d.sync, client: unavailableClient,
    req, url: new URL(req.url), via: "dashboard", listener: "tcp", dashboard: true,
    credentialSignal: credential.signal, noTimeout: () => {},
  };
  const outcome = await dispatch(ctx).then((response) => ({ status: response.status }), (error: { status: number }) => ({ status: error.status }));
  credential.abort();
  await flushRequests(forwardingOwner.d.core, forwardingOwner.d.client, forwardingOwner.d.sync.requestCatchUp);
  expect(outcome.status).toBe(503);
  expect(forwardingOwner.d.core.store.queuedRequests().filter((queued) => {
    const request = JSON.parse(queued.json) as { kind: string; body: { node_id?: string } };
    return request.kind === "team.admit-link" && request.body.node_id === waiter.d.nodeId;
  })).toHaveLength(0);
  expect(owner.d.core.store.joinRequest(waiter.d.nodeId)).not.toBeNull();
  expect(owner.d.core.roster.nodes.has(waiter.d.nodeId)).toBe(false);

  const legacyCredential = new AbortController();
  const legacyReq = new Request("http://127.0.0.1/v1/team/admit", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_id: row.node_id, approve: true }),
  });
  const legacy = await dispatch({ ...ctx, req: legacyReq, url: new URL(legacyReq.url), credentialSignal: legacyCredential.signal })
    .then((response) => ({ status: response.status }), (error: { status: number }) => ({ status: error.status }));
  legacyCredential.abort();
  await flushRequests(forwardingOwner.d.core, forwardingOwner.d.client, forwardingOwner.d.sync.requestCatchUp);
  expect(legacy.status).toBe(503);
  expect(forwardingOwner.d.core.store.queuedRequests().filter((queued) => {
    const request = JSON.parse(queued.json) as { kind: string; body: { node_id?: string } };
    return request.kind === "team.admit" && request.body.node_id === waiter.d.nodeId;
  })).toHaveLength(0);
});

test("a forwarded dashboard approval does not reach the peer after its credential ends before the RPC", async () => {
  const link = await owner.client().mintLink({ for: "owner", owner_machines: true, approve: true });
  const waiter = await cluster.add({ name: "inflight-link", login: "-", direct: true });
  expect((await waiter.client().joinLink(link.token)).reason).toBe("pending_approval");
  const row = (await forwardingOwner.client().links()).uses.find((use) => use.node_id === waiter.d.nodeId && use.state === "pending")!;
  const credential = new AbortController();
  let rpcStarted = false;
  const client = new Proxy(forwardingOwner.d.client, {
    get(target, property, receiver) {
      if (property === "addrOf") return (...args: Parameters<typeof target.addrOf>) => {
        const address = target.addrOf(...args);
        credential.abort();
        return address;
      };
      if (property === "rosterRequest") return (...args: Parameters<typeof target.rosterRequest>) => {
        rpcStarted = true;
        return target.rosterRequest(...args);
      };
      return Reflect.get(target, property, receiver);
    },
  });
  const req = new Request("http://127.0.0.1/v1/team/admit-link", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_id: row.node_id, approve: true, link: row.link, generation: row.generation }),
  });
  const ctx: RouteCtx = {
    core: forwardingOwner.d.core, sync: forwardingOwner.d.sync, client, req, url: new URL(req.url),
    via: "dashboard", listener: "tcp", dashboard: true, credentialSignal: credential.signal, noTimeout: () => {},
  };
  await expect(dispatch(ctx)).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  expect(credential.signal.aborted).toBe(true);
  expect(rpcStarted).toBe(false);
  expect(owner.d.core.store.joinRequest(waiter.d.nodeId)).not.toBeNull();
  expect(owner.d.core.roster.nodes.has(waiter.d.nodeId)).toBe(false);
});

test("a forwarded dashboard approval cannot reach the peer after its credential ends during the RPC", async () => {
  const link = await owner.client().mintLink({ for: "owner", owner_machines: true, approve: true });
  const waiter = await cluster.add({ name: "inflight-rpc-link", login: "-", direct: true });
  expect((await waiter.client().joinLink(link.token)).reason).toBe("pending_approval");
  const row = (await forwardingOwner.client().links()).uses.find((use) => use.node_id === waiter.d.nodeId && use.state === "pending")!;
  const credential = new AbortController();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const client = new Proxy(forwardingOwner.d.client, {
    get(target, property, receiver) {
      if (property === "rosterRequest") return async (...args: Parameters<typeof target.rosterRequest>) => {
        entered();
        await held;
        return target.rosterRequest(...args);
      };
      return Reflect.get(target, property, receiver);
    },
  });
  const req = new Request("http://127.0.0.1/v1/team/admit-link", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_id: row.node_id, approve: true, link: row.link, generation: row.generation }),
  });
  const ctx: RouteCtx = {
    core: forwardingOwner.d.core, sync: forwardingOwner.d.sync, client, req, url: new URL(req.url),
    via: "dashboard", listener: "tcp", dashboard: true, credentialSignal: credential.signal, noTimeout: () => {},
  };
  const decision = dispatch(ctx);
  await started;
  credential.abort();
  release();
  await expect(decision).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  expect(owner.d.core.store.joinRequest(waiter.d.nodeId)).not.toBeNull();
  expect(owner.d.core.roster.nodes.has(waiter.d.nodeId)).toBe(false);
});

for (const forwarded of [false, true]) {
  for (const approve of [true, false]) {
    test(`${forwarded ? "forwarded" : "authority"} dashboard can ${approve ? "approve" : "deny"} a bound fleet request`, async () => {
      const decider = forwarded ? forwardingOwner : owner;
      const link = await owner.client().mintLink({ for: "owner", owner_machines: true, approve: true });
      const waiter = await cluster.add({ name: `waiter-${Number(forwarded)}-${Number(approve)}`, login: "-", direct: true });
      expect((await waiter.client().joinLink(link.token)).reason).toBe("pending_approval");
      const browser = await session(decider);
      const listed = await fetch(`${browser.origin}/v1/team/links`, { headers: browser.headers });
      expect(listed.status).toBe(200);
      const view = await listed.json() as { uses: Array<{ node_id: string; link: string; generation?: string; state: string }> };
      const row = view.uses.find((use) => use.node_id === waiter.d.nodeId && use.state === "pending");
      expect(Boolean(row?.generation)).toBe(true);
      const body: Decision = { node_id: row!.node_id, link: row!.link, generation: row!.generation!, approve };
      const before = owner.d.core.store.joinRequest(waiter.d.nodeId);

      const staleGeneration = body.generation === "0".repeat(32) ? "1".repeat(32) : "0".repeat(32);
      const stale = await decide(browser, { ...body, generation: staleGeneration });
      expect(stale.status).toBe(409);
      expect((await stale.json() as { error: { code: string } }).error.code).toBe("stale_join_request");
      expect(owner.d.core.store.joinRequest(waiter.d.nodeId)).toEqual(before);

      expect((await decide(browser, body, { ...browser.headers, Origin: "http://foreign.example" })).status).toBe(403);
      const { Origin: _origin, ...withoutOrigin } = browser.headers;
      expect((await fetch(`${browser.origin}/v1/team/admit-link`, {
        method: "POST", headers: withoutOrigin, body: JSON.stringify(body),
      })).status).toBe(403);
      expect((await decide(await session(member), body)).status).toBe(403);
      expect(owner.d.core.store.joinRequest(waiter.d.nodeId)).toEqual(before);

      expect((await decide(browser, body)).status).toBe(200);
      expect(owner.d.core.store.joinRequest(waiter.d.nodeId)).toBeNull();
      expect(owner.d.core.roster.nodes.get(waiter.d.nodeId)?.login ?? null).toBe(approve ? "direct:owner" : null);
      expect((await fetch(`${browser.origin}/v1/team/admit-link`, { headers: browser.headers })).status).toBe(403);
      expect((await fetch(`${browser.origin}/v1/diag`, { headers: browser.headers })).status).toBe(403);
    });
  }
}
