// SUDO-RS-1 (WALK-93): seat users on machines whose sudo is sudo-rs (Ubuntu 25.10 and later). The strings below are what
// the real tools printed in throwaway containers (Ubuntu 24.04 sudo 1.9.15p5, 25.10 sudo-rs 0.2.8, 26.04 sudo-rs 0.2.13);
// test/sudo-rules-containers.sh runs the rules through the real sudo of each.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../../src/cli/args.ts";
import { CLI_BOOLEANS } from "../../src/cli/booleans.ts";
import { seatUserSetup } from "../../src/cli/commands/seat-user.ts";
import type { Ctx } from "../../src/cli/context.ts";
import { runSeatAdmin, type AdminSys } from "../../src/daemon/seats/admin.ts";
import { NATIVE_INSTALL } from "../../src/switch/trusted.ts";
import {
  DEFAULT_ADMIN, DEFAULT_RUNNER, checkSudoRules, detectSudo, seatUserPlan, sudoInfoFrom, sudoProblem, toolOutput, unknownRequiretty, type SudoInfo,
} from "../../src/daemon/seats/seat-user.ts";

const CLASSIC_SUDO = "Sudo version 1.9.15p5\nConfigure options: --build=aarch64-linux-gnu --prefix=/usr --with-pam\nSudoers policy plugin version 1.9.15p5\nSudoers file grammar version 50\n";
const CLASSIC_VISUDO = "visudo version 1.9.15p5\nvisudo grammar version 50\n";
const RS_08_SUDO = "sudo-rs 0.2.8\n";
const RS_08_VISUDO = "visudo version 0.2.8\n";
const RS_013_SUDO = "sudo-rs 0.2.13-0ubuntu1.2\n";
const RS_013_VISUDO = "visudo-rs 0.2.13\n";

/** What sudo-rs's `visudo -c -f` printed for the rules with the two `!requiretty` lines (0.2.8 and 0.2.13 alike). */
const RS_REFUSES_REQUIRETTY = `/tmp/with:4:56: syntax error: unknown setting: 'requiretty'
Defaults!/usr/local/libexec/walkie/walkie-seat-runner !requiretty
                                                       ^~~~~~~~~~
/tmp/with:5:55: syntax error: unknown setting: 'requiretty'
Defaults!/usr/local/libexec/walkie/walkie-seat-admin !requiretty
                                                      ^~~~~~~~~~
visudo: invalid sudoers file
`;

const REQUIRETTY_LINES = [`Defaults!${DEFAULT_RUNNER} !requiretty`, `Defaults!${DEFAULT_ADMIN} !requiretty`];
const classic: SudoInfo = { flavor: "classic", version: "1.9.15p5" };
const rs = (version: string | null): SudoInfo => ({ flavor: "sudo-rs", version });
const unknown: SudoInfo = { flavor: "unknown", version: null };

function plan(over: Partial<Parameters<typeof seatUserPlan>[0]> = {}) {
  return seatUserPlan({
    platform: "linux", daemonUser: "arvid", source: "/usr/local/bin/walkie", groupId: 0, walkieHome: "/home/arvid/.walkie",
    sudoersTmp: "/tmp/x/walkie-seats", home: "/home/arvid", homeProblem: null, runtimes: {}, ...over,
  });
}

