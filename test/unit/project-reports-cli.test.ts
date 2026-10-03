// PROJECT-REPORTS-1: `walkie projects report <project> [on|off]`, and the setting in `walkie projects show` and --json.
// A stand-in daemon on a unix socket records what the CLI sends.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { projectsCmd } from "../../src/cli/commands/projects.ts";
import { UsageError } from "../../src/cli/args.ts";
import type { Ctx } from "../../src/cli/context.ts";
import type { ProjectView } from "../../src/protocol/projects/schema.ts";
import { fakeDaemon, type FakeDaemon } from "../helpers/fake-daemon.ts";

const CH = "p-5e7a7e01";
const meter = { mode: "count" as const, done: 1, counted: 4, by_role: { backlog: 0, todo: 2, active: 1, review: 0, done: 1, cancelled: 0 } };
const project = (mode: "hourly" | "off"): ProjectView => ({
  channel: CH, id: "a000000000000001:1", name: "Website", folder: "Acme", description: "", prefix: "WEB", paths: [], meter_mode: "count",
  automations: { pr_opened: true, pr_merged: false, agents_can_close: true }, state: "active", steward: "on", steward_node: "", status_report: mode,
  private: false, admins: ["alex"], creator: "alex", created_at: 0, boards: [], meter, cards: 0, last_activity: 0,
});

let daemon: FakeDaemon;
let routes: Record<string, unknown>;
let savedSocket: string | undefined;
beforeEach(() => {
  routes = {
    "GET /v1/projects": { projects: [project("off")], stubs: [] },
    [`GET /v1/projects/${CH}`]: { project: project("off"), cards: [], timeline: [] },
    [`POST /v1/projects/${CH}`]: { project: project("hourly") },
  };
  daemon = fakeDaemon(routes);
  savedSocket = process.env.WALKIE_SOCKET;
  process.env.WALKIE_SOCKET = daemon.socket;
});
afterEach(() => {
  daemon.stop();
  if (savedSocket === undefined) delete process.env.WALKIE_SOCKET; else process.env.WALKIE_SOCKET = savedSocket;
});

function run(pos: string[], opts: { json?: boolean; forAgent?: boolean } = {}) {
  const lines: string[] = [];
  const ctx = {
    args: { pos, flags: new Map() }, json: opts.json === true, forAgent: opts.forAgent === true, agentMarker: () => null,
    client: () => { throw new Error("projects uses its own client"); }, out: (s: string) => lines.push(s), err: (s: string) => lines.push(s),
  } as unknown as Ctx;
  return { lines, done: projectsCmd(ctx) };
}
const posts = () => daemon.requests.filter((r) => r.method === "POST");

describe("walkie projects report", () => {
  test("on sets hourly; off sets off; each says so", async () => {
    const on = run(["report", "WEB", "on"]);
    expect(await on.done).toBe(0);
    expect(posts()[0]).toMatchObject({ path: `/v1/projects/${CH}`, body: { status_report: "hourly" } });
    expect(on.lines.join("\n")).toContain("hourly status report on");
    routes[`POST /v1/projects/${CH}`] = { project: project("off") };
    const off = run(["report", "WEB", "off"]);
    expect(await off.done).toBe(0);
    expect(posts()[1]).toMatchObject({ body: { status_report: "off" } });
    expect(off.lines.join("\n")).toContain("hourly status report off");
  });

  test("a project is found by prefix, name or channel", async () => {
    for (const ref of ["WEB", "web", "Website", CH]) {
      const r = run(["report", ref, "on"]);
      expect(await r.done).toBe(0);
    }
    expect(posts().map((p) => p.path)).toEqual([`/v1/projects/${CH}`, `/v1/projects/${CH}`, `/v1/projects/${CH}`, `/v1/projects/${CH}`]);
  });

  test("with no verb it only reads the setting", async () => {
    const r = run(["report", "WEB"]);
    expect(await r.done).toBe(0);
    expect(posts()).toEqual([]);
    expect(r.lines.join("\n")).toContain("hourly status report off");
    routes[`GET /v1/projects/${CH}`] = { project: project("hourly"), cards: [], timeline: [] };
    const again = run(["report", "WEB"]);
    await again.done;
    expect(again.lines.join("\n")).toContain("hourly status report on");
  });

  test("--json prints the project's prefix and the setting", async () => {
    const r = run(["report", "WEB", "on"], { json: true });
    await r.done;
    expect(JSON.parse(r.lines[0] ?? "{}")).toEqual({ project: "WEB", status_report: "hourly" });
  });

  test("a missing project or a verb that is not on or off is a usage error", async () => {
    await expect(run(["report"]).done).rejects.toBeInstanceOf(UsageError);
    await expect(run(["report", "WEB", "daily"]).done).rejects.toBeInstanceOf(UsageError);
    await expect(run(["report", "NOPE", "on"]).done).rejects.toThrow("no project NOPE");
    expect(posts()).toEqual([]);
  });
});

describe("walkie projects show", () => {
  test("a person sees the setting under the project's line; --json carries the field", async () => {
    routes[`GET /v1/projects/${CH}`] = { project: project("hourly"), cards: [], timeline: [] };
    const r = run(["show", "WEB"]);
    await r.done;
    expect(r.lines.join("\n")).toContain("status report: hourly");
    const j = run(["show", "WEB"], { json: true });
    await j.done;
    expect(JSON.parse(j.lines[0] ?? "{}").project.status_report).toBe("hourly");
  });

  test("an agent's text and JSON name it too", async () => {
    routes[`GET /v1/projects/${CH}`] = { project: project("hourly"), cards: [], timeline: [] };
    const t = run(["show", "WEB"], { forAgent: true });
    await t.done;
    expect(t.lines.join("\n")).toContain("status report: hourly");
    const j = run(["show", "WEB"], { forAgent: true, json: true });
    await j.done;
    expect(JSON.parse(j.lines[0] ?? "{}").status_report).toBe("hourly");
  });
});
