// COMPANY POOL, round 2 (Alex 2026-09-27: "Team setting, on for us"): a TEAM setting, off by default and fail-closed,
// persisted; an upgrade changes nothing; while on, every login not marked personal is lent to every member's machines
// (Claude setup-tokens as-is, Codex as a lease copy — never the refresh token or the email; the home is its one
// refresher and renews it); the 10 % personal reserve enforced by the router at any reading age, by the lender and
// during a session; lender alternatives; the fleet listing and a split that only uses reachable holders.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { select, selectOwnFirst, type Candidate } from "../../src/accounts/select.ts";
import { candidatesFrom } from "../../src/switch/accounts.ts";
import { Vault } from "../../src/accounts/vault/vault.ts";
import { fileKeyStore } from "../../src/accounts/vault/keystore.ts";
import { codexAccessOnly, codexLeaseCopy, isAccessOnly, jwtExpiry } from "../../src/accounts/vault/codex-access.ts";
import { isLeaseHome, processStart, removeLeaseHome, sweepLeaseHomes, writeLeaseHome } from "../../src/accounts/vault/codex-lease-home.ts";
import { effectiveTeamPolicy, localTeamPolicy, mayLeaseUnder, writeLocalTeamPolicy } from "../../src/accounts/pool.ts";
import { fleetView, splitLogin, suggestSplit } from "../../src/protocol/fleet.ts";
import { AccountsService, vaultOf } from "../../src/accounts/service.ts";
import { AccountsSnapshot, type AccountUsage, type AccountView, type ResetClock } from "../../src/protocol/accounts.ts";
import { nextFreeByProvider, parseCaps, poolNoticeLines, renderFleet, renderSplit } from "../../src/cli/commands/accounts-pool.ts";
import { grantLease, NonceBook, requestLease, type PeerLeaseReq } from "../../src/daemon/vault-lease.ts";
import { TeamPoolState } from "../../src/daemon/team-pool.ts";
import type { AppServerLauncher } from "../../src/accounts/resets.ts";
import type { SyncManager } from "../../src/daemon/sync.ts";
import type { VaultSource } from "../../src/accounts/service.ts";
import type { VaultEntry } from "../../src/accounts/vault/vault.ts";
import type { Core } from "../../src/daemon/core.ts";
import type { Logger } from "../../src/daemon/logger.ts";
import type { MemberRec } from "../../src/daemon/roster.ts";
import { ephemeralKey } from "../../src/accounts/vault/seal.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";

const root = mkdtempSync("/tmp/walkie-pool-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const dir = () => { const d = join(root, `d${n++}`); mkdirSync(d, { recursive: true }); return d; };
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });

const T0 = Date.UTC(2026, 8, 27, 19, 0, 0);
const H = 3_600_000;
const A = "a".repeat(24);
const B = "b".repeat(24);
const C = "c".repeat(24);
const TOKEN = "sk-ant-oat01-FAKEPOOLTOKEN0123456789abcdefghijklmn";

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (exp: number) => `${b64u({ alg: "none" })}.${b64u({ exp: Math.floor(exp / 1000), email: "x@example.test" })}.sig`;
const REFRESH = "rt_FAKEREFRESHTOKEN_never_leaves_home";
const codexAuth = (exp: number) => JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { access_token: jwt(exp), id_token: jwt(exp), refresh_token: REFRESH, account_id: "acct-1" }, last_refresh: "2026-09-27T00:00:00Z" });

const usage = (over: Partial<AccountUsage> = {}): AccountUsage => ({ at: T0, state: "ok", reason: null, source: "api", until: null, windows: [], ...over });
const clock = (over: Partial<ResetClock> = {}): ResetClock => ({ kind: "session", scope: null, window_s: 18_000, resets_at: T0 + 2 * H, observed_at: T0 - H, exhausted: true, source: "api", ...over });
const cand = (over: Partial<Candidate> = {}): Candidate => ({ id: A, provider: "claude", label: "al***@ex***.com", owner: "alex", own: true, source: "local", usage: null, leases: 0, ...over });

