// Mixed teams (ALE-5265, PROTOCOL §4 "Mixed teams"): one Tailscale team, both transports.
//   alex   the roster authority: Tailscale (fake tailnet) + Walkie Direct after `walkie direct enable` (dual)
//   bob    Tailscale only
//   arvid  Walkie Direct only, joined with an invite code minted on the Tailscale team
//   dave   a real v0.1.3 daemon (the tagged source, run in-process), Tailscale only
// Anti-entropy runs every 20 s here, so anything that arrives within a couple of seconds came by push/relay.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { WalkieClient, WalkieError } from "../../src/client/index.ts";
import { DirectNet } from "../../src/daemon/direct/net.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { PeerCallError, PeerClient } from "../../src/daemon/peer-client.ts";
import { Transports } from "../../src/daemon/transport.ts";
import type { SyncOptions } from "../../src/daemon/sync.ts";
import { Cluster, TEST_LIMITS, waitFor, type TestNode } from "../helpers/cluster.ts";

const SLOW: SyncOptions = { intervalMs: 20_000, livenessMs: 60_000, pushTimeoutMs: 1_000 };
const REPO = join(import.meta.dir, "../..");

let c: Cluster;
let alex: TestNode, bob: TestNode, arvid: TestNode;

beforeAll(async () => {
  c = new Cluster();
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", dual: true, sync: SLOW });
  bob = await c.add({ name: "bob", login: "bob@example.com", hostname: "bobs-mbp", sync: SLOW });
  arvid = await c.add({ name: "arvid", login: "-", hostname: "arvid-mbp", direct: true, sync: SLOW });
}, 30_000);

afterAll(async () => {
  await dave?.stop().catch(() => undefined);
  await c.close();
});

const alexDirect = () => ({ ip: "", port: 7458, pubkey: alex.d.core.keys.pubkey });
const texts = async (n: { events: (q: { channel: string; kinds: string }) => Promise<{ events: { body: unknown }[] }> }) =>
  (await n.events({ channel: "general", kinds: "msg.post" })).events.map((e) => (e.body as { text?: string }).text);
const sees = (client: WalkieClient, text: string) => async () => (await texts(client)).includes(text);
type HeldStats = { net: DirectNet };

describe("a Tailscale team turns on Walkie Direct", () => {
  test("a Tailscale team without a Direct authority can't mint invite codes", async () => {
    const me = await alex.client().init("aka", "alex");
    expect(me.transport?.mode).toBe("tailscale");
    await alex.client().invite("bob@example.com", "bob", "member");
    expect((await bob.client().join(alex.peerAddr)).admitted).toBe(true);
    await bob.client().post({ channel: "general", text: "bob: before arvid" });
    const err = await alex.client().inviteCode("arvid", "member").then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(WalkieError);
    expect((err as WalkieError).code).toBe("direct_unavailable");
    expect((err as WalkieError).message).toContain("walkie direct enable");
  });

  test("walkie direct enable on the authority appends one re-pin; the roster isn't forked or rewritten", async () => {
    await waitFor(() => bob.d.core.chainLength === alex.d.core.chainLength, { what: "bob caught up" });
    const before = alex.d.core.chainLength;
    const nodesBefore = [...alex.d.core.roster.nodes.keys()].sort();
    const res = await alex.client().request<{ transports: string[]; advertised: boolean; direct: { endpoint: string } | null }>("POST", "/v1/direct/enable", {});
    expect(res).toMatchObject({ transports: ["tailscale", "direct"], advertised: true });
    expect(res.direct?.endpoint).toBe(Buffer.from(alex.d.core.keys.pubkey, "base64").toString("hex"));
    expect(alex.d.core.chainLength).toBe(before + 1);
    const rec = alex.d.core.roster.nodes.get(alex.d.nodeId);
    expect(rec).toMatchObject({ ip: "127.0.0.1", login: "alex@example.com", transports: ["tailscale", "direct"] });
    expect([...alex.d.core.roster.nodes.keys()].sort()).toEqual(nodesBefore);
    await waitFor(() => bob.d.core.roster.nodes.get(alex.d.nodeId)?.transports?.includes("direct"), { what: "bob sees alex serve Direct" });
    expect(bob.d.core.chainLength).toBe(before + 1);
    const me = await alex.client().me();
    expect(me.transport).toMatchObject({ mode: "tailscale", transports: ["tailscale", "direct"] });
    // The authority still answers over the tailnet.
    expect((await bob.d.client.vv({ ip: "127.0.0.1", port: alex.peerPort })).node).toBe(alex.d.nodeId);
  });

  test("arvid joins the Tailscale team with an invite code (Direct only)", async () => {
    const inv = await alex.client().inviteCode("arvid", "member");
    expect(inv.code.startsWith("wk1")).toBe(true);
    const t0 = performance.now();
    const res = await arvid.client().join(inv.code);
    console.log(`[metric] mixed join over Direct (dial + admit + full pull): ${(performance.now() - t0).toFixed(1)} ms`);
    expect(res).toMatchObject({ admitted: true, handle: "arvid", role: "member" });
    const node = alex.d.core.roster.nodes.get(arvid.d.nodeId);
    expect(node).toMatchObject({ login: "direct:arvid", ip: "", transports: ["direct"] });
    expect((await arvid.client().me()).transport?.mode).toBe("direct");
    // History from the Tailscale-only member came through the authority.
    expect(await texts(arvid.client())).toContain("bob: before arvid");
    await waitFor(() => bob.d.core.roster.nodes.get(arvid.d.nodeId), { what: "bob learns arvid's machine" });
  }, 30_000);
});

