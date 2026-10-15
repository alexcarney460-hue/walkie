import { expect, test } from "bun:test";
import { browserCmd } from "./browser.ts";
import type { Ctx } from "../context.ts";

test("an agent cannot turn this machine's browser on, even with a working daemon client", async () => {
  let writes = 0;
  const ctx = {
    args: { pos: ["on"], flags: new Map() }, json: false,
    agentMarker: () => "claude-code", agentSignals: () => ({ marker: "claude-code", inspection: "ok" }),
    person: { interactive: () => true, ask: async () => "yes", note: () => {} },
    client: () => ({ request: async (method: string) => { if (method === "POST") writes++; return { enabled: false, allowed_agents: [], denylist: [] }; } }),
    out: () => {}, err: () => {},
  } as unknown as Ctx;
  await expect(browserCmd(ctx)).rejects.toThrow("agents can't");
  expect(writes).toBe(0);
});
