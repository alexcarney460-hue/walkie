// The seats CLI (`bun src/cli/main.ts …`) against two in-process daemons with a FAKE codex/claude on the host:
// `walkie join … --allow-seats` (the person's, or an agent's while agent admin is on), `walkie seat run --wait`, and an
// agent's run refused by the host.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { runAsPerson } from "../helpers/person-cli.ts";
import { signInCodex } from "../helpers/fake-seat-users.ts";
import { noKeychainSeats } from "../helpers/no-keychain.ts";

const CLI = join(import.meta.dir, "../../src/cli/main.ts");
const FIXTURES = join(import.meta.dir, "..", "fixtures");
let c: Cluster;
let alex: TestNode;
let arvid: TestNode;

beforeAll(async () => {
  c = new Cluster();
  const home = join(c.root, "arvid-home");
  mkdirSync(home, { recursive: true });
  signInCodex(home);
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  arvid = await c.add({
    name: "arvid", login: "arvid@example.com", hostname: "arvid-mac",
    seats: { flushMs: 100, env: { PATH: `${join(FIXTURES, "fake-claude")}:${join(FIXTURES, "fake-codex")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, FAKE_CLAUDE_STATE: join(c.root, "fake-state") } },
  });
  await alex.client().init("aka", "alex");
  await alex.client().invite("arvid@example.com", "arvid", "member");
}, 60_000);
afterAll(async () => { await c.close(); });

/** A person's terminal: no agent session marker unless `env` adds one. */
async function walkie(node: TestNode, args: string[], env: Record<string, string> = {}) {
  // As a person would (test/helpers/person-cli.ts): detached from this test's own process ancestry, which may include
  // an agent runtime that agent-detect.ts would rightly count.
  return runAsPerson([process.execPath, CLI, ...args], { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: node.home, WALKIE_SOCKET: node.socket, ...env });
}

describe("walkie seats CLI", () => {
  test("join --allow-seats under an agent is refused before joining while agent admin is off; a person's explicit flag opts in", async () => {
    await arvid.client().adminSwitches({ agent_admin: false });
    const agent = await walkie(arvid, ["join", alex.peerAddr, "--allow-seats"], { CLAUDECODE: "1" });
    expect(agent.code).toBe(1);
    expect(agent.err).toContain("agent_admin_off");
    expect((await arvid.client().me()).team).toBeFalsy();
    await arvid.client().adminSwitches({ agent_admin: true });
    const r = await walkie(arvid, ["join", alex.peerAddr, "--allow-seats"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("joined aka as @arvid");
    expect(r.out).toContain("seats allowed");
    expect(r.out).toContain("Seats run as YOUR OS user: a seat can reach your Walkie");
    expect(r.out).toContain("Private worker directories organize each run");
    const cfg = JSON.parse(readFileSync(join(arvid.home, "config.json"), "utf8")) as { seats?: { allow?: boolean; mode?: string } };
    expect(cfg.seats).toMatchObject({ allow: true, mode: "same_user" });
    await waitFor(async () => (await alex.client().seats()).hosts.find((h) => h.hostname === "arvid-mac" && h.allows && h.member), { what: "alex sees arvid-mac" });
  }, 60_000);

  test("join --allow-seats under an agent with agent admin on joins and turns seats on, audited as the agent", async () => {
    const kira = await c.add({ name: "kira", login: "kira@example.com", hostname: "kira-mac", seats: noKeychainSeats(join(c.root, "kira-home")) });
    await alex.client().invite("kira@example.com", "kira", "member");
    const r = await walkie(kira, ["join", alex.peerAddr, "--allow-seats"], { CLAUDECODE: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("joined aka as @kira");
    expect((await kira.client().seats()).local).toMatchObject({ allow: true, same_user: true });
    expect(readFileSync(join(kira.home, "admin-audit.jsonl"), "utf8")).toMatch(/"actor":"@kira\/kira-mac\/claude-code \(unnamed\)","action":"allowed seats on this machine/);
  }, 60_000);

  test("seats setup-user prints its plan (for an agent too, AGENT-ADMIN-1); allow says who seats run as", async () => {
    const agent = await walkie(arvid, ["seats", "setup-user"], { CLAUDECODE: "1" });
    expect([agent.code, agent.out.includes("Every seat as a fresh OS user")]).toEqual([0, true]);
    const plan = await walkie(arvid, ["seats", "setup-user"]);
    expect(plan.code).toBe(0);
    expect(plan.out).toContain("Every seat as a fresh OS user of its own, made for it and destroyed after it (never reused)");
    expect(plan.out).toContain("ALL=(%walkie-seats) NOPASSWD: /usr/local/libexec/walkie/walkie-seat-runner seat-runner");
    expect(plan.out).toContain("ALL=(root) NOPASSWD: /usr/local/libexec/walkie/walkie-seat-admin seat-admin create *, /usr/local/libexec/walkie/walkie-seat-admin seat-admin destroy *");
    // Applied only from a closed home (or when accepted); either way the plan says how.
    expect(`${plan.out}${plan.err}`).toMatch(/walkie seats setup-user --apply|not applied: your home/);
    const list = await walkie(arvid, ["seats"]);
    expect(list.out).toContain("seats allowed as your own user");
    expect(list.out).toContain("launchers the team's owners and their agents (person entries cover their agents)");
  });

  test("an explicit empty launcher policy displays nobody", async () => {
    const { local } = await arvid.client().seatsConfig({ allow: true, same_user: true, launchers: [] });
    expect(local.launcher_policy_empty).toBe(true);
    const list = await walkie(arvid, ["seats"]);
    expect(list.out).toContain("launchers nobody (person entries cover their agents)");
    await arvid.client().seatsConfig({ allow: true, launchers: null });
  });

  test("seats allow/deny under an agent: refused while its person has agent admin off", async () => {
    await arvid.client().adminSwitches({ agent_admin: false });
    const r = await walkie(arvid, ["seats", "deny"], { CODEX_THREAD_ID: "t-1" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("agent_admin_off");
    expect((await arvid.client().seats()).local.allow).toBe(true);
    await arvid.client().adminSwitches({ agent_admin: true });
  });

  test("seat run --wait prints the output and ends with the state; an agent's run is refused by the host", async () => {
    const r = await walkie(alex, ["seat", "run", "--machine", "arvid-mac", "--runtime", "codex", "--wait", "--", "hello", "codex"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("codex: hello codex");
    expect(r.out.trim().split("\n").pop()).toMatch(/^done/);
    // The default mode (acceptEdits) can't run shell commands in a seat: said up front, with the exact fix.
    expect(r.err).toContain("acceptEdits can't run shell commands in a seat");
    expect(r.err).toContain("--permission-mode bypassPermissions");
    const agent = await walkie(alex, ["seat", "run", "--machine", "arvid-mac", "--wait", "--", "from", "an", "agent"], { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "abc-123" });
    expect(agent.code).toBe(1);
    // Marked as an agent's (agent-detect.ts) but unnamed: refused before any request is made; named, the host judges.
    // The exact fix, not just that it's required (Alex: the whole seat-run failure surface should say this).
    expect(agent.out + agent.err).toContain("a seat request from an agent must name it: set WALKIE_AGENT=‹name› in this agent's environment, or add --agent ‹name› to this walkie seat run command");
    const list = await walkie(alex, ["seats"]);
    expect(list.out).toContain("arvid-mac (@arvid) · seats allowed · online · you can launch");
  }, 60_000);
});
