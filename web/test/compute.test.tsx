// RENT-2: "Add compute" in Machines (Team page) and Mission Control, owners only; the dialog lists the four tiers with
// PRICES ONLY, a count per tier, the running total, the credit balance and "Buy credit"; rented machines carry a
// "Rented · <tier> · $X/h" chip with Stop. No cost, margin, provider or instance type may ever render.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MeView, NodeView, TeamView } from "../src/api/types.ts";
import type { State } from "../src/state/reducer.ts";
import type { ComputeState, Quotes, RentResult, RentalView } from "../../src/protocol/compute.ts";
import { FORBIDDEN_CUSTOMER_KEYS } from "../../src/protocol/compute.ts";
import type { AddComputeViewProps } from "../src/views/compute/AddComputeSheet.tsx";

import { go, installWindow } from "./window-stub.ts";
const hadWindow = "window" in globalThis;
const hadDocument = "document" in globalThis;
installWindow();
const inert: unknown = new Proxy(() => inert, { get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : inert), apply: () => undefined });
(globalThis as { document?: unknown }).document ??= inert;
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
  if (!hadDocument) delete (globalThis as { document?: unknown }).document;
});

type ComputeMod = typeof import("../src/api/compute.ts");
let mod: {
  Team: () => ReactNode; MissionControl: () => ReactNode;
  AddComputeView: (p: AddComputeViewProps) => ReactNode;
  AddComputeSheet: (p: { onClose: () => void }) => ReactNode;
  hourlyTotal: (q: Quotes, c: Record<string, number>) => number;
  RentedChip: (p: { rental: RentalView; quotes: Quotes | null; canStop: boolean }) => ReactNode;
  StaticStore: (p: { state: State; children: ReactNode }) => ReactNode; initialState: State;
  api: ComputeMod;
};
beforeAll(async () => {
  const [tm, mc, ac, rc, st, rd, api] = await Promise.all([
    import("../src/views/Team.tsx"), import("../src/views/mission/MissionControl.tsx"), import("../src/views/compute/AddComputeSheet.tsx"),
    import("../src/views/compute/RentedChip.tsx"), import("../src/state/store.tsx"), import("../src/state/reducer.ts"), import("../src/api/compute.ts"),
  ]);
  mod = {
    Team: tm.Team, MissionControl: mc.MissionControl, AddComputeView: ac.AddComputeView, AddComputeSheet: ac.AddComputeSheet,
    hourlyTotal: ac.hourlyTotal as never,
    RentedChip: rc.RentedChip, StaticStore: st.StaticStore, initialState: rd.initialState, api,
  };
});

const NOW = Date.now();
const QUOTES: Quotes = {
  available: true,
  currency: "usd", min_hours_covered: 1, credit_blocks: [50, 200, 1000], egress_included_gib: 1024, egress_price_per_gib_micros: 20_000,
  tiers: [
    { id: "agent", name: "Agent box", specs: "8 dedicated vCPU · 32 GB RAM · 100 GB disk", gpu: null, good_for: "About 6-10 coding agents at once, with their builds and tests.", price_per_hour_micros: 750_000, price_per_month_micros: 547_500_000, min_minutes: 1 },
    { id: "agent-xl", name: "Agent box XL", specs: "16 dedicated vCPU · 64 GB RAM · 200 GB disk", gpu: null, good_for: "About 15-20 agents, or heavy builds (Rust, monorepos, browser tests).", price_per_hour_micros: 1_500_000, price_per_month_micros: 1_095_000_000, min_minutes: 1 },
    { id: "gpu-20", name: "GPU 20 GB", specs: "8 vCPU · 32 GB RAM · 500 GB NVMe · Toronto", gpu: "NVIDIA RTX 4000 Ada 20 GB", good_for: "One 20B-class open model at 4-bit (or 14B at 8-bit) for the team's pool.", price_per_hour_micros: 1_520_000, price_per_month_micros: 1_109_600_000, min_minutes: 5 },
    { id: "gpu-48", name: "GPU 48 GB", specs: "8 vCPU · 64 GB RAM · 500 GB NVMe · Toronto", gpu: "NVIDIA L40S 48 GB", good_for: "30B-class open models; a 70B model at 4-bit with a short context.", price_per_hour_micros: 3_140_000, price_per_month_micros: 2_292_200_000, min_minutes: 5 },
    { id: "gpu-80", name: "GPU 80 GB", specs: "20 vCPU · 240 GB RAM", gpu: "NVIDIA H100 80 GB", good_for: "70B-class open models at 4-bit with room for context.", price_per_hour_micros: 8_820_000, price_per_month_micros: 6_438_600_000, min_minutes: 5 },
  ],
};
const RUNNING: RentalView = {
  id: "r_0123456789abcdef", tier: "agent", name: "rent-agent-7f3a", state: "running", queue_position: null, price_per_hour_micros: 750_000,
  spent_micros: 2_380_000, created_at: NOW - 3_600_000, started_at: NOW - 3_500_000, ended_at: null, end_reason: null, node_id: "a1b2c3d4e5f60718", idle_minutes: 30,
};
const QUEUED: RentalView = { ...RUNNING, id: "r_fedcba9876543210", tier: "gpu-20", name: "rent-gpu-20-c21d", state: "queued", queue_position: 1, price_per_hour_micros: 1_520_000, spent_micros: 0, started_at: null, node_id: null };
const STATE: ComputeState = {
  account_id: "ca_5e2b9d0c41a7f836", team_id: "7c1e4a90b25fd318", status: "active", balance_micros: 143_200_000,
  burn_per_hour_micros: 750_000, hours_left: 190.9, rentals: [RUNNING, QUEUED],
};

