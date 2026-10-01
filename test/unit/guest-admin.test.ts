import { expect, test } from "bun:test";
import { grantGuest } from "../../src/mcp/guest-admin.ts";
import { GuestRegistry } from "../../src/mcp/guest-registry.ts";
import type { GuestData } from "../../src/mcp/guest-scope.ts";
import "../../src/mcp/guest-routes.ts";
import { hasRoute } from "../../src/daemon/local-routes.ts";
import { dashboardRoute } from "../../src/daemon/local-api.ts";

test("person dashboard can reach guest administration routes", () => {
  for (const [method, path] of [["GET", "/v1/guests"], ["GET", "/v1/guests/audit"], ["POST", "/v1/guests"], ["POST", "/v1/guests/kill"], ["POST", "/v1/guests/dots-ops/revoke"]]) {
    expect(hasRoute(method as string, path as string)).toBe(true);
    expect(dashboardRoute(method as string, path as string)).toBe(true);
  }
});

test("grant is person-owned and every bound card must already be assigned", () => {
  const values = new Map<string, string>();
  const registry = new GuestRegistry({ getMeta: (k) => values.get(k) ?? null, setMeta: (k, v) => { values.set(k, v); } });
  const data: Pick<GuestData, "card" | "project"> = {
    card: (id) => id === "aaaaaaaaaaaaaaaa:1" ? { id, channel: "p-11111111", key: "WEB-1", ref: "WEB-1-aaaaaaaa", title: "Assigned", body: "Work", assignee: "@alex/cloud/dots-ops", labels: [], state: "open", column: "todo", updated_at: 1 } : null,
    project: () => ({ channel: "p-11111111", name: "Allowed", prefix: "WEB", private: false, state: "active" }),
  };
  const input = { family: "dots" as const, name: "ops", subject: "tunnel-alex", cardIds: ["aaaaaaaaaaaaaaaa:1"], tools: ["walkie_task"] };
  expect(grantGuest(registry, data, "alex", "1234567890abcdef", input, 60_000).guest.address).toBe("@alex/cloud/dots-ops");
  expect(() => grantGuest(registry, data, "alex", "1234567890abcdef", { ...input, cardIds: ["aaaaaaaaaaaaaaaa:2"] }, 60_000)).toThrow(/assigned/);
  expect(() => grantGuest(registry, data, "alex", "1234567890abcdef", { ...input, tools: ["walkie_cli"] }, 60_000)).toThrow(/allowed/);
  data.project = () => ({ channel: "p-11111111", name: "Allowed", prefix: "WEB", private: true, state: "active" });
  expect(() => grantGuest(registry, data, "alex", "1234567890abcdef", input, 60_000)).toThrow(/assigned/);
});
