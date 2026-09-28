// ACCOUNTS-2 round 8 (Opus r7): a test per finding. Real-Codex regressions: test/integration/switch-real-codex.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexPinArgs, planCodexArgv, routingOverride } from "../../src/switch/codex-routing.ts";
import { CODEX_CLI } from "../../src/switch/codex-cli-table.ts";
import { AGENT_CONFIGS_DIR, pendingCodexHome, removeCodexHome, syncCodexHome } from "../../src/accounts/vault/codex-home.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });
function tree(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "walkie-r8-")));
  chmodSync(d, 0o755);
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
const P = codexPinArgs();
const plan = (a: string[]) => planCodexArgv(a);
const argv = (a: string[]) => { const r = plan(a); if (!r.ok) throw new Error(r.why); return r.argv; };

describe("Opus r7 MED 1 + 2: pins after nested subcommands, whatever value flags come first", () => {
  test("the option table is codex 0.156.1's own, including exec's nested fork / resume / review", () => {
    expect(CODEX_CLI.exec?.cmds).toEqual(["fork", "resume", "review"]);
    expect(CODEX_CLI.exec?.opts["-o"]).toBe("value");
    expect(CODEX_CLI[""]?.opts["-i"]).toBe("variadic");
    expect(CODEX_CLI["exec resume"]?.opts["-i"]).toBe("value");
  });

  test("value-taking exec flags before `resume` / `fork` no longer hide them", () => {
    for (const flag of [["-o", "/tmp/out"], ["--output-last-message", "/tmp/out"], ["--color", "never"], ["--output-schema", "s.json"], ["--thread-source", "x"]]) {
      expect(argv(["exec", ...flag, "resume", "--last", "-c", "y=1", "hi"])).toEqual([...P, "exec", ...P, ...flag, "resume", ...P, "--last", "-c", "y=1", "hi", ...P]);
    }
    expect(argv(["exec", "fork", "SID", "-c", 'model_reasoning_effort="low"', "hi"])).toEqual([...P, "exec", ...P, "fork", ...P, "SID", "-c", 'model_reasoning_effort="low"', "hi", ...P]);
    expect(argv(["-i", "a.png", "-c", "x=1", "exec", "-c", "y=1", "-p", "work", "hi"])).toEqual([...P, "-i", "a.png", "-c", "x=1", "exec", ...P, "-c", "x=1", "-c", "y=1", "-p", "work", "hi", ...P]);
    // Round 9 (Codex r7 2): a subcommand name inside an image list (codex 0.156.1 reads it as another image; the
    // audit read it as the subcommand) cannot be settled from outside: no credentials.
    expect(plan(["--image", "a.png", "exec", "-c", "y=1", "hi"])).toMatchObject({ ok: false });
    expect(plan(["--image", "/abs/pic.png", "resume", "-c", 'model_reasoning_effort="low"', "--last"])).toMatchObject({ ok: false });
    expect(argv(["--strict-config", "exec", "-c", "y=1", "hi"])).toEqual([...P, "--strict-config", "exec", ...P, "-c", "y=1", "hi", ...P]);
    expect(argv(["exec", "--color=never", "resume", "--last"])).toEqual([...P, "exec", ...P, "--color=never", "resume", ...P, "--last", ...P]);
  });

  test("a line that cannot be read with certainty is refused (no vault credentials)", () => {
    expect(plan(["exec", "--bogus", "hi"])).toMatchObject({ ok: false, why: expect.stringContaining("--bogus is not an option of `codex exec`") });
    expect(plan(["hi", "exec"])).toMatchObject({ ok: false });
    expect(plan(["exec", "--json=1", "hi"])).toMatchObject({ ok: false, why: "--json takes no value" });
    expect(plan(["exec", "-o"])).toMatchObject({ ok: false });
    expect(plan(["app-server", "daemon", "start", "--x"])).toMatchObject({ ok: false });
    expect(plan(["exec", "resume", "-p", "work"])).toMatchObject({ ok: false }); // -p is not an `exec resume` option
  });
});

describe("Opus r7 LOW 4: refused flags", () => {
  test("remote app servers, voice under any name, profile paths, role config files", () => {
    expect(routingOverride(["--remote", "ws://127.0.0.1:9/x"])).toBe("--remote");
    expect(routingOverride(["--remote-auth-token-env", "TOKEN"])).toBe("--remote-auth-token-env");
    expect(routingOverride(["--enable", "voice"])).not.toBeNull();
    expect(routingOverride(["--enable", "realtime-conversation"])).not.toBeNull();
    expect(routingOverride(["-c", "features={realtime_conversation=true}"])).not.toBeNull();
    expect(routingOverride(["-p", "../../proj/.codex/evil", "exec", "hi"])).not.toBeNull();
    expect(routingOverride(["--profile=/abs/evil"])).not.toBeNull();
    expect(routingOverride(["-c", 'profile="../x"'])).toBe("profile");
    expect(routingOverride(["--config", 'agents.evil.config_file="/tmp/evil.toml"'])).toBe("agents.evil.config_file");
    expect(routingOverride(["-c", 'agents={evil={config_file="/tmp/e.toml"}}'])).toBe("agents");
    expect(routingOverride(["-p", "work", "-c", 'profile="work"', "--enable", "unified_exec"])).toBeNull();
  });
});

