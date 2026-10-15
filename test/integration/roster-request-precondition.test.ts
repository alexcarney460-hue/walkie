// WALK-109: a roster request (team.member) is signed against the chain position its owner had read (`seen_pos`).
// The authority refuses it when the target was removed, or had their role changed, at or after that position, so a
// request queued on an asleep owner machine cannot re-admit that person, or undo a demotion, when it flushes later.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../../src/protocol/canonical.ts";
import type { RosterRequest } from "../../src/protocol/schemas.ts";
import { applyRequest, flushRequests, signRequest, submitRequest } from "../../src/daemon/requests.ts";
import type { PeerClient } from "../../src/daemon/peer-client.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

type Row = { login: string; handle: string };
const NOOR: Row = { login: "noor@example.com", handle: "noor" };

describe("grant requests to an older roster authority", () => {
  let cluster: Cluster;
  let alex: TestNode;
  let olive: TestNode;
  beforeAll(async () => { ({ cluster, alex, olive } = await team([NOOR])); }, 60_000);
  afterAll(async () => { await cluster?.close(); });

  for (const [version, allowed] of [["0.2.0-pre.13", false], ["0.2.0-pre.14", true], ["0.2.0-pre.15", true], [undefined, false], ["not-a-version", false]] as const) {
    test(`role grant with authority version ${version ?? "unknown"}`, async () => {
      let sent = 0;
      const verifiedKey = `peer_caps_verified:${alex.d.core.nodeId}`;
      const wasVerified = olive.d.core.store.getMeta(verifiedKey);
      if (!version) olive.d.core.store.deleteMeta(verifiedKey);
      const client = {
        addrOf: olive.d.client.addrOf.bind(olive.d.client),
        vv: async () => ({ verified: true, capabilities: version ? { version, caps: [] } : undefined }),
        rosterRequest: async () => { sent++; return {}; },
      } as unknown as PeerClient;
      try {
        const run = submitRequest(olive.d.core, client, async () => {}, "team.member", { ...NOOR, role: "owner" });
        if (allowed) expect(await run).toEqual({ event: null });
        else if (version === undefined || version === "not-a-version") expect(await run).toMatchObject({ queued: true });
        else await expect(run).rejects.toThrow(/roster authority.*updated.*first/i);
        expect(sent).toBe(allowed ? 1 : 0);
        expect(olive.d.core.store.queuedRequests()).toHaveLength(version === undefined || version === "not-a-version" ? 1 : 0);
      } finally {
        for (const q of olive.d.core.store.queuedRequests()) olive.d.core.store.dequeueRequest(q.id);
        if (wasVerified !== null) olive.d.core.store.setMeta(verifiedKey, wasVerified);
      }
    });
  }

  test("an unverified version cannot authorize a grant", async () => {
    const verifiedKey = `peer_caps_verified:${alex.d.core.nodeId}`;
    const wasVerified = olive.d.core.store.getMeta(verifiedKey);
    olive.d.core.store.deleteMeta(verifiedKey);
    let sent = 0;
    const client = {
      addrOf: olive.d.client.addrOf.bind(olive.d.client),
      vv: async () => ({ verified: false, capabilities: { version: "0.2.0-pre.14", caps: [] } }),
      rosterRequest: async () => { sent++; return {}; },
    } as unknown as PeerClient;
    try {
      expect(await submitRequest(olive.d.core, client, async () => {}, "team.member", { ...NOOR, role: "owner" })).toMatchObject({ queued: true });
      expect(sent).toBe(0);
      expect(olive.d.core.store.queuedRequests()).toHaveLength(1);
    } finally {
      for (const q of olive.d.core.store.queuedRequests()) olive.d.core.store.dequeueRequest(q.id);
      if (wasVerified !== null) olive.d.core.store.setMeta(verifiedKey, wasVerified);
    }
  });

  test("a failed probe with no verified version queues a grant", async () => {
    const verifiedKey = `peer_caps_verified:${alex.d.core.nodeId}`;
    const wasVerified = olive.d.core.store.getMeta(verifiedKey);
    olive.d.core.store.deleteMeta(verifiedKey);
    let sent = 0;
    const client = {
      addrOf: olive.d.client.addrOf.bind(olive.d.client),
      vv: async () => { throw new Error("probe failed"); },
      rosterRequest: async () => { sent++; return {}; },
    } as unknown as PeerClient;
    try {
      expect(await submitRequest(olive.d.core, client, async () => {}, "team.member", { ...NOOR, role: "owner" })).toMatchObject({ queued: true });
      expect(sent).toBe(0);
      expect(olive.d.core.store.queuedRequests()).toHaveLength(1);
    } finally {
      for (const q of olive.d.core.store.queuedRequests()) olive.d.core.store.dequeueRequest(q.id);
      if (wasVerified !== null) olive.d.core.store.setMeta(verifiedKey, wasVerified);
    }
  });

  test("unknown version queues restricted-channel and opening grants, but sends removals", async () => {
    const verifiedKey = `peer_caps_verified:${alex.d.core.nodeId}`;
    const wasVerified = olive.d.core.store.getMeta(verifiedKey);
    olive.d.core.store.deleteMeta(verifiedKey);
    const sent: string[] = [];
    const client = {
      addrOf: olive.d.client.addrOf.bind(olive.d.client),
      vv: async () => ({ verified: true }),
      rosterRequest: async (_addr: unknown, req: { kind: string }) => { sent.push(req.kind); return {}; },
    } as unknown as PeerClient;
    try {
      for (const body of [{ name: "private", members: ["alex", "noor"] }, { name: "private", public: true }]) {
        expect(await submitRequest(olive.d.core, client, async () => {}, "channel.upsert", body)).toMatchObject({ queued: true });
      }
      expect(await submitRequest(olive.d.core, client, async () => {}, "team.member", { ...NOOR, role: "removed" })).toEqual({ event: null });
      expect(await submitRequest(olive.d.core, client, async () => {}, "channel.upsert", { name: "private", members: [] })).toEqual({ event: null });
      expect(sent).toEqual(["team.member", "channel.upsert"]);
      expect(olive.d.core.store.queuedRequests()).toHaveLength(2);
    } finally {
      for (const q of olive.d.core.store.queuedRequests()) olive.d.core.store.dequeueRequest(q.id);
      if (wasVerified !== null) olive.d.core.store.setMeta(verifiedKey, wasVerified);
    }
  });

  test("unknown version queues a grant without a transport", async () => {
    const verifiedKey = `peer_caps_verified:${alex.d.core.nodeId}`;
    const wasVerified = olive.d.core.store.getMeta(verifiedKey);
    olive.d.core.store.deleteMeta(verifiedKey);
    const client = { addrOf: () => null } as unknown as PeerClient;
    try {
      expect(await submitRequest(olive.d.core, client, async () => {}, "team.member", { ...NOOR, role: "owner" })).toMatchObject({ queued: true });
      expect(olive.d.core.store.queuedRequests()).toHaveLength(1);
    } finally {
      for (const q of olive.d.core.store.queuedRequests()) olive.d.core.store.dequeueRequest(q.id);
      if (wasVerified !== null) olive.d.core.store.setMeta(verifiedKey, wasVerified);
    }
  });

  test("the local authority applies a grant without a version probe", async () => {
    const own = await team([NOOR]);
    try {
      const client = { vv: async () => { throw new Error("unexpected probe"); } } as unknown as PeerClient;
      const result = await submitRequest(own.alex.d.core, client, async () => {}, "team.member", { ...NOOR, role: "owner" });
      expect(result).toHaveProperty("event");
      expect(own.alex.d.core.roster.members.get(NOOR.login)?.role).toBe("owner");
    } finally { await own.cluster.close(); }
  });

  test("a queued grant is checked again when a later probe learns the authority is old", async () => {
    const id = alex.d.core.nodeId;
    const verifiedKey = `peer_caps_verified:${id}`;
    const capsKey = `peer_capabilities:${id}`;
    const wasVerified = olive.d.core.store.getMeta(verifiedKey);
    const wasCaps = olive.d.core.store.getMeta(capsKey);
    olive.d.core.store.setMeta(verifiedKey, "1");
    olive.d.core.store.setMeta(capsKey, JSON.stringify({ version: "0.2.0-pre.14", caps: [] }));
    let reachable = false;
    let version = "0.2.0-pre.13";
    let sent = 0;
    const client = {
      addrOf: (node: Parameters<PeerClient["addrOf"]>[0]) => reachable ? olive.d.client.addrOf(node) : null,
      vv: async () => ({ verified: true, capabilities: { version, caps: [] } }),
      rosterRequest: async () => { sent++; return {}; },
    } as unknown as PeerClient;
    try {
      const req = signRequest(olive.d.core, "team.member", { ...NOOR, role: "owner" });
      olive.d.core.store.queueRequest(req.id, JSON.stringify(req));
      expect(olive.d.core.store.queuedRequests()).toHaveLength(1);
      reachable = true;
      await flushRequests(olive.d.core, client, async () => {});
      expect(sent).toBe(0);
      expect(olive.d.core.store.queuedRequests()).toHaveLength(1);
      version = "0.2.0-pre.14";
      await flushRequests(olive.d.core, client, async () => {});
      expect(sent).toBe(1);
      expect(olive.d.core.store.queuedRequests()).toEqual([]);
    } finally {
      for (const q of olive.d.core.store.queuedRequests()) olive.d.core.store.dequeueRequest(q.id);
      if (wasVerified === null) olive.d.core.store.deleteMeta(verifiedKey);
      else olive.d.core.store.setMeta(verifiedKey, wasVerified);
      if (wasCaps === null) olive.d.core.store.deleteMeta(capsKey);
      else olive.d.core.store.setMeta(capsKey, wasCaps);
    }
  });

  test("a queued grant is refused while the version is unknown, then a new grant can use a confirmed version", async () => {
    const verifiedKey = `peer_caps_verified:${alex.d.core.nodeId}`;
    const wasVerified = olive.d.core.store.getMeta(verifiedKey);
    olive.d.core.store.deleteMeta(verifiedKey);
    const req = signRequest(olive.d.core, "team.member", { ...NOOR, role: "owner" });
    olive.d.core.store.queueRequest(req.id, JSON.stringify(req));
    let version: string | undefined;
    let sent = 0;
    const client = {
      addrOf: olive.d.client.addrOf.bind(olive.d.client),
      vv: async () => ({ verified: true, capabilities: version ? { version, caps: [] } : undefined }),
      rosterRequest: async () => { sent++; return {}; },
    } as unknown as PeerClient;
    try {
      await flushRequests(olive.d.core, client, async () => {});
      expect(sent).toBe(0);
      expect(olive.d.core.store.queuedRequests()).toHaveLength(1);
      expect(olive.d.core.store.queuedRequests()[0]!.last_error).toMatch(/could not be confirmed/);
      version = "0.2.0-pre.14";
      await flushRequests(olive.d.core, client, async () => {});
      expect(sent).toBe(1);
      expect(olive.d.core.store.queuedRequests()).toEqual([]);
      expect(await submitRequest(olive.d.core, client, async () => {}, "team.member", { ...NOOR, role: "owner" })).toEqual({ event: null });
      expect(sent).toBe(2);
    } finally {
      olive.d.core.store.dequeueRequest(req.id);
      if (wasVerified !== null) olive.d.core.store.setMeta(verifiedKey, wasVerified);
    }
  });

  test("old authority still accepts removal and an empty access list", async () => {
    const sent: string[] = [];
    const client = {
      addrOf: olive.d.client.addrOf.bind(olive.d.client),
      vv: async () => ({ verified: true, capabilities: { version: "0.2.0-pre.13", caps: [] } }),
      rosterRequest: async (_addr: unknown, req: { kind: string }) => { sent.push(req.kind); return {}; },
    } as unknown as PeerClient;
    for (const [kind, body] of [
      ["team.member", { ...NOOR, role: "removed" }],
      ["channel.upsert", { name: "general", members: [] }],
    ] as const) expect(await submitRequest(olive.d.core, client, async () => {}, kind, body)).toEqual({ event: null });
    expect(sent).toEqual(["team.member", "channel.upsert"]);
  });

  test("a restricted-channel membership grant is refused before reaching an old authority", async () => {
    let sent = 0;
    const client = {
      addrOf: olive.d.client.addrOf.bind(olive.d.client),
      vv: async () => ({ verified: true, capabilities: { version: "0.2.0-pre.13", caps: [] } }),
      rosterRequest: async () => { sent++; return {}; },
    } as unknown as PeerClient;
    await expect(submitRequest(olive.d.core, client, async () => {}, "channel.upsert", { name: "private", members: ["alex", "noor"] }))
      .rejects.toThrow(/roster authority.*updated.*first/i);
    expect(sent).toBe(0);
    expect(olive.d.core.store.queuedRequests()).toEqual([]);
  });

  test("same-role and same-list requests cannot restore access through an old authority", async () => {
    let sent = 0;
    const client = {
      addrOf: olive.d.client.addrOf.bind(olive.d.client),
      vv: async () => ({ verified: true, capabilities: { version: "0.2.0-pre.13", caps: [] } }),
      rosterRequest: async () => { sent++; return {}; },
    } as unknown as PeerClient;
    await expect(submitRequest(olive.d.core, client, async () => {}, "team.member", { ...NOOR, role: "member" }))
      .rejects.toThrow(/updated.*first/i);
    alex.d.core.emit("channel.upsert", { name: "private", members: ["alex", "noor"] } as never);
    await waitFor(() => olive.d.core.roster.channels.get("private")?.members?.length === 2, { what: "private channel synced" });
    await expect(submitRequest(olive.d.core, client, async () => {}, "channel.upsert", { name: "private", members: ["alex", "noor"] }))
      .rejects.toThrow(/updated.*first/i);
    expect(sent).toBe(0);
  });
});

