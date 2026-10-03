// WALK-101: an ended rental is closed (and marked revoked) only when the roster CONFIRMS its machine revoked. A
// revocation that is only queued (the roster authority is unreachable) or refused leaves the machine admitted, so the
// record stays open, is tried again every round without sending the request twice, survives a daemon restart, and owners
// are told (the state's alerts, and one #general line for a refusal). Real Cores over throwaway stores; the roster
// authority and the site are fakes.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { loadRentals, newRecord, rentalsPath, RentalsFileError, saveAccounts, saveRentals } from "../../src/daemon/compute/files.ts";
import { revokeRentedNode } from "../../src/daemon/compute/nodes.ts";
import { ACCEPTED_WAIT_MS, ComputeService, REFUSED_RETRY_MAX_MS, REVOKE_WATCH_MS, type ComputeDeps } from "../../src/daemon/compute/service.ts";
import { ComputeSite } from "../../src/daemon/compute/site.ts";
import type { Core } from "../../src/daemon/core.ts";
import type { Logger } from "../../src/daemon/logger.ts";
import { PeerCallError, type PeerAddr, type PeerClient } from "../../src/daemon/peer-client.ts";
import { flushRequests, queuedView } from "../../src/daemon/requests.ts";
import type { ComputeState } from "../../src/protocol/compute.ts";
import type { RosterRequest } from "../../src/protocol/schemas.ts";
import { ev, memberEv, nodeEv, createTeam, now, tnode } from "../helpers/events.ts";
import { makeCore, reopen } from "../helpers/core.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const RENTAL = "r_00000000000000a1";
const ACCOUNT = "ca_00000000000000c1";
const TOKEN = "T".repeat(43);
const INVITE = "ab".repeat(16);

/** The site's view of the rental: ended at `endedAt` (the world's clock when it was built). */
const endedRental = (endedAt: number) => ({
  id: RENTAL, tier: "agent", name: "rent-agent-7f3a", state: "ended", queue_position: null, price_per_hour_micros: 750_000, spent_micros: 250_000,
  created_at: endedAt - 3_600_000, started_at: endedAt - 3_500_000, ended_at: endedAt, end_reason: "user", node_id: null, idle_minutes: 30,
});

interface Opts {
  /** This daemon is the roster authority (else the owner's second machine, with alex as the authority). */
  readonly authority?: boolean;
  /** The rented machine is the roster authority itself (it cannot be revoked this way). */
  readonly rentedIsAuthority?: boolean;
  /** The rental's machine id preset on the record, not on the roster. */
  readonly strayNode?: string;
  /** The machine's admission has not reached this daemon yet (a daemon that was asleep or cut off); `joinLate()` delivers it. */
  readonly lateJoin?: boolean;
}

