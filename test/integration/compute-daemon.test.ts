// RENT-2 daemon side, end to end against a fake site (Bun.serve, the site API contract of src/protocol/compute.ts):
// an owner rents 3 mixed machines (2 fit, 1 queues), each started one carries its own 1-hour add-machine code minted by
// the owner's daemon; a fake rented box joins the team with its code; the chain (not the box's own report) says which
// node a rental became; the poller hands a fresh code to the queued machine when capacity frees and revokes a rented
// machine once its rental ends. Members can't rent, agents only with agent admin on, and no local compute answer
// carries a cost, a margin, a provider or an instance type.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { WalkieError } from "../../src/client/index.ts";
import { computeFor } from "../../src/daemon/compute/routes.ts";
import { loadPending, loadRentals } from "../../src/daemon/compute/files.ts";
import { ComputeSite } from "../../src/daemon/compute/site.ts";
import { decodeInvite } from "../../src/daemon/invite.ts";
import { dashboardRoute } from "../../src/daemon/local-api.ts";
import {
  FORBIDDEN_CUSTOMER_KEYS, RENTAL_CODE_TTL_MS, SiteRentReq, type RentalView, type RentResult, type TierId,
} from "../../src/protocol/compute.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { forbiddenKeys, QUOTES } from "../helpers/compute-fixtures.ts";

setDefaultTimeout(60_000);

/** The fake control plane: capacity for CAPACITY machines at once, the rest queued; never keeps a code past "boot". */
const CAPACITY = 2;
const TOKEN = randomBytes(32).toString("base64url");
const site = {
  balance: 50_000_000,
  rentals: new Map<string, RentalView>(),
  order: [] as string[],
  /** What cloud-init would get: the code each started rental boots with (the test plays the box). */
  bootCodes: new Map<string, string>(),
  idem: new Map<string, RentResult>(),
  starts: [] as { rental_id: string; code: string }[],
  /** The rented box's own claim about its node (ignored by the daemon in favour of the chain). */
  claimedNode: "ffffffffffffffff",
  accounts: 0,
};
const priceOf = (t: TierId) => QUOTES.tiers.find((x) => x.id === t)?.price_per_hour_micros ?? 0;
const running = () => [...site.rentals.values()].filter((r) => r.state === "starting" || r.state === "running" || r.state === "needs_code").length;

function promote(): void {
  for (const id of site.order) {
    const r = site.rentals.get(id);
    if (r?.state === "queued" && running() < CAPACITY) site.rentals.set(id, { ...r, state: "needs_code", queue_position: null });
  }
  let pos = 1;
  for (const id of site.order) {
    const r = site.rentals.get(id);
    if (r?.state === "queued") site.rentals.set(id, { ...r, queue_position: pos++ });
  }
}

function stateBody() {
  promote();
  const rentals = site.order.map((id) => site.rentals.get(id) as RentalView);
  const burn = rentals.filter((r) => r.state === "starting" || r.state === "running").reduce((a, r) => a + r.price_per_hour_micros, 0);
  return {
    account_id: "ca_00000000000000c1", team_id: teamId, status: "active", balance_micros: site.balance,
    burn_per_hour_micros: burn, hours_left: burn ? site.balance / burn : null, rentals,
  };
}

