// WALK-108: a private project's card title, and a confidential card's title, must not be written into a recommendation
// posted in the owner-only schedule channel. A newly added owner is in that channel before the roster authority admits
// them to the private project, so the stored record, their list and their CLI must not contain the title. Someone who
// can see the card's channel sees the title, and approving still echoes the text that person was shown.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "../../src/cli/context.ts";
import { talkieRecs } from "../../src/cli/commands/talkie-recs.ts";
import "../../src/daemon/projects/routes.ts";
import { overrideCall, overrideFleet, overrideSeats, type FleetNow } from "../../src/daemon/orchestrator/rec-act.ts";
import "../../src/daemon/orchestrator/rec-routes.ts";
import { registerHost, type OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";
import { prepareCardCuration, type CurationDeps } from "../../src/daemon/orchestrator/curation.ts";
import { planCuration, type CurationInput } from "../../src/daemon/orchestrator/curation-plan.ts";
import { prepareOrchestrationPoll, type PollDeps } from "../../src/daemon/orchestrator/poll.ts";
import { planPoll, type PollMachine, type WaitingWork } from "../../src/daemon/orchestrator/poll-plan.ts";
import { HttpError } from "../../src/daemon/http.ts";
import { buildRec } from "../../src/daemon/orchestrator/rec-input.ts";
import { answerRec, createRec, forgetRecs, readRecs, recordRec, viewsOf } from "../../src/daemon/orchestrator/recs.ts";
import { comment, updateCard } from "../../src/daemon/projects/service.ts";
import type { AccountView } from "../../src/protocol/accounts.ts";
import { DEFAULT_COLUMNS, type CardView } from "../../src/protocol/projects/schema.ts";
import type { AgentView, NodeView, BodyOf } from "../../src/protocol/schemas.ts";
import type { SeatHostView, SeatView } from "../../src/protocol/seats.ts";
import type { CardEvidence, StewardCard, StewardInput, StewardMove, StewardPlan } from "../../src/protocol/projects/steward.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { REC_TTL_MS, foldRecs, recKey, resolveText, withoutPrivatePhrases, type NewRec, type RecEvent } from "../../src/protocol/talkie-recs.ts";
import { approveShown, outcome, recsWorld, requester, type RecsWorld } from "../helpers/talkie-recs.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  overrideCall(null);
  overrideSeats(null);
  overrideFleet(null);
  while (cleanups.length) (cleanups.pop() as () => void)();
});

const H = 3_600_000;
const GIB = 1024 ** 3;
const NODE = "aaaaaaaaaaaaaaaa";
const VAULT = "Rotate the vault keys";
const SEED = "Escrow the signing seed";
const TOKEN = "Mint the $spare token";
const LAYOFF = "Plan the quiet layoff";
const PNAME = "Northwind Vault";
const TITLES = [VAULT, SEED, TOKEN, LAYOFF];
const HIDDEN = "A recommendation about a project you cannot see";

const machine = (node: string, hostname: string, handle = "alex"): PollMachine =>
  ({ node, hostname, handle, online: true, seats: { allows: true, max: 3, active: 0 }, runtimes: ["claude"] });

describe("owners-only plans do not store a card title", () => {
  test("a private project's seat recommendation stores the card id, not its key, title or project name", () => {
    const id = `${NODE}:9`;
    const work = {
      card: id, channel: "p-0a1b2c3d", project: PNAME, prefixes: ["VLT"],
      title: SEED, role: "build" as const, since: 0, audience: "owners" as const, viewers: ["alex"],
    } as WaitingWork;
    const plan = planPoll({ machines: [machine(NODE, "mac-a")], waiting: [work], now: 5 * H });
    const stored = JSON.stringify(plan.recs);
    expect(stored).not.toContain(SEED);
    expect(stored).not.toContain("VLT-1");
    expect(stored).not.toContain(PNAME);
    expect(stored).toContain(id);
    expect(stored).toContain("p-0a1b2c3d");
    expect(plan.recs[0]?.summary).toBe(`Start a builder for card ${id}`);
    expect(plan.recs[0]?.evidence.join("\n")).toContain("in p-0a1b2c3d since");
  });

  test("a team project's seat recommendation still says the title", () => {
    const work: WaitingWork = {
      card: `${NODE}:9`, channel: "p-0a1b2c3d", project: "Website", prefixes: ["WEB"], title: "Fix the login page",
      role: "build", since: 0, audience: "team",
    };
    const plan = planPoll({ machines: [machine(NODE, "mac-a")], waiting: [work], now: 5 * H });
    expect(plan.recs[0]?.summary).toBe("Start a builder for “Fix the login page”");
  });

  test("a private or confidential card's move stores the card id, not its key or title", () => {
    const channel = "p-0a1b2c3d";
    const id = `${NODE}:9`;
    for (const [title, key, labels, priv] of [
      [VAULT, "VLT-1", [] as string[], true],
      [LAYOFF, "WEB-4", ["confidential"], false],
    ] as const) {
      const made = curationOf({ title, key, channel, labels: [...labels], priv, evidence: [`the latest comment says "Done: ${title} merged"`] });
      const wire = JSON.stringify({ summary: made.recs[0]?.summary, action: made.recs[0]?.action });
      expect(wire).not.toContain(title);
      expect(wire).not.toContain(key);
      expect(wire).toContain(id);
      expect(JSON.stringify(made.recs)).toContain(channel);
      expect(made.recs[0]?.summary).toBe(`Move card ${id} to done`);
      // The comment stays on the in-memory recommendation. createRec moves it onto the project post and off the schedules record.
      expect(made.recs[0]?.evidence.join("\n")).toContain(title);
    }
  });

  test("a team card's move still says the title", () => {
    const made = curationOf({ title: "Fix the login page", key: "WEB-2", channel: "p-0a1b2c3d", labels: [], priv: false, evidence: ["its branch has 3 commits"] });
    expect(made.recs[0]?.summary).toBe("Move “Fix the login page” to Done");
    expect(JSON.stringify(made.recs)).toContain("Fix the login page");
  });
});

describe("a schedule record does not carry a private or confidential title", () => {
  test("a new owner who is not in the private project sees no title in the record, the list or the CLI; a member does", async () => {
    const world = await posted();
    const { t, bea, maren, vault, seat, secret, move } = world;
    const schedule = dumped(t, SCHEDULE_CHANNEL);
    for (const title of TITLES) expect(schedule).not.toContain(title);
    expect(schedule).not.toContain(PNAME);
    const stored = JSON.stringify(readRecs(t.deps));
    for (const title of TITLES) expect(stored).not.toContain(title);
    expect(stored).not.toContain(PNAME);
    expect(stored).not.toContain(move.key);
    expect(stored).not.toContain(seat.key);
    expect(stored).not.toContain(secret.key);
    expect(stored).toContain(move.id);
    expect(stored).toContain(vault.channel);
    expect(stored).toContain(seat.id);
    expect(stored).toContain(secret.id);

    // The schedule record is what she can read. A private-channel post that was not yet anchored when it arrived is
    // stored in full and never shown (PROTOCOL §3); that is the card's own post, not the recommendation.
    const beaSchedule = dumped(bea, SCHEDULE_CHANNEL);
    expect(beaSchedule).not.toContain(VAULT);
    expect(beaSchedule).not.toContain(SEED);
    expect(beaSchedule).not.toContain(TOKEN);
    expect(beaSchedule).not.toContain(PNAME);
    const beaList = await listed(bea);
    const beaCli = await printed(bea);
    for (const title of [VAULT, SEED, TOKEN]) {
      expect(beaList).not.toContain(title);
      expect(beaCli).not.toContain(title);
    }
    expect(beaList).not.toContain(PNAME);
    expect(beaCli).not.toContain(PNAME);
    expect(beaList).toContain(LAYOFF);
    expect(beaCli).toContain(LAYOFF);
    const beaRecs = (await outcome(requester(bea)("GET", "/v1/talkie/recs"))).body.recs as Array<{
      can_approve: boolean; can_dismiss: boolean; why_not?: string; project_name: string | null; project?: string | null;
      outgoing?: unknown; summary: string; evidence: string[]; key: string; context?: string;
    }>;
    expect(beaRecs.length).toBeGreaterThan(0);
    const hidden = beaRecs.filter((r) => r.project === vault.channel);
    expect(hidden.length).toBeGreaterThanOrEqual(4);
    for (const rec of hidden) {
      expect(rec.can_approve).toBe(false);
      expect(rec.can_dismiss).toBe(false);
      expect(rec.why_not).toContain("you cannot see this card's channel");
      expect(rec.outgoing).toBeUndefined();
      expect(rec.project_name).toBeNull();
      expect(rec.summary).toBe(HIDDEN);
      expect(rec.evidence).toEqual([]);
      expect(rec.key).toBe("hidden");
      expect(rec.context).toBeUndefined();
    }
    const layoff = beaRecs.find((r) => r.summary.includes(LAYOFF));
    expect(layoff?.can_dismiss).toBe(true);
    expect(layoff?.can_approve).toBe(true);

    for (const who of [t, maren]) {
      const list = await listed(who);
      const cli = await printed(who);
      for (const title of TITLES) {
        expect(list).toContain(title);
        expect(cli).toContain(title);
      }
    }
    const alexRows = (await outcome(requester(t)("GET", "/v1/talkie/recs"))).body.recs as Array<{ summary: string; outgoing?: string | null }>;
    const alexLayoff = alexRows.find((r) => r.summary.includes(LAYOFF));
    expect(alexLayoff?.outgoing ?? "").not.toContain(LAYOFF);
    const vaultAsk = alexRows.find((r) => r.summary.includes(VAULT) && r.outgoing);
    expect(vaultAsk?.outgoing).toContain(VAULT);
  });

  test("someone who already has the card locally still sees no title after they lose the channel", async () => {
    const t = recsWorld(cleanups);
    const p = await t.project("Northwind Vault", "VLT", { off: true, private: true });
    t.core.emit("channel.upsert", { name: p.channel, project: true, members: ["alex", "bea"] });
    const card = t.card(p, VAULT, { column: "doing" });
    const bea = t.person("bea", "owner");
    expect(bea.idx.db.card(card.id)?.title).toBe(VAULT);
    t.core.emit("channel.upsert", { name: p.channel, project: true, members: ["alex"] });
    comment(t.w, card.id, `Done: ${VAULT} merged`);
    t.idx.flushAll();
    await prepareCardCuration(curationDeps(t), () => true);
    t.core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, topic: "WalkieTalkie schedules", members: ["alex", "bea"] });
    bea.mirror();
    expect(bea.idx.db.card(card.id)?.title).toBe(VAULT);
    expect(dumped(t, SCHEDULE_CHANNEL)).not.toContain(VAULT);
    // The card post already on this machine stays. The new schedule record must not repeat the title.
    expect(dumped(bea, SCHEDULE_CHANNEL)).not.toContain(VAULT);
    expect(await listed(bea)).not.toContain(VAULT);
    expect(await printed(bea)).not.toContain(VAULT);
    const recs = (await outcome(requester(bea)("GET", "/v1/talkie/recs"))).body.recs as Array<{ can_approve: boolean; can_dismiss: boolean; summary: string }>;
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.every((r) => r.can_approve === false && r.can_dismiss === false && r.summary === HIDDEN)).toBe(true);
  });

  test("a member's approval still echoes the text they were shown, and an owner who cannot see the card cannot approve it", async () => {
    const { t, bea, vault } = await posted();
    const launches: string[] = [];
    const asks: string[] = [];
    overrideCall((_m, path, body) => {
      if (path === "/v1/seats/run") { launches.push((body as { prompt: string }).prompt); return Promise.resolve({}); }
      if (path === "/v1/ask") { asks.push((body as { text: string }).text); return Promise.resolve({ event: {} }); }
      return undefined;
    });
    overrideFleet(() => fleetNow());
    overrideSeats(() => []);

    const before = (await outcome(requester(bea)("GET", "/v1/talkie/recs"))).body.recs as Array<{ id: string; project?: string | null }>;
    const hidden = before.filter((r) => r.project === vault.channel);
    expect(hidden.length).toBeGreaterThanOrEqual(4);
    for (const rec of hidden) {
      const refused = await outcome(requester(bea)("POST", `/v1/talkie/recs/${encodeURIComponent(rec.id)}/approve`, {}));
      expect(refused.status).toBe(403);
      expect(refused.message).toContain("you cannot see this card's channel");
      const dismissed = await outcome(requester(bea)("POST", `/v1/talkie/recs/${encodeURIComponent(rec.id)}/dismiss`, {}));
      expect(dismissed.status).toBe(403);
      expect(dismissed.message).toContain("you cannot dismiss this one");
    }
    expect(launches).toEqual([]);
    expect(asks).toEqual([]);
    expect(t.idx.db.cards(vault.channel, { states: ["open"], limit: 50 }).some((c) => c.title === TOKEN)).toBe(false);

    const alex = (await outcome(requester(t)("GET", "/v1/talkie/recs"))).body.recs as Array<{ id: string; summary: string; kind: string; outgoing?: string | null }>;
    const ask = alex.find((r) => r.kind === "ask_orchestrator" && r.summary.includes(VAULT));
    expect(ask?.outgoing).toContain(VAULT);
    const approved = await outcome(approveShown(requester(t), ask!.id));
    expect(approved.status).toBe(200);
    expect(asks).toEqual([ask!.outgoing as string]);

    const seatRec = alex.find((r) => r.kind === "start_seat");
    expect(seatRec?.outgoing).toContain(SEED);
    const shown = seatRec!.outgoing as string;
    const seatCard = (readRecs(t.deps).find((r) => r.id === seatRec!.id)?.action as { card: string }).card;
    updateCard(t.w, seatCard, { title: "Escrow the signing seed tonight" });
    t.idx.flushAll();
    expect(await outcome(requester(t)("POST", `/v1/talkie/recs/${encodeURIComponent(seatRec!.id)}/approve`, { seen: shown }))).toMatchObject({ status: 409, code: "rec_changed" });
    expect(launches).toEqual([]);
    const again = (await outcome(requester(t)("GET", "/v1/talkie/recs"))).body.recs as Array<{ id: string; outgoing?: string }> ;
    const next = again.find((r) => r.id === seatRec!.id)?.outgoing;
    expect(next).toContain("Escrow the signing seed tonight");
    expect((await outcome(requester(t)("POST", `/v1/talkie/recs/${encodeURIComponent(seatRec!.id)}/approve`, { seen: next }))).status).toBe(200);
    expect(launches).toHaveLength(1);
    expect(launches[0]).toContain("Escrow the signing seed tonight");

    const create = alex.find((r) => r.kind === "create_card");
    expect(create?.outgoing).toContain(TOKEN);
    expect((await outcome(approveShown(requester(t), create!.id))).status).toBe(200);
    expect(t.idx.db.cards(vault.channel, { states: ["open"], limit: 50 }).some((c) => c.title === TOKEN)).toBe(true);
    bea.mirror();
    // A card post that is not yet anchored is stored in full and never shown (PROTOCOL §3). The schedule record,
    // the list and the CLI are what this owner can read, and none of them carry the title.
    const schedule = dumped(bea, SCHEDULE_CHANNEL);
    expect(schedule).not.toContain(TOKEN);
    expect(schedule).not.toContain("Escrow the signing seed tonight");
    const list = await listed(bea);
    expect(list).not.toContain(TOKEN);
    expect(list).not.toContain("Escrow the signing seed tonight");
  });
});

