// AGENT-ADMIN-1 units: the switches as config.json holds them, the remote allow-list, the CLI's remote call split.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSwitches, writeSwitch } from "../../src/daemon/admin/switches.ts";
import { remoteArgvProblem } from "../../src/protocol/admin.ts";
import { splitRemote } from "../../src/cli/commands/admin.ts";
import { auditText } from "../../src/daemon/admin/audit.ts";

const dirs: string[] = [];
const cfg = (content?: string) => {
  const d = mkdtempSync("/tmp/walkie-sw-");
  dirs.push(d);
  const p = join(d, "config.json");
  if (content !== undefined) writeFileSync(p, content);
  return p;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test("switches: absent file or keys = on (existing installs migrate to on); false = off; unreadable = off", () => {
  expect(readSwitches(cfg())).toEqual({ agent_admin: true, remote_admin: true });
  expect(readSwitches(cfg(JSON.stringify({ peer_port: 7458 })))).toEqual({ agent_admin: true, remote_admin: true });
  expect(readSwitches(cfg(JSON.stringify({ agent_admin: false })))).toEqual({ agent_admin: false, remote_admin: true });
  expect(readSwitches(cfg("{not json"))).toEqual({ agent_admin: false, remote_admin: false });
  const p = cfg(JSON.stringify({ peer_port: 7000 }));
  expect(writeSwitch(p, "remote_admin", false)).toEqual({ agent_admin: true, remote_admin: false });
});

test("remote allow-list: walkie subcommands only, no stdin, no program paths, switches only off", () => {
  expect(remoteArgvProblem(["seats", "enable", "--yes", "--same-user", "--max", "12", "--launchers", "@alex"])).toBeNull();
  expect(remoteArgvProblem(["hooks", "install", "all"])).toBeNull();
  expect(remoteArgvProblem(["agents", "admin", "off"])).toBeNull();
  expect(remoteArgvProblem(["admin", "remote", "off"])).toBeNull();
  expect(remoteArgvProblem(["admin", "remote", "on"])).toContain("only be turned off");
  expect(remoteArgvProblem(["agents", "admin", "on"])).toContain("only be turned off");
  expect(remoteArgvProblem(["admin", "--machine", "x", "seats", "doctor"])).not.toBeNull();
  expect(remoteArgvProblem(["admin", "log", "--machines=all"])).toContain("further machines");
  expect(remoteArgvProblem(["sh", "-c", "id"])).toContain("can't run remotely");
  expect(remoteArgvProblem(["post", "#general", "x"])).toContain("can't run remotely");
  expect(remoteArgvProblem(["accounts", "exec", "--", "id"])).toContain("can't run remotely");
  expect(remoteArgvProblem(["accounts", "add", "codex"])).toContain("browser");
  expect(remoteArgvProblem(["integrations", "enable", "linear", "--key", "-"])).toContain("--key");
  expect(remoteArgvProblem(["orchestrator", "start", "--claude", "/tmp/evil"])).toContain("--claude");
  expect(remoteArgvProblem(["seats", "token", "set"])).toContain("can't run remotely");
  expect(remoteArgvProblem(["seats", "enable", "a\nb"])).toContain("line break");
  expect(remoteArgvProblem([])).toBe("no command");
});

test("seats allow --dir: a leading ~ or an absolute path are fine remotely; a relative one is refused (the target's spawned admin run's cwd isn't meaningful)", () => {
  expect(remoteArgvProblem(["seats", "allow", "--dir", "~/walkie-seats"])).toBeNull();
  expect(remoteArgvProblem(["seats", "allow", "--dir=~"])).toBeNull();
  expect(remoteArgvProblem(["seats", "allow", "--dir", "/Users/kira/walkie-seats"])).toBeNull();
  expect(remoteArgvProblem(["seats", "allow"])).toBeNull(); // --dir left out entirely: fine, keeps its value
  expect(remoteArgvProblem(["seats", "allow", "--dir", "walkie-seats"])).toContain("absolute path or start with ~/");
  expect(remoteArgvProblem(["seats", "allow", "--dir", "../walkie-seats"])).toContain("absolute path or start with ~/");
  expect(remoteArgvProblem(["seats", "allow", "--dir=relative/seats"])).toContain("absolute path or start with ~/");
});

test("the CLI split: leading --machine/--machines/--timeout/--json belong to walkie admin; the rest passes through", () => {
  expect(splitRemote(["status"])).toBeNull();
  expect(splitRemote(["--machine", "almond-wsl", "seats", "enable", "--yes", "--max", "12", "--json"])).toEqual({
    machines: "almond-wsl", json: false, forAgent: false, argv: ["seats", "enable", "--yes", "--max", "12", "--json"],
  });
  expect(splitRemote(["--machines=all-mine", "--json", "--timeout", "600", "--", "hooks", "install", "all"])).toEqual({
    machines: "all-mine", timeout_s: 600, json: true, forAgent: false, argv: ["hooks", "install", "all"],
  });
  expect(() => splitRemote(["--machine", "x"])).toThrow(/name the walkie command/);
  expect(() => splitRemote(["--machine", "x", "--timeout", "0", "seats"])).toThrow(/--timeout/);
});

test("audit line: actor, remote marker, machine; secrets in a command line are redacted", () => {
  const t = auditText({ actor: "@alex/alex-mbp/cc-1", action: ("ran `walkie integrations enable linear --key-path sk" + "-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`"), machine: "kiras-mbp", via: "remote" });
  expect(t.startsWith("[admin] @alex/alex-mbp/cc-1 (remote) on kiras-mbp: ran")).toBe(true);
  expect(t).not.toContain(("sk" + "-ant-api03-AAAA"));
});

// ---- fix round 2 ---------------------------------------------------------------------------------------------------

import { parseArgs } from "../../src/cli/args.ts";
import { CLI_BOOLEANS } from "../../src/cli/booleans.ts";
import { canonicalArgv, REMOTE_COMMANDS } from "../../src/protocol/admin.ts";
import { adoptRemoteRun, remoteRunToken, resetRemoteRunForTests } from "../../src/client/remote-run.ts";
import { claimSlot, MAX_RUNS, MAX_RUNS_PER_CALLER } from "../../src/daemon/admin/runs.ts";
import type { Core } from "../../src/daemon/core.ts";

const LEADING: string[][] = [["--json"], ["--yes"], ["-j"], ["--max=12"], ["--launchers", "@a"], ["--json", "--yes"], ["--for-agent=true"]];
const HIDDEN = ["exec", "trust-cli", "start", "token", "remove", "anything", "export", "configure", "run-shell"];

test("Opus HIGH / Codex HIGH 1: a leading flag never hides the subcommand; what is checked is what the CLI parses", () => {
  const withEmpty = Object.entries(REMOTE_COMMANDS).filter(([, subs]) => subs.includes("")).map(([cmd]) => cmd);
  expect(withEmpty.sort()).toEqual(["accounts", "admin", "doctor", "integrations", "pool", "seats"]);
  for (const cmd of withEmpty) {
    for (const lead of LEADING) {
      for (const sub of HIDDEN) {
        const argv = [cmd, ...lead, sub, "x"];
        const parsedSub = parseArgs(argv.slice(1), CLI_BOOLEANS).pos[0];
        expect(parsedSub).toBe(sub); // the parser the running walkie uses sees the hidden word as the subcommand…
        const allowed = (REMOTE_COMMANDS[cmd] as readonly string[]).includes(sub);
        // …and so does the allow-list: refused unless that very subcommand is listed (and never exec / trust-cli).
        expect([argv.join(" "), remoteArgvProblem(argv) === null]).toEqual([argv.join(" "), allowed && !(cmd === "accounts" && ["exec", "trust-cli"].includes(sub))]);
      }
    }
  }
  expect(remoteArgvProblem(["accounts", "--json", "exec", "--", "sh"])).toContain("can't run remotely");
  expect(remoteArgvProblem(["seats", "--yes", "start", "m", "--prompt", "x"])).toContain("seats start");
  expect(remoteArgvProblem(["seats", "-j", "token"])).toContain("seats token");
  expect(remoteArgvProblem(["admin", "--json", "remote", "on"])).toContain("only be turned off");
  expect(remoteArgvProblem(["seats", "--launchers"])).toContain("don't parse");
});

test("the canonical form parses back to the same positionals and flags, and is itself allowed", () => {
  for (const argv of [
    ["seats", "enable", "--yes", "--same-user", "--max", "12", "--launchers", "@alex,@alex/alex-mbp/cc-1"],
    ["seats", "-j", "list"], ["hooks", "install", "all", "--dry-run"], ["accounts", "policy", "abc123", "own", "--with=kira"],
    ["admin", "--json", "remote", "off"], ["invite", "kira@example.com", "--handle", "kira", "--role=member"],
  ]) {
    const canon = canonicalArgv(argv) as string[];
    const a = parseArgs(argv.slice(1), CLI_BOOLEANS);
    const b = parseArgs(canon.slice(1), CLI_BOOLEANS);
    expect([argv.join(" "), b.pos]).toEqual([argv.join(" "), a.pos]);
    expect([...b.flags].sort()).toEqual([...a.flags].sort());
    expect(remoteArgvProblem(canon)).toBeNull();
  }
});

test("Opus LOW 4: a remote run's token and agent name leave the environment (nothing the run spawns inherits them)", () => {
  const env: NodeJS.ProcessEnv = { WALKIE_ADMIN_TOKEN: "ab".repeat(24), WALKIE_AGENT: "remote-admin", PATH: "/bin" };
  try {
    adoptRemoteRun(env);
    expect(env).toEqual({ PATH: "/bin" });
    expect(remoteRunToken()).toBe("ab".repeat(24));
  } finally {
    resetRemoteRunForTests(); // module state: never leak into the rest of the suite
  }
  expect(remoteRunToken()).toBeNull();
  const stray: NodeJS.ProcessEnv = { WALKIE_ADMIN_TOKEN: "zz", WALKIE_AGENT: "cc-1" };
  adoptRemoteRun(stray);
  expect(stray).toEqual({ WALKIE_AGENT: "cc-1" }); // a malformed token is dropped, a real agent name kept
});

test("Opus MEDIUM 3: at most 4 remote admin runs per machine, 2 per calling machine", () => {
  const core = {} as Core;
  const a1 = claimSlot(core, "a");
  const a2 = claimSlot(core, "a");
  expect([!!a1, !!a2, claimSlot(core, "a")]).toEqual([true, true, null]);
  const b1 = claimSlot(core, "b");
  const b2 = claimSlot(core, "b");
  expect([!!b1, !!b2, claimSlot(core, "c"), MAX_RUNS, MAX_RUNS_PER_CALLER]).toEqual([true, true, null, 4, 2]);
  a1?.(); a1?.(); // a release counts once
  expect(!!claimSlot(core, "c")).toBe(true);
  expect(claimSlot(core, "d")).toBeNull();
});

test("Codex LOW 6: the audit line is redacted before it is cut (a secret across the cut is still gone)", () => {
  const secret = ("sk" + "-ant-api03-") + "Q".repeat(60);
  const action = `${"x".repeat(560)} ${secret}`;
  const t = auditText({ actor: "@a/m/cc", action, machine: "m", via: "local" });
  expect(t.length).toBeLessThanOrEqual(600);
  expect(t).not.toContain(("sk" + "-ant-api03-QQQQ"));
  expect(t).not.toMatch(/Q{10}/);
});

// ---- round 3 -------------------------------------------------------------------------------------------------------

import { remoteRosterProblem } from "../../src/protocol/admin.ts";
import { redactedOutput } from "../../src/daemon/admin/remote.ts";

test("round 3: options the machine's person sets there are refused remotely; the commands without them still run", () => {
  const refused: string[][] = [
    ["seats", "allow", "--same-user", "--env", "ANTHROPIC_API_KEY"], ["seats", "allow", "--env=OPENAI_API_KEY"], ["seats", "enable", "--yes", "--env", "X"],
    ["pool", "install", "--dir", "/tmp/evil"], ["pool", "install", "--dir=/opt/x"],
    ["orchestrator", "start", "--permission-mode", "bypassPermissions"], ["orchestrator", "start", "--cwd=/"], ["orchestrator", "start", "--access", "full"],
    ["integrations", "enable", "linear", "--key-path", "/Users/k/keys/linear.txt"], ["integrations", "--json", "enable", "linear", "--key-path=/k"],
    ["integrations", "enable", "wispr"], ["integrations", "enable", "fireflies", "--channel", "meetings"], ["integrations", "--yes", "enable", "fireflies"],
    ["invite", "kira@example.com", "--handle", "k2", "--role", "owner"], ["invite", "--handle", "k3", "--role=owner"],
  ];
  for (const argv of refused) expect([argv.join(" "), remoteArgvProblem(argv) === null]).toEqual([argv.join(" "), false]);
  for (const argv of [["seats", "allow", "--same-user", "--launchers", "@alex", "--dir", "/srv/seats"], ["pool", "install"], ["pool", "share", "on"],
    ["orchestrator", "start"], ["orchestrator", "stop"], ["integrations", "enable", "linear"], ["integrations", "disable", "wispr"],
    ["invite", "--handle", "k4"], ["invite", "--handle", "k5", "--role", "member"]]) {
    expect([argv.join(" "), remoteArgvProblem(argv)]).toEqual([argv.join(" "), null]);
  }
});

test("pre.7 merge: WalkieTalkie's access stays the machine's person's remotely under either name; its model may switch", () => {
  for (const argv of [["talkie", "start", "--access", "full"], ["talkie", "start", "--permission-mode=bypassPermissions"], ["talkie", "start", "--cwd", "/"],
    ["orchestrator", "access", "full"], ["talkie", "access", "full"], ["talkie", "--json", "access", "platform"]]) {
    expect([argv.join(" "), remoteArgvProblem(argv) === null]).toEqual([argv.join(" "), false]);
  }
  for (const argv of [["talkie", "start"], ["talkie", "start", "--model", "opus"], ["talkie", "model", "sonnet"], ["orchestrator", "model", "opus"], ["talkie", "status"], ["talkie", "stop"]]) {
    expect([argv.join(" "), remoteArgvProblem(argv)]).toEqual([argv.join(" "), null]);
  }
});

test("round 3: no invite or add-machine code for an owner's handle remotely (the roster decides)", () => {
  const roles: Record<string, string> = { alex: "owner", kira: "member" };
  const roleOf = (h: string) => roles[h] ?? null;
  expect(remoteRosterProblem(["team", "add-machine", "alex"], roleOf)).toContain("owner");
  expect(remoteRosterProblem(["team", "add-machine", "@alex"], roleOf)).toContain("owner");
  expect(remoteRosterProblem(["invite", "--handle", "alex"], roleOf)).toContain("owner");
  expect(remoteRosterProblem(["team", "add-machine", "kira"], roleOf)).toBeNull();
  expect(remoteRosterProblem(["invite", "--handle", "newbie"], roleOf)).toBeNull();
  expect(remoteRosterProblem(["seats", "doctor"], roleOf)).toBeNull();
});

test("round 3: remote output is redacted before it is cut (a secret across the 64 KB line is gone, not half-kept)", () => {
  const secret = ("sk" + "-ant-api03-") + "Z".repeat(90);
  const max = 1_000;
  const raw = `${"a".repeat(max - 40)} ${secret} tail`;
  const out = redactedOutput(raw, max);
  expect(out.text.length).toBeLessThanOrEqual(max);
  expect(out.text).not.toMatch(/Z{8}/);
  expect(out.text).not.toContain(("sk" + "-ant-api03-Z"));
  expect(redactedOutput("short", max)).toEqual({ text: "short", cut: false });
});
