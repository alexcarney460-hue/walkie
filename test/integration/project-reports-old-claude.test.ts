// PROJECT-REPORTS-1 on a Claude too old to know the flags of a tool-less turn (the FAKE claude rejects `--tools` as an older
// one does: `error: unknown option '--tools='`, exit at once). Only the report turn can fail: it ends with a plain reason in
// the duty's run, WalkieTalkie stays up (no give-up) and answers a person's next message with the usual flags, later report
// turns fail without launching anything, and a restart of WalkieTalkie or a replaced `claude` lets the next one try again.
// The report turn is never run with the tools instead: its prompt reaches no Claude at all while the flags are rejected.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hostFor } from "../../src/daemon/orchestrator/host.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

const FAKE = join(import.meta.dir, "..", "fixtures", "fake-claude", "claude");
const REASON = "this Claude is too old for tool-less report turns; update Claude";
const NEVER = "0 3 1 * *"; // a duty that, in a test, only ever runs when told to (the first of the month at 03:00)

type Row = { pid: number; argv?: string[]; turn?: string };
let c: Cluster;
let alex: TestNode;
let log: string;
let wrapper: string;
const env: Record<string, string | undefined> = {};
let updates = 0;

const rows = (): Row[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row) : []);
const launches = (): Array<{ pid: number; argv: string[] }> => rows().filter((r): r is { pid: number; argv: string[] } => !!r.argv?.includes("-p"));
const toolless = () => launches().filter((l) => l.argv.includes("--tools="));
const launchFor = (text: string): string[] | null => {
  const turn = rows().find((r) => r.turn?.includes(text));
  return turn ? launches().find((l) => l.pid === turn.pid)?.argv ?? null : null;
};
const hasTools = (argv: string[]) => argv.includes("--allowedTools=mcp__walkie") && argv.some((a) => a.startsWith("--mcp-config=")) && !argv.some((a) => a.startsWith("--tools"));
const view = async () => (await alex.client("").orchestrator()).local;
const host = () => hostFor(alex.d.core)!;

/** `claude` on the host's PATH: a script over the fake; rewriting it is what an update of Claude looks like (a new size and time). */
function installClaude(): void {
  writeFileSync(wrapper, `#!/bin/sh\n# build ${++updates}\nexec '${process.execPath}' '${FAKE}' "$@"\n`);
  chmodSync(wrapper, 0o755);
}
/** The duty's run is read (its reply, its result) on the schedule tick, which this daemon (no auto loop) is given by hand. */
async function resultOf(id: string): Promise<{ last_result: string | null; failures: number }> {
  const schedules = host().schedules;
  await waitFor(async () => { await schedules.tick(); return schedules.get(id).last_result !== null; }, { what: "the run's result", timeoutMs: 30_000 });
  const { last_result, failures } = schedules.get(id);
  return { last_result, failures };
}
async function reportRun(name: string): Promise<{ last_result: string | null; failures: number }> {
  const { schedule } = await alex.client("").scheduleAdd({ name, cron: NEVER, task: { template: "project-reports" } });
  await alex.client("").scheduleRunNow(schedule.id);
  return resultOf(schedule.id);
}
async function answered(text: string): Promise<string> {
  const said = host().say(text, undefined, { via: "cli" });
  await waitFor(async () => (await alex.client("").orchestratorMessages({ limit: 500 })).messages.some((m) => m.role === "orchestrator" && m.reply_to === said.id), { what: `the answer to "${text}"`, timeoutMs: 30_000 });
  return (await alex.client("").orchestratorMessages({ limit: 500 })).messages.find((m) => m.reply_to === said.id)!.text;
}
const notGivenUp = async () => {
  const v = await view();
  expect([v.running, v.state === "failed", v.last_error ?? ""]).toEqual([true, false, expect.not.stringContaining("too old for WalkieTalkie")]);
  const saved = JSON.parse(readFileSync(join(alex.home, "orchestrator.json"), "utf8")) as { gave_up?: boolean };
  expect(saved.gave_up ?? false).toBe(false);
};

