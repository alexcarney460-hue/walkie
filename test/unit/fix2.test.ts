// WALKIE-MISSION-1 fix round 2: the round-2 audits' findings (Codex r2, Opus r2) as regression tests.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoContext } from "../../src/agent/identity.ts";
import { SessionFiles } from "../../src/daemon/activity.ts";
import { HEARTBEAT_MS, SWEEP_GRACE_MS } from "../../src/daemon/discovery.ts";
import { SystemProcessProvider } from "../../src/daemon/procs.ts";
import type { SyncManager } from "../../src/daemon/sync.ts";
import { agentsView } from "../../src/daemon/views.ts";
import { describeTool, titleFromPrompt } from "../../src/hooks/activity.ts";
import { classifyNotification, transition } from "../../src/hooks/claude.ts";
import { stateProvenance } from "../../src/hooks/state.ts";
import { runCodexHook } from "../../src/hooks/codex.ts";
import { redactSecrets } from "../../src/protocol/safety.ts";
import { projectStatus } from "../../src/protocol/status-projection.ts";
import { accept, beginMore, failed, initialPager, restart } from "../../web/src/views/mission/archive-pager.ts";
import { addCpu, AGENT, hook, jl, ME, prompt, status, toolCall, toolResult, world } from "../helpers/discovery-world.ts";
import { fakeDaemon } from "../helpers/fake-daemon.ts";
import { runAsPerson } from "../helpers/person-cli.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });
const onlineSync = { isOnline: () => true } as unknown as SyncManager;
const TICK = 15_000;
const tmp = (p: string) => { const d = mkdtempSync(`/tmp/walkie-fix2-${p}-`); cleanups.push(() => rmSync(d, { recursive: true, force: true })); return d; };

// ---- Codex r2 #3 / Opus r2 #3: redaction ----------------------------------------------------------------------------

