// WALK-74 (ASYNC-PERMS-1) for rental compute: renting is an owner's, and two parts of a rent happen later, on the poller:
// a queued rental gets its code (and starts billing) only when capacity frees, and a rent whose answer was lost is sent
// again. Both are re-checked then: a machine whose person is no longer an owner starts nothing, keeps the pending rent
// (it is recovered if the role comes back) and says why in the log. The controls: while still an owner both happen.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { computeFor } from "../../src/daemon/compute/routes.ts";
import { loadPending } from "../../src/daemon/compute/files.ts";
import { ComputeSite } from "../../src/daemon/compute/site.ts";
import { memberByHandle } from "../../src/daemon/roster.ts";
import { SiteRentReq, type RentalView, type RentResult } from "../../src/protocol/compute.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { QUOTES } from "../helpers/compute-fixtures.ts";

setDefaultTimeout(60_000);

/** A fake site with room for one machine at a time; the rest queue and wait for a code. */
const TOKEN = randomBytes(32).toString("base64url");
const site = { rentals: new Map<string, RentalView>(), order: [] as string[], idem: new Map<string, RentResult>(), starts: [] as string[], rents: 0 };
const live = () => [...site.rentals.values()].filter((r) => r.state === "starting" || r.state === "running" || r.state === "needs_code").length;
function promote(): void {
  for (const id of site.order) {
    const r = site.rentals.get(id);
    if (r?.state === "queued" && live() < 1) site.rentals.set(id, { ...r, state: "needs_code" });
  }
}
const j = (body: unknown, status = 200) => Response.json(body, { status });
let teamId = "";
/** Rent calls that never reach the site (the network fails before it), so only a replay can deliver them. */
let unreachableRents = 0;

async function handle(req: Request): Promise<Response> {
  const p = new URL(req.url).pathname;
  if (p === "/api/compute/quotes") return j(QUOTES);
  if (p === "/api/compute/account") return j({ account_id: "ca_00000000000000c2", token: TOKEN }, 201);
  if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return j({ error: "invalid_token" }, 401);
  if (p === "/api/compute/state") {
    promote();
    return j({ account_id: "ca_00000000000000c2", team_id: teamId, status: "active", balance_micros: 50_000_000, burn_per_hour_micros: 0,
      hours_left: null, rentals: site.order.map((id) => site.rentals.get(id)) });
  }
  const body = await req.json() as Record<string, unknown>;
  if (p === "/api/compute/rent") {
    const b = SiteRentReq.parse(body);
    site.rents++;
    const seen = site.idem.get(b.idempotency_key);
    if (seen) return j({ ...seen, replay: true });
    const codeIndex: Record<string, number> = {};
    const created: RentalView[] = [];
    let i = 0;
    for (const m of b.machines) for (let k = 0; k < m.count; k++, i++) {
      const id = `r_${randomBytes(8).toString("hex")}`;
      const start = live() < 1;
      const r: RentalView = { id, tier: m.tier, name: `rent-${randomBytes(2).toString("hex")}`, state: start ? "starting" : "queued", queue_position: null,
        price_per_hour_micros: 750_000, spent_micros: 0, created_at: Date.now(), started_at: start ? Date.now() : null, ended_at: null, end_reason: null,
        node_id: null, idle_minutes: 30 };
      site.rentals.set(id, r);
      site.order.push(id);
      if (start) codeIndex[id] = i;
      created.push(r);
    }
    const res: RentResult = { rentals: created, started: Object.keys(codeIndex).length, queued: created.length - Object.keys(codeIndex).length,
      code_index: codeIndex, balance_micros: 50_000_000, replay: false };
    site.idem.set(b.idempotency_key, res);
    return j(res);
  }
  if (p === "/api/compute/start") {
    const r = site.rentals.get(String(body.rental_id));
    if (!r || r.state !== "needs_code") return j({ error: "not_waiting_for_code" }, 409);
    site.starts.push(r.id);
    const next = { ...r, state: "starting" as const, started_at: Date.now() };
    site.rentals.set(r.id, next);
    return j({ rental: next });
  }
  return j({ error: "not_found" }, 404);
}

