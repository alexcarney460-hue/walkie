import { expect, test } from "bun:test";
import { classifyAgent, hermesProcessOf, hermesProfileOf, runtimeName, wireRuntime } from "./agent-procs.ts";
import { world, status, ME } from "../../test/helpers/discovery-world.ts";
import { applyHermesStatus, submitHermesUpdate } from "./hermes-status.ts";
import { hermesEvent, hermesHook, launchd, offlineEvents, rowState, session, type World } from "../../test/helpers/hermes-world.ts";

test("a successful census clears an exited Hermes working session before another idle hook", async () => {
  const cleanups: Array<() => void> = [];
  try {
    const w = world(cleanups);
    w.fx.procs = [
      { pid: 1, ppid: 0, uid: 0, startedAt: w.clock.t - 100_000, command: "/sbin/launchd" },
      { pid: 201, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "hermes --profile default chat" },
    ];
    w.fx.cwds.set(201, w.cwd);
    const disc = w.disc();
    await disc.tick();
    submitHermesUpdate(w.core.statuses, applyHermesStatus(w.core.store, { profile: "default", session: session("exited"), at: w.clock.t,
      sequence: 0, state: "working", fallback: "idle" }, w.clock.t), []);
    w.fx.procs = w.fx.procs.filter((p) => p.pid !== 201);
    w.clock.t += 15_000;
    await disc.tick();
    expect(status(w.core, "hermes-default")?.state).toBe("offline");
    expect(w.core.store.db.query<{ state: string }, []>("SELECT state FROM hermes_sessions").get()?.state).toBe("offline");
    const idle = applyHermesStatus(w.core.store, { profile: "default", session: session("later"), at: w.clock.t,
      sequence: 0, state: "idle", fallback: "idle" }, w.clock.t);
    expect(idle.body.state).toBe("idle");
  } finally { while (cleanups.length) cleanups.pop()?.(); }
});

test("a Hermes hook received after census capture survives that sweep", async () => {
  const cleanups: Array<() => void> = [];
  try {
    const w = world(cleanups);
    const listEnv = w.fx.envVars.bind(w.fx);
    let posted = false;
    w.fx.envVars = async (pids, names) => {
      if (!posted) {
        posted = true;
        w.clock.t += 1;
        submitHermesUpdate(w.core.statuses, applyHermesStatus(w.core.store, { profile: "default", session: session("new"),
          at: w.clock.t - 60_000, sequence: 0, state: "working", fallback: "idle" }, w.clock.t), []);
      }
      return listEnv(pids, names);
    };
    await w.disc().tick();
    expect(w.core.store.db.query<{ state: string }, []>("SELECT state FROM hermes_sessions").get()?.state).toBe("working");
  } finally { while (cleanups.length) cleanups.pop()?.(); }
});

const TURN: ReadonlyArray<readonly [event: string, tool?: string]> = [["on_session_start"], ["pre_llm_call"],
  ["pre_tool_call", "terminal"], ["post_tool_call", "terminal"], ["post_llm_call"], ["on_session_end"]];
/** A complete turn: the session is then at its prompt, and its row is state offline / fallback idle. */
function hermesTurn(w: World, profile: string, name: string) {
  for (const [event, tool] of TURN) hermesEvent(w, profile, name, event, tool);
}

/** One 15 s scan period of a live session: a hook every 5 s, then the census scan. */
async function liveScan(w: World, disc: ReturnType<World["disc"]>, profile: string, name: string) {
  for (let n = 0; n < 3; n++) { hermesHook(w, profile, name); w.clock.t += 5_000; }
  await disc.tick();
}

for (const command of ["hermes -p example-billing chat", "hermes chat -p example-billing", "hermes chat --profile=Example-Billing"]) {
  test(`hooks of a live '${command}' keep its row working across 8 scans with no offline event`, async () => {
    const cleanups: Array<() => void> = [];
    try {
      const w = world(cleanups);
      w.fx.procs = [launchd(w), { pid: 202, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command }];
      w.fx.cwds.set(202, w.cwd);
      const disc = w.disc();
      await disc.tick();
      for (let scan = 0; scan < 8; scan++) {
        await liveScan(w, disc, "example-billing", "live");
        expect(rowState(w, "live")).toBe("working");
        expect(status(w.core, "hermes-example-billing")?.state).toBe("working");
      }
      expect(offlineEvents(w, "hermes-example-billing")).toBe(0);
    } finally { while (cleanups.length) cleanups.pop()?.(); }
  });
}

