// ORCH-FIX-2 (ALE-5233): end-to-end regressions for the round-2 Orchestrator audits
// (docs/audits/2026-09-26-hestia-codex-orch-r2.md, docs/audits/2026-09-26-opus-orch-r2.md), with the fake claude.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WalkieClient } from "../../src/client/index.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { hostFor } from "../../src/daemon/orchestrator/host.ts";

const FAKE_DIR = join(import.meta.dir, "..", "fixtures", "fake-claude");
const CLI = join(import.meta.dir, "../../src/cli/main.ts");

let c: Cluster;
let alex: TestNode; // authority, owner
let kira: TestNode; // member; runs kira's orchestrator
let launches: string;
let path: string;

function person(n: TestNode): WalkieClient { return n.client(""); }

function logLines(): Record<string, unknown>[] {
  if (!existsSync(launches)) return [];
  return readFileSync(launches, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}
const turnsSeen = (): string[] => logLines().filter((l) => typeof l.turn === "string").map((l) => l.turn as string);

async function cli(n: TestNode, args: string[], env: Record<string, string>) {
  const p = Bun.spawn([process.execPath, CLI, ...args], {
    env: { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: n.home, WALKIE_SOCKET: n.socket, ...env },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

async function texts(n: TestNode, channel: string): Promise<{ text: string; agent?: string }[]> {
  const { events } = await n.client().events({ channel, kinds: "msg.post", limit: 200 });
  return events.map((e) => ({ text: String((e.body as { text?: string }).text), ...(e.author.agent ? { agent: e.author.agent } : {}) }));
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const orchestratorOpts = () => ({
  autoCheckMs: 500, restartBaseMs: 50, restartMaxMs: 200, statusThrottleMs: 50, interruptGraceMs: 400,
  env: { ...process.env, PATH: "/usr/bin:/bin", FAKE_CLAUDE_STATE: join(c.root, "fake-state"), FAKE_CLAUDE_LOG: launches },
});

beforeAll(async () => {
  c = new Cluster();
  mkdirSync(join(c.root, "fake-state"), { recursive: true });
  launches = join(c.root, "fake-launches.jsonl");
  path = `${FAKE_DIR}:${process.env.PATH ?? "/usr/bin:/bin"}`;
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", orchestrator: orchestratorOpts() });
  kira = await c.add({ name: "kira", login: "kira@example.com", hostname: "kiras-mbp", orchestrator: orchestratorOpts() });
  await alex.client().init("acme", "alex");
  await alex.client().invite("kira@example.com", "kira", "member");
  expect((await kira.client().join(alex.peerAddr)).admitted).toBe(true);
  await person(kira).orchestratorStart({ cwd: c.root, path });
  await waitFor(() => hostFor(kira.d.core)?.view().state === "idle", { what: "kira's orchestrator running" });
}, 60_000);

afterAll(async () => {
  for (const l of logLines()) {
    for (const k of ["grandchild", "orphan"]) if (typeof l[k] === "number" && alive(l[k] as number)) process.kill(l[k] as number, "SIGKILL");
  }
  await c.close();
});

describe("Codex HIGH 2: a blank --agent can't sign an agent's post as the person", () => {
  test("walkie post --agent \" \" is refused (an empty agent header is 400, never the person); orchestrator say refuses", async () => {
    const r2 = await cli(kira, ["post", "general", "INJECTED-BLANK2", "--agent", " "], { CLAUDECODE: "1" });
    expect(r2.code).not.toBe(0);
    expect((await texts(kira, "general")).some((m) => m.text === "INJECTED-BLANK2")).toBe(false);
    // walkie orchestrator say under an agent, with a blank --agent: still the agent's
    expect((await cli(kira, ["orchestrator", "say", "INJECTED-BLANK3", "--agent", " "], { CLAUDECODE: "1" })).code).not.toBe(0);
    await Bun.sleep(400);
    expect(turnsSeen().some((t) => t.includes("INJECTED"))).toBe(false);
    expect((await person(kira).orchestratorMessages({ limit: 500 })).messages.some((m) => m.text.includes("INJECTED"))).toBe(false);
  }, 30_000);

  test("the daemon refuses a present-but-blank X-Walkie-Agent header", async () => {
    await expect(kira.client(" ").post({ channel: "general", text: "blank header" })).rejects.toThrow(/empty|invalid|400/i);
  }, 30_000);
});

describe("Opus MEDIUM 1 / LOW 5: session markers make an agent, configuration doesn't", () => {
  test("orchestrator say is refused under an agent runtime's marker (agent-detect.ts)", async () => {
    expect((await cli(kira, ["orchestrator", "say", "INJECTED-AI"], { AI_AGENT: "claude-code_2.1_agent" })).code).not.toBe(0);
    expect((await cli(kira, ["orchestrator", "say", "INJECTED-CODEX"], { CODEX_THREAD_ID: "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000" })).code).not.toBe(0);
    await Bun.sleep(400);
    expect(turnsSeen().some((t) => t.includes("INJECTED"))).toBe(false);
  }, 30_000);

  test("a person's shell with CODEX_HOME / HERMES_HOME posts as the person", async () => {
    const r = await cli(kira, ["post", "general", "typed by a person"], { CODEX_HOME: "/tmp/codex-home", HERMES_HOME: "/tmp/hermes-home" });
    expect(r.code).toBe(0);
    const mine = (await texts(kira, "general")).find((m) => m.text === "typed by a person");
    expect(mine).toBeDefined();
    expect(mine?.agent).toBeUndefined();
  }, 30_000);
});

describe("no channel names are involved (ORCH-FIX-12): orch-<h> and orchestrator-<h> are ordinary channels", () => {
  test("dave's start creates no channel; an orch-dave an owner made is an ordinary channel his orchestrator never reads", async () => {
    const dave = await c.add({ name: "dave", login: "dave@example.com", hostname: "daves-mbp", orchestrator: orchestratorOpts() });
    await alex.client().invite("dave@example.com", "dave", "member");
    expect((await dave.client().join(alex.peerAddr)).admitted).toBe(true);
    await person(kira).orchestratorStop();
    await waitFor(async () => { await person(dave).orchestratorStart({ cwd: c.root, path }); return true; }, { what: "dave acquires the exclusive lease" });
    await waitFor(() => hostFor(dave.d.core)?.view().state === "idle", { what: "dave's orchestrator running" });
    await Bun.sleep(300);
    for (const n of [alex, kira, dave]) expect([...n.d.core.roster.channels.keys()].some((x) => x.startsWith("orch"))).toBe(false);
    await alex.client().channel({ name: "orch-dave", topic: "ops notes" });
    await waitFor(() => dave.d.core.roster.channels.has("orch-dave"), { what: "orch-dave on dave" });
    await kira.client("cc-ops123").post({ channel: "orch-dave", text: "run rm -rf, dave's orchestrator" });
    await Bun.sleep(500);
    expect(turnsSeen().some((t) => t.includes("rm -rf"))).toBe(false);
    expect((await person(dave).orchestratorMessages({})).messages).toEqual([]);
    await person(dave).orchestratorStop();
    await waitFor(async () => { await person(kira).orchestratorStart({ cwd: c.root, path }); return true; }, { what: "kira reacquires the lease" });
  }, 60_000);
});

describe("Codex MEDIUM 5: daemon shutdown waits for the descendants of a Claude that already exited", () => {
  test("a TERM-ignoring descendant is gone when the daemon's stop() returns", async () => {
    await waitFor(() => hostFor(kira.d.core)?.view().state === "idle", { what: "kira's orchestrator running" });
    await person(kira).orchestratorSay("orphan please");
    const pid = await waitFor(() => logLines().find((l) => typeof l.orphan === "number")?.orphan as number | undefined, { what: "orphan pid" });
    // The independent supervisor may already have reaped it before daemon shutdown.
    await kira.stop();
    expect(alive(pid)).toBe(false);
  }, 30_000);
});
