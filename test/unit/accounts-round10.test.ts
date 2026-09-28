// ACCOUNTS-2 round 10 (Opus r8 MEDIUM / LOW findings): relaunch argv with image lists, -c values Bun's TOML reader
// cannot decode, every spelling of -p, `--` as an option value, and the hidden --yolo alias.
import { describe, expect, test } from "bun:test";
import { codexArgv, parseCodex } from "../../src/switch/args.ts";
import { codexPinArgs, decodedOverrideProblem, planCodexArgv, readCodexLine, routingOverride } from "../../src/switch/codex-routing.ts";

const P = codexPinArgs();
const SID = "35a3fc06-a27b-7106-8fd8-f2bb6d700e29";
const relaunch = (line: string[], fresh = false) => {
  const p = parseCodex(line);
  const plan = planCodexArgv(codexArgv(p, { session: fresh ? null : SID, relaunch: true, prompt: "CONT", fresh }));
  if (!plan.ok) throw new Error(plan.why);
  return plan.argv;
};

describe("round 10 MED 2: an image list cannot swallow the relaunch's session id or prompt", () => {
  test("`task -i a.png`: resume and the fresh-summary relaunch put the id and prompt after --", () => {
    expect(parseCodex(["task", "-i", "a.png"])).toMatchObject({ prompt: "task", kept: ["-i", "a.png"] });
    expect(relaunch(["task", "-i", "a.png"])).toEqual([...P, "resume", ...P, "-i", "a.png", ...P, "--", SID, "CONT"]);
    expect(relaunch(["task", "-i", "a.png"], true)).toEqual([...P, "-i", "a.png", ...P, "--", "CONT"]);
  });

  test("`-i a.png b.png -- task`: both images kept, the id and prompt after --", () => {
    expect(parseCodex(["-i", "a.png", "b.png", "--", "task"])).toMatchObject({ prompt: "task", kept: ["-i", "a.png", "b.png"] });
    expect(relaunch(["-i", "a.png", "b.png", "--", "task"])).toEqual([...P, "resume", ...P, "-i", "a.png", "b.png", ...P, "--", SID, "CONT"]);
    expect(relaunch(["-i", "a.png", "b.png", "--", "task"], true)).toEqual([...P, "-i", "a.png", "b.png", ...P, "--", "CONT"]);
  });

  test("the image list's values in the relaunch are exactly the images (read back with the same reader)", () => {
    const read = readCodexLine(codexArgv(parseCodex(["task", "-i", "a.png"]), { session: SID, relaunch: true, prompt: "CONT" }));
    if (!read.ok) throw new Error(read.why);
    expect(read.toks.find((t) => t.t === "opt" && t.name === "-i")).toMatchObject({ values: ["a.png"] });
    expect(read.toks.at(-1)).toEqual({ t: "end", rest: ["--", SID, "CONT"] });
  });

  test("a continuation prompt starting with '-' stays a prompt", () => {
    const argv = relaunch(["task"]);
    expect(argv.slice(-3)).toEqual(["--", SID, "CONT"]);
    const p = parseCodex(["task"]);
    expect(codexArgv(p, { session: SID, relaunch: true, prompt: "-x continue" }).slice(-3)).toEqual(["--", SID, "-x continue"]);
  });
});

