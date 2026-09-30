// ORCH-2: the dashboard's Start dialog offers the access choice (platform, the default, or full) and the model; the
// chat header's model picker; Mission Control's orchestrator card names its model.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentView } from "../src/api/types.ts";
import { AgentCard } from "../src/views/mission/AgentCard.tsx";
import { AccessChoice, StartOrchestrator } from "../src/views/orchestrator/Lifecycle.tsx";
import { AccessSelect, ModelPicker } from "../src/views/orchestrator/ModelPicker.tsx";
import { modelLabel } from "../src/views/orchestrator/model.ts";
import { notRunningKind, standingDown, StoppedCard, TalkieStateCard } from "../src/views/orchestrator/TalkieState.tsx";

describe("the Start dialog's access choice", () => {
  test("Start renders both options with platform checked by default, before the Start button", () => {
    const out = renderToStaticMarkup(<StartOrchestrator />);
    const input = (v: string) => new RegExp(`<input[^>]*value="${v}"[^>]*/>`).exec(out)?.[0] ?? "";
    expect(out).toContain("<legend class=\"orch-access-legend\">Access</legend>");
    expect(input("platform")).toMatch(/type="radio"[^>]*name="orch-access"[^>]*checked=""/);
    expect(input("full")).toMatch(/type="radio"[^>]*name="orch-access"/);
    expect(input("full")).not.toContain("checked");
    expect(out).toContain("Walkie platform");
    expect(out).toContain("Full access");
    expect(out).toContain("bypass permissions");
    expect(out.indexOf("orch-access")).toBeLessThan(out.indexOf("Start WalkieTalkie"));
  });

  test("the compact form (the offline bar) keeps both choices without the hints", () => {
    const out = renderToStaticMarkup(<StartOrchestrator size="sm" />);
    expect(out).toContain("orch-access is-compact");
    expect(out).toContain("Full access");
    expect(out).not.toContain("orch-access-hint");
  });

  test("the chosen value is the checked one", () => {
    const out = renderToStaticMarkup(<AccessChoice value="full" onChange={() => undefined} />);
    const input = (v: string) => new RegExp(`<input[^>]*value="${v}"[^>]*/>`).exec(out)?.[0] ?? "";
    expect(input("full")).toContain("checked=\"\"");
    expect(input("platform")).not.toContain("checked");
  });
});

describe("ORCH-2 model picker", () => {
  const optionValues = (out: string) => [...out.matchAll(/<option[^>]*value="([^"]+)"/g)].map((m) => m[1]);

  test("the picker offers Default, the four aliases and a full model id; the setting is selected", () => {
    const out = renderToStaticMarkup(<ModelPicker value="sonnet" onPick={() => undefined} />);
    expect(optionValues(out)).toEqual(["default", "opus", "sonnet", "haiku", "fable", "__custom"]);
    expect(out).toContain("Full model id…");
    expect(out).toMatch(/<select[^>]*id="orch-model"/);
    expect(out).toMatch(/<label[^>]*for="orch-model"[^>]*>Model<\/label>/);
  });

  test("a full id setting is listed as itself", () => {
    const out = renderToStaticMarkup(<ModelPicker value="claude-sonnet-4-6" onPick={() => undefined} />);
    expect(optionValues(out)).toContain("claude-sonnet-4-6");
  });

  test("the Start dialog has the model picker next to the access choice, Default first", () => {
    const out = renderToStaticMarkup(<StartOrchestrator />);
    expect(out).toContain('id="orch-start-model"');
    expect(out.indexOf("orch-model")).toBeLessThan(out.indexOf("Start WalkieTalkie"));
    expect(renderToStaticMarkup(<StartOrchestrator size="sm" />)).toContain('id="orch-start-model-sm"');
  });

  test("labels: aliases capitalised, a full id by family, default is plain Claude", () => {
    expect(modelLabel("sonnet")).toBe("Claude · Sonnet");
    expect(modelLabel("default")).toBe("Claude");
    expect(modelLabel("claude-opus-5-5[1m]")).toContain("Opus");
  });

  test("Mission Control's orchestrator card shows its model; other agents' cards don't get the chip", () => {
    const base = { handle: "alex", node: "n1", hostname: "alex-mbp", updated_at: 1, machine_online: true, effective_state: "idle" as const, archived: false };
    const orch = { ...base, id: "alex/alex-mbp/orchestrator", agent: "orchestrator", status: { agent: "orchestrator", state: "idle", runtime: "claude-code", model: "opus" } } as unknown as AgentView;
    const other = { ...base, id: "alex/alex-mbp/cc-1", agent: "cc-1", status: { agent: "cc-1", state: "idle", runtime: "claude-code", model: "opus" } } as unknown as AgentView;
    const html = (a: AgentView) => renderToStaticMarkup(<AgentCard agent={a} onOpen={() => undefined} />);
    expect(html(orch)).toMatch(/data-testid="orchestrator-model"[^>]*>Claude · Opus</);
    expect(html(other)).not.toContain("orchestrator-model");
  });
});

