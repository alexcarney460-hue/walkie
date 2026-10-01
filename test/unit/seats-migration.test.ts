import { expect, test } from "bun:test";
import { parseArgs } from "../../src/cli/args.ts";
import { CLI_BOOLEANS } from "../../src/cli/booleans.ts";
import { seats } from "../../src/cli/commands/seats.ts";
import type { Ctx } from "../../src/cli/context.ts";
import { remoteArgvProblem } from "../../src/protocol/admin.ts";
import type { SeatsLocalView } from "../../src/protocol/seats.ts";

test("remote admin cannot request a same-user mode flip", () => {
  expect(remoteArgvProblem(["seats", "allow", "--same-user"])).toContain("cannot run remotely");
  expect(remoteArgvProblem(["seats", "enable", "--same-user", "--yes"])).toContain("cannot run remotely");
  expect(remoteArgvProblem(["seats", "migrate", "--same-user"])).toContain("can't run remotely");
});

test("local migration inventories, asks for typed consent, denies, then sends the one-use confirmation", async () => {
  const calls: unknown[] = [];
  let local = { allow: true, ephemeral: true, same_user: false, running: 0, queued: 0, quarantined: [] } as unknown as SeatsLocalView;
  const client = {
    seats: async () => ({ local, seats: [] }),
    me: async () => ({ team: { name: "fixture" }, node: { id: "node" } }),
    seatsConfig: async (body: Record<string, unknown>) => {
      calls.push(body);
      local = { ...local, allow: body.allow as boolean, ...(body.mode === "same_user" ? { ephemeral: false, same_user: true } : {}) };
      return { local };
    },
  };
  const output: string[] = [];
  const ctx = {
    args: parseArgs(["migrate", "--same-user"], CLI_BOOLEANS), json: false,
    agentMarker: () => null, agentSignals: () => ({ marker: null, inspection: "ok" as const }),
    person: { interactive: () => true, ask: async () => "migrate same-user seats", note: () => undefined },
    client: () => client, out: (line: string) => output.push(line), err: (line: string) => output.push(line),
  } as unknown as Ctx;
  expect(await seats(ctx)).toBe(0);
  expect(calls).toEqual([{ allow: false }, { allow: true, mode: "same_user", migration_confirm: "migrate same-user seats" }]);
  expect(output.join("\n")).toContain("Seat migration preflight");
});

test("migration stays the person's alone: an agent, or a caller with no terminal, is refused before anything is sent", async () => {
  const calls: unknown[] = [];
  const local = { allow: true, ephemeral: true, same_user: false, running: 0, queued: 0, quarantined: [] } as unknown as SeatsLocalView;
  const client = {
    seats: async () => ({ local, seats: [] }),
    me: async () => ({ team: { name: "fixture" }, node: { id: "node" } }),
    seatsConfig: async (body: Record<string, unknown>) => { calls.push(body); return { local }; },
  };
  for (const [who, marker, terminal] of [["an agent", "CLAUDECODE is set in its environment", true], ["no terminal", null, false]] as const) {
    const ctx = {
      args: parseArgs(["migrate", "--same-user"], CLI_BOOLEANS), json: false,
      agentMarker: () => marker, agentSignals: () => ({ marker, inspection: "ok" as const }),
      person: { interactive: () => terminal, ask: async () => "migrate same-user seats", note: () => undefined },
      client: () => client, out: () => undefined, err: () => undefined,
    } as unknown as Ctx;
    await expect(seats(ctx), who).rejects.toThrow("seat migration is for the person at this machine's terminal");
  }
  expect(calls).toEqual([]);
});
