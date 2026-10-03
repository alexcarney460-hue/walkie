// WALK-97: in full access (WalkieTalkie's own shell user, bypass permissions) a conversation that WalkieTalkie has no Claude
// for yet gets a fresh Claude, as in the other modes, and a conversation it has one for is resumed. A change of conversation
// goes through a restart in this mode (the login and the shell user are prepared again first); that restart resumed the
// session of the conversation that was running, which is never the one wanted, so a second NEW conversation (a person's, or
// a scheduled duty's run) was answered by nothing and looped through restarts until WalkieTalkie gave up ("WalkieTalkie keeps
// failing: Claude exited without a diagnostic"). The same loop stopped a switch between two conversations that both exist.
// Real in-process daemon, the repo's fake shell user and the FAKE claude: no model, no real uid.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostFor } from "../../src/daemon/orchestrator/host.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

const WT = join(import.meta.dir, "..", "..");
const FAKE_DIR = join(WT, "test", "fixtures", "fake-claude");
const NEVER = "0 3 1 * *"; // a duty that, in a test, only ever runs when told to (the first of the month at 03:00)

type Row = { pid: number; argv?: string[]; turn?: string };
let c: Cluster;
let alex: TestNode;
let log = "";

const rows = (): Row[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row) : []);
const launches = (): Array<{ pid: number; argv: string[] }> => rows().filter((r): r is { pid: number; argv: string[] } => !!r.argv?.includes("-p"));
/** The Claude that took a message, by its argv. */
const launchFor = (text: string): string[] => {
  const turn = rows().find((r) => r.turn?.includes(text));
  const launch = turn ? launches().find((l) => l.pid === turn.pid) : undefined;
  if (!launch) throw new Error(`no Claude took a message containing "${text}"`);
  return launch.argv;
};
/** What a launch is for: a fresh session, or the one of a conversation it resumes. */
const sessionOf = (argv: string[]): { resumed: boolean; id: string } => {
  const resume = argv.indexOf("--resume");
  const fresh = argv.indexOf("--session-id");
  return resume >= 0 ? { resumed: true, id: argv[resume + 1] as string } : { resumed: false, id: argv[fresh + 1] as string };
};
const hasTools = (argv: string[]) => argv.includes("--allowedTools=mcp__walkie") && !argv.some((a) => a.startsWith("--tools"));
const view = async () => (await alex.client("").orchestrator()).local;
const host = () => hostFor(alex.d.core)!;
const savedGaveUp = () => (JSON.parse(readFileSync(join(alex.home, "orchestrator.json"), "utf8")) as { gave_up?: boolean }).gave_up ?? false;
const replyTo = async (id: string): Promise<string | null> =>
  (await alex.client("").orchestratorMessages({ limit: 500 })).messages.find((m) => m.role === "orchestrator" && m.reply_to === id)?.text ?? null;

/** A person's message (a new conversation, or a follow-up in `thread`) and the answer, or none when WalkieTalkie gave up first. */
async function say(text: string, thread?: string): Promise<{ thread: string; reply: string | null }> {
  const said = host().say(text, thread, { via: "cli" });
  await waitFor(async () => (await replyTo(said.id)) !== null || (await view()).state === "failed", { what: `the answer to "${text}" (or a give-up)`, timeoutMs: 30_000, intervalMs: 50 });
  return { thread: said.thread, reply: await replyTo(said.id) };
}
/** One run of a duty of the given task, started by hand: its recorded result, or null when WalkieTalkie gave up first. */
async function dutyRun(name: string, task: { prompt: string } | { template: "project-reports" }): Promise<{ last_result: string | null; failures: number }> {
  const { schedule } = await alex.client("").scheduleAdd({ name, cron: NEVER, task });
  await alex.client("").scheduleRunNow(schedule.id);
  const schedules = host().schedules;
  await waitFor(async () => { await schedules.tick(); return schedules.get(schedule.id).last_result !== null || (await view()).state === "failed"; }, { what: `the result of "${name}"`, timeoutMs: 30_000, intervalMs: 50 });
  const { last_result, failures } = schedules.get(schedule.id);
  return { last_result, failures };
}
async function notGivenUp(): Promise<void> {
  const v = await view();
  expect([v.running, v.state === "failed", savedGaveUp(), v.last_error ?? ""]).toEqual([true, false, false, expect.not.stringContaining("keeps failing")]);
}

