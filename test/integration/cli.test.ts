// Runs the real CLI entry (`bun src/cli/main.ts …`) against in-process test daemons.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Cluster, standardTeam, waitFor, type TestNode } from "../helpers/cluster.ts";
import { runAsPerson } from "../helpers/person-cli.ts";

const CLI = join(import.meta.dir, "../../src/cli/main.ts");
let c: Cluster;
let alex: TestNode, kira: TestNode;

beforeAll(async () => {
  c = new Cluster();
  ({ alex, kira } = await standardTeam(c));
});
afterAll(async () => { await c.close(); });

async function walkie(node: TestNode | null, args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", NO_COLOR: "1", ...opts.env };
  if (node) { env.WALKIE_HOME = node.home; env.WALKIE_SOCKET = node.socket; }
  else { env.WALKIE_HOME = join(c.root, "nowhere"); }
  // A person's terminal: no agent runtime among its ancestors, even when the suite runs under one (agent-detect.ts).
  return runAsPerson([process.execPath, CLI, ...args], env, opts.stdin !== undefined ? { stdin: opts.stdin } : {});
}

describe("walkie CLI", () => {
  test("post (args and stdin) then get", async () => {
    const r1 = await walkie(alex, ["post", "#general", "hello", "from", "cli"]);
    expect(r1.code).toBe(0);
    expect(r1.out).toMatch(/^posted [0-9a-f]{16}:\d+ to #general/);
    const r2 = await walkie(alex, ["post", "general", "-"], { stdin: "piped text\n" });
    expect(r2.code).toBe(0);
    const got = await walkie(alex, ["get", "#general", "--limit", "5"]);
    expect(got.code).toBe(0);
    const lines = got.out.trim().split("\n");
    expect(lines.at(-1)).toMatch(/^\d\d:\d\d #general @alex\/alex-mbp {2}piped text$/);
    expect(lines.at(-2)).toContain("hello from cli");
    const js = JSON.parse((await walkie(alex, ["get", "#general", "--json", "--limit", "2"])).out) as { events: unknown[] };
    expect(js.events.length).toBe(2);
  });

  test("agent name from WALKIE_AGENT shows in the author", async () => {
    await walkie(alex, ["post", "#general", "agent says hi"], { env: { WALKIE_AGENT: "claude-3f9a" } });
    const got = await walkie(alex, ["get", "#general", "--limit", "1"]);
    expect(got.out).toContain("@alex/alex-mbp/claude-3f9a  agent says hi");
  });

  test("who shows team, machines and agents", async () => {
    await walkie(kira, ["status", "wiring", "the", "daemon", "--task", "ALE-5156", "--agent", "ux"]);
    await waitFor(async () => (await alex.client().agents()).agents.some((a) => a.agent === "ux"));
    const r = await walkie(alex, ["who"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("acme");
    expect(r.out).toContain("@alex");
    expect(r.out).toContain("@kira");
    expect(r.out).toContain("kiras-mbp");
    expect(r.out).toMatch(/ux\s+working\s+wiring the daemon \(ALE-5156\)/);
  });

  test("ask times out with exit code 2", async () => {
    const r = await walkie(alex, ["ask", "@kira", "anyone", "there?", "--timeout", "1"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("no answer within 1s");
  });

  test("ask answered via reply exits 0 and prints the answer", async () => {
    const asking = walkie(alex, ["ask", "@kira", "ship it?", "--timeout", "20"]);
    const ask = await waitFor(async () => (await kira.client().asks({ state: "open", to: "me" })).asks.find((a) => (a.ask.body as { text: string }).text === "ship it?"));
    const ans = await walkie(kira, ["reply", ask.ask.id, "ship", "it"]);
    expect(ans.code).toBe(0);
    const r = await asking;
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("ship it");
  });

  test("inbox + answer --decline → asker exit 2", async () => {
    const asking = walkie(alex, ["ask", "@kira", "friday deploy?", "--timeout", "20"]);
    const ask = await waitFor(async () => (await kira.client().asks({ state: "open", to: "me" })).asks.find((a) => (a.ask.body as { text: string }).text === "friday deploy?"));
    const inbox = await walkie(kira, ["inbox"]);
    expect(inbox.out).toContain("friday deploy?");
    expect((await walkie(kira, ["answer", ask.ask.id, "no", "--decline"])).code).toBe(0);
    const r = await asking;
    expect(r.code).toBe(2);
    expect(r.err).toContain("declined");
  });

  test("daemon unreachable → exit 3; usage errors → exit 1", async () => {
    const r = await walkie(null, ["get"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("not reachable");
    expect((await walkie(alex, ["post"])).code).toBe(1);
    expect((await walkie(alex, ["nonsense"])).code).toBe(1);
    expect((await walkie(alex, ["version"])).out).toMatch(/^walkie \d+\.\d+\.\d+/);
    expect((await walkie(alex, ["help"])).out).toContain("usage: walkie <command>");
  });

  test("channel create + share + fetch round trip", async () => {
    expect((await walkie(alex, ["channel", "create", "ops", "--topic", "operations"])).code).toBe(0);
    const file = join(c.root, "artifact.txt");
    await Bun.write(file, "artifact body");
    const s = await walkie(alex, ["share", file, "#ops", "--note", "fyi"]);
    expect(s.code).toBe(0);
    const hash = /→ ([0-9a-f]{64})/.exec(s.out)?.[1] as string;
    await waitFor(() => kira.d.core.store.blobRefRows(hash).length > 0);
    const f = await walkie(kira, ["fetch", hash]);
    expect(f.code).toBe(0);
    expect(f.out).toBe("artifact body");
  });

  test("daemon install --dry-run prints the unit without installing", async () => {
    const r = await walkie(alex, ["daemon", "install", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("would install");
    expect(r.out).toContain("daemon");
  });
});
