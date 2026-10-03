// RENT-2: `walkie compute …` (a fake daemon client), the machine-ask parser, the site client's strict contract and the
// compute files. Prices only: no JSON the CLI prints carries a cost/margin/provider key or a cost number.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compute, creditText, listText, quotesText } from "../../src/cli/commands/compute.ts";
import type { Ctx } from "../../src/cli/context.ts";
import { UsageError } from "../../src/cli/args.ts";
import { loadAccount, loadRentals, newRecord, RentalsFileError, saveAccount, saveRentals, accountPath, rentalsPath } from "../../src/daemon/compute/files.ts";
import { ComputeSite, ComputeSiteError, computeBaseFromEnv } from "../../src/daemon/compute/site.ts";
import { SITE_ORIGIN } from "../../src/license/site.ts";
import { FORBIDDEN_CUSTOMER_KEYS, parseMachineAsks, usd } from "../../src/protocol/compute.ts";
import { COST_NUMBERS, forbiddenKeys, PRIVATE_WORDS, QUOTES, rental, state } from "../helpers/compute-fixtures.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("parseMachineAsks", () => {
  test("counts, defaults to 1, adds up repeats, keeps tier order of first mention", () => {
    expect(parseMachineAsks(["agent=2", "gpu-48", "agent"])).toEqual([{ tier: "agent", count: 3 }, { tier: "gpu-48", count: 1 }]);
    expect(parseMachineAsks(["agent-xl=1"])).toEqual([{ tier: "agent-xl", count: 1 }]);
  });
  test("refuses unknown tiers, zero, junk and more than 50 machines", () => {
    for (const bad of [["gpu-24"], ["agent=0"], ["agent=-1"], ["agent=x"], ["AGENT"], ["agent=1000"], [], ["agent=30", "gpu-20=21"]]) {
      expect(() => parseMachineAsks(bad)).toThrow();
    }
    expect(parseMachineAsks(["agent=25", "gpu-20=25"]).reduce((a, m) => a + m.count, 0)).toBe(50);
  });
});

describe("usd", () => {
  test("cents, thousands separators, rounds a part-cent UP", () => {
    expect(usd(750_000)).toBe("$0.75");
    expect(usd(1_219_100_000)).toBe("$1,219.10");
    expect(usd(1)).toBe("$0.01");
    expect(usd(0)).toBe("$0.00");
    expect(usd(-2_500_000)).toBe("-$2.50");
  });
});

interface Fake { ctx: Ctx; out: string[]; calls: unknown[] }
function fakeCtx(pos: string[], flags: Record<string, boolean | string> = {}, client: Record<string, (...a: never[]) => unknown> = {}): Fake {
  const out: string[] = [];
  const calls: unknown[] = [];
  const recorded = Object.fromEntries(Object.entries(client).map(([k, fn]) => [k, (...a: never[]) => { calls.push([k, ...a]); return fn(...a); }]));
  const ctx = {
    args: { pos, flags: new Map(Object.entries(flags)) }, json: flags.json === true, forAgent: false,
    agentMarker: () => null, person: { interactive: () => true, ask: async () => "yes", note: () => undefined },
    client: () => recorded, out: (s: string) => out.push(s), err: (s: string) => out.push(s),
  } as unknown as Ctx;
  return { ctx, out, calls };
}

function noCost(text: string): void {
  for (const n of COST_NUMBERS) expect(text).not.toContain(n);
  for (const w of PRIVATE_WORDS) expect(text.toLowerCase()).not.toContain(w.toLowerCase());
  expect(text.toLowerCase()).not.toMatch(/\bcost\b|margin|markup|wholesale/);
}

