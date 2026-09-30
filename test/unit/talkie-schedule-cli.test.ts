import { describe, expect, test } from "bun:test";
import { orchestrator } from "../../src/cli/commands/orchestrator.ts";
import type { Ctx } from "../../src/cli/context.ts";

function context(pos: string[], flags: Record<string, string | true>, client: Record<string, unknown>) {
  const lines: string[] = [];
  const ctx = {
    args: { pos, flags: new Map(Object.entries(flags)) }, json: false, forAgent: false,
    agentMarker: () => null, person: { interactive: () => true, ask: async () => "", note: () => {} },
    client: () => client, out: (s: string) => lines.push(s), err: (s: string) => lines.push(s),
  } as unknown as Ctx;
  return { ctx, lines };
}

describe("talkie schedule CLI", () => {
  test("plural schedules lists the named defaults", async () => {
    const names = ["Board refresh", "Machine onboarding", "Project sync", "Capacity check", "Data room refresh"];
    const { ctx, lines } = context(["schedules"], {}, {
      schedules: async () => ({ schedules: names.map((name) => ({ id: "id", name, enabled: true, cron: "0 * * * *", next_run: null, last_result: null })) }),
    });
    expect(await orchestrator(ctx)).toBe(0);
    for (const name of names) expect(lines.join("\n")).toContain(name);
  });
  test("new templates can be added by name", async () => {
    for (const template of ["machine-onboarding", "project-sync"]) {
      let task: unknown;
      const { ctx } = context(["schedule", "add", "Duty"], { cron: "0 * * * *", template }, {
        scheduleAdd: async (body: { task: unknown }) => { task = body.task; return { schedule: { name: "Duty", id: "id", next_run: Date.now() + 60_000 } }; },
      });
      expect(await orchestrator(ctx)).toBe(0);
      expect(task).toEqual({ template });
    }
  });
  test("unresolved subcommand prints a cursor page and forwards bounds", async () => {
    let args: unknown[] = [];
    const { ctx, lines } = context(["schedule", "unresolved"], { after: "cursor", limit: "2" }, {
      scheduleUnresolved: async (...received: unknown[]) => { args = received; return { total: 3,
        entries: [{ id: "id", name: "Job", run: "run" }], next_cursor: "next" }; },
    });
    expect(await orchestrator(ctx)).toBe(0);
    expect(args).toEqual(["cursor", 2]);
    expect(lines.join("\n")).toContain("next");
  });
  test("unresolved text distinguishes claims and local ids for the same run", async () => {
    const entries = [
      { id: "id", name: "Job", run: "run", claim: { term: 1, seq: 2, generation: 3 } },
      { id: "id", name: "Job", run: "run", claim: { term: 1, seq: 4, generation: 3 } },
      { id: "id", name: "Job", run: "run", local_id: "local-1" },
    ];
    const { ctx, lines } = context(["schedule", "unresolved"], {}, {
      scheduleUnresolved: async () => ({ total: entries.length, entries, next_cursor: null }),
    });
    expect(await orchestrator(ctx)).toBe(0);
    expect(new Set(lines.slice(0, 3)).size).toBe(3);
    expect(lines[0]).toContain("claim 1:2:3");
    expect(lines[1]).toContain("claim 1:4:3");
    expect(lines[2]).toContain("local_id local-1");
  });
  test("reset sanitizes terminal control characters in schedule JSON", async () => {
    const { ctx, lines } = context(["schedule", "reset", "id"], {}, {
      scheduleReset: async () => ({ schedule: { name: "Check", task: { prompt: "unsafe\u001b[31mtext" } } }),
    });
    (ctx as Ctx & { person: { ask: () => Promise<string> } }).person.ask = async () => "id";
    await orchestrator(ctx);
    expect(lines.join("\n")).not.toContain("\\u001b");
  });
  test("pause and remove report the folded result when their writes lose", async () => {
    const client = { scheduleEdit: async () => ({ schedule: { name: "Check", enabled: true } }),
      scheduleRemove: async () => ({ removed: false, schedule: { name: "Check" } }) };
    const pause = context(["schedule", "pause", "id"], {}, client);
    await orchestrator(pause.ctx);
    expect(pause.lines.join(" ")).not.toContain("paused Check");
    const remove = context(["schedule", "remove", "id"], {}, client);
    await orchestrator(remove.ctx);
    expect(remove.lines.join(" ")).not.toContain("removed id");
  });
  test("edit reports the folded result when another change wins over the patched fields", async () => {
    const stale = { name: "Old name", cron: "*/5 * * * *", task: { prompt: "old prompt" } };
    const client = { scheduleEdit: async () => ({ schedule: stale }) };
    const lost = context(["schedule", "edit", "id"], { name: "New name", cron: "*/10 * * * *", prompt: "new prompt" }, client);
    expect(await orchestrator(lost.ctx)).toBe(0);
    const text = lost.lines.join(" ");
    expect(text).toContain("did not win");
    expect(text).toContain("name, cron, task");
    expect(text).not.toContain("edited");
    const partial = context(["schedule", "edit", "id"], { name: "Old name", cron: "*/10 * * * *" }, client);
    await orchestrator(partial.ctx);
    expect(partial.lines.join(" ")).toContain("keeps its previous cron");
    expect(partial.lines.join(" ")).not.toContain("name,");
  });
  test("edit reports success when the folded schedule carries every patched field, trimmed as the daemon stores them", async () => {
    const applied = { name: "New name", cron: "*/10 * * * *", task: { prompt: "new prompt" } };
    const client = { scheduleEdit: async () => ({ schedule: applied }) };
    const won = context(["schedule", "edit", "id"], { name: " New name ", cron: " */10 * * * * ", prompt: "  new prompt " }, client);
    expect(await orchestrator(won.ctx)).toBe(0);
    expect(won.lines.join(" ")).toBe("edited New name");
    const template = context(["schedule", "edit", "id"], { template: "capacity-check" }, { scheduleEdit: async () => ({
      schedule: { ...applied, task: { template: "capacity-check" } }, }) });
    await orchestrator(template.ctx);
    expect(template.lines.join(" ")).toBe("edited New name");
  });
  test("add validates its task and passes a template to the API", async () => {
    let body: unknown;
    const { ctx, lines } = context(["schedule", "add", "Check"], { cron: "*/5 * * * *", template: "capacity-check" }, {
      scheduleAdd: async (b: unknown) => { body = b; return { schedule: { name: "Check", id: "id", next_run: Date.now() + 60_000 } }; },
    });
    expect(await orchestrator(ctx)).toBe(0);
    expect(body).toEqual({ name: "Check", cron: "*/5 * * * *", task: { template: "capacity-check" } });
    expect(lines.join(" ")).toContain("added Check");
  });
  test("pause and run-now call the matching API operations", async () => {
    const calls: unknown[] = [];
    const client = {
      scheduleEdit: async (id: string, patch: unknown) => { calls.push([id, patch]); return { schedule: { name: "Check" } }; },
      scheduleRunNow: async (id: string) => { calls.push(id); return { run_id: "run" }; },
    };
    expect(await orchestrator(context(["schedule", "pause", "id"], {}, client).ctx)).toBe(0);
    expect(await orchestrator(context(["schedule", "run-now", "id"], {}, client).ctx)).toBe(0);
    expect(calls).toEqual([["id", { enabled: false }], "id"]);
  });
  test("reset requires a person's typed confirmation and calls the reset API", async () => {
    let called = 0;
    const client = { scheduleReset: async (_id: string) => { called++; return { schedule: { name: "Check", next_run: 123, last_run: null } }; } };
    const wrong = context(["schedule", "reset", "id"], {}, client).ctx;
    await expect(orchestrator(wrong)).rejects.toMatchObject({ code: "not_confirmed" });
    expect(called).toBe(0);
    const { ctx: confirmed, lines } = context(["schedule", "reset", "id"], {}, client);
    (confirmed as Ctx & { person: { ask: () => Promise<string> } }).person.ask = async () => "id";
    expect(await orchestrator(confirmed)).toBe(0);
    expect(lines.join("\n")).toContain('"next_run": 123');
    expect(lines.join("\n")).toContain('"last_run": null');
    expect(called).toBe(1);
    const agent = context(["schedule", "reset", "id"], {}, client).ctx;
    (agent as Ctx & { agentMarker: () => string }).agentMarker = () => "test-agent";
    await expect(orchestrator(agent)).rejects.toMatchObject({ code: "person_only" });
    expect(called).toBe(1);
  });
});