beforeAll(async () => {
  c = new Cluster();
  const state = join(c.root, "fake-state");
  mkdirSync(state, { recursive: true });
  log = join(c.root, "fake-launches.jsonl");
  const talkieHome = join(c.root, "walkie-talkie");
  mkdirSync(talkieHome);
  const cfgDir = join(c.root, "claude-cfg");
  mkdirSync(cfgDir);
  writeFileSync(join(cfgDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fake-access", refreshToken: "fake-refresh", expiresAt: Date.now() + 3_600_000 } }));
  const runner = join(c.root, "talkie-runner");
  writeFileSync(runner, `#!/bin/sh\nexec '${process.execPath}' '${join(WT, "src/cli/main.ts")}' "$@"\n`);
  chmodSync(runner, 0o755);
  const runtime = join(c.root, "claude-runtime");
  writeFileSync(runtime, `#!/bin/sh\nexec '${process.execPath}' '${join(FAKE_DIR, "claude")}' "$@"\n`);
  chmodSync(runtime, 0o755);
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${FAKE_DIR}:${dirname(process.execPath)}:/usr/bin:/bin`, FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_LOG: log, CLAUDE_CONFIG_DIR: cfgDir };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", orchestrator: {
    autoCheckMs: 500, restartBaseMs: 50, restartMaxMs: 200, statusThrottleMs: 50, shellTokenMarginMs: 60_000, env,
    shellUser: { ready: () => true, existing: () => false, privateHome: () => null, socketRoot: c.root, runner, runtime,
      testEnv: { FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_LOG: log },
      admin: async () => ({ ok: true, name: "walkie-talkie", uid: 550_000, home: talkieHome }),
      userSwitch: () => [process.execPath, join(WT, "test/fixtures/fake-talkie-runner.ts")] } } });
  await alex.client().init("acme", "alex");
  const web = (await alex.client().createProject({ name: "Website relaunch" })).project;
  await alex.client().request("POST", `/v1/projects/${web.channel}`, { status_report: "hourly" });
  await alex.client().createTask({ project: web.channel, title: "Pricing page" });
  await alex.client("").orchestratorStart({ access: "full" });
  await waitFor(async () => (await view()).state === "idle" && launches().length >= 1, { what: "idle with a launched Claude (full access)", timeoutMs: 60_000 });
}, 120_000);
afterAll(async () => { await c.close(); });

let alpha: { thread: string; session: string };
let beta: { thread: string; session: string };

test("a Claude that dies before it has taken any message is replaced by a fresh session, not by a resume of one that never existed", async () => {
  const boot = launches();
  expect(boot).toHaveLength(1);
  process.kill((boot[0] as { pid: number }).pid, "SIGKILL");
  await waitFor(async () => launches().length >= 2 && (await view()).state === "idle", { what: "the replacement Claude", timeoutMs: 30_000, intervalMs: 50 });
  expect(launches().filter((l) => l.argv.includes("--resume"))).toEqual([]);
  expect(sessionOf((launches()[1] as { argv: string[] }).argv).id).not.toBe(sessionOf((boot[0] as { argv: string[] }).argv).id);
  await notGivenUp();
}, 60_000);

test("the first conversation is answered by the Claude that is waiting", async () => {
  const first = await say("alpha first");
  expect(first.reply).toBe("pong: alpha first");
  alpha = { thread: first.thread, session: sessionOf(launchFor("alpha first")).id };
  expect(sessionOf(launchFor("alpha first")).resumed).toBe(false);
  await notGivenUp();
}, 60_000);

test("a second, new conversation gets a fresh Claude, not the first one's session, and WalkieTalkie does not give up", async () => {
  const second = await say("beta first");
  expect(second.reply).toBe("pong: beta first");
  const launch = sessionOf(launchFor("beta first"));
  expect(launch.resumed).toBe(false);
  expect(launch.id).not.toBe(alpha.session);
  beta = { thread: second.thread, session: launch.id };
  expect(hasTools(launchFor("beta first"))).toBe(true);
  await notGivenUp();
}, 60_000);

test("a follow-up in the first conversation resumes its own session, with its history; so does one in the second after it", async () => {
  const again = await say("alpha history", alpha.thread);
  expect(again.reply).toBe("turns=2 first=alpha first");
  expect(sessionOf(launchFor("alpha history"))).toEqual({ resumed: true, id: alpha.session });
  const back = await say("beta history", beta.thread);
  expect(back.reply).toBe("turns=2 first=beta first");
  expect(sessionOf(launchFor("beta history"))).toEqual({ resumed: true, id: beta.session });
  await notGivenUp();
}, 90_000);

test("a third new conversation, and a follow-up in the same one right after it (no restart between), are answered", async () => {
  const third = await say("gamma first");
  expect(third.reply).toBe("pong: gamma first");
  expect(sessionOf(launchFor("gamma first")).resumed).toBe(false);
  const launchesBefore = launches().length;
  const next = await say("gamma history", third.thread);
  expect(next.reply).toBe("turns=2 first=gamma first");
  expect(launches()).toHaveLength(launchesBefore); // the Claude that has the conversation answers it: nothing is launched for it
  await notGivenUp();
}, 60_000);

test("messages for two conversations that wait together are answered in order, each by a Claude with its own session", async () => {
  const first = host().say("alpha queued", alpha.thread, { via: "cli" });
  const second = host().say("beta queued", beta.thread, { via: "cli" });
  await waitFor(async () => (await replyTo(first.id)) !== null && (await replyTo(second.id)) !== null || (await view()).state === "failed", { what: "both answers (or a give-up)", timeoutMs: 30_000, intervalMs: 50 });
  expect([await replyTo(first.id), await replyTo(second.id)]).toEqual(["pong: alpha queued", "pong: beta queued"]);
  expect(sessionOf(launchFor("alpha queued"))).toEqual({ resumed: true, id: alpha.session });
  expect(sessionOf(launchFor("beta queued"))).toEqual({ resumed: true, id: beta.session });
  await notGivenUp();
}, 60_000);

test("two duty runs in a row each get a fresh Claude, and a person's message after them is answered by yet another", async () => {
  const one = await dutyRun("Check one", { prompt: "Scheduled check number one" });
  expect(one.last_result).toContain("pong:");
  expect(one.failures).toBe(0);
  const two = await dutyRun("Check two", { prompt: "Scheduled check number two" });
  expect(two.last_result).toContain("pong:");
  expect(two.failures).toBe(0);
  const first = sessionOf(launchFor("check number one"));
  const second = sessionOf(launchFor("check number two"));
  expect([first.resumed, second.resumed]).toEqual([false, false]);
  expect(second.id).not.toBe(first.id);
  const person = await say("delta first");
  expect(person.reply).toBe("pong: delta first");
  expect(sessionOf(launchFor("delta first")).resumed).toBe(false);
  await notGivenUp();
}, 120_000);

test("status report runs (no tools at all) in a row, and a person's message between them, each get a fresh Claude with the right flags", async () => {
  const one = await dutyRun("Reports 1", { template: "project-reports" });
  expect(one.last_result).toContain("Reported 0 of 1 changed project"); // the fake Claude writes no report: what matters here is how it was launched
  const reportLaunches = () => launches().filter((l) => l.argv.includes("--tools="));
  expect(reportLaunches()).toHaveLength(1);
  const person = await say("epsilon first");
  expect(person.reply).toBe("pong: epsilon first");
  const personLaunch = launchFor("epsilon first");
  expect(hasTools(personLaunch)).toBe(true); // the tools Claude, not the report's
  expect(sessionOf(personLaunch).resumed).toBe(false);
  const two = await dutyRun("Reports 2", { template: "project-reports" });
  expect(two.last_result).toContain("Reported 0 of 1 changed project");
  expect(reportLaunches()).toHaveLength(2);
  expect(sessionOf(reportLaunches()[1]!.argv)).toMatchObject({ resumed: false });
  expect(sessionOf(reportLaunches()[1]!.argv).id).not.toBe(sessionOf(reportLaunches()[0]!.argv).id);
  await notGivenUp();
  expect((await say("zeta first")).reply).toBe("pong: zeta first");
}, 180_000);

test("an idle crash with no queued message resumes the completed conversation and preserves its history", async () => {
  const first = await say("idle-recovery first");
  expect(first.reply).toBe("pong: idle-recovery first");
  const before = launches();
  const session = sessionOf(launchFor("idle-recovery first")).id;
  process.kill(before.at(-1)!.pid, "SIGKILL");
  await waitFor(async () => launches().length > before.length && (await view()).state === "idle", {
    what: "the completed conversation resumed after an idle crash", timeoutMs: 30_000, intervalMs: 50,
  });
  expect(sessionOf(launches().at(-1)!.argv)).toEqual({ resumed: true, id: session });
  expect((await say("idle-recovery history", first.thread)).reply).toBe("turns=2 first=idle-recovery first");
  expect(launches()).toHaveLength(before.length + 1);
  await notGivenUp();
}, 60_000);
