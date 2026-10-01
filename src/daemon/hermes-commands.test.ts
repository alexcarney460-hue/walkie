// Round 10, finding 1: Hermes' management commands (`hermes logs -f`, `update`, `doctor`, `model`, ...) are no agent session and
// no liveness evidence, so they leave no ghost card and shield no hooked row. Only the invocations that run an agent session do.
// Round 11 moved the three that run agent turns in their own process, `cron run|tick`, `dashboard` and `serve`, out of "no liveness
// evidence" (hermes-hosts.test.ts): they are still no session and no card.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { classifyAgent, hermesProcessOf, hermesProfileOf } from "./agent-procs.ts";
import { applyHermesStatus, submitHermesUpdate } from "./hermes-status.ts";
import { world, ME } from "../../test/helpers/discovery-world.ts";

// hermes_cli/main.py `_BUILTIN_SUBCOMMANDS` (hermes-agent 0.21.3, read 2026-10-01): the 74 top-level subcommands Hermes knows
// without plugin discovery, in the source's order. Of them `chat` and `acp` run an agent session (`_AGENT_COMMANDS`, with the
// bare `hermes`) and `gateway` runs the messaging gateway when it is `run` (or nothing). The rest manage something or serve.
const BUILTIN_SUBCOMMANDS: readonly string[] = [
  "acp", "approvals", "auth", "backup", "bundles", "checkpoints", "claw", "completion", "computer-use", "config",
  "console", "cron", "curator", "dashboard", "serve", "debug", "doctor", "dump", "egress", "fallback", "gateway",
  "hooks", "import", "import-agent", "insights", "gui", "desktop", "kanban", "login", "logout", "logs", "lsp", "mcp",
  "memory", "migrate", "moa", "journey", "memory-graph", "learning", "model", "monitoring", "pairing", "pause",
  "peer", "pets", "plugins", "portal", "profile", "project", "proxy", "prompt-size", "resume", "send", "sessions",
  "setup", "skin", "skills", "slack", "status", "sync", "tools", "uninstall", "update", "vault", "webhook",
  "whatsapp", "whatsapp-cloud", "worktree", "chat", "secrets", "security", "browser", "verify", "help",
];
const RUNS_SOMETHING = new Set<string>(["chat", "acp", "gateway"]);
const MANAGEMENT = BUILTIN_SUBCOMMANDS.filter((name) => !RUNS_SOMETHING.has(name));
/** The two that, started as a server, host hooked agent turns (hermes-hosts.test.ts); `cron` does only for `run` and `tick`. */
const SERVERS = new Set<string>(["dashboard", "serve"]);

const VENV = "/Users/example/.hermes/hermes-agent/venv/bin";
const PY = `${VENV}/python3`;
const HERMES = `${VENV}/hermes`;
/** The argv `ps` prints for the `hermes` CLI: the launcher, the installed console script, and `-m hermes_cli.main`. */
const LAUNCHERS = ["hermes", `${PY} ${HERMES}`, `${PY} -m hermes_cli.main`] as const;

test("the list is Hermes' own: 74 distinct built-in subcommands, 71 of which run neither a session nor the gateway", () => {
  expect(BUILTIN_SUBCOMMANDS.length).toBe(74);
  expect(new Set(BUILTIN_SUBCOMMANDS).size).toBe(74);
  expect(MANAGEMENT.length).toBe(71);
  for (const name of ["logs", "update", "doctor", "model", "config", "sessions", "cron", "mcp", "serve", "dashboard", "setup"]) {
    expect(MANAGEMENT).toContain(name);
  }
});

for (const name of MANAGEMENT.filter((n) => !SERVERS.has(n))) {
  test(`'hermes ${name}' is no agent session and no liveness evidence, however it is launched`, () => {
    for (const launcher of LAUNCHERS) {
      for (const before of ["", " -p work", " --profile=work -m some-model", " --yolo", " -w"]) {
        for (const after of ["", " -f", " list --all", " -p work"]) {
          for (const tty of ["ttys001", null]) {
            const command = `${launcher}${before} ${name}${after}`;
            expect([command, tty, classifyAgent(command, tty)]).toEqual([command, tty, null]);
            expect([command, tty, hermesProcessOf(command, tty)]).toEqual([command, tty, null]);
          }
        }
      }
    }
  });
}