describe("walkie compute (fake daemon)", () => {
  test('handover object invokes the owner daemon once', async () => {
    const t = fakeCtx(['handover', 'object'], {}, { computeHandoverObject: async () => ({ objected: true }) });
    await compute(t.ctx);
    expect(t.calls).toEqual([['computeHandoverObject']]);
    expect(t.out[0]).toContain('operator review');
    await expect(compute(fakeCtx(['handover', 'unknown']).ctx)).rejects.toBeInstanceOf(UsageError);
  });
  test("quotes: prices per hour and month, no cost anywhere (text and --json)", async () => {
    const t = fakeCtx(["quotes"], {}, { computeQuotes: async () => QUOTES });
    await compute(t.ctx);
    expect(t.out[0]).toContain("$0.75/h");
    expect(t.out[0]).toContain("$8.82/h");
    expect(t.out[0]).toContain("$1,095.00/month");
    expect(t.out[0]).toContain("$1.52/h  $1,109.60/month · 5-minute minimum");
    expect(t.out[0]).not.toMatch(/\$0\.75\/h  \$547\.50\/month · /); // CPU tiers: no minimum line
    expect(t.out[0]).toContain("Each machine includes 1,024 GiB of outbound data, then $0.02 per GiB.");
    noCost(t.out.join("\n"));
    const j = fakeCtx(["quotes"], { json: true }, { computeQuotes: async () => QUOTES });
    await compute(j.ctx);
    expect(forbiddenKeys(JSON.parse(j.out[0] as string), FORBIDDEN_CUSTOMER_KEYS)).toEqual([]);
    noCost(j.out[0] as string);
  });

  test("rent: parses the tiers, sends them once, prints N started, M queued", async () => {
    const res = { rentals: [rental(), rental({ id: "r_00000000000000a2", state: "queued", queue_position: 1, started_at: null, spent_micros: 0 })], started: 1, queued: 1, code_index: { r_00000000000000a1: 0 }, balance_micros: 49_000_000, replay: false };
    const t = fakeCtx(["rent", "agent=2"], { yes: true, idle: "45" }, { computeRent: async () => res });
    await compute(t.ctx);
    expect(t.calls).toEqual([["computeRent", { machines: [{ tier: "agent", count: 2 }], idle_minutes: 45 }]]);
    expect(t.out[0]).toContain("1 started, 1 queued");
    expect(t.out[0]).toContain("queued #1");
    noCost(t.out.join("\n"));
    const j = fakeCtx(["rent", "agent=2"], { yes: true, json: true }, { computeRent: async () => res });
    await compute(j.ctx);
    expect(forbiddenKeys(JSON.parse(j.out[0] as string), FORBIDDEN_CUSTOMER_KEYS)).toEqual([]);
  });

  test("rent refuses a bad tier or idle before calling the daemon", async () => {
    for (const [pos, flags] of [[["rent", "gpu-24"], {}], [["rent"], {}], [["rent", "agent"], { idle: "5" }]] as const) {
      const t = fakeCtx([...pos], { yes: true, ...flags }, { computeRent: async () => { throw new Error("must not be called"); } });
      await expect(compute(t.ctx)).rejects.toBeInstanceOf(UsageError);
      expect(t.calls).toEqual([]);
    }
  });

  test("credit: balance, burn and hours left; credit buy prints the checkout link; bad blocks refused", async () => {
    const s = state([rental()]);
    const t = fakeCtx(["credit"], {}, { computeState: async () => s });
    await compute(t.ctx);
    expect(t.out[0]).toContain("balance $49.16");
    expect(t.out[0]).toContain("using $0.75/h");
    expect(t.out[0]).toContain("58.5 h left");
    const b = fakeCtx(["credit", "buy", "200"], { "no-open": true }, { computeCredit: async () => ({ url: "https://checkout.stripe.com/c/pay/cs_test_x" }) });
    await compute(b.ctx);
    expect(b.calls).toEqual([["computeCredit", 200]]);
    expect(b.out[0]).toContain("cs_test_x");
    await expect(compute(fakeCtx(["credit", "buy", "75"]).ctx)).rejects.toBeInstanceOf(UsageError);
  });

  test("list / credit with no account yet", () => {
    const none = { account_id: null, team_id: "0123456789abcdef", status: "none", balance_micros: 0, burn_per_hour_micros: 0, hours_left: null, rentals: [] } as const;
    expect(listText({ ...none, rentals: [] })).toContain("nothing rented yet");
    expect(creditText({ ...none, rentals: [] })).toContain("$0.00");
  });

  test("list tells the owner when an ended rental's machine is still on the team (queued or refused revocation)", () => {
    const ended = rental({ state: "ended", end_reason: "user", ended_at: 1 });
    const text = listText(state([ended], { alerts: ["revocation_pending", "revocation_refused", "revocation_waiting_for_authority_sync", "compute_records_unreadable"] }));
    expect(text).toContain("An ended rental can't be closed yet: this machine hasn't been able to sync with the team's roster authority");
    expect(text).toContain("Walkie can't read its record of rented machines, so ended rentals aren't being removed from the team (revocations are paused). Inspect or restore ~/.walkie/compute-rentals.json; Walkie never overwrites it.");
    expect(text).toContain("still on the team after its rental ended. Walkie removes it as soon as the team's roster authority is reachable.");
    expect(text).toContain("couldn't be removed automatically. The reason is posted in #general.");
    expect(listText(state([ended]))).not.toContain("still on the team");
    noCost(text);
  });

  test("list shows active rentals, counts ended ones; stop needs a rental id or all", async () => {
    const text = listText(state([rental(), rental({ id: "r_00000000000000a3", state: "ended", end_reason: "idle", ended_at: 1 })]));
    expect(text).toContain("rent-agent-7f3a");
    expect(text).toContain("1 ended");
    await expect(compute(fakeCtx(["stop", "rent-agent-7f3a"], { yes: true }).ctx)).rejects.toBeInstanceOf(UsageError);
    const t = fakeCtx(["stop", "all"], { yes: true }, { computeStop: async () => ({ stopped: 2, rentals: [] }) });
    await compute(t.ctx);
    expect(t.calls).toEqual([["computeStop", { all: true }]]);
    expect(quotesText(QUOTES)).toContain("walkie compute rent");
  });
});

