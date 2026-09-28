// Remote seats (PROTOCOL §11): request validation, who may launch or stop, the channel's fitness, the seats
// channel's reservation at the authority, the runtimes' argv (the prompt never on it), Codex's JSONL, and the
// environment a seat gets (API keys dropped, the seat env file sourced).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestAllowed, memberByHandle, seatsChannelRule } from "../../src/daemon/roster.ts";
import { SeatsConfig } from "../../src/daemon/config.ts";
import { git, readHead } from "../../src/daemon/seats/git.ts";
import { channelFit, decideRun, decideStop, desiredMembers, launcherAllowed, parseLaunchers, type SeatsPolicy } from "../../src/daemon/seats/rules.ts";
import { claudeSeatArgs, codexSeatArgs, codexSeatLine, claudeSeatParser, dropFromSeat, findRuntime, loginEnv, seatEnvFile, seatEnvNameProblem } from "../../src/daemon/seats/runtime.ts";
import {
  isSeatAgent, parseLauncher, runText, seatAgentName, seatOf, seatsChannel, seatsChannelNode, type SeatRun,
} from "../../src/protocol/seats.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { createTeam, ev, memberEv, nodeEv, now, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const RUN: SeatRun = { op: "run", v: 1, runtime: "claude", prompt: "fix the tests", timeout_s: 600, max_concurrent: 9 };

/** alex (owner) + arvid (member, the host arvid-mac) + kira (member), the seats channel [arvid, alex]. */
function team(members: string[] = ["arvid", "alex"]) {
  const alex = tnode("alex");
  const arvid = tnode("arvid", "arvid@example.com", "arvid-mac");
  const kira = tnode("kira");
  const { team: id, create } = createTeam(alex);
  const core = makeCore(arvid, id, cleanups);
  const events = [
    create, memberEv(id, alex, arvid, "member"), memberEv(id, alex, kira, "member"), nodeEv(id, alex, arvid), nodeEv(id, alex, kira),
    ev(id, alex, "channel.upsert", { name: "general" }),
    ev(id, alex, "channel.upsert", { name: seatsChannel(arvid.keys.nodeId), members, seats: true }),
  ];
  feed(core, events);
  return { id, core, alex, arvid, kira, channel: seatsChannel(arvid.keys.nodeId) };
}

const POLICY: SeatsPolicy = { allow: true, launchers: null, runtimes: ["claude", "codex"] };

function ctxFor(t: ReturnType<typeof team>, policy: SeatsPolicy = POLICY, at = now()) {
  return { roster: t.core.roster, node: t.arvid.keys.nodeId, me: "arvid", policy, now: at, maxAgeMs: 10 * 60_000 };
}

describe("seat bodies", () => {
  test("seatOf accepts only well-formed, known ops and rejects extra fields", () => {
    expect(seatOf({ text: "x", seat: RUN })).toEqual(RUN);
    expect(seatOf({ text: "x" })).toBeNull();
    expect(seatOf({ text: "x", seat: { ...RUN, op: "exec" } })).toBeNull();
    expect(seatOf({ text: "x", seat: { ...RUN, shell: "rm -rf /" } })).toBeNull();
    expect(seatOf({ text: "x", seat: { ...RUN, runtime: "bash" } })).toBeNull();
    expect(seatOf({ text: "x", seat: { ...RUN, timeout_s: 1 } })).toBeNull();
    expect(seatOf({ text: "x", seat: { ...RUN, model: "opus; rm -rf ~" } })).toBeNull();
    expect(seatOf({ text: "x", seat: { op: "stop", v: 1, seat: "0123456789abcdef:3" } })).not.toBeNull();
    expect(seatOf({ text: "x", seat: "run" })).toBeNull();
  });

  test("channel and agent names", () => {
    expect(seatsChannelNode(seatsChannel("0123456789abcdef"))).toBe("0123456789abcdef");
    expect(seatsChannelNode("seats-xyz")).toBeNull();
    expect(seatAgentName("0123456789abcdef:42")).toBe("seat-012345-42");
    expect(isSeatAgent("seats")).toBe(true);
    expect(isSeatAgent("seat-012345-42")).toBe(true);
    expect(isSeatAgent("cc-1234")).toBe(false);
    expect(parseLauncher("@alex/alex-mac/orchestrator")).toEqual({ handle: "alex", machine: "alex-mac", agent: "orchestrator" });
    expect(parseLauncher("alex")).toEqual({ handle: "alex" });
    expect(parseLauncher("@Alex")).toBeNull();
    expect(parseLauncher("@alex/../x")).toBeNull();
  });

  test("the request text quotes the prompt as a preview, line by line", () => {
    const text = runText({ ...RUN, prompt: "line one\n# not a heading" }, "arvid-mac");
    expect(text).toContain("Seat request: claude on arvid-mac");
    expect(text).toContain("> line one\n> # not a heading");
  });
});

