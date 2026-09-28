// WALKIE-MISSION-1: what Mission Control shows by default, the Agent archive (live roster vs archive), and the
// archive staying bounded (time limit + per-machine cap, the 687-ghost case).
import { afterEach, describe, expect, test } from "bun:test";
import { archiveList, renderArchive } from "../../src/cli/commands/archive.ts";
import { renderWho } from "../../src/cli/commands/team.ts";
import { AgentArchive, archiveOverflow } from "../../src/daemon/agent-archive.ts";
import type { Core } from "../../src/daemon/core.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import type { SyncManager } from "../../src/daemon/sync.ts";
import { agentsPayload, agentsView } from "../../src/daemon/views.ts";
import {
  ARCHIVE_CAP_PER_NODE, ARCHIVE_TTL_MS, IDLE_ARCHIVE_MS, OFFLINE_GRACE_MS, archiveCountText, hiddenByNode, isArchived,
  matchesSearch, shownByDefault,
} from "../../src/protocol/agent-roster.ts";
import type { AgentState, AgentView, TeamView } from "../../src/protocol/schemas.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });

const onlineSync = { isOnline: () => true } as unknown as SyncManager;

function setup(): { core: Core; clock: { t: number } } {
  const alex = tnode("alex");
  const { team, create } = createTeam(alex);
  const clock = { t: now() };
  const core = makeCore(alex, team, cleanups, { clock: () => clock.t });
  expect(core.ingest(create, "local").status).toBe("accepted");
  return { core, clock };
}

function post(core: Core, agent: string, state: AgentState, title?: string): void {
  // Straight to the emitter: the per-agent rate limit is not what these tests are about.
  core.emit("agent.status", { agent, state, runtime: "claude-code", ...(title ? { title } : {}) }, { agent, provenance: { title: "agent" } });
}

function view(state: AgentState, updated_at: number, extra: Partial<AgentView> = {}): AgentView {
  return {
    id: `alex/mbp/a-${updated_at}`, handle: "alex", node: "n1", hostname: "mbp", agent: `a-${updated_at}`,
    status: { agent: `a-${updated_at}`, state, runtime: "claude-code" }, updated_at, machine_online: true,
    effective_state: state, archived: false, ...extra,
  };
}

describe("archive rules", () => {
  test("default view = working + needs a person; idle 30 min and offline 10 min are archived", () => {
    const t = 1_000_000_000;
    expect(shownByDefault({ effective_state: "working" })).toBe(true);
    expect(shownByDefault({ effective_state: "waiting" })).toBe(true);
    expect(shownByDefault({ effective_state: "blocked" })).toBe(true);
    expect(shownByDefault({ effective_state: "idle" })).toBe(false);
    expect(shownByDefault({ effective_state: "offline" })).toBe(false);
    expect(isArchived({ effective_state: "idle", updated_at: t }, t + IDLE_ARCHIVE_MS - 1)).toBe(false);
    expect(isArchived({ effective_state: "idle", updated_at: t }, t + IDLE_ARCHIVE_MS)).toBe(true);
    expect(isArchived({ effective_state: "offline", updated_at: t }, t + OFFLINE_GRACE_MS - 1)).toBe(false);
    expect(isArchived({ effective_state: "offline", updated_at: t }, t + OFFLINE_GRACE_MS)).toBe(true);
    // Working / waiting / stuck are never archived, however old (staleness turns an old working into offline first).
    expect(isArchived({ effective_state: "working", updated_at: t }, t + ARCHIVE_TTL_MS)).toBe(false);
    expect(isArchived({ effective_state: "blocked", updated_at: t }, t + ARCHIVE_TTL_MS)).toBe(false);
  });

  test("hidden counts per machine merge the live roster's idle/offline with the archive's", () => {
    const live = [view("working", 1), view("idle", 2), view("offline", 3), { ...view("idle", 4), node: "n2" }];
    expect(hiddenByNode(live, [{ node: "n1", idle: 5, offline: 7 }, { node: "n3", idle: 0, offline: 1 }]).sort((a, b) => a.node.localeCompare(b.node))).toEqual([
      { node: "n1", idle: 6, offline: 8 }, { node: "n2", idle: 1, offline: 0 }, { node: "n3", idle: 0, offline: 1 },
    ]);
    expect(archiveCountText({ idle: 3, offline: 12 })).toBe("3 idle · 12 offline");
    expect(archiveCountText({ idle: 0, offline: 2 })).toBe("2 offline");
    expect(archiveCountText({ idle: 0, offline: 0 })).toBe("");
  });

  test("search matches name, machine, title, task, repo, activity (case-insensitive)", () => {
    const a = view("idle", 1, { status: { agent: "cc-1", state: "idle", runtime: "codex", title: "Fix the Parser", task: "ALE-5286", repo: "walkie", activity: "$ bun test" } });
    for (const q of ["parser", "ale-5286", "WALKIE", "bun test", "mbp", "a-1", "  "]) expect(matchesSearch(a, q)).toBe(true);
    expect(matchesSearch(a, "nothing")).toBe(false);
  });
});