function curationOf(o: { title: string; key: string; channel: string; labels: string[]; priv: boolean; evidence: string[] }) {
  const id = `${NODE}:9`;
  const card: StewardCard = {
    id, key: o.key, ref: `${o.key}-abcd1234`, title: o.title, board: `${NODE}:2`, column: "doing", state: "open",
    assignee: null, blocked: false, blocked_reason: null, created_at: 1, created_by: { handle: "alex", node: NODE }, updated_at: 1,
  };
  const move: StewardMove = {
    card: id, key: o.key, ref: card.ref, title: o.title, rule: "done", from: "doing", to: "done",
    evidence: o.evidence, ping: [], comment: "noted",
  };
  const evidence = new Map<string, CardEvidence>([[id, { agents: [], branches: [], linear: null, timeline: [] }]]);
  const steward: StewardInput = {
    now: 5 * H, prefix: o.priv ? "VLT" : "WEB", steward: "on", boards: [{ id: card.board, columns: [...DEFAULT_COLUMNS] }],
    cards: [card], evidence, staleHours: 24, owners: ["alex"], agentsCanClose: true,
  };
  const plan: StewardPlan = { steward: "on", moves: [move], ambiguous: [], held: [], deferred: 0 };
  const input: CurationInput = {
    project: { channel: o.channel, name: o.priv ? "Northwind Vault" : "Website", prefixes: [steward.prefix], private: o.priv },
    steward, plan, cards: [{ id, labels: o.labels } as unknown as CardView], now: 5 * H, seatCards: new Set(),
    askTarget: () => ({ to: "@maren", label: "maren" }),
  };
  return planCuration(input);
}

const node = (): NodeView => ({
  node_id: NODE, handle: "alex", hostname: "mac-a", ip: "127.0.0.1", transports: ["tailscale"], online: true, last_seen: Date.now(), rtt_ms: 1, self: false,
  sync: { behind: 0, last_sync: null },
  stats: { at: Date.now(), mem: { total: 16 * GIB, used: 4 * GIB, free: 8 * GIB, swap_used: 0, pressure: "normal" }, temp_c: null,
    sys: { os: "linux", arch: "x64", cpus: 8, load1: 0.5, cpu_busy_pct: 10 } },
}) as unknown as NodeView;
const host = (): SeatHostView => ({
  node: NODE, hostname: "mac-a", handle: "alex", self: false, allows: true, member: true, channel: `seats-${NODE}`, online: true,
  availability: { state: "available", max: 3, running: 0 },
}) as SeatHostView;
const account = (): AccountView => {
  const usage = { at: Date.now() - 60_000, state: "ok", reason: null, source: "api", until: null, windows: [{ kind: "session", used_pct: 10, resets_at: Date.now() + 3 * H, window_s: null, scope: null }] };
  return { key: "alex:claude:mac-a", id: "claude", provider: "claude", label: "claude", plan: null, owners: ["alex"], claimed_by: [],
    machines: [{ node_id: NODE, hostname: "mac-a", handle: "alex", online: true, self: false, agents: [], usage }], usage, usage_host: "mac-a", last_seen: Date.now() } as unknown as AccountView;
};
function fleetNow(): FleetNow {
  return { machines: [machine(NODE, "mac-a", "alex")], working: new Set() };
}
function pollDeps(t: RecsWorld): PollDeps {
  return { ...t.deps, nodes: () => [node()], seatHosts: () => [host()], seats: () => [] as SeatView[], accounts: () => [account()], agents: () => [] as AgentView[] };
}
function curationDeps(t: RecsWorld): CurationDeps {
  return { ...t.deps, agents: () => [], gitDeadlineMs: 50 };
}

/** The private titles and the confidential title, recorded the way the duties record them. */
async function posted() {
  const t = recsWorld(cleanups);
  registerHost(t.core, { acceptsToken: () => true, scheduledTurnActive: () => true, currentTurnId: () => "turn-1" } as unknown as OrchestratorHost);
  const maren = t.person("maren", "owner");
  const vault = await t.project("Northwind Vault", "VLT", { off: true, private: true });
  t.core.emit("channel.upsert", { name: vault.channel, project: true, members: ["alex", "maren"] });
  const move = t.card(vault, VAULT, { column: "doing" });
  const seat = t.card(vault, SEED);
  comment(t.w, move.id, `Done: ${VAULT} merged`);
  const web = await t.project("Website", "WEB", { off: true });
  const secret = t.card(web, LAYOFF, { labels: ["confidential"] });
  t.idx.flushAll();
  t.tick(5 * H);
  await prepareOrchestrationPoll(pollDeps(t), () => true);
  await prepareCardCuration(curationDeps(t), () => true);
  const post = (body: unknown) => outcome(requester(t, { orchestratorToken: "valid" })("POST", "/v1/talkie/recs", body));
  expect((await post({ kind: "create_card", project: vault.channel, title: TOKEN, reason: `${TOKEN} is not on the board` })).status).toBe(201);
  expect((await post({ kind: "ask_orchestrator", to: "@maren", topic: "status", card: move.id, reason: `${VAULT} has no update` })).status).toBe(201);
  expect((await post({ kind: "ask_orchestrator", to: "@maren", topic: "status", card: secret.id, reason: `${LAYOFF} is overdue` })).status).toBe(201);
  const bea = t.person("bea", "owner");
  t.core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, topic: "WalkieTalkie schedules", members: ["alex", "maren", "bea"] });
  bea.mirror();
  maren.mirror();
  return { t, bea, maren, vault, seat, secret, move };
}

/** Every stored body and envelope. `channel` limits it to one channel (the schedule record). */
function dumped(who: { core: RecsWorld["core"] }, channel?: string): string {
  const rows = channel
    ? who.core.store.db.query<{ body: string | null; json: string }, [string]>("SELECT body, json FROM events WHERE channel = ?").all(channel)
    : who.core.store.db.query<{ body: string | null; json: string }, []>("SELECT body, json FROM events").all();
  return rows.map((r) => `${r.body ?? ""}\n${r.json}`).join("\n");
}

