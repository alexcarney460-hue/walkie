// Adversarial probe P2: step runner (receipts, revocation races, retry) and executor (spawn/env/URL surface) with
// every spawn and fetch stubbed. Nothing real is installed; all state lives in /tmp/enprov-p2-*.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const R = join(import.meta.dir, "../../src/daemon/provision");
const { PROFILES } = await import(`${R}/profiles.ts`);
const { createGrant, readGrant, revokeGrant, authorizeProvision } = await import(`${R}/grant.ts`);
const { setTestEnrollmentRoot } = await import(`${R}/root-marker.ts`);
const { applyProfile, profileStatus, markInterrupted } = await import(`${R}/runner.ts`);
const { executorFor, lockProblem, systemVersionAtLeast } = await import(`${R}/executor.ts`);
type Step = (typeof PROFILES)["developer-worker"]["steps"][number];

const homes: string[] = [];
const home = () => { const p = mkdtempSync("/tmp/enprov-p2-"); homes.push(p); setTestEnrollmentRoot(p, join(p, "root")); return p; };
const fields = { team_id: "t", owner_node: "o", target_node: "target-node", recipient: "kira", consent_text: "c", consent_version: 1, company_mode: true as const, launchers: ["@alex"], seat_cap: 3,
  profiles: [{ id: "developer-worker" as const, version: PROFILES["developer-worker"].version }, { id: "freight-worker" as const, version: PROFILES["freight-worker"].version }], created_at: Date.now(), expires_at: Date.now() + 90 * 86400_000 };
const okCtx = (grantHome: string, extra: Record<string, unknown> = {}) => () => authorizeProvision({ grant: readGrant(grantHome), teamId: "t", targetHandle: "kira", targetNode: "target-node", ownerHandle: "alex", actorHandle: "alex", actorNode: "o", actorRole: "owner", ownerNodeCurrent: true, remoteAdmin: true, agentAdmin: true, profile: "developer-worker", ...extra });

let realFetch: typeof fetch;
beforeEach(() => { realFetch = globalThis.fetch; globalThis.fetch = (async (u: unknown) => { throw new Error(`STUB fetch blocked: ${String(u)}`); }) as never; });
afterEach(() => { globalThis.fetch = realFetch; for (const p of homes.splice(0)) { try { chmodSync(p, 0o700); } catch { /* */ } rmSync(p, { recursive: true, force: true }); } });

const stepNames = PROFILES["developer-worker"].steps.map((s: Step) => s.id) as string[];

function fake(opts: { installed?: Set<string>; onExecute?: (s: Step) => Promise<void | "needs_installer_elevation"> } = {}) {
  const installed = opts.installed ?? new Set(["walkie-daemon", "bun"]);
  const log: string[] = [];
  return { log, installed, ex: {
    inspect: async (s: Step) => { log.push(`inspect:${s.id}`); return installed.has(s.id) ? "installed" as const : "missing" as const; },
    execute: async (s: Step) => { log.push(`execute:${s.id}`); const r = opts.onExecute ? await opts.onExecute(s) : undefined; if (r === undefined) installed.add(s.id); return r; },
  } };
}

test("R1: journal write failure blocks the installer (receipt-before-irreversible-step is fail-closed)", async () => {
  const p = home(); createGrant(p, fields);
  profileStatus(p, "developer-worker");
  const f = fake();
  chmodSync(p, 0o500); // directory not writable: writePrivate cannot create its temp file
  let threw = false;
  try { await applyProfile(p, "developer-worker", okCtx(p), f.ex, { actor: "a", target: "t" }); } catch { threw = true; }
  chmodSync(p, 0o700);
  console.log("R1 threw:", threw, "calls:", f.log.join(","));
  expect(f.log.some((l) => l.startsWith("execute:"))).toBe(false);
});

