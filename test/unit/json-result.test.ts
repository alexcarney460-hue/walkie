import { describe, expect, test } from "bun:test";
import { WalkieClient, WalkieError } from "../../src/client/index.ts";
import { UsageError } from "../../src/cli/args.ts";
import { errorCode, failResult, okResult, quietCtx, runJsonCommand } from "../../src/cli/json-result.ts";
import type { Ctx } from "../../src/cli/context.ts";
import { setupResult, type SetupFacts } from "../../src/cli/commands/setup-result.ts";
import type { MeView } from "../../src/protocol/schemas.ts";

function capture(): Ctx & { outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  return { args: { pos: [], flags: new Map() }, json: true, forAgent: false, client: () => new WalkieClient(), out: (s: string) => outs.push(s), err: (s: string) => errs.push(s), outs, errs } as unknown as Ctx & { outs: string[]; errs: string[] };
}

describe("result builders", () => {
  test("okResult and failResult put ok and command first", () => {
    expect(okResult("daemon stop", { state: "stopped" })).toEqual({ ok: true, command: "daemon stop", state: "stopped" });
    expect(Object.keys(okResult("x", { a: 1 }))).toEqual(["ok", "command", "a"]);
    expect(failResult("x", { code: "boom", message: "it broke" })).toEqual({ ok: false, command: "x", error: { code: "boom", message: "it broke" } });
  });
  test("errorCode: the client's code, usage, else error", () => {
    expect(errorCode(new WalkieError("daemon_unreachable", "m", 0))).toBe("daemon_unreachable");
    expect(errorCode(new UsageError("m"))).toBe("usage");
    expect(errorCode(new Error("m"))).toBe("error");
  });
  test("quietCtx sends prose to stderr and leaves the rest alone", () => {
    const ctx = capture();
    quietCtx(ctx).out("hello");
    expect(ctx.outs).toEqual([]);
    expect(ctx.errs).toEqual(["hello"]);
  });
  test("a spread of the quiet context is still quiet and still json", () => {
    const ctx = capture();
    const copy = { ...quietCtx(ctx) };
    copy.out("x");
    expect(copy.json).toBe(true);
    expect(ctx.outs).toEqual([]);
    expect(ctx.errs).toEqual(["x"]);
  });
});

describe("runJsonCommand", () => {
  test("success: one object on stdout, prose on stderr", async () => {
    const ctx = capture();
    const code = await runJsonCommand(ctx, "daemon start", async (q) => { q.out("starting"); return { exit: 0, facts: { state: "started" } }; });
    expect(code).toBe(0);
    expect(ctx.outs.map((l) => JSON.parse(l))).toEqual([{ ok: true, command: "daemon start", state: "started" }]);
    expect(ctx.errs).toEqual(["starting"]);
  });
  test("a failure outcome keeps its exit code", async () => {
    const ctx = capture();
    const code = await runJsonCommand(ctx, "daemon start", async () => ({ exit: 1, error: { code: "daemon_start_failed", message: "daemon did not come up" } }));
    expect(code).toBe(1);
    expect(JSON.parse(ctx.outs[0] as string)).toEqual({ ok: false, command: "daemon start", error: { code: "daemon_start_failed", message: "daemon did not come up" } });
  });
  test("a thrown error is written as a failure object and rethrown", async () => {
    const ctx = capture();
    const err = new WalkieError("daemon_unreachable", "no daemon\u0007", 0);
    await expect(runJsonCommand(ctx, "setup", async () => { throw err; })).rejects.toBe(err);
    expect(ctx.outs).toHaveLength(1);
    expect(JSON.parse(ctx.outs[0] as string)).toEqual({ ok: false, command: "setup", error: { code: "daemon_unreachable", message: "no daemon" } });
  });
  test("a delegated outcome writes nothing", async () => {
    const ctx = capture();
    expect(await runJsonCommand(ctx, "setup", async () => ({ exit: 7, delegated: true }))).toBe(7);
    expect(ctx.outs).toEqual([]);
  });
});

const me = (over: Partial<MeView> = {}): MeView => ({
  version: "1", protocol: 1, team: { id: "t1", name: "Acme" }, node: { id: "n1", hostname: "box", ip: "127.0.0.1", port: 1 }, handle: "alex", role: "owner",
  tailscale: { ok: false, login: null }, transport: { mode: "direct" }, plan: null, ...over,
}) as MeView;

const facts = (over: Partial<SetupFacts> = {}): SetupFacts => ({
  me: me(), team: "created", service: { state: "running" }, teamAgents: "declined",
  hooks: { state: "skipped", reason: "--no-hooks" }, switching: { state: "skipped", reason: "--no-switching" }, ...over,
});

describe("setupResult", () => {
  test("a created team on a machine with everything skipped", () => {
    const r = setupResult(facts()) as Record<string, unknown>;
    expect(r).toMatchObject({
      team: { id: "t1", name: "Acme" }, handle: "alex", machine: { id: "n1", hostname: "box" }, transport: "direct", admitted: true, pending: false,
      team_result: "created", service: { state: "running" }, hooks: { state: "skipped", reason: "--no-hooks" }, switching: { state: "skipped", reason: "--no-switching" },
      team_agents: "declined",
    });
    expect(Array.isArray(r.next_steps)).toBe(true);
    expect((r.next_steps as string[]).every((s) => typeof s === "string")).toBe(true);
    expect((r.next_steps as string[]).join("\n")).toContain("walkie invite --handle <name>");
  });
  test("a machine still waiting for approval is pending, not admitted", () => {
    const r = setupResult(facts({ me: me({ team: null, handle: null, role: null, transport: { mode: null } }), team: "pending_approval" })) as Record<string, unknown>;
    expect(r).toMatchObject({ team: null, handle: null, transport: null, admitted: false, pending: true, team_result: "pending_approval" });
    expect((r.next_steps as string[]).join("\n")).toContain("approve this machine");
  });
  test("a skipped service and hooks found nowhere name what to run", () => {
    const r = setupResult(facts({ service: { state: "skipped", reason: "--no-service" }, hooks: { state: "none_found", agents: [] }, switching: { state: "declined" } })) as Record<string, unknown>;
    const steps = (r.next_steps as string[]).join("\n");
    expect(steps).toContain("walkie daemon start");
    expect(steps).toContain("walkie hooks install");
    expect(steps).toContain("walkie accounts shims install --profile");
  });
});
