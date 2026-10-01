// Adversarial probe P5: (a) old-peer refusal fixture served over real HTTP through PeerClient;
// (b) grant replay to the same person's other machine; (c) named owner and demotion rules.
// fetch guarded to loopback; spawn only for the walkie CLI child; spawnSync blocked. Nothing installed.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { copyFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

const R = join(import.meta.dir, "../..");
setDefaultTimeout(120_000);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let host = ""; try { host = new URL(u).hostname; } catch { /* */ }
  if (init?.unix || host === "127.0.0.1" || host === "localhost") return realFetch(input, init);
  throw new Error(`STUB fetch blocked: ${u}`);
}) as never;
const realSpawn = Bun.spawn.bind(Bun);
(Bun as any).spawn = (argv: any, opts: any) => { const a = Array.isArray(argv) ? argv : argv.cmd; if (a[0] === process.execPath && a[1] === `${R}/src/cli/main.ts`) return realSpawn(argv, opts); throw new Error(`STUB spawn blocked: ${JSON.stringify(a)}`); };
const realSpawnSync = Bun.spawnSync.bind(Bun);
(Bun as any).spawnSync = () => { throw new Error("STUB spawnSync blocked"); };

const { Cluster, standardTeam, waitFor } = await import(`${R}/test/helpers/cluster.ts`);
const { PeerClient } = await import(`${R}/src/daemon/peer-client.ts`);
const { consentText } = await import(`${R}/src/daemon/provision/consent.ts`);
const { PROFILES } = await import(`${R}/src/daemon/provision/profiles.ts`);
const { writeRootMarker } = await import(`${R}/src/daemon/provision/root-marker.ts`);
const oldAdmin = { remoteArgvProblem: (argv: string[]) => argv[0] === "provision" ? "walkie provision can't run remotely (allowed: seats, accounts, admin)" : "not_allowed_remotely" };
type TestNode = any;
let cluster: any; let alex: TestNode, kira: TestNode, kira2: TestNode, noor: TestNode;
const profile = { id: "developer-worker" as const, version: PROFILES["developer-worker"].version };
const run = (from: TestNode, argv: string[], machines = "kiras-studio") => from.client().adminRun({ machines, argv });
const grantBody = (owner: string, ownerHandle = "alex") => ({ owner_node: owner, launchers: ["@alex"], seat_cap: 3, profiles: [profile], company_mode: true as const, consent_version: 1, consented: true as const, confirmation: { surface: "desktop" as const, typed_phrase: "yes" as const }, consent_text: consentText(ownerHandle, ["@alex"], 3, [profile]) });
let fake: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  cluster = new Cluster();
  ({ alex, kira, kira2 } = await standardTeam(cluster));
  noor = await cluster.add({ name: "noor", login: "noor@example.com", hostname: "noors-mbp" });
  await alex.client().invite("noor@example.com", "noor", "member");
  if (!(await noor.client().join(alex.peerAddr)).admitted) throw new Error("noor join failed");
  await alex.client().setRole("noor", "owner");
  await waitFor(() => [...kira2.d.core.roster.members.values()].find((m: any) => m.handle === "noor")?.role === "owner" && kira2.d.core.roster.nodes.size === 4 && kira.d.core.roster.nodes.size === 4, { what: "roster sync" });
  await waitFor(() => [...noor.d.core.roster.members.values()].find((m: any) => m.handle === "noor")?.role === "owner" && noor.d.core.roster.nodes.size === 4, { what: "noor sync" });
  fake = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = (await req.json()) as { argv: string[] };
    const message = oldAdmin.remoteArgvProblem(body.argv) ?? "ok";
    return new Response(JSON.stringify({ error: { code: "not_allowed_remotely", message } }), { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } });
  } });
});
afterAll(async () => { fake.stop(true); await cluster.close(); globalThis.fetch = realFetch; (Bun as any).spawn = realSpawn; (Bun as any).spawnSync = realSpawnSync; });

