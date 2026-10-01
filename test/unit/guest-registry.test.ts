import { expect, test } from "bun:test";
import { GuestRegistry } from "../../src/mcp/guest-registry.ts";

function store() {
  const values = new Map<string, string>();
  return { getMeta: (key: string) => values.get(key) ?? null, setMeta: (key: string, value: string) => { values.set(key, value); }, values };
}

test("tokens bind to a named owner, tunnel subject, tools and cards", () => {
  let now = 1_000;
  const db = store();
  const registry = new GuestRegistry(db, () => now);
  const { token, guest } = registry.issue({ owner: "alex", node: "1234567890abcdef", family: "dots", name: "ops", subject: "tunnel-alex", cardIds: ["aaaaaaaaaaaaaaaa:1"], tools: ["walkie_task"] }, 60_000);
  expect(guest.address).toBe("@alex/cloud/dots-ops");
  expect(registry.authenticate(token, "tunnel-alex")?.id).toBe(guest.id);
  expect(registry.authenticate(token, "other")).toBeNull();
  expect(registry.authenticate("invalid", "tunnel-alex")).toBeNull();
  expect(new GuestRegistry(db, () => now).authenticate(token, "tunnel-alex")?.id).toBe(guest.id);
  now = 61_001;
  expect(registry.authenticate(token, "tunnel-alex")).toBeNull();
});

test("rotation, per guest revoke and persisted global kill invalidate old tokens", () => {
  const db = store();
  const registry = new GuestRegistry(db, () => 1_000);
  const input = { owner: "alex", node: "1234567890abcdef", family: "grokbot" as const, name: "ops", subject: "bot", cardIds: ["aaaaaaaaaaaaaaaa:1"], tools: ["walkie_task"] };
  const first = registry.issue(input, 60_000);
  const second = registry.issue(input, 60_000);
  expect(registry.authenticate(first.token, "bot")).toBeNull();
  expect(registry.authenticate(second.token, "bot")).not.toBeNull();
  registry.revoke(second.guest.id);
  expect(registry.authenticate(second.token, "bot")).toBeNull();
  const third = registry.issue(input, 60_000);
  registry.killAll(true);
  expect(new GuestRegistry(db, () => 1_000).authenticate(third.token, "bot")).toBeNull();
  expect(registry.audit().some((entry) => entry.kind === "global_kill")).toBe(true);
  expect(JSON.stringify(registry.audit())).not.toContain(third.token);
});

test("tunnel nonce replay is rejected across registry instances", () => {
  const db = store();
  const first = new GuestRegistry(db, () => 1_000);
  expect(first.consumeNonce("tunnel-alex", "one")).toBe(true);
  const restarted = new GuestRegistry(db, () => 1_000);
  expect(restarted.consumeNonce("tunnel-alex", "one")).toBe(false);
  expect(restarted.consumeNonce("tunnel-alex", "two")).toBe(true);
  expect([...db.values.values()].join("")).not.toContain("tunnel-alex");
});

test("early audit counts separate sources and minutes and persist at rollover", () => {
  let now = 1_000;
  const db = store();
  const registry = new GuestRegistry(db, () => now);
  for (let i = 0; i < 3; i++) registry.recordEarly("rejected", 404, "source-a");
  registry.recordEarly("rejected", 404, "source-b");
  expect(registry.audit().find((entry) => entry.source === "source-a")?.count).toBe(3);
  now = 61_000;
  registry.recordEarly("rejected", 404, "source-a");
  registry.flushEarly();
  const audit = new GuestRegistry(db, () => now).audit();
  expect(audit.filter((entry) => entry.source === "source-a").map((entry) => entry.count)).toEqual([3, 1]);
  expect(audit.find((entry) => entry.source === "source-b")?.count).toBe(1);
});