const noop = () => {};
const view = (over: Partial<AddComputeViewProps> = {}) => renderToStaticMarkup(
  <mod.AddComputeView quotes={QUOTES} state={STATE} counts={{}} onCount={noop} onRent={noop} onBuy={noop} onStop={noop} busy={null} result={null} error={null} {...over} />,
);

const node = (hostname: string, handle: string, id: string): NodeView => ({
  node_id: id, handle, hostname, ip: "", online: true, last_seen: NOW, rtt_ms: 3, self: hostname === "maren-mbp", sync: { behind: 0, last_sync: NOW },
});
const NODES = [node("maren-mbp", "maren", "n1"), node("rent-agent-7f3a", "maren", RUNNING.node_id as string)];
const TEAM: TeamView = {
  id: "t", name: "harbor", authority: "n1", channels: [], nodes: NODES, plan: undefined as never,
  members: [{ login: "direct:maren", handle: "maren", role: "owner", display_name: "Maren Holt" }, { login: "direct:arvid", handle: "arvid", role: "observer", display_name: "Arvid" }],
};
const state = (role: "owner" | "member" | "observer", handle: string): State => ({
  ...mod.initialState, phase: "ready", team: TEAM, nodes: NODES,
  me: { handle, role, transport: { mode: "direct" }, tailscale: { ok: false } } as unknown as MeView,
});
const render = (s: State, el: ReactNode) => renderToStaticMarkup(<mod.StaticStore state={s}>{el}</mod.StaticStore>);
const seed = () => mod.api.computeStore.seed({ status: "ready", state: STATE, quotes: QUOTES, error: null });

