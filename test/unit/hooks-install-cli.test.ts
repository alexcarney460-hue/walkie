// `walkie hooks install|uninstall claude|grok` as a person runs them: a child process with a temp HOME (so the only
// settings files any code can touch are the temp ones) and a PATH of our own making, either with no `claude` on it or
// with a stand-in that only records its arguments. The real claude CLI is never reachable from here.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_EVENTS } from "../../src/hooks/install.ts";

const MAIN = join(import.meta.dir, "../../src/cli/main.ts");

let dir: string;
let home: string;
let noClaudePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "walkie-hooks-cli-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(dir, "walkie"), { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  noClaudePath = `${join(dir, "bin")}:/usr/bin:/bin`;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Run { code: number; out: string }

async function walkie(args: string[], path = noClaudePath): Promise<Run> {
  const child = Bun.spawn([process.execPath, MAIN, ...args], {
    stdout: "pipe", stderr: "pipe",
    env: { PATH: path, NO_COLOR: "1", HOME: home, WALKIE_HOME: join(dir, "walkie") },
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out: (out + err).trim() };
}

/** A `claude` that records its arguments, one call per line, and exits with `addExits` for `mcp add` (0 for anything else). */
function standInClaude(addExits = 0): { path: string; calls: () => string[] } {
  const log = join(dir, "claude-calls.log");
  writeFileSync(join(dir, "bin", "claude"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n[ "$2" = add ] && exit ${addExits}\nexit 0\n`, { mode: 0o755 });
  return { path: noClaudePath, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

const settingsPath = () => join(home, ".claude", "settings.json");
const walkieEvents = () => {
  const hooks = (JSON.parse(readFileSync(settingsPath(), "utf8")) as { hooks?: Record<string, { hooks: { command: string }[] }[]> }).hooks ?? {};
  return Object.entries(hooks).filter(([, entries]) => entries.some((e) => e.hooks.some((h) => h.command.includes("# walkie-managed")))).map(([event]) => event).sort();
};
const ALL_CLAUDE_EVENTS = CLAUDE_EVENTS.map((e) => e.event).sort();

test("the probe PATH has no claude on it (the real CLI is not reachable from these tests)", () => {
  expect(Bun.which("claude", { PATH: noClaudePath })).toBeNull();
});

test("walkie hooks install claude with no claude CLI writes the hooks, skips the MCP step with a note, and exits 0", async () => {
  const r = await walkie(["hooks", "install", "claude"]);
  expect(r.out).not.toContain("failed");
  expect(r.code).toBe(0);
  expect(walkieEvents()).toEqual(ALL_CLAUDE_EVENTS);
  expect(r.out).toContain(settingsPath());
  expect(r.out).toContain("claude mcp add --scope user walkie -- "); // the command to run once Claude Code is installed
  expect(r.out).not.toContain("ran:");
}, 30_000);

test("walkie hooks install claude with the claude CLI registers the MCP server exactly as before", async () => {
  const claude = standInClaude();
  const r = await walkie(["hooks", "install", "claude"], claude.path);
  expect(r.code).toBe(0);
  const calls = claude.calls();
  expect(calls).toHaveLength(2);
  expect(calls[0]).toBe("mcp remove --scope user walkie");
  expect(calls[1]).toStartWith("mcp add --scope user walkie -- ");
  expect(calls[1]).toEndWith(" mcp");
  expect(r.out).toContain("ran: claude mcp add --scope user walkie -- ");
  expect(walkieEvents()).toEqual(ALL_CLAUDE_EVENTS);
}, 30_000);

test("a claude CLI that is present but fails to add the MCP server is still an error", async () => {
  const claude = standInClaude(1);
  const r = await walkie(["hooks", "install", "claude"], claude.path);
  expect(r.code).toBe(1);
  expect(r.out).toContain("claude mcp add failed");
}, 30_000);

test("walkie hooks uninstall claude with no claude CLI removes the hooks and exits 0", async () => {
  await walkie(["hooks", "install", "claude"]);
  const r = await walkie(["hooks", "uninstall", "claude"]);
  expect(r.code).toBe(0);
  expect(walkieEvents()).toEqual([]);
  expect(r.out).not.toContain("ran:");
}, 60_000);

// ---- walkie hooks install|uninstall grok -------------------------------------------------------------------------
// Grok reads Walkie's shared Claude hooks from ~/.claude/settings.json, so `install grok` writes them too, with the
// hooks writer only: no claude CLI is needed and none is ever run.

const grokFile = () => join(home, ".grok", "hooks", "walkie.json");
const walkieHome = () => join(dir, "walkie");
/** What the AGENT-ADMIN-1 audit recorded: the daemon is unreachable here, so the CLI's own local log has it. */
const audited = () => {
  const log = join(walkieHome(), "admin-audit.jsonl");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { action: string }).action) : [];
};

/** The audit log's whole entries (action, and `refused` for an attempt that was refused or failed). */
const auditEntries = () => {
  const log = join(walkieHome(), "admin-audit.jsonl");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { action: string; refused?: string; via: string }) : [];
};

test("walkie hooks install grok on a machine with no claude CLI writes the Grok file and the shared Claude hooks, and exits 0", async () => {
  const r = await walkie(["hooks", "install", "grok"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(readFileSync(grokFile(), "utf8")).hooks).toBeDefined();
  expect(walkieEvents()).toEqual(ALL_CLAUDE_EVENTS);
  expect(r.out).toContain(grokFile());
  expect(r.out).toContain(settingsPath());
  expect(r.out).not.toContain("walkie hooks install claude"); // nothing left for the person to do
  expect(r.out).not.toContain("claude mcp");
  expect(r.out).toContain("compat.claude.hooks"); // what Grok needs to keep on to run the shared hooks
}, 30_000);

test("walkie hooks install grok never runs the claude CLI, even when there is one", async () => {
  const claude = standInClaude();
  const r = await walkie(["hooks", "install", "grok"], claude.path);
  expect(r.code).toBe(0);
  expect(walkieEvents()).toEqual(ALL_CLAUDE_EVENTS);
  expect(claude.calls()).toEqual([]);
}, 30_000);

test("the audit line for install grok names both files it touched; for uninstall, the one", async () => {
  await walkie(["hooks", "install", "grok"]);
  await walkie(["hooks", "uninstall", "grok"]);
  const lines = audited();
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain("installed the Walkie hooks for grok");
  expect(lines[0]).toContain("~/.grok/hooks/walkie.json");
  expect(lines[0]).toContain("~/.claude/settings.json");
  expect(lines[1]).toContain("removed the Walkie hooks for grok");
  expect(lines[1]).toContain("~/.grok/hooks/walkie.json");
  expect(lines[1]).not.toContain("settings.json");
  expect(lines.join("\n")).not.toContain(home); // never an absolute home path
}, 60_000);

test("walkie hooks install grok --dry-run writes neither file and names both", async () => {
  const r = await walkie(["hooks", "install", "grok", "--dry-run"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("would update");
  expect(r.out).toContain(grokFile());
  expect(r.out).toContain(settingsPath());
  expect(existsSync(grokFile())).toBe(false);
  expect(existsSync(settingsPath())).toBe(false);
  expect(audited()).toEqual([]); // a dry run changes nothing and is not audited
  const removal = await walkie(["hooks", "uninstall", "grok", "--dry-run"]);
  expect(removal.code).toBe(0);
  expect(removal.out).toContain("would update");
  expect(removal.out).toContain("walkie hooks uninstall claude");
  expect(existsSync(grokFile())).toBe(false);
}, 30_000);

test("walkie hooks uninstall grok removes only the Grok file's hooks and says Grok keeps reporting through the Claude hooks", async () => {
  await walkie(["hooks", "install", "grok"]);
  const claudeBefore = readFileSync(settingsPath(), "utf8");
  const r = await walkie(["hooks", "uninstall", "grok"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(readFileSync(grokFile(), "utf8"))).toEqual({});
  expect(readFileSync(settingsPath(), "utf8")).toBe(claudeBefore);
  expect(r.out).toContain(grokFile());
  expect(r.out).not.toContain(settingsPath()); // it did not touch that file
  expect(r.out).toContain("Claude hooks");
  expect(r.out).toContain("walkie hooks uninstall claude");
  expect(r.out).toContain("compat.claude.hooks");
  expect(r.out).not.toContain("walkie hooks install claude");
}, 60_000);

test("walkie hooks install grok stops with the Claude settings untouched when they are not valid JSON", async () => {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(settingsPath(), "{ not json");
  const r = await walkie(["hooks", "install", "grok"]);
  expect(r.code).toBe(1);
  expect(r.out).toContain("no changes made");
  expect(readFileSync(settingsPath(), "utf8")).toBe("{ not json");
  expect(existsSync(grokFile())).toBe(false);
}, 30_000);

// ---- the audit line is written AFTER the install, and an attempt that did not succeed is audited as such (final review B) ----
// The line used to be written before the install ran, so a bad settings file ("no changes made") left an audit line saying the hooks were
// installed in both files. The agent gate (agent admin off) still comes first and writes nothing as done.

test("an install that succeeds is audited once, after it ran, as done (no refusal on the line)", async () => {
  const r = await walkie(["hooks", "install", "grok"]);
  expect(r.code).toBe(0);
  const entries = auditEntries();
  expect(entries).toHaveLength(1);
  expect(entries[0]!.action).toMatch(/^installed the Walkie hooks for grok \(/);
  expect(entries[0]).not.toHaveProperty("refused");
  expect(existsSync(grokFile())).toBe(true); // by the time the line exists, the file does
}, 60_000);

test("an install the settings file refuses is audited as failed, with the reason, and never as installed", async () => {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(settingsPath(), "{ not json");
  const r = await walkie(["hooks", "install", "grok"]);
  expect(r.code).toBe(1);
  expect(r.out).toContain("no changes made");
  const entries = auditEntries();
  expect(entries).toHaveLength(1);
  expect(entries[0]!.action).toMatch(/^tried to install the Walkie hooks for grok \(/);
  expect(entries[0]!.refused).toMatch(/^failed: .*no changes made/);
  expect(entries.some((e) => e.action.startsWith("installed"))).toBe(false);
  expect(existsSync(grokFile())).toBe(false);
  expect(readFileSync(settingsPath(), "utf8")).toBe("{ not json");
}, 60_000);

test("a removal that fails is audited as failed too, and a removal that succeeds as removed", async () => {
  await walkie(["hooks", "install", "grok"]);
  const first = auditEntries().length;
  writeFileSync(grokFile(), "{ not json");
  const failed = await walkie(["hooks", "uninstall", "grok"]);
  expect(failed.code).toBe(1);
  const afterFail = auditEntries().slice(first);
  expect(afterFail).toHaveLength(1);
  expect(afterFail[0]!.action).toMatch(/^tried to remove the Walkie hooks for grok \(/);
  expect(afterFail[0]!.refused).toMatch(/^failed: /);
  writeFileSync(grokFile(), "{}");
  expect((await walkie(["hooks", "uninstall", "grok"])).code).toBe(0);
  const afterOk = auditEntries().slice(first + 1);
  expect(afterOk).toHaveLength(1);
  expect(afterOk[0]!.action).toMatch(/^removed the Walkie hooks for grok \(/);
  expect(afterOk[0]).not.toHaveProperty("refused");
}, 90_000);

test("with agent admin off the agent is refused before anything is written, and the refusal is audited as refused", async () => {
  writeFileSync(join(walkieHome(), "config.json"), JSON.stringify({ agent_admin: false }));
  for (const target of ["claude", "grok"]) {
    const r = await walkie(["hooks", "install", target]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("agent admin is off");
  }
  expect(existsSync(settingsPath())).toBe(false);
  expect(existsSync(grokFile())).toBe(false);
  const entries = auditEntries();
  expect(entries).toHaveLength(2);
  for (const entry of entries) {
    expect(entry.refused).toBe("agent_admin_off");
    expect(entry.action).toMatch(/^tried to install the Walkie hooks for (claude|grok)/);
  }
}, 60_000);

test("a dry run is still not audited, and a person at a terminal is never recorded", async () => {
  expect((await walkie(["hooks", "install", "grok", "--dry-run"])).code).toBe(0);
  expect(auditEntries()).toEqual([]);
}, 30_000);

// ---- walkie hooks install|uninstall hermes ---------------------------------------------------------------------------------
// Hermes' hooks go into the config.yaml of the profiles the person names, and no other: a missing --profiles is a usage error
// before the gate, the install and the audit; an install and a removal are audited after they ran, like every other runtime's.

const hermesConfig = () => join(home, ".hermes", "config.yaml");
const withHermesConfig = () => {
  mkdirSync(join(home, ".hermes"), { recursive: true });
  writeFileSync(hermesConfig(), "model: x\n");
};

test("walkie hooks install hermes without --profiles is a usage error: nothing is written and nothing is audited", async () => {
  withHermesConfig();
  const r = await walkie(["hooks", "install", "hermes"]);
  expect(r.code).toBe(1);
  expect(r.out).toContain("Hermes needs --profiles");
  expect(readFileSync(hermesConfig(), "utf8")).toBe("model: x\n");
  expect(auditEntries()).toEqual([]);
}, 30_000);

test("walkie hooks install hermes --profiles writes the named profile's hooks and uninstall removes only those, each audited as done", async () => {
  withHermesConfig();
  const installed = await walkie(["hooks", "install", "hermes", "--profiles", "default"]);
  expect(installed.code).toBe(0);
  expect(installed.out).toContain(hermesConfig());
  expect(installed.out).toContain("Hermes must consent");
  const text = readFileSync(hermesConfig(), "utf8");
  expect(text.startsWith("model: x\n")).toBe(true);
  expect(text).toContain("walkie-hermes:on_session_start");
  expect(text).toContain("hook hermes");
  expect(existsSync(settingsPath())).toBe(false); // Hermes' hooks are in its own profile, never in Claude's settings
  const removed = await walkie(["hooks", "uninstall", "hermes", "--profiles", "default"]);
  expect(removed.code).toBe(0);
  expect(readFileSync(hermesConfig(), "utf8")).toBe("model: x\n");
  const entries = auditEntries();
  expect(entries.map((e) => e.action)).toEqual(["installed the Walkie hooks for hermes", "removed the Walkie hooks for hermes"]);
  for (const entry of entries) expect(entry).not.toHaveProperty("refused");
}, 90_000);

test("an install for a Hermes profile that has no config is audited as failed, with the reason, and writes nothing", async () => {
  const r = await walkie(["hooks", "install", "hermes", "--profiles", "nobody"]);
  expect(r.code).toBe(1);
  expect(r.out).toContain("selected Hermes profile config does not exist");
  expect(existsSync(join(home, ".hermes"))).toBe(false);
  const entries = auditEntries();
  expect(entries).toHaveLength(1);
  expect(entries[0]!.action).toBe("tried to install the Walkie hooks for hermes");
  expect(entries[0]!.refused).toMatch(/^failed: .*does not exist/);
}, 30_000);

test("a Hermes dry run writes nothing and is not audited; with agent admin off an install is refused before anything is written", async () => {
  withHermesConfig();
  const dry = await walkie(["hooks", "install", "hermes", "--profiles", "default", "--dry-run"]);
  expect(dry.code).toBe(0);
  expect(dry.out).toContain("would update");
  expect(readFileSync(hermesConfig(), "utf8")).toBe("model: x\n");
  expect(auditEntries()).toEqual([]);
  writeFileSync(join(walkieHome(), "config.json"), JSON.stringify({ agent_admin: false }));
  const refused = await walkie(["hooks", "install", "hermes", "--profiles", "default"]);
  expect(refused.code).toBe(1);
  expect(refused.out).toContain("agent admin is off");
  expect(readFileSync(hermesConfig(), "utf8")).toBe("model: x\n");
  const entries = auditEntries();
  expect(entries).toHaveLength(1);
  expect(entries[0]!.action).toBe("tried to install the Walkie hooks for hermes");
  expect(entries[0]!.refused).toBe("agent_admin_off");
}, 60_000);

// ---- walkie hooks install hermes --activity ----------------------------------------------------------------------------------------
// Every Hermes profile shows its state only. `--activity name[,name]` lists the profiles whose status may carry activity text, in
// config.json (`hermes_activity_profiles`); `--activity ""` clears the list; no flag leaves it alone. The write goes through the same
// gate and audit line as the hooks themselves.

const walkieConfig = () => join(walkieHome(), "config.json");
const activityList = () => (JSON.parse(readFileSync(walkieConfig(), "utf8")) as { hermes_activity_profiles?: unknown }).hermes_activity_profiles;
const installHermes = (...extra: string[]) => walkie(["hooks", "install", "hermes", "--profiles", "default", ...extra]);

test("--activity writes the list to config.json beside the hooks, keeps every other key, and says what is in force", async () => {
  withHermesConfig();
  writeFileSync(walkieConfig(), JSON.stringify({ share_activity: true, seats: { allow: true } }, null, 2));
  const r = await installHermes("--activity", "research,writer");
  expect(r.code).toBe(0);
  expect(JSON.parse(readFileSync(walkieConfig(), "utf8"))).toEqual({ share_activity: true, seats: { allow: true }, hermes_activity_profiles: ["research", "writer"] });
  expect(statSync(walkieConfig()).mode & 0o777).toBe(0o600);
  expect(r.out).toContain("Activity text is shown for: research, writer. Every other Hermes profile shows its state only.");
  expect(readFileSync(hermesConfig(), "utf8")).toContain("walkie-hermes:on_session_start"); // the hooks went in too
  expect(auditEntries().map((e) => e.action)).toEqual(["installed the Walkie hooks for hermes, with activity text shown for 2 profiles"]);
  expect(auditEntries()[0]).not.toHaveProperty("refused");
}, 60_000);

test("the list is replaced, not added to; --activity \"\" clears it; no flag leaves it alone and says what is in force", async () => {
  withHermesConfig();
  await installHermes("--activity", "research,writer");
  expect((await installHermes("--activity", "writer")).code).toBe(0);
  expect(activityList()).toEqual(["writer"]);
  const kept = await installHermes(); // no --activity: the list stays
  expect(activityList()).toEqual(["writer"]);
  expect(kept.out).toContain("Activity text is shown for: writer.");
  const cleared = await installHermes("--activity", "");
  expect(cleared.code).toBe(0);
  expect(activityList()).toEqual([]);
  expect(cleared.out).toContain("Activity text is hidden for every Hermes profile unless it is listed with --activity name[,name].");
  expect((await installHermes("--activity", "research")).code).toBe(0);
  expect((await installHermes("--activity=")).code).toBe(0); // the --flag= form clears it too
  expect(activityList()).toEqual([]);
  expect(auditEntries().map((e) => e.action)).toEqual([
    "installed the Walkie hooks for hermes, with activity text shown for 2 profiles",
    "installed the Walkie hooks for hermes, with activity text shown for 1 profile",
    "installed the Walkie hooks for hermes", // no --activity: the line says nothing about activity
    "installed the Walkie hooks for hermes, with activity text hidden for every profile",
    "installed the Walkie hooks for hermes, with activity text shown for 1 profile",
    "installed the Walkie hooks for hermes, with activity text hidden for every profile",
  ]);
}, 120_000);

test("a Hermes install with no list written says that activity text is hidden for every profile, and an uninstall says nothing of it", async () => {
  withHermesConfig();
  const installed = await installHermes();
  expect(installed.out).toContain("Activity text is hidden for every Hermes profile unless it is listed with --activity name[,name].");
  expect(existsSync(walkieConfig())).toBe(false); // nothing was asked of config.json
  const removed = await walkie(["hooks", "uninstall", "hermes", "--profiles", "default"]);
  expect(removed.code).toBe(0);
  expect(removed.out).not.toContain("Activity text");
}, 60_000);

test("an invalid --activity is a usage error before anything is written or audited", async () => {
  withHermesConfig();
  const tooMany = Array.from({ length: 65 }, (_, i) => `p${i}`).join(",");
  for (const bad of ["Research", "re search", "re_search", "a".repeat(33), "../x", "research,Writer", tooMany]) {
    const r = await installHermes("--activity", bad);
    expect([bad.slice(0, 12), r.code]).toEqual([bad.slice(0, 12), 1]);
    expect(r.out).toMatch(/--activity (names|names more than)/);
  }
  const notHermes = await walkie(["hooks", "install", "claude", "--activity", "research"]);
  expect(notHermes.code).toBe(1);
  expect(notHermes.out).toContain("--activity is only for hermes");
  expect(existsSync(walkieConfig())).toBe(false);
  expect(readFileSync(hermesConfig(), "utf8")).toBe("model: x\n");
  expect(existsSync(settingsPath())).toBe(false);
  expect(auditEntries()).toEqual([]);
}, 120_000);

test("a dry run with --activity writes neither the hooks nor the list, says what it would do, and is not audited", async () => {
  withHermesConfig();
  writeFileSync(walkieConfig(), JSON.stringify({ hermes_activity_profiles: ["old"] }));
  const set = await installHermes("--activity", "research", "--dry-run");
  expect(set.code).toBe(0);
  expect(set.out).toContain("would set the Hermes profiles that show activity text to: research");
  const clear = await installHermes("--activity", "", "--dry-run");
  expect(clear.out).toContain("would clear the Hermes profiles that show activity text");
  expect(activityList()).toEqual(["old"]);
  expect(readFileSync(hermesConfig(), "utf8")).toBe("model: x\n");
  expect(auditEntries()).toEqual([]);
}, 60_000);

test("with agent admin off the list is refused with the hooks, before anything is written, and the refusal is audited as refused", async () => {
  withHermesConfig();
  writeFileSync(walkieConfig(), JSON.stringify({ agent_admin: false }));
  const r = await installHermes("--activity", "research");
  expect(r.code).toBe(1);
  expect(r.out).toContain("agent admin is off");
  expect(JSON.parse(readFileSync(walkieConfig(), "utf8"))).toEqual({ agent_admin: false });
  expect(readFileSync(hermesConfig(), "utf8")).toBe("model: x\n");
  const entries = auditEntries();
  expect(entries).toHaveLength(1);
  expect(entries[0]!.action).toBe("tried to install the Walkie hooks for hermes, with activity text shown for 1 profile");
  expect(entries[0]!.refused).toBe("agent_admin_off");
}, 60_000);

test("when the hooks cannot be installed the list is not written, and the failure is audited with the list it wanted", async () => {
  writeFileSync(walkieConfig(), JSON.stringify({ hermes_activity_profiles: ["old"] }));
  const r = await walkie(["hooks", "install", "hermes", "--profiles", "nobody", "--activity", "research"]); // no such Hermes profile
  expect(r.code).toBe(1);
  expect(r.out).toContain("selected Hermes profile config does not exist");
  expect(activityList()).toEqual(["old"]);
  const entries = auditEntries();
  expect(entries).toHaveLength(1);
  expect(entries[0]!.action).toBe("tried to install the Walkie hooks for hermes, with activity text shown for 1 profile");
  expect(entries[0]!.refused).toMatch(/^failed: .*does not exist/);
}, 60_000);

test("a config.json that cannot be read as a JSON object counts as agent admin off: the install is refused and the file is left as it was", async () => {
  withHermesConfig();
  for (const content of ["[1]", "null", "{ not json"]) {
    writeFileSync(walkieConfig(), content);
    const r = await installHermes("--activity", "research");
    expect([content, r.code, r.out.includes("agent admin is off")]).toEqual([content, 1, true]);
    expect(readFileSync(walkieConfig(), "utf8")).toBe(content);
  }
  expect(readFileSync(hermesConfig(), "utf8")).toBe("model: x\n"); // a damaged file never lets an agent change what is shared
  const entries = auditEntries();
  expect(entries).toHaveLength(3);
  for (const entry of entries) expect(entry.refused).toBe("agent_admin_off");
}, 120_000);

test("the help says that activity text is hidden for every Hermes profile unless listed with --activity", async () => {
  const r = await walkie(["help"]);
  expect(r.out).toContain("activity text is hidden for every Hermes profile unless listed with --activity name[,name]");
  expect(r.out).toContain('--activity "" clears the list');
}, 30_000);
