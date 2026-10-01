// WALKIE-ADD-MACHINE-1 scope addition (Alex: "this should all be handled by the sign up link"): `walkie setup` asks
// once whether the team may start agents (seats) on this machine. Tested: feature detection (a daemon without seats,
// including this real build, is never asked), the consent path (yes → runtimes checked, one sudo step through the
// seats lane's `seats setup-user --apply`, then POST /v1/seats/config allow), no/decline, the flags, the no-terminal
// default (no), and that an agent's terminal is never asked: it applies the flag it was given while agent admin is on
// (the company-machine consent is the person's alone).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WalkieClient } from "../../src/client/index.ts";
import { parseArgs, UsageError } from "../../src/cli/args.ts";
import type { Ctx } from "../../src/cli/context.ts";
import { TEAM_AGENTS_QUESTION, companyConsentText, readSavedGrant, teamAgentsQuestion, seatsSupported, teamAgentsStep, type RuntimeCheck, type SeatsLocal, type TeamAgentsDeps } from "../../src/cli/commands/team-agents.ts";
import { fakeDaemon, type FakeDaemon } from "../helpers/fake-daemon.ts";
import { Cluster, type TestNode } from "../helpers/cluster.ts";
import { PROFILES } from "../../src/daemon/provision/profiles.ts";

const BOOLEANS = new Set(["allow-team-agents", "no-team-agents", "for-agent", "seat-users", "same-user", "company-machine"]);
const DEVELOPER_PROFILE = { id: "developer-worker" as const, version: PROFILES["developer-worker"].version };
const ME = { team: { id: "t", name: "acme" }, handle: "arvid", role: "member", node: { id: "recipient-node", hostname: "arvid-mac" } };

function ctxOf(argv: string[], opts: { forAgent?: boolean } = {}): Ctx & { lines: string[] } {
  const lines: string[] = [];
  const args = parseArgs(argv, BOOLEANS);
  const forAgent = opts.forAgent ?? args.flags.get("for-agent") === true;
  return {
    args, json: false, forAgent, agentMarker: () => (forAgent ? "CLAUDECODE is set in its environment" : null), lines,
    client: () => { throw new Error("unused"); }, out: (s) => lines.push(s), err: (s) => lines.push(s),
  };
}

function deps(over: Partial<TeamAgentsDeps> & { answers?: string[] } = {}) {
  const calls = { asked: [] as string[], checked: [] as string[], sudo: 0 };
  const answers = [...(over.answers ?? [])];
  const d: TeamAgentsDeps = {
    interactive: over.interactive ?? true,
    ask: async (q) => { calls.asked.push(q); return answers.shift() ?? ""; },
    checkRuntime: over.checkRuntime ?? (async (n): Promise<RuntimeCheck> => { calls.checked.push(n); return { installed: true, loggedIn: true }; }),
    installSeatUsers: over.installSeatUsers ?? (async () => { calls.sudo++; return true; }),
    readGrant: over.readGrant,
  };
  return { d, calls };
}

let seatsDaemon: FakeDaemon;
let local: SeatsLocal;
beforeAll(() => {
  local = { allow: true, ephemeral: false, claude_login: "machine" };
  seatsDaemon = fakeDaemon({
    "GET /v1/me": ME,
    "GET /v1/seats": { local: { allow: false }, hosts: [], seats: [] },
    "POST /v1/seats/config": { get local() { return local; } },
  });
});
afterAll(() => seatsDaemon.stop());

const client = () => new WalkieClient({ socket: seatsDaemon.socket, timeoutMs: 5_000 });
const configPosts = () => seatsDaemon.requests.filter((r) => r.method === "POST" && r.path === "/v1/seats/config");
const run = async (argv: string[], d: TeamAgentsDeps, opts: { forAgent?: boolean } = {}) => {
  const ctx = ctxOf(argv, opts);
  let headings = 0;
  const before = configPosts().length;
  const outcome = await teamAgentsStep(ctx, client(), d, () => { headings++; });
  return { outcome, out: ctx.lines.join("\n"), headings, posted: configPosts().slice(before).map((r) => r.body) };
};