describe("company pool: the router across machines, the personal reserve", () => {
  const theirs = (over: Partial<Candidate> = {}) => cand({ id: B, owner: "kira", own: false, source: "peer", node: "n-kira", pooled: true, ...over });
  const room = (left: number) => usage({ windows: [{ kind: "session", used_pct: 100 - left, resets_at: T0 + H, window_s: 18_000, scope: null }] });

  test("a pooled teammate login is used when no own login can be picked (no opt-in, no share list)", () => {
    const own = cand({ unavailable: true, source: "peer" });
    const sel = selectOwnFirst([own, theirs({ usage: room(60) })], { provider: "claude", now: T0 });
    expect(sel.pick).toMatchObject({ id: B, owner: "kira", pooled: true });
    // A merely SHARED teammate login still needs every own login at its limit (round 2 rule kept).
    const shared = selectOwnFirst([own, theirs({ pooled: false, usage: room(60) })], { provider: "claude", now: T0 });
    expect(shared.pick).toBeNull();
  });

  test("the last 10 % of a pooled login is kept for its person; room ranks net of the reserve", () => {
    const sel = select([theirs({ usage: room(8) })], { provider: "claude", now: T0 });
    expect(sel.pick).toBeNull();
    expect(sel.excluded[0]?.why).toBe("kept for its person (the last 10%)");
    expect(select([theirs({ usage: room(50) })], { provider: "claude", now: T0 }).pick?.room).toBe(40);
    // Its own person is never held back by it.
    expect(select([cand({ usage: room(8), pooled: true })], { provider: "claude", now: T0 }).pick?.room).toBe(8);
  });

  const view = (over: Partial<AccountView> = {}): AccountView => ({
    key: `kira:${B}`, id: B, provider: "codex", label: "ky***@ex***.com", plan: "Pro", owners: ["kira"], claimed_by: [], usage: null, usage_host: null, last_seen: 1,
    machines: [{ node_id: "n-kira", hostname: "kira-mac", handle: "kira", online: true, self: false, agents: [], usage: null, vault: { policy: "own", company: true, home_at: 10 } }],
    leases: [], ...over,
  });
  const base = { provider: "codex" as const, entries: [], saved: new Map(), marks: {}, localLeases: new Map<string, number>() };
  const on = (over: Record<string, unknown> = {}) => ({ accounts: [view()], me: "alex", team: "company" as const, ...over });

  test("borrowed acquisition requires a fresh reserve reading; stale and absent usage fail closed", () => {
    const stale = usage({ at: T0 - 3 * H, windows: [{ kind: "weekly", used_pct: 92, resets_at: T0 + 3 * 24 * H, window_s: 604_800, scope: null }] });
    expect(select([theirs({ usage: stale })], { provider: "claude", now: T0 }).excluded[0]).toMatchObject({ why: "usage unknown: the last 10% kept for its person can't be checked", until: null });
    expect(select([theirs({ usage: null })], { provider: "claude", now: T0 }).excluded[0]?.why).toBe("usage unknown: the last 10% kept for its person can't be checked");
    // A reset inferred from an old reading still requires a fresh reading before borrowing.
    const reset = usage({ at: T0 - 3 * H, windows: [{ kind: "session", used_pct: 95, resets_at: T0 - H, window_s: 18_000, scope: null }] });
    expect(select([theirs({ usage: reset })], { provider: "claude", now: T0 }).pick).toBeNull();
  });

  test("while the team's pool is on every machine sees every pooled login (Codex too); observers, pool off and personal do not", () => {
    expect(candidatesFrom({ ...base, pooled: on() })).toEqual([
      expect.objectContaining({ id: B, provider: "codex", own: false, owner: "kira", source: "peer", node: "n-kira", pooled: true }),
    ]);
    expect(candidatesFrom({ ...base, pooled: on({ role: "observer" }) })).toEqual([]);
    expect(candidatesFrom({ ...base, pooled: on({ team: "per-account" }) })).toEqual([]);
    expect(candidatesFrom({ ...base, pooled: { accounts: [view()], me: "alex" } })).toEqual([]); // unknown = off
    const personal = view({ machines: [{ ...view().machines[0] as AccountView["machines"][number], vault: { policy: "own", personal: true, home_at: 10 } }] });
    expect(candidatesFrom({ ...base, pooled: on({ accounts: [personal] }) })).toEqual([]);
  });

  test("lenders: the newest online home first, the others kept as alternatives; a copy needing re-login is skipped", () => {
    const m = (id: string, home_at: number, online = true, relogin = false) => ({
      node_id: id, hostname: id, handle: "kira", online, self: false, agents: [],
      usage: relogin ? usage({ state: "relogin", reason: "login_expired" }) : null, vault: { policy: "own" as const, company: true as const, home_at },
    });
    const three = view({ machines: [m("n-old", 10), m("n-new", 20), m("n-mid", 15)] });
    expect(candidatesFrom({ ...base, pooled: on({ accounts: [three] }) })[0]).toMatchObject({ node: "n-new", nodes: ["n-new", "n-mid", "n-old"] });
    const broken = view({ machines: [m("n-old", 10), m("n-new", 20, true, true), m("n-gone", 30, false)] });
    const c = candidatesFrom({ ...base, pooled: on({ accounts: [broken] }) })[0];
    expect(c?.node).toBe("n-old");
    expect(c?.nodes).toBeUndefined();
  });

  test("mayLeaseUnder: own/shared as before; the pool needs the holder's company flag AND this machine knowing it is on", () => {
    const v = { policy: "local" as const, company: true as const };
    expect(mayLeaseUnder(v, "kira", "alex", "company", "member")).toBe(true);
    expect(mayLeaseUnder(v, "kira", "alex", "company", "observer")).toBe(false);
    expect(mayLeaseUnder(v, "kira", "alex", "per-account", "member")).toBe(false);
    expect(mayLeaseUnder({ policy: "own" }, "kira", "kira", "per-account", "member")).toBe(true);
    expect(mayLeaseUnder({ policy: "local" }, "kira", "kira", "company", "member")).toBe(false);
  });
});

