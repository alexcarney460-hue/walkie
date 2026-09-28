import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountView, AccountWindow } from "../src/api/types.ts";
import { AccountChip, AccountMini, AccountsStrip, AccountTile, accountForAgent } from "../src/components/Accounts.tsx";

const NOW = Date.UTC(2026, 8, 26, 18, 0);
const H = 3_600_000;
const w = (kind: AccountWindow["kind"], used: number, resetsIn: number | null, scope: string | null = null): AccountWindow =>
  ({ kind, used_pct: used, resets_at: resetsIn === null ? null : NOW + resetsIn, window_s: null, scope });
const USAGE: AccountView["usage"] = { at: NOW - 60_000, state: "ok", reason: null, source: "api", until: null, windows: [w("session", 62, 2 * H + 45 * 60_000), w("weekly", 75, 3 * 24 * H), w("weekly_model", 95, 3 * 24 * H, "Opus")] };
const acct = (over: Partial<AccountView> = {}): AccountView => ({
  id: "a1c0ffee0000000000000001", provider: "claude", label: "ma***@ke***.example", plan: "Max 20x", owners: ["maren"],
  machines: [{ node_id: "a1b2c3d4e5f60718", hostname: "maren-mbp", handle: "maren", online: true, self: true, agents: ["ux-seat"], usage: USAGE }],
  usage: USAGE, key: "maren:a1c0ffee0000000000000001", claimed_by: [],
  usage_host: "maren-mbp", last_seen: NOW, ...over,
});
const tile = (a: AccountView) => renderToStaticMarkup(<AccountTile account={a} now={NOW} />);