test("the management commands the brief names, as `ps` prints them for the installed Hermes", () => {
  for (const tail of ["logs -f", "logs errors --since 1h", "update", "doctor", "model", "-p example-billing doctor", "config edit"]) {
    const command = `${PY} ${HERMES} ${tail}`;
    expect([command, classifyAgent(command, "ttys003")]).toEqual([command, null]);
    expect([command, hermesProcessOf(command, "ttys003")]).toEqual([command, null]);
  }
});

// Every invocation that runs an agent session is still one, and names the profile its arguments name.
const SESSIONS = [
  "", "chat", "chat -q summarise the repo", "chat --query=summarise", "-z hello", "--oneshot hello there", "--tui", "--tui --dev",
  "chat --tui", "--cli", "acp", "-c", "-c my project", "--continue=my-project", "-r latest", "--resume 20260930_ab", "-w",
  "-m some-model", "--provider openrouter chat", "-s a,b chat", "-t web,file", "--yolo", "--accept-hooks chat", "--in /work/dir -c",
] as const;

test("a bare hermes, chat, one-shot, resume, TUI and acp invocations are agent sessions, whichever way they are launched", () => {
  for (const launcher of LAUNCHERS) {
    for (const tail of SESSIONS) {
      for (const [prefix, profile] of [["", null], [" -p work", "work"], [" --profile=work", "work"]] as const) {
        const command = `${launcher}${prefix} ${tail}`.trim();
        expect([command, classifyAgent(command, "ttys001")?.runtime]).toEqual([command, "hermes"]);
        expect([command, hermesProcessOf(command, "ttys001")]).toEqual([command, { profile, gateway: false }]);
        expect([command, hermesProfileOf(command)]).toEqual([command, profile]);
      }
    }
  }
});

test("hermes-acp and hermes-agent are entry points of their own: whatever follows them is no subcommand", () => {
  for (const command of [`${PY} ${VENV}/hermes-acp`, `${VENV}/hermes-acp`, `${PY} ${VENV}/hermes-agent hello world`,
    `${PY} ${VENV}/hermes-agent --query=update`, `${PY} ${VENV}/hermes-agent logs`, `${VENV}/hermes-agent doctor now`]) {
    expect([command, classifyAgent(command, "ttys001")?.runtime]).toEqual([command, "hermes"]);
    expect([command, hermesProcessOf(command, "ttys001")]).toEqual([command, { profile: null, gateway: false }]);
  }
});

test("the ACP entry's own management options start no server: acp --check, --setup, --setup-browser and --version are no session", () => {
  for (const flag of ["--check", "--setup", "--setup-browser", "--setup-browser --yes", "--version"]) {
    for (const command of [`hermes acp ${flag}`, `hermes -p work acp ${flag}`, `${PY} ${HERMES} acp ${flag}`, `${PY} -m hermes_cli.main acp ${flag}`,
      `${VENV}/hermes-acp ${flag}`, `${PY} ${VENV}/hermes-acp ${flag}`]) {
      for (const tty of ["ttys001", null]) {
        expect([command, tty, classifyAgent(command, tty)]).toEqual([command, tty, null]);
        expect([command, tty, hermesProcessOf(command, tty)]).toEqual([command, tty, null]);
      }
    }
  }
  // the server itself, with or without the options that only change how it runs
  for (const command of ["hermes acp", "hermes -p work acp --yes", `${VENV}/hermes-acp`, `${PY} ${VENV}/hermes-acp -y`]) {
    expect([command, classifyAgent(command, null)?.runtime]).toEqual([command, "hermes"]);
    expect([command, hermesProcessOf(command, null)?.gateway]).toEqual([command, false]);
  }
});

test("a prompt or a session name that spells a subcommand is free text: the run is a session, never that command", () => {
  for (const [command, profile] of [
    ["hermes -z please update the docs", null],
    ["hermes -z restart the gateway run", null],
    ["hermes -z tail the logs -f", null],
    ["hermes --oneshot why does doctor fail", null],
    ["hermes --oneshot=run the doctor", null],
    ["hermes -zupdate the docs", null],
    ["hermes -c fix the doctor", null], // a quoted name: `ps` joins argv with spaces
    ["hermes -c release notes for the model", null],
    ["hermes --continue=logs", null],
    ["hermes -rmodel", null],
    ["hermes --resume=sessions", null],
    ["hermes chat -q update the model", null],
    ["hermes -m update", null], // a model named update
    ["hermes --provider logs --tui", null],
    ["hermes -p update", "update"], // a profile named update
    ["hermes -p work -z run doctor", "work"],
    [`${PY} ${HERMES} -z please update the docs`, null],
    [`${PY} -m hermes_cli.main -p work -c fix the doctor`, "work"],
  ] as const) {
    expect([command, classifyAgent(command, "ttys001")?.runtime]).toEqual([command, "hermes"]);
    expect([command, hermesProcessOf(command, "ttys001")]).toEqual([command, { profile, gateway: false }]);
  }
});

