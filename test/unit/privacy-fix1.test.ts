// WALKIE-MISSION-1 fix round 1, privacy (Codex 1/2/3): one sharing policy for discovery and both hooks; prompt titles
// only with share_prompts (existing installs without the key: off), tool text only with share_activity (default off),
// cached prompt titles never carried once off, and secrets redacted BEFORE any shortening, at every cutoff.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSharePolicy, sharePolicy, SHARE_NOTHING } from "../../src/agent/share-policy.ts";
import { ConfigSchema } from "../../src/daemon/config.ts";
import { activityPhrase, describeTool, titleFromPrompt } from "../../src/hooks/activity.ts";
import { runClaudeHook } from "../../src/hooks/claude.ts";
import { runCodexHook } from "../../src/hooks/codex.ts";
import { redactSecrets } from "../../src/protocol/safety.ts";
import { AGENT, endTurn, hook, prompt, SID, status, toolCall, world } from "../helpers/discovery-world.ts";
import { fakeDaemon } from "../helpers/fake-daemon.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });

describe("the sharing policy", () => {
  test("off unless config.json says true; WALKIE_SHARE_PROMPTS=0 wins; unreadable config shares nothing", () => {
    expect(ConfigSchema.parse({})).toMatchObject({ share_prompts: false, share_activity: false });
    expect(sharePolicy({}, {})).toEqual({ prompts: false, activity: false, paths: false }); // an install from before this change
    expect(sharePolicy({ share_prompts: true, share_activity: true, share_paths: true }, {})).toEqual({ prompts: true, activity: true, paths: true });
    expect(sharePolicy({ share_prompts: true }, { WALKIE_SHARE_PROMPTS: "0" })).toEqual({ prompts: false, activity: false, paths: false });
    expect(sharePolicy({ share_prompts: "yes" }, {})).toEqual({ prompts: false, activity: false, paths: false });
    const home = mkdtempSync("/tmp/walkie-policy-");
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    expect(readSharePolicy(home, {})).toEqual(SHARE_NOTHING);
    writeFileSync(join(home, "config.json"), "{not json");
    expect(readSharePolicy(home, {})).toEqual(SHARE_NOTHING);
    writeFileSync(join(home, "config.json"), JSON.stringify({ share_prompts: true }));
    expect(readSharePolicy(home, {})).toEqual({ prompts: true, activity: false, paths: false });
  });

  test("share_activity off: a fixed phrase names the kind of step, never its text", () => {
    expect(describeTool("Bash", { command: "PGPASSWORD=x psql -h db.internal acme_payroll" }, "/")).toBe("Running a command");
    expect(describeTool("Edit", { file_path: "/w/secret-merger-plan.md" }, "/w")).toBe("Editing files");
    expect(describeTool("Grep", { pattern: "acquisition target" }, "/")).toBe("Searching");
    expect(describeTool("Task", { description: "review the layoffs list" }, "/")).toBe("Waiting on a subagent");
    expect(describeTool("WebFetch", { url: "https://x.example/private?token=1" }, "/")).toBe("Fetching a web page");
    expect(activityPhrase("mcp__linear__save_issue")).toBe("Using a tool");
  });
});

// ---- redaction: every new pattern, and every fixed-length pattern at every cutoff ---------------------------------

