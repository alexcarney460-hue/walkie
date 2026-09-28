// WALKIE-MISSION-1 fix round 5: the round-4 audits' findings (Codex r4, Opus r4) as regression tests.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionFiles } from "../../src/daemon/activity.ts";
import { AgentArchive } from "../../src/daemon/agent-archive.ts";
import type { Core } from "../../src/daemon/core.ts";
import { HEARTBEAT_MS, MIN_EXAMINED } from "../../src/daemon/discovery.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { DEFAULT_LIMITS } from "../../src/daemon/ratelimit.ts";
import type { SyncManager } from "../../src/daemon/sync.ts";
import { agentsPayload, agentsView } from "../../src/daemon/views.ts";
import { describeTool } from "../../src/hooks/activity.ts";
import { redactSecrets } from "../../src/protocol/safety.ts";
import type { AgentState, BodyOf, Event } from "../../src/protocol/schemas.ts";
import { projectStatus } from "../../src/protocol/status-projection.ts";
import { M4, needleOf } from "../fixtures/redact-m4.ts";
import { makeCore } from "../helpers/core.ts";
import { AGENT, hook, ME, status, toolCall, toolResult, world } from "../helpers/discovery-world.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });
const onlineSync = { isOnline: () => true } as unknown as SyncManager;
const TICK = 15_000;
const DAY = 86_400_000;

function node(): { core: Core; clock: { t: number }; share(on: boolean): void } {
  const alex = tnode("alex");
  const { team, create } = createTeam(alex);
  const clock = { t: now() };
  const core = makeCore(alex, team, cleanups, { clock: () => clock.t, limits: { ...DEFAULT_LIMITS, status: { capacity: 100_000, perSecond: 100_000 } } });
  expect(core.ingest(create, "local").status).toBe("accepted");
  return { core, clock, share: (on) => writeFileSync(core.paths.config, JSON.stringify({ share_prompts: on, share_activity: on })) };
}

// ---- A / B: re-signing never resurrects; provenance rows ----------------------------------------------------------

describe("re-signing after sharing narrows (Opus r4 #1 / Codex r4 #6)", () => {
  const STATES: AgentState[] = ["working", "waiting", "blocked", "idle", "offline"];

  test("five agents aged 2 days stay out of the live roster after narrowing + upkeep; copies keep observed_at", () => {
    const n = node();
    n.share(true);
    const t0 = n.clock.t;
    const signed = STATES.map((state) => n.core.emit("agent.status", { agent: `old-${state}`, state, runtime: "claude-code", title: `Secret plan ${state}` }, { agent: `old-${state}`, provenance: { title: "prompt" } }));
    n.clock.t = t0 + 2 * DAY;
    n.share(false);
    const upkeep = new AgentArchive(n.core, onlineSync, createLogger({}), { now: () => n.clock.t });
    upkeep.tick();
    const live = agentsPayload(n.core, onlineSync, {}, n.clock.t).agents.map((a) => a.agent);
    expect(live.filter((a) => a.startsWith("old-"))).toEqual([]);
    for (const [k, state] of STATES.entries()) {
      const row = n.core.store.agent(n.core.nodeId, `old-${state}`);
      expect(row?.event_id).not.toBe(signed[k]?.id); // re-signed...
      const body = JSON.parse(row?.body ?? "{}") as BodyOf<"agent.status">;
      expect(body.title).toBeUndefined(); // ...without the title...
      expect(body.observed_at).toBe(t0); // ...and with when it was really seen
    }
    const views = agentsView(n.core, onlineSync, n.clock.t).filter((a) => a.agent.startsWith("old-"));
    expect(views.every((a) => a.archived && a.updated_at === t0)).toBe(true);
    expect(views.find((a) => a.agent === "old-working")?.effective_state).toBe("offline"); // stale, not working
    expect(n.core.reprojectOwnStatuses()).toBe(0); // done: compliant now (idempotent projection)
  });

  test("first run after the upgrade (no provenance recorded): 120 old titled statuses, re-signed 50 per pass, none live", () => {
    const n = node();
    n.share(true);
    const t0 = n.clock.t;
    for (let i = 0; i < 120; i++) n.core.emit("agent.status", { agent: `pre-${i}`, state: i % 2 ? "working" : "idle", runtime: "claude-code", title: `pre-upgrade ${i}` }, { agent: `pre-${i}`, provenance: { title: "prompt" } });
    n.core.store.deleteStatusProvenance(Array.from({ length: 120 }, (_, i) => `pre-${i}`)); // as before the upgrade
    n.share(false);
    n.clock.t = t0 + 2 * DAY;
    expect(n.core.reprojectOwnStatuses()).toBe(50);
    expect(n.core.reprojectOwnStatuses()).toBe(50);
    expect(n.core.reprojectOwnStatuses()).toBe(20);
    expect(n.core.reprojectOwnStatuses()).toBe(0);
    expect(agentsPayload(n.core, onlineSync, {}, n.clock.t).agents.filter((a) => a.agent.startsWith("pre-"))).toEqual([]);
  });

  test("provenance is a row per agent, deleted with the agent by the archive", () => {
    const n = node();
    const ev = n.core.emit("agent.status", { agent: "cc-row", state: "idle", runtime: "claude-code", title: "Deploy", task: "ALE-1" }, { agent: "cc-row", provenance: { title: "person", task: "person" } });
    expect(n.core.store.statusProvenance("cc-row")).toMatchObject({ event_id: ev.id });
    expect(n.core.currentStatusProvenance("cc-row")).toMatchObject({ title: "person", task: "person" });
    expect(n.core.store.getMeta("status_prov")).toBeNull();
    n.clock.t += 8 * DAY; // past the archive's time limit
    new AgentArchive(n.core, onlineSync, createLogger({}), { now: () => n.clock.t }).tick();
    expect(n.core.store.agent(n.core.nodeId, "cc-row")).toBeNull();
    expect(n.core.store.statusProvenance("cc-row")).toBeNull();
  });
});