describe("stale roster against an older authority", () => {
  test("a locally demoting role request cannot restore access on the authority", async () => {
    const { cluster, alex, olive } = await team([NOOR]);
    try {
      alex.d.sync.stop();
      olive.d.sync.stop();
      setRole(alex, NOOR, "owner");
      await olive.d.sync.requestCatchUp(olive.d.client.addrOf(olive.d.core.roster.nodes.get(alex.d.core.nodeId)!)!, alex.d.core.nodeId, alex.d.core.store.vvOf(alex.d.core.nodeId));
      setRole(alex, NOOR, "observer");
      expect(olive.d.core.roster.members.get(NOOR.login)?.role).toBe("owner");
      expect(alex.d.core.roster.members.get(NOOR.login)?.role).toBe("observer");
      let sent = 0;
      const client = { addrOf: olive.d.client.addrOf.bind(olive.d.client), vv: async () => ({ verified: true, capabilities: { version: "0.2.0-pre.13", caps: [] } }), rosterRequest: async () => { sent++; return {}; } } as unknown as PeerClient;
      await expect(submitRequest(olive.d.core, client, async () => {}, "team.member", { ...NOOR, role: "member" })).rejects.toThrow(/updated.*first/i);
      expect(sent).toBe(0);
    } finally { await cluster.close(); }
  });

  test("a locally narrowing channel list cannot restore access on the authority", async () => {
    const { cluster, alex, olive } = await team([NOOR]);
    try {
      alex.d.sync.stop();
      olive.d.sync.stop();
      alex.d.core.emit("channel.upsert", { name: "private", members: ["alex", "olive", "noor"] } as never);
      await olive.d.sync.requestCatchUp(olive.d.client.addrOf(olive.d.core.roster.nodes.get(alex.d.core.nodeId)!)!, alex.d.core.nodeId, alex.d.core.store.vvOf(alex.d.core.nodeId));
      alex.d.core.emit("channel.upsert", { name: "private", members: ["olive"] } as never);
      expect(olive.d.core.roster.channels.get("private")?.members).toEqual(["alex", "olive", "noor"]);
      expect(alex.d.core.roster.channels.get("private")?.members).toEqual(["olive"]);
      let sent = 0;
      const client = { addrOf: olive.d.client.addrOf.bind(olive.d.client), vv: async () => ({ verified: true, capabilities: { version: "0.2.0-pre.13", caps: [] } }), rosterRequest: async () => { sent++; return {}; } } as unknown as PeerClient;
      await expect(submitRequest(olive.d.core, client, async () => {}, "channel.upsert", { name: "private", members: ["alex", "olive"] })).rejects.toThrow(/updated.*first/i);
      expect(sent).toBe(0);
    } finally { await cluster.close(); }
  });
});

