// TALKIE-OPS-1: nothing a scheduled duty does changes anything. The daemon, not a prompt, refuses every write from WalkieTalkie's own
// child while one of its scheduled turns runs (except a post and a recommendation); the duties' own code has no path to a card, a
// seat or another machine; the older duties now run the recommend-only work; the two new ones are seeded like the others.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatch, type RouteCtx } from "../../src/daemon/local-routes.ts";
import { prepareFor } from "../../src/daemon/orchestrator/host.ts";
import { registerHost, type OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";
import { Schedules, type ScheduleRunner } from "../../src/daemon/orchestrator/schedules.ts";
import type { Core } from "../../src/daemon/core.ts";
import { SCHEDULE_CHANNEL, ScheduleTemplate, TEMPLATE_PROMPTS, schedulePrompt, validateCron, nextRuns, type Schedule } from "../../src/protocol/talkie-schedule.ts";
import { playbook } from "../../src/daemon/orchestrator/playbook.ts";

const ROOT = join(import.meta.dir, "..", "..");

// ---- the guard ----------------------------------------------------------------------------------------------------------

function world(active: boolean) {
  const core = { teamId: "team", hostname: "lead", nodeId: "owner-node", me: () => ({ handle: "alex", role: "owner" }), myHandle: () => "alex" } as unknown as Core;
  registerHost(core, { acceptsToken: () => true, scheduledTurnActive: () => active } as unknown as OrchestratorHost);
  const request = (method: string, path: string, opts: { child?: boolean; agent?: string } = {}) => {
    const req = new Request(`http://localhost${path}`, { method, ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }) });
    return dispatch({ core, req, url: new URL(req.url), via: "cli", listener: "unix", noTimeout: () => {}, agent: opts.agent,
      ...(opts.child ? { orchestratorToken: "valid" } : {}) } as unknown as RouteCtx);
  };
  return { core, request };
}

const SID = "11111111-1111-4111-8111-111111111111";
const WRITES: Array<[string, string]> = [
  ["POST", "/v1/tasks"], ["POST", "/v1/tasks/WEB-1"], ["POST", "/v1/tasks/WEB-1/comment"], ["POST", "/v1/tasks/WEB-1/start"], ["POST", "/v1/tasks/automation"],
  ["POST", "/v1/projects"], ["POST", "/v1/projects/p-0a1b2c3d"], ["POST", "/v1/projects/p-0a1b2c3d/boards"], ["POST", "/v1/projects/p-0a1b2c3d/batch"],
  ["POST", "/v1/projects/p-0a1b2c3d/room"], ["POST", "/v1/steward/run"], ["POST", "/v1/steward/config"],
  ["POST", "/v1/seats/run"], ["POST", "/v1/seats/stop"], ["POST", "/v1/seats/config"], ["POST", "/v1/seats/busy"],
  ["POST", "/v1/admin/run"], ["POST", "/v1/admin/switches"], ["POST", "/v1/ask"], ["POST", "/v1/answer"], ["POST", "/v1/status"], ["POST", "/v1/artifacts"],
  ["POST", "/v1/channels"], ["POST", "/v1/team/invite"], ["POST", "/v1/team/add-machine"], ["POST", "/v1/orchestrator/say"], ["POST", "/v1/orchestrator/stop"],
  ["POST", `/v1/orchestrator/schedules/${SID}/run-now`], ["POST", "/v1/orchestrator/schedules"], ["PATCH", `/v1/orchestrator/schedules/${SID}`],
  ["DELETE", `/v1/orchestrator/schedules/${SID}`], ["POST", "/v1/talkie/recs/abcd1234/approve"], ["POST", "/v1/talkie/recs/abcd1234/dismiss"],
  ["PUT", "/v1/anything"],
];

