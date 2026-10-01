import { afterAll, beforeAll, expect, test } from "bun:test";
import { GuestRegistry } from "../../src/mcp/guest-registry.ts";
import { guestData } from "../../src/mcp/guest-data.ts";
import { GuestScope } from "../../src/mcp/guest-scope.ts";
import { WalkieError } from "../../src/client/index.ts";
import { Cluster, type TestNode } from "../helpers/cluster.ts";

let cluster: Cluster;
let node: TestNode;
beforeAll(async () => {
  cluster = new Cluster();
  node = await cluster.add({ name: "guest-alex", login: "alex@example.com", hostname: "alex-mbp" });
  await node.client().init("team", "alex");
});
afterAll(async () => { await cluster.close(); });

test("person grants a bound guest; its status is signed and reassignment revokes card access", async () => {
  const { project } = await node.client().createProject({ name: "Guest work" });
  const { task } = await node.client().createTask({ project: project.channel, title: "Assigned work", assignee: "@alex/cloud/dots-ops" });
  const { token, guest } = await node.client().request<{ token: string; guest: { id: string; agent: string } }>("POST", "/v1/guests", {
    family: "dots", name: "ops", subject: "fake-tunnel", cardIds: [task.id], tools: ["walkie_task", "walkie_set_status"], ttlMs: 60_000,
  });
  const registry = new GuestRegistry(node.d.core.store);
  const current = registry.authenticate(token, "fake-tunnel");
  expect(current?.id).toBe(guest.id);
  const listing = await node.client().request<{ guests: { agent: string; tokenHash?: string }[] }>("GET", "/v1/guests");
  expect(listing.guests.find((row) => row.agent === guest.agent)?.tokenHash).toBeUndefined();
  const { nonce } = await node.client().authNonce();
  const auth = await fetch(`http://127.0.0.1:${node.d.localPort}/auth?nonce=${nonce}`, { redirect: "manual" });
  const session = /#s=([0-9a-f]{64})$/.exec(auth.headers.get("location") ?? "")?.[1];
  expect(session).toBeDefined();
  expect((await fetch(`http://127.0.0.1:${node.d.localPort}/v1/guests`, { headers: { "X-Walkie-Session": session! } })).status).toBe(200);
  await expect(node.client("cc-test").request("GET", "/v1/guests")).rejects.toBeInstanceOf(WalkieError);
  await expect(node.client().request("POST", "/v1/status", { agent: guest.agent, state: "working", runtime: "other", title: "fake" })).rejects.toBeInstanceOf(WalkieError);
  const scope = new GuestScope(guestData(node.d.core, node.d.projects, node.d.client, node.d.sync.requestCatchUp));
  expect(scope.call(current!, "walkie_task", { key: task.key }).isError).toBeUndefined();
  expect(scope.call(current!, "walkie_set_status", { title: "Working", task: task.key }).isError).toBeUndefined();
  const row = node.d.core.store.agent(node.d.nodeId, guest.agent);
  expect(row?.handle).toBe("alex");
  expect(JSON.parse(row?.body ?? "{}").runtime_name).toBe("dots");
  expect((await node.client().agents({ scope: "all" })).agents.find((agent) => agent.agent === guest.agent)?.id).toBe("@alex/cloud/dots-ops");
  await node.client().updateTask(task.id, { assignee: "@alex" });
  expect(scope.call(current!, "walkie_task", { key: task.key }).isError).toBe(true);
  await node.client().updateTask(task.id, { assignee: "@alex/cloud/dots-ops", labels: ["confidential"] });
  expect(scope.call(current!, "walkie_task", { key: task.key }).isError).toBe(true);
  await node.client().updateTask(task.id, { labels: [] });
  expect(scope.call(current!, "walkie_task", { key: task.key }).isError).toBeUndefined();
  await node.client().updateProject(project.channel, { private: true });
  expect(scope.call(current!, "walkie_task", { key: task.key }).isError).toBe(true);
  await node.client().request("POST", `/v1/guests/${guest.agent}/revoke`, {});
  expect(registry.authenticate(token, "fake-tunnel")).toBeNull();
  expect(JSON.parse(node.d.core.store.agent(node.d.nodeId, guest.agent)?.body ?? "{}").state).toBe("offline");
});
