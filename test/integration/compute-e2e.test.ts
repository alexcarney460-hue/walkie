// RENT-2 end to end: the REAL site control plane (site/api/compute/* handlers over HTTP, MemoryStore, FakeCloud, a
// controllable clock) and REAL daemons. An owner buys credit (Stripe test-mode checkout, then the signed webhook fixture
// delivered three times: credited once), rents 3 mixed machines (the provider's limit holds 2, so 1 queues), a rented
// box boots from the user-data the provider received and joins the team with its 1-hour code, heartbeats feed
// metering, stopping one frees capacity so the queued machine gets a fresh code from the owner's daemon and starts,
// and when the credit runs out every machine stops and the owner's daemon revokes the rented nodes.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { ComputeSite } from "../../src/daemon/compute/site.ts";
import { computeFor } from "../../src/daemon/compute/routes.ts";
import { decodeInvite } from "../../src/daemon/invite.ts";
import { RENTAL_CODE_TTL_MS, type RentResult } from "../../src/protocol/compute.ts";
import { makeAccount } from "../../site/api/compute/account.ts";
import { makeCredit } from "../../site/api/compute/credit.ts";
import { makeHeartbeat } from "../../site/api/compute/heartbeat.ts";
import { makeQuotes } from "../../site/api/compute/quotes.ts";
import { makeRent } from "../../site/api/compute/rent.ts";
import { makeStart } from "../../site/api/compute/start.ts";
import { makeState } from "../../site/api/compute/state.ts";
import { makeStop } from "../../site/api/compute/stop.ts";
import { makeTick } from "../../site/api/compute/tick.ts";
import { makeComputeWebhook } from "../../site/api/compute/webhook.ts";
import type { HandlerDeps } from "../../site/api/_lib/compute/handler.ts";
import type { ProvisionReq } from "../../site/api/_lib/compute/driver.ts";
import { MIN, stripeTestHeader, world, type World } from "../../site/test/compute-helpers.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

setDefaultTimeout(90_000);

const WH = "whsec_" + "e2e_compute_secret";
const CRON = "cron-" + "e2e-secret";
const boots: { instance: string; req: ProvisionReq }[] = [];
const checkouts: unknown[] = [];

let w: World;
let deps: HandlerDeps;
let server: ReturnType<typeof Bun.serve>;
let c: Cluster;
let alex: TestNode;
const boxes: TestNode[] = [];
let rent: RentResult;

const ROUTES: Record<string, (d: HandlerDeps) => (req: Request) => Promise<Response>> = {
  quotes: makeQuotes, account: makeAccount, state: makeState, credit: makeCredit, rent: makeRent, start: makeStart,
  stop: makeStop, heartbeat: makeHeartbeat, tick: makeTick, webhook: makeComputeWebhook,
};