/** The site ends rentals (their idle timers, or a stop elsewhere): running ones free capacity for the queue. */
function endRentals(states: readonly RentalView["state"][] = ["starting", "running"]): void {
  for (const [id, r] of site.rentals) if (states.includes(r.state)) site.rentals.set(id, { ...r, state: "ended", ended_at: Date.now(), end_reason: "user" });
}

let server: ReturnType<typeof Bun.serve>;
let c: Cluster;
let bob: TestNode, alex: TestNode;
const poll = () => computeFor(alex.d.core)?.pollOnce() as Promise<void>;
const lostRent = async () => {
  unreachableRents = 2; // the first send and its immediate retry
  await expect(alex.client().computeRent({ machines: [{ tier: "agent", count: 1 }] })).rejects.toBeDefined();
};

beforeAll(async () => {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handle });
  c = new Cluster();
  alex = await c.add({
    name: "alex", login: "-", hostname: "alex-mbp", direct: true,
    compute: { site: new ComputeSite({ base: `http://127.0.0.1:${server.port}`, fetch: async (url, init) => {
      if (url.endsWith("/rent") && unreachableRents > 0) { unreachableRents--; throw new Error("network unreachable"); }
      return fetch(url, init);
    } }), intervalMs: 3_600_000 },
  });
  bob = await c.add({ name: "bob", login: "-", hostname: "bob-mbp", direct: true });
  // The compute account is made on the roster authority (alex); bob is a second owner who later takes the authority.
  await alex.client().init("acme", "alex");
  teamId = alex.d.core.teamId as string;
  expect((await bob.client().join((await alex.client().inviteCode("bob", "owner")).code)).admitted).toBe(true);
}, 30_000);
afterAll(async () => { await c.close(); server.stop(true); });

test("control: while still an owner, a queued rental gets its code when capacity frees", async () => {
  const res = await alex.client().computeRent({ machines: [{ tier: "agent", count: 2 }] });
  expect([res.started, res.queued]).toEqual([1, 1]);
  const queued = res.rentals.find((r) => r.state === "queued") as RentalView;
  endRentals();
  await poll();
  expect(site.starts).toContain(queued.id);
});

test("control: while still an owner, a rent whose answer was lost is sent again and recovered", async () => {
  const before = site.rents;
  await lostRent();
  expect(loadPending(alex.home)).toHaveLength(1);
  expect(site.rents).toBe(before);
  await poll();
  expect(site.rents).toBe(before + 1);
  expect(loadPending(alex.home)).toHaveLength(0);
});

test("made a member: the queued rental is not started and the lost rent is not sent; both are said in the log", async () => {
  // Earlier rentals end; then one machine runs and one queues behind it, and one rent's answer is lost, while alex is an owner.
  endRentals(["starting", "running", "queued", "needs_code"]);
  const res = await alex.client().computeRent({ machines: [{ tier: "agent", count: 2 }] });
  expect([res.started, res.queued]).toEqual([1, 1]);
  const queued = res.rentals.find((r) => r.state === "queued") as RentalView;
  await lostRent();
  expect(loadPending(alex.home)).toHaveLength(1);
  await alex.client().setAuthority("bob-mbp");
  await waitFor(() => bob.d.core.isAuthority() ? true : null, { what: "bob holds the roster authority" });
  await bob.client().setRole("alex", "member");
  await waitFor(() => memberByHandle(alex.d.core.roster, "alex")?.role === "member" ? true : null, { what: "alex sees herself made a member" });
  const starts = site.starts.length;
  const rents = site.rents;
  endRentals();
  await poll();
  await poll();
  expect(site.rentals.get(queued.id)?.state).toBe("needs_code");
  expect(site.starts).toHaveLength(starts);
  expect(site.rents).toBe(rents);
  expect(loadPending(alex.home)).toHaveLength(1); // kept: recovered with the same key if alex is an owner again
  const log = await Bun.file(alex.d.paths.log).text();
  const lines = log.split("\n").filter((l) => l.includes("compute_start_refused") || l.includes("compute_rent_refused"));
  expect(lines.filter((l) => l.includes("compute_start_refused") && l.includes(queued.id))).toHaveLength(1); // once, not every round
  expect(lines.filter((l) => l.includes("compute_rent_refused"))).toHaveLength(1);
  expect(lines.every((l) => l.includes("@alex is no longer a team owner (renting compute is an owner's), so this machine's rentals are not started"))).toBe(true);
});
