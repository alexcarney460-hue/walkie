// FLEET-LINK-1 on a Tailscale team: machines join with a fleet link over Walkie Direct, so the roster authority must
// serve Direct (as for invite codes): before `walkie direct enable` a link can't be minted (409 direct_unavailable,
// from the authority itself and from another owner's Tailscale machine); after it, a Tailscale owner that doesn't run
// Direct mints one (registered on the authority over the tailnet) and a machine with no Tailscale joins with it as
// that owner's machine.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { WalkieError } from "../../src/client/index.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

setDefaultTimeout(60_000);
let c: Cluster;
let alex: TestNode, bob: TestNode;

beforeAll(async () => {
  c = new Cluster();
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", dual: true });
  bob = await c.add({ name: "bob", login: "bob@example.com", hostname: "bobs-mbp" });
  await alex.client().init("aka", "alex");
  await alex.client().invite("bob@example.com", "bob", "owner");
  expect((await bob.client().join(alex.peerAddr)).admitted).toBe(true);
});
afterAll(async () => { await c.close(); });

test("no Direct on the authority: refused with the fix; after walkie direct enable: a Tailscale owner's link admits a Direct machine", async () => {
  for (const node of [alex, bob]) {
    const err = await node.client().mintLink({}).then(() => null, (e: unknown) => e as WalkieError);
    expect([err?.code, err?.message.includes("walkie direct enable")]).toEqual(["direct_unavailable", true]);
  }
  await alex.client().request("POST", "/v1/direct/enable", {});
  await waitFor(() => bob.d.core.roster.nodes.get(alex.d.nodeId)?.transports?.includes("direct"), { what: "bob sees the authority serve Direct" });
  const res = await bob.client().mintLink({ owner_machines: true, uses: 2 }); // bob's machine runs no Direct: registered over the tailnet
  expect([res.handle, res.created_by]).toEqual(["bob", "bob"]);
  const box = await c.add({ name: "box", login: "-", hostname: "office-box", direct: true });
  const j = await box.client().joinLink(res.link);
  expect([j.admitted, j.handle, j.role]).toEqual([true, "bob", "owner"]);
  const rec = alex.d.core.roster.nodes.get(box.d.nodeId);
  expect([rec?.login, rec?.transports]).toEqual(["bob@example.com", ["direct"]]);
  await waitFor(async () => (await bob.client().team()).nodes.some((n) => n.hostname === "office-box"), { what: "bob sees the new machine" });
});
