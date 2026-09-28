// COMPANY POOL / RESET-CLOCK-1 on the Accounts page: the team policy, who uses which account now, when the next
// account frees (live countdown, exact time on hover) and the suggested split.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountView, NodeView } from "../src/api/types.ts";
import { PoolBanner, PoolPanel } from "../src/components/AccountsPool.tsx";
import { DEFAULT_SEAT_CAP } from "../../src/protocol/fleet.ts";
import { DEFAULT_HOST_MAX } from "../../src/protocol/seats.ts";

const NOW = Date.UTC(2026, 8, 27, 20, 0);
const H = 3_600_000;
const text = (html: string) => html.replace(/<[^>]+>/g, "");
const node = (id: string, host: string, handle: string, self = false): NodeView =>
  ({ node_id: id, handle, hostname: host, ip: "100.64.0.1", online: true, last_seen: NOW, rtt_ms: 3, self, sync: { behind: 0, last_sync: NOW } });
const acct = (over: Partial<AccountView>): AccountView => ({
  key: "alex:a", id: "a".repeat(24), provider: "claude", label: "al***@ex***.com", plan: "Max", owners: ["alex"], claimed_by: [], usage_host: "alex-mac", last_seen: NOW,
  usage: { at: NOW - 60_000, state: "ok", reason: null, source: "api", until: null, windows: [{ kind: "session", used_pct: 30, resets_at: NOW + 2 * H, window_s: 18_000, scope: null }] },
  machines: [{ node_id: "n1", hostname: "alex-mac", handle: "alex", online: true, self: true, agents: ["cc-1"], usage: null, vault: { policy: "own", company: true, home_at: 1 } }],
  leases: [{ handle: "kira", hostname: "kira-mac", node_id: "n2", agent: "cx-9", since: NOW - H, verified: true }], ...over,
});
const out = acct({
  key: "kira:b", id: "b".repeat(24), label: "ky***@ex***.com", owners: ["kira"],
  usage: { at: NOW - 3 * H, state: "exhausted", reason: "limit_reached", source: "api", until: NOW + 72 * 60_000, windows: [] },
  clock: [{ kind: "session", scope: null, window_s: 18_000, resets_at: NOW + 72 * 60_000, observed_at: NOW - 3 * H, exhausted: true, source: "api" }],
  machines: [{ node_id: "n2", hostname: "kira-mac", handle: "kira", online: true, self: false, agents: [], usage: null, vault: { policy: "own", company: true, home_at: 1 } }],
  leases: [],
});
const nodes = [node("n1", "alex-mac", "alex", true), node("n2", "kira-mac", "kira")];
const ON = { policy: "company" as const, at: NOW - H, by: "alex" };
const panel = (now = NOW, pool: { policy: "company" | "per-account"; at: number | null; by: string | null } | null = ON) =>
  renderToStaticMarkup(<PoolPanel accounts={[acct({}), out]} nodes={nodes} pool={pool} now={now} />);

test("pool on: pooled count, who uses which account now, the personal reserve", () => {
  const t = text(panel());
  expect(t).toContain("Company pool");
  expect(t).toContain("On");
  expect(t).toContain("2 logins pooled");
  expect(t).toContain("last 10% of each is kept for its person");
  expect(t).toContain("kira-mac cx-9 → al***@ex***.com");
  expect(t).toContain("alex-mac cc-1 → al***@ex***.com");
});

test("the next account to free counts down live with the exact time on hover", () => {
  const html = panel();
  expect(text(html)).toContain("Next Claude frees in 1h 12m");
  expect(html).toContain(`<time dateTime="${new Date(NOW + 72 * 60_000).toISOString()}" title="`);
  expect(text(panel(NOW + 60 * 60_000))).toContain("Next Claude frees in 12m");
});

test("a suggested split: seats per login per machine, the out login gets none", () => {
  const t = text(panel());
  expect(t).toContain("Suggested split");
  expect(t).toContain("alex-mac 3 × al***@ex***.com");
  expect(t).toContain("kira-mac 3 × al***@ex***.com");
  expect(t).not.toMatch(/× ky\*\*\*/);
});

test("pool off (the default, and unknown) says so; the default seat cap matches the seats host's", () => {
  const t = text(panel(NOW, { policy: "per-account", at: 1, by: "alex" }));
  expect(t).toContain("own policy applies");
  expect(t).toContain("Set by @alex.");
  expect(text(panel(NOW, null))).toContain("Off");
  expect(text(panel(NOW, null))).not.toContain("logins pooled");
  expect(DEFAULT_SEAT_CAP).toBe(DEFAULT_HOST_MAX);
});

test("the banner: shown on every page while the pool is on and not yet dismissed; nothing while it is off", () => {
  expect(renderToStaticMarkup(<PoolBanner pool={ON} />)).toContain("The company account pool is on");
  expect(renderToStaticMarkup(<PoolBanner pool={ON} />)).toContain("walkie accounts personal &lt;account&gt;");
  expect(renderToStaticMarkup(<PoolBanner pool={{ policy: "per-account", at: 1, by: "alex" }} />)).toBe("");
  expect(renderToStaticMarkup(<PoolBanner pool={null} />)).toBe("");
});

