// Probe P7: a NAMED launcher who is a plain member on another person's machine (consent text: "the named launchers to provision this machine").
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
const realSpawn = Bun.spawn.bind(Bun);
(Bun as any).spawn = (argv: any, opts: any) => { const a = Array.isArray(argv) ? argv : argv.cmd; if (a[0] === process.execPath && a[1] === `${R}/src/cli/main.ts`) return realSpawn(argv, opts); throw new Error(`STUB spawn blocked: ${JSON.stringify(a)}`); };
const realSpawnSync = Bun.spawnSync.bind(Bun);
(Bun as any).spawnSync = () => { throw new Error("STUB spawnSync blocked"); };
const { Cluster, standardTeam, waitFor } = await import(`${R}/test/helpers/cluster.ts`);
const { consentText } = await import(`${R}/src/daemon/provision/consent.ts`);
const { PROFILES } = await import(`${R}/src/daemon/provision/profiles.ts`);
let cluster: any; let alex: any, kira: any, kira2: any, bob: any;
const profile = { id: "developer-worker" as const, version: PROFILES["developer-worker"].version };
beforeAll(async () => {
  cluster = new Cluster(); ({ alex, kira, kira2 } = await standardTeam(cluster));
  bob = await cluster.add({ name: "bob", login: "bob@example.com", hostname: "bobs-mbp" });
  await alex.client().invite("bob@example.com", "bob", "member");
  if (!(await bob.client().join(alex.peerAddr)).admitted) throw new Error("bob join");
  await waitFor(() => kira2.d.core.roster.nodes.size === 4 && bob.d.core.roster.nodes.size === 4, { what: "sync" });
});
afterAll(async () => { await cluster.close(); globalThis.fetch = realFetch; (Bun as any).spawn = realSpawn; (Bun as any).spawnSync = realSpawnSync; });
test("P7: '@bob' is a named launcher in the consent, but bob (member) is refused at the peer route before authorizeProvision", async () => {
  const launchers = ["@alex", "@bob"];
  await kira2.client().request("POST", "/v1/provision/grant", { owner_node: alex.d.nodeId, launchers, seat_cap: 2, profiles: [profile], company_mode: true, consent_version: 1, consented: true, confirmation: { surface: "desktop", typed_phrase: "yes" }, consent_text: consentText("alex", launchers, 2, [profile]) });
  const r = await bob.client().adminRun({ machines: "kiras-studio", argv: ["provision", "status", "--profile", "developer-worker"] });
  console.log("P7 bob (named launcher, member) ->", JSON.stringify(r.results[0]?.error));
  expect(r.results[0]?.error?.code).toBe("not_your_machine");
});
