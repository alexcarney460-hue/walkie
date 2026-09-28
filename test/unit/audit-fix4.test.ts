// FIX-4 (ALE-5156): stale answer verdicts (hestia H2, Fable F1), held rows re-judged on origin changes
// (Fable F2), watermark capacity (hestia H1, Fable F5), request dedup independent of signature encoding
// (hestia H3, Fable F3) and own-login node requests (Fable F4). Live-cluster variants of F3/F4 are in
// test/integration/audit-fix4.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import type { Core } from "../../src/daemon/core.ts";
import { HttpError } from "../../src/daemon/http.ts";
import { verifyEvent, verifySig } from "../../src/daemon/keys.ts";
import { admitJoin, applyRequest, requestIdOf } from "../../src/daemon/requests.ts";
import { MAX_NODES_PER_LOGIN, MAX_NODES_PER_TEAM, requestAllowed } from "../../src/daemon/roster.ts";
import { canonicalJson } from "../../src/protocol/canonical.ts";
import { MAX_WM_ORIGINS, type BodyOf, type Event, type RosterRequest } from "../../src/protocol/schemas.ts";
import { feed, makeCore, reopen, settle, statusOf } from "../helpers/core.ts";
import { createTeam, ev, memberEv, nodeEv, tnode, type TNode } from "../helpers/events.ts";
import { testVendor } from "../helpers/license.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const withWm = <T>(body: T, wm: Record<string, number>): T => ({ ...body, wm }) as T;