const j = (body: unknown, status = 200) => Response.json(body, { status });
let teamId = "";
let dropRents = 0, dropStarts = 0;

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (p === "/api/compute/quotes") return j(QUOTES);
  if (p === "/api/compute/account") {
    site.accounts++;
    return j({ account_id: "ca_00000000000000c1", token: TOKEN }, 201);
  }
  if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return j({ error: "invalid_token" }, 401);
  if (p === "/api/compute/state") return j(stateBody());
  if (p === "/api/compute/credit") return j({ url: "https://checkout.stripe.com/c/pay/cs_test_fake" });
  const body = await req.json() as Record<string, unknown>;
  if (p === "/api/compute/rent") {
    const b = SiteRentReq.parse(body);
    const seen = site.idem.get(b.idempotency_key);
    if (seen) return j({ ...seen, replay: true });
    const needed = b.machines.reduce((a, m) => a + m.count * priceOf(m.tier), 0);
    if (needed > site.balance) return j({ error: "insufficient_credit", needed_micros: needed, balance_micros: site.balance }, 402);
    const created: RentalView[] = [];
    const codeIndex: Record<string, number> = {};
    let i = 0;
    for (const m of b.machines) {
      for (let k = 0; k < m.count; k++, i++) {
        const id = `r_${randomBytes(8).toString("hex")}`;
        const start = running() < CAPACITY;
        const r: RentalView = {
          id, tier: m.tier, name: `rent-${m.tier}-${randomBytes(2).toString("hex")}`, state: start ? "starting" : "queued", queue_position: null,
          price_per_hour_micros: priceOf(m.tier), spent_micros: 0, created_at: Date.now(), started_at: start ? Date.now() : null,
          ended_at: null, end_reason: null, node_id: start ? site.claimedNode : null, idle_minutes: b.idle_minutes ?? 30,
        };
        site.rentals.set(id, r);
        site.order.push(id);
        if (start) { codeIndex[id] = i; site.bootCodes.set(id, b.codes[i] as string); }
        created.push(r);
      }
    }
    promote();
    const res: RentResult = {
      rentals: created.map((r) => site.rentals.get(r.id) as RentalView), started: Object.keys(codeIndex).length,
      queued: created.length - Object.keys(codeIndex).length, code_index: codeIndex, balance_micros: site.balance, replay: false,
    };
    site.idem.set(b.idempotency_key, res);
    return j(res);
  }
  if (p === "/api/compute/start") {
    const r = site.rentals.get(String(body.rental_id));
    if (!r || r.state !== "needs_code") return j({ error: "not_waiting_for_code" }, 409);
    site.starts.push({ rental_id: r.id, code: String(body.code) });
    site.bootCodes.set(r.id, String(body.code));
    const next = { ...r, state: "starting" as const, started_at: Date.now() };
    site.rentals.set(r.id, next);
    return j({ rental: next });
  }
  if (p === "/api/compute/stop") {
    const ids = body.all === true ? [...site.order] : [String(body.rental_id)];
    const stopped: RentalView[] = [];
    for (const id of ids) {
      const r = site.rentals.get(id);
      if (!r || r.state === "ended") continue;
      const next = { ...r, state: "ended" as const, ended_at: Date.now(), end_reason: "user" as const };
      site.rentals.set(id, next);
      stopped.push(next);
    }
    return j({ stopped: stopped.length, rentals: stopped });
  }
  return j({ error: "not_found" }, 404);
}

let server: ReturnType<typeof Bun.serve>;
let c: Cluster;
let alex: TestNode, kira: TestNode;
let rent: RentResult;

const refused = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as WalkieError; }
  throw new Error("expected a refusal");
};

beforeAll(async () => {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handle });
  c = new Cluster();
  alex = await c.add({
    name: "alex", login: "-", hostname: "alex-mbp", direct: true,
    compute: { site: new ComputeSite({ base: `http://127.0.0.1:${server.port}`, fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (url.endsWith('/rent') && dropRents > 0) { dropRents--; throw new Error('lost rent response'); }
      if (url.endsWith('/start') && dropStarts > 0) { dropStarts--; throw new Error('lost start response'); }
      return response;
    } }), intervalMs: 3_600_000 },
  });
  kira = await c.add({ name: "kira", login: "-", hostname: "kiras-mbp", direct: true });
  await alex.client().init("acme", "alex");
  teamId = alex.d.core.teamId as string;
  expect((await kira.client().join((await alex.client().inviteCode("kira", "member")).code)).admitted).toBe(true);
}, 30_000);
afterAll(async () => {
  await c.close();
  server.stop(true);
});

