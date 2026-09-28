// WALKIE-MISSION-1 fix round 3: the round-3 audits' findings (Codex r3, Opus r3) as regression tests.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WalkieClient } from "../../src/client/index.ts";
import { parseTail } from "../../src/daemon/activity.ts";
import type { SyncManager } from "../../src/daemon/sync.ts";
import { agentsView } from "../../src/daemon/views.ts";
import { describeTool, titleFromPrompt } from "../../src/hooks/activity.ts";
import { callTool, SET_STATUS_WARNING, TOOLS } from "../../src/mcp/tools.ts";
import { redactSecrets } from "../../src/protocol/safety.ts";
import { projectStatus } from "../../src/protocol/status-projection.ts";
import { accept, initialPager, invalidate, restart } from "../../web/src/views/mission/archive-pager.ts";
import { AGENT, hook, jl, ME, status, toolCall, world } from "../helpers/discovery-world.ts";
import { fakeDaemon } from "../helpers/fake-daemon.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });
const onlineSync = { isOnline: () => true } as unknown as SyncManager;
const TICK = 15_000;
const rendered = (w: ReturnType<typeof world>, agent: string) => agentsView(w.core, onlineSync, w.clock.t).find((a) => a.agent === agent)?.effective_state;

// ---- Codex r3 #1: deliberate titles ------------------------------------------------------------------------------------

describe("deliberate titles (Codex r3 #1)", () => {
  test("walkie_set_status warns the model that the whole team sees the title; so do the MCP instructions", async () => {
    const tool = TOOLS.find((t) => t.name === "walkie_set_status");
    expect(tool?.description).toContain("This title is visible to your whole team.");
    expect(tool?.description).toContain("never paste prompt text, customer names, secrets or confidential details");
    expect(SET_STATUS_WARNING).toContain("Describe the kind of work");
    const server = await Bun.file(join(import.meta.dir, "../../src/mcp/server.ts")).text();
    expect(server).toContain("That title is visible to your whole team");
  });

  test("provenance is precise: walkie_set_status = agent, `walkie status` = person; both are shared, unknown is not", async () => {
    const d = fakeDaemon({ "POST /v1/status": { event: null } });
    cleanups.push(d.stop);
    const home = join(d.socket, "..", "home");
    mkdirSync(join(home, "agents"), { recursive: true });
    const saved = { h: process.env.WALKIE_HOME };
    process.env.WALKIE_HOME = home;
    try {
      await callTool(new WalkieClient({ socket: d.socket, agent: "cc-prov" }), "walkie_set_status", { title: "Refactoring the billing parser", task: "ALE-5" });
    } finally {
      if (saved.h === undefined) delete process.env.WALKIE_HOME; else process.env.WALKIE_HOME = saved.h;
    }
    const cli = Bun.spawn([process.execPath, join(import.meta.dir, "../../src/cli/main.ts"), "status", "Typed by me", "--agent", "cli-p"], {
      env: { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: home, WALKIE_SOCKET: d.socket }, stdout: "pipe", stderr: "pipe",
    });
    expect(await cli.exited).toBe(0);
    const provs = d.requests.filter((r) => r.path === "/v1/status").map((r) => (r.body as { provenance?: Record<string, string> }).provenance);
    expect(provs[0]).toMatchObject({ title: "agent", task: "agent" });
    expect(provs[1]).toMatchObject({ title: "person", task: "person" });
    const off = { prompts: false, activity: false };
    const body = { agent: "a", state: "working" as const, runtime: "cli" as const, title: "T", task: "ALE-5" };
    expect(projectStatus(body, { title: "agent", task: "agent" }, off)).toMatchObject({ title: "T", task: "ALE-5" });
    expect(projectStatus(body, { title: "person", task: "person" }, off)).toMatchObject({ title: "T", task: "ALE-5" });
    expect(projectStatus(body, {}, off).title).toBeUndefined();
    // An older CLI / MCP's "explicit" is read as agent.
    expect(projectStatus(body, { title: "explicit" } as never, off).title).toBe("T");
  });
});

// ---- Codex r3 #2, Opus r3 #3: redaction ---------------------------------------------------------------------------------