function shuffle<T>(xs: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const rnd = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

async function replicate(self: TNode, team: string, events: readonly Event[]): Promise<Core> {
  const core = makeCore(self, team, cleanups);
  feed(core, events);
  core.drainPending();
  await settle(core);
  feed(core, events);
  core.drainPending();
  await settle(core);
  return core;
}

function nodeBody(n: TNode, extra: Partial<BodyOf<"team.node">> = {}): BodyOf<"team.node"> {
  return { node_id: n.keys.nodeId, login: n.login, hostname: n.hostname, pubkey: n.keys.pubkey, ip: "127.0.0.1", ...extra };
}

function thrown(fn: () => unknown): HttpError | null {
  try { fn(); } catch (e) { return e as HttpError; }
  return null;
}

// ---- H2 / F1: an answer's stale roster rejection ---------------------------------------------------

describe("H2/F1: a stored answer is re-judged whenever its ask becomes accepted", () => {
  for (const anchored of [true, false]) {
    test(`Fable min-answer (${anchored ? "anchored" : "unanchored"}): every arrival order and a restart agree`, async () => {
      const a = tnode("alex"), m = tnode("mia"), k = tnode("kira");
      const { team, create } = createTeam(a);
      const setup = [create, memberEv(team, a, m, "member"), nodeEv(team, a, m), memberEv(team, a, k, "member"), nodeEv(team, a, k),
        ev(team, a, "channel.upsert", { name: "general" })];
      const ask = ev(team, k, "ask", { to: "@mia", text: "q", expires_at: 4e12 }, { channel: "general" });
      const answer = ev(team, m, "answer", { ask: ask.id, text: "ans" }, { channel: "general" });
      const demote = ev(team, a, "team.member", withWm({ login: m.login, handle: "mia", role: "observer" as const }, { [m.keys.nodeId]: 0 }));
      const promote = ev(team, a, "team.member", withWm({ login: m.login, handle: "mia", role: "member" as const }, { [m.keys.nodeId]: 0 }));
      const anchor = ev(team, a, "channel.upsert", withWm({ name: "general", topic: "t" },
        { [m.keys.nodeId]: anchored ? 1 : 0, [k.keys.nodeId]: anchored ? 1 : 0 }));
      const orders: Event[][] = [
        [...setup, demote, answer, promote, anchor, ask], // the answer arrives first, while mia is an observer
        [...setup, demote, promote, anchor, ask, answer],
        [...setup, ask, answer, demote, promote, anchor],
      ];
      for (const order of orders) {
        let core = await replicate(tnode("obs"), team, order);
        expect(statusOf(core, ask.id)).toBe("ok");
        expect(statusOf(core, answer.id)).toBe("ok");
        core = reopen(core, tnode("obs"));
        const c = core;
        cleanups.push(() => c.close());
        feed(core, [...order].reverse());
        core.drainPending();
        await settle(core);
        expect(statusOf(core, answer.id)).toBe("ok");
      }
      const events = orders[0] as Event[];
      for (let seed = 1; seed <= 30; seed++) {
        const core = await replicate(tnode(`r${seed}`), team, shuffle(events, seed));
        expect({ seed, got: statusOf(core, answer.id) }).toEqual({ seed, got: "ok" });
        while (cleanups.length > 1) cleanups.shift()?.();
      }
    }, 60_000);
  }

  test("a re-judged row whose verdict is pending records unknown_ask instead of the old rejection", async () => {
    const a = tnode("alex"), m = tnode("mia"), k = tnode("kira");
    const { team, create } = createTeam(a);
    const setup = [create, memberEv(team, a, m, "observer"), nodeEv(team, a, m), memberEv(team, a, k, "member"), nodeEv(team, a, k),
      ev(team, a, "channel.upsert", { name: "general" })];
    const ask = ev(team, k, "ask", { to: "@mia", text: "q", expires_at: 4e12 }, { channel: "general" });
    const answer = ev(team, m, "answer", { ask: ask.id, text: "ans" }, { channel: "general" });
    const promote = ev(team, a, "team.member", withWm({ login: m.login, handle: "mia", role: "member" as const }, { [m.keys.nodeId]: 0 }));
    const core = await replicate(tnode("obs"), team, [...setup, answer]);
    expect(core.store.getRow(answer.id)?.reason).toBe("observer_readonly");
    feed(core, [promote]);
    await settle(core);
    expect(core.store.getRow(answer.id)).toMatchObject({ status: "rejected", reason: "unknown_ask" });
    feed(core, [ask]);
    await settle(core);
    expect(statusOf(core, answer.id)).toBe("ok");
  });

  test("hestia H2: an ask kept as a stub, filled after a channel grant, re-judges its stored answer", async () => {
    const a = tnode("alex"), m = tnode("mia"), r = tnode("rob");
    const { team, create } = createTeam(a);
    const setup = [create, memberEv(team, a, m, "observer"), nodeEv(team, a, m), memberEv(team, a, r, "member"), nodeEv(team, a, r),
      ev(team, a, "channel.upsert", { name: "general" }), ev(team, a, "channel.upsert", { name: "c", members: ["alex", "mia"] })];
    const q = ev(team, m, "ask", { to: "@mia", text: "q", expires_at: 4e12 }, { channel: "c" });
    const e = ev(team, m, "answer", { ask: q.id, text: "ans" }, { channel: "c" });
    const promote = ev(team, a, "team.member", withWm({ login: m.login, handle: "mia", role: "member" as const }, { [m.keys.nodeId]: 0 }));
    const anchor = ev(team, a, "channel.upsert", withWm({ name: "general", topic: "t" }, { [m.keys.nodeId]: 2 }));
    const grant = ev(team, a, "channel.upsert", withWm({ name: "c", members: ["alex", "mia", "rob"] }, { [m.keys.nodeId]: 2 }));

    // R: E stored hidden (mia an observer), the promotion, the anchor, then Q arrives as a final valid
    // event in a channel R can't see (a stub). The grant makes C visible and the stub is filled.
    const rep = makeCore(r, team, cleanups);
    feed(rep, [...setup, e]);
    expect(statusOf(rep, e.id)).toBe("rejected");
    feed(rep, [promote, anchor, q]);
    await settle(rep);
    expect(statusOf(rep, q.id)).toBe("stub");
    feed(rep, [grant]);
    await settle(rep);
    expect(rep.fillableStubIds(10, "peer")).toEqual([q.id]);
    expect(rep.ingest(q, "remote").status).toBe("accepted"); // the stub fill
    await settle(rep);
    expect(statusOf(rep, q.id)).toBe("ok");
    expect(statusOf(rep, e.id)).toBe("ok");

    // Codex's first variant (R holds both in full before the promotion) and the complete chain first.
    for (const order of [[...setup, q, e, promote, anchor, grant], [...setup, promote, anchor, grant, q, e]]) {
      const other = await replicate(r, team, order);
      expect([statusOf(other, q.id), statusOf(other, e.id)]).toEqual(["ok", "ok"]);
    }
  });
});

// ---- F2: held rows re-judged on an origin's roster change -------------------------------------------

describe("F2: an origin's held rows are re-judged when its roster changes", () => {
  test("a held answer that a demotion makes invalid regardless of its ask is rejected, as on a replica that got the demotion first", async () => {
    const a = tnode("alex"), m = tnode("mia"), k = tnode("kira");
    const { team, create } = createTeam(a);
    const setup = [create, memberEv(team, a, m, "member"), nodeEv(team, a, m), memberEv(team, a, k, "member"), nodeEv(team, a, k),
      ev(team, a, "channel.upsert", { name: "general" })];
    const ask = ev(team, k, "ask", { to: "@mia", text: "q", expires_at: 4e12 }, { channel: "general" }); // never delivered
    const answer = ev(team, m, "answer", { ask: ask.id, text: "ans" }, { channel: "general" });
    const demote = ev(team, a, "team.member", withWm({ login: m.login, handle: "mia", role: "observer" as const }, { [m.keys.nodeId]: 0 }));
    const held = makeCore(tnode("h"), team, cleanups);
    feed(held, [...setup, answer]);
    expect(statusOf(held, answer.id)).toBe("pending");
    feed(held, [demote]);
    await settle(held);
    expect(held.store.getRow(answer.id)).toMatchObject({ status: "rejected", reason: "observer_readonly" });
    const first = await replicate(tnode("f"), team, [...setup, demote, answer]);
    expect(first.store.getRow(answer.id)).toMatchObject({ status: "rejected", reason: "observer_readonly" });
  });
});

describe("re-audit #3: a channel restriction re-judges held rows in that channel whatever they wait for", () => {
  test("a held answer in a channel narrowed to exclude its author is rejected, as on a replica that got the narrowing first", async () => {
    const a = tnode("alex"), m = tnode("mia"), k = tnode("kira");
    const { team, create } = createTeam(a);
    const setup = [create, memberEv(team, a, m, "member"), nodeEv(team, a, m), memberEv(team, a, k, "member"), nodeEv(team, a, k),
      ev(team, a, "channel.upsert", { name: "dev" })];
    const ask = ev(team, k, "ask", { to: "@mia", text: "q", expires_at: 4e12 }, { channel: "dev" }); // never delivered
    const answer = ev(team, m, "answer", { ask: ask.id, text: "ans" }, { channel: "dev" });
    const narrow = ev(team, a, "channel.upsert", withWm({ name: "dev", members: ["alex", "kira"] }, { [m.keys.nodeId]: 0 }));
    const held = makeCore(tnode("h"), team, cleanups);
    feed(held, [...setup, answer]);
    expect(statusOf(held, answer.id)).toBe("pending");
    feed(held, [narrow]);
    await settle(held);
    expect(held.store.getRow(answer.id)).toMatchObject({ status: "rejected", reason: "not_channel_member" });
    const first = await replicate(tnode("f"), team, [...setup, narrow, answer]);
    expect(first.store.getRow(answer.id)).toMatchObject({ status: "rejected", reason: "not_channel_member" });
  });
});

// ---- H1 / F5: watermark capacity ----------------------------------------------------------------------

describe("H1/F5: node limits keep the watermark representable; revoke, remove and transfer work at capacity", () => {
  test("the watermark carries only roster nodes (a version vector padded with unknown origins can't freeze the authority)", () => {
    const a = tnode("alex");
    const { team, create } = createTeam(a);
    const core = makeCore(a, team, cleanups);
    core.ingest(create, "local");
    for (let i = 0; i < MAX_WM_ORIGINS; i++) core.store.setVv(i.toString(16).padStart(16, "0"), 1);
    const up = core.emit("channel.upsert", { name: "x" });
    expect(Object.keys((up.body as { wm: Record<string, number> }).wm)).toEqual([a.keys.nodeId]);
  });

  test(`at most ${MAX_NODES_PER_LOGIN} active machines per login; a revocation frees a slot`, () => {
    const a = tnode("alex"), k = tnode("kira");
    const { team, create } = createTeam(a);
    const core = makeCore(a, team, cleanups);
    core.ingest(create, "local");
    core.emit("team.member", { login: k.login, handle: "kira", role: "member" });
    const machines = Array.from({ length: MAX_NODES_PER_LOGIN + 1 }, (_, i) => tnode("kira", k.login, `k${i}`));
    for (const n of machines.slice(0, MAX_NODES_PER_LOGIN)) core.emit("team.node", nodeBody(n));
    const extra = machines[MAX_NODES_PER_LOGIN] as TNode;
    const err = thrown(() => core.emit("team.node", nodeBody(extra)));
    expect([err?.status, err?.code]).toEqual([409, "node_limit"]);
    core.emit("team.node", nodeBody(machines[0] as TNode, { revoked: true }));
    expect(core.emit("team.node", nodeBody(extra)).kind).toBe("team.node");
    // Re-arming the revoked one now exceeds the per-login limit again.
    expect(thrown(() => core.emit("team.node", nodeBody(machines[0] as TNode)))?.code).toBe("node_limit");
  });

  test(`${MAX_NODES_PER_TEAM} node ids per team with a full watermark: admission refused, then revoke, remove, transfer and the new authority's first entry all work`, async () => {
    const a = tnode("alex");
    const { team, create } = createTeam(a);
    // 64 people exceed the trial's 50: a Business license (throwaway vendor key) lifts the plan limit so
    // this test exercises only the node limits. The license entry has no watermark (anchors nothing).
    const vendor = testVendor();
    const auth = makeCore(a, team, cleanups, { licenseVerifier: vendor.verify });
    auth.ingest(create, "local");
    auth.emit("team.license", { key: vendor.issue({ team, plan: "business", seats: 100 }) });
    const logins = [a, ...Array.from({ length: MAX_NODES_PER_TEAM / MAX_NODES_PER_LOGIN - 1 }, (_, i) => tnode(`m${i}`))];
    const heir = logins[1] as TNode; // becomes an owner and the next authority
    const nodes: TNode[] = [];
    for (const who of logins) {
      if (who !== a) auth.emit("team.member", { login: who.login, handle: who.handle, role: who === heir ? "owner" : "member" });
      const first = who === a ? 1 : 0; // the founder's node is already admitted
      for (let i = first; i < MAX_NODES_PER_LOGIN; i++) {
        const n = i === 0 ? who : tnode(who.handle, who.login, `${who.handle}-${i}`);
        auth.emit("team.node", nodeBody(n));
        nodes.push(n);
      }
    }
    expect(auth.roster.nodes.size).toBe(MAX_NODES_PER_TEAM);
    auth.emit("channel.upsert", { name: "general" });
    for (const n of nodes) if (n !== heir) expect(auth.ingest(ev(team, n, "msg.post", { text: "hi" }, { channel: "general" }), "remote").status).toBe("accepted");
    await settle(auth);

    const stranger = tnode("late");
    auth.emit("team.member", { login: stranger.login, handle: "late", role: "member" });
    const err = thrown(() => auth.emit("team.node", nodeBody(stranger)));
    expect([err?.status, err?.code]).toEqual([409, "node_limit"]);

    const revoke = auth.emit("team.node", nodeBody(nodes[5] as TNode, { revoked: true }));
    expect(Object.keys((revoke.body as { wm: Record<string, number> }).wm).length).toBe(MAX_NODES_PER_TEAM - 1); // every origin but the heir
    auth.emit("team.member", { login: (logins[2] as TNode).login, handle: (logins[2] as TNode).handle, role: "removed" });
    expect(thrown(() => auth.emit("team.node", nodeBody(stranger)))?.code).toBe("node_limit"); // ids never leave the roster
    const transfer = auth.emit("team.authority", { node_id: heir.keys.nodeId });
    expect(auth.authority).toBe(heir.keys.nodeId);
    expect(Buffer.byteLength(JSON.stringify(transfer))).toBeLessThan(64 * 1024);

    // The heir's daemon replicates everything and appends its first (linked) entry at capacity.
    const next = makeCore(heir, team, cleanups, { licenseVerifier: vendor.verify });
    const rows = (o: string): Event[] => auth.store.rowsForSync(o, 0, auth.store.vvOf(o), 100_000).map((r) => JSON.parse(r.json) as Event);
    feed(next, rows(a.keys.nodeId));
    for (const o of Object.keys(auth.store.vv())) if (o !== a.keys.nodeId) feed(next, rows(o));
    next.drainPending();
    await settle(next);
    expect(next.isAuthority()).toBe(true);
    expect(next.roster.nodes.size).toBe(MAX_NODES_PER_TEAM);
    const first = next.emit("channel.upsert", { name: "after-transfer" });
    expect((first.body as { after?: string }).after).toBe(transfer.id);
    expect(Object.keys((first.body as { wm: Record<string, number> }).wm).length).toBeLessThanOrEqual(MAX_NODES_PER_TEAM);
    expect(next.emit("team.node", nodeBody(nodes[5] as TNode)).kind).toBe("team.node"); // re-arm an existing id
    expect(auth.ingest(first, "remote").status).toBe("accepted");
  }, 120_000);

  test("a pending join over the limit is refused without dropping the request", () => {
    const a = tnode("alex"), k = tnode("kira");
    const { team, create } = createTeam(a);
    const core = makeCore(a, team, cleanups);
    core.ingest(create, "local");
    core.emit("team.member", { login: k.login, handle: "kira", role: "member" });
    for (let i = 0; i < MAX_NODES_PER_LOGIN; i++) core.emit("team.node", nodeBody(tnode("kira", k.login, `k${i}`)));
    const j = tnode("kira", k.login, "kj");
    core.store.addJoinRequest({ node_id: j.keys.nodeId, login: k.login, pubkey: j.keys.pubkey, hostname: "kj", ip: "127.0.0.1", port: 7458, requested_at: core.clock() });
    expect(thrown(() => admitJoin(core, j.keys.nodeId, true))?.code).toBe("node_limit");
    expect(core.store.joinRequest(j.keys.nodeId, core.clock())).not.toBeNull();
  });
});

// ---- H3 / F3: one encoding per signature; request identity from the signed payload -------------------

function request(team: string, n: TNode, kind: RosterRequest["kind"], body: Record<string, unknown>): RosterRequest {
  const unsigned = { id: crypto.randomUUID().replaceAll("-", ""), kind, body, node: n.keys.nodeId, ts: Date.now() };
  return { ...unsigned, sig: n.keys.sign(canonicalJson({ team, ...unsigned })) };
}

describe("H3/F3: signatures have one valid encoding; request dedup ignores the signature text", () => {
  test("verifySig refuses non-canonical base64 of a valid signature", () => {
    const n = tnode("alex");
    const sig = n.keys.sign("data");
    expect(verifySig(n.keys.pubkey, "data", sig)).toBe(true);
    expect(sig.endsWith("==")).toBe(true);
    for (const variant of [sig.replace(/=+$/, ""), `${sig} `, sig.replaceAll("+", "-").replaceAll("/", "_"), `\n${sig}`]) {
      if (variant === sig) continue;
      expect(verifySig(n.keys.pubkey, "data", variant)).toBe(false);
    }
  });

  test("the request id is the hash of the signed payload, whatever the signature's encoding", () => {
    const n = tnode("kira");
    const q = request("0123456789abcdef", n, "team.member", { login: "x@example.com", handle: "x", role: "member" });
    expect(requestIdOf("0123456789abcdef", { ...q, sig: q.sig.replace(/=+$/, "") })).toBe(requestIdOf("0123456789abcdef", q));
    expect(requestIdOf("0123456789abcdef", { ...q, ts: q.ts + 1 })).not.toBe(requestIdOf("0123456789abcdef", q));
    expect(requestIdOf("fedcba9876543210", q)).not.toBe(requestIdOf("0123456789abcdef", q));
  });

  test("hestia H3: a padding-stripped resubmission is refused and never re-applied", () => {
    const a = tnode("alex"), k = tnode("kira"), m = tnode("mem");
    const { team, create } = createTeam(a);
    const core = makeCore(a, team, cleanups);
    core.ingest(create, "local");
    core.emit("team.member", { login: k.login, handle: "kira", role: "owner" });
    core.emit("team.node", nodeBody(k));
    core.emit("team.member", { login: m.login, handle: "mem", role: "member" });
    const q = request(team, k, "team.member", { login: m.login, handle: "mem", role: "owner" });
    const applied = applyRequest(core, q);
    core.emit("team.member", { login: m.login, handle: "mem", role: "member" }); // demoted afterwards
    const err = thrown(() => applyRequest(core, { ...q, sig: q.sig.replace(/=+$/, "") }));
    expect([err?.status, err?.code]).toEqual([403, "forbidden"]);
    expect(applyRequest(core, q)?.id).toBe(applied?.id as string); // the original is still deduplicated
    expect(core.roster.members.get(m.login)?.role).toBe("member");
  });

  test("an event or stub with a re-encoded signature is a forgery, not a second copy or a conflict", () => {
    const a = tnode("alex"), k = tnode("kira");
    const { team, create } = createTeam(a);
    const setup = [create, memberEv(team, a, k, "member"), nodeEv(team, a, k), ev(team, a, "channel.upsert", { name: "general" }),
      ev(team, a, "channel.upsert", { name: "vault", members: ["alex", "kira"] })];
    const post = ev(team, k, "msg.post", { text: "once" }, { channel: "general" });
    const stripped = { ...post, sig: post.sig.replace(/=+$/, "") };
    expect(verifyEvent(stripped, k.keys.pubkey)).toBe(false);
    const fresh = makeCore(tnode("f"), team, cleanups);
    feed(fresh, setup);
    expect(fresh.ingest(stripped, "remote")).toEqual({ status: "rejected", reason: "bad_signature" });
    expect(fresh.ingest(post, "remote").status).toBe("accepted");
    expect(fresh.ingest(stripped, "remote")).toEqual({ status: "rejected", reason: "bad_signature" });
    expect(fresh.store.conflictOrigins()).toEqual([]);
    const hsigStripped = { ...post, hsig: (post.hsig as string).replace(/=+$/, "") };
    const other = makeCore(tnode("o"), team, cleanups);
    feed(other, setup);
    expect(other.ingest(hsigStripped, "remote").status).toBe("rejected");
  });
});

// ---- F4: an owner's team.node request binds keys only to the owner's own login ----------------------

describe("F4: an owner can't admit a key under another member's login by request", () => {
  test("requestAllowed: own login, revocations and existing bindings only", () => {
    const a = tnode("alex"), k = tnode("kira"), m = tnode("mem");
    const { team, create } = createTeam(a);
    const core = makeCore(a, team, cleanups);
    core.ingest(create, "local");
    core.emit("team.member", { login: k.login, handle: "kira", role: "owner" });
    core.emit("team.member", { login: m.login, handle: "mem", role: "member" });
    core.emit("team.node", nodeBody(m));
    const kira = core.roster.members.get(k.login) as NonNullable<ReturnType<typeof core.roster.members.get>>;
    const ghost = tnode("mem", m.login, "ghost");
    expect(requestAllowed("team.node", { ...nodeBody(ghost) }, core.roster, kira)).toEqual({ status: "reject", reason: "not_own_node" });
    expect(requestAllowed("team.node", { ...nodeBody(tnode("kira", k.login, "k2")) }, core.roster, kira).status).toBe("ok");
    expect(requestAllowed("team.node", { ...nodeBody(m, { revoked: true }) }, core.roster, kira).status).toBe("ok");
    expect(requestAllowed("team.node", { ...nodeBody(m, { ip: "127.0.0.2" }) }, core.roster, kira).status).toBe("ok");
    expect(requestAllowed("team.node", { ...nodeBody(m, { pubkey: ghost.keys.pubkey }) }, core.roster, kira)).toEqual({ status: "reject", reason: "not_own_node" });
  });

  test("re-audit #1: revoking a never-admitted key can't plant a cross-login binding to re-admit later", () => {
    const a = tnode("alex"), k = tnode("kira"), m = tnode("mem");
    const { team, create } = createTeam(a);
    const core = makeCore(a, team, cleanups);
    core.ingest(create, "local");
    core.emit("team.member", { login: k.login, handle: "kira", role: "owner" });
    core.emit("team.node", nodeBody(k));
    core.emit("team.member", { login: m.login, handle: "mem", role: "member" });
    core.emit("team.node", nodeBody(m));
    const kira = core.roster.members.get(k.login) as NonNullable<ReturnType<typeof core.roster.members.get>>;
    const planted = tnode("mem", m.login, "planted");
    expect(requestAllowed("team.node", { ...nodeBody(planted, { revoked: true }) }, core.roster, kira)).toEqual({ status: "reject", reason: "not_own_node" });
    const err = thrown(() => applyRequest(core, request(team, k, "team.node", { ...nodeBody(planted, { revoked: true }) })));
    expect([err?.status, err?.message]).toEqual([403, "request refused: not_own_node"]);
    expect(core.roster.nodes.has(planted.keys.nodeId)).toBe(false);
    const again = thrown(() => applyRequest(core, request(team, k, "team.node", { ...nodeBody(planted) })));
    expect(again?.status).toBe(403);
    // revoking the victim's REAL machine is still an owner power
    expect(requestAllowed("team.node", { ...nodeBody(m, { revoked: true }) }, core.roster, kira).status).toBe("ok");
  });

  test("Fable F4: the impersonation request is refused, so a post signed by the minted key stays unadmitted", () => {
    const a = tnode("alex"), k = tnode("kira"), m = tnode("mem");
    const { team, create } = createTeam(a);
    const core = makeCore(a, team, cleanups);
    core.ingest(create, "local");
    core.emit("team.member", { login: k.login, handle: "kira", role: "owner" });
    core.emit("team.node", nodeBody(k));
    core.emit("team.member", { login: m.login, handle: "mem", role: "member" });
    core.emit("team.node", nodeBody(m));
    core.emit("channel.upsert", { name: "general" });
    const fake = tnode("mem", m.login, "ghost");
    const err = thrown(() => applyRequest(core, request(team, k, "team.node", { ...nodeBody(fake) })));
    expect([err?.status, err?.message]).toEqual([403, "request refused: not_own_node"]);
    expect(core.roster.nodes.has(fake.keys.nodeId)).toBe(false);
    const forged = ev(team, fake, "msg.post", { text: "I (mem) resign" }, { channel: "general" });
    expect(core.ingest(forged, "remote").status).toBe("pending");
    // An owner may still add a machine of their own, and revoke anyone's.
    expect(applyRequest(core, request(team, k, "team.node", { ...nodeBody(tnode("kira", k.login, "k2")) }))?.kind).toBe("team.node");
    expect(applyRequest(core, request(team, k, "team.node", { ...nodeBody(m, { revoked: true }) }))?.kind).toBe("team.node");
    expect(core.roster.nodes.get(m.keys.nodeId)?.revoked).toBe(true);
  });
});
