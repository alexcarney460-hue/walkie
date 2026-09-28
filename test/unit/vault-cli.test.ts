// ACCOUNTS-2 CLI: `walkie accounts add|remove|policy` are for a person at a terminal (agents and terminal-less runs
// are refused); `pick` and `exec` work for scripts. Never the real Keychain (file key store), never a daemon.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Vault } from "../../src/accounts/vault/vault.ts";
import { fileKeyStore } from "../../src/accounts/vault/keystore.ts";
import { AGENT_ENV_MARKERS, type ProcRow } from "../../src/cli/agent-detect.ts";
import type { Args } from "../../src/cli/args.ts";
import { AGENT_TTY, addClaude, person, tokenReader, vaultCommand } from "../../src/cli/commands/vault.ts";
import { importClaudeLogin } from "../../src/accounts/vault/import.ts";
import { poolNoticeLines } from "../../src/cli/commands/accounts-pool.ts";
import type { Ctx } from "../../src/cli/context.ts";
import { setTtyForTests, type Tty } from "../../src/cli/tty.ts";

const TOKEN = ("sk" + "-ant-oat01-FAKECLITOKEN0123456789abcdefghijklmnop");
let home = "";
const saved: Record<string, string | undefined> = {};
// pre.3 moved the markers to agent-detect.ts (exact names only: AGENT_ENV_MARKERS).
const agentKeys = () => Object.keys(process.env).filter((k) => (AGENT_ENV_MARKERS as readonly string[]).includes(k));

beforeEach(() => {
  home = mkdtempSync("/tmp/walkie-vcli-");
  // This suite may itself run under an agent: the person checks need a clean environment.
  for (const k of [...agentKeys(), "WALKIE_HOME", "WALKIE_SOCKET", "WALKIE_VAULT_KEYSTORE"]) saved[k] = process.env[k];
  for (const k of agentKeys()) delete process.env[k];
  process.env.WALKIE_HOME = home;
  process.env.WALKIE_SOCKET = join(home, "none.sock");
  process.env.WALKIE_VAULT_KEYSTORE = "file";
});
afterEach(() => {
  setTtyForTests(undefined);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(home, { recursive: true, force: true });
});

function scripted(answers: string[]): Tty & { asked: string[] } {
  const asked: string[] = [];
  return { asked, ask: async (q) => { asked.push(q); return answers.shift() ?? ""; }, secret: async (q) => { asked.push(q); return answers.shift() ?? ""; }, close: () => undefined };
}
function ctx(pos: string[], flags: Record<string, string | true> = {}, json = false) {
  const out: string[] = [];
  const err: string[] = [];
  const args: Args = { pos, flags: new Map(Object.entries(flags)) };
  // A person's terminal (no agent among the ancestors), whatever runs this suite.
  const agentSignals = () => ({ marker: null, inspection: "ok" as const });
  return { c: { args, json, forAgent: false, agentSignals, client: () => { throw new Error("no daemon in this test"); }, out: (s: string) => out.push(s), err: (s: string) => err.push(s) } as unknown as Ctx, out, err };
}

