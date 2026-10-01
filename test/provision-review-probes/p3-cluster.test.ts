// Adversarial probe P3: real in-process cluster (temp homes under /tmp/walkie-*), real peer API + real remote-admin path +
// real CLI children (bun src/cli/main.ts against the TEST daemon's socket), with the INSTALLER replaced by a controllable
// fake (mock.module on executor.ts). fetch is guarded to loopback only; Bun.spawn only allows the walkie CLI child.
import { afterAll, beforeAll, expect, mock, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

const R = join(import.meta.dir, "../..");
setDefaultTimeout(120_000);

// ---- safety nets: no external network, no installer spawns ------------------------------------------------------
const blocked: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let host = ""; try { host = new URL(u).hostname; } catch { /* */ }
  if (init?.unix || host === "127.0.0.1" || host === "localhost" || host === "[::1]" || u.startsWith("unix:") || u.startsWith("http://localhost")) return realFetch(input, init);
  blocked.push(`fetch ${u}`);
  throw new Error(`STUB fetch blocked: ${u}`);
}) as never;
const realSpawn = Bun.spawn.bind(Bun);
const cliMain = `${R}/src/cli/main.ts`;
(Bun as any).spawn = (argv: any, opts: any) => {
  const a = Array.isArray(argv) ? argv : argv.cmd;
  if (a[0] === process.execPath && a[1] === cliMain) return realSpawn(argv, opts);
  blocked.push(`spawn ${JSON.stringify(a)}`);
  throw new Error(`STUB spawn blocked: ${JSON.stringify(a)}`);
};
const realSpawnSync = Bun.spawnSync.bind(Bun);
(Bun as any).spawnSync = (argv: any, opts: any) => {
  const a = Array.isArray(argv) ? argv : argv.cmd;
  blocked.push(`spawnSync ${JSON.stringify(a)}`);
  void realSpawnSync;
  throw new Error(`STUB spawnSync blocked: ${JSON.stringify(a)}`);
};

// ---- fake installer ---------------------------------------------------------------------------------------------
const { ProvisionInterrupted } = await import(`${R}/src/daemon/provision/interrupt.ts`);
type Gate = { released: boolean; release: () => void };
const ctl = {
  gates: new Map<string, Gate>(), executed: [] as string[], log: [] as string[], installed: new Set<string>(["walkie-daemon", "bun"]),
  gate(id: string): Gate { const g = { released: false, release: () => { g.released = true; } }; this.gates.set(id, g); return g; },
  reset() { this.gates.clear(); this.executed.length = 0; this.log.length = 0; this.installed = new Set(["walkie-daemon", "bun"]); },
};
// mock.module outlives this file in Bun: snapshot the real exports first and hand them back in afterAll.
const realExecutor = { ...(await import(`${R}/src/daemon/provision/executor.ts`)) };
mock.module(`${R}/src/daemon/provision/executor.ts`, () => ({
  lockProblem: () => null,
  executorFor: (_home: string) => ({
    inspect: async (s: { id: string }) => (ctl.installed.has(s.id) ? "installed" : "missing"),
    execute: async (s: { id: string; kind: string }, onProcess?: (p: { pid: number; start: string }) => void, guard?: () => string | null) => {
      ctl.executed.push(s.id); ctl.log.push(`start:${s.id}`);
      if (s.kind === "node_archive" || s.kind === "npm_locked") onProcess?.({ pid: 999999, start: "fake-installer" });
      const g = ctl.gates.get(s.id);
      while (g && !g.released) {
        const denied = guard?.();
        if (denied) { ctl.log.push(`aborted:${s.id}`); throw new ProvisionInterrupted(denied); }
        await Bun.sleep(20);
      }
      ctl.log.push(`end:${s.id}`);
      if (s.kind === "installer_elevation" || s.kind === "check") return "needs_installer_elevation";
      ctl.installed.add(s.id);
    },
  }),
}));