test("an unnamed running Hermes process protects a working profile row, until the ten-minute TTL since its last hook", async () => {
  const cleanups: Array<() => void> = [];
  try {
    const w = world(cleanups);
    hermesHook(w, "default", "unnamed");
    const lastHook = w.clock.t;
    w.fx.procs = [launchd(w), { pid: 202, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "hermes chat" }];
    w.fx.cwds.set(202, w.cwd);
    const disc = w.disc();
    await disc.tick();
    w.clock.t += 15_000;
    await disc.tick();
    expect(rowState(w, "unnamed")).toBe("working");
    w.clock.t = lastHook + 10 * 60_000 - 1;
    await disc.tick();
    expect(rowState(w, "unnamed")).toBe("working");
    w.clock.t = lastHook + 10 * 60_000;
    await disc.tick();
    expect(rowState(w, "unnamed")).toBe("offline");
    expect(status(w.core, "hermes-default")?.state).toBe("offline");
    w.clock.t += 15_000;
    await disc.tick();
    expect(rowState(w, "unnamed")).toBeUndefined(); // the retired row is purged by the next sweep: its ten minutes are up, and its session is over
    expect(status(w.core, "hermes-default")?.state).toBe("offline");
  } finally { while (cleanups.length) cleanups.pop()?.(); }
});

test("a named Hermes card remains live when the replacement process has no profile, until the TTL", async () => {
  const cleanups: Array<() => void> = [];
  try {
    const w = world(cleanups);
    w.fx.procs = [launchd(w),
      { pid: 201, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "hermes --profile default chat" }];
    w.fx.cwds.set(201, w.cwd);
    const disc = w.disc();
    await disc.tick();
    hermesHook(w, "default", "replaced");
    const lastHook = w.clock.t;
    w.fx.procs = [w.fx.procs[0]!, { pid: 202, ppid: 1, uid: ME, startedAt: w.clock.t, command: "hermes chat" }];
    w.clock.t += 15_000;
    await disc.tick();
    expect(status(w.core, "hermes-default")?.state).toBe("working");
    expect(rowState(w, "replaced")).toBe("working");
    w.clock.t = lastHook + 10 * 60_000;
    await disc.tick();
    expect(status(w.core, "hermes-default")?.state).toBe("offline");
    expect(rowState(w, "replaced")).toBe("offline");
  } finally { while (cleanups.length) cleanups.pop()?.(); }
});

test("a named Hermes process for one profile does not keep another profile's row working", async () => {
  const cleanups: Array<() => void> = [];
  try {
    const w = world(cleanups);
    w.fx.procs = [launchd(w),
      { pid: 201, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "hermes --profile example-billing chat" }];
    w.fx.cwds.set(201, w.cwd);
    const disc = w.disc();
    await disc.tick();
    hermesHook(w, "example-billing", "mine");
    hermesHook(w, "default", "other");
    w.clock.t += 15_000;
    await disc.tick();
    expect([rowState(w, "mine"), rowState(w, "other")]).toEqual(["working", "offline"]);
    expect(status(w.core, "hermes-default")?.state).toBe("offline");
  } finally { while (cleanups.length) cleanups.pop()?.(); }
});

test("a live bare 'hermes chat' stays working across 8 scans of hooks with no offline event, and is retired ten minutes after its last hook", async () => {
  const cleanups: Array<() => void> = [];
  try {
    const w = world(cleanups);
    w.fx.procs = [launchd(w), { pid: 202, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "hermes chat" }];
    w.fx.cwds.set(202, w.cwd);
    const disc = w.disc();
    await disc.tick();
    for (let scan = 0; scan < 8; scan++) {
      await liveScan(w, disc, "default", "bare");
      expect(rowState(w, "bare")).toBe("working");
      expect(status(w.core, "hermes-default")?.state).toBe("working");
    }
    expect(offlineEvents(w, "hermes-default")).toBe(0);
    // The process is still alive, but the hooks stopped: the profile fallback is bounded by the TTL since the last hook.
    const lastHook = w.clock.t - 5_000; // liveScan's third hook, 5 s before its scan
    w.clock.t = lastHook + 10 * 60_000 - 1;
    await disc.tick();
    expect(rowState(w, "bare")).toBe("working");
    w.clock.t = lastHook + 10 * 60_000;
    await disc.tick();
    expect(rowState(w, "bare")).toBe("offline");
    expect(status(w.core, "hermes-default")?.state).toBe("offline");
    expect(offlineEvents(w, "hermes-default")).toBe(1);
  } finally { while (cleanups.length) cleanups.pop()?.(); }
});

test("two sessions of one profile, one exits silently and the other idles: the card is idle, never offline (hook-supplied pids)", async () => {
  const cleanups: Array<() => void> = [];
  try {
    const w = world(cleanups);
    w.fx.procs = [launchd(w),
      { pid: 201, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "hermes --profile default chat" },
      { pid: 202, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "hermes --profile default chat" }];
    const disc = w.disc();
    await disc.tick();
    hermesHook(w, "default", "exits", "working", 201);
    w.clock.t += 1;
    hermesHook(w, "default", "sibling", "idle", 202);
    w.fx.procs = w.fx.procs.filter((p) => p.pid !== 201);
    w.clock.t += 15_000;
    await disc.tick();
    expect([rowState(w, "exits"), rowState(w, "sibling")]).toEqual(["offline", "idle"]);
    expect(status(w.core, "hermes-default")?.state).toBe("idle");
    expect(offlineEvents(w, "hermes-default")).toBe(0);
  } finally { while (cleanups.length) cleanups.pop()?.(); }
});