describe("a scheduled turn cannot act", () => {
  test("every write from WalkieTalkie's child is refused while its scheduled turn runs, with what to do instead", async () => {
    const { request } = world(true);
    for (const [method, path] of WRITES) {
      await expect(request(method, path, { child: true })).rejects.toMatchObject({ status: 403, code: "scheduled_turn_cannot_act" });
    }
    await expect(request("POST", "/v1/tasks", { child: true })).rejects.toThrow("walkie talkie recommend");
  });

  test("a post and a recommendation are the only writes it may make", async () => {
    const { request } = world(true);
    for (const path of ["/v1/post", "/v1/talkie/recs"]) {
      // Not the guard's refusal: the request goes on to its route (this fake daemon has none of them registered, which is a 404 or another error).
      const outcome = await request("POST", path, { child: true }).then(() => null, (err: { code?: string }) => err.code ?? "error");
      expect(outcome).not.toBe("scheduled_turn_cannot_act");
    }
  });

  test("reads are never refused", async () => {
    const { request } = world(true);
    for (const path of ["/v1/tasks", "/v1/projects", "/v1/seats", "/v1/orchestrator/schedules", "/v1/talkie/recs", "/v1/who"]) {
      const outcome = await request("GET", path, { child: true }).then(() => null, (err: { code?: string }) => err.code ?? "error");
      expect(outcome).not.toBe("scheduled_turn_cannot_act");
    }
  });

  test("the same child in a conversation its person started acts as it always did", async () => {
    const { request } = world(false);
    for (const [method, path] of WRITES) {
      const outcome = await request(method, path, { child: true }).then(() => null, (err: { code?: string }) => err.code ?? "error");
      expect(outcome).not.toBe("scheduled_turn_cannot_act");
    }
  });

  test("a person at a terminal or the dashboard is never held back, scheduled turn or not", async () => {
    const { request } = world(true);
    for (const [method, path] of WRITES) {
      const outcome = await request(method, path).then(() => null, (err: { code?: string }) => err.code ?? "error");
      expect(outcome).not.toBe("scheduled_turn_cannot_act");
    }
  });
});

// ---- the duties' own code -----------------------------------------------------------------------------------------------

describe("the duties have no path to a card, a seat or another machine", () => {
  const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
  const importsOf = (src: string) => [...src.matchAll(/^import[^;]*?from\s+"([^"]+)";/gms)].map((m) => `${m[0]}`).join("\n");

  test("the poll, the curation and their records import nothing that writes a card, starts a seat or runs a remote command", () => {
    for (const file of ["poll.ts", "poll-plan.ts", "curation.ts", "curation-plan.ts", "recs.ts"]) {
      const imports = importsOf(read(`src/daemon/orchestrator/${file}`));
      for (const forbidden of ["runSteward", "StewardLoop", "updateCard", "createCard", "cardAction", "comment,", "seats/host", "seats/routes", "admin/remote", "admin/routes", "peer-client"]) {
        expect(imports).not.toContain(forbidden);
      }
      expect(imports).not.toMatch(/\bcomment\b/);
    }
  });

  test("nothing wired to a schedule runs the steward with writes: the daemon's one writing steward is its own opt-in loop", () => {
    const main = read("src/daemon/main.ts");
    expect(main).not.toContain("boardRefresh");
    expect(main).not.toMatch(/dryRun:\s*false/);
    // Capacity check runs the poll: the old model turn's capacity asks and summary are not wired, so no run marks an
    // orchestrator as asked (a schedule write each time) when nothing asks it.
    expect(main).not.toMatch(/capacityTargets:|capacitySnapshot:/);
    const host = read("src/daemon/orchestrator/host.ts");
    expect(host).not.toContain("boardRefresh");
    expect(host).not.toMatch(/runSteward/);
  });

  test("a duty's prepare step maps each template to the recommend-only work, and says plainly when the daemon has none", async () => {
    const calls: string[] = [];
    const deps = {
      orchestrationPoll: async () => { calls.push("poll"); return { skip: "polled" }; },
      cardCuration: async () => { calls.push("curation"); return { skip: "curated" }; },
    };
    const go = (template: string) => prepareFor(deps, { template } as Parameters<typeof prepareFor>[1], () => true, new AbortController().signal);
    expect(await go("orchestration-poll")).toEqual({ skip: "polled" });
    expect(await go("capacity-check")).toEqual({ skip: "polled" });
    expect(await go("card-curation")).toEqual({ skip: "curated" });
    expect(await go("board-refresh")).toEqual({ skip: "curated" });
    expect(calls).toEqual(["poll", "poll", "curation", "curation"]);
    for (const template of ["machine-onboarding", "project-sync", "data-room-refresh"]) expect(await go(template)).toBe("");
    const none = (template: string) => prepareFor({}, { template } as Parameters<typeof prepareFor>[1], () => true, new AbortController().signal);
    expect(await none("orchestration-poll")).toEqual({ skip: "The orchestration poll is not available on this daemon." });
    expect(await none("board-refresh")).toEqual({ skip: "Card curation is not available on this daemon." });
  });
});

// ---- what the duties say ------------------------------------------------------------------------------------------------

