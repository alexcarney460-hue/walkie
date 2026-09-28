// Two daemons: a connector enabled on node A posts; node B receives the post (author.agent = connector
// id, the dashboard's source badge) and can fetch the attached transcript. B never sees A's key.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Event } from "../../src/protocol/schemas.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { FakeApis } from "../helpers/fake-apis.ts";

const KEY = "ff_cluster_key_0123456789abcdef";
let c: Cluster;
let a: TestNode, b: TestNode;
const apis = new FakeApis();

beforeAll(async () => {
  c = new Cluster();
  a = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", integrations: { fetch: apis.fetch, autoRun: false } });
  b = await c.add({ name: "kira", login: "kira@example.com", hostname: "kiras-mbp" });
  await a.client().init("acme", "alex");
  await a.client().invite("kira@example.com", "kira", "member", "Kira Moore");
  const j = await b.client().join(a.peerAddr);
  if (!j.admitted) throw new Error(`join failed: ${j.reason}`);
});
afterAll(async () => { await c.close(); });

test("enabling Fireflies on A posts a meeting that B sees with the source badge metadata and transcript", async () => {
  const keys = join(c.root, "keys");
  mkdirSync(keys, { recursive: true });
  writeFileSync(join(keys, "ff.txt"), KEY, { mode: 0o600 });
  await a.client().channel({ name: "meetings" }); // connectors never create channels
  apis.transcript({ id: "cluster-1", date: Date.now() - 30 * 60_000, title: "Pairing: refunds" });
  await a.client().configureIntegration("fireflies", { key_path: join(keys, "ff.txt") });
  const run = await a.client().runIntegration("fireflies");
  expect(run.integration.items_posted).toBe(1);

  const seen = await waitFor(async () => {
    const { events } = await b.client().events({ channel: "meetings", kinds: "msg.post", limit: 20 });
    return events.find((e) => e.author.agent === "fireflies");
  }, { what: "fireflies post on B", timeoutMs: 15_000 });
  expect(seen.author).toMatchObject({ handle: "alex", agent: "fireflies", node: a.d.nodeId });
  expect(String(seen.body.text)).toContain("**Meeting: Pairing: refunds**");
  expect(seen.body.mentions).toEqual(["@kira"]); // the action item names Kira Moore → B's agents are addressed
  const hash = (seen.body.artifacts as string[])[0] as string;
  await waitFor(async () => (await b.client().event(seen.id)).replies.some((r: Event) => r.kind === "artifact.share"), { what: "share on B" });
  const bytes = await b.client().fetchArtifact(hash); // pulled from A over the peer API
  expect(new TextDecoder().decode(bytes)).toContain("Kira Moore: The dry run is green.");

  // B has no integration state of its own and never saw the key.
  expect((await b.client().integrations()).integrations.every((i) => !i.enabled && i.items_posted === 0)).toBe(true);
  expect(readFileSync(b.d.paths.log, "utf8")).not.toContain(KEY);
  expect(JSON.stringify((await b.client().events({ limit: 500 })).events)).not.toContain(KEY);
});