// ---- D: send boundaries --------------------------------------------------------------------------------------------

describe("status history at every send boundary (Codex r4 #2)", () => {
  test("own statuses: a non-compliant one is not full even for a legacy peer; a superseded compliant one is, for legacy only", () => {
    const n = node();
    n.share(true);
    const secret = n.core.emit("agent.status", { agent: "cc-h", state: "working", runtime: "claude-code", title: "Zanzibar" }, { agent: "cc-h", provenance: { title: "prompt" } });
    n.share(false);
    expect(n.core.serveStatusInFull(secret, { legacy: true })).toBe(false); // what a push and an old peer get: nothing / a stub
    expect(n.core.serveStatusInFull(secret)).toBe(false);
    n.clock.t += 1_000;
    const plain1 = n.core.emit("agent.status", { agent: "cc-p", state: "idle", runtime: "claude-code", activity: "Finished turn" }, { agent: "cc-p", provenance: { activity: "phrase" } });
    n.clock.t += 1_000;
    n.core.emit("agent.status", { agent: "cc-p", state: "working", runtime: "claude-code", activity: "Thinking" }, { agent: "cc-p", provenance: { activity: "phrase" } });
    expect(n.core.serveStatusInFull(plain1, { legacy: true })).toBe(true); // an old peer would stall on a stub
    expect(n.core.serveStatusInFull(plain1)).toBe(false); // a peer that takes stubs gets the stub
    const other = { ...plain1, origin: "0000000000000000" } as Event;
    expect(n.core.serveStatusInFull(other, { legacy: true })).toBe(true);
  });

  test("the push path consults the same rule (source check)", async () => {
    const src = await Bun.file(join(import.meta.dir, "../../src/daemon/sync.ts")).text();
    expect(src).toContain('if (ev.kind === "agent.status" && !this.core.serveStatusInFull(ev, { legacy: true })) return;');
  });
});

// ---- F / G / H / J: discovery ---------------------------------------------------------------------------------------

