import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type AdminRunResult, WalkieError } from "../../src/client/index.ts";
import { PeerCallError } from "../../src/daemon/peer-client.ts";
import { servePeerAdmin } from "../../src/daemon/admin/remote.ts";
import { nodeMember } from "../../src/daemon/roster.ts";
import { consentText } from "../../src/daemon/provision/consent.ts";
import { PROFILES } from "../../src/daemon/provision/profiles.ts";
import { Cluster, standardTeam, type TestNode } from "../helpers/cluster.ts";

setDefaultTimeout(60_000);
let cluster: Cluster;
let alex: TestNode;
let kira: TestNode;
let kira2: TestNode;
beforeAll(async () => { cluster = new Cluster(); ({ alex, kira, kira2 } = await standardTeam(cluster)); });
afterAll(async () => { await cluster.close(); });

const profile = { id: "developer-worker" as const, version: PROFILES["developer-worker"].version };
const run = (from: TestNode, argv: string[]) => from.client().adminRun({ machines: "kiras-studio", argv });
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as WalkieError; } throw new Error("expected refusal"); };

test("local grant requires person, admitted recipient, owner node and exact consent", async () => {
  const worker_accounts = { claude: `alex:${"a".repeat(24)}`, codex: `alex:${"b".repeat(24)}` };
  const body = { owner_node: alex.d.nodeId, launchers: ["@alex"], seat_cap: 3, profiles: [profile],
    worker_accounts,
    company_mode: true, consent_version: 1, consented: true,
    consent_text: consentText("alex", ["@alex"], 3, [profile], worker_accounts),
    confirmation: { surface: "desktop", typed_phrase: "yes" } };
  expect((await err(kira2.client().request("POST", "/v1/provision/grant", { ...body, confirmation: undefined }))).code).toBe("invalid");
  expect((await err(kira2.client().request("POST", "/v1/provision/grant", { ...body, confirmation: { surface: "desktop", accepted: true } }))).code).toBe("invalid");
  expect((await err(kira2.client().request("POST", "/v1/provision/grant", { ...body, confirmation: { surface: "desktop", typed_phrase: "YES" } }))).code).toBe("invalid");
  expect((await err(kira2.client().request("POST", "/v1/provision/grant", { ...body, consent_version: 2 }))).code).toBe("invalid");
  expect((await err(kira2.client("agent").request("POST", "/v1/provision/grant", body))).code).toBe("person_only");
  expect((await err(kira2.client().request("POST", "/v1/provision/grant", { ...body, consent_text: "yes" }))).code).toBe("invalid_consent");
  expect((await err(kira2.client().request("POST", "/v1/provision/grant", { ...body, worker_accounts: { claude: `kira:${"a".repeat(24)}` } }))).code).toBe("invalid_account");
  const grant = await kira2.client().request<{ recipient: string; target_node: string; created_at: number; expires_at: number }>("POST", "/v1/provision/grant", body);
  expect(grant.recipient).toBe("kira");
  expect(grant.target_node).toBe(kira2.d.nodeId);
  expect(grant.expires_at).toBeGreaterThan(Date.now());
  expect(grant.expires_at - grant.created_at).toBe(90 * 86400_000);
  expect((await kira2.client().provisionStatus("developer-worker")).profile).toBe("developer-worker");
  expect(statSync(join(kira2.home, "provision-grant.json")).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(kira2.home, "provision-grant.json"), "utf8")).not.toContain("token");
  expect((await err(kira2.client().provisionReset("developer-worker"))).code).toBe("profile_upgrade_required");
  const audit = readFileSync(join(kira2.home, "admin-audit.jsonl"), "utf8");
  expect(audit).toContain("approved enrollment grant");
  expect(audit).not.toContain("consent_text");
  expect((await err(kira2.client("agent").provisionApply("developer-worker"))).code).toBe("person_only");
  const forged = await fetch("http://walkie/v1/provision/apply", { method: "POST", unix: kira2.d.paths.socket,
    headers: { "Content-Type": "application/json", "X-Walkie-Admin-Token": "0".repeat(48) },
    body: JSON.stringify({ profile: "developer-worker" }) } as RequestInit);
  expect((await forged.json()).error.code).toBe("invalid_run_token");
  expect((await err(kira2.client("agent").request("POST", "/v1/provision/reset", { profile: "developer-worker" }))).code).toBe("person_only");
});