const S = "Sup3rS3cretPw";
/** Quoted / escaped credential forms (Codex r3 #2). */
const QUOTED: Array<[string, string, string]> = [
  ["sshpass dq", `sshpass -p "${S}" ssh host`, S],
  ["sshpass sq spaces", `sshpass -p 'Sup3r two words' ssh host`, "two words"],
  ["keychain -w dq", `security add-generic-password -a alex -s svc -w "${S}"`, S],
  ["keychain -w sq", `security add-generic-password -a alex -s svc -w 'two secret words'`, "secret words"],
  ["keychain unlock -p", `security unlock-keychain -p "${S}" login.keychain`, S],
  ["curl user flag dq multiword", `curl -${""}u "alex:two secret words" https://x`, "secret words"],
  ["curl user flag sq", `curl --us${""}er 'alex:two secret words' https://x`, "secret words"],
  ["escaped dq", `CLIENT_SECRET="first\\" suffixSecret" ./run`, "suffixSecret"],
  ["escaped sq", `CLIENT_SECRET='first\\' suffixSecret' ./run`, "suffixSecret"],
  ["mysql -p dq", `mysql -uroot -p"two secret words" db`, "secret words"],
  ["mysql -p sq", `mysql -uroot -p'${S}'`, S],
  ["--password dq", `node x --password "two secret words"`, "secret words"],
  ["docker dq", `echo "two secret words" | docker login -u a --password-stdin`, "secret words"],
  ["header escaped", `curl -H "X-Api-Key: \\"quoted secret words\\"" x`, "secret words"],
  ["env escaped", `PGPASSWORD="a \\"b\\" secretword" psql`, "secretword"],
];
/** The Opus r3 corpus (scratchpad m3/redact3.ts). */
const OPUS3: Array<[string, string, string]> = [
  ["pw quoted spaces", `node x --password "correct horse battery staple"`, "horse battery"],
  ["mysql -p'q'", `mysql -uroot -p'Sup3rS3cretPw'`, "Sup3rS3cret"],
  ["basic hdr", `curl -H 'Authorization: Ba${""}sic YWxleDpTdXAzclMzY3JldFB3'`, "YWxleDpTdXAzclMz"],
  ["openai proj", `OPENAI_KEY=sk${""}-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd ./x`, "AbCdEfGhIjKlMnOp"],
  ["openai bare", `echo sk${""}-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd`, "AbCdEfGhIjKlMnOp"],
  ["xai", `echo xa${""}i-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdEFGH`, "AbCdEfGhIjKlMnOp"],
  ["AKIA", `aws configure set aws_access_key_id AK${""}IAIOSFODNN7EXAMPLE`, "IOSFODNN7EXAMPLE"],
  ["azure conn", `az x --connection-string 'DefaultEndpointsProtocol=https;AccountName=a;Ac${""}countKey=Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFy==;'`, "Zm9vYmFyZm9vYmFy"],
  ["mongo srv", `mongosh 'mongodb+srv://app:${""}Sup3rS3cretPw@c0.mongodb.net/db'`, "Sup3rS3cret"],
  ["redis nouser", `redis-cli -u redis://:Sup3rS3cretPw@host:6379`, "Sup3rS3cret"],
  ["--token=", `gh x --token=Sup3rS3cretPwLongValue123`, "Sup3rS3cret"],
  ["--api-key sp", `tool --api-key Sup3rS3cretPwLongValue123`, "Sup3rS3cret"],
  ["PRIVATE-TOKEN", `curl -H "PRIVATE-TOKEN: Sup3rS3cretPwLongValue123" x`, "Sup3rS3cret"],
  ["env quoted 2w", `DB_PASSWORD="two words here" ./run`, "two words"],
  ["client_secret q", `curl 'https://x/token?client_id=a&client_secret=Sup3rS3cretPwLongValue123'`, "Sup3rS3cret"],
  ["vault hvs", `VAULT_TOKEN=hv${""}s.CAESIAbCdEfGhIjKlMnOpQrStUvWxYz01 vault kv get x`, "CAESIAbCdEfGh"],
  ["vault bare hvs", `vault login hv${""}s.CAESIAbCdEfGhIjKlMnOpQrStUvWxYz01`, "CAESIAbCdEfGh"],
  ["doppler", `doppler run --token dp.st.prd.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 -- x`, "AbCdEfGhIjKlMnOp"],
  ["whsec", `echo wh${""}sec_AbCdEfGhIjKlMnOpQrStUvWxYz012345`, "AbCdEfGhIjKlMnOp"],
  ["rk_live", `echo rk${""}_live_51AbCdEfGhIjKlMnOpQrStUvWxYz`, "AbCdEfGhIjKlMnOp"],
  ["github_pat", `echo gi${""}thub_pat_11AAAAAAA0AbCdEfGhIjKl_MnOpQrStUvWxYz0123456789abcdefghijklmnopqrstuvwxyzAB`, "AbCdEfGhIjKl"],
  ["ghs", `echo gh${""}s_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789`, "AbCdEfGhIjKlMnOp"],
  ["shopify", `echo sh${""}pat_0123456789abcdef0123456789abcdef`, "0123456789abcdef0123"],
  ["DO", `doctl auth init -t do${""}p_v1_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`, "0123456789abcdef0123"],
  ["ya29", `curl -H 'x: ya${""}29.a0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789' x`, "a0AbCdEfGhIjKl"],
  ["pypi", `twine upload -p py${""}pi-AgEIcHlwaS5vcmcCJAbCdEfGhIjKlMnOpQrStUvWxYz0123456789`, "AgEIcHlwaS5vcmc"],
  ["sentry", `echo sn${""}trys_eyJpYXQiOjE3MDAwMDAwMDAuMCwidXJsIjoiaHR0cHM6Ly9zZW50cnkuaW8ifQ_AbCdEfGhIjKlMnOpQrStUvWx`, "eyJpYXQiOjE3MDAw"],
  ["atlassian", `echo AT${""}ATT3xFfGF0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKl=ABCD1234`, "AbCdEfGhIjKlMnOp"],
  ["age secret", `echo AG${""}E-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ`, "QQQQQQQQQQQQQQQQ"],
  ["openssh no END", `echo '-----BEG${""}IN OPENSSH PRIVATE KEY----- b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ'`, "b3BlbnNzaC1rZXkt"],
  ["gcp json", `echo '{"private_key": "-----BEG${""}IN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n-----END PRIVATE KEY-----"}'`, "MIIEvQIBADANBgkq"],
  ["yaml pass", `echo 'password: Sup3rS3cretPw' >> cfg.yml`, "Sup3rS3cret"],
  ["passwd=", `ldapsearch passwd=Sup3rS3cretPw`, "Sup3rS3cret"],
  ["twilio", `curl -u AC${""}0123456789abcdef0123456789abcdef:0123456789abcdef0123456789abcdef x`, "0123456789abcdef0123456789abcdef x"],
  ["discord bot", `echo MT${""}AxMjM0NTY3ODkwMTIzNDU2Nw.GAbCdE.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ab`, "AbCdEfGhIjKlMnOpQrSt"],
  ["npm _auth", `npm config set _au${""}th=YWxleDpTdXAzclMzY3JldFB3`, "YWxleDpTdXAzclMz"],
  ["oauth2-bearer", `curl --oauth2-bearer Sup3rS3cretPwLongValue123 x`, "Sup3rS3cret"],
  ["hex 64", `export SIGNING=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`, "0123456789abcdef0123"],
  ["url pw at", `git push https://x-access-token:${""}Sup3rS3cretPw@github.com/a/b`, "Sup3rS3cret"],
  ["slack webhook", `curl https://ho${""}oks.slack.com/services/T0000/B0000/AbCdEfGhIjKlMnOpQrStUvWx`, "AbCdEfGhIjKlMnOp"],
  ["telegram bot", `curl https://api.telegram.org/bot1234567890:${""}AAAbCdEfGhIjKlMnOpQrStUvWxYz012345/sendMessage`, "AAAbCdEfGhIjKlMn"],
  ["unicode ws", `PGPASSWORD=\u00a0Sup3rS3cretPw psql`, "Sup3rS3cret"], // a no-break space, as in m3/redact3.ts
  ["thin space", `PGPASSWORD=\u2009Sup3rS3cretPw psql`, "Sup3rS3cret"],
  ["tab sep flag", `sshpass\t-p\tSup3rS3cretPw ssh x`, "Sup3rS3cret"],
];

