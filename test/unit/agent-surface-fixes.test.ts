import { expect, test } from "bun:test";
import { cliArgvProblem } from "../../src/mcp/walkie-cli.ts";
import { join, teamCmd } from "../../src/cli/commands/team.ts";
import { parseArgs } from "../../src/cli/args.ts";
import { CLI_BOOLEANS } from "../../src/cli/booleans.ts";
import type { Ctx } from "../../src/cli/context.ts";

test("MCP refuses deciding link actions and channel archive, while allowing reads", () => {
  for (const args of [["team", "link"], ["team", "link", "revoke", "abcdef"], ["channel", "archive", "general"]])
    expect(cliArgvProblem(args)).toContain("person");
  expect(cliArgvProblem(["team", "link", "list"])).toBeNull();
});

function ctx(args: string[], client: Record<string, unknown>, json = true) {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, value: {
    args: parseArgs(args, CLI_BOOLEANS), json, forAgent: false, agentMarker: () => null,
    person: { interactive: () => true, ask: async () => "", note: () => {} },
    client: () => client, out: (s: string) => lines.push(s), err: (s: string) => errors.push(s),
  } as unknown as Ctx };
}

test("team pending reads the existing pending endpoint as JSON", async () => {
  const calls: unknown[] = [];
  const r = ctx(["pending"], { request: async (...args: unknown[]) => { calls.push(args); return { requests: [], roster_requests: [] }; } });
  expect(await teamCmd(r.value)).toBe(0);
  expect(calls).toEqual([["GET", "/v1/team/pending"]]);
  expect(JSON.parse(r.lines[0]!)).toEqual({ requests: [], roster_requests: [] });
});

test("team admit sends an ordinary decision and preserves the receipt", async () => {
  const calls: unknown[] = [];
  const r = ctx(["admit", "a".repeat(16), "--yes"], { request: async (...args: unknown[]) => {
    calls.push(args);
    return args[0] === "GET" ? { requests: [{ node_id: "a".repeat(16) }] } : { event: { id: "receipt" } };
  } });
  expect(await teamCmd(r.value)).toBe(0);
  expect(calls[1]).toEqual(["POST", "/v1/team/admit", { node_id: "a".repeat(16), approve: true }]);
  expect(JSON.parse(r.lines[0]!)).toEqual({ event: { id: "receipt" } });
});

test("team admit uses the fleet request's link and generation", async () => {
  const calls: unknown[] = [];
  const node = "b".repeat(16);
  const link = "c".repeat(32);
  const generation = "d".repeat(32);
  const r = ctx(["admit", node, "--decline", "--yes"], { request: async (...args: unknown[]) => {
    calls.push(args);
    return args[0] === "GET" ? { requests: [{ node_id: node, link, generation }] } : { queued: true, request_id: "receipt" };
  } });
  expect(await teamCmd(r.value)).toBe(0);
  expect(calls[1]).toEqual(["POST", "/v1/team/admit-link", { node_id: node, approve: false, link, generation }]);
  expect(JSON.parse(r.lines[0]!)).toEqual({ queued: true, request_id: "receipt" });
});

test("join --wait retries an ordinary pending join until it adopts the roster", async () => {
  let checks = 0;
  const r = ctx(["peer", "--wait"], {
    join: async () => ++checks === 1 ? { admitted: false, reason: "pending_approval" }
      : { admitted: true, team: { name: "test" }, handle: "alex", role: "owner", node: { hostname: "test" } },
  });
  expect(await join(r.value)).toBe(0);
  expect(checks).toBe(2);
  expect(JSON.parse(r.lines[0]!).admitted).toBe(true);
});

test("join --wait reports a pending timeout without claiming admission", async () => {
  const old = process.env.WALKIE_LINK_WAIT_S;
  process.env.WALKIE_LINK_WAIT_S = "0";
  try {
    const r = ctx(["peer", "--wait"], { join: async () => ({ admitted: false, reason: "pending_approval" }) });
    expect(await join(r.value)).toBe(2);
    expect(JSON.parse(r.lines[0]!)).toMatchObject({ admitted: false, reason: "pending_approval" });
  } finally {
    if (old === undefined) delete process.env.WALKIE_LINK_WAIT_S;
    else process.env.WALKIE_LINK_WAIT_S = old;
  }
});

test("join --wait does not poll after a shortened deadline", async () => {
  const old = process.env.WALKIE_LINK_WAIT_S;
  process.env.WALKIE_LINK_WAIT_S = "0.01";
  try {
    let calls = 0;
    const r = ctx(["peer", "--wait"], { join: async () => { calls++; return { admitted: false, reason: "pending_approval" }; } });
    const start = Date.now();
    expect(await join(r.value)).toBe(2);
    expect(Date.now() - start).toBeLessThan(500);
    expect(calls).toBe(1);
  } finally {
    if (old === undefined) delete process.env.WALKIE_LINK_WAIT_S;
    else process.env.WALKIE_LINK_WAIT_S = old;
  }
});

test("join --wait ignores admission returned after its deadline", async () => {
  const old = process.env.WALKIE_LINK_WAIT_S;
  process.env.WALKIE_LINK_WAIT_S = "2.2";
  try {
    let calls = 0;
    let retryTimeout: number | undefined;
    const r = ctx(["peer", "--wait"], { join: async (_peer: string, timeoutMs?: number) => {
      if (++calls === 1) return { admitted: false, reason: "pending_approval" };
      retryTimeout = timeoutMs;
      await Bun.sleep(400);
      return { admitted: true, team: { name: "test" }, handle: "alex", role: "owner", node: { hostname: "test" } };
    } });
    const start = Date.now();
    expect(await join(r.value)).toBe(2);
    expect(Date.now() - start).toBeLessThan(2_500);
    expect(calls).toBe(2);
    expect(retryTimeout).toBeGreaterThan(0);
    expect(retryTimeout).toBeLessThanOrEqual(200);
    expect(JSON.parse(r.lines[0]!)).toMatchObject({ admitted: false, reason: "pending_approval" });
  } finally {
    if (old === undefined) delete process.env.WALKIE_LINK_WAIT_S;
    else process.env.WALKIE_LINK_WAIT_S = old;
  }
});
