// TALKIE-OPS-1, the orchestration poll over a real core and board index: free capacity read from the daemon's own views, waiting
// work read from the boards, recommendations made once, kept while true, retired when the situation moves, and nothing written
// (and no model asked) when nothing changed.
import { afterEach, describe, expect, test } from "bun:test";
import { prepareOrchestrationPoll, type PollDeps } from "../../src/daemon/orchestrator/poll.ts";
import { openRecs, readRecs } from "../../src/daemon/orchestrator/recs.ts";
import { updateCard, updateProject } from "../../src/daemon/projects/service.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import type { AccountView } from "../../src/protocol/accounts.ts";
import type { AgentView, NodeView } from "../../src/protocol/schemas.ts";
import type { SeatHostView, SeatView } from "../../src/protocol/seats.ts";
import { recsWorld } from "../helpers/talkie-recs.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });

const H = 3_600_000;
const GIB = 1024 ** 3;
const NODE = "aaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbb";

const node = (id = NODE, name = "mac-a", over: Record<string, unknown> = {}): NodeView => ({
  node_id: id, handle: "maren", hostname: name, ip: "127.0.0.1", transports: ["tailscale"], online: true, last_seen: Date.now(), rtt_ms: 1, self: false,
  sync: { behind: 0, last_sync: null },
  stats: { at: Date.now(), mem: { total: 16 * GIB, used: 4 * GIB, free: 8 * GIB, swap_used: 0, pressure: "normal" }, temp_c: null,
    sys: { os: "linux", arch: "x64", cpus: 8, load1: 0.5, cpu_busy_pct: 10 } }, ...over,
}) as unknown as NodeView;
const host = (id = NODE, name = "mac-a", over: Record<string, unknown> = {}): SeatHostView => ({
  node: id, hostname: name, handle: "maren", self: false, allows: true, member: true, channel: `seats-${id}`, online: true,
  availability: { state: "available", max: 3, running: 0 }, ...over,
}) as SeatHostView;
/** Built when the poll asks, so its reading is as fresh as the mocked clock says. */
const account = ([provider, used, id = NODE]: AccountSpec): AccountView => {
  const usage = { at: Date.now() - 60_000, state: "ok", reason: null, source: "api", until: null, windows: [{ kind: "session", used_pct: used, resets_at: Date.now() + 3 * H, window_s: null, scope: null }] };
  return { key: `maren:${provider}:${id}`, id: provider, provider, label: provider, plan: null, owners: ["maren"], claimed_by: [],
    machines: [{ node_id: id, hostname: "mac-a", handle: "maren", online: true, self: false, agents: [], usage }], usage, usage_host: "mac-a", last_seen: Date.now() } as unknown as AccountView;
};
type AccountSpec = [provider: string, used: number, node?: string];
const seatOn = (id: string, state = "running"): SeatView => ({ id: `${id}:9`, host: { node: id, hostname: "mac-a", handle: "maren" }, state }) as unknown as SeatView;

interface Fleet { nodes: NodeView[]; hosts: SeatHostView[]; seats: SeatView[]; accounts: AccountSpec[]; agents: AgentView[] }

function setup() {
  const t = recsWorld(cleanups);
  const fleet: Fleet = { nodes: [node()], hosts: [host()], seats: [], accounts: [["claude", 10]], agents: [] };
  const deps: PollDeps = { ...t.deps, nodes: () => fleet.nodes, seatHosts: () => fleet.hosts, seats: () => fleet.seats, accounts: () => fleet.accounts.map(account), agents: () => fleet.agents };
  const run = (canAct: () => boolean = () => true) => prepareOrchestrationPoll(deps, canAct);
  const events = () => t.core.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n ?? 0;
  return { t, fleet, deps, run, events };
}

