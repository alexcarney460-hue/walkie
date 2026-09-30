// ORCH-2 fix: the walkie_cli MCP tool runs one walkie command as an argv array (no shell) with a timeout and an output
// cap, redacted; it refuses what the remote-admin allow-list refuses (accounts exec, trust-cli) and more. WalkieTalkie's
// platform access allows only the Walkie MCP tools, so this is its way to the walkie CLI.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import type { WalkieClient } from "../../src/client/index.ts";
import { callTool, TOOLS } from "../../src/mcp/tools.ts";
import { cliArgvProblem, runWalkieCli } from "../../src/mcp/walkie-cli.ts";
import { Cluster, type TestNode } from "../helpers/cluster.ts";

let c: Cluster;
let alex: TestNode;
let env: Record<string, string>;
beforeAll(async () => {
  c = new Cluster();
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  await alex.client().init("acme", "alex");
  env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", NO_COLOR: "1", WALKIE_HOME: alex.home, WALKIE_SOCKET: alex.socket, WALKIE_AGENT: "cc-tester" };
}, 30_000);
afterAll(async () => { await c.close(); });

describe("walkie_cli", () => {
  test("is an MCP tool taking args: string[]", () => {
    const t = TOOLS.find((x) => x.name === "walkie_cli");
    expect(t?.inputSchema).toMatchObject({ required: ["args"], properties: { args: { type: "array", items: { type: "string" } } } });
  });

  test("runs `who --json` against the daemon as this agent", async () => {
    const r = await runWalkieCli(["who", "--json"], env);
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout) as { team: { name: string } };
    expect(out.team.name).toBe("acme");
    expect(r.timed_out).toBe(false);
  }, 30_000);

  test("refuses accounts exec (also behind a leading flag), trust-cli and other credential/program commands, without running anything", async () => {
    for (const bad of [["accounts", "exec", "--provider", "claude", "--", "sh"], ["accounts", "--json", "exec", "--", "id"], ["accounts", "trust-cli"],
      ["claude"], ["dashboard"], ["mobile", "pair"], ["token", "rotate"], ["update"], ["daemon", "stop"], ["talkie", "say", "hi"],
      ["integrations", "enable", "linear", "--key", "-"], ["integrations", "enable", "linear", "--key=abc"], ["post", "#general", "-"],
      ["seat", "run", "--agent", "helper"], ["post", "#general", "--agent=helper", "hello"], []]) {
      expect({ bad, refused: cliArgvProblem(bad) !== null }).toEqual({ bad, refused: true });
    }
    for (const ok of [["who", "--json"], ["projects", "list", "--all", "--json"], ["team", "add-machine", "alex", "--json"], ["talkie", "status"],
      ["task", "create", "WEB", "Fix; ls ~/keys | cat", "--column", "todo"], ["admin", "--machine", "hestia", "seats", "enable"]]) {
      expect({ ok, problem: cliArgvProblem(ok) }).toEqual({ ok, problem: null });
    }
    const calls: string[] = [];
    const spy = new Proxy({}, { get: (_t, k) => { calls.push(String(k)); return () => Promise.reject(new Error("no daemon")); } }) as WalkieClient;
    const r = await callTool(spy, "walkie_cli", { args: ["accounts", "exec", "--provider", "claude", "--", "sh", "-c", "id"] });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("walkie_cli doesn't run walkie accounts exec");
    expect(calls).toEqual([]);
  });

  test("a shell metacharacter stays a literal argument (nothing is run by a shell)", async () => {
    const marker = `/tmp/wc${process.pid}`;
    rmSync(marker, { force: true });
    const arg = `;touch ${marker}|$(touch ${marker})\`touch ${marker}\``;
    const r = await runWalkieCli(["stale", "--project", arg, "--json"], env);
    expect(r.exit).not.toBe(0); // no such project: the whole string reached walkie as one value
    expect(`${r.stdout}${r.stderr}`).toMatch(/project/i);
    expect(existsSync(marker)).toBe(false);
  }, 30_000);
});