/** An owner's daemon with one ended rental whose machine joined with INVITE. */
function world(o: Opts = {}) {
  const alex = tnode("alex", "direct:alex");
  const bea = tnode("bea", "direct:bea");
  const box = o.rentedIsAuthority ? alex : tnode("rented", o.authority ? alex.login : bea.login, "rent-agent-7f3a");
  let t = now() + 600_000;
  const endedAt = t;
  const clock = () => t;
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const log = { info: (event: string, fields: Record<string, unknown> = {}) => logs.push({ event, fields }), warn: () => undefined } as unknown as Logger;
  const boxBody = (revoked = false) => ({
    node_id: box.keys.nodeId, login: box.login, hostname: box.hostname, pubkey: box.keys.pubkey, ip: "127.0.0.1",
    ...(revoked ? { revoked: true } : { invite: INVITE }),
  });
  let core: Core;
  let team: string;
  if (o.authority) {
    core = makeCore(alex, "0000000000000000", cleanups, { clock });
    core.store.deleteMeta("team");
    core.createTeam("acme", "alex", { login: alex.login });
    team = core.teamId as string;
    core.emit("channel.upsert", { name: "general" });
    core.emit("team.node", boxBody() as never);
  } else {
    const made = createTeam(alex);
    team = made.team;
    core = makeCore(bea, team, cleanups, { clock });
    const events = [made.create, ev(team, alex, "channel.upsert", { name: "general" }), memberEv(team, alex, bea, "owner"), nodeEv(team, alex, bea),
      ...(o.lateJoin ? [] : [ev(team, alex, "team.node", boxBody() as never)])];
    for (const e of events) expect(core.ingest(e, "remote").status).toBe("accepted");
  }
  saveAccounts(core.paths.home, [{ account_id: ACCOUNT, team, token: TOKEN }]);
  const record = { ...newRecord("agent", [INVITE], t), state: "running" as const, ...(o.strayNode ? { node_id: o.strayNode } : {}) };
  saveRentals(core.paths.home, { [RENTAL]: record });

  // The roster authority, as a fake peer: up or down; it applies a revocation like the real one (alex signs the event) or refuses.
  const authority = { up: false, refuse: false, requests: [] as RosterRequest[], sync: true, inbox: [] as ReturnType<typeof ev>[] };
  const client = {
    addrOf: () => (authority.up ? ({ kind: "direct" } as unknown as PeerAddr) : null),
    rosterRequest: async (_addr: PeerAddr, req: RosterRequest) => {
      authority.requests.push(req);
      if (authority.refuse) throw new PeerCallError(403, "forbidden", "request refused: not_own_node");
      const e = ev(team, alex, "team.node", { ...req.body } as never);
      authority.inbox.push(e);
      return { event: { id: e.id, seq: e.seq } };
    },
  } as unknown as PeerClient;
  const catchUp = async () => { if (authority.sync) while (authority.inbox.length) core.ingest(authority.inbox.shift()!, "remote"); };

  const siteCalls: string[] = [];
  let syncedAt: number | null | "now" = "now";
  const site = new ComputeSite({ base: "https://fixture.test", fetch: async (url) => {
    siteCalls.push(String(url));
    if (String(url).endsWith("/api/compute/state")) {
      return Response.json({ account_id: ACCOUNT, team_id: team, status: "active", balance_micros: 1_000_000, burn_per_hour_micros: 0, hours_left: null, rentals: [endedRental(endedAt)] });
    }
    return Response.json({ error: "handover_not_found" }, { status: 404 });
  } });
  const authoritySyncedAt = () => (syncedAt === "now" ? t : syncedAt);
  const service = (c: Core = core, withSync = true) => new ComputeService(
    { core: c, client, catchUp, log, transport: () => undefined, ...(withSync ? { authoritySyncedAt } : {}) } as unknown as ComputeDeps,
    { site, version: "v0.2.0-pre.11" });
  return {
    alex, bea, box, team, authority, client, catchUp, logs, service, siteCalls, endedAt,
    get core() { return core; },
    set core(c: Core) { core = c; },
    /** When this daemon last synced with the authority (null: never; "now": always, as the authority's own daemon is). */
    get syncedAt() { return syncedAt; },
    set syncedAt(v: number | null | "now") { syncedAt = v; },
    clock,
    joinLate: () => core.ingest(ev(team, alex, "team.node", boxBody() as never), "remote").status,
    /** An owner revokes the machine by hand (the event reaches this daemon). */
    revokeByHand: () => core.ingest(ev(team, alex, "team.node", boxBody(true) as never), "remote").status,
    advance: (ms: number) => { t += ms; },
    rec: () => loadRentals(core.paths.home)[RENTAL]!,
    revokedOnRoster: () => core.roster.nodes.get(box.keys.nodeId)?.revoked === true,
    queued: () => queuedView(core).filter((q) => q.kind === "team.node"),
    revokeEvents: () => core.store.queryEvents({ kinds: ["team.node"], limit: 100 }).filter((r) => (JSON.parse(r.json) as { body: { node_id: string; revoked?: boolean } }).body.revoked === true
      && (JSON.parse(r.json) as { body: { node_id: string } }).body.node_id === box.keys.nodeId),
    flush: () => flushRequests(core, client, catchUp),
    audit: () => core.store.queryEvents({ kinds: ["msg.post"], channel: "general", limit: 50 })
      .map((r) => (JSON.parse(r.json) as { body: { text: string } }).body.text).filter((x) => x.includes("rented machine")),
  };
}

