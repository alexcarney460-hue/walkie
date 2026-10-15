// Lane D round 3, with real daemons and their real stores: an owner whose machine holds no compute account sends no
// team proof until another current owner's daemon posts a handover notice in #general (expectation (c) of
// HANDOVER_CHECK_MS). Then it asks the site once at once, and a handover_not_found answer settles it.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { ComputeSite } from "../../src/daemon/compute/site.ts";
import { computeFor } from "../../src/daemon/compute/routes.ts";
import { handoverNoticeText } from "../../src/daemon/compute/handover-notice.ts";
import { postAudit } from "../../src/daemon/admin/audit.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

setDefaultTimeout(60_000);

const seen: string[] = [];
const site = () => new ComputeSite({ base: "http://127.0.0.1:9", fetch: async (url, init) => {
  seen.push(`${new URL(String(url)).pathname}${String(init?.body ?? "").includes('"action":"status"') ? " status" : ""}`);
  return Response.json({ error: "handover_not_found" }, { status: 404 });
} });
let c: Cluster;
let alex: TestNode, bob: TestNode;

beforeAll(async () => {
  c = new Cluster();
  alex = await c.add({ name: "alex", login: "-", hostname: "alex-mbp", direct: true, compute: { site: site(), autostart: false } });
  bob = await c.add({ name: "bob", login: "-", hostname: "bob-mbp", direct: true, compute: { site: site(), autostart: false } });
  await alex.client().init("acme", "alex");
  expect((await bob.client().join((await alex.client().inviteCode("bob", "owner")).code)).admitted).toBe(true);
  await waitFor(() => bob.d.core.roster.channels.has("general") && bob.d.core.me()?.role === "owner" ? true : null, { what: "bob is an owner with #general" });
}, 30_000);
afterAll(async () => { await c.close(); });

test("no account, no notice: nothing; another owner's posted notice: one status at once; handover_not_found settles it", async () => {
  const bobPoll = () => computeFor(bob.d.core)!.pollOnce();
  for (let i = 0; i < 3; i++) await bobPoll();
  expect(seen).toEqual([]);
  const chain = "d".repeat(64);
  const text = handoverNoticeText({ v: 1, team: alex.d.core.teamId!, proposed_by: alex.d.core.keys.pubkey, old_chain: "e".repeat(64),
    proposed_chain: chain, accounts: ["ca_0123456789abcdef"], proposed_at: Date.now(), completes_at: null, objected: false });
  const notices = async () => (await bob.client().events({ channel: "general", limit: 50 })).events
    .filter((e) => String((e.body as { text?: string }).text).startsWith("Compute handover pending:")).length;
  // A person's plain #general message with that text is not a daemon's notice (and the client's secret scan redacts its
  // key-like part anyway): no status request.
  await alex.client().post({ channel: "general", text });
  await waitFor(async () => await notices() >= 1 ? true : null, { what: "bob received the plain post" });
  await bobPoll();
  expect(seen).toEqual([]);
  expect(postAudit(alex.d.core, text)).toBe(true); // what alex's daemon posts when its account's state carries a notice
  await waitFor(async () => await notices() >= 2 ? true : null, { what: "bob received the daemon's notice" });
  await bobPoll();
  expect(seen).toEqual(["/api/compute/handover status"]);
  for (let i = 0; i < 3; i++) await bobPoll();
  expect(seen).toEqual(["/api/compute/handover status"]);
  expect(bob.d.core.store.getMeta(`compute-handover-settled:${chain}`)).toBe("1");
  // The poster's own daemon does not treat its own post as a notice from another owner.
  await computeFor(alex.d.core)!.pollOnce();
  expect(seen).toEqual(["/api/compute/handover status"]);
});