describe("ORCH-2 WalkieTalkie in the dashboard", () => {
  test("standby names the lead and the takeover rule; no Start button", () => {
    const out = renderToStaticMarkup(<TalkieStateCard view={{ running: false, state: "standby", restarts: 0, lead: "alex-mbp", auto: true }} />);
    expect(out).toContain("WalkieTalkie is on standby here");
    expect(out).toContain("alex-mbp");
    expect(out).toContain("offline for 5 minutes");
    expect(out).not.toContain("Start WalkieTalkie");
    expect(standingDown({ running: false, state: "standby", restarts: 0 })).toBe(true);
  });

  test("needs a model login: the reason and the one command", () => {
    const out = renderToStaticMarkup(<TalkieStateCard view={{ running: false, state: "needs_login", restarts: 0, needs: "WalkieTalkie needs a Claude login for now (found codex; Codex/Kimi support is coming). Sign in with: claude", logins: ["codex"] }} />);
    expect(out).toContain("WalkieTalkie needs a model login");
    expect(out).toContain("Codex/Kimi support is coming");
    expect(out).toContain("Found here: codex.");
    expect(out).toMatch(/claude/);
    expect(standingDown({ running: true, state: "idle", restarts: 0 })).toBe(false);
  });

  test("the nav, the command palette and the Start button say WalkieTalkie", async () => {
    const shell = await Bun.file(new URL("../src/components/Shell.tsx", import.meta.url)).text();
    expect(shell).toContain('label: "WalkieTalkie"');
    expect(renderToStaticMarkup(<StartOrchestrator />)).toContain("Start WalkieTalkie");
    const card = renderToStaticMarkup(<AgentCard agent={{ id: "a/h/orchestrator", agent: "orchestrator", handle: "a", node: "n", hostname: "h", updated_at: 1, machine_online: true, effective_state: "idle", archived: false, status: { agent: "orchestrator", state: "idle", runtime: "claude-code" } } as unknown as AgentView} onOpen={() => undefined} />);
    expect(card).toContain(">WalkieTalkie</span>");
  });
});

describe("Codex RC MEDIUM 4: the header's access switch", () => {
  test("Walkie tools / Full access, the current one selected", () => {
    const out = renderToStaticMarkup(<AccessSelect value="full" onPick={() => undefined} />);
    expect(out).toMatch(/<label[^>]*for="orch-head-access"[^>]*>Access<\/label>/);
    expect([...out.matchAll(/<option[^>]*value="([^"]+)"/g)].map((m) => m[1])).toEqual(["platform", "full"]);
    expect(out).toMatch(/<select[^>]*id="orch-head-access"/);
  });
  test("the dashboard's client calls the access route", async () => {
    const client = await Bun.file(new URL("../src/api/client.ts", import.meta.url)).text();
    expect(client).toContain('request<OrchestratorView>("POST", "/v1/orchestrator/access", { access }');
  });
});

describe("pre.8: no Start press on the lead", () => {
  const v = (extra: Record<string, unknown>) => ({ running: false, state: "stopped" as const, restarts: 0, ...extra });
  test("stopped by you: the one button is Resume (automatic)", () => {
    expect(notRunningKind(v({ stopped_by_hand: true }))).toBe("stopped_by_you");
    const out = renderToStaticMarkup(<StoppedCard kind="stopped_by_you" />);
    expect(out).toContain("WalkieTalkie is stopped (by you)");
    expect(out).toContain(">Resume</button>");
    expect(out).not.toContain("Start WalkieTalkie");
    expect(out.match(/<button/g)?.length).toBe(1);
  });
  test("not stopped by you, auto on: starting on its own, no button", () => {
    expect(notRunningKind(v({ auto: true }))).toBe("starting");
    const out = renderToStaticMarkup(<StoppedCard kind="starting" />);
    expect(out).toContain("WalkieTalkie is starting");
    expect(out).toContain("nothing to press");
    expect(out).not.toContain("<button");
  });
  test("a capped crash loop shows its diagnostic and a deliberate restart", () => {
    const view = { running: false, state: "failed" as const, auto: true, restarts: 4,
      last_error: "WalkieTalkie keeps failing: claude exited (code 1): unknown option" };
    expect(notRunningKind(view)).toBe("failed");
    const out = renderToStaticMarkup(<StoppedCard kind="failed" view={view} />);
    expect(out).toContain("WalkieTalkie keeps failing");
    expect(out).toContain("unknown option");
    expect(out).toContain("Start WalkieTalkie");
  });
  test("a daemon without the auto-start keeps the manual Start", () => {
    expect(notRunningKind(v({}))).toBe("manual");
    expect(notRunningKind(null)).toBe("manual");
  });
  test("Resume calls POST /v1/orchestrator/auto", async () => {
    const client = await Bun.file(new URL("../src/api/client.ts", import.meta.url)).text();
    expect(client).toContain('request<OrchestratorView>("POST", "/v1/orchestrator/auto", {}');
  });
});

test("the WalkieTalkie card shows one bounded cleanup pending diagnostic", () => {
  const out = renderToStaticMarkup(<TalkieStateCard view={{ running: false, state: "cleanup_pending", restarts: 0,
    last_error: "helper unavailable\n" + "x".repeat(500) }} />);
  expect(out).toContain("WalkieTalkie cleanup pending");
  expect(out).toContain("helper unavailable");
  expect(out).not.toContain("Stopped");
  expect(out).not.toContain("offline");
  expect(out).not.toContain("x".repeat(241));
});