test("two sessions of one profile without pids: when the exited one's row expires the card goes idle, never offline", async () => {
  const cleanups: Array<() => void> = [];
  try {
    const w = world(cleanups);
    w.fx.procs = [launchd(w),
      { pid: 201, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "hermes --profile default chat" },
      { pid: 202, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "hermes --profile default chat" }];
    const disc = w.disc();
    await disc.tick();
    hermesHook(w, "default", "exits", "working");
    const lastHook = w.clock.t;
    w.clock.t += 1;
    hermesHook(w, "default", "sibling", "idle");
    w.fx.procs = w.fx.procs.filter((p) => p.pid !== 201);
    for (let step = 1; lastHook + step * 15_000 <= lastHook + 15 * 60_000; step++) {
      w.clock.t = lastHook + step * 15_000;
      await disc.tick();
      expect(status(w.core, "hermes-default")?.state).not.toBe("offline");
    }
    // the exited session's row was retired at ten minutes and purged; the sibling's, at its prompt for 15 minutes, is owned by the process that runs
    expect([rowState(w, "exits"), rowState(w, "sibling")]).toEqual([undefined, "idle"]);
    expect(status(w.core, "hermes-default")?.state).toBe("idle");
    expect(offlineEvents(w, "hermes-default")).toBe(0);
  } finally { while (cleanups.length) cleanups.pop()?.(); }
});

for (const [label, command, profile] of [
  ["a named gateway", "python -m hermes_cli.main --profile example-billing gateway run --replace --external-supervisor", "example-billing"],
  ["a gateway named with -p", "hermes -p example-billing gateway run", "example-billing"],
  ["a gateway that names no profile", "python -m hermes_cli.main gateway run --replace", "default"],
  ["a bare `hermes gateway`", "hermes gateway", "default"],
] as const) {
  test(`${label} keeps its profile's hooked row working while it runs, retires it ten minutes after the last hook, and is no agent`, async () => {
    const cleanups: Array<() => void> = [];
    try {
      const w = world(cleanups);
      w.fx.procs = [launchd(w), { pid: 200, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command }];
      const disc = w.disc();
      await disc.tick();
      hermesHook(w, profile, "bot");
      const lastHook = w.clock.t;
      w.clock.t += 15_000;
      await disc.tick();
      expect(rowState(w, "bot")).toBe("working");
      expect(status(w.core, `hermes-${profile}`)?.state).toBe("working");
      w.clock.t = lastHook + 10 * 60_000 - 1;
      await disc.tick();
      expect(rowState(w, "bot")).toBe("working");
      w.clock.t = lastHook + 10 * 60_000;
      await disc.tick();
      expect(rowState(w, "bot")).toBe("offline");
      expect(status(w.core, `hermes-${profile}`)?.state).toBe("offline");
      // Never listed itself: the only Hermes card is the hooks' own.
      expect(w.core.store.db.query<{ agent: string }, []>("SELECT DISTINCT author_agent AS agent FROM events WHERE kind = 'agent.status'").all()
        .map((r) => r.agent).filter((a) => a.startsWith("hermes-"))).toEqual([`hermes-${profile}`]);
    } finally { while (cleanups.length) cleanups.pop()?.(); }
  });
}

test("a gateway named for one profile does not keep another profile's row working, and gateway management commands are no evidence", async () => {
  const cleanups: Array<() => void> = [];
  try {
    const w = world(cleanups);
    w.fx.procs = [launchd(w),
      { pid: 200, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "hermes --profile example-billing gateway run" },
      { pid: 201, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "hermes gateway status" },
      { pid: 202, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "hermes --profile default gateway stop --all" }];
    const disc = w.disc();
    await disc.tick();
    hermesHook(w, "example-billing", "billing");
    hermesHook(w, "default", "other");
    w.clock.t += 15_000;
    await disc.tick();
    expect([rowState(w, "billing"), rowState(w, "other")]).toEqual(["working", "offline"]);
  } finally { while (cleanups.length) cleanups.pop()?.(); }
});

test("Hermes interactive and one-shot processes are agents", () => {
  expect(classifyAgent("/Users/a/.local/bin/hermes --profile example-billing chat", "ttys001")).toEqual({ runtime: "hermes" });
  expect(classifyAgent("/Users/a/.hermes/venv/bin/python -m hermes_cli.main --profile default", null)).toEqual({ runtime: "hermes", launch: "headless" });
  expect(classifyAgent("hermes -z hello", "ttys002")).toEqual({ runtime: "hermes", launch: "headless" });
  expect(hermesProfileOf("hermes --profile example-billing chat")).toBe("example-billing");
  expect(hermesProfileOf("hermes chat")).toBeNull();
  expect(wireRuntime("hermes")).toBe("other");
  expect(runtimeName("hermes")).toBe("hermes");
});