async function listed(who: { core: RecsWorld["core"]; idx: RecsWorld["idx"] }): Promise<string> {
  const res = await outcome(requester(who)("GET", "/v1/talkie/recs?status=all"));
  expect(res.status).toBe(200);
  return JSON.stringify(res.body);
}

async function printed(who: { core: RecsWorld["core"]; idx: RecsWorld["idx"] }): Promise<string> {
  const lines: string[] = [];
  const req = requester(who);
  const ctx = {
    args: { pos: ["recs"], flags: new Map() }, json: false, forAgent: false,
    client: () => ({
      talkieRecs: async (status: "open" | "all" = "open") => {
        const res = await req("GET", `/v1/talkie/recs?status=${status}`);
        if (!res.ok) throw new Error(`list ${res.status}`);
        return res.json();
      },
    }),
    out: (s: string) => lines.push(s), err: (s: string) => lines.push(s),
  } as unknown as Ctx;
  expect(await talkieRecs(ctx, false)).toBe(0);
  return lines.join("\n");
}

/** An owner who is in the schedule channel and not in the private project. */
function admit(t: RecsWorld) {
  const bea = t.person("bea", "owner");
  t.core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, topic: "WalkieTalkie schedules", members: ["alex", "maren", "bea"] });
  bea.mirror();
  return bea;
}

async function privateWorld() {
  const t = recsWorld(cleanups);
  registerHost(t.core, { acceptsToken: () => true, scheduledTurnActive: () => true, currentTurnId: () => "turn-1" } as unknown as OrchestratorHost);
  t.person("maren", "owner");
  const vault = await t.project(PNAME, "VLT", { off: true, private: true });
  t.core.emit("channel.upsert", { name: vault.channel, project: true, members: ["alex", "maren"] });
  const card = t.card(vault, VAULT, { column: "doing" });
  t.idx.flushAll();
  return { t, vault, card };
}

const recommend = (t: RecsWorld, body: unknown) => outcome(requester(t, { orchestratorToken: "valid" })("POST", "/v1/talkie/recs", body));

function scheduleOf(who: { core: RecsWorld["core"] }): string {
  return who.core.store.db.query<{ body: string | null }, [string]>("SELECT body FROM events WHERE channel = ?").all(SCHEDULE_CHANNEL).map((r) => r.body ?? "").join("\n");
}

/** A schedules record written the way an older daemon stored it: the title is still in the key, the summary and the action. */
function emitLegacy(t: RecsWorld, channel: string, rec: Record<string, unknown>): void {
  t.core.emit("msg.post", {
    text: `WalkieTalkie recommends: ${String(rec.summary ?? "")}`,
    talkie_rec: { v: 1, op: "create", ...rec },
  } as unknown as BodyOf<"msg.post">, { channel: SCHEDULE_CHANNEL, agent: "orchestrator" });
  forgetRecs(t.core);
}

describe("a viewer who cannot see the project learns nothing from the list", () => {
  test("P1 a card-less ask's model text loses every private title before it is stored", async () => {
    const { t } = await privateWorld();
    const reason = `${VAULT} is being worked on with no card`;
    expect((await recommend(t, { kind: "ask_orchestrator", to: "@maren", topic: "record", reason })).status).toBe(201);
    const bea = admit(t);
    // A card-less ask has no project post, so the scrubbed model text stays on the schedules record.
    expect(scheduleOf(t)).toContain("is being worked on");
    expect(scheduleOf(t)).not.toContain(VAULT);
    const shown = await listed(bea);
    expect(shown).toContain("is being worked on");
    expect(shown).not.toContain(VAULT);
    expect(await printed(bea)).not.toContain(VAULT);
  });

  test("P2 a private create's schedule record drops model text and another card's title", async () => {
    const { t, vault } = await privateWorld();
    const fragment = "rotating the vault keys failed";
    expect((await recommend(t, { kind: "create_card", project: vault.channel, title: "Call the HSM vendor", reason: `follow-up to ${VAULT}. ${fragment}` })).status).toBe(201);
    const stored = scheduleOf(t);
    expect(stored).not.toContain(fragment);
    expect(stored).not.toContain(VAULT);
    expect(stored).toContain("WalkieTalkie suggested this");
    const raw = await outcome(requester(t)("GET", `/v1/events?channel=${SCHEDULE_CHANNEL}&limit=500`));
    expect(raw.status).toBe(200);
    const rawText = JSON.stringify(raw.body);
    expect(rawText).not.toContain(fragment);
    expect(rawText).not.toContain(VAULT);
    const holder = await outcome(requester(t)("GET", `/v1/events?channel=${vault.channel}&limit=500`));
    expect(JSON.stringify(holder.body)).toContain(fragment);
    const member = await listed(t);
    expect(member).toContain(fragment);
    const bea = admit(t);
    const shown = await listed(bea);
    expect(shown).not.toContain(VAULT);
    expect(shown).not.toContain(fragment);
    expect(shown).toContain(HIDDEN);
  });

  test("P3 a poll recommendation does not name the private project", async () => {
    const { t, vault } = await privateWorld();
    t.card(vault, SEED);
    t.idx.flushAll();
    t.tick(5 * H);
    await prepareOrchestrationPoll(pollDeps(t), () => true);
    expect(readRecs(t.deps).some((r) => r.kind === "start_seat")).toBe(true);
    expect(scheduleOf(t)).not.toContain(PNAME);
    const bea = admit(t);
    const shown = await listed(bea);
    expect(shown).not.toContain(PNAME);
    expect(shown).not.toMatch(/"evidence":\[[^\]]*[A-Za-z]/);
    expect(await printed(bea)).not.toContain(PNAME);
  });

  test("P4 a block's branch slug and comment stay off the schedule record and off a non-member's list", async () => {
    const { t, vault, card } = await privateWorld();
    const slug = `${card.key.toLowerCase()}-rotate-vault-keys`;
    const commentText = "rotating the vault keys failed";
    const made = planCuration({
      project: { channel: vault.channel, name: PNAME, prefixes: [vault.prefix], private: true },
      steward: {
        now: Date.now(), prefix: vault.prefix, steward: "on", boards: [{ id: card.board, columns: [...DEFAULT_COLUMNS] }],
        cards: [{
          id: card.id, key: card.key, ref: card.ref, title: VAULT, board: card.board, column: card.column, state: "open",
          assignee: null, blocked: false, blocked_reason: null, created_at: 1, created_by: { handle: "alex", node: NODE }, updated_at: 1,
        }],
        evidence: new Map([[card.id, { agents: [], branches: [], linear: null, timeline: [] }]]),
        staleHours: 24, owners: ["alex"], agentsCanClose: true,
      },
      plan: {
        steward: "on", deferred: 0, ambiguous: [], held: [],
        moves: [{
          card: card.id, key: card.key, ref: card.ref, title: VAULT, rule: "stale", from: card.column,
          blocked_reason: `stalled: ${commentText}: HSM timeout`,
          evidence: [`branch ${slug} (3 commits, last 30 h ago) is merged into main`, `the last comment reports an error: "${commentText}"`],
          ping: [], comment: "noted",
        }],
      },
      cards: [{ id: card.id, labels: [] } as unknown as CardView], now: Date.now(), seatCards: new Set(), askTarget: () => null,
    });
    expect(made.recs).toHaveLength(1);
    createRec(t.deps, made.recs[0]!, vault.channel);
    const stored = scheduleOf(t);
    expect(stored).not.toContain(slug);
    expect(stored).not.toContain(commentText);
    expect(stored).not.toContain(VAULT);
    expect(JSON.stringify(readRecs(t.deps))).not.toContain(slug);
    const bea = admit(t);
    expect(await listed(bea)).not.toContain(slug);
    expect(await listed(bea)).not.toContain(commentText);
    expect(await printed(bea)).not.toContain(slug);
    const member = (await outcome(requester(t)("GET", "/v1/talkie/recs"))).body.recs as Array<{ id: string; kind: string; evidence: string[]; action: { blocked_reason?: string } }>;
    const block = member.find((r) => r.kind === "move_card");
    expect(block?.evidence.join("\n")).toContain(slug);
    expect(block?.action.blocked_reason).toContain(commentText);
    expect(block?.action.blocked_reason).not.toBe("blocked");
    expect((await outcome(approveShown(requester(t), block!.id))).status).toBe(200);
    t.idx.flushAll();
    const after = t.idx.db.card(card.id);
    expect(after?.blocked_reason ?? "").toContain(commentText);
    expect(after?.blocked_reason).not.toBe("blocked");
  });

  test("P5 an older owners-only create still hides its title, project name and key", async () => {
    const { t, vault } = await privateWorld();
    const title = "Mint the spare token";
    emitLegacy(t, vault.channel, {
      key: `card|${vault.channel}|mint the spare token`, group: "moves", source: "turn", audience: "owners", project: vault.channel,
      action: { kind: "create_card", project: vault.channel, title },
      summary: `Create a card “${title}” in ${PNAME}`, reason: "x", evidence: [`the card belongs in ${PNAME}`], ttl_ms: REC_TTL_MS,
    });
    const bea = admit(t);
    const body = await outcome(requester(bea)("GET", "/v1/talkie/recs?status=all"));
    const shown = JSON.stringify(body.body);
    expect(shown.toLowerCase()).not.toContain("mint the spare token");
    expect(shown).not.toContain(PNAME);
    const rec = (body.body.recs as Array<{ summary: string; key: string; evidence: string[]; action: { title?: string } }>)[0];
    expect(rec?.summary).toBe(HIDDEN);
    expect(rec?.key).toBe("hidden");
    expect(rec?.evidence).toEqual([]);
    expect(rec?.action.title).toBe("a card");
  });

  test("P6 dismissing a private recommendation is refused and does not suppress it", async () => {
    const { t, card } = await privateWorld();
    expect((await recommend(t, { kind: "ask_orchestrator", to: "@maren", topic: "status", card: card.id, reason: "no update" })).status).toBe(201);
    const bea = admit(t);
    const recs = (await outcome(requester(bea)("GET", "/v1/talkie/recs"))).body.recs as Array<{ id: string; can_dismiss: boolean; can_approve: boolean; status?: string }>;
    expect(recs).toHaveLength(1);
    expect(recs[0]?.can_dismiss).toBe(false);
    expect(recs[0]?.can_approve).toBe(false);
    const dismissed = await outcome(requester(bea)("POST", `/v1/talkie/recs/${encodeURIComponent(recs[0]!.id)}/dismiss`, {}));
    expect(dismissed.status).toBe(403);
    expect(dismissed.message).toContain("you cannot dismiss this one");
    expect(readRecs(t.deps).some((r) => r.id === recs[0]!.id && r.status === "pending")).toBe(true);
    t.tick(3 * H);
    const again = await recommend(t, { kind: "ask_orchestrator", to: "@maren", topic: "status", card: card.id, reason: "no update" });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ duplicate: true });
  });

  test("P7 approve and dismiss refuse a missing card the same way as a real one", async () => {
    const { t, vault, card } = await privateWorld();
    createRec(t.deps, t.ownersRec(vault, card), vault.channel);
    const missing = `${card.id.split(":")[0]}:9999`;
    createRec(t.deps, t.ownersRec(vault, { ...card, id: missing }), vault.channel);
    const bea = admit(t);
    const recs = (await outcome(requester(bea)("GET", "/v1/talkie/recs"))).body.recs as Array<{ id: string }>;
    expect(recs).toHaveLength(2);
    const approved: string[] = [];
    const dismissed: string[] = [];
    for (const rec of recs) {
      const yes = await outcome(requester(bea)("POST", `/v1/talkie/recs/${encodeURIComponent(rec.id)}/approve`, {}));
      const no = await outcome(requester(bea)("POST", `/v1/talkie/recs/${encodeURIComponent(rec.id)}/dismiss`, {}));
      expect(yes.status).toBe(403);
      expect(no.status).toBe(403);
      approved.push(yes.message ?? "");
      dismissed.push(no.message ?? "");
    }
    expect(approved[0]).toBe(approved[1]);
    expect(approved[0]).toContain("you cannot see this card's channel");
    expect(dismissed[0]).toBe(dismissed[1]);
    expect(dismissed[0]).toContain("you cannot dismiss this one");
    expect(readRecs(t.deps).filter((r) => r.status === "pending")).toHaveLength(2);
  });
});