describe("who may launch", () => {
  test("default launchers are the owners at request time; a person, not an agent", () => {
    const t = team();
    const byAlex = ev(t.id, t.alex, "msg.post", { text: "go", seat: RUN } as never, { channel: t.channel });
    expect(launcherAllowed(byAlex, t.core.roster, POLICY)).toBeNull();
    const byArvid = ev(t.id, t.arvid, "msg.post", { text: "go", seat: RUN } as never, { channel: t.channel });
    expect(launcherAllowed(byArvid, t.core.roster, POLICY)).toBe("not_a_launcher");
    const byAgent = ev(t.id, t.alex, "msg.post", { text: "go", seat: RUN } as never, { channel: t.channel, agent: "orchestrator" });
    expect(launcherAllowed(byAgent, t.core.roster, POLICY)).toBe("agent_not_allowed");
  });

  test("a named agent is allowed only with its exact machine; a named person from any or the named machine", () => {
    const t = team();
    const policy: SeatsPolicy = { ...POLICY, launchers: parseLaunchers(["@kira", "@alex/alex-mbp/orchestrator"]) };
    const agent = ev(t.id, t.alex, "msg.post", { text: "go", seat: RUN } as never, { channel: t.channel, agent: "orchestrator" });
    expect(launcherAllowed(agent, t.core.roster, policy)).toBeNull();
    const other = ev(t.id, t.alex, "msg.post", { text: "go", seat: RUN } as never, { channel: t.channel, agent: "cc-1" });
    expect(launcherAllowed(other, t.core.roster, policy)).toBe("agent_not_allowed");
    const alexPerson = ev(t.id, t.alex, "msg.post", { text: "go", seat: RUN } as never, { channel: t.channel });
    expect(launcherAllowed(alexPerson, t.core.roster, policy)).toBe("not_a_launcher"); // narrowed: alex the person isn't listed
    const kira = ev(t.id, t.kira, "msg.post", { text: "go", seat: RUN } as never, { channel: t.channel });
    expect(launcherAllowed(kira, t.core.roster, policy)).toBeNull();
    const machine: SeatsPolicy = { ...POLICY, launchers: parseLaunchers(["@kira/kiras-studio"]) };
    expect(launcherAllowed(kira, t.core.roster, machine)).toBe("not_a_launcher");
  });

  test("an author that isn't its node's member is refused", () => {
    const t = team();
    const forged = ev(t.id, t.kira, "msg.post", { text: "go", seat: RUN } as never, { channel: t.channel, handle: "alex" });
    expect(launcherAllowed(forged, t.core.roster, POLICY)).toBe("node_not_admitted");
  });

  test("decideRun: fresh, allowed, runtime allowed; stale and turned-off requests are refused", () => {
    const t = team();
    const req = ev(t.id, t.alex, "msg.post", { text: "go", seat: RUN } as never, { channel: t.channel });
    const ok = decideRun(req, ctxFor(t, POLICY, req.ts));
    expect(ok?.ok).toBe(true);
    expect(decideRun(req, ctxFor(t, POLICY, req.ts + 11 * 60_000))).toEqual({ ok: false, reason: "stale", answer: true });
    // Dated ahead of the host's clock: a little skew is fine, more is refused (it would stay "fresh" too long).
    expect(decideRun(req, ctxFor(t, POLICY, req.ts - 60_000))?.ok).toBe(true);
    expect(decideRun(req, ctxFor(t, POLICY, req.ts - 3 * 60_000))).toEqual({ ok: false, reason: "future", answer: true });
    expect(decideRun(req, ctxFor(t, { ...POLICY, allow: false }, req.ts))).toMatchObject({ ok: false, reason: "seats_not_allowed" });
    expect(decideRun(req, ctxFor(t, { ...POLICY, runtimes: ["codex"] }, req.ts))).toMatchObject({ ok: false, reason: "runtime_not_allowed" });
    // Not a request: an ordinary post, another channel, a stop (for decideRun).
    expect(decideRun(ev(t.id, t.alex, "msg.post", { text: '{"op":"run"}' }, { channel: t.channel }), ctxFor(t))).toBeNull();
    const stop = ev(t.id, t.alex, "msg.post", { text: "stop", seat: { op: "stop", v: 1, seat: req.id } } as never, { channel: t.channel });
    expect(decideRun(stop, ctxFor(t, POLICY, stop.ts))).toBeNull();
    expect(decideStop(stop, ctxFor(t, POLICY, stop.ts))?.ok).toBe(true);
    // The host's own person (not a launcher) may stop what runs on their machine, but not launch there.
    const own = ev(t.id, t.arvid, "msg.post", { text: "stop", seat: { op: "stop", v: 1, seat: req.id } } as never, { channel: t.channel });
    expect(decideStop(own, ctxFor(t, POLICY, own.ts))?.ok).toBe(true);
    const ownAgent = ev(t.id, t.arvid, "msg.post", { text: "stop", seat: { op: "stop", v: 1, seat: req.id } } as never, { channel: t.channel, agent: "cc-9" });
    expect(decideStop(ownAgent, ctxFor(t, POLICY, ownAgent.ts))).toMatchObject({ ok: false, reason: "agent_not_allowed" });
  });

  test("a channel wider than the host and its launchers is not used (and nothing is posted back there)", () => {
    const t = team(["arvid", "alex", "kira"]);
    const req = ev(t.id, t.alex, "msg.post", { text: "go", seat: RUN } as never, { channel: t.channel });
    expect(decideRun(req, ctxFor(t, POLICY, req.ts))).toEqual({ ok: false, reason: "channel_too_wide", answer: false });
    expect(channelFit(undefined, "arvid", ["alex"])).toBe("channel_missing");
    expect(channelFit({ name: "x", seats: true }, "arvid", ["alex"])).toBe("channel_not_private");
    expect(channelFit({ name: "x", members: ["alex"], seats: true }, "arvid", ["alex"])).toBe("channel_without_host");
    expect(channelFit({ name: "x", members: ["arvid", "alex"], archived: true, seats: true }, "arvid", ["alex"])).toBe("channel_archived");
    // PRE4 delta (Opus 4): an unmarked channel (an older authority dropped the mark) runs no seat, however it is shaped.
    expect(channelFit({ name: "x", members: ["arvid", "alex"] }, "arvid", ["alex"])).toBe("channel_unmarked");
    expect(channelFit({ name: "x", members: ["arvid", "alex"], seats: true }, "arvid", ["alex"])).toBeNull();
    expect(desiredMembers(t.core.roster, "arvid", POLICY)).toEqual(["arvid", "alex"]);
  });
});