test("hermesProfileOf reads every profile form Hermes' own pre-parse accepts, before or after the subcommand", () => {
  for (const [command, profile] of [
    ["hermes --profile example-billing chat", "example-billing"],
    ["hermes --profile=example-billing chat", "example-billing"],
    ["hermes -p example-billing chat", "example-billing"],
    ["hermes chat -p example-billing", "example-billing"],
    ["hermes chat --profile example-billing", "example-billing"],
    ["hermes chat --profile=example-billing", "example-billing"],
    ["python -m hermes_cli.main -p social-assistant gateway run --replace", "social-assistant"],
    ["/Users/a/.local/bin/hermes chat -m some-model -p example-billing", "example-billing"],
    // The value of a top-level value flag is skipped, never read as a profile selector (main.py _scan_profile_flag). The
    // flags whose value is free text are another matter: nothing after them is read (the test on free text below).
    ["hermes -m some-model -p example-billing chat", "example-billing"],
    ["hermes --in /work/dir -t web,file -s a,b -p example-billing chat", "example-billing"],
    ["hermes -c -p example-billing chat", "example-billing"],
    // The first selector wins.
    ["hermes -p one chat --profile two", "one"],
  ] as const) expect([command, hermesProfileOf(command)]).toEqual([command, profile]);
});

test("hermesProfileOf normalizes names the way Hermes does", () => {
  expect(hermesProfileOf("hermes -p Example-Billing chat")).toBe("example-billing");
  expect(hermesProfileOf("hermes --profile=EXAMPLE-BILLING chat")).toBe("example-billing");
  expect(hermesProfileOf("hermes chat -p DEFAULT")).toBe("default");
});

test("hermesProfileOf leaves a process unresolved where Hermes selects no profile Walkie can name", () => {
  for (const command of ["hermes", "hermes chat", "hermes -p", "hermes chat -p", "hermes -p ../escape chat",
    "hermes -p -z chat", "hermes -m -p chat", "hermes -c x -q y", "hermes -p=example-billing chat",
    "hermes -p under_score chat", `hermes -p ${"a".repeat(33)} chat`,
    "hermes chat -- -p example-billing", "hermes mcp add docker --args -p example-billing",
    "node /x/server.js -p example-billing", ""]) {
    expect([command, hermesProfileOf(command)]).toEqual([command, null]);
  }
});

test("hermesProfileOf reads a bounded number of words of one command line", () => {
  const filler = "word ".repeat(300);
  expect(hermesProfileOf(`hermes -p example-billing chat ${filler}`)).toBe("example-billing");
  expect(hermesProfileOf(`hermes chat ${filler} -p example-billing`)).toBeNull();
});

test("a Hermes gateway named with -p is a gateway, not a session; a -p chat is a session", () => {
  for (const command of ["hermes -p default gateway run", "hermes --profile=x gateway run",
    "python -m hermes_cli.main -p x gateway run --replace", "hermes -m some-model -p x gateway run"]) {
    expect([command, classifyAgent(command, null)]).toEqual([command, null]);
  }
  expect(classifyAgent("hermes -p default chat", "ttys001")).toEqual({ runtime: "hermes" });
  expect(classifyAgent("hermes chat -p default", "ttys001")).toEqual({ runtime: "hermes" });
});

test("hermesProcessOf puts sessions and the hosts of hooked turns in the liveness census, and nothing else", () => {
  const home = "/Users/a/.hermes/hermes-agent/venv/bin/python";
  for (const [command, tty, kind] of [
    ["hermes --profile example-billing chat", "ttys001", { profile: "example-billing", gateway: false }],
    ["hermes chat", "ttys001", { profile: null, gateway: false }],
    ["hermes -z hello", "ttys002", { profile: null, gateway: false }],
    ["hermes -z gateway run", "ttys002", { profile: null, gateway: false }], // a prompt, not a subcommand
    [`${home} -m hermes_cli.main --profile social-assistant gateway run --replace --external-supervisor`, null, { profile: "social-assistant", gateway: true }],
    [`${home} -m hermes_cli.main gateway run --replace`, null, { profile: null, gateway: true }],
    ["hermes -p x gateway run", null, { profile: "x", gateway: true }],
    ["hermes gateway run -p x", null, { profile: "x", gateway: true }],
    ["hermes gateway", null, { profile: null, gateway: true }], // bare `hermes gateway` defaults to run
    ["hermes gateway status", null, null],
    ["hermes gateway --help", null, null],
    ["hermes gateway run --help", null, null],
    ["hermes gateway stop --all", null, null],
    ["hermes -p x gateway restart", null, null],
    ["hermes gateway install", null, null],
    ["hermes serve", null, { profile: null, gateway: true }], // a server serves any profile's sessions: hermes-hosts.test.ts
    ["hermes cron list", null, null],
    ["hermes --help", null, null],
    // Hermes' supervisor wrapper runs the gateway as its child: only the child is the gateway.
    [`${home} -m hermes_cli.stderr_timestamp --error-log /x/gateway.error.log -- ${home} -m hermes_cli.main gateway run`, null, null],
    ["python -m other.module gateway run", null, null],
    ["/sbin/launchd", null, null],
    ["", null, null],
  ] as const) expect([command, hermesProcessOf(command, tty)]).toEqual([command, kind]);
});

