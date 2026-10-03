// walkie doctor's EXIT STATUS on a mixed team, with the real CLI against real daemons. The macOS company-machine join
// (desktop/src-tauri/src/macos.rs `doctor`, join_flow.rs `execute`) runs `walkie doctor` as its last step and treats any
// non-zero exit as a failed join, skipping the owner-SSH step after it. A company machine joins with an add-machine Direct
// invite, so it is a Direct-only machine; on a mixed team whose Tailscale-only machines are asleep or not bridged, "mixed
// transports" reports other machines' reachability, not this machine's health, and must never turn the exit status red.
//   alex   dual (Tailscale + Walkie Direct), the roster authority and the bridge
//   bob    Tailscale only
//   arvid  Walkie Direct only (the machine whose doctor runs; no Tailscale checks apply to it)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { runAsPerson } from "../helpers/person-cli.ts";

const CLI = join(import.meta.dir, "../../src/cli/main.ts");
// A quick liveness window: a stopped machine stops being vouched for within seconds.
const FAST = { intervalMs: 1_000, livenessMs: 4_000, pushTimeoutMs: 1_000 };

let c: Cluster;
let alex: TestNode, bob: TestNode, arvid: TestNode;

interface Check { level: string; name: string; detail: string }

/** `walkie doctor --json` as a person's terminal runs it against `node`'s daemon: the exit status and the checks. */
async function doctor(node: TestNode): Promise<{ code: number; checks: Check[] }> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: node.home, WALKIE_SOCKET: node.socket };
  const r = await runAsPerson([process.execPath, CLI, "doctor", "--json"], env);
  return { code: r.code, checks: (JSON.parse(r.out) as { checks: Check[] }).checks };
}

const peer = async (n: TestNode, host: string) => (await n.client().peers()).nodes.find((x) => x.hostname === host);

beforeAll(async () => {
  c = new Cluster();
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", dual: true, sync: FAST });
  bob = await c.add({ name: "bob", login: "bob@example.com", hostname: "bobs-mbp", sync: FAST });
  arvid = await c.add({ name: "arvid", login: "-", hostname: "arvid-mbp", direct: true, sync: FAST });
  await alex.client().init("aka", "alex");
  await alex.client().invite("bob@example.com", "bob", "member");
  expect((await bob.client().join(alex.peerAddr)).admitted).toBe(true);
  await alex.client().request("POST", "/v1/direct/enable", {});
  const inv = await alex.client().inviteCode("arvid", "member");
  expect((await arvid.client().join(inv.code)).admitted).toBe(true);
  await waitFor(async () => (await peer(arvid, "bobs-mbp"))?.online, { timeoutMs: 30_000, what: "arvid sees bob online through alex" });
}, 60_000);

afterAll(async () => { await c.close(); });

describe("walkie doctor on a Direct-only machine of a mixed team", () => {
  test("the Tailscale-only machine is bridged by the dual authority: a warning, and exit status 0", async () => {
    const d = await doctor(arvid);
    const mixed = d.checks.find((x) => x.name === "mixed transports");
    expect(mixed).toMatchObject({ level: "warn" });
    expect(mixed?.detail).toContain("1 machine uses only Tailscale (bobs-mbp)");
    expect(mixed?.detail).toContain("its agents show here only while another machine that reaches it is in sync");
    expect(d.checks.filter((x) => x.level === "fail")).toEqual([]);
    expect(d.code).toBe(0);
  }, 60_000);

  test("every Tailscale-only machine is off (nobody vouches for it, its agents are hidden): still a warning, still exit status 0", async () => {
    await bob.stop();
    await waitFor(async () => (await peer(arvid, "bobs-mbp"))?.unreached?.vouched === false, { timeoutMs: 40_000, what: "bob no longer vouched for on arvid" });
    const d = await doctor(arvid);
    const mixed = d.checks.find((x) => x.name === "mixed transports");
    expect(mixed).toMatchObject({ level: "warn" });
    expect(mixed?.detail).toContain("so its agents are hidden here (or that machine is off)");
    expect(mixed?.detail).toContain("Fix: Tailscale is optional on this machine; the other machines should run walkie direct enable");
    // The desktop join sees only the exit status: nothing here may fail on account of other machines.
    expect(d.checks.filter((x) => x.level === "fail")).toEqual([]);
    expect(d.code).toBe(0);
  }, 90_000);
});
