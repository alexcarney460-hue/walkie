// WALK-50 step 3 (OCJ-B): `walkie setup`'s "Background service" step must never leave an already-healthy but
// stale daemon running just because healthz answers ok — after a new binary lands (scripts/install.sh,
// site/install.sh and a bare `walkie setup` on an existing install all reach this), it restarts the service and
// waits for healthz to answer as *this* binary's version, reusing update.ts's restartService/waitForDaemon (the
// same logic `walkie update` already relies on and tests in update-restart.test.ts).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WalkieClient } from "../../src/client/index.ts";
import { companyConsentExit, ensureService } from "../../src/cli/commands/setup.ts";
import type { HealthProbe } from "../../src/cli/commands/update.ts";
import type { Ctx } from "../../src/cli/context.ts";
import type { ServicePlan } from "../../src/daemon/service.ts";
import { VERSION } from "../../src/daemon/version.ts";
import { fakeDaemon } from "../helpers/fake-daemon.ts";

function scripted(answers: Array<{ ok: boolean; version: string } | Error>): HealthProbe & { calls: number } {
  const probe = Object.assign(async () => {
    const a = answers[Math.min(probe.calls++, answers.length - 1)] as { ok: boolean; version: string } | Error;
    if (a instanceof Error) throw a;
    return a;
  }, { calls: 0 });
  return probe;
}

function capture(): Ctx & { outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  return { args: { _: [], flags: {} }, json: false, forAgent: false, client: () => new WalkieClient(), out: (s: string) => outs.push(s), err: (s: string) => errs.push(s), outs, errs } as unknown as Ctx & { outs: string[]; errs: string[] };
}

const dir = mkdtempSync("/tmp/walkie-setup-service-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** An existing service unit file (restartService only restarts a plan whose path is actually on disk). */
const plan = (restart: string[], name: string): ServicePlan => {
  const path = join(dir, name);
  writeFileSync(path, "<plist/>");
  return { platform: "launchd", path, content: "", load: [], unload: [], restart };
};
const client = new WalkieClient();

describe("ensureService", () => {
  test("already running this version: nothing restarted", async () => {
    const ctx = capture();
    const probe = scripted([{ ok: true, version: VERSION }]);
    let installed = false;
    expect(await ensureService(ctx, client, { probe, install: async () => { installed = true; } })).toBe(true);
    expect(ctx.outs.join("\n")).toContain(`already running (${VERSION})`);
    expect(installed).toBe(false);
    expect(probe.calls).toBe(1); // one health check, no restart poll loop
  });

  test("old daemon running: restarted to the new version", async () => {
    const ctx = capture();
    // 1st call: the initial health check (old version, triggers a restart). 2nd/3rd: restartService's own poll,
    // as if the kickstart took one cycle to bring the new binary's daemon up.
    const probe = scripted([{ ok: true, version: "0.1.2" }, { ok: true, version: "0.1.2" }, { ok: true, version: VERSION }]);
    let installed = false;
    const ok = await ensureService(ctx, client, { probe, plan: plan(["true"], "old.plist"), intervalMs: 10, install: async () => { installed = true; } });
    expect(ok).toBe(true);
    expect(installed).toBe(false); // an already-running daemon is restarted, not reinstalled
    expect(ctx.outs.join("\n")).toContain(`running 0.1.2, not ${VERSION}; restarting`);
    expect(ctx.outs.join("\n")).toContain(`daemon answering as ${VERSION}`);
  });

  test("fresh install: no daemon yet, installs and waits for the new version", async () => {
    const ctx = capture();
    let installCalls = 0;
    const probe = scripted([new Error("walkie daemon not reachable"), { ok: true, version: VERSION }]);
    const ok = await ensureService(ctx, client, { probe, intervalMs: 10, install: async () => { installCalls++; } });
    expect(ok).toBe(true);
    expect(installCalls).toBe(1);
    expect(ctx.outs.join("\n")).toContain(`answering as ${VERSION}`);
    expect(ctx.outs.join("\n")).toContain("starts at login, restarts on crash");
  });

  test("fresh install that never comes up: false, with a clear timeout message", async () => {
    const ctx = capture();
    const probe = scripted([new Error("walkie daemon not reachable")]);
    const ok = await ensureService(ctx, client, { probe, timeoutMs: 150, intervalMs: 20, install: async () => {} });
    expect(ok).toBe(false);
    const err = ctx.errs.join("\n");
    expect(err).toContain("did not come up within 0.15 s");
    expect(err).toContain("no answer (walkie daemon not reachable)");
    expect(err).toContain("walkie doctor");
  });

  test("old daemon running but the restart command itself fails: false, with the reason", async () => {
    const ctx = capture();
    const probe = scripted([{ ok: true, version: "0.1.2" }]);
    const ok = await ensureService(ctx, client, { probe, plan: plan(["false"], "fail.plist") });
    expect(ok).toBe(false);
    expect(ctx.errs.join("\n")).toContain("could not restart the service: false exited 1");
    expect(ctx.outs.join("\n")).not.toContain("restarted");
  });
});

describe("company enrollment setup exit", () => {
  test("the actual nonterminal setup process exits 4 before later steps", async () => {
    const daemon = fakeDaemon({
      "GET /v1/me": { team: { id: "team", name: "Team" }, handle: "kira", role: "member", tailscale: { ok: false } },
      "GET /v1/seats": { local: { allow: false }, hosts: [], seats: [] },
    });
    try {
      const child = Bun.spawn([process.execPath, "src/cli/main.ts", "setup", "--no-service", "--no-hooks",
        "--no-switching", "--company-machine", "--invite", "wk1fixture"], {
        cwd: process.cwd(), stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { ...process.env, WALKIE_SOCKET: daemon.socket, WALKIE_HOME: dir },
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(code).toBe(4);
      expect(out).toContain("type yes at this machine's terminal");
      expect(err).toContain("walkie setup --invite <private-code> --company-machine");
      expect(out).not.toContain("Account switching (optional)");
      expect(daemon.requests.every((r) => r.method === "GET")).toBe(true);
    } finally { daemon.stop(); }
  });

  test("refused and incomplete consent return a distinct status and an actionable retry", () => {
    for (const outcome of ["refused", "incomplete"] as const) {
      const ctx = { ...capture(), args: { pos: [], flags: new Map([["company-machine", true]]) } as Ctx["args"] };
      expect(companyConsentExit(ctx, outcome)).toBe(4);
      expect(ctx.errs.join("\n")).toContain("walkie setup --invite <private-code> --company-machine");
      expect(ctx.errs.join("\n")).toContain("type yes");
    }
  });

  test("allowed and explicitly declined company seats do not fail ordinary setup", () => {
    for (const outcome of ["allowed", "declined"] as const) {
      const ctx = { ...capture(), args: { pos: [], flags: new Map([["company-machine", true]]) } as Ctx["args"] };
      expect(companyConsentExit(ctx, outcome)).toBeNull();
      expect(ctx.errs).toEqual([]);
    }
  });
});