test("Hermes gateways, serve backends, cron, and management commands are not sessions", () => {
  for (const command of ["python -m hermes_cli.main gateway run --replace", "hermes --profile default gateway run",
    "hermes serve", "hermes cron list", "hermes hooks list", "hermes mcp serve", "hermes dashboard", "hermes --help"]) {
    expect(classifyAgent(command, null)).toBeNull();
  }
});

test("discovery publishes a Hermes process as a state-only row, whatever the share policy says", async () => {
  const cleanups: Array<() => void> = [];
  try {
    const w = world(cleanups, { prompts: true, activity: true, paths: true });
    w.fx.procs = [
      { pid: 1, ppid: 0, uid: 0, startedAt: w.clock.t - 100_000, command: "/sbin/launchd" },
      { pid: 200, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "python -m hermes_cli.main gateway run --replace" },
      { pid: 201, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "hermes --profile example-billing chat" },
    ];
    w.fx.cwds.set(201, w.cwd);
    await w.disc().tick();
    const observed = status(w.core, "hermes-example-billing");
    expect(observed).toMatchObject({ agent: "hermes-example-billing", runtime: "other", runtime_name: "hermes" });
    for (const key of ["title", "task", "repo", "branch", "cwd", "activity"]) expect(observed).not.toHaveProperty(key);
    expect(status(w.core, "hermes-default")).toBeNull();
  } finally { while (cleanups.length) cleanups.pop()?.(); }
});

// ---- the argv `ps` prints for the installed Hermes (round 9, finding 1) -----------------------------------------------
// `hermes` is a Python console script with a `#!<venv>/bin/python3` shebang (hermes-agent 0.21.3 on this Mac), so `ps`
// prints the interpreter, then the script, then Hermes' own arguments: never a bare `hermes` and never `-m hermes_cli.main`.
const VENV = "/Users/example/.hermes/hermes-agent/venv/bin";
const PY = `${VENV}/python3`;
const HERMES = `${VENV}/hermes`;

test("the installed Hermes console script is a session in the census, with the profile its arguments name", () => {
  for (const [command, profile] of [
    [`${PY} ${HERMES} chat`, null],
    [`${PY} ${HERMES}`, null],
    [`${PY} ${HERMES} -p example-billing chat`, "example-billing"],
    [`${PY} ${HERMES} --profile=x chat`, "x"],
    [`${PY} ${HERMES} chat --profile Work`, "work"],
    [`${PY} ${HERMES} --tui`, null], // the TUI's parent is the same console script (it waits for the Node UI it spawns)
    [`${PY} ${HERMES} -p example-billing --tui`, "example-billing"],
    [`${VENV}/python ${HERMES} chat`, null],
    // A macOS framework build runs as Python.app/Contents/MacOS/Python.
    [`/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python ${HERMES} -p x chat`, "x"],
    ["/usr/bin/python3.11 /opt/hermes/venv/bin/hermes chat", null],
    ["python3 /Users/example/.hermes/hermes-agent/hermes -p x chat", "x"], // the checkout's own launcher script
    [`${PY} ${VENV}/hermes-agent`, null], // `hermes-agent` is run_agent's own Fire CLI: it has no profile selector
    [`${PY} ${VENV}/hermes-acp`, null], // `hermes-acp` is the ACP adapter an editor starts, the program `hermes acp` runs
  ] as const) {
    expect([command, classifyAgent(command, "ttys001")?.runtime]).toEqual([command, "hermes"]);
    expect([command, hermesProcessOf(command, "ttys001")]).toEqual([command, { profile, gateway: false }]);
    expect([command, hermesProfileOf(command)]).toEqual([command, profile]);
  }
  expect(classifyAgent(`${PY} ${HERMES} -z hello`, "ttys002")).toEqual({ runtime: "hermes", launch: "headless" });
  expect(classifyAgent(`${PY} ${VENV}/hermes-acp`, null)).toEqual({ runtime: "hermes", launch: "headless" }); // no terminal: the editor's pipe
});

test("a gateway run or a serve through the console script is evidence and no agent; management and help through it are neither", () => {
  for (const [command, kind] of [
    [`${PY} ${HERMES} gateway run --replace`, { profile: null, gateway: true }],
    [`${PY} ${HERMES} -p social-assistant gateway run`, { profile: "social-assistant", gateway: true }],
    [`${PY} ${HERMES} gateway`, { profile: null, gateway: true }],
    [`${PY} ${HERMES} gateway status`, null],
    [`${PY} ${HERMES} gateway run --help`, null],
    [`${PY} ${HERMES} --help`, null],
    [`${PY} ${HERMES} --version`, null],
    [`${PY} ${HERMES} serve`, { profile: null, gateway: true }],
    [`${PY} ${HERMES} cron list`, null],
    [`${PY} ${HERMES} serve --stop`, null],
  ] as const) {
    expect([command, classifyAgent(command, null)]).toEqual([command, null]);
    expect([command, hermesProcessOf(command, null)]).toEqual([command, kind]);
  }
});