describe("an owners-only create key is not a hash of the title", () => {
  test("P8 the key differs per project, is not unsalted sha256, and the secret file is owner-only", async () => {
    const t = recsWorld(cleanups);
    registerHost(t.core, { acceptsToken: () => true, scheduledTurnActive: () => true, currentTurnId: () => "turn-1" } as unknown as OrchestratorHost);
    const a = await t.project(PNAME, "VLT", { off: true, private: true });
    const b = await t.project("Southwind Archive", "SWA", { off: true, private: true });
    const title = "Plan the quiet layoff";
    expect((await recommend(t, { kind: "create_card", project: a.channel, title, reason: "needed" })).status).toBe(201);
    expect((await recommend(t, { kind: "create_card", project: b.channel, title: "Plan the  QUIET layoff", reason: "needed" })).status).toBe(201);
    const recs = readRecs(t.deps).filter((r) => r.kind === "create_card");
    const keyA = recs.find((r) => r.action.kind === "create_card" && r.action.project === a.channel)?.key ?? "";
    const keyB = recs.find((r) => r.action.kind === "create_card" && r.action.project === b.channel)?.key ?? "";
    expect(keyA.toLowerCase()).not.toContain("plan the quiet layoff");
    const digest = (key: string) => key.split("|h:")[1] ?? "";
    expect(digest(keyA)).toMatch(/^[0-9a-f]{32}$/);
    expect(digest(keyB)).toMatch(/^[0-9a-f]{32}$/);
    expect(digest(keyA)).not.toBe(digest(keyB));
    for (const guess of ["plan the layoff", "plan the quiet layoff", "fire the sales team"]) {
      expect(createHash("sha256").update(guess).digest("hex").slice(0, 32)).not.toBe(digest(keyA));
    }
    expect(statSync(join(t.core.paths.home, "rec-seal.key")).mode & 0o777).toBe(0o600);
    const again = await recommend(t, { kind: "create_card", project: a.channel, title: "PLAN   the quiet layoff", reason: "again" });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ duplicate: true });
    const web = await t.project("Website", "WEB", { off: true });
    expect((await recommend(t, { kind: "create_card", project: web.channel, title: "Fix the login page", reason: "needed" })).status).toBe(201);
    const team = readRecs(t.deps).find((r) => r.kind === "create_card" && r.audience === "team");
    expect(team?.action).not.toHaveProperty("seal");
    expect(team?.summary).toContain("Fix the login page");
  });
});

describe("a project post is trusted only from the recommendation's own WalkieTalkie", () => {
  test("L1 a person-written title post is not the title, and approving waits", async () => {
    const { t, vault } = await privateWorld();
    const stolen = t.core.emit("msg.post", { text: "hello", talkie_title: { v: 1, title: "Stolen title" } } as unknown as BodyOf<"msg.post">, { channel: vault.channel });
    emitLegacy(t, vault.channel, {
      key: `card|${vault.channel}|h:0123456789abcdef0123456789abcdef`, group: "moves", source: "turn", audience: "owners", project: vault.channel,
      action: { kind: "create_card", project: vault.channel, title: `card-title:${stolen.id}`, seal: 1 },
      summary: `Create a card in ${vault.channel}`, reason: "x", evidence: [], ttl_ms: REC_TTL_MS,
    });
    const recs = (await outcome(requester(t)("GET", "/v1/talkie/recs"))).body.recs as Array<{ id: string; summary: string }>;
    expect(recs).toHaveLength(1);
    expect(JSON.stringify(recs)).not.toContain("Stolen title");
    const refused = await outcome(requester(t)("POST", `/v1/talkie/recs/${encodeURIComponent(recs[0]!.id)}/approve`, {}));
    expect(refused.status).toBe(409);
    expect(refused.message).toContain("try again shortly");
    expect(refused.message ?? "").not.toMatch(/dismiss/i);
    expect(t.idx.db.cards(vault.channel, { states: ["open"], limit: 50 }).some((c) => c.title === "Stolen title")).toBe(false);
  });

  test("L1 a model title that looks like a reference is stored as the title and not followed", async () => {
    const { t, vault } = await privateWorld();
    const other = t.core.emit("msg.post", { text: "notes from the meeting" } as unknown as BodyOf<"msg.post">, { channel: vault.channel });
    const literal = `card-title:${other.id}`;
    expect((await recommend(t, { kind: "create_card", project: vault.channel, title: literal, reason: "use this name" })).status).toBe(201);
    const rec = readRecs(t.deps).find((r) => r.kind === "create_card");
    const ref = /^card-title:([0-9a-f]{16}:[1-9][0-9]*)$/.exec(rec?.action.kind === "create_card" ? rec.action.title : "");
    expect(ref).toBeTruthy();
    expect(ref?.[1]).not.toBe(other.id);
    const holder = t.core.store.db.query<{ body: string | null }, [string]>("SELECT body FROM events WHERE id = ?").get(ref![1] as string);
    expect(JSON.parse(holder?.body ?? "{}").talkie_title.title).toBe(literal);
    expect((await outcome(approveShown(requester(t), rec!.id))).status).toBe(200);
    const titles = t.idx.db.cards(vault.channel, { states: ["open"], limit: 50 }).map((c) => c.title);
    expect(titles).toContain(literal);
    expect(titles).not.toContain("notes from the meeting");
  });

  test("L2 a sealed create whose title post is missing says to try again, not to dismiss", async () => {
    const { t, vault } = await privateWorld();
    emitLegacy(t, vault.channel, {
      key: `card|${vault.channel}|h:fedcba9876543210fedcba9876543210`, group: "moves", source: "turn", audience: "owners", project: vault.channel,
      action: { kind: "create_card", project: vault.channel, title: "card-title:aaaaaaaaaaaaaaaa:99", seal: 1 },
      summary: `Create a card in ${vault.channel}`, reason: "x", evidence: [], ttl_ms: REC_TTL_MS,
    });
    const recs = (await outcome(requester(t)("GET", "/v1/talkie/recs"))).body.recs as Array<{ id: string }>;
    expect(recs).toHaveLength(1);
    const refused = await outcome(requester(t)("POST", `/v1/talkie/recs/${encodeURIComponent(recs[0]!.id)}/approve`, {}));
    expect(refused.status).toBe(409);
    expect(refused.message).toContain("try again shortly");
    expect(refused.message ?? "").not.toMatch(/dismiss/i);
  });

  test("L2 a block whose reason post is missing is not applied as the placeholder", async () => {
    const { t, vault, card } = await privateWorld();
    emitLegacy(t, vault.channel, {
      key: `move|${card.id}|block`, group: "moves", source: "curation", audience: "owners", project: vault.channel,
      action: { kind: "move_card", card: card.id, from: card.column, blocked_reason: "blocked" },
      summary: `Mark card ${card.id} as blocked`, reason: "It stopped with an error.", evidence: [], ttl_ms: REC_TTL_MS,
    });
    const recs = (await outcome(requester(t)("GET", "/v1/talkie/recs"))).body.recs as Array<{ id: string }>;
    expect(recs).toHaveLength(1);
    const refused = await outcome(requester(t)("POST", `/v1/talkie/recs/${encodeURIComponent(recs[0]!.id)}/approve`, {}));
    expect(refused.status).toBe(409);
    expect(refused.message).toContain("try again shortly");
    expect(refused.message ?? "").not.toMatch(/dismiss/i);
    expect(t.idx.db.card(card.id)?.blocked).not.toBe(true);
  });

  test("L4 a private title is removed only as a whole phrase", async () => {
    const { t, vault } = await privateWorld();
    t.card(vault, "seed");
    t.idx.flushAll();
    const reason = "seeding the seed vault. please Rotate the vault keys now. rotating the vault keys failed";
    expect((await recommend(t, { kind: "ask_orchestrator", to: "@maren", topic: "record", reason })).status).toBe(201);
    const bea = admit(t);
    const recs = (await outcome(requester(bea)("GET", "/v1/talkie/recs?status=all"))).body.recs as Array<{ context?: string }>;
    const ctx = recs.map((r) => r.context ?? "").join("\n");
    expect(ctx).toContain("seeding");
    expect(ctx).toContain("rotating the vault keys failed");
    expect(ctx.toLowerCase()).not.toContain("rotate the vault keys");
    expect(ctx).not.toMatch(/(?<![\p{L}\p{N}_])seed(?![\p{L}\p{N}_])/u);
    expect(scheduleOf(t)).not.toMatch(/(?<![\p{L}\p{N}_])seed(?![\p{L}\p{N}_])/u);
  });
});

const flat = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