const S = "Sup3rS3cretPw";
/** The Opus r2 corpus (scratchpad m2/redact2.ts): [label, command, what must not appear]. */
const CORPUS: Array<[string, string, string]> = [
  ["pg url", ("export DATABASE_URL=postgres://app:" + "Sup3rS3cretPw@db.internal:5432/app"), S],
  ["PGPASSWORD", "PGPASSWORD=Sup3rS3cretPw psql -h db -U app", S],
  ["mysql -p", "mysql -uroot -pSup3rS3cretPw", S],
  ["sshpass", "sshpass -p Sup3rS3cretPw ssh almond", S],
  ["auth lin", ("curl -H 'Authorization: li" + "n_api_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789' https://api.linear.app"), "AbCdEfGhIjKlMnOp"],
  ["bearer", "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCD' x", "abcdefghijklmnopqrstuvwxyz0123"],
  ["ghp url", ("git clone https://alex:gh" + "p_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789@github.com/x/y"), "AbCdEfGhIjKlMnOp"],
  ["stripe", ("STRIPE_KEY=sk" + "_live_51AbCdEfGhIjKlMnOpQrStUvWxYz ./run"), "51AbCdEfGhIj"],
  ["tskey", ("tailscale up --authkey ts" + "key-auth-kAbCdEf1CNTRL-AbCdEfGhIjKlMnOpQrStUvWxYz"), "kAbCdEf1CNTRL"],
  ["fly", ("fly secrets set API_TOKEN=Fl" + "yV1 fm" + "2_lJPECAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), "lJPECAAAA"],
  ["docker", "echo hunter2hunter2 | docker login -u alex --password-stdin", "hunter2hunter2"],
  ["--password", "node app.js --password Sup3rS3cretPw", S],
  ["xoxb heredoc", ("vercel env add X <<< 'xo" + "xb-1234567890-abcdefghijklmnop'"), "abcdefghijklmnop"],
  ["curl user flag", ("curl -u alex:" + "Sup3rS3cretPw https://api.example.com"), S],
  ["cookie hdr", ("curl -H 'Coo" + "kie: session=Sup3rS3cretPwLongValue123' https://x"), S],
  ["x-api-key hdr", ("curl -H 'X-Api" + "-Key: Sup3rS3cretPwLongValue123' https://x"), S],
  ["npm authToken", ("npm config set //registry.npmjs.org/:_authToken=np" + "m_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"), "AbCdEfGhIjKlMnOp"],
  ["hf token", ("huggingface-cli login --token hf" + "_AbCdEfGhIjKlMnOpQrStUvWxYz01234567"), "AbCdEfGhIjKlMnOp"],
  ["gitlab", ("git clone https://oauth2:gl" + "pat-AbCdEfGhIjKlMnOpQrSt@gitlab.com/x"), "AbCdEfGhIjKlMnOpQrSt"],
  ["google key", ("curl 'https://maps.googleapis.com/x?key=AI" + "zaSyAbCdEfGhIjKlMnOpQrStUvWxYz0123456'"), "AbCdEfGhIjKlMnOp"],
  ["query token", "curl 'https://api.x.com/v1?access_token=Sup3rS3cretPwLongValue123'", S],
  ["export lower", "export db_pass=Sup3rS3cretPw", S],
  ["gh auth stdin", ("echo gh" + "p_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 | gh auth login --with-token"), "AbCdEfGhIjKlMnOp"],
  ["anthropic", ("ANTHROPIC_API_KEY=sk" + "-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 claude -p hi"), "AbCdEfGhIjKlMnOp"],
  ["sendgrid", ("curl -H 'Authorization: Bearer SG" + ".AbCdEfGhIjKlMnOpQrSt.UvWxYz0123456789AbCdEfGhIjKlMnOpQrSt' x"), "AbCdEfGhIjKlMnOpQrSt"],
  ["jwt bare", ("curl -d token ey" + "JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U x"), "dozjgNryP4J3"],
  ["openssl pass", "openssl enc -aes-256-cbc -pass pass:Sup3rS3cretPw -in f", S],
  ["psql conn kv", "psql 'host=db user=app password=Sup3rS3cretPw dbname=x'", S],
  ["aws secret", "export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI"],
  ["keychain -w", "security add-generic-password -a alex -s svc -w Sup3rS3cretPw", S],
  ["api-key hdr", "curl -H \"api-key: Sup3rS3cretPwLongValue123\" x", S],
  ["multiword quoted", `CLIENT_SEC${""}RET="Zq8Rt3Wv9Lp2Xk7Mn SecondSecretPart" ./run`, "SecondSecretPart"],
  ["quoted password", `psql "password='two secret words' host=db"`, "secret words"],
];

describe("redaction (Codex r2 #3, Opus r2 #3)", () => {
  test.each(CORPUS)("%s", (_l, cmd, secret) => {
    expect(describeTool("Bash", { command: cmd }, "", true)).not.toContain(secret);
    expect(redactSecrets(cmd).text).not.toContain(secret);
  });

  test("an input too long to redact whole shows no detail: a long quoted PGPASSWORD, a PEM whose END is past 8 KiB", () => {
    expect(describeTool("Bash", { command: `PGPASSWORD="${"Q".repeat(9_000)}" psql` }, "", true)).toBe("Running a command");
    for (const extra of [30, 40, 45, 48, 50, 55]) { // m2/cut8k.ts
      const cmd = `echo '-----BEG${""}IN PRIVATE KEY-----${"A".repeat(8080 + extra)}-----END PRIVATE KEY-----' ; export T=sk${""}-ant-api03-${"Q".repeat(60)}`;
      expect(describeTool("Bash", { command: cmd }, "", true)).toBe("Running a command");
    }
    expect(titleFromPrompt(`use ${"y".repeat(9_000)} sk${""}-ant-api03-${"Z".repeat(40)}`)).toBe("");
  });

  test("a PEM block without its END is redacted to the end; a partly redacted value is redacted whole", () => {
    expect(describeTool("Bash", { command: `echo '-----BEG${""}IN RSA PRIVATE KEY-----\nMIIEow${"B".repeat(300)}` }, "", true)).not.toContain("MIIEow");
    expect(redactSecrets("API_TOKEN=[REDACTED:secret]tail-of-it more").text).toMatch(/^API_TOKEN=\[REDACTED:[a-z_]+\] more$/);
    expect(redactSecrets("docker login --password-stdin; git push; monkey=banana; OLDPWD=/x; token list").text)
      .toBe("docker login --password-stdin; git push; monkey=banana; OLDPWD=/x; token list");
  });

  test("the Codex hook redacts the reply line before shortening it (share_prompts on)", async () => {
    const home = tmp("codexhome");
    writeFileSync(join(home, "config.json"), JSON.stringify({ share_prompts: true }));
    const d = fakeDaemon({ "POST /v1/status": { event: null } });
    cleanups.push(d.stop);
    const saved = { h: process.env.WALKIE_HOME, s: process.env.WALKIE_SOCKET };
    process.env.WALKIE_HOME = home; process.env.WALKIE_SOCKET = d.socket;
    try {
      const token = `ghp_${"Ab3Cd5Ef7Gh9Ij1Kl3Mn5Op7Qr9St1Uv3Wx5Y"}`;
      for (const pad of [150, 160, 165, 168]) {
        await runCodexHook(JSON.stringify({ type: "agent-turn-complete", "thread-id": "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0009", cwd: "/tmp", "input-messages": ["x"], "last-assistant-message": `${"r".repeat(pad)} ${token}` }), {});
      }
      await runCodexHook(JSON.stringify({ type: "agent-turn-complete", "thread-id": "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0009", cwd: "/tmp", "input-messages": ["x"], "last-assistant-message": `${"r".repeat(5_000)} ${token}` }), {});
    } finally {
      for (const [k, v] of Object.entries({ WALKIE_HOME: saved.h, WALKIE_SOCKET: saved.s })) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    const acts = d.requests.filter((r) => r.path === "/v1/status").map((r) => String((r.body as { activity?: string }).activity));
    expect(acts).toHaveLength(5);
    for (const a of acts) expect(a).not.toMatch(/Ab3Cd5|Cd5Ef7|Uv3Wx5/);
    expect(acts[4]).toBe("Finished turn"); // too long to redact whole
  });
});

// ---- Codex r2 #1 / #5: notifications and task provenance in the hook -------------------------------------------------

describe("hook notifications and task keys", () => {
  test("notifications are classified; their text only with share_activity", () => {
    expect(classifyNotification("permission_prompt", "x")).toEqual({ state: "waiting", phrase: "Needs your permission" });
    expect(classifyNotification("elicitation_dialog", "x")).toEqual({ state: "waiting", phrase: "Needs your answer" });
    expect(classifyNotification("idle_prompt", "x")).toEqual({ state: "idle", phrase: "Waiting for input" });
    expect(classifyNotification("auth_success", "x")).toBeNull();
    expect(classifyNotification(undefined, "Claude needs your permission to use Bash")?.phrase).toBe("Needs your permission");
    expect(classifyNotification(undefined, "something else")).toBeNull();
    const msg = "Claude needs your permission to Read /private/acquisition/ORION-742.xlsx at https://internal.example/deal";
    const off = transition({ hook_event_name: "Notification", notification_type: "permission_prompt", message: msg }, { injected: [] }, 1);
    expect(off).toMatchObject({ state: "waiting", activity: "Needs your permission", activityKind: "phrase" });
    const on = transition({ hook_event_name: "Notification", notification_type: "permission_prompt", message: msg }, { injected: [] }, 1, { prompts: false, activity: true });
    expect(on).toMatchObject({ state: "waiting", activityKind: "notification" });
  });

  test("a prompt's issue key cached while sharing was on is not re-sent once off (task provenance)", () => {
    const on = transition({ hook_event_name: "UserPromptSubmit", prompt: "fix ORION-742 now" }, { injected: [] }, 1, { prompts: true, activity: false });
    expect(on?.next).toMatchObject({ task: "ORION-742", task_src: "prompt", title_src: "prompt" });
    const off = transition({ hook_event_name: "UserPromptSubmit", prompt: "next thing" }, on?.next ?? { injected: [] }, 2);
    // The cache keeps it, but what goes out is decided by provenance (the projection drops a prompt key without sharing).
    const body = projectStatus({ agent: "cc-1", state: "working", runtime: "claude-code", task: off?.next.task, title: off?.next.title, branch: "main" },
      stateProvenance(off?.next ?? {}), { prompts: false, activity: false });
    expect(body.task).toBeUndefined();
    expect(body.title).toBe("Working on a task");
  });
});

// ---- Codex r2 #6: a verifiably pending tool keeps working, rendered, beyond 30 min -----------------------------------

describe("quiet tools (Codex r2 #6)", () => {
  test("Claude: a hook's working with a live tool process stays working as RENDERED beyond 30 min (heartbeat)", async () => {
    const w = world(cleanups);
    const d = w.disc();
    w.write([toolCall("Bash", { command: "ssh almond ./gate.sh" })]);
    w.fx.procs.push({ pid: 103, ppid: 100, uid: ME, startedAt: w.clock.t, command: "ssh almond", cpuMs: 0 });
    hook(w.core, "working", "Running a command");
    for (let i = 0; i < 35 * 4; i++) { w.clock.t += TICK; await d.tick(); }
    expect(agentsView(w.core, onlineSync, w.clock.t).find((a) => a.agent === AGENT)?.effective_state).toBe("working");
    // The tool ends (its process is gone, the result is written): the turn goes on, then ends; idle follows.
    w.fx.procs = w.fx.procs.filter((p) => p.pid !== 103);
    w.write([toolResult("done"), { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }, { type: "system", subtype: "turn_duration" }]);
    for (let i = 0; i < 16; i++) { w.clock.t += TICK; await d.tick(); }
    expect(status(w.core, AGENT)?.state).toBe("idle");
  });

  test("Codex: a function call with no output and its live process: working beyond 30 min (discovery's own)", async () => {
    const w = world(cleanups);
    w.fx.procs = w.fx.procs.filter((p) => p.pid < 100);
    const rollout = join(w.root, "rollout-2026-09-26T10-00-00-0199bbbb-cccc-4ddd-8eee-ffff00001111.jsonl");
    writeFileSync(rollout, jl({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "sleep 3000" }) } }));
    utimesSync(rollout, new Date(w.clock.t), new Date(w.clock.t));
    w.fx.procs.push({ pid: 300, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "codex exec go", cpuMs: 1 });
    w.fx.procs.push({ pid: 301, ppid: 300, uid: ME, startedAt: w.clock.t, command: "sleep 3000", cpuMs: 0 });
    w.fx.files.set(300, [rollout]);
    const d = w.disc();
    for (let i = 0; i < 35 * 4; i++) { await d.tick(); w.clock.t += TICK; }
    expect(agentsView(w.core, onlineSync, w.clock.t).find((a) => a.agent === "codex-0199bb")?.effective_state).toBe("working");
    expect(HEARTBEAT_MS).toBeLessThan(30 * 60_000);
  });
});

