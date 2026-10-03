// Mixed teams (PROTOCOL §4 "Mixed teams"): the machines this one shares no transport with, and whether each shows
// online, which for such a machine is only on the word of a machine that reaches it (SyncManager.unreached, the
// `unreached` field of NodeView). The roster: alex the dual authority, bob Tailscale-only, carol and dana Direct-only;
// the machine under test is "iris" (Tailscale-only, dual, or Direct-only per test). The real PeerClient decides who
// shares a transport; only the peer's answer to a vv call and the clock are faked.
import { afterEach, describe, expect, test } from "bun:test";
import { PeerClient, type PeerAddr } from "../../src/daemon/peer-client.ts";
import type { NodeRec } from "../../src/daemon/roster.ts";
import { SyncManager } from "../../src/daemon/sync.ts";
import type { Transport } from "../../src/daemon/transport.ts";
import { nodesView, teamView } from "../../src/daemon/views.ts";
import type { TransportKind } from "../../src/protocol/schemas.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { createTeam, ev, memberEv, tnode, type TNode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const LIVENESS_MS = 45_000;
const hex = (n: TNode) => Buffer.from(n.keys.pubkey, "base64").toString("hex");

/** What the machine under test serves: a v0.1 Tailscale record, both transports, or Walkie Direct only. */
type Kind = "tailscale" | "dual" | "direct";

