import { expect, test } from "bun:test";
import { channelsCmd } from "./channels.ts";
import type { Ctx } from "../context.ts";
import { createHash } from "node:crypto";

test("agent cannot enable or register a messaging number", async () => {
  let writes = 0;
  for (const pos of [["on"], ["register", "+15551230001"], ["link", "whatsapp"]]) {
    const ctx = {
      args: { pos, flags: new Map() }, json: false,
      agentMarker: () => "codex", agentSignals: () => ({ marker: "codex", inspection: "ok" }),
      person: { interactive: () => true, ask: async () => "yes", note: () => {} },
      client: () => ({ request: async () => { writes++; return {}; } }),
      out: () => {}, err: () => {},
    } as unknown as Ctx;
    await expect(channelsCmd(ctx)).rejects.toThrow("agents can't");
  }
  expect(writes).toBe(0);
});

test("enabling shows risk and sends explicit acknowledgement", async () => {
  const sent: unknown[] = [];
  const warnings: string[] = [];
  const ctx = {
    args: { pos: ["on"], flags: new Map() }, json: false,
    agentMarker: () => null, agentSignals: () => ({ marker: null, inspection: "ok" }),
    person: { interactive: () => true, ask: async () => "yes", note: () => {} },
    client: () => ({ request: async (...args: unknown[]) => { sent.push(args); return args[0] === "GET" ? { warning: "WhatsApp and Google may block the number" } : {}; } }),
    out: () => {}, err: (value: string) => warnings.push(value),
  } as unknown as Ctx;
  expect(await channelsCmd(ctx)).toBe(0);
  expect(warnings.join(" ")).toContain("may block the number");
  expect(sent).toEqual([
    ["GET", "/v1/channels/config"],
    ["POST", "/v1/channels/config", { enabled: true, acknowledge_risk: createHash("sha256").update("WhatsApp and Google may block the number").digest("hex") }],
  ]);
});

test("only a person can reset a damaged channel quota", async () => {
  const calls: unknown[] = [];
  const output: string[] = [];
  const ctx = {
    args: { pos: ["reset-quota"], flags: new Map() }, json: false,
    agentMarker: () => null, agentSignals: () => ({ marker: null, inspection: "ok" }),
    person: { interactive: () => true, ask: async () => "yes", note: () => {} },
    client: () => ({ request: async (...args: unknown[]) => { calls.push(args); return args[0] === "GET" ? { quota_damaged: true } : { backup: "/tmp/quota.json.damaged-test" }; } }),
    out: (value: string) => output.push(value), err: () => {},
  } as unknown as Ctx;
  expect(await channelsCmd(ctx)).toBe(0);
  expect(calls).toEqual([["GET", "/v1/channels/status"], ["POST", "/v1/channels/reset-quota"]]);
  expect(output[0]).toContain("quota.json.damaged-test");
  const agent = { ...ctx, agentMarker: () => "codex", agentSignals: () => ({ marker: "codex", inspection: "ok" }) } as Ctx;
  await expect(channelsCmd(agent)).rejects.toThrow("agents can't");
  expect(calls).toHaveLength(2);
});