const site = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${server.port}${path}`, init);
const tick = async () => (await site("/api/compute/tick", { headers: { authorization: `Bearer ${CRON}` } })).json() as Promise<Record<string, unknown>>;
const codeOf = (b: { req: ProvisionReq }) => /--invite (wk1[A-Za-z0-9_-]+) /.exec(b.req.user_data)?.[1] as string;
const tokenOf = (b: { req: ProvisionReq }) => /printf '%s' '([A-Za-z0-9_-]{43})'/.exec(b.req.user_data)?.[1] as string;
const rentalOf = (b: { req: ProvisionReq }) => b.req.tags["walkie:rental"] as string;

async function beat(b: { req: ProvisionReq }, extra: Record<string, unknown> = {}) {
  const res = await site("/api/compute/heartbeat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ rental_id: rentalOf(b), token: tokenOf(b), busy_seats: 1, pool_jobs: 0, cpu_pct: 35, egress_bytes: 1000, ...extra }),
  });
  return res.json() as Promise<{ state: string }>;
}

async function joinBox(b: { req: ProvisionReq }): Promise<TestNode> {
  const box = await c.add({ name: `box${boxes.length + 1}`, login: "-", hostname: b.req.name, direct: true });
  expect((await box.client().join(codeOf(b))).admitted).toBe(true);
  boxes.push(box);
  return box;
}

beforeAll(async () => {
  w = world({ quotas: { cpu: 1, gpu: 1 }, cloud: { onBoot: (instance, req) => boots.push({ instance, req }) } });
  deps = {
    env: { COMPUTE_ENABLED: "1", COMPUTE_STRIPE_WEBHOOK_SECRET: WH, CRON_SECRET: CRON, SITE_URL: "https://site.test" },
    compute: () => w.d,
    stripe: () => ({ async createCreditCheckout(p) { checkouts.push(p); return { url: "https://checkout.stripe.com/c/pay/cs_test_e2e" }; } }),
  };
  server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch: (req) => {
      const name = /^\/api\/compute\/([a-z]+)$/.exec(new URL(req.url).pathname)?.[1] ?? "";
      const make = ROUTES[name];
      return make ? make(deps)(req) : Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  c = new Cluster();
  alex = await c.add({
    name: "alex", login: "-", hostname: "alex-mbp", direct: true, clock: () => w.clock.now,
    compute: { site: new ComputeSite({ base: `http://127.0.0.1:${server.port}` }), intervalMs: 3_600_000 },
  });
  await alex.client().init("acme", "alex");
  w.clock.now = Date.now();
  Object.assign(w.d, { config: { ...w.d.config, team_authorities: { [alex.d.core.teamId!]: alex.d.core.keys.pubkey } } });
  await tick();
}, 30_000);

afterAll(async () => {
  await c.close();
  server.stop(true);
});

