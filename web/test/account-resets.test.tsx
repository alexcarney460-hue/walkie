// ACCOUNTS-RESET-1 on the dashboard: the three display states, which button each provider gets, the confirmation
// sheet's wording, and the attempt guard (a double-click sends one request; a retry reuses the attempt's id).
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountView, ResetResult } from "../src/api/types.ts";
import { ResetSheet, ResetsRow } from "../src/components/AccountResets.tsx";
import { AccountTile } from "../src/components/Accounts.tsx";
import { ResetSheetFlow } from "../src/lib/resets.ts";
import { installWindow } from "./window-stub.ts";

installWindow();
const NOW = Date.UTC(2026, 8, 26, 18, 0);
const H = 3_600_000;
const usage = (resets?: { available: number; applicable: number | null }): AccountView["usage"] => ({
  at: NOW - 60_000, state: "ok", reason: null, source: "api", until: null,
  windows: [{ kind: "session", used_pct: 40, resets_at: NOW + 2 * H + 5 * 60_000, window_s: 18_000, scope: null }],
  ...(resets ? { resets } : {}),
});
const acct = (over: Partial<AccountView> = {}, self = true): AccountView => ({
  id: "a1c0ffee0000000000000002", provider: "codex", label: "ma***@ke***.example", plan: "Pro", owners: ["maren"],
  machines: [{ node_id: "a1b2c3d4e5f60718", hostname: "maren-mbp", handle: "maren", online: true, self, agents: ["review"], usage: null }],
  usage: usage({ available: 2, applicable: 1 }), key: "maren:a1c0ffee0000000000000002", claimed_by: [], usage_host: "maren-mbp", last_seen: NOW, ...over,
});
const row = (a: AccountView, initialSheet = false) => renderToStaticMarkup(<ResetsRow account={a} now={NOW} initialSheet={initialSheet} useReset={async () => { throw new Error("not called"); }} />);

test("Codex on this machine: the count, the window reset, and an enabled Use a reset button", () => {
  const out = row(acct());
  expect(out).toContain("Resets available: 2");
  expect(out).toContain("5-hour window resets in 2h 05m");
  expect(out).toMatch(/<button type="button" class="btn btn-sm">Use a reset<\/button>/);
  expect(out).not.toContain("role=\"dialog\"");
});

test("no resets: the state is shown and the button is disabled", () => {
  const out = row(acct({ usage: usage({ available: 0, applicable: 0 }) }));
  expect(out).toContain("No resets available");
  expect(out).toMatch(/<button type="button" class="btn btn-sm" disabled="">Use a reset<\/button>/);
});

test("not reported (Claude): no count, the page button, and the honest note", () => {
  const out = row(acct({ provider: "claude", usage: usage() }));
  expect(out).toContain("Not reported by Claude");
  expect(out).toContain('href="https://claude.ai/settings/usage"');
  expect(out).toContain('target="_blank"');
  expect(out).toContain('rel="noopener noreferrer"');
  expect(out).toContain("Open Claude usage page");
  expect(out).toContain("used on its own page");
  expect(out).not.toContain("Use a reset");
});

test("Kimi: no resets, a link to its page; Grok: the state only", () => {
  const kimi = row(acct({ provider: "kimi", usage: usage() }));
  expect(kimi).toContain("Not reported by Kimi");
  expect(kimi).toContain("Kimi has no limit resets.");
  expect(kimi).toContain("Open Kimi page");
  const grok = row(acct({ provider: "grok", usage: null }));
  expect(grok).toContain("Not reported by Grok");
  expect(grok).not.toContain("<a ");
  expect(grok).not.toContain("<button");
});

test("an account held on another machine: 'Use on <machine>', no button (v1 is local-only)", () => {
  const out = row(acct({}, false));
  expect(out).toContain("Use on maren-mbp:");
  expect(out).not.toContain("Use a reset</button>");
  // Nothing to use and not here: no hint at all.
  expect(row(acct({ usage: usage() }, false))).not.toContain("dashboard on the machine");
});