describe("rental revocation is closed only when confirmed", () => {
  test("revoked: the roster authority's own daemon revokes at once; the record closes", async () => {
    const w = world({ authority: true });
    const svc = w.service();
    await svc.pollOnce();
    expect(w.revokedOnRoster()).toBe(true);
    expect(w.rec()).toMatchObject({ revoked: true, closed: true, node_id: w.box.keys.nodeId });
    expect(w.rec().revoke).toBeUndefined();
    expect(w.logs.find((l) => l.event === "compute_node_revoked")?.fields.outcome).toBe("revoked");
  });

  test("idempotent: settling again, or after an owner revoked it first, never writes a second revocation", async () => {
    const w = world({ authority: true });
    const svc = w.service();
    await svc.pollOnce();
    await svc.pollOnce();
    await svc.pollOnce();
    expect(w.revokeEvents()).toHaveLength(1);
    const again = world({ authority: true });
    again.core.emit("team.node", { node_id: again.box.keys.nodeId, login: again.box.login, hostname: again.box.hostname, pubkey: again.box.keys.pubkey, ip: "127.0.0.1", revoked: true } as never);
    expect(again.revokeEvents()).toHaveLength(1);
    await again.service().pollOnce();
    expect(again.revokeEvents()).toHaveLength(1); // "already": confirmed without another event
    expect(again.rec()).toMatchObject({ revoked: true, closed: true });
  });

  test("queued: the authority is unreachable, so the machine is still admitted and the rental stays open; no duplicate request", async () => {
    const w = world();
    const svc = w.service();
    await svc.pollOnce();
    expect(w.revokedOnRoster()).toBe(false);
    expect(w.rec()).toMatchObject({ revoked: false, closed: false, revoke: { state: "pending" } });
    expect(w.queued()).toHaveLength(1);
    for (let i = 0; i < 3; i++) await svc.pollOnce();
    expect(w.queued()).toHaveLength(1); // the same queued request, not one per round
    expect(w.rec()).toMatchObject({ revoked: false, closed: false });
    expect(svc.pending()).toBe(true);
    // Past the watch window a machine that is still admitted is NOT given up on.
    w.advance(REVOKE_WATCH_MS + 60_000);
    await svc.pollOnce();
    expect(w.rec()).toMatchObject({ revoked: false, closed: false, revoke: { state: "pending" } });
    expect(((await svc.state()) as ComputeState).alerts).toEqual(["revocation_pending"]);
  });

  test("queued, then confirmed once the authority is back: the request flushes, the roster shows it, the record closes", async () => {
    const w = world();
    const svc = w.service();
    await svc.pollOnce();
    expect(w.rec().closed).toBe(false);
    w.authority.up = true;
    await w.flush();
    expect(w.revokedOnRoster()).toBe(true);
    expect(w.queued()).toHaveLength(0);
    await svc.pollOnce();
    expect(w.rec()).toMatchObject({ revoked: true, closed: true });
    expect(w.rec().revoke).toBeUndefined();
    expect(w.authority.requests).toHaveLength(1); // exactly one request ever reached the authority
    expect(((await svc.state()) as ComputeState).alerts).toBeUndefined();
  });

  test("a daemon restart between queueing and confirmation: the queued request and the open record both survive; nothing is sent twice", async () => {
    const w = world();
    await w.service().pollOnce();
    expect(w.queued()).toHaveLength(1);
    w.core = reopen(w.core, w.bea, {});
    cleanups.push(() => w.core.close());
    const restarted = w.service(w.core);
    await restarted.pollOnce();
    await restarted.pollOnce();
    expect(w.rec()).toMatchObject({ revoked: false, closed: false, revoke: { state: "pending" } });
    expect(w.queued()).toHaveLength(1);
    w.authority.up = true;
    await w.flush();
    await restarted.pollOnce();
    expect(w.rec()).toMatchObject({ revoked: true, closed: true });
    expect(w.authority.requests).toHaveLength(1);
  });

  test("a queued request that was dropped (refused later by the authority) is asked again, not forgotten", async () => {
    const w = world();
    const svc = w.service();
    await svc.pollOnce();
    const [dropped] = w.core.store.queuedRequests();
    w.core.store.dequeueRequest(dropped!.id); // flushRequests drops a refused request like this
    await svc.pollOnce();
    expect(w.queued()).toHaveLength(1);
    expect(w.queued()[0]!.id).not.toBe(dropped!.id);
    expect(w.rec()).toMatchObject({ revoked: false, closed: false });
  });

  test("accepted by the authority but not yet synced here: not confirmed until the roster shows it", async () => {
    const w = world();
    w.authority.up = true;
    w.authority.sync = false;
    const svc = w.service();
    await svc.pollOnce();
    expect(w.revokedOnRoster()).toBe(false);
    expect(w.rec()).toMatchObject({ revoked: false, closed: false, revoke: { state: "pending", accepted_at: w.clock() } });
    // While the accepted request is on its way here it is not sent again, round after round.
    for (let i = 0; i < 3; i++) { w.advance(60_000); await svc.pollOnce(); }
    expect(w.authority.requests).toHaveLength(1);
    expect(w.revokeEvents()).toHaveLength(0);
    // The bounded wait is over and the roster still doesn't show it: asked once more (not once per round).
    w.advance(ACCEPTED_WAIT_MS);
    await svc.pollOnce();
    expect(w.authority.requests).toHaveLength(2);
    for (let i = 0; i < 3; i++) { w.advance(60_000); await svc.pollOnce(); }
    expect(w.authority.requests).toHaveLength(2);
    w.authority.sync = true;
    await w.catchUp(); // the sync round delivers the event
    await svc.pollOnce();
    expect(w.revokedOnRoster()).toBe(true);
    expect(w.rec()).toMatchObject({ revoked: true, closed: true });
    expect(w.rec().revoke).toBeUndefined();
  });

  test("refused (the rented machine is the roster authority): stays open, plain reason on the record, state and #general, once", async () => {
    const w = world({ rentedIsAuthority: true });
    const svc = w.service();
    await svc.pollOnce();
    expect(w.rec()).toMatchObject({ revoked: false, closed: false, revoke: { state: "refused" } });
    expect(w.rec().revoke?.reason).toContain("roster authority");
    expect(w.queued()).toHaveLength(0);
    for (let i = 0; i < 3; i++) await svc.pollOnce();
    w.advance(REVOKE_WATCH_MS + 60_000);
    await svc.pollOnce();
    expect(w.rec()).toMatchObject({ revoked: false, closed: false, revoke: { state: "refused" } }); // never closed by the clock
    const posts = w.audit();
    expect(posts).toHaveLength(1); // one line, not one per round
    expect(posts[0]).toContain(RENTAL);
    expect(posts[0]).toContain("could not be removed automatically");
    expect(w.logs.filter((l) => l.event === "compute_node_revoked")).toHaveLength(1); // logged when it first happened
    expect(((await svc.state()) as ComputeState).alerts).toEqual(["revocation_refused"]);
  });

  test("refused by the authority (a 4xx answer): the round does not fail, the rental stays open with the reason, and a later accept closes it", async () => {
    const w = world();
    w.authority.up = true;
    w.authority.refuse = true;
    const svc = w.service();
    await svc.pollOnce(); // must not throw: one refused rental must not stop the round
    expect(w.rec()).toMatchObject({ revoked: false, closed: false, revoke: { state: "refused" } });
    expect(w.rec().revoke?.reason).toBe("the team's roster authority refused the request (forbidden)");
    expect(w.queued()).toHaveLength(0);
    expect(w.audit()).toHaveLength(1);
    w.authority.refuse = false;
    w.advance(60_000); // the first backoff
    await svc.pollOnce();
    expect(w.rec()).toMatchObject({ revoked: true, closed: true });
    expect(w.rec().revoke).toBeUndefined();
    expect(w.revokedOnRoster()).toBe(true);
  });

  test("unknown_node: the roster has no such machine; nothing to revoke, so it is watched until its codes can no longer be used, then closed", async () => {
    const w = world({ strayNode: "f".repeat(16) });
    const svc = w.service();
    await svc.pollOnce();
    expect(w.rec()).toMatchObject({ revoked: false, closed: false });
    expect(w.rec().revoke).toBeUndefined();
    expect(w.queued()).toHaveLength(0);
    expect(w.logs.find((l) => l.event === "compute_node_revoked")?.fields.outcome).toBe("unknown_node");
    w.advance(REVOKE_WATCH_MS + 60_000);
    await svc.pollOnce();
    expect(w.rec()).toMatchObject({ revoked: false, closed: true });
  });
});