describe("what a scheduled turn is told", () => {
  test("every scheduled job starts by saying it changes nothing, and how to record what it would do", () => {
    for (const template of ScheduleTemplate.options) {
      const prompt = schedulePrompt({ template });
      expect(prompt).toContain("A scheduled job changes nothing");
      expect(prompt).toContain("walkie talkie recommend");
      expect(prompt).not.toContain("never launch seats in a scheduled turn");
    }
    expect(schedulePrompt({ prompt: "Check the queue" })).toContain("A scheduled job changes nothing");
  });

  test("project sync and machine onboarding recommend instead of creating, asking and setting up", () => {
    const sync = schedulePrompt({ template: "project-sync" });
    for (const clause of ["walkie who --all --json", "walkie projects list --all --json", "walkie tasks --project <P> --limit 500 --json", "total exceeds tasks.length", "create_card", "ask_orchestrator", "disagrees"]) expect(sync).toContain(clause);
    for (const gone of ["use walkie ask to ask", "walkie task create <P>", "respect a person's changes"]) expect(sync).not.toContain(gone);
    const onboarding = schedulePrompt({ template: "machine-onboarding" });
    for (const clause of ["walkie admin machines --json", "walkie seats --json", "agent admin", "seat helper", "runtime login", "version", "onboarding_step", "one exact next step", "Never post join links"]) expect(onboarding).toContain(clause);
    for (const gone of ["permitted remote setup", "Use walkie admin --machine <m> seats doctor, then"]) expect(onboarding).not.toContain(gone);
  });

  test("the two new duties and the two they replace say they are daemon work that recommends only", () => {
    for (const template of ["orchestration-poll", "capacity-check", "card-curation", "board-refresh"] as const) {
      expect(TEMPLATE_PROMPTS[template]).toContain("no model turn");
      expect(TEMPLATE_PROMPTS[template]).toContain("recommendations");
    }
    expect(TEMPLATE_PROMPTS["orchestration-poll"]).toContain("free seats");
    expect(TEMPLATE_PROMPTS["card-curation"]).toContain("steward");
  });

  test("the playbook no longer tells WalkieTalkie to act on its own in a scheduled turn", () => {
    const text = playbook({ owner: "alex", hostname: "lead", access: "platform" });
    expect(text).toContain("A scheduled turn changes nothing");
    expect(text).toContain("walkie talkie recommend");
    expect(text).not.toContain("recommend fitting work with walkie ask, and never launch seats");
    expect(text).not.toContain("Autonomously perform these duties on their schedules without waiting to be asked");
  });
});

// ---- the two new duties are seeded like the others ---------------------------------------------------------------------------

const ID = "11111111-1111-4111-8111-111111111111";
const OLD: Schedule[] = [
  ["Board refresh", "0 * * * *", "board-refresh"], ["Machine onboarding", "*/15 * * * *", "machine-onboarding"], ["Project sync", "0 * * * *", "project-sync"],
  ["Capacity check", "*/15 * * * *", "capacity-check"], ["Data room refresh", "0 9 * * *", "data-room-refresh"], ["Project status reports", "7 * * * *", "project-reports"],
].map(([name, cron, template], i) => ({ id: `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`, name: name!, cron: cron!, task: { template: template as ScheduleTemplate },
  enabled: true, created_by: "alex", last_run: null, next_run: 1, last_result: null, failures: 0, run_id: null }));

function fixture(initial: Schedule[]) {
  const events: Array<{ body: { text: string } }> = initial.map((schedule) => ({ body: { text: `walkie-talkie-schedule:v1:${JSON.stringify({ op: "put", schedule })}` } }));
  const meta = new Map<string, string>();
  const core = {
    isAuthority: () => true, authorityLeaseTerm: 0, roster: { channels: new Map([[SCHEDULE_CHANNEL, {}]]) },
    store: { queryEvents: () => [...events].reverse().map((e) => ({ json: JSON.stringify(e) })), channelEventCount: () => events.length,
      transaction: (fn: () => void) => fn(), getMeta: (key: string) => meta.get(key) ?? null, setMeta: (key: string, value: string) => { meta.set(key, value); } },
    emit: (_kind: string, body: { text: string }) => { events.push({ body }); return {}; }, myHandle: () => "alex", log: { warn: () => {} },
  } as unknown as Core;
  const runner: ScheduleRunner = { valid: () => true, claim: async () => true, turn: () => "turn", reply: () => null, interrupt: () => {} };
  return { core, runner, events };
}