describe("discovery (Codex r4 #4, #5, #7, #9)", () => {
  test("#4 a call opened before the 32 KB tail stays open (first read and incremental)", () => {
    const w = world(cleanups);
    const siblings = Array.from({ length: 120 }, (_, i) => [
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `s${i}`, name: "Read", input: { file_path: `/f${i}` } }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `s${i}`, content: "x".repeat(800) }] } },
    ]).flat();
    w.write([{ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "slow", name: "Bash", input: { command: "make" } }] } }, ...siblings]);
    const files = new SessionFiles();
    expect(files.read(w.transcript, "claude")?.info).toMatchObject({ toolRunning: true, midTurn: true });
    // incremental: more finished siblings arrive; the slow call is still open
    w.write(siblings.map((r) => JSON.parse(JSON.stringify(r).replace(/"s(\d+)"/g, '"t$1"'))));
    expect(files.read(w.transcript, "claude")?.info.toolRunning).toBe(true);
    w.write([toolResult("done"), { type: "system", subtype: "turn_duration" }].map((r) => (r.type === "user" ? { ...r, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "slow", content: "ok" }] } } : r)));
    expect(files.read(w.transcript, "claude")?.info.toolRunning).toBe(false);
  });

  test("#5 a hook's waiting stays waiting through discovery's freshness re-sends", async () => {
    const w = world(cleanups);
    const d = w.disc();
    w.write([toolCall("Bash", { command: "rm -rf x" })]);
    hook(w.core, "waiting", "Needs your permission");
    const states: string[] = [];
    for (let i = 0; i < 4 * 45; i++) { w.clock.t += TICK; await d.tick(); states.push(status(w.core, AGENT)?.state as string); }
    expect(new Set(states)).toEqual(new Set(["waiting"]));
    expect(agentsView(w.core, onlineSync, w.clock.t).find((a) => a.agent === AGENT)?.effective_state).toBe("waiting");
    expect(HEARTBEAT_MS).toBeLessThan(45 * 60_000);
  });

  test("#7 over the cap the whole population rotates: the oldest of 101 is examined too", async () => {
    const w = world(cleanups);
    w.fx.procs = w.fx.procs.filter((p) => p.pid < 100);
    for (let i = 0; i < 101; i++) w.fx.procs.push({ pid: 2000 + i, ppid: 1, uid: ME, startedAt: w.clock.t - 1_000_000 + i * 1000, command: "kimi", cpuMs: 1 });
    const d = w.disc();
    await d.tick();
    expect(status(w.core, "kimi-pid2000")).toBeNull(); // the oldest: not in the first 100
    w.clock.t += TICK;
    await d.tick();
    expect(status(w.core, "kimi-pid2000")?.state).toBe("idle");
  });

  test("#7 the budget starts after the process listing, and every scan examines at least MIN_EXAMINED sessions", async () => {
    const w = world(cleanups);
    w.fx.procs = w.fx.procs.filter((p) => p.pid < 100);
    for (let i = 0; i < 10; i++) w.fx.procs.push({ pid: 3000 + i, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000 - i, command: "kimi", cpuMs: 1 });
    const envVars = w.fx.envVars.bind(w.fx);
    w.fx.envVars = async (pids: readonly number[], names: readonly string[]) => { await Bun.sleep(150); return envVars(pids, names); };
    const cwd = w.fx.cwd.bind(w.fx);
    w.fx.cwd = async (pid: number) => { await Bun.sleep(60); return cwd(pid); };
    const d = w.disc({ scanBudgetMs: 50, concurrency: 1 });
    await d.tick();
    expect(w.core.store.agents().filter((r) => r.agent.startsWith("kimi-pid")).length).toBeGreaterThanOrEqual(MIN_EXAMINED);
  });

  test("#9 a person's task key stays when discovery builds its own status (not the branch's key)", async () => {
    const w = world(cleanups, { prompts: false, activity: false });
    const d = w.disc();
    w.core.emit("agent.status", { agent: AGENT, state: "offline", runtime: "claude-code", title: "Deploying billing", task: "ALE-42", branch: "walkie-mission-1" }, { agent: AGENT, provenance: { title: "person", task: "person" } });
    w.clock.t += 60_000;
    w.write([toolCall("Bash", { command: "make" })]);
    await d.tick();
    expect(status(w.core, AGENT)).toMatchObject({ state: "working", task: "ALE-42", title: "Deploying billing" });
  });
});

// ---- C / K: redaction --------------------------------------------------------------------------------------------------

const CODEX_R4: Array<[string, string]> = [
  ["PGPASSWORD=first\\ second\\ secret psql", "second"],
  [`mysql -p'first'"second"`, "second"],
  [`curl -H 'Cookie: session="SecretCookie123"' x`, "SecretCookie123"],
  [`PGPASSWORD="FirstSecret\nSecondSecret" psql`, "SecondSecret"],
];

