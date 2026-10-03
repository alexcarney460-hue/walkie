// A Direct-only machine whose Walkie Direct endpoint is not up (every start until it binds, or a bind that fails and
// retries) shares no transport with ANY machine, the dual authority included. Reporting them all as "unreached" would
// send the person to `walkie direct enable`, which does nothing on a Direct-only daemon (it returns early); doctor's
// "walkie direct: not running" already says what is wrong. Real daemons: the endpoint is held down with a bind address
// that cannot bind, and the daemon keeps retrying.
//   alex   dual (Tailscale + Walkie Direct), the roster authority and the bridge
//   bob    Tailscale only
//   arvid  Walkie Direct only: the machine under test
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { runAsPerson } from "../helpers/person-cli.ts";

const CLI = join(import.meta.dir, "../../src/cli/main.ts");
const FAST = { intervalMs: 1_000, livenessMs: 4_000, pushTimeoutMs: 1_000 };

let c: Cluster;
let alex: TestNode, bob: TestNode, arvid: TestNode;

const peers = async (n: TestNode) => (await n.client().peers()).nodes.filter((x) => !x.self);
const peer = async (n: TestNode, host: string) => (await peers(n)).find((x) => x.hostname === host);

beforeAll(async () => {
  c = new Cluster();
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", dual: true, sync: FAST });
  bob = await c.add({ name: "bob", login: "bob@example.com", hostname: "bobs-mbp", sync: FAST });
  arvid = await c.add({ name: "arvid", login: "-", hostname: "arvid-mbp", direct: true, sync: FAST });
  await alex.client().init("aka", "alex");
  await alex.client().invite("bob@example.com", "bob", "member");
  expect((await bob.client().join(alex.peerAddr)).admitted).toBe(true);
  await alex.client().request("POST", "/v1/direct/enable", {});
  const inv = await alex.client().inviteCode("arvid", "member");
  expect((await arvid.client().join(inv.code)).admitted).toBe(true);
  await waitFor(async () => (await peer(arvid, "bobs-mbp"))?.online, { timeoutMs: 30_000, what: "arvid sees bob online through alex" });
}, 60_000);

afterAll(async () => { await c.close(); });

describe("a Direct-only machine whose Walkie Direct endpoint is down", () => {
  test("with the endpoint up it lists the Tailscale-only machine it shares no transport with", async () => {
    expect(await peer(arvid, "bobs-mbp")).toMatchObject({ via: "relay", unreached: { vouched: true } });
    expect(await peer(arvid, "alex-mbp")).toMatchObject({ via: "direct" });
    expect((await peer(arvid, "alex-mbp"))?.unreached).toBeUndefined();
  });

  test("with the endpoint failing to bind it reports no unreached machines at all, and doctor names the real problem", async () => {
    arvid.spec.directBind = "not-an-address";
    await arvid.restart();
    const me = await arvid.client().me();
    expect(me.transport?.mode).toBe("direct");
    expect(me.transport?.transports).toEqual([]); // nothing served: the endpoint is not up
    // Every other machine, the dual authority included, is out of reach (relay), and none of them is "unreached".
    const others = await peers(arvid);
    expect(others.map((n) => [n.hostname, n.via]).sort()).toEqual([["alex-mbp", "relay"], ["bobs-mbp", "relay"]]);
    expect(others.filter((n) => n.unreached !== undefined)).toEqual([]);

    const env: Record<string, string> = { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: arvid.home, WALKIE_SOCKET: arvid.socket };
    const r = await runAsPerson([process.execPath, CLI, "doctor", "--json"], env);
    const checks = (JSON.parse(r.out) as { checks: { level: string; name: string; detail: string }[] }).checks;
    expect(checks.find((x) => x.name === "walkie direct")).toMatchObject({ level: "fail" });
    expect(checks.some((x) => x.name === "mixed transports")).toBe(false);
  }, 60_000);

  test("once the endpoint is up again the gap that is really there is listed", async () => {
    arvid.spec.directBind = undefined;
    await arvid.restart();
    await waitFor(async () => (await peer(arvid, "bobs-mbp"))?.unreached !== undefined, { timeoutMs: 30_000, what: "bob listed as unreached once Direct is up" });
    expect(await peer(arvid, "bobs-mbp")).toMatchObject({ via: "relay", unreached: expect.anything() });
    expect((await peer(arvid, "alex-mbp"))?.unreached).toBeUndefined();
  }, 60_000);
});
