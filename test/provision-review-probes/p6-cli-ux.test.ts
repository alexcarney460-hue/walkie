// Adversarial probe P6: the real `walkie provision ...` CLI against a TEST daemon (temp home), person vs agent-marked.
import { join } from "node:path";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
const R = join(import.meta.dir, "../..");
setDefaultTimeout(120_000);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let host = ""; try { host = new URL(u).hostname; } catch { /* */ }
  if (init?.unix || host === "127.0.0.1" || host === "localhost") return realFetch(input, init);
  throw new Error(`STUB fetch blocked: ${u}`);
}) as never;
const realSpawnSync = Bun.spawnSync.bind(Bun);
// The CLI children below are agent-detected through process ancestry (src/cli/agent-detect.ts, signal 2) when this test
// process runs under an agent runtime, even with a clean environment. Read that once, before spawnSync is stubbed.
const { agentAncestor, readProcessTable } = await import(`${R}/src/cli/agent-detect.ts`);
const underAgentRuntime = agentAncestor(readProcessTable(), process.pid) !== null;
(Bun as any).spawnSync = () => { throw new Error("STUB spawnSync blocked"); };
const { Cluster, standardTeam, waitFor } = await import(`${R}/test/helpers/cluster.ts`);
const { consentText } = await import(`${R}/src/daemon/provision/consent.ts`);
const { PROFILES } = await import(`${R}/src/daemon/provision/profiles.ts`);
let cluster: any; let alex: any, kira: any, kira2: any;
const profile = { id: "developer-worker" as const, version: PROFILES["developer-worker"].version };
async function cli(n: any, args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn([process.execPath, `${R}/src/cli/main.ts`, ...args], { env: { PATH: process.env.PATH ?? "", HOME: n.home, NO_COLOR: "1", WALKIE_HOME: n.home, WALKIE_SOCKET: n.socket, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out.trim().slice(0, 200), err: err.trim().slice(0, 200) };
}
beforeAll(async () => { cluster = new Cluster(); ({ alex, kira, kira2 } = await standardTeam(cluster)); await waitFor(() => kira2.d.core.roster.members.size === 2, { what: "sync" }); });
afterAll(async () => { await cluster.close(); globalThis.fetch = realFetch; (Bun as any).spawnSync = realSpawnSync; });

test("CLI grant refuses a noninteractive confirmation", async () => {
  const result = await cli(kira2, ["provision", "grant", "--owner-node", alex.d.nodeId, "--owner-handle", "alex",
    "--launchers", "@alex", "--seat-cap", "2", "--profile", "developer-worker"]);
  expect(result.code).toBe(1);
  expect(result.err).toContain("interactive terminal");
});

test("CLI surface: person vs agent, usage refusals, exit codes", async () => {
  const launchers = ["@alex", "@kira"];
  await kira2.client().request("POST", "/v1/provision/grant", { owner_node: alex.d.nodeId, launchers, seat_cap: 2, profiles: [profile], company_mode: true, consent_version: 1, consented: true, confirmation: { surface: "desktop", typed_phrase: "yes" }, consent_text: consentText("alex", launchers, 2, [profile]) });
  const rows: [string, Awaited<ReturnType<typeof cli>>][] = [];
  rows.push(["status (person, listed)", await cli(kira2, ["provision", "status", "--profile", "developer-worker", "--json"])]);
  rows.push(["status no --profile", await cli(kira2, ["provision", "status"])]);
  rows.push(["apply --profile custom", await cli(kira2, ["provision", "apply", "--profile", "custom"])]);
  rows.push(["apply --yes", await cli(kira2, ["provision", "apply", "--profile", "developer-worker", "--yes"])]);
  rows.push(["apply --profile x --url", await cli(kira2, ["provision", "apply", "--profile", "developer-worker", "--url", "https://evil.example/x.sh"])]);
  rows.push(["revoke extra", await cli(kira2, ["provision", "revoke", "extra"])]);
  rows.push(["--help", await cli(kira2, ["provision", "--help"])]);
  rows.push(["revoke as AGENT (CLAUDECODE=1)", await cli(kira2, ["provision", "revoke"], { CLAUDECODE: "1" })]);
  rows.push(["status as AGENT (CLAUDECODE=1, person listed)", await cli(kira2, ["provision", "status", "--profile", "developer-worker", "--json"], { CLAUDECODE: "1" })]);
  rows.push(["revoke as person", await cli(kira2, ["provision", "revoke"])]);
  rows.push(["status after revoke", await cli(kira2, ["provision", "status", "--profile", "developer-worker"])]);
  for (const [name, r] of rows) console.log(`CLI ${name.padEnd(46)} exit=${r.code} out=${JSON.stringify(r.out.slice(0, 90))} err=${JSON.stringify(r.err.slice(0, 120))}`);
  expect(rows[7]![1].err).toContain("person_only");
  if (underAgentRuntime) {
    // Under an agent runtime even the env-clean 'person' CLI is agent-detected via process ancestry, so status is refused and
    // 'revoke as person' is refused person_only: an honest-agent guard, not a boundary.
    expect(rows[0]![1].code).toBe(1);
    expect(rows[9]![1].err).toContain("person_only");
  } else {
    // From a person's own terminal (or CI) the same two commands are the person's: status answers and revoke goes through.
    expect(rows[0]![1].code).toBe(0);
    expect(rows[9]![1].code).toBe(0);
    expect(rows[9]![1].out).toContain("grant revoked");
    expect(rows[10]![1].err).toContain("grant_revoked");
  }
  expect([1, 2, 3, 4, 5, 6].every((i) => rows[i]![1].code === 1)).toBe(true);
});
