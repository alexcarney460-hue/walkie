// ORCH-2 WalkieTalkie: model-login detection (presence only, no token read), the one-lead-per-team election, the
// auto-start decision, the needs-login text, the rename and the playbook's onboarding clauses.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decide, needsLoginText } from "../../src/daemon/orchestrator/auto.ts";
import { electLead, leadOrder, type LeadNode } from "../../src/daemon/orchestrator/lead.ts";
import { detectLogins, type Logins } from "../../src/daemon/orchestrator/logins.ts";
import { FIRST_RUN_PROMPT, playbook } from "../../src/daemon/orchestrator/playbook.ts";
import { agentDisplayName, ORCHESTRATOR_AGENT, ORCHESTRATOR_DISPLAY } from "../../src/protocol/orchestrator.ts";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }); });
function home(): string { const d = mkdtempSync("/tmp/walkie-logins-"); dirs.push(d); return d; }
const CLAUDE_JSON = JSON.stringify({ oauthAccount: { accountUuid: "11111111-2222-3333-4444-555555555555", emailAddress: "a@example.com" } });
function claudeCli(h: string, creds: boolean): void {
  writeFileSync(join(h, ".claude.json"), CLAUDE_JSON);
  mkdirSync(join(h, ".claude"), { recursive: true });
  if (creds) writeFileSync(join(h, ".claude", ".credentials.json"), "{}");
}
function codex(h: string): void { mkdirSync(join(h, ".codex"), { recursive: true }); writeFileSync(join(h, ".codex", "auth.json"), "{}"); }
function kimi(h: string): void { mkdirSync(join(h, ".kimi-code", "credentials"), { recursive: true }); writeFileSync(join(h, ".kimi-code", "credentials", "kimi-code.json"), "{}"); }
const detect = (h: string, extra: { env?: NodeJS.ProcessEnv; keychain?: boolean; vault?: string[]; platform?: string } = {}) => detectLogins({
  home: h, env: extra.env ?? {}, keychainHas: async () => extra.keychain ?? false, vaultClaude: () => extra.vault ?? [], platform: extra.platform ?? "linux",
});

describe("detection matrix (fake logins; names only)", () => {
  test("claude only (the CLI's sign-in: account in .claude.json + credentials file)", async () => {
    const h = home(); claudeCli(h, true);
    expect(await detect(h)).toEqual({ found: ["claude"], claude: "cli" });
  });
  test("claude on macOS: the Keychain item's presence counts (looked up without -w)", async () => {
    const h = home(); claudeCli(h, false);
    expect((await detect(h, { platform: "darwin", keychain: true })).claude).toBe("cli");
    expect((await detect(h, { platform: "darwin", keychain: false })).claude).toBeNull();
  });
  test("claude by CLAUDE_CODE_OAUTH_TOKEN, and by a vault account", async () => {
    expect((await detect(home(), { env: { CLAUDE_CODE_OAUTH_TOKEN: "x" } })).claude).toBe("env");
    expect(await detect(home(), { vault: ["acct1"] })).toEqual({ found: ["claude"], claude: "vault", vaultAccount: "acct1" });
  });
  test("codex only, kimi only, none", async () => {
    const c = home(); codex(c);
    expect(await detect(c)).toEqual({ found: ["codex"], claude: null });
    const k = home(); kimi(k);
    expect(await detect(k)).toEqual({ found: ["kimi"], claude: null });
    expect(await detect(home())).toEqual({ found: [], claude: null });
  });
  test("all three: Claude first", async () => {
    const h = home(); claudeCli(h, true); codex(h); kimi(h);
    expect((await detect(h)).found).toEqual(["claude", "codex", "kimi"]);
  });
});

const node = (id: string, handle: string, online = true, last_seen: number | null = 0): LeadNode => ({ node_id: id, hostname: `${id}-host`, handle, online, last_seen });
const NOW = 1_000_000_000;

describe("the lead: the roster authority, then the owners' machines by node id", () => {
  const nodes = [node("c", "carol"), node("a", "alex"), node("b", "alex"), node("m", "mia")];
  const owners = new Set(["alex", "carol"]);
  test("order: authority first, owners' other machines by node id, members never", () => {
    expect(leadOrder({ authority: "c", nodes, owners }).map((n) => n.node_id)).toEqual(["c", "a", "b"]);
  });
  test("the authority leads when it may; else the next owner machine that may", () => {
    const all = electLead({ self: "a", authority: "c", nodes, owners, now: NOW, eligible: () => true });
    expect(all?.node_id).toBe("c");
    expect(electLead({ self: "a", authority: "c", nodes, owners, now: NOW, eligible: (id) => id !== "c" })?.node_id).toBe("a");
    expect(electLead({ self: "a", authority: "c", nodes, owners, now: NOW, eligible: (id) => id === "m" })).toBeNull();
  });
  test("a lead offline more than 5 minutes is passed over; seen again, it leads again", () => {
    const gone = [node("c", "carol", false, NOW - 5 * 60_000 - 1), node("a", "alex")];
    expect(electLead({ self: "a", authority: "c", nodes: gone, owners, now: NOW, eligible: () => true })?.node_id).toBe("a");
    const brief = [node("c", "carol", false, NOW - 60_000), node("a", "alex")];
    expect(electLead({ self: "a", authority: "c", nodes: brief, owners, now: NOW, eligible: () => true })?.node_id).toBe("c");
    const back = [node("c", "carol", true, NOW), node("a", "alex")];
    expect(electLead({ self: "a", authority: "c", nodes: back, owners, now: NOW, eligible: () => true })?.node_id).toBe("c");
  });
});

