// Walkie Direct (ALE-5156): a three-node team with no Tailscale anywhere, over iroh QUIC on loopback (no relays).
// invite → join → replication, the peer gate by endpoint key (revoked, removed, outsider), single-use invites,
// and an ask/answer round trip.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DirectNet } from "../../src/daemon/direct/net.ts";
import { createInvite } from "../../src/daemon/invite.ts";
import { generateKeys } from "../../src/daemon/keys.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { PeerCallError, PeerClient } from "../../src/daemon/peer-client.ts";
import { Transports } from "../../src/daemon/transport.ts";
import { WalkieError } from "../../src/client/index.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { runAsPerson, runConfirmed } from "../helpers/person-cli.ts";

let c: Cluster;
let alex: TestNode, kira: TestNode, riley: TestNode;
let kiraCode = "";
/** A key that was never admitted, with its own Direct endpoint (an outsider on the internet). */
let outsider: { net: DirectNet; client: PeerClient; keys: ReturnType<typeof generateKeys> };

beforeAll(async () => {
  c = new Cluster();
  alex = await c.add({ name: "alex", login: "-", hostname: "alex-mbp", direct: true });
  kira = await c.add({ name: "kira", login: "-", hostname: "kiras-mbp", direct: true });
  riley = await c.add({ name: "riley", login: "-", hostname: "riley-air", direct: true });
  const keys = generateKeys();
  const client = new PeerClient({ team: () => alex.d.core.teamId, nodeId: keys.nodeId }, new Transports());
  const net = await DirectNet.start({
    keys, log: createLogger({ file: `${c.root}/outsider.log` }), admitted: () => false,
    handler: async () => new Response("no", { status: 404 }),
  }, { preset: "minimal", bindAddr: "127.0.0.1:0", addressBook: c.addressBook });
  client.transports.direct = net;
  outsider = { net, client, keys };
}, 30_000);

afterAll(async () => {
  await outsider?.net.stop();
  await c.close();
});

const alexAddr = () => ({ ip: "", port: 7458, pubkey: alex.d.core.keys.pubkey });

