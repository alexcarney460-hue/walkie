// JOIN-STATUS-1: the pure pieces of the post-join #general status — Claude/Codex readiness from the seats doctor's
// own facts, a few cheap local health checks, and the message they compose into. The daemon wiring (posted once,
// retried until #general exists) is exercised end to end in test/integration/join-status.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { basicHealth, joinStatusText, runtimeReadiness, type JoinStatusFacts } from "../../src/daemon/join-status.ts";
import type { DoctorFacts } from "../../src/daemon/seats/doctor.ts";
import type { SeatsLocalView } from "../../src/protocol/seats.ts";

function local(over: Partial<SeatsLocalView> = {}): SeatsLocalView {
  return { claude_login: "machine", codex_login: "machine", ...over } as SeatsLocalView;
}
function facts(over: Partial<DoctorFacts["runtimes"]> = {}): DoctorFacts {
  return { team: "acme", release: false, runnerProblem: null, helper: "ok", rootsFile: "ok", runtimes: { claude: "/bin/claude", codex: "/bin/codex", ...over } };
}

describe("runtimeReadiness", () => {
  test("both installed and logged in: ready", () => {
    const { claude, codex } = runtimeReadiness(local(), facts());
    expect(claude).toEqual({ ready: true });
    expect(codex).toEqual({ ready: true });
  });

  test("not installed: not ready, says so", () => {
    const { claude, codex } = runtimeReadiness(local(), facts({ claude: null, codex: null }));
    expect(claude).toEqual({ ready: false, why: "Claude Code not installed" });
    expect(codex).toEqual({ ready: false, why: "Codex not installed" });
  });

  test("installed but not signed in: not ready, says so", () => {
    const { claude, codex } = runtimeReadiness(local({ claude_login: "unavailable", codex_login: "unavailable" }), facts());
    expect(claude).toEqual({ ready: false, why: "Claude Code not signed in" });
    expect(codex).toEqual({ ready: false, why: "Codex not signed in" });
  });

  test("a dedicated Claude token still counts as ready", () => {
    const { claude } = runtimeReadiness(local({ claude_login: "dedicated" }), facts());
    expect(claude).toEqual({ ready: true });
  });
});

describe("basicHealth", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  function tmp(): string { const d = mkdtempSync("/tmp/walkie-join-status-"); dirs.push(d); return d; }

  test("no files at all: ok (nothing to check yet)", () => {
    const dir = tmp();
    const paths = { socket: join(dir, "walkie.sock"), key: join(dir, "node.key"), db: join(dir, "walkie.db") };
    expect(basicHealth(paths)).toEqual({ ok: true });
  });

  test("a world-readable node key fails", () => {
    const dir = tmp();
    const key = join(dir, "node.key");
    writeFileSync(key, "secret", { mode: 0o644 });
    const paths = { socket: join(dir, "walkie.sock"), key, db: join(dir, "walkie.db") };
    const h = basicHealth(paths);
    expect(h.ok).toBe(false);
    expect(h.why).toContain("node key");
  });

  test("an open socket permission fails", () => {
    const dir = tmp();
    const socket = join(dir, "walkie.sock");
    writeFileSync(socket, "");
    chmodSync(socket, 0o666);
    const paths = { socket, key: join(dir, "node.key"), db: join(dir, "walkie.db") };
    const h = basicHealth(paths);
    expect(h.ok).toBe(false);
    expect(h.why).toContain("socket");
  });

  test("a corrupt database fails", () => {
    const dir = tmp();
    const db = join(dir, "walkie.db");
    writeFileSync(db, "not a sqlite file");
    const paths = { socket: join(dir, "walkie.sock"), key: join(dir, "node.key"), db };
    const h = basicHealth(paths);
    expect(h.ok).toBe(false);
  });
});

const READY: JoinStatusFacts = {
  handle: "kira", machine: "kiras-mbp", version: "0.2.0-pre.8", seats: { running: 0, max: 3 },
  claude: { ready: true }, codex: { ready: true }, health: { ok: true },
};

describe("joinStatusText", () => {
  test("everything ready: the exact target shape", () => {
    expect(joinStatusText(READY)).toBe("Ready: @kira's kiras-mbp, Walkie 0.2.0-pre.8, seats 0/3, Claude/Codex ready");
  });

  test("Claude missing: a specific partial status naming it", () => {
    const text = joinStatusText({ ...READY, claude: { ready: false, why: "Claude Code not installed" } });
    expect(text).toBe("Partial: @kira's kiras-mbp, Walkie 0.2.0-pre.8, seats 0/3 — missing: Claude Code not installed");
    expect(text.startsWith("Ready:")).toBe(false);
  });

  test("Codex missing: named, Claude left out of the missing list", () => {
    const text = joinStatusText({ ...READY, codex: { ready: false, why: "Codex not signed in" } });
    expect(text).toContain("missing: Codex not signed in");
    expect(text).not.toContain("Claude");
  });

  test("a seat enrollment block prevents a Ready announcement even when both runtimes are signed in", () => {
    const text = joinStatusText({ ...READY, disabled_reason: "enrollment migration requires local elevation: run walkie provision migrate-enrollment" });
    expect(text).toContain("enrollment migration requires local elevation: run walkie provision migrate-enrollment");
    expect(text.startsWith("Ready:")).toBe(false);
  });

  test("everything wrong: every reason named, in order", () => {
    const text = joinStatusText({
      handle: "kira", machine: "kiras-mbp", version: "0.2.0-pre.8", seats: { running: 0, max: 3 },
      claude: { ready: false, why: "Claude Code not installed" }, codex: { ready: false, why: "Codex not installed" },
      health: { ok: false, why: "the local database failed its integrity check" },
    });
    expect(text).toBe(
      "Partial: @kira's kiras-mbp, Walkie 0.2.0-pre.8, seats 0/3 — missing: the local database failed its "
      + "integrity check; Claude Code not installed; Codex not installed",
    );
  });

  test("an unlimited seats max still reads as a plain number (no seats enabled: max is a plain default, never null)", () => {
    expect(joinStatusText({ ...READY, seats: { running: 2, max: 3 } })).toContain("seats 2/3");
  });
});