// ---- Codex r2 #7 / #9 / #10: session files and auxiliary reads ----------------------------------------------------

describe("session files (Codex r2 #7, #9, #10)", () => {
  test("#7 a big tool result followed by bookkeeping: read back to the turn evidence (mid-turn), not 'turn ended'", () => {
    const d = tmp("readback");
    const p = join(d, "t.jsonl");
    writeFileSync(p, jl(toolCall("Read", { file_path: "/x" }), toolResult("y".repeat(40_000)), { type: "queue-operation", operation: "enqueue" }));
    expect(new SessionFiles().read(p, "claude")?.info).toMatchObject({ midTurn: true, turnSeen: true });
  });

  test("#9 a cached transcript whose project directory is swapped for a symlink outside is no longer read", () => {
    const d = tmp("swap");
    const cfg = join(d, "cfg");
    const sid = "aaaa1111-0000-4000-8000-00000000000a";
    const proj = join(cfg, "projects", "-w");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, `${sid}.jsonl`), jl(prompt("mine")));
    const files = new SessionFiles();
    const path = files.claudeTranscript(cfg, "/w", sid, 1);
    expect(path).toBe(join(proj, `${sid}.jsonl`));
    expect(files.read(path as string, "claude")).not.toBeNull();
    const outside = join(d, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, `${sid}.jsonl`), jl(prompt("someone else's"), toolCall("Bash", { command: "x" })));
    renameSync(proj, join(d, "moved"));
    symlinkSync(outside, proj);
    expect(files.claudeTranscript(cfg, "/w", sid, 2)).toBeNull(); // the cached path is re-validated
    expect(files.read(path as string, "claude")).toBeNull(); // and a read bound to the root refuses it
  });

  test("#10 .git/HEAD and sessions/<pid>.json as FIFOs or symlinks never block and are not read", async () => {
    const d = tmp("aux");
    const repo = join(d, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    expect(Bun.spawnSync(["mkfifo", join(repo, ".git", "HEAD")]).exitCode).toBe(0);
    const t0 = Date.now();
    expect(repoContext(repo)).toMatchObject({ repo: "repo" });
    expect(repoContext(repo).branch).toBeUndefined();
    writeFileSync(join(d, "gitfile-target"), "x");
    const wt = join(d, "wt");
    mkdirSync(wt);
    expect(Bun.spawnSync(["mkfifo", join(wt, ".git")]).exitCode).toBe(0);
    expect(repoContext(wt).branch).toBeUndefined();
    const cfg = join(d, "claude");
    mkdirSync(join(cfg, "sessions"), { recursive: true });
    expect(Bun.spawnSync(["mkfifo", join(cfg, "sessions", "4242.json")]).exitCode).toBe(0);
    const provider = new SystemProcessProvider();
    expect(await provider.claudeSession(4242, cfg)).toBeUndefined();
    writeFileSync(join(d, "real.json"), JSON.stringify({ pid: 4343, sessionId: "abc" }));
    symlinkSync(join(d, "real.json"), join(cfg, "sessions", "4343.json"));
    expect(await provider.claudeSession(4343, cfg)).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

// ---- Codex r2 #8 / #12, Opus r2 #4: discovery bookkeeping ---------------------------------------------------------

describe("discovery bookkeeping", () => {
  test("#8 crossing the per-runtime cap: the session no longer reported is NOT marked offline (its process runs)", async () => {
    const w = world(cleanups);
    w.fx.procs = w.fx.procs.filter((p) => p.pid < 100);
    for (let i = 0; i < 3; i++) w.fx.procs.push({ pid: 900 + i, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000 + i * 1000, command: "codex", cpuMs: 1 });
    const d = w.disc({ maxPerRuntime: 3 });
    await d.tick();
    expect(status(w.core, "codex-pid900")?.state).toBe("idle");
    w.clock.t += TICK;
    w.fx.procs.push({ pid: 903, ppid: 1, uid: ME, startedAt: w.clock.t, command: "codex", cpuMs: 1 }); // newer: 900 drops out
    await d.tick();
    expect(status(w.core, "codex-pid903")?.state).toBe("idle");
    expect(status(w.core, "codex-pid900")?.state).toBe("idle"); // not "Process exited"
    w.fx.procs = w.fx.procs.filter((p) => p.pid !== 900); // now it really ends
    w.clock.t += TICK;
    await d.tick();
    expect(status(w.core, "codex-pid900")?.state).toBe("offline");
  });

  test("#12 an overall scan budget: sessions not examined in time keep their state; the next scans catch up", async () => {
    const w = world(cleanups);
    w.fx.procs = w.fx.procs.filter((p) => p.pid < 100);
    for (let i = 0; i < 12; i++) { w.fx.procs.push({ pid: 1000 + i, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000 - i, command: "kimi", cpuMs: 1 }); w.fx.cwds.set(1000 + i, w.cwd); }
    const d = w.disc({ scanBudgetMs: 60_000, concurrency: 4 });
    await d.tick();
    expect(w.core.store.agents().filter((r) => r.agent.startsWith("kimi-pid")).length).toBe(12);
    // Now every lookup is slow (a stuck lsof): with a 250 ms budget only some are examined.
    const slow = w.disc({ scanBudgetMs: 250, concurrency: 2 });
    const cwd = w.fx.cwd.bind(w.fx);
    w.fx.cwd = async (pid: number) => { await Bun.sleep(200); return cwd(pid); };
    w.clock.t += SWEEP_GRACE_MS * 2;
    await slow.tick();
    const rows = w.core.store.agents().filter((r) => r.agent.startsWith("kimi-pid"));
    expect(rows.length).toBe(12);
    expect(rows.every((r) => (JSON.parse(r.body) as { state: string }).state !== "offline")).toBe(true);
  });

  test("Opus r2 #4: a session that cd'd into a subdirectory still takes over its hook card (no ghost)", async () => {
    const w = world(cleanups);
    w.fx.env.set(101, {}); // unnamed
    const sub = join(w.cwd, "packages", "web");
    mkdirSync(sub, { recursive: true });
    hook(w.core, "idle", "Finished turn", "cc-subdir", { cwd: repoContext(sub).cwd });
    const d = w.disc();
    w.clock.t += 60_000;
    await d.tick();
    for (let i = 0; i < 2; i++) { w.clock.t += TICK; addCpu(w.fx, 100, 5_000); await d.tick(); } // two busy readings
    expect(status(w.core, "claude-pid100")).toBeNull();
    expect(status(w.core, "cc-subdir")?.state).toBe("working");
  });
});

// ---- Codex r2 #11: Archive "Load more" --------------------------------------------------------------------------------

describe("archive pager (Codex r2 #11)", () => {
  test("one page at a time; the cursor comes from the answered page; an old generation's answer is dropped", () => {
    let p = restart(initialPager);
    const g1 = p.gen;
    p = accept(p, g1, 0, { rows: 200, offset: 0, total: 1_000, truncated: true }) ?? p;
    expect(p).toMatchObject({ next: 200, more: true, inflight: null });
    const a = beginMore(p);
    expect(a?.offset).toBe(200);
    p = a?.pager ?? p;
    expect(beginMore(p)).toBeNull(); // a double click: no second request
    p = accept(p, g1, 200, { rows: 200, offset: 200, total: 1_000, truncated: true }) ?? p;
    expect(p.next).toBe(400); // not 600
    const b = beginMore(p);
    p = b?.pager ?? p;
    const restarted = restart(p); // the query changed while page 3 was on its way
    expect(accept(restarted, g1, 400, { rows: 200, offset: 400, truncated: true })).toBeNull();
    expect(failed(restarted, g1)).toBe(restarted);
    expect(beginMore({ ...restarted, inflight: null, more: false })).toBeNull();
  });
});

// ---- Opus r2 #7: a pre-MISSION daemon's whole roster is paged client-side -----------------------------------------

describe("pre-MISSION daemon with 1,200 agents (Opus r2 #7)", () => {
  const TEAM = {
    id: "t-legacy", name: "acme", authority: null, plan: null, channels: [], members: [{ handle: "alex", role: "owner" }],
    nodes: [{ node_id: "n1", handle: "alex", hostname: "mbp", online: true, self: true, authority: true, rtt_ms: null, last_seen: null, sync: { behind: 0, last_sync: null }, stats: null }],
  };
  const agents = Array.from({ length: 1_200 }, (_, i) => ({
    id: `alex/mbp/a${i}`, handle: "alex", node: "n1", hostname: "mbp", agent: `a${i}`, machine_online: true, effective_state: "idle",
    updated_at: Date.now() - i * 1000, status: { agent: `a${i}`, state: "idle", runtime: "claude-code" },
  }));

  test("walkie who --all lists at most 1,000 and counts the rest; MCP walkie_who all: true at most 300", async () => {
    const d = fakeDaemon({ "GET /v1/agents": { agents }, "GET /v1/team": TEAM });
    cleanups.push(d.stop);
    const cli = join(import.meta.dir, "../../src/cli/main.ts");
    const ran = await runAsPerson([process.execPath, cli, "who", "--all", "--json"], { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: "/nonexistent", WALKIE_SOCKET: d.socket });
    const out = JSON.parse(ran.out) as { agents: unknown[]; total: number; truncated: boolean };
    expect(out.agents).toHaveLength(1_000);
    expect(out).toMatchObject({ total: 1_200, truncated: true });
    const { callTool } = await import("../../src/mcp/tools.ts");
    const { WalkieClient } = await import("../../src/client/index.ts");
    const r = await callTool(new WalkieClient({ socket: d.socket, agent: "cc-x" }), "walkie_who", { all: true }) as { content: Array<{ text: string }> };
    const lines = (r.content[0]?.text ?? "").split("\n").filter((l) => l.startsWith("@alex/mbp/"));
    expect(lines).toHaveLength(300);
    expect(r.content[0]?.text).toContain("900 older agents not listed");
  });
});