const { Cluster, standardTeam, waitFor } = await import(`${R}/test/helpers/cluster.ts`);
const { WalkieClient } = await import(`${R}/src/client/index.ts`);
const { consentText } = await import(`${R}/src/daemon/provision/consent.ts`);
const { PROFILES } = await import(`${R}/src/daemon/provision/profiles.ts`);
const { provisionChecks } = await import(`${R}/src/cli/commands/doctor.ts`);
type TestNode = any;

let cluster: InstanceType<typeof Cluster>;
let alex: TestNode, kira: TestNode, kira2: TestNode, noor: TestNode;
const profile = { id: "developer-worker" as const, version: PROFILES["developer-worker"].version };
const journalPath = () => join(kira2.home, "provision-developer-worker.json");
const journal = () => JSON.parse(readFileSync(journalPath(), "utf8")) as { steps: { id: string; state: string; attempts: number; actor?: string; target?: string }[] };
const state = (id: string) => journal().steps.find((s) => s.id === id)?.state;
const auditFile = () => readFileSync(join(kira2.home, "admin-audit.jsonl"), "utf8");
const run = (from: TestNode, argv: string[], machines = "kiras-studio") => from.client().adminRun({ machines, argv });
const grantBody = (owner: string, launchers = ["@alex"]) => ({ owner_node: owner, launchers, seat_cap: 3, profiles: [profile], company_mode: true as const, consent_version: 1, consented: true as const, confirmation: { surface: "desktop" as const, typed_phrase: "yes" as const }, consent_text: consentText("alex", launchers, 3, [profile]) });
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as { code: string; status: number; message: string }; } throw new Error("expected refusal"); };
async function posts(n: TestNode) {
  const got = await n.client().events({ channel: "general", kinds: "msg.post", limit: 500 });
  return got.events.filter((e: any) => e.author.agent === "walkie-admin").map((e: any) => (e.body as { text: string }).text);
}

beforeAll(async () => {
  cluster = new Cluster();
  ({ alex, kira, kira2 } = await standardTeam(cluster));
  noor = await cluster.add({ name: "noor", login: "noor@example.com", hostname: "noors-mbp" });
  await alex.client().invite("noor@example.com", "noor", "member");
  const j = await noor.client().join(alex.peerAddr);
  if (!j.admitted) throw new Error("noor join failed");
  await alex.client().setRole("noor", "owner");
  await waitFor(() => [...kira2.d.core.roster.members.values()].find((m: any) => m.handle === "noor")?.role === "owner" && kira2.d.core.roster.nodes.size === 4, { what: "roster sync (noor owner)" });
  await waitFor(() => [...noor.d.core.roster.members.values()].find((m: any) => m.handle === "noor")?.role === "owner" && noor.d.core.roster.nodes.size === 4, { what: "noor roster sync" });
});
afterAll(async () => {
  await cluster.close();
  console.log("BLOCKED external attempts during P3:", blocked.length ? blocked.join(" | ") : "none");
  globalThis.fetch = realFetch; (Bun as any).spawn = realSpawn; (Bun as any).spawnSync = realSpawnSync;
  mock.module(`${R}/src/daemon/provision/executor.ts`, () => realExecutor);
});

test("T0: grant creation is local person only, exact consent, one active grant", async () => {
  const body = grantBody(alex.d.nodeId);
  expect((await err(kira2.client("agent").request("POST", "/v1/provision/grant", body))).code).toBe("person_only");
  expect((await err(kira2.client().request("POST", "/v1/provision/grant", { ...body, consent_text: body.consent_text + " " }))).code).toBe("invalid_consent");
  const g: any = await kira2.client().request("POST", "/v1/provision/grant", body);
  expect(g.recipient).toBe("kira");
  expect((await err(kira2.client().request("POST", "/v1/provision/grant", body))).code).toBe("grant_exists");
  expect((await posts(kira2)).filter((t: string) => t.includes("may now provision kiras-studio")).length).toBe(1);
  // an owner_node that is a MEMBER's node is refused
  expect((await err(kira2.client().request("POST", "/v1/provision/grant", { ...body, owner_node: kira.d.nodeId }))).code).toBe("owner_required");
});

