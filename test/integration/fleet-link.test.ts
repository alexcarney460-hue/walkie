// FLEET-LINK-1 (ALE-5388), end to end on Walkie Direct daemons: an owner mints ONE link and many machines join with it.
// Uses, the race for the last use, revocation, the approve-each-machine flow (pending → approve, deny frees the use),
// person-only minting, a non-authority owner minting (registered on the authority over the peer API), the observer
// opt-in, a removed member's link, de-duplicated hostnames, and joining from a CLI without any terminal.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { WalkieClient, WalkieError } from "../../src/client/index.ts";
import { LINK_WAIT } from "../../src/daemon/join.ts";
import { dashboardRoute } from "../../src/daemon/local-api.ts";
import { decodeFleetLink, linkUseId } from "../../src/daemon/fleet-link.ts";
import { VERSION } from "../../src/daemon/version.ts";
import { INSTALL_URL, JOIN_URL, releaseTag } from "../../src/protocol/add-machine.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { runAsPerson } from "../helpers/person-cli.ts";

setDefaultTimeout(60_000);
const CLI = join(import.meta.dir, "../../src/cli/main.ts");
const TAG = releaseTag(VERSION) as string;

let c: Cluster;
let maren: TestNode, devon: TestNode;
/** Fresh machines, one per join attempt (a Direct node with no team yet). */
let n = 0;
async function machine(hostname = "ubuntu"): Promise<TestNode> {
  n++;
  return c.add({ name: `m${n}`, login: "-", hostname, direct: true });
}

async function refused(p: Promise<unknown>): Promise<WalkieError> {
  try { await p; } catch (e) { if (e instanceof WalkieError) return e; throw e; }
  throw new Error("expected a refusal");
}

beforeAll(async () => {
  LINK_WAIT.intervalMs = 300;
  c = new Cluster();
  maren = await c.add({ name: "maren", login: "-", hostname: "maren-mbp", direct: true });
  devon = await c.add({ name: "devon", login: "-", hostname: "devon-mbp", direct: true });
  await maren.client().init("acme", "maren");
  expect((await devon.client().join((await maren.client().inviteCode("devon", "member")).code)).admitted).toBe(true);
}, 60_000);
afterAll(async () => { LINK_WAIT.intervalMs = 10_000; await c.close(); });