describe("live roster vs archive in the daemon", () => {
  test("/v1/agents (live) leaves archived agents out and counts them per machine; scope=archive lists them", () => {
    const { core, clock } = setup();
    const t0 = clock.t;
    post(core, "old-idle", "idle", "done yesterday");
    post(core, "gone", "offline");
    clock.t = t0 + IDLE_ARCHIVE_MS + 60_000;
    post(core, "busy", "working", "Fix the bug");
    post(core, "asks", "waiting");
    post(core, "fresh-idle", "idle");
    const at = clock.t + 1_000;
    const live = agentsPayload(core, onlineSync, {}, at);
    expect(live.agents.map((a) => a.agent).sort()).toEqual(["asks", "busy", "fresh-idle"]);
    expect(live.agents.every((a) => !a.archived)).toBe(true);
    expect(live.archive).toEqual([{ node: core.nodeId, idle: 1, offline: 1 }]);
    const arch = agentsPayload(core, onlineSync, { scope: "archive" }, at);
    expect(arch.agents.map((a) => a.agent).sort()).toEqual(["gone", "old-idle"]);
    expect(arch.agents.every((a) => a.archived)).toBe(true);
    expect(agentsPayload(core, onlineSync, { scope: "archive", q: "yesterday" }, at).agents.map((a) => a.agent)).toEqual(["old-idle"]);
    expect(agentsPayload(core, onlineSync, { scope: "archive", node: "nope" }, at).agents).toEqual([]);
    expect(agentsPayload(core, onlineSync, { scope: "all" }, at).agents).toHaveLength(5);
  });

  test("an archived agent is live again the moment it reports", () => {
    const { core, clock } = setup();
    post(core, "cc-1", "idle");
    clock.t += IDLE_ARCHIVE_MS + 1;
    expect(agentsView(core, onlineSync, clock.t)[0]?.archived).toBe(true);
    post(core, "cc-1", "working");
    expect(agentsView(core, onlineSync, clock.t)[0]).toMatchObject({ archived: false, effective_state: "working" });
  });

  test("upkeep deletes expired archived agents and the oldest beyond the per-machine cap; live ones stay", () => {
    const { core, clock } = setup();
    const t0 = clock.t;
    post(core, "ancient", "offline");
    clock.t = t0 + ARCHIVE_TTL_MS;
    for (let i = 0; i < 6; i++) { post(core, `ghost-${i}`, "idle"); clock.t += 1_000; }
    clock.t += IDLE_ARCHIVE_MS;
    post(core, "busy", "working");
    let changed = 0;
    const hub = core.hub as unknown as { agentsChanged(): void };
    const orig = hub.agentsChanged.bind(hub);
    hub.agentsChanged = () => { changed++; orig(); };
    const upkeep = new AgentArchive(core, onlineSync, createLogger({}), { cap: 4, now: () => clock.t });
    expect(upkeep.tick()).toBe(3); // "ancient" (past the time limit) + the two oldest ghosts (over the cap of 4)
    expect(core.store.agents().map((r) => r.agent).sort()).toEqual(["busy", "ghost-2", "ghost-3", "ghost-4", "ghost-5"]);
    expect(changed).toBe(1);
    expect(upkeep.tick()).toBe(0);
    expect(changed).toBe(1); // nothing moved: dashboards are not re-sent the roster
    clock.t += 31 * 60_000; // "busy" went stale (30 min working without an update → offline) and later archived
    upkeep.tick();
    expect(changed).toBe(2);
  });

  test("the 687-ghost case collapses to the cap", () => {
    const views = Array.from({ length: 687 }, (_, i) => ({ ...view("idle", 1_000 + i), archived: true }));
    const drop = archiveOverflow(views, 10_000);
    expect(views.length - drop.length).toBe(ARCHIVE_CAP_PER_NODE);
    expect(Math.min(...views.filter((v) => !drop.includes(v)).map((v) => v.updated_at))).toBe(1_000 + 687 - ARCHIVE_CAP_PER_NODE);
  });
});

describe("CLI rendering", () => {
  const team: TeamView = {
    id: "t1", name: "acme", authority: "n1", channels: [], members: [{ login: "alex@x", handle: "alex", role: "owner" }],
    nodes: [{ node_id: "n1", handle: "alex", hostname: "almond-wsl", ip: "100.1.1.1", online: true, last_seen: 1, rtt_ms: 3, self: false, sync: { behind: 0, last_sync: 1 } }],
    plan: undefined as never,
  };

  test("who lists working and attention, then one archive line per machine", () => {
    const busy = { ...view("working", 5), agent: "cc-busy", status: { agent: "cc-busy", state: "working" as const, runtime: "claude-code" as const, title: "Build it" } };
    const out = renderWho(team, [busy], 10_000, [{ node: "n1", idle: 12, offline: 26 }]);
    expect(out).toContain("1 working · 0 need a person · 38 idle or offline");
    expect(out).toMatch(/cc-busy\s+working\s+Build it/);
    expect(out).toContain("12 idle · 26 offline in the archive (walkie agents archive --machine almond-wsl)");
  });

  test("agents archive: idle/offline only, per machine, newest first, filtered", () => {
    const list = [view("working", 1), view("idle", 2), view("offline", 3), { ...view("idle", 4), hostname: "hestia", node: "n2" }];
    expect(archiveList(list, {}).map((a) => a.updated_at)).toEqual([4, 3, 2]);
    expect(archiveList(list, { machine: "hestia" }).map((a) => a.updated_at)).toEqual([4]);
    expect(archiveList(list, { limit: 1 })).toHaveLength(1);
    const out = renderArchive(archiveList(list, {}), 3, 10_000);
    expect(out).toContain("hestia");
    expect(out).toContain("1 idle · 1 offline");
    expect(out).toMatch(/seen \d+s ago/);
  });
});
