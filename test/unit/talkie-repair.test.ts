import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CleanupObligation } from "../../src/daemon/orchestrator/cleanup-obligation.ts";
import { repairTalkieCleanup, repairEmptyTalkieOwner as repairEmptyOwner, type RepairSnapshot } from "../../src/daemon/orchestrator/cleanup-repair.ts";
import { orchestrator } from "../../src/cli/commands/orchestrator.ts";
import type { Ctx } from "../../src/cli/context.ts";
import { parseArgs } from "../../src/cli/args.ts";
import { CLI_BOOLEANS } from "../../src/cli/booleans.ts";
import { inspectTalkieStatus, parsePersonRepairAnswer, personRepairArgv } from "../../src/cli/commands/talkie-repair.ts";
import { parseAdminArgv } from "../../src/daemon/seats/admin.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const state = () => {
  const dir = mkdtempSync("/tmp/walkie-repair-"); roots.push(dir);
  const path = join(dir, "cleanup.sqlite");
  const obligation = new CleanupObligation(path);
  obligation.record("run-one");
  return { path, obligation };
};
const clean: RepairSnapshot = { accountUid: null, uidTaken: false, processes: [], homeExists: false, ledgerOwner: null };
const personCtx = (interactive = true, marker: string | null = null): Ctx => ({
  agentMarker: () => marker, agentSignals: () => ({ marker, inspection: "ok" }),
  person: { interactive: () => interactive, ask: async () => "yes", note: () => undefined },
} as unknown as Ctx);

test("cleanup --repair parses as a person-only switch", () => {
  const args = parseArgs(["cleanup", "--repair"], CLI_BOOLEANS);
  expect(args.pos).toEqual(["cleanup"]);
  expect(args.flags.get("repair")).toBe(true);
});

test("repair gets validated read-only facts through the allowed helper command", async () => {
  const commands: string[][] = [];
  const result = await inspectTalkieStatus(async (argv) => {
    commands.push(argv);
    return { ok: true, status: { ...clean, processes: [42] } };
  });
  expect(commands).toHaveLength(1);
  expect(commands[0]?.slice(-2)).toEqual(["seat-admin", "talkie-status"]);
  expect(result.processes).toEqual([42]);
  await expect(inspectTalkieStatus(async () => ({ ok: true }))).rejects.toThrow("incomplete");
});

test("owner release forces the person's sudo password in a terminal", () => {
  expect(personRepairArgv("11111111-1111-4111-8111-111111111111")).toEqual([
    "sudo", "-k", "/usr/local/libexec/walkie/walkie-seat-admin", "seat-admin", "talkie-repair", "11111111-1111-4111-8111-111111111111",
  ]);
  expect(personRepairArgv(null).at(-1)).toBe("legacy");
  expect(parsePersonRepairAnswer(1, '{"ok":true}').ok).toBe(false);
  expect(parsePersonRepairAnswer(0, '{"ok":true}').ok).toBe(true);
});

test("repair clears only after all fixed-uid and ledger checks pass", async () => {
  const { path, obligation } = state();
  expect(await repairTalkieCleanup(path, async () => clean, personCtx())).toEqual({ repaired: true, remaining: [] });
  expect(obligation.read()).toBeNull();
  expect(obligation.record("run-one")).toBe(false);
});

test("person repair reruns cleanup before clearing, and retains the obligation on sweep failure", async () => {
  const { path, obligation } = state();
  let calls = 0;
  const failed = await repairTalkieCleanup(path, async () => clean, personCtx(), async () => {
    calls++;
    return "older folder still holds an entry";
  });
  expect(failed.repaired).toBe(false);
  expect(obligation.read()?.generation).toBe("run-one");
  const repaired = await repairTalkieCleanup(path, async () => clean, personCtx(), async () => {
    calls++;
    return null;
  });
  expect(repaired.repaired).toBe(true);
  expect(calls).toBe(2);
});