describe("Tailscale-only ⇄ Direct-only through the dual authority", () => {
  test("posts cross both ways at push speed (relayed by the authority, not the 20 s anti-entropy)", async () => {
    let t0 = performance.now();
    await bob.client().post({ channel: "general", text: "bob → arvid" });
    await waitFor(sees(arvid.client(), "bob → arvid"), { timeoutMs: 5_000, what: "arvid gets bob's post" });
    console.log(`[metric] bob (Tailscale) → arvid (Direct) via alex: ${(performance.now() - t0).toFixed(1)} ms`);
    t0 = performance.now();
    await arvid.client().post({ channel: "general", text: "arvid → bob" });
    await waitFor(sees(bob.client(), "arvid → bob"), { timeoutMs: 5_000, what: "bob gets arvid's post" });
    console.log(`[metric] arvid (Direct) → bob (Tailscale) via alex: ${(performance.now() - t0).toFixed(1)} ms`);
    expect(await texts(alex.client())).toEqual(expect.arrayContaining(["bob → arvid", "arvid → bob"]));
  }, 20_000);

  test("asks work across: bob asks @arvid, arvid answers", async () => {
    const t0 = performance.now();
    const { event: ask } = await bob.client().ask({ to: "@arvid", text: "which build did you test?", channel: "general", timeout_s: 60 });
    const open = await waitFor(async () => (await arvid.client().asks({ state: "open", to: "me" })).asks.find((a) => a.ask.id === ask.id), { timeoutMs: 5_000, what: "ask reaches arvid" });
    await arvid.client().answer({ ask: open.ask.id, text: "v0.2.0 from the mixed branch" });
    const done = await bob.client().askView(ask.id, 10);
    console.log(`[metric] ask/answer bob → arvid → bob: ${(performance.now() - t0).toFixed(1)} ms`);
    expect(done.state).toBe("answered");
    expect((done.answers[0]?.body as { text?: string }).text).toBe("v0.2.0 from the mixed branch");
  }, 20_000);

  test("artifacts cross both ways: the authority fetches from the uploader for a peer that can't reach it", async () => {
    const fromBob = new TextEncoder().encode("bob's build log\n".repeat(200));
    const { event: s1 } = await bob.client().share(fromBob, { name: "build.log", mime: "text/plain", channel: "general" });
    const h1 = (s1.body as { hash: string }).hash;
    await waitFor(async () => (await arvid.client().event(s1.id).catch(() => null)) !== null, { timeoutMs: 5_000, what: "arvid gets bob's share" });
    expect(Buffer.from(await arvid.client().fetchArtifact(h1)).equals(Buffer.from(fromBob))).toBe(true);
    const fromArvid = new TextEncoder().encode("arvid's notes\n".repeat(100));
    const { event: s2 } = await arvid.client().share(fromArvid, { name: "notes.txt", mime: "text/plain", channel: "general" });
    await waitFor(async () => (await bob.client().event(s2.id).catch(() => null)) !== null, { timeoutMs: 5_000, what: "bob gets arvid's share" });
    expect(Buffer.from(await bob.client().fetchArtifact((s2.body as { hash: string }).hash)).equals(Buffer.from(fromArvid))).toBe(true);
  }, 20_000);

  test("fetch-on-behalf re-judges access after the download (Codex mixed MEDIUM 1)", async () => {
    await alex.client().request("POST", "/v1/channels", { name: "ops", members: ["alex", "bob", "arvid"] });
    await waitFor(async () => arvid.d.core.roster.channels.has("ops") && bob.d.core.roster.channels.has("ops"), { timeoutMs: 10_000, what: "ops reaches everyone" });
    const secret = new TextEncoder().encode("ops runbook\n".repeat(50));
    const { event: sh } = await bob.client().share(secret, { name: "runbook.txt", mime: "text/plain", channel: "ops" });
    const hash = (sh.body as { hash: string }).hash;
    await waitFor(async () => (await arvid.client().event(sh.id).catch(() => null)) !== null, { timeoutMs: 5_000, what: "arvid gets the ops share" });
    const real = alex.d.core.fetchBlob!;
    alex.d.core.fetchBlob = async (nodeId, h, ch) => {
      const ok = await real(nodeId, h, ch);
      // arvid loses the channel while the authority is downloading on his behalf
      await alex.client().request("POST", "/v1/channels", { name: "ops", members: ["alex", "bob"] });
      return ok;
    };
    try {
      const err = await arvid.client().fetchArtifact(hash).then(() => null, (e: unknown) => e);
      console.log(`[evidence] fetch after losing the channel mid-download: ${err ? (err as Error).message : "SERVED"}`);
      expect(err).not.toBeNull();
    } finally {
      alex.d.core.fetchBlob = real;
    }
  }, 20_000);

  test("who: each sees the other online, marked via relay; the authority reaches both directly", async () => {
    const peer = async (n: TestNode, host: string) => (await n.client().peers()).nodes.find((x) => x.hostname === host);
    await waitFor(async () => (await peer(arvid, "bobs-mbp"))?.online, { timeoutMs: 30_000, what: "arvid sees bob online" });
    await waitFor(async () => (await peer(bob, "arvid-mbp"))?.online, { timeoutMs: 30_000, what: "bob sees arvid online" });
    expect((await peer(arvid, "bobs-mbp"))?.via).toBe("relay");
    expect((await peer(bob, "arvid-mbp"))?.via).toBe("relay");
    expect((await peer(arvid, "alex-mbp"))?.via).toBe("direct");
    expect((await peer(alex, "arvid-mbp"))?.via).toBe("direct");
    expect((await peer(alex, "bobs-mbp"))?.via).toBe("tailscale");
    expect((await peer(bob, "alex-mbp"))?.via).toBe("tailscale");
  }, 70_000);

  test("authority can't move to a machine the Direct-only member couldn't reach", async () => {
    const err = await alex.client().request("POST", "/v1/team/authority", { node: "bobs-mbp" }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(WalkieError);
    expect((err as WalkieError).code).toBe("authority_unreachable");
    expect(alex.d.core.authority).toBe(alex.d.nodeId);
  });
});

describe("no impersonation across transports", () => {
  test("arvid's key can't claim bob's node over Direct", async () => {
    const asBob = new PeerClient({ team: () => alex.d.core.teamId, nodeId: bob.d.nodeId }, arvid.d.client.transports);
    await expect(asBob.vv(alexDirect())).rejects.toMatchObject({ status: 403 });
  });

  test("bob's key over Direct is refused: a Tailscale-only record doesn't serve Direct", async () => {
    const keys = bob.d.core.keys;
    const net = await DirectNet.start({
      keys, log: createLogger({ file: `${c.root}/bob-direct.log` }), admitted: () => false,
      handler: async () => new Response("no", { status: 404 }),
    }, { preset: "minimal", bindAddr: "127.0.0.1:0", addressBook: new Map(c.addressBook) });
    try {
      const client = new PeerClient({ team: () => alex.d.core.teamId, nodeId: keys.nodeId }, new Transports());
      client.transports.direct = net;
      await expect(client.vv(alexDirect())).rejects.toMatchObject({ status: 403, code: "not_member" });
    } finally {
      await net.stop();
    }
  });

  test("the tailnet gate refuses a caller naming arvid's machine, or holding a Direct login", async () => {
    const call = (node: string) => fetch(`http://127.0.0.1:${alex.peerPort}/peer/v1/vv`, {
      headers: { "X-Walkie-Team": alex.d.core.teamId as string, "X-Walkie-Node": node },
    });
    expect((await call(arvid.d.nodeId)).status).toBe(403); // no tailnet identity for a Direct-only machine
    c.identities.set(arvid.d.nodeId, { login: "direct:arvid", nodeName: "arvid-mbp" }); // a whois claiming its login
    try {
      const res = await call(arvid.d.nodeId);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_member");
    } finally {
      c.identities.delete(arvid.d.nodeId);
    }
  });
});

// ---- a real v0.1.3 daemon on the same team ---------------------------------------------------------------

interface V013 { nodeId: string; socket: string; stop(): Promise<void> }
let dave: V013 | null = null;

/** The v0.1.3 tree from its tag (gitignored .cache/), run in-process; null when the tag isn't available. */
async function startV013(): Promise<V013 | null> {
  const root = join(REPO, ".cache/v0.1.3");
  const ready = () => existsSync(join(root, "src/daemon/main.ts")) && existsSync(join(root, "package.json"));
  if (!ready()) {
    mkdirSync(root, { recursive: true });
    const r = Bun.spawnSync(["sh", "-c", `git archive v0.1.3 src package.json | tar -x -C "${root}"`], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0 || !ready()) return null;
  }
  const main = await import(join(root, "src/daemon/main.ts")) as typeof import("../../src/daemon/main.ts");
  const idm = await import(join(root, "src/daemon/identity.ts")) as typeof import("../../src/daemon/identity.ts");
  const home = join(c.root, "dave");
  const socket = join(home, "walkie.sock");
  const d = await main.startDaemon({
    home, socket, identity: new idm.FakeIdentity({ ip: "127.0.0.1", login: "dave@example.com", nodeName: "daves-mbp" }, c.identities),
    peerHost: "127.0.0.1", peerPort: 0, localPort: 0, hostname: "daves-mbp", sync: SLOW, limits: TEST_LIMITS,
    webDir: join(home, "no-web"), env: false, heartbeatMs: 15_000, integrations: { autoRun: false }, licenseRenew: false,
    discovery: false, licenseService: { fetch: async () => { throw new Error("no license service in tests"); } },
  });
  c.identities.set(d.nodeId, { login: "dave@example.com", nodeName: "daves-mbp" });
  return { nodeId: d.nodeId, socket, stop: () => d.stop() };
}

describe("compatibility", () => {
  test("a v0.1.3 Tailscale node on the mixed team syncs both ways with the Direct-only member", async () => {
    dave = await startV013();
    if (!dave) { console.log("[skip] v0.1.3 tag not available in this checkout"); return; }
    const daveClient = new WalkieClient({ socket: dave.socket, timeoutMs: 15_000 });
    expect((await daveClient.me()).version).toBe("0.1.3");
    await alex.client().invite("dave@example.com", "dave", "member");
    expect((await daveClient.join(alex.peerAddr)).admitted).toBe(true);
    // The v0.1.3 node holds the whole mixed roster (it ignores the transport fields) and arvid's history.
    expect(await texts(daveClient)).toEqual(expect.arrayContaining(["arvid → bob", "bob: before arvid"]));
    await daveClient.post({ channel: "general", text: "dave (v0.1.3) → arvid" });
    await waitFor(sees(arvid.client(), "dave (v0.1.3) → arvid"), { timeoutMs: 5_000, what: "arvid gets the v0.1.3 node's post" });
    await arvid.client().post({ channel: "general", text: "arvid → dave (v0.1.3)" });
    await waitFor(sees(daveClient, "arvid → dave (v0.1.3)"), { timeoutMs: 5_000, what: "the v0.1.3 node gets arvid's post" });
  }, 60_000);

  test("restarting the authority keeps it dual (config and record); arvid keeps syncing", async () => {
    await alex.restart();
    expect((await alex.client().me()).transport?.transports).toEqual(["tailscale", "direct"]);
    await arvid.client().post({ channel: "general", text: "arvid after alex restarted" });
    await waitFor(sees(alex.client(), "arvid after alex restarted"), { timeoutMs: 30_000, what: "alex gets arvid's post after restart" });
    await waitFor(sees(bob.client(), "arvid after alex restarted"), { timeoutMs: 30_000, what: "bob gets it too" });
  }, 60_000);
});

describe("removal", () => {
  test("removing arvid closes his Direct connection; he is refused and learns of it", async () => {
    await arvid.d.client.vv(alexDirect());
    const held = () => (alex.d.transport as unknown as HeldStats).net.stats().admittedByKey.get(arvid.d.core.keys.pubkey) ?? 0;
    expect(held()).toBeGreaterThan(0);
    await alex.client().setRole("arvid", "removed");
    await waitFor(() => held() === 0, { what: "arvid's connection closed by the removal" });
    await waitFor(async () => {
      const e = await arvid.d.client.vv(alexDirect()).then(() => null, (x: unknown) => x);
      return e instanceof PeerCallError && e.status === 403;
    }, { what: "arvid refused after removal" });
    await waitFor(() => arvid.d.core.roster.members.get("direct:arvid")?.role === "removed", { what: "arvid learns he was removed" });
    await waitFor(async () => !(await bob.client().peers()).nodes.some((n) => n.hostname === "arvid-mbp"), { what: "bob drops arvid" });
  }, 30_000);
});
