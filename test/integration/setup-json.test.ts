// `--json` on setup, hooks install|uninstall and daemon start|stop|restart: the real CLI entry (bun src/cli/main.ts) against a
// daemon in a throwaway home, with the flags that keep it from installing a service, hooks or shims. One JSON object on stdout.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Cluster, type TestNode } from "../helpers/cluster.ts";
import { runAsPerson, type CliResult } from "../helpers/person-cli.ts";

const MAIN = join(import.meta.dir, "../../src/cli/main.ts");
let c: Cluster;
let node: TestNode;
let scratch: string;
let env: Record<string, string>;
const cli = (args: string[], e: Record<string, string> = env): Promise<CliResult> => runAsPerson([process.execPath, MAIN, ...args], e, { timeoutMs: 60_000 });
const one = (r: CliResult): Record<string, any> => JSON.parse(r.out) as Record<string, any>;

beforeAll(async () => {
  c = new Cluster();
  node = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-box" });
  scratch = mkdtempSync("/tmp/walkie-setup-json-");
  env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: scratch, NO_COLOR: "1", WALKIE_HOME: node.home, WALKIE_SOCKET: node.socket };
}, 30_000);
afterAll(async () => { await c.close(); rmSync(scratch, { recursive: true, force: true }); });

const SAFE = ["--no-service", "--no-hooks", "--no-switching", "--no-team-agents"];

describe("walkie setup --json", () => {
  test("refuses instead of asking: no team name and no flag for it", async () => {
    const r = await cli(["setup", "--json", ...SAFE]);
    expect(r.code).toBe(1);
    const o = one(r);
    expect(o).toMatchObject({ ok: false, command: "setup", error: { code: "input_required" } });
    expect(typeof o.error.message).toBe("string");
    expect(r.err).toContain("input_required");
  }, 60_000);

  test("success: the facts the prose reports, as one object", async () => {
    const r = await cli(["setup", "--json", "--team", "Acme", "--handle", "alex", ...SAFE]);
    expect(r.code).toBe(0);
    const o = one(r);
    expect(o).toMatchObject({
      ok: true, command: "setup", team: { name: "Acme" }, handle: "alex", machine: { hostname: "alex-box" }, transport: "direct", admitted: true, pending: false,
      team_result: "created", service: { state: "skipped", reason: "--no-service" }, hooks: { state: "skipped", reason: "--no-hooks" },
      switching: { state: "skipped", reason: "--no-switching" },
    });
    expect((o.next_steps as unknown[]).every((s) => typeof s === "string")).toBe(true);
    expect(r.out.trim().split("\n")).toHaveLength(1);
    expect(r.err).toContain("created");
  }, 60_000);

  test("a second run reports the team it is already in", async () => {
    const o = one(await cli(["setup", "--json", ...SAFE]));
    expect(o).toMatchObject({ ok: true, team_result: "already_member", handle: "alex" });
  }, 60_000);

  test("failure: no daemon answering exits 3 with an error object", async () => {
    const dead = mkdtempSync("/tmp/walkie-setup-json-dead-");
    try {
      const r = await cli(["setup", "--json", "--team", "X", "--handle", "x", ...SAFE], { ...env, WALKIE_HOME: dead, WALKIE_SOCKET: join(dead, "walkie.sock") });
      expect(r.code).toBe(3);
      expect(one(r)).toMatchObject({ ok: false, command: "setup", error: { code: "daemon_unreachable" } });
    } finally { rmSync(dead, { recursive: true, force: true }); }
  }, 60_000);

  test("without --json the output is the prose it always was", async () => {
    const other = await c.add({ name: "pat", login: "pat@example.com", hostname: "pat-box" });
    await other.client().init("Acme", "pat");
    const r = await cli(["setup", ...SAFE], { ...env, WALKIE_HOME: other.home, WALKIE_SOCKET: other.socket });
    expect(r.code).toBe(0);
    expect(r.out).toBe([
      "1. Background service", "   skipped (--no-service); run walkie daemon start yourself",
      "2. Team", "   already in Acme as @pat",
      "3. Team agents on this machine", "   team agents off. Later: walkie seats enable",
      "4. Agents", "   skipped (--no-hooks)",
      "5. Account switching (optional)", "   skipped (--no-switching)",
      "6. Dashboard", "   walkie dashboard opens it · walkie who shows everyone in the terminal", "",
    ].join("\n"));
  }, 60_000);
});

describe("walkie hooks --json", () => {
  test("a dry run reports what would change; stdout is one object", async () => {
    const r = await cli(["hooks", "install", "codex", "--dry-run", "--json"]);
    expect(r.code).toBe(0);
    expect(one(r)).toMatchObject({ ok: true, command: "hooks install", action: "install", target: "codex", dry_run: true, hooks: [{ target: "codex" }] });
    expect(r.out.trim().split("\n")).toHaveLength(1);
  }, 60_000);

  test("all reports each runtime", async () => {
    const o = one(await cli(["hooks", "uninstall", "all", "--dry-run", "--json"]));
    expect(o).toMatchObject({ ok: true, command: "hooks uninstall", target: "all" });
    expect(o.hooks.map((h: { target: string }) => h.target)).toEqual(["claude", "codex"]);
  }, 60_000);

  test("a refusal is an error object with the prose path's exit code", async () => {
    const r = await cli(["hooks", "install", "hermes", "--dry-run", "--json"]);
    expect(r.code).toBe(1);
    expect(one(r)).toMatchObject({ ok: false, command: "hooks install", error: { code: "usage" } });
  }, 60_000);
});

describe("walkie daemon --json", () => {
  test("start finds the daemon already running", async () => {
    const r = await cli(["daemon", "start", "--json"]);
    expect(r.code).toBe(0);
    expect(one(r)).toMatchObject({ ok: true, command: "daemon start", state: "already_running" });
  }, 60_000);

  test("stop with no pid file says so", async () => {
    const dead = mkdtempSync("/tmp/walkie-setup-json-stop-");
    try {
      const r = await cli(["daemon", "stop", "--json"], { ...env, WALKIE_HOME: dead, WALKIE_SOCKET: join(dead, "walkie.sock") });
      expect(r.code).toBe(0);
      expect(one(r)).toMatchObject({ ok: true, command: "daemon stop", state: "not_running" });
    } finally { rmSync(dead, { recursive: true, force: true }); }
  }, 60_000);

  test("restart is not a daemon verb: an error object, not prose", async () => {
    const r = await cli(["daemon", "restart", "--json"]);
    expect(r.code).toBe(1);
    expect(one(r)).toMatchObject({ ok: false, command: "daemon restart", error: { code: "usage" } });
  }, 60_000);
});
