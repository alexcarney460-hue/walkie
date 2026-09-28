// PRE5-INT (c): the dashboard's Start / Stop buttons (web/src/views/orchestrator/Lifecycle.tsx) call
// POST /v1/orchestrator/start with no settings (the daemon's defaults) and POST /v1/orchestrator/stop, as a dashboard
// SESSION: that really passes the person-only gate, with a FAKE claude found on the daemon's own PATH. The daemon's
// refusals are what the button shows inline (no_team; claude_not_found; an observer); an agent and a paired phone are
// refused (the phone app has no Orchestrator tab, and its tunnel can't reach these routes either).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { hkdfKey, pairingKeys, unb64u } from "../../src/mobile/crypto.ts";
import { MobileLink, type Registered } from "../../src/mobile/client.ts";
import type { OrchestratorView } from "../../src/protocol/orchestrator.ts";
import { startRelay, type RelayHandle } from "../../src/relay/server.ts";
import { ApiError } from "../../web/src/api/client.ts";
import { lifecycleError } from "../../web/src/views/orchestrator/lifecycle-error.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

const FAKE_DIR = join(import.meta.dir, "..", "fixtures", "fake-claude");

let c: Cluster;
let alex: TestNode;
let kira: TestNode;
let relay: RelayHandle;
let relayUrl: string;

