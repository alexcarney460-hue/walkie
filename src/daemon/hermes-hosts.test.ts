// Round 11: the Hermes processes that host hooked agent turns without being a session. Hermes' own list of the commands that can run an
// agent turn (hermes_cli/main.py `_AGENT_COMMANDS` and `_AGENT_SUBCOMMANDS`) names `cron run`, `cron tick`, `gateway run` and `mcp serve`;
// its source (hermes-agent 0.21.3, read 2026-10-01) says which of them, and of the servers it does not list, really run one:
//  - `cron run` runs the job in the CLI process itself and `cron tick` the due jobs (cron/scheduler.py `run_one_job`: an AIAgent turn,
//    unless the job is a `no_agent` script); jobs are per profile (cron/jobs.py), so a process that names a profile serves that one;
//  - `dashboard` and `serve` run every session in-process (hermes_cli/main.py `_dashboard_prepare_runtime`; tui_gateway/server.py
//    `_make_agent` registers the shell hooks) and scope each session to the profile its client names, and a named-profile launch is
//    re-exec'd as `-p default ... --open-profile <name>` (hermes_cli/main_dashboard.py): no argv says which profiles a backend serves;
//  - `desktop` and `gui` only build and launch the Electron app (hermes_cli/main_desktop.py `cmd_gui`), which starts its own
//    `hermes serve` (apps/desktop/electron/backend-command.ts): the backend is the evidence, never the launcher;
//  - `mcp serve` is a stdio bridge to messaging conversations (mcp_serve.py): it creates no AIAgent.
// A running host is liveness evidence for the rows its profile hooks (gateway-style, under the same ten-minute TTL), and never a card.
import { expect, test } from "bun:test";
import { classifyAgent, hermesProcessOf } from "./agent-procs.ts";
import { ME, status, world } from "../../test/helpers/discovery-world.ts";
import { hermesEvent, hermesHook, launchd, rowState, type World } from "../../test/helpers/hermes-world.ts";

const VENV = "/Users/example/.hermes/hermes-agent/venv/bin";
const PY = `${VENV}/python3`;
const HERMES = `${VENV}/hermes`;
/** The argv `ps` prints for the `hermes` CLI: the launcher, the installed console script, and `-m hermes_cli.main`. */
const LAUNCHERS = ["hermes", `${PY} ${HERMES}`, `${PY} -m hermes_cli.main`] as const;
const TTL = 10 * 60_000;

/** [arguments after the launcher, the profile they name]: invocations that host hooked turns and are no session. */
const HOSTS: ReadonlyArray<readonly [string, string | null]> = [
  ["cron tick", null], ["cron tick --accept-hooks", null], ["--accept-hooks cron tick", null], ["-m some-model cron tick", null],
  ["cron run nightly-report", null], ["cron run nightly-report --accept-hooks", null], ["cron run tick", null], // a job may be named tick
  ["-p work cron tick", "work"], ["cron tick -p work", "work"], ["--profile=work cron run nightly-report", "work"],
  ["cron -p work run nightly-report", "work"],
  // a server serves any profile's sessions, so it names none whatever its argv says
  ["dashboard", null], ["dashboard --no-open", null], ["dashboard --port 9119 --host 127.0.0.1", null], ["dashboard --isolated", null],
  ["serve", null], ["serve --host 127.0.0.1 --port 0", null],
  ["--profile work serve --host 127.0.0.1 --port 0", null], // the desktop app's backend for one profile
  ["-p default dashboard --port 9119 --host 127.0.0.1 --open-profile work", null], // the machine dashboard a named-profile launch re-execs into
  ["serve --isolated --host 127.0.0.1 --port 0 --ssh-session-token-file /run/x/token --ssh-owner-nonce abc123", null],
  ["-p work serve --port 0 --no-open", null],
];

/** Invocations of the same subcommands that run no agent turn: they manage, ask a server to stop, print help, or launch the app. */
const NOT_HOSTS: readonly string[] = [
  "cron", "cron list", "cron list --all", "cron status", "cron create 0 9 * * * summarise the inbox", "cron edit abc --schedule 1h",
  "cron pause abc", "cron resume abc --run-now", "cron remove abc", "cron rm abc", "cron resnap --all", "cron runs", "cron history abc",
  "cron incidents ack i1", "cron notepad abc get k", "cron doctor", "cron --help", "cron run --help", "cron tick -h", "-p work cron tick --help",
  "cron edit tick --schedule 1h", "cron pause run", "cron remove tick", // the verb is the first word; a job may be named run or tick
  "dashboard --stop", "dashboard --status", "serve --stop", "serve --status", "dashboard register", "dashboard register --name x",
  "dashboard --port 9119 register", "serve register", "dashboard --help", "dashboard -h", "serve --help", "serve -h",
  "desktop", "gui", "desktop --build-only", "gui --source", "gui --skip-build --local", "desktop --setup-tcc-identity",
  "mcp serve", "mcp add x --args serve",
];