const PW = "Zq8Rt3Wv9Lp2Xk7Mn";
const SAMPLES: Array<[string, string, string]> = [
  // [label, command, the secret part that must never show]
  ["anthropic", `curl -H "x-api-key: sk${""}-ant-api03-Hq7Lm2Zx9Rt4Wv8Kp3Nd6Yc1Bf5Gj0Ts2Ue" https://api`, "Hq7Lm2Zx9Rt4Wv8Kp3Nd6Yc1Bf5Gj0Ts2Ue"],
  ["openai", ("export OPENAI=sk" + "-proj-Hq7Lm2Zx9Rt4Wv8Kp3Nd6Yc1Bf5Gj0"), "Hq7Lm2Zx9Rt4Wv8Kp3Nd6Yc1Bf5Gj0"],
  ["stripe", ("stripe --api sk" + "_live_51Hq7Lm2Zx9Rt4Wv8Kp3Nd6Y listen"), "51Hq7Lm2Zx9Rt4Wv8Kp3Nd6Y"],
  ["stripe-test", ("run sk" + "_test_51Hq7Lm2Zx9Rt4Wv8Kp3Nd6Y"), "51Hq7Lm2Zx9Rt4Wv8Kp3Nd6Y"],
  ["stripe-restricted", ("run rk" + "_live_51Hq7Lm2Zx9Rt4Wv8Kp3Nd6Y"), "51Hq7Lm2Zx9Rt4Wv8Kp3Nd6Y"],
  ["aws", ("aws configure set aws_access_key_id AK" + "IAQ7LM2ZX9RT4WV8KP"), "Q7LM2ZX9RT4WV8KP"],
  ["github-pat", ("git push https://gi" + "thub_pat_11Hq7Lm2Zx9Rt4Wv8Kp3Nd6Yc1Bf@github.com/x"), "11Hq7Lm2Zx9Rt4Wv8Kp3Nd6Yc1Bf"],
  ["github", `curl -H "Authorization: token gh${""}p_Hq7Lm2Zx9Rt4Wv8Kp3Nd6Yc1Bf5Gj0Ts2UeAbc" x`, "Hq7Lm2Zx9Rt4Wv8Kp3Nd6Yc1Bf5Gj0Ts2UeAbc"],
  ["slack", ("vercel env add X <<< 'xo" + "xb-1234567890-Hq7Lm2Zx9Rt4Wv8K'"), "1234567890-Hq7Lm2Zx9Rt4Wv8K"],
  ["linear", ("curl -H 'Authorization: li" + "n_api_Hq7Lm2Zx9Rt4Wv8Kp3Nd6Yc1Bf5Gj0' https://api.linear.app"), "Hq7Lm2Zx9Rt4Wv8Kp3Nd6Yc1Bf5Gj0"],
  ["tailscale", ("tailscale up --authkey ts" + "key-auth-kHq7Lm2Zx9CNTRL-Rt4Wv8Kp3Nd6Yc1Bf5Gj0"), "kHq7Lm2Zx9CNTRL-Rt4Wv8Kp3Nd6Yc1Bf5Gj0"],
  ["fly", ("fly secrets set X=1 --access-token 'Fl" + "yV1 fm" + "2_lJPECAAAAAAAHq7Lm2Zx9Rt4Wv8Kp3Nd6Yc1Bf5Gj0'"), "lJPECAAAAAAAHq7Lm2Zx9Rt4Wv8Kp3Nd6Yc1Bf5Gj0"],
  ["jwt", ("curl -b session=ey" + "JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.Hq7Lm2Zx9Rt4Wv8Kp3 x"), "Hq7Lm2Zx9Rt4Wv8Kp3"],
  ["url-userinfo", `export DATABASE_URL=postgres://app:${PW}@db.internal:5432/app`, PW],
  ["env-password", `PGPASSWORD=${PW} psql -h db -U app`, PW],
  ["env-token", `GH_TOKEN=${PW} gh pr list`, PW],
  ["env-secret", `CLIENT_SECRET=${PW} ./run`, PW],
  ["env-key", `STRIPE_KEY=${PW} ./run`, PW],
  ["mysql", `mysql -uroot -p${PW} acme`, PW],
  ["sshpass", `sshpass -p ${PW} ssh almond`, PW],
  ["bearer", `curl -H 'Authorization: Bearer ${PW}Q' https://x`, `${PW}Q`],
  ["password-flag", `node app.js --password ${PW}`, PW],
  ["token-flag", `deploy --token=${PW}`, PW],
  ["secret-flag", `vault write --secret "${PW}"`, PW],
  ["docker-login", `echo ${PW} | docker login -u alex --password-stdin`, PW],
];

/** No 6-character run of the secret appears in the output. */
function leaks(out: string, secret: string): string | null {
  for (let i = 0; i + 6 <= secret.length; i++) if (out.includes(secret.slice(i, i + 6))) return secret.slice(i, i + 6);
  return null;
}