function removed(node: TestNode, who: Row): void {
  node.d.core.emit("team.member", { login: who.login, handle: who.handle, role: "removed" });
}

function setRole(node: TestNode, who: Row, role: string): void {
  node.d.core.emit("team.member", { login: who.login, handle: who.handle, role } as never);
}

/** The chain position of this handle's newest `team.member` entry (the roster's entry index). */
function newestEntry(node: TestNode, handle: string): number {
  let at = -1;
  node.d.core.rosterEntries().forEach((e, i) => {
    if (e.kind === "team.member" && (e.body as { handle?: string }).handle === handle) at = i;
  });
  return at;
}

/** A request this owner signed claiming it read the chain up to `seen` (a position, not the owner's real one). */
function requestSeeing(owner: TestNode, who: Row, role: string, seen: number): RosterRequest {
  const signed = signRequest(owner.d.core, "team.member", { login: who.login, handle: who.handle, role });
  const unsigned = { id: signed.id, kind: signed.kind, body: { ...signed.body, seen_pos: seen }, node: signed.node, ts: signed.ts };
  const sig = owner.d.core.keys.sign(canonicalJson({ team: owner.d.core.teamId ?? "", ...unsigned }));
  return { ...unsigned, sig };
}

/** The roster-request log lines this node writes from now on. */
function watchRosterLog(node: TestNode): { event: string; id?: string; err?: string; kind?: string; subject?: string }[] {
  const seen: { event: string; id?: string; err?: string; kind?: string; subject?: string }[] = [];
  const queued = new Map<string, RosterRequest>();
  const remember = (id: string) => {
    const row = node.d.core.store.queuedRequest(id);
    if (row) queued.set(id, JSON.parse(row.json) as RosterRequest);
  };
  for (const row of node.d.core.store.queuedRequests()) remember(row.id);
  const log = node.d.core.log as unknown as Record<string, (event: string, fields?: { id?: string; err?: string }) => void>;
  for (const level of ["info", "warn"]) {
    const original = log[level]?.bind(log);
    log[level] = (event, fields) => {
      if (event === "roster_request_queued" && fields?.id) remember(fields.id);
      if (event.startsWith("roster_request")) {
        const req = fields?.id ? queued.get(fields.id) : undefined;
        seen.push({ event, id: fields?.id, err: fields?.err, kind: req?.kind,
          subject: req?.kind === "channel.upsert" ? String(req.body.name) : undefined });
      }
      original?.(event, fields);
    };
  }
  return seen;
}