describe("the seats channel at the authority", () => {
  test("a member may create and re-shape their own machine's seats channel; not someone else's; owners can't widen it", () => {
    const t = team();
    const r = t.core.roster;
    const arvid = memberByHandle(r, "arvid");
    const kira = memberByHandle(r, "kira");
    const alex = memberByHandle(r, "alex");
    if (!arvid || !kira || !alex) throw new Error("roster");
    const own = { name: t.channel, members: ["arvid", "alex"] };
    expect(requestAllowed("channel.upsert", own, r, arvid, t.arvid.keys.nodeId).status).toBe("ok");
    expect(requestAllowed("channel.upsert", { ...own, members: ["arvid", "alex", "kira"] }, r, arvid, t.arvid.keys.nodeId).status).toBe("ok");
    expect(requestAllowed("channel.upsert", own, r, kira, t.kira.keys.nodeId).status).toBe("reject");
    expect(requestAllowed("channel.upsert", { name: t.channel, members: ["alex"] }, r, arvid, t.arvid.keys.nodeId).status).toBe("reject");
    expect(requestAllowed("channel.upsert", { name: t.channel, public: true }, r, arvid, t.arvid.keys.nodeId).status).toBe("reject");
    // An owner can't widen (or publish) arvid's seats channel either.
    expect(requestAllowed("channel.upsert", { name: t.channel, members: ["arvid", "alex", "kira"] }, r, alex, t.alex.keys.nodeId).status).toBe("reject");
    expect(seatsChannelRule({ name: t.channel, public: true }, r, "alex")?.status).toBe("reject");
    expect(seatsChannelRule({ name: t.channel, members: ["arvid", "ghost"] }, r, "arvid")?.status).toBe("reject");
    // Not reserved: a seats- name that isn't an admitted node.
    expect(seatsChannelRule({ name: "seats-ffffffffffffffff", members: ["kira"] }, r, "kira")).toBeNull();
  });
});

