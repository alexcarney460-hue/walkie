// Adversarial probe P4: REAL executor code through the REAL remote-admin path, with fetch guarded to loopback (so the
// Node download is blocked) and spawnSync fully blocked; Bun.spawn only for the walkie CLI child. Nothing is installed.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const R = join(import.meta.dir, "../..");
setDefaultTimeout(120_000);
const blocked: string[] = [];
const fetchAttempts: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let host = ""; try { host = new URL(u).hostname; } catch { /* */ }
  if (init?.unix || host === "127.0.0.1" || host === "localhost") return realFetch(input, init);
  fetchAttempts.push(`${u} redirect=${init?.redirect}`);
  throw new Error(`STUB fetch blocked: ${u}`);
}) as never;
const realSpawn = Bun.spawn.bind(Bun);
const cliMain = `${R}/src/cli/main.ts`;
(Bun as any).spawn = (argv: any, opts: any) => {
  const a = Array.isArray(argv) ? argv : argv.cmd;
  if (a[0] === process.execPath && a[1] === cliMain) return realSpawn(argv, opts);
  blocked.push(`spawn ${JSON.stringify(a)}`); throw new Error(`STUB spawn blocked: ${JSON.stringify(a)}`);
};
const realSpawnSync = Bun.spawnSync.bind(Bun);
(Bun as any).spawnSync = (argv: any) => { const a = Array.isArray(argv) ? argv : argv.cmd; blocked.push(`spawnSync ${JSON.stringify(a)}`); throw new Error("STUB spawnSync blocked"); };

const { Cluster, standardTeam, waitFor } = await import(`${R}/test/helpers/cluster.ts`);
const { consentText } = await import(`${R}/src/daemon/provision/consent.ts`);
const { PROFILES } = await import(`${R}/src/daemon/provision/profiles.ts`);
type TestNode = any;
let cluster: any; let alex: TestNode, kira: TestNode, kira2: TestNode;
const profile = { id: "developer-worker" as const, version: PROFILES["developer-worker"].version };
const run = (from: TestNode, argv: string[], machines = "kiras-studio") => from.client().adminRun({ machines, argv });
const grantBody = (owner: string) => ({ owner_node: owner, launchers: ["@alex"], seat_cap: 3, profiles: [profile], company_mode: true as const, consent_version: 1, consented: true as const, confirmation: { surface: "desktop" as const, typed_phrase: "yes" as const }, consent_text: consentText("alex", ["@alex"], 3, [profile]) });
async function posts(n: TestNode) {
  const got = await n.client().events({ channel: "general", kinds: "msg.post", limit: 500 });
  return got.events.filter((e: any) => e.author.agent === "walkie-admin").map((e: any) => (e.body as { text: string }).text);
}

beforeAll(async () => {
  cluster = new Cluster();
  ({ alex, kira, kira2 } = await standardTeam(cluster));
  await waitFor(() => kira2.d.core.roster.members.size === 2 && alex.d.core.roster.nodes.size === 3, { what: "roster sync" });
});
afterAll(async () => {
  await cluster.close();
  console.log("P4 blocked spawns:", blocked.join(" | ") || "none", "| fetch attempts:", fetchAttempts.join(" | ") || "none");
  globalThis.fetch = realFetch; (Bun as any).spawn = realSpawn; (Bun as any).spawnSync = realSpawnSync;
});

test("W1: both profile flag forms work through remote admin", async () => {
  await kira2.client().request("POST", "/v1/provision/grant", grantBody(alex.d.nodeId));
  const eq = await run(alex, ["provision", "status", "--profile=developer-worker", "--json"]);
  const sp = await run(alex, ["provision", "status", "--profile", "developer-worker", "--json"]);
  console.log("W1 '--profile=developer-worker' ->", JSON.stringify(eq.results[0]?.error ?? { exit: eq.results[0]?.exit }));
  console.log("W1 '--profile developer-worker' ->", JSON.stringify(sp.results[0]?.error ?? { exit: sp.results[0]?.exit }));
  expect(sp.results[0]?.exit).toBe(0);
  expect(eq.results[0]?.exit).toBe(0);
});

test("W2: ambiguous profile argv is refused before target execution", async () => {
  await kira2.client().request("POST", "/v1/provision/revoke", {});
  const odd = await run(alex, ["provision", "apply", "--profile", "--json", "developer-worker"]).then(() => null, (e: { code: string }) => e.code);
  expect(odd).toBe("not_allowed_remotely");
  const clean = await run(alex, ["provision", "apply", "--profile", "developer-worker"]);
  console.log("W2 control (same state, canonical argv) ->", JSON.stringify(clean.results[0]?.error));
  const a = await posts(kira2);
  console.log("W2 #general tail:", JSON.stringify(a.slice(-3)));
  await kira2.client().request("POST", "/v1/provision/grant", grantBody(alex.d.nodeId));
});

test("W3: blocked network leaves a safe failure reason and installs nothing", async () => {
  const r = await run(alex, ["provision", "apply", "--profile", "developer-worker", "--json"]);
  const out = JSON.parse(r.results[0]?.stdout ?? "{}");
  console.log("W3 result:", r.results[0]?.exit, out.state, out.reason, "| steps:", out.journal?.steps?.map((s: any) => `${s.id}=${s.state}`).join(" "));
  const jf = readFileSync(join(kira2.home, "provision-developer-worker.json"), "utf8");
  console.log("W3 journal file:", jf.trim().slice(0, 400));
  console.log("W3 fetch attempts (all blocked):", fetchAttempts.join(" | "));
  console.log("W3 provision-tools exists:", existsSync(join(kira2.home, "provision-tools")), existsSync(join(kira2.home, "provision-tools")) ? readdirSync(join(kira2.home, "provision-tools")).join(",") : "");
  expect(out.state).toBe("failed");
  expect(out.reason).toBe("download_unavailable");
  expect(fetchAttempts.length).toBeGreaterThanOrEqual(1);
  expect(fetchAttempts.every((f) => /^https:\/\/nodejs\.org\/dist\/v22\.20\.0\/node-v22\.20\.0-(darwin|linux)-(arm64|x64)\.tar\.xz redirect=error$/.test(f))).toBe(true);
  expect(blocked.filter((b) => !b.includes("walkie-talkie") && !/provision-tools\/node-22\.20\.0\/bin\/node","--version"\]$/.test(b)).length).toBe(0);
  expect(jf).not.toMatch(/Error|blocked|stack|nodejs\.org/);
});