beforeAll(async () => {
  c = new Cluster();
  const root = mkdtempSync(join(tmpdir(), "reports-old-claude-"));
  const state = join(root, "fake-state");
  mkdirSync(state, { recursive: true });
  const bin = join(root, "bin");
  mkdirSync(bin);
  log = join(root, "fake-launches.jsonl");
  wrapper = join(bin, "claude");
  installClaude();
  Object.assign(env, process.env, {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_LOG: log, CLAUDE_CODE_OAUTH_TOKEN: "fake-test-token",
    FAKE_CLAUDE_REJECT: "--tools",
  });
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", orchestrator: {
    logins: async () => ({ found: ["claude" as const], claude: "env" as const }),
    autoCheckMs: 500, restartBaseMs: 50, restartMaxMs: 200, statusThrottleMs: 50, env,
  } });
  await alex.client().init("acme", "alex");
  const web = (await alex.client().createProject({ name: "Website relaunch" })).project;
  await alex.client().request("POST", `/v1/projects/${web.channel}`, { status_report: "hourly" });
  await alex.client().createTask({ project: web.channel, title: "Pricing page" });
  await alex.client("").orchestratorStart({});
  await waitFor(async () => (await view()).state === "idle", { what: "WalkieTalkie idle", timeoutMs: 20_000 });
  await waitFor(async () => launches().length >= 1, { what: "the Claude that started with WalkieTalkie", timeoutMs: 20_000 });
}, 90_000);

afterAll(async () => { await c.close(); });

test("a Claude that rejects --tools fails only the report turn, in plain words; WalkieTalkie stays up and answers the next message with the tools", async () => {
  const ran = await reportRun("Reports 1");
  expect(ran).toEqual({ last_result: REASON, failures: 1 });
  // The tool-less Claude was launched once and left at once; the report prompt reached no Claude at all (never run with the tools).
  expect(toolless()).toHaveLength(1);
  expect(rows().filter((r) => r.turn?.includes("Website relaunch"))).toEqual([]);
  // The reason is also in the conversation of the failed turn, and the Claude session that never started is not kept for it.
  const messages = (await alex.client("").orchestratorMessages({ limit: 500 })).messages;
  const reply = messages.find((m) => m.role === "orchestrator" && m.text === REASON);
  expect(reply).toBeDefined();
  const sessions = (JSON.parse(readFileSync(join(alex.home, "orchestrator.json"), "utf8")) as { sessions: Record<string, string> }).sessions;
  expect(Object.keys(sessions)).not.toContain(reply!.thread);
  // No give-up: the orchestrator is up, and the next message is answered by a Claude launched with the usual flags.
  await waitFor(async () => (await view()).state === "idle", { what: "idle again", timeoutMs: 20_000 });
  await notGivenUp();
  expect(await answered("Hello after the failure")).toContain("pong: Hello after the failure");
  expect(hasTools(launchFor("Hello after the failure") as string[])).toBe(true);
  await notGivenUp();
}, 120_000);

test("later report turns fail at once, without launching anything, in the same words; a normal turn in between is still answered", async () => {
  const before = launches().length;
  const again = await reportRun("Reports 2");
  expect(again).toEqual({ last_result: REASON, failures: 1 });
  expect(launches()).toHaveLength(before);
  expect(rows().filter((r) => r.turn?.includes("Website relaunch"))).toEqual([]);
  // A normal turn in between is still answered.
  expect(await answered("Still there?")).toContain("pong: Still there?");
  expect(hasTools(launchFor("Still there?") as string[])).toBe(true);
  await notGivenUp();
}, 120_000);

test("a restart of WalkieTalkie lets the next report turn try again (and it is remembered again when it fails again)", async () => {
  await alex.client("").orchestratorStop();
  await waitFor(async () => !(await view()).running, { what: "stopped", timeoutMs: 20_000 });
  await alex.client("").orchestratorStart({});
  await waitFor(async () => (await view()).state === "idle", { what: "idle after the restart", timeoutMs: 30_000 });
  const tried = toolless().length;
  const ran = await reportRun("Reports 3");
  expect(ran).toEqual({ last_result: REASON, failures: 1 });
  expect(toolless()).toHaveLength(tried + 1); // it was launched this time (and rejected)
  const after = launches().length;
  expect((await reportRun("Reports 4")).last_result).toBe(REASON);
  expect(launches()).toHaveLength(after); // and remembered again: no launch
  await waitFor(async () => (await view()).state === "idle", { what: "idle again", timeoutMs: 20_000 });
  await notGivenUp();
}, 180_000);