describe("the poll and the curation among the defaults", () => {
  test("the templates are the six there were and the two new ones, which a model never has to run", () => {
    expect(ScheduleTemplate.options).toEqual(["board-refresh", "machine-onboarding", "project-sync", "capacity-check", "data-room-refresh", "project-reports", "orchestration-poll", "card-curation"]);
  });

  test("every five minutes, and a seven-minute step the cron rules accept", () => {
    expect(validateCron("*/5 * * * *")).toBeGreaterThan(0);
    const curation = "3,10,17,24,31,38,45,52 * * * *";
    expect(validateCron(curation)).toBeGreaterThan(0);
    const minutes = nextRuns(curation, Date.UTC(2026, 9, 1, 12, 0), 9).map((at) => new Date(at).getMinutes());
    expect(minutes).toEqual([3, 10, 17, 24, 31, 38, 45, 52, 3]);
  });

  test("a fresh team gets all eight", async () => {
    const f = fixture([]);
    const schedules = new Schedules(f.core, f.runner, undefined, undefined, { topUpDefaults: true });
    await schedules.defaultsForAuthority();
    expect(schedules.list().map((s) => [s.name, s.cron, s.task])).toEqual([
      ["Board refresh", "0 * * * *", { template: "board-refresh" }],
      ["Capacity check", "*/15 * * * *", { template: "capacity-check" }],
      ["Card curation", "3,10,17,24,31,38,45,52 * * * *", { template: "card-curation" }],
      ["Data room refresh", "0 9 * * *", { template: "data-room-refresh" }],
      ["Machine onboarding", "*/15 * * * *", { template: "machine-onboarding" }],
      ["Orchestration poll", "*/5 * * * *", { template: "orchestration-poll" }],
      ["Project status reports", "7 * * * *", { template: "project-reports" }],
      ["Project sync", "0 * * * *", { template: "project-sync" }],
    ]);
  });

  test("a team with the six gets the two new ones once, and the older ones stay as they are", async () => {
    const f = fixture(OLD);
    const schedules = new Schedules(f.core, f.runner, undefined, undefined, { topUpDefaults: true });
    await schedules.defaultsForAuthority();
    expect(schedules.list()).toHaveLength(8);
    expect(schedules.list().filter((s) => OLD.some((o) => o.id === s.id))).toHaveLength(6);
    expect(schedules.list().find((s) => s.name === "Orchestration poll")?.task).toEqual({ template: "orchestration-poll" });
    expect(schedules.list().find((s) => s.name === "Card curation")?.cron).toBe("3,10,17,24,31,38,45,52 * * * *");
    const count = f.events.length;
    await schedules.defaultsForAuthority();
    expect(f.events).toHaveLength(count);
  });

  test("an owner who removed one is not given it again", async () => {
    const f = fixture(OLD);
    const schedules = new Schedules(f.core, f.runner, undefined, undefined, { topUpDefaults: true });
    await schedules.defaultsForAuthority();
    schedules.remove(schedules.list().find((s) => s.name === "Card curation")!.id);
    const count = f.events.length;
    await schedules.defaultsForAuthority();
    expect(f.events).toHaveLength(count);
    expect(schedules.list().map((s) => s.name)).not.toContain("Card curation");
    void ID;
  });
});

// ---- no model in the watch, changed or not -----------------------------------------------------------------------------------

describe("the poll, the curation and the two duties they replace never start a model turn", () => {
  const NEW: Schedule[] = [["Orchestration poll", "*/5 * * * *", "orchestration-poll"], ["Card curation", "3,10,17,24,31,38,45,52 * * * *", "card-curation"]]
    .map(([name, cron, template], i) => ({ ...OLD[0]!, id: `22222222-2222-4222-8222-${String(OLD.length + i).padStart(12, "0")}`, name: name!, cron: cron!,
      task: { template: template as ScheduleTemplate } }));
  const WATCH = ["orchestration-poll", "capacity-check", "card-curation", "board-refresh"];

  test("whether a pass found something new or nothing, each run ends in the daemon's prepare step with its result line", async () => {
    for (const changed of [false, true]) {
      const f = fixture([...OLD, ...NEW]);
      const prompts: string[] = [];
      f.runner.turn = (prompt) => { prompts.push(prompt); return `turn-${prompts.length}`; };
      const line = (duty: string) => `${duty}: recommendations ${changed ? "1 new, 0" : "0 new, 1"} already open.`;
      // The real seam: the host's prepareFor, wired as main.ts wires it, in front of the schedule runner.
      f.runner.prepare = (task, canAct, signal) => prepareFor({
        orchestrationPoll: async () => ({ skip: line("Orchestration poll") }),
        cardCuration: async () => ({ skip: line("Card curation") }),
      }, task, canAct, signal);
      const schedules = new Schedules(f.core, f.runner);
      const watch = schedules.list().filter((s) => "template" in s.task && WATCH.includes(s.task.template));
      expect(watch).toHaveLength(4);
      for (const s of watch) {
        await schedules.runNow(s.id, Date.now());
        const after = schedules.get(s.id);
        const template = (s.task as { template: string }).template;
        expect(after.last_result).toBe(line(template === "orchestration-poll" || template === "capacity-check" ? "Orchestration poll" : "Card curation"));
        expect(after.failures).toBe(0);
      }
      expect(prompts).toEqual([]);
      // The control: a duty that still needs judgment (project sync) does get its turn, told it changes nothing.
      await schedules.runNow(schedules.list().find((s) => "template" in s.task && s.task.template === "project-sync")!.id, Date.now());
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("A scheduled job changes nothing");
    }
  });
});