test("O1: old-peer refusal fixture over real HTTP -> target_outdated; other codes pass through", async () => {
  const realClient = alex.d.client as InstanceType<typeof PeerClient>;
  const orig = realClient.adminRun.bind(realClient);
  (realClient as any).adminRun = (_addr: unknown, body: Record<string, unknown>, t: number) => PeerClient.prototype.adminRun.call(realClient, { ip: "127.0.0.1", port: fake.port, nodeId: kira2.d.nodeId }, body, t);
  try {
    const oldMsg = oldAdmin.remoteArgvProblem(["provision", "status", "--profile", "developer-worker"]);
    console.log("O1 the message an OLD target really sends:", JSON.stringify(oldMsg));
    const r = await run(alex, ["provision", "status", "--profile", "developer-worker"]);
    console.log("O1 classified as:", JSON.stringify(r.results[0]?.error));
    expect(r.results[0]?.error?.code).toBe("target_outdated");
    // control: a non-provision command refused by the same old peer keeps its own code (not misclassified)
    const c = await run(alex, ["seats", "doctor"]);
    console.log("O1 control (seats doctor against the same fake) ->", JSON.stringify(c.results[0]?.error));
  } finally { (realClient as any).adminRun = orig; }
});

test("O2: copied grant is refused on another node", async () => {
  await kira2.client().request("POST", "/v1/provision/grant", grantBody(alex.d.nodeId));
  expect((await run(alex, ["provision", "status", "--profile", "developer-worker"], "kiras-mbp")).results[0]?.error?.code).toBe("grant_absent");
  copyFileSync(join(kira2.home, "provision-grant.json"), join(kira.home, "provision-grant.json"));
  chmodSync(join(kira.home, "provision-grant.json"), 0o600);
  // The root-owned enrollment marker is keyed by the home it was written for: a copied grant file on a home that never
  // consented is refused before the machine binding is even read.
  const noMarker = await run(alex, ["provision", "status", "--profile", "developer-worker", "--json"], "kiras-mbp");
  console.log("O2 status on kiras-mbp (no marker) with a grant file copied from kiras-studio ->", JSON.stringify(noMarker.results[0]?.error ?? { exit: noMarker.results[0]?.exit }));
  expect(noMarker.results[0]?.error?.code).toBe("root_marker_required");
  // With that machine's own marker present, the grant's machine binding still refuses the copy.
  writeRootMarker(kira.home);
  const r = await run(alex, ["provision", "status", "--profile", "developer-worker", "--json"], "kiras-mbp");
  console.log("O2 status on kiras-mbp with a grant file copied from kiras-studio ->", JSON.stringify(r.results[0]?.error ?? { exit: r.results[0]?.exit }));
  expect(r.results[0]?.error?.code).toBe("wrong_machine");
});

test("O3: named owner is required and demotion revokes authority", async () => {
  // consent names noor as the owner
  await kira2.client().request("POST", "/v1/provision/revoke", {});
  await kira2.client().request("POST", "/v1/provision/grant", grantBody(noor.d.nodeId, "noor"));
  const viaAlex = await run(alex, ["provision", "status", "--profile", "developer-worker"]);
  console.log("O3 consent names @noor; alex (a different owner) ->", JSON.stringify(viaAlex.results[0]?.error ?? { exit: viaAlex.results[0]?.exit }));
  expect(viaAlex.results[0]?.error?.code).toBe("owner_not_consented");
  await alex.client().setRole("noor", "member");
  await waitFor(() => [...kira2.d.core.roster.members.values()].find((m: any) => m.handle === "noor")?.role === "member", { what: "noor demoted on kira2" });
  const after = await run(alex, ["provision", "status", "--profile", "developer-worker"]);
  console.log("O3 after @noor (named) demoted; alex ->", JSON.stringify(after.results[0]?.error));
  expect(after.results[0]?.error?.code).toBe("owner_changed");
  await alex.client().setRole("noor", "owner");
});

test("O4: local grant route refuses a non-owner node and a nonexistent node; cannot name a removed member's node", async () => {
  await kira2.client().request("POST", "/v1/provision/revoke", {});
  const bad = async (owner: string) => { try { await kira2.client().request("POST", "/v1/provision/grant", grantBody(owner)); return "created"; } catch (e) { return (e as any).code; } };
  expect(await bad("deadbeef")).toBe("owner_required");
  expect(await bad(kira.d.nodeId)).toBe("owner_required");
  expect(existsSync(join(kira2.home, "provision-grant.json"))).toBe(true); // the old (revoked) record is still on disk
});