describe("the auto-start decision", () => {
  const withClaude: Logins = { found: ["claude"], claude: "cli" };
  const base = { inTeam: true, observer: false, manual: false, stopped: false, logins: withClaude, self: "a" };
  test("the lead runs; others stand by naming the lead", () => {
    expect(decide({ ...base, lead: node("a", "alex") })).toEqual({ kind: "run" });
    expect(decide({ ...base, lead: node("c", "carol") })).toEqual({ kind: "standby", lead: "c-host" });
    expect(decide({ ...base, lead: null })).toEqual({ kind: "standby", lead: null });
  });
  test("no Claude login: needs a login (Codex/Kimi named); a stop by hand, a start by hand, no team: left alone", () => {
    expect(decide({ ...base, logins: { found: ["codex"], claude: null }, lead: null })).toEqual({ kind: "needs_login", found: ["codex"] });
    expect(decide({ ...base, stopped: true, lead: node("a", "alex") })).toEqual({ kind: "stopped" });
    expect(decide({ ...base, manual: true, lead: node("c", "carol") })).toEqual({ kind: "none" });
    expect(decide({ ...base, inTeam: false, lead: null })).toEqual({ kind: "none" });
    expect(decide({ ...base, observer: true, lead: null })).toEqual({ kind: "none" });
  });
  test("the needs-login text: the one step, and Codex/Kimi named as not supported yet", () => {
    expect(needsLoginText([])).toContain("run: claude");
    expect(needsLoginText(["codex", "kimi"])).toBe("WalkieTalkie needs a Claude login for now (found codex and kimi; Codex/Kimi support is coming). Sign in with: claude");
  });
});

describe("the rename", () => {
  test("people see WalkieTalkie; the agent name stays orchestrator", () => {
    expect(ORCHESTRATOR_AGENT).toBe("orchestrator");
    expect(ORCHESTRATOR_DISPLAY).toBe("WalkieTalkie");
    expect(agentDisplayName("orchestrator")).toBe("WalkieTalkie");
    expect(agentDisplayName("cc-1")).toBe("cc-1");
  });
});

describe("the playbook: WalkieTalkie, first-run onboarding, other computers", () => {
  const p = playbook({ owner: "alex", hostname: "alex-mac", access: "platform" });
  test("opens as WalkieTalkie and stays tight", () => {
    expect(p.startsWith("You are WalkieTalkie, the Walkie orchestrator for @alex")).toBe(true);
    expect(p.split("\n").length).toBeLessThanOrEqual(60);
  });
  test("first-run onboarding: opens the conversation, detects sources without secrets, offers the import, asks for a credential once", () => {
    expect(p).toContain("## First-run onboarding (your first start, whenever the team has no projects, or when asked)");
    expect(p).toContain("Open the conversation yourself");
    expect(p).toMatch(/Detect likely sources without secrets: Linear[^\n]*GitHub[^\n]*local git repos[^\n]*existing Walkie boards/);
    expect(p).toMatch(/`walkie import linear` if `walkie help` lists it; otherwise create the projects and cards/);
    expect(p).toMatch(/ask once, say where to get it, and have them paste it in the dashboard's Integrations page \(Walkie's integration settings\), never in chat, cards or files/);
    expect(FIRST_RUN_PROMPT).toContain("First-run onboarding");
  });
  test("other computers: ask, mint the right link, reply privately with expiry, who, 3 steps; watch and set up", () => {
    expect(p).toMatch(/Ask whether they, or their company, have other computers to add/);
    expect(p).toContain("`walkie team add-machine <handle> --json`");
    expect(p).toContain("`walkie invite --handle <h>`");
    expect(p).toMatch(/Reply here only \(never post a link anywhere else\) with the link, its expiry, who the machine joins as, and 3 steps/);
    expect(p).toMatch(/1\. open the link, or run the one command on the new machine \(macOS\/Linux; Windows = WSL\); 2\. approve the one question it asks; 3\. done: it shows up in Mission Control/);
    expect(p).toMatch(/confirm each new machine when it joins[^\n]*offer to set it up over remote admin/);
    expect(p).toMatch(/When the team looks small for its work[^\n]*other computers to add/);
  });
});
