// WALKIE-MISSION-1 fix round 6: the round-5 audits' findings (Codex r5, Opus r5) as regression tests.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionFiles } from "../../src/daemon/activity.ts";
import { AgentArchive } from "../../src/daemon/agent-archive.ts";
import type { Core } from "../../src/daemon/core.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { DEFAULT_LIMITS } from "../../src/daemon/ratelimit.ts";
import { MIGRATIONS, Store } from "../../src/daemon/store.ts";
import type { SyncManager } from "../../src/daemon/sync.ts";
import { redactSecrets } from "../../src/protocol/safety.ts";
import type { BodyOf, Event } from "../../src/protocol/schemas.ts";
import { projectStatus } from "../../src/protocol/status-projection.ts";
import { makeCore } from "../helpers/core.ts";
import { jl, ME, status, world } from "../helpers/discovery-world.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });
const onlineSync = { isOnline: () => true } as unknown as SyncManager;
const TICK = 15_000;
const DAY = 86_400_000;
const OFF = { prompts: false, activity: false };

function node(): { core: Core; clock: { t: number }; share(on: boolean): void } {
  const alex = tnode("alex");
  const { team, create } = createTeam(alex);
  const clock = { t: now() };
  const core = makeCore(alex, team, cleanups, { clock: () => clock.t, limits: { ...DEFAULT_LIMITS, status: { capacity: 100_000, perSecond: 100_000 } } });
  expect(core.ingest(create, "local").status).toBe("accepted");
  return { core, clock, share: (on) => writeFileSync(core.paths.config, JSON.stringify({ share_prompts: on })) };
}

// ---- 1. false positives ------------------------------------------------------------------------------------------------

/** Ordinary text that must come out unchanged (Opus m5-fp1 and the Codex r5 list). */
const ORDINARY = [
  "lane/checkout-to-invoice-1", "fix/ENG-4102-release-gate", "feature/ENG-4210-dashboard-1", "lane/pay-7ab-lows-1-f1",
  "claude/review-pay7ablows1f1-audit2-4810327", "acme-dashboard-1", "worktree-agent-b3c9d1e0f2a47586e", "dependabot/npm_and_yarn/next-15.2.3",
  "release/v0.2.0-pre.1", "users/sam/ENG-3920-deploy", "auth: fix login redirect after token refresh", "Session: resumed after the reboot",
  "docker run -p 8080:80 nginx", "mac 00:11:22:33:44:55", "claude-opus-5-5", "gpt-5.1-codex-max", "agent-1xob3", "cc-8bbc6a",
  "src/daemon/core.ts:821", "ops/notes/BACKLOG.md", "MERGE-4C-a-f2", "MAX_WORKERS=3", "MAP_TILES_ORIGIN=https://tiles.example.dev",
  "session: 4f2a9c1e-7b3d-4e8a-9c5f-1d2e3f4a5b6c", "pass=3 fail=0", "TOKEN_BUDGET=4000", "keyboard shortcuts for the auth page",
  "bun test test/unit/fix5.test.ts", "git push origin HEAD:refs/heads/acme-dashboard-1", "Fix5Test.testSomething_v2Runs",
  "staging.example.dev/api/v1/orders?id=123", "The session token expired so I re-ran login", "x-request-id: 9f8e7d6c5b4a",
  "reviewer1-batch5-r5", "v0.2.0-pre.1+build.20260926T1655Z", "2026-09-26T16:55:00Z", "ENG-5288/SEARCH-1/design", "feat/v2-USD-settlement",
  "e2e/Playwright-Chromium-v1.48", "commit 92a5fdc: fix(privacy): kebab names", "lane/checkout-to-invoice-1 on build-wsl",
  "design/style-guide.md", "~/workspace/app/.worktrees/checkout-to-invoice-1", "Password reset emails now send from noreply",
  "TypeError: Cannot read properties of undefined (reading 'token')", "Authorization header missing on /api/agents", "cookie banner copy",
  "passwordless login flow", "npm i @anthropic-ai/sdk@0.40.1", "python3 -m pytest tests/test_api_v2.py::TestAuth::test_token_refresh",
  "kubectl -n prod get pods", "ssh -p 2222 alex@host",
  // Codex r5 #5
  "release/v1.2.3-RC1.2.3", "Update SecretManagerV2AdapterV3Tests", "Tokens: 4096", "this.local.enablePending(id)",
  "feat: add password reset pages and account routes", "the Bearer insufficient_scope challenge",
];

