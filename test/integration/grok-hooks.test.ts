// Walkie's two Grok hook paths, end to end: the real installers write the hook files Grok scans, a stand-in for Grok's
// dispatch (test/helpers/grok-dispatch.ts) runs the handlers those files register against a real daemon, and every
// report is counted: how many hook processes reported, how many the daemon applied, how many it dropped as a repeat.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GROK_EVENTS, type GrokPath } from "../../src/hooks/grok-events.ts";
import { grokCommand, installGrok, withGrokHooks } from "../../src/hooks/install-grok.ts";
import { withClaudeHooks, type HookEntry, type Settings } from "../../src/hooks/install.ts";
import { Cluster, TEST_LIMITS, type TestNode } from "../helpers/cluster.ts";
import { GrokDispatcher, readJsonFile, recordStatuses, writeJsonFile, type GrokEventSpec, type Outcome } from "../helpers/grok-dispatch.ts";

const MAIN = join(import.meta.dir, "../../src/cli/main.ts");
const BASH = "run_terminal_command"; // Grok's name for the shell tool (Claude's Bash)
const spec = (name: string, tool?: string, extra?: Record<string, unknown>, session?: true): GrokEventSpec => {
  const event = GROK_EVENTS.find((e) => e.name === name);
  if (!event) throw new Error(`not a Grok event Walkie reports: ${name}`);
  return { name, snake: event.snake, ...(tool ? { tool } : {}), ...(session ? { session } : {}), ...(extra ? { extra } : {}) };
};

/** One of each Grok event Walkie reports, in the order a session produces them. */
const EVENTS: GrokEventSpec[] = [
  spec("SessionStart"),
  spec("UserPromptSubmit", undefined, { prompt: "fix the build" }),
  spec("PreToolUse", BASH, { toolInput: { command: "sleep 1" } }),
  spec("PostToolUse", BASH, { toolInput: { command: "sleep 1" } }),
  spec("PostToolUseFailure", BASH, { toolInput: { command: "false" } }),
  spec("Notification", undefined, { notificationType: "idle_prompt" }, true),
  spec("Stop"),
  spec("StopFailure"),
  spec("StopCancelled"),
  spec("Stop", undefined, { reason: "shutdown" }, true), // the extra Stop at session end
  spec("SessionEnd"),
];
/** A sub-agent launch: the one tool call the Claude install's PreToolUse entry (matcher Agent|Task) also fits. */
const LAUNCH = spec("PreToolUse", "spawn_subagent", { toolInput: {} });
const label = (s: GrokEventSpec) => `${s.name}${s.tool ? ` (${s.tool})` : ""}${s.session ? " (session)" : ""}`;
const ownerOf = (s: GrokEventSpec): GrokPath => GROK_EVENTS.find((e) => e.name === s.name)?.path ?? "native";
const once: Outcome = { sent: 1, applied: 1, repeats: 0 };
const never: Outcome = { sent: 0, applied: 0, repeats: 0 };

let c: Cluster;
let node: TestNode;
let rec: ReturnType<typeof recordStatuses>;
let seq = 0;
const saved = { home: process.env.WALKIE_HOME, socket: process.env.WALKIE_SOCKET };
const bin = (name: string) => join(c.root, "bin", name);