describe("lease, never copy: one refresher per login", () => {
  test("the access-only copy drops the refresh token, carries an empty one (codex 0.156 needs the field), refuses a near-expired token", () => {
    const got = codexAccessOnly(codexAuth(T0 + 5 * 86_400_000), T0);
    expect(got).not.toBeNull();
    expect(got?.json).not.toContain(REFRESH);
    expect(JSON.parse(got?.json as string).tokens).toMatchObject({ refresh_token: "", account_id: "acct-1" });
    expect(got?.expiresAt).toBe(Math.floor((T0 + 5 * 86_400_000) / 1000) * 1000);
    expect(isAccessOnly(got?.json as string)).toBe(true);
    expect(isAccessOnly(codexAuth(T0 + H))).toBe(false); // a real refresh token is never accepted on the borrower
    expect(codexAccessOnly(codexAuth(T0 + 5 * 60_000), T0)).toBeNull();
    expect(codexAccessOnly(JSON.stringify({ OPENAI_API_KEY: "sk-proj-x" }), T0)).toBeNull();
    expect(jwtExpiry("not.a.jwt")).toBeNull();
  });

  test("the LEASE copy: no refresh token, no email (a claims-only id_token codex-cli accepts), last_refresh = now; never lent blind", () => {
    const lease = codexLeaseCopy(codexAuth(T0 + 5 * 86_400_000), T0);
    const o = JSON.parse(lease?.json as string) as { tokens: Record<string, string>; last_refresh: string };
    expect(lease?.json).not.toContain(REFRESH);
    // The id_token keeps only the plan and account id codex-cli reads; the person's email and name are dropped.
    const withClaims = JSON.stringify({ tokens: { access_token: jwt(T0 + 5 * 86_400_000), refresh_token: REFRESH, id_token: `${b64u({ alg: "none" })}.${b64u({ email: "pat@example.test", name: "Pat", "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_account_id: "acct-1", user_id: "u-9" } })}.sig` } });
    const claims = (json: string) => JSON.parse(Buffer.from((JSON.parse(json).tokens.id_token as string).split(".")[1] as string, "base64").toString());
    expect(claims(codexLeaseCopy(withClaims, T0)?.json as string)).toEqual({ "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_account_id: "acct-1" } });
    expect(claims(lease?.json as string)).toEqual({ "https://api.openai.com/auth": {} });
    expect(o.tokens.refresh_token).toBe("");
    expect(o.last_refresh).toBe(new Date(T0).toISOString());
    expect(isAccessOnly(lease?.json as string)).toBe(true);
    // An access token whose expiry cannot be read, or with under 30 minutes left: not lent.
    const noExp = JSON.stringify({ tokens: { access_token: "opaque-token", id_token: "x.y.z", refresh_token: REFRESH } });
    expect(codexLeaseCopy(noExp, T0)).toBeNull();
    expect(codexLeaseCopy(codexAuth(T0 + 20 * 60_000), T0)).toBeNull();
  });

  test("the vault reads a Codex login's access-only copy from its home; the file there keeps its refresh token", () => {
    const w = join(dir(), "w");
    const v = Vault.open(w, { keystore: fileKeyStore(w) });
    const home = join(w, "vault", "codex", B);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "auth.json"), codexAuth(Date.now() + 5 * 86_400_000), { mode: 0o600 });
    v.addCodex({ id: B, label: "ChatGPT account", plan: "Pro", home });
    const a = v.codexAccess(B);
    expect(v.codexExpiry(B)).toBe(Math.floor((Date.now() + 5 * 86_400_000) / 1000) * 1000);
    expect(a?.json).not.toContain(REFRESH);
    expect(readFileSync(join(home, "auth.json"), "utf8")).toContain(REFRESH); // the home machine's login is untouched
    v.close();
  });

  test("the borrower's leased CODEX_HOME: access-only only, 0700/0600, removed after the session; dead sessions swept", () => {
    const w = join(dir(), "w");
    const base = join(dir(), "codex-base");
    const json = codexAccessOnly(codexAuth(Date.now() + 5 * 86_400_000))?.json as string;
    expect(() => writeLeaseHome(w, base, "0123456789abcdef", codexAuth(Date.now() + 86_400_000))).toThrow(/access-only/);
    const home = writeLeaseHome(w, base, "0123456789abcdef", json);
    expect(isLeaseHome(home, w)).toBe(true);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "auth.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, "auth.json"), "utf8")).not.toContain(REFRESH);
    expect(existsSync(join(home, "sessions"))).toBe(true); // linked to the person's own sessions (resume works)
    expect(() => writeLeaseHome(w, base, "0123456789abcdef", json)).toThrow(); // one home per grant
    removeLeaseHome(home, w);
    expect(existsSync(home)).toBe(false);
    expect(existsSync(join(base, "sessions"))).toBe(true); // links unlinked, never followed
    expect(() => removeLeaseHome(base, w)).toThrow(/not a leased/);
    const stale = writeLeaseHome(w, base, "fedcba9876543210", json, 2 ** 30);
    const live = writeLeaseHome(w, base, "00000000000000aa", json, process.pid);
    // A reused pid (alive, but started at another time than the session that wrote the home) is stale too.
    const reused = writeLeaseHome(w, base, "00000000000000bb", json, process.pid);
    writeFileSync(join(reused, ".walkie-lease"), `${process.pid} Mon Jan  1 00:00:00 2001`);
    expect(processStart(process.pid)).not.toBeNull();
    expect(sweepLeaseHomes(w)).toBe(2);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(reused)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });
});

