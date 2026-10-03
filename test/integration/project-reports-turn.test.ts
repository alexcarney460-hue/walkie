// PROJECT-REPORTS-1 through a real daemon and the FAKE claude (every launch is logged with its argv): the status reports
// duty's model turn needs no tool, so its Claude is launched with none (no built-in tool, no MCP server, nothing allowed,
// permissions never bypassed), while a person's message and every other duty still get the Walkie tools. The fake claude
// is the child's stand-in only; no model is called.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hostFor } from "../../src/daemon/orchestrator/host.ts";
import type { ProjectView } from "../../src/protocol/projects/schema.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

const FAKE_DIR = join(import.meta.dir, "..", "fixtures", "fake-claude");

type Row = { pid: number; argv?: string[]; turn?: string };
let c: Cluster;
let alex: TestNode;
let log: string;
let web: ProjectView;

const rows = (): Row[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row) : []);
const launches = (): Required<Pick<Row, "pid" | "argv">>[] => rows().filter((r): r is Required<Pick<Row, "pid" | "argv">> => !!r.argv?.includes("-p"));
/** The launch of the child that was given a turn containing `text`. */
function launchRow(text: string): { pid: number; argv: string[] } | null {
  const turn = rows().find((r) => r.turn?.includes(text));
  return turn ? launches().find((l) => l.pid === turn.pid) ?? null : null;
}
const launchFor = (text: string): string[] | null => launchRow(text)?.argv ?? null;
const valueOf = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];
/** The duty's run is read (its reply, its result) on the schedule tick, which this daemon (no auto loop) is given by hand. */
async function resultOf(id: string): Promise<{ last_result: string | null; failures: number }> {
  const schedules = hostFor(alex.d.core)!.schedules;
  await waitFor(async () => { await schedules.tick(); return schedules.get(id).last_result !== null; }, { what: "the run's result", timeoutMs: 30_000 });
  const { last_result, failures } = schedules.get(id);
  return { last_result, failures };
}
const NEVER = "0 3 1 * *"; // a duty that, in a test, only ever runs when told to (the first of the month at 03:00)
const hasTools = (argv: string[]) => argv.includes("--allowedTools=mcp__walkie") && argv.some((a) => a.startsWith("--mcp-config=")) && !argv.some((a) => a.startsWith("--tools"));

beforeAll(async () => {
  c = new Cluster();
  const root = mkdtempSync(join(tmpdir(), "reports-turn-"));
  const state = join(root, "fake-state");
  mkdirSync(state, { recursive: true });
  log = join(root, "fake-launches.jsonl");
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", orchestrator: {
    // A Claude login without looking for one: the real check asks this machine's Keychain (tests never touch it).
    logins: async () => ({ found: ["claude" as const], claude: "env" as const }),
    autoCheckMs: 500, restartBaseMs: 50, restartMaxMs: 200, statusThrottleMs: 50,
    env: { ...process.env, PATH: `${FAKE_DIR}:${dirname(process.execPath)}:/usr/bin:/bin`, FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_LOG: log, CLAUDE_CODE_OAUTH_TOKEN: "fake-test-token" },
  } });
  await alex.client().init("acme", "alex");
  web = (await alex.client().createProject({ name: "Website relaunch" })).project;
  await alex.client().request("POST", `/v1/projects/${web.channel}`, { status_report: "hourly" });
  await alex.client().createTask({ project: web.channel, title: "Pricing page" });
  await alex.client("").orchestratorStart({});
  await waitFor(async () => (await alex.client("").orchestrator()).local.state === "idle", { what: "WalkieTalkie idle", timeoutMs: 20_000 });
}, 90_000);

afterAll(async () => { await c.close(); });

test("the status reports turn is launched with no tools at all, even when a Claude with the tools is waiting unused; a person's message and another duty get the Walkie tools", async () => {
  // Only the Claude that started with WalkieTalkie exists, and no turn has used it: it is "fresh", the one a new
  // conversation would normally reuse. The duty's turn must not run in it, because it has the tools.
  await waitFor(async () => launches().length >= 1, { what: "the Claude that started with WalkieTalkie", timeoutMs: 20_000 });
  expect(launches()).toHaveLength(1);
  expect(rows().filter((r) => r.turn)).toEqual([]);
  expect(hasTools(launches()[0]!.argv)).toBe(true);

  const { schedule } = await alex.client("").scheduleAdd({ name: "Reports under test", cron: NEVER, task: { template: "project-reports" } });
  await alex.client("").scheduleRunNow(schedule.id);
  await waitFor(async () => launchFor("Website relaunch") !== null, { what: "the duty's turn", timeoutMs: 30_000 });
  const none = launchFor("Website relaunch") as string[];
  expect(none).toContain("--tools=");
  expect(none).toContain("--strict-mcp-config");
  expect(none.some((a) => a.startsWith("--mcp-config"))).toBe(false);
  expect(none.some((a) => a.startsWith("--allowedTools"))).toBe(false);
  expect(valueOf(none, "--permission-mode")).toBe("default");
  expect(valueOf(none, "--setting-sources")).toBe("");
  expect(launchRow("Website relaunch")!.pid).not.toBe(launches()[0]!.pid);

  // The run read its reply (the fake claude's has no report block), so the finish step ran.
  const ran = await resultOf(schedule.id);
  expect(ran.last_result).toContain("no usable report");
  expect(ran.failures).toBe(1);

  // A person's message afterwards is answered by a Claude with the Walkie tools again, and so is another duty.
  hostFor(alex.d.core)!.say("Hello from a person", undefined, { via: "cli" });
  await waitFor(async () => launchFor("Hello from a person") !== null, { what: "the person's turn", timeoutMs: 20_000 });
  expect(hasTools(launchFor("Hello from a person") as string[])).toBe(true);
  expect(launchRow("Hello from a person")!.pid).not.toBe(launchRow("Website relaunch")!.pid);
  const other = await alex.client("").scheduleAdd({ name: "Say hi", cron: NEVER, task: { prompt: "Greet the team once." } });
  await alex.client("").scheduleRunNow(other.schedule.id);
  await waitFor(async () => launchFor("Greet the team once.") !== null, { what: "the other duty's turn", timeoutMs: 30_000 });
  expect(hasTools(launchFor("Greet the team once.") as string[])).toBe(true);
}, 120_000);
