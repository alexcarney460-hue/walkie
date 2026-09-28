// FINAL-2 Codex 2 (HIGH): `walkie upgrade` fails CLOSED when the plan can't be read. A subscriber whose
// daemon is stopped must never be handed a new-subscription checkout (a second recurring charge).
import { describe, expect, test } from "bun:test";
import { WalkieError, type WalkieClient } from "../../src/client/index.ts";
import { parseArgs } from "../../src/cli/args.ts";
import { upgrade } from "../../src/cli/commands/license.ts";
import { EXIT, type Ctx } from "../../src/cli/context.ts";
import { MANAGE_URL } from "../../src/license/site.ts";
import type { PlanView } from "../../src/protocol/schemas.ts";

function plan(over: Partial<PlanView>): PlanView {
  return {
    plan: "team", status: "trial", entitlements: { people: 50, machines: null, restricted_channels: true, integrations: null, audit_export: false, join_approval: false },
    seats: { used: 3, limit: 50 }, machines: { used: 3, limit: null }, license: null, trial: { ends_at: 0, days_left: 9 },
    upgrade_url: "https://getwalkie.vercel.app/api/checkout?plan=team&interval=month&seats=3", manage_url: MANAGE_URL, ...over,
  };
}

function ctx(argv: string[], license: () => Promise<PlanView>): Ctx & { lines: string[]; errs: string[] } {
  const lines: string[] = [], errs: string[] = [];
  const args = parseArgs([...argv, "--no-open"], new Set(["json", "no-open"]));
  return {
    args, json: args.flags.get("json") === true, forAgent: false, agentMarker: () => null, lines, errs,
    client: () => ({ license } as unknown as WalkieClient),
    out: (s) => { lines.push(s); }, err: (s) => { errs.push(s); },
  };
}

describe("walkie upgrade fails closed", () => {
  test("daemon unreachable: no checkout URL, the portal is named, exit 3", async () => {
    const c = ctx([], async () => { throw new WalkieError("daemon_unreachable", "walkie daemon not reachable", 0); });
    expect(await upgrade(c)).toBe(EXIT.unreachable);
    const all = [...c.lines, ...c.errs].join("\n");
    expect(all).not.toContain("api/checkout");
    expect(all).toContain("can't read your plan");
    expect(all).toContain(MANAGE_URL);
    expect(all).toContain("walkie upgrade");
  });

  test("any other failure to read the plan (timeout, 5xx, no team) is closed too; --json says why", async () => {
    for (const err of [new WalkieError("http_500", "boom", 500), new WalkieError("no_team", "no team", 409), new Error("timeout")]) {
      const c = ctx(["--json"], async () => { throw err; });
      expect(await upgrade(c)).not.toBe(EXIT.ok);
      const out = JSON.parse(c.lines.join("\n")) as { error: string; portal: string; url?: string };
      expect(out.error).toBe("plan_unavailable");
      expect(out.portal).toBe(MANAGE_URL);
      expect(out.url).toBeUndefined();
    }
  });

  test("an active subscriber goes to the portal; a trial team gets checkout for its people count; a lapsed license rides along", async () => {
    const active = ctx(["--json"], async () => plan({ status: "active", license: { lic_id: "sub_1", plan: "team", seats: 5, email: "a@b.c", interval: "month", issued_at: 0, expires_at: 0, grace_ends_at: 0 }, upgrade_url: MANAGE_URL }));
    expect(await upgrade(active)).toBe(EXIT.ok);
    expect(JSON.parse(active.lines[0] as string)).toMatchObject({ url: MANAGE_URL, portal: true });
    const trial = ctx(["--json"], async () => plan({}));
    expect(await upgrade(trial)).toBe(EXIT.ok);
    expect(JSON.parse(trial.lines[0] as string).url).toBe("https://getwalkie.vercel.app/api/checkout?plan=team&interval=month&seats=3");
    const grace = ctx(["--json"], async () => plan({ status: "grace", license: { lic_id: "sub_9", plan: "team", seats: 5, email: "a@b.c", interval: "month", issued_at: 0, expires_at: 0, grace_ends_at: 0 } }));
    expect(await upgrade(grace)).toBe(EXIT.ok);
    expect(JSON.parse(grace.lines[0] as string).url).toContain("lic_id=sub_9");
  });
});