test("cron run, cron tick and the dashboard and serve backends are liveness evidence and no agent session, however they are launched", () => {
  for (const launcher of LAUNCHERS) {
    for (const [tail, profile] of HOSTS) {
      for (const tty of ["ttys001", null]) {
        const command = `${launcher} ${tail}`;
        expect([command, tty, classifyAgent(command, tty)]).toEqual([command, tty, null]);
        expect([command, tty, hermesProcessOf(command, tty)]).toEqual([command, tty, { profile, gateway: true }]);
      }
    }
  }
});

test("the same subcommands managing something, stopping a server, printing help or launching the app are neither evidence nor a session", () => {
  for (const launcher of LAUNCHERS) {
    for (const tail of NOT_HOSTS) {
      for (const tty of ["ttys001", null]) {
        const command = `${launcher} ${tail}`;
        expect([command, tty, classifyAgent(command, tty)]).toEqual([command, tty, null]);
        expect([command, tty, hermesProcessOf(command, tty)]).toEqual([command, tty, null]);
      }
    }
  }
});

test("a prompt that spells a host command is a session, never that host", () => {
  for (const command of ["hermes -z please run cron tick", "hermes -z restart the dashboard", "hermes -z serve the docs --port 80",
    "hermes chat -q start cron run nightly", "hermes -c fix the dashboard", `${PY} ${HERMES} -z cron tick`]) {
    expect([command, classifyAgent(command, "ttys001")?.runtime]).toEqual([command, "hermes"]);
    expect([command, hermesProcessOf(command, "ttys001")]).toEqual([command, { profile: null, gateway: false }]);
  }
});

// ---- the census and the cards ------------------------------------------------------------------------------------------
const hermesCards = (w: World) => w.core.store.db.query<{ agent: string }, []>(
  "SELECT DISTINCT author_agent AS agent FROM events WHERE kind = 'agent.status'").all().map((r) => r.agent).filter((a) => a.startsWith("hermes-")).sort();
const proc = (w: World, pid: number, command: string, tty: string | null = null) => ({ pid, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command, tty });
async function inWorld(run: (w: World) => Promise<void>) {
  const cleanups: Array<() => void> = [];
  try { await run(world(cleanups)); } finally { while (cleanups.length) cleanups.pop()?.(); }
}

for (const [label, command, profile] of [
  ["a cron tick that names no profile", "hermes cron tick", "default"],
  ["a cron tick through the console script, named", `${PY} ${HERMES} -p work cron tick --accept-hooks`, "work"],
  ["a cron run", `${PY} -m hermes_cli.main --profile=work cron run nightly-report`, "work"],
  ["a bare dashboard", `${PY} ${HERMES} dashboard`, "default"],
  ["a dashboard on a port", "hermes dashboard --no-open --port 9119", "work"],
  ["the desktop app's backend for one profile", `${PY} -m hermes_cli.main --profile work serve --host 127.0.0.1 --port 0`, "work"],
  ["the machine dashboard a named-profile launch re-execs into", `${PY} -m hermes_cli.main -p default dashboard --port 9119 --host 127.0.0.1 --open-profile work`, "work"],
  ["an isolated serve", "hermes serve --isolated --host 127.0.0.1 --port 0", "default"],
] as const) {
  test(`${label} keeps its profile's hooked row working while it runs, retires it ten minutes after the last hook, and is no agent`, () => inWorld(async (w) => {
    w.fx.procs = [launchd(w), proc(w, 200, command)];
    const disc = w.disc();
    await disc.tick();
    hermesHook(w, profile, "turn");
    const lastHook = w.clock.t;
    w.clock.t += 15_000;
    await disc.tick();
    expect([rowState(w, "turn"), status(w.core, `hermes-${profile}`)?.state]).toEqual(["working", "working"]);
    w.clock.t = lastHook + TTL - 1;
    await disc.tick();
    expect(rowState(w, "turn")).toBe("working");
    w.clock.t = lastHook + TTL;
    await disc.tick();
    expect([rowState(w, "turn"), status(w.core, `hermes-${profile}`)?.state]).toEqual(["offline", "offline"]);
    expect(hermesCards(w)).toEqual([`hermes-${profile}`]); // never listed itself: the only Hermes card is the hooks' own
  }));
}