function site(handler: (url: string, init: RequestInit) => Response): ComputeSite {
  return new ComputeSite({ base: "https://site.test", fetch: async (u, i) => handler(u, i) });
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("ComputeSite (strict contract)", () => {
  test("a reply with a field the contract doesn't know (a cost) is refused, not passed on", async () => {
    const withCost = { ...QUOTES, tiers: QUOTES.tiers.map((t) => ({ ...t, cost_per_hour_micros: 375_000 })) };
    await expect(site(() => reply(withCost)).quotes()).rejects.toMatchObject({ code: "bad_site_reply", status: 502 });
    const provider = { ...state(), rentals: [{ ...rental(), provider: "x", instance_type: "g-8vcpu-32gb" }] };
    await expect(site(() => reply(provider)).state("t".repeat(43))).rejects.toMatchObject({ code: "bad_site_reply" });
    expect(await site(() => reply(QUOTES)).quotes()).toEqual(QUOTES);
  });

  test("errors: the site's code and numeric details only; the bearer token goes in the header", async () => {
    let auth = "";
    const s = site((_u, init) => {
      auth = new Headers(init.headers).get("authorization") ?? "";
      return reply({ error: "insufficient_credit", needed_micros: 2_500_000, balance_micros: 1_000_000, note: "<script>", cost: 1 }, 402);
    });
    const e = await s.state("tok_".padEnd(43, "a")).catch((x: unknown) => x) as ComputeSiteError;
    expect(e).toBeInstanceOf(ComputeSiteError);
    expect(e.code).toBe("insufficient_credit");
    expect(e.details).toEqual({ needed_micros: 2_500_000, balance_micros: 1_000_000 });
    expect(auth).toBe(`Bearer ${"tok_".padEnd(43, "a")}`);
  });

  test("unreachable: status 0; redirects are never followed", async () => {
    let redirect: RequestRedirect | undefined;
    const e = await new ComputeSite({ base: "https://site.test", fetch: async (_u, i) => { redirect = i.redirect; throw new TypeError("boom"); } }).quotes().catch((x: unknown) => x);
    expect(e).toMatchObject({ status: 0, code: "site_unreachable" });
    expect(redirect).toBe("error");
  });

  test("WALKIE_COMPUTE_SITE is a development override for loopback only", () => {
    expect(computeBaseFromEnv({ WALKIE_COMPUTE_SITE: "http://127.0.0.1:9", WALKIE_DEV: "1" }, false)).toBe("http://127.0.0.1:9");
    expect(computeBaseFromEnv({ WALKIE_COMPUTE_SITE: "http://127.0.0.1:9" }, false)).toBe(SITE_ORIGIN);
    expect(computeBaseFromEnv({ WALKIE_COMPUTE_SITE: "https://evil.example", WALKIE_DEV: "1" }, false)).toBe(SITE_ORIGIN);
    expect(computeBaseFromEnv({ WALKIE_COMPUTE_SITE: "http://127.0.0.1:9", WALKIE_DEV: "1" }, true)).toBe(SITE_ORIGIN);
  });
});

describe("compute files", () => {
  test("account and rentals: 0600, validated; a junk account reads as nothing, a junk rentals file is refused (never read as empty)", () => {
    const home = mkdtempSync("/tmp/walkie-compute-");
    dirs.push(home);
    expect(loadAccount(home)).toBeNull();
    const acc = { account_id: "ca_00000000000000c1", team: "0123456789abcdef", token: "A".repeat(43) };
    saveAccount(home, acc);
    expect(loadAccount(home)).toEqual(acc);
    expect(statSync(accountPath(home)).mode & 0o777).toBe(0o600);
    expect(() => saveAccount(home, { ...acc, token: "short" })).toThrow();
    saveRentals(home, { r_00000000000000a1: newRecord("agent", ["0".repeat(32)], 1) });
    expect(statSync(rentalsPath(home)).mode & 0o777).toBe(0o600);
    expect(loadRentals(home).r_00000000000000a1?.invite_ids).toEqual(["0".repeat(32)]);
    writeFileSync(accountPath(home), "{not json");
    writeFileSync(rentalsPath(home), JSON.stringify({ v: 1, rentals: { bad: {} } }));
    expect(loadAccount(home)).toBeNull();
    // The poller writes the records back after every round: reading a damaged (or newer) file as empty would wipe the
    // links from active rentals to their machines, so it throws and leaves the file alone.
    expect(() => loadRentals(home)).toThrow(RentalsFileError);
    writeFileSync(rentalsPath(home), "{not json");
    expect(() => loadRentals(home)).toThrow(RentalsFileError);
    expect(readFileSync(rentalsPath(home), "utf8")).toBe("{not json");
    rmSync(rentalsPath(home));
    expect(loadRentals(home)).toEqual({}); // no file yet is simply none
  });
});
