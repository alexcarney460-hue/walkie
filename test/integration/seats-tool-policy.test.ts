// Host enforcement of seats.tools (WALK-76). Drives SeatsHost through the seats API with the fake runtimes.
// A spawn that drops Claude's tool flags, or a host that stops refusing Codex, Kimi, and an empty Grok allow
// list, fails here. No model is called.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WalkieClient } from "../../src/client/index.ts";
import { TERMINAL_STATES, type SeatView } from "../../src/protocol/seats.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { signInCodex } from "../helpers/fake-seat-users.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const BUN_DIR = dirname(process.execPath);
const HOOK = "fixture-project-hook";

let cluster: Cluster;
let alex: TestNode;
let arvid: TestNode;
let home: string;
let claudeLog: string;
let codexLog: string;
let kimiLog: string;
let grokLog: string;

const person = (n: TestNode): WalkieClient => n.client("");
const seatOn = async (id: string): Promise<SeatView | undefined> => (await alex.client().seats(id)).seats[0];
const ended = (id: string) => waitFor(async () => {
  const row = await seatOn(id);
  return row && TERMINAL_STATES.has(row.state) ? row : null;
}, { timeoutMs: 20_000, what: `seat ${id} to end` });

function lines(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv[i + 1];
}

/** A git bundle whose work tree carries a project Claude settings file that would turn hooks back on. */
function makeBundle(): string {
  const repo = join(cluster.root, "repo-hooks");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({
    disableAllHooks: false,
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: HOOK }] }] },
  }));
  writeFileSync(join(repo, "README.md"), "hello\n");
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=T", ...args], { cwd: repo, stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  };
  git("init", "-q", "-b", "main");
  git("add", "-f", "README.md", ".claude/settings.json");
  const tracked = Bun.spawnSync(["git", "ls-files"], { cwd: repo, stdout: "pipe" }).stdout.toString();
  if (!tracked.includes(".claude/settings.json")) throw new Error("project settings were not committed");
  git("commit", "-q", "-m", "init");
  const bundle = join(cluster.root, "repo-hooks.bundle");
  git("bundle", "create", bundle, "HEAD", "main");
  return bundle;
}

beforeAll(async () => {
  cluster = new Cluster();
  home = join(cluster.root, "arvid-home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "fixture-access", expiresAt: Date.now() + 8 * 3_600_000, scopes: ["user:inference"] },
  }), { mode: 0o600 });
  signInCodex(home);
  mkdirSync(join(home, ".grok"), { recursive: true });
  writeFileSync(join(home, ".grok", "auth.json"), "fixture", { mode: 0o600 });
  const bin = join(cluster.root, "seat-bin");
  mkdirSync(bin);
  for (const [dir, name] of [["fake-claude", "claude"], ["fake-codex", "codex"], ["fake-kimi", "kimi"], ["fake-grok", "grok"]] as const) {
    symlinkSync(join(FIXTURES, dir, name), join(bin, name));
  }
  claudeLog = join(cluster.root, "claude.jsonl");
  codexLog = join(cluster.root, "codex.jsonl");
  kimiLog = join(cluster.root, "kimi.jsonl");
  grokLog = join(cluster.root, "grok.jsonl");
  alex = await cluster.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  arvid = await cluster.add({
    name: "arvid", login: "arvid@example.com", hostname: "arvid-mac",
    seats: {
      flushMs: 50, launchesPerMinute: 100,
      env: {
        PATH: `${bin}:${BUN_DIR}:/usr/bin:/bin`, HOME: home,
        FAKE_CLAUDE_LOG: claudeLog, FAKE_CLAUDE_STATE: join(cluster.root, "claude-state"),
        FAKE_CODEX_LOG: codexLog, FAKE_KIMI_LOG: kimiLog, FAKE_GROK_LOG: grokLog,
      },
    },
  });
  await alex.client().init("aka", "alex");
  await alex.client().invite("arvid@example.com", "arvid", "member");
  expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
  const { local } = await person(arvid).seatsConfig({
    allow: true, same_user: true, runtimes: ["claude", "codex", "kimi", "grok"],
    env: ["FAKE_CLAUDE_LOG", "FAKE_CLAUDE_STATE", "FAKE_CODEX_LOG", "FAKE_KIMI_LOG", "FAKE_GROK_LOG"],
    tools: { allow: ["Read", "Grep"], deny: ["WebFetch"] },
  });
  expect(local.tools).toEqual({ allow: ["Read", "Grep"], deny: ["WebFetch"] });
  await waitFor(() => alex.d.sync.peerCapabilities(arvid.d.nodeId)?.caps.includes("seats_v2") ?? false, { what: "seats v2" });
  await waitFor(async () => (await alex.client().seats()).hosts.find((h) => h.node === arvid.d.nodeId && h.allows && h.member), { what: "seat host" });
}, 90_000);

