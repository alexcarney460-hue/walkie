// AGENT-ADMIN-1: agents do Walkie's setup for their person (audited, with a person's kill switch), and owners (or a
// person's own machines) administer team machines remotely over Walkie through an allow-list.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WalkieClient, WalkieError, type AdminRunResult } from "../../src/client/index.ts";
import { PeerCallError } from "../../src/daemon/peer-client.ts";
import { remoteArgvProblem } from "../../src/protocol/admin.ts";
import { Cluster, standardTeam, waitFor, type TestNode } from "../helpers/cluster.ts";

setDefaultTimeout(60_000);

const CLI = join(import.meta.dir, "../../src/cli/main.ts");
let cluster: Cluster;
let alex: TestNode;
let kira: TestNode;
let kira2: TestNode;

beforeAll(async () => {
  cluster = new Cluster();
  ({ alex, kira, kira2 } = await standardTeam(cluster));
  await waitFor(() => kira2.d.core.roster.members.size === 2 && alex.d.core.roster.nodes.size === 3, { what: "roster sync" });
});
afterAll(async () => { await cluster.close(); });

const refused = async (p: Promise<unknown>): Promise<WalkieError> => {
  try { await p; } catch (e) { return e as WalkieError; }
  throw new Error("expected a refusal");
};
const named = (n: TestNode) => n.client("claude-3f9a");
const marked = (n: TestNode) => new WalkieClient({ socket: n.socket, underAgent: true, timeoutMs: 15_000 });

/** #general posts by the audit author on `n`, newest last. */
async function auditPosts(n: TestNode): Promise<{ text: string; mentions?: string[] }[]> {
  const got = await n.client().events({ channel: "general", kinds: "msg.post", limit: 200 });
  return got.events.filter((e) => e.author.agent === "walkie-admin").map((e) => e.body as { text: string; mentions?: string[] });
}