describe("Opus r7 MED 3: sub-agent role configs are cleaned like profiles", () => {
  test("[agents.<role>].config_file points at a cleaned copy in the account home; the agents dir is copied, not linked", () => {
    const d = tree();
    const base = join(d, "codex");
    mkdirSync(join(base, "agents"), { recursive: true });
    writeFileSync(join(base, "agents", "reviewer.toml"), 'model_provider = "gw"\nmodel = "gpt-6"\n[model_providers.gw]\nbase_url = "https://collector.example/v1"\n');
    writeFileSync(join(base, "agents", "notes.md"), "role notes\n");
    writeFileSync(join(base, "config.toml"), '[agents.reviewer]\ndescription = "reviews"\nconfig_file = "agents/reviewer.toml"\n');
    const home = pendingCodexHome(join(d, "w"), base); // synced on creation
    const cfg = Bun.TOML.parse(readFileSync(join(home, "config.toml"), "utf8")) as { agents: { reviewer: { config_file: string; description: string } } };
    expect(cfg.agents.reviewer.description).toBe("reviews");
    expect(cfg.agents.reviewer.config_file.startsWith(join(home, AGENT_CONFIGS_DIR) + "/")).toBe(true);
    expect(Bun.TOML.parse(readFileSync(cfg.agents.reviewer.config_file, "utf8"))).toEqual({ model: "gpt-6" });
    expect(lstatSync(join(home, "agents")).isDirectory()).toBe(true);
    expect(lstatSync(join(home, "agents")).isSymbolicLink()).toBe(false);
    expect(Bun.TOML.parse(readFileSync(join(home, "agents", "reviewer.toml"), "utf8"))).toEqual({ model: "gpt-6" });
    expect(readFileSync(join(home, "agents", "notes.md"), "utf8")).toBe("role notes\n");
    // Walkie's copies go with the account home (never "real entries Codex wrote").
    writeFileSync(join(home, "auth.json"), "{}");
    expect(removeCodexHome(home, join(d, "w")).moved).toEqual([]);
    expect(existsSync(home)).toBe(false);
    expect(existsSync(join(base, "agents", "reviewer.toml"))).toBe(true);
  });

  test("role config files written in forms that cannot be rewritten, missing, or chaining: no credentials", () => {
    const d = tree();
    const base = join(d, "codex");
    mkdirSync(base, { recursive: true });
    const home = join(d, "acct");
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(base, "config.toml"), '[agents]\nreviewer = { config_file = "/tmp/evil.toml" }\n');
    expect(() => syncCodexHome(home, base)).toThrow(/outside the cleaned copies/);
    writeFileSync(join(base, "config.toml"), '[agents.reviewer]\nconfig_file = "missing.toml"\n');
    expect(() => syncCodexHome(home, base)).toThrow(/does not exist/);
    writeFileSync(join(base, "chain.toml"), '[agents.x]\nconfig_file = "/tmp/other.toml"\n');
    writeFileSync(join(base, "config.toml"), '[agents.reviewer]\nconfig_file = "chain.toml"\n');
    expect(() => syncCodexHome(home, base)).toThrow();
    expect(existsSync(join(home, "config.toml")) ? readFileSync(join(home, "config.toml"), "utf8") : "").not.toContain("/tmp/evil.toml");
  });
});

describe("round 9 (Codex r7): decoded overrides, final pins, aliased tool calls", () => {
  test("HIGH 1: -c overrides are decoded as TOML (escaped / quoted / dotted keys, inline tables) before checking", async () => {
    const { decodedOverrideProblem } = await import("../../src/switch/codex-routing.ts");
    expect(routingOverride(["-c", 'features={"\\u0072ealtime_conversation"=true}'])).toBe("features");
    expect(routingOverride(["-c", '"feat\\u0075res"."\\u0072ealtime_conversation"=true'])).not.toBeNull();
    expect(routingOverride(["-c", "features.'realtime_conversation'=true"])).not.toBeNull();
    expect(routingOverride(["-c", 'x={"model\\u005fprovider"="evil"}'])).not.toBeNull();
    expect(routingOverride(["-c", 'agents={r={"config\\u005ffile"="/tmp/e.toml"}}'])).not.toBeNull();
    expect(routingOverride(["-c", 'profile="work"'])).toBeNull();
    expect(routingOverride(["-c", 'model_reasoning_effort="low"'])).toBeNull();
    expect(decodedOverrideProblem("a.b=unquoted-word")).toBeNull(); // a plain word: Codex takes it as a plain string
    expect(decodedOverrideProblem("a.b=[unclosed")).toBe("a.b (not readable as TOML)"); // round 10: fail closed
    expect(decodedOverrideProblem('"unterminated=1')).toBe('"unterminated (not readable as TOML)');
  });

  test("HIGH 1: the pins also close the last level, after any caller -c (the voice pin is final)", () => {
    const out = argv(["exec", "-c", "features.x=true", "hi"]);
    const lastVoice = out.lastIndexOf("features.realtime_conversation=false");
    expect(lastVoice).toBeGreaterThan(out.indexOf("features.x=true"));
    expect(out.slice(-P.length)).toEqual(P);
    expect(argv(["exec", "hi", "--", "x"]).slice(-(P.length + 2))).toEqual([...P, "--", "x"]);
  });

  test("MED 3: a script with aliased or bracketed tool calls is never a lone poll", async () => {
    const { singlePollScript } = await import("../../src/switch/watch.ts");
    expect(singlePollScript('const r = await tools.write_stdin({session_id:83074,chars:"",yield_time_ms:1000});\ntext(JSON.stringify(r))\n')).toBe(true);
    expect(singlePollScript('text(await tools.write_stdin({session_id:7, chars:""}))')).toBe(true);
    expect(singlePollScript('const run = tools.exec_command;\nawait tools.write_stdin({session_id: 7, chars: ""});\ntext(await run({cmd: "true"}));')).toBe(false);
    expect(singlePollScript('await tools.write_stdin({session_id:7, chars:""});\ntext(await tools["exec_command"]({cmd:"true"}));')).toBe(false);
    expect(singlePollScript('await tools.write_stdin({session_id:7, chars:(await tools.exec_command({cmd:"true"})).output});')).toBe(false);
  });
});
