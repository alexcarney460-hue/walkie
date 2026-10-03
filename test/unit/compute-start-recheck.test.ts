// WALK-107: a queued rental's owner check runs before mint() and record(), then site.start() is not checked
// again. These tests pause inside those two calls (a prototype wrap: the base commit has no test hook) and demote
// the machine's person while the call is in flight. On the base commit the site is still asked to start, and the
// minted code is usable again once the person is made an owner within the hour. A person who stays an owner is the
// control: that one passes on the base commit too. The lost-rent case pauses inside the first replay and demotes
// before the second pending rent is sent.
//
// The follow-up bounds who may restate a node just to mark an invite used. On the base commit a member's restate
// is refused (`not_owner`). The tests below require the narrow allowance (own code, within an hour of demotion,
// at most 8) and refuse the flood, so they fail on the base commit and on the unbounded allowance.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { loadPending, loadRentals, saveAccounts, savePending } from "../../src/daemon/compute/files.ts";
import { invitedNodes } from "../../src/daemon/compute/nodes.ts";
import { ComputeService, type ComputeDeps } from "../../src/daemon/compute/service.ts";
import { ComputeSite } from "../../src/daemon/compute/site.ts";
import { rosterProof } from "../../src/daemon/compute/team-proof.ts";
import type { Core } from "../../src/daemon/core.ts";
import { HttpError } from "../../src/daemon/http.ts";
import { checkInvite, createInvite, inviteMintPos } from "../../src/daemon/invite.ts";
import { mintInviteCode, type MintedInvite } from "../../src/daemon/invite-mint.ts";
import type { Logger } from "../../src/daemon/logger.ts";
import { PeerCallError, type PeerAddr, type PeerClient } from "../../src/daemon/peer-client.ts";
import { applyRequest, flushRequests, queuedView, signRequest } from "../../src/daemon/requests.ts";
import { applyRosterEvent, EMPTY_ROSTER, endpointHex, nodeMember, requestAllowed, transportFields, type Roster } from "../../src/daemon/roster.ts";
import { SyncManager } from "../../src/daemon/sync.ts";
import { FUTURE_SKEW_MS } from "../../src/license/plans.ts";
import { RENTAL_CODE_TTL_MS, type ComputeState, type RentalView, type RentResult } from "../../src/protocol/compute.ts";
import type { Event, RosterRequest } from "../../src/protocol/schemas.ts";
import { teamAuthority } from "../../site/api/_lib/compute/team-proof.ts";
import { pre12FoldNodes, type Pre12Node } from "../fixtures/pre12-team-node-fold.ts";
import { makeCore } from "../helpers/core.ts";
import { tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  restoreProto();
  while (cleanups.length) cleanups.pop()?.();
});

const RENTAL = "r_00000000000000a1";
const ACCOUNT = "ca_00000000000000c1";
const TOKEN = "T".repeat(43);
const OWNER_LOST = "@alex is no longer a team owner (renting compute is an owner's), so this machine's rentals are not started";

const needsCode: RentalView = {
  id: RENTAL, tier: "agent", name: "rent-agent-7f3a", state: "needs_code", queue_position: null,
  price_per_hour_micros: 750_000, spent_micros: 0, created_at: 1_700_000_000_000, started_at: null, ended_at: null,
  end_reason: null, node_id: null, idle_minutes: 30,
};