test("an existing talkie account blocks repair and names all remaining items", async () => {
  const { path, obligation } = state();
  expect(await repairTalkieCleanup(path, async () => ({ ...clean, accountUid: 550_000 }), personCtx()))
    .toMatchObject({ repaired: false, remaining: [expect.stringContaining("account remains")] });
  const result = await repairTalkieCleanup(path, async () => ({ ...clean, accountUid: 550_000,
    processes: [42], homeExists: true, ledgerOwner: "created" }), personCtx());
  expect(result.repaired).toBe(false);
  expect(result.remaining.join("; ")).toContain("process 42");
  expect(result.remaining.join("; ")).toContain("home");
  expect(result.remaining.join("; ")).toContain("ledger");
  expect(result.remaining.join("; ")).toContain("account remains");
  expect(obligation.read()?.generation).toBe("run-one");
});

test("repair checks uid processes again immediately before clearing", async () => {
  const { path, obligation } = state();
  let checks = 0;
  const result = await repairTalkieCleanup(path, async () => (++checks === 1 ? clean : { ...clean, processes: [73] }), personCtx());
  expect(result.repaired).toBe(false);
  expect(result.remaining).toContain("uid 550000 still has process 73");
  expect(checks).toBe(2);
  expect(obligation.read()?.generation).toBe("run-one");
});

test("repair refuses a different account on the fixed uid", async () => {
  const { path, obligation } = state();
  const result = await repairTalkieCleanup(path, async () => ({ ...clean, accountUid: 501, uidTaken: true }), personCtx());
  expect(result.repaired).toBe(false);
  expect(result.remaining.join("; ")).toContain("uid 501");
  expect(obligation.read()?.generation).toBe("run-one");
});

test("an agent cannot invoke cleanup repair even with agent admin enabled", async () => {
  const errors: string[] = [];
  const ctx = { args: { pos: ["cleanup"], flags: new Map([["repair", true]]) },
    agentMarker: () => "agent", agentSignals: () => ({ marker: "agent", inspection: "ok" }),
    person: { interactive: () => false }, err: (line: string) => { errors.push(line); } } as unknown as Ctx;
  expect(await orchestrator(ctx)).toBe(1);
  expect(errors.join(" ")).toContain("for people");
});

test("repair helper refuses agent and non-interactive callers before inspecting", async () => {
  const { path, obligation } = state();
  let checks = 0;
  const inspect = async () => { checks++; return clean; };
  await expect(repairTalkieCleanup(path, inspect, personCtx(true, "agent"))).rejects.toThrow("agents can't");
  await expect(repairTalkieCleanup(path, inspect, personCtx(false))).rejects.toThrow("only a person");
  expect(checks).toBe(0);
  expect(obligation.read()?.generation).toBe("run-one");
});

test("person can release an empty owner row without a pending obligation after seeing its generation", async () => {
  const dir = mkdtempSync("/tmp/walkie-repair-empty-"); roots.push(dir);
  const path = join(dir, "cleanup.sqlite");
  const snapshot = { ...clean, ledgerOwner: "making for uid 501", generation: "run-one", instance: "old-daemon" };
  const prompts: string[] = [];
  let released = false;
  const ctx = { ...personCtx(), person: { interactive: () => true,
    ask: async (prompt: string) => { prompts.push(prompt); return "yes"; }, note: () => undefined } } as Ctx;
  const result = await repairEmptyOwner(path, async () => released ? clean : snapshot,
    async (generation) => { expect(generation).toBe("run-one"); released = true; return { ok: true }; }, ctx);
  expect(result).toEqual({ repaired: true, remaining: [] });
  expect(prompts.join(" ")).toContain("run-one");
});

test("root repair command accepts only a fenced generation or legacy null marker", () => {
  expect(parseAdminArgv(["talkie-repair", "11111111-1111-4111-8111-111111111111"])?.verb).toBe("talkie-repair");
  expect(parseAdminArgv(["talkie-repair", "legacy"])?.verb).toBe("talkie-repair");
  expect(parseAdminArgv(["talkie-repair", "anything"])).toBeNull();
});

test("empty owner repair clears a matching pending obligation after root release", async () => {
  const { path, obligation } = state();
  let released = false;
  const row = { ...clean, ledgerOwner: "destroying for uid 501", generation: "run-one" };
  const result = await repairEmptyOwner(path, async () => released ? clean : row,
    async () => { released = true; return { ok: true }; }, personCtx());
  expect(result.repaired).toBe(true);
  expect(obligation.read()).toBeNull();
});