describe("the home machine lends (vault-lease)", () => {
  const logs: string[] = [];
  const spy: Logger = { debug: () => undefined, info: (m, f) => logs.push(JSON.stringify({ m, ...f })), warn: (m, f) => logs.push(JSON.stringify({ m, ...f })), error: (m, f) => logs.push(JSON.stringify({ m, ...f })) };
  function vault(entries: Partial<VaultEntry>[], codexJson: string | null = null): VaultSource {
    const list = entries.map((e) => ({ id: A, provider: "claude", label: "Claude account", plan: null, policy: "local", share_with: [], created_at: 1, expires_at: null, home: null, linked: false, gen: "g1", home_at: 1, personal: false, ...e }) as VaultEntry);
    return { list: () => list, claudeToken: async () => TOKEN, codexAccess: (_id, t) => (codexJson ? codexLeaseCopy(codexJson, t) : null) };
  }
  function owner() {
    const alex = tnode("alex");
    const { team, create } = createTeam(alex);
    const core = makeCore(alex, team, cleanups);
    core.ingest(create, "local");
    (core as unknown as { log: Logger }).log = spy;
    return { core, create, alex: { login: alex.login, handle: "alex", role: "owner" } as MemberRec };
  }
  const req = (account = A): PeerLeaseReq => {
    const key = ephemeralKey();
    return { account, epk: key.publicKey, nonce: crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), ""), ts: now() };
  };
  const kira: MemberRec = { login: "kira@example.com", handle: "kira", role: "member" };
  const obs: MemberRec = { login: "obs@example.com", handle: "obs", role: "observer" };
  const pool = (over: Record<string, unknown> = {}) => ({ vault: vault([{}]), sharing: false, nonces: new NonceBook(), teamPolicy: () => "company" as const, roomLeft: () => 50, ...over });

  test("pool OFF (the default, and after an upgrade): nothing changes — a teammate is refused, own/shared work as before", async () => {
    const { core, alex } = owner();
    await expect(grantLease(core, { vault: vault([{ policy: "own" }]), sharing: false, nonces: new NonceBook() }, "node-kira", kira, req(), now())).rejects.toMatchObject({ code: "not_allowed" });
    expect((await grantLease(core, { vault: vault([{ policy: "own" }]), sharing: false, nonces: new NonceBook() }, "node-alex-2", alex, req(), now())).owner).toBe("alex");
    const shared = { vault: vault([{ policy: "shared", share_with: ["kira"] }]), nonces: new NonceBook() };
    await expect(grantLease(core, { ...shared, sharing: false }, "node-kira", kira, req(), now())).rejects.toMatchObject({ code: "not_allowed" });
    expect((await grantLease(core, { ...shared, sharing: true, nonces: new NonceBook() }, "node-kira", kira, req(), now())).owner).toBe("alex");
  });

  test("pool ON: a member's machine gets a login not marked personal; never an observer; personal is honoured; OFF again stops new leases", async () => {
    const { core } = owner();
    expect((await grantLease(core, pool(), "node-kira", kira, req(), now())).owner).toBe("alex");
    await expect(grantLease(core, pool({ nonces: new NonceBook() }), "node-obs", obs, req(), now())).rejects.toMatchObject({ code: "not_allowed" });
    await expect(grantLease(core, pool({ nonces: new NonceBook(), vault: vault([{ personal: true }]) }), "node-kira", kira, req(), now())).rejects.toMatchObject({ code: "not_allowed" });
    await expect(grantLease(core, pool({ nonces: new NonceBook(), teamPolicy: () => "per-account" as const }), "node-kira", kira, req(), now())).rejects.toMatchObject({ code: "not_allowed" });
    expect(logs.join("\n")).not.toContain("FAKEPOOLTOKEN");
  });

  test("the lender keeps the last 10 % for its person (Codex p8 HIGH 2): at or under it, or with no current reading, it refuses", async () => {
    const { core, alex } = owner();
    await expect(grantLease(core, pool({ roomLeft: () => 10 }), "node-kira", kira, req(), now())).rejects.toMatchObject({ code: "reserved", status: 409 });
    await expect(grantLease(core, pool({ nonces: new NonceBook(), roomLeft: () => null }), "node-kira", kira, req(), now())).rejects.toMatchObject({ code: "reserved" });
    expect((await grantLease(core, pool({ nonces: new NonceBook(), roomLeft: () => 11 }), "node-kira", kira, req(), now())).owner).toBe("alex");
    // Its own person's other machines are never held back by it.
    expect((await grantLease(core, pool({ nonces: new NonceBook(), roomLeft: () => 2 }), "node-alex-2", alex, req(), now())).owner).toBe("alex");
  });

  test("a Codex login is leased (no refresh token, no email) end to end; the requester refuses a full copy; an unlendable one asks the home to renew", async () => {
    const own = owner();
    const alex2 = tnode("alex", "alex@example.com", "alex-mini");
    const requester = makeCore(alex2, own.core.teamId as string, cleanups);
    requester.ingest(own.create, "remote");
    const d = pool({ vault: vault([{ id: B, provider: "codex", home: "/x" }], codexAuth(Date.now() + 5 * 86_400_000)) });
    const call = async (_a: { ip: string; port: number }, b: PeerLeaseReq) => grantLease(own.core, d, requester.nodeId, kira, b, now());
    const got = await requestLease(requester, call, { account: B, node: own.core.nodeId, provider: "codex" }, now());
    expect(got.codex_auth).toBeDefined();
    expect(got.codex_auth).not.toContain(REFRESH);
    expect(got.token).toBeUndefined();
    expect(logs.join("\n")).not.toContain(REFRESH);
    await expect(requestLease(requester, call, { account: B, node: own.core.nodeId }, now())).rejects.toMatchObject({ code: "bad_lease" });
    const leaky = async (_a: { ip: string; port: number }, b: PeerLeaseReq) =>
      grantLease(own.core, { ...d, nonces: new NonceBook(), vault: { ...d.vault, codexAccess: () => ({ json: codexAuth(Date.now() + 86_400_000), expiresAt: null }) } }, requester.nodeId, kira, b, now());
    await expect(requestLease(requester, leaky, { account: B, node: own.core.nodeId, provider: "codex" }, now())).rejects.toMatchObject({ code: "bad_lease" });
    const renewals: string[] = [];
    const dry = { ...d, nonces: new NonceBook(), vault: vault([{ id: B, provider: "codex", home: "/x" }], null), renew: (id: string) => renewals.push(id) };
    await expect(grantLease(own.core, dry, requester.nodeId, kira, req(B), now())).rejects.toMatchObject({ code: "unavailable" });
    expect(renewals).toEqual([B]);
  });
});

