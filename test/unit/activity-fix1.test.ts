// WALKIE-MISSION-1 fix round 1 (Codex 4 / Opus 9): session files are opened only when the session id is a plain id, the
// path stays inside <config dir>/projects (symlinks resolved), and the opened file is a regular file of this user; a
// FIFO put in a transcript's place never blocks the daemon. Plus the transcript parsing fixes (Opus 2).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeProjectSlug, parseTail, SESSION_ID_RE, SessionFiles } from "../../src/daemon/activity.ts";
import { endTurn, jl, prompt, toolCall } from "../helpers/discovery-world.ts";

const dir = mkdtempSync("/tmp/walkie-actfix-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const SID = "aaaa1111-0000-4000-8000-000000000000";

describe("safe session files", () => {
  test("session ids: plain ids only", () => {
    expect(SESSION_ID_RE.test(SID)).toBe(true);
    for (const bad of ["../x", "a/b", "..", "", ".hidden", "x".repeat(81), "a b", "a\u0000b"]) expect(SESSION_ID_RE.test(bad)).toBe(false);
    const files = new SessionFiles();
    expect(files.claudeTranscript(join(dir, "cfg"), "/w", "../../../../etc/passwd", 1)).toBeNull();
  });

  test("a project directory symlinked outside the config directory is not followed", () => {
    const cfg = join(dir, "cfg-link");
    const outside = join(dir, "outside");
    mkdirSync(join(cfg, "projects"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, `${SID}.jsonl`), jl(prompt("someone else's transcript")));
    symlinkSync(outside, join(cfg, "projects", claudeProjectSlug("/w")));
    expect(new SessionFiles().claudeTranscript(cfg, "/w", SID, 1)).toBeNull();
  });

  test("a symlinked transcript file is not read; a FIFO never blocks; another user's file is not read", async () => {
    const cfg = join(dir, "cfg-special");
    const proj = join(cfg, "projects", claudeProjectSlug("/w"));
    mkdirSync(proj, { recursive: true });
    const real = join(dir, "real.jsonl");
    writeFileSync(real, jl(prompt("x")));
    symlinkSync(real, join(proj, `${SID}.jsonl`));
    const files = new SessionFiles();
    expect(files.claudeTranscript(cfg, "/w", SID, 1)).toBeNull();
    expect(files.read(join(proj, `${SID}.jsonl`), "claude")).toBeNull();

    const fifo = join(proj, "bbbb2222-0000-4000-8000-000000000000.jsonl");
    const mk = Bun.spawnSync(["mkfifo", fifo]);
    expect(mk.exitCode).toBe(0);
    const t0 = Date.now();
    expect(files.claudeTranscript(cfg, "/w", "bbbb2222-0000-4000-8000-000000000000", 1)).toBeNull();
    expect(files.read(fifo, "claude")).toBeNull();
    expect(files.openFile(fifo)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_000);

    const mine = join(proj, "cccc3333-0000-4000-8000-000000000000.jsonl");
    writeFileSync(mine, jl(prompt("x")));
    expect(new SessionFiles().claudeTranscript(cfg, "/w", "cccc3333-0000-4000-8000-000000000000", 1)).toBe(mine);
    const asOther = new SessionFiles({ uid: (process.getuid?.() ?? 0) + 12_345 });
    expect(asOther.claudeTranscript(cfg, "/w", "cccc3333-0000-4000-8000-000000000000", 1)).toBeNull();
    expect(asOther.read(mine, "claude")).toBeNull();
  });
});

describe("transcript records (Opus 2)", () => {
  test("slash commands, their output and meta records are not turns; an interrupt ends the turn", () => {
    const cmd = parseTail(jl(prompt("hi"), ...endTurn(),
      { type: "user", message: { role: "user", content: "<command-name>/model</command-name>" } },
      { type: "user", isMeta: true, message: { role: "user", content: "anything" } },
      { type: "user", message: { role: "user", content: "<local-command-stdout>Set model</local-command-stdout>" } }), "claude", true);
    expect(cmd).toMatchObject({ midTurn: false, newestIsTurn: false, prompt: "hi" });
    const esc = parseTail(jl(prompt("do x"), toolCall("Bash", { command: "sleep 9" }),
      { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "interrupted" }, { type: "text", text: "[Request interrupted by user for tool use]" }] } }), "claude", true);
    expect(esc).toMatchObject({ midTurn: false, newestIsTurn: true });
    const bookkeeping = parseTail(jl(toolCall("Bash", { command: "x" }), { type: "queue-operation" }, { type: "ai-title" }), "claude", true);
    expect(bookkeeping).toMatchObject({ midTurn: true, toolRunning: true, newestIsTurn: false });
    const stamped = parseTail(jl({ ...prompt("x"), timestamp: "2026-09-26T10:00:00.000Z" }, { type: "ai-title" }), "claude", true);
    expect(stamped.lastTurnAt).toBe(Date.parse("2026-09-26T10:00:00.000Z"));
  });
});

describe("model", () => {
  test("Claude's <synthetic> marker (an injected message) is not a model", () => {
    const t = parseTail(jl({ type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "a" }] } }, { type: "assistant", message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "b" }] } }), "claude", true);
    expect(t.model).toBe("claude-opus-5-5");
  });
});