describe("waiting work meets free capacity", () => {
  test("a to-do card nobody is on gets a builder on the machine with a free seat, in the project's channel", async () => {
    const { t, run } = setup();
    const p = await t.project("Website", "WEB", { off: true });
    const c = t.card(p, "Fix the login page");
    t.tick(5 * H);
    const r = await run();
    expect(r).toEqual({ skip: expect.stringContaining("1 machine (3 free seats), 1 card waiting, 0 without a seat; recommendations 1 new, 0 already open.") });
    expect(readRecs(t.deps)).toMatchObject([{
      kind: "start_seat", group: "work", source: "poll", audience: "team", channel: p.channel, status: "pending",
      action: { kind: "start_seat", machine: NODE, runtime: "claude", role: "builder", card: c.id },
      summary: "Start a builder for “Fix the login page”",
    }]);
  });

  test("a card in review with no reviewer gets a reviewer, preferring a vendor other than the builder's", async () => {
    const { t, fleet, run } = setup();
    fleet.accounts = [["claude", 10], ["codex", 20]];
    const p = await t.project("Website", "WEB", { off: true });
    t.card(p, "Check the refund flow", { column: "review", assignee: "@maren/mbp/cc-2" });
    fleet.agents = [t.agent("cc-2", "something else", { handle: "maren", hostname: "mbp", status: { agent: "cc-2", state: "idle", runtime: "claude-code" } as AgentView["status"] })];
    t.tick(6 * H);
    await run();
    expect(openRecs(t.deps)).toMatchObject([{ group: "reviews", action: { role: "reviewer", runtime: "codex" }, reason: expect.stringContaining("6 hours for review") }]);
  });

  test("work that is not waiting for a seat is left alone: blocked, assigned, confidential, waiting on a decision, an agent on it, a reviewer named", async () => {
    const { t, fleet, run } = setup();
    const p = await t.project("Website", "WEB", { off: true });
    t.card(p, "On the board and free");
    updateCard(t.w, t.card(p, "Blocked one").id, { blocked: true });
    t.card(p, "Assigned to a person", { assignee: "@maren" });
    t.card(p, "A secret", { labels: ["Confidential"] });
    t.card(p, "Needs a decision", { labels: ["decision-needed"] });
    const watched = t.card(p, "An agent is on this");
    t.card(p, "A reviewer is named", { column: "review", reviewer: "@maren" });
    t.card(p, "Done work", { column: "done" });
    fleet.agents = [t.agent("cc-9", watched.key)];
    t.tick(5 * H);
    await run();
    expect(openRecs(t.deps).map((r) => (r.action as { card: string }).card)).toEqual([t.idx.db.cards(p.channel, { states: ["open"], limit: 50 }).find((c) => c.title === "On the board and free")!.id]);
  });

  test("a private project's recommendation is for the owners, sits in the owner-only channel, and names only a machine whose person can see it", async () => {
    const { t, fleet, run } = setup();
    const p = await t.project("Ops", "OPS", { off: true, private: true });
    t.card(p, "Rotate the keys");
    t.tick(5 * H);
    // The only free machine is maren's, and maren cannot see the private project: no seat is recommended there.
    expect((await run() as { skip: string }).skip).toContain("1 card waiting, 1 without a seat");
    expect(readRecs(t.deps)).toEqual([]);
    fleet.nodes = [node(NODE, "mac-a", { handle: "alex" })];
    await run();
    expect(readRecs(t.deps)).toMatchObject([{ audience: "owners", channel: SCHEDULE_CHANNEL, project: p.channel }]);
  });

  test("an archived project is not polled", async () => {
    const { t, run } = setup();
    const p = await t.project("Website", "WEB", { off: true });
    t.card(p, "Fix the login page");
    await updateProject(t.w, p.channel, { state: "archived" });
    t.idx.flushAll();
    await run();
    expect(readRecs(t.deps)).toEqual([]);
  });
});

