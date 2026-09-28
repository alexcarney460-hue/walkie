// ORCH-FIX-3 (ALE-5233) introduced launchers (config.json `orchestrator.launchers`); ORCH-FIX-11 removed them: only
// the person at the machine drives its orchestrator. End to end with the fake claude and the real CLI.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WalkieClient } from "../../src/client/index.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { runAsPerson } from "../helpers/person-cli.ts";

const FAKE_DIR = join(import.meta.dir, "..", "fixtures", "fake-claude");
const CLI = join(import.meta.dir, "../../src/cli/main.ts");
const LAUNCHER = "driver";

let c: Cluster;
let alex: TestNode; // authority
let kira: TestNode; // lists @kira/kiras-mbp/driver; runs kira's orchestrator
let launches: string;
let path: string;

function person(n: TestNode): WalkieClient { return n.client(""); }

function logLines(): Record<string, unknown>[] {
  if (!existsSync(launches)) return [];
  return readFileSync(launches, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}
const turnsSeen = (): string[] => logLines().filter((l) => typeof l.turn === "string").map((l) => l.turn as string);

/** The real CLI as a person's terminal runs it: no agent runtime among its ancestors (test/helpers/person-cli.ts). */
async function personCli(n: TestNode, args: string[]) {
  // A person at a terminal (fix round 2: the conversation is a person's, and no terminal counts as an agent).
  return runAsPerson([process.execPath, CLI, ...args], { PATH: path, NO_COLOR: "1", HOME: process.env.HOME ?? "/tmp", WALKIE_HOME: n.home, WALKIE_SOCKET: n.socket }, { tty: true });
}

async function cli(n: TestNode, args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn([process.execPath, CLI, ...args], {
    env: { PATH: path, NO_COLOR: "1", WALKIE_HOME: n.home, WALKIE_SOCKET: n.socket, ...env },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

const running = async (): Promise<boolean> => (await person(kira).orchestrator()).local.running;

beforeAll(async () => {
  c = new Cluster();
  mkdirSync(join(c.root, "fake-state"), { recursive: true });
  launches = join(c.root, "fake-launches.jsonl");
  path = `${FAKE_DIR}:${process.env.PATH ?? "/usr/bin:/bin"}`;
  const orchestrator = {
    autoCheckMs: 500, restartBaseMs: 50, restartMaxMs: 200, statusThrottleMs: 50, interruptGraceMs: 400,
    env: { ...process.env, PATH: "/usr/bin:/bin", FAKE_CLAUDE_STATE: join(c.root, "fake-state"), FAKE_CLAUDE_LOG: launches },
  };
  // Kira's machine still lists a launcher from an older build: it is ignored.
  mkdirSync(join(c.root, "kira"), { recursive: true, mode: 0o700 });
  writeFileSync(join(c.root, "kira", "config.json"), JSON.stringify({
    orchestrator: { launchers: [`@kira/kiras-mbp/${LAUNCHER}`, "@kira/kiras-mbp", "@kira/kiras-mbp/orchestrator"] },
  }));
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", orchestrator });
  kira = await c.add({ name: "kira", login: "kira@example.com", hostname: "kiras-mbp", orchestrator });
  await alex.client().init("acme", "alex");
  await alex.client().invite("kira@example.com", "kira", "member");
  expect((await kira.client().join(alex.peerAddr)).admitted).toBe(true);
  await person(kira).orchestratorStart({ cwd: c.root, path });
  await waitFor(async () => (await person(kira).orchestrator()).local.state === "idle", { what: "kira's orchestrator idle" });
}, 60_000);

afterAll(async () => {
  await c.close();
});

describe("no launchers (ORCH-FIX-11): every agent is refused, even one an older config.json lists", () => {
  test("an agent (session marker) can't say or read, can't stop or start while agent admin is off, and nothing reaches Claude", async () => {
    await kira.client().adminSwitches({ agent_admin: false });
    for (const env of <Record<string, string>[]>[{ CLAUDECODE: "1", WALKIE_AGENT: "intruder" }, { CLAUDECODE: "1", WALKIE_AGENT: LAUNCHER }, { CLAUDECODE: "1", WALKIE_AGENT: "orchestrator" }, { CLAUDECODE: "1" }]) {
      const say = await cli(kira, ["orchestrator", "say", "INJECTED-SAY", "--timeout", "5"], env);
      expect(say.code).not.toBe(0);
      expect(say.err).toContain("is for people");
      expect((await cli(kira, ["orchestrator", "stop"], env)).code).not.toBe(0);
      expect((await cli(kira, ["orchestrator", "log"], env)).code).not.toBe(0);
      expect(await running()).toBe(true);
    }
    // The daemon's own check, for callers that don't go through the CLI (the listed name included).
    for (const agent of ["intruder", LAUNCHER]) {
      await expect(kira.client(agent).orchestratorSay("INJECTED-RAW")).rejects.toThrow(/never an agent/);
      await expect(kira.client(agent).orchestratorMessages({})).rejects.toThrow(/never an agent/);
      await expect(kira.client(agent).orchestratorStop()).rejects.toThrow(/agent admin is off/);
      await expect(kira.client(agent).orchestratorStart({ cwd: c.root, path })).rejects.toThrow(/agent admin is off/);
    }
    await kira.client().adminSwitches({ agent_admin: true });
    // With it on, an impostor naming itself "orchestrator" is still refused (the name needs the host's token).
    await expect(kira.client("orchestrator").orchestratorStop()).rejects.toThrow(/reserved for this machine's orchestrator/);
    await Bun.sleep(500);
    expect(turnsSeen().some((t) => t.includes("INJECTED"))).toBe(false);
    expect(await running()).toBe(true);
  }, 60_000);

  test("a plain person's terminal works: say waits for the reply, log shows the conversation", async () => {
    const r = await personCli(kira, ["orchestrator", "say", "PERSON-HELLO", "--new", "--timeout", "20"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("pong: PERSON-HELLO");
    expect(r.out).not.toContain("<walkie-message");
    const log = await personCli(kira, ["orchestrator", "log"]);
    expect(log.code).toBe(0);
    expect(log.out).toContain("PERSON-HELLO");
    expect(log.out).toContain("pong: PERSON-HELLO");
    // the person stops and starts it
    expect((await personCli(kira, ["orchestrator", "stop"])).out).toContain("stopped");
    expect(await running()).toBe(false);
    expect((await personCli(kira, ["orchestrator", "start", "--cwd", c.root])).out).toContain("WalkieTalkie started");
    expect(await running()).toBe(true);
  }, 60_000);
});
