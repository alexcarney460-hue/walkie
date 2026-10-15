import { expect, test } from "bun:test";
import { requireOssCapability, requireOssPerson } from "../../src/daemon/seats/routes.ts";
import { seat } from "../../src/cli/commands/seats.ts";
import type { Ctx } from "../../src/cli/context.ts";
import { peerCapabilities } from "../../src/daemon/peer-capabilities.ts";
import { SEATS_CODEX_OSS_CAP, SEATS_V2_CAP } from "../../src/protocol/seats.ts";

test("consent is local person-only even when generic agent admin would be enabled", () => {
  const base = { agent: undefined, underAgent: false, via: "cli" as const, req: new Request("http://walkie/v1/seats/codex-oss") };
  expect(() => requireOssPerson(base)).not.toThrow();
  for (const overrides of [{ agent: "builder" }, { underAgent: true }, { via: "dashboard" as const }, { via: "phone" as const },
    { req: new Request(base.req, { headers: { "x-walkie-admin-token": "fake" } }) },
    { req: new Request(base.req, { headers: { "x-walkie-talkie-shell": "1" } }) }]) {
    expect(() => requireOssPerson({ ...base, ...overrides })).toThrow();
  }
});

test("capability requires positive authenticated host evidence, not stats or arbitrary announced flags", () => {
  for (const caps of [undefined, [], [SEATS_V2_CAP], [SEATS_CODEX_OSS_CAP]]) {
    const c = { core: { nodeId: "self" }, sync: { peerCapabilities: () => caps ? { caps } : undefined } } as never;
    expect(() => requireOssCapability(c, "remote")).toThrow();
  }
  const c = { core: { nodeId: "self" }, sync: { peerCapabilities: () => ({ caps: [SEATS_V2_CAP, SEATS_CODEX_OSS_CAP] }) } } as never;
  expect(() => requireOssCapability(c, "remote")).not.toThrow();
});

test("CLI negative capability stops before brief-file read, delta or repo upload", async () => {
  let checked = false, uploaded = false;
  const ctx = { args: { pos: ["run"], flags: new Map([
    ["machine", "host"], ["runtime", "codex"], ["model", "fake:1"], ["local-provider", "ollama"],
    ["brief-file", "/nonexistent-private-brief"], ["repo-id", "repo"], ["ref", "main"], ["delta", "/nonexistent-delta"],
  ]) }, client: () => ({ seatsOssPreflight: async () => { checked = true; throw new Error("unsupported host"); },
    seatsBundle: async () => { uploaded = true; throw new Error("UPLOAD"); } }) } as unknown as Ctx;
  await expect(seat(ctx)).rejects.toThrow("unsupported host");
  expect(checked).toBe(true); expect(uploaded).toBe(false);
});


test("forged storage caps are not authenticated evidence; a later negative snapshot stays negative", () => {
  const metadata = new Map<string, string>();
  const store = { getMeta: (k: string) => metadata.get(k) ?? null } as never;
  metadata.set("peer_capabilities:remote", JSON.stringify({ version: "0.2.0-pre.13", caps: [SEATS_V2_CAP, SEATS_CODEX_OSS_CAP] }));
  const c = { core: { nodeId: "self" }, sync: { peerCapabilities: (node: string) => peerCapabilities(store, node) } } as never;
  expect(() => requireOssCapability(c, "remote")).toThrow();
  metadata.set("peer_caps_verified:remote", "1");
  expect(() => requireOssCapability(c, "remote")).not.toThrow();
  metadata.set("peer_capabilities:remote", JSON.stringify({ version: "0.2.0-pre.13", caps: [SEATS_V2_CAP] }));
  expect(() => requireOssCapability(c, "remote")).toThrow();
});