afterAll(async () => { await cluster?.close(); });

describe.serial("SeatsHost enforces the tool allow-list at spawn", () => {
  test("a Claude seat argv carries the tool flags and ignores project settings", async () => {
    const bundle = makeBundle();
    const hash = (await person(alex).seatsBundle(new Uint8Array(readFileSync(bundle)))).hash;
    const run = await person(alex).seatRun({ machine: "arvid-mac", runtime: "claude", prompt: "list the files", bundle: hash });
    const done = await ended(run.seat);
    expect(done.state).toBe("done");
    const launch = lines(claudeLog).find((row) => Array.isArray(row.argv)) as { argv: string[]; cwd: string } | undefined;
    expect(launch).toBeDefined();
    const argv = launch!.argv;
    expect(argv).toContain("--tools=Read,Grep");
    expect(argv).toContain("--allowedTools=Read,Grep");
    expect(argv).toContain("--disallowedTools=WebFetch");
    expect(argv).toContain("--strict-mcp-config");
    expect(flagValue(argv, "--setting-sources")).toBe("user");
    expect(argv).not.toContain("--settings");
    expect(argv.some((arg) => arg.startsWith("--settings"))).toBe(false);
    expect(argv.filter((arg) => arg === "--setting-sources").length).toBe(1);
    const prompt = flagValue(argv, "--append-system-prompt") ?? "";
    expect(prompt).toContain("CLAUDE.md");
    expect(prompt).toContain("AGENTS.md");
    expect(prompt).toContain("within the brief");
    expect(argv.join("\n")).not.toContain(HOOK);
    const projectSettings = join(realpathSync(launch!.cwd), ".claude", "settings.json");
    expect(JSON.parse(readFileSync(projectSettings, "utf8")).disableAllHooks).toBe(false);
    expect(readFileSync(projectSettings, "utf8")).toContain(HOOK);
  }, 60_000);

  test("Codex and Kimi launches are refused before a runtime starts", async () => {
    const codexBefore = lines(codexLog).length;
    const kimiBefore = lines(kimiLog).length;
    const codex = await person(alex).seatRun({ machine: "arvid-mac", runtime: "codex", prompt: "hi" });
    const kimi = await person(alex).seatRun({ machine: "arvid-mac", runtime: "kimi", brief: "fixture", permission_mode: "bypassPermissions" });
    const codexEnded = await ended(codex.seat);
    const kimiEnded = await ended(kimi.seat);
    expect(codexEnded.state).toBe("refused");
    expect(codexEnded.reason).toContain("no per-launch tool flags");
    expect(kimiEnded.state).toBe("refused");
    expect(kimiEnded.reason).toContain("no tool flags");
    expect(lines(codexLog).length).toBe(codexBefore);
    expect(lines(kimiLog).length).toBe(kimiBefore);
  }, 60_000);

  test("Grok maps Read and Grep, and an empty allow list is refused before spawn", async () => {
    const mapped = await person(alex).seatRun({ machine: "arvid-mac", runtime: "grok", brief: "fixture map", permission_mode: "default" });
    const mappedEnded = await ended(mapped.seat);
    expect(mappedEnded.state).toBe("done");
    const launch = lines(grokLog).at(-1) as { argv: string[]; brief: string } | undefined;
    expect(launch?.brief).toBe("fixture map");
    expect(launch?.argv.slice(launch.argv.indexOf("--tools"), launch.argv.indexOf("--tools") + 2)).toEqual(["--tools", "read_file,grep"]);
    expect(launch?.argv).not.toContain("");
    const before = lines(grokLog).length;
    await person(arvid).seatsConfig({ allow: true, tools: { allow: [] } });
    const empty = await person(alex).seatRun({ machine: "arvid-mac", runtime: "grok", brief: "fixture empty", permission_mode: "bypassPermissions" });
    const emptyEnded = await ended(empty.seat);
    expect(emptyEnded.state).toBe("refused");
    expect(emptyEnded.reason).toContain("empty --tools");
    expect(lines(grokLog).length).toBe(before);
    // A space is rejected by the schema. This pattern has none, so it stores, and Grok refuses it.
    await person(arvid).seatsConfig({ allow: true, tools: { allow: ["Bash(git:*)"] } });
    const pattern = await person(alex).seatRun({
      machine: "arvid-mac", runtime: "grok", brief: "fixture pattern", permission_mode: "acceptEdits",
    });
    const patternEnded = await ended(pattern.seat);
    expect(patternEnded.state).toBe("refused");
    expect(patternEnded.reason).toContain("Bash(git:*)");
    expect(lines(grokLog).length).toBe(before);
    // grok 1.0.46 treats this id as every tool. The launch must be refused before spawn.
    await person(arvid).seatsConfig({ allow: true, tools: { allow: ["run_terminal_command"] } });
    const shell = await person(alex).seatRun({
      machine: "arvid-mac", runtime: "grok", brief: "fixture shell", permission_mode: "bypassPermissions",
    });
    const shellEnded = await ended(shell.seat);
    expect(shellEnded.state).toBe("refused");
    expect(shellEnded.reason).toContain("run_terminal_command");
    expect(lines(grokLog).length).toBe(before);
    await person(arvid).seatsConfig({ allow: true, tools: { allow: ["read_file"], deny: ["run_terminal_command"] } });
    const denied = await person(alex).seatRun({
      machine: "arvid-mac", runtime: "grok", brief: "fixture deny shell", permission_mode: "bypassPermissions",
    });
    const deniedEnded = await ended(denied.seat);
    expect(deniedEnded.state).toBe("done");
    const deniedLaunch = lines(grokLog).at(-1) as { argv: string[]; brief: string } | undefined;
    expect(deniedLaunch?.brief).toBe("fixture deny shell");
    const deniedDenies = deniedLaunch?.argv.flatMap((arg, i) => arg === "--deny" ? [deniedLaunch.argv[i + 1]] : []) ?? [];
    expect(deniedDenies).toContain("Bash");
    expect(deniedDenies).not.toContain("run_terminal_command");
    expect(deniedLaunch?.argv.slice(deniedLaunch.argv.indexOf("--tools"), deniedLaunch.argv.indexOf("--tools") + 2)).toEqual(["--tools", "read_file"]);
  }, 60_000);

  test("an unverified or unreadable grok version refuses a policy launch before spawn", async () => {
    const bin = join(cluster.root, "seat-bin", "grok");
    const saved = readlinkSync(bin);
    const swap = (body: string) => {
      const path = join(cluster.root, `grok-ver-${Date.now()}`);
      writeFileSync(path, `#!/bin/sh\n${body}`, { mode: 0o755 });
      rmSync(bin);
      symlinkSync(path, bin);
    };
    const policy = await import("../../src/daemon/seats/tool-policy.ts");
    if (typeof policy.clearGrokVersionCache === "function") policy.clearGrokVersionCache();
    try {
      swap("if [ \"$1\" = \"--version\" ]; then echo 'grok 9.9.9 (fixture)'; exit 0; fi\nexit 2\n");
      if (typeof policy.clearGrokVersionCache === "function") policy.clearGrokVersionCache();
      const before = lines(grokLog).length;
      const unverified = await person(alex).seatRun({
        machine: "arvid-mac", runtime: "grok", brief: "fixture unverified version", permission_mode: "bypassPermissions",
      });
      const unverifiedEnded = await ended(unverified.seat);
      expect(unverifiedEnded.state).toBe("refused");
      expect(unverifiedEnded.reason).toContain("9.9.9");
      expect(unverifiedEnded.reason).toContain("cannot be enforced");
      expect(lines(grokLog).length).toBe(before);
      swap("if [ \"$1\" = \"--version\" ]; then echo nope; exit 0; fi\nexit 2\n");
      if (typeof policy.clearGrokVersionCache === "function") policy.clearGrokVersionCache();
      const unparsed = await person(alex).seatRun({
        machine: "arvid-mac", runtime: "grok", brief: "fixture unparsed version", permission_mode: "acceptEdits",
      });
      const unparsedEnded = await ended(unparsed.seat);
      expect(unparsedEnded.state).toBe("refused");
      expect(unparsedEnded.reason).toContain("nope");
      expect(unparsedEnded.reason).toContain("cannot be enforced");
      expect(lines(grokLog).length).toBe(before);
    } finally {
      rmSync(bin);
      symlinkSync(saved, bin);
      if (typeof policy.clearGrokVersionCache === "function") policy.clearGrokVersionCache();
    }
    const restored = await person(alex).seatRun({
      machine: "arvid-mac", runtime: "grok", brief: "fixture verified version", permission_mode: "bypassPermissions",
    });
    const restoredEnded = await ended(restored.seat);
    expect(restoredEnded.state).toBe("done");
    const launch = lines(grokLog).at(-1) as { argv: string[]; brief: string } | undefined;
    expect(launch?.brief).toBe("fixture verified version");
    expect(launch?.argv).toContain("read_file");
  }, 60_000);
});