interface Hold { entered: Promise<void>; hold: Promise<void>; arm: () => void; release: () => void }
function hold(): Hold {
  let arm!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { arm = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return { entered, hold: gate, arm, release };
}

type MintFn = (this: ComputeService, handle: string) => Promise<MintedInvite>;
type RecordFn = (this: ComputeService, ...args: never[]) => Promise<void>;
type SerialFn = (this: ComputeService, fn: () => Promise<unknown>) => Promise<unknown>;
const proto = ComputeService.prototype as unknown as { mint: MintFn; record: RecordFn; serial: SerialFn };
const origMint = proto.mint;
const origRecord = proto.record;
const origSerial = proto.serial;
function restoreProto(): void {
  proto.mint = origMint;
  proto.record = origRecord;
  proto.serial = origSerial;
}

const hex32 = (): string => randomBytes(16).toString("hex");

function segmentHops(head: { prev?: unknown } | undefined): number {
  let hops = 0;
  let cur = head;
  const seen = new Set<object>();
  while (cur?.prev && !seen.has(cur)) {
    seen.add(cur);
    hops++;
    cur = cur.prev as { prev?: unknown };
  }
  return hops;
}

interface LogLine { event: string; fields: Record<string, unknown> }

function nodeSnapshot(nodes: ReadonlyMap<string, object>): object[] {
  return [...nodes.values()].map((n) => ({ ...n })).sort((a, b) => {
    const ia = String((a as { node_id?: string }).node_id);
    const ib = String((b as { node_id?: string }).node_id);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

/**
 * Fold the same chain with this tree and with the pre.12 node fold
 * (test/fixtures/pre12-team-node-fold.ts, copied from 66ccde8e). No git, no shared temp dir.
 */
function foldsOf(events: readonly Event[]): { oldNodes: object[]; newNodes: object[] } {
  let old = new Map<string, Pre12Node>();
  let next: Roster = EMPTY_ROSTER;
  for (const ev of events) {
    old = pre12FoldNodes(old, ev);
    next = applyRosterEvent(next, ev);
  }
  return { oldNodes: nodeSnapshot(old), newNodes: nodeSnapshot(next.nodes) };
}

async function until(pred: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > 4000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface WorldOpts {
  /** The authority answers the spend request with 403, as a pre.12 authority would. */
  readonly refuseSpend?: boolean;
  /** What GET /api/compute/state lists. Lost-rent replay has nothing waiting for a code. */
  readonly rentals?: "needs_code" | "none";
  /** After the request is recorded, before the authority answers. A delay here is a slow authority. */
  readonly beforeSpend?: () => Promise<void> | void;
}

function world(o: WorldOpts = {}) {
  const bea = tnode("bea");
  const alex = tnode("alex");
  const authority = makeCore(bea, "0000000000000000", cleanups);
  authority.store.deleteMeta("team");
  authority.createTeam("acme", "bea", { login: bea.login });
  const team = authority.teamId as string;
  authority.emit("team.node", {
    node_id: bea.keys.nodeId, login: bea.login, hostname: bea.hostname, pubkey: bea.keys.pubkey,
    ip: "127.0.0.1", port: 7458, transports: ["tailscale", "direct"], endpoint: endpointHex(bea.keys.pubkey),
    peer_sig_v1: true,
  });
  authority.emit("team.member", { login: alex.login, handle: alex.handle, role: "owner" });
  authority.emit("team.node", {
    node_id: alex.keys.nodeId, login: alex.login, hostname: alex.hostname, pubkey: alex.keys.pubkey, ip: "127.0.0.1", port: 7458,
  });
  const daemon = makeCore(alex, team, cleanups);
  const sync = (): void => {
    for (const ev of authority.rosterEntries()) {
      if (daemon.store.getRow(ev.id)) continue;
      const res = daemon.ingest(ev, "remote");
      if (res.status !== "accepted") throw new Error(`sync ${ev.kind} ${res.status} ${res.reason ?? ""}`);
    }
  };
  sync();
  saveAccounts(daemon.paths.home, [{ account_id: ACCOUNT, team, token: TOKEN }]);

  const logs: LogLine[] = [];
  const log = {
    debug: () => undefined,
    info: (event: string, fields: Record<string, unknown> = {}) => logs.push({ event, fields }),
    warn: (event: string, fields: Record<string, unknown> = {}) => logs.push({ event, fields }),
    error: (event: string, fields: Record<string, unknown> = {}) => logs.push({ event, fields }),
  } as Logger;
  const requests: RosterRequest[] = [];
  const client = {
    addrOf: () => ({ kind: "direct" } as unknown as PeerAddr),
    rosterRequest: async (_addr: PeerAddr, req: RosterRequest) => {
      requests.push(req);
      if (o.beforeSpend) await o.beforeSpend();
      if (o.refuseSpend) throw new PeerCallError(403, "forbidden", "request refused: not_owner");
      const event = applyRequest(authority, req);
      sync();
      return { event: event ? { id: event.id, seq: event.seq } : null };
    },
  } as unknown as PeerClient;
  const catchUp = async () => { sync(); };

  const starts: { rental_id: string; code: string }[] = [];
  let rents = 0;
  let onFirstRent: (() => void) | null = null;
  const rental = needsCode;
  const state = (rentals: RentalView[]): ComputeState => ({
    account_id: ACCOUNT, team_id: team, status: "active", balance_micros: 1_000_000, burn_per_hour_micros: 0,
    hours_left: null, rentals,
  });
  const rentAnswer: RentResult = { rentals: [], started: 0, queued: 1, code_index: {}, balance_micros: 1_000_000, replay: false };
  const site = new ComputeSite({ base: "https://fixture.test", fetch: async (url, init) => {
    const path = String(url);
    if (path.endsWith("/api/compute/state")) return Response.json(state(o.rentals === "none" ? [] : [rental]));
    if (path.endsWith("/api/compute/rent")) {
      rents++;
      if (rents === 1) onFirstRent?.();
      return Response.json(rentAnswer);
    }
    if (path.endsWith("/api/compute/start")) {
      starts.push(JSON.parse(String(init?.body ?? "{}")) as { rental_id: string; code: string });
      return Response.json({ rental: { ...rental, state: "starting", started_at: rental.created_at } });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  } });
  const service = new ComputeService(
    { core: daemon, client, catchUp, log, transport: () => undefined } as unknown as ComputeDeps,
    { site, version: "v0.2.0-pre.11" },
  );
  const setRole = (role: "owner" | "member" | "observer" | "removed"): void => {
    authority.emit("team.member", { login: alex.login, handle: alex.handle, role });
    sync();
  };
  return {
    bea, alex, authority, daemon, team, service, logs, requests, starts, setRole, sync, client, catchUp,
    get rents() { return rents; },
    set onFirstRent(fn: () => void) { onFirstRent = fn; },
    restate(invite?: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
      const n = authority.roster.nodes.get(alex.keys.nodeId)!;
      return {
        node_id: n.node_id, login: n.login, hostname: n.hostname, pubkey: n.pubkey, ip: n.ip, port: n.port,
        ...transportFields(n), ...(n.peer_sig_v1 ? { peer_sig_v1: true } : {}),
        ...(invite ? { invite } : {}), ...patch,
      };
    },
  };
}

/** Resolves "held" once the wrapper pauses, or "finished" if the poll ends (or throws) without pausing. */
function heldOrDone(poll: Promise<void>, entered: Promise<void>): Promise<"held" | "finished"> {
  return Promise.race([
    entered.then(() => "held" as const),
    poll.then(() => "finished" as const, () => "finished" as const),
  ]);
}

function refused(logs: LogLine[], event: string): LogLine[] {
  return logs.filter((l) => l.event === event);
}

type World = ReturnType<typeof world>;

/** Every roster origin's highest seq on the authority, as its version vector answers it. */
function authorityVv(w: World): Record<string, number> {
  const vv: Record<string, number> = {};
  for (const ev of w.authority.rosterEntries()) vv[ev.origin] = Math.max(vv[ev.origin] ?? 0, ev.seq);
  return vv;
}

/** A peer client for the daemon: answers from the authority's own copy, records what is sent, applies it there. */
function authorityClient(w: World, sent: RosterRequest[], over: Record<string, unknown> = {}): PeerClient {
  return {
    addrOf: () => ({ ip: "127.0.0.1", port: 7458 }),
    vv: async () => ({ vv: authorityVv(w), online: [], capabilities: { caps: [] } }),
    pull: async (_addr: PeerAddr, origin: string, after: number) => ({
      events: w.authority.rosterEntries().filter((ev) => ev.origin === origin && ev.seq > after),
    }),
    pullIds: async () => ({ events: [] }),
    rosterRequest: async (_addr: PeerAddr, req: RosterRequest) => {
      sent.push(req);
      const ev = applyRequest(w.authority, req);
      return { event: ev ? { id: ev.id, seq: ev.seq } : null };
    },
    ...over,
  } as unknown as PeerClient;
}

/** Pins Walkie Direct on the alex machine at the authority only: this daemon has not pulled it. */
function pinDirectAtAuthority(w: World): void {
  const n = w.authority.roster.nodes.get(w.alex.keys.nodeId)!;
  w.authority.emit("team.node", {
    node_id: n.node_id, login: n.login, hostname: n.hostname, pubkey: n.pubkey, ip: n.ip, port: n.port,
    endpoint: endpointHex(n.pubkey), transports: ["tailscale", "direct"], peer_sig_v1: true,
  });
}

/** Queues an owner's restate that marks one invite id used (the id alone), with a fixed creation time. */
function queueSpendAt(w: World, at: number): string {
  const id = hex32();
  const q = signRequest(w.daemon, "team.node", w.restate(id));
  w.daemon.store.queueRequest(q.id, JSON.stringify(q));
  w.daemon.store.db.query("UPDATE roster_requests SET created_at = ? WHERE id = ?").run(at, q.id);
  return id;
}

function queueChannelAt(w: World, name: string, at: number): void {
  const q = signRequest(w.daemon, "channel.upsert", { name });
  w.daemon.store.queueRequest(q.id, JSON.stringify(q));
  w.daemon.store.db.query("UPDATE roster_requests SET created_at = ? WHERE id = ?").run(at, q.id);
}

const queuedSpends = (w: World): number => w.daemon.store.queuedRequests(5000).filter((q) => q.json.includes('"invite"')).length;

describe("WALK-107 queued rental start rechecks the owner", () => {
  test("demotion during mint: the queued machine does not start, and the code cannot be used after a re-promotion", async () => {
    const w = world();
    const slot = hold();
    let mints = 0;
    let minted: MintedInvite | null = null;
    proto.mint = async function (this: ComputeService, handle: string) {
      mints++;
      const inv = await origMint.call(this, handle);
      minted = inv;
      slot.arm();
      await slot.hold;
      return inv;
    };
    const poll = w.service.pollOnce();
    const which = await heldOrDone(poll, slot.entered);
    if (which !== "held") {
      await poll;
      throw new Error("the poll finished before mint paused");
    }
    w.setRole("member");
    slot.release();
    await poll;

    expect(w.starts).toHaveLength(0);
    expect(mints).toBe(1);
    expect(refused(w.logs, "compute_start_refused")).toEqual([
      { event: "compute_start_refused", fields: { rental: RENTAL, reason: OWNER_LOST } },
    ]);
    const rec = loadRentals(w.daemon.paths.home)[RENTAL];
    expect(rec?.state).toBe("needs_code");
    expect(rec?.invite_ids ?? []).not.toContain(minted!.id);
    expect(w.daemon.roster.nodes.get(w.alex.keys.nodeId)?.revoked).toBe(false);
    expect(w.authority.roster.nodes.get(w.alex.keys.nodeId)?.revoked).toBe(false);
    const code = minted!.code;
    expect(code.length).toBeGreaterThan(40);
    expect(JSON.stringify(w.logs)).not.toContain(code);
    expect(JSON.stringify(w.authority.rosterEntries())).not.toContain(code);
    expect(w.requests).toHaveLength(1);
    expect(w.requests[0]!.body.invite).toBe(minted!.id);
    expect(w.requests[0]!.body.invite_code).toBe(code);
    expect(w.requests[0]!.body.node_id).toBe(w.alex.keys.nodeId);

    await w.service.pollOnce();
    expect(mints).toBe(1);
    expect(w.starts).toHaveLength(0);
    expect(refused(w.logs, "compute_start_refused")).toHaveLength(1);
    expect(w.requests).toHaveLength(1);

    w.setRole("owner");
    expect(checkInvite(code, w.authority.roster, w.team, w.daemon.clock())).toEqual({ ok: false, reason: "invite_used" });
    expect(checkInvite(code, w.daemon.roster, w.team, w.daemon.clock())).toEqual({ ok: false, reason: "invite_used" });
  });

  test("demotion during record: the queued machine does not start, and the code cannot be used after a re-promotion", async () => {
    const w = world();
    const slot = hold();
    let mints = 0;
    let minted: MintedInvite | null = null;
    proto.mint = async function (this: ComputeService, handle: string) {
      mints++;
      minted = await origMint.call(this, handle);
      return minted;
    };
    let records = 0;
    proto.record = async function (this: ComputeService, ...args: never[]) {
      records++;
      await origRecord.call(this, ...args);
      if (records === 1) {
        slot.arm();
        await slot.hold;
      }
    };
    const poll = w.service.pollOnce();
    const which = await heldOrDone(poll, slot.entered);
    if (which !== "held") {
      await poll;
      throw new Error("the poll finished before record paused");
    }
    w.setRole("observer");
    slot.release();
    await poll;

    expect(w.starts).toHaveLength(0);
    expect(mints).toBe(1);
    expect(records).toBe(1);
    expect(refused(w.logs, "compute_start_refused")).toEqual([
      { event: "compute_start_refused", fields: { rental: RENTAL, reason: OWNER_LOST } },
    ]);
    const rec = loadRentals(w.daemon.paths.home)[RENTAL];
    expect(rec?.state).toBe("needs_code");
    expect(rec?.invite_ids ?? []).not.toContain(minted!.id);
    expect(w.authority.roster.nodes.get(w.alex.keys.nodeId)?.revoked).toBe(false);
    const code = minted!.code;
    expect(JSON.stringify(w.authority.rosterEntries())).not.toContain(code);
    expect(JSON.stringify(w.logs)).not.toContain(code);

    await w.service.pollOnce();
    expect(mints).toBe(1);
    expect(w.starts).toHaveLength(0);
    expect(refused(w.logs, "compute_start_refused")).toHaveLength(1);

    w.setRole("owner");
    expect(checkInvite(code, w.authority.roster, w.team, w.daemon.clock())).toEqual({ ok: false, reason: "invite_used" });
  });

  test("still an owner: a pause during mint and record still starts the queued machine", async () => {
    const w = world();
    let minted: MintedInvite | null = null;
    proto.mint = async function (this: ComputeService, handle: string) {
      minted = await origMint.call(this, handle);
      await Bun.sleep(20);
      return minted;
    };
    proto.record = async function (this: ComputeService, ...args: never[]) {
      await origRecord.call(this, ...args);
      await Bun.sleep(20);
    };
    await w.service.pollOnce();
    expect(w.starts).toEqual([{ rental_id: RENTAL, code: minted!.code }]);
    expect(w.logs.some((l) => l.event === "compute_started_from_queue" && l.fields.invite === minted!.id)).toBe(true);
    expect(refused(w.logs, "compute_start_refused")).toHaveLength(0);
    // The same round's state poll still says needs_code, and settle writes that back. The code stays on the record.
    const rec = loadRentals(w.daemon.paths.home)[RENTAL];
    expect(rec?.state).toBe("needs_code");
    expect(rec?.invite_ids).toContain(minted!.id);
    expect(checkInvite(minted!.code, w.authority.roster, w.team, w.daemon.clock()).ok).toBe(true);
    expect(w.requests).toHaveLength(0);
    expect(w.authority.roster.nodes.get(w.alex.keys.nodeId)?.revoked).toBe(false);
  });

  test("a lost rent is checked again before each replay: the second pending rent stays when the role is lost during the first", async () => {
    const w = world({ rentals: "none" });
    const first = "ab".repeat(16);
    const second = "cd".repeat(16);
    const firstKey = "pending-key-aaaaaa";
    const secondKey = "pending-key-bbbbbb";
    const secondCode = "d".repeat(40);
    savePending(w.daemon.paths.home, [
      { account_id: ACCOUNT, invite_ids: [first], body: { idempotency_key: firstKey, machines: [{ tier: "agent", count: 1 }], codes: ["c".repeat(40)], walkie_version: "v0.2.0-pre.12" } },
      { account_id: ACCOUNT, invite_ids: [second], body: { idempotency_key: secondKey, machines: [{ tier: "agent", count: 1 }], codes: [secondCode], walkie_version: "v0.2.0-pre.12" } },
    ]);
    w.onFirstRent = () => w.setRole("member");
    await w.service.pollOnce();
    expect(w.rents).toBe(1);
    const pending = loadPending(w.daemon.paths.home);
    expect(pending.map((p) => p.body.idempotency_key)).toEqual([secondKey]);
    expect(pending[0]!.invite_ids).toEqual([second]);
    expect(pending[0]!.body.codes).toEqual([secondCode]);
    expect(refused(w.logs, "compute_rent_refused")).toEqual([
      { event: "compute_rent_refused", fields: { reason: OWNER_LOST } },
    ]);
    expect(w.logs.some((l) => l.event === "compute_invite_spent" || l.event === "compute_invite_spend_failed")).toBe(false);
    expect(w.authority.roster.invites?.has(first) ?? false).toBe(false);
    expect(w.authority.roster.invites?.has(second) ?? false).toBe(false);
    expect(w.daemon.roster.invites?.has(second) ?? false).toBe(false);
    expect(w.starts).toHaveLength(0);
  });

  test("a pre.12 authority that refuses the spend: this daemon still will not honour the code, and the poll does not throw", async () => {
    const w = world({ refuseSpend: true });
    const slot = hold();
    let minted: MintedInvite | null = null;
    proto.mint = async function (this: ComputeService, handle: string) {
      minted = await origMint.call(this, handle);
      slot.arm();
      await slot.hold;
      return minted;
    };
    const poll = w.service.pollOnce();
    const which = await heldOrDone(poll, slot.entered);
    if (which !== "held") {
      await poll;
      throw new Error("the poll finished before mint paused");
    }
    w.setRole("member");
    slot.release();
    await poll;
    expect(w.starts).toHaveLength(0);
    expect(refused(w.logs, "compute_start_refused")).toHaveLength(1);
    expect(w.logs.some((l) => l.event === "compute_invite_spend_failed" && l.fields.invite === minted!.id && l.fields.err === "forbidden")).toBe(true);
    expect(JSON.stringify(w.logs)).not.toContain(minted!.code);
    w.setRole("owner");
    expect(checkInvite(minted!.code, w.daemon.roster, w.team, w.daemon.clock())).toEqual({ ok: false, reason: "invite_used" });
    expect(checkInvite(minted!.code, w.authority.roster, w.team, w.daemon.clock()).ok).toBe(true);
  });

  test("a demoted owner may mark only their own code used, and only within the hour", async () => {
    const w = world();
    const nodeId = w.alex.keys.nodeId;
    const owner = nodeMember(w.authority.roster, nodeId)!;
    // An owner may still restate with a bare id. The cap is only for members and observers.
    expect(requestAllowed("team.node", w.restate(hex32()), w.authority.roster, owner, nodeId)).toEqual({ status: "ok" });
    const minted = await mintInviteCode(w.daemon, undefined, w.alex.handle, "member", { ttlMs: RENTAL_CODE_TTL_MS });
    w.setRole("member");
    const member = nodeMember(w.authority.roster, nodeId)!;
    const now = w.authority.clock();
    const demotedAt = member.demoted_ts ?? now;
    const withCode = (id: string, code?: string, patch: Record<string, unknown> = {}): Record<string, unknown> => ({
      ...w.restate(id, patch), ...(code ? { invite_code: code } : {}),
    });
    const allow = (body: Record<string, unknown>, who = member, at?: number, node: string | undefined = nodeId) =>
      requestAllowed("team.node", body, w.authority.roster, who, node, at);
    expect(allow(withCode(minted.id, minted.code), member, now)).toEqual({ status: "ok" });
    expect(allow(withCode(minted.id, minted.code), member, demotedAt + RENTAL_CODE_TTL_MS)).toEqual({ status: "ok" });
    expect(allow(withCode(minted.id, minted.code), member, demotedAt - FUTURE_SKEW_MS)).toEqual({ status: "ok" });
    expect(allow(withCode(minted.id, minted.code), member, demotedAt + RENTAL_CODE_TTL_MS + 1)).toEqual({ status: "reject", reason: "not_owner" });
    expect(allow(withCode(minted.id, minted.code), member, demotedAt - FUTURE_SKEW_MS - 1)).toEqual({ status: "reject", reason: "not_owner" });
    expect(allow(withCode(minted.id, minted.code), member)).toEqual({ status: "reject", reason: "not_owner" });
    expect(allow(w.restate(minted.id), member, now)).toEqual({ status: "reject", reason: "not_owner" });
    expect(allow(withCode(hex32(), minted.code), member, now)).toEqual({ status: "reject", reason: "not_owner" });
    // No machine named: not an invite spend, even with the code. (A default parameter would swallow `undefined`.)
    expect(requestAllowed("team.node", withCode(minted.id, minted.code), w.authority.roster, member, undefined, now)).toEqual({ status: "reject", reason: "not_owner" });
    w.setRole("observer");
    const observer = nodeMember(w.authority.roster, nodeId)!;
    expect(allow(withCode(minted.id, minted.code), observer, w.authority.clock())).toEqual({ status: "ok" });
    const rejected = [
      withCode(minted.id, minted.code, { ip: "10.1.0.9" }),
      { ...withCode(minted.id, minted.code), revoked: true },
      { ...withCode(minted.id, minted.code), node_id: w.bea.keys.nodeId },
      w.restate(),
      { ...withCode(minted.id, minted.code), peer_sig_strict: false },
      { ...withCode(minted.id, minted.code), transports: ["tailscale"] },
      { ...withCode(minted.id, minted.code), peer_sig_v1: true },
    ];
    for (const body of rejected) {
      expect(allow(body, observer, w.authority.clock())).toEqual({ status: "reject", reason: "not_owner" });
    }
    const olive = tnode("olive");
    w.authority.emit("team.member", { login: olive.login, handle: olive.handle, role: "member" });
    w.authority.emit("team.node", {
      node_id: olive.keys.nodeId, login: olive.login, hostname: olive.hostname, pubkey: olive.keys.pubkey, ip: "127.0.0.1", port: 7458,
    });
    const oliveNode = w.authority.roster.nodes.get(olive.keys.nodeId)!;
    const oliveCode = createInvite(olive.keys, {
      team: w.team, authority: w.authority.roster.nodes.get(w.bea.keys.nodeId)!.pubkey, handle: olive.handle, role: "member",
      now: w.authority.clock(), pos: inviteMintPos(w.authority.roster),
    });
    const oliveMember = nodeMember(w.authority.roster, olive.keys.nodeId)!;
    expect(requestAllowed("team.node", {
      node_id: oliveNode.node_id, login: oliveNode.login, hostname: oliveNode.hostname, pubkey: oliveNode.pubkey,
      ip: oliveNode.ip, port: oliveNode.port, invite: oliveCode.id, invite_code: oliveCode.code,
    }, w.authority.roster, oliveMember, olive.keys.nodeId, w.authority.clock())).toEqual({ status: "reject", reason: "not_owner" });
    applyRequest(w.authority, signRequest(w.daemon, "team.node", withCode(minted.id, minted.code)));
    const stored = JSON.stringify(w.authority.rosterEntries());
    expect(stored).not.toContain(minted.code);
    expect(stored).not.toContain("invite_code");
    expect(w.authority.roster.invites?.has(minted.id)).toBe(true);
  });

  test("PROBE eight own codes per demotion, and the ninth stays usable", async () => {
    const w = world();
    const codes: MintedInvite[] = [];
    for (let i = 0; i < 9; i++) codes.push(await mintInviteCode(w.daemon, undefined, w.alex.handle, "member", { ttlMs: RENTAL_CODE_TTL_MS }));
    w.setRole("member");
    let accepted = 0;
    for (const inv of codes) {
      try {
        applyRequest(w.authority, signRequest(w.daemon, "team.node", { ...w.restate(inv.id), invite_code: inv.code }));
        accepted++;
      } catch (err) {
        if (accepted < 8) throw err;
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).message).toContain("not_owner");
      }
    }
    expect(accepted).toBe(8);
    // A later demotion to observer does not open a new budget.
    w.setRole("observer");
    expect(() => applyRequest(w.authority, signRequest(w.daemon, "team.node", { ...w.restate(codes[8]!.id), invite_code: codes[8]!.code }))).toThrow(/not_owner/);
    w.setRole("owner");
    expect(checkInvite(codes[0]!.code, w.authority.roster, w.team, w.authority.clock())).toEqual({ ok: false, reason: "invite_used" });
    expect(checkInvite(codes[8]!.code, w.authority.roster, w.team, w.authority.clock()).ok).toBe(true);
    const chain = JSON.stringify(w.authority.rosterEntries());
    expect(chain).not.toContain(codes[0]!.code);
    expect(chain).not.toContain("invite_code");
    // A fresh demotion gives a new budget of 8, so the code the last one refused can still be marked.
    w.setRole("member");
    applyRequest(w.authority, signRequest(w.daemon, "team.node", { ...w.restate(codes[8]!.id), invite_code: codes[8]!.code }));
    w.setRole("owner");
    expect(checkInvite(codes[8]!.code, w.authority.roster, w.team, w.authority.clock())).toEqual({ ok: false, reason: "invite_used" });
  });

  test("PROBE 2100 observer restates are refused and a rental admission stays findable", () => {
    const w = world();
    const box = tnode("noor");
    const admission = hex32();
    w.authority.emit("team.node", {
      node_id: box.keys.nodeId, login: w.bea.login, hostname: "rent-agent-1", pubkey: box.keys.pubkey,
      ip: "", port: 7458, transports: ["direct"], endpoint: endpointHex(box.keys.pubkey), invite: admission, peer_sig_v1: true,
    });
    w.setRole("observer");
    let floodAccepted = 0;
    for (let i = 0; i < 2100; i++) {
      try {
        applyRequest(w.authority, signRequest(w.daemon, "team.node", w.restate(hex32())));
        floodAccepted++;
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
      }
    }
    expect(floodAccepted).toBe(0);
    expect(invitedNodes(w.authority).get(admission)).toBe(box.keys.nodeId);
    const proof = rosterProof(w.authority);
    expect(proof.roster_events.length).toBeLessThanOrEqual(500);
    expect(teamAuthority(w.team, proof)).not.toBeNull();
    expect(w.authority.roster.nodes.get(box.keys.nodeId)?.revoked).toBe(false);
  });

  test("PROBE an observer cannot burn another owner's invite", async () => {
    const w = world();
    const inv = await mintInviteCode(w.authority, undefined, "noor", "member");
    expect(checkInvite(inv.code, w.authority.roster, w.team, w.authority.clock()).ok).toBe(true);
    w.setRole("observer");
    const observer = nodeMember(w.authority.roster, w.alex.keys.nodeId)!;
    const now = w.authority.clock();
    expect(requestAllowed("team.node", { ...w.restate(inv.id), invite_code: inv.code }, w.authority.roster, observer, w.alex.keys.nodeId, now)).toEqual({ status: "reject", reason: "not_owner" });
    expect(() => applyRequest(w.authority, signRequest(w.daemon, "team.node", w.restate(inv.id)))).toThrow(/not_owner/);
    w.setRole("owner");
    expect(checkInvite(inv.code, w.authority.roster, w.team, w.authority.clock()).ok).toBe(true);
  });

  test("PROBE used-invite checkpoints share segments instead of copying every id", () => {
    const w = world();
    const n = w.authority.roster.nodes.get(w.alex.keys.nodeId)!;
    for (let i = 0; i < 600; i++) {
      w.authority.emit("team.node", {
        node_id: n.node_id, login: n.login, hostname: n.hostname, pubkey: n.pubkey, ip: n.ip, port: n.port, invite: hex32(),
      });
    }
    const chain = (w.authority as unknown as { chain: { checkpoints: { invites?: { prev?: unknown; size: number; span?: number } }[] } }).chain;
    const head = w.authority.roster.invites as { prev?: unknown; size: number; span?: number } | undefined;
    const versions = chain.checkpoints.map((c) => c.invites).filter((s): s is NonNullable<typeof s> => !!s && s.size > 0);
    expect(head).toBeDefined();
    versions.push(head!);
    // Several checkpoints, each smaller than the head, and not a private copy of every id.
    expect(versions.length).toBeGreaterThan(10);
    expect(versions[0]!.size).toBeLessThan(head!.size);
    const seen = new Set<object>();
    let uniqueSpan = 0;
    let totalSize = 0;
    for (const version of versions) {
      totalSize += version.size;
      let cur: { prev?: unknown; span?: number } | undefined = version;
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        expect(typeof cur.span).toBe("number");
        uniqueSpan += cur.span as number;
        cur = cur.prev as { prev?: unknown; span?: number } | undefined;
      }
    }
    expect(uniqueSpan * 2).toBeLessThan(totalSize);
    expect(segmentHops(head)).toBeLessThanOrEqual(16);
  });

  test("PROBE a stale spend event folds to the same node record as pre.12", async () => {
    const w = world();
    w.setRole("member");
    const id = hex32();
    const stale = signRequest(w.daemon, "team.node", w.restate(id));
    expect(stale.body.transports).toBeUndefined();
    const n = w.authority.roster.nodes.get(w.alex.keys.nodeId)!;
    w.authority.emit("team.node", {
      node_id: n.node_id, login: n.login, hostname: n.hostname, pubkey: n.pubkey, ip: n.ip, port: n.port,
      endpoint: endpointHex(n.pubkey), transports: ["tailscale", "direct"], peer_sig_v1: true,
    });
    w.setRole("owner");
    applyRequest(w.authority, stale);
    const folded = await foldsOf(w.authority.rosterEntries());
    expect(folded.newNodes).toEqual(folded.oldNodes);
    const mine = folded.oldNodes.find((node) => (node as { node_id: string }).node_id === w.alex.keys.nodeId) as { transports?: string[] };
    // The body that was signed has no transports. Both folds apply that body, so both drop the pin.
    expect(mine.transports).toBeUndefined();
    expect(w.authority.roster.invites?.has(id)).toBe(true);
  });

  test("PROBE a queued spend is sent with the current transports", async () => {
    const w = world();
    w.setRole("member");
    const minted = await mintInviteCode(w.daemon, undefined, w.alex.handle, "member", { ttlMs: RENTAL_CODE_TTL_MS });
    const stale = signRequest(w.daemon, "team.node", { ...w.restate(minted.id), invite_code: minted.code });
    expect(stale.body.transports).toBeUndefined();
    w.daemon.store.queueRequest(stale.id, JSON.stringify(stale));
    const n = w.authority.roster.nodes.get(w.alex.keys.nodeId)!;
    w.authority.emit("team.node", {
      node_id: n.node_id, login: n.login, hostname: n.hostname, pubkey: n.pubkey, ip: n.ip, port: n.port,
      endpoint: endpointHex(n.pubkey), transports: ["tailscale", "direct"], peer_sig_v1: true,
    });
    w.setRole("owner");
    w.sync();
    expect(w.daemon.roster.nodes.get(w.alex.keys.nodeId)?.transports).toEqual(["tailscale", "direct"]);
    await flushRequests(w.daemon, w.client, w.catchUp);
    const after = w.authority.roster.nodes.get(w.alex.keys.nodeId);
    expect(after?.transports).toEqual(["tailscale", "direct"]);
    expect(after?.peer_sig_v1).toBe(true);
    expect(w.authority.roster.invites?.has(minted.id)).toBe(true);
    const ev = w.authority.rosterEntries().at(-1)!;
    expect(ev.kind).toBe("team.node");
    expect((ev.body as { transports?: string[] }).transports).toEqual(["tailscale", "direct"]);
    const chain = JSON.stringify(w.authority.rosterEntries());
    expect(chain).not.toContain(minted.code);
    expect(chain).not.toContain("invite_code");
    const folded = await foldsOf(w.authority.rosterEntries());
    expect(folded.newNodes).toEqual(folded.oldNodes);
    const mine = folded.newNodes.find((node) => (node as { node_id: string }).node_id === w.alex.keys.nodeId) as { transports?: string[] };
    expect(mine.transports).toEqual(["tailscale", "direct"]);
  });

  test("PROBE a queued spend flushed in the same tick waits for the authority pin", async () => {
    const w = world();
    w.setRole("member");
    const minted = await mintInviteCode(w.daemon, undefined, w.alex.handle, "member", { ttlMs: RENTAL_CODE_TTL_MS });
    const stale = signRequest(w.daemon, "team.node", { ...w.restate(minted.id), invite_code: minted.code });
    expect(stale.body.transports).toBeUndefined();
    w.daemon.store.queueRequest(stale.id, JSON.stringify(stale));
    const n = w.authority.roster.nodes.get(w.alex.keys.nodeId)!;
    // On the authority only. The daemon has not pulled this pin yet.
    w.authority.emit("team.node", {
      node_id: n.node_id, login: n.login, hostname: n.hostname, pubkey: n.pubkey, ip: n.ip, port: n.port,
      endpoint: endpointHex(n.pubkey), transports: ["tailscale", "direct"], peer_sig_v1: true,
    });
    expect(w.daemon.roster.nodes.get(w.alex.keys.nodeId)?.transports).toBeUndefined();

    let releaseVv!: () => void;
    const vvGate = new Promise<void>((resolve) => { releaseVv = resolve; });
    let pulled = false;
    const sent: RosterRequest[] = [];
    const client = {
      addrOf: () => ({ ip: "127.0.0.1", port: 7458 }),
      vv: async () => {
        await vvGate;
        const vv: Record<string, number> = {};
        for (const ev of w.authority.rosterEntries()) vv[ev.origin] = Math.max(vv[ev.origin] ?? 0, ev.seq);
        return { vv, online: [], capabilities: { caps: [] } };
      },
      pull: async (_addr: PeerAddr, origin: string, after: number) => {
        const events = w.authority.rosterEntries().filter((ev) => ev.origin === origin && ev.seq > after);
        pulled = events.length > 0;
        return { events };
      },
      pullIds: async () => ({ events: [] }),
      rosterRequest: async (_addr: PeerAddr, req: RosterRequest) => {
        sent.push(req);
        return { event: null };
      },
    } as unknown as PeerClient;
    const sync = new SyncManager(w.daemon, client, {});
    try {
      sync.tick();
      // The tick starts the authority sync and the flush together. The flush must not send the stale body first.
      expect(sent).toEqual([]);
      releaseVv();
      await until(() => sent.length >= 1, "flushed spend");
    } finally {
      releaseVv();
    }
    expect(pulled).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.transports).toEqual(["tailscale", "direct"]);
    expect(sent[0]!.body.peer_sig_v1).toBe(true);
    expect(sent[0]!.body.invite).toBe(minted.id);
    expect(sent[0]!.body.invite_code).toBe(minted.code);
    expect(w.daemon.roster.nodes.get(w.alex.keys.nodeId)?.transports).toEqual(["tailscale", "direct"]);
    expect(w.daemon.store.queuedRequests()).toEqual([]);
  });

  test("PROBE a queued spend is dropped when its node is no longer that record", async () => {
    const w = world();
    w.setRole("owner");
    const id = hex32();
    const stale = signRequest(w.daemon, "team.node", { ...w.restate(id), login: "other@example.com" });
    w.daemon.store.queueRequest(stale.id, JSON.stringify(stale));
    await flushRequests(w.daemon, w.client, w.catchUp);
    expect(w.requests).toEqual([]);
    expect(w.daemon.store.queuedRequests()).toEqual([]);
    expect(w.authority.roster.invites?.has(id)).toBeFalsy();
  });

  test("PROBE used-invite lookup walks at most 64 links", async () => {
    const mod = await import("../../src/daemon/roster.ts") as {
      InviteSet?: { of(prev: ReadonlySet<string> | undefined, id: string): ReadonlySet<string> & { prev?: unknown } };
    };
    expect(typeof mod.InviteSet).toBe("function");
    const InviteSet = mod.InviteSet!;
    let s: (ReadonlySet<string> & { prev?: unknown }) | undefined;
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) {
      const id = hex32();
      ids.push(id);
      s = InviteSet.of(s, id);
    }
    if (!s) throw new Error("empty invite set");
    expect(s.size).toBe(200);
    expect(s.has(ids[0]!)).toBe(true);
    expect(s.has(ids[199]!)).toBe(true);
    expect(s.has(hex32())).toBe(false);
    expect(new Set(s).size).toBe(200);
    expect(InviteSet.of(s, ids[10]!)).toBe(s);
    let hops = 0;
    let cur: { prev?: unknown } | undefined = s;
    const seen = new Set<object>();
    while (cur?.prev && !seen.has(cur)) {
      seen.add(cur);
      hops++;
      cur = cur.prev as { prev?: unknown };
    }
    expect(hops).toBeLessThanOrEqual(64);
  });

  test("PROBE a long used-invite list is a few segments", async () => {
    const mod = await import("../../src/daemon/roster.ts") as {
      InviteSet?: { of(prev: ReadonlySet<string> | undefined, id: string): ReadonlySet<string> & { prev?: unknown } };
    };
    expect(typeof mod.InviteSet).toBe("function");
    const InviteSet = mod.InviteSet!;
    let s: (ReadonlySet<string> & { prev?: unknown }) | undefined;
    const ids: string[] = [];
    for (let i = 0; i < 129; i++) {
      const id = hex32();
      ids.push(id);
      s = InviteSet.of(s, id);
    }
    if (!s) throw new Error("empty invite set");
    // 129 one-id links would be 128 hops. Segments that merge within a factor of two stay near log2(129).
    expect(segmentHops(s)).toBeLessThanOrEqual(16);
    expect(s.size).toBe(129);
    expect(s.has(ids[0]!)).toBe(true);
    expect(s.has(ids[128]!)).toBe(true);
    expect(s.has(hex32())).toBe(false);
    expect(new Set(s).size).toBe(129);
    expect(InviteSet.of(s, ids[10]!)).toBe(s);
  });

  test("PROBE a spend stays queued when the authority pull fails after its version vector", async () => {
    const w = world();
    w.setRole("member");
    const minted = await mintInviteCode(w.daemon, undefined, w.alex.handle, "member", { ttlMs: RENTAL_CODE_TTL_MS });
    const queued = signRequest(w.daemon, "team.node", { ...w.restate(minted.id), invite_code: minted.code });
    w.daemon.store.queueRequest(queued.id, JSON.stringify(queued));
    const n = w.authority.roster.nodes.get(w.alex.keys.nodeId)!;
    w.authority.emit("team.node", {
      node_id: n.node_id, login: n.login, hostname: n.hostname, pubkey: n.pubkey, ip: n.ip, port: n.port,
      endpoint: endpointHex(n.pubkey), transports: ["tailscale", "direct"], peer_sig_v1: true,
    });
    // Re-promoted on the authority only. The daemon has not pulled the pin or this role change.
    w.authority.emit("team.member", { login: w.alex.login, handle: w.alex.handle, role: "owner" });
    expect(w.daemon.roster.nodes.get(w.alex.keys.nodeId)?.transports).toBeUndefined();
    const sent: RosterRequest[] = [];
    let pulls = 0;
    const client = {
      addrOf: () => ({ ip: "127.0.0.1", port: 7458 }),
      vv: async () => {
        const vv: Record<string, number> = {};
        for (const ev of w.authority.rosterEntries()) vv[ev.origin] = Math.max(vv[ev.origin] ?? 0, ev.seq);
        return { vv, online: [], capabilities: { caps: [] } };
      },
      pull: async () => { pulls++; throw new PeerCallError(0, "timeout", "pull timed out"); },
      pullIds: async () => ({ events: [] }),
      rosterRequest: async (_addr: PeerAddr, req: RosterRequest) => {
        sent.push(req);
        applyRequest(w.authority, req);
        return { event: null };
      },
    } as unknown as PeerClient;
    const sync = new SyncManager(w.daemon, client, {});
    try {
      sync.tick();
      await until(() => pulls >= 1, "authority pull");
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      sync.stop();
    }
    expect(sent).toEqual([]);
    expect(w.daemon.store.queuedRequests()).toHaveLength(1);
    expect(w.authority.roster.nodes.get(w.alex.keys.nodeId)?.transports).toEqual(["tailscale", "direct"]);
    expect(w.daemon.roster.nodes.get(w.alex.keys.nodeId)?.transports).toBeUndefined();
  });

  test("PROBE a spend the chain already recorded is refused, and the same signed request is not applied twice", async () => {
    const w = world();
    w.setRole("member");
    const minted = await mintInviteCode(w.daemon, undefined, w.alex.handle, "member", { ttlMs: RENTAL_CODE_TTL_MS });
    const queued = signRequest(w.daemon, "team.node", { ...w.restate(minted.id), invite_code: minted.code });
    const first = applyRequest(w.authority, queued);
    const again = applyRequest(w.authority, queued);
    expect(again?.id).toBe(first?.id);
    expect(w.authority.roster.members.get(w.alex.login)?.invite_spends).toBe(1);
    const n = w.authority.roster.nodes.get(w.alex.keys.nodeId)!;
    w.authority.emit("team.node", {
      node_id: n.node_id, login: n.login, hostname: n.hostname, pubkey: n.pubkey, ip: n.ip, port: n.port,
      endpoint: endpointHex(n.pubkey), transports: ["tailscale", "direct"], peer_sig_v1: true,
    });
    w.sync();
    const lines: string[] = [];
    (w.daemon as unknown as { log: Logger }).log = {
      debug: () => undefined,
      info: (event: string, fields: Record<string, unknown> = {}) => { lines.push(JSON.stringify({ event, fields })); },
      warn: (event: string, fields: Record<string, unknown> = {}) => { lines.push(JSON.stringify({ event, fields })); },
      error: (event: string, fields: Record<string, unknown> = {}) => { lines.push(JSON.stringify({ event, fields })); },
    } as Logger;
    w.daemon.store.queueRequest(queued.id, JSON.stringify(queued));
    // A real peer turns the authority's 403 into PeerCallError. HttpError alone would be retried.
    const client = {
      addrOf: () => ({ ip: "127.0.0.1", port: 7458 }),
      rosterRequest: async (_addr: PeerAddr, req: RosterRequest) => {
        try {
          const event = applyRequest(w.authority, req);
          w.sync();
          return { event: event ? { id: event.id, seq: event.seq } : null };
        } catch (err) {
          if (err instanceof HttpError) throw new PeerCallError(err.status, err.code, err.message);
          throw err;
        }
      },
    } as unknown as PeerClient;
    await flushRequests(w.daemon, client, w.catchUp);
    expect(w.authority.roster.members.get(w.alex.login)?.invite_spends).toBe(1);
    const marked = w.authority.rosterEntries().filter((ev) => ev.kind === "team.node" && (ev.body as { invite?: string }).invite === minted.id);
    expect(marked).toHaveLength(1);
    expect(w.daemon.store.queuedRequests()).toEqual([]);
    expect(lines.join("\n")).not.toContain(minted.code);
    // Retired only on this authority, not written on the chain: the chain's used set does not include it, so the spend is still appended.
    const localOnly = hex32();
    w.setRole("owner");
    w.authority.retireInvite(localOnly);
    expect(w.authority.roster.invites?.has(localOnly)).toBe(true);
    applyRequest(w.authority, signRequest(w.daemon, "team.node", w.restate(localOnly)));
    const onChain = w.authority.rosterEntries().filter((ev) => ev.kind === "team.node" && (ev.body as { invite?: string }).invite === localOnly);
    expect(onChain).toHaveLength(1);
  });

  test("PROBE a queued spend waits for the authority's record and not for an unrelated origin", async () => {
    const w = world();
    w.setRole("member");
    const minted = await mintInviteCode(w.daemon, undefined, w.alex.handle, "member", { ttlMs: RENTAL_CODE_TTL_MS });
    const stale = signRequest(w.daemon, "team.node", { ...w.restate(minted.id), invite_code: minted.code });
    expect(stale.body.transports).toBeUndefined();
    w.daemon.store.queueRequest(stale.id, JSON.stringify(stale));
    const n = w.authority.roster.nodes.get(w.alex.keys.nodeId)!;
    w.authority.emit("team.node", {
      node_id: n.node_id, login: n.login, hostname: n.hostname, pubkey: n.pubkey, ip: n.ip, port: n.port,
      endpoint: endpointHex(n.pubkey), transports: ["tailscale", "direct"], peer_sig_v1: true,
    });
    const t0 = Date.now();
    let sendAt = -1;
    let slowFinished = false;
    const sent: RosterRequest[] = [];
    const other = "f".repeat(16);
    const client = {
      addrOf: () => ({ ip: "127.0.0.1", port: 7458 }),
      vv: async () => {
        const vv: Record<string, number> = {};
        for (const ev of w.authority.rosterEntries()) vv[ev.origin] = Math.max(vv[ev.origin] ?? 0, ev.seq);
        vv[other] = 5;
        return { vv, online: [], capabilities: { caps: [] } };
      },
      pull: async (_addr: PeerAddr, origin: string, after: number) => {
        if (origin === other) {
          await new Promise((r) => setTimeout(r, 1500));
          slowFinished = true;
          return { events: [] };
        }
        return { events: w.authority.rosterEntries().filter((ev) => ev.origin === origin && ev.seq > after) };
      },
      pullIds: async () => ({ events: [] }),
      rosterRequest: async (_addr: PeerAddr, req: RosterRequest) => {
        sendAt = Date.now() - t0;
        sent.push(req);
        return { event: null };
      },
    } as unknown as PeerClient;
    const sync = new SyncManager(w.daemon, client, {});
    try {
      sync.tick();
      await until(() => sendAt >= 0, "flushed spend");
    } finally {
      sync.stop();
    }
    expect(sendAt).toBeLessThan(1000);
    expect(slowFinished).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.transports).toEqual(["tailscale", "direct"]);
    expect(sent[0]!.body.invite).toBe(minted.id);
  });

  test("PROBE an unreachable authority is not sent a spend, and stopping during the wait sends nothing", async () => {
    const w = world();
    w.setRole("owner");
    const minted = await mintInviteCode(w.daemon, undefined, w.alex.handle, "member", { ttlMs: RENTAL_CODE_TTL_MS });
    const queued = signRequest(w.daemon, "team.node", { ...w.restate(minted.id), invite_code: minted.code });
    w.daemon.store.queueRequest(queued.id, JSON.stringify(queued));
    let vvFailed = false;
    const sendAt: number[] = [];
    const down = {
      addrOf: () => ({ ip: "127.0.0.1", port: 7458 }),
      vv: async () => { await new Promise((r) => setTimeout(r, 200)); vvFailed = true; throw new PeerCallError(0, "unreachable", "down"); },
      pull: async () => ({ events: [] }),
      pullIds: async () => ({ events: [] }),
      rosterRequest: async () => { sendAt.push(Date.now()); throw new PeerCallError(0, "unreachable", "down"); },
    } as unknown as PeerClient;
    const sync = new SyncManager(w.daemon, down, {});
    try {
      sync.tick();
      await until(() => vvFailed, "version vector failure");
      await new Promise((r) => setTimeout(r, 60));
      // RV4-F4 (r4) asked the authority anyway. A spend is now held whenever this round did not catch the machine up.
      expect(sendAt).toEqual([]);
      expect(w.daemon.store.queuedRequests()).toHaveLength(1);
    } finally {
      sync.stop();
    }

    w.daemon.store.dequeueRequest(queued.id);
    w.daemon.store.queueRequest(queued.id, JSON.stringify(queued));
    let releaseVv!: () => void;
    const vvGate = new Promise<void>((resolve) => { releaseVv = resolve; });
    let sends = 0;
    const gated = {
      addrOf: () => ({ ip: "127.0.0.1", port: 7458 }),
      vv: async () => {
        await vvGate;
        const vv: Record<string, number> = {};
        for (const ev of w.authority.rosterEntries()) vv[ev.origin] = Math.max(vv[ev.origin] ?? 0, ev.seq);
        return { vv, online: [], capabilities: { caps: [] } };
      },
      pull: async () => ({ events: [] }),
      pullIds: async () => ({ events: [] }),
      rosterRequest: async () => { sends++; return { event: null }; },
    } as unknown as PeerClient;
    const held = new SyncManager(w.daemon, gated, {});
    try {
      held.tick();
      const authNode = w.daemon.roster.nodes.get(w.bea.keys.nodeId)!;
      const second = held.antiEntropy(authNode);
      const raced = await Promise.race([second.then(() => "returned"), new Promise((r) => setTimeout(() => r("blocked"), 40))]);
      expect(raced).toBe("returned");
      held.stop();
      releaseVv();
      await new Promise((r) => setTimeout(r, 30));
      expect(sends).toBe(0);
    } finally {
      releaseVv();
      held.stop();
    }
  });

  for (const mode of ["timeout", "http-503", "http-429"] as const) {
    test(`PROBE a spend stays queued when the authority's version vector call fails (${mode}), and the next round sends it with the pin`, async () => {
      const w = world();
      const spendId = hex32();
      const queued = signRequest(w.daemon, "team.node", w.restate(spendId)); // an owner: the id alone
      w.daemon.store.queueRequest(queued.id, JSON.stringify(queued));
      pinDirectAtAuthority(w);
      expect(w.daemon.roster.nodes.get(w.alex.keys.nodeId)?.transports).toBeUndefined();
      const sent: RosterRequest[] = [];
      let vvCalls = 0;
      const failing = authorityClient(w, sent, {
        vv: async () => {
          vvCalls++;
          await new Promise((r) => setTimeout(r, 20));
          if (mode === "timeout") throw new PeerCallError(0, "unreachable", "127.0.0.1:7458 unreachable (TimeoutError)");
          if (mode === "http-503") throw new PeerCallError(503, "unavailable", "busy");
          throw new PeerCallError(429, "rate_limited", "slow down");
        },
      });
      const first = new SyncManager(w.daemon, failing, {});
      try {
        first.tick();
        await until(() => vvCalls >= 1, "failing version vector call");
        await new Promise((r) => setTimeout(r, 120));
      } finally {
        first.stop();
      }
      // The authority could be asked and would have taken the request, but this machine's record is stale: it stays queued.
      expect(sent).toEqual([]);
      expect(w.daemon.store.queuedRequests()).toHaveLength(1);
      expect(w.authority.roster.nodes.get(w.alex.keys.nodeId)?.transports).toEqual(["tailscale", "direct"]);
      expect(w.daemon.roster.nodes.get(w.alex.keys.nodeId)?.transports).toBeUndefined();

      const second = new SyncManager(w.daemon, authorityClient(w, sent), {});
      try {
        second.tick();
        await until(() => sent.length >= 1, "spend after a good round");
      } finally {
        second.stop();
      }
      expect(sent).toHaveLength(1);
      expect(sent[0]!.body.invite).toBe(spendId);
      expect(sent[0]!.body.transports).toEqual(["tailscale", "direct"]);
      expect(sent[0]!.body.peer_sig_v1).toBe(true);
      expect(w.authority.roster.nodes.get(w.alex.keys.nodeId)?.transports).toEqual(["tailscale", "direct"]);
      expect(w.daemon.store.queuedRequests()).toEqual([]);
    });
  }

  test("PROBE a spend is not sent when no sync round is running for the authority", async () => {
    const w = world();
    queueSpendAt(w, 1_000);
    pinDirectAtAuthority(w);
    const sent: RosterRequest[] = [];
    const sync = new SyncManager(w.daemon, authorityClient(w, sent), {});
    try {
      await sync.flushRequests();
      expect(sent).toEqual([]);
      expect(w.daemon.store.queuedRequests()).toHaveLength(1);
      sync.tick();
      await until(() => sent.length >= 1, "spend after a round");
    } finally {
      sync.stop();
    }
    expect(sent[0]!.body.transports).toEqual(["tailscale", "direct"]);
    expect(w.daemon.store.queuedRequests()).toEqual([]);
  });

  test("PROBE the authority itself still applies its own queued spend, with nothing to catch up on", async () => {
    const w = world();
    const id = hex32();
    const n = w.authority.roster.nodes.get(w.bea.keys.nodeId)!;
    const body = {
      node_id: n.node_id, login: n.login, hostname: n.hostname, pubkey: n.pubkey, ip: n.ip, port: n.port,
      ...transportFields(n), ...(n.peer_sig_v1 ? { peer_sig_v1: true } : {}), invite: id,
    };
    const q = signRequest(w.authority, "team.node", body);
    w.authority.store.queueRequest(q.id, JSON.stringify(q));
    const sync = new SyncManager(w.authority, {} as PeerClient, {});
    await sync.flushRequests();
    sync.stop();
    expect(w.authority.store.queuedRequests()).toEqual([]);
    expect(w.authority.recordedInvites()?.has(id)).toBe(true);
  });

  for (const n of [19, 20, 25, 500, 999]) {
    test(`PROBE ${n} held spends do not keep a request queued behind them from being sent`, async () => {
      const w = world();
      for (let i = 0; i < n; i++) queueSpendAt(w, 1_000 + i);
      queueChannelAt(w, "ops", 1_000 + n);
      pinDirectAtAuthority(w); // the authority is one event ahead, so its origin must be pulled, and that fails
      const sent: RosterRequest[] = [];
      let pulls = 0;
      const client = authorityClient(w, sent, {
        pull: async () => { pulls++; throw new PeerCallError(0, "unreachable", "pull timed out (TimeoutError)"); },
      });
      const sync = new SyncManager(w.daemon, client, {});
      try {
        sync.tick();
        await until(() => sent.length >= 1, "request behind the held spends");
        await new Promise((r) => setTimeout(r, 60));
      } finally {
        sync.stop();
      }
      expect(pulls).toBeGreaterThan(0);
      expect(sent.map((r) => r.kind)).toEqual(["channel.upsert"]);
      expect(w.authority.roster.channels.has("ops")).toBe(true);
      expect(queuedSpends(w)).toBe(n);
      expect(w.daemon.store.queuedRequests(5000)).toHaveLength(n);
    });
  }

  test("PROBE held spends are read past without using up the batch, and the rest go in creation order", async () => {
    const w = world();
    for (let i = 0; i < 25; i++) {
      queueSpendAt(w, 1_000 + i * 2);
      queueChannelAt(w, `room${String(i).padStart(2, "0")}`, 1_001 + i * 2);
    }
    const sent: RosterRequest[] = [];
    await flushRequests(w.daemon, authorityClient(w, sent), w.catchUp, { holdSpends: true });
    expect(sent.map((r) => r.body.name)).toEqual(Array.from({ length: 20 }, (_, i) => `room${String(i).padStart(2, "0")}`));
    expect(queuedSpends(w)).toBe(25);
    expect(w.daemon.store.queuedRequests(5000)).toHaveLength(30);
    // Without a hold, the spends are sent too, in the same oldest-first order and at most 20 a round.
    sent.length = 0;
    await flushRequests(w.daemon, authorityClient(w, sent), w.catchUp);
    expect(sent).toHaveLength(20);
    expect(sent.map((r) => r.kind).slice(0, 4)).toEqual(["team.node", "team.node", "team.node", "team.node"]);
  });

  test("PROBE the held-spend scan is bounded: a request behind 1,000 held spends waits", async () => {
    const w = world();
    for (let i = 0; i < 1_000; i++) queueSpendAt(w, 1_000 + i);
    queueChannelAt(w, "ops", 5_000);
    const sent: RosterRequest[] = [];
    await flushRequests(w.daemon, authorityClient(w, sent), w.catchUp, { holdSpends: true });
    expect(sent).toEqual([]);
    expect(w.daemon.store.queuedRequests(5000)).toHaveLength(1_001);
  });

  test("interactive rent rechecks the owner after the pending save", async () => {
    const w = world();
    const slot = hold();
    let minted: MintedInvite | null = null;
    proto.mint = async function (this: ComputeService, handle: string) {
      minted = await origMint.call(this, handle);
      return minted;
    };
    let serials = 0;
    proto.serial = async function (this: ComputeService, fn: () => Promise<unknown>) {
      const out = await origSerial.call(this, fn);
      serials++;
      if (serials === 2) {
        slot.arm();
        await slot.hold;
      }
      return out;
    };
    const pending = w.service.rent(w.alex.handle, { machines: [{ tier: "agent", count: 1 }] });
    const which = await heldOrDone(pending.then(() => undefined, () => undefined), slot.entered);
    if (which !== "held") {
      await pending.catch(() => undefined);
      throw new Error("rent finished before the pending save returned");
    }
    w.setRole("member");
    slot.release();
    await expect(pending).rejects.toThrow(/no longer a team owner/);
    expect(w.rents).toBe(0);
    expect(loadPending(w.daemon.paths.home)).toEqual([]);
    const code = minted!.code;
    expect(JSON.stringify(w.logs)).not.toContain(code);
    expect(JSON.stringify(w.authority.rosterEntries())).not.toContain(code);
    expect(w.requests[0]?.body.invite_code).toBe(code);
    w.setRole("owner");
    expect(checkInvite(code, w.authority.roster, w.team, w.daemon.clock())).toEqual({ ok: false, reason: "invite_used" });
    expect(checkInvite(code, w.daemon.roster, w.team, w.daemon.clock())).toEqual({ ok: false, reason: "invite_used" });
  });

  test("a pending roster request does not show the invite code", async () => {
    const w = world();
    const minted = await mintInviteCode(w.daemon, undefined, w.alex.handle, "member", { ttlMs: RENTAL_CODE_TTL_MS });
    const req = signRequest(w.daemon, "team.node", { ...w.restate(minted.id), invite_code: minted.code });
    w.daemon.store.queueRequest(req.id, JSON.stringify(req));
    const view = JSON.stringify(queuedView(w.daemon));
    expect(view).not.toContain(minted.code);
    expect(view).toContain(minted.id);
    expect(queuedView(w.daemon)[0]?.body).not.toHaveProperty("invite_code");
  });

  test("PROBE a 20-machine abandoned rent sends only the demotion budget that is left", async () => {
    const w = world();
    w.setRole("member");
    for (let i = 0; i < 5; i++) {
      const inv = await mintInviteCode(w.daemon, undefined, w.alex.handle, "member", { ttlMs: RENTAL_CODE_TTL_MS });
      applyRequest(w.authority, signRequest(w.daemon, "team.node", { ...w.restate(inv.id), invite_code: inv.code }));
    }
    w.sync();
    expect(w.daemon.roster.members.get(w.alex.login)?.invite_spends).toBe(5);
    const minted: MintedInvite[] = [];
    proto.mint = async function (this: ComputeService, handle: string) {
      const inv = await origMint.call(this, handle);
      minted.push(inv);
      return inv;
    };
    const pending = w.service.rent(w.alex.handle, { machines: [{ tier: "agent", count: 20 }] });
    await expect(pending).rejects.toThrow(/no longer a team owner/);
    expect(w.rents).toBe(0);
    expect(loadPending(w.daemon.paths.home)).toEqual([]);
    await until(() => w.requests.length >= 3 && w.authority.roster.members.get(w.alex.login)?.invite_spends === 8, "budget spends");
    await new Promise((r) => setTimeout(r, 40));
    expect(w.requests.length).toBe(3);
    expect(w.authority.roster.members.get(w.alex.login)?.invite_spends).toBe(8);
    expect(minted).toHaveLength(20);
    const sent = new Set(w.requests.map((r) => String(r.body.invite)));
    expect(sent.size).toBe(3);
    // checkInvite reports "not an owner" before "already used". Promote first, so a local retire shows as used.
    w.setRole("owner");
    for (const inv of minted) {
      expect(checkInvite(inv.code, w.daemon.roster, w.team, w.daemon.clock())).toEqual({ ok: false, reason: "invite_used" });
      const onAuthority = checkInvite(inv.code, w.authority.roster, w.team, w.authority.clock());
      if (sent.has(inv.id)) expect(onAuthority).toEqual({ ok: false, reason: "invite_used" });
      else expect(onAuthority.ok).toBe(true);
    }
    expect(JSON.stringify(w.logs)).not.toContain(minted[0]!.code);
    expect(JSON.stringify(w.authority.rosterEntries())).not.toContain(minted[0]!.code);
  });

  test("PROBE a 20-machine abandoned rent answers before the spends and stops at not_owner", async () => {
    let entered = 0;
    const w = world({
      refuseSpend: true,
      beforeSpend: async () => {
        entered++;
        await new Promise((r) => setTimeout(r, 200));
      },
    });
    const slot = hold();
    let serials = 0;
    proto.serial = async function (this: ComputeService, fn: () => Promise<unknown>) {
      const out = await origSerial.call(this, fn);
      serials++;
      if (serials === 2) {
        slot.arm();
        await slot.hold;
      }
      return out;
    };
    const pending = w.service.rent(w.alex.handle, { machines: [{ tier: "agent", count: 20 }] });
    const which = await heldOrDone(pending.then(() => undefined, () => undefined), slot.entered);
    if (which !== "held") {
      await pending.catch(() => undefined);
      throw new Error("rent finished before the pending save returned");
    }
    w.setRole("member");
    const t0 = Date.now();
    slot.release();
    await expect(pending).rejects.toThrow(/no longer a team owner/);
    expect(Date.now() - t0).toBeLessThan(250);
    expect(w.rents).toBe(0);
    expect(loadPending(w.daemon.paths.home)).toEqual([]);
    await until(() => entered >= 1, "first spend");
    await new Promise((r) => setTimeout(r, 500));
    expect(entered).toBe(1);
    expect(w.requests.length).toBe(1);
  });
});