describe("redaction (Codex r3 #2, Opus r3 #3)", () => {
  test.each([...QUOTED, ...OPUS3])("%s", (_l, cmd, secret) => {
    expect(redactSecrets(cmd).text).not.toContain(secret);
    expect(describeTool("Bash", { command: cmd }, "", true)).not.toContain(secret);
    expect(titleFromPrompt(cmd)).not.toContain(secret);
    // And in a deliberate (agent-set) title, which is shared whatever the policy.
    const t = projectStatus({ agent: "a", state: "working", runtime: "cli", title: cmd.slice(0, 200) }, { title: "agent" }, { prompts: false, activity: false }).title ?? "";
    expect(t).not.toContain(secret);
  });

  test("ordinary text still reads the same", () => {
    const plain = "docker login --password-stdin; git push; monkey=banana; OLDPWD=/x; token list; security find-generic-password -a a -s s -w";
    expect(redactSecrets(plain).text).toBe(plain);
  });
});

// ---- Codex r3 #3: open tool calls ------------------------------------------------------------------------------------

describe("open tool calls keep a session working, rendered at 35 min (Codex r3 #3)", () => {
  test("Claude: a long MCP-server call (no new process), hook-owned and discovery-owned", async () => {
    const w = world(cleanups);
    const d = w.disc();
    w.write([{ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "mcp__walkie__walkie_ask", input: {} }] } }]);
    hook(w.core, "working", "Using a tool");
    for (let i = 0; i < 35 * 4; i++) { w.clock.t += TICK; await d.tick(); }
    expect(rendered(w, AGENT)).toBe("working");
    // Its result arrives and the turn ends: idle follows.
    w.write([{ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } }, { type: "system", subtype: "turn_duration" }]);
    for (let i = 0; i < 12; i++) { w.clock.t += TICK; await d.tick(); }
    expect(status(w.core, AGENT)?.state).toBe("idle");
  });

  test("Codex: polling an older running command (write_stdin with no output yet)", async () => {
    const w = world(cleanups);
    w.fx.procs = w.fx.procs.filter((p) => p.pid < 100);
    const rollout = join(w.root, "rollout-2026-09-26T10-00-00-0199cccc-dddd-4eee-8fff-000011112222.jsonl");
    writeFileSync(rollout, jl(
      { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "c1", arguments: JSON.stringify({ cmd: "make long" }) } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "still running (session 7)" } },
      { type: "response_item", payload: { type: "function_call", name: "write_stdin", call_id: "c2", arguments: "{}" } },
      { type: "event_msg", payload: { type: "token_count" } },
    ));
    utimesSync(rollout, new Date(w.clock.t), new Date(w.clock.t));
    w.fx.procs.push({ pid: 300, ppid: 1, uid: ME, startedAt: w.clock.t - 3_600_000, command: "codex exec go", cpuMs: 1 });
    w.fx.files.set(300, [rollout]);
    const d = w.disc();
    for (let i = 0; i < 35 * 4; i++) { await d.tick(); w.clock.t += TICK; }
    expect(rendered(w, "codex-0199cc")).toBe("working");
  });
});