test("owner can read bounded status; absent, switched off and revoked grants refuse at target", async () => {
  const status = await run(alex, ["provision", "status", "--profile", "developer-worker", "--json"]);
  expect(status.results[0]?.exit).toBe(0);
  const equalsStatus = await run(alex, ["provision", "status", "--profile=developer-worker", "--json"]);
  expect(equalsStatus.results[0]?.exit).toBe(0);
  expect(JSON.parse(status.results[0]?.stdout ?? "{}").steps.length).toBeGreaterThan(0);
  const ownButUnlisted = await run(kira, ["provision", "status", "--profile", "developer-worker"]);
  expect(ownButUnlisted.results[0]?.error?.code).toBe("not_authorized");
  const absent = await alex.client().adminRun({ machines: "kiras-mbp", argv: ["provision", "status", "--profile", "developer-worker"] });
  expect(absent.results[0]?.error?.code).toBe("grant_absent");
  await kira2.client().adminSwitches({ remote_admin: false });
  expect((await run(alex, ["provision", "status", "--profile", "developer-worker"])).results[0]?.error?.code).toBe("remote_admin_off");
  await kira2.client().adminSwitches({ remote_admin: true });
  await kira2.client().adminSwitches({ agent_admin: false });
  expect((await run(alex, ["provision", "status", "--profile", "developer-worker"])).results[0]?.error?.code).toBe("agent_admin_off");
  await kira2.client().adminSwitches({ agent_admin: true });
  await kira2.client().request("POST", "/v1/provision/revoke", {});
  expect((await run(alex, ["provision", "status", "--profile", "developer-worker"])).results[0]?.error?.code).toBe("grant_revoked");
  expect((await run(alex, ["provision", "apply", "--profile", "developer-worker"])).results[0]?.error?.code).toBe("grant_revoked");
  expect(readFileSync(join(kira2.home, "admin-audit.jsonl"), "utf8")).toContain("grant_revoked");
  expect((await err(kira2.client("agent").provisionUnenroll())).code).toBe("person_only");
  expect((await err(kira2.client().provisionUnenroll())).code).toBe("person_only");
  const port = kira2.d.localPort as number;
  const { nonce } = await kira2.client().authNonce();
  const login = await fetch(`http://127.0.0.1:${port}/auth?nonce=${nonce}`, { redirect: "manual" });
  const session = /#s=([0-9a-f]{64})$/.exec(login.headers.get("location") ?? "")?.[1] ?? "";
  const loopback = await fetch(`http://127.0.0.1:${port}/v1/provision/unenroll`, { method: "POST", body: "{}",
    headers: { "X-Walkie-Session": session, Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" } });
  expect(loopback.status).toBe(403);
  expect(((await loopback.json()) as { error: { code: string } }).error.code).toBe("forbidden");
});

test("old target with admin/run but no provision verb is target_outdated", async () => {
  const old = alex.d.client.adminRun.bind(alex.d.client);
  alex.d.client.adminRun = async () => ({ machine: "kiras-studio", exit: 1, stdout: "", stderr: "walkie: unknown command \"provision\"", truncated: false, timed_out: false });
  try {
    const result: AdminRunResult = await run(alex, ["provision", "status", "--profile", "developer-worker"]);
    expect(result.results[0]?.error?.code).toBe("target_outdated");
    alex.d.client.adminRun = async () => { throw new PeerCallError(400, "not_allowed_remotely", "walkie provision can't run remotely"); };
    const refused = await run(alex, ["provision", "status", "--profile", "developer-worker"]);
    expect(refused.results[0]?.error?.code).toBe("target_outdated");
  } finally { alex.d.client.adminRun = old; }
});

test("refused remote provision records only verb and refusal code", async () => {
  const marker = "unrecognized-secret-value-XYZ";
  const owner = nodeMember(kira2.d.core.roster, alex.d.nodeId);
  expect(owner).not.toBeNull();
  try { await servePeerAdmin(kira2.d.core, alex.d.nodeId, owner!, { argv: ["provision", "apply", "--profile", "developer-worker", "--bad", marker] }); }
  catch (e) { expect((e as { code: string }).code).toBe("not_allowed_remotely"); }
  const audit = readFileSync(join(kira2.home, "admin-audit.jsonl"), "utf8");
  expect(audit).not.toContain(marker);
  expect(audit).toContain("provision refused: not_allowed_remotely");
});
