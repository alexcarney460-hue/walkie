import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelGate } from "./policy.ts";
import { dispatch } from "../local-routes.ts";
import "./routes.ts";

const owner = "+15551230001";
const other = "+15551230002";

test("review probe: unknown messages cannot replace a damaged quota or reopen it after restart", () => {
  const file = join(mkdtempSync(join(tmpdir(), "walkie-channel-damaged-")), "quota.json");
  writeFileSync(file, "{invalid");
  const gate = new ChannelGate(() => 1_000, file, () => true);
  expect(gate.receive("whatsapp-web", owner, owner, true)).toBe("limited");
  expect(gate.receive("whatsapp-web", other, owner, true)).toBe("unknown");
  expect(readFileSync(file, "utf8")).toBe("{invalid");
  expect(gate.quotaDamaged).toBe(true);
  expect(new ChannelGate(() => 1_000, file, () => true).receive("sms-gvoice", owner, owner, true)).toBe("limited");
});

test("person reset preserves damaged bytes in a timestamped file and starts fresh counters", () => {
  const dir = mkdtempSync(join(tmpdir(), "walkie-channel-reset-"));
  const file = join(dir, "quota.json");
  writeFileSync(file, "{invalid");
  const gate = new ChannelGate(() => 1_000, file, () => true);
  const backup = gate.resetQuota();
  expect(backup).toMatch(/quota\.json\.damaged-\d{4}-\d{2}-\d{2}T/);
  expect(readFileSync(backup!, "utf8")).toBe("{invalid");
  expect(existsSync(file)).toBe(true);
  expect(gate.quotaDamaged).toBe(false);
  expect(gate.receive("whatsapp-web", owner, owner, true)).toBe("accepted");
  expect(new ChannelGate(() => 1_000, file, () => true).receive("sms-gvoice", owner, owner, true)).toBe("accepted");
  expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("invalid records and a missing record after backup remain closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "walkie-channel-invalid-r3-"));
  const file = join(dir, "quota.json");
  writeFileSync(file, JSON.stringify({ ignored: 0, numbers: { [owner]: [1_000] }, machine: ["bad"] }));
  expect(new ChannelGate(() => 1_000, file, () => true).receive("whatsapp-web", owner, owner, true)).toBe("limited");
  writeFileSync(file, JSON.stringify({ ignored: 0, numbers: {} }));
  expect(new ChannelGate(() => 1_000, file, () => true).receive("whatsapp-web", owner, owner, true)).toBe("limited");
  writeFileSync(file, JSON.stringify({ ignored: 0, numbers: {}, machine: [] }));
  const gate = new ChannelGate(() => 1_000, file, () => true);
  writeFileSync(file, "{invalid");
  expect(gate.receive("whatsapp-web", owner, owner, true)).toBe("limited");
  expect(readFileSync(file, "utf8")).toBe("{invalid");
  renameSync(file, `${file}.damaged-2026-10-04T00-00-00-000Z-test`);
  expect(new ChannelGate(() => 1_000, file, () => true).receive("whatsapp-web", owner, owner, true)).toBe("limited");
  const restarted = new ChannelGate(() => 1_000, file, () => true);
  const preserved = restarted.resetQuota();
  expect(readFileSync(preserved!, "utf8")).toBe("{invalid");
  expect(restarted.receive("whatsapp-web", owner, owner, true)).toBe("accepted");
});

test("reset route is person-only and status explains the pause", async () => {
  const home = mkdtempSync(join(tmpdir(), "walkie-channel-route-r3-"));
  const file = join(home, "channels", "quota.json");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(home, "channels"));
  writeFileSync(file, "{invalid");
  const core = { paths: { home, config: join(home, "config.json") }, hostname: "test", myHandle: () => "alex",
    teamId: "team", me: () => ({ handle: "alex" }), roster: { channels: new Map([["general", {}]]) },
    emit() { return {}; }, log: { info() {}, warn() {} } };
  const call = (method: string, path: string, opts: { agent?: string; via?: "cli" | "phone" } = {}) => {
    const url = new URL(`http://walkie${path}`);
    return dispatch({ req: new Request(url, { method }), url, core, via: opts.via ?? "cli", agent: opts.agent, noTimeout() {} } as never);
  };
  const status = await (await call("GET", "/v1/channels/status")).json() as { quota_damaged: boolean; notice: string };
  expect(status.quota_damaged).toBe(true);
  expect(status.notice).toContain("channels are paused because the quota record is damaged");
  const health = await (await call("GET", "/v1/channels/health")).json() as { quota_damaged: boolean; notice: string };
  expect(health.quota_damaged).toBe(true);
  expect(health.notice).toBe(status.notice);
  for (const opts of [{ agent: "worker" }, { via: "phone" as const }])
    await expect(call("POST", "/v1/channels/reset-quota", opts)).rejects.toThrow();
  expect(readFileSync(file, "utf8")).toBe("{invalid");
  const response = await (await call("POST", "/v1/channels/reset-quota")).json() as { quota_damaged: boolean; backup: string };
  expect(response.quota_damaged).toBe(false);
  expect(readFileSync(response.backup, "utf8")).toBe("{invalid");
});