test("F1-live: another owner cannot provision without new consent", async () => {
  const res = await run(noor, ["provision", "status", "--profile", "developer-worker", "--json"]);
  console.log("F1-live noor status ->", JSON.stringify({ ok: res.results[0]?.ok, exit: res.results[0]?.exit, error: res.results[0]?.error }));
  expect(res.results[0]?.error?.code).toBe("owner_not_consented");
  const ap = await run(noor, ["provision", "apply", "--profile", "developer-worker", "--json"]);
  const out = JSON.parse(ap.results[0]?.stdout ?? "{}");
  console.log("F1-live noor apply ->", ap.results[0]?.error?.code, out.state);
  expect(ap.results[0]?.error?.code).toBe("owner_not_consented");
  // reset installed state for later tests + wipe journal for a clean slate (test-side file removal in the TEST node's temp home)
  ctl.reset();
  writeFileSync(journalPath(), JSON.stringify({ profile: "developer-worker", version: profile.version, steps: PROFILES["developer-worker"].steps.map((s: any) => ({ id: s.id, version: s.version, state: "pending", attempts: 0, at: 0 })) }) + "\n", { mode: 0o600 });
  chmodSync(journalPath(), 0o600);
});

test("T2: revoke interrupts the running node step and leaves uncertainty", async () => {
  ctl.reset();
  const gate = ctl.gate("node");
  const pending = run(alex, ["provision", "apply", "--profile", "developer-worker", "--json"]);
  await waitFor(() => ctl.log.includes("start:node"), { what: "node step running" });
  expect(state("node")).toBe("started"); // receipt persisted BEFORE the irreversible step
  await kira2.client().request("POST", "/v1/provision/revoke", {});
  await kira2.client().request("POST", "/v1/provision/revoke", {});
  expect((await posts(kira2)).filter((t: string) => t.includes("revoked @kira's enrollment grant")).length).toBe(1);
  await Bun.sleep(300);
  console.log("T2 while revoked but gate held: log =", ctl.log.join(","), "| journal node =", state("node"));
  gate.release();
  const res = await pending;
  const out = JSON.parse(res.results[0]?.stdout ?? "{}");
  console.log("T2 remote result:", res.results[0]?.exit, out.state, out.reason, "| node:", state("node"), "| pnpm:", state("pnpm"), "| executed:", ctl.executed.join(","));
  expect(out.state).toBe("revoked");
  expect(state("node")).toBe("uncertain");
  expect(ctl.executed.includes("pnpm")).toBe(false);
  expect(ctl.log).toContain("aborted:node");
  expect(ctl.log).not.toContain("end:node");
  const a = auditFile();
  expect(a).toContain("provision developer-worker v3 node: started");
  expect(a).toContain("provision developer-worker v3 node: uncertain");
  // once revoked, further remote provision calls are refused at the target
  expect((await run(alex, ["provision", "apply", "--profile", "developer-worker"])).results[0]?.error?.code).toBe("grant_revoked");
});

test("T5: after process exit and renewed consent, uncertain node can retry", async () => {
  const before = ctl.executed.filter((x) => x === "node").length;
  const g: any = await kira2.client().request("POST", "/v1/provision/grant", grantBody(alex.d.nodeId));
  expect(g.revoked_at).toBeUndefined();
  ctl.gates.clear();
  const res = await run(alex, ["provision", "apply", "--profile", "developer-worker", "--json"]);
  const out = JSON.parse(res.results[0]?.stdout ?? "{}");
  console.log("T5 result:", out.state, "| node reruns:", ctl.executed.filter((x) => x === "node").length - before, "| steps:", journal().steps.map((s) => `${s.id}=${s.state}`).join(" "));
  expect(ctl.executed.filter((x) => x === "node").length).toBe(before + 1);
  expect(state("node")).toBe("done");
});