function conflictingGrantDaemon() {
  const dir = mkdtempSync(join(import.meta.dir, ".grant-conflict-"));
  const posts: string[] = [];
  const socket = join(dir, "walkie.sock");
  const server = Bun.serve({ unix: socket, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.method === "POST") posts.push(path);
    if (path === "/v1/me") return Response.json(ME);
    if (path === "/v1/team") return Response.json({ members: [{ handle: "alex", role: "owner" }],
      nodes: [{ node_id: "owner-node", handle: "alex" }], authority: "owner-node", channels: [] });
    if (path === "/v1/seats" && req.method === "GET") return Response.json({ local: { allow: false } });
    if (path === "/v1/provision/grant") return Response.json({ error: { code: "grant_exists", message: "active grant" } }, { status: 409 });
    if (path === "/v1/seats/config") return Response.json({ local: { allow: true, same_user: true } });
    return Response.json({ error: { code: "not_found", message: path } }, { status: 404 });
  } });
  return { socket, posts, stop: () => { server.stop(true); rmSync(dir, { recursive: true, force: true }); } };
}

function currentGrant() {
  const now = Date.now();
  return { team_id: "t", target_node: "recipient-node", recipient: "arvid", owner_node: "owner-node",
    launchers: ["@alex"], seat_cap: 4, profiles: [DEVELOPER_PROFILE],
    company_mode: true, consent_version: 1, consent_text: companyConsentText("alex", ["@alex"], 4),
    created_at: now - 1000, expires_at: now + 60_000 };
}

test("company setup resumes seats after grant_exists only for the identical current grant", async () => {
  const daemon = conflictingGrantDaemon();
  try {
    const d = deps({ answers: ["yes"], readGrant: async () => currentGrant() });
    const ctx = ctxOf(["--company-machine"]);
    expect(await teamAgentsStep(ctx, new WalkieClient({ socket: daemon.socket }), d.d, () => undefined)).toBe("allowed");
    expect(daemon.posts).toEqual(["/v1/provision/grant", "/v1/seats/config"]);
  } finally { daemon.stop(); }
});

test("company setup refuses changed, expired or revoked grants on retry without enabling seats", async () => {
  const base = currentGrant();
  for (const changed of [
    { owner_node: "other-owner" }, { target_node: "other-machine" }, { team_id: "other-team" },
    { recipient: "other-person" }, { consent_version: 2 },
    { consent_text: "changed" }, { profiles: [{ id: "freight-worker", version: PROFILES["freight-worker"].version }] },
    { launchers: ["@another"] }, { seat_cap: 5 }, { expires_at: Date.now() - 1 },
    { revoked_at: Date.now() },
  ]) {
    const daemon = conflictingGrantDaemon();
    try {
      const d = deps({ answers: ["yes"], readGrant: async () => ({ ...base, ...changed }) });
      const ctx = ctxOf(["--company-machine"]);
      expect(await teamAgentsStep(ctx, new WalkieClient({ socket: daemon.socket }), d.d, () => undefined)).toBe("refused");
      expect(ctx.lines.join("\n")).toContain("different or expired provisioning grant");
      expect(daemon.posts).toEqual(["/v1/provision/grant"]);
    } finally { daemon.stop(); }
  }
});

