// POOL-REAL-1: "serve on the best machine" across isolated daemons: a member asks the sharing machine to serve a
// catalog model, gets a 127.0.0.1 endpoint on its own machine, and its OpenAI calls cross Walkie (a Tailscale
// WebSocket in one team, a Walkie Direct stream in the other) into the serving machine's allow-list proxy in front
// of llama-server (a stand-in here: fixtures/pool/fake-llama-server.ts; the real one ran on the team's GPUs, see
// docs/plans/POOL-REAL-1.md). Consent, keys and teardown are checked on the way.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { ACCEPT_STANDIN, fakeServeRuntime, placeModel } from "../helpers/pool-runtime.ts";
import { WalkieClient } from "../../src/client/index.ts";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { locateRuntime } from "../../src/pool/run/runtime.ts";

const GiB = 1024 ** 3;

/** The person's agent admin switch (AGENT-ADMIN-1), read from config.json on every request. */
function setAgentAdmin(home: string, on: boolean): void {
  const p = join(home, "config.json");
  const c = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown> : {};
  writeFileSync(p, JSON.stringify({ ...c, agent_admin: on }));
}

async function chat(endpoint: string, keyFile: string | null, stream = false): Promise<Response> {
  const key = keyFile ? readFileSync(keyFile, "utf8").trim() : "0".repeat(48);
  return fetch(`${endpoint}/chat/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "ping" }], stream }),
  });
}

describe("serve a model on one machine, use it from another through Walkie", () => {
  let c: Cluster;
  let rt: string;
  beforeAll(() => { c = new Cluster(); rt = fakeServeRuntime(c.root); });
  afterAll(async () => { await c.close(); });

  async function pair(transport: "tailscale" | "direct"): Promise<{ host: TestNode; user: TestNode }> {
    const direct = transport === "direct";
    const pool = { llamaDir: rt, verifyRuntime: ACCEPT_STANDIN, serveBudget: () => 11 * GiB };
    const host = await c.add({ name: `sh-${transport}`, login: `alex-s-${transport}@example.com`, hostname: `atlas-${transport}`, direct, pool });
    const user = await c.add({ name: `su-${transport}`, login: `kira-s-${transport}@example.com`, hostname: `mac-${transport}`, direct, pool });
    await host.client().init(`serve-${transport}`, "alex");
    if (direct) {
      const inv = await host.client().inviteCode("kira", "member");
      expect((await user.client().join(inv.code)).admitted).toBe(true);
    } else {
      await host.client().invite(`kira-s-${transport}@example.com`, "kira", "member");
      expect((await user.client().join(host.peerAddr)).admitted).toBe(true);
    }
    placeModel(host.home, "llama-3.2-3b", "q4");
    return { host, user };
  }

  for (const transport of ["tailscale", "direct"] as const) {
    test(`${transport}: consent, serve, connect, chat (plain + streamed), allow-list, keys, disconnect, stop`, async () => {
      const { host, user } = await pair(transport);
      // Not sharing: another machine may neither start nor connect.
      await expect(user.client().poolServe({ model: "llama-3.2-3b", on: host.hostname })).rejects.toMatchObject({ code: "not_sharing" });
      await host.client().poolShare(true, null);
      await waitFor(async () => (await user.client().team()).nodes.find((n) => n.hostname === host.hostname)?.pool?.share, { timeoutMs: 15_000, what: "sharing seen" });

      const r = await user.client().poolServe({ model: "llama-3.2-3b", on: host.hostname });
      expect(r.on.self).toBe(false);
      const conn = r.connection!;
      expect(conn.state).toBe("connected");
      expect(conn.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      // The key file is this user's alone.
      expect((await Bun.file(conn.api_key_file).exists())).toBe(true);
      expect(Bun.spawnSync(["stat", "-f", "%Lp", conn.api_key_file]).stdout.toString().trim()).toBe("600");

      const served = await waitFor(async () => { const s = (await host.client().pool()).serve; return s?.state === "serving" ? s : null; }, { timeoutMs: 30_000, what: "host serving" });
      expect(served.started_by?.hostname).toBe(user.hostname);
      // llama-server: loopback only, every layer on the GPU, one slot, the slots endpoint off.
      const args = JSON.parse(readFileSync(join(host.home, "pool", "fake-llama-args.json"), "utf8")) as string[];
      expect(args.slice(args.indexOf("--host"), args.indexOf("--host") + 2)).toEqual(["--host", "127.0.0.1"]);
      for (const a of ["--no-slots", "-ngl", "all", "-np", "--no-webui"]) expect(args).toContain(a);

      // The team sees what it serves.
      const pub = await waitFor(async () => (await user.client().team()).nodes.find((n) => n.hostname === host.hostname)?.pool?.serving ?? null, { timeoutMs: 15_000, what: "serving published" });
      expect(pub.model_id).toBe("llama-3.2-3b");
      expect(pub.open).toBe(true);

      const plain = await chat(conn.endpoint, conn.api_key_file);
      expect(plain.status).toBe(200);
      const body = await plain.json() as { choices: { message: { content: string } }[] };
      expect(body.choices[0]!.message.content).toContain("You said: ping");

      const t0 = performance.now();
      const streamed = await chat(conn.endpoint, conn.api_key_file, true);
      expect(streamed.headers.get("content-type")).toContain("text/event-stream");
      const text = await streamed.text();
      console.log(`[evidence] ${transport}: streamed ${text.split("data: ").length - 1} SSE events through Walkie in ${(performance.now() - t0).toFixed(0)} ms`);
      expect(text).toContain("[DONE]");
      expect(text).toContain("served");

      // Only the OpenAI calls: llama-server's /slots (other clients' prompts) and /props stay unreachable.
      const key = readFileSync(conn.api_key_file, "utf8").trim();
      for (const p of ["/slots", "/props", "/metrics"]) {
        const res = await fetch(conn.endpoint.replace(/\/v1$/, p), { headers: { Authorization: `Bearer ${key}` } });
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain("SECRET");
      }
      // A wrong key is refused.
      expect((await chat(conn.endpoint, null)).status).toBe(401);
      // The host's own person uses its own endpoint with its own key.
      const own = await chat(served.endpoint!, served.api_key_file!);
      expect(own.status).toBe(200);
      const hv = (await host.client().pool()).serve!;
      expect(hv.clients.map((x) => x.hostname)).toEqual([user.hostname]);
      expect(hv.requests).toBeGreaterThanOrEqual(3);

      // Disconnect: the key file is gone and the host forgot the key.
      await user.client().poolDisconnect(host.hostname);
      expect(existsSync(conn.api_key_file)).toBe(false);
      await waitFor(async () => ((await host.client().pool()).serve?.clients.length === 0 ? true : null), { what: "client dropped" });
      const again = await user.client().poolConnect(host.hostname);
      expect((await chat(again.connection.endpoint, again.connection.api_key_file)).status).toBe(200);

      // Sharing off: the other machine's connection is dropped at once and the model it started stops.
      await host.client().poolShare(false);
      const stopped = await waitFor(async () => { const s = (await host.client().pool()).serve; return s && ["stopped", "failed"].includes(s.state) ? s : null; }, { timeoutMs: 15_000, what: "serve stopped" });
      expect(stopped.error).toContain("sharing off");
      const res = await chat(again.connection.endpoint, again.connection.api_key_file).catch(() => null);
      expect(res === null || res.status !== 200).toBe(true);
      await user.client().poolDisconnect(host.hostname);
    }, 90_000);
  }

  test("the host's person serves locally; agents can't start, a second model is refused, stop kills llama-server", async () => {
    const host = await c.add({ name: "sh-local", login: "alex-local@example.com", hostname: "atlas-local", pool: { llamaDir: rt, verifyRuntime: ACCEPT_STANDIN, serveBudget: () => 11 * GiB } });
    await host.client().init("serve-local", "alex");
    placeModel(host.home, "llama-3.2-3b", "q4");
    // Too big for the GPU: refused before anything downloads, with the split hint.
    await expect(host.client().poolServe({ model: "qwen3-32b", on: host.hostname })).rejects.toMatchObject({ code: "insufficient_memory" });
    // Without --on the fastest GPU is picked from machine stats (unit-tested: serveHosts); these daemons publish none.
    await expect(host.client().poolServe({ model: "llama-3.2-3b" })).rejects.toMatchObject({ code: "does_not_fit" });
    const r = await host.client().poolServe({ model: "llama-3.2-3b", on: host.hostname });
    expect(r.on.self).toBe(true);
    const s = await waitFor(async () => { const x = (await host.client().pool()).serve; return x?.state === "serving" ? x : null; }, { timeoutMs: 30_000, what: "serving" });
    expect((await chat(s.endpoint!, s.api_key_file!)).status).toBe(200);
    // The same model again joins it; another one is refused while it serves.
    expect((await host.client().poolServe({ model: "llama-3.2-3b" })).serve?.id).toBe(s.id); // found as served here
    await expect(host.client().poolServe({ model: "llama-3.1-8b", on: host.hostname })).rejects.toMatchObject({ code: "serve_active" });
    // One pool job per machine: no split run headed from here while it serves.
    await expect(host.client().poolRun({ model: "llama-3.2-3b" })).rejects.toMatchObject({ status: 409, code: "busy" });
    // An agent may not start one (people only).
    // AGENT-ADMIN-1: an agent may while its person's agent admin switch is on (audited); off, it can't.
    setAgentAdmin(host.home, false);
    await expect(host.client("claude-1").poolServe({ model: "llama-3.2-3b" })).rejects.toMatchObject({ status: 403, code: "agent_admin_off" });
    await expect(host.client("claude-1").poolServeStop()).rejects.toMatchObject({ status: 403, code: "agent_admin_off" });
    setAgentAdmin(host.home, true);
    const pid = s.server_pid!;
    await host.client().poolServeStop();
    expect((await host.client().pool()).serve?.state).toBe("stopped");
    expect(Bun.spawnSync(["ps", "-p", String(pid), "-o", "pid="], { stdout: "pipe" }).stdout.toString().trim()).toBe("");
  }, 60_000);

  test("installing the runtime is a chore: a person or a NAMED agent may do it; an unnamed agent can't; agent admin off stops agents", async () => {
    const calls: string[] = [];
    let open: () => void = () => undefined;
    const gate = new Promise<void>((r) => { open = r; });
    const node = await c.add({
      name: "inst", login: "alex-inst@example.com", hostname: "inst-box",
      pool: {
        verifyRuntime: ACCEPT_STANDIN,
        // Stand-in for the pinned download: fills the directory as installRuntime would, with progress.
        installRuntime: async (t, dir, onProgress) => {
          calls.push(t.id);
          await gate; // p8-2: held open while the test checks that nothing else starts meanwhile
          for (const a of t.assets) onProgress(a.file, a.bytes, a.bytes);
          mkdirSync(dir, { recursive: true });
          cpSync(rt, dir, { recursive: true });
          writeFileSync(join(dir, "WALKIE_BUILD"), `b11205 ${t.id}\n`);
          return locateRuntime("", dir);
        },
      },
    });
    await node.client().init("inst-team", "alex");
    expect((await node.client().pool()).runtime.installed).toBe(false);
    // An agent that doesn't say who it is: refused, nothing installed.
    await expect(new WalkieClient({ socket: node.socket, underAgent: true }).poolInstall()).rejects.toMatchObject({ status: 403, code: "agent_unnamed" });
    expect(calls).toEqual([]);
    // A named agent: allowed.
    const agent = node.client("codex-7");
    const started = (await agent.poolInstall()).install;
    expect(started.by).toBe("codex-7");
    // p8-2: while it installs, the machine is taken: no served model and no split run start, a second install joins it.
    placeModel(node.home, "llama-3.2-3b", "q4");
    await expect(node.client().poolServe({ model: "llama-3.2-3b", on: node.hostname })).rejects.toMatchObject({ status: 409, code: "busy" });
    await expect(node.client().poolRun({ model: "llama-3.2-3b" })).rejects.toMatchObject({ status: 409 });
    expect((await node.client().poolInstall()).install.state).toBe("downloading");
    open();
    const done = await waitFor(async () => { const v = (await node.client().pool()); return v.install?.state === "done" ? v : null; }, { what: "install done" });
    expect(done.runtime.installed).toBe(true);
    expect(done.install?.done).toBe(done.install?.total);
    expect(calls).toHaveLength(1);
    // With the person's agent admin switch off, neither the install nor the trust decisions pass for an agent.
    setAgentAdmin(node.home, false);
    await expect(agent.poolInstall()).rejects.toMatchObject({ status: 403, code: "agent_admin_off" });
    await expect(agent.poolShare(true)).rejects.toMatchObject({ status: 403, code: "agent_admin_off" });
    await expect(agent.poolServe({ model: "llama-3.2-3b" })).rejects.toMatchObject({ status: 403, code: "agent_admin_off" });
    await expect(agent.poolRun({ model: "llama-3.2-3b" })).rejects.toMatchObject({ status: 403, code: "agent_admin_off" });
    setAgentAdmin(node.home, true);
    // A person may install too (again: replaces what Walkie installed).
    expect((await node.client().poolInstall()).install.by).toBeNull();
  }, 30_000);
});