// Round 12, finding 1: the same goes for the flags that print help or a version. A prompt that ends in a command's own flag
// (`-z git --version`, `-z node -v`, `-z ls -h`) or a session title with one (`-c fix -h handling`) is text, never `hermes --help`:
// reading it as one hides a live session, which the census then retires at every scan or purges at ten minutes.
const FLAG_TEXT = [
  // the natural short prompts: a command and its own help or version flag
  "-z git --version", "-z node -v", "-z python --version", "-z docker -v", "-z tar --help", "-z ls -h",
  // a flag in the middle or at the end of a longer prompt
  "-z what -v does", "-z summarize --help output", "-z explain -h", "-z how --version works", "-z list -V", "-z x -v",
  "--oneshot what -v does", "--oneshot=git --version", "-z=node -v", "-zgit --version",
  // the title or id of a session to resume
  "-c mysession -v", "-c fix -h handling", "-r id --help", "--resume id --help", "--continue=fix -h", "-rid --help", "-cfix -v",
] as const;

test("a prompt or a session title that spells a help or version flag is free text: the run is a session, never a help request", () => {
  for (const launcher of LAUNCHERS) {
    for (const [prefix, profile] of [["", null], [" -p work", "work"], [" -m some-model", null]] as const) {
      for (const tail of FLAG_TEXT) {
        const command = `${launcher}${prefix} ${tail}`;
        expect([command, classifyAgent(command, "ttys001")?.runtime]).toEqual([command, "hermes"]);
        expect([command, hermesProcessOf(command, "ttys001")]).toEqual([command, { profile, gateway: false }]);
      }
    }
  }
  // the one-shot flag still says how it was started, the resume forms do not
  expect(classifyAgent("hermes -z git --version", "ttys001")).toEqual({ runtime: "hermes", launch: "headless" });
  expect(classifyAgent("hermes -c fix -h handling", "ttys001")).toEqual({ runtime: "hermes" });
});

test("a help or version flag before any free text is a real request: no session and no liveness evidence, however Hermes is launched", () => {
  for (const launcher of LAUNCHERS) {
    for (const tail of ["--help", "-h", "--version", "-V", "-p work --help", "-m some-model -h", "--help chat", "-c --version",
      "-h -z hello", "--version -c my title", "-p work -V -z hello"]) {
      for (const tty of ["ttys001", null]) {
        const command = `${launcher} ${tail}`;
        expect([command, tty, classifyAgent(command, tty)]).toEqual([command, tty, null]);
        expect([command, tty, hermesProcessOf(command, tty)]).toEqual([command, tty, null]);
      }
    }
  }
});

test("a version flag after the subcommand is that subcommand's own option, not a version request: `hermes chat -v` is --verbose", () => {
  for (const launcher of LAUNCHERS) {
    for (const tail of ["chat -v", "chat --verbose", "-p work chat -v", "chat -m some-model -v", "chat -q hello -v"]) {
      const command = `${launcher} ${tail}`;
      expect([command, classifyAgent(command, "ttys001")?.runtime]).toEqual([command, "hermes"]);
      expect([command, hermesProcessOf(command, "ttys001")?.gateway]).toEqual([command, false]);
    }
  }
});

test("a management command after options is found past them, and a subcommand's arguments never make it a session", () => {
  for (const command of ["hermes --tui logs", "hermes -m some-model update", "hermes -s a,b doctor", "hermes --reasoning high model",
    "hermes -- logs", "hermes logs chat", "hermes update --check chat", "hermes sessions browse", "hermes model -m chat"]) {
    expect([command, classifyAgent(command, "ttys001")]).toEqual([command, null]);
    expect([command, hermesProcessOf(command, "ttys001")]).toEqual([command, null]);
  }
});