function expectRoleRefusal(log: ReturnType<typeof watchRosterLog>, roleId: string): void {
  const refused = log.filter((l) => l.event === "roster_request_refused");
  const role = refused.filter((l) => l.id === roleId);
  expect(role).toHaveLength(1);
  expect(role[0]?.err).toMatch(/stale_request.*@noor/);
  // A sync round can also refuse its own stale #talkie-schedules repair; account for that row by ID and subject.
  const schedule = refused.filter((l) => l.id !== roleId);
  expect(schedule.length).toBeLessThanOrEqual(1);
  expect(schedule.every((l) =>
    l.kind === "channel.upsert" && l.subject === "talkie-schedules" && /stale_request/.test(l.err ?? ""))).toBe(true);
}

/** Roles the chain gave this handle, oldest first. */
function roles(node: TestNode, handle: string): string[] {
  return node.d.core.rosterEntries()
    .filter((e) => e.kind === "team.member" && (e.body as { handle?: string }).handle === handle)
    .map((e) => (e.body as { role: string }).role);
}

/** The `team.member` requests this node still has queued (its other queued rows, such as a channel request, are not these). */
function memberRows(node: TestNode): { id: string; body: Record<string, unknown> }[] {
  return node.d.core.store.queuedRequests()
    .map((q) => ({ id: q.id, ...(JSON.parse(q.json) as { kind: string; body: Record<string, unknown> }) }))
    .filter((r) => r.kind === "team.member");
}

/** The request as a pre-WALK-109 owner machine signed it: same signed part, no `seen_pos`. */
function legacyRequest(owner: TestNode, who: Row, role: string): RosterRequest {
  const signed = signRequest(owner.d.core, "team.member", { login: who.login, handle: who.handle, role });
  const { seen_pos: _seen, ...body } = signed.body;
  const unsigned = { id: signed.id, kind: signed.kind, body, node: signed.node, ts: signed.ts };
  const sig = owner.d.core.keys.sign(canonicalJson({ team: owner.d.core.teamId ?? "", id: unsigned.id, kind: unsigned.kind, body: unsigned.body, node: unsigned.node, ts: unsigned.ts }));
  return { ...unsigned, sig };
}

async function team(members: Row[]): Promise<{ cluster: Cluster; alex: TestNode; olive: TestNode }> {
  const cluster = new Cluster();
  const alex = await cluster.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  const olive = await cluster.add({ name: "olive", login: "olive@example.com", hostname: "olive-mbp" });
  await alex.client().init("acme", "alex");
  await alex.client().invite("olive@example.com", "olive", "owner");
  for (const m of members) await alex.client().invite(m.login, m.handle, "member");
  expect((await olive.client().join(alex.peerAddr)).admitted).toBe(true);
  await waitFor(() => olive.d.core.me()?.role === "owner" && members.every((m) => olive.d.core.roster.members.get(m.login)?.role === "member"), { what: "olive synced" });
  return { cluster, alex, olive };
}

describe("a queued role request that was signed before a removal", () => {
  let cluster: Cluster;
  let alex: TestNode;
  let olive: TestNode;

  beforeAll(async () => { ({ cluster, alex, olive } = await team([NOOR])); }, 60_000);
  afterAll(async () => { await cluster?.close(); });

  test("does not re-admit the removed member when it flushes, and is dropped as refused", async () => {
    await alex.stop();
    const req = signRequest(olive.d.core, "team.member", { ...NOOR, role: "observer" });
    olive.d.core.store.queueRequest(req.id, JSON.stringify(req));
    const rows = memberRows(olive);
    expect(rows.length).toBe(1);
    // The request carries the chain position its owner had read when it was signed.
    expect(rows[0]?.body.seen_pos).toBe(olive.d.core.roster.pos);
    olive.d.sync.stop();
    await alex.start();
    alex.d.sync.stop();
    // Another owner removes noor while olive's laptop is asleep; olive has not read that removal.
    removed(alex, NOOR);
    expect(olive.d.core.roster.members.get(NOOR.login)?.role).toBe("member");
    await flushRequests(olive.d.core, olive.d.client, olive.d.sync.requestCatchUp);
    expect(memberRows(olive)).toEqual([]);
    expect(alex.d.core.roster.members.get(NOOR.login)?.role).toBe("removed");
    expect(roles(alex, "noor")).toEqual(["member", "removed"]);
  }, 60_000);
});

