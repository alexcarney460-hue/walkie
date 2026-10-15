import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kimiCredentialsPath, provisionalKimiIdentity, readKimiToken } from "../../src/accounts/adapters/kimi.ts";
import { addKimi, vaultCommand } from "../../src/cli/commands/vault.ts";
import type { Args } from "../../src/cli/args.ts";
import type { Ctx } from "../../src/cli/context.ts";
import { setTtyForTests, type Tty } from "../../src/cli/tty.ts";
import { Vault } from "../../src/accounts/vault/vault.ts";
import { AccountsService, vaultOf } from "../../src/accounts/service.ts";
import { planSeatAccount, seatCredentials } from "../../src/daemon/seats/account.ts";
import type { Login } from "../../src/accounts/types.ts";
import { fakeFetch } from "../helpers/accounts.ts";

const dirs: string[] = [];
const token = "fake-kimi-access-token";
const account = "a".repeat(24);
const tree = () => { const p = mkdtempSync(join(tmpdir(), "walkie-vault-kimi-")); dirs.push(p); return p; };
const login = (dir: string): Login => ({ provider: "kimi", dir, isDefault: false });
const cred = (dir: string, name: string, value = token) => {
  mkdirSync(join(dir, "credentials"), { recursive: true, mode: 0o700 });
  const p = join(dir, "credentials", name);
  writeFileSync(p, JSON.stringify({ access_token: value }), { mode: 0o600 });
  return p;
};
const tty: Tty = { ask: async () => "y", secret: async () => "", close: () => undefined };
const ctx = (pos: string[], flags: Record<string, string | true> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const args: Args = { pos, flags: new Map(Object.entries(flags)) };
  return { c: { args, json: false, forAgent: false, agentSignals: () => ({ marker: null, inspection: "ok" }), client: () => { throw new Error("no daemon"); }, out: (s: string) => out.push(s), err: (s: string) => err.push(s) } as unknown as Ctx, out, err };
};
afterEach(() => { setTtyForTests(undefined); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("Kimi credential selection", () => {
  test("accepts the fixed name and the CLI's 16-hex environment name", () => {
    const dir = tree();
    const fixed = cred(dir, "kimi-code.json", "fixed-token-123456");
    expect(kimiCredentialsPath(login(dir))).toBe(fixed);
    expect(readKimiToken(login(dir))).toMatchObject({ value: "fixed-token-123456" });
    rmSync(fixed);
    const named = cred(dir, "kimi-code-env-0123456789abcdef.json");
    expect(kimiCredentialsPath(login(dir))).toBe(named);
    expect(provisionalKimiIdentity(login(dir))?.pending).toBe(true);
    expect(readKimiToken(login(dir))).toMatchObject({ value: token });
  });

  test("chooses the newest env credential and ignores unrelated names", () => {
    const dir = tree();
    const old = cred(dir, "kimi-code-env-aaaaaaaaaaaaaaaa.json", "older-token-12345");
    const newer = cred(dir, "kimi-code-env-bbbbbbbbbbbbbbbb.json", "newer-token-12345");
    cred(dir, "kimi-code-env-not-hex.json", "wrong-token-12345");
    utimesSync(old, new Date(1000), new Date(1000));
    utimesSync(newer, new Date(2000), new Date(2000));
    expect(kimiCredentialsPath(login(dir))).toBe(newer);
    expect(readKimiToken(login(dir))).toMatchObject({ value: "newer-token-12345" });
  });

  test("refuses symlinks and non-regular credentials", () => {
    const dir = tree();
    const outside = cred(tree(), "kimi-code.json");
    mkdirSync(join(dir, "credentials"));
    symlinkSync(outside, join(dir, "credentials", "kimi-code.json"));
    expect(kimiCredentialsPath(login(dir))).toBeNull();
    expect(readKimiToken(login(dir))).toBe("none");
    expect(provisionalKimiIdentity(login(dir))).toBeNull();
    rmSync(join(dir, "credentials", "kimi-code.json"));
    mkdirSync(join(dir, "credentials", "kimi-code-env-0123456789abcdef.json"));
    expect(readKimiToken(login(dir))).toBe("none");
  });
});

test("fake kimi login receives only login/region and a private vault home; the account is recorded without a token in SQLite", async () => {
  const root = tree();
  const walkie = join(root, "walkie");
  const binary = join(root, "kimi");
  writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "$@" > '${join(root, "argv")}'\nprintf '%s' "$KIMI_CODE_HOME" > '${join(root, "home")}'\nprintf '%s' "\${KIMI_API_KEY:+set}:\${WALKIE_NO_SWITCH:-}" > '${join(root, "env")}'\nmkdir -p "$KIMI_CODE_HOME/credentials"\nprintf '%s' '{"access_token":"${token}"}' > "$KIMI_CODE_HOME/credentials/kimi-code-env-0123456789abcdef.json"\nchmod 600 "$KIMI_CODE_HOME/credentials/kimi-code-env-0123456789abcdef.json"\nchmod 755 "$KIMI_CODE_HOME"\n`);
  chmodSync(binary, 0o755);
  const oldKey = process.env.KIMI_API_KEY;
  const oldHome = process.env.KIMI_CODE_HOME;
  process.env.KIMI_API_KEY = "fake-parent-key";
  process.env.KIMI_CODE_HOME = join(root, "wrong-home");
  const vault = Vault.open(walkie);
  try {
    const input = ctx(["add", "kimi"], { account, email: "alex@example.com", plan: "Pro", region: "mainland-cn" });
    const entry = await addKimi(input.c, vault, tty, walkie, binary);
    expect(readFileSync(join(root, "argv"), "utf8")).toBe("login\n--region\nmainland-cn\n");
    expect(readFileSync(join(root, "home"), "utf8")).toMatch(/\/vault\/kimi\/pending-[0-9a-f]{12}$/);
    expect(readFileSync(join(root, "env"), "utf8")).toBe(":1");
    expect(entry).toMatchObject({ id: account, provider: "kimi", plan: "Pro", policy: "local" });
    expect(statSync(entry.home!).mode & 0o777).toBe(0o700);
    expect(lstatSync(kimiCredentialsPath(login(entry.home!))!).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(walkie, "vault.db"), "latin1")).not.toContain(token);
  } finally {
    vault.close();
    if (oldKey === undefined) delete process.env.KIMI_API_KEY; else process.env.KIMI_API_KEY = oldKey;
    if (oldHome === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = oldHome;
  }
});

test("Kimi add removes the pending home when its owner cannot be verified", async () => {
  const root = tree(); const walkie = join(root, "walkie"); const binary = join(root, "kimi");
  writeFileSync(binary, '#!/bin/sh\nmkdir -p "$KIMI_CODE_HOME/credentials"\nprintf \'%s\' \'{"access_token":"fake-token-12345"}\' > "$KIMI_CODE_HOME/credentials/kimi-code.json"\nprintf \'settings\' > "$KIMI_CODE_HOME/settings.json"\nchmod 600 "$KIMI_CODE_HOME/credentials/kimi-code.json"\nchmod 755 "$KIMI_CODE_HOME"\n');
  chmodSync(binary, 0o755);
  const vault = Vault.open(walkie);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("POSIX owner id required");
  const mock = spyOn(process, "getuid").mockReturnValue(uid + 1);
  try {
    await expect(addKimi(ctx(["add", "kimi"], { account }).c, vault, tty, walkie, binary)).rejects.toThrow(/home owner/i);
    expect(readdirSync(join(walkie, "vault", "kimi"))).toEqual([]);
    expect(vault.get(account)).toBeNull();
  } finally { mock.mockRestore(); vault.close(); }
});

test("Kimi add refuses agent and missing terminal even when agent admin is on", async () => {
  const root = tree();
  const previous = process.env.WALKIE_HOME;
  process.env.WALKIE_HOME = join(root, "walkie");
  try {
    mkdirSync(process.env.WALKIE_HOME);
    setTtyForTests(null);
    const input = ctx(["add", "kimi"]);
    await expect(vaultCommand(input.c, "add")).rejects.toThrow(/person.*terminal|terminal.*person/i);
  } finally { if (previous === undefined) delete process.env.WALKIE_HOME; else process.env.WALKIE_HOME = previous; }
});

test("Kimi add refuses a marked agent even with a terminal", async () => {
  const root = tree();
  const previous = process.env.WALKIE_HOME;
  process.env.WALKIE_HOME = join(root, "walkie");
  setTtyForTests(tty);
  try {
    const input = ctx(["add", "kimi"]);
    input.c.agentSignals = () => ({ marker: "CLAUDECODE", inspection: "ok" }) as ReturnType<NonNullable<Ctx["agentSignals"]>>;
    await expect(vaultCommand(input.c, "add")).rejects.toThrow(/person.*terminal/i);
    expect(existsSync(join(process.env.WALKIE_HOME!, "vault.db"))).toBe(false);
  } finally { if (previous === undefined) delete process.env.WALKIE_HOME; else process.env.WALKIE_HOME = previous; }
});

test("same-machine Kimi seat uses the vault home; another machine cannot lease it", async () => {
  const root = tree();
  const home = join(root, "walkie", "vault", "kimi", account);
  cred(home, "kimi-code-env-0123456789abcdef.json");
  const vault = Vault.open(join(root, "walkie"));
  const entry = vault.addKimi({ id: account, label: "Kimi account", plan: null, home });
  const local = planSeatAccount(`alex:${account}`, { runtime: "kimi", me: "alex", launcher: "alex", vault: [entry], pooled: [] });
  expect(local.kind).toBe("local");
  if (local.kind === "local") {
    const creds = await seatCredentials(local, "alex", false, { claudeToken: async () => "", lease: async () => { throw new Error("lease attempted"); }, accessOnlyCodex: () => null });
    expect(creds.env).toEqual({ KIMI_CODE_HOME: home });
  }
  expect(planSeatAccount(`alex:${account}`, { runtime: "kimi", me: "other", launcher: "other", vault: [], pooled: [] }))
    .toMatchObject({ kind: "refused", why: expect.stringMatching(/rotat.*token|token.*rotat/i) });
  vault.close();
});

test("vault Kimi account polls the current token and replaces its provisional label after /me", async () => {
  const root = tree();
  const walkie = join(root, "walkie");
  const home = join(walkie, "vault", "kimi", account);
  cred(home, "kimi-code-env-0123456789abcdef.json");
  const vault = Vault.open(walkie);
  vault.addKimi({ id: account, label: "Kimi account", plan: null, home });
  const fetch = fakeFetch();
  const log = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
  const svc = new AccountsService(walkie, log, () => undefined, { home: root, vault, fetch: fetch.fetch, keychain: async () => null });
  try {
    svc.syncVault();
    expect(svc.snapshot().accounts.find((a) => a.id === account)?.usage?.reason).toBe("identity_pending");
    await svc.tick();
    const current = svc.snapshot().accounts.find((a) => a.id === account);
    expect(current?.label).toBe("de***@ex***.test");
    expect(current?.usage?.state).toBe("ok");
    expect(fetch.calls).toHaveLength(2);
    svc.syncVault();
    expect(svc.snapshot().accounts.find((a) => a.id === account)?.label).toBe(current?.label);
  } finally { svc.stop(); vault.close(); }
});

test("remove kimi refuses other CLI files until --move and keeps the vault row on refusal", async () => {
  const root = tree();
  const walkie = join(root, "walkie");
  const home = join(walkie, "vault", "kimi", account);
  const base = join(root, "base-kimi");
  cred(home, "kimi-code-env-0123456789abcdef.json");
  writeFileSync(join(home, "credentials", "settings.json"), "local settings");
  writeFileSync(join(home, "notes.txt"), "local session notes");
  const vault = Vault.open(walkie);
  vault.addKimi({ id: account, label: "Kimi account", plan: null, home });
  vault.close();
  const oldWalkie = process.env.WALKIE_HOME;
  const oldKimi = process.env.KIMI_CODE_HOME;
  process.env.WALKIE_HOME = walkie;
  process.env.KIMI_CODE_HOME = base;
  setTtyForTests(tty);
  try {
    await expect(vaultCommand(ctx(["remove", account]).c, "remove")).rejects.toThrow(/--move/);
    const still = Vault.open(walkie);
    expect(still.get(account)?.provider).toBe("kimi");
    still.close();
    expect(await vaultCommand(ctx(["remove", account], { move: true }).c, "remove")).toBe(0);
    expect(readFileSync(join(base, "notes.txt"), "utf8")).toBe("local session notes");
    expect(readFileSync(join(base, "credentials", "settings.json"), "utf8")).toBe("local settings");
    expect(existsSync(home)).toBe(false);
    const gone = Vault.open(walkie);
    expect(gone.get(account)).toBeNull();
    gone.close();
  } finally {
    if (oldWalkie === undefined) delete process.env.WALKIE_HOME; else process.env.WALKIE_HOME = oldWalkie;
    if (oldKimi === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = oldKimi;
  }
});

test("Kimi policy cannot advertise cross-machine lending", () => {
  const root = tree();
  const walkie = join(root, "walkie");
  const vault = Vault.open(walkie);
  try {
    const entry = vault.addKimi({ id: account, label: "Kimi account", plan: null, home: join(walkie, "vault", "kimi", account) });
    expect(vaultOf(entry, true).company).toBeUndefined();
    expect(() => vault.setPolicy(account, "own")).toThrow(/stays on the machine/);
    expect(() => vault.setPolicy(account, "shared", ["alex"])).toThrow(/stays on the machine/);
  } finally { vault.close(); }
});
