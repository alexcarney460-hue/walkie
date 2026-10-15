import { afterEach, expect, test } from "bun:test";
import { Cluster } from "../helpers/cluster.ts";
import { PeerApi } from "../../src/daemon/peer-api.ts";
import { RateLimiter, MAX_BUCKETS } from "../../src/daemon/ratelimit.ts";
import { peerSigStrict } from "../../src/daemon/peer-capabilities.ts";
import type { Core } from "../../src/daemon/core.ts";

let cluster: Cluster | undefined;
afterEach(async () => { await cluster?.close(); cluster = undefined; });

test("fleet admission records signed peer evidence, but refuses a tampered signed link", async () => {
  cluster = new Cluster();
  const owner = await cluster.add({ name: "owner", login: "-", direct: true });
  const joining = await cluster.add({ name: "joining", login: "-", direct: true });
  await owner.client().init("acme", "owner");
  const link = await owner.client().mintLink({ owner_machines: true, uses: 1 });
  const raw = Buffer.from(link.token.slice(3), "base64url");
  raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
  const tampered = `wl1${raw.toString("base64url")}`;
  expect((await joining.client().joinLink(tampered)).reason).toBe("link_bad_signature");
  expect(owner.d.core.roster.nodes.has(joining.d.nodeId)).toBe(false);
  expect((await joining.client().joinLink(link.token)).admitted).toBe(true);
  expect(peerSigStrict(owner.d.core.roster, owner.d.core.store)).toBe(true);
  expect(owner.d.core.roster.nodes.get(joining.d.nodeId)?.peer_sig_v1).toBe(true);
}, 60_000);

test("unadmitted fleet keys cannot evict an admitted peer's rate bucket", () => {
  const limiter = new RateLimiter();
  const admitted = "peer:direct:admitted";
  const limit = { capacity: 1, perSecond: 0 };
  expect(limiter.take(admitted, limit)).toBe(true);
  expect(limiter.can(admitted, limit)).toBe(false);
  const core = { limiter, roster: { nodes: new Map(), members: new Map() }, teamId: "0123456789abcdef", log: { warn: () => {} } } as unknown as Core;
  const api = new PeerApi(core) as unknown as { joinWithLink: (token: string, hostname: string, pubkey: string, nodeId: string) => unknown };
  for (let i = 0; i < MAX_BUCKETS; i++) {
    try { api.joinWithLink("invalid", "stranger", "invalid", i.toString(16).padStart(16, "0")); } catch { /* invalid link is expected */ }
  }
  expect(limiter.can(admitted, limit)).toBe(false);
});