test("the dialog: five tiers with name, specs, GPU, good-for, price per hour and per month, GPU minimum, egress terms", () => {
  const out = view();
  for (const t of QUOTES.tiers) {
    expect(out).toContain(`data-testid="ac-tier-${t.id}"`);
    expect(out).toContain(t.name);
    expect(out).toContain(t.specs);
    expect(out).toContain(t.good_for.replace(/'/g, "&#x27;"));
  }
  expect(out).toContain("NVIDIA RTX 4000 Ada 20 GB");
  expect(out).toContain("NVIDIA L40S 48 GB");
  expect(out).toContain("NVIDIA H100 80 GB");
  for (const p of ["$0.75", "$1.50", "$1.52", "$3.14", "$8.82"]) expect(out).toContain(p);
  expect(out).toContain("$547.50/month");
  expect(out).toContain("$6,438.60/month");
  for (const id of ["gpu-20", "gpu-48", "gpu-80"]) expect(out).toContain(`data-testid="ac-min-${id}">5-minute minimum<`);
  expect(out).not.toContain('data-testid="ac-min-agent"');
  expect(out).not.toContain('data-testid="ac-min-agent-xl"');
  expect(out).toContain("Each machine includes 1,024 GiB of outbound data per 730 hours, prorated by rented hours, then $0.02 per GiB.");
  expect(out).toContain('aria-label="More GPU 48 GB"');
  // nothing picked: the total says so and Rent is disabled
  expect(out).toContain("Pick at least one machine");
  expect(out).toMatch(/<button type="button" class="btn btn-primary" disabled="">Rent<\/button>/);
});

test("the credit line: balance, hours left at the burn, and Buy credit $50 / $200 / $1,000", () => {
  const out = view();
  expect(out).toContain("<b class=\"tnum\">$143.20</b>");
  expect(out).toContain("about 190 h left at $0.75/h");
  expect(out).toContain(">$50<");
  expect(out).toContain(">$200<");
  expect(out).toContain(">$1,000<");
  expect(view({ state: { ...STATE, burn_per_hour_micros: 0, hours_left: null } })).toContain("nothing running");
});

test("totals: counts per tier add up per hour; Rent names the count", () => {
  const counts = { agent: 2, "gpu-20": 1 };
  expect(mod.hourlyTotal(QUOTES, counts)).toBe(2 * 750_000 + 1_520_000);
  const out = view({ counts });
  expect(out).toContain("3 machines · $3.02/h");
  expect(out).toContain(">Rent 3 machines<");
  expect(out).not.toContain('data-testid="ac-short"');
  expect(out).toContain('class="ac-tier is-on" data-testid="ac-tier-agent"');
});

test("not enough credit for the first hour: the hint names the need and the balance, Rent is disabled", () => {
  const out = view({ counts: { "gpu-48": 2 }, state: { ...STATE, balance_micros: 5_000_000 } });
  expect(out).toContain("Needs $6.28 of credit for the first hour; the balance is $5.00.");
  expect(out).toMatch(/class="btn btn-primary" disabled="">Rent 2 machines</);
});

test("a rent result: N started, M queued", () => {
  const result: RentResult = { rentals: [], started: 2, queued: 1, code_index: {}, balance_micros: 1, replay: false };
  const out = view({ result });
  expect(out).toContain("2 started, 1 queued.");
  expect(out).toContain("Queued machines start as soon as there");
});

test("the dialog lists rented machines not yet stopped, with state and Stop", () => {
  const out = view();
  expect(out).toContain('data-testid="ac-rental-r_fedcba9876543210"');
  expect(out).toContain("Queued · #1");
  expect(out).toContain('aria-label="Stop rent-gpu-20-c21d"');
  const ended = view({ state: { ...STATE, rentals: [{ ...QUEUED, state: "ended" }] } });
  expect(ended).not.toContain("Your rented machines");
});

test("Buy credit asks the daemon for a checkout link and opens it", async () => {
  const calls: Array<{ url: string; body: string | null; method: string }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: (init?.body as string) ?? null, method: init?.method ?? "GET" });
    return new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_test_1" }), { status: 200 });
  }) as unknown as typeof fetch;
  const opened: string[] = [];
  await mod.api.buyCredit(200, (u) => opened.push(u));
  expect(calls).toEqual([{ url: "/v1/compute/credit", body: JSON.stringify({ block: 200 }), method: "POST" }]);
  expect(opened).toEqual(["https://checkout.stripe.com/c/pay/cs_test_1"]);
});

test('adopted accounts appear in the dashboard and requests select the chosen account', async () => {
  const second = 'ca_0123456789abcdef';
  mod.api.computeStore.seed({ status: 'ready', quotes: QUOTES, error: null, state: { ...STATE,
    accounts: [{ account_id: STATE.account_id, status: 'active', balance_micros: 0, burn_per_hour_micros: 0, hours_left: null },
      { account_id: second, status: 'active', balance_micros: 5_000_000, burn_per_hour_micros: 0, hours_left: null }] } });
  const html = renderToStaticMarkup(<mod.AddComputeSheet onClose={noop} />);
  expect(html).toContain('aria-label="Compute account"');
  expect(html).toContain(second);
  const calls: string[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calls.push(init?.body as string);
    return Response.json({ url: 'https://checkout.test/fixture' });
  }) as unknown as typeof fetch;
  await mod.api.computeApi.credit(50, second);
  expect(calls[0]).toBe(JSON.stringify({ block: 50, account_id: second }));
});

test("a 402 insufficient_credit carries the amounts; the state 404 before first use is an empty account", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: "insufficient_credit", message: "x", needed_micros: 750_000, balance_micros: 0 } }), { status: 402 })) as unknown as typeof fetch;
  const err = await mod.api.computeApi.rent([{ tier: "agent", count: 1 }]).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(mod.api.ComputeError);
  expect((err as InstanceType<ComputeMod["ComputeError"]>).code).toBe("insufficient_credit");
  expect((err as InstanceType<ComputeMod["ComputeError"]>).neededMicros).toBe(750_000);
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: "no_compute_account", message: "none yet" } }), { status: 404 })) as unknown as typeof fetch;
  const s = await mod.api.computeApi.state();
  expect(s.balance_micros).toBe(0);
  expect(s.rentals).toEqual([]);
  globalThis.fetch = (async () => new Response(JSON.stringify({ account_id: null, team_id: "7c1e4a90b25fd318", status: "none", balance_micros: 0, burn_per_hour_micros: 0, hours_left: null, rentals: [] }), { status: 200 })) as unknown as typeof fetch;
  const none = await mod.api.computeApi.state();
  expect(none.balance_micros).toBe(0);
  expect(none.rentals).toEqual([]);
});