function world(kind: Kind, directRunning = kind !== "tailscale") {
  /** The daemon's word (main.ts, DirectLink.pending) that this machine should run Walkie Direct but its endpoint is not up. */
  let directPending = false;
  const alex = tnode("alex"), bob = tnode("bob"), carol = tnode("carol", "direct:carol"), dana = tnode("dana", "direct:dana");
  const iris = tnode("iris", kind === "direct" ? "direct:iris" : "iris@example.com");
  const { team, create } = createTeam(alex);
  const node = (who: TNode, ip: string, transports?: TransportKind[]) => ev(team, alex, "team.node", {
    node_id: who.keys.nodeId, login: who.login, hostname: who.hostname, pubkey: who.keys.pubkey, ip,
    ...(transports ? { transports, endpoint: hex(who) } : {}),
  });
  const core = makeCore(iris, team, cleanups);
  feed(core, [
    create,
    node(alex, "100.64.0.1", ["tailscale", "direct"]), // alex's own re-pin: dual
    memberEv(team, alex, bob, "member"), node(bob, "100.64.0.3"),
    memberEv(team, alex, carol, "member"), node(carol, "", ["direct"]),
    memberEv(team, alex, dana, "member"), node(dana, "", ["direct"]),
    memberEv(team, alex, iris, "member"),
    kind === "tailscale" ? node(iris, "100.64.0.2") : kind === "dual" ? node(iris, "100.64.0.2", ["tailscale", "direct"]) : node(iris, "", ["direct"]),
  ]);
  expect(core.roster.nodes.size).toBe(5); // a world that did not build would make every expectation below empty

  const client = new PeerClient({ team: () => core.teamId, nodeId: core.nodeId, self: () => core.roster.nodes.get(core.nodeId) });
  if (directRunning) client.transports.direct = { kind: "direct", request: async () => new Response("{}") } as Transport;
  let clock = 1_000_000;
  /** What each reached peer (by pubkey) reports online in its next vv answer. */
  const answers = new Map<string, string[]>();
  client.vv = (async (_addr: PeerAddr, pubkey?: string) => ({ node: "peer", vv: {}, ts: clock, online: answers.get(pubkey ?? "") ?? [] })) as unknown as typeof client.vv;
  const sync = new SyncManager(core, client, { now: () => clock, livenessMs: LIVENESS_MS, directPending: () => directPending });
  return {
    alex, bob, carol, dana, team, core, sync, answers,
    setDirectPending: (v: boolean) => { directPending = v; },
    /** An anti-entropy round with `who` (only a machine this one shares a transport with is reached). */
    reach: (who: TNode) => sync.antiEntropy(core.roster.nodes.get(who.keys.nodeId) as NodeRec),
    advance: (ms: number) => { clock += ms; },
    /** [hostname, vouched] of the unreached machines, by hostname. */
    unreached: () => sync.unreached().map((u) => [u.node.hostname, u.vouched] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    views: () => new Map(nodesView(core, sync).map((n) => [n.hostname, n])),
  };
}

describe("a Tailscale-only machine", () => {
  test("lists the Direct-only machines it shares no transport with, each online only on a reaching machine's word", async () => {
    const w = world("tailscale");
    expect(w.unreached()).toEqual([["carol-mbp", false], ["dana-mbp", false]]);
    // alex (dual) is reached over Tailscale and says carol is online: carol is vouched for, dana is not.
    w.answers.set(w.alex.keys.pubkey, [w.carol.keys.nodeId]);
    await w.reach(w.alex);
    expect(w.unreached()).toEqual([["carol-mbp", true], ["dana-mbp", false]]);

    const view = w.views();
    expect(view.get("carol-mbp")).toMatchObject({ via: "relay", online: true, unreached: { vouched: true } });
    expect(view.get("dana-mbp")).toMatchObject({ via: "relay", online: false, unreached: { vouched: false } });
    // Machines it reaches itself, and itself, are never "unreached": bob is offline here (never synced) but reachable.
    for (const host of ["alex-mbp", "bob-mbp", "iris-mbp"]) expect(view.get(host)).not.toHaveProperty("unreached");
    expect(view.get("alex-mbp")).toMatchObject({ via: "tailscale", online: true });
    expect(view.get("bob-mbp")).toMatchObject({ via: "tailscale", online: false });
    expect(view.get("iris-mbp")).toMatchObject({ self: true, online: true });
    // The team view (walkie who, GET /v1/team) carries the same field.
    expect(teamView(w.core, w.sync)?.nodes.find((n) => n.hostname === "carol-mbp")?.unreached).toEqual({ vouched: true });
  });

  test("a vouch lapses with the liveness window; a fresh answer brings it back", async () => {
    const w = world("tailscale");
    w.answers.set(w.alex.keys.pubkey, [w.carol.keys.nodeId, w.dana.keys.nodeId]);
    await w.reach(w.alex);
    expect(w.unreached()).toEqual([["carol-mbp", true], ["dana-mbp", true]]);
    w.advance(LIVENESS_MS - 1);
    expect(w.unreached()).toEqual([["carol-mbp", true], ["dana-mbp", true]]);
    w.advance(1);
    expect(w.unreached()).toEqual([["carol-mbp", false], ["dana-mbp", false]]);
    expect(w.views().get("carol-mbp")).toMatchObject({ online: false, unreached: { vouched: false } });
    await w.reach(w.alex);
    expect(w.unreached()).toEqual([["carol-mbp", true], ["dana-mbp", true]]);
  });

  test("a removed member's machine is not listed", () => {
    const w = world("tailscale");
    feed(w.core, [ev(w.team, w.alex, "team.member", { login: w.dana.login, handle: "dana", role: "removed" })]);
    expect(w.unreached()).toEqual([["carol-mbp", false]]);
    expect(w.views().has("dana-mbp")).toBe(false);
  });
});

describe("observers", () => {
  test("an observer's machine is not listed: an observer publishes no agent status, so nothing of theirs can be hidden", () => {
    const w = world("tailscale");
    expect(w.unreached()).toEqual([["carol-mbp", false], ["dana-mbp", false]]);
    feed(w.core, [memberEv(w.team, w.alex, w.carol, "observer")]);
    expect(w.core.roster.members.get(w.carol.login)?.role).toBe("observer");
    expect(w.unreached()).toEqual([["dana-mbp", false]]);
    expect(w.views().get("carol-mbp")).not.toHaveProperty("unreached"); // still on the team, still via relay
    expect(w.views().get("carol-mbp")).toMatchObject({ via: "relay" });
    // Why: the roster refuses every agent status from an observer.
    const status = ev(w.team, w.carol, "agent.status", { agent: "bot", state: "working", runtime: "cli", title: "x" }, { agent: "bot" });
    expect(w.core.ingest(status, "remote")).toMatchObject({ status: "rejected", reason: "observer_readonly" });
    // When the only machines out of reach are observers', there is nothing to report at all.
    feed(w.core, [memberEv(w.team, w.alex, w.dana, "observer")]);
    expect(w.unreached()).toEqual([]);
    for (const n of w.views().values()) expect(n).not.toHaveProperty("unreached");
  });

  test("members and owners are listed, and a machine returns to the list when its person stops being an observer", () => {
    const w = world("tailscale");
    feed(w.core, [memberEv(w.team, w.alex, w.carol, "observer"), memberEv(w.team, w.alex, w.dana, "owner")]);
    expect(w.unreached()).toEqual([["dana-mbp", false]]);
    feed(w.core, [memberEv(w.team, w.alex, w.carol, "member")]);
    expect(w.unreached()).toEqual([["carol-mbp", false], ["dana-mbp", false]]);
  });
});

describe("a dual machine", () => {
  test("shares a transport with every machine: nothing is unreached", () => {
    const w = world("dual");
    expect(w.unreached()).toEqual([]);
    const view = w.views();
    for (const n of view.values()) expect(n).not.toHaveProperty("unreached");
    expect(["alex-mbp", "bob-mbp", "carol-mbp", "dana-mbp"].map((h) => view.get(h)?.via)).toEqual(["tailscale", "tailscale", "direct", "direct"]);
  });

  test("whose Walkie Direct is not running can't reach the Direct-only machines, whatever its record says (the raw view)", () => {
    const w = world("dual", false);
    expect(w.unreached()).toEqual([["carol-mbp", false], ["dana-mbp", false]]);
  });
});

describe("while this machine's own Walkie Direct endpoint is not up but should be (starting, or failing to bind)", () => {
  test("a Direct-only machine reports no unreached machines: it reaches nobody, and walkie direct enable would do nothing", () => {
    const w = world("direct", false);
    // Without the daemon's word every other machine reads as unreached, the dual authority and the Tailscale-only machine included.
    expect(w.unreached().map((u) => u[0])).toEqual(["alex-mbp", "bob-mbp", "carol-mbp", "dana-mbp"]);
    w.setDirectPending(true);
    expect(w.unreached()).toEqual([]);
    const view = w.views();
    for (const host of ["alex-mbp", "bob-mbp", "carol-mbp", "dana-mbp"]) expect(view.get(host)).toMatchObject({ via: "relay" }); // still no way to reach them
    for (const n of view.values()) expect(n).not.toHaveProperty("unreached");
    expect(teamView(w.core, w.sync)?.nodes.some((n) => n.unreached !== undefined)).toBe(false);
  });

  test("a dual machine at start (record serves Direct, endpoint not bound yet) reports none; the gap that is really there is listed once it is up", () => {
    const w = world("dual", false);
    w.setDirectPending(true);
    expect(w.unreached()).toEqual([]);
    // Direct just turned on with the roster record not yet listing it: the endpoint is up, so nothing is pending, and the
    // Direct-only machines are still out of reach until the record says so (walkie direct enable retries that).
    const enabled = world("tailscale", true);
    expect(enabled.unreached()).toEqual([["carol-mbp", false], ["dana-mbp", false]]);
  });
});

describe("a Direct-only machine", () => {
  test("lists the Tailscale-only machines (the reverse gap) and shows them on a reaching machine's word", async () => {
    const w = world("direct");
    expect(w.unreached()).toEqual([["bob-mbp", false]]);
    w.answers.set(w.alex.keys.pubkey, [w.bob.keys.nodeId]);
    await w.reach(w.alex);
    expect(w.unreached()).toEqual([["bob-mbp", true]]);
    const view = w.views();
    expect(view.get("bob-mbp")).toMatchObject({ via: "relay", online: true, unreached: { vouched: true } });
    for (const host of ["alex-mbp", "carol-mbp", "dana-mbp"]) expect(view.get(host)).toMatchObject({ via: "direct" });
    expect(view.get("alex-mbp")).not.toHaveProperty("unreached");
  });
});