describe("rental compute on the daemon", () => {
  test("quotes and state before any account: prices only, no site account created yet", async () => {
    const q = await alex.client().computeQuotes();
    expect(q.tiers.map((t) => t.id)).toEqual(["agent", "agent-xl", "gpu-20", "gpu-48", "gpu-80"]);
    const s = await alex.client().computeState();
    expect(s).toEqual({ account_id: null, team_id: teamId, status: "none", balance_micros: 0, burn_per_hour_micros: 0, hours_left: null, rentals: [] });
    expect(site.accounts).toBe(0);
  });

  test("a member can't rent or read the balance (owner machines only)", async () => {
    expect((await refused(kira.client().computeRent({ machines: [{ tier: "agent", count: 1 }] }))).status).toBe(403);
    expect((await refused(kira.client().computeState())).status).toBe(403);
  });

  test("not enough credit: 402 with the numbers, nothing rented", async () => {
    const e = await refused(alex.client().computeRent({ machines: [{ tier: "gpu-48", count: 16 }] }));
    expect(e.status).toBe(402);
    expect(e.code).toBe("insufficient_credit");
    expect(e.details).toMatchObject({ needed_micros: 16 * 3_140_000, balance_micros: 50_000_000 });
    expect(site.rentals.size).toBe(0);
    expect(site.accounts).toBe(1); // created lazily by the first rent, once
  });

  test("rent 3 mixed machines: 2 start with their own 1-hour codes, 1 queues", async () => {
    const before = Date.now();
    rent = await alex.client().computeRent({ machines: [{ tier: "agent", count: 2 }, { tier: "gpu-20", count: 1 }], idle_minutes: 45 });
    expect(rent.started).toBe(2);
    expect(rent.queued).toBe(1);
    const codes = [...site.bootCodes.values()];
    expect(new Set(codes).size).toBe(2);
    for (const code of codes) {
      const d = decodeInvite(code);
      if ("error" in d) throw new Error(d.error);
      expect(d.handle).toBe("alex");
      expect(d.team).toBe(teamId);
      expect(d.expires_at - before).toBeLessThanOrEqual(RENTAL_CODE_TTL_MS + 1_000);
      expect(d.expires_at - before).toBeGreaterThan(RENTAL_CODE_TTL_MS - 5_000);
    }
    expect(forbiddenKeys(rent, FORBIDDEN_CUSTOMER_KEYS)).toEqual([]);
  });

  test("a rented box joins with its code; the chain (not the box's claim) names the node", async () => {
    const first = rent.rentals.find((r) => r.state === "starting") as RentalView;
    const box = await c.add({ name: "box1", login: "-", hostname: first.name, direct: true });
    expect((await box.client().join(site.bootCodes.get(first.id) as string)).admitted).toBe(true);
    const s = await waitFor(async () => {
      const st = await alex.client().computeState();
      return st.rentals.find((r) => r.id === first.id)?.node_id === box.d.nodeId ? st : null;
    }, { what: "the rental's node from the chain" });
    const other = s.rentals.find((r) => r.id !== first.id && r.state === "starting");
    expect(other?.node_id).toBe(site.claimedNode); // no admission yet: the box's own report, for display only
    expect(forbiddenKeys(s, FORBIDDEN_CUSTOMER_KEYS)).toEqual([]);
  });

  test("stopping frees capacity: the poller gives the queued machine a fresh 1-hour code; the stopped box is revoked", async () => {
    const first = rent.rentals.find((r) => r.state === "starting") as RentalView;
    const queued = rent.rentals.find((r) => r.state === "queued") as RentalView;
    const boxId = [...alex.d.core.roster.nodes.values()].find((n) => n.hostname === first.name)?.node_id as string;
    const stopped = await alex.client().computeStop({ rental_id: first.id });
    expect(stopped.stopped).toBe(1);
    await computeFor(alex.d.core)?.pollOnce();
    await computeFor(alex.d.core)?.pollOnce();
    const start = site.starts.find((s) => s.rental_id === queued.id);
    expect(start).toBeDefined();
    const d = decodeInvite(start?.code as string);
    if ("error" in d) throw new Error(d.error);
    expect(d.handle).toBe("alex");
    expect(d.expires_at - Date.now()).toBeLessThanOrEqual(RENTAL_CODE_TTL_MS);
    expect(site.rentals.get(queued.id)?.state).toBe("starting");
    await waitFor(() => alex.d.core.roster.nodes.get(boxId)?.revoked === true, { what: "the ended rental's node revoked" });
    // The owner's own machines are untouched.
    expect(alex.d.core.roster.nodes.get(kira.d.nodeId)?.revoked).toBe(false);
  });

  test("agents rent only while agent admin is on", async () => {
    await alex.client().adminSwitches({ agent_admin: false });
    const e = await refused(alex.client("helper").computeRent({ machines: [{ tier: "agent", count: 1 }] }));
    expect(e.code).toBe("agent_admin_off");
    await alex.client().adminSwitches({ agent_admin: true });
    const r = await alex.client("helper").computeRent({ machines: [{ tier: "agent", count: 1 }] });
    expect(r.started + r.queued).toBe(1);
    const audit = await alex.client().admin(50);
    expect(JSON.stringify(audit)).toContain("rented 1 machine (agent×1; $0.75/h)");
  });

  test("credit link, stop all; every local compute answer is free of cost keys; the dashboard may call them", async () => {
    const link = await alex.client().computeCredit(50);
    expect(link.url).toContain("cs_test_fake");
    const all = await alex.client().computeStop({ all: true });
    expect(all.stopped).toBeGreaterThan(0);
    for (const v of [await alex.client().computeQuotes(), await alex.client().computeState(), link, all]) {
      expect(forbiddenKeys(v, FORBIDDEN_CUSTOMER_KEYS)).toEqual([]);
    }
    for (const [m, p] of [["GET", "/v1/compute/quotes"], ["GET", "/v1/compute/state"], ["POST", "/v1/compute/rent"], ["POST", "/v1/compute/stop"], ["POST", "/v1/compute/credit"]] as const) {
      expect(dashboardRoute(m, p)).toBe(true);
    }
  });

  test("the token never leaves the daemon: not in the state answer, not in the log", async () => {
    const s = JSON.stringify(await alex.client().computeState());
    expect(s).not.toContain(TOKEN);
    const log = await Bun.file(alex.d.paths.log).text();
    expect(log).toContain("compute_rented"); // the log is there and has the rentals (chain ids only)
    expect(log).toContain("compute_node_revoked");
    expect(log).not.toContain(TOKEN);
    for (const code of site.bootCodes.values()) expect(log).not.toContain(code);
  });
});


