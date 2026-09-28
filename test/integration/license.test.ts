// WALKIE-LICENSE-1 end to end: live daemons (a throwaway vendor key), the local API, a roster request
// relayed through a non-authority owner, and the real CLI.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { WalkieError } from "../../src/client/index.ts";
import { SITE_ORIGIN } from "../../src/license/site.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { testVendor } from "../helpers/license.ts";
import { runAsPerson, runConfirmed } from "../helpers/person-cli.ts";

const CLI = join(import.meta.dir, "../../src/cli/main.ts");
const vendor = testVendor();
let c: Cluster;
let alex: TestNode, bea: TestNode;

async function walkie(node: TestNode, args: string[], confirm?: string) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: node.home, WALKIE_SOCKET: node.socket };
  // A person's terminal; person-only commands (invite, revoke) are confirmed by typing `confirm` at their prompt.
  return confirm === undefined ? runAsPerson([process.execPath, CLI, ...args], env) : runConfirmed([process.execPath, CLI, ...args], env, confirm);
}

async function caught(p: Promise<unknown>): Promise<WalkieError> {
  try { await p; } catch (err) { if (err instanceof WalkieError) return err; throw err; }
  throw new Error("expected an error");
}

beforeAll(async () => {
  c = new Cluster();
  alex = await c.add({ name: "alex", login: "alex@example.com", licenseVerifier: vendor.verify });
  bea = await c.add({ name: "bea", login: "bea@example.com", licenseVerifier: vendor.verify });
  await alex.client().init("acme", "alex");
  await alex.client().invite("bea@example.com", "bea", "owner");
  const j = await bea.client().join(alex.peerAddr);
  if (!j.admitted) throw new Error(`bea join failed: ${j.reason}`);
});
afterAll(async () => { await c.close(); });

describe("license end to end", () => {
  test("a new team starts on the 14-day Team trial, visible in /v1/me, /v1/team and /v1/license", async () => {
    const me = await alex.client().me();
    expect(me.plan).toMatchObject({ plan: "team", status: "trial", seats: { used: 2, limit: 50 }, trial: { days_left: 14 } });
    expect((await alex.client().team()).plan.status).toBe("trial");
    expect((await bea.client().license()).entitlements.integrations).toBeNull();
  });

  test("a forged key is refused; an owner off the authority activates through a roster request, and every node shows it", async () => {
    const team = (await alex.client().me()).team?.id as string;
    const forged = await walkie(bea, ["license", "activate", testVendor().issue({ team, issued_at: Date.now(), expires_at: Date.now() + 86_400_000 })]);
    expect(forged.code).toBe(1);
    expect(forged.err).toContain("invalid_license");
    const other = await walkie(bea, ["license", "activate", vendor.issue({ team: "abcdefabcdefabcd", issued_at: Date.now(), expires_at: Date.now() + 86_400_000 })]);
    expect([other.code, other.err.includes("wrong_team")]).toEqual([1, true]);
    const key = vendor.issue({ team, seats: 2, issued_at: Date.now(), expires_at: Date.now() + 35 * 86_400_000 });
    const r = await walkie(bea, ["license", "activate", key]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("license activated · Team · 2/2 seats");
    const plan = await waitFor(async () => { const p = await alex.client().license(); return p.license ? p : null; }, { what: "license on the authority" });
    expect(plan).toMatchObject({ plan: "team", status: "active", seats: { used: 2, limit: 2 } });
    const again = await walkie(alex, ["license", "activate", key]);
    expect(again.out).toContain("already active");
    const show = await walkie(alex, ["license"]);
    expect(show.out).toContain("Team · 2/2 seats");
    expect(show.out).toContain("billed per month · billing@example.com");
    expect((await walkie(alex, ["who"])).out).toContain("plan: Team · 2/2 seats");
  });

  test("inviting past the seats: 402 plan_limit with the details, on the authority and relayed from another owner", async () => {
    const err = await caught(alex.client().invite("kira@example.com", "kira", "member"));
    expect([err.status, err.code]).toEqual([402, "plan_limit"]);
    // FINAL Codex 1: this team already subscribes (an active license): more seats are added in the billing
    // portal, never through a second checkout, on the authority and relayed alike.
    expect(err.details).toEqual({ resource: "people", limit: 2, used: 2, plan: "team", subscribed: true, upgrade_url: `${SITE_ORIGIN}/api/portal` });
    const relayed = await caught(bea.client().invite("kira@example.com", "kira", "member"));
    expect([relayed.status, relayed.code, relayed.details?.upgrade_url, relayed.details?.subscribed]).toEqual([402, "plan_limit", `${SITE_ORIGIN}/api/portal`, true]);
    const cli = await walkie(bea, ["invite", "kira@example.com", "--handle", "kira"], "kira");
    expect(cli.code).toBe(1);
    expect(cli.err).toContain("Your Team plan includes 2 people (2 in use).");
    expect(cli.err).toContain("already subscribe");
    expect(cli.err).toContain(`${SITE_ORIGIN}/api/portal`);
    expect(cli.err).not.toContain("/api/checkout");
    expect((await alex.client().team()).members.length).toBe(2);
    // Restricted channels are part of Team.
    expect((await alex.client().channel({ name: "core", members: ["alex", "bea"] })).event.kind).toBe("channel.upsert");
  });

  test("walkie upgrade sends a subscriber to the billing portal (never a second checkout); doctor shows the plan", async () => {
    const r = await walkie(alex, ["upgrade", "--no-open", "--interval", "year"]);
    expect(r.out).toContain("already subscribes");
    expect(r.out).toContain(`${SITE_ORIGIN}/api/portal`);
    expect(r.out).not.toContain("/api/checkout");
    const js = JSON.parse((await walkie(alex, ["upgrade", "--json"])).out) as { url: string; portal?: boolean };
    expect(js).toMatchObject({ url: `${SITE_ORIGIN}/api/portal`, portal: true });
    const d = await walkie(alex, ["doctor", "--json"]);
    const checks = (JSON.parse(d.out) as { checks: { name: string; detail: string }[] }).checks;
    expect(checks.find((x) => x.name === "plan")?.detail).toBe("Team · 2/2 seats");
  });
});