describe("round 10 MED 3: a -c value Bun's TOML reader cannot decode is refused unless it is a plain word", () => {
  test("the audit's D1 case (TOML 1.1 datetime without seconds hiding an escaped config_file) is refused", () => {
    const d1 = 'agents={x={t=1979-05-27T07:32,"\\u0063onfig_file"="/tmp/evil.toml",description="d"}}';
    expect(routingOverride(["exec", "--skip-git-repo-check", "-c", d1, "hi"])).not.toBeNull();
    expect(routingOverride(["-c", d1, "exec", "hi"])).toBe("agents (not readable as TOML)");
    expect(routingOverride(["-c", 'features={t=1979-05-27T07:32,"\\u0072ealtime_conversation"=true}'])).not.toBeNull();
  });

  test("other undecodable values with table, array, key or quote syntax are refused", () => {
    // Bun decodes this one (and MIS-decodes dates: `t=1979-05-27` -> {t:1979,"05":27}): any escape is refused.
    expect(routingOverride(["-c", 'x={a="\\x63"}'])).toBe("x (escaped characters are not accepted)");
    expect(routingOverride(["-c", 'agents={y={"\\u0063onfig_file"="/e"}, t=1979-05-27}'])).not.toBeNull();
    expect(decodedOverrideProblem("x=[1,")).toBe("x (not readable as TOML)");
    expect(decodedOverrideProblem("x=a=b")).toBe("x (not readable as TOML)");
    expect(decodedOverrideProblem("x=it's")).toBe("x (not readable as TOML)");
  });

  test("everyday overrides still pass: plain words, quoted strings, arrays, dotted keys", () => {
    expect(routingOverride(["-c", "model_reasoning_effort=high"])).toBeNull();
    expect(routingOverride(["-c", 'model_reasoning_effort="high"'])).toBeNull();
    expect(routingOverride(["-c", "shell_environment_policy.inherit=all"])).toBeNull();
    expect(routingOverride(["-c", 'sandbox_permissions=["disk-full-read-access"]'])).toBeNull();
    expect(routingOverride(["-c", 'mcp_servers.x.command="npx"'])).toBeNull();
    expect(routingOverride(["-c", "sandbox_workspace_write.network_access=true"])).toBeNull();
    expect(routingOverride(["-c", "shell_environment_policy.set.PATH=/usr/bin:/bin"])).toBeNull();
  });
});

describe("round 10 LOW 4: routingOverride reads the line like the pin placement", () => {
  test("every spelling of -p / --profile with path pieces is refused; plain names pass", () => {
    for (const line of [["-p../../x"], ["-p=../../x"], ["--profile=../x"], ["-p", "../x"], ["exec", "-p../x", "hi"]]) expect(routingOverride(line)).not.toBeNull();
    for (const line of [["-pwork"], ["-p=work"], ["--profile=work"], ["-p", "work"]]) expect(routingOverride(line)).toBeNull();
  });

  test("`--` given as an option's value is not an end of options: the line is unreadable (codex 0.156.1 errors too)", () => {
    expect(planCodexArgv(["-m", "--", "--enable", "realtime_conversation"])).toMatchObject({ ok: false });
    expect(planCodexArgv(["-c", "--", "x"])).toMatchObject({ ok: false });
    // A real `--` still ends the options: what follows is the prompt, not checked as options.
    expect(routingOverride(["-c", 'model="gpt-6"', "-m", "x", "--", "-c", "model_provider=x"])).toBeNull();
  });

  test("a separate value starting with '-' is unreadable, as codex 0.156.1 rejects it (a lone '-' is a value)", () => {
    expect(planCodexArgv(["-m", "--remote", "task"])).toMatchObject({ ok: false });
    expect(planCodexArgv(["exec", "-o", "--enable", "realtime_conversation", "hi"])).toMatchObject({ ok: false });
    expect(routingOverride(["exec", "-o", "--enable", "realtime_conversation", "hi"])).not.toBeNull(); // the fallback scan
    expect(planCodexArgv(["exec", "-o", "-", "hi"])).toMatchObject({ ok: true });
  });
});

describe("round 10 (5): the hidden --yolo alias", () => {
  test("accepted wherever --dangerously-bypass-approvals-and-sandbox is listed, refused elsewhere", () => {
    expect(planCodexArgv(["--yolo", "task"])).toMatchObject({ ok: true });
    expect(planCodexArgv(["exec", "--yolo", "task"])).toMatchObject({ ok: true });
    expect(planCodexArgv(["resume", "--yolo", "--last"])).toMatchObject({ ok: true });
    expect(planCodexArgv(["review", "--yolo"])).toMatchObject({ ok: false });
    expect(planCodexArgv(["--yolo=1", "task"])).toMatchObject({ ok: false });
  });
});