describe("redaction", () => {
  test.each(SAMPLES)("%s: recognised whole", (_label, cmd, secret) => {
    const r = redactSecrets(cmd);
    expect(r.redactions.length).toBeGreaterThan(0);
    expect(leaks(r.text, secret)).toBeNull();
  });

  test.each(SAMPLES)("%s: never leaks through the activity line or a title, whatever the cutoff", (_label, cmd, secret) => {
    for (let pad = 0; pad <= 170; pad++) {
      const text = `${"x".repeat(pad)} ${cmd} and more after it`;
      const line = describeTool("Bash", { command: text }, "", true);
      expect(line.length).toBeLessThanOrEqual(180);
      const leaked = leaks(line, secret);
      if (leaked) throw new Error(`pad ${pad}: "${leaked}" leaked in ${line}`);
      const title = titleFromPrompt(text);
      const t = leaks(title, secret);
      if (t) throw new Error(`pad ${pad}: "${t}" leaked in title ${title}`);
    }
  });

  test("the audit's case: a GitHub-shaped token cut at the 120-character mark (35 of 36 characters showed before)", () => {
    const token = "ghp_" + "Ab3Cd5Ef7Gh9Ij1Kl3Mn5Op7Qr9St1Uv3Wx5Y";
    for (let pad = 90; pad <= 125; pad++) {
      expect(leaks(describeTool("Bash", { command: `${"y".repeat(pad)} ${token}` }, "", true), token.slice(4))).toBeNull();
    }
  });

  test("ordinary text is left alone", () => {
    expect(redactSecrets("docker login --password-stdin; git push; monkey=banana; OLDPWD=/x; token list").text)
      .toBe("docker login --password-stdin; git push; monkey=banana; OLDPWD=/x; token list");
  });
});

// ---- discovery ------------------------------------------------------------------------------------------------------

describe("discovery under the policy", () => {
  test("defaults (nothing shared): no prompt title, no command text, in anything posted", async () => {
    const w = world(cleanups, SHARE_NOTHING);
    w.write([prompt("Confidential: acquire ExampleCo for $42 million"), toolCall("Bash", { command: "psql -h db.internal acme_merger" })]);
    await w.disc().tick();
    const s = status(w.core, AGENT);
    expect(s).toMatchObject({ state: "working", activity: "Running a command", runtime: "claude-code", branch: "walkie-mission-1", session: SID });
    expect(s?.title).toBeUndefined();
    const all = JSON.stringify(w.core.store.agents());
    for (const bit of ["ExampleCo", "42 million", "psql", "acme_merger"]) expect(all).not.toContain(bit);
  });

  test("turning share_prompts off drops the prompt title discovery cached before, on its next post", async () => {
    const w = world(cleanups, { prompts: true, activity: false });
    w.write([prompt("Secret roadmap review"), toolCall("Bash", { command: "ls" })]);
    await w.disc().tick();
    expect(status(w.core, AGENT)?.title).toBe("Secret roadmap review");
    const w2 = { ...w };
    writeFileSync(w.core.paths.config, JSON.stringify({ share_prompts: false })); // turned off...
    const off = w2.disc({ share: SHARE_NOTHING }); // ...and the daemon restarted
    w.clock.t += 5 * 60_000;
    w.write([...endTurn()], w.clock.t - 4 * 60_000);
    await off.tick();
    await off.tick();
    const s = status(w.core, AGENT);
    expect(s?.state).toBe("idle");
    expect(JSON.stringify(s)).not.toContain("roadmap");
  });

  test("a hook's prompt title is not carried by discovery (working / idle / offline); a title set with walkie_set_status is", async () => {
    const w = world(cleanups, SHARE_NOTHING);
    const d = w.disc();
    w.write([prompt("x"), ...endTurn()], w.clock.t - 3_600_000);
    // An old hook posted a prompt title (its state file has no title source: counted as a prompt's).
    writeFileSync(join(w.home, "agents", `${AGENT}.json`), JSON.stringify({ title: "Hook title", injected: [] }));
    hook(w.core, "idle", "Finished turn");
    w.clock.t += 60_000;
    w.write([toolCall("Bash", { command: "make" })]);
    await d.tick();
    expect(status(w.core, AGENT)).toMatchObject({ state: "working", activity: "Running a command" });
    expect(status(w.core, AGENT)?.title).toBeUndefined();

    // walkie_set_status: an explicit title stays through discovery's updates and the offline.
    writeFileSync(join(w.home, "agents", `${AGENT}.json`), JSON.stringify({ title: "Reviewing PR 12", title_src: "explicit", injected: [] }));
    hook(w.core, "idle", "Updated status", AGENT, { title: "Reviewing PR 12" }, { title: "agent" });
    w.clock.t += 60_000;
    w.write([toolCall("Bash", { command: "make" })]);
    await d.tick();
    expect(status(w.core, AGENT)).toMatchObject({ state: "working", title: "Reviewing PR 12" });
    w.fx.procs = w.fx.procs.filter((p) => p.pid < 100);
    await d.tick();
    expect(status(w.core, AGENT)).toMatchObject({ state: "offline", title: "Reviewing PR 12" });
  });
});