describe("the authority's precondition on a team.member request", () => {
  let cluster: Cluster;
  let alex: TestNode;
  let olive: TestNode;
  const people = ["cora", "dana", "eli", "fay", "gina", "hana", "ivan", "jules", "kai"].map((handle): Row => ({ login: `${handle}@example.com`, handle }));
  const who = (handle: string): Row => people.find((p) => p.handle === handle) as Row;

  beforeAll(async () => { ({ cluster, alex, olive } = await team(people)); }, 60_000);
  afterAll(async () => { await cluster?.close(); });

  test("a member removed and re-invited after the request was signed is not touched by it", () => {
    const cora = who("cora");
    const req = signRequest(olive.d.core, "team.member", { login: cora.login, handle: cora.handle, role: "owner" });
    removed(alex, cora);
    alex.d.core.emit("team.member", { login: cora.login, handle: cora.handle, role: "member" });
    expect(() => applyRequest(alex.d.core, req)).toThrow(/stale_request/);
    expect(alex.d.core.roster.members.get(cora.login)?.role).toBe("member");
    expect(roles(alex, "cora")).toEqual(["member", "removed", "member"]);
  });

  test("a request signed after the removal was read can still re-admit on purpose", async () => {
    const eli = who("eli");
    removed(alex, eli);
    await waitFor(() => olive.d.core.roster.members.get(eli.login)?.role === "removed", { what: "olive reads the removal" });
    const res = await olive.client().request<{ event?: { body?: { role?: string } } }>("POST", "/v1/team/member", { handle: "eli", role: "observer" });
    expect(res.event?.body?.role).toBe("observer");
    expect(alex.d.core.roster.members.get(eli.login)?.role).toBe("observer");
  });

  test("a removal is never refused as stale", () => {
    const fay = who("fay");
    const req = signRequest(olive.d.core, "team.member", { login: fay.login, handle: fay.handle, role: "removed" });
    removed(alex, fay);
    alex.d.core.emit("team.member", { login: fay.login, handle: fay.handle, role: "member" });
    const ev = applyRequest(alex.d.core, req);
    expect(ev).not.toBeNull();
    expect(alex.d.core.roster.members.get(fay.login)?.role).toBe("removed");
  });

  test("a request without a position is refused for someone removed, and applied for someone who is not", () => {
    const gina = who("gina");
    const hana = who("hana");
    removed(alex, gina);
    expect(() => applyRequest(alex.d.core, legacyRequest(olive, gina, "observer"))).toThrow(/stale_request/);
    expect(alex.d.core.roster.members.get(gina.login)?.role).toBe("removed");
    const ev = applyRequest(alex.d.core, legacyRequest(olive, hana, "observer"));
    expect(ev).not.toBeNull();
    expect(alex.d.core.roster.members.get(hana.login)?.role).toBe("observer");
  });

  test("a positionless grant stays refused after reinvitation or promotion", () => {
    const gina = who("gina");
    const hana = who("hana");
    alex.d.core.emit("team.member", { login: gina.login, handle: gina.handle, role: "member" });
    alex.d.core.emit("team.member", { login: hana.login, handle: hana.handle, role: "member" });
    expect(() => applyRequest(alex.d.core, legacyRequest(olive, gina, "owner"))).toThrow(/Update Sqwakie/);
    expect(() => applyRequest(alex.d.core, legacyRequest(olive, hana, "owner"))).toThrow(/Update Sqwakie/);
    expect(alex.d.core.roster.members.get(gina.login)?.role).toBe("member");
    expect(alex.d.core.roster.members.get(hana.login)?.role).toBe("member");
  });

  test("a future signed position is refused for a role grant", () => {
    const ivan = who("ivan");
    const signed = signRequest(olive.d.core, "team.member", { login: ivan.login, handle: ivan.handle, role: "owner" });
    const body = { ...signed.body, seen_pos: alex.d.core.roster.pos! + 1 };
    const unsigned = { id: signed.id, kind: signed.kind, body, node: signed.node, ts: signed.ts };
    const sig = olive.d.core.keys.sign(canonicalJson({ team: olive.d.core.teamId ?? "", ...unsigned }));
    expect(() => applyRequest(alex.d.core, { ...unsigned, sig })).toThrow(/bad_precondition/);
  });

  test("a position that is not a non-negative integer is refused", () => {
    const ivan = who("ivan");
    for (const bad of ["5", -1, 1.5, null, true]) {
      const signed = signRequest(olive.d.core, "team.member", { login: ivan.login, handle: ivan.handle, role: "observer" });
      const body = { ...signed.body, seen_pos: bad };
      const unsigned = { id: signed.id, kind: signed.kind, body, node: signed.node, ts: signed.ts };
      const sig = olive.d.core.keys.sign(canonicalJson({ team: olive.d.core.teamId ?? "", ...unsigned }));
      expect(() => applyRequest(alex.d.core, { ...unsigned, sig })).toThrow(/bad_precondition/);
    }
    expect(alex.d.core.roster.members.get(ivan.login)?.role).toBe("member");
  });

  test("the position is not written to the chain, and a request already applied is not refused on replay", () => {
    const jules = who("jules");
    const req = signRequest(olive.d.core, "team.member", { login: jules.login, handle: jules.handle, role: "observer" });
    const first = applyRequest(alex.d.core, req);
    expect(first).not.toBeNull();
    expect(Object.keys(first?.body ?? {})).not.toContain("seen_pos");
    removed(alex, jules);
    const length = alex.d.core.rosterEntries().length;
    const again = applyRequest(alex.d.core, req);
    expect(again?.id).toBe(first?.id);
    expect(alex.d.core.rosterEntries().length).toBe(length);
    expect(alex.d.core.roster.members.get(jules.login)?.role).toBe("removed");
  });

  test("a follower owner's ordinary invite and role change are applied", async () => {
    const invited = await olive.client().invite("lena@example.com", "lena", "member");
    expect(invited.event?.body).toMatchObject({ login: "lena@example.com", role: "member", requested_by: "olive" });
    const changed = await olive.client().setRole("lena", "observer");
    expect(changed.event.body).toMatchObject({ role: "observer", requested_by: "olive" });
    expect(alex.d.core.roster.members.get("lena@example.com")?.role).toBe("observer");
    expect(roles(alex, "lena")).toEqual(["member", "observer"]);
  });

  test("a request for someone who was never removed is applied", () => {
    const kai = who("kai");
    const ev = applyRequest(alex.d.core, signRequest(olive.d.core, "team.member", { login: kai.login, handle: kai.handle, role: "observer" }));
    expect(ev).not.toBeNull();
    expect(alex.d.core.roster.members.get(kai.login)?.role).toBe("observer");
  });
});