describe("which sudo this machine has, from what `sudo --version` and `visudo --version` print", () => {
  test("the original sudo", () => {
    expect(sudoInfoFrom(CLASSIC_SUDO, CLASSIC_VISUDO)).toEqual(classic);
    expect(sudoInfoFrom(CLASSIC_SUDO, null)).toEqual(classic);
    expect(sudoInfoFrom(null, CLASSIC_VISUDO)).toEqual(classic);
  });

  test("sudo-rs, whichever tool answers (visudo's own words differ between versions)", () => {
    expect(sudoInfoFrom(RS_08_SUDO, RS_08_VISUDO)).toEqual(rs("0.2.8"));
    expect(sudoInfoFrom(RS_013_SUDO, RS_013_VISUDO)).toEqual(rs("0.2.13"));
    expect(sudoInfoFrom(RS_013_SUDO, null)).toEqual(rs("0.2.13"));
    expect(sudoInfoFrom(null, RS_08_VISUDO)).toEqual(rs("0.2.8")); // "visudo version 0.x": the original sudo never had a 0.x
    expect(sudoInfoFrom(null, RS_013_VISUDO)).toEqual(rs("0.2.13"));
  });

  test("either tool saying sudo-rs wins (the check that gates the install is visudo's)", () => {
    expect(sudoInfoFrom(CLASSIC_SUDO, RS_013_VISUDO).flavor).toBe("sudo-rs");
    expect(sudoInfoFrom(RS_013_SUDO, CLASSIC_VISUDO).flavor).toBe("sudo-rs");
  });

  test("anything else is unknown, never a guess", () => {
    expect(sudoInfoFrom(null, null)).toEqual(unknown);
    expect(sudoInfoFrom("", "")).toEqual(unknown);
    expect(sudoInfoFrom("doas: not sudo\n", "visudo: command not found\n")).toEqual(unknown);
    expect(sudoInfoFrom("sudo-rs\n", null)).toEqual({ flavor: "sudo-rs", version: null }); // named, no number
  });

  test("detectSudo asks `sudo --version` and `visudo --version`, and survives a tool that is missing or fails", () => {
    const asked: string[] = [];
    const run = (argv: string[]) => {
      asked.push(argv.join(" "));
      if (argv[0] === "/usr/bin/sudo") return RS_013_SUDO;
      return argv[0] === "/usr/sbin/visudo" ? RS_013_VISUDO : null;
    };
    expect(detectSudo(run)).toEqual(rs("0.2.13"));
    expect(asked).toContain("/usr/bin/sudo --version");
    expect(asked).toContain("/usr/sbin/visudo --version");
    expect(detectSudo(() => null)).toEqual(unknown);
    expect(detectSudo(() => { throw new Error("spawn ENOENT"); })).toEqual(unknown);
    // the real thing on this machine: one of the three, never a throw
    expect(["classic", "sudo-rs", "unknown"]).toContain(detectSudo().flavor);
  });
});

describe("reading a tool's version from the real thing", () => {
  const dirs: string[] = [];
  afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }); });
  function tool(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "sudo-tool-"));
    dirs.push(dir);
    const path = join(dir, "tool");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  test("sudo-rs 0.2.8 prints its version on stderr: both streams are read", () => {
    const sudo = toolOutput([tool("echo 'sudo-rs 0.2.8' >&2"), "--version"]);
    expect(sudo).toContain("sudo-rs 0.2.8");
    expect(sudoInfoFrom(sudo, null)).toEqual(rs("0.2.8"));
    expect(toolOutput([tool("echo 'visudo version 0.2.8'"), "--version"])).toContain("visudo version 0.2.8");
  });

  test("a tool that fails, or isn't there, says nothing", () => {
    expect(toolOutput([tool("echo 'sudo-rs 0.2.8' >&2; exit 1"), "--version"])).toBeNull();
    expect(toolOutput(["/nonexistent/sudo", "--version"])).toBeNull();
  });
});