describe("false positives (Opus r5 #1, Codex r5 #5)", () => {
  test.each(ORDINARY)("%s is left alone", (text) => {
    expect(redactSecrets(text).text).toBe(text);
  });

  test("repo and branch are names: never scanned for random-looking tokens; only URL userinfo is stripped", () => {
    const body = { agent: "a", state: "working" as const, runtime: "claude-code" as const, repo: "acme-billing-platform-20260921", branch: "fix/ALE-5156-OAuth2SAML2OIDC1-x7Kq9Zr2Lp" };
    expect(projectStatus(body, undefined, OFF)).toMatchObject({ repo: body.repo, branch: body.branch });
    expect(projectStatus({ ...body, repo: "https://alex:" + "hunter2@github.com/x/y" }, undefined, OFF).repo).toBe("y");
  });

  // The real corpus (4,069 branch names, 8,567 commit subjects of Alex's repositories) is not committed: it is private
  // project history. Point WALKIE_FP_CORPUS at a directory with branches.txt and subjects.txt to run it.
  const corpus = process.env.WALKIE_FP_CORPUS;
  test.skipIf(!corpus || !existsSync(join(corpus, "branches.txt")))("real branches: 0 changed; real commit subjects: < 0.1 %", () => {
    const read = (f: string) => readFileSync(join(corpus as string, f), "utf8").split("\n").filter(Boolean);
    const branches = read("branches.txt");
    expect(branches.filter((b) => redactSecrets(b).text !== b)).toEqual([]);
    const subjects = read("subjects.txt");
    const changed = subjects.filter((s) => redactSecrets(s).text !== s);
    expect(changed.length / subjects.length).toBeLessThan(0.001);
    for (const s of changed) expect(s).toMatch(/\bsk-[A-Za-z0-9-]{20,}/); // the only remaining ones: literal key fixtures
  });
});

// ---- 2. linear time ----------------------------------------------------------------------------------------------------

describe("linear-time redaction (Opus r5 #3, Codex r5 #6)", () => {
  test("400 KB single-line JSON < 200 ms; '-a-a-a…' 32 K < 50 ms; a 32 K flag word < 50 ms", () => {
    const json = JSON.stringify({ agents: Array.from({ length: 2_000 }, (_, i) => ({ id: `alex/mbp/cc-${i}`, status: { state: "working", title: `Task ${i} ALE-${i}`, branch: `feat/ALE-${i}-x`, session: "5eed0001-1111-4222-8333-944455556666" } })) }).slice(0, 400_000);
    const time = (s: string) => { const t0 = performance.now(); redactSecrets(s); return performance.now() - t0; };
    time("warm up");
    expect(time(json)).toBeLessThan(200);
    expect(time("-" + "a-".repeat(16_000))).toBeLessThan(50);
    expect(time("-" + "a".repeat(32_000))).toBeLessThan(50);
    expect(time("x" + "=".repeat(32_000))).toBeLessThan(50);
    expect(time(" " + "a:1:a:a".repeat(4_600))).toBeLessThan(50);
    expect(time("mysql ".repeat(6_000))).toBeLessThan(100);
  });

  test("past 64 KB only the linear passes run, split at a line; a provider token there is still caught", () => {
    const head = "x ".repeat(40_000);
    const out = redactSecrets(`${head}\nsk${""}-ant-api03-${"Q".repeat(40)} and PGPASSWORD=late`).text;
    expect(out).not.toContain("QQQQQQQQ");
  });
});

// ---- 3. migration 10 -------------------------------------------------------------------------------------------------