test("other Python programs are no Hermes process, whatever their path says", () => {
  for (const command of [
    // The Hermes venv's Python runs these on this Mac (read-only ps, 2026-10-01): a team script and Hermes' MCP supervisor.
    `${PY} /Users/example/workspace/hermes-example-team/access.py`,
    `${PY} /Users/example/.hermes/hermes-agent/tools/mcp_death_supervisor.py --parent-pgid 41648`,
    `${PY} -m tui_gateway.entry`, // the process the Node TUI spawns: the parent console script is the session
    `${PY} /opt/hermes/hermes.py chat`,
    `${PY} /opt/hermes-tools/run.py hermes chat`,
    `${PY} -c print('hermes')`,
    `${PY} ${VENV}/hermes-agent-helper chat`,
    `${PY} -m hermes_cli.stderr_timestamp --error-log /x/gateway.error.log -- ${PY} -m hermes_cli.main gateway run`, // the supervisor wrapper
    "node --expose-gc /Users/example/.hermes/hermes-agent/ui-tui/dist/entry.js", // the TUI's Node child
    "python3",
  ]) {
    expect([command, classifyAgent(command, "ttys001")]).toEqual([command, null]);
    expect([command, hermesProcessOf(command, "ttys001")]).toEqual([command, null]);
    expect([command, hermesProfileOf(command)]).toEqual([command, null]);
  }
});

test("the console-script and `-m hermes_cli.main` prefixes read a profile the way the bare launcher does", () => {
  for (const tail of ["-p work chat", "chat -p Work", "--profile=work gateway run", "gateway run --replace", "-m x -p work chat"]) {
    const bare = hermesProfileOf(`hermes ${tail}`);
    expect([tail, hermesProfileOf(`/Users/a/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main ${tail}`)]).toEqual([tail, bare]);
    expect([tail, hermesProfileOf(`/Users/a/.hermes/hermes-agent/venv/bin/python3 /Users/a/.hermes/hermes-agent/venv/bin/hermes ${tail}`)]).toEqual([tail, bare]);
  }
});

for (const [label, command, withGateway, profile, tty] of [
  ["real `hermes chat`, no gateway", `${PY} ${HERMES} chat`, false, "default", "ttys001"],
  ["real `hermes -p example-billing chat`, no gateway", `${PY} ${HERMES} -p example-billing chat`, false, "example-billing", "ttys001"],
  ["real `hermes chat`, a bare gateway running", `${PY} ${HERMES} chat`, true, "default", "ttys001"],
  ["real `hermes --tui` (the TUI's parent), no gateway", `${PY} ${HERMES} --tui`, false, "default", "ttys001"],
  ["real `hermes-acp` (an editor's pipe), no gateway", `${PY} ${VENV}/hermes-acp`, false, "default", null],
  ["control `python -m hermes_cli.main chat`, no gateway", `${PY} -m hermes_cli.main chat`, false, "default", "ttys001"],
  ["control literal `hermes chat`, no gateway", "hermes chat", false, "default", "ttys001"],
] as const) {
  test(`${label}: a live session hooking every 5 s stays working across 8 scans with no offline event`, async () => {
    const cleanups: Array<() => void> = [];
    try {
      const w = world(cleanups);
      w.fx.procs = [launchd(w), { pid: 202, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command, tty }];
      if (withGateway) w.fx.procs.push({ pid: 300, ppid: 1, uid: ME, startedAt: w.clock.t - 600_000, command: `${PY} -m hermes_cli.main gateway run --replace` });
      w.fx.cwds.set(202, w.cwd);
      const disc = w.disc();
      await disc.tick();
      for (let scan = 0; scan < 8; scan++) {
        await liveScan(w, disc, profile, "live");
        expect(rowState(w, "live")).toBe("working");
        expect(status(w.core, `hermes-${profile}`)?.state).toBe("working");
      }
      expect(offlineEvents(w, `hermes-${profile}`)).toBe(0);
    } finally { while (cleanups.length) cleanups.pop()?.(); }
  });
}

test("a Hermes TUI's parent is the one session of its process tree", async () => {
  const cleanups: Array<() => void> = [];
  try {
    const w = world(cleanups);
    w.fx.procs = [launchd(w),
      { pid: 202, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: `${PY} ${HERMES} --tui`, tty: "ttys001" },
      { pid: 203, ppid: 202, uid: ME, startedAt: w.clock.t - 59_000, command: "node --expose-gc /Users/example/.hermes/hermes-agent/ui-tui/dist/entry.js", tty: "ttys001" },
      { pid: 204, ppid: 203, uid: ME, startedAt: w.clock.t - 58_000, command: `${PY} -m tui_gateway.entry`, tty: null }];
    w.fx.cwds.set(202, w.cwd);
    await w.disc().tick();
    const cards = w.core.store.db.query<{ agent: string }, []>("SELECT DISTINCT author_agent AS agent FROM events WHERE kind = 'agent.status'").all()
      .map((r) => r.agent).filter((agent) => agent.startsWith("hermes-"));
    expect(cards).toEqual(["hermes-pid202"]);
  } finally { while (cleanups.length) cleanups.pop()?.(); }
});