describe("the sudo rules per sudo", () => {
  test("the original sudo (and a sudo we don't recognize) keep !requiretty: some systems want a terminal and seats have none", () => {
    for (const sudo of [classic, unknown, undefined]) {
      const p = plan(sudo ? { sudo } : {});
      for (const line of REQUIRETTY_LINES) expect(p.sudoers).toContain(`${line}\n`);
    }
  });

  test("sudo-rs gets the same rules without the two !requiretty lines, and nothing else changes", () => {
    const withLines = plan({ sudo: classic }).sudoers;
    for (const sudo of [rs("0.2.13"), rs("0.2.15"), rs(null)]) {
      const p = plan({ sudo });
      expect(p.sudoers).not.toContain("requiretty");
      expect(p.sudoers).toBe(withLines.split("\n").filter((l) => !REQUIRETTY_LINES.includes(l)).join("\n"));
      expect(p.sudoers).toContain("timestamp_timeout=0"); // sudo-rs knows it, and talkie-repair keeps its fresh password
      expect(p.sudoers).toContain("ALL=(%walkie-seats) NOPASSWD:");
      expect(p.sudoers).toContain("PASSWD: WALKIE_TALKIE_REPAIR");
    }
  });

  test("the fallback text is exactly the sudo-rs text, and only a plan that has the lines carries one", () => {
    const sudoRs = plan({ sudo: rs("0.2.13") });
    for (const sudo of [classic, unknown, undefined]) {
      const p = plan(sudo ? { sudo } : {});
      expect(p.sudoersWithoutRequiretty).toBe(sudoRs.sudoers);
    }
    expect(sudoRs.sudoersWithoutRequiretty).toBeNull();
  });

  test("the check of the sudo rules is the one step marked for the fallback", () => {
    const p = plan();
    const checks = p.steps.filter((s) => s.sudoersCheck);
    expect(checks.map((s) => s.argv)).toEqual([["visudo", "-c", "-f", "/tmp/x/walkie-seats"]]);
    expect(p.steps.find((s) => s.argv.join(" ") === "visudo -c -f /etc/sudoers.d/walkie-seats")?.sudoersCheck).toBeUndefined();
  });

  test("the plan says in plain words which sudo it found and what that means for the rules", () => {
    expect(plan({ sudo: classic }).sudoNote).toMatch(/original sudo 1\.9\.15p5.*keep !requiretty/);
    expect(plan({ sudo: rs("0.2.13") }).sudoNote).toMatch(/sudo-rs 0\.2\.13.*leave out !requiretty/);
    expect(plan({ sudo: rs(null) }).sudoNote).toMatch(/sudo-rs.*leave out !requiretty/);
    expect(plan({ sudo: unknown }).sudoNote).toMatch(/isn't recognized.*keep !requiretty.*written again without it/);
    expect(plan({ sudo: rs("0.2.13") }).sudo).toEqual(rs("0.2.13"));
    expect(plan().sudo).toEqual(unknown);
  });

  test("a sudo-rs older than 0.2.13 can't read the * the helper's commands end in: refused with the way out, nothing to apply", () => {
    for (const v of ["0.2.8", "0.2.12", "0.1.9"]) {
      const p = plan({ sudo: rs(v) });
      expect(p.sudoProblem).toContain(`sudo-rs ${v}`);
      expect(p.sudoProblem).toContain("0.2.13");
      expect(p.sudoProblem).toContain("sudo apt install sudo && sudo update-alternatives --set sudo /usr/bin/sudo.ws");
      expect(p.sudoProblem).toContain("walkie seats enable --same-user");
      expect(sudoProblem(rs(v))).toBe(p.sudoProblem);
    }
    for (const sudo of [rs("0.2.13"), rs("0.2.15"), rs("0.3.0"), rs("1.0.0"), rs(null), classic, unknown]) expect(plan({ sudo }).sudoProblem).toBeNull();
  });
});

describe("the check of the sudo rules, with its one fallback", () => {
  test("the exact error sudo-rs prints for requiretty, and nothing else, is the one that regenerates", () => {
    expect(unknownRequiretty(RS_REFUSES_REQUIRETTY)).toBe(true);
    expect(unknownRequiretty("/tmp/x:4:56: syntax error: unknown setting: 'requiretty'\n")).toBe(true);
    expect(unknownRequiretty("")).toBe(false);
    expect(unknownRequiretty("/tmp/walkie-seats: parsed OK\n")).toBe(false);
    // another setting sudo-rs doesn't know is not ours to paper over
    expect(unknownRequiretty("/tmp/x:3:1: syntax error: unknown setting: 'timestamp_timeout'\n")).toBe(false);
    // requiretty AND another error: the second would stay after a regenerate
    expect(unknownRequiretty(`${RS_REFUSES_REQUIRETTY}/tmp/x:9:1: syntax error: unexpected token\n`)).toBe(false);
    expect(unknownRequiretty("/tmp/x:9:1: syntax error: unexpected token\n")).toBe(false);
    // the original sudo's own wording for a bad file
    expect(unknownRequiretty("visudo: /tmp/x:4:56: syntax error\n")).toBe(false);
    expect(unknownRequiretty("sudo: unknown setting: requiretty\n")).toBe(false);
  });

  test("a check that passes is not repeated and never rewrites", () => {
    let checks = 0; let rewrites = 0;
    const r = checkSudoRules(() => { checks++; return { ok: true, output: "/tmp/x: parsed OK\n" }; }, () => { rewrites++; });
    expect(r).toEqual({ ok: true, output: "/tmp/x: parsed OK\n", regenerated: false });
    expect([checks, rewrites]).toEqual([1, 0]);
  });

  test("the exact requiretty error: the rules are written again without those lines and checked once more", () => {
    const answers = [{ ok: false, output: RS_REFUSES_REQUIRETTY }, { ok: true, output: "/tmp/x: parsed OK\n" }];
    const order: string[] = [];
    const r = checkSudoRules(() => { order.push("check"); return answers.shift() as { ok: boolean; output: string }; }, () => { order.push("rewrite"); });
    expect(r).toEqual({ ok: true, output: "/tmp/x: parsed OK\n", regenerated: true });
    expect(order).toEqual(["check", "rewrite", "check"]);
  });

  test("when the second check fails too, it fails with the second answer (once; no loop)", () => {
    const answers = [{ ok: false, output: RS_REFUSES_REQUIRETTY }, { ok: false, output: "/tmp/x:2:3: syntax error: unexpected token\n" }];
    let rewrites = 0;
    const r = checkSudoRules(() => answers.shift() as { ok: boolean; output: string }, () => { rewrites++; });
    expect(r).toEqual({ ok: false, output: "/tmp/x:2:3: syntax error: unexpected token\n", regenerated: true });
    expect(rewrites).toBe(1);
    expect(answers).toEqual([]);
  });

  test("any other failure stays a failure: no rewrite, one check", () => {
    let checks = 0; let rewrites = 0;
    const r = checkSudoRules(() => { checks++; return { ok: false, output: "/tmp/x:3:1: syntax error: unknown setting: 'timestamp_timeout'\n" }; }, () => { rewrites++; });
    expect(r.ok).toBe(false);
    expect(r.regenerated).toBe(false);
    expect([checks, rewrites]).toEqual([1, 0]);
  });

  test("rules that already lack the lines have nothing to regenerate (no rewrite given)", () => {
    let checks = 0;
    const r = checkSudoRules(() => { checks++; return { ok: false, output: RS_REFUSES_REQUIRETTY }; }, null);
    expect(r.ok).toBe(false);
    expect(r.regenerated).toBe(false);
    expect(checks).toBe(1);
  });
});

describe("the warning when a runtime can't be copied for the seat users names the fix", () => {
  // The command named has to work once seat users exist (as they do when the run that printed it has applied): `seats enable
  // --seat-users` skips the setup then (test/unit/seats-enable-codex-release.test.ts), `seats setup-user --apply` doesn't.
  test("claude: Claude Code's standalone build, with the official command, then the command that works once seat users exist", () => {
    const warning = plan({ runtimes: { claude: null, codex: "/opt/codex" } }).warnings.join("\n");
    expect(warning).toMatch(/claude/);
    expect(warning).toMatch(/standalone/i);
    expect(warning).toContain("curl -fsSL https://claude.ai/install.sh | bash");
    expect(warning).toContain(NATIVE_INSTALL.claude); // the one command Walkie gives for Claude's native build, wherever it says so
    expect(warning).toContain("walkie seats setup-user --apply");
    expect(warning).not.toContain("seats enable");
    expect(warning).not.toMatch(/codex/);
    expect(warning).not.toContain("install it where the seat users can run it");
  });

  // nativeRuntime stops at the first claude on PATH that isn't Walkie's shim (test/unit/seat-user-native.test.ts: a script before the
  // native one means none), so the standalone build is not found until a shell has it on PATH and an older npm launcher is not first.
  test("claude: a new terminal, and an older npm claude that comes first on PATH has to go", () => {
    const warning = plan({ runtimes: { claude: null, codex: "/opt/codex" } }).warnings.join("\n");
    expect(warning).toMatch(/new terminal/);
    expect(warning).toContain("npm uninstall -g @anthropic-ai/claude-code");
    expect(warning.indexOf("claude.ai/install.sh")).toBeLessThan(warning.indexOf("new terminal"));
    expect(warning.indexOf("new terminal")).toBeLessThan(warning.indexOf("walkie seats setup-user --apply"));
  });

  test("codex: --codex-release through seats setup-user --apply", () => {
    const warning = plan({ runtimes: { claude: "/opt/claude", codex: null } }).warnings.join("\n");
    expect(warning).toContain("walkie seats setup-user --apply --codex-release");
    expect(warning).not.toContain("seats enable");
    expect(warning).not.toMatch(/claude/);
  });

  test("both: one plain line each", () => {
    const warnings = plan({ runtimes: { claude: null, codex: null } }).warnings;
    expect(warnings.length).toBe(2);
    expect(warnings.find((w) => w.startsWith("claude"))).toContain("claude.ai/install.sh");
    expect(warnings.find((w) => w.startsWith("codex"))).toContain("--codex-release");
  });

  test("codex after --codex-release already failed: check the network and try again, or install one yourself", () => {
    const warning = plan({ runtimes: { claude: "/opt/claude", codex: null }, codexReleaseTried: true }).warnings.join("\n");
    expect(warning).toMatch(/could not be fetched/);
    expect(warning).toMatch(/check the network/);
    expect(warning).toContain("walkie seats setup-user --apply --codex-release again");
    expect(warning).toMatch(/standalone codex yourself/);
    expect(warning).not.toContain("seats enable");
  });

  test("a runtime that can be copied, or one we have no advice for, adds no false advice", () => {
    expect(plan({ runtimes: { claude: "/opt/claude", codex: "/opt/codex" } }).warnings).toEqual([]);
    const other = plan({ runtimes: { kimi: null } }).warnings.join("\n");
    expect(other).toContain("kimi");
    expect(other).not.toContain("claude.ai/install.sh");
    expect(other).not.toContain("--codex-release");
  });
});

describe("the question setup puts to sudo after installing the rules: the helper's `create 0`", () => {
  test("the helper answers it with a JSON refusal and touches nothing, so an answer means sudo let the command through", async () => {
    const self = process as { getuid?: () => number };
    const real = self.getuid;
    self.getuid = () => 0; // the helper runs as root through sudo
    try {
      const lines: string[] = [];
      const untouched = new Proxy({}, { get: () => { throw new Error("the helper touched the system"); } }) as unknown as AdminSys;
      expect(await runSeatAdmin(["create", "0"], untouched, (line) => lines.push(line))).toBe(1);
      const answer = lines.join("");
      expect(answer.startsWith("{")).toBe(true);
      expect(JSON.parse(answer)).toMatchObject({ ok: false, code: "refused" });
    } finally { self.getuid = real; }
  });
});

describe("walkie seats setup-user prints what it found, and refuses a sudo that can't take the rules before changing anything", () => {
  function capture(args: string[]) {
    const out: string[] = []; const err: string[] = [];
    const client = { seats: async () => ({ local: { allow: false } }), seatsConfig: async () => { throw new Error("must not be reached"); } };
    const ctx = {
      args: parseArgs(args, CLI_BOOLEANS), json: false, forAgent: false, agentMarker: () => null,
      client: () => client, out: (s: string) => { out.push(s); }, err: (s: string) => { err.push(s); },
    } as unknown as Ctx;
    return { ctx, out, err };
  }
  const run = async (sudo: SudoInfo, apply: boolean) => {
    const w = capture(["setup-user", ...(apply ? ["--apply"] : [])]);
    const result = await seatUserSetup(w.ctx, { apply, accept: true, plan: true, sudo });
    return { result, text: [...w.out, ...w.err].join("\n"), out: w.out.join("\n"), err: w.err.join("\n") };
  };

  test("the plan output names the sudo, and the rules it prints match", async () => {
    const rsRun = await run(rs("0.2.13"), false);
    expect(rsRun.out).toMatch(/sudo here is sudo-rs 0\.2\.13/);
    expect(rsRun.out.split("\n").filter((l) => l.includes("Defaults!") && l.includes("requiretty"))).toEqual([]);
    expect(rsRun.result).toEqual({ ok: true, applied: false });
    const classicRun = await run(classic, false);
    expect(classicRun.out).toMatch(/sudo here is the original sudo 1\.9\.15p5/);
    expect(classicRun.out.split("\n").filter((l) => l.includes("Defaults!") && l.includes("!requiretty")).length).toBe(2);
  });

  test("sudo-rs 0.2.8: the plan says why it can't be applied, and --apply stops there (nothing was changed)", async () => {
    const planned = await run(rs("0.2.8"), false);
    expect(planned.err).toMatch(/not applied: sudo-rs 0\.2\.8/);
    expect(planned.result.ok).toBe(true); // printing a plan is not a failure
    const applied = await run(rs("0.2.8"), true);
    expect(applied.result.ok).toBe(false);
    expect(applied.result.applied).toBe(false);
    expect(applied.result.why).toContain("0.2.13");
    expect(applied.err).toContain("walkie seats enable --same-user");
    expect(applied.text).not.toMatch(/^→ /m); // no step ran
  });
});