describe("private phrases are removed after the same normalisation", () => {
  test("near-miss spellings, keys, archived titles and a team create are scrubbed", async () => {
    const { t, vault, card } = await privateWorld();
    expect(card.key).toBe("VLT-1");
    t.card(vault, "Escrow  the signing  seed");
    const arch = t.card(vault, "Retire the old HSM");
    updateCard(t.w, arch.id, { state: "archived" });
    t.idx.flushAll();
    const ask = (reason: string) => buildRec(t.deps, { kind: "ask_orchestrator", to: "@maren", topic: "record", reason }).rec.context ?? "";
    expect(flat(ask("ROTATE THE VAULT KEYS now"))).toBe("now");
    for (const reason of [
      "rotate the vault keys.",
      "Rotate the vault-keys",
      "Rotate, the vault keys",
      "“Rotate the vault keys”",
      "Ｒｏｔａｔｅ ｔｈｅ ｖａｕｌｔ ｋｅｙｓ",
      "Rot\u200bate the vault keys",
      "R\u043etate the vault keys",
      "Rotat\u00e9 the vault keys",
      "northwind vault",
      "Northwind-Vault",
      "NorthwindVault",
      "Northwind\u00a0Vault",
      "Rotate the\tvault keys",
      "VLT-1",
      "Escrow the signing seed",
      "Retire the old HSM",
      "_Rotate the vault keys_",
      "__Northwind Vault__",
      "rotate_the_vault_keys",
      "VLT_1",
    ]) {
      const ctx = ask(reason);
      expect(flat(ctx)).not.toContain(flat(reason));
      expect(ctx === "(no words)" || !flat(ctx).includes("rotatethevaultkeys")).toBe(true);
    }
    expect(flat(ask("Rotate the vault keys2"))).toBe("rotatethevaultkeys2");
    expect(ask("the vault keys")).toContain("the vault keys");

    const web = await t.project("Website", "WEB", { off: true });
    t.idx.flushAll();
    const title = "Follow up on Rotate the vault keys for Northwind Vault";
    let refused: unknown;
    try { buildRec(t.deps, { kind: "create_card", project: web.channel, title, reason: "Rotate the vault keys blocks it" }); }
    catch (err) { refused = err; }
    expect(refused).toBeInstanceOf(HttpError);
    expect((refused as HttpError).status).toBe(400);
    expect((refused as HttpError).message).toBe("this title matches a private card or project name");
    const posted = await recommend(t, { kind: "create_card", project: web.channel, title, reason: "Rotate the vault keys blocks it" });
    expect(posted.status).toBe(400);
    expect(posted.message).toBe("this title matches a private card or project name");
    // The model's own words are still scrubbed. The team title is refused, not stored in a shortened form.
    expect(ask("Rotate the vault keys blocks it")).not.toContain(VAULT);
    expect(ask("Rotate the vault keys blocks it")).not.toContain(PNAME);
  });

  test("6400 phrases are scrubbed in under 50 ms", async () => {
    const mod = await import("../../src/protocol/talkie-recs.ts");
    const fn = (mod as { withoutPrivatePhrases?: (text: string, phrases: readonly string[], prefixes: readonly string[]) => string }).withoutPrivatePhrases;
    expect(typeof fn).toBe("function");
    const phrases = Array.from({ length: 6400 }, (_, i) => `Private task number ${i} for the vault`);
    const text = "Private task number 7 for the vault is untracked";
    const t0 = performance.now();
    const out = fn!(text, phrases, ["VLT"]);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(out.toLowerCase()).not.toContain("private task number 7 for the vault");
    expect(out).toContain("untracked");
  });
});

describe("an owners-only schedule record carries no model text", () => {
  test("an ask about a private card keeps model text on the project post only", async () => {
    const { t, vault, card } = await privateWorld();
    const fragment = "rotating the vault keys failed twice";
    expect((await recommend(t, { kind: "ask_orchestrator", to: "@maren", topic: "status", card: card.id, reason: fragment, note: "see the VLT-1 thread" })).status).toBe(201);
    const raw = await outcome(requester(t)("GET", `/v1/events?channel=${SCHEDULE_CHANNEL}&limit=500`));
    expect(raw.status).toBe(200);
    const events = (raw.body.events ?? []) as Array<{ body?: { talkie_rec?: { op?: string; context?: string; reason?: string } } }>;
    const creates = events.map((e) => e.body?.talkie_rec).filter((r) => r?.op === "create");
    expect(creates.length).toBeGreaterThan(0);
    for (const rec of creates) {
      expect(rec?.context).toBeUndefined();
      expect(JSON.stringify(rec)).not.toContain(fragment);
      expect(JSON.stringify(rec)).not.toContain("VLT-1");
    }
    expect(JSON.stringify(raw.body)).toContain("WalkieTalkie suggested this");
    const holder = JSON.stringify((await outcome(requester(t)("GET", `/v1/events?channel=${vault.channel}&limit=500`))).body);
    expect(holder).toContain(fragment);
    expect((await listed(t))).toContain(fragment);
    const bea = admit(t);
    expect(await listed(bea)).not.toContain(fragment);
  });
});

