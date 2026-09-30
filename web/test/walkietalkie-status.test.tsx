// ORCH-STATUS-1: the WalkieTalkie page and Mission Control both show this host's real state — running/stopped, the
// lead machine, model, uptime and access — with the Start/Stop/Resume control that matches it.
import { afterAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installWindow } from "./window-stub.ts";

// route.ts (hrefFor, imported by TalkieState.tsx) reads window.location at import time.
const hadWindow = "window" in globalThis;
installWindow();
afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
});

const { accessLabel, talkieSummaryText, WalkieTalkieStatus } = await import("../src/views/orchestrator/TalkieState.tsx");
type TalkieView = import("../src/views/orchestrator/TalkieState.tsx").TalkieView;

const NOW = Date.now();
const HOUR = 3_600_000;

const v = (extra: Partial<TalkieView>): TalkieView => ({ running: false, state: "stopped", restarts: 0, ...extra });

describe("accessLabel", () => {
  test("full access and Walkie tools (default, and an older daemon that sends nothing)", () => {
    expect(accessLabel("full")).toBe("Full access");
    expect(accessLabel("platform")).toBe("Walkie tools");
    expect(accessLabel(undefined)).toBe("Walkie tools");
  });
});

describe("talkieSummaryText", () => {
  test("running: model, access and uptime", () => {
    const text = talkieSummaryText(v({ running: true, state: "idle", model: "sonnet", access: "full", started_at: NOW - (2 * HOUR + 5 * 60_000) }), NOW);
    expect(text).toBe("Claude · Sonnet · Full access · up 2h 5m");
  });

  test("running with no model reported yet falls back to the setting, and Walkie tools by default", () => {
    expect(talkieSummaryText(v({ running: true, state: "starting", model_setting: "opus" }), NOW)).toBe("Claude · Opus · Walkie tools");
  });

  test("standby names the lead; with none yet, says no machine can lead", () => {
    expect(talkieSummaryText(v({ state: "standby", lead: "alex-mbp" }), NOW)).toBe("Standby · leads on alex-mbp");
    expect(talkieSummaryText(v({ state: "standby" }), NOW)).toBe("Standby · no machine can lead yet");
  });

  test("needs a model login", () => {
    expect(talkieSummaryText(v({ state: "needs_login" }), NOW)).toBe("Needs a model login");
  });

  test("stopped by you, vs. starting on its own, vs. an older daemon with no auto-start", () => {
    expect(talkieSummaryText(v({ stopped_by_hand: true }), NOW)).toBe("Stopped by you");
    expect(talkieSummaryText(v({ auto: true }), NOW)).toBe("Starting on its own");
    expect(talkieSummaryText(v({}), NOW)).toBe("Stopped");
  });

  test("not reporting at all (no daemon answer yet)", () => {
    expect(talkieSummaryText(null, NOW)).toBe("Not reporting");
  });
});

describe("WalkieTalkieStatus (Mission Control's card, and the same view the WalkieTalkie page reads)", () => {
  test("running: the dot is on, the summary line, and Stop (not Start or Resume)", () => {
    const out = renderToStaticMarkup(<WalkieTalkieStatus view={v({ running: true, state: "working", model: "opus", access: "platform", started_at: NOW - 45_000 })} now={NOW} />);
    expect(out).toMatch(/class="wt-dot is-on"[^>]*data-testid="walkietalkie-dot"/);
    expect(out).toMatch(/data-testid="walkietalkie-summary"[^>]*>Claude · Opus · Walkie tools · up 45s</);
    expect(out).toContain("Stop WalkieTalkie");
    expect(out).not.toContain("Start WalkieTalkie");
    expect(out).not.toContain(">Resume</button>");
  });

  test("standby: the dot is off, the lead is named, and no button (nothing to press here)", () => {
    const out = renderToStaticMarkup(<WalkieTalkieStatus view={v({ state: "standby", lead: "atlas" })} now={NOW} />);
    expect(out).toMatch(/class="wt-dot"[^>]*data-testid="walkietalkie-dot"/);
    expect(out).not.toContain("is-on");
    expect(out).toContain("Standby · leads on atlas");
    expect(out).not.toContain("<button");
  });

  test("needs a model login: the reason, no button", () => {
    const out = renderToStaticMarkup(<WalkieTalkieStatus view={v({ state: "needs_login" })} now={NOW} />);
    expect(out).toContain("Needs a model login");
    expect(out).not.toContain("<button");
  });

  test("stopped by you: Resume is the one control", () => {
    const out = renderToStaticMarkup(<WalkieTalkieStatus view={v({ stopped_by_hand: true })} now={NOW} />);
    expect(out).toContain("Stopped by you");
    expect(out).toContain(">Resume</button>");
    expect(out).not.toContain("Start WalkieTalkie");
  });

  test("starting on its own: no button (it starts by itself)", () => {
    const out = renderToStaticMarkup(<WalkieTalkieStatus view={v({ auto: true })} now={NOW} />);
    expect(out).toContain("Starting on its own");
    expect(out).not.toContain("<button");
  });

  test("stopped, no auto-start (an older daemon): the manual Start", () => {
    const out = renderToStaticMarkup(<WalkieTalkieStatus view={v({})} now={NOW} />);
    expect(out).toContain("Stopped");
    expect(out).toContain("Start WalkieTalkie");
  });

  test("not reporting yet (no view): still renders, with a Start button and no crash on null fields", () => {
    const out = renderToStaticMarkup(<WalkieTalkieStatus view={null} now={NOW} />);
    expect(out).toContain("Not reporting");
    expect(out).toContain("Start WalkieTalkie");
  });

  test("links to the WalkieTalkie page", () => {
    const out = renderToStaticMarkup(<WalkieTalkieStatus view={v({})} now={NOW} />);
    expect(out).toContain('href="#/orchestrator"');
  });
});

describe("Mission Control renders the WalkieTalkie card", () => {
  test("MissionControl.tsx wires WalkieTalkieCard into its extras panel", async () => {
    const src = await Bun.file(new URL("../src/views/mission/MissionControl.tsx", import.meta.url)).text();
    expect(src).toContain('import { WalkieTalkieCard } from "../orchestrator/TalkieState.tsx";');
    expect(src).toContain("<WalkieTalkieCard />");
  });
});

describe("the WalkieTalkie page's header shows access and uptime too", () => {
  test("Orchestrator.tsx composes access and uptime into the running 'where' line, and names why it's stopped otherwise", async () => {
    const src = await Bun.file(new URL("../src/views/orchestrator/Orchestrator.tsx", import.meta.url)).text();
    expect(src).toContain("accessLabel(talkie?.access)");
    expect(src).toContain("up ${duration(now - talkie.started_at)}");
    expect(src).toContain('"stopped (by you)"');
    expect(src).toContain('"starting on its own"');
    expect(src).toContain('"not running on this machine"');
  });
});