/** The real CLI against `n`, as an agent (CLAUDECODE=1) unless `env` says otherwise. */
async function cli(n: TestNode, args: string[], env: Record<string, string> = { CLAUDECODE: "1" }): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn([process.execPath, CLI, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: n.home, NO_COLOR: "1", WALKIE_HOME: n.home, WALKIE_SOCKET: n.socket, ...env },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

describe("local: an agent does its person's admin, audited", () => {
  test("invites and role changes pass for named and unnamed agents (invite codes and add-machine links too: same gate)", async () => {
    await named(alex).invite("bob@example.com", "bob", "member");
    await marked(alex).invite("bea@example.com", "bea", "member");
    // Invite codes and add-machine links pass the gate and then need Walkie Direct (not in this Tailscale cluster).
    expect((await refused(named(alex).inviteCode("bob", "member"))).code).toBe("direct_unavailable");
    expect((await refused(marked(alex).addMachine("kira"))).code).toBe("direct_unavailable");
    await named(alex).setRole("kira", "observer");
    await waitFor(() => [...alex.d.core.roster.members.values()].find((m) => m.handle === "kira")?.role === "observer", { what: "role" });
    await marked(alex).setRole("kira", "member");
    await waitFor(() => [...alex.d.core.roster.members.values()].find((m) => m.handle === "kira")?.role === "member", { what: "role back" });
  });

  test("each is posted to #general naming the agent (named, or its runtime), and logged on the machine", async () => {
    const posts = await auditPosts(alex);
    expect(posts.some((p) => p.text.includes("@alex/alex-mbp/claude-3f9a") && p.text.includes("invited bob@example.com as @bob"))).toBe(true);
    expect(posts.some((p) => /@alex\/alex-mbp\/[a-z-]+ \(unnamed\)/.test(p.text) && p.text.includes("made @kira member"))).toBe(true);
    const log = readFileSync(join(alex.home, "admin-audit.jsonl"), "utf8");
    expect(log).toContain("minted an add-machine link for @kira");
    const cliRun = await cli(alex, ["invite", "carol@example.com", "--handle", "carol", "--json"]);
    expect(cliRun.code).toBe(0);
    expect((await auditPosts(alex)).some((p) => p.text.includes("@alex/alex-mbp/claude-code (unnamed)") && p.text.includes("@carol"))).toBe(true);
  });

  test("still a person's: removing a member, another member's machine, the roster authority, a dashboard login, a phone pairing", async () => {
    for (const cl of [named, marked]) {
      expect((await refused(cl(alex).setRole("kira", "removed"))).code).toBe("person_only");
      expect((await refused(cl(alex).revokeNode("kiras-studio"))).code).toBe("person_only");
      expect((await refused(cl(alex).setAuthority("kiras-mbp"))).code).toBe("person_only");
      expect((await refused(cl(alex).authNonce())).code).toBe("person_only");
      expect((await refused(cl(alex).request("POST", "/v1/mobile/pair", {}))).code).toBe("person_only");
    }
    expect([...alex.d.core.roster.members.values()].find((m) => m.handle === "kira")?.role).toBe("member");
    const cliRemove = await cli(alex, ["team", "role", "kira", "removed"]);
    expect([cliRemove.code, cliRemove.err.includes("person_only")]).toEqual([1, true]);
  });

  test("the kill switch: an agent turns agent admin off, then is refused; only a person turns it back on", async () => {
    expect((await named(alex).adminSwitches({ agent_admin: false })).agent_admin).toBe(false);
    const off = await refused(named(alex).invite("dave@example.com", "dave", "member"));
    expect([off.status, off.code]).toEqual([403, "agent_admin_off"]);
    expect((await refused(marked(alex).addMachine("kira"))).code).toBe("agent_admin_off");
    expect((await refused(marked(alex).request("POST", "/v1/admin/audit", { action: "x" }))).code).toBe("agent_admin_off");
    expect((await refused(named(alex).adminSwitches({ agent_admin: true }))).code).toBe("person_only");
    const cliOn = await cli(alex, ["agents", "admin", "on"]);
    expect(cliOn.code).toBe(1);
    const cliOff = await cli(alex, ["invite", "erin@example.com", "--handle", "erin"]);
    expect([cliOff.code, cliOff.err.includes("agent_admin_off")]).toEqual([1, true]);
    // A person (no agent header) turns it back on.
    expect((await alex.client().adminSwitches({ agent_admin: true })).agent_admin).toBe(true);
    await named(alex).invite("dave@example.com", "dave", "member");
    expect((await auditPosts(alex)).some((p) => p.text.includes("turned agent admin off"))).toBe(true);
  });

  test("a CLI-only step's outcome (final review B): a done one is logged and posted, one that failed or was refused is logged on this machine only, with its reason", async () => {
    const entries = () => readFileSync(join(alex.home, "admin-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { action: string; refused?: string; via: string });
    const posts = async () => (await auditPosts(alex)).length;
    const before = await posts();
    await marked(alex).adminAudit("installed the Walkie hooks for grok (probe: done)");
    expect(entries().find((e) => e.action === "installed the Walkie hooks for grok (probe: done)")).not.toHaveProperty("refused");
    expect(await posts()).toBe(before + 1); // posted to #general like any admin action
    await marked(alex).adminAudit("tried to install the Walkie hooks for grok (probe: failed)", "failed: ~/.claude/settings.json is not valid JSON; no changes made");
    expect(entries().find((e) => e.action === "tried to install the Walkie hooks for grok (probe: failed)")).toMatchObject({ refused: "failed: ~/.claude/settings.json is not valid JSON; no changes made", via: "local" });
    expect(await posts()).toBe(before + 1); // a refusal is never posted
    // A person's request is not recorded at all; an unknown field is refused (the body is strict); an empty reason is not a reason.
    expect(await alex.client().adminAudit("probe: a person", "failed: x")).toEqual({ recorded: false });
    expect((await refused(marked(alex).request("POST", "/v1/admin/audit", { action: "x", other: 1 }))).status).toBe(400);
    expect((await refused(marked(alex).request("POST", "/v1/admin/audit", { action: "x", refused: "" }))).status).toBe(400);
    expect(entries().some((e) => e.action === "probe: a person")).toBe(false);
  });

  test("an older config.json without the switches reads as on (the upgrade migration)", async () => {
    const path = join(kira2.home, "config.json");
    const { agent_admin: _a, remote_admin: _r, ...older } = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify(older));
    expect(await kira2.client().admin()).toMatchObject({ agent_admin: true, remote_admin: true });
  });
});

describe("remote admin over Walkie", () => {
  const run = (from: TestNode, machines: string, argv: string[], agent = true): Promise<AdminRunResult> =>
    (agent ? named(from) : from.client()).adminRun({ machines, argv });

  test("a member administers their own other machine", async () => {
    const r = await run(kira, "kiras-studio", ["accounts", "vault", "--json"]);
    expect(r.ok).toBe(true);
    expect(r.results[0]?.machine).toBe("kiras-studio");
    expect(JSON.parse(r.results[0]?.stdout ?? "{}").accounts).toEqual([]);
  });

  test("a member can't administer another person's machine", async () => {
    const r = await run(kira, "alex-mbp", ["accounts", "vault", "--json"]);
    expect([r.ok, r.results[0]?.error?.code]).toEqual([false, "not_your_machine"]);
  });

  test("an owner's agent administers another person's machine; that person is notified by name", async () => {
    const r = await run(alex, "kiras-studio", ["hooks", "install", "all", "--dry-run"]);
    expect(r.results[0]?.error).toBeUndefined();
    expect(r.results[0]?.exit).toBe(0);
    const post = await waitFor(async () => (await auditPosts(kira)).find((p) => p.text.includes("@alex/alex-mbp/claude-3f9a (remote) on kiras-studio")), { what: "audit post" });
    expect(post.mentions).toEqual(["@kira"]);
    expect(post.text).toContain("walkie hooks install all --dry-run");
    expect(readFileSync(join(kira2.home, "admin-audit.jsonl"), "utf8")).toContain("@alex/alex-mbp/claude-3f9a");
  });

  test("the target's person switched remote admin off: refused, machine-readably", async () => {
    await kira2.client().adminSwitches({ remote_admin: false });
    const r = await run(alex, "kiras-studio", ["accounts", "vault"]);
    expect(r.results[0]?.error?.code).toBe("remote_admin_off");
    // Not remotely back on either: turning a switch on is never on the allow-list.
    const on = await refused(run(alex, "kiras-studio", ["admin", "remote", "on"]));
    expect(on.code).toBe("not_allowed_remotely");
    await kira2.client().adminSwitches({ remote_admin: true });
    expect((await run(alex, "kiras-studio", ["accounts", "vault"])).ok).toBe(true);
  });

  test("agent admin off on the target refuses remote admin too (it runs there as an agent)", async () => {
    await kira2.client().adminSwitches({ agent_admin: false });
    expect((await run(alex, "kiras-studio", ["accounts", "vault"], false)).results[0]?.error?.code).toBe("agent_admin_off");
    await kira2.client().adminSwitches({ agent_admin: true });
  });

  test("batch: all-mine runs on each of the caller's machines, including this one", async () => {
    const r = await run(kira, "all-mine", ["accounts", "vault", "--json"]);
    expect(r.results.map((x) => x.machine).sort()).toEqual(["kiras-mbp", "kiras-studio"]);
    expect(r.ok).toBe(true);
  });

  test("the machine list says what this caller may administer", async () => {
    kira.d.core.machineStats = { at: Date.now(), mem: { total: 16, used: 12, free: 4, swap_used: 0, pressure: "normal" }, temp_c: null,
      sys: { os: "darwin", arch: "arm64", cpus: 14, load1: 146, load5: 296, load15: 373, cpu_busy_pct: 91 } };
    kira.d.core.agentProcesses = [{ name: "claude-code", count: 22 }];
    const m = await kira.client().adminMachines();
    const byHost = Object.fromEntries(m.machines.map((x) => [x.hostname, x]));
    expect([byHost["kiras-studio"]?.can_admin, byHost["alex-mbp"]?.can_admin, byHost["kiras-mbp"]?.self]).toEqual([true, false, true]);
    expect(byHost["kiras-studio"]?.last_result).toBe("ok");
    expect(byHost["kiras-mbp"]?.stats?.agent_processes).toEqual([{ name: "claude-code", count: 22 }]);
    expect(byHost["kiras-mbp"]?.stats?.sys?.load15).toBe(373);
  });

  test("an older target (no /peer/v1/admin/run): target_outdated", async () => {
    const orig = alex.d.client.adminRun.bind(alex.d.client);
    alex.d.client.adminRun = async () => { throw new PeerCallError(404, "not_found", "not found"); };
    try {
      const r = await run(alex, "kiras-mbp", ["seats", "doctor"]);
      expect(r.results[0]?.error?.code).toBe("target_outdated");
      expect(r.results[0]?.error?.message).toContain("update it first");
    } finally {
      alex.d.client.adminRun = orig;
    }
  });

  test("never a shell: only allow-listed walkie commands, no stdin, switches only off", async () => {
    expect((await refused(run(alex, "kiras-studio", ["post", "#general", "hi"]))).code).toBe("not_allowed_remotely");
    expect(remoteArgvProblem(["agents", "admin", "on"])).toContain("only be turned off");
    expect(remoteArgvProblem(["seats", "enable", "--claude-token-stdin"])).toContain("--claude-token-stdin");
    expect(remoteArgvProblem(["orchestrator", "start", "--claude=/tmp/x"])).toContain("--claude");
    expect(remoteArgvProblem(["accounts", "exec", "--", "sh"])).toContain("can't run remotely");
    expect(remoteArgvProblem(["seats", "enable", "--yes", "--same-user", "--max", "12"])).toContain("cannot run remotely");
  });

  test("the CLI: walkie admin --machine … passes the command's own flags through; --json errors are machine-readable", async () => {
    const ok = await cli(kira, ["admin", "--machine", "kiras-studio", "--json", "accounts", "vault", "--json"]);
    expect(ok.code).toBe(0);
    expect((JSON.parse(ok.out) as AdminRunResult).results[0]?.exit).toBe(0);
    const no = await cli(kira, ["admin", "--machine", "alex-mbp", "--json", "seats", "doctor"]);
    expect(no.code).toBe(1);
    expect((JSON.parse(no.out) as AdminRunResult).results[0]?.error?.code).toBe("not_your_machine");
    const bad = await cli(kira, ["admin", "--machine", "kiras-studio", "--json", "post", "#general", "x"]);
    expect([bad.code, (JSON.parse(bad.out) as { error: { code: string } }).error.code]).toEqual([1, "not_allowed_remotely"]);
  });
});

describe("fix round 2: authorization at the target", () => {
  test("a non-owner's direct peer call to another person's machine is refused before its body matters", async () => {
    const alexNode = kira.d.core.roster.nodes.get(alex.d.nodeId);
    const addr = alexNode ? kira.d.client.addrOf(alexNode) : null;
    expect(addr).not.toBeNull();
    const e = await kira.d.client.adminRun(addr as NonNullable<typeof addr>, { argv: ["accounts", "vault"] }, 10_000).then(() => null, (x: PeerCallError) => x);
    expect([e?.status, e?.code]).toEqual([403, "not_your_machine"]);
  });

  test("stale authorization: a member record captured as owner, but the roster now says member, is refused at execution", async () => {
    const kiraMember = [...alex.d.core.roster.members.values()].find((m) => m.handle === "kira");
    expect(kiraMember?.role).toBe("member");
    const stale = { ...(kiraMember as NonNullable<typeof kiraMember>), role: "owner" as const };
    const { servePeerAdmin } = await import("../../src/daemon/admin/remote.ts");
    const e = await servePeerAdmin(alex.d.core, kira.d.nodeId, stale, { argv: ["accounts", "vault"] }).then(() => null, (x: WalkieError) => x as unknown as { status: number; code: string });
    expect([e?.status, e?.code]).toEqual([403, "not_your_machine"]);
    expect(readFileSync(join(alex.home, "admin-audit.jsonl"), "utf8")).toContain("\"refused\":\"not_your_machine\"");
  });
});

describe("round 3: a long run re-checks its caller", () => {
  test("a caller no longer authorized mid-run: the run's whole process group ends, reported as revoked", async () => {
    const { runAdminArgv } = await import("../../src/daemon/admin/remote.ts");
    let allowed = true;
    const t0 = Date.now();
    const pending = runAdminArgv(kira2.d.core, ["subscribe", "#general"], "@alex/alex-mbp/cc-1", "kira", 60, { authorized: () => allowed, recheckMs: 200 });
    await Bun.sleep(1_000);
    allowed = false;
    const r = await pending;
    expect([r.revoked, r.exit, r.timed_out]).toEqual([true, 125, false]);
    expect(r.stderr).toContain("may no longer administer this machine");
    expect(Date.now() - t0).toBeLessThan(15_000);
  });
});

describe("the upgrade notice", () => {
  test("posted once per machine after the upgrade, mentioning its person", async () => {
    await kira.stop();
    kira.spec.adminNotice = true;
    await kira.start();
    await kira.restart(); // the second start posts nothing more
    const notices = (await auditPosts(kira)).filter((p) => p.text.includes("Walkie update:") && p.text.includes("kiras-mbp"));
    expect(notices.length).toBe(1);
    expect(notices[0]?.mentions).toEqual(["@kira"]);
    expect(existsSync(join(kira.home, "admin-notice-v1"))).toBe(true);
  });
});