test("a response that grows a cost field is refused, not rendered (strict contract)", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ ...QUOTES, tiers: QUOTES.tiers.map((t) => ({ ...t, cost_per_hour_micros: 1 })) }), { status: 200 })) as unknown as typeof fetch;
  const err = await mod.api.computeApi.quotes().catch((e: unknown) => e);
  expect((err as { code?: string }).code).toBe("bad_response");
});

test("Stop on a rented machine asks first; declining sends nothing", async () => {
  let sent = 0;
  globalThis.fetch = (async () => { sent += 1; return new Response(JSON.stringify({ stopped: 1, rentals: [{ ...RUNNING, state: "ended" }] }), { status: 200 }); }) as unknown as typeof fetch;
  expect(await mod.api.stopRental(RUNNING.id, RUNNING.name, () => false)).toBe(false);
  expect(sent).toBe(0);
  let asked = "";
  expect(await mod.api.stopRental(RUNNING.id, RUNNING.name, (m) => { asked = m; return true; })).toBe(true);
  expect(asked).toContain("Stopping deletes the machine and its disk");
  expect(sent).toBeGreaterThanOrEqual(1);
  seed();
});

test("Machines (owner): Add compute, the rented chip with Stop on the rented machine, queued rentals listed", () => {
  seed();
  go("#/team");
  const out = render(state("owner", "maren"), <mod.Team />);
  expect(out).toContain("Add compute");
  expect(out).toContain('data-testid="rented-r_0123456789abcdef"');
  expect(out).toContain("Rented · Agent box · $0.75/h");
  expect(out).toContain('aria-label="Stop rent-agent-7f3a"');
  expect(out).toContain('data-testid="rented-pending-r_fedcba9876543210"');
  expect(out.match(/Rented · /g)).toHaveLength(2); // joined and queued rentals both retain shutdown controls
});

test("Machines (owner): alerts say what is wrong, including an ended rental's machine still on the team", () => {
  mod.api.computeStore.seed({ status: "ready", state: { ...STATE, alerts: ["tick_stale", "termination_delayed", "revocation_pending", "revocation_refused", "revocation_waiting_for_authority_sync", "compute_records_unreadable"] }, quotes: QUOTES, error: null });
  go("#/team");
  const out = render(state("owner", "maren"), <mod.Team />);
  expect(out).toContain("Compute monitoring is delayed. New rentals are paused.");
  expect(out).toContain("Shutdown is delayed. Billing continues until deletion is confirmed.");
  expect(out).toContain("A rented machine is still on the team after its rental ended. Walkie removes it as soon as the team&#x27;s roster authority is reachable.");
  expect(out).toContain("A rented machine is still on the team after its rental ended and couldn&#x27;t be removed automatically. The reason is posted in #general.");
  expect(out).toContain("An ended rental can&#x27;t be closed yet: this machine hasn&#x27;t been able to sync with the team&#x27;s roster authority");
  expect(out).toContain("Walkie can&#x27;t read its record of rented machines, so ended rentals aren&#x27;t being removed from the team (revocations are paused). Inspect or restore ~/.walkie/compute-rentals.json; Walkie never overwrites it.");
  expect(out.match(/role="alert"/g)).toHaveLength(6);
  seed();
});

test("Mission Control (owner): WalkieTalkie, Add compute, and the rented machine render together", () => {
  seed();
  go("#/mission");
  const working = {
    id: "maren/rent-agent-7f3a/seat-1", handle: "maren", node: RUNNING.node_id as string, hostname: "rent-agent-7f3a", agent: "seat-1",
    status: { agent: "seat-1", state: "working", runtime: "claude-code", title: "Run the test suite" }, updated_at: NOW, machine_online: true,
    effective_state: "working", archived: false,
  } as State["agents"][number];
  const out = render({ ...state("owner", "maren"), agents: [working] }, <mod.MissionControl />);
  expect(out).toContain('data-testid="walkietalkie-card"');
  expect(out).toContain("Add compute");
  expect(out).toContain("Rented · Agent box · $0.75/h");
  expect(out).toContain('aria-label="Stop rent-agent-7f3a"');
});