// ---- one profile's hook must not strand another profile's published card (round 9, finding 2) ------------------------
// A hook of any profile deletes the rows older than the ten-minute TTL; the pid-less shield of a running Hermes process
// lasts exactly one TTL. A dead session's working row could therefore be deleted by someone else's hook in the seconds
// between the two bounds, before the sweep retired it, and its card then stayed working with no row left to retire.
const BARE_GATEWAY = `${VENV}/python -m hermes_cli.main gateway run --replace`; // this Mac's always-on gateway (pid 41648)

/**
 * One chronological timeline against a bare gateway (it shields every pid-less row for the TTL): a session of profile
 * `example-ops` hooks once and its process exits silently. Scans run every 15 s, the first `scanPhase` ms after that
 * hook; profile `work` hooks at the offsets in `busyAt` (ms after it). Returns the dead profile's card at the end.
 */
async function deadSessionCard(scanPhase: number, busyAt: readonly number[], minutes: number) {
  const cleanups: Array<() => void> = [];
  try {
    const w = world(cleanups);
    w.fx.procs = [launchd(w), { pid: 41648, ppid: 1, uid: ME, startedAt: w.clock.t - 86_400_000, command: BARE_GATEWAY }];
    const disc = w.disc();
    await disc.tick();
    hermesHook(w, "example-ops", "dead");
    const t0 = w.clock.t;
    const timeline: Array<{ at: number; kind: "scan" | "busy" }> = busyAt.map((at) => ({ at, kind: "busy" as const }));
    for (let at = scanPhase; at <= minutes * 60_000; at += 15_000) timeline.push({ at, kind: "scan" });
    timeline.sort((a, b) => a.at - b.at || (a.kind === "busy" ? -1 : 1));
    for (const step of timeline) {
      w.clock.t = t0 + step.at;
      if (step.kind === "busy") hermesHook(w, "work", "busy"); else await disc.tick();
    }
    return status(w.core, "hermes-example-ops")?.state;
  } finally { while (cleanups.length) cleanups.pop()?.(); }
}

test("with no other profile hooking, a dead session's card goes offline at the TTL (control)", async () => {
  expect(await deadSessionCard(7_000, [], 12 * 60)).toBe("offline");
});

test("another profile hooking 3 s after the TTL and 4 s before the next scan does not strand the dead session's working card", async () => {
  expect(await deadSessionCard(7_000, [603_000], 30 * 60)).toBe("offline");
});

test("a busy Mac (another profile hooking every 5 s) retires the dead session's card whatever the scan phase", async () => {
  const busy = Array.from({ length: 144 }, (_, n) => 2_000 + n * 5_000); // every 5 s for 12 minutes
  for (let phase = 1_000; phase <= 15_000; phase += 2_000) {
    expect([phase, await deadSessionCard(phase, busy, 12)]).toEqual([phase, "offline"]);
  }
});

// ---- a sibling at its prompt is a live session (round 9, finding 3) ----------------------------------------------------
for (const [label, procA, procB] of [
  ["named (-p default) processes", "hermes -p default chat", "hermes -p default chat"],
  ["bare processes", "hermes chat", "hermes chat"],
] as const) {
  test(`two sessions of one profile, ${label}: B exits silently while A sits at its prompt, the card never goes offline`, async () => {
    const cleanups: Array<() => void> = [];
    try {
      const w = world(cleanups);
      w.fx.procs = [launchd(w),
        { pid: 201, ppid: 1, uid: ME, startedAt: w.clock.t - 600_000, command: procA },
        { pid: 202, ppid: 1, uid: ME, startedAt: w.clock.t - 600_000, command: procB }];
      const disc = w.disc();
      await disc.tick();
      hermesTurn(w, "default", "A"); // A's row: state offline, fallback idle
      w.clock.t += 1_000;
      hermesEvent(w, "default", "B", "pre_llm_call");
      const lastB = w.clock.t;
      w.fx.procs = w.fx.procs.filter((p) => p.pid !== 202); // B's process exits silently; A (pid 201) keeps running
      let retired = false;
      for (let step = 1; step * 15_000 <= 15 * 60_000; step++) {
        w.clock.t = lastB + step * 15_000;
        await disc.tick();
        retired ||= rowState(w, "B") === "offline";
        expect(status(w.core, "hermes-default")?.state).not.toBe("offline");
      }
      expect(retired).toBe(true); // B's row really was retired during those 15 minutes
      expect(status(w.core, "hermes-default")?.state).toBe("idle");
      expect(offlineEvents(w, "hermes-default")).toBe(0);
    } finally { while (cleanups.length) cleanups.pop()?.(); }
  });
}