describe("the rec seal secret is not replaced in silence", () => {
  test("the key is created whole, and a later missing or empty file refuses a private create", async () => {
    const { t, vault } = await privateWorld();
    const home = t.core.paths.home;
    expect((await recommend(t, { kind: "create_card", project: vault.channel, title: "Call the HSM vendor", reason: "needed" })).status).toBe(201);
    const keyPath = join(home, "rec-seal.key");
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(statSync(keyPath).size).toBeGreaterThan(0);
    expect(existsSync(join(home, "rec-seal.stamp"))).toBe(true);
    expect(readdirSync(home).some((name) => name.includes("rec-seal.key.") && name.endsWith(".tmp"))).toBe(false);
    rmSync(keyPath);
    const refused = await recommend(t, { kind: "create_card", project: vault.channel, title: "Call the escrow desk", reason: "needed" });
    expect(refused.status).toBe(409);
    expect(refused.message ?? "").toMatch(/rec-seal\.key/);
    expect(refused.message ?? "").toMatch(/will not write a new one/i);
    expect(existsSync(keyPath)).toBe(false);
    writeFileSync(keyPath, "", { mode: 0o600 });
    const empty = await recommend(t, { kind: "create_card", project: vault.channel, title: "Call the escrow desk", reason: "needed" });
    expect(empty.status).toBe(409);
    expect(empty.message ?? "").toMatch(/will not write a new one/i);
    expect(statSync(keyPath).size).toBe(0);
  });

  test("the doctor reports a missing key and does not create one", async () => {
    const home = mkdtempSync(join(tmpdir(), "walkie-rec-seal-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    let check: ((dir: string) => { level: string; detail: string } | null) | undefined;
    let load: ((dir: string) => unknown) | undefined;
    try {
      const mod = await import("../../src/daemon/orchestrator/rec-seal.ts") as {
        recSealCheck?: (dir: string) => { level: string; detail: string } | null;
        loadOrCreateRecSeal?: (dir: string) => unknown;
      };
      check = mod.recSealCheck;
      load = mod.loadOrCreateRecSeal;
    } catch { /* the base commit has neither export */ }
    expect(typeof check).toBe("function");
    expect(check!(home)).toBeNull();
    expect(existsSync(join(home, "rec-seal.key"))).toBe(false);
    load!(home);
    expect(check!(home)).toBeNull();
    rmSync(join(home, "rec-seal.key"));
    const bad = check!(home);
    expect(bad?.level).toBe("fail");
    expect(bad?.detail ?? "").toMatch(/rec-seal\.key/);
    expect(bad?.detail ?? "").toMatch(/rec-seal\.stamp/);
    expect(bad?.detail ?? "").toMatch(/will not write a new one/i);
    expect(existsSync(join(home, "rec-seal.key"))).toBe(false);
    writeFileSync(join(home, "rec-seal.key"), "", { mode: 0o600 });
    expect(check!(home)?.level).toBe("fail");
    expect(statSync(join(home, "rec-seal.key")).size).toBe(0);
    const bytes = "ab".repeat(32);
    writeFileSync(join(home, "rec-seal.key"), `${bytes}\n`, { mode: 0o600 });
    chmodSync(join(home, "rec-seal.key"), 0o644);
    const loose = check!(home);
    expect(loose?.level).toBe("fail");
    expect(loose?.detail ?? "").toMatch(/chmod 600/);
    expect(loose?.detail ?? "").toContain(join(home, "rec-seal.key"));
    expect(loose?.detail ?? "").not.toMatch(/delete/i);
    expect(statSync(join(home, "rec-seal.key")).mode & 0o777).toBe(0o644);
    expect(readFileSync(join(home, "rec-seal.key"), "utf8").trim()).toBe(bytes);
    // Doctor does not chmod. The daemon does, the next time it reads the key, and the bytes stay.
    const held = mkdtempSync(join(tmpdir(), "walkie-rec-seal-held-"));
    cleanups.push(() => rmSync(held, { recursive: true, force: true }));
    load!(held);
    const heldPath = join(held, "rec-seal.key");
    const heldBytes = readFileSync(heldPath, "utf8");
    chmodSync(heldPath, 0o644);
    load!(held);
    expect(statSync(heldPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(heldPath, "utf8")).toBe(heldBytes);
  });

  test("two owners' daemons use different keys, so one dismissal does not hold the other back", async () => {
    const t = recsWorld(cleanups);
    registerHost(t.core, { acceptsToken: () => true, scheduledTurnActive: () => true, currentTurnId: () => "turn-1" } as unknown as OrchestratorHost);
    const maren = t.person("maren", "owner");
    registerHost(maren.core, { acceptsToken: () => true, scheduledTurnActive: () => true, currentTurnId: () => "turn-m" } as unknown as OrchestratorHost);
    const vault = await t.project(PNAME, "VLT", { off: true, private: true });
    t.core.emit("channel.upsert", { name: vault.channel, project: true, members: ["alex", "maren"] });
    t.core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, topic: "WalkieTalkie schedules", members: ["alex", "maren"] });
    maren.mirror();
    const input = { kind: "create_card" as const, project: vault.channel, title: "Call the HSM vendor", reason: "needed" };
    const mine = buildRec(t.deps, input).rec;
    const theirs = buildRec(maren.deps, input).rec;
    expect(mine.key).not.toBe(theirs.key);
    expect(recordRec(t.deps, mine, vault.channel).outcome).toBe("created");
    maren.mirror();
    expect(recordRec(maren.deps, theirs, vault.channel).outcome).toBe("created");
  });
});

describe("a viewer who cannot see the project does not see an approval note", () => {
  test("the note stays on the member's list and is absent from the hidden list", async () => {
    const { t, vault, card } = await privateWorld();
    const id = createRec(t.deps, t.ownersRec(vault, card), vault.channel);
    const approved = await outcome(approveShown(requester(t), id, { note: `done: ${VAULT}` }));
    expect(approved.status).toBe(200);
    const member = (await outcome(requester(t)("GET", "/v1/talkie/recs?status=all"))).body.recs as Array<{ resolved?: { note?: string } }>;
    expect(member.some((r) => r.resolved?.note?.includes(VAULT))).toBe(true);
    const bea = admit(t);
    const hidden = (await outcome(requester(bea)("GET", "/v1/talkie/recs?status=all"))).body.recs as Array<{ resolved?: { note?: string }; summary: string }>;
    expect(hidden.length).toBeGreaterThan(0);
    for (const rec of hidden) {
      expect(rec.resolved?.note).toBeUndefined();
      expect(JSON.stringify(rec)).not.toContain(VAULT);
    }
  });
});

describe("a block-only owners move is sealed", () => {
  test("the stored action carries seal 1 and the column name stays off an owners summary", async () => {
    const { t, vault, card } = await privateWorld();
    const ceremony = DEFAULT_COLUMNS.map((c) => c.id === "done" ? { ...c, name: "Vault ceremony" } : c);
    const blocked = planCuration({
      project: { channel: vault.channel, name: PNAME, prefixes: [vault.prefix], private: true },
      steward: {
        now: Date.now(), prefix: vault.prefix, steward: "on", boards: [{ id: card.board, columns: ceremony }],
        cards: [{
          id: card.id, key: card.key, ref: card.ref, title: VAULT, board: card.board, column: card.column, state: "open",
          assignee: null, blocked: false, blocked_reason: null, created_at: 1, created_by: { handle: "alex", node: NODE }, updated_at: 1,
        }],
        evidence: new Map([[card.id, { agents: [], branches: [], linear: null, timeline: [] }]]),
        staleHours: 24, owners: ["alex"], agentsCanClose: true,
      },
      plan: {
        steward: "on", deferred: 0, ambiguous: [], held: [],
        moves: [{
          card: card.id, key: card.key, ref: card.ref, title: VAULT, rule: "stale", from: card.column,
          blocked_reason: "stalled: the HSM timed out", evidence: ["the last comment reports an error"], ping: [], comment: "noted",
        }],
      },
      cards: [{ id: card.id, labels: [] } as unknown as CardView], now: Date.now(), seatCards: new Set(), askTarget: () => null,
    });
    expect(blocked.recs[0]?.action.kind === "move_card" && blocked.recs[0].action.blocked_reason).toContain("HSM");
    expect(JSON.stringify(blocked.recs)).not.toContain("Vault ceremony");
    createRec(t.deps, blocked.recs[0]!, vault.channel);
    const row = t.core.store.db.query<{ body: string }, [string]>(
      "SELECT body FROM events WHERE channel = ? AND json_extract(body, '$.talkie_rec.op') = 'create' ORDER BY seq DESC LIMIT 1",
    ).get(SCHEDULE_CHANNEL);
    const action = JSON.parse(row?.body ?? "{}").talkie_rec.action as { blocked_reason?: string; seal?: number; to?: string };
    expect(action.blocked_reason).toBe("blocked");
    expect(action.seal).toBe(1);
    expect(action.to).toBeUndefined();

    const moved = planCuration({
      project: { channel: vault.channel, name: PNAME, prefixes: [vault.prefix], private: true },
      steward: {
        now: Date.now(), prefix: vault.prefix, steward: "on", boards: [{ id: card.board, columns: ceremony }],
        cards: [{
          id: card.id, key: card.key, ref: card.ref, title: VAULT, board: card.board, column: "doing", state: "open",
          assignee: null, blocked: false, blocked_reason: null, created_at: 1, created_by: { handle: "alex", node: NODE }, updated_at: 1,
        }],
        evidence: new Map([[card.id, { agents: [], branches: [], linear: null, timeline: [] }]]),
        staleHours: 24, owners: ["alex"], agentsCanClose: true,
      },
      plan: {
        steward: "on", deferred: 0, ambiguous: [], held: [],
        moves: [{ card: card.id, key: card.key, ref: card.ref, title: VAULT, rule: "done", from: "doing", to: "done", evidence: ["merged"], ping: [], comment: "noted" }],
      },
      cards: [{ id: card.id, labels: [] } as unknown as CardView], now: Date.now(), seatCards: new Set(), askTarget: () => null,
    });
    expect(moved.recs[0]?.summary).toBe(`Move card ${card.id} to done`);
    expect(JSON.stringify(moved.recs)).not.toContain("Vault ceremony");
    const team = curationOf({ title: "Fix the login page", key: "WEB-2", channel: "p-0a1b2c3d", labels: [], priv: false, evidence: ["merged"] });
    // The team fixture uses the column's display name. A custom name is covered by the owners case above and the default team case.
    expect(team.recs[0]?.summary).toBe("Move “Fix the login page” to Done");
  });

  test("a team move still says a custom column name", () => {
    const ceremony = DEFAULT_COLUMNS.map((c) => c.id === "done" ? { ...c, name: "Vault ceremony" } : c);
    const id = `${NODE}:9`;
    const made = planCuration({
      project: { channel: "p-0a1b2c3d", name: "Website", prefixes: ["WEB"], private: false },
      steward: {
        now: 5 * H, prefix: "WEB", steward: "on", boards: [{ id: `${NODE}:2`, columns: ceremony }],
        cards: [{
          id, key: "WEB-2", ref: "WEB-2-abcd1234", title: "Fix the login page", board: `${NODE}:2`, column: "doing", state: "open",
          assignee: null, blocked: false, blocked_reason: null, created_at: 1, created_by: { handle: "alex", node: NODE }, updated_at: 1,
        }],
        evidence: new Map([[id, { agents: [], branches: [], linear: null, timeline: [] }]]),
        staleHours: 24, owners: ["alex"], agentsCanClose: true,
      },
      plan: {
        steward: "on", deferred: 0, ambiguous: [], held: [],
        moves: [{ card: id, key: "WEB-2", ref: "WEB-2-abcd1234", title: "Fix the login page", rule: "done", from: "doing", to: "done", evidence: ["merged"], ping: [], comment: "noted" }],
      },
      cards: [{ id, labels: [] } as unknown as CardView], now: 5 * H, seatCards: new Set(), askTarget: () => null,
    });
    expect(made.recs[0]?.summary).toContain("Vault ceremony");
  });
});

describe("a blind dismissal from someone who cannot see the project does not count", () => {
  test("the recommendation stays open, and it is not suppressed after it expires", async () => {
    const { t, card } = await privateWorld();
    const made = await recommend(t, { kind: "ask_orchestrator", to: "@maren", topic: "status", card: card.id, reason: "no update" });
    expect(made.status).toBe(201);
    const id = made.body.id as string;
    const dana = t.person("dana", "owner");
    t.core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, topic: "WalkieTalkie schedules", members: ["alex", "maren", "dana"] });
    dana.mirror();
    const rec = readRecs(t.deps).find((r) => r.id === id);
    expect(rec?.status).toBe("pending");
    t.tick(20 * H);
    dana.core.emit("msg.post", {
      text: resolveText("dismissed", rec!.summary, "dana"),
      talkie_rec: { v: 1, op: "resolve", rec: id, status: "dismissed", key: rec!.key },
    } as unknown as BodyOf<"msg.post">, { channel: SCHEDULE_CHANNEL });
    dana.push();
    forgetRecs(t.core);
    expect(readRecs(t.deps).find((r) => r.id === id)?.status).toBe("pending");
    const again = await recommend(t, { kind: "ask_orchestrator", to: "@maren", topic: "status", card: card.id, reason: "no update" });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ duplicate: true });
    t.tick(5 * H);
    forgetRecs(t.core);
    expect(readRecs(t.deps).find((r) => r.id === id)?.status).toBe("expired");
    const later = await recommend(t, { kind: "ask_orchestrator", to: "@maren", topic: "status", card: card.id, reason: "no update" });
    expect(later.status).toBe(201);
  });

  test("the fold ignores an approve or dismiss whose author cannot see the project", () => {
    const project = "p-0a1b2c3d";
    const cardId = `${NODE}:9`;
    const create = {
      v: 1, op: "create", key: `ask|@maren|${cardId}|status`, group: "stalled", source: "turn", audience: "owners", project,
      action: { kind: "ask_orchestrator", to: "@maren", topic: "status", card: cardId },
      summary: `Ask maren for an update on card ${cardId}`, reason: "Nothing has changed.", evidence: [], ttl_ms: REC_TTL_MS,
    };
    const base: RecEvent = { id: "aaaaaaaaaaaaaaaa:1", ts: 1_700_000_000_000, channel: SCHEDULE_CHANNEL, author: { handle: "alex", agent: "orchestrator" }, rec: create };
    const dismiss: RecEvent = {
      id: "bbbbbbbbbbbbbbbb:1", ts: base.ts + 20 * H, channel: SCHEDULE_CHANNEL, author: { handle: "dana" },
      rec: { v: 1, op: "resolve", rec: base.id, status: "dismissed", key: create.key },
    };
    const owners = new Set(["alex", "dana"]);
    const hidden = foldRecs([base, dismiss], { owners, now: base.ts + 20 * H + 1_000, canAnswer: () => false });
    expect(hidden[0]?.status).toBe("pending");
    const seen = foldRecs([base, dismiss], { owners, now: base.ts + 20 * H + 1_000, canAnswer: () => true });
    expect(seen[0]?.status).toBe("dismissed");
    const legacy = foldRecs([base, dismiss], { owners, now: base.ts + 20 * H + 1_000 });
    expect(legacy[0]?.status).toBe("dismissed");
    // Nothing on an answer vouches for it: one that says it is judged is asked like any other, and the callback is given the event.
    const marked = { ...dismiss, judged: true, origin: "bbbbbbbbbbbbbbbb", seq: 1 } as RecEvent;
    const asked: Array<[string, string | undefined, number | undefined]> = [];
    const refused = foldRecs([base, marked], {
      owners, now: base.ts + 20 * H + 1_000, canAnswer: (handle, _rec, e) => { asked.push([handle, e.origin, e.seq]); return false; },
    });
    expect(refused[0]?.status).toBe("pending");
    expect(asked).toEqual([["dana", "bbbbbbbbbbbbbbbb", 1]]);
  });
});

describe("a stored title that ends in an ellipsis is still a phrase", () => {
  test("a title ending in … or in ... is taken out of model text and off the schedules record", async () => {
    const { t, vault } = await privateWorld();
    t.card(vault, "Escrow the signing seed…");
    t.card(vault, "Ship the spare token...");
    t.idx.flushAll();
    const ask = (reason: string) => buildRec(t.deps, { kind: "ask_orchestrator", to: "@maren", topic: "record", reason }).rec.context ?? "";
    expect(ask("Escrow the signing seed… is not tracked")).not.toContain("Escrow the signing seed");
    expect(ask("Ship the spare token... is not tracked")).not.toContain("Ship the spare token");
    expect((await recommend(t, { kind: "ask_orchestrator", to: "@maren", topic: "record", reason: "Escrow the signing seed… is not tracked" })).status).toBe(201);
    const bea = admit(t);
    const raw = JSON.stringify((await outcome(requester(bea)("GET", `/v1/events?channel=${SCHEDULE_CHANNEL}&limit=500`))).body);
    expect(raw).not.toContain("Escrow the signing seed");
    expect(raw).not.toContain("Ship the spare token");
  });
});