test("the confirmation sheet: 1 of N on the account, can't be undone, 'keep it' is the safe default; no id until the daemon mints one", () => {
  const out = row(acct(), true);
  expect(out).toContain('role="dialog"');
  expect(out).toContain('aria-modal="true"');
  expect(out).toContain("Use a reset?");
  expect(out).toMatch(/This uses 1 of 2 resets on <strong class="mono">Codex ma\*\*\*@ke\*\*\*\.example<\/strong>; it can(&#x27;|')t be undone\./);
  expect(out).toContain("No, keep it");
  expect(out).toContain("Preparing…");
  expect(out).toMatch(/<button type="button" class="btn btn-primary" disabled="">Yes, use a reset<\/button>/);
  expect(out).not.toContain("data-request-id");
});

const sheet = (a: AccountView, attempt: Parameters<typeof ResetSheet>[0]["initialAttempt"]) => renderToStaticMarkup(
  <ResetSheet account={a} resets={{ kind: "available", n: 2, applicable: 1 }} useReset={async () => { throw new Error("not called"); }}
    prepareReset={async () => { throw new Error("not called"); }} onClose={() => undefined} initialAttempt={attempt} />,
);
const ID = "5d0c7a2e-1f6b-4b8e-9a51-0c2f3b4d5e6f";

test("a prepared attempt: the daemon's id on the button", () => {
  const out = sheet(acct(), { id: ID, account: "a1c0ffee0000000000000002", earlier: null });
  expect(out).toContain(`data-request-id="${ID}"`);
  expect(out).toMatch(/<button type="button" class="btn btn-primary" data-request-id="[^"]+">Yes, use a reset<\/button>/);
});

test("an earlier unconfirmed try: warned, and blocked until usage is re-read; then the SAME attempt may be retried", () => {
  const waiting = sheet(acct(), { id: ID, account: "a1c0ffee0000000000000002", earlier: { tried_at: NOW - 60_000, reread: false } });
  expect(waiting).toContain("An earlier attempt may have gone through. Check usage before trying again.");
  expect(waiting).toContain("re-reading it now");
  expect(waiting).toMatch(/<button type="button" class="btn btn-primary" disabled="" data-request-id="[^"]+">Try the same attempt again<\/button>/);
  expect(waiting).toContain(">I checked usage</button>"); // a person may always say they checked (a clock pushed back included)
  const reread = sheet(acct(), { id: ID, account: "a1c0ffee0000000000000002", earlier: { tried_at: NOW - 60_000, reread: true } });
  expect(reread).toContain("Usage was re-read: Resets available: 2");
  expect(reread).toContain("can&#x27;t use a second reset");
  expect(reread).toMatch(/<button type="button" class="btn btn-primary" data-request-id="5d0c7a2e[^"]*">Try the same attempt again<\/button>/);
});

test("another window finished the attempt: the sheet says so and never becomes a new attempt (RESET-3)", () => {
  const out = renderToStaticMarkup(
    <ResetSheet account={acct()} resets={{ kind: "available", n: 2, applicable: 1 }} useReset={async () => { throw new Error("not called"); }}
      prepareReset={async () => { throw new Error("not called"); }} onClose={() => undefined}
      initialAttempt={{ id: ID, account: "a1c0ffee0000000000000002", earlier: null }} initialSuperseded />,
  );
  expect(out).toContain("This attempt is no longer current (another window used it, or it expired). Close this and reopen it.");
  expect(out).toMatch(/<button type="button" class="btn btn-primary" disabled="" data-request-id="[^"]+">Yes, use a reset<\/button>/);
});

test("an attempt interrupted before anything was sent says so", () => {
  expect(sheet(acct(), { id: ID, account: "a1c0ffee0000000000000002", earlier: null, interrupted: true }))
    .toContain("The last try stopped before anything was sent to Codex. Nothing was used.");
});

test("the same login on another machine is called out (Walkie can't coordinate the two)", () => {
  const two = acct({ machines: [
    { node_id: "a1b2c3d4e5f60718", hostname: "maren-mbp", handle: "maren", online: true, self: true, agents: [], usage: null },
    { node_id: "b1b2c3d4e5f60718", hostname: "atlas", handle: "maren", online: true, self: false, agents: [], usage: null },
  ] });
  expect(sheet(two, { id: ID, account: "a1c0ffee0000000000000002", earlier: null })).toContain("This login is also on atlas.");
});

test("the tile carries the resets row", () => {
  expect(renderToStaticMarkup(<AccountTile account={acct()} now={NOW} />)).toContain("Resets available: 2");
});

const A = "5d0c7a2e-1f6b-4b8e-9a51-0c2f3b4d5e6f";
const B = "6e1d8b3f-2a7c-4c9f-8b62-1d3e4f5a6b7c";
const view = (id: string) => ({ id, account: "a1c0ffee0000000000000002", earlier: null });

test("flow: a double-click is ONE request, with the pinned id", async () => {
  const uses: string[] = [];
  let release!: (r: { result: ResetResult }) => void;
  const flow = new ResetSheetFlow("a1c0ffee0000000000000002", {
    prepare: async () => ({ attempt: view(A) }),
    use: (_a, id) => { uses.push(id); return new Promise((r) => { release = r; }); },
  });
  flow.onPrepared(view(A));
  const p1 = flow.confirm();
  const p2 = flow.confirm();
  await Bun.sleep(5);
  release({ result: { outcome: "reset", left: 1 } });
  expect(await p1).toEqual({ outcome: "reset", left: 1 });
  expect(await p2).toEqual({ outcome: "reset", left: 1 });
  expect(uses).toEqual([A]);
});

test("flow: Codex r2 HIGH 1 path: the answer is lost, a fresh reading brings attempt B, 'try again' still asks for A", async () => {
  const uses: string[] = [];
  let prepares = 0;
  let lose = true;
  const flow = new ResetSheetFlow("a1c0ffee0000000000000002", {
    prepare: async () => { prepares++; return { attempt: view(prepares === 1 ? A : B) }; },
    use: async (_a, id) => { uses.push(id); if (lose) { lose = false; throw new Error("network"); } return { result: { outcome: "reset", left: 1 } }; },
  });
  flow.onPrepared(view(A));
  await expect(flow.confirm()).rejects.toThrow("network"); // sent; the daemon finished A; the page never heard
  expect(flow.onPrepared(view(B))).toBe("ignore"); // the usage update's prepare: never replaces A
  expect(await flow.confirm()).toEqual({ outcome: "reset", left: 1 }); // the daemon replays A's answer
  expect(uses).toEqual([A, A]);
  expect(prepares).toBe(1); // only the pre-send check; retries go by id
});

test("flow: another window finished the attempt before this sheet sent anything: superseded, nothing sent", async () => {
  const uses: string[] = [];
  const flow = new ResetSheetFlow("a1c0ffee0000000000000002", { prepare: async () => ({ attempt: view(B) }), use: async (_a, id) => { uses.push(id); return { result: { outcome: "reset", left: 0 } }; } });
  flow.onPrepared(view(A));
  expect(await flow.confirm()).toBe("superseded");
  expect(uses).toEqual([]);
  expect(flow.onPrepared(view(B))).toBe("superseded");
});

test("an earlier try re-read: the person may retry the same attempt or say they checked usage", () => {
  const out = sheet(acct(), { id: ID, account: "a1c0ffee0000000000000002", earlier: { tried_at: NOW - 60_000, reread: true } });
  expect(out).toContain(">I checked usage</button>");
  expect(out).toContain("Try the same attempt again");
});