describe("the authority's precondition covers every later change to the target, not only a removal", () => {
  let cluster: Cluster;
  let alex: TestNode;
  let olive: TestNode;
  const people = ["ada", "bo", "cyd", "dax", "edna", "finn", "gwen", "hugo", "ines"].map((handle): Row => ({ login: `${handle}@example.com`, handle }));
  const who = (handle: string): Row => people.find((p) => p.handle === handle) as Row;
  const roleOf = (handle: string): string | undefined => alex.d.core.roster.members.get(who(handle).login)?.role;

  beforeAll(async () => { ({ cluster, alex, olive } = await team(people)); }, 60_000);
  afterAll(async () => { await cluster?.close(); });

  test("a demotion after the request was signed refuses it, and the person stays demoted", () => {
    const ada = who("ada");
    const req = signRequest(olive.d.core, "team.member", { login: ada.login, handle: ada.handle, role: "owner" });
    setRole(alex, ada, "observer");
    const length = alex.d.core.rosterEntries().length;
    expect(() => applyRequest(alex.d.core, req)).toThrow(/stale_request/);
    expect(roleOf("ada")).toBe("observer");
    expect(roles(alex, "ada")).toEqual(["member", "observer"]);
    expect(alex.d.core.rosterEntries().length).toBe(length);
  });

  test("a membership entry records its own chain position, the same one on every replica", async () => {
    const bo = who("bo");
    setRole(alex, bo, "observer");
    const at = newestEntry(alex, "bo");
    expect(at).toBe(alex.d.core.rosterEntries().length - 1);
    expect(alex.d.core.roster.members.get(bo.login)?.changed_pos).toBe(at);
    await waitFor(() => olive.d.core.roster.members.get(bo.login)?.role === "observer", { what: "olive reads the demotion" });
    expect(olive.d.core.roster.members.get(bo.login)?.changed_pos).toBe(at);
  });

  test("a request that has read exactly up to the change is refused; one that has read past it is applied", () => {
    const bo = who("bo");
    const at = alex.d.core.roster.members.get(bo.login)?.changed_pos as number;
    expect(() => applyRequest(alex.d.core, requestSeeing(olive, bo, "owner", at))).toThrow(/stale_request/);
    expect(roleOf("bo")).toBe("observer");
    const ev = applyRequest(alex.d.core, requestSeeing(olive, bo, "owner", at + 1));
    expect(ev).not.toBeNull();
    expect(roleOf("bo")).toBe("owner");
  });

  test("the same boundary holds for a removal: read up to it is refused, read past it re-admits", () => {
    const cyd = who("cyd");
    removed(alex, cyd);
    const at = alex.d.core.roster.members.get(cyd.login)?.removed_pos as number;
    expect(at).toBe(newestEntry(alex, "cyd"));
    expect(alex.d.core.roster.members.get(cyd.login)?.changed_pos).toBe(at);
    expect(() => applyRequest(alex.d.core, requestSeeing(olive, cyd, "observer", at))).toThrow(/stale_request/);
    expect(roleOf("cyd")).toBe("removed");
    const ev = applyRequest(alex.d.core, requestSeeing(olive, cyd, "observer", at + 1));
    expect(ev).not.toBeNull();
    expect(roleOf("cyd")).toBe("observer");
  });

  test("removed, re-added, with the request signed in between: refused; one signed after the re-add is read applies", async () => {
    const dax = who("dax");
    removed(alex, dax);
    await waitFor(() => olive.d.core.roster.members.get(dax.login)?.role === "removed", { what: "olive reads the removal" });
    // Signed after the removal was read, before the re-invite: the removal is behind it, the re-invite is not.
    const between = signRequest(olive.d.core, "team.member", { login: dax.login, handle: dax.handle, role: "owner" });
    setRole(alex, dax, "member");
    expect(() => applyRequest(alex.d.core, between)).toThrow(/stale_request/);
    expect(roleOf("dax")).toBe("member");
    expect(roles(alex, "dax")).toEqual(["member", "removed", "member"]);
    await waitFor(() => olive.d.core.roster.members.get(dax.login)?.role === "member", { what: "olive reads the re-invite" });
    const ok = await olive.client().setRole("dax", "observer");
    expect(ok.event.body).toMatchObject({ role: "observer", requested_by: "olive" });
    expect(roles(alex, "dax")).toEqual(["member", "removed", "member", "observer"]);
  });

  test("a removal request is applied after a later role change, not refused", () => {
    const edna = who("edna");
    const req = signRequest(olive.d.core, "team.member", { login: edna.login, handle: edna.handle, role: "removed" });
    setRole(alex, edna, "observer");
    const ev = applyRequest(alex.d.core, req);
    expect(ev).not.toBeNull();
    expect(roleOf("edna")).toBe("removed");
    expect(roles(alex, "edna")).toEqual(["member", "observer", "removed"]);
  });

  test("the same request sent again after it was applied returns its own entry and appends nothing", () => {
    const finn = who("finn");
    const req = signRequest(olive.d.core, "team.member", { login: finn.login, handle: finn.handle, role: "observer" });
    const first = applyRequest(alex.d.core, req);
    expect(first).not.toBeNull();
    // Its own entry is now the newest change to finn, at or past the position the request carries.
    expect(alex.d.core.roster.members.get(finn.login)?.changed_pos as number).toBeGreaterThanOrEqual(req.body.seen_pos as number);
    const length = alex.d.core.rosterEntries().length;
    const again = applyRequest(alex.d.core, req);
    expect(again?.id).toBe(first?.id);
    expect(alex.d.core.rosterEntries().length).toBe(length);
    expect(roles(alex, "finn")).toEqual(["member", "observer"]);
  });

  test("a request with no position refuses a target whose role changed", () => {
    const gwen = who("gwen");
    setRole(alex, gwen, "observer");
    expect(() => applyRequest(alex.d.core, legacyRequest(olive, gwen, "owner"))).toThrow(/Update Sqwakie/);
    expect(roleOf("gwen")).toBe("observer");
  });

  test("a request naming someone with no membership entry yet applies, even from a roster at position 0", () => {
    const newcomer: Row = { login: "ravi@example.com", handle: "ravi" };
    const ev = applyRequest(alex.d.core, requestSeeing(olive, newcomer, "member", 0));
    expect(ev).not.toBeNull();
    expect(alex.d.core.roster.members.get(newcomer.login)?.role).toBe("member");
  });

  test("a stale refusal tells a machine that has not caught up to try again after it syncs; a request with no position is told to update Sqwakie", () => {
    const hugo = who("hugo");
    const ines = who("ines");
    const lagging = signRequest(olive.d.core, "team.member", { login: ines.login, handle: ines.handle, role: "owner" });
    setRole(alex, ines, "observer");
    let message = "";
    try { applyRequest(alex.d.core, lagging); } catch (err) { message = (err as Error).message; }
    expect(message).toContain("stale_request");
    expect(message).toContain("has not caught up yet");
    expect(message).toContain("try again after that machine syncs");
    expect(message).not.toContain("Update Sqwakie");
    removed(alex, hugo);
    let legacy = "";
    try { applyRequest(alex.d.core, legacyRequest(olive, hugo, "observer")); } catch (err) { legacy = (err as Error).message; }
    expect(legacy).toContain("stale_request");
    expect(legacy).toContain("Update Sqwakie on the requesting machine");
    expect(legacy).not.toContain("has not caught up yet");
    expect(roleOf("hugo")).toBe("removed");
  });
});