test("a green meter shows what is LEFT, with aria meter values and a reset countdown", () => {
  const out = tile(acct());
  expect(out).toContain('role="meter"');
  expect(out).toContain('aria-valuenow="38"');
  expect(out).toContain("width:38%");
  expect(out).toContain("38% left");
  expect(out).toContain("resets in 2h 45m");
  expect(out).toContain('aria-valuetext="38% left, resets in 2h 45m"');
  // Bands: 38 % left green, weekly 25 % left amber, Opus 5 % left red (thin bar).
  expect(out).toMatch(/acct-meter lv-green"/);
  expect(out).toMatch(/acct-meter lv-amber"/);
  expect(out).toMatch(/acct-meter lv-red is-thin"/);
  expect(out).toContain("Weekly · Opus");
  expect(out).toContain("Max 20x");
  expect(out).toContain("Updated 1m ago from maren-mbp");
});

test("neutral monogram with owner initials, never a logo", () => {
  const out = tile(acct());
  expect(out).toContain('<span class="acct-mono">Cl</span>');
  expect(out).toContain('<span class="acct-owner">MA</span>');
  expect(out).not.toMatch(/<img|<svg[^>]*anthropic|openai/i);
  expect(tile(acct({ provider: "codex" }))).toContain(">Cx<");
  expect(tile(acct({ provider: "grok" }))).toContain(">Gk<");
});

test("stale after 15 min: colour kept but dimmed, labelled", () => {
  const out = tile(acct({ usage: { ...acct().usage!, at: NOW - 20 * 60_000 } }));
  expect(out).toContain("acct-state-stale");
  expect(out).toContain("is-stale");
  expect(out).toContain("Stale: last reading 20m ago");
});

test("exhausted: red, 0 % left, and when it is usable again", () => {
  const out = tile(acct({ usage: { at: NOW - 60_000, state: "exhausted", reason: "limit_reached", source: "api", until: NOW + H + 12 * 60_000, windows: [w("session", 100, H + 12 * 60_000), w("weekly", 64, 48 * H)] } }));
  expect(out).toContain("acct-state-exhausted");
  expect(out).toContain("Limit reached.");
  // RESET-CLOCK-1: the time is a <time> element with the exact local time on hover.
  expect(out.replace(/<[^>]+>/g, "")).toContain("Usable again in 1h 12m.");
  expect(out).toContain('aria-valuenow="0"');
  expect(out).toMatch(/acct-meter lv-red"/);
});

test("needs re-login: the exact step on the machine that holds the login, no meters", () => {
  const out = tile(acct({ provider: "codex", usage: { at: NOW, state: "relogin", reason: "login_expired", source: "none", until: null, windows: [] } }));
  expect(out).toContain("Needs re-login");
  expect(out).toContain("On maren-mbp: run `codex login`");
  expect(out).not.toContain('role="meter"');
});

test("unknown: neutral meters and the reason", () => {
  const out = tile(acct({ provider: "grok", usage: { at: NOW, state: "unknown", reason: "no_usage_api", source: "none", until: null, windows: [] } }));
  expect(out).toContain("acct-state-unknown");
  expect(out).toContain("Usage unknown: no usage API for this provider.");
  expect(out).toContain("acct-meter lv-none");
  expect(out).toContain('aria-valuetext="unknown"');
});

test("mini tile (Mission Control) has both mini meters; idle accounts are dimmed; the strip counts accounts in use", () => {
  const mini = renderToStaticMarkup(<AccountMini account={acct()} now={NOW} />);
  expect(mini.match(/role="meter"/g)).toHaveLength(2);
  // A provider that reports only the weekly window gets only that bar.
  const weeklyOnly = acct({ provider: "codex", usage: { ...acct().usage!, windows: [w("weekly", 13, 6 * 24 * H)] } });
  expect(renderToStaticMarkup(<AccountMini account={weeklyOnly} now={NOW} />).match(/role="meter"/g)).toHaveLength(1);
  expect(mini).toContain('href="#/accounts"');
  const idle = acct({ id: "a1c0ffee0000000000000002", machines: [{ ...acct().machines[0]!, agents: [] }] });
  expect(renderToStaticMarkup(<AccountMini account={idle} now={NOW} />)).toContain("is-idle");
  const strip = renderToStaticMarkup(<AccountsStrip accounts={[idle, acct()]} now={NOW} />);
  expect(strip).toContain("1 in use of 2");
  expect(strip.indexOf('class="acct-mini is-ok"')).toBeGreaterThan(-1);
  expect(strip.indexOf('class="acct-mini is-ok"')).toBeLessThan(strip.indexOf("is-idle")); // in use first
  expect(renderToStaticMarkup(<AccountsStrip accounts={[]} now={NOW} />)).toBe("");
});

test("agent card chip: the account an agent runs on and what is left of its tightest window", () => {
  const list = [acct()];
  expect(accountForAgent(list, { node: "a1b2c3d4e5f60718", agent: "ux-seat" })?.id).toBe("a1c0ffee0000000000000001");
  expect(accountForAgent(list, { node: "a1b2c3d4e5f60718", agent: "other" })).toBeUndefined();
  const chip = renderToStaticMarkup(<AccountChip account={acct()} now={NOW} />);
  expect(chip).toContain(">5%<"); // Opus weekly is the tightest
  expect(chip).toContain("lv-red");
  expect(renderToStaticMarkup(<AccountChip account={acct({ usage: { at: NOW, state: "relogin", reason: "login_expired", source: "none", until: null, windows: [] } })} now={NOW} />)).toContain("re-login");
});

test("an agent's chip uses its OWN machine's reading, not the freshest one of the account (ACCOUNTS-FIX-1, Codex 3)", () => {
  const mine = { at: NOW - 60_000, state: "ok" as const, reason: null, source: "api" as const, until: null, windows: [w("session", 10, H)] };
  const other = { at: NOW - 120_000, state: "ok" as const, reason: null, source: "api" as const, until: null, windows: [w("session", 90, H)] };
  const a = acct({
    usage: mine, usage_host: "maren-mbp",
    machines: [
      { node_id: "n1", hostname: "maren-mbp", handle: "maren", online: true, self: true, agents: ["ux-seat"], usage: mine },
      { node_id: "n2", hostname: "atlas", handle: "maren", online: true, self: false, agents: ["api-seat"], usage: other },
    ],
  });
  expect(accountForAgent([a], { node: "n2", agent: "api-seat" })).toMatchObject({ usage: other, usage_host: "atlas" });
  expect(accountForAgent([a], { node: "n1", agent: "ux-seat" })).toMatchObject({ usage: mine, usage_host: "maren-mbp" });
  expect(renderToStaticMarkup(<AccountChip account={accountForAgent([a], { node: "n2", agent: "api-seat" })!} now={NOW} />)).toContain(">10%<");
});

test("a tile names the other members who report the same account: unverified, shown separately", () => {
  const out = tile(acct({ claimed_by: ["mallory"] }));
  expect(out).toContain("Also reported by mallory");
  expect(out).toContain("unverified");
  expect(tile(acct())).not.toContain("Also reported by");
});

test("ACCOUNTS-2: a vault account shows the Switchable badge, its policy and the sessions running on it", () => {
  const out = tile(acct({
    vault: { policy: "shared", share_with: ["kira"] },
    leases: [{ handle: "kira", hostname: "kira-mbp", node_id: "k1", agent: "cc-kira01", since: NOW - 5 * 60_000 }],
  }));
  expect(out).toContain("Switchable");
  expect(out).toContain("shared with kira");
  expect(out).toContain("kira/kira-mbp · cc-kira01");
  expect(tile(acct())).not.toContain("Switchable");
});

test("ACCOUNTS-2: an agent chip follows a wrapped session to its account through the lease", () => {
  const a = acct({ machines: [], leases: [{ handle: "kira", hostname: "kira-mbp", node_id: "k1", agent: "cc-kira01", since: NOW }] });
  expect(accountForAgent([a], { node: "k1", agent: "cc-kira01" })?.id).toBe(a.id);
  expect(accountForAgent([a], { node: "k1", agent: "other" })).toBeUndefined();
});