describe("migration 10 (Codex r5 #4)", () => {
  test("carries the round-3 provenance blob over before deleting it", () => {
    const dir = mkdtempSync("/tmp/walkie-mig10-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "walkie.db");
    const first = new Store(path);
    // Back to the store just before the migration that creates status_provenance, found by what it does (not its
    // number: lanes merge migrations in, ORCH-FIX-13): that one and every later one are undone (their triggers,
    // indexes and tables dropped, the columns they added to older tables dropped; PROJECTS-1's migration adds some).
    const at = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE status_provenance"));
    expect(at).toBeGreaterThan(0);
    const later = MIGRATIONS.slice(at);
    const all = (re: RegExp) => later.flatMap((m) => [...m.matchAll(re)]);
    const created = new Set(all(/CREATE TABLE (\w+)/g).map((x) => x[1] as string));
    const undo = [
      ...all(/CREATE TRIGGER (\w+)/g).map((x) => `DROP TRIGGER IF EXISTS ${x[1]};`),
      ...all(/CREATE INDEX (\w+)/g).map((x) => `DROP INDEX IF EXISTS ${x[1]};`),
      ...[...created].map((t) => `DROP TABLE IF EXISTS ${t};`),
      ...all(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g).filter((x) => !created.has(x[1] as string))
        .map((x) => `ALTER TABLE ${x[1]} DROP COLUMN ${x[2]};`),
    ];
    first.db.exec(`${undo.join(" ")} DELETE FROM migrations WHERE version > ${at};`);
    first.setMeta("status_prov", JSON.stringify({ "cc-p": { id: "n:1", p: { title: "person", task: "person" } }, "cc-q": { id: "n:2" }, "bad": 7 }));
    first.close();
    const again = new Store(path);
    cleanups.push(() => again.close());
    expect(again.statusProvenance("cc-p")).toEqual({ event_id: "n:1", prov: JSON.stringify({ title: "person", task: "person" }) });
    expect(again.statusProvenance("cc-q")).toEqual({ event_id: "n:2", prov: "{}" });
    expect(again.statusProvenance("bad")).toBeNull();
    expect(again.getMeta("status_prov")).toBeNull();
  });
});

// ---- 4. history: independent of what the requester claims ---------------------------------------------------------------

describe("status history (Codex r5 #1)", () => {
  test("another machine's superseded status with text is never full; content-free or own compliant ones are, for old peers", () => {
    const n = node();
    const other = "7777777777777777";
    const mk = (seq: number, body: Record<string, unknown>) => ({ v: 1, team: "t", id: `${other}:${seq}`, origin: other, seq, ts: n.clock.t, kind: "agent.status", author: { handle: "kira", node: other }, body: { agent: "cc-k", state: "working", runtime: "claude-code", ...body } }) as unknown as Event;
    // The store says cc-k's latest is seq 3.
    n.core.store.upsertAgent(mk(3, {}));
    const withText = mk(1, { title: "Zanzibar layoffs" });
    const plain = mk(2, { activity: "Running a command" });
    expect(n.core.serveStatusInFull(withText, { legacy: true })).toBe(false); // a requester omitting status_stubs gains nothing
    expect(n.core.serveStatusInFull(withText)).toBe(false);
    expect(n.core.serveStatusInFull(plain, { legacy: true })).toBe(true); // nothing to disclose: an old peer isn't stalled
    expect(n.core.serveStatusInFull(plain)).toBe(false);
    expect(n.core.serveStatusInFull(mk(3, {}))).toBe(true);
  });
});

// ---- 5-8. discovery, growth, idempotence, archive order ------------------------------------------------------------------

describe("discovery and activity (Codex r5 #2, #3, #8; Opus r5 #6)", () => {
  test("#2 201 stable sessions over a cap of 100: every one is examined within a few scans", async () => {
    const w = world(cleanups);
    w.fx.procs = w.fx.procs.filter((p) => p.pid < 100);
    for (let i = 0; i < 201; i++) w.fx.procs.push({ pid: 4000 + i, ppid: 1, uid: ME, startedAt: w.clock.t - 1_000_000 + i * 1000, command: "kimi", cpuMs: 1 });
    const d = w.disc();
    for (let k = 0; k < 4; k++) { await d.tick(); w.clock.t += TICK; }
    const seen = w.core.store.agents().filter((r) => r.agent.startsWith("kimi-pid")).length;
    expect(seen).toBe(201);
    expect(status(w.core, "kimi-pid4000")?.state).toBe("idle"); // the oldest too
  });

  test("#3 a 1.29 MB append of finished calls keeps an earlier open call open", () => {
    const w = world(cleanups);
    w.write([{ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "slow", name: "Bash", input: { command: "make" } }] } }]);
    const files = new SessionFiles();
    expect(files.read(w.transcript, "claude")?.info.toolRunning).toBe(true);
    const chunk = jl(...Array.from({ length: 1_400 }, (_, i) => [
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `s${i}`, name: "Read", input: {} }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `s${i}`, content: "x".repeat(700) }] } },
    ]).flat());
    appendFileSync(w.transcript, chunk);
    expect(Buffer.byteLength(chunk)).toBeGreaterThan(1_250_000);
    expect(files.read(w.transcript, "claude")?.info.toolRunning).toBe(true);
  });

  test("#8 whole-status idempotence: a branch-derived task is checked against the branch as published", () => {
    const body = { agent: "a", state: "working" as const, runtime: "claude-code" as const, branch: "feat/ALE-1234-OAuth2SAML2OIDC1", task: "ALE-1234" };
    const p1 = projectStatus(body, { task: "branch" }, OFF);
    expect(p1).toMatchObject({ branch: body.branch, task: "ALE-1234" });
    expect(projectStatus(p1, { task: "branch" }, OFF)).toEqual(p1);
  });

  test("Opus r5 #6: the archive prunes before it re-signs, so expired statuses are deleted, not re-signed", () => {
    const n = node();
    n.share(true); // signed while sharing was on...
    n.core.emit("agent.status", { agent: "old-1", state: "idle", runtime: "claude-code", title: "Secret" }, { agent: "old-1", provenance: { title: "prompt" } });
    n.core.emit("agent.status", { agent: "kept-1", state: "idle", runtime: "claude-code", title: "Secret too" }, { agent: "kept-1", provenance: { title: "prompt" } });
    n.clock.t += 8 * DAY;
    n.core.emit("agent.status", { agent: "kept-1", state: "idle", runtime: "claude-code", title: "Secret too" }, { agent: "kept-1", provenance: { title: "prompt" } });
    const before = n.core.store.queryEvents({ kinds: ["agent.status"], limit: 100 }).length;
    n.share(false); // ...then narrowed
    new AgentArchive(n.core, onlineSync, createLogger({}), { now: () => n.clock.t }).tick();
    expect(n.core.store.agent(n.core.nodeId, "old-1")).toBeNull();
    const after = n.core.store.queryEvents({ kinds: ["agent.status"], limit: 100 }).map((r) => JSON.parse(r.json) as Event);
    expect(after.length).toBe(before + 1); // only kept-1 was re-signed
    expect(after.filter((e) => (e.body as BodyOf<"agent.status">).agent === "old-1").length).toBe(1);
  });
});