describe("revokeRentedNode outcomes", () => {
  const deps = (w: ReturnType<typeof world>) => ({ core: w.core, client: w.client, catchUp: w.catchUp });

  test("each outcome, and only revoked/already confirm", async () => {
    const own = world({ authority: true });
    expect((await revokeRentedNode(deps(own), own.box.keys.nodeId)).outcome).toBe("revoked");
    expect((await revokeRentedNode(deps(own), own.box.keys.nodeId)).outcome).toBe("already");
    expect((await revokeRentedNode(deps(own), "e".repeat(16))).outcome).toBe("unknown_node");
    const away = world();
    const queued = await revokeRentedNode(deps(away), away.box.keys.nodeId);
    expect(queued.outcome).toBe("queued");
    expect((await revokeRentedNode(deps(away), away.box.keys.nodeId)).outcome).toBe("queued"); // already waiting: not sent again
    expect(away.queued()).toHaveLength(1);
    const self = world({ rentedIsAuthority: true });
    const refused = await revokeRentedNode(deps(self), self.box.keys.nodeId);
    expect(refused).toMatchObject({ outcome: "refused" });
    expect(refused.reason).toBeTruthy();
    // Held: nothing is sent, the roster is still checked.
    const held = world();
    expect((await revokeRentedNode(deps(held), held.box.keys.nodeId, true)).outcome).toBe("held");
    expect(held.queued()).toHaveLength(0);
    held.revokeByHand();
    expect((await revokeRentedNode(deps(held), held.box.keys.nodeId, true)).outcome).toBe("already");
    // Never this machine itself.
    const mine = await revokeRentedNode(deps(away), away.bea.keys.nodeId);
    expect(mine.outcome).toBe("refused");
  });
});