describe("people only", () => {
  test("AGENT-ADMIN-1: an agent session (or no terminal) goes ahead as its person's agent; CODEX_HOME alone is not an agent", () => {
    const bare = { args: { pos: [], flags: new Map() } as Args };
    const noAgent = () => new Map<number, ProcRow>([[process.ppid, { ppid: 1, command: "-zsh" }], [1, { ppid: 0, command: "/sbin/launchd" }]]);
    setTtyForTests(scripted([]));
    expect(person(bare, "walkie accounts add", { env: { CLAUDECODE: "1" }, table: noAgent, home })).toBe(AGENT_TTY);
    setTtyForTests(null);
    expect(person(bare, "walkie accounts add", { env: {}, table: noAgent, home })).toBe(AGENT_TTY);
    const t = scripted([]);
    setTtyForTests(t);
    expect(person(bare, "walkie accounts add", { env: { CODEX_HOME: "/x" }, table: noAgent, home })).toBe(t);
  });

  test("the shared detection (--for-agent, a marker-free process under claude) marks an agent; agent admin off refuses it", async () => {
    setTtyForTests(scripted(["n"])); // a terminal that would answer: the agent never uses it
    const flagged = { args: { pos: [], flags: new Map<string, string | true>([["for-agent", true]]) } as Args };
    const bare = { args: { pos: [], flags: new Map() } as Args };
    const noAgent = () => new Map<number, ProcRow>([[process.ppid, { ppid: 1, command: "-zsh" }], [1, { ppid: 0, command: "/sbin/launchd" }]]);
    const underClaude = () => new Map<number, ProcRow>([[process.ppid, { ppid: 40, command: "/bin/sh -c walkie accounts policy x own" }], [40, { ppid: 1, command: "/Users/u/.local/bin/claude" }], [1, { ppid: 0, command: "/sbin/launchd" }]]);
    expect(person(flagged, "walkie accounts policy", { env: {}, table: noAgent, home })).toBe(AGENT_TTY);
    expect(person(bare, "walkie accounts policy", { env: {}, table: underClaude, home })).toBe(AGENT_TTY);
    expect(await AGENT_TTY.ask("Let x be used from your own machines? [y/N] ")).toBe("y");
    expect(await AGENT_TTY.ask("Number: ")).toBe("");
    writeFileSync(join(home, "config.json"), JSON.stringify({ agent_admin: false }));
    expect(() => person(bare, "walkie accounts policy", { env: {}, table: underClaude, home })).toThrow(/agent admin is off/);
  });

  test("add claude with nothing pasted imports this machine's login when it is long-lived; a session token is refused", async () => {
    const fakeHome = mkdtempSync("/tmp/walkie-cchome-");
    try {
      const creds = (expiresAt: number | null) => writeFileSync(join(fakeHome, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt } }));
      mkdirSync(join(fakeHome, ".claude"));
      const noKeychain = async () => null;
      creds(Date.now() + 365 * 86_400_000);
      expect(await importClaudeLogin({ env: {}, home: fakeHome, keychain: noKeychain })).toEqual({ token: TOKEN, source: "this machine's Claude login" });
      creds(Date.now() + 8 * 3_600_000);
      const short = await importClaudeLogin({ env: {}, home: fakeHome, keychain: noKeychain });
      expect("why" in short && short.why).toMatch(/session token that expires in about 8 h/);
      expect(await importClaudeLogin({ env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, home: fakeHome, keychain: noKeychain })).toEqual({ token: TOKEN, source: "CLAUDE_CODE_OAUTH_TOKEN" });
      rmSync(join(fakeHome, ".claude", ".credentials.json"));
      expect("why" in (await importClaudeLogin({ env: {}, home: fakeHome, keychain: noKeychain }))).toBe(true);
      // The CLI path: an agent gives no token (empty stdin), the import supplies it and the vault stores it, confirmed by the agent.
      creds(null);
      const v = Vault.open(home, { keystore: fileKeyStore(home) });
      const notes: string[] = [];
      const read = tokenReader(AGENT_TTY, () => importClaudeLogin({ env: {}, home: fakeHome, keychain: noKeychain }), (l) => notes.push(l), async () => "");
      const e = await addClaude(ctx(["add", "claude"]).c, v, AGENT_TTY, home, read);
      expect(await v.claudeToken(e.id)).toBe(TOKEN);
      expect(notes).toEqual(["imported this machine's Claude login"]);
      v.close();
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("trust-cli and shims install ask for the same confirmation; a no changes nothing", async () => {
    setTtyForTests(scripted(["n"]));
    const t = ctx(["trust-cli"]);
    expect(await vaultCommand(t.c, "trust-cli")).toBe(1);
    expect(t.out).toEqual([]);
    const tty = scripted(["n"]);
    setTtyForTests(tty);
    const s = ctx(["shims", "install"]);
    expect(await vaultCommand(s.c, "shims")).toBe(1);
    expect(tty.asked.join("\n")).toMatch(/Install the claude \/ codex shims/);
    expect(existsSync(join(home, "bin", "claude"))).toBe(false);
  });

  test("add claude: confirmed at the terminal, stored encrypted with a masked label (the full email is never kept)", async () => {
    const tty = scripted(["y"]);
    const v = Vault.open(home, { keystore: fileKeyStore(home) });
    const { c } = ctx(["add", "claude"], { email: "zed.person@example.com", plan: "Max" });
    const e = await addClaude(c, v, tty, home, async () => TOKEN);
    expect(e.label).toBe("ze***@ex***.com");
    expect(e.plan).toBe("Max");
    expect(await v.claudeToken(e.id)).toBe(TOKEN);
    expect(readFileSync(join(home, "vault.db")).toString("latin1")).not.toContain("zed.person");
    const no = scripted(["n"]);
    await expect(addClaude(ctx(["add", "claude"]).c, v, no, home, async () => TOKEN.replace("FAKE", "OTHR"))).rejects.toThrow(/not stored/);
    v.close();
  });

  test("remove and policy go through the same terminal confirmation", async () => {
    const v = Vault.open(home, { keystore: fileKeyStore(home) });
    await v.addClaude({ id: "a".repeat(24), label: "al***@ex***.com", plan: null, token: TOKEN, linked: false });
    v.close();
    setTtyForTests(scripted(["y"]));
    const p = ctx(["policy", "aaaaaa", "shared"], { with: "kira,@arvid" });
    expect(await vaultCommand(p.c, "policy")).toBe(0);
    expect(p.out.join("\n")).toContain("shared (kira, arvid)");
    setTtyForTests(scripted(["y"]));
    const r = ctx(["remove", "al***@ex***.com"]);
    expect(await vaultCommand(r.c, "remove")).toBe(0);
    const again = Vault.open(home, { keystore: fileKeyStore(home) });
    expect(again.list()).toEqual([]);
    again.close();
  });
});

describe("pick and exec (scripts and agents)", () => {
  test("pick --json names the account; exec runs the command on it (token in its environment) and releases the lease", async () => {
    const v = Vault.open(home, { keystore: fileKeyStore(home) });
    await v.addClaude({ id: "a".repeat(24), label: "al***@ex***.com", plan: null, token: TOKEN, linked: false });
    v.close();
    process.env.CLAUDECODE = "1"; // an agent may pick and exec
    const p = ctx(["pick"], { provider: "claude" }, true);
    expect(await vaultCommand(p.c, "pick")).toBe(0);
    expect(JSON.parse(p.out[0] as string)).toMatchObject({ account: "a".repeat(24), label: "al***@ex***.com", source: "local", room_pct: null });
    const outFile = join(home, "exec-out.txt");
    const countFile = join(home, "exec-leases.txt");
    const x = ctx(["exec", "/bin/sh", "-c", `printf '%s|%s|%s' "$CLAUDE_CODE_OAUTH_TOKEN" "$WALKIE_ACCOUNT" "$WALKIE_NO_SWITCH" > ${outFile}; ls ${join(home, "leases")} | wc -l | tr -d ' ' > ${countFile}; exit 7`], { provider: "claude" });
    expect(await vaultCommand(x.c, "exec")).toBe(7);
    expect(readFileSync(outFile, "utf8")).toBe(`${TOKEN}|${"a".repeat(24)}|1`);
    expect(readFileSync(countFile, "utf8").trim()).toBe("1"); // one lease while it ran
    expect(readdirSync(join(home, "leases")).length).toBe(0); // released after
    delete process.env.CLAUDECODE;
  });

  test("every account out: pick and exec exit 75 with the earliest reset", async () => {
    const v = Vault.open(home, { keystore: fileKeyStore(home) });
    await v.addClaude({ id: "a".repeat(24), label: "al***@ex***.com", plan: null, token: TOKEN, linked: false });
    v.close();
    const until = Date.now() + 3_600_000;
    const gen = Vault.open(home, { keystore: fileKeyStore(home) }).get("a".repeat(24))?.gen;
    // A reset the provider named (not exactly mark + 60 min, the signature of an older switcher's placeholder guess).
    writeFileSync(join(home, "account-marks.json"), JSON.stringify({ v: 1, marks: { ["a".repeat(24)]: { state: "exhausted", until, at: Date.now() - 1_000, reason: "five_hour", gen } } }));
    const p = ctx(["pick"], { provider: "claude" }, true);
    expect(await vaultCommand(p.c, "pick")).toBe(75);
    expect(JSON.parse(p.out[0] as string)).toMatchObject({ account: null, waiting_until: until });
    const x = ctx(["exec", "/usr/bin/true"], { provider: "claude" });
    expect(await vaultCommand(x.c, "exec")).toBe(75);
  });
});

describe("RESET-CLOCK-1 / COMPANY POOL at the command line", () => {
  test("pick routes by the remembered reset (from accounts.json, no daemon, no ping) and names the next account to free", async () => {
    const v = Vault.open(home, { keystore: fileKeyStore(home) });
    await v.addClaude({ id: "a".repeat(24), label: "al***@ex***.com", plan: null, token: TOKEN, linked: false });
    await v.addClaude({ id: "b".repeat(24), label: "bo***@ex***.com", plan: null, token: TOKEN.replace("FAKE", "FAKF"), linked: false });
    v.close();
    const now = Date.now();
    const clock = (resetsIn: number) => [{ kind: "session", scope: null, window_s: 18_000, resets_at: now + resetsIn, observed_at: now - 3_600_000, exhausted: true, source: "api" }];
    const rec = (id: string, resetsIn: number) => ({ id, provider: "claude", label: "x", plan: null, dir: `vault:${id}`, is_default: false, last_seen: now, reading: null, vault: true, clock: clock(resetsIn) });
    writeFileSync(join(home, "accounts.json"), JSON.stringify({ v: 1, records: [rec("a".repeat(24), 5 * 3_600_000), rec("b".repeat(24), 42 * 60_000)] }));
    const p = ctx(["pick"], { provider: "claude" }, true);
    expect(await vaultCommand(p.c, "pick")).toBe(75);
    const j = JSON.parse(p.out[0] as string);
    expect(j).toMatchObject({ account: null, waiting_until: now + 42 * 60_000, next_free: { at: now + 42 * 60_000, account: "b".repeat(24), label: "bo***@ex***.com", provider: "claude" } });
    expect(j.excluded.map((e: { why: string }) => e.why)).toEqual(["limit reached (remembered)", "limit reached (remembered)"]);
    const t = ctx(["pick"], { provider: "claude" });
    expect(await vaultCommand(t.c, "pick")).toBe(75);
    expect(t.out[0]).toMatch(/^no claude account has room; next account frees at (?:[A-Z][a-z]{2} )?\d{1,2}:\d{2} [AP]M, bo\*\*\*@ex\*\*\*\.com$/);
    const x = ctx(["exec", "/usr/bin/true"], { provider: "claude" });
    expect(await vaultCommand(x.c, "exec")).toBe(75);
    expect(JSON.parse(x.err[0] as string)).toMatchObject({ walkie: "all_accounts_exhausted", next_free: { account: "b".repeat(24) } });
  });

  test("pool on|off: only a team owner (or an owner's agent); turning it on tells the team in #general", async () => {
    const posts: Array<{ channel: string; text: string }> = [];
    const client = (role: string) => () => ({ me: async () => ({ role }), post: async (b: { channel: string; text: string }) => { posts.push(b); return {}; } });
    const asMember = ctx(["pool", "on"]);
    (asMember.c as unknown as { client: unknown }).client = client("member");
    await expect(vaultCommand(asMember.c, "pool")).rejects.toThrow(/only a team owner/);
    process.env.CLAUDECODE = "1"; // the owner's agent may (agent setup is allowed by design)
    const asOwner = ctx(["pool", "on"], {}, true);
    (asOwner.c as unknown as { client: unknown }).client = client("owner");
    expect(await vaultCommand(asOwner.c, "pool")).toBe(0);
    delete process.env.CLAUDECODE;
    expect(JSON.parse(asOwner.out[0] as string)).toMatchObject({ on: true, told_team: true });
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).vault_team_policy.policy).toBe("company");
    expect(posts).toEqual([{ channel: "general", text: expect.stringContaining("walkie accounts personal <account>") }]);
    const off = ctx(["pool", "off"]);
    (off.c as unknown as { client: unknown }).client = client("owner");
    expect(await vaultCommand(off.c, "pool")).toBe(0);
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).vault_team_policy.policy).toBe("per-account");
    expect(posts.length).toBe(1);
    await expect(vaultCommand(ctx(["pool", "everyone"]).c, "pool")).rejects.toThrow(/on, off or status/);
  });

  test("personal [off] and promote: a person confirms at the terminal; an agent only while agent admin is on (pre.8 merge)", async () => {
    const v = Vault.open(home, { keystore: fileKeyStore(home) });
    await v.addClaude({ id: "a".repeat(24), label: "al***@ex***.com", plan: null, token: TOKEN, linked: false });
    v.close();
    setTtyForTests(scripted(["y"]));
    expect(await vaultCommand(ctx(["personal", "al***@ex***.com"]).c, "personal")).toBe(0);
    const reopened = () => Vault.open(home, { keystore: fileKeyStore(home) }).get("a".repeat(24));
    expect([reopened()?.personal, reopened()?.policy]).toEqual([true, "local"]); // its policy is untouched
    setTtyForTests(scripted(["y"]));
    expect(await vaultCommand(ctx(["personal", "a".repeat(24), "off"]).c, "personal")).toBe(0);
    expect(reopened()?.personal).toBe(false);
    setTtyForTests(scripted(["y"]));
    expect(await vaultCommand(ctx(["promote", "a".repeat(24)]).c, "promote")).toBe(0);
    expect(reopened()?.home_at).toBeGreaterThan(Date.now() - 60_000);
    const agent = ctx(["personal", "a".repeat(24)], { "for-agent": true });
    (agent.c as unknown as { agentSignals: () => unknown }).agentSignals = () => ({ marker: "--for-agent", inspection: "ok" });
    expect(await vaultCommand(agent.c, "personal")).toBe(0); // agent admin is on by default: audited, like accounts policy
    expect(reopened()?.personal).toBe(true);
    writeFileSync(join(home, "config.json"), JSON.stringify({ agent_admin: false }));
    await expect(vaultCommand(agent.c, "personal")).rejects.toThrow(/agent admin is off/);
    const promoter = ctx(["promote", "a".repeat(24)], { "for-agent": true });
    (promoter.c as unknown as { agentSignals: () => unknown }).agentSignals = () => ({ marker: "--for-agent", inspection: "ok" });
    await expect(vaultCommand(promoter.c, "promote")).rejects.toThrow(/agent admin is off/);
  });

  test("the pool notice: shown to each person once per time an owner turned it on; nothing while it is off", () => {
    expect(poolNoticeLines({ policy: "per-account", at: 5, by: "alex" }, home)).toEqual([]);
    const first = poolNoticeLines({ policy: "company", at: 5, by: "alex" }, home);
    expect(first.join("\n")).toContain("The company account pool is on");
    expect(first.join("\n")).toContain("walkie accounts personal <account>");
    expect(poolNoticeLines({ policy: "company", at: 5, by: "alex" }, home)).toEqual([]);
    expect(poolNoticeLines({ policy: "company", at: 9, by: "alex" }, home).length).toBe(2); // turned on again later
  });
});