describe("rental compute end to end (real control plane, FakeCloud, real daemons)", () => {
  test("buy credit: test-mode checkout link, then the signed webhook credits $50 once across three deliveries", async () => {
    const link = await alex.client().computeCredit(50);
    expect(link.url).toBe("https://checkout.stripe.com/c/pay/cs_test_e2e");
    const accountId = (await alex.client().computeState()).account_id as string;
    expect(accountId).toMatch(/^ca_[0-9a-f]{16}$/);
    expect(checkouts).toEqual([expect.objectContaining({ accountId, block: 50 })]);
    const payload = JSON.stringify({
      id: "evt_e2e", type: "checkout.session.completed",
      data: { object: { id: "cs_test_e2e", mode: "payment", payment_status: "paid", currency: "usd", amount_total: 5000, payment_intent: "pi_e2e", metadata: { walkie_compute_account: accountId, walkie_credit_usd: "50" } } },
    });
    for (let i = 0; i < 3; i++) {
      const header = await stripeTestHeader(payload, WH);
      expect((await site("/api/compute/webhook", { method: "POST", body: payload, headers: { "stripe-signature": header } })).status).toBe(200);
    }
    expect((await alex.client().computeState()).balance_micros).toBe(50_000_000);
  });

  test("rent 3 mixed machines: 2 start (provider limit), 1 queues; each boot carries its own 1-hour code for @alex", async () => {
    const before = Date.now();
    rent = await alex.client().computeRent({ machines: [{ tier: "agent", count: 2 }, { tier: "gpu-20", count: 1 }] });
    expect(rent).toMatchObject({ started: 2, queued: 1 });
    expect(rent.rentals.map((r) => [r.tier, r.state])).toEqual([["agent", "starting"], ["agent", "queued"], ["gpu-20", "starting"]]);
    await tick();
    expect(boots).toHaveLength(2);
    for (const b of boots) {
      const d = decodeInvite(codeOf(b));
      if ("error" in d) throw new Error(d.error);
      expect(d.handle).toBe("alex");
      expect(d.expires_at - before).toBeLessThanOrEqual(RENTAL_CODE_TTL_MS + 1_000);
      expect(b.req.user_data).toContain("--allow-team-agents");
    }
    // First minute on the Agent box, 5-minute minimum on the GPU.
    expect((await alex.client().computeState()).balance_micros).toBe(50_000_000 - 12_500 - Math.ceil((1_520_000 * 5) / 60));
  });

  test("a rented box joins the team with the code it booted with; heartbeats mark it running; the owner sees its node", async () => {
    const agentBoot = boots.find((b) => b.req.name.startsWith("rent-agent-")) as (typeof boots)[number];
    const box = await joinBox(agentBoot);
    w.advance(MIN);
    expect(await beat(agentBoot)).toEqual({ state: "running" });
    expect(await beat(boots[1] as (typeof boots)[number])).toEqual({ state: "running" });
    const s = await waitFor(async () => {
      const st = await alex.client().computeState();
      return st.rentals.find((r) => r.id === rentalOf(agentBoot))?.node_id === box.d.nodeId ? st : null;
    }, { what: "the rented node on the owner's state" });
    expect(s.rentals.find((r) => r.id === rentalOf(agentBoot))?.state).toBe("running");
  });

  test("metering: per started minute from the ledger", async () => {
    const start = (await alex.client().computeState()).balance_micros;
    for (let m = 0; m < 10; m++) {
      w.advance(MIN);
      for (const b of boots) await beat(b);
      await tick();
    }
    // Agent: minutes 2..11 (10 more minutes); GPU: minutes 6..11 beyond its 5-minute minimum (6 more).
    const spent = start - (await alex.client().computeState()).balance_micros;
    expect(spent).toBe(10 * 12_500 + (Math.ceil((1_520_000 * 11) / 60) - Math.ceil((1_520_000 * 5) / 60)));
  });

  test("stopping frees the slot: the queued Agent box gets a fresh code from the owner's daemon, boots and joins", async () => {
    const agentBoot = boots.find((b) => b.req.name.startsWith("rent-agent-")) as (typeof boots)[number];
    const queued = rent.rentals.find((r) => r.state === "queued")?.id as string;
    await alex.client().computeStop({ rental_id: rentalOf(agentBoot) });
    const rep = await tick();
    expect(rep.dequeued).toBe(1);
    await computeFor(alex.d.core)?.pollOnce();
    await tick();
    const third = boots.find((b) => rentalOf(b) === queued);
    expect(third).toBeDefined();
    await joinBox(third as (typeof boots)[number]);
    w.advance(MIN);
    expect(await beat(third as (typeof boots)[number])).toEqual({ state: "running" });
    // The stopped box is revoked by the owner's daemon.
    await computeFor(alex.d.core)?.pollOnce();
    await tick();
    await waitFor(() => alex.d.core.roster.nodes.get(boxes[0]?.d.nodeId as string)?.revoked === true, { what: "stopped rental's node revoked" });
  });

  test("minute billing stops machines before the next paid lease is unaffordable and revokes nodes", async () => {
    const live = () => boots.filter((b) => b.req.name && rentalOf(b) !== rentalOf(boots[0] as (typeof boots)[number]));
    for (let i = 0; i < 2000; i++) {
      w.advance(MIN);
      for (const b of live()) await beat(b);
      await tick();
      const st = await alex.client().computeState();
      if (st.rentals.every((r) => r.state === "ended" || r.state === "failed")) break;
    }
    const st = await alex.client().computeState();
    expect(st.rentals.filter((r) => r.end_reason === "no_credit").map((r) => r.tier).sort()).toEqual(["agent", "gpu-20"]);
    expect(st.balance_micros).toBeGreaterThanOrEqual(0);
    expect(st.balance_micros).toBeLessThan(15 * (12_500 + 25_334)); // less than the next fifteen-minute lease
    await computeFor(alex.d.core)?.pollOnce();
    await tick();
    const joined = boxes[1] as TestNode;
    await waitFor(() => alex.d.core.roster.nodes.get(joined.d.nodeId)?.revoked === true, { what: "last rented node revoked" });
    expect(w.cloud.provisions.length).toBe(3);
    expect(await w.cloud.list()).toEqual([]);
  });
});