test("a cron tick that names a profile keeps only that profile's rows; a backend, which serves any profile's sessions, keeps every profile's", async () => {
  for (const [command, kept] of [
    ["hermes -p work cron tick", ["working", "offline"]],
    ["hermes cron tick", ["working", "working"]],
    [`${PY} -m hermes_cli.main --profile work serve --host 127.0.0.1 --port 0`, ["working", "working"]],
    [`${PY} -m hermes_cli.main -p default dashboard --port 9119 --open-profile work`, ["working", "working"]],
  ] as const) {
    await inWorld(async (w) => {
      w.fx.procs = [launchd(w), proc(w, 200, command)];
      const disc = w.disc();
      await disc.tick();
      hermesHook(w, "work", "mine");
      hermesHook(w, "other", "theirs");
      w.clock.t += 15_000;
      await disc.tick();
      expect([command, rowState(w, "mine"), rowState(w, "theirs")]).toEqual([command, ...kept]);
    });
  }
});

test("commands that only manage cron, stop or inspect a server, launch the desktop app or bridge MCP keep no hooked row live and make no card", () => inWorld(async (w) => {
  const tails = ["cron list", "cron status", "cron runs", "dashboard --stop", "dashboard --status", "dashboard register", "serve --status", "desktop",
    "gui --build-only", "mcp serve", "-p default config edit"];
  hermesHook(w, "default", "hooked");
  w.clock.t += 15_000;
  w.fx.procs = [launchd(w), ...tails.map((tail, n) => proc(w, 300 + n, `${PY} ${HERMES} ${tail}`, "ttys002"))];
  await w.disc().tick();
  expect(hermesCards(w)).toEqual(["hermes-default"]); // the hook's own card, and no `hermes-pid<N>` of a command
  expect(rowState(w, "hooked")).toBe("offline"); // not one of them could own it, so the census retired it
}));

test("when the host exits, the rows it kept are retired at the next scan", () => inWorld(async (w) => {
  w.fx.procs = [launchd(w), proc(w, 200, "hermes cron tick")];
  const disc = w.disc();
  await disc.tick();
  hermesHook(w, "default", "turn");
  w.clock.t += 15_000;
  await disc.tick();
  expect(rowState(w, "turn")).toBe("working");
  w.fx.procs = [launchd(w)];
  w.clock.t += 15_000;
  await disc.tick();
  expect([rowState(w, "turn"), status(w.core, "hermes-default")?.state]).toEqual(["offline", "offline"]);
}));

test("beside the hosts, a real session is exactly one card and keeps its hooked row live", () => inWorld(async (w) => {
  hermesHook(w, "default", "hooked");
  w.clock.t += 15_000;
  w.fx.procs = [launchd(w), proc(w, 300, `${PY} ${HERMES} cron tick`), proc(w, 301, `${PY} ${HERMES} dashboard`), proc(w, 302, `${PY} ${HERMES} serve --port 0`),
    proc(w, 303, `${PY} ${HERMES} chat`, "ttys001")];
  w.fx.cwds.set(303, w.cwd);
  await w.disc().tick();
  expect(hermesCards(w)).toEqual(["hermes-default", "hermes-pid303"]);
  expect(rowState(w, "hooked")).toBe("working");
}));

test("a session at its prompt keeps its row while a tick or backend that could own it runs, and loses it ten minutes after its last hook once none does", () => inWorld(async (w) => {
  w.fx.procs = [launchd(w), proc(w, 200, "hermes -p work cron tick")];
  const disc = w.disc();
  await disc.tick();
  for (const event of ["on_session_start", "pre_llm_call", "post_llm_call", "on_session_end"]) { hermesEvent(w, "work", "prompt", event); w.clock.t += 1; }
  const lastHook = w.clock.t - 1;
  expect([rowState(w, "prompt"), status(w.core, "hermes-work")?.state]).toEqual(["offline", "idle"]); // at its prompt: a row that ended, a card that is idle
  w.clock.t = lastHook + TTL + 15_000;
  await disc.tick();
  expect([rowState(w, "prompt"), status(w.core, "hermes-work")?.state]).toEqual(["offline", "idle"]); // the tick could own it
  w.fx.procs = [launchd(w)];
  w.clock.t += 15_000;
  await disc.tick();
  expect([rowState(w, "prompt"), status(w.core, "hermes-work")?.state]).toEqual([undefined, "offline"]);
}));