describe("structural redaction (Codex r4 #1, Opus m4)", () => {
  test.each(CODEX_R4)("Codex r4: %s", (text, secret) => {
    expect(redactSecrets(text).text).not.toContain(secret);
    const t = projectStatus({ agent: "a", state: "working", runtime: "cli", title: text.slice(0, 200) }, { title: "agent" }, { prompts: false, activity: false }).title ?? "";
    expect(t).not.toContain(secret);
  });

  test.each(M4)("Opus m4: %s", (label, text) => {
    const needle = needleOf(label, text);
    expect(redactSecrets(text).text).not.toContain(needle);
    expect(describeTool("Bash", { command: text }, "", true)).not.toContain(needle);
    const t = projectStatus({ agent: "a", state: "working", runtime: "cli", title: text.slice(0, 200) }, { title: "agent" }, { prompts: false, activity: false }).title ?? "";
    expect(t).not.toContain(needle);
  });

  test("prose, hashes, ids and paths are left alone", () => {
    const plain = [
      "I can't find the key: it's in the drawer, don't worry",
      "commit 3f9a2b1c4d5e6f708192a3b4c5d6e7f8091a2b3c merged; blob sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "session 5eed0001-1111-4222-8333-944455556666 at /Users/alex/workspace/walkie/src/daemon/discovery.ts",
      "getAgentStatusProjection returns the body; see WALKIE-MISSION-1 and ALE-5286",
      "token list; docker login --password-stdin; OLDPWD=/x; monkey=banana",
      `{"key": "ALE-1", "key_source": "key_path"}`,
      "repo review-pay7ablows1f1-audit2-4810327 on branch acme-dashboard-1-fix2-b3c9d1e0f2a47586e",
    ];
    for (const p of plain) expect(redactSecrets(p).text).toBe(p);
  });
});

describe("idempotent projection (Opus r4 #6)", () => {
  test("projecting a projected status changes nothing (randomised)", () => {
    const seeds = [`PASSWORD=abc`, `token: "x y z"`, `curl -u a:b`, `Authorization: Bearer abcdefgh12345`, `PASS=[REDACTED:env_secret]x`,
      `DB_PASSWORD="two words" API_TOKEN=abcdefghijklmnop`, `mysql -uroot -p'Sup3r'`, `sshpass -p "x y" ssh`, `https://u:pw@h/x?token=abc&key=def`,
      `-----BEG${""}IN RSA PRIVATE KEY-----abc`, `export SECRET_TOKEN=\\"a b\\"`, `--password="a \\" b"`, `X-Api-Key: abc`, `Cookie: a=b; c=d`,
      `SIGNING=0123456789abcdef0123456789abcdef0123`, `a_b_token=xyz`, `password = 'a'`, `token=[REDACTED:secret]`];
    let seed = 7;
    const rnd = (k: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % k; };
    for (let i = 0; i < 3_000; i++) {
      let s = "";
      for (let j = 0, parts = 1 + rnd(4); j < parts; j++) s += (j ? ([" ", "; ", "\n", "=", ":", '"'][rnd(6)] as string) : "") + (seeds[rnd(seeds.length)] as string);
      if (rnd(2)) s = s.slice(0, rnd(s.length + 1));
      if (rnd(3) === 0) s = "x".repeat(rnd(200)) + s;
      const body = { agent: "a", state: "working" as const, runtime: "cli" as const, title: s.slice(0, 200), task: "ALE-1", activity: s.slice(0, 200), branch: s.slice(0, 120) };
      for (const pol of [{ prompts: true, activity: true, paths: true }, { prompts: false, activity: false }]) {
        const prov = { title: "agent" as const, task: "person" as const, activity: "tool" as const };
        const p1 = projectStatus(body, prov, pol);
        expect(projectStatus(p1, prov, pol)).toEqual(p1);
      }
    }
  });
});

describe("coverage limit is stated (Codex r4 #8)", () => {
  test("Mission Control and INSTALL say Codex app / IDE sessions are not discovered", async () => {
    const mc = await Bun.file(join(import.meta.dir, "../../web/src/views/mission/MissionControl.tsx")).text();
    expect(mc).toContain("codex app-server");
    const install = await Bun.file(join(import.meta.dir, "../../docs/INSTALL.md")).text();
    expect(install).toContain("Coverage limit");
  });
});
