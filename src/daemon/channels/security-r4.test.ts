import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dispatch } from "../local-routes.ts";
import { loadConfig } from "../config.ts";
import { ChannelGate } from "./policy.ts";
import "./routes.ts";

const owner = "+15551230001";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "walkie-channel-r4-"));
  const config = join(home, "config.json");
  const file = join(home, "channels", "quota.json");
  const core = { paths: { home, config }, hostname: "test", myHandle: () => "alex",
    teamId: "team", me: () => ({ handle: "alex" }), roster: { channels: new Map([["general", {}]]) },
    emit() { return {}; }, log: { info() {}, warn() {} } };
  const call = (method: string, path: string, body?: object) => {
    const url = new URL(`http://walkie${path}`);
    const req = new Request(url, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
    return dispatch({ req, url, core, via: "cli", noTimeout() {} } as never);
  };
  const gate = () => new ChannelGate(() => 1_000, file, () => !!loadConfig(config, false).channels_quota_initialized,
    () => loadConfig(config, false).channels_enabled);
  return { config, file, call, gate };
}

async function enable(f: ReturnType<typeof fixture>) {
  const warning = await (await f.call("GET", "/v1/channels/config")).json() as { warning_sha256: string };
  await f.call("POST", "/v1/channels/config", { owner_number: owner });
  await f.call("POST", "/v1/channels/config", { enabled: true, acknowledge_risk: warning.warning_sha256 });
}

test("first enable creates committed quota and timestamp in one settings record; disabling retains it", async () => {
  const f = fixture();
  expect(existsSync(f.file)).toBe(false);
  expect(f.gate().quotaDamaged).toBe(false);
  expect(f.gate().receive("whatsapp-web", owner, owner, true)).toBe("limited");
  expect(existsSync(f.file)).toBe(false);
  await enable(f);
  expect(readFileSync(f.file, "utf8")).toContain('"numbers":{}');
  const stamp = loadConfig(f.config, false).channels_quota_initialized;
  expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(readdirSync(dirname(f.config)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  await f.call("POST", "/v1/channels/config", { enabled: false });
  expect(loadConfig(f.config, false).channels_quota_initialized).toBe(stamp);
  unlinkSync(f.file);
  expect(f.gate().quotaDamaged).toBe(true);
});

test("reviewer probe: a vanished committed quota after restart stays paused until person reset", async () => {
  const f = fixture();
  await enable(f);
  const gate = f.gate();
  for (let i = 0; i < 10; i++) expect(gate.receive("whatsapp-web", owner, owner, true)).toBe("accepted");
  expect(gate.receive("sms-gvoice", owner, owner, true)).toBe("limited");
  unlinkSync(f.file);
  expect(f.gate().receive("sms-gvoice", owner, owner, true)).toBe("limited");
  const status = await (await f.call("GET", "/v1/channels/health")).json() as { quota_damaged: boolean };
  expect(status.quota_damaged).toBe(true);
  const reset = await (await f.call("POST", "/v1/channels/reset-quota")).json() as { quota_damaged: boolean; backup: string | null };
  expect(reset.quota_damaged).toBe(false);
  expect(reset.backup).toBeNull();
  expect(f.gate().receive("sms-gvoice", owner, owner, true)).toBe("accepted");
});

test("reset recovers when the whole quota directory disappeared", async () => {
  const f = fixture();
  await enable(f);
  const { rmSync } = await import("node:fs");
  rmSync(dirname(f.file), { recursive: true });
  expect(f.gate().quotaDamaged).toBe(true);
  const reset = await (await f.call("POST", "/v1/channels/reset-quota")).json() as { quota_damaged: boolean; backup: string | null };
  expect(reset.quota_damaged).toBe(false);
  expect(reset.backup).toBeNull();
  expect(existsSync(f.file)).toBe(true);
});

test("quota file with missing initialization flag is damage and reset repairs both records", async () => {
  const f = fixture();
  await enable(f);
  const raw = JSON.parse(readFileSync(f.config, "utf8")) as Record<string, unknown>;
  delete raw.channels_quota_initialized;
  writeFileSync(f.config, JSON.stringify(raw));
  expect(f.gate().quotaDamaged).toBe(true);
  const warning = await (await f.call("GET", "/v1/channels/config")).json() as { warning_sha256: string };
  await expect(f.call("POST", "/v1/channels/config", { enabled: true, acknowledge_risk: warning.warning_sha256 })).rejects.toThrow("quota record is damaged");
  const reset = await (await f.call("POST", "/v1/channels/reset-quota")).json() as { quota_damaged: boolean; backup: string };
  expect(reset.quota_damaged).toBe(false);
  expect(readFileSync(reset.backup, "utf8")).toContain('"numbers":{}');
  expect(loadConfig(f.config, false).channels_quota_initialized).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(f.gate().quotaDamaged).toBe(false);
});

test("enabled settings without either marker or quota are damage, not first run", async () => {
  const f = fixture();
  await enable(f);
  unlinkSync(f.file);
  const raw = JSON.parse(readFileSync(f.config, "utf8")) as Record<string, unknown>;
  delete raw.channels_quota_initialized;
  writeFileSync(f.config, JSON.stringify(raw));
  expect(f.gate().quotaDamaged).toBe(true);
  const reset = await (await f.call("POST", "/v1/channels/reset-quota")).json() as { quota_damaged: boolean };
  expect(reset.quota_damaged).toBe(false);
  expect(f.gate().quotaDamaged).toBe(false);
});