describe("the team's pool setting: off by default, fail closed, persisted; an upgrade changes nothing", () => {
  test("the newest OWNER setting wins; members' settings are ignored; nothing known = off", () => {
    expect(effectiveTeamPolicy([])).toEqual({ policy: "per-account", at: null, by: null });
    expect(effectiveTeamPolicy([
      { role: "owner", handle: "alex", ad: { policy: "company", at: 5 } },
      { role: "member", handle: "kira", ad: { policy: "per-account", at: 9 } },
      { role: "owner", handle: "arvid", ad: { policy: "per-account", at: 3 } },
    ])).toEqual({ policy: "company", at: 5, by: "alex" });
  });

  test("`pool on` is written into config.json keeping the other keys", () => {
    const w = dir();
    writeFileSync(join(w, "config.json"), JSON.stringify({ accounts: true, vault_sharing: false }));
    writeLocalTeamPolicy(join(w, "config.json"), "company", 42);
    expect(JSON.parse(readFileSync(join(w, "config.json"), "utf8"))).toEqual({ accounts: true, vault_sharing: false, vault_team_policy: { policy: "company", at: 42 } });
    expect(localTeamPolicy(join(w, "config.json"))).toEqual({ policy: "company", at: 42 });
  });

  test("an upgrade changes nothing: existing logins keep their policy, are not personal and are not pooled while the pool is off", async () => {
    const w = join(dir(), "w");
    const v = Vault.open(w, { keystore: fileKeyStore(w) });
    await v.addClaude({ id: A, label: "Claude account", plan: null, token: TOKEN, linked: false });
    v.setPolicy(A, "own");
    v.close();
    // A pre.8 vault has no `personal` column: drop it to simulate one.
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(w, "vault.db"));
    db.exec("ALTER TABLE accounts DROP COLUMN personal");
    db.close();
    const up = Vault.open(w, { keystore: fileKeyStore(w) });
    const e = up.get(A) as VaultEntry;
    expect([e.policy, e.personal]).toEqual(["own", false]);
    expect(vaultOf(e, false)).toEqual({ policy: "own", gen: e.gen, home_at: e.home_at }); // pool off: no company flag
    expect(vaultOf(e, true)).toMatchObject({ policy: "own", company: true }); // an owner turned it on: it joins
    expect(vaultOf(up.setPersonal(A, true), true)).toEqual({ policy: "own", gen: e.gen, personal: true, home_at: e.home_at });
    expect(up.setPersonal(A, false).personal).toBe(false);
    expect(up.promote(A, 777).home_at).toBe(777);
    up.close();
  });

  test("the daemon remembers the newest owner setting on disk (a restart, an offline owner) and fails closed without one", () => {
    const w = dir();
    const cfg = join(w, "config.json");
    writeFileSync(cfg, "{}");
    const node = (id: string, login: string) => [id, { node_id: id, login, hostname: id, pubkey: "k", ip: "100.64.0.1", port: 1, revoked: false }] as const;
    const roster = {
      team: null, channels: new Map(),
      members: new Map([["o@x", { login: "o@x", handle: "olga", role: "owner" as const }], ["m@x", { login: "m@x", handle: "mo", role: "member" as const }]]),
      nodes: new Map([node("n-self", "m@x"), node("n-own", "o@x")]),
    };
    let ownerAd: unknown = null;
    let skew = 0;
    const core = { roster, nodeId: "n-self" } as unknown as Core;
    const sync = { peerState: (id: string) => (id === "n-own" && ownerAd ? { accounts: { at: 1, accounts: [], team_policy: ownerAd }, skewMs: skew } : undefined) } as unknown as SyncManager;
    expect(new TeamPoolState(w, cfg).current(core, sync)).toEqual({ policy: "per-account", at: null, by: null });
    ownerAd = { policy: "company", at: 1_000 };
    skew = 400; // the owner's clock is 400 ms ahead: its time moves onto ours
    expect(new TeamPoolState(w, cfg).current(core, sync)).toEqual({ policy: "company", at: 600, by: "olga" });
    ownerAd = null; // the owner goes offline; this machine restarts
    expect(new TeamPoolState(w, cfg).current(core, sync)).toEqual({ policy: "company", at: 600, by: "olga" });
    expect(statSync(join(w, "team-pool.json")).mode & 0o777).toBe(0o600);
    // A member's own setting never counts (only owners set the pool).
    writeLocalTeamPolicy(cfg, "per-account", 5_000);
    expect(new TeamPoolState(w, cfg).current(core, sync).policy).toBe("company");
    // A persisted vote is no longer authoritative after removal, even across a restart.
    roster.members.delete("o@x");
    const restarted = new TeamPoolState(w, cfg);
    expect(restarted.current(core, sync)).toEqual({ policy: "per-account", at: null, by: null });
    expect(new TeamPoolState(w, cfg).current(core, sync).policy).toBe("per-account");
  });

  test("on the wire the pool is additive (company, personal, home_at): a released peer still reads the snapshot", () => {
    const e: VaultEntry = { id: A, provider: "claude", label: "Claude account", plan: null, policy: "local", share_with: [], created_at: 1, expires_at: null, home: null, linked: false, gen: "ab12", home_at: 5, personal: false };
    const badge = vaultOf(e, true);
    expect(badge).toEqual({ policy: "local", gen: "ab12", company: true, home_at: 5 });
    const snap = { at: 1, accounts: [{ id: A, provider: "claude", label: "Claude account", plan: null, agents: [], usage: null, last_seen: 1, vault: badge }], team_policy: { policy: "company", at: 3 } };
    expect(AccountsSnapshot.safeParse(snap).success).toBe(true);
    const odd = AccountsSnapshot.safeParse({ ...snap, accounts: [{ ...snap.accounts[0], vault: { ...badge, company: false, personal: "yes", home_at: -1 } }] });
    expect(odd.success && odd.data.accounts[0]?.vault).toEqual({ policy: "local", gen: "ab12" });
    const Pre5Vault = z.object({ policy: z.enum(["local", "own", "shared"]), share_with: z.array(z.string()).optional(), gen: z.string().optional() });
    const Pre5 = z.object({ at: z.number(), accounts: z.array(z.object({ id: z.string(), vault: Pre5Vault.optional() })) });
    expect(Pre5.safeParse(snap).success).toBe(true);
  });
});