test('lost rent responses survive daemon restart and recover invite associations by idempotent replay', async () => {
  dropRents = 2;
  const before = site.rentals.size;
  await refused(alex.client().computeRent({ machines: [{ tier: 'agent', count: 1 }] }));
  expect(loadPending(alex.home).length).toBe(1);
  expect(site.rentals.size).toBe(before + 1);
  await alex.restart();
  await computeFor(alex.d.core)?.pollOnce();
  expect(loadPending(alex.home).length).toBe(0);
  expect(site.rentals.size).toBe(before + 1);
  const rid = site.order.at(-1)!;
  const inv = decodeInvite(site.bootCodes.get(rid)!);
  if ('error' in inv) throw new Error(inv.error);
  expect(loadRentals(alex.home)[rid]?.invite_ids.includes(inv.id)).toBe(true);
  await alex.client().computeStop({ all: true });
});
test('lost start response retains its invite for revocation after restart', async () => {
  const res = await alex.client().computeRent({ machines: [{ tier: 'agent', count: 3 }] });
  const queued = res.rentals.find(r => r.state === 'queued')!;
  const first = res.rentals.find(r => r.state === 'starting')!;
  await alex.client().computeStop({ rental_id: first.id });
  dropStarts = 1;
  await computeFor(alex.d.core)?.pollOnce();
  const inv = decodeInvite(site.bootCodes.get(queued.id)!);
  if ('error' in inv) throw new Error(inv.error);
  expect(loadRentals(alex.home)[queued.id]?.invite_ids.includes(inv.id)).toBe(true);
  await alex.restart();
  const box = await c.add({ name: 'lost-start-box', login: '-', hostname: queued.name, direct: true });
  expect((await box.client().join(site.bootCodes.get(queued.id)!)).admitted).toBe(true);
  await alex.client().computeStop({ rental_id: queued.id });
  dropRents = 2;
  await refused(alex.client().computeRent({ machines: [{ tier: 'agent', count: 1 }] }));
  dropRents = 1; // an unrelated pending request cannot block this known rental's revocation
  await computeFor(alex.d.core)?.pollOnce();
  expect(loadPending(alex.home).length).toBe(1);
  await waitFor(() => alex.d.core.roster.nodes.get(box.d.nodeId)?.revoked === true, { what: 'lost response rental revoked' });
  await computeFor(alex.d.core)?.pollOnce();
  expect(loadPending(alex.home).length).toBe(0);
});