describe("runtimes", () => {
  test("the prompt is never on argv; Codex reads it from stdin", () => {
    const c = claudeSeatArgs({ session: "s1", mode: "acceptEdits", permissionPrompts: true, systemPrompt: "sys" });
    expect(c).toContain("--input-format");
    expect(c[c.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    const x = codexSeatArgs({ cwd: "/tmp/w", mode: "bypassPermissions", model: "gpt-x" });
    expect(x[0]).toBe("exec");
    expect(x[x.length - 1]).toBe("-");
    expect(x).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(codexSeatArgs({ cwd: "/tmp/w", mode: "acceptEdits" })).toContain("workspace-write");
    expect(codexSeatArgs({ cwd: "/tmp/w", mode: "default" })).toContain("read-only");
  });

  test("Codex JSONL events become text, tool lines and the end", () => {
    expect(codexSeatLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }))).toEqual([{ kind: "text", text: "done" }]);
    expect(codexSeatLine(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "bun test", exit_code: 1 } })))
      .toEqual([{ kind: "tool", text: "$ bun test (exit 1)" }]);
    expect(codexSeatLine(JSON.stringify({ type: "turn.completed" }))).toEqual([{ kind: "final", ok: true, text: "" }]);
    expect(codexSeatLine(JSON.stringify({ type: "turn.failed", error: { message: "quota" } }))).toEqual([{ kind: "final", ok: false, text: "quota" }]);
    expect(codexSeatLine(JSON.stringify({ type: "item.started", item: { type: "agent_message", text: "partial" } }))).toBeNull();
    expect(codexSeatLine("not json")).toBeNull();
    expect(codexSeatLine("[1,2]")).toBeNull();
  });

  test("a tool line is redacted before it is shortened: a token across the cut doesn't leak (Codex MEDIUM 5)", () => {
    const token = `ghp_${"A1b2C3d4E5".repeat(4)}`;
    const command = `${"x".repeat(100)} ${token} --more`; // the token straddles the 120-character cut
    const codex = codexSeatLine(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command, exit_code: 0 } }));
    const claude = claudeSeatParser("/w")(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] }, parent_tool_use_id: null }));
    for (const out of [codex, claude]) {
      const text = out?.[0]?.text ?? "";
      expect(text.startsWith("$ xxx")).toBe(true);
      expect(text).not.toContain("ghp_");
      expect(text).not.toContain("A1b2C3d4E5");
    }
  });

  test("Claude's stream-json becomes text, tool lines and the result", () => {
    const p = claudeSeatParser("/w");
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] }, parent_tool_use_id: null });
    expect(p(line)).toEqual([{ kind: "text", text: "hi" }, { kind: "tool", text: "$ ls" }]);
    expect(p(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }))).toEqual([{ kind: "final", ok: true, text: "ok" }]);
  });

  test("a seat never inherits API keys or a parent agent session's markers; the seat env file is sourced", async () => {
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "CODEX_API_KEY", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "WALKIE_AGENT", "CODEX_THREAD_ID", "GEMINI_API_KEY"]) {
      expect(dropFromSeat(k)).toBe(true);
    }
    for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "CODEX_HOME", "PATH", "HOME"]) expect(dropFromSeat(k)).toBe(false);
    const home = mkdtempSync(join(tmpdir(), "seat-env-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const file = join(home, "seat-env");
    writeFileSync(file, ('export UNIT_MARK=yes\nexport CODEX_HOME="$HOME/.codex-seat"\nexport ANTHROPIC_API_KEY=sk' + '-ant-should-drop\nCLAUDE_CODE_OAUTH_TOKEN=oauth-kept\nexport FLY_API_TOKEN=fly-drop\n'));
    const base = { PATH: "/usr/bin:/bin", HOME: home, OPENAI_API_KEY: "sk-drop", GITHUB_TOKEN: "gh-drop", WALKIE_HOME: "/w", LC_ALL: "C", TERM: "xterm" };
    const { env, sourced } = await loginEnv(base, home, file, ["UNIT_MARK", "ANTHROPIC_API_KEY"]);
    expect(sourced).toBe(file);
    // An allowlist: the fixed names, LC_*, and the host's extras (never an API key, even when listed).
    expect(Object.keys(env).sort()).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "CODEX_HOME", "HOME", "LC_ALL", "PATH", "TERM", "UNIT_MARK"]);
    expect(env.UNIT_MARK).toBe("yes");
    expect(env.CODEX_HOME).toBe(join(home, ".codex-seat"));
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-kept");
    // Without extras, UNIT_MARK is not passed either.
    expect((await loginEnv(base, home, file)).env.UNIT_MARK).toBeUndefined();
    expect(seatEnvNameProblem("UNIT_MARK")).toBeNull();
    expect(seatEnvNameProblem("WALKIE_SOCKET")).toContain("set by the host daemon");
    expect(seatEnvNameProblem("OPENAI_API_KEY")).toContain("never reach a seat");
    expect(seatEnvNameProblem("A-B")).toContain("not an environment variable name");
    // No seat env file: the base environment, still filtered.
    const bare = await loginEnv({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "x" }, home, join(home, "nope", "seat-env"));
    expect(bare.sourced).toBeNull();
    expect(bare.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("the seat env file: seat-env in the Walkie home by default, or seats.env_file (absolute or ~/)", async () => {
    expect(seatEnvFile("/w/.walkie", "/home/sam")).toBe("/w/.walkie/seat-env");
    expect(seatEnvFile("/w/.walkie", "/home/sam", "~/work/seat.env")).toBe("/home/sam/work/seat.env");
    expect(seatEnvFile("/w/.walkie", "/home/sam", "/etc/walkie/seat.env")).toBe("/etc/walkie/seat.env");
    // Only the chosen file is sourced: a file anywhere else (the person's home included) is not.
    const home = mkdtempSync(join(tmpdir(), "seat-envfile-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const walkieHome = join(home, ".walkie");
    mkdirSync(walkieHome);
    writeFileSync(join(walkieHome, "seat-env"), "export UNIT_MARK=default\n");
    writeFileSync(join(home, "custom.env"), "export UNIT_MARK=custom\n");
    writeFileSync(join(home, ".profile"), "export UNIT_MARK=profile\n");
    const base = { PATH: "/usr/bin:/bin", HOME: home };
    const def = await loginEnv(base, home, seatEnvFile(walkieHome, home), ["UNIT_MARK"]);
    expect([def.sourced, def.env.UNIT_MARK]).toEqual([join(walkieHome, "seat-env"), "default"]);
    const custom = await loginEnv(base, home, seatEnvFile(walkieHome, home, "~/custom.env"), ["UNIT_MARK"]);
    expect([custom.sourced, custom.env.UNIT_MARK]).toEqual([join(home, "custom.env"), "custom"]);
    // seats.env_file is config.json only: an absolute path or ~/…
    expect(SeatsConfig.safeParse({ allow: true, env_file: "~/custom.env" }).success).toBe(true);
    expect(SeatsConfig.safeParse({ allow: true, env_file: "/etc/walkie/seat.env" }).success).toBe(true);
    expect(SeatsConfig.safeParse({ allow: true, env_file: "custom.env" }).success).toBe(false);
  });

  test("Codex seats find codex in $CODEX_HOME/bin after PATH", () => {
    const home = mkdtempSync(join(tmpdir(), "seat-codexhome-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const bin = join(home, ".codex-seat", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "codex"), "#!/bin/sh\n", { mode: 0o755 });
    expect(findRuntime("codex", "/nonexistent", home, join(home, ".codex-seat"))).toBe(join(bin, "codex"));
  });
});

describe("the host's git calls", () => {
  test("a stopped git call ends its whole process group; HEAD is read from the files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seat-git-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const pidFile = join(dir, "child.pid");
    const ac = new AbortController();
    const started = Date.now();
    // An alias shell command stands in for anything git starts (a filter, a hook): it lives in git's process group.
    const call = git(["-c", `alias.slow=!echo $$ > '${pidFile}'; exec sleep 30`, "slow"], dir, { PATH: "/usr/bin:/bin" }, { signal: ac.signal });
    const { existsSync, readFileSync } = await import("node:fs");
    while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8").trim()) await Bun.sleep(20);
    const child = Number(readFileSync(pidFile, "utf8").trim());
    ac.abort();
    const res = await call;
    expect(res.code).toBe(-1);
    expect(Date.now() - started).toBeLessThan(10_000);
    await Bun.sleep(100);
    expect(() => process.kill(child, 0)).toThrow();

    const gitDir = join(dir, "g");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
    const id = "a".repeat(40);
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(gitDir, "packed-refs"), `# pack-refs with: peeled\n${id} refs/heads/main\n`);
    expect(readHead(gitDir)).toBe(id);
    writeFileSync(join(gitDir, "refs", "heads", "main"), `${"b".repeat(40)}\n`);
    expect(readHead(gitDir)).toBe("b".repeat(40));
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/../../etc/passwd\n");
    expect(readHead(gitDir)).toBeNull();
  });
});