test("two tool-less turns waiting when the rejection arrives both end plainly (the one in flight and the one queued behind it); neither reaches a Claude", async () => {
  await alex.client("").orchestratorStop();
  await waitFor(async () => !(await view()).running, { what: "stopped", timeoutMs: 20_000 });
  await alex.client("").orchestratorStart({});
  await waitFor(async () => (await view()).state === "idle", { what: "idle after the restart", timeoutMs: 30_000 });
  const tried = toolless().length;
  const first = host().say("Report batch A", undefined, { via: "cli" }, { tools: "none" });
  const second = host().say("Report batch B", undefined, { via: "cli" }, { tools: "none" }); // queued behind the first
  const reasonFor = async (id: string) => (await alex.client("").orchestratorMessages({ limit: 500 })).messages.find((m) => m.reply_to === id)?.text;
  await waitFor(async () => (await reasonFor(first.id)) === REASON && (await reasonFor(second.id)) === REASON, { what: "both turns ended", timeoutMs: 30_000 });
  expect(toolless()).toHaveLength(tried + 1); // one launch served the finding; the queued one never got a Claude of its own
  expect(rows().filter((r) => r.turn?.includes("Report batch"))).toEqual([]);
  const states = (await alex.client("").orchestratorMessages({ limit: 500 })).messages.filter((m) => m.role === "person" && m.text.startsWith("Report batch"));
  expect(states.map((m) => [m.text, m.state]).sort()).toEqual([["Report batch A", "sent"], ["Report batch B", "dropped"]]);
  await waitFor(async () => (await view()).state === "idle", { what: "idle again", timeoutMs: 20_000 });
  expect(await answered("Up and answering")).toContain("pong: Up and answering");
  await notGivenUp();
}, 180_000);

test("a Claude launched while a tool-less turn waits for a Claude known not to run one is the usual one", async () => {
  const internals = host() as unknown as { queue: unknown[]; spawn(session: string, resume: boolean): void; toollessRejected: { binary: string | null } | null };
  expect(internals.toollessRejected).not.toBeNull(); // set by the test before
  const before = launches().length;
  internals.queue.push({ id: "om_guard", text: "Guard check", thread: "om_guard", ts: Date.now(), origin: { via: "cli" }, tools: "none" });
  internals.spawn("00000000-0000-4000-8000-000000000001", false);
  await waitFor(async () => launches().length > before, { what: "the Claude", timeoutMs: 20_000 });
  expect(hasTools(launches().at(-1)!.argv)).toBe(true); // not a tool-less one: it would be rejected again for nothing
  internals.queue.pop();
  await notGivenUp();
}, 60_000);

test("a rejection is not a failure that counts towards giving up: with the rapid-failure count at its limit, WalkieTalkie still stays up and the count is untouched", async () => {
  await alex.client("").orchestratorStop();
  await waitFor(async () => !(await view()).running, { what: "stopped", timeoutMs: 20_000 });
  await alex.client("").orchestratorStart({});
  await waitFor(async () => (await view()).state === "idle", { what: "idle after the restart", timeoutMs: 30_000 });
  const internals = host() as unknown as { attempt: number };
  internals.attempt = 4; // one more counted failure and WalkieTalkie would give up (MAX_RAPID_FAILURES is 5)
  const ran = await reportRun("Reports at the limit");
  expect(ran.last_result).toBe(REASON);
  await waitFor(async () => (await view()).state === "idle", { what: "idle again", timeoutMs: 20_000 });
  await notGivenUp();
  expect(internals.attempt).toBe(4);
  internals.attempt = 0;
}, 120_000);

test("a replaced claude (an update) lets the next report turn try again, and this time it runs without tools", async () => {
  delete env.FAKE_CLAUDE_REJECT; // the new Claude knows the flags
  installClaude(); // and is a different file
  const tried = toolless().length;
  const ran = await reportRun("Reports 5");
  // The fake's reply has no report block, so the finish step records it as a run with no usable report: it ran, with no tools.
  expect(ran.last_result).toContain("no usable report");
  expect(toolless()).toHaveLength(tried + 1);
  const latest = toolless().at(-1)!.argv;
  expect(latest).toContain("--strict-mcp-config");
  expect(latest.some((a) => a.startsWith("--mcp-config"))).toBe(false);
  expect(rows().filter((r) => r.turn?.includes("Website relaunch"))).toHaveLength(1);
  await notGivenUp();
}, 120_000);