test("observers and members see neither Add compute nor rental controls", () => {
  seed();
  for (const role of ["observer", "member"] as const) {
    go("#/team");
    const team = render(state(role, "arvid"), <mod.Team />);
    expect(team).not.toContain("Add compute");
    expect(team).not.toContain("Rented · ");
    expect(team).not.toContain("Stop rent-");
    go("#/mission");
    const mission = render(state(role, "arvid"), <mod.MissionControl />);
    expect(mission).not.toContain("Add compute");
    expect(mission).not.toContain("Rented · ");
  }
});

// Our cost per hour for the tiers (DigitalOcean, plan §3A.4), per hour, in micros and per 730-hour month: none may
// ever reach a customer's screen. 0.75 / 750000 is left out on purpose: the Agent box XL's cost is the Agent box's price.
const COST_NUMBERS = ["0.375", "0.76", "1.57", "4.41", "375000", "760000", "1570000", "4410000", "273.75", "554.80", "1146.10", "3219.30"];
const PRIVATE_WORDS = ["digitalocean", "g-8vcpu-32gb", "g-16vcpu-64gb", "gpu-4000adax1-20gb", "gpu-l40sx1-48gb", "gpu-h100x1-80gb", "tor1", "nyc3"];

test("customers never see our cost: no cost/margin/provider/instance-type words or cost numbers in the dialog or chip", () => {
  seed();
  const outputs = [
    view(),
    view({ counts: { agent: 1, "agent-xl": 1, "gpu-20": 1, "gpu-48": 1, "gpu-80": 1 }, state: { ...STATE, balance_micros: 1 } }),
    view({ result: { rentals: [RUNNING], started: 1, queued: 0, code_index: { [RUNNING.id]: 0 }, balance_micros: 1, replay: false } }),
    renderToStaticMarkup(<mod.RentedChip rental={RUNNING} quotes={QUOTES} canStop />),
    (go("#/team"), render(state("owner", "maren"), <mod.Team />)),
    (go("#/mission"), render(state("owner", "maren"), <mod.MissionControl />)),
  ];
  const words = new RegExp(FORBIDDEN_CUSTOMER_KEYS.source, "gi");
  for (const html of outputs.slice(0, 4)) {
    const text = html.replace(/<[^>]+>/g, " ");
    expect(text.match(words)).toBeNull();
    expect(html.match(words)).toBeNull(); // attributes, test ids and class names too
  }
  for (const html of outputs) {
    for (const n of COST_NUMBERS) expect(html).not.toContain(n);
    for (const w of PRIVATE_WORDS) expect(html.toLowerCase()).not.toContain(w);
    expect(html).not.toMatch(/\bAWS\b|m7i\.|g6e?\.xlarge/);
  }
});

test("disabled capability hides purchases and Add compute but preserves Stop", () => {
  const quotes = { ...QUOTES, available: false };
  expect(view({ quotes })).not.toContain('Buy credit');
  mod.api.computeStore.seed({ status: 'ready', state: STATE, quotes, error: null });
  const html = render(state('owner', 'maren'), <mod.Team />);
  expect(html).not.toContain('Add compute');
  expect(html).toContain('Stop');
});
test('disabled capability never installs the recurring dashboard poll', async () => {
  const originalInterval = globalThis.setInterval;
  let intervals = 0, states = 0;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => { intervals++; return originalInterval(...args); }) as typeof setInterval;
  globalThis.fetch = (async (url: string) => {
    if (url.endsWith('/quotes')) return Response.json({ ...QUOTES, available: false });
    states++; return Response.json(STATE);
  }) as typeof fetch;
  const release = mod.api.computeStore.retain();
  try {
    await Bun.sleep(20);
    expect(intervals).toBe(0);
    expect(states).toBe(1);
  } finally { release(); globalThis.setInterval = originalInterval; }
});
test('disabled compute still lets an owner stop each unjoined rental', () => {
  mod.api.computeStore.seed({ status: 'ready', state: STATE, quotes: { ...QUOTES, available: false }, error: null });
  const html = render(state('owner', 'maren'), <mod.Team />);
  expect(html.includes(`aria-label="Stop ${QUEUED.name}"`)).toBe(true);
  expect(html.includes('Add compute')).toBe(false);
});
