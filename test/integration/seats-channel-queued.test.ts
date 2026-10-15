// The seats channel request is a grant: the version gate refuses it while the roster authority's build is known to be
// older than this Walkie. Refused interactively, nothing used to be queued (the host retried on a 30 s pace), so
// enabling seats right around an authority update could wait past the channel's deadline. The host now keeps the
// request in the roster queue, where the flush retries it every sync round; nothing is sent to the old authority, and
// the request goes out once its build is recorded as current.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Cluster, waitFor } from "../helpers/cluster.ts";
import { rememberPeerCapabilities } from "../../src/daemon/peer-capabilities.ts";

let cluster: Cluster | undefined;
afterEach(async () => { await cluster?.close(); cluster = undefined; });

test("the seats channel request the version gate refuses is queued and applies once the authority is updated", async () => {
  cluster = new Cluster();
  const arvidHome = join(cluster.root, "arvid-home");
  mkdirSync(arvidHome, { mode: 0o700 });
  const alex = await cluster.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  const arvid = await cluster.add({ name: "arvid", login: "arvid@example.com", hostname: "arvid-mac",
    seats: { keychain: async () => null, env: { HOME: arvidHome } } });
  await alex.client().init("acme", "alex");
  await alex.client().invite("arvid@example.com", "arvid", "member");
  expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
  const alexId = alex.d.core.nodeId;
  const channel = `seats-${arvid.d.nodeId}`;
  const channelRow = () => arvid.d.core.store.queuedRequests().filter((q) => {
    try {
      const req = JSON.parse(q.json) as { kind?: unknown; body?: { name?: unknown } };
      return req.kind === "channel.upsert" && req.body?.name === channel;
    } catch {
      return false;
    }
  });
  await alex.stop();
  // A verified record of an old build: while the authority is down no probe can replace it.
  rememberPeerCapabilities(arvid.d.core.store, alexId, { version: "0.2.0-pre.13", caps: [] });
  expect((await arvid.client("").seatsConfig({ allow: true, ephemeral: true })).local.channel_ok).toBe(false);
  await waitFor(() => (channelRow().length === 1 ? true : null), { timeoutMs: 15_000, what: "the seats channel request queued" });
  await alex.start();
  // The authority now runs this build; record it and let the flush deliver the queued request.
  rememberPeerCapabilities(arvid.d.core.store, alexId, { version: "0.2.0-pre.14", caps: [] });
  await waitFor(async () => ((await arvid.client("").seats()).local.channel_ok ? true : null), { timeoutMs: 30_000, what: "the seats channel made once the authority is updated" });
  expect(channelRow()).toEqual([]);
}, 90_000);