test("R2: revocation between 'started' receipt and execute -> execute never called", async () => {
  const p = home(); createGrant(p, fields);
  let revokeNow = false;
  const f = fake();
  const guard = () => (revokeNow ? "grant_revoked" : okCtx(p)());
  const ex = { ...f.ex, inspect: async (s: Step) => { const r = await f.ex.inspect(s); if (s.id === "node") revokeNow = true; return r; } };
  const res = await applyProfile(p, "developer-worker", guard, ex, {});
  console.log("R2", res.state, res.reason, f.log.join(","));
  expect(res.state).toBe("revoked");
  expect(f.log.includes("execute:node")).toBe(false);
});

test("R3: a noncooperative fake executor completes after revocation, but runner marks uncertainty", async () => {
  const p = home(); createGrant(p, fields);
  let gate!: () => void; const wait = new Promise<void>((r) => { gate = r; });
  const events: string[] = [];
  const f = fake({ onExecute: async (s) => { if (s.id === "node") { events.push("node-running"); await wait; events.push("node-finished-installing"); } } });
  const run = applyProfile(p, "developer-worker", okCtx(p), f.ex, {});
  await Bun.sleep(30);
  expect(profileStatus(p, "developer-worker").steps.find((s: { id: string }) => s.id === "node")?.state).toBe("started");
  revokeGrant(p); events.push("revoked-while-node-running");
  await Bun.sleep(30);
  events.push("(nothing aborted the running installer here)");
  gate();
  const res = await run;
  const j = profileStatus(p, "developer-worker");
  console.log("R3 events:", events.join(" | "));
  console.log("R3 result:", res.state, res.reason, "node state:", j.steps.find((s: { id: string }) => s.id === "node")?.state, "later calls:", f.log.slice(f.log.indexOf("execute:node") + 1).join(","));
  expect(res.state).toBe("revoked");
  expect(j.steps.find((s: { id: string }) => s.id === "node")?.state).toBe("uncertain");
  expect(f.log.includes("execute:pnpm")).toBe(false);
  // The installer ran to completion AFTER revocation: this is the residual window (finding).
  expect(events.indexOf("node-finished-installing")).toBeGreaterThan(events.indexOf("revoked-while-node-running"));
});

test("R4: retry never re-executes a step recorded done, even when inspect now says missing", async () => {
  const p = home(); createGrant(p, fields);
  const f = fake();
  const first = await applyProfile(p, "developer-worker", okCtx(p), f.ex, {});
  console.log("R4 first:", first.state, first.journal.steps.map((s: { id: string; state: string }) => `${s.id}=${s.state}`).join(" "));
  const calls = f.log.filter((l) => l.startsWith("execute:")).length;
  f.installed.clear();
  const second = await applyProfile(p, "developer-worker", okCtx(p), f.ex, {});
  console.log("R4 second:", second.state, "extra executes:", f.log.filter((l) => l.startsWith("execute:")).length - calls);
  expect(f.log.filter((l) => l.startsWith("execute:")).length).toBe(calls);
});

test("R5: interrupted 'started' -> markInterrupted -> uncertain; retry reruns ONLY when inspect says missing", async () => {
  const p = home(); createGrant(p, fields);
  // simulate crash: journal has node=started
  const j0 = profileStatus(p, "developer-worker");
  const started = { ...j0, steps: j0.steps.map((s: { id: string }, i: number) => (s.id === "node" ? { ...s, state: "started", attempts: 1, at: 5 } : s)) };
  writeFileSync(join(p, "provision-developer-worker.json"), JSON.stringify(started) + "\n", { mode: 0o600 });
  expect(markInterrupted(p, "developer-worker").steps.find((s: { id: string }) => s.id === "node")?.state).toBe("uncertain");
  const f = fake({ installed: new Set(["walkie-daemon", "bun", "node"]) }); // half-done install actually completed
  await applyProfile(p, "developer-worker", okCtx(p), f.ex, {});
  console.log("R5 executes when node was actually installed:", f.log.filter((l) => l === "execute:node").length);
  expect(f.log.includes("execute:node")).toBe(false);
});