test("company retry reads only a private regular grant receipt", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".grant-file-"));
  const path = join(dir, "provision-grant.json");
  try {
    const grant = currentGrant();
    writeFileSync(path, JSON.stringify(grant), { mode: 0o600 });
    expect(await readSavedGrant(dir)).toEqual(grant);
    chmodSync(path, 0o644);
    expect(await readSavedGrant(dir)).toBeNull();
    rmSync(path);
    writeFileSync(join(dir, "target"), JSON.stringify(currentGrant()), { mode: 0o600 });
    symlinkSync(join(dir, "target"), path);
    await expect(readSavedGrant(dir)).rejects.toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("company enrollment asks once and configures named owner launchers as same-user without sudo or recipient login", async () => {
  const company = fakeDaemon({
    "GET /v1/me": ME,
    "GET /v1/team": { members: [{ handle: "alex", role: "owner" }], nodes: [{ node_id: "owner-node", handle: "alex" }], authority: "owner-node", channels: [] },
    "GET /v1/seats": { local: { allow: false }, hosts: [], seats: [] },
    "POST /v1/provision/grant": { team_id: "t", company_mode: true },
    "POST /v1/seats/config": { local: { allow: true, same_user: true, max: 4, launchers: ["@alex"] } },
  });
  try {
    const approved = deps({ answers: ["yes"] });
    const ctx = ctxOf(["--company-machine"]);
    const outcome = await teamAgentsStep(ctx, new WalkieClient({ socket: company.socket }), approved.d, () => undefined);
    expect(outcome).toBe("allowed");
    expect(approved.calls.asked).toHaveLength(1);
    expect(approved.calls.asked[0]).toContain("read and change files and keys");
    expect(approved.calls.sudo).toBe(0);
    expect(approved.calls.checked).toEqual([]);
    const post = company.requests.find((r) => r.method === "POST" && r.path === "/v1/seats/config");
    expect(post?.body).toEqual({ allow: true, same_user: true, ephemeral: false, mode: "same_user", launchers: ["@alex"], max: 4 });
    const grant = company.requests.find((r) => r.method === "POST" && r.path === "/v1/provision/grant");
    // Provision lane's GrantReq/consentText contract: the exact displayed text, version and typed yes.
    expect(grant?.body).toEqual({ owner_node: "owner-node", launchers: ["@alex"], seat_cap: 4,
      profiles: [DEVELOPER_PROFILE], company_mode: true, consent_version: 1,
      consent_text: companyConsentText("alex", ["@alex"], 4), consented: true,
      confirmation: { surface: "cli", typed_phrase: "yes" } });
    expect(approved.calls.asked[0]).toBe(`${(grant?.body as { consent_text: string }).consent_text} (type yes/N)`);
    const denied = deps();
    const flag = ctxOf(["--company-machine", "--allow-team-agents"]);
    expect(await teamAgentsStep(flag, new WalkieClient({ socket: company.socket }), denied.d, () => undefined)).toBe("refused");
    expect(denied.calls.asked).toEqual([]);
    const before = company.requests.filter((r) => r.method === "POST").length;
    // An agent never gives this consent either, with agent admin on (no config.json: on) or with the flag: nothing is asked or posted.
    const home = mkdtempSync("/tmp/walkie-ta-co-");
    const prevHome = process.env.WALKIE_HOME;
    process.env.WALKIE_HOME = home;
    try {
      for (const argv of [["--company-machine"], ["--company-machine", "--allow-team-agents"]]) {
        const byAgent = deps({ answers: ["yes"] });
        expect([argv.join(" "), await teamAgentsStep(ctxOf(argv, { forAgent: true }), new WalkieClient({ socket: company.socket }), byAgent.d, () => undefined), byAgent.calls.asked.length])
          .toEqual([argv.join(" "), "refused", 0]);
      }
    } finally {
      if (prevHome === undefined) delete process.env.WALKIE_HOME; else process.env.WALKIE_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
    expect(company.requests.filter((r) => r.method === "POST")).toHaveLength(before);
    expect(await teamAgentsStep(ctxOf(["--company-machine"]), new WalkieClient({ socket: company.socket }),
      deps({ answers: ["y"] }).d, () => undefined)).toBe("declined");
    expect(company.requests.filter((r) => r.method === "POST")).toHaveLength(before);
  } finally { company.stop(); }
});

test("company setup refuses to flip an existing seat-user machine without migration", async () => {
  const old = fakeDaemon({
    "GET /v1/me": ME,
    "GET /v1/seats": { local: { allow: true, ephemeral: true, same_user: false }, hosts: [], seats: [] },
  });
  try {
    const d = deps({ answers: ["yes"] });
    const ctx = ctxOf(["--company-machine"]);
    expect(await teamAgentsStep(ctx, new WalkieClient({ socket: old.socket }), d.d, () => undefined)).toBe("refused");
    expect(ctx.lines.join("\n")).toContain("migration preflight");
    expect(d.calls.asked).toEqual([]);
    expect(old.requests.some((r) => r.method === "POST")).toBe(false);
  } finally { old.stop(); }
});

test("company setup leaves seats off when the provisioning grant route is unavailable", async () => {
  const old = fakeDaemon({
    "GET /v1/me": ME,
    "GET /v1/seats": { local: { allow: false }, hosts: [], seats: [] },
    "GET /v1/team": { members: [{ handle: "alex", role: "owner" }], nodes: [{ node_id: "owner-node", handle: "alex" }], authority: "owner-node", channels: [] },
  });
  try {
    const d = deps({ answers: ["yes"] });
    const ctx = ctxOf(["--company-machine"]);
    expect(await teamAgentsStep(ctx, new WalkieClient({ socket: old.socket }), d.d, () => undefined)).toBe("incomplete");
    expect(ctx.lines.join("\n")).toContain("company seats stay off");
    expect(old.requests.some((r) => r.method === "POST" && r.path === "/v1/seats/config")).toBe(false);
  } finally { old.stop(); }
});

describe("feature detection", () => {
  let c: Cluster;
  let node: TestNode;
  beforeAll(async () => {
    c = new Cluster();
    node = await c.add({ name: "solo", login: "-", hostname: "solo-mbp", direct: true });
    await node.client().init("acme", "solo");
  }, 20_000);
  afterAll(async () => { await c.close(); });

  test("this build's real daemon hosts seats (SEATS-PRE3): GET /v1/seats answers", async () => {
    expect(await seatsSupported(node.client())).toBe(true);
  });
  test("a daemon without seats (an older build: no /v1/seats) is skipped without a word or a question", async () => {
    const old = fakeDaemon({ "GET /v1/me": ME }); // no seats routes: 404
    try {
      const { d, calls } = deps({ answers: ["y"] });
      const ctx = ctxOf([]);
      let headings = 0;
      expect(await teamAgentsStep(ctx, new WalkieClient({ socket: old.socket }), d, () => { headings++; })).toBe("unsupported");
      expect([headings, ctx.lines, calls.asked, calls.sudo]).toEqual([0, [], [], 0]);
      const flagged = deps();
      const ctx2 = ctxOf(["--allow-team-agents"]);
      expect(await teamAgentsStep(ctx2, new WalkieClient({ socket: old.socket }), flagged.d, () => undefined)).toBe("unsupported");
      expect(ctx2.lines.join("\n")).toContain("can't host team agents yet: --allow-team-agents ignored");
      expect(flagged.calls.sudo).toBe(0);
    } finally { old.stop(); }
  });
  test("a daemon with seats answers GET /v1/seats", async () => {
    expect(await seatsSupported(client())).toBe(true);
  });
  test("401/403 from /v1/seats is 'not available', not an error that stops setup", async () => {
    for (const status of [401, 403]) {
      const dir = `/tmp/walkie-seats-${status}-${process.pid}`;
      const { mkdirSync, rmSync } = await import("node:fs");
      mkdirSync(dir, { recursive: true });
      const server = Bun.serve({ unix: `${dir}/s.sock`, fetch: () => Response.json({ error: { code: "forbidden", message: "no" } }, { status }) });
      try {
        expect(await seatsSupported(new WalkieClient({ socket: `${dir}/s.sock` }))).toBe(false);
      } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
    }
  });
});

describe("the consent question", () => {
  test("asked once, in plain words; yes → runtimes checked, same-user seats allowed without sudo", async () => {
    const { d, calls } = deps({ answers: ["y"] });
    const r = await run([], d);
    expect(r.outcome).toBe("allowed");
    expect(calls.asked).toEqual([`${TEAM_AGENTS_QUESTION} (y/N)`]);
    expect(TEAM_AGENTS_QUESTION).toContain("as your OS user");
    expect(TEAM_AGENTS_QUESTION).toContain("this machine's own Claude/Codex login");
    expect(TEAM_AGENTS_QUESTION).toContain("walkie seats deny");
    expect(teamAgentsQuestion("dedicated")).toContain("token set for seats only; a running seat can read it");
    expect(teamAgentsQuestion("machine", true)).toContain("as separate OS users");
    expect(teamAgentsQuestion("dedicated")).not.toContain("machine's short-lived Claude access token");
    expect(calls.checked).toEqual(["claude", "codex"]);
    expect(calls.sudo).toBe(0);
    expect(r.posted).toEqual([{ allow: true, same_user: true, ephemeral: false }]);
    expect(r.out).toContain("without a sudo step");
    expect(r.out).toContain("team agents on");
    expect(r.out).toContain("Off any time: walkie seats deny");
    expect(r.headings).toBe(1);
  });
  test("anything but y/yes is no (the default): nothing is set up or allowed", async () => {
    for (const a of ["", "n", "no", "maybe", "yess"]) {
      const { d, calls } = deps({ answers: [a] });
      const r = await run([], d);
      expect(r.outcome).toBe("declined");
      expect([calls.sudo, r.posted]).toEqual([0, []]);
      expect(r.out).toContain("walkie seats enable");
    }
  });
  test("no terminal and no flag: not asked, default no", async () => {
    const { d, calls } = deps({ interactive: false, answers: ["y"] });
    const r = await run([], d);
    expect(r.outcome).toBe("declined");
    expect([calls.asked, calls.sudo, r.posted]).toEqual([[], 0, []]);
    expect(r.out).toContain("no terminal to ask; --allow-team-agents turns them on");
  });
  test("--allow-team-agents / --no-team-agents answer without asking (non-interactive installs)", async () => {
    const yes = deps({ interactive: false });
    const r1 = await run(["--allow-team-agents"], yes.d);
    expect([r1.outcome, yes.calls.asked.length, yes.calls.sudo, r1.posted]).toEqual(["allowed", 0, 0, [{ allow: true, same_user: true, ephemeral: false }]]);
    const no = deps({ interactive: true, answers: ["y"] });
    const r2 = await run(["--no-team-agents"], no.d);
    expect([r2.outcome, no.calls.asked.length, no.calls.sudo, r2.posted]).toEqual(["declined", 0, 0, []]);
    await expect(run(["--allow-team-agents", "--no-team-agents"], deps().d)).rejects.toBeInstanceOf(UsageError);
  });
  test("--seat-users is honoured during unattended setup and requires explicit consent", async () => {
    const x = deps({ interactive: false });
    const r = await run(["--allow-team-agents", "--seat-users"], x.d);
    expect(r.posted).toEqual([{ allow: true, mode: "seat_users", same_user: false, ephemeral: true }]);
    expect(x.calls.sudo).toBe(1);
    await expect(run(["--seat-users"], deps().d)).rejects.toBeInstanceOf(UsageError);
  });
  test("AGENT-ADMIN-1: an agent's terminal is never asked; it applies the flag it was given (and not while agent admin is off)", async () => {
    const home = mkdtempSync("/tmp/walkie-ta-");
    const prev = process.env.WALKIE_HOME;
    process.env.WALKIE_HOME = home;
    try {
      const asked = deps({ answers: ["y"] });
      const r = await run([], asked.d, { forAgent: true });
      expect([r.outcome, asked.calls.asked.length, asked.calls.sudo, r.posted]).toEqual(["declined", 0, 0, []]);
      const yes = deps();
      const on = await run(["--allow-team-agents"], yes.d, { forAgent: true });
      expect([on.outcome, yes.calls.asked.length, yes.calls.sudo, on.posted]).toEqual(["allowed", 0, 0, [{ allow: true, same_user: true, ephemeral: false }]]);
      const no = deps({ answers: ["y"] });
      const declined = await run(["--no-team-agents"], no.d, { forAgent: true });
      expect([declined.outcome, no.calls.asked.length, declined.posted]).toEqual(["declined", 0, []]);
      writeFileSync(join(home, "config.json"), JSON.stringify({ agent_admin: false }));
      const before = configPosts().length;
      const off = await run(["--allow-team-agents"], deps().d, { forAgent: true });
      expect([off.outcome, off.out.includes("agent admin is off"), configPosts().length]).toEqual(["refused", true, before]);
      // Declining needs no permission: with agent admin off, --no-team-agents still just declines (nothing posted).
      const offNo = await run(["--no-team-agents"], deps().d, { forAgent: true });
      expect([offNo.outcome, offNo.posted]).toEqual(["declined", []]);
    } finally {
      if (prev === undefined) delete process.env.WALKIE_HOME; else process.env.WALKIE_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

test("walkie setup refuses both flags at once before touching anything (the real CLI)", async () => {
  const p = Bun.spawn([process.execPath, `${import.meta.dir}/../../src/cli/main.ts`, "setup", "--allow-team-agents", "--no-team-agents"], {
    env: { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: "/nonexistent/walkie-home", WALKIE_SOCKET: "/nonexistent/walkie.sock" },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect([code, out]).toEqual([1, ""]);
  expect(err).toContain("--allow-team-agents and --no-team-agents are exclusive");
});

describe("after yes", () => {
  test("company mode does not call seat-user setup, even when the helper is unavailable", async () => {
    const { d } = deps({ answers: ["yes"], installSeatUsers: async () => false });
    const r = await run([], d);
    expect(r.outcome).toBe("allowed");
    expect(r.posted).toEqual([{ allow: true, same_user: true, ephemeral: false }]);
  });
  test("the switch failing prints the finish step and setup continues", async () => {
    const d = fakeDaemon({ "GET /v1/me": ME, "GET /v1/seats": { local: { allow: false } } }); // no POST route: 404
    try {
      const x = deps({ answers: ["y"] });
      const ctx = ctxOf([]);
      expect(await teamAgentsStep(ctx, new WalkieClient({ socket: d.socket }), x.d, () => undefined)).toBe("incomplete");
      expect(x.calls.sudo).toBe(0);
      expect(ctx.lines.join("\n")).toContain("team agents couldn't be turned on");
      expect(ctx.lines.join("\n")).toContain("Finish it: walkie seats enable");
    } finally { d.stop(); }
  });
  test("a missing or signed-out runtime gets its exact one-line sign-in step", async () => {
    const checks: Record<string, RuntimeCheck> = { claude: { installed: true, loggedIn: false }, codex: { installed: true, loggedIn: false } };
    const { d } = deps({ answers: ["y"], checkRuntime: async (n) => checks[n] as RuntimeCheck });
    const r = await run([], d);
    expect(r.out).toContain("claude: not signed in. Run: claude auth login");
    expect(r.out).toContain("codex: not signed in. Run: codex login");
    expect(r.out).toContain("no signed-in Claude Code or Codex yet");
    const none = deps({ answers: ["y"], checkRuntime: async () => ({ installed: false, loggedIn: null }) });
    const r2 = await run([], none.d);
    expect(r2.out).toContain("claude: not installed. Install Claude Code (https://claude.com/claude-code), then run: claude auth login");
    expect(r2.out).not.toContain("codex:"); // codex is optional: only checked when present
  });
  test("seats' Claude login unavailable (Keychain) → the exact token step; a disabled reason is shown", async () => {
    local = { allow: true, ephemeral: true, claude_login: "unavailable", disabled_reason: "your home /Users/arvid can be read by other users: chmod 700 /Users/arvid" };
    try {
      const r = await run([], deps({ answers: ["y"] }).d);
      expect(r.out).toContain("claude setup-token, then walkie seats token set");
      expect(r.out).toContain("they don't run yet: your home /Users/arvid can be read by other users");
    } finally {
      local = { allow: true, ephemeral: true, claude_login: "machine" };
    }
  });
  test("observers are never asked (they can't host seats)", async () => {
    const d = fakeDaemon({ "GET /v1/me": { ...ME, role: "observer" }, "GET /v1/seats": { local: { allow: false } } });
    try {
      const x = deps({ answers: ["y"] });
      const ctx = ctxOf([]);
      expect(await teamAgentsStep(ctx, new WalkieClient({ socket: d.socket }), x.d, () => undefined)).toBe("refused");
      expect(x.calls.asked).toEqual([]);
      expect(d.requests.some((q) => q.method === "POST")).toBe(false);
    } finally { d.stop(); }
  });
});