beforeAll(async () => {
  c = new Cluster();
  node = await c.add({ name: "solo", login: "solo@example.com", hostname: "solo-mbp", limits: { ...TEST_LIMITS, status: { capacity: 10_000, perSecond: 10_000 } } });
  await node.client().init("acme", "solo");
  process.env.WALKIE_HOME = node.home; // hooks resolve their socket and state from the environment, like a real session
  process.env.WALKIE_SOCKET = node.socket;
  mkdirSync(join(c.root, "bin"), { recursive: true });
  for (const name of ["walkie-a", "walkie-b", "noop"]) writeFileSync(bin(name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  rec = recordStatuses();
});
afterAll(async () => {
  rec.stop();
  if (saved.home === undefined) delete process.env.WALKIE_HOME; else process.env.WALKIE_HOME = saved.home;
  if (saved.socket === undefined) delete process.env.WALKIE_SOCKET; else process.env.WALKIE_SOCKET = saved.socket;
  await c.close();
});

/** A fresh Grok home and session; every scenario has its own agent, so none sees another's state. */
function scenario(): GrokDispatcher {
  const n = ++seq;
  return new GrokDispatcher(join(c.root, `home${n}`), `${String(n).padStart(3, "0")}abc-${n}`);
}

type Action = "claude" | "grok" | "remove-claude" | "remove-grok";
async function act(g: GrokDispatcher, action: Action): Promise<void> {
  if (action === "claude" || action === "remove-claude") {
    writeJsonFile(g.claudeSettings, withClaudeHooks(readJsonFile<Settings>(g.claudeSettings, {}), JSON.stringify(bin("walkie-a")), action === "claude"));
  } else {
    // Both files are this scenario's own (a temp home): `install grok` also writes the shared Claude hooks, and the default for
    // that file is the real ~/.claude/settings.json, which no test may ever write.
    await installGrok({ dryRun: false, uninstall: action === "remove-grok", paths: { hooks: join(g.hooksDir, "walkie.json"), claudeSettings: g.claudeSettings } });
  }
}

/** A Grok hook file naming `command` for each of `events`, for every tool. */
function nativeFile(command: string, events: readonly string[]): Settings {
  return { hooks: Object.fromEntries(events.map((e): [string, HookEntry[]] => [e, [{ hooks: [{ type: "command", command, timeout: 5 }] }]])) };
}
const walkieHook = (exe: string) => `${grokCommand([exe])} hook grok # walkie-managed`;

async function outcomes(g: GrokDispatcher, specs: GrokEventSpec[] = [...EVENTS, LAUNCH]): Promise<Record<string, Outcome>> {
  const out: Record<string, Outcome> = {};
  for (const s of specs) out[label(s)] = await g.dispatch(s, rec);
  return out;
}

describe("install and uninstall orders", () => {
  const orders: { actions: Action[]; claude: boolean; grok: boolean }[] = [
    { actions: ["claude", "grok"], claude: true, grok: true },
    { actions: ["grok", "claude"], claude: true, grok: true },
    { actions: ["claude", "grok", "remove-claude"], claude: false, grok: true },
    { actions: ["grok", "claude", "remove-grok"], claude: true, grok: false },
  ];
  for (const o of orders) {
    test(`${o.actions.join(", ")}: each event is reported once by the path that owns it, and by no other`, async () => {
      const g = scenario();
      for (const a of o.actions) await act(g, a);
      for (const s of [...EVENTS, LAUNCH]) {
        const installed = ownerOf(s) === "claude" ? o.claude : o.grok;
        expect(await g.dispatch(s, rec), label(s)).toEqual(installed ? once : never);
      }
    });
  }
});

describe("a Bash pre-use", () => {
  test("gets exactly one update, from the native hook, with both paths installed", async () => {
    const g = scenario();
    await act(g, "claude");
    await act(g, "grok");
    const bash = spec("PreToolUse", BASH, { toolInput: { command: "sleep 1" } });
    // Only the native hook is registered for it: the Claude entry's matcher (Agent|Task) does not fit a shell call.
    expect(g.handlers("PreToolUse", BASH)).toHaveLength(1);
    expect(g.handlers("PreToolUse", BASH)[0]).toContain(" hook grok ");
    expect(await g.dispatch(bash, rec)).toEqual(once);
  });

  test("a sub-agent launch, which both registrations fit, still gets one update", async () => {
    const g = scenario();
    await act(g, "claude");
    await act(g, "grok");
    expect(g.handlers("PreToolUse", "spawn_subagent")).toHaveLength(2); // both hooks run for it ...
    expect(await g.dispatch(LAUNCH, rec)).toEqual(once); // ... and the Claude-compatible one stands down
  });
});

describe("stale and foreign hook files", () => {
  test("a stale native config pointing at a removed binary changes nothing", async () => {
    const before = scenario();
    await act(before, "claude");
    const baseline = await outcomes(before);

    const stale = scenario();
    await act(stale, "claude");
    writeJsonFile(join(stale.hooksDir, "walkie.json"), nativeFile(walkieHook(bin("removed")), GROK_EVENTS.map((e) => e.name)));
    expect(await outcomes(stale)).toEqual(baseline);
    // What the Claude-compatible hook owns is still reported once each.
    for (const s of EVENTS) expect(baseline[label(s)], label(s)).toEqual(ownerOf(s) === "claude" ? once : never);
  });

  test("the native hook installed from one valid Walkie path and the Claude hook from another report each event once", async () => {
    const g = scenario();
    await act(g, "claude"); // walkie-a
    writeJsonFile(join(g.hooksDir, "walkie.json"), withGrokHooks({}, grokCommand([bin("walkie-b")]), true));
    for (const s of [...EVENTS, LAUNCH]) expect(await g.dispatch(s, rec), label(s)).toEqual(once);
  });

  test("a runnable native program that reports nothing silences nothing", async () => {
    const g = scenario();
    await act(g, "claude");
    writeJsonFile(join(g.hooksDir, "walkie.json"), nativeFile(walkieHook(bin("noop")), GROK_EVENTS.map((e) => e.name)));
    for (const s of EVENTS) expect(await g.dispatch(s, rec), label(s)).toEqual(ownerOf(s) === "claude" ? once : never);
  });

  test("a hook file from an earlier build that registers every event adds no second report", async () => {
    const g = scenario();
    await act(g, "claude");
    writeJsonFile(join(g.hooksDir, "walkie.json"), nativeFile(walkieHook(bin("walkie-b")), GROK_EVENTS.map((e) => e.name)));
    for (const s of [...EVENTS, LAUNCH]) expect(await g.dispatch(s, rec), label(s)).toEqual(once);
  });
});

describe("one path registered twice", () => {
  test("the daemon applies each event once and drops the repeat", async () => {
    const g = scenario();
    await act(g, "grok");
    // Two Walkie installs in one Claude settings file: two handlers of the same path for every event it registers.
    const a = withClaudeHooks({}, JSON.stringify(bin("walkie-a")), true).hooks ?? {};
    const b = withClaudeHooks({}, JSON.stringify(bin("walkie-b")), true).hooks ?? {};
    writeJsonFile(g.claudeSettings, { hooks: Object.fromEntries(Object.keys(a).map((e) => [e, [...(a[e] ?? []), ...(b[e] ?? [])]])) });
    for (const s of [...EVENTS, LAUNCH]) {
      const expected: Outcome = ownerOf(s) === "claude" ? { sent: 2, applied: 1, repeats: 1 } : once;
      expect(await g.dispatch(s, rec), label(s)).toEqual(expected);
    }
  });

  test("two events of one instant are two deliveries, and one event delivered twice is one", async () => {
    const g = scenario();
    await act(g, "claude");
    const post = spec("PostToolUse", BASH, { toolInput: { command: "ls" } });
    const at = "2026-10-01T01:00:00Z";
    expect(await g.dispatch(post, rec, { at, call: "parallel-1" })).toEqual(once);
    expect(await g.dispatch(post, rec, { at, call: "parallel-2" })).toEqual(once);
    expect(await g.dispatch(post, rec, { at, call: "parallel-1" })).toEqual({ sent: 1, applied: 0, repeats: 1 });
  });

  test("two notifications of one instant and of different types are two deliveries, and one delivered twice is one", async () => {
    const g = scenario();
    await act(g, "claude");
    const note = (notificationType: string) => spec("Notification", undefined, { notificationType }, true);
    const at = "2026-10-01T02:00:00Z";
    expect(await g.dispatch(note("permission_prompt"), rec, { at })).toEqual(once);
    expect(await g.dispatch(note("idle_prompt"), rec, { at })).toEqual(once);
    expect(await g.dispatch(note("idle_prompt"), rec, { at })).toEqual({ sent: 1, applied: 0, repeats: 1 });
  });
});

/** The real `walkie` CLI against this scenario's home, on a PATH with no claude on it: a machine with only Grok. */
async function walkieCli(g: GrokDispatcher, args: string[]): Promise<{ code: number; out: string }> {
  const path = `${join(c.root, "bin")}:/usr/bin:/bin`;
  expect(Bun.which("claude", { PATH: path }), "the real claude CLI must not be reachable from this test").toBeNull();
  mkdirSync(g.home, { recursive: true });
  const child = Bun.spawn([process.execPath, MAIN, ...args], {
    stdout: "pipe", stderr: "pipe",
    env: { PATH: path, NO_COLOR: "1", HOME: g.home, WALKIE_HOME: join(g.home, ".walkie") },
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out: (out + err).trim() };
}

describe("a machine with only Grok (no claude CLI)", () => {
  test("walkie hooks install grok gives the whole lifecycle, each event reported once, and uninstall grok leaves the six shared events", async () => {
    const g = scenario();
    const installed = await walkieCli(g, ["hooks", "install", "grok"]);
    expect(installed.code, installed.out).toBe(0);
    expect(existsSync(join(g.hooksDir, "walkie.json"))).toBe(true);
    expect(existsSync(g.claudeSettings)).toBe(true);
    for (const s of [...EVENTS, LAUNCH]) expect(await g.dispatch(s, rec), label(s)).toEqual(once);

    const removed = await walkieCli(g, ["hooks", "uninstall", "grok"]);
    expect(removed.code, removed.out).toBe(0);
    const reported = new Set<string>();
    const silent = new Set<string>();
    for (const s of [...EVENTS, LAUNCH]) {
      const outcome = await g.dispatch(s, rec);
      expect(outcome, label(s)).toEqual(ownerOf(s) === "claude" ? once : never);
      (outcome.sent ? reported : silent).add(s.name);
    }
    expect([...reported].sort()).toEqual(["Notification", "PostToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);
    expect([...silent].sort()).toEqual(["PostToolUseFailure", "PreToolUse", "StopCancelled", "StopFailure"]);
  });

  test("install grok on a machine that already has the Claude hooks adds the four native events and repeats none", async () => {
    const g = scenario();
    await act(g, "claude");
    for (const s of [...EVENTS, LAUNCH]) expect(await g.dispatch(s, rec), label(s)).toEqual(ownerOf(s) === "claude" ? once : never);
    const installed = await walkieCli(g, ["hooks", "install", "grok"]);
    expect(installed.code, installed.out).toBe(0);
    for (const s of [...EVENTS, LAUNCH]) expect(await g.dispatch(s, rec), label(s)).toEqual(once);
  });
});