describe("underscore is a gap, like other punctuation", () => {
  test("emphasis, snake case and a key written with an underscore are removed", () => {
    const phrases = [VAULT, "VLT-1", PNAME];
    for (const text of ["_Rotate the vault keys_", "__Northwind Vault__", "rotate_the_vault_keys", "see VLT_1 today"]) {
      const out = withoutPrivatePhrases(text, phrases, ["VLT"]);
      expect(out.toLowerCase()).not.toContain("rotate the vault keys");
      expect(out.toLowerCase()).not.toContain("northwind vault");
      expect(out.toLowerCase()).not.toContain("rotate_the_vault_keys");
      expect(out).not.toMatch(/VLT[_-]1/i);
    }
    expect(withoutPrivatePhrases("seeding the vault keys2", phrases, ["VLT"])).toContain("seeding");
    expect(withoutPrivatePhrases("seeding the vault keys2", phrases, ["VLT"])).toContain("keys2");
  });

  test("a team create whose title is the private title in snake case is refused", async () => {
    const { t, vault } = await privateWorld();
    const web = await t.project("Website", "WEB", { off: true });
    t.card(vault, "Budget");
    t.card(vault, "plan");
    t.idx.flushAll();
    for (const title of ["rotate_the_vault_keys", "Write the release plan", "Budget", "_Rotate the vault keys_"]) {
      const posted = await recommend(t, { kind: "create_card", project: web.channel, title, reason: "needed" });
      expect(posted.status).toBe(400);
      expect(posted.message).toBe("this title matches a private card or project name");
    }
    const kept = await recommend(t, { kind: "create_card", project: web.channel, title: "Fix the login page", reason: "needed" });
    expect(kept.status).toBe(201);
    expect(JSON.stringify(readRecs(t.deps))).toContain("Fix the login page");
  });
});

describe("the phrase list is read again for every recommendation", () => {
  test("a private card created after the turn's first recommendation is still scrubbed", async () => {
    const { t, vault } = await privateWorld();
    expect(buildRec(t.deps, { kind: "ask_orchestrator", to: "@maren", topic: "record", reason: "warm up" }).rec.context ?? "").toContain("warm up");
    t.card(vault, "Retire the old HSM");
    t.idx.flushAll();
    const ctx = buildRec(t.deps, { kind: "ask_orchestrator", to: "@maren", topic: "record", reason: "Retire the old HSM is untracked" }).rec.context ?? "";
    expect(ctx).not.toContain("Retire the old HSM");
    expect((await recommend(t, { kind: "ask_orchestrator", to: "@maren", topic: "record", reason: "Retire the old HSM is untracked" })).status).toBe(201);
    const bea = admit(t);
    const raw = JSON.stringify((await outcome(requester(bea)("GET", `/v1/events?channel=${SCHEDULE_CHANNEL}&limit=500`))).body);
    expect(raw).not.toContain("Retire the old HSM");
  });
});

function ownersMove(project: { channel: string }, card: { id: string; column: string }, to = "review"): NewRec {
  return {
    key: recKey.move(card.id, to), group: "moves", source: "curation", audience: "owners", project: project.channel,
    action: { kind: "move_card", card: card.id, from: card.column, to },
    summary: `Move card ${card.id} to ${to}`, reason: "The work is ready and nobody is building it.", evidence: [], ttl_ms: REC_TTL_MS,
  };
}

describe("an owners-only answer does not put the note or the result on the schedules record", () => {
  test("the note and the result line are on the project post, and the schedules record says Approved", async () => {
    const { t, vault, card } = await privateWorld();
    const id = createRec(t.deps, ownersMove(vault, card), vault.channel);
    const approved = await outcome(approveShown(requester(t), id, { note: `done: ${VAULT}` }));
    expect(approved.status).toBe(200);
    expect(approved.body?.result ?? "").toContain("In review");
    const member = (await outcome(requester(t)("GET", "/v1/talkie/recs?status=all"))).body.recs as Array<{ resolved?: { note?: string } }>;
    expect(member.some((r) => r.resolved?.note?.includes(VAULT))).toBe(true);
    const project = JSON.stringify((await outcome(requester(t)("GET", `/v1/events?channel=${vault.channel}&limit=500`))).body);
    expect(project).toContain(`done: ${VAULT}`);
    expect(project).toContain("Moved to");
    const bea = admit(t);
    const raw = JSON.stringify((await outcome(requester(bea)("GET", `/v1/events?channel=${SCHEDULE_CHANNEL}&limit=500`))).body);
    expect(raw).not.toContain(VAULT);
    expect(raw).not.toContain("In review");
    expect(raw).not.toContain("Moved to");
    expect(raw).toContain("Approved.");
    const hidden = (await outcome(requester(bea)("GET", "/v1/talkie/recs?status=all"))).body.recs as Array<{ resolved?: { note?: string } }>;
    for (const rec of hidden) expect(rec.resolved?.note).toBeUndefined();

    const ask = createRec(t.deps, {
      key: recKey.ask("@maren", card.id, "status"), group: "stalled", source: "curation", audience: "owners", project: vault.channel,
      action: { kind: "ask_orchestrator", to: "@maren", topic: "status", card: card.id },
      summary: `Ask maren for an update on card ${card.id}`, reason: "Nothing has changed.", evidence: [], ttl_ms: REC_TTL_MS,
    }, vault.channel);
    const dismissed = await outcome(requester(t)("POST", `/v1/talkie/recs/${encodeURIComponent(ask)}/dismiss`, { note: `not now: ${VAULT}` }));
    expect(dismissed.status).toBe(200);
    bea.mirror();
    const after = JSON.stringify((await outcome(requester(bea)("GET", `/v1/events?channel=${SCHEDULE_CHANNEL}&limit=500`))).body);
    expect(after).not.toContain(VAULT);
    expect(after).not.toContain("not now");
    expect(after).toContain("Dismissed.");
    const memberAfter = (await outcome(requester(t)("GET", "/v1/talkie/recs?status=all"))).body.recs as Array<{ resolved?: { note?: string } }>;
    expect(memberAfter.some((r) => r.resolved?.note?.includes(`not now: ${VAULT}`))).toBe(true);
  });
});

/** Runs `fn` and returns the SQL text of every query this daemon's store was asked meanwhile. */
function queriesDuring(t: { core: RecsWorld["core"] }, fn: () => void): string[] {
  const db = t.core.store.db as unknown as { query: (sql: string) => unknown };
  const real = db.query;
  const seen: string[] = [];
  db.query = function spy(this: unknown, sql: string) { seen.push(sql); return real.call(db, sql); };
  try { fn(); } finally { db.query = real; }
  return seen;
}

/** A raw approve or dismiss as a modified client could write it: the resolve with whatever extra fields it likes, from its own daemon. */
function rawAnswer(who: { core: RecsWorld["core"] }, rec: { id: string; key: string; summary: string }, status: "approved" | "dismissed", extra: Record<string, unknown> = {}): void {
  who.core.emit("msg.post", {
    text: resolveText(status, rec.summary, "someone"),
    talkie_rec: { v: 1, op: "resolve", rec: rec.id, status, key: rec.key },
    ...extra,
  } as unknown as BodyOf<"msg.post">, { channel: SCHEDULE_CHANNEL });
}

