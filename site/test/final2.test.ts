// FINAL-2 re-audits: Codex 4 (a lost reveal response can be retried within the window) and Fable 4 (the
// unmark race can't reveal a third time outside the same session's window).
import { describe, expect, test } from "bun:test";
import type { Deps } from "../api/_lib/issue.ts";
import { REVEAL_NONCE_META, REVEALED_META, SHOWN_META } from "../api/_lib/metadata.ts";
import { makeLicense, RETRY_WINDOW_MS, revealState } from "../api/license/index.ts";
import { body, fullEnv, MockStripe, NOW, stripeError, subscription, testKeypair } from "./helpers.ts";

const kp = testKeypair();
const ENV = fullEnv(kp.pem);
const SUB = "sub_ABC123";
const req = (): Request => new Request("https://site.test/api/license?session_id=cs_test_1");

function world(): { s: MockStripe; h: (r: Request) => Promise<Response>; setNow: (t: number) => void; meta: () => Record<string, string> } {
  const s = new MockStripe();
  s.subs.set(SUB, subscription());
  s.sessions.set("cs_test_1", { id: "cs_test_1", mode: "subscription", status: "complete", subscription: SUB, customer: "cus_XYZ" });
  let t = NOW;
  const deps: Deps = { env: ENV, stripe: () => s, now: () => t };
  return { s, h: makeLicense(deps), setNow: (v) => { t = v; }, meta: () => s.subs.get(SUB)?.metadata ?? {} };
}

describe("Codex 4: a lost response is retried within the window, even after the reveal completed", () => {
  test("shown recorded, response lost → the same session gets the code again within 10 min; 410 after", async () => {
    const w = world();
    const first = await w.h(req());
    expect(first.status).toBe(200);
    const code = (await body(first)).code as string;
    expect(w.meta()[SHOWN_META]).toBe(String(NOW));
    // The buyer's browser never got it: the retry (same session, same code) answers 200 without a new mark.
    w.setNow(NOW + 5 * 60_000);
    const writes = w.s.calls.metadata.length;
    const again = await w.h(req());
    expect(again.status).toBe(200);
    expect((await body(again)).code).toBe(code);
    expect(w.s.calls.metadata.length).toBe(writes); // idempotent: nothing rewritten
    expect(w.meta()[SHOWN_META]).toBe(String(NOW)); // the window counts from the first delivery
    w.setNow(NOW + RETRY_WINDOW_MS + 1);
    const late = await w.h(req());
    expect([late.status, (await body(late)).error]).toEqual([410, "already_revealed"]);
  });

  test("revealState checks shown first: a cleared mark with shown set is still shown (outside the window)", () => {
    const meta = { [SHOWN_META]: String(NOW) };
    expect(revealState(meta, NOW + RETRY_WINDOW_MS + 1)).toBe("shown");
    expect(revealState(meta, NOW + 1)).toBe("redeliver");
    expect(revealState({ [REVEALED_META]: String(NOW) }, NOW + 1)).toBe("retriable");
    expect(revealState({ [REVEALED_META]: String(NOW) }, NOW + RETRY_WINDOW_MS + 1)).toBe("shown");
    expect(revealState({}, NOW)).toBe("unrevealed");
  });
});

describe("Fable 4: the read-back race can't reveal a third time outside the window", () => {
  test("A marks, B (same session) marks + completes, A's read-back fails: A's unmark is a no-op; a call after the window is 410", async () => {
    const w = world();
    let releaseA: () => void = () => {};
    const aParked = new Promise<void>((r) => { releaseA = r; });
    let aStarted: () => void = () => {};
    const aStartedP = new Promise<void>((r) => { aStarted = r; });
    const origGet = w.s.getSubscription.bind(w.s);
    let gets = 0;
    w.s.getSubscription = async (id) => {
      gets++;
      if (gets === 2) { aStarted(); await aParked; throw stripeError(503); } // A's read-back: parked until B is done, then fails
      return origGet(id);
    };
    const A = w.h(req());
    await aStartedP;
    const B = await w.h(req()); // B runs while A is parked: the mark is stale (no shown_at) → B reveals and completes
    expect(B.status).toBe(200);
    expect(w.meta()[SHOWN_META]).toBe(String(NOW));
    releaseA();
    expect((await A).status).toBe(502);
    // A's unmark saw `shown` and left everything alone.
    expect(w.meta()[SHOWN_META]).toBe(String(NOW));
    expect(w.meta()[REVEALED_META]).toBe(String(NOW));
    expect(w.meta()[REVEAL_NONCE_META]).toBeDefined();
    // Outside the window: no third reveal.
    w.setNow(NOW + RETRY_WINDOW_MS + 1);
    expect((await w.h(req())).status).toBe(410);
  });

  test("unmark when the read of the current state fails: nothing is written (the retry window covers it)", async () => {
    const w = world();
    const origGet = w.s.getSubscription.bind(w.s);
    let gets = 0;
    w.s.getSubscription = async (id) => { gets++; if (gets >= 2) throw stripeError(503); return origGet(id); };
    expect((await w.h(req())).status).toBe(502);
    expect(w.s.calls.metadata.length).toBe(1); // the mark only; no clear without knowing the state
    expect(w.meta()[REVEALED_META]).toBe(String(NOW));
    expect(revealState(w.meta(), NOW + 1)).toBe("retriable");
  });
});