// ---- a selector inside a prompt names no profile (round 9, finding 4) ------------------------------------------------
// `ps` joins argv with spaces, so a prompt (or a session name) on the command line is several words, and `mkdir -p build`,
// `ssh -p 22` or `git log -p` inside it read as a profile selector. The wrong name is not harmless: the process then matches
// no row and counts as unresolved for none, so the real profile's rows are retired at every scan while it runs.
const PROMPTS = [
  "hermes -z write a build script that does mkdir -p build and then exit",
  "hermes chat -q run the installer with ssh -p 22 to the box",
  "hermes -z summarise git log -p release notes",
] as const;

/** Both launchers of a prompt: the bare `hermes` and the console script that `ps` prints for the installed Hermes. */
const launched = (prompts: readonly string[]) => prompts.flatMap((prompt) => [
  [prompt, prompt] as const,
  [`${prompt} (console script)`, prompt.replace("hermes", `${PY} ${HERMES}`)] as const,
]);

/** A live default-profile session in this process, for 8 scans of hooks every 5 s with no Hermes process but its own: never offline. */
async function expectSessionNeverFlaps(command: string) {
  expect([command, hermesProfileOf(command)]).toEqual([command, null]);
  expect([command, hermesProcessOf(command, "ttys001")]).toEqual([command, { profile: null, gateway: false }]);
  const cleanups: Array<() => void> = [];
  try {
    const w = world(cleanups);
    w.fx.procs = [launchd(w), { pid: 202, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command, tty: "ttys001" }];
    w.fx.cwds.set(202, w.cwd);
    const disc = w.disc();
    await disc.tick();
    for (let scan = 0; scan < 8; scan++) {
      await liveScan(w, disc, "default", "live");
      expect(rowState(w, "live")).toBe("working");
    }
    expect(offlineEvents(w, "hermes-default")).toBe(0);
  } finally { while (cleanups.length) cleanups.pop()?.(); }
}

for (const [label, command] of launched(PROMPTS)) {
  test(`'${label}': the selector inside the prompt leaves the process unresolved, and its default-profile session does not flap`, () => expectSessionNeverFlaps(command));
}

// ---- a help or version flag inside a prompt is text, too (round 12, finding 1) ---------------------------------------------
// `hermes -z git --version` is a one-shot prompt, not `hermes --version`: read as that, the process is no session and no
// liveness evidence, so a live session of the default profile would have its working row retired at every scan.
const FLAG_PROMPTS = [
  "hermes -z git --version",
  "hermes -z node -v",
  "hermes -z tar --help",
  "hermes -z summarize --help output for me",
] as const;

for (const [label, command] of launched(FLAG_PROMPTS)) {
  test(`'${label}': the flag inside the prompt leaves it a session, and its default-profile session does not flap`, () => expectSessionNeverFlaps(command));
}

test("nothing after a flag whose value is free text is read as a selector, but a selector before it still counts", () => {
  for (const [command, profile] of [
    // prompts: -z / --oneshot and -q / --query, spaced or attached with `=`
    ["hermes --oneshot do mkdir -p build", null],
    ["hermes chat --query=ssh -p 22 host", null],
    ["hermes -z=run git log -p now", null],
    ["hermes chat -q hello -p example-billing", null], // one word, then a selector: flattened, it cannot be told from a prompt
    ["hermes -z hello --profile example-billing", null],
    ["hermes -z", null],
    // session names and titles: -r / --resume and -c / --continue (only when they take a name)
    ["hermes -c fix ssh -p bug", null],
    ["hermes --continue=fix ssh -p bug", null],
    ["hermes --resume my title -p x chat", null],
    ["hermes -c session -p example-billing chat", null],
    // argparse also takes a short option's value attached to it: -zPROMPT, -qPROMPT, -rTITLE, -cNAME
    ["hermes -zmkdir -p build", null],
    ["hermes chat -qssh -p 22 host", null],
    ["hermes -r20260930_ab -p work chat", null],
    ["hermes -cfix ssh -p bug", null],
    [`${PY} ${HERMES} -zmkdir -p build`, null],
    // before the free text, the first selector decides, as it does for Hermes
    ["hermes -p work -z mkdir -p build", "work"],
    ["hermes --profile=work chat -q ssh -p 22 host", "work"],
    ["hermes -p work chat --query=a -p b", "work"],
    ["hermes -p work -zmkdir -p build", "work"],
    // a -c with no name takes no value, so what follows it is still argv
    ["hermes -c -p example-billing chat", "example-billing"],
    ["hermes -c", null],
    // values that are not free text are skipped as before
    ["hermes -m some-model -p example-billing chat", "example-billing"],
    ["hermes --provider openrouter --reasoning high -p example-billing", "example-billing"],
    // the same words through the console script and `-m hermes_cli.main`
    [`${PY} ${HERMES} -z mkdir -p build`, null],
    [`${PY} -m hermes_cli.main -p work -z mkdir -p build`, "work"],
  ] as const) expect([command, hermesProfileOf(command)]).toEqual([command, profile]);
});
