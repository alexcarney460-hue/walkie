// v0.1.3: `walkie update` restarts the service, then waits (up to 30 s) until the daemon answers healthz as the new
// version, and fails clearly when it doesn't (a 0.1.1 → 0.1.2 update left a daemon with no socket for minutes
// while update had already reported success).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WalkieClient } from "../../src/client/index.ts";
import { restartService, waitForDaemon, type HealthProbe } from "../../src/cli/commands/update.ts";
import type { Ctx } from "../../src/cli/context.ts";
import type { ServicePlan } from "../../src/daemon/service.ts";
import { VERSION } from "../../src/daemon/version.ts";
import { Cluster } from "../helpers/cluster.ts";

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

const dir = mkdtempSync("/tmp/walkie-restart-");
const unit = join(dir, "dev.walkie.daemon.plist");
writeFileSync(unit, "<plist/>");
const plan = (restart: string[]): ServicePlan => ({ platform: "launchd", path: unit, content: "", load: [], unload: [], restart });
const c = new Cluster();
afterAll(async () => { await c.close(); rmSync(dir, { recursive: true, force: true }); });

describe("waitForDaemon", () => {
  test("keeps polling through no answer and the old version until the new version answers", async () => {
    const probe = scripted([new Error("socket missing"), { ok: true, version: "0.1.2" }, { ok: true, version: "0.1.3" }]);
    const r = await waitForDaemon("v0.1.3", probe, 5_000, 10);
    expect(r.ok).toBe(true);
    expect(probe.calls).toBe(3);
  });

  test("gives up after the timeout and says what it saw last", async () => {
    const t0 = Date.now();
    const none = await waitForDaemon("0.1.3", scripted([new Error("walkie daemon not reachable")]), 300, 20);
    expect(none).toEqual({ ok: false, last: "no answer (walkie daemon not reachable)" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    const old = await waitForDaemon("0.1.3", scripted([{ ok: true, version: "0.1.2" }]), 200, 20);
    expect(old).toEqual({ ok: false, last: "answering as 0.1.2, not 0.1.3" });
  });
});

describe("restartService", () => {
  test("restart, then success once the real daemon answers healthz as this version", async () => {
    const node = await c.add({ name: "alex", login: "alex@example.com" });
    const ctx = capture();
    const probe = () => new WalkieClient({ socket: node.socket, timeoutMs: 2_000 }).healthz();
    expect(await restartService(ctx, VERSION, { plan: plan(["true"]), probe, timeoutMs: 5_000, intervalMs: 20 })).toBe(true);
    expect(ctx.outs.join("\n")).toContain(`daemon answering as ${VERSION}`);
    expect(ctx.errs).toEqual([]);
  });

  test("a daemon that never answers: false, with the reason and where to look", async () => {
    const ctx = capture();
    const ok = await restartService(ctx, "0.1.3", { plan: plan(["true"]), probe: scripted([new Error("walkie daemon not reachable")]), timeoutMs: 200, intervalMs: 20 });
    expect(ok).toBe(false);
    const err = ctx.errs.join("\n");
    expect(err).toContain("did not answer healthz within 0.2 s");
    expect(err).toContain("no answer (walkie daemon not reachable)");
    expect(err).toContain("daemon.out");
    expect(err).toContain("walkie doctor");
  });

  test("a failing restart command: false, never reported as restarted", async () => {
    const ctx = capture();
    const probe = scripted([{ ok: true, version: "0.1.3" }]);
    expect(await restartService(ctx, "0.1.3", { plan: plan(["false"]), probe, timeoutMs: 200 })).toBe(false);
    expect(ctx.errs.join("\n")).toContain("could not restart the service: false exited 1");
    expect(ctx.outs.join("\n")).not.toContain("restarted");
    expect(probe.calls).toBe(0);
  });

  test("no service installed: nothing to wait for", async () => {
    const ctx = capture();
    const missing: ServicePlan = { ...plan(["true"]), path: join(dir, "absent.plist") };
    expect(await restartService(ctx, "0.1.3", { plan: missing, probe: scripted([new Error("x")]) })).toBe(true);
    expect(ctx.outs.join("\n")).toContain("no service installed");
  });
});