test("T5b: daemon worker aborts when its remote run token ends", async () => {
  const { beginRun } = await import(`${R}/src/daemon/admin/runs.ts`);
  writeFileSync(journalPath(), JSON.stringify({ profile: "developer-worker", version: profile.version,
    steps: PROFILES["developer-worker"].steps.map((s: any) => ({ id: s.id, version: s.version, state: "pending", attempts: 0, at: 0 })) }) + "\n", { mode: 0o600 });
  ctl.reset();
  const gate = ctl.gate("node");
  const remote = beginRun(kira2.d.core, { actor: "@alex/alex-mbp", notify: "kira", callerNode: alex.d.nodeId, callerHandle: "alex" });
  const pending = fetch("http://walkie/v1/provision/apply", { method: "POST", unix: kira2.socket,
    headers: { "Content-Type": "application/json", "X-Walkie-Agent": "remote-admin", "X-Walkie-Admin-Token": remote.token },
    body: JSON.stringify({ profile: "developer-worker" }) } as RequestInit);
  try {
    await waitFor(() => ctl.log.includes("start:node"), { what: "remote node step running" });
    remote.end();
    const result = await (await pending).json() as { state: string };
    expect(result.state).toBe("revoked");
    expect(ctl.log).toContain("aborted:node");
    expect(state("node")).toBe("uncertain");
  } finally { remote.end(); gate.release(); }
});

test("T3/T4: busy admission and switch-off interrupt running work", async () => {
  // fresh profile state
  writeFileSync(journalPath(), JSON.stringify({ profile: "developer-worker", version: profile.version, steps: PROFILES["developer-worker"].steps.map((s: any) => ({ id: s.id, version: s.version, state: "pending", attempts: 0, at: 0 })) }) + "\n", { mode: 0o600 });
  ctl.reset();
  const gate = ctl.gate("pnpm");
  const first = run(alex, ["provision", "apply", "--profile", "developer-worker", "--json"]);
  await waitFor(() => ctl.log.includes("start:pnpm"), { what: "pnpm running" });
  const second = await run(alex, ["provision", "apply", "--profile", "developer-worker", "--json"]);
  console.log("T4 second apply while first runs ->", JSON.stringify({ exit: second.results[0]?.exit, err: second.results[0]?.error, stderr: second.results[0]?.stderr?.slice(0, 200) }));
  const otherProfile = await err(kira2.client().request("POST", "/v1/provision/apply", { profile: "freight-worker" }));
  console.log("T4 local apply of a different profile while first runs ->", otherProfile.code);
  await kira2.client().adminSwitches({ remote_admin: false });
  await Bun.sleep(200);
  gate.release();
  const res = await first;
  const out = JSON.parse(res.results[0]?.stdout ?? "{}");
  console.log("T3 result after remote_admin off mid-run:", out.state, out.reason, "| pnpm:", state("pnpm"), "| claude-code:", state("claude-code"), "| executed:", ctl.executed.join(","));
  expect(out.state).toBe("revoked");
  expect(ctl.executed.includes("claude-code")).toBe(false);
  await kira2.client().adminSwitches({ remote_admin: true });
});