describe("a queued request and a live request, through the real sync loop", () => {
  let open: Cluster | null = null;
  afterEach(async () => { await open?.close(); open = null; });

  /** olive's laptop queues `role` for noor while alex (the authority) is away, then sleeps. Returns with alex back and both syncs stopped. */
  async function queueThenSleep(role: string): Promise<{ alex: TestNode; olive: TestNode }> {
    const t = await team([NOOR]);
    open = t.cluster;
    await waitFor(() => t.olive.d.core.store.queuedRequests().length === 0, { what: "join setup requests settled", timeoutMs: 20_000 });
    await t.alex.stop();
    const req = signRequest(t.olive.d.core, "team.member", { ...NOOR, role });
    t.olive.d.core.store.queueRequest(req.id, JSON.stringify(req));
    t.olive.d.sync.stop();
    await t.alex.start();
    t.alex.d.sync.stop();
    // Restart can queue the unrelated talkie-schedules setup request while alex is offline.
    // Keep this fixture focused on the one role request whose refusal count it checks.
    for (const q of t.olive.d.core.store.queuedRequests()) {
      const req = JSON.parse(q.json) as RosterRequest;
      if (req.kind === "channel.upsert" && req.body.name === "talkie-schedules") t.olive.d.core.store.dequeueRequest(q.id);
    }
    expect(memberRows(t.olive)).toHaveLength(1);
    expect(t.olive.d.core.store.queuedRequests()).toHaveLength(1);
    return t;
  }

  test("a queued owner-grant is refused after another owner lowered the person to observer, dropped once, and logged", async () => {
    const { alex, olive } = await queueThenSleep("owner");
    const roleId = memberRows(olive)[0]!.id;
    setRole(alex, NOOR, "observer");
    const log = watchRosterLog(olive);
    alex.d.sync.start();
    olive.d.sync.start();
    await waitFor(() => memberRows(olive).length === 0 && olive.d.core.roster.pos === alex.d.core.roster.pos, { what: "queue drained and olive level with the authority", timeoutMs: 20_000 });
    const length = alex.d.core.rosterEntries().length;
    await Bun.sleep(2_500); // more sync rounds: a dropped row is not retried
    expect(alex.d.core.rosterEntries().length).toBe(length);
    expect(roles(alex, "noor")).toEqual(["member", "observer"]);
    expect(alex.d.core.roster.members.get(NOOR.login)?.role).toBe("observer");
    expect(olive.d.core.roster.members.get(NOOR.login)?.role).toBe("observer");
    expectRoleRefusal(log, roleId);
    expect(log.filter((l) => l.event === "roster_request_applied")).toEqual([]);
  }, 60_000);

  test("an offboard that stopped after the suspend leaves the person at observer; the older queued owner-grant is refused and a re-run finishes the removal", async () => {
    const { alex, olive } = await queueThenSleep("owner");
    const roleId = memberRows(olive)[0]!.id;
    setRole(alex, NOOR, "observer"); // offboard's suspend step landed; the machine that ran it stopped before the removal
    const log = watchRosterLog(olive);
    alex.d.sync.start();
    olive.d.sync.start();
    await waitFor(() => memberRows(olive).length === 0 && olive.d.core.roster.pos === alex.d.core.roster.pos, { what: "queue drained and olive level with the authority", timeoutMs: 20_000 });
    expect(roles(alex, "noor")).toEqual(["member", "observer"]);
    expectRoleRefusal(log, roleId);
    expect(log.filter((l) => l.event === "roster_request_applied")).toEqual([]);
    const applied = await alex.client().request<{ role: string; steps: { step: string; status: string }[] }>("POST", "/v1/team/offboard", { handle: "noor" }, 30_000);
    expect(applied.role).toBe("removed");
    expect(roles(alex, "noor")).toEqual(["member", "observer", "removed"]);
  }, 60_000);

  test("an authority transfer between the change and the flush does not lift the refusal", async () => {
    const { alex, olive } = await queueThenSleep("owner");
    setRole(alex, NOOR, "observer");
    const changedAt = alex.d.core.roster.members.get(NOOR.login)?.changed_pos;
    expect(changedAt).toBe(newestEntry(alex, "noor"));
    alex.d.core.emit("team.authority", { node_id: olive.d.core.nodeId } as never);
    // olive reads the transfer and the demotion from alex's origin, so it is the authority before it flushes its own row.
    const alexNode = olive.d.core.roster.nodes.get(alex.d.core.nodeId);
    const alexAddr = alexNode ? olive.d.client.addrOf(alexNode) : null;
    expect(alexAddr).not.toBeNull();
    await olive.d.sync.requestCatchUp(alexAddr as NonNullable<typeof alexAddr>, alex.d.core.nodeId, alex.d.core.store.vvOf(alex.d.core.nodeId));
    expect(olive.d.core.isAuthority()).toBe(true);
    expect(olive.d.core.roster.members.get(NOOR.login)?.changed_pos).toBe(changedAt);
    // Catch-up can queue a stale schedule-channel repair; this fixture flushes only the signed role request.
    for (const q of olive.d.core.store.queuedRequests()) {
      const req = JSON.parse(q.json) as RosterRequest;
      if (req.kind === "channel.upsert" && req.body.name === "talkie-schedules") olive.d.core.store.dequeueRequest(q.id);
    }
    expect(olive.d.core.store.queuedRequests()).toHaveLength(1);
    const log = watchRosterLog(olive);
    await flushRequests(olive.d.core, olive.d.client, olive.d.sync.requestCatchUp);
    expect(memberRows(olive)).toEqual([]);
    expect(roles(olive, "noor")).toEqual(["member", "observer"]);
    const refused = log.filter((l) => l.event === "roster_request_refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.err).toMatch(/stale_request/);
    expect(log.filter((l) => l.event === "roster_request_applied")).toEqual([]);
  }, 60_000);

  test("a live request from a machine that has not read a demotion gets 409 saying to wait for sync, and applies after it syncs", async () => {
    const t = await team([NOOR]);
    open = t.cluster;
    const { alex, olive } = t;
    alex.d.sync.stop();
    olive.d.sync.stop();
    await Bun.sleep(1_200); // let a sync round that was already running finish
    setRole(alex, NOOR, "observer");
    expect(olive.d.core.roster.members.get(NOOR.login)?.role).toBe("member");
    const refused = await olive.client().request("POST", "/v1/team/member", { handle: "noor", role: "owner" }).then(() => null, (err: unknown) => err as { status?: number; code?: string; message: string });
    expect(refused).toMatchObject({ status: 409, code: "stale_request" });
    expect(refused?.message).toContain("has not caught up yet");
    expect(refused?.message).toContain("try again after that machine syncs");
    expect(roles(alex, "noor")).toEqual(["member", "observer"]);
    alex.d.sync.start();
    olive.d.sync.start();
    await waitFor(() => olive.d.core.roster.members.get(NOOR.login)?.role === "observer", { what: "olive reads the demotion", timeoutMs: 20_000 });
    const raised = await olive.client().request<{ event?: { body?: { role?: string } } }>("POST", "/v1/team/member", { handle: "noor", role: "owner" });
    expect(raised.event?.body?.role).toBe("owner");
    expect(roles(alex, "noor")).toEqual(["member", "observer", "owner"]);
  }, 60_000);
});

describe("the docs and the changelog say what the check protects and what it does not", () => {
  const read = (path: string): string => readFileSync(join(import.meta.dir, "../..", path), "utf8");

  test("a removal and any later role change are named, with the older-version, older-authority and separate channel.upsert protection", () => {
    const changelog = read("CHANGELOG.md");
    // Only the current release notes, before the pre.13 section.
    const notes = changelog.slice(0, changelog.indexOf("## v0.2.0-pre.13"));
    expect(notes).toContain("or had their role changed by anyone");
    expect(notes).toContain("an older or unconfirmed authority refuses grants with `409 authority_update_required`");
    expect(notes).toContain("request sent by an older version of Walkie on the owner's machine");
    expect(notes).toContain("ever removed or demoted, even after re-invitation or promotion");
    expect(notes).toContain("message to update Walkie on that machine");
    expect(notes).toContain("Channel membership requests have separate removal preconditions (WALK-124)");
    for (const doc of [read("docs/PROTOCOL.md"), read("docs/SECURITY.md")]) {
      expect(doc).toContain("authority must run a build");
      expect(doc).toContain("WALK-124");
      expect(doc).toContain("demoted");
    }
    expect(read("docs/PROTOCOL.md")).toContain("update Sqwakie and send the request again");
  });
});