test("R6: a missing system prerequisite does not stop user-space steps", async () => {
  const p = home(); createGrant(p, fields);
  // real executor semantics: kind 'check' (bun) that mismatches and kind 'installer_elevation' both return needs_installer_elevation
  const f = fake({ installed: new Set(["walkie-daemon"]), onExecute: async (s) => (s.id === "bun" ? "needs_installer_elevation" : undefined) });
  const res = await applyProfile(p, "developer-worker", okCtx(p), f.ex, {});
  console.log("R6", res.state, "executed:", f.log.filter((l) => l.startsWith("execute:")).join(","));
  expect(res.state).toBe("needs_installer_elevation");
  expect(f.log).toContain("execute:node");
  expect(f.log).toContain("execute:codex");
});

// --------------------------------------------- executor ---------------------------------------------------
test("E1: lockProblem accepts all 3 shipped locks and rejects tampering", async () => {
  const pnpm = (await import(`${R}/locks/pnpm/package-lock.json`)).default;
  const claude = (await import(`${R}/locks/claude-code/package-lock.json`)).default;
  const codex = (await import(`${R}/locks/codex/package-lock.json`)).default;
  expect(lockProblem(pnpm, "pnpm", "10.34.3")).toBeNull();
  expect(lockProblem(claude, "@anthropic-ai/claude-code", "2.1.285")).toBeNull();
  expect(lockProblem(codex, "@openai/codex", "0.159.1")).toBeNull();
  const t = structuredClone(codex) as any; t.packages["node_modules/@openai/codex"].resolved = "http://registry.npmjs.org/x.tgz";
  expect(lockProblem(t, "@openai/codex", "0.159.1")).toBe("unverified_package");
  const t2 = structuredClone(codex) as any; delete t2.packages["node_modules/@openai/codex"].integrity;
  expect(lockProblem(t2, "@openai/codex", "0.159.1")).toBe("unverified_package");
  const t3 = structuredClone(codex) as any; t3.packages["node_modules/@openai/codex"].resolved = "https://registry.npmjs.org.evil.example/x.tgz";
  console.log("E1 host-suffix spoof 'registry.npmjs.org.evil.example' ->", lockProblem(t3, "@openai/codex", "0.159.1"));
  const t4 = structuredClone(codex) as any; t4.packages["node_modules/@openai/codex"].resolved = "https://registry.npmjs.org@evil.example/x.tgz";
  console.log("E1 userinfo spoof 'registry.npmjs.org@evil.example' ->", lockProblem(t4, "@openai/codex", "0.159.1"));
});

test("E2: node archive: fixed URL, redirect:'error', wrong bytes rejected BEFORE anything is written under provision-tools", async () => {
  const p = home();
  const seen: { url: string; init: any }[] = [];
  globalThis.fetch = (async (u: unknown, init: unknown) => { seen.push({ url: String(u), init }); return new Response(new Uint8Array([1, 2, 3])); }) as never;
  const spawns: unknown[] = [];
  const s1 = spyOn(Bun, "spawn").mockImplementation(((a: unknown) => { spawns.push(a); throw new Error("spawn blocked"); }) as never);
  const s2 = spyOn(Bun, "spawnSync").mockImplementation(((a: unknown) => { spawns.push(a); throw new Error("spawnSync blocked"); }) as never);
  try {
    const node = PROFILES["developer-worker"].steps.find((s: Step) => s.id === "node") as Step;
    let err = "";
    try { await executorFor(p).execute(node); } catch (e) { err = (e as Error).message; }
    console.log("E2 error:", err, "| fetch:", seen.map((x) => `${x.url} redirect=${x.init?.redirect}`).join(";"), "| spawns:", spawns.length, "| provision-tools exists:", existsSync(join(p, "provision-tools")));
    expect(err).toBe("Node archive checksum mismatch");
    expect(seen[0]?.url).toMatch(/^https:\/\/nodejs\.org\/dist\/v22\.20\.0\/node-v22\.20\.0-(darwin|linux)-(arm64|x64)\.tar\.xz$/);
    expect(seen[0]?.init?.redirect).toBe("error");
    expect(existsSync(join(p, "provision-tools"))).toBe(false);
    expect(spawns.length).toBe(0);
  } finally { s1.mockRestore(); s2.mockRestore(); }
});

