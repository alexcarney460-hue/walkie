// RESET-CLOCK-1: the dashboard counts reset times down on its own (the shared 1 s clock), with the local time on hover.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountView } from "../src/api/types.ts";
import type { ResetClock } from "../../src/protocol/accounts.ts";
import { AccountChip, AccountTile } from "../src/components/Accounts.tsx";

const NOW = Date.UTC(2026, 8, 27, 20, 0);
const MIN = 60_000;
const H = 60 * MIN;
const text = (html: string) => html.replace(/<[^>]+>/g, "");
const c = (over: Partial<ResetClock> = {}): ResetClock =>
  ({ kind: "session", scope: null, window_s: 18_000, resets_at: NOW + 2 * H + 14 * MIN, observed_at: NOW - 3 * H, exhausted: false, source: "api", ...over });
const weekly = c({ kind: "weekly", window_s: 604_800, resets_at: NOW + 3 * 24 * H + 4 * H });
const acct = (over: Partial<AccountView> = {}): AccountView => ({
  id: "a1c0ffee0000000000000001", provider: "claude", label: "ae***@gm***.com", plan: "Max 20x", owners: ["alex"],
  machines: [{ node_id: "a1b2c3d4e5f60718", hostname: "alex-mac", handle: "alex", online: true, self: true, agents: [], usage: null }],
  usage: { at: NOW - 3 * H, state: "unknown", reason: "keychain_unavailable", source: "none", windows: [], until: null },
  key: "alex:a1c0ffee0000000000000001", claimed_by: [], usage_host: "alex-mac", last_seen: NOW, clock: [c(), weekly], ...over,
});
const tile = (a: AccountView, now = NOW) => renderToStaticMarkup(<AccountTile account={a} now={now} />);

test("no current reading: the remembered resets still count down, as <time> with the exact time on hover", () => {
  const out = tile(acct());
  expect(out).toContain("acct-state-unknown");
  expect(out).toContain(`<time dateTime="${new Date(NOW + 2 * H + 14 * MIN).toISOString()}" title="`);
  expect(text(out)).toContain("resets in 2h 14m");
  expect(text(out)).toContain("resets in 3d 4h");
  expect(text(out)).not.toContain("no reading");
});

test("live, with no refetch: the same data rendered a minute later reads a minute less", () => {
  const a = acct();
  expect(text(tile(a, NOW + MIN))).toContain("resets in 2h 13m");
  expect(text(tile(a, NOW + 2 * H))).toContain("resets in 14m");
});

test("a limit remembered from an older reading: Exhausted (last known), usable again at its reset", () => {
  const out = tile(acct({ clock: [c({ exhausted: true, resets_at: NOW + 40 * MIN }), weekly] }));
  expect(out).toContain("acct-state-exhausted");
  expect(text(out)).toContain("Limit reached (last known). Usable again in 40m.");
});

test("its reset passed with no reading since: 'Should be available again (not yet confirmed)', badge 'Likely available'", () => {
  // One reading 13 h ago: 5-hour used up (reset 12 h ago), weekly with room.
  const out = tile(acct({ clock: [c({ exhausted: true, resets_at: NOW - 12 * H, observed_at: NOW - 13 * H }), { ...weekly, observed_at: NOW - 13 * H }] }));
  expect(out).toContain("acct-state-likely");
  expect(out).toContain(">Likely available<");
  expect(text(out)).toContain("Should be available again (not yet confirmed). The limit reset at");
  expect(text(out)).toContain("no reading since.");
  expect(text(out)).toContain("reset passed at");
  expect(text(out)).not.toMatch(/100% left|0% used/);
});

test("a reset time the provider never named reads 'reset time not reported', never a made-up time", () => {
  const out = tile(acct({ clock: [c({ resets_at: null }), weekly] }));
  expect(text(out)).toContain("reset time not reported");
});

test("the chip's hover line carries the countdown too", () => {
  const out = renderToStaticMarkup(<AccountChip account={acct()} now={NOW} labelled />);
  expect(out).toContain("5-hour resets in 2h 14m");
});

test("an aged-out reading says how old it is instead of an unrelated reason", () => {
  const out = tile(acct({ usage: { at: NOW - 13 * H, state: "exhausted", reason: "limit_reached", source: "api", until: NOW - 12 * H, windows: [] } }));
  expect(text(out)).toContain("No current reading: the last one is 13h old, from alex-mac.");
});

test("pre.7 RC: a placeholder reset (an older Grok reading: its time + 60 min) is never shown as 'Usable again in …'", () => {
  const legacy = { at: NOW - 5 * MIN, state: "exhausted" as const, reason: "limit_reached" as const, source: "log" as const, windows: [], until: NOW + 55 * MIN };
  const a = acct({ provider: "grok", plan: null, usage: legacy, clock: [], machines: [{ node_id: "a1b2c3d4e5f60718", hostname: "alex-mac", handle: "alex", online: true, self: true, agents: [], usage: legacy }] });
  const t = text(tile(a));
  expect(t).toContain("Limit reached.");
  expect(t).toContain("Reset time not reported.");
  expect(t).not.toMatch(/Usable again|55m/);
  // The chip's hover line (usageLine) says the same.
  const chip = renderToStaticMarkup(<AccountChip account={a} now={NOW} />);
  expect(chip).not.toMatch(/resets in|55m/);
});

test("pre.7 RC delta: an exhausted reading with no reported reset is not 'Exhausted' 72 h later (the 1-hour hold)", () => {
  const u = { at: NOW - 72 * H, state: "exhausted" as const, reason: "limit_reached" as const, source: "session" as const, windows: [], until: null };
  const a = acct({ usage: u, clock: [], machines: [{ node_id: "a1b2c3d4e5f60718", hostname: "alex-mac", handle: "alex", online: true, self: true, agents: [], usage: u }] });
  const out = tile(a);
  expect(out).not.toContain("acct-state-exhausted");
  expect(text(out)).not.toContain("Limit reached.");
  const fresh = { ...u, at: NOW - 10 * 60_000 };
  expect(tile(acct({ usage: fresh, clock: [] }))).toContain("acct-state-exhausted");
});