const url = (n: TestNode, p: string) => `http://127.0.0.1:${n.d.localPort as number}${p}`;
async function session(n: TestNode): Promise<Record<string, string>> {
  const { nonce } = await n.client().authNonce();
  const res = await fetch(url(n, `/auth?nonce=${nonce}`), { redirect: "manual" });
  const value = /#s=([0-9a-f]{64})$/.exec(res.headers.get("location") ?? "")?.[1] ?? "";
  if (!value) throw new Error("no dashboard session");
  return { "X-Walkie-Session": value, Origin: `http://127.0.0.1:${n.d.localPort as number}` };
}
/** Exactly what the dashboard's api.orchestratorStart / orchestratorStop send (web/src/api/client.ts). */
async function dash(n: TestNode, h: Record<string, string>, what: "start" | "stop"): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url(n, `/v1/orchestrator/${what}`), {
    method: "POST", headers: { ...h, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
/** The text the dashboard shows for a refusal (lifecycleError over the ApiError its client builds). */
function shown(r: { status: number; body: Record<string, unknown> }): string {
  const e = r.body.error as { code: string; message: string };
  return lifecycleError(new ApiError(e.code, e.message, r.status));
}

async function phone(n: TestNode): Promise<MobileLink> {
  const p = await n.client().mobilePair();
  const code = /#pair=([A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22})/.exec(p.url)?.[1];
  if (!code) throw new Error("no pairing code");
  const k = await pairingKeys(code);
  const pairing = await MobileLink.open({ relay: relayUrl, room: k.room, kid: "pair", psk: k.psk });
  const reg: Registered = await pairing.register("Alex's phone");
  pairing.close();
  return MobileLink.open({ relay: relayUrl, room: reg.room, kid: `d:${reg.device.id}`, psk: await hkdfKey(unb64u(reg.key)) });
}

beforeAll(async () => {
  relay = startRelay({ port: 0, hostname: "127.0.0.1", connectRate: { capacity: 1_000, perSecond: 1_000 }, perIpConnections: 1_000 });
  relayUrl = `ws://127.0.0.1:${relay.port}`;
  c = new Cluster();
  const state = join(c.root, "fake-state");
  mkdirSync(state, { recursive: true });
  // The daemon's OWN PATH has the fake claude first (and bun, its interpreter): the dashboard sends no path, so this is
  // where start finds it.
  const orchestrator = {
    autoCheckMs: 500, restartBaseMs: 50, restartMaxMs: 200, statusThrottleMs: 50,
    env: { ...process.env, PATH: `${FAKE_DIR}:${dirname(process.execPath)}:/usr/bin:/bin`, FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_LOG: join(c.root, "fake-launches.jsonl") },
  };
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", orchestrator, mobile: { relayUrl, appUrl: "http://127.0.0.1:1/m" } });
  kira = await c.add({ name: "kira", login: "kira@example.com", hostname: "kiras-mbp", orchestrator });
}, 60_000);

afterAll(async () => { await c.close(); relay.stop(); });

describe("the dashboard's Start / Stop (PRE5-INT c)", () => {
  test("before a team: start is refused with the daemon's words, shown inline", async () => {
    const r = await dash(alex, await session(alex), "start");
    expect(r.status).toBe(409);
    expect((r.body.error as { code: string }).code).toBe("no_team");
    expect(shown(r)).toStartWith("Not in a team yet");
  });

  test("a dashboard session starts it with the daemon's defaults (the fake claude on its PATH), then stops it", async () => {
    await alex.client().init("acme", "alex");
    const h = await session(alex);
    const started = await dash(alex, h, "start");
    expect(started.status).toBe(200);
    const v = started.body as unknown as OrchestratorView;
    expect(v.local.running).toBe(true);
    expect(v.local.claude).toEndWith("/test/fixtures/fake-claude/claude");
    expect(v.local.permission_mode).toBe("default");
    await waitFor(async () => (await alex.client("").orchestrator()).local.state === "idle", { what: "orchestrator idle" });
    // the tab's "running" signal: the orchestrator agent is live on this machine
    await waitFor(async () => (await alex.client().agents()).agents.some((a) => a.agent === "orchestrator" && a.node === alex.d.nodeId && a.effective_state !== "offline"), { what: "orchestrator agent live" });

    // a dashboard session names no binary, PATH, folder or permission mode: those stay with the CLI (ORCH-2: the access
    // and the model are the dashboard's to choose, test/integration/orch-2.test.ts)
    for (const extra of [{ claude: "/bin/sh" }, { path: "/tmp" }, { cwd: "/" }, { permission_mode: "bypassPermissions" }, { model: "opus", cwd: "/" }]) {
      const r = await fetch(url(alex, "/v1/orchestrator/start"), { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify(extra) });
      expect({ extra, status: r.status }).toEqual({ extra, status: 403 });
    }
    expect((await alex.client("").orchestrator()).local.claude).toEndWith("/test/fixtures/fake-claude/claude"); // unchanged
    const stopped = await dash(alex, h, "stop");
    expect(stopped.status).toBe(200);
    expect(stopped.body.stopped).toBe("local");
    expect((stopped.body as unknown as OrchestratorView).local.running).toBe(false);
    expect((await dash(alex, h, "stop")).body.stopped).toBe("none");
  }, 30_000);

  test("an agent is refused start and stop while agent admin is off (AGENT-ADMIN-1); a paired phone reaches neither", async () => {
    await alex.client("").adminSwitches({ agent_admin: false });
    await expect(alex.client("cc-agent1").orchestratorStart({})).rejects.toMatchObject({ status: 403, code: "agent_admin_off" });
    await expect(alex.client("cc-agent1").orchestratorStop()).rejects.toMatchObject({ status: 403, code: "agent_admin_off" });
    await alex.client("").adminSwitches({ agent_admin: true });
    const link = await phone(alex);
    try {
      for (const p of ["/v1/orchestrator/start", "/v1/orchestrator/stop"]) {
        const r = await link.request("POST", p, {});
        expect({ p, status: r.status }).toEqual({ p, status: 403 });
      }
    } finally {
      link.close();
    }
    expect((await alex.client("").orchestrator()).local.running).toBe(false);
  }, 30_000);

  test("an agent cannot grant shell or elevated permissions, but can lower access", async () => {
    const agent = alex.client("cc-agent1");
    await expect(agent.orchestratorStart({ access: "full" })).rejects.toThrow(/only a person can give WalkieTalkie shell access/);
    await expect(agent.orchestratorStart({ permission_mode: "acceptEdits" })).rejects.toThrow(/only a person can give WalkieTalkie shell access/);
    for (const option of [{ claude: "/bin/sh" }, { path: "/tmp" }, { cwd: "/tmp" }]) {
      await expect(agent.orchestratorStart(option)).rejects.toMatchObject({ status: 403, code: "person_only" });
    }
    await expect(agent.orchestratorAccess("full")).rejects.toThrow(/only a person can give WalkieTalkie shell access/);
    await expect(agent.orchestratorLeadEligible(true)).rejects.toMatchObject({ status: 403 });
    const h = await session(alex);
    const res = await fetch(url(alex, "/v1/orchestrator/start"), { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ access: "full" }) });
    expect(res.status).toBe(200);
    await expect(agent.orchestratorAuto()).rejects.toThrow(/only a person can give WalkieTalkie shell access/);
    expect((await agent.orchestratorAccess("platform")).local.access).toBe("platform");
    await alex.client("").orchestratorStop();
  }, 30_000);

  test("an observer's dashboard is refused with the daemon's reason", async () => {
    await alex.client().invite("kira@example.com", "kira", "observer");
    expect((await kira.client().join(alex.peerAddr)).admitted).toBe(true);
    const r = await dash(kira, await session(kira), "start");
    expect(r.status).toBe(403);
    expect(shown(r)).toBe("Observers can't run an orchestrator");
  }, 30_000);

  test("the dashboard's text: daemon refusals verbatim (capitalised), session/network ones friendly", () => {
    expect(lifecycleError(new ApiError("claude_not_found", "the claude CLI was not found (install Claude Code and sign in, or pass --claude <path>)", 409)))
      .toBe("The claude CLI was not found (install Claude Code and sign in, or pass --claude <path>)");
    expect(lifecycleError(new ApiError("network", "daemon unreachable", 0))).toBe("Can't reach the Walkie daemon on this machine.");
    expect(lifecycleError(new ApiError("unauthorized", "no session", 401))).toContain("Run `walkie dashboard`");
    expect(lifecycleError(new Error("boom"))).toBe("Something went wrong. Try again.");
  });
});