describe("the fleet listing and the suggested split", () => {
  const m = (node: string, host: string, handle: string, over: Partial<AccountView["machines"][number]> = {}): AccountView["machines"][number] =>
    ({ node_id: node, hostname: host, handle, online: true, self: false, agents: [], usage: null, ...over });
  const acct = (over: Partial<AccountView>): AccountView => ({
    key: `alex:${A}`, id: A, provider: "claude", label: "al***@ex***.com", plan: "Max", owners: ["alex"], claimed_by: [], usage: null, usage_host: null, last_seen: T0, leases: [], machines: [], ...over,
  });
  const u = (used: number, resetIn: number, at = T0): AccountUsage => usage({ at, windows: [{ kind: "session", used_pct: used, resets_at: T0 + resetIn, window_s: 18_000, scope: null }, { kind: "weekly", used_pct: used / 2, resets_at: T0 + 3 * 24 * H, window_s: 604_800, scope: null }] });

  const list: AccountView[] = [
    acct({
      usage: u(40, 2 * H),
      machines: [
        m("n-mac", "alex-mac", "alex", { self: true, usage: u(40, 2 * H), vault: { policy: "own", company: true, home_at: 5 }, agents: ["cc-1"] }),
        m("n-mini", "alex-mini", "alex", { usage: usage({ at: T0, state: "relogin", reason: "login_expired" }) }),
      ],
      leases: [{ handle: "kira", hostname: "kira-mac", node_id: "n-kira", agent: "cx-9", since: T0 - H, verified: true }],
    }),
    acct({
      key: `kira:${B}`, id: B, label: "ky***@ex***.com", owners: ["kira"], usage: usage({ at: T0 - 3 * H, state: "exhausted", reason: "limit_reached", until: T0 + H, windows: [] }),
      clock: [clock({ resets_at: T0 + H, observed_at: T0 - 3 * H })],
      machines: [m("n-kira", "kira-mac", "kira", { vault: { policy: "own", company: true, home_at: 7 }, clock: [clock({ resets_at: T0 + H, observed_at: T0 - 3 * H })] })],
    }),
  ];

  test("every machine's accounts: window, used %, resets_at, observed_at; needs re-login per copy; who uses what now", () => {
    const f = fleetView(list, "company", T0);
    expect(f.machines.map((x) => x.hostname)).toEqual(["alex-mac", "alex-mini", "kira-mac"]);
    const mac = f.machines[0]?.accounts[0];
    expect(mac).toMatchObject({ label: "al***@ex***.com", owner: "alex", pooled: true, lender: true, needs_relogin: false, agents: ["cc-1"] });
    expect(mac?.windows[0]).toEqual({ kind: "session", scope: null, window_s: 18_000, used_pct: 40, resets_at: T0 + 2 * H, observed_at: T0, exhausted: false });
    expect(f.machines[1]?.accounts[0]).toMatchObject({ needs_relogin: true, lender: false, policy: null });
    // kira-mac: no current windows, but the remembered reset still counts (used % unknown).
    expect(f.machines[2]?.accounts[0]?.windows[0]).toMatchObject({ used_pct: null, resets_at: T0 + H, observed_at: T0 - 3 * H, exhausted: true });
    expect(f.using_now).toEqual([{ key: `alex:${A}`, label: "al***@ex***.com", provider: "claude", owner: "alex", handle: "kira", hostname: "kira-mac", agent: "cx-9", since: T0 - H, verified: true }]);
    expect(nextFreeByProvider(list, T0)).toEqual({ claude: { at: T0 + H, account: B, key: `kira:${B}`, label: "ky***@ex***.com", owner: "kira" } });
    expect(JSON.stringify(f)).not.toMatch(/sk-ant|refresh|token"/);
    const text = renderFleet(f, { policy: "company", at: null, by: null }, T0, "UTC").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toContain("alex-mini");
    expect(text).toContain("needs re-login");
    expect(text).toContain("kira-mac cx-9 → al***@ex***.com");
    expect(text).toContain("resets in 2h 00m (9:00 PM) · seen 7:00 PM");
  });

  test("suggest a split: seats follow room (net of the reserve on other people's machines); an out login waits", () => {
    const logins = [
      splitLogin(acct({ key: "alex:A", id: A, usage: u(20, 2 * H), machines: [m("n-mac", "alex-mac", "alex", { vault: { policy: "own", company: true } })] }), "company", T0),
      splitLogin(acct({ key: "arvid:C", id: C, label: "ar***@ex***.com", owners: ["arvid"], usage: u(60, 2 * H), machines: [m("n-arj", "arvid-mac", "arvid", { vault: { policy: "own", company: true } })] }), "company", T0),
      splitLogin(list[1] as AccountView, "company", T0),
    ];
    expect(logins.map((l) => [l.label, l.room, l.usable])).toEqual([["al***@ex***.com", 80, true], ["ar***@ex***.com", 40, true], ["ky***@ex***.com", 0, false]]);
    const r = suggestSplit([
      { node_id: "n-mac", hostname: "alex-mac", handle: "alex", online: true, cap: 3 },
      { node_id: "n-arj", hostname: "arvid-mac", handle: "arvid", online: true, cap: 3 },
      { node_id: "n-off", hostname: "gone", handle: "kira", online: false, cap: 3 },
    ], logins);
    const seats = Object.fromEntries(r.machines.map((x) => [x.hostname, x.seats.map((s) => `${s.seats}×${s.label}`)]));
    // 80 % vs 40 % left → 4 : 2 seats; each person's own login is favoured on their machine (no reserve there).
    expect(seats).toEqual({ "alex-mac": ["3×al***@ex***.com"], "arvid-mac": ["2×ar***@ex***.com", "1×al***@ex***.com"] });
    expect(r.waiting).toEqual([{ key: `kira:${B}`, label: "ky***@ex***.com", frees_at: T0 + H, why: "out" }]);
    // A personal (own) login only runs on its person's machines.
    const personal = splitLogin(acct({ key: "arvid:C", id: C, owners: ["arvid"], usage: u(10, 2 * H), machines: [m("n-arj", "arvid-mac", "arvid", { vault: { policy: "own" } })] }), "company", T0);
    const only = suggestSplit([{ node_id: "n-mac", hostname: "alex-mac", handle: "alex", online: true, cap: 2 }, { node_id: "n-arj", hostname: "arvid-mac", handle: "arvid", online: true, cap: 2 }], [personal]);
    expect(only.machines.map((x) => [x.hostname, x.seats.length, x.idle])).toEqual([["alex-mac", 0, 2], ["arvid-mac", 1, 0]]);
    const text = renderSplit(r, "claude", T0, "UTC").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toContain("alex-mac");
    expect(text).toContain("waiting ky***@ex***.com frees at 8:00 PM");
    expect(parseCaps("alex-mac=3, build-02=2")).toEqual(new Map([["alex-mac", 3], ["build-02", 2]]));
    expect(() => parseCaps("build-02")).toThrow(/host=n/);
  });

  test("a login whose holders are all offline gets no seat anywhere (Codex p8 MEDIUM 5); unknown room gets none on another person's machine", () => {
    const machines = [{ node_id: "n-mac", hostname: "alex-mac", handle: "alex", online: true, cap: 3 }, { node_id: "n-arj", hostname: "arvid-mac", handle: "arvid", online: true, cap: 3 }];
    const offline = splitLogin(acct({ key: "kira:K", id: B, owners: ["kira"], usage: u(10, 2 * H), machines: [m("n-kira", "kira-mac", "kira", { online: false, vault: { policy: "own", company: true } })] }), "company", T0);
    expect(offline).toMatchObject({ reachable: false, holders: [] });
    const r = suggestSplit(machines, [offline]);
    expect(r.machines.every((x) => x.seats.length === 0)).toBe(true);
    expect(r.waiting).toEqual([{ key: "kira:K", label: "al***@ex***.com", frees_at: null, why: "unreachable" }]);
    const unknown = splitLogin(acct({ key: "arvid:U", id: C, owners: ["arvid"], usage: null, machines: [m("n-arj", "arvid-mac", "arvid", { vault: { policy: "own", company: true } })] }), "company", T0);
    const s2 = suggestSplit(machines, [unknown]);
    expect(s2.machines.map((x) => [x.hostname, x.seats.length])).toEqual([["alex-mac", 0], ["arvid-mac", 1]]);
  });

  test("of two logins with equal room the one that resets sooner gets the seat first (Codex p8 LOW 6)", () => {
    const soon = splitLogin(acct({ key: "z:soon", id: B, usage: u(50, 60_000), machines: [m("n-mac", "alex-mac", "alex", { vault: { policy: "own", company: true } })] }), "company", T0);
    const late = splitLogin(acct({ key: "a:late", id: C, usage: u(50, 7 * 24 * H - 1), machines: [m("n-mac", "alex-mac", "alex", { vault: { policy: "own", company: true } })] }), "company", T0);
    const r = suggestSplit([{ node_id: "n-mac", hostname: "alex-mac", handle: "alex", online: true, cap: 1 }], [late, soon]);
    expect(r.machines[0]?.seats.map((x) => x.key)).toEqual(["z:soon"]);
  });
});

test("lease homes live only under the vault's Codex root (nothing else can be deleted as one)", () => {
  const w = dir();
  expect(isLeaseHome(join(w, "vault", "codex", "lease-0123456789abcdef"), w)).toBe(true);
  expect(isLeaseHome(join(w, "vault", "codex", A), w)).toBe(false);
  expect(isLeaseHome(join(w, "elsewhere", "lease-0123456789abcdef"), w)).toBe(false);
  expect(readdirSync(w)).toEqual([]);
});

test("the accounts snapshot carries this machine's team policy setting, re-published when it changes", () => {
  const w = dir();
  const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
  let ad: { policy: "company" | "per-account"; at: number } | null = null;
  const snaps: unknown[] = [];
  const svc = new AccountsService(w, quiet, (x) => snaps.push(x), { home: dir(), poll: false, teamPolicy: () => ad });
  expect(svc.snapshot().team_policy).toBeUndefined();
  svc.syncTeamPolicy();
  const before = snaps.length;
  ad = { policy: "per-account", at: 5 };
  svc.syncTeamPolicy();
  expect(snaps.length).toBe(before + 1);
  expect(svc.snapshot().team_policy).toEqual({ policy: "per-account", at: 5 });
  svc.syncTeamPolicy();
  expect(snaps.length).toBe(before + 1); // unchanged: not re-published
  svc.stop();
});

describe("what the home machine does for its lent logins (service)", () => {
  const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
  const entry = (over: Partial<VaultEntry> = {}): VaultEntry => ({ id: B, provider: "codex", label: "ChatGPT account", plan: "Pro", policy: "local", share_with: [], created_at: 1, expires_at: null, home: "/nonexistent/codex-home", linked: true, gen: "ab12", home_at: 1, personal: false, ...over });

  test("the badge follows the team's pool: published again when it turns on or off; personal never pooled", () => {
    let poolOn = false;
    const snaps: unknown[] = [];
    const svc = new AccountsService(dir(), quiet, (x) => snaps.push(x), { home: dir(), poll: false, vault: { list: () => [entry(), entry({ id: C, personal: true })], claudeToken: async () => TOKEN }, poolOn: () => poolOn });
    svc.syncVault();
    svc.syncTeamPolicy();
    expect(svc.snapshot().accounts.map((a) => a.vault?.company ?? false)).toEqual([false, false]);
    const before = snaps.length;
    poolOn = true;
    svc.syncTeamPolicy();
    expect(snaps.length).toBe(before + 1);
    const badges = Object.fromEntries(svc.snapshot().accounts.map((a) => [a.id, a.vault]));
    expect(badges[B]).toMatchObject({ company: true });
    expect(badges[C]).toMatchObject({ personal: true });
    expect(badges[C]?.company).toBeUndefined();
    svc.stop();
  });

  test("renewal (Codex p8 HIGH 1): a lent Codex login near expiry is renewed by the user's own Codex, one at a time, at most hourly", async () => {
    let now = T0;
    const starts: string[] = [];
    let release: () => void = () => undefined;
    const launcher: AppServerLauncher = async (login) => {
      starts.push(login.dir);
      await new Promise<void>((r) => { release = r; });
      return { request: async () => ({}), notify: () => undefined, close: () => undefined };
    };
    let exp: number | null = T0 + 3 * H; // inside the 48-hour renewal window
    const vault: VaultSource = { list: () => [entry(), entry({ id: C, home: "/nonexistent/other" })], claudeToken: async () => TOKEN, codexExpiry: () => exp };
    const svc = new AccountsService(dir(), quiet, () => undefined, { home: dir(), fetch: async () => new Response("{}", { status: 500 }), vault, poolOn: () => true, clock: () => now, codexAppServer: launcher, tickMs: 3_600_000 });
    await svc.tick();
    await svc.tick(); // one is still running: nothing else starts
    expect(starts).toEqual(["/nonexistent/codex-home"]);
    release();
    await Bun.sleep(5);
    now += 10 * 60_000;
    await svc.tick(); // the other login is due now; the first waits an hour
    expect(starts).toEqual(["/nonexistent/codex-home", "/nonexistent/other"]);
    release();
    await Bun.sleep(5);
    exp = T0 + 30 * 24 * H; // renewed: nothing to do
    now += 2 * H;
    await svc.tick();
    expect(starts.length).toBe(2);
    svc.stop();
  });

  test("authorized demand renews with pool off or personal, retaining expiry and retry guards", async () => {
    let time = T0;
    let enabled = false;
    let personal = false;
    let exp = T0 + H;
    let starts = 0;
    const svc = new AccountsService(dir(), quiet, () => undefined, {
      home: dir(), poll: false, clock: () => time, poolOn: () => enabled,
      vault: { list: () => [entry({ personal })], claudeToken: async () => TOKEN, codexExpiry: () => exp },
      codexAppServer: async () => { starts++; return { request: async () => ({}), notify: () => undefined, close: () => undefined }; },
    });
    const attempt = async () => { svc.syncVault(); svc.renewCodex(B); await Bun.sleep(5); };
    await attempt(); expect(starts).toBe(1);
    personal = true; time += H;
    await attempt(); expect(starts).toBe(2);
    personal = false;
    await attempt(); expect(starts).toBe(2);
    await attempt(); expect(starts).toBe(2);
    time += H;
    await attempt(); expect(starts).toBe(3);
    time += H; exp = time + 30 * 24 * H;
    await attempt(); expect(starts).toBe(3);
    svc.stop();
  });

  test("roomLeft: the lender's reserve check reads its own current reading; none under an hour old = unknown", () => {
    const svc = new AccountsService(dir(), quiet, () => undefined, { home: dir(), poll: false, vault: { list: () => [entry()], claudeToken: async () => TOKEN } });
    svc.syncVault();
    expect(svc.roomLeft(B, T0)).toBeNull();
    expect(svc.roomLeft("f".repeat(24), T0)).toBeNull();
    svc.stop();
  });
});

test("pre.7 RC: an older peer's Grok placeholder is not a 'frees at' time in the fleet listing or the split", () => {
  const legacy: AccountUsage = { at: T0 - 5 * 60_000, state: "exhausted", reason: "limit_reached", source: "log", windows: [], until: T0 + 55 * 60_000 };
  const g: AccountView = {
    key: "alex:g", id: "a1c0ffee00000000000000ff", provider: "grok", label: "al***@ex***.com", plan: null, owners: ["alex"], claimed_by: [], usage: legacy, usage_host: "m",
    last_seen: T0, machines: [{ node_id: "n1", hostname: "m", handle: "alex", online: true, self: true, agents: [], usage: legacy }], leases: [],
  };
  expect(nextFreeByProvider([g], T0)).toEqual({ grok: null });
  expect(splitLogin(g, "company", T0)).toMatchObject({ usable: false, resets_at: null });
});