describe("an ended rental whose machine never showed is not closed before this daemon has synced with the authority", () => {
  test("a daemon that was away during the rental: the admission arrives with the first sync and the machine is revoked, not forgotten", async () => {
    const w = world({ lateJoin: true });
    w.syncedAt = null; // asleep or cut off: no sync with the authority since the rental ended
    w.advance(REVOKE_WATCH_MS + 60_000); // the site ended it long ago; this is the daemon's first round
    const svc = w.service();
    await svc.pollOnce();
    expect(w.rec()).toMatchObject({ revoked: false, closed: false, node_id: null });
    await svc.pollOnce();
    expect(w.rec().closed).toBe(false); // still no sync: still open
    // The sync with the authority brings the admission.
    expect(w.joinLate()).toBe("accepted");
    w.syncedAt = w.clock();
    w.authority.up = true;
    await svc.pollOnce();
    expect(w.rec()).toMatchObject({ revoked: true, closed: true, node_id: w.box.keys.nodeId });
    expect(w.revokedOnRoster()).toBe(true);
  });

  test("closed only after a sync that is later than the rental's last usable code (a sync from before it proves nothing)", async () => {
    const w = world({ lateJoin: true });
    w.advance(REVOKE_WATCH_MS + 60_000);
    w.syncedAt = w.endedAt + REVOKE_WATCH_MS - 1_000; // level with the authority, but while a code could still be used
    const svc = w.service();
    await svc.pollOnce();
    expect(w.rec()).toMatchObject({ closed: false, node_id: null });
    w.syncedAt = w.clock(); // a later sync: everything the authority admitted is here, and nothing is this rental's
    await svc.pollOnce();
    expect(w.rec()).toMatchObject({ revoked: false, closed: true, node_id: null });
  });

  test("the authority's own daemon has nothing to sync: closes as soon as the window is over; a daemon with no sync source never closes", async () => {
    const w = world({ strayNode: "f".repeat(16) });
    w.advance(REVOKE_WATCH_MS + 60_000);
    await w.service().pollOnce();
    expect(w.rec().closed).toBe(true);
    const blind = world({ strayNode: "f".repeat(16) });
    blind.advance(REVOKE_WATCH_MS + 60_000);
    await blind.service(blind.core, false).pollOnce();
    expect(blind.rec().closed).toBe(false);
  });
});