// ---- hooks ----------------------------------------------------------------------------------------------------------

function hookEnv(config: Record<string, unknown> | null) {
  const home = mkdtempSync("/tmp/walkie-hookhome-");
  mkdirSync(join(home, "agents"), { recursive: true });
  if (config) writeFileSync(join(home, "config.json"), JSON.stringify(config));
  const daemon = fakeDaemon({ "POST /v1/status": { event: null }, "GET /v1/asks": { asks: [] }, "GET /v1/events": { events: [] } });
  const saved = { WALKIE_HOME: process.env.WALKIE_HOME, WALKIE_SOCKET: process.env.WALKIE_SOCKET };
  process.env.WALKIE_HOME = home;
  process.env.WALKIE_SOCKET = daemon.socket;
  cleanups.push(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    daemon.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const statuses = () => daemon.requests.filter((r) => r.path === "/v1/status").map((r) => r.body as Record<string, unknown>);
  return { home, statuses };
}

describe("hooks under the policy", () => {
  test("Codex hook: without share_prompts no prompt title and no reply line (it read only WALKIE_SHARE_PROMPTS before)", async () => {
    const h = hookEnv({ auto_admit: true }); // an existing install: no share_prompts key
    const n = { type: "agent-turn-complete", "thread-id": "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0000", cwd: "/tmp", "input-messages": ["Draft the ExampleCo term sheet ALE-7777"], "last-assistant-message": "Here is the term sheet: $42M at 8x" };
    await runCodexHook(JSON.stringify(n), {});
    const [s] = h.statuses();
    expect(s).toMatchObject({ state: "idle", title: "Working on a task", activity: "Finished turn" });
    expect(JSON.stringify(s)).not.toMatch(/ExampleCo|term sheet|42M|ALE-7777/);
  });

  test("Codex hook with share_prompts: the title and the reply's first line (redacted)", async () => {
    const h = hookEnv({ share_prompts: true });
    const n = { type: "agent-turn-complete", "thread-id": "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0001", cwd: "/tmp", "input-messages": ["Fix the build"], "last-assistant-message": `Fixed; used ghp_${"Ab3Cd5Ef7Gh9Ij1Kl3Mn5Op7Qr9St1Uv3Wx5Y"}` };
    await runCodexHook(JSON.stringify(n), {});
    const [s] = h.statuses();
    expect(s).toMatchObject({ title: "Fix the build" });
    expect(String(s?.activity)).toMatch(/^Done: Fixed; used \[REDACTED:github_token\]/);
  });

  test("Claude hook: a prompt title cached while sharing was on is not sent once it is off; explicit titles are", async () => {
    const h = hookEnv({});
    const env = { CLAUDE_CODE_SESSION_ID: "7a11c0de-0000-4000-8000-000000000000" };
    const agent = "cc-7a11c0";
    writeFileSync(join(h.home, "agents", `${agent}.json`), JSON.stringify({ title: "Plan the ExampleCo acquisition", injected: [] }));
    await runClaudeHook(JSON.stringify({ hook_event_name: "PreToolUse", session_id: env.CLAUDE_CODE_SESSION_ID, cwd: "/tmp", tool_name: "Bash", tool_input: { command: "psql acme_merger" } }), env);
    const [first] = h.statuses();
    expect(first).toMatchObject({ state: "working", activity: "Running a command" });
    expect(first?.title).toBeUndefined();
    expect(JSON.stringify(first)).not.toMatch(/ExampleCo|psql|acme_merger/);
    await runClaudeHook(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: env.CLAUDE_CODE_SESSION_ID, cwd: "/tmp", prompt: "Now the ExampleCo board deck" }), env);
    expect(h.statuses()[1]).toMatchObject({ title: "Working on a task" });
    writeFileSync(join(h.home, "agents", `${agent}.json`), JSON.stringify({ title: "Reviewing PR 12", title_src: "explicit", injected: [] }));
    await runClaudeHook(JSON.stringify({ hook_event_name: "Stop", session_id: env.CLAUDE_CODE_SESSION_ID, cwd: "/tmp" }), env);
    expect(h.statuses()[2]).toMatchObject({ state: "idle", title: "Reviewing PR 12" });
  });
});
