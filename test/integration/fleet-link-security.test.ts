import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { WalkieError } from "../../src/client/index.ts";
import { decodeFleetLink } from "../../src/daemon/fleet-link.ts";
import { fleetLinkUrl } from "../../src/protocol/fleet-link.ts";
import { admitLinkJoin } from "../../src/daemon/fleet-link-service.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

setDefaultTimeout(60_000);
let c: Cluster, maren: TestNode, devon: TestNode;
beforeAll(async () => {
  c = new Cluster();
  maren = await c.add({ name: "maren", login: "-", direct: true });
  devon = await c.add({ name: "devon", login: "-", direct: true });
  await maren.client().init("acme", "maren");
  expect((await devon.client().join((await maren.client().inviteCode("devon", "owner")).code)).admitted).toBe(true);
});
afterAll(async () => { await c?.close(); });

test("local and forwarded registration require explicit owner confirmation", async () => {
  for (const node of [maren, devon]) {
    await expect(node.client().mintLink({})).rejects.toMatchObject({ status: 409, code: "owner_target" });
    const link = await node.client().mintLink({ owner_machines: true });
    const decoded = decodeFleetLink(link.token);
    expect("error" in decoded ? decoded.error : decoded.approve).toBe(false);
    expect(link.role).toBe("owner");
  }
});

test("a damaged token, URL or command passed as a peer never echoes the credential", async () => {
  const link = await maren.client().mintLink({ owner_machines: true });
  const m = await c.add({ name: "damaged", login: "-", direct: true });
  const bad = `${link.token}x`;
  for (const input of [bad, `${bad.slice(0, 80)}\n${bad.slice(80)}`, fleetLinkUrl(bad, null), `sh -s -- --join-link ${bad}`, "wl1!"]) {
    const err = await m.client().join(input).then(() => null, (e: unknown) => e);
    expect(err instanceof WalkieError).toBe(true);
    expect((err as WalkieError).code).toBe("invalid");
    expect((err as WalkieError).message.includes(link.token)).toBe(false);
    expect((err as WalkieError).message).toContain("fleet link");
  }
  expect((await Bun.file(m.d.paths.log).text()).includes(link.token)).toBe(false);
});

test("moving authority away and back permanently kills existing links and pending approvals, including after restart", async () => {
  const old = await maren.client().mintLink({ uses: 5, owner_machines: true });
  const approval = await maren.client().mintLink({ approve: true, owner_machines: true });
  const waiting = await c.add({ name: "waiting", login: "-", direct: true });
  expect((await waiting.client().joinLink(approval.token)).reason).toBe("pending_approval");
  await maren.client().setAuthority(devon.d.nodeId);
  await waitFor(() => devon.d.core.isAuthority() && !maren.d.core.isAuthority());
  const m = await c.add({ name: "moved", login: "-", direct: true });
  expect((await m.client().joinLink(old.token)).reason).toBe("link_unknown");
  await devon.client().setAuthority(maren.d.nodeId);
  await waitFor(() => maren.d.core.isAuthority() && !devon.d.core.isAuthority());
  const checkDead = async () => {
    expect((await maren.client().links()).links.find((l) => l.id === old.id)).toMatchObject({ state: "dead", reason: "link_authority_changed" });
    const j = maren.d.core.store.joinRequest(waiting.d.nodeId, maren.d.core.clock());
    expect(j).not.toBeNull();
    expect(() => admitLinkJoin(maren.d.core, j!, true)).toThrow("authority changed");
  };
  await checkDead();
  await maren.restart();
  await checkDead();
  const back = await c.add({ name: "back", login: "-", direct: true });
  expect((await back.client().joinLink(old.token)).reason).toBe("link_authority_changed");
  const fresh = await maren.client().mintLink({ uses: 1, owner_machines: true });
  expect((await back.client().joinLink(fresh.token)).admitted).toBe(true);
});


test("observer consent is enforced locally and by a forwarded owner registration", async () => {
  const viewer = await c.add({ name: "viewer", login: "-", direct: true });
  expect((await viewer.client().join((await maren.client().inviteCode("viewer", "observer")).code)).admitted).toBe(true);
  await waitFor(() => [...devon.d.core.roster.members.values()].some(m => m.handle === "viewer" && m.role === "observer"));
  for (const node of [maren, devon]) {
    await expect(node.client().mintLink({ for: "viewer" })).rejects.toMatchObject({ status: 409, code: "observer_target" });
    expect((await node.client().mintLink({ for: "viewer", observer: true })).role).toBe("observer");
  }
});