// ---- Codex r3 #4: fairness, liveness, health ----------------------------------------------------------------------------

describe("scan budget and cap (Codex r3 #4)", () => {
  test("a budget that runs out rotates: every session gets examined within a few scans", async () => {
    const w = world(cleanups);
    w.fx.procs = w.fx.procs.filter((p) => p.pid < 100);
    for (let i = 0; i < 12; i++) { w.fx.procs.push({ pid: 1100 + i, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000 - i, command: "kimi", cpuMs: 1 }); w.fx.cwds.set(1100 + i, w.cwd); }
    const cwd = w.fx.cwd.bind(w.fx);
    w.fx.cwd = async (pid: number) => { await Bun.sleep(120); return cwd(pid); };
    const d = w.disc({ scanBudgetMs: 300, concurrency: 1 });
    await d.tick();
    expect(w.core.discoveryHealth).toMatchObject({ incomplete: true });
    for (let i = 0; i < 8; i++) { w.clock.t += TICK; await d.tick(); }
    expect(w.core.store.agents().filter((r) => r.agent.startsWith("kimi-pid")).length).toBe(12);
  });

  test("a working agent pushed over the cap keeps a fresh status (liveness only) and renders working at 35 min", async () => {
    const w = world(cleanups);
    w.fx.procs = w.fx.procs.filter((p) => p.pid < 100);
    w.fx.procs.push({ pid: 1200, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "kimi", cpuMs: 1 });
    const d = w.disc({ maxPerRuntime: 1 });
    hook(w.core, "working", "Running a command", "kimi-pid1200", { runtime: "kimi" });
    await d.tick();
    w.fx.procs.push({ pid: 1201, ppid: 1, uid: ME, startedAt: w.clock.t, command: "kimi", cpuMs: 1 }); // newer: 1200 is over the cap
    for (let i = 0; i < 35 * 4; i++) { w.clock.t += TICK; await d.tick(); }
    expect(rendered(w, "kimi-pid1200")).toBe("working");
    expect(w.core.discoveryHealth).toEqual({ incomplete: true, unreported: 1 });
    w.core.machineStats = { at: w.clock.t, mem: null, temp_c: null };
    expect(w.core.publishedStats()?.discovery).toEqual({ incomplete: true, unreported: 1 });
  });
});