// ---- nice to have: more credential forms (Codex r5 #7, Opus r5 #4) -----------------------------------------------------

const X = "Zq9vXk2mWp7rT4ny";
const MISSES: string[] = [
  `password: |\n  SaffronBlueLake`, `machine db\nlogin user\npassword SaffronBlueLake`, `{"password":123456}`, `sudo -u root redis-cli -a SaffronBlueLake`,
  `os.environ["API_TOKEN"] = "${X}"`, `process.env['DB_PASSWORD'] = '${X}'`, `ENV["STRIPE_SECRET"]="${X}"`, `:password => "${X}"`, `"passwd"=>"${X}"`,
  `<password>${X}</password>`, `<add key="ApiKey" value="${X}"/>`, `the db password is ${X}`, `config.password = "${X}"`, `let token = "${X}";`,
  `$env:GITHUB_TOKEN = "${X}"`, `login alex password ${X}`, `pwd: ${X}`, `kubectl create secret generic x --from-literal=db-pass=${X.slice(0, 8)}`,
];

describe("more credential forms", () => {
  test.each(MISSES)("%s", (text) => {
    const out = redactSecrets(text).text;
    for (const secret of ["SaffronBlueLake", "123456", X.slice(0, 8)]) if (text.includes(secret)) expect(out).not.toContain(secret);
  });
});