describe("an answer is judged where it stands in the log, not by what it says about itself", () => {
  test("the recommendation stays approved after the approver leaves the project", async () => {
    const { t, vault, card } = await privateWorld();
    const id = createRec(t.deps, ownersMove(vault, card), vault.channel);
    let moves = 0;
    overrideCall((method, path) => {
      if (method === "POST" && /^\/v1\/tasks\/[^/]+$/.test(path)) moves += 1;
      return undefined;
    });
    expect((await outcome(approveShown(requester(t), id))).status).toBe(200);
    expect(moves).toBe(1);
    t.tick(1_000);
    t.core.emit("channel.upsert", { name: vault.channel, project: true, members: ["maren"] });
    expect(t.core.roster.channels.get(vault.channel)?.members).toEqual(["maren"]);
    forgetRecs(t.core);
    expect(readRecs(t.deps).find((r) => r.id === id)?.status).toBe("approved");
    const again = await outcome(approveShown(requester(t), id));
    expect(again.status).toBe(409);
    expect(again.code).toBe("rec_not_pending");
    expect(moves).toBe(1);
    const view = ((await outcome(requester(t)("GET", "/v1/talkie/recs?status=all"))).body.recs as Array<{ id: string; status: string; can_approve: boolean }>)
      .find((r) => r.id === id);
    expect(view?.status).toBe("approved");
    expect(view?.can_approve).toBe(false);
    // The answer carries nothing beside the recommendation's own field: there is no mark for anyone to forge or to trust.
    const bodies = t.core.store.db.query<{ body: string }, []>("SELECT body FROM events WHERE json_extract(body, '$.talkie_rec.op') = 'resolve'").all().map((r) => JSON.parse(r.body) as Record<string, unknown>);
    expect(bodies.length).toBe(1);
    expect(Object.keys(bodies[0] as object).sort()).toEqual(["talkie_rec", "text"]);
  });

  test("an older answer still counts when the approver could see the project at that time", async () => {
    const { t, vault, card } = await privateWorld();
    const id = createRec(t.deps, ownersMove(vault, card, "done"), vault.channel);
    const rec = readRecs(t.deps).find((r) => r.id === id);
    expect(rec?.status).toBe("pending");
    t.tick(1_000);
    t.core.emit("msg.post", {
      text: resolveText("approved", rec!.summary, "alex"),
      talkie_rec: { v: 1, op: "resolve", rec: id, status: "approved", key: rec!.key },
    } as unknown as BodyOf<"msg.post">, { channel: SCHEDULE_CHANNEL });
    t.tick(1_000);
    t.core.emit("channel.upsert", { name: vault.channel, project: true, members: ["maren"] });
    forgetRecs(t.core);
    expect(readRecs(t.deps).find((r) => r.id === id)?.status).toBe("approved");
    const again = await outcome(requester(t)("POST", `/v1/talkie/recs/${encodeURIComponent(id)}/approve`, {}));
    expect(again.status).toBe(409);
    expect(again.code).toBe("rec_not_pending");
  });

  test("F1 a raw answer from an owner who cannot see the project does not count, marked judged or not", async () => {
    for (const extra of [{}, { talkie_judged: 1 }, { talkie_judged: true }] as const) {
      for (const status of ["dismissed", "approved"] as const) {
        const { t, vault, card } = await privateWorld();
        const id = createRec(t.deps, ownersMove(vault, card), vault.channel);
        const rec = readRecs(t.deps).find((r) => r.id === id)!;
        const dana = t.person("dana", "owner");
        t.core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, topic: "WalkieTalkie schedules", members: ["alex", "maren", "dana"] });
        dana.mirror();
        let moves = 0;
        overrideCall((method, path) => {
          if (method === "POST" && /^\/v1\/tasks\/[^/]+$/.test(path)) moves += 1;
          return undefined;
        });
        t.tick(1_000);
        rawAnswer(dana, rec, status, extra);
        dana.push();
        forgetRecs(t.core);
        expect(readRecs(t.deps).find((r) => r.id === id)?.status).toBe("pending");
        const view = ((await outcome(requester(t)("GET", "/v1/talkie/recs?status=all"))).body.recs as Array<{ id: string; status: string; can_approve: boolean }>).find((r) => r.id === id);
        expect(view?.status).toBe("pending");
        expect(view?.can_approve).toBe(true);
        // Nothing holds it back either: the same key is still one open recommendation, not a cooled one.
        expect(recordRec(t.deps, ownersMove(vault, card), vault.channel).outcome).toBe("duplicate");
        expect((await outcome(approveShown(requester(t), id))).status).toBe(200);
        expect(moves).toBe(1);
      }
    }
  });

  test("F1b an ex-member's answer back-dated to before they left does not count", async () => {
    const { t, vault, card } = await privateWorld();
    const id = createRec(t.deps, ownersMove(vault, card), vault.channel);
    const rec = readRecs(t.deps).find((r) => r.id === id)!;
    const olive = t.person("olive", "owner");
    t.core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, topic: "WalkieTalkie schedules", members: ["alex", "maren", "olive"] });
    t.core.emit("channel.upsert", { name: vault.channel, project: true, members: ["alex", "maren", "olive"] });
    olive.mirror();
    const before = t.tick(1_000);
    t.tick(1_000);
    t.core.emit("channel.upsert", { name: vault.channel, project: true, members: ["alex", "maren"] });
    t.tick(5_000);
    olive.mirror();
    t.tick(before - t.wall()); // olive's clock is set back to before her removal
    rawAnswer(olive, rec, "dismissed");
    t.tick(10_000);
    olive.push();
    forgetRecs(t.core);
    expect(readRecs(t.deps).find((r) => r.id === id)?.status).toBe("pending");
    // The same answer with the mark a modified client would add.
    rawAnswer(olive, rec, "approved", { talkie_judged: 1 });
    olive.push();
    forgetRecs(t.core);
    expect(readRecs(t.deps).find((r) => r.id === id)?.status).toBe("pending");
  });

  test("an answer a member wrote from their own machine before they were removed still counts", async () => {
    const { t, vault, card } = await privateWorld();
    const id = createRec(t.deps, ownersMove(vault, card), vault.channel);
    const rec = readRecs(t.deps).find((r) => r.id === id)!;
    const olive = t.person("olive", "owner");
    t.core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, topic: "WalkieTalkie schedules", members: ["alex", "maren", "olive"] });
    t.core.emit("channel.upsert", { name: vault.channel, project: true, members: ["alex", "maren", "olive"] });
    olive.mirror();
    t.tick(1_000);
    rawAnswer(olive, rec, "dismissed");
    olive.push();
    t.tick(1_000);
    // The authority has seen the answer before it removes her, so the answer stands where it was written.
    t.core.emit("channel.upsert", { name: vault.channel, project: true, members: ["alex", "maren"] });
    forgetRecs(t.core);
    const folded = readRecs(t.deps).find((r) => r.id === id);
    expect(folded?.status).toBe("dismissed");
    expect(folded?.resolved?.by).toBe("olive");
  });

  test("who could see the project is read from the roster chain, not by scanning the log for channel changes", async () => {
    const { t, vault, card } = await privateWorld();
    const id = createRec(t.deps, ownersMove(vault, card), vault.channel);
    const rec = readRecs(t.deps).find((r) => r.id === id)!;
    t.tick(1_000);
    rawAnswer(t, rec, "approved");
    forgetRecs(t.core);
    const seen = queriesDuring(t, () => {
      expect(readRecs(t.deps).find((r) => r.id === id)?.status).toBe("approved");
      recordRec(t.deps, ownersMove(vault, card, "done"), vault.channel);
    });
    expect(seen.length).toBeGreaterThan(0);
    // (The chain's own read of roster events when a new record is written is not this code's, and has `kind IN (...)`.)
    expect(seen.filter((q) => /kind = 'channel\.upsert'/.test(q))).toEqual([]);
  });

  test("a list reads every answered note in two queries, and a note is still found after many later posts", async () => {
    const { t, vault } = await privateWorld();
    overrideCall(() => undefined);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const c = t.card(vault, `Private task number ${i} for the vault`, { column: "doing" });
      t.idx.flushAll();
      const id = createRec(t.deps, ownersMove(vault, c), vault.channel);
      forgetRecs(t.core);
      answerRec(t.deps, readRecs(t.deps).find((r) => r.id === id)!, "dismissed", `later ${i}`);
      ids.push(id);
      t.tick(1_000);
    }
    // Posts that came after the answers, in the schedules channel and in the project.
    t.core.store.transaction(() => {
      for (let i = 0; i < 400; i++) {
        t.core.emit("msg.post", { text: `WalkieTalkie note ${i}` } as BodyOf<"msg.post">, { channel: SCHEDULE_CHANNEL, agent: "orchestrator" });
        t.core.emit("msg.post", { text: `project chat ${i}` } as BodyOf<"msg.post">, { channel: vault.channel });
      }
    });
    forgetRecs(t.core);
    let listed: Array<{ id: string; resolved?: { note?: string } }> = [];
    const seen = queriesDuring(t, () => {
      const rows = viewsOf(t.deps, readRecs(t.deps).filter((r) => ids.includes(r.id)), () => ({}));
      listed = rows;
    });
    expect(seen.filter((q) => q.includes("json_each(?)")).length).toBe(2);
    for (let i = 0; i < ids.length; i++) expect(listed.find((r) => r.id === ids[i])?.resolved?.note).toBe(`later ${i}`);
    // Through the route too: the member's list carries each note, and an owner outside the project is given none and no read of them.
    const member = (await outcome(requester(t)("GET", "/v1/talkie/recs?status=all"))).body.recs as Array<{ id: string; resolved?: { note?: string } }>;
    for (let i = 0; i < ids.length; i++) expect(member.find((r) => r.id === ids[i])?.resolved?.note).toBe(`later ${i}`);
    const bea = admit(t);
    const outside = queriesDuring(bea, () => { viewsOf(bea.deps, readRecs(bea.deps), () => ({})); });
    expect(outside.filter((q) => q.includes("json_each(?)"))).toEqual([]);
  });
});

// Codex pre.13 audit MUST: the context was cut to 600 characters before private titles were scrubbed, so a title cut in
// two at the limit escaped the whole-phrase scrub and reached a public channel. The scrub now runs on each whole line.
test("a private title split by the 600-character context cut is still withheld from a public recommendation", async () => {
  const t = recsWorld(cleanups);
  registerHost(t.core, { acceptsToken: () => true, scheduledTurnActive: () => true, currentTurnId: () => "turn-1" } as unknown as OrchestratorHost);
  t.person("maren", "owner");
  const vault = await t.project("Northwind Vault", "VLT", { off: true, private: true });
  t.core.emit("channel.upsert", { name: vault.channel, project: true, members: ["alex", "maren"] });
  t.card(vault, VAULT, { column: "doing" });
  const web = await t.project("Website", "WEB", { off: true });
  const open = t.card(web, "Refresh the landing copy");
  t.idx.flushAll();
  const post = (body: unknown) => outcome(requester(t, { orchestratorToken: "valid" })("POST", "/v1/talkie/recs", body));
  const reason = `${"the landing copy is stale ".repeat(10)}`.slice(0, 199) + "z"; // exactly 200, no edge spaces
  // reason (200) + newline + note (400) = 601: the old cut removed the note's last character, the title's last letter.
  const filler = `${"context words ".repeat(40)}`.slice(0, 400 - VAULT.length - 2) + "x"; // ends in a letter, then one space
  const note = `${filler} ${VAULT}`;
  expect(reason.length).toBe(200);
  expect(note.length).toBe(400);
  const r = await post({ kind: "ask_orchestrator", to: "@maren", topic: "status", card: open.id, reason, note });
  expect(r.status).toBe(201);
  const pub = dumped(t, web.channel);
  expect(pub).not.toContain(VAULT.slice(0, -1));
  expect(pub).not.toContain(VAULT);
});

test("a private title split across two quoted fields is withheld once they are joined (Codex pre.13 audit round 2)", async () => {
  const t = recsWorld(cleanups);
  registerHost(t.core, { acceptsToken: () => true, scheduledTurnActive: () => true, currentTurnId: () => "turn-1" } as unknown as OrchestratorHost);
  t.person("maren", "owner");
  const vault = await t.project("Northwind Vault", "VLT", { off: true, private: true });
  t.core.emit("channel.upsert", { name: vault.channel, project: true, members: ["alex", "maren"] });
  t.card(vault, VAULT, { column: "doing" });
  const web = await t.project("Website", "WEB", { off: true });
  const open = t.card(web, "Refresh the landing copy");
  t.idx.flushAll();
  const post = (body: unknown) => outcome(requester(t, { orchestratorToken: "valid" })("POST", "/v1/talkie/recs", body));
  // "Rotate the vault" ends the reason, "keys" starts the evidence: joined, the whole private title reads across them.
  const r = await post({ kind: "ask_orchestrator", to: "@maren", topic: "status", card: open.id, reason: "stalled since Rotate the vault", evidence: ["keys came up in standup"] });
  expect(r.status).toBe(201);
  const pub = dumped(t, web.channel).replace(/\\n/g, " ");
  expect(pub).not.toMatch(/Rotate the vault\s+keys/);
});

test("a team create whose title normalizing stretches a private name across the 200-character cut is refused (Codex pre.13 audit round 2)", async () => {
  const t = recsWorld(cleanups);
  registerHost(t.core, { acceptsToken: () => true, scheduledTurnActive: () => true, currentTurnId: () => "turn-1" } as unknown as OrchestratorHost);
  t.person("maren", "owner");
  const vault = await t.project("Northwind Vault", "VLT", { off: true, private: true });
  t.core.emit("channel.upsert", { name: vault.channel, project: true, members: ["alex", "maren"] });
  t.card(vault, VAULT, { column: "doing" });
  const web = await t.project("Website", "WEB", { off: true });
  t.idx.flushAll();
  const post = (body: unknown) => outcome(requester(t, { orchestratorToken: "valid" })("POST", "/v1/talkie/recs", body));
  // 65 "ﬃ" ligatures (one character each) normalize to 195 letters: the private name then starts at 196 of a 217-letter
  // title, and the 200-character cut keeps only "Rota" of it. The title as sent is 87 characters, under the limit.
  const title = `${"ﬃ".repeat(65)} ${VAULT}`;
  expect(title.length).toBe(87);
  const r = await post({ kind: "create_card", project: web.channel, title, reason: "office supplies" });
  expect(r.status).toBe(400);
  expect(r.message).toBe("this title matches a private card or project name");
});