test("E3: node archive size cap", async () => {
  const p = home();
  globalThis.fetch = (async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(8 * 1024 * 1024)); } }))) as never;
  const node = PROFILES["developer-worker"].steps.find((s: Step) => s.id === "node") as Step;
  let err = ""; try { await executorFor(p).execute(node); } catch (e) { err = (e as Error).message; }
  console.log("E3 error:", err);
  expect(err).toBe("Node archive too large");
});

test("E4: npm step: exact argv, cwd, and a scrubbed env; hostile process.env (NODE_OPTIONS, npm_config_*, proxies) is NOT inherited", async () => {
  const p = home();
  const tools = join(p, "provision-tools");
  const npmCli = join(tools, "node-22.20.0", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  mkdirSync(join(npmCli, ".."), { recursive: true, mode: 0o700 }); writeFileSync(npmCli, "// fake npm");
  mkdirSync(join(tools, "node-22.20.0", "bin"), { recursive: true }); writeFileSync(join(tools, "node-22.20.0", "bin", "node"), "#!/bin/sh\n");
  const hostile = { NODE_OPTIONS: "--require /tmp/evil.js", npm_config_registry: "https://evil.example/", npm_config_script_shell: "/tmp/evil", HTTPS_PROXY: "http://evil:1", NPM_TOKEN: "npm_SECRET", GITHUB_TOKEN: "ghp_SECRET", LD_PRELOAD: "/tmp/evil.so", DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib" };
  const before: Record<string, string | undefined> = {}; for (const k of Object.keys(hostile)) before[k] = process.env[k];
  Object.assign(process.env, hostile);
  const calls: { argv: string[]; opts: any }[] = [];
  const s1 = spyOn(Bun, "spawn").mockImplementation(((argv: string[], opts: any) => { calls.push({ argv, opts }); return { exited: Promise.resolve(0), kill() { /* */ } }; }) as never);
  const s2 = spyOn(Bun, "spawnSync").mockImplementation(((argv: string[]) => { calls.push({ argv, opts: "sync" }); return { exitCode: 1, stdout: Buffer.from(""), stderr: Buffer.from("") }; }) as never);
  try {
    for (const id of ["pnpm", "codex"]) {
      const step = PROFILES["developer-worker"].steps.find((s: Step) => s.id === id) as Step;
      await executorFor(p).execute(step);
    }
    const spawned = calls.filter((c) => c.opts !== "sync");
    for (const c of spawned) {
      console.log("E4 spawn:", JSON.stringify(c.argv.map((a) => a.replace(p, "<HOME>"))), "cwd:", String(c.opts.cwd).replace(p, "<HOME>"), "stdio:", c.opts.stdin, c.opts.stdout, c.opts.stderr);
      console.log("E4 env:", JSON.stringify(Object.fromEntries(Object.entries(c.opts.env as Record<string, string>).map(([k, v]) => [k, String(v).replace(p, "<HOME>")]))));
      for (const k of Object.keys(hostile)) { if (k === "npm_config_registry") expect(c.opts.env[k]).toBe("https://registry.npmjs.org/"); else expect(Object.keys(c.opts.env)).not.toContain(k); }
      expect(c.argv.slice(2)).toEqual(["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev"]);
    }
    expect(spawned.length).toBe(2);
    // package.json content is fixed
    console.log("E4 package.json:", readFileSync(join(tools, "codex", "package.json"), "utf8").trim());
  } finally {
    s1.mockRestore(); s2.mockRestore();
    for (const k of Object.keys(hostile)) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; }
  }
});

test("E5: claude native placement refuses a symlinked source or destination", async () => {
  const p = home();
  const tools = join(p, "provision-tools");
  const npmCli = join(tools, "node-22.20.0", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  mkdirSync(join(npmCli, ".."), { recursive: true, mode: 0o700 }); writeFileSync(npmCli, "// fake npm");
  const platform = `${process.platform}-${process.arch}`;
  const dir = join(tools, "claude-code");
  mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
  const srcDir = join(dir, "node_modules", "@anthropic-ai", `claude-code-${platform}`);
  const destDir = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin");
  mkdirSync(srcDir, { recursive: true }); mkdirSync(destDir, { recursive: true });
  const victim = join(p, "victim.txt"); writeFileSync(victim, "precious");
  symlinkSync(victim, join(srcDir, "claude"));
  writeFileSync(join(destDir, "claude.exe"), "stub");
  const s1 = spyOn(Bun, "spawn").mockImplementation((() => ({ exited: Promise.resolve(0), kill() { /* */ } })) as never);
  const s2 = spyOn(Bun, "spawnSync").mockImplementation((() => ({ exitCode: 1, stdout: Buffer.from(""), stderr: Buffer.from("") })) as never);
  try {
    const step = PROFILES["developer-worker"].steps.find((s: Step) => s.id === "claude-code") as Step;
    let err = ""; try { await executorFor(p).execute(step); } catch (e) { err = (e as Error).message; }
    console.log("E5 symlinked src ->", err, "| victim intact:", readFileSync(victim, "utf8"));
    expect(err).toBe("pinned Claude binary missing");
  } finally { s1.mockRestore(); s2.mockRestore(); }
});

test("E6: check/elevation kinds never spawn anything from execute (root steps refused)", async () => {
  const p = home();
  const spawns: unknown[] = [];
  const s1 = spyOn(Bun, "spawn").mockImplementation(((a: unknown) => { spawns.push(a); throw new Error("blocked"); }) as never);
  const s2 = spyOn(Bun, "spawnSync").mockImplementation(((a: unknown) => { spawns.push(a); throw new Error("blocked"); }) as never);
  try {
    const ex = executorFor(p);
    for (const prof of ["developer-worker", "freight-worker"] as const) {
      for (const s of PROFILES[prof].steps as Step[]) {
        if (s.kind === "installer_elevation" || s.kind === "check") expect(await ex.execute(s)).toBe("needs_installer_elevation");
      }
    }
    expect(spawns.length).toBe(0);
    // no sudo/su/doas string anywhere in the executor source
    const src = readFileSync(`${R}/executor.ts`, "utf8") + readFileSync(`${R}/runner.ts`, "utf8") + readFileSync(`${R}/routes.ts`, "utf8");
    console.log("E6 mentions of sudo/su/doas/pkexec/osascript in provision runtime sources:", (src.match(/\b(sudo|doas|pkexec|osascript|runas)\b/g) ?? []).length);
    expect(/\b(sudo|doas|pkexec|osascript|runas)\b/.test(src)).toBe(false);
  } finally { s1.mockRestore(); s2.mockRestore(); }
});

test("E7: stock system tool versions meet the profile minimums", async () => {
  const canned: Record<string, string> = { git: "git version 2.43.0", make: "GNU Make 4.3", jq: "jq-1.7.1", age: "v1.1.1", ssh: "OpenSSH_9.6p1 Ubuntu-3ubuntu13", openssl: "OpenSSL 3.0.13 30 Jan 2024", unzip: "UnZip 6.00 of 20 April 2009", psql: "psql (PostgreSQL) 16.4", postgres: "postgres (PostgreSQL) 16.4" };
  for (const s of PROFILES["developer-worker"].steps as Step[]) {
    if (s.kind !== "installer_elevation") continue;
    expect(systemVersionAtLeast(canned[s.command!] ?? "", s.version)).toBe(true);
  }
});
