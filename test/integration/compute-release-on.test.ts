// v0.2.0-pre.17 (lane E): the daemon lock is ON. The shipped daemon (no test site injected) runs its rental compute
// service against the real site origin, and the CLI's `walkie compute` is the real command. A fresh node makes no site
// call until asked: its local state answers without the site, quotes go to the site. Agent compute writes still pass the
// admin gate: while agent admin is off they are refused before any site call and claim nothing in #general.
// The assertions below hold the poller still (compute autostart false) and run its rounds explicitly, so a background
// poll can't land between them (REVIEW-pre17-codex P3-9); startup traffic with the real poller running is its own test.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Cluster } from "../helpers/cluster.ts";
import { computeFor } from "../../src/daemon/compute/routes.ts";
import { COMMANDS, USAGE } from "../../src/cli/main.ts";
import { compute } from "../../src/cli/commands/compute.ts";
import { RENTAL_COMPUTE_AVAILABLE_IN_THIS_VERSION } from "../../src/protocol/compute-release.ts";
import { SITE_ORIGIN } from "../../src/license/site.ts";

// Every non-loopback request the in-process daemon makes (the preload's fetch guard still refuses each one).
let siteCalls: string[] = [];
let guarded: typeof fetch;
beforeEach(() => {
  siteCalls = [];
  guarded = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(SITE_ORIGIN)) siteCalls.push(new URL(url).pathname);
    return guarded(input, init);
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = guarded; });

test("the shipped daemon and CLI run rental compute: local state without the site, quotes from the site", async () => {
  expect(RENTAL_COMPUTE_AVAILABLE_IN_THIS_VERSION).toBe(true);
  expect(COMMANDS.compute).toBe(compute);
  expect(USAGE).toContain("compute quotes [--json]");
  expect(USAGE).not.toContain("rental compute is not available in this version");
  const cluster = new Cluster();
  try {
    const node = await cluster.add({ name: "alex", login: "alex@example.com", compute: { autostart: false } });
    await node.client().init("acme", "alex");
    const state = await fetch("http://walkie/v1/compute/state", { unix: node.socket } as RequestInit);
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ account_id: null, rentals: [] });
    // Poll rounds of the shipped service, run here: an owner with no compute account and no handover sends nothing.
    for (let i = 0; i < 3; i++) await computeFor(node.d.core)!.pollOnce();
    expect(siteCalls).toEqual([]);
    // The quotes are the site's: the daemon asks it (here the test's fetch guard refuses the request).
    const quotes = await node.client().computeQuotes().then(() => null, (err: Error) => err.message);
    expect(quotes).not.toBeNull();
    expect(quotes).not.toContain("not available in this version");
    expect(siteCalls).toEqual(["/api/compute/quotes"]);
  } finally { await cluster.close(); }
});

test("agent compute writes: refused while agent admin is off before any site call; with it on, a rent asks the site first", async () => {
  const cluster = new Cluster();
  try {
    const node = await cluster.add({ name: "alex", login: "alex@example.com", compute: { autostart: false } });
    await node.client().init("acme", "alex");
    const general = async () => (await node.client().events({ channel: "general", limit: 100 })).events.length;
    const post = (path: string, body: unknown) => fetch(`http://walkie${path}`, { unix: node.socket, method: "POST",
      headers: { "Content-Type": "application/json", "X-Walkie-Agent": "cc-probe" }, body: JSON.stringify(body) } as RequestInit);
    await node.client().adminSwitches({ agent_admin: false });
    const before = await general();
    for (const [path, body] of [
      ["/v1/compute/rent", { machines: [{ tier: "agent", count: 1 }] }],
      ["/v1/compute/stop", { all: true }],
      ["/v1/compute/credit", { block: 50 }],
      ["/v1/compute/handover/object", {}],
    ] as const) {
      const response = await post(path, body);
      expect([path, response.status]).toEqual([path, 403]);
      expect(await response.text()).toContain("agent_admin_off");
    }
    expect(await general()).toBe(before);
    expect(siteCalls).toEqual([]);
    // Agent admin on: the rent's audit line carries the price, so the daemon reads the site's quotes before anything
    // else; when the site cannot answer, nothing is claimed in #general.
    await node.client().adminSwitches({ agent_admin: true });
    const onBefore = await general();
    const rented = await post("/v1/compute/rent", { machines: [{ tier: "agent", count: 1 }] });
    expect(rented.status).toBe(502);
    expect(siteCalls).toEqual(["/api/compute/quotes"]);
    expect(await general()).toBe(onBefore);
  } finally { await cluster.close(); }
});

test("startup with the shipped poller running: an owner on a team that never rented makes no site call", async () => {
  const cluster = new Cluster();
  try {
    // The real scheduler, made fast (rounds every 50 ms from the start): dozens of rounds before and after the team exists.
    const node = await cluster.add({ name: "alex", login: "alex@example.com", compute: { intervalMs: 50, random: () => 0 } });
    await new Promise((r) => setTimeout(r, 300));
    await node.client().init("acme", "alex");
    await new Promise((r) => setTimeout(r, 1_500));
    expect(node.d.core.me()?.role).toBe("owner");
    expect(node.d.core.roster.channels.has("general")).toBe(true);
    expect(siteCalls).toEqual([]);
  } finally { await cluster.close(); }
});
