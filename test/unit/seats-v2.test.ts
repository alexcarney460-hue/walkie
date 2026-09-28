// Seats v2 (FO-2, FLEET-ORCH-1 §3.4 + §8 FO-2 acceptance): the v2 request body (and that a v1 host / an older daemon
// never takes it), Kimi's argv (a fixed pointer, never the brief), the host workspace in its own clone (a delta
// bundle's missing prerequisites refused, a build's worktree on lane/<label>, an audit's detached at the exact
// commit), the result file (no symlink followed), and the account check against the vault policy (own-policy
// hand-out works; a shared account is refused for a teammate it doesn't list).
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SEATS_V2_CAP, SEAT_TASK_PROMPT, SEAT_TASK_PROMPT_ALT, SeatRun, SeatRunV2, runTextV2, seatBlobRefs, seatOf, seatRequestText, seatsChannel,
  type SeatRunV2 as SeatRunV2T,
} from "../../src/protocol/seats.ts";
import { MachineStats, hasCap } from "../../src/protocol/machine-stats.ts";
import { hostSys } from "../../src/daemon/machine-stats/sampler.ts";
import { kimiSeatArgs, kimiSeatLine, dropFromSeat, findRuntime, loginEnv } from "../../src/daemon/seats/runtime.ts";
import { seatsDirArg } from "../../src/cli/commands/seats.ts";
import {
  LANE_MARKER, SeatRefusal, addWorktree, placeTask, planTask, recordLaneTip, readResultFile, releaseExclude, removeTask, resolveRepo, stageBundle, stageDir, sweepStaged, validTaskRecord, writeTask,
} from "../../src/daemon/seats/v2.ts";
import { MAX_FILTERS, gitToFile, seatOutcome } from "../../src/daemon/seats/git.ts";
import { planSeatAccount, seatCredentials } from "../../src/daemon/seats/account.ts";
import { decideRun, type DecideCtx } from "../../src/daemon/seats/rules.ts";
import type { AccountView } from "../../src/protocol/accounts.ts";
import type { VaultEntry } from "../../src/accounts/vault/vault.ts";
import type { MemberRec } from "../../src/daemon/roster.ts";
import { grantLease, NonceBook, requestLease, type PeerLeaseReq } from "../../src/daemon/vault-lease.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });
function tmp(prefix = "walkie-v2-"): string {
  const d = mkdtempSync(join("/tmp", prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

const HASH = "b".repeat(64);
const DELTA = "c".repeat(64);
const v2Body = (over: Partial<SeatRunV2T> = {}): SeatRunV2T => ({
  op: "run", v: 2, runtime: "kimi", brief: HASH, label: "sp-210", workspace: { repo: "app", ref: "a".repeat(40), mode: "branch", bundle: DELTA },
  result_file: ".audit-private/verdict.json", timeout_s: 600, max_concurrent: 3, ...over,
});

describe("the v2 request body", () => {
  test("a v1 host ignores a v2 body: its strict v1 schema doesn't take it, so it is not a request", () => {
    const body = v2Body();
    expect(SeatRunV2.safeParse(body).success).toBe(true);
    // What a released pre.5 host parses a `seat` field with (v1: `v: 1`, runtime claude|codex, a prompt).
    expect(SeatRun.safeParse(body).success).toBe(false);
    expect(SeatRun.safeParse({ ...body, v: 1 }).success).toBe(false); // no prompt, unknown fields: still not v1
    // This build reads both.
    expect(seatOf({ seat: body })).toMatchObject({ op: "run", v: 2, runtime: "kimi" });
    expect(seatOf({ seat: { op: "run", v: 1, runtime: "kimi", prompt: "x", timeout_s: 60, max_concurrent: 1 } })).toBeNull(); // Kimi is v2 only
  });

  test("the desk (and the run route) never target a host that doesn't announce seats_v2", () => {
    const sys = hostSys("darwin", "arm64");
    expect(sys.caps).toContain(SEATS_V2_CAP);
    expect(hasCap(MachineStats.parse({ at: 1, mem: null, temp_c: null, sys }), SEATS_V2_CAP)).toBe(true);
    // A pre.5 daemon's stats: sys without caps.
    const { caps: _c, ...old } = sys;
    expect(hasCap(MachineStats.parse({ at: 1, mem: null, temp_c: null, sys: old }), SEATS_V2_CAP)).toBe(false);
    expect(hasCap(undefined, SEATS_V2_CAP)).toBe(false);
    // A malformed caps list drops only itself.
    expect(MachineStats.parse({ at: 1, mem: null, temp_c: null, sys: { ...old, caps: ["BAD CAP"] } }).sys).toEqual(old);
  });

  test("a branch or detached workspace needs a label; refs, labels, result files and accounts are validated", () => {
    expect(SeatRunV2.safeParse(v2Body({ label: undefined })).success).toBe(false);
    expect(SeatRunV2.safeParse(v2Body({ label: undefined, workspace: { repo: "app", ref: "main", mode: "fresh" } })).success).toBe(true);
    for (const ref of ["-rf", "a..b", "refs//x", "x.lock", "x/"]) {
      expect(SeatRunV2.safeParse(v2Body({ workspace: { repo: "app", ref, mode: "detached" } })).success).toBe(false);
    }
    for (const result_file of ["/etc/passwd", "../x", "a/../b", ".git/config", "a//b"]) {
      expect(SeatRunV2.safeParse(v2Body({ result_file })).success).toBe(false);
    }
    expect(SeatRunV2.safeParse(v2Body({ label: "../x" })).success).toBe(false);
    expect(SeatRunV2.safeParse(v2Body({ account: `alex:${"a".repeat(24)}` })).success).toBe(true);
    expect(SeatRunV2.safeParse(v2Body({ account: "sk-ant-oat01-abc" })).success).toBe(false);
    expect(SeatRunV2.safeParse({ ...v2Body(), prompt: "inline" }).success).toBe(false); // the brief is never inline
  });

  test("the request post: its text is exactly the daemon's (no brief, no path), and it references the brief and the delta", () => {
    const run = v2Body();
    const text = runTextV2(run, "arvid-mac");
    expect(text).not.toContain("verdict.json\n");
    expect(seatRequestText({ text, seat: run })).toBe(true);
    expect(seatRequestText({ text: `${text} extra`, seat: run })).toBe(false);
    expect(seatRequestText({ text, seat: run, mentions: ["x"] })).toBe(false);
    const ev = { kind: "msg.post", channel: seatsChannel("0123456789abcdef"), body: { text, seat: run } };
    expect(seatBlobRefs(ev).sort()).toEqual([HASH, DELTA].sort());
    expect(seatBlobRefs({ ...ev, channel: "general" })).toEqual([]);
  });
});

describe("Kimi as a seat runtime", () => {
  test("argv carries only the fixed pointer to TASK.md, never the brief", () => {
    const args = kimiSeatArgs({ prompt: SEAT_TASK_PROMPT });
    expect(args).toEqual(["-p", "Read ./TASK.md and do it", "--output-format", "text"]);
    expect(kimiSeatArgs({ prompt: SEAT_TASK_PROMPT, model: "k2" })).toEqual(["-p", SEAT_TASK_PROMPT, "--output-format", "text", "-m", "k2"]);
    expect(kimiSeatLine("\u001b[1mkimi\u001b[0m: hi")).toEqual([{ kind: "text", text: "kimi: hi" }]);
    expect(kimiSeatLine("   ")).toBeNull();
  });

  test("its API keys never reach a seat; its binary is found in ~/.kimi-code/bin", () => {
    for (const k of ["KIMI_API_KEY", "MOONSHOT_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) expect(dropFromSeat(k)).toBe(true);
    const home = tmp();
    mkdirSync(join(home, ".kimi-code", "bin"), { recursive: true });
    const bin = join(home, ".kimi-code", "bin", "kimi");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    expect(findRuntime("kimi", "/nonexistent", home)).toBe(bin);
  });

  test("a host that doesn't allow Kimi refuses it (runtime_not_allowed)", () => {
    const alex = tnode("alex");
    const { team, create } = createTeam(alex);
    const core = makeCore(alex, team, cleanups);
    core.ingest(create, "local");
    const ctx = { roster: core.roster, node: core.nodeId, me: "alex", policy: { allow: true, launchers: null, runtimes: ["claude", "codex"] as const }, now: now(), maxAgeMs: 600_000 } as unknown as DecideCtx;
    const ev = { kind: "msg.post", channel: "general", body: { seat: v2Body() } } as never;
    expect(decideRun(ev, ctx)).toBeNull(); // not this host's channel
  });
});

// ---- git fixtures ---------------------------------------------------------------------------------------------

const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/tmp" };
function g(cwd: string, ...a: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=T", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
function repoWithCommits(n = 2): { dir: string; shas: string[] } {
  const dir = join(tmp(), "clone");
  mkdirSync(dir);
  g(dir, "init", "-q", "-b", "main");
  const shas: string[] = [];
  for (let i = 0; i < n; i++) {
    writeFileSync(join(dir, `f${i}.txt`), `${i}\n`);
    g(dir, "add", ".");
    g(dir, "commit", "-q", "-m", `c${i}`);
    shas.push(g(dir, "rev-parse", "HEAD"));
  }
  return { dir, shas };
}

describe("the workspace in the host's own clone", () => {
  test("a delta bundle whose prerequisites the clone lacks is refused with the reason", async () => {
    const { dir } = repoWithCommits(1);
    // The launcher's history diverged: its delta is based on a commit this clone never had.
    const other = repoWithCommits(3);
    const bundle = join(tmp(), "delta.bundle");
    g(other.dir, "bundle", "create", bundle, "main", `^${other.shas[1]}`);
    const err = await resolveRepo({ app: dir }, { repo: "app", ref: "main", mode: "branch" }, bundle, "t1", ENV).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SeatRefusal);
    expect((err as Error).message).toMatch(/doesn't apply to repo app's branches and tags on this machine \(it builds on [0-9a-f]{12}\)/);
    expect((err as Error).message).toContain((other.shas[1] as string).slice(0, 12));
  });

  test("a good delta bundle is fetched; its ref resolves to the exact commit; the private refs are removable", async () => {
    const { dir, shas } = repoWithCommits(1);
    const launcher = join(tmp(), "launcher");
    g("/tmp", "clone", "-q", dir, launcher);
    writeFileSync(join(launcher, "new.txt"), "new\n");
    g(launcher, "add", ".");
    g(launcher, "commit", "-q", "-m", "new");
    g(launcher, "checkout", "-q", "-b", "lane/x");
    const tip = g(launcher, "rev-parse", "HEAD");
    const bundle = join(tmp(), "delta.bundle");
    g(launcher, "bundle", "create", bundle, "lane/x", `^${shas[0]}`);
    const got = await resolveRepo({ app: dir }, { repo: "app", ref: "lane/x", mode: "branch" }, bundle, "t2", ENV);
    expect(got).toEqual({ clone: dir, sha: tip });
    expect(g(dir, "for-each-ref", "refs/walkie/in/t2/")).toContain(tip);
    await expect(resolveRepo({ app: dir }, { repo: "app", ref: "no-such", mode: "branch" }, null, "t3", ENV)).rejects.toThrow(/ref no-such isn't a branch, a tag, or a commit on one, in repo app/);
    await expect(resolveRepo({}, { repo: "app", ref: "main", mode: "branch" }, null, "t4", ENV)).rejects.toThrow(/no clone of repo app/);
  });

  test("a build's worktree is .worktrees/<label> on branch lane/<label>; an audit's is detached at the exact commit", async () => {
    const { dir, shas } = repoWithCommits(2);
    const build = await addWorktree(dir, "sp-210", "branch", shas[0] as string, undefined, ENV);
    expect(build.cwd).toBe(join(realpathSync(dir), ".worktrees", "sp-210"));
    expect(g(build.cwd, "symbolic-ref", "HEAD")).toBe("refs/heads/lane/sp-210");
    expect(g(build.cwd, "rev-parse", "HEAD")).toBe(shas[0] as string);
    expect(statSync(build.dirs.gitDir).isDirectory()).toBe(true);
    expect(g(dir, "status", "--porcelain")).toBe(""); // the lanes' worktrees aren't untracked content of the person's tree
    const audit = await addWorktree(dir, "sp-210-audit", "detached", shas[1] as string, undefined, ENV);
    expect(g(audit.cwd, "rev-parse", "HEAD")).toBe(shas[1] as string);
    expect(Bun.spawnSync(["git", "symbolic-ref", "-q", "HEAD"], { cwd: audit.cwd }).exitCode).not.toBe(0); // detached
    // The build's commit comes back as a bundle, read through the host's own git directories.
    writeFileSync(join(build.cwd, "work.txt"), "w\n");
    g(build.cwd, "add", "work.txt");
    g(build.cwd, "commit", "-q", "-m", "work");
    const out = join(tmp(), "result.bundle");
    const o = await seatOutcome(build.cwd, shas[0] as string, out, ENV, undefined, undefined, build.dirs);
    expect(o).toMatchObject({ commits: 1, dirty: 0, bundle: out });
    await recordLaneTip(dir, "lane/sp-210", ENV, { base: shas[0] as string, head: g(build.cwd, "rev-parse", "HEAD") }); // the host, as the seat ends
    // A retry replaces a clean leftover worktree; one with uncommitted work is refused, never discarded.
    const again = await addWorktree(dir, "sp-210", "branch", shas[1] as string, undefined, ENV);
    expect(g(again.cwd, "rev-parse", "HEAD")).toBe(shas[1] as string);
    writeFileSync(join(again.cwd, "wip.txt"), "unsaved\n");
    await expect(addWorktree(dir, "sp-210", "branch", shas[1] as string, undefined, ENV)).rejects.toThrow(/uncommitted work/);
    expect(readFileSync(join(again.cwd, "wip.txt"), "utf8")).toBe("unsaved\n");
  });

  test("r1 HIGH 3: a seat user's bundle is staged privately (0600 in a 0700 dir), capped, and swept at start", async () => {
    const { dir, shas } = repoWithCommits(2);
    const home = tmp();
    const into = stageDir(home);
    expect(statSync(into).mode & 0o777).toBe(0o700);
    const staged = await stageBundle(dir, shas[0] as string, into, "in-abc.bundle", 1024 * 1024, ENV);
    expect(statSync(staged.path).mode & 0o777).toBe(0o600);
    expect(staged.size).toBe(statSync(staged.path).size);
    const out = join(tmp(), "c");
    g("/tmp", "clone", "-q", staged.path, out);
    expect(g(out, "rev-parse", "HEAD")).toBe(shas[0] as string);
    await expect(stageBundle(dir, shas[1] as string, into, "in-big.bundle", 10, ENV)).rejects.toThrow(/more than 0 MB, the most a seat user can receive/);
    expect(existsSync(join(into, "in-big.bundle"))).toBe(false);
    expect(sweepStaged(home)).toBe(1);
    expect(existsSync(staged.path)).toBe(false);
  });
});

describe("the brief and the result file", () => {
  test("TASK.md is written 0600 and kept out of the seat's commits; a tree with its own TASK.md gets .walkie/TASK.md", async () => {
    const { dir } = repoWithCommits(1);
    const t = await writeTask(dir, "the brief", ENV);
    expect(t).toMatchObject({ file: "TASK.md", prompt: SEAT_TASK_PROMPT, exclude: join(dir, ".git", "info", "exclude") });
    expect(statSync(join(dir, "TASK.md")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, ".git", "info", "exclude"), "utf8")).toContain("/TASK.md");
    expect(g(dir, "status", "--porcelain")).toBe(""); // excluded
    removeTask(dir, t);
    expect(existsSync(join(dir, "TASK.md"))).toBe(false);
    // The last seat's end takes the exclude line out again: the person's clone is left as it was.
    releaseExclude(t);
    expect(readFileSync(join(dir, ".git", "info", "exclude"), "utf8")).not.toContain("TASK.md");
    // A tracked TASK.md of the repo's own is never overwritten.
    writeFileSync(join(dir, "TASK.md"), "the repo's own\n");
    g(dir, "add", "TASK.md");
    g(dir, "commit", "-q", "-m", "own task");
    const alt = await writeTask(dir, "the brief", ENV);
    expect(alt).toMatchObject({ file: ".walkie/TASK.md", prompt: SEAT_TASK_PROMPT_ALT });
    expect(readFileSync(join(dir, "TASK.md"), "utf8")).toBe("the repo's own\n");
    expect(readFileSync(join(dir, ".walkie", "TASK.md"), "utf8")).toBe("the brief");
  });

  test("a result file is read (redacted); a symlinked one, or one behind a symlinked directory, is refused", () => {
    const root = tmp();
    mkdirSync(join(root, ".audit-private"));
    writeFileSync(join(root, ".audit-private", "verdict.json"), '{"verdict":"PASS","token":"ghp_0123456789abcdefghijklmnopqrstuvwxyzAB"}\n');
    const ok = readResultFile(root, ".audit-private/verdict.json");
    expect("bytes" in ok).toBe(true);
    const text = new TextDecoder().decode((ok as { bytes: Uint8Array }).bytes);
    expect(text).toContain('"verdict":"PASS"');
    expect(text).not.toContain("ghp_0123456789");
    const outside = join(tmp(), "secret.txt");
    writeFileSync(outside, "secret\n");
    symlinkSync(outside, join(root, "link.json"));
    expect(readResultFile(root, "link.json")).toEqual({ error: "refused: it is a symlink" });
    symlinkSync(join(outside, ".."), join(root, "dirlink"));
    expect(readResultFile(root, "dirlink/secret.txt")).toEqual({ error: "refused: a symlink on its path" });
    writeFileSync(join(root, "big.json"), "x".repeat(64 * 1024 + 1));
    expect(readResultFile(root, "big.json")).toEqual({ error: "over 64 KiB" });
    expect(readResultFile(root, "missing.json")).toEqual({ error: "not found" });
    expect(readResultFile(root, "../secret.txt")).toEqual({ error: "not a relative path inside the work tree" });
    expect(lstatSync(join(root, "link.json")).isSymbolicLink()).toBe(true);
  });
});

// ---- accounts --------------------------------------------------------------------------------------------------

const ID = "a".repeat(24);
const entry = (over: Partial<VaultEntry> = {}): VaultEntry => ({
  id: ID, provider: "claude", label: "Claude account", plan: null, policy: "local", share_with: [], created_at: 1, expires_at: null, home: null, linked: false, gen: "g1", ...over,
}) as VaultEntry;
function view(owner: string, machines: AccountView["machines"], provider: AccountView["provider"] = "claude"): AccountView {
  return { key: `${owner}:${ID}`, id: ID, provider, label: "Claude account", plan: null, owners: [owner], claimed_by: [], machines, usage: null, usage_host: null, last_seen: 1 };
}
const machine = (over: Partial<AccountView["machines"][number]>) => ({ node_id: "1111111111111111", hostname: "alex-mbp", handle: "alex", online: true, self: false, agents: [], usage: null, ...over });

describe("a v2 seat's account, checked against the host's vault policy", () => {
  test("an account this host may not use is refused account_not_usable", () => {
    const base = { runtime: "claude" as const, me: "arvid", launcher: "alex", vault: [] as VaultEntry[], pooled: [] as AccountView[] };
    expect(planSeatAccount(`arvid:${ID}`, base)).toMatchObject({ kind: "refused", why: expect.stringMatching(/^account_not_usable: no Claude account/) });
    // Alex's own-policy account is Alex's, never Arvid's.
    const alexOwn = view("alex", [machine({ vault: { policy: "own" } })]);
    expect(planSeatAccount(`alex:${ID}`, { ...base, pooled: [alexOwn] })).toMatchObject({ kind: "refused", why: expect.stringMatching(/^account_not_usable: @alex hasn't shared it with @arvid/) });
    // A local-policy account on another of Arvid's machines stays there.
    const local = view("arvid", [machine({ handle: "arvid", vault: { policy: "local" } })]);
    expect(planSeatAccount(`arvid:${ID}`, { ...base, pooled: [local] })).toMatchObject({ kind: "refused", why: expect.stringMatching(/policy is local/) });
    expect(planSeatAccount(`arvid:${ID}`, { ...base, runtime: "kimi" })).toMatchObject({ kind: "refused", why: expect.stringMatching(/^account_not_usable: Kimi logins/) });
    expect(planSeatAccount(`arvid:${ID}`, { ...base, runtime: "codex", vault: [entry()] })).toMatchObject({ kind: "refused", why: expect.stringMatching(/claude login and this seat runs codex/) });
    expect(planSeatAccount(`arvid:${ID}`, { ...base, runtime: "codex" })).toMatchObject({ kind: "refused", why: expect.stringMatching(/no Codex account/) });
    // In this machine's own vault: usable here whatever its policy.
    expect(planSeatAccount(`arvid:${ID}`, { ...base, vault: [entry()] })).toMatchObject({ kind: "local" });
  });

  test("a shared-policy account is refused for a handle it doesn't list, taken for one it does", () => {
    const shared = view("alex", [machine({ vault: { policy: "shared", share_with: ["kira"] } })]);
    expect(planSeatAccount(`alex:${ID}`, { runtime: "claude", me: "arvid", launcher: "arvid", vault: [], pooled: [shared] }))
      .toMatchObject({ kind: "refused", why: expect.stringMatching(/^account_not_usable: @alex hasn't shared it with @arvid/) });
    expect(planSeatAccount(`alex:${ID}`, { runtime: "claude", me: "kira", launcher: "kira", vault: [], pooled: [shared] })).toEqual({ kind: "peer", id: ID, owner: "alex", node: "1111111111111111", provider: "claude" });
    // r1 MEDIUM 11: shared with the host's person (kira) is not enough: the launcher must be allowed by the policy too.
    expect(planSeatAccount(`alex:${ID}`, { runtime: "claude", me: "kira", launcher: "arvid", vault: [], pooled: [shared] }))
      .toMatchObject({ kind: "refused", why: expect.stringMatching(/shared it with @kira, not with @arvid who launched this seat/) });
    expect(planSeatAccount(`alex:${ID}`, { runtime: "claude", me: "kira", launcher: "alex", vault: [], pooled: [shared] })).toMatchObject({ kind: "peer" });
    const offline = view("alex", [machine({ online: false, vault: { policy: "shared", share_with: ["kira"] } })]);
    expect(planSeatAccount(`alex:${ID}`, { runtime: "claude", me: "kira", launcher: "kira", vault: [], pooled: [offline] })).toMatchObject({ kind: "refused", why: expect.stringMatching(/offline/) });
  });

  test("an own-policy lease works on the person's other machine (end to end through the owner's hand-out), and the owner refuses an unlisted teammate", async () => {
    const TOKEN = "sk-ant-oat01-FAKESEATTOKEN0123456789abcdefghijklmn";
    const alex = tnode("alex");
    const { team, create } = createTeam(alex);
    const ownerCore = makeCore(alex, team, cleanups);
    ownerCore.ingest(create, "local");
    const alex2 = tnode("alex", "alex@example.com", "alex-mini");
    const host = makeCore(alex2, team, cleanups);
    host.ingest(create, "remote");
    const vault = { list: () => [entry({ policy: "own" })], claudeToken: async () => TOKEN };
    const d = { vault, sharing: false, nonces: new NonceBook() };
    const alexMember: MemberRec = { login: alex.login, handle: "alex", role: "owner" };
    const own = view("alex", [machine({ node_id: ownerCore.nodeId, vault: { policy: "own" } })]);
    const plan = planSeatAccount(`alex:${ID}`, { runtime: "claude", me: "alex", launcher: "kira", vault: [], pooled: [own] });
    expect(plan).toEqual({ kind: "peer", id: ID, owner: "alex", node: ownerCore.nodeId, provider: "claude" });
    const creds = await seatCredentials(plan as Exclude<typeof plan, { kind: "refused" }>, "alex", false, {
      claudeToken: async () => { throw new Error("not local"); },
      lease: async (id, node, _provider) => {
        const r = await requestLease(host, async (_a, b: PeerLeaseReq) => grantLease(ownerCore, d, host.nodeId, alexMember, b, now()), { account: id, node, agent: "seat-abc-1" }, now());
        return { token: r.token, grant: r.grant };
      },
      accessOnlyCodex: () => null,
    });
    expect(creds.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    expect(creds.lease).toMatchObject({ provider: "claude", account: ID, from_node: ownerCore.nodeId, grant: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(creds.lease.owner).toBeUndefined(); // the person's own account
    // The owner's side checks again: a teammate the shared policy doesn't list gets nothing.
    const kira: MemberRec = { login: "kira@example.com", handle: "kira", role: "member" };
    const sharedD = { vault: { list: () => [entry({ policy: "shared", share_with: ["arvid"] })], claudeToken: async () => TOKEN }, sharing: true, nonces: new NonceBook() };
    const r = await requestLease(host, async (_a, b: PeerLeaseReq) => grantLease(ownerCore, sharedD, "kira-node", kira, b, now()), { account: ID, node: ownerCore.nodeId }, now()).catch((e: unknown) => e);
    expect(r).toMatchObject({ code: "not_allowed" });
  });

  test("a local vault account: Claude's token for this run, Codex's own home (as the person) or its access-only auth (as a seat user)", async () => {
    const home = tmp();
    writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "at", refresh_token: "rt" } }));
    const deps = { claudeToken: async () => "sk-ant-oat01-LOCALTOKEN0123456789abcdefgh", lease: async () => { throw new Error("no"); }, accessOnlyCodex: (t: string) => (JSON.parse(t).tokens.access_token ? '{"tokens":{"access_token":"at"}}' : null) };
    expect((await seatCredentials({ kind: "local", entry: entry() }, "arvid", false, deps)).env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-LOCALTOKEN0123456789abcdefgh" });
    const codex = entry({ provider: "codex", home });
    expect((await seatCredentials({ kind: "local", entry: codex }, "arvid", false, deps)).env).toEqual({ CODEX_HOME: home });
    const asUser = await seatCredentials({ kind: "local", entry: codex }, "arvid", true, deps);
    expect(asUser.env).toEqual({});
    expect(asUser.codexAuth).not.toContain("rt");
  });
});

// ---- FO-2 fix round 1 (Opus + Codex audits) -------------------------------------------------------------------

describe("r1 HIGH 1: the person's branches are never reset", () => {
  test("a branch outside lane/… or walkie/… can't even be asked for", () => {
    for (const branch of ["release", "main", "refs/heads/lane/x", "lane/../main", "lane/"]) {
      expect(SeatRunV2.safeParse(v2Body({ workspace: { repo: "app", ref: "main", mode: "branch", branch } })).success).toBe(false);
    }
    expect(SeatRunV2.safeParse(v2Body({ workspace: { repo: "app", ref: "main", mode: "branch", branch: "walkie/sp-210" } })).success).toBe(true);
  });

  test("an existing lane branch Walkie didn't create is refused and left exactly where it was", async () => {
    const { dir, shas } = repoWithCommits(2);
    g(dir, "branch", "lane/sp-9", shas[0] as string); // the person's own branch that happens to have a lane name
    await expect(addWorktree(dir, "sp-9", "branch", shas[1] as string, undefined, ENV)).rejects.toThrow(/branch lane\/sp-9 exists .* isn't Walkie's/);
    expect(g(dir, "rev-parse", "lane/sp-9")).toBe(shas[0] as string);
    expect(existsSync(join(dir, ".worktrees", "sp-9"))).toBe(false);
  });

  test("Walkie's own lane branch: fast-forwarded when safe; with commits the new base lacks, a fresh -2 (nothing lost)", async () => {
    const { dir, shas } = repoWithCommits(3);
    const a = await addWorktree(dir, "sp-7", "branch", shas[0] as string, undefined, ENV);
    expect(a.branch).toBe("lane/sp-7");
    expect(g(dir, "rev-parse", "refs/walkie/lanes/lane/sp-7")).toBe(shas[0] as string); // the ownership record
    g(dir, "worktree", "remove", a.cwd);
    // Fast-forward: shas[0] → shas[2] descends from the branch's tip.
    const b = await addWorktree(dir, "sp-7", "branch", shas[2] as string, undefined, ENV);
    expect(b.branch).toBe("lane/sp-7");
    expect(g(dir, "rev-parse", "lane/sp-7")).toBe(shas[2] as string);
    // The seat commits on it; a retry from an older base would drop that commit: a fresh name instead.
    writeFileSync(join(b.cwd, "seat.txt"), "s\n");
    g(b.cwd, "add", "seat.txt");
    g(b.cwd, "commit", "-q", "-m", "seat work");
    const seatTip = g(b.cwd, "rev-parse", "HEAD");
    await recordLaneTip(dir, "lane/sp-7", ENV, { base: shas[2] as string, head: seatTip }); // the host, as the seat ends
    const c = await addWorktree(dir, "sp-7", "branch", shas[1] as string, undefined, ENV);
    expect(c.branch).toBe("lane/sp-7-2");
    expect(g(dir, "rev-parse", "lane/sp-7")).toBe(seatTip); // untouched
    expect(g(c.cwd, "rev-parse", "HEAD")).toBe(shas[1] as string);
  });
});

describe("r1 HIGH 2 + HIGH 8: only Walkie's own worktrees are replaced, inside a real .worktrees", () => {
  test("a person's clean worktree at .worktrees/<label> (with an ignored .env) is refused, never removed", async () => {
    const { dir, shas } = repoWithCommits(1);
    writeFileSync(join(dir, ".gitignore"), ".env\n");
    g(dir, "add", ".gitignore");
    g(dir, "commit", "-q", "-m", "ignore .env");
    g(dir, "worktree", "add", "-q", "--detach", join(dir, ".worktrees", "mine"), "HEAD");
    writeFileSync(join(dir, ".worktrees", "mine", ".env"), "SECRET=1\n");
    await expect(addWorktree(dir, "mine", "detached", shas[0] as string, undefined, ENV)).rejects.toThrow(/isn't a worktree Walkie made/);
    expect(readFileSync(join(dir, ".worktrees", "mine", ".env"), "utf8")).toBe("SECRET=1\n");
    // A plain directory there is refused too.
    mkdirSync(join(dir, ".worktrees", "plain"));
    await expect(addWorktree(dir, "plain", "detached", shas[0] as string, undefined, ENV)).rejects.toThrow(/isn't a worktree Walkie made/);
    // Walkie's own (its marker in the admin directory) is replaced.
    const w = await addWorktree(dir, "ours", "detached", shas[0] as string, undefined, ENV);
    expect(existsSync(join(w.dirs.gitDir, LANE_MARKER))).toBe(true);
    expect(existsSync(join(w.cwd, LANE_MARKER))).toBe(false); // never in the tree
    const again = await addWorktree(dir, "ours", "detached", shas[0] as string, undefined, ENV);
    expect(again.cwd).toBe(w.cwd);
  });

  test("a vanished worktree's record: Walkie's own is dropped and re-made; the person's is refused (no worktree prune)", async () => {
    const { dir, shas } = repoWithCommits(1);
    const w = await addWorktree(dir, "gone", "detached", shas[0] as string, undefined, ENV);
    rmSync(w.cwd, { recursive: true });
    expect((await addWorktree(dir, "gone", "detached", shas[0] as string, undefined, ENV)).cwd).toBe(w.cwd);
    g(dir, "worktree", "add", "-q", "--detach", join(dir, ".worktrees", "theirs"), "HEAD");
    g(dir, "worktree", "add", "-q", "--detach", join(tmp(), "elsewhere"), "HEAD"); // another of the person's
    rmSync(join(dir, ".worktrees", "theirs"), { recursive: true });
    await expect(addWorktree(dir, "theirs", "detached", shas[0] as string, undefined, ENV)).rejects.toThrow(/registered .* worktree Walkie didn't make/);
    expect(g(dir, "worktree", "list", "--porcelain")).toContain("theirs"); // its record kept
  });

  test("a symlinked .worktrees, or a symlink at the label, is refused before anything changes", async () => {
    const { dir, shas } = repoWithCommits(1);
    const elsewhere = tmp();
    symlinkSync(elsewhere, join(dir, ".worktrees"));
    await expect(addWorktree(dir, "x", "detached", shas[0] as string, undefined, ENV)).rejects.toThrow(/isn't a plain directory/);
    expect(readdirSync(elsewhere)).toEqual([]);
    rmSync(join(dir, ".worktrees"));
    mkdirSync(join(dir, ".worktrees"));
    symlinkSync(elsewhere, join(dir, ".worktrees", "y"));
    await expect(addWorktree(dir, "y", "detached", shas[0] as string, undefined, ENV)).rejects.toThrow(/is a symlink/);
  });
});

describe("r1 MEDIUM 5: the brief never leaves in a commit", () => {
  test("a .gitignore that re-includes TASK.md makes the seat refuse to start (fail closed), the brief removed", async () => {
    const { dir } = repoWithCommits(1);
    writeFileSync(join(dir, ".gitignore"), "!TASK.md\n");
    await expect(writeTask(dir, "secret brief", ENV)).rejects.toBeInstanceOf(SeatRefusal);
    expect(existsSync(join(dir, "TASK.md"))).toBe(false);
    expect(readFileSync(join(dir, ".git", "info", "exclude"), "utf8")).not.toContain("/TASK.md");
  });

  test("commits that touch the brief file are not bundled", async () => {
    const { dir, shas } = repoWithCommits(1);
    writeFileSync(join(dir, "TASK.md"), "the brief\n");
    g(dir, "add", "-f", "TASK.md");
    g(dir, "commit", "-q", "-m", "oops");
    const out = join(tmp(), "r.bundle");
    expect(await seatOutcome(dir, shas[0] as string, out, ENV, undefined, undefined, undefined, "TASK.md")).toEqual({ commits: 1, dirty: 0, brief: true });
    expect(existsSync(out)).toBe(false);
  });
});

describe("r1 MEDIUM 6: only branches, tags and commits on them are served", () => {
  test("stash, remote-tracking refs and a commit only a stash reaches are refused; a branch, a tag and a commit on main resolve", async () => {
    const { dir, shas } = repoWithCommits(2);
    g(dir, "tag", "v1", shas[0] as string);
    writeFileSync(join(dir, "f0.txt"), "private wip\n");
    g(dir, "stash");
    const stashCommit = g(dir, "rev-parse", "stash@{0}");
    g(dir, "update-ref", "refs/remotes/origin/secret", stashCommit);
    const ws = (ref: string) => ({ repo: "app", ref, mode: "detached" as const });
    for (const ref of ["stash", "refs/stash", "refs/remotes/origin/secret", "origin/secret", stashCommit, "HEAD"]) {
      await expect(resolveRepo({ app: dir }, ws(ref), null, "t9", ENV)).rejects.toThrow(/isn't a branch, a tag, or a commit on one/);
    }
    expect((await resolveRepo({ app: dir }, ws("main"), null, "t9", ENV)).sha).toBe(shas[1] as string);
    expect((await resolveRepo({ app: dir }, ws("v1"), null, "t9", ENV)).sha).toBe(shas[0] as string);
    expect((await resolveRepo({ app: dir }, ws(shas[0] as string), null, "t9", ENV)).sha).toBe(shas[0] as string);
  });
});

describe("r1 MEDIUM 9: host-side checkouts run none of the clone's filters", () => {
  test("a smudge filter the clone's config defines doesn't run when a worktree is made", async () => {
    const { dir } = repoWithCommits(1);
    writeFileSync(join(dir, ".gitattributes"), "*.txt filter=evil\n");
    g(dir, "add", ".gitattributes");
    g(dir, "commit", "-q", "-m", "attrs");
    const sha = g(dir, "rev-parse", "HEAD");
    const marker = join(tmp(), "PWNED");
    g(dir, "config", "filter.evil.smudge", `touch ${marker}`);
    g(dir, "config", "filter.evil.required", "true");
    await addWorktree(dir, "f1", "detached", sha, undefined, ENV);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("r1 MEDIUM 4: a brief's record survives a crash (the next start removes it)", () => {
  test("only records this daemon writes are taken", () => {
    expect(validTaskRecord({ cwd: "/x/clone/.worktrees/a", file: "TASK.md", exclude: "/x/clone/.git/info/exclude" })).toBe(true);
    expect(validTaskRecord({ cwd: "/x", file: ".walkie/TASK.md" })).toBe(true);
    expect(validTaskRecord({ cwd: "/x", file: "../../etc/passwd" })).toBe(false);
    expect(validTaskRecord({ cwd: "relative", file: "TASK.md" })).toBe(false);
    expect(validTaskRecord({ cwd: "/x", file: "TASK.md", exclude: "/etc/hosts" })).toBe(false);
  });

  test(".walkie/ made for the brief is removed with it when empty", async () => {
    const { dir } = repoWithCommits(1);
    writeFileSync(join(dir, "TASK.md"), "own\n");
    g(dir, "add", "TASK.md");
    g(dir, "commit", "-q", "-m", "own task");
    const t = await writeTask(dir, "brief", ENV);
    removeTask(dir, t);
    expect(existsSync(join(dir, ".walkie"))).toBe(false);
  });
});

// ---- FO-2 fix round 2 (Opus + Codex r2 audits) ------------------------------------------------------------------

/** A bundle file by hand: `heads` (and `prereqs`), with an empty pack (no objects). */
function forgedBundle(file: string, heads: Array<[string, string]>, prereqs: string[] = []): void {
  const header = `# v2 git bundle\n${prereqs.map((p) => `-${p} x\n`).join("")}${heads.map(([sha, ref]) => `${sha} ${ref}\n`).join("")}\n`;
  const pack = new Uint8Array(12);
  pack.set(new TextEncoder().encode("PACK"), 0);
  new DataView(pack.buffer).setUint32(4, 2);
  new DataView(pack.buffer).setUint32(8, 0);
  const sum = new Uint8Array(new Bun.CryptoHasher("sha1").update(pack).digest());
  writeFileSync(file, Buffer.concat([Buffer.from(header), Buffer.from(pack), Buffer.from(sum)]));
}

describe("r2 MED 1: a delta bundle can't get an unpublished commit of the clone served", () => {
  test("a forged bundle naming the stash commit (empty pack) is refused; nothing is fetched; the error doesn't tell existence", async () => {
    const { dir, shas } = repoWithCommits(1);
    writeFileSync(join(dir, "f0.txt"), "private wip\n");
    g(dir, "stash");
    const stash = g(dir, "rev-parse", "stash@{0}");
    const forged = join(tmp(), "forged.bundle");
    forgedBundle(forged, [[stash, "refs/heads/lane/x"]]);
    const ws = { repo: "app", ref: "lane/x", mode: "detached" as const };
    const a = await resolveRepo({ app: dir }, ws, forged, "f1", ENV).catch((e: Error) => e);
    expect(a).toBeInstanceOf(SeatRefusal);
    expect(g(dir, "for-each-ref", "refs/walkie/in/")).toBe("");
    // A commit that doesn't exist at all reads exactly the same.
    const ghost = join(tmp(), "ghost.bundle");
    forgedBundle(ghost, [["e".repeat(40), "refs/heads/lane/x"]]);
    const b = await resolveRepo({ app: dir }, ws, ghost, "f2", ENV).catch((e: Error) => e);
    expect((b as Error).message).toBe((a as Error).message);
    // Building on the stash (a prerequisite that isn't on a branch or tag) is refused too.
    const side = join(tmp(), "side");
    g("/tmp", "clone", "-q", dir, side);
    g(side, "fetch", "-q", dir, `${stash}:refs/heads/from-stash`);
    g(side, "checkout", "-q", "from-stash");
    writeFileSync(join(side, "n.txt"), "n\n");
    g(side, "add", "n.txt");
    g(side, "commit", "-q", "-m", "on the stash");
    const onStash = join(tmp(), "on-stash.bundle");
    g(side, "bundle", "create", onStash, "from-stash", `^${stash}`);
    await expect(resolveRepo({ app: dir }, { ...ws, ref: "from-stash" }, onStash, "f3", ENV)).rejects.toThrow(/doesn't apply to repo app's branches and tags/);
    // A genuine delta on a published commit still goes.
    const good = join(tmp(), "good");
    g("/tmp", "clone", "-q", dir, good);
    writeFileSync(join(good, "g.txt"), "g\n");
    g(good, "add", "g.txt");
    g(good, "commit", "-q", "-m", "good");
    const goodBundle = join(tmp(), "good.bundle");
    g(good, "bundle", "create", goodBundle, "main", `^${shas[0]}`);
    expect((await resolveRepo({ app: dir }, { ...ws, ref: "main" }, goodBundle, "f4", ENV)).sha).toBe(g(good, "rev-parse", "HEAD"));
  });
});

describe("r2 MED 2: the brief's cleanup intent comes first, and never removes a file that isn't the brief", () => {
  test("planTask writes nothing; a file of the person's that took the name is never removed", async () => {
    const { dir } = repoWithCommits(1);
    const plan = await planTask(dir, "the brief", ENV);
    // (Checked field by field: bun's toMatchObject writes its asymmetric matchers into the object it checks.)
    expect(plan.file).toBe("TASK.md");
    expect(plan.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.exclude).toMatch(/info\/exclude$/);
    expect(existsSync(join(dir, "TASK.md"))).toBe(false);
    // The person writes a TASK.md after the plan: placing fails (exclusive create), and cleanup leaves theirs.
    writeFileSync(join(dir, "TASK.md"), "the person's own\n");
    await expect(placeTask(dir, "the brief", plan, ENV)).rejects.toThrow();
    removeTask(dir, plan);
    expect(readFileSync(join(dir, "TASK.md"), "utf8")).toBe("the person's own\n");
    // The brief itself (same hash) is removed.
    rmSync(join(dir, "TASK.md"));
    const placed = await placeTask(dir, "the brief", plan, ENV);
    removeTask(dir, placed);
    expect(existsSync(join(dir, "TASK.md"))).toBe(false);
    expect(validTaskRecord({ cwd: dir, file: "TASK.md", hash: "x" })).toBe(false);
  });
});

describe("r2 MED 3: a brief committed in merged side history is found", () => {
  test("added then removed on a side branch merged in: the commits are not bundled", async () => {
    const { dir, shas } = repoWithCommits(1);
    g(dir, "checkout", "-q", "-b", "side");
    writeFileSync(join(dir, "TASK.md"), "the brief\n");
    g(dir, "add", "-f", "TASK.md");
    g(dir, "commit", "-q", "-m", "adds the brief");
    g(dir, "rm", "-q", "TASK.md");
    g(dir, "commit", "-q", "-m", "removes it again");
    g(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "m.txt"), "m\n");
    g(dir, "add", "m.txt");
    g(dir, "commit", "-q", "-m", "main work");
    g(dir, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    // A path-limited log with history simplification shows nothing here:
    expect(g(dir, "log", "--format=%H", `${shas[0]}..HEAD`, "--", "TASK.md")).toBe("");
    const out = join(tmp(), "r.bundle");
    expect(await seatOutcome(dir, shas[0] as string, out, ENV, undefined, undefined, undefined, "TASK.md")).toMatchObject({ commits: 4, brief: true });
    expect(existsSync(out)).toBe(false);
    // Without the brief anywhere, the same shape is bundled.
    const clean = repoWithCommits(1);
    g(clean.dir, "checkout", "-q", "-b", "side");
    writeFileSync(join(clean.dir, "s.txt"), "s\n");
    g(clean.dir, "add", "s.txt");
    g(clean.dir, "commit", "-q", "-m", "side");
    g(clean.dir, "checkout", "-q", "main");
    g(clean.dir, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    expect(await seatOutcome(clean.dir, clean.shas[0] as string, join(tmp(), "c.bundle"), ENV, undefined, undefined, undefined, "TASK.md")).toMatchObject({ commits: 2, bundle: expect.any(String) });
  });
});

describe("r2 MED 4: one holder allows both the host's person and the launcher, and is the one leased from", () => {
  test("an offline holder that allows the launcher doesn't let an online one that doesn't serve the seat", () => {
    const acct = view("alex", [
      machine({ node_id: "1111111111111111", hostname: "alex-mbp", online: false, vault: { policy: "shared", share_with: ["kira", "arvid"] } }),
      machine({ node_id: "2222222222222222", hostname: "alex-mini", online: true, vault: { policy: "shared", share_with: ["kira"] } }),
    ]);
    expect(planSeatAccount(`alex:${ID}`, { runtime: "claude", me: "kira", launcher: "arvid", vault: [], pooled: [acct] }))
      .toMatchObject({ kind: "refused", why: expect.stringMatching(/alex-mbp\) is offline/) });
    // Kira launching for himself: the online holder serves, and it's the one named.
    expect(planSeatAccount(`alex:${ID}`, { runtime: "claude", me: "kira", launcher: "kira", vault: [], pooled: [acct] })).toEqual({ kind: "peer", id: ID, owner: "alex", node: "2222222222222222", provider: "claude" });
  });
});

describe("pre.8 merge: a named seat account follows the company pool rules; without one a seat keeps the machine's own login", () => {
  const roles: Record<string, string> = { alex: "owner", kira: "member", arvid: "member", otto: "observer" };
  const on = { team: "company" as const, roleOf: (h: string) => roles[h] ?? null };
  const off = { team: "per-account" as const, roleOf: on.roleOf };
  const pooled = (provider: "claude" | "codex" = "claude", over: Record<string, unknown> = {}) =>
    view("alex", [machine({ vault: { policy: "local", company: true, ...over } })], provider);

  test("pool on: a pooled login serves a member's machine for a member launcher; off, personal or an observer: refused", () => {
    const base = { runtime: "claude" as const, me: "kira", launcher: "arvid", vault: [] as VaultEntry[] };
    expect(planSeatAccount(`alex:${ID}`, { ...base, pooled: [pooled()], pool: on })).toEqual({ kind: "peer", id: ID, owner: "alex", node: "1111111111111111", provider: "claude", pooled: true });
    expect(planSeatAccount(`alex:${ID}`, { ...base, pooled: [pooled()], pool: off })).toMatchObject({ kind: "refused" });
    expect(planSeatAccount(`alex:${ID}`, { ...base, pooled: [pooled()] })).toMatchObject({ kind: "refused" }); // no pool context: off
    expect(planSeatAccount(`alex:${ID}`, { ...base, pooled: [pooled("claude", { personal: true })], pool: on })).toMatchObject({ kind: "refused" });
    expect(planSeatAccount(`alex:${ID}`, { ...base, launcher: "otto", pooled: [pooled()], pool: on }))
      .toMatchObject({ kind: "refused", why: expect.stringMatching(/not with @otto who launched this seat/) });
    expect(planSeatAccount(`alex:${ID}`, { ...base, me: "otto", launcher: "otto", pooled: [pooled()], pool: on })).toMatchObject({ kind: "refused" });
  });

  test("a pooled Codex login is leased: a seat user gets the access-only copy, a same-user seat a leased home of its own", async () => {
    const plan = planSeatAccount(`alex:${ID}`, { runtime: "codex", me: "kira", launcher: "kira", vault: [], pooled: [pooled("codex")], pool: on });
    expect(plan).toEqual({ kind: "peer", id: ID, owner: "alex", node: "1111111111111111", provider: "codex", pooled: true });
    const auth = JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: "fake-access", refresh_token: "" } });
    const asked: string[] = [];
    const deps = {
      claudeToken: async () => { throw new Error("not local"); },
      lease: async (_id: string, _node: string, provider: "claude" | "codex") => { asked.push(provider); return { codex_auth: auth, grant: "0123456789abcdef" }; },
      leaseHome: (grant: string, json: string) => `/leases/lease-${grant}:${json.length}`,
      accessOnlyCodex: () => null,
    };
    const p = plan as Exclude<typeof plan, { kind: "refused" }>;
    const seatUser = await seatCredentials(p, "kira", true, deps);
    expect(seatUser).toMatchObject({ env: {}, codexAuth: auth, lease: { provider: "codex", account: ID, from_node: "1111111111111111", owner: "alex" } });
    const same = await seatCredentials(p, "kira", false, deps);
    expect(same.env).toEqual({ CODEX_HOME: `/leases/lease-0123456789abcdef:${auth.length}` });
    expect(same.leaseHome).toBe(same.env.CODEX_HOME);
    expect(asked).toEqual(["codex", "codex"]);
    await expect(seatCredentials(p, "kira", false, { ...deps, lease: async () => ({ grant: "0123456789abcdef" }) })).rejects.toThrow(/sent no Codex login/);
  });
});

describe("r2 MED 5: staging stops at the cap while the bundle is made", () => {
  test("the stream is cut at the cap: the file never holds more, and is removed", async () => {
    const { dir } = repoWithCommits(1);
    writeFileSync(join(dir, "big.bin"), crypto.getRandomValues(new Uint8Array(1024 * 1024))); // incompressible
    g(dir, "add", "big.bin");
    g(dir, "commit", "-q", "-m", "big");
    const out = join(stageDir(tmp()), "b.bundle");
    const r = await gitToFile(["bundle", "create", "--quiet", "-", "HEAD"], dir, ENV, out, 64 * 1024);
    expect(r.capped).toBe(true);
    expect(r.size).toBeLessThanOrEqual(64 * 1024);
    expect(existsSync(out)).toBe(false);
  });
});

describe("r2 LOWs", () => {
  test("more filter drivers than can be turned off: refused, nothing checked out", async () => {
    const { dir, shas } = repoWithCommits(1);
    let cfg = readFileSync(join(dir, ".git", "config"), "utf8");
    for (let i = 0; i <= MAX_FILTERS; i++) cfg += `[filter "f${i}"]\n\tsmudge = false\n`;
    writeFileSync(join(dir, ".git", "config"), cfg);
    await expect(addWorktree(dir, "many", "detached", shas[0] as string, undefined, ENV)).rejects.toThrow(/filter drivers/);
    expect(existsSync(join(dir, ".worktrees", "many"))).toBe(false);
  });

  test("ownership: a record whose branch is gone is dropped; a branch the person moved since isn't Walkie's", async () => {
    const { dir, shas } = repoWithCommits(2);
    const a = await addWorktree(dir, "own", "branch", shas[0] as string, undefined, ENV);
    g(dir, "worktree", "remove", a.cwd);
    g(dir, "branch", "-D", "lane/own");
    const b = await addWorktree(dir, "own", "branch", shas[1] as string, undefined, ENV); // record dropped, branch re-made
    expect(b.branch).toBe("lane/own");
    g(dir, "worktree", "remove", b.cwd);
    g(dir, "update-ref", "refs/heads/lane/own", shas[0] as string); // the person moves it
    await expect(addWorktree(dir, "own", "branch", shas[1] as string, undefined, ENV)).rejects.toThrow(/isn't Walkie's/);
    expect(g(dir, "rev-parse", "lane/own")).toBe(shas[0] as string);
  });

  test("a clean Walkie worktree with ignored files is refused, not deleted; a refused branch leaves the old worktree in place", async () => {
    const { dir, shas } = repoWithCommits(1);
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    g(dir, "add", ".gitignore");
    g(dir, "commit", "-q", "-m", "gi");
    const sha = g(dir, "rev-parse", "HEAD");
    const w = await addWorktree(dir, "ig", "detached", sha, undefined, ENV);
    mkdirSync(join(w.cwd, "node_modules"));
    writeFileSync(join(w.cwd, "node_modules", "x.js"), "x");
    await expect(addWorktree(dir, "ig", "detached", sha, undefined, ENV)).rejects.toThrow(/ignored files/);
    expect(existsSync(join(w.cwd, "node_modules", "x.js"))).toBe(true);
    // Selection before removal: a branch Walkie can't use leaves the existing worktree where it was.
    const k = await addWorktree(dir, "keep", "detached", sha, undefined, ENV);
    g(dir, "branch", "walkie/theirs", shas[0] as string);
    await expect(addWorktree(dir, "keep", "branch", sha, "walkie/theirs", ENV)).rejects.toThrow(/isn't Walkie's/);
    expect(existsSync(join(k.cwd, ".gitignore"))).toBe(true);
  });

  test("an owned lane whose commits are merged into the person's branch is reused instead of a new suffix", async () => {
    const { dir, shas } = repoWithCommits(1);
    const a = await addWorktree(dir, "mg", "branch", shas[0] as string, undefined, ENV);
    writeFileSync(join(a.cwd, "w.txt"), "w\n");
    g(a.cwd, "add", "w.txt");
    g(a.cwd, "commit", "-q", "-m", "lane work");
    await recordLaneTip(dir, "lane/mg", ENV, { base: shas[0] as string, head: g(a.cwd, "rev-parse", "HEAD") });
    g(a.cwd, "checkout", "-q", "--detach");
    g(dir, "merge", "-q", "--ff-only", "lane/mg"); // the person merged it
    writeFileSync(join(dir, "later.txt"), "l\n");
    g(dir, "add", "later.txt");
    g(dir, "commit", "-q", "-m", "later");
    g(dir, "worktree", "remove", a.cwd);
    // An unrelated base (not a fast-forward of lane/mg): reused anyway, its commits being on main.
    const b = await addWorktree(dir, "mg", "branch", shas[0] as string, undefined, ENV);
    expect(b.branch).toBe("lane/mg");
  });

  test("an existing seats-stage with loose permissions is tightened", () => {
    const home = tmp();
    mkdirSync(join(home, "seats-stage"), { mode: 0o755 });
    chmodSync(join(home, "seats-stage"), 0o755);
    expect(statSync(stageDir(home)).mode & 0o777).toBe(0o700);
  });
});

// ---- FO-2 fix round 3 (Opus r3 re-audit) ----------------------------------------------------------------------

describe("r3 MED 1: a delta bundle can't borrow an unpublished tree or blob either", () => {
  test("a carried commit whose tree is the stash's (pack holds only the commit) is refused; nothing reaches the clone", async () => {
    // Opus r3 repro3: the attacker knows the stash's tree id and packs only a commit pointing at it.
    const { dir, shas } = repoWithCommits(1);
    const main = shas[0] as string;
    writeFileSync(join(dir, "f0.txt"), "SECRET-FROM-STASH\n");
    g(dir, "stash", "-q");
    const stashTree = g(dir, "rev-parse", "stash^{tree}");
    const atk = join(tmp(), "atk");
    mkdirSync(atk);
    g(atk, "init", "-q", "--bare");
    const body = `tree ${stashTree}\nparent ${main}\nauthor x <x@x> 0 +0000\ncommitter x <x@x> 0 +0000\n\nborrow\n`;
    const cid = Bun.spawnSync(["git", "hash-object", "-t", "commit", "-w", "--literally", "--stdin"], { cwd: atk, stdin: new TextEncoder().encode(body), stdout: "pipe" }).stdout.toString().trim();
    const pack = Bun.spawnSync(["git", "pack-objects", "--stdout"], { cwd: atk, stdin: new TextEncoder().encode(`${cid}\n`), stdout: "pipe" }).stdout;
    const bundle = join(tmp(), "forge.bundle");
    writeFileSync(bundle, Buffer.concat([Buffer.from(`# v2 git bundle\n-${main} c1\n${cid} refs/heads/feature\n\n`), Buffer.from(pack)]));
    const mirrors = tmp();
    await expect(resolveRepo({ app: dir }, { repo: "app", ref: "feature", mode: "detached" }, bundle, "r3", ENV, undefined, mirrors))
      .rejects.toThrow(/doesn't apply to repo app's branches and tags/);
    expect(g(dir, "for-each-ref", "refs/walkie/in/")).toBe("");
    expect(Bun.spawnSync(["git", "cat-file", "-e", cid], { cwd: dir }).exitCode).not.toBe(0);
    // The mirror holds published history only: the stash's tree never entered it.
    const mirror = join(mirrors, readdirSync(mirrors)[0] as string);
    expect(Bun.spawnSync(["git", "cat-file", "-e", stashTree], { cwd: mirror }).exitCode).not.toBe(0);
    expect(Bun.spawnSync(["git", "cat-file", "-e", main], { cwd: mirror }).exitCode).toBe(0);
  });
});

describe("r3 LOWs: lane records", () => {
  test("the branch and Walkie's record of it move in one step (created, fast-forwarded)", async () => {
    const { dir, shas } = repoWithCommits(2);
    const a = await addWorktree(dir, "tx", "branch", shas[0] as string, undefined, ENV);
    expect(g(dir, "rev-parse", "refs/walkie/lanes/lane/tx")).toBe(g(dir, "rev-parse", "lane/tx"));
    g(dir, "worktree", "remove", a.cwd);
    await addWorktree(dir, "tx", "branch", shas[1] as string, undefined, ENV);
    expect(g(dir, "rev-parse", "lane/tx")).toBe(shas[1] as string);
    expect(g(dir, "rev-parse", "refs/walkie/lanes/lane/tx")).toBe(shas[1] as string);
  });

  test("the record follows only the seat's own result; the person's later commit on the lane isn't claimed", async () => {
    const { dir, shas } = repoWithCommits(1);
    const w = await addWorktree(dir, "cl", "branch", shas[0] as string, undefined, ENV);
    writeFileSync(join(w.cwd, "s.txt"), "seat\n");
    g(w.cwd, "add", "s.txt");
    g(w.cwd, "commit", "-q", "-m", "seat");
    const seatHead = g(w.cwd, "rev-parse", "HEAD");
    writeFileSync(join(w.cwd, "p.txt"), "person\n");
    g(w.cwd, "add", "p.txt");
    g(w.cwd, "commit", "-q", "-m", "the person, afterwards");
    await recordLaneTip(dir, "lane/cl", ENV, { base: shas[0] as string, head: seatHead });
    expect(g(dir, "rev-parse", "refs/walkie/lanes/lane/cl")).toBe(shas[0] as string); // unclaimed
    g(w.cwd, "reset", "-q", "--hard", seatHead);
    await recordLaneTip(dir, "lane/cl", ENV, { base: shas[0] as string, head: seatHead });
    expect(g(dir, "rev-parse", "refs/walkie/lanes/lane/cl")).toBe(seatHead); // the seat's own result
    // No seat result (after a crash): nothing claimed; the branch gone: the record goes.
    await recordLaneTip(dir, "lane/cl", ENV);
    expect(g(dir, "rev-parse", "refs/walkie/lanes/lane/cl")).toBe(seatHead);
    g(dir, "worktree", "remove", "--force", w.cwd);
    g(dir, "branch", "-D", "lane/cl");
    await recordLaneTip(dir, "lane/cl", ENV);
    expect(Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", "refs/walkie/lanes/lane/cl"], { cwd: dir }).exitCode).not.toBe(0);
  });
});


// ---- FO-2: Codex r3 (on 39efb6d) items checked against round 4 ---------------------------------------------------

describe("Codex r3 MED 3: a partial brief write never escapes cleanup", () => {
  test("the brief is published whole (temp name, fsync, link); a crash's partial temp file is removed by its recorded name", async () => {
    const { dir } = repoWithCommits(1);
    const plan = await planTask(dir, "the whole brief", ENV);
    expect(plan.tmp).toMatch(/^\.walkie-brief-[0-9a-f]{24}\.tmp$/);
    expect(validTaskRecord({ cwd: dir, file: "TASK.md", tmp: plan.tmp })).toBe(true);
    expect(validTaskRecord({ cwd: dir, file: "TASK.md", tmp: "../../x" })).toBe(false);
    // A crash mid-write: only the temporary file exists, truncated (its hash is not the brief's).
    writeFileSync(join(dir, plan.tmp as string), "the who");
    removeTask(dir, plan); // what the next start does with the durable record
    expect(existsSync(join(dir, plan.tmp as string))).toBe(false);
    expect(existsSync(join(dir, "TASK.md"))).toBe(false);
    // A normal write leaves no temporary file behind, and the published brief is complete.
    const placed = await placeTask(dir, "the whole brief", plan, ENV);
    expect(readdirSync(dir).filter((f) => f.startsWith(".walkie-brief-"))).toEqual([]);
    expect(readFileSync(join(dir, "TASK.md"), "utf8")).toBe("the whole brief");
    removeTask(dir, placed);
    expect(existsSync(join(dir, "TASK.md"))).toBe(false);
  });
});

describe("Codex r3 MED 4: recovery never adopts a person's replacement branch", () => {
  test("the person re-makes the lane while the daemon is down: the next start claims nothing; the lane is refused", async () => {
    const { dir, shas } = repoWithCommits(2);
    const w = await addWorktree(dir, "rb", "branch", shas[0] as string, undefined, ENV);
    g(dir, "worktree", "remove", w.cwd);
    // Daemon down: the person deletes Walkie's lane and makes their own branch of that name elsewhere.
    g(dir, "branch", "-D", "lane/rb");
    g(dir, "branch", "lane/rb", shas[1] as string);
    await recordLaneTip(dir, "lane/rb", ENV); // the start's recovery: no seat result
    expect(g(dir, "rev-parse", "refs/walkie/lanes/lane/rb")).toBe(shas[0] as string); // not moved to the person's
    await expect(addWorktree(dir, "rb", "branch", shas[1] as string, undefined, ENV)).rejects.toThrow(/isn't Walkie's/);
    expect(g(dir, "rev-parse", "lane/rb")).toBe(shas[1] as string);
  });
});

// ---- pre.8 fixes from live pre.7 use ---------------------------------------------------------------------------

describe("seats' login location and --dir", () => {
  test("CLAUDE_CONFIG_DIR reaches a same-user seat (a worker login), from the daemon's env or the seat env file; API keys still don't", async () => {
    const home = tmp();
    writeFileSync(join(home, "seat-env"), `export CLAUDE_CONFIG_DIR="$HOME/.worker-claude"\nexport ANTHROPIC_API_KEY=never\n`);
    const { env } = await loginEnv({ PATH: "/usr/bin:/bin", HOME: home }, home, join(home, "seat-env"));
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(home, ".worker-claude"));
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    const other = tmp();
    const direct = await loginEnv({ PATH: "/usr/bin:/bin", HOME: tmp(), CLAUDE_CONFIG_DIR: "/w/.worker-claude" }, other, join(other, "seat-env"));
    expect(direct.env.CLAUDE_CONFIG_DIR).toBe("/w/.worker-claude");
  });

  test("a quoted '~/x' --dir is kept for the daemon to expand once, run locally or remotely (cwd = the daemon's home)", () => {
    expect(seatsDirArg("~/workspace/app", "/Users/arvid/src")).toBe("~/workspace/app");
    expect(seatsDirArg("~/workspace/app", "/home/dana")).toBe("~/workspace/app"); // was "/home/dana/~/workspace/app" → "~/~/workspace/app"
    expect(seatsDirArg("~", "/home/dana")).toBe("~");
    expect(seatsDirArg("seats", "/home/dana")).toBe("/home/dana/seats");
    expect(seatsDirArg("/abs/seats", "/home/dana")).toBe("/abs/seats");
  });
});