// ---- Codex r3 #5 / #6 / #8, Opus r3 #5 --------------------------------------------------------------------------------

describe("Codex tails, fresh branches, live policy, kept deliberate titles", () => {
  test("#5 Codex bookkeeping (token_count, turn_context) is not turn evidence; turn timestamps are kept", () => {
    const only = parseTail(jl({ type: "event_msg", payload: { type: "token_count" } }, { type: "turn_context", payload: { model: "gpt" } }), "codex", false);
    expect(only).toMatchObject({ midTurn: false, newestIsTurn: false });
    expect(only.turnSeen).toBeUndefined();
    const t = parseTail(jl({ type: "event_msg", timestamp: "2026-09-26T10:00:00.000Z", payload: { type: "user_message", message: "x" } }, { type: "event_msg", payload: { type: "token_count" } }), "codex", true);
    expect(t).toMatchObject({ midTurn: true, newestIsTurn: false, turnSeen: true, lastTurnAt: Date.parse("2026-09-26T10:00:00.000Z") });
  });

  test("#6 a checkout changes the published branch (and the branch's task key) on the next update", async () => {
    const w = world(cleanups);
    const d = w.disc();
    w.write([toolCall("Bash", { command: "git checkout" })]);
    await d.tick();
    expect(status(w.core, AGENT)).toMatchObject({ branch: "walkie-mission-1", task: "MISSION-1" });
    writeFileSync(join(w.cwd, ".git", "HEAD"), "ref: refs/heads/feat/ALE-4242-x\n");
    for (let i = 0; i < 45; i++) { w.clock.t += TICK; w.write([toolCall("Bash", { command: "make" })]); await d.tick(); }
    expect(status(w.core, AGENT)).toMatchObject({ branch: "feat/ALE-4242-x", task: "ALE-4242" });
  });

  test("#8 discovery picks up a changed collection policy without a restart", async () => {
    const w = world(cleanups, { prompts: false, activity: false });
    let policy = { prompts: false, activity: false };
    const d = w.disc({ share: () => policy });
    w.write([toolCall("Bash", { command: "make release" })]);
    await d.tick();
    expect(status(w.core, AGENT)?.activity).toBe("Running a command");
    policy = { prompts: false, activity: true };
    writeFileSync(w.core.paths.config, JSON.stringify({ share_activity: true }));
    w.clock.t += 60_000;
    w.write([toolCall("Bash", { command: "make release" })]);
    await d.tick();
    expect(status(w.core, AGENT)?.activity).toBe("$ make release");
  });

  test("Opus r3 #5: a person's `walkie status` title and key are kept through discovery's updates", async () => {
    const w = world(cleanups, { prompts: false, activity: false });
    const d = w.disc();
    w.core.emit("agent.status", { agent: AGENT, state: "idle", runtime: "claude-code", title: "Deploying billing", task: "ALE-42" }, { agent: AGENT, provenance: { title: "person", task: "person" } });
    w.clock.t += 60_000;
    w.write([toolCall("Bash", { command: "make" })]);
    await d.tick();
    expect(status(w.core, AGENT)).toMatchObject({ state: "working", title: "Deploying billing", task: "ALE-42" });
    w.fx.procs = w.fx.procs.filter((p) => p.pid < 100);
    await d.tick();
    expect(status(w.core, AGENT)).toMatchObject({ state: "offline", title: "Deploying billing", task: "ALE-42" });
  });
});

// ---- Codex r3 #7: archive after unmount --------------------------------------------------------------------------------

describe("archive pager after unmount (Codex r3 #7)", () => {
  test("an answer that arrives after the view went away is dropped", () => {
    const p = restart(initialPager);
    const gone = invalidate(p); // unmount
    expect(accept(gone, p.gen, 0, { rows: 200, offset: 0, truncated: true })).toBeNull();
  });
});