describe("what a machine can take", () => {
  test("a seat per free slot, the oldest work first; the rest wait and are counted", async () => {
    const { t, fleet, run } = setup();
    fleet.hosts = [host(NODE, "mac-a", { availability: { state: "available", max: 4, running: 0 } })];
    fleet.seats = [seatOn(NODE), seatOn(NODE, "queued"), seatOn(NODE, "paused")];
    const p = await t.project("Website", "WEB", { off: true });
    t.card(p, "Older");
    t.tick(H);
    t.card(p, "Newer");
    t.tick(3 * H);
    const r = await run();
    expect(openRecs(t.deps).map((x) => x.summary)).toEqual(["Start a builder for “Older”"]);
    expect((r as { skip: string }).skip).toContain("2 cards waiting, 1 without a seat");
    fleet.seats = [seatOn(NODE), seatOn(NODE, "stopped"), seatOn(NODE, "done")];
    await run();
    expect(openRecs(t.deps)).toHaveLength(2); // a stopped or finished seat does not count
  });

  test("machines that cannot take work are named with why, and nothing is recommended for them", async () => {
    const { t, fleet, run } = setup();
    fleet.nodes = [node(NODE, "mac-a", { online: false }), node(OTHER, "mac-bb", { stats: { at: Date.now(), mem: { total: 16 * GIB, used: 15 * GIB, free: GIB, swap_used: 0, pressure: "normal" }, temp_c: null, sys: { os: "linux", arch: "x64", cpus: 8, load1: 1, cpu_busy_pct: 5 } } })];
    fleet.hosts = [host(NODE, "mac-a"), host(OTHER, "mac-bb")];
    const p = await t.project("Website", "WEB", { off: true });
    t.card(p, "Fix the login page");
    t.tick(5 * H);
    const r = await run();
    expect(readRecs(t.deps)).toEqual([]);
    expect((r as { skip: string }).skip).toContain("Not taking work: mac-a (it is offline); mac-bb (less than 2 GB of memory is free).");
  });

  test("a machine with no account that has room has nothing to run on", async () => {
    const { t, fleet, run } = setup();
    fleet.accounts = [["claude", 95]];
    const p = await t.project("Website", "WEB", { off: true });
    t.card(p, "Fix the login page");
    t.tick(5 * H);
    const r = await run();
    expect(readRecs(t.deps)).toEqual([]);
    expect((r as { skip: string }).skip).toContain("no account has room beyond the 10% reserve");
  });
});

describe("a poll that finds nothing new writes nothing", () => {
  test("the same fleet and the same work again: no record, no event, the same recommendation kept", async () => {
    const { t, run, events } = setup();
    const p = await t.project("Website", "WEB", { off: true });
    t.card(p, "Fix the login page");
    t.tick(5 * H);
    await run();
    const before = events();
    t.tick(5 * 60_000);
    const r = await run();
    expect(events()).toBe(before);
    expect((r as { skip: string }).skip).toContain("recommendations 0 new, 1 already open.");
    expect(openRecs(t.deps)).toHaveLength(1);
  });

  test("an empty team still polls, says so, and writes nothing", async () => {
    const { t, fleet, run, events } = setup();
    fleet.nodes = [];
    fleet.hosts = [];
    const before = events();
    const r = await run();
    expect(r).toEqual({ skip: "Orchestration poll: 0 machines (0 free seats), 0 cards waiting, 0 without a seat; recommendations 0 new, 0 already open." });
    expect(events()).toBe(before);
    void t;
  });

  test("when the seat goes, or the work moves on, the recommendation is retired", async () => {
    const { t, fleet, run } = setup();
    const p = await t.project("Website", "WEB", { off: true });
    const c = t.card(p, "Fix the login page");
    t.tick(5 * H);
    await run();
    expect(openRecs(t.deps)).toHaveLength(1);
    fleet.hosts = [host(NODE, "mac-a", { allows: false })];
    const r = await run();
    expect(openRecs(t.deps)).toEqual([]);
    expect((r as { skip: string }).skip).toContain("1 retired");
    fleet.hosts = [host()];
    await run();
    expect(openRecs(t.deps)).toHaveLength(1);
    updateCard(t.w, c.id, { column: "doing" });
    t.idx.flushAll();
    await run();
    expect(openRecs(t.deps)).toEqual([]);
  });

  test("a seat the poll would now put on another machine keeps its recommendation: the machine is chosen when a person approves", async () => {
    const { t, fleet, run, events } = setup();
    const p = await t.project("Website", "WEB", { off: true });
    t.card(p, "Fix the login page");
    t.tick(5 * H);
    await run();
    const before = events();
    fleet.nodes = [node(NODE, "mac-a"), node(OTHER, "mac-bb")];
    fleet.hosts = [host(NODE, "mac-a", { allows: false }), host(OTHER, "mac-bb")];
    fleet.accounts = [["claude", 10], ["claude", 10, OTHER]];
    const r = await run();
    expect((r as { skip: string }).skip).toContain("0 new, 1 already open");
    expect(openRecs(t.deps).map((x) => (x.action as { machine: string }).machine)).toEqual([NODE]);
    expect(events()).toBe(before); // no retire-and-remake churn
  });

  test("a lost lease stops it before it writes", async () => {
    const { t, run, events } = setup();
    const p = await t.project("Website", "WEB", { off: true });
    t.card(p, "Fix the login page");
    t.tick(5 * H);
    const before = events();
    await expect(run(() => false)).rejects.toThrow("lease expired");
    expect(events()).toBe(before);
  });
});