describe("mint", () => {
  test("an owner explicitly confirms owner machines and mints one link: token only in the fragment, pinned commands (Mac/Linux and Windows via WSL), defaults 25 × 7 days", async () => {
    const res = await maren.client().mintLink({ owner_machines: true });
    expect([res.handle, res.role, res.uses, res.used, res.pending, res.approve, res.state]).toEqual(["maren", "owner", 25, 0, 0, false, "active"]);
    expect(res.expires_at - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(res.expires_at - Date.now()).toBeLessThanOrEqual(7 * 86_400_000);
    expect(res.link).toBe(`${JOIN_URL}#${res.token}&v=${TAG}`);
    expect(new URL(res.link).search).toBe("");
    expect(res.command).toBe(`curl -fsSL ${INSTALL_URL} | WALKIE_VERSION=${TAG} sh -s -- --join-link ${res.token}`);
    expect(res.windows_command).toBe(`wsl -- sh -c "${res.command}"`);
    const d = decodeFleetLink(res.token);
    expect("error" in d ? d.error : [d.handle, d.uses, d.id, d.issuer]).toEqual(["maren", 25, res.id, maren.d.nodeId]);
    // The authority keeps no secret: its record is keyed by the link id; the token is nowhere in its database or log.
    const rows = maren.d.core.store.db.query<{ id: string }, []>("SELECT id FROM fleet_links").all();
    expect(rows.map((r) => r.id)).toContain(res.id);
    const dump = JSON.stringify(maren.d.core.store.db.query("SELECT * FROM fleet_links").all());
    expect(dump).not.toContain(res.token.slice(3, 40));
    const log = await Bun.file(maren.d.paths.log).text();
    expect(log).toContain(`"fleet_link_created"`);
    expect(log).toContain(res.id);
    expect(log).not.toContain(res.token);
    expect(log).not.toContain(res.token.slice(40, 80));
  });

  test("a member can't mint; an agent can't (named, or an unnamed CLI under an agent); the dashboard may", async () => {
    expect([(await refused(devon.client().mintLink({}))).status, (await refused(devon.client().mintLink({}))).code]).toEqual([403, "forbidden"]);
    expect((await refused(maren.client("claude-3f9a").mintLink({}))).code).toBe("person_only");
    const marked = new WalkieClient({ socket: maren.socket, underAgent: true, timeoutMs: 15_000 });
    expect((await refused(marked.mintLink({}))).code).toBe("person_only");
    expect((await refused(marked.revokeLink("abcdef12"))).code).toBe("person_only");
    for (const [m, p] of [["POST", "/v1/team/links"], ["GET", "/v1/team/links"], ["POST", "/v1/team/links/revoke"]] as const) expect(dashboardRoute(m, p)).toBe(true);
    // The CLI in an agent's environment is refused before it asks anything.
    const r = await runAsPerson([process.execPath, CLI, "team", "link"], { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: maren.home, WALKIE_SOCKET: maren.socket, CLAUDECODE: "1" });
    expect([r.code, r.err.includes("person_only"), r.out.includes("wl1")]).toEqual([1, true, false]);
  });

  test("only for a current member; an observer only when the owner says so", async () => {
    expect((await refused(maren.client().mintLink({ for: "nobody" }))).status).toBe(404);
    await maren.client().inviteCode("viewer", "observer");
    const v = await machine("viewer-mbp");
    expect((await v.client().join((await maren.client().inviteCode("viewer", "observer")).code)).admitted).toBe(true);
    const e = await refused(maren.client().mintLink({ for: "viewer" }));
    expect([e.status, e.code]).toEqual([409, "observer_target"]);
    const ok = await maren.client().mintLink({ for: "viewer", observer: true, uses: 1 });
    expect([ok.handle, ok.role]).toEqual(["viewer", "observer"]);
  });
});

describe("redeem", () => {
  test("3 machines join with a 3-use link (same hostname: de-duplicated), the 4th is refused, all recorded", async () => {
    const res = await maren.client().mintLink({ owner_machines: true, uses: 3 });
    const ms = [await machine("ubuntu"), await machine("ubuntu"), await machine("ubuntu"), await machine("ubuntu")];
    for (const m of ms.slice(0, 3)) {
      const j = await m.client().joinLink(res.command); // the whole command pasted works too
      expect([j.admitted, j.handle, j.role]).toEqual([true, "maren", "owner"]);
    }
    const last = await ms[3]?.client().joinLink(res.token);
    expect([last?.admitted, last?.reason]).toEqual([false, "link_used_up"]);
    // The roster: three machines of @maren, each with the chain's use id; named ubuntu, ubuntu-2, ubuntu-3.
    const r = maren.d.core.roster;
    const names = ms.slice(0, 3).map((m) => r.nodes.get(m.d.nodeId)?.hostname);
    expect(names).toEqual(["ubuntu", "ubuntu-2", "ubuntu-3"]);
    for (const m of ms.slice(0, 3)) expect(r.invites?.has(linkUseId(res.id, m.d.nodeId))).toBe(true);
    // Each machine goes by its roster name (asks addressed to @maren/ubuntu-2 reach it), after a restart too.
    expect((await ms[1]?.client().me())?.node.hostname).toBe("ubuntu-2");
    await ms[1]?.restart();
    expect((await ms[1]?.client().me())?.node.hostname).toBe("ubuntu-2");
    // Owners see it: used up, the three admissions and the refusal.
    const view = await maren.client().links();
    const l = view.links.find((x) => x.id === res.id);
    expect([l?.used, l?.pending, l?.state]).toEqual([3, 0, "used_up"]);
    const uses = view.uses.filter((u) => u.link === res.id).map((u) => u.state).sort();
    expect(uses).toEqual(["admitted", "admitted", "admitted", "refused"]);
    // The machines show up for the rest of the team too.
    await waitFor(async () => (await devon.client().team()).nodes.filter((x) => x.hostname.startsWith("ubuntu")).length === 3, { what: "devon sees the 3 machines" });
    // Joining again with the same link is harmless for an admitted machine.
    expect((await ms[0]?.client().joinLink(res.token))?.admitted).toBe(true);
  });

  test("two machines racing for the last use: exactly one gets in", async () => {
    const res = await maren.client().mintLink({ owner_machines: true, uses: 1 });
    const a = await machine("race-a");
    const b = await machine("race-b");
    const [ra, rb] = await Promise.all([a.client().joinLink(res.token), b.client().joinLink(res.token)]);
    expect([ra.admitted, rb.admitted].sort()).toEqual([false, true]);
    expect([ra, rb].find((x) => !x.admitted)?.reason).toBe("link_used_up");
    expect((await maren.client().links()).links.find((x) => x.id === res.id)?.used).toBe(1);
  });

  test("revoked: refused at once; the machines it admitted stay", async () => {
    const res = await maren.client().mintLink({ owner_machines: true, uses: 5 });
    const a = await machine("rev-a");
    expect((await a.client().joinLink(res.token)).admitted).toBe(true);
    const out = await maren.client().revokeLink(res.short);
    expect([out.link.state, out.link.used]).toEqual(["revoked", 1]);
    const b = await machine("rev-b");
    expect((await b.client().joinLink(res.token)).reason).toBe("link_revoked");
    expect(maren.d.core.roster.nodes.get(a.d.nodeId)?.revoked).toBe(false);
  });

  test("a CLI with no terminal at all joins with the link (walkie join <link>)", async () => {
    const res = await maren.client().mintLink({ owner_machines: true, uses: 1 });
    const m = await machine("headless");
    const r = await runAsPerson([process.execPath, CLI, "join", res.link], { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: m.home, WALKIE_SOCKET: m.socket });
    expect(r.code).toBe(0);
    expect(r.out).toContain("joined acme as @maren (owner) on headless");
  });

  test("walkie join --link-stdin: the link from stdin (out of shell history)", async () => {
    const res = await maren.client().mintLink({ owner_machines: true, uses: 1 });
    const m = await machine("stdin-box");
    const r = await runAsPerson([process.execPath, CLI, "join", "--link-stdin"], { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: m.home, WALKIE_SOCKET: m.socket }, { stdin: `${res.command}\n` });
    expect([r.code, r.out.includes("joined acme as @maren")]).toEqual([0, true]);
  });

  test("a removed member's link dies (also after a re-invite)", async () => {
    const lee = await machine("lee-mbp");
    expect((await lee.client().join((await maren.client().inviteCode("lee", "member")).code)).admitted).toBe(true);
    const res = await maren.client().mintLink({ for: "lee", uses: 5 });
    await maren.client().setRole("lee", "removed");
    const m = await machine("lee-2");
    expect((await m.client().joinLink(res.token)).reason).toBe("link_member_removed");
    await maren.client().inviteCode("lee", "member"); // re-invited by a fresh code (not used): the old link stays dead
    const lee2 = await machine("lee-3");
    expect((await lee2.client().join((await maren.client().inviteCode("lee", "member")).code)).admitted).toBe(true);
    const m2 = await machine("lee-4");
    expect((await m2.client().joinLink(res.token)).reason).toBe("link_member_removed");
    expect((await maren.client().links()).links.find((x) => x.id === res.id)?.state).toBe("dead");
  });
});

describe("approve each machine", () => {
  test("pending → an owner approves → the machine joins by itself; a declined one frees its use and can't re-queue", async () => {
    const res = await maren.client().mintLink({ owner_machines: true, uses: 2, approve: true });
    const a = await machine("approve-a");
    const first = await a.client().joinLink(res.token);
    expect([first.admitted, first.reason]).toEqual([false, "pending_approval"]);
    // Asking again doesn't take a second use.
    expect((await a.client().joinLink(res.token)).reason).toBe("pending_approval");
    const pending = await maren.client().request<{ requests: Array<{ node_id: string; hostname: string; link?: string }> }>("GET", "/v1/team/pending");
    const req = pending.requests.find((p) => p.node_id === a.d.nodeId) as { hostname: string; link?: string; handle?: string } | undefined;
    expect([req?.hostname, req?.link, req?.handle]).toEqual(["approve-a", res.id, "maren"]);
    expect((await maren.client().links()).links.find((x) => x.id === res.id)?.pending).toBe(1);
    // Devon (a member) can't approve; maren can, from the dashboard's route.
    await maren.client().request("POST", "/v1/team/admit-link", { ...maren.d.core.store.joinRequest(a.d.nodeId, maren.d.core.clock())!, node_id: a.d.nodeId, approve: true });
    await waitFor(async () => (await a.client().me()).team?.name === "acme", { what: "the approved machine joined by itself", timeoutMs: 15_000 });
    expect((await a.client().me()).handle).toBe("maren");
    // A second machine: declined; the use is free again and it can't queue itself again.
    const b = await machine("approve-b");
    expect((await b.client().joinLink(res.token)).reason).toBe("pending_approval");
    await maren.client().request("POST", "/v1/team/admit-link", { ...maren.d.core.store.joinRequest(b.d.nodeId, maren.d.core.clock())!, node_id: b.d.nodeId, approve: false });
    await waitFor(() => b.d.core.store.getMeta("link_wait") === null, { what: "the declined machine stops polling" });
    expect((await Bun.file(b.d.paths.log).text())).toContain('"link_wait_refused"');
    expect((await Bun.file(b.d.paths.log).text())).toContain('"code":"link_declined"');
    const after = (await maren.client().links()).links.find((x) => x.id === res.id);
    expect([after?.used, after?.pending, after?.state]).toEqual([1, 0, "active"]);
    expect((await b.client().joinLink(res.token)).reason).toBe("link_declined");
    const cand = await machine("approve-c");
    expect((await cand.client().joinLink(res.token)).reason).toBe("pending_approval");
  });

  test("revoking a link drops its waiting machines", async () => {
    const res = await maren.client().mintLink({ owner_machines: true, uses: 3, approve: true });
    const a = await machine("wait-a");
    expect((await a.client().joinLink(res.token)).reason).toBe("pending_approval");
    await maren.client().revokeLink(res.id);
    const pending = await maren.client().request<{ requests: Array<{ node_id: string }> }>("GET", "/v1/team/pending");
    expect(pending.requests.some((p) => p.node_id === a.d.nodeId)).toBe(false);
  });
});

describe("another owner", () => {
  test("devon, promoted, mints on his machine (registered on the authority); approves a waiting machine; demoted, his link dies", async () => {
    await maren.client().setRole("devon", "owner");
    await waitFor(async () => (await devon.client().me()).role === "owner", { what: "devon is an owner" });
    // An approve-each-machine link's machine, approved from devon's machine (a team.admit request to the authority).
    const ap = await maren.client().mintLink({ owner_machines: true, uses: 1, approve: true });
    const w = await machine("devon-approves");
    expect((await w.client().joinLink(ap.token)).reason).toBe("pending_approval");
    const seen = (await devon.client().links()).uses.find((u) => u.link === ap.id && u.node_id === w.d.nodeId);
    expect(seen?.state).toBe("pending"); // devon's dashboard lists it through the authority
    await devon.client().request("POST", "/v1/team/admit-link", { ...maren.d.core.store.joinRequest(w.d.nodeId, maren.d.core.clock())!, node_id: w.d.nodeId, approve: true });
    await waitFor(async () => (await w.client().me()).team?.name === "acme", { what: "approved from another owner's machine", timeoutMs: 15_000 });
    const res = await devon.client().mintLink({ owner_machines: true, uses: 2 });
    expect([res.handle, res.created_by]).toEqual(["devon", "devon"]);
    expect(maren.d.core.store.links.get(res.id)?.issuer).toBe(devon.d.nodeId); // the record lives on the authority
    expect(devon.d.core.store.links.get(res.id)).toBe(null);
    const m = await machine("devon-box");
    expect((await m.client().joinLink(res.token)).handle).toBe("devon");
    expect((await devon.client().links()).links.find((x) => x.id === res.id)?.used).toBe(1); // listed through the authority
    await maren.client().setRole("devon", "member");
    const m2 = await machine("devon-box-2");
    expect((await m2.client().joinLink(res.token)).reason).toBe("link_issuer_not_owner");
  });
});