test("T6/T7: local surfaces: agent-marked caller, forged admin token, unmarked raw caller (same-user boundary)", async () => {
  // grant currently active with launchers [@alex]; kira2's person is kira (member, not listed)
  const a1 = await err(kira2.client("agent").request("POST", "/v1/provision/apply", { profile: "developer-worker" }));
  console.log("T6 agent-marked local apply ->", a1.code);
  expect(a1.code).toBe("person_only");
  const rawRes = await fetch("http://walkie/v1/provision/apply", { method: "POST", unix: kira2.socket, headers: { "Content-Type": "application/json", "X-Walkie-Admin-Token": "0".repeat(48) }, body: JSON.stringify({ profile: "developer-worker" }) } as RequestInit);
  const a2 = (await rawRes.json()) as { error?: { code?: string } };
  console.log("T7 forged 48-hex admin token from a local socket caller ->", rawRes.status, a2.error?.code);
  expect(a2.error?.code).toBe("invalid_run_token");
  // person-only grant route through a client that just omits the agent marker (what any same-user process can do)
  await kira2.client().request("POST", "/v1/provision/revoke", {});
  const raw = new WalkieClient({ socket: kira2.socket, timeoutMs: 15_000 });
  const g: any = await raw.request("POST", "/v1/provision/grant", grantBody(alex.d.nodeId, ["@alex", "@kira"]));
  console.log("T7 unmarked raw client minted a grant:", g.recipient, g.launchers.join(","));
  expect(g.recipient).toBe("kira");
  // with @kira listed, an agent on kira's own machine can now run provision (local actor = kira)
  const a3 = await err(kira2.client("agent").request("POST", "/v1/provision/apply", { profile: "freight-worker" }));
  console.log("T6b agent-marked local apply of unselected profile ->", a3.code);
  expect(a3.code).toBe("person_only");
});

test("T8: refused requests remain in the local audit", async () => {
  await kira2.client().request("POST", "/v1/provision/revoke", {});
  const audited = auditFile().split("\n").filter((line) => line.includes('"refused":"grant_revoked"')).length;
  const before = (await posts(kira2)).filter((t: string) => t.includes("provision request refused")).length;
  for (let i = 0; i < 6; i++) await run(alex, ["provision", "status", "--profile", "developer-worker"]);
  await Bun.sleep(300);
  const after = (await posts(kira2)).filter((t: string) => t.includes("provision request refused"));
  console.log("T8 #general refusal posts before/after 6 refused calls:", before, after.length, "| sample:", after[0]);
  expect(after.length - before).toBe(0);
  expect(auditFile().split("\n").filter((line) => line.includes('"refused":"grant_revoked"')).length - audited).toBe(6);
});

test("T13: a profile version mismatch needs local receipt reset", async () => {
  await kira2.client().request("POST", "/v1/provision/grant", grantBody(alex.d.nodeId));
  writeFileSync(journalPath(), JSON.stringify({ profile: "developer-worker", version: 1, steps: [{ id: "node", version: "22.20.0", state: "done", attempts: 1, at: 1 }] }) + "\n", { mode: 0o600 });
  const st = await run(alex, ["provision", "status", "--profile", "developer-worker"]);
  const ap = await run(alex, ["provision", "apply", "--profile", "developer-worker"]);
  console.log("T13 status:", st.results[0]?.exit, st.results[0]?.stderr?.trim().slice(0, 160), "| apply:", ap.results[0]?.exit, ap.results[0]?.stderr?.trim().slice(0, 160));
  expect(st.results[0]?.exit).not.toBe(0);
  expect(ap.results[0]?.exit).not.toBe(0);
  console.log("T13 doctor check:", JSON.stringify(await provisionChecks(kira2.home)));
  const reset = await kira2.client().provisionReset("developer-worker");
  expect(reset.archived).toBe(true);
  expect((await run(alex, ["provision", "status", "--profile", "developer-worker"])).results[0]?.exit).toBe(0);
});

test("T17: no secrets in journal/audit/#general; files are 0600", async () => {
  const j = readFileSync(journalPath(), "utf8"); const a = auditFile(); const p = (await posts(kira2)).join("\n");
  for (const blob of [j, a, p]) expect(/sk-[A-Za-z0-9]{10,}|ghp_|token|password|secret|BEGIN [A-Z ]*PRIVATE/i.test(blob)).toBe(false);
  expect((await Bun.file(join(kira2.home, "provision-grant.json")).stat()).mode & 0o777).toBe(0o600);
  expect(existsSync(join(kira2.home, "provision-tools"))).toBe(false);
});
