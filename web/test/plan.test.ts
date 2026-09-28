import { describe, expect, test } from "bun:test";
import { planLimitDetails } from "../src/api/client.ts";
import type { PlanView } from "../src/api/types.ts";
import { activationMessage, limitMessage, overLimit, planBadgeText, planTone, safeExternalUrl, trialLeft } from "../src/lib/plan.ts";
import { mockActivate, planView, seedPlan } from "../mock/plan.ts";

const NOW = Date.UTC(2026, 8, 25, 12);
const view = (mode: Parameters<typeof seedPlan>[0], people = 4, machines = 5): PlanView =>
  planView(seedPlan(mode, NOW), { people, machines }, NOW);

describe("planBadgeText", () => {
  test("Free shows people used over the limit", () => {
    expect(planBadgeText(view("free", 2, 3))).toBe("Free · 2/2 people");
    expect(planBadgeText(view("free", 4, 5))).toBe("Free · 4/2 people");
  });
  test("trial shows the days left", () => {
    expect(planBadgeText(view("trial"))).toBe("Team trial · 9 days left");
    const p = view("trial");
    expect(planBadgeText({ ...p, trial: { ends_at: p.trial!.ends_at, days_left: 1 } })).toBe("Team trial · 1 day left");
    expect(trialLeft(0)).toBe("ends today");
  });
  test("paid plans show seats; unlimited shows the count", () => {
    expect(planBadgeText(view("team", 7))).toBe("Team · 7/10 seats");
    expect(planBadgeText(view("business", 7))).toBe("Business · 7/25 seats");
    const p = view("team", 7);
    expect(planBadgeText({ ...p, seats: { used: 7, limit: null } })).toBe("Team · 7 seats");
  });
  test("grace reads as renewal overdue, amber", () => {
    const p = view("grace");
    expect(p.status).toBe("grace");
    expect(planBadgeText(p)).toBe("Team · renewal overdue");
    expect(planTone(p)).toBe("amber");
  });
  test("tone: active = signal, over a limit = amber, trial = neutral", () => {
    expect(planTone(view("team"))).toBe("signal");
    expect(planTone(view("free", 4, 5))).toBe("amber");
    expect(overLimit(view("free", 2, 4))).toBe(false);
    expect(planTone(view("trial"))).toBe("neutral");
  });
});

describe("plan_limit errors", () => {
  test("details are parsed only when well formed", () => {
    const d = planLimitDetails({ code: "plan_limit", resource: "people", limit: 2, used: 2, plan: "free", upgrade_url: "https://getwalkie.vercel.app/api/checkout?plan=team&interval=month&seats=3" });
    expect(d?.resource).toBe("people");
    expect(limitMessage(d!)).toBe("Your Free plan includes 2 people (2 used). Upgrade to add more.");
    expect(planLimitDetails({ resource: "bogus", limit: 2, used: 2, upgrade_url: "x" })).toBeUndefined();
    expect(planLimitDetails({ resource: "people", limit: "2", used: 2, upgrade_url: "x" })).toBeUndefined();
  });
  test("restricted channel message", () => {
    expect(limitMessage({ resource: "restricted_channels", limit: 0, used: 0, plan: "free", upgrade_url: "https://x" }))
      .toContain("Restricted channels are part of the Team plan");
  });
  test("only http(s) upgrade links render", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("data:text/html,x")).toBeNull();
    expect(safeExternalUrl("https://getwalkie.vercel.app/api/portal")).toBe("https://getwalkie.vercel.app/api/portal");
    expect(safeExternalUrl("not a url")).toBeNull();
  });
});

describe("activation result (audit L10)", () => {
  test("a queued activation (202 while the authority is offline) is a message, not an error", () => {
    expect(activationMessage({ queued: true, request_id: "r1" })).toBe("Activation queued, the roster authority will apply it when it's online.");
  });
  test("an applied activation names the plan and seats; a missing renewal token warns", () => {
    const p = view("team");
    expect(activationMessage({ event: null, plan: p })).toBe("License activated: Team · 10 seats.");
    expect(activationMessage({ event: null, plan: p, renewal: "missing" })).toContain("won't renew by itself");
    expect(activationMessage({ event: null })).toBe("License activated.");
  });
});

describe("mock license activation", () => {
  test("mock keys activate, others don't", () => {
    expect(mockActivate("mock-team-12", NOW)?.seats).toBe(12);
    expect(mockActivate("mock-business-0", NOW)).toBeNull();
    expect(mockActivate("eyJ.bad", NOW)).toBeNull();
  });
});