test("a word that is on no list fails open: it stays a session, so a session is never dropped for an option Walkie does not know", () => {
  // A plugin's command, a typo, and the value of an option a newer Hermes added (or an abbreviated one: argparse takes `--prov`
  // for `--provider`) all read as a first word that names no management command.
  for (const command of ["hermes photon status", "hermes frobnicate", "hermes --newflag value chat", "hermes --prov openrouter",
    "hermes --workdir /work/dir", `${PY} ${HERMES} teams_pipeline run`]) {
    expect([command, classifyAgent(command, "ttys001")?.runtime]).toEqual([command, "hermes"]);
    expect([command, hermesProcessOf(command, "ttys001")?.gateway]).toEqual([command, false]);
  }
});

test("the gateway stays evidence for the profile it names, and a gateway prompt is a session, not a gateway", () => {
  for (const [command, kind] of [
    ["hermes gateway run", { profile: null, gateway: true }],
    ["hermes -p work gateway run --replace", { profile: "work", gateway: true }],
    ["hermes gateway", { profile: null, gateway: true }],
    [`${PY} ${HERMES} --profile=work gateway run`, { profile: "work", gateway: true }],
    ["hermes gateway status", null],
    ["hermes gateway stop --all", null],
    ["hermes gateway run --help", null],
    ["hermes -z restart the gateway run", { profile: null, gateway: false }],
  ] as const) {
    expect([command, classifyAgent(command, null)?.runtime ?? null]).toEqual([command, kind && !kind.gateway ? "hermes" : null]);
    expect([command, hermesProcessOf(command, null)]).toEqual([command, kind]);
  }
});

// ---- the census and the cards ------------------------------------------------------------------------------------------
const key = (name: string) => createHash("sha256").update(name).digest("hex");
type World = ReturnType<typeof world>;
const launchd = (w: World) => ({ pid: 1, ppid: 0, uid: 0, startedAt: w.clock.t - 100_000, command: "/sbin/launchd" });
const proc = (w: World, pid: number, command: string, tty: string | null = "ttys002") => ({ pid, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command, tty });
const hermesCards = (w: World) => w.core.store.db.query<{ agent: string }, []>(
  "SELECT DISTINCT author_agent AS agent FROM events WHERE kind = 'agent.status'").all().map((r) => r.agent).filter((agent) => agent.startsWith("hermes-")).sort();
const rowState = (w: World, name: string) => w.core.store.db.query<{ state: string }, [string]>(
  "SELECT state FROM hermes_sessions WHERE session = ?").get(key(name))?.state;
/** A working hook of the default profile, as the daemon route applies it. */
function hookWorking(w: World, name: string) {
  submitHermesUpdate(w.core.statuses, applyHermesStatus(w.core.store, { profile: "default", session: key(name), at: w.clock.t, sequence: 1,
    state: "working", fallback: "working" }, w.clock.t), []);
}

test("management commands in the process list make no ghost card and keep no hooked row live", async () => {
  const cleanups: Array<() => void> = [];
  try {
    const w = world(cleanups);
    hookWorking(w, "hooked");
    w.clock.t += 15_000;
    w.fx.procs = [launchd(w), ...["logs -f", "update", "doctor", "model", "-p default config edit", "sessions list", "cron list", "desktop", "mcp serve"]
      .map((tail, n) => proc(w, 300 + n, `${PY} ${HERMES} ${tail}`))];
    await w.disc().tick();
    expect(hermesCards(w)).toEqual(["hermes-default"]); // the hook's own card, and no `hermes-pid<N>` of a command
    expect(rowState(w, "hooked")).toBe("offline"); // not one of them could own it, so the census retired it
  } finally { while (cleanups.length) cleanups.pop()?.(); }
});

test("beside the management commands, a real session is exactly one card and keeps its hooked row live", async () => {
  const cleanups: Array<() => void> = [];
  try {
    const w = world(cleanups);
    hookWorking(w, "hooked");
    w.clock.t += 15_000;
    w.fx.procs = [launchd(w), proc(w, 300, `${PY} ${HERMES} logs -f`), proc(w, 301, `${PY} ${HERMES} chat`, "ttys001"), proc(w, 302, `${PY} ${HERMES} update`)];
    w.fx.cwds.set(301, w.cwd);
    await w.disc().tick();
    expect(hermesCards(w)).toEqual(["hermes-default", "hermes-pid301"]);
    expect(rowState(w, "hooked")).toBe("working");
  } finally { while (cleanups.length) cleanups.pop()?.(); }
});
