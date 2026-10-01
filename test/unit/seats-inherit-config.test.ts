import { expect, test } from "bun:test";
import { parseArgs } from "../../src/cli/args.ts";
import { CLI_BOOLEANS } from "../../src/cli/booleans.ts";
import { seats } from "../../src/cli/commands/seats.ts";
import type { Ctx } from "../../src/cli/context.ts";
import type { SeatsLocalView } from "../../src/protocol/seats.ts";

test("a local person can withdraw personal config inheritance; omitted allow and deny preserve it", async () => {
  const calls: Record<string, unknown>[] = [];
  let local = { allow: true, ephemeral: false, same_user: true } as SeatsLocalView;
  const client = {
    seats: async () => ({ local }),
    seatsConfig: async (body: Record<string, unknown>) => {
      calls.push(body);
      local = { ...local, allow: body.allow as boolean };
      return { local };
    },
  };
  const run = async (argv: string[]) => {
    const ctx = {
      args: parseArgs(argv, CLI_BOOLEANS), json: true,
      agentMarker: () => null, agentSignals: () => ({ marker: null, inspection: "ok" as const }),
      person: { interactive: () => true, ask: async () => "yes", note: () => undefined },
      client: () => client, out: () => undefined, err: () => undefined,
    } as unknown as Ctx;
    expect(await seats(ctx)).toBe(0);
  };
  await run(["allow", "--inherit-person-config=false"]);
  await run(["allow"]);
  await run(["deny"]);
  await run(["deny", "--inherit-person-config=false"]);
  expect(calls).toEqual([
    { allow: true, inherit_person_config: false },
    { allow: true },
    { allow: false },
    { allow: false, inherit_person_config: false },
  ]);
});