describe("owners are told when an unseen rental can't be closed for lack of a level sync with the authority", () => {
  const alerts = async (svc: ComputeService) => ((await svc.state()) as ComputeState).alerts;

  test("past its window with no level sync: the alert; once the sync comes (nothing ever joined) it closes and the alert goes", async () => {
    const w = world({ lateJoin: true });
    w.syncedAt = null; // mixed transport with no shared transport to the authority, or it is offline
    const svc = w.service();
    await svc.pollOnce();
    expect(await alerts(svc)).toBeUndefined(); // the window is not over: nothing is wrong yet
    w.advance(REVOKE_WATCH_MS + 60_000);
    await svc.pollOnce();
    expect(w.rec().closed).toBe(false);
    expect(await alerts(svc)).toEqual(["revocation_waiting_for_authority_sync"]);
    w.syncedAt = w.endedAt + REVOKE_WATCH_MS - 1_000; // level, but from before the last usable code: still waiting
    expect(await alerts(svc)).toEqual(["revocation_waiting_for_authority_sync"]);
    w.syncedAt = w.clock();
    await svc.pollOnce();
    expect(w.rec().closed).toBe(true);
    expect(await alerts(svc)).toBeUndefined();
  });

  test("a failed rental (no machine ever) is covered too, and a daemon with no sync source at all says so", async () => {
    const w = world({ lateJoin: true });
    const svc = w.service(w.core, false);
    await svc.pollOnce();
    w.advance(REVOKE_WATCH_MS + 60_000);
    await svc.pollOnce();
    expect(w.rec()).toMatchObject({ closed: false, node_id: null });
    expect(await alerts(svc)).toEqual(["revocation_waiting_for_authority_sync"]);
  });

  test("not raised while the machine is being revoked (that is pending/refused), nor on the authority's own daemon", async () => {
    const w = world();
    w.syncedAt = null;
    const svc = w.service();
    await svc.pollOnce();
    w.advance(REVOKE_WATCH_MS + 60_000);
    await svc.pollOnce();
    expect(await alerts(svc)).toEqual(["revocation_pending"]); // a machine was seen: it is queued, not waiting for a sync
    const own = world({ authority: true, strayNode: "f".repeat(16) });
    const ownSvc = own.service();
    await ownSvc.pollOnce();
    own.advance(REVOKE_WATCH_MS + 60_000);
    await ownSvc.pollOnce();
    expect(own.rec().closed).toBe(true);
    expect(await alerts(ownSvc)).toBeUndefined();
  });
});

describe("a refused revocation backs off, and the alert stays", () => {
  test("asked again after 1 round, 2, 4, … never more often, up to an hour; roster checks and the alert go on every round", async () => {
    const w = world();
    w.authority.up = true;
    w.authority.refuse = true;
    const svc = w.service();
    await svc.pollOnce();
    expect(w.authority.requests).toHaveLength(1);
    expect(w.rec().revoke).toMatchObject({ state: "refused", attempts: 1, retry_at: w.clock() + 60_000 });
    await svc.pollOnce(); // the same minute: nothing sent
    expect(w.authority.requests).toHaveLength(1);
    const delays: number[] = [];
    for (let attempt = 2; attempt <= 10; attempt++) {
      const retryAt = w.rec().revoke!.retry_at!;
      w.advance(retryAt - w.clock() - 1_000);
      await svc.pollOnce(); // just before: held
      expect(w.authority.requests).toHaveLength(attempt - 1);
      expect(((await svc.state()) as ComputeState).alerts).toEqual(["revocation_refused"]);
      w.advance(1_000);
      await svc.pollOnce(); // due
      expect(w.authority.requests).toHaveLength(attempt);
      delays.push(w.rec().revoke!.retry_at! - w.clock());
    }
    expect(delays.slice(0, 5)).toEqual([120_000, 240_000, 480_000, 960_000, 1_920_000]);
    expect(Math.max(...delays)).toBe(REFUSED_RETRY_MAX_MS);
    expect(delays.at(-1)).toBe(REFUSED_RETRY_MAX_MS);
    expect(w.rec()).toMatchObject({ revoked: false, closed: false });
    expect(w.audit()).toHaveLength(1);
  });

  test("an owner revoking it by hand while a refusal is backing off ends it at the next round, without waiting out the backoff", async () => {
    const w = world();
    w.authority.up = true;
    w.authority.refuse = true;
    const svc = w.service();
    await svc.pollOnce();
    w.advance(60_000);
    await svc.pollOnce();
    expect(w.rec().revoke).toMatchObject({ state: "refused", attempts: 2 });
    expect(w.revokeByHand()).toBe("accepted");
    w.advance(1_000); // far inside the backoff
    await svc.pollOnce();
    expect(w.rec()).toMatchObject({ revoked: true, closed: true });
    expect(w.rec().revoke).toBeUndefined();
    expect(w.authority.requests).toHaveLength(2);
    expect(((await svc.state()) as ComputeState).alerts).toBeUndefined();
  });
});