describe("Walkie Direct: invite → join", () => {
  test("init without Tailscale founds a Direct team", async () => {
    const me = await alex.client().init("acme", "alex");
    expect(me.team?.name).toBe("acme");
    expect(me.tailscale.ok).toBe(false);
    expect(me.transport?.mode).toBe("direct");
    expect(me.transport?.direct?.endpoint).toBe(Buffer.from(alex.d.core.keys.pubkey, "base64").toString("hex"));
    const self = alex.d.core.roster.nodes.get(alex.d.nodeId);
    expect(self?.transports).toEqual(["direct"]);
  });

  test("an owner mints a compact code; the joiner is admitted and gets the history", async () => {
    await alex.client().post({ channel: "general", text: "before kira joined" });
    const inv = await alex.client().inviteCode("kira", "member");
    kiraCode = inv.code;
    console.log(`[metric] invite code length: ${inv.code.length} chars`);
    expect(inv.code.length).toBeLessThanOrEqual(300);
    const t0 = performance.now();
    const res = await kira.client().join(inv.code);
    console.log(`[metric] direct join (dial + admit + full pull): ${(performance.now() - t0).toFixed(1)} ms`);
    expect(res.admitted).toBe(true);
    expect(res.handle).toBe("kira");
    expect(res.role).toBe("member");
    const got = await kira.client().events({ channel: "general", kinds: "msg.post" });
    expect(got.events.some((e) => (e.body as { text?: string }).text === "before kira joined")).toBe(true);
    const node = alex.d.core.roster.nodes.get(kira.d.nodeId);
    expect(node?.login).toBe("direct:kira");
    expect(node?.transports).toEqual(["direct"]);
  });

  test("the same invite can't be used twice (another machine is refused)", async () => {
    const res = await riley.client().join(kiraCode);
    expect(res.admitted).toBe(false);
    expect(res.reason).toBe("invite_used");
    // …and the machine that used it re-joins idempotently.
    expect((await kira.client().join(kiraCode)).admitted).toBe(true);
  });

  test("third node joins; a post replicates to every node over QUIC", async () => {
    const inv = await alex.client().inviteCode("riley", "member");
    expect((await riley.client().join(inv.code)).admitted).toBe(true);
    for (const n of [alex, kira, riley]) {
      await waitFor(async () => (await n.client().peers()).nodes.filter((x) => x.online).length === 3, { what: `all online on ${n.spec.name}`, timeoutMs: 15_000 });
    }
    const t0 = performance.now();
    const { event } = await kira.client().post({ channel: "general", text: "hello over walkie direct" });
    await waitFor(async () => {
      const [a, r] = await Promise.all([alex.client().event(event.id).catch(() => null), riley.client().event(event.id).catch(() => null)]);
      return !!a && !!r;
    }, { intervalMs: 2, what: "push to alex and riley", timeoutMs: 10_000 });
    const ms = performance.now() - t0;
    console.log(`[metric] direct push kira→alex+riley (post + poll): ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(2_000);
    const view = await riley.client().team();
    expect(view.nodes.every((n) => n.transports?.includes("direct"))).toBe(true);
  });

  test("ask/answer round trip over Direct", async () => {
    const t0 = performance.now();
    const { event: ask } = await alex.client().ask({ to: "@kira", text: "which staging DB did you seed?", channel: "general", timeout_s: 60 });
    const open = await waitFor(async () => (await kira.client().asks({ state: "open", to: "me" })).asks.find((a) => a.ask.id === ask.id), { intervalMs: 2, what: "ask on kira" });
    await kira.client().answer({ ask: open.ask.id, text: "staging-2" });
    const done = await alex.client().askView(ask.id, 10);
    const ms = performance.now() - t0;
    console.log(`[metric] direct ask→answer round trip alex→kira→alex: ${ms.toFixed(1)} ms`);
    expect(done.state).toBe("answered");
    expect((done.answers[0]?.body as { text?: string }).text).toBe("staging-2");
  });
});

const CLI = join(import.meta.dir, "../../src/cli/main.ts");
async function walkie(node: TestNode, args: string[], confirm?: string) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: node.home, WALKIE_SOCKET: node.socket };
  // A person's terminal; person-only commands (invite, revoke) are confirmed by typing `confirm` at their prompt.
  return confirm === undefined ? runAsPerson([process.execPath, CLI, ...args], env) : runConfirmed([process.execPath, CLI, ...args], env, confirm);
}

describe("Walkie Direct: the CLI", () => {
  test("walkie invite --handle prints a code; walkie join <code> admits; who and doctor show Direct", async () => {
    const inv = await walkie(alex, ["invite", "--handle", "dana", "--role", "observer"], "dana");
    expect(inv.code).toBe(0);
    const code = /\b(wk1[A-Za-z0-9_-]+)/.exec(inv.out)?.[1];
    expect(code).toBeDefined();
    expect(inv.out).toContain("single use");
    const dana = await c.add({ name: "dana", login: "-", hostname: "dana-mbp", direct: true });
    const joined = await walkie(dana, ["join", code as string]);
    expect(joined.code).toBe(0);
    expect(joined.out).toContain("joined acme as @dana (observer)");
    const again = await walkie(await c.add({ name: "eve", login: "-", hostname: "eve-mbp", direct: true }), ["join", code as string]);
    expect(again.code).not.toBe(0);
    expect(again.err).toContain("already used");
    const who = await walkie(alex, ["who"]);
    expect(who.out).toMatch(/dana-mbp .*· direct/);
    const doc = await walkie(dana, ["doctor", "--json"]);
    const checks = (JSON.parse(doc.out) as { checks: { name: string; level: string; detail: string }[] }).checks;
    expect(checks.find((x) => x.name === "transport")?.detail).toContain("Walkie Direct");
    expect(checks.find((x) => x.name === "walkie direct")?.detail).toContain("endpoint");
    expect(checks.some((x) => x.name.startsWith("tailscale"))).toBe(false);
  }, 30_000);

  // DIRECT-FIX-1 (Opus MEDIUM 2): single-machine revoke (SECURITY.md threat 1).
  test("walkie team revoke <machine> revokes one machine through the authority; never this machine", async () => {
    const self = await walkie(alex, ["team", "revoke", "alex-mbp"], "alex-mbp");
    expect(self.code).not.toBe(0);
    expect(self.err).toContain("your own machine");
    const missing = await walkie(alex, ["team", "revoke", "no-such-mbp"], "no-such-mbp");
    expect(missing.code).not.toBe(0);
    const r = await walkie(alex, ["team", "revoke", "dana-mbp"], "dana-mbp");
    expect(r.code).toBe(0);
    expect(r.out).toContain("revoked dana-mbp");
    const dana = [...alex.d.core.roster.nodes.values()].find((n) => n.hostname === "dana-mbp");
    expect(dana).toMatchObject({ revoked: true, transports: ["direct"] });
    expect(dana?.revoked_by_removal).toBeUndefined();
    expect(alex.d.core.roster.members.get("direct:dana")?.role).toBe("observer"); // the member stays
    const who = await walkie(alex, ["who"]);
    expect(who.out).not.toContain("dana-mbp");
  }, 30_000);

  test("walkie init --direct founds a Direct team; --direct and --tailscale are exclusive", async () => {
    const fay = await c.add({ name: "fay", login: "-", hostname: "fay-mbp", direct: true });
    const both = await walkie(fay, ["init", "solo", "--handle", "fay", "--direct", "--tailscale"]);
    expect(both.code).not.toBe(0);
    const r = await walkie(fay, ["init", "solo", "--handle", "fay", "--direct"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Walkie Direct");
    expect(r.out).toContain("walkie invite --handle <name>");
    expect((await fay.client().me()).transport?.mode).toBe("direct");
  }, 30_000);
});

describe("Walkie Direct: the peer gate is the authenticated key", () => {
  test("an outsider key is refused on every endpoint, and can't join without an invite", async () => {
    await expect(outsider.client.vv(alexAddr())).rejects.toMatchObject({ status: 403, code: "not_member" });
    await expect(outsider.client.hello(alexAddr())).rejects.toMatchObject({ status: 403, code: "not_member" });
    await expect(outsider.client.pull(alexAddr(), alex.d.nodeId, 0)).rejects.toMatchObject({ status: 403 });
    await expect(outsider.client.join(alexAddr(), { pubkey: outsider.keys.pubkey, hostname: "evil", ip: "", port: 7458 }))
      .rejects.toMatchObject({ status: 403, code: "not_member" });
  });

  test("an outsider can't join with a used, forged or someone else's invite", async () => {
    const join = (invite: string, pubkey = outsider.keys.pubkey) =>
      outsider.client.join(alexAddr(), { pubkey, hostname: "evil", ip: "", port: 7458, invite });
    await expect(join(kiraCode)).rejects.toMatchObject({ status: 403, code: "invite_used" });
    const forged = createInvite(outsider.keys, {
      team: alex.d.core.teamId as string, authority: alex.d.core.keys.pubkey, handle: "mallory", role: "owner", now: Date.now(), pos: 0,
    });
    await expect(join(forged.code)).rejects.toMatchObject({ status: 403, code: "invite_issuer_unknown" });
    // A valid, unused invite presented for ANOTHER key: the key admitted must be the connection's own.
    const fresh = await alex.client().inviteCode("sam", "member");
    await expect(join(fresh.code, kira.d.core.keys.pubkey)).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(alex.d.core.roster.members.get("direct:mallory")).toBeUndefined();
  });

  test("a spoofed X-Walkie-Node never widens the gate (the key decides)", async () => {
    const spoof = new PeerClient({ team: () => alex.d.core.teamId, nodeId: kira.d.nodeId }, outsider.client.transports);
    await expect(spoof.vv(alexAddr())).rejects.toMatchObject({ status: 403 });
  });

  test("a revoked node is refused; its member's other data is untouched", async () => {
    const before = await riley.d.client.vv(alexAddr());
    expect(before.node).toBe(alex.d.nodeId);
    const n = alex.d.core.roster.nodes.get(riley.d.nodeId);
    if (!n) throw new Error("riley's node missing");
    const held = () => (alex.d.transport as unknown as { net: DirectNet }).net.stats().admittedByKey.get(riley.d.core.keys.pubkey) ?? 0;
    expect(held()).toBeGreaterThan(0);
    alex.d.core.emit("team.node", { node_id: n.node_id, login: n.login, hostname: n.hostname, pubkey: n.pubkey, ip: "", revoked: true, transports: ["direct"] });
    // DIRECT-FIX-1: the revocation closes riley's connection to alex at once (a request racing it sees the close);
    // riley's next connection is refused at the gate.
    await waitFor(async () => held() === 0, { what: "riley's admitted connection closed by the revocation" });
    const err = await waitFor(async () => {
      const e = await riley.d.client.vv(alexAddr()).then(() => null, (x: unknown) => x);
      return e instanceof PeerCallError && e.status === 403 ? e : null;
    }, { what: "riley refused after revocation" });
    expect(err).toMatchObject({ status: 403, code: "not_member" });
    // Revoked explicitly: even a fresh invite can't bring the same key back.
    const inv = await alex.client().inviteCode("riley", "member");
    await expect(riley.d.client.join(alexAddr(), { pubkey: riley.d.core.keys.pubkey, hostname: "riley-air", ip: "", port: 7458, invite: inv.code }))
      .rejects.toMatchObject({ status: 403, code: "forbidden" });
    // kira still syncs.
    expect((await kira.d.client.vv(alexAddr())).node).toBe(alex.d.nodeId);
  });

  test("removing a member cuts their machine off, closing its open connections", async () => {
    const held = () => (alex.d.transport as unknown as { net: DirectNet }).net.stats().admittedByKey.get(kira.d.core.keys.pubkey) ?? 0;
    await kira.d.client.vv(alexAddr());
    expect(held()).toBeGreaterThan(0);
    await alex.client().setRole("kira", "removed");
    await waitFor(async () => held() === 0, { what: "kira's admitted connections closed by the removal" });
    await waitFor(async () => {
      const e = await kira.d.client.vv(alexAddr()).then(() => null, (x: unknown) => x);
      return e instanceof PeerCallError && e.status === 403;
    }, { what: "kira refused after removal" });
  });

  test("a non-owner can't mint invites", async () => {
    // kira was removed above; riley revoked: use a fresh member on a new node.
    const sam = await c.add({ name: "sam", login: "-", hostname: "sams-mbp", direct: true });
    const inv = await alex.client().inviteCode("sam", "member");
    expect((await sam.client().join(inv.code)).admitted).toBe(true);
    const err = await sam.client().inviteCode("eve", "owner").then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(WalkieError);
    expect((err as WalkieError).status).toBe(403);
  });
});
