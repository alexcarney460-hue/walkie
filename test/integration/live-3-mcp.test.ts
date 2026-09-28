// WALKIE-LIVE-3 (Opus r1 MED 2, Codex r1 #4): an unnamed MCP session delays only its roster card. Asks for it are
// pushed from the start, and asks that arrived before its stream subscribed are pushed once it announces.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Cluster, standardTeam, waitFor, type TestNode } from "../helpers/cluster.ts";

let c: Cluster;
let alex: TestNode, kira: TestNode;
beforeAll(async () => {
  c = new Cluster();
  ({ alex, kira } = await standardTeam(c));
});
afterAll(async () => { await c.close(); });

const GRACE_MS = 6_000;

function unnamedMcp(graceMs: number) {
  const env = { ...process.env, WALKIE_HOME: kira.home, WALKIE_SOCKET: kira.socket, WALKIE_MCP_ANNOUNCE_GRACE_MS: String(graceMs) } as Record<string, string>;
  for (const k of ["WALKIE_AGENT", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "KIMI_SESSION_ID", "WALKIE_ASK_POLICY"]) delete env[k];
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "../../src/cli/main.ts"), "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "probe", version: "0" });
  const pushes: string[] = [];
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === "notifications/claude/channel") pushes.push((n.params as { content: string }).content);
  };
  return { client, transport, pushes };
}

test("an ask sent before the unnamed session subscribed is pushed once, at announce; one sent during the grace, at once", async () => {
  const before = await alex.client().ask({ to: "@kira", text: "sent before the session started", timeout_s: 120 });
  const m = unnamedMcp(GRACE_MS);
  const t0 = Date.now();
  await m.client.connect(m.transport);
  try {
    await Bun.sleep(800); // inside the grace: no card yet, but the push loop is subscribed
    const agents = () => kira.client().agents().then((r) => r.agents.filter((a) => a.agent.startsWith("agent-")));
    expect(await agents()).toEqual([]);
    const during = await alex.client().ask({ to: "@kira", text: "sent during the grace", timeout_s: 120 });
    await waitFor(() => m.pushes.find((p) => p.includes(during.event.id)), { what: "push during grace", timeoutMs: 5_000 });
    // Pushed while the session still has no card: before the announcement, not because of it (timing-free under load).
    if (Date.now() - t0 < GRACE_MS) expect(await agents()).toEqual([]);
    await waitFor(() => m.pushes.find((p) => p.includes(before.event.id)), { what: "catch-up push at announce", timeoutMs: 15_000 });
    await waitFor(async () => (await agents()).length === 1, { what: "card after the grace", timeoutMs: 10_000 });
    await Bun.sleep(300);
    expect(m.pushes.filter((p) => p.includes(before.event.id))).toHaveLength(1);
    expect(m.pushes.filter((p) => p.includes(during.event.id))).toHaveLength(1);
  } finally {
    await m.client.close();
  }
}, 45_000);