describe("a rentals file this version can't read is never read as empty and written back", () => {
  const UNKNOWN = (path: string) => {
    const file = JSON.parse(readFileSync(path, "utf8")) as { rentals: Record<string, Record<string, unknown>> };
    file.rentals[RENTAL] = { ...file.rentals[RENTAL], from_a_newer_walkie: true };
    writeFileSync(path, JSON.stringify(file) + "\n");
    return readFileSync(path, "utf8");
  };

  test("the round refuses to run, leaves the file byte for byte as it was, and sends nothing", async () => {
    const w = world();
    w.authority.up = true;
    w.advance(REVOKE_WATCH_MS + 60_000);
    const original = readFileSync(rentalsPath(w.core.paths.home), "utf8");
    const before = UNKNOWN(rentalsPath(w.core.paths.home));
    const svc = w.service();
    await expect(svc.pollOnce()).rejects.toBeInstanceOf(RentalsFileError);
    expect(readFileSync(rentalsPath(w.core.paths.home), "utf8")).toBe(before);
    expect(w.authority.requests).toHaveLength(0);
    expect(w.revokedOnRoster()).toBe(false);
    expect(svc.pending()).toBe(true); // needs attention
    // What owners are shown does not fail with it, and says revocations are paused (the alert is computed outside the file).
    const shown = (await svc.state()) as ComputeState;
    expect(shown.rentals).toHaveLength(1);
    expect(shown.alerts).toEqual(["compute_records_unreadable"]);
    // Fixed: the next round runs on the records again and revokes the machine.
    writeFileSync(rentalsPath(w.core.paths.home), original);
    await svc.pollOnce();
    expect(w.rec()).toMatchObject({ revoked: true, closed: true });
    expect(w.revokedOnRoster()).toBe(true);
    expect(((await svc.state()) as ComputeState).alerts).toBeUndefined();
  });

  test("alerts that live in the file (a revocation waiting on the authority) give way to the unreadable-file alert, and return when it is fixed", async () => {
    const w = world();
    const svc = w.service();
    await svc.pollOnce();
    expect(((await svc.state()) as ComputeState).alerts).toEqual(["revocation_pending"]);
    const original = readFileSync(rentalsPath(w.core.paths.home), "utf8");
    UNKNOWN(rentalsPath(w.core.paths.home));
    expect(((await svc.state()) as ComputeState).alerts).toEqual(["compute_records_unreadable"]);
    writeFileSync(rentalsPath(w.core.paths.home), original);
    expect(((await svc.state()) as ComputeState).alerts).toEqual(["revocation_pending"]);
  });

  test("renting is refused before anything is paid for or minted", async () => {
    const w = world();
    UNKNOWN(rentalsPath(w.core.paths.home));
    const before = w.siteCalls.length;
    const refused = await w.service().rent("bea", { machines: [{ tier: "agent", count: 1 }] }).then(() => null, (e: { status?: number; code?: string }) => e);
    expect(refused).toMatchObject({ status: 500, code: "compute_records_unreadable" });
    expect(w.siteCalls.slice(before).filter((u) => u.endsWith("/api/compute/rent"))).toEqual([]);
  });
});
