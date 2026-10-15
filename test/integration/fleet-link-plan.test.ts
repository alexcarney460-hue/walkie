// FLEET-LINK-1: the clock-dependent rules, on daemons whose clocks move together (a peer more than a day ahead is held).
// A link expires (refused after), and the plan's machine limit applies at redemption: Free has 4 machines, the 5th
// joining with a link gets 402 plan_limit (the joining CLI says so plainly); an owner's approval is limited the same way.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { WalkieError } from "../../src/client/index.ts";
import { DAY_MS } from "../../src/license/plans.ts";
import { Cluster, type TestNode } from "../helpers/cluster.ts";
import { runAsPerson } from "../helpers/person-cli.ts";

setDefaultTimeout(60_000);
const CLI = join(import.meta.dir, "../../src/cli/main.ts");
let c: Cluster;
let alex: TestNode;
let offset = 0;
let n = 0;
const clock = () => Date.now() + offset;
const machine = (hostname: string) => c.add({ name: `p${++n}`, login: "-", hostname, direct: true, clock });

beforeAll(async () => {
  c = new Cluster();
  alex = await c.add({ name: "alex", login: "-", hostname: "alex-mbp", direct: true, clock });
  await alex.client().init("acme", "alex");
});
afterAll(async () => { await c.close(); });

test("a link past its expiry is refused; one still in date works, until the plan's machine limit (402 plan_limit)", async () => {
  const short = await alex.client().mintLink({ owner_machines: true, uses: 10, expires_days: 1 });
  const long = await alex.client().mintLink({ owner_machines: true, uses: 10, expires_days: 30 });
  const pending = await alex.client().mintLink({ owner_machines: true, uses: 10, expires_days: 30, approve: true });
  offset = 20 * DAY_MS; // the trial is over: Free (4 machines); the 1-day link has expired
  expect((await alex.client().license()).plan).toBe("free");
  const waiting = await machine("waits");
  expect((await waiting.client().joinLink(pending.token)).reason).toBe("pending_approval"); // queued with room left
  const late = await machine("late");
  expect((await late.client().joinLink(short.token)).reason).toBe("link_expired");
  expect((await alex.client().links()).links.find((l) => l.id === short.id)?.state).toBe("expired");
  // alex-mbp + 3 more = the 4 machines Free allows.
  for (const h of ["a", "b", "c"]) expect((await (await machine(`free-${h}`)).client().joinLink(long.token)).admitted).toBe(true);
  const fifth = await machine("free-d");
  expect((await fifth.client().joinLink(long.token)).reason).toBe("plan_limit");
  // The CLI on that machine says what it means.
  const r = await runAsPerson([process.execPath, CLI, "join", long.token], { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: fifth.home, WALKIE_SOCKET: fifth.socket });
  expect([r.code, r.err.includes("the team's plan has no room for another machine")]).toEqual([1, true]);
  // An owner's approval is held to the same limit (the request stays, to approve after an upgrade).
  const err = await alex.client().request("POST", "/v1/team/admit-link", { ...alex.d.core.store.joinRequest(waiting.d.nodeId, alex.d.core.clock())!, node_id: waiting.d.nodeId, approve: true }).then(() => null, (e: unknown) => e as WalkieError);
  expect([err?.status, err?.code]).toEqual([402, "plan_limit"]);
  const still = await alex.client().request<{ requests: Array<{ node_id: string }> }>("GET", "/v1/team/pending");
  expect(still.requests.some((p) => p.node_id === waiting.d.nodeId)).toBe(true);
  // The refused attempt is recorded for owners.
  expect((await alex.client().links()).uses.some((u) => u.link === long.id && u.state === "refused" && u.reason === "plan_limit")).toBe(true);
});
