import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Cluster, standardTeam, waitFor, type TestNode } from "../helpers/cluster.ts";

let c: Cluster;
let alex: TestNode, kira: TestNode, kira2: TestNode;

beforeAll(async () => {
  c = new Cluster();
  ({ alex, kira, kira2 } = await standardTeam(c));
});
afterAll(async () => { await c.close(); });

describe("ask / answer", () => {
  test("ask from A to @kira is answered on C; the blocking wait resolves", async () => {
    const asker = alex.client("planner");
    const { event } = await asker.ask({ to: "@kira", text: "is the build green?", timeout_s: 30 });
    const t0 = performance.now();
    const waiting = asker.awaitAnswer(event.id, 30);
    const inbox = await waitFor(async () => {
      const r = await kira2.client("ux").asks({ state: "open", to: "me" });
      return r.asks.find((a) => a.ask.id === event.id);
    }, { what: "ask in kira2 inbox" });
    expect(inbox.state).toBe("open");
    await kira2.client("ux").answer({ ask: event.id, text: "yes, green" });
    const view = await waiting;
    console.log(`[metric] ask → answered on another node → waiter resolved: ${(performance.now() - t0).toFixed(1)} ms`);
    expect(view.state).toBe("answered");
    expect((view.answers[0]?.body as { text: string }).text).toBe("yes, green");
    expect(view.answers[0]?.author).toMatchObject({ handle: "kira", agent: "ux" });
  });

  test("machine-addressed asks only show on that machine; others can't answer for another handle", async () => {
    const { event } = await alex.client().ask({ to: "@kira/kiras-studio", text: "machine-specific", timeout_s: 30 });
    await waitFor(async () => (await kira.client().asks({ to: "me" })).asks.length >= 0 && kira.d.core.store.getRow(event.id));
    expect((await kira.client().asks({ state: "open", to: "me" })).asks.some((a) => a.ask.id === event.id)).toBe(false);
    await waitFor(async () => (await kira2.client().asks({ state: "open", to: "me" })).asks.some((a) => a.ask.id === event.id), { what: "kira2 inbox" });
    await expect(alex.client().answer({ ask: event.id, text: "not mine" })).rejects.toMatchObject({ status: 403 });
  });

  test("decline and expiry", async () => {
    const { event } = await alex.client().ask({ to: "@kira", text: "deploy friday?", timeout_s: 30 });
    await waitFor(() => kira.d.core.store.getRow(event.id));
    await kira.client().answer({ ask: event.id, text: "no", declined: true });
    expect((await alex.client().awaitAnswer(event.id, 5)).state).toBe("declined");
    const short = await alex.client().ask({ to: "@kira", text: "quick?", timeout_s: 1 });
    const t0 = Date.now();
    const v = await alex.client().awaitAnswer(short.event.id, 1);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(["open", "expired"]).toContain(v.state);
    await Bun.sleep(50);
    expect((await alex.client().askView(short.event.id)).state).toBe("expired");
  });

  test("long-poll survives past the 10 s default idle timeout on the unix socket", async () => {
    const { event } = await alex.client().ask({ to: "@kira", text: "slow one", timeout_s: 60 });
    const t0 = Date.now();
    const v = await alex.client().askView(event.id, 11);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(10_900);
    expect(v.state).toBe("open");
  }, 20_000);

  test("unknown handle is 404", async () => {
    await expect(alex.client().ask({ to: "@nobody", text: "hi" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("threads, status, artifacts", () => {
  test("reply threads and /v1/events/:id", async () => {
    const root = (await alex.client().post({ channel: "general", text: "root" })).event;
    await waitFor(() => kira.d.core.store.getRow(root.id));
    const r = (await kira.client().post({ channel: "general", text: "reply", thread: root.id })).event;
    await waitFor(() => alex.d.core.store.getRow(r.id));
    const view = await alex.client().event(root.id);
    expect(view.replies.map((e) => e.id)).toEqual([r.id]);
  });

  test("secret redaction on post (and --raw bypass)", async () => {
    const key = ["ghp_", "x".repeat(36)].join("");
    const res = await alex.client().post({ channel: "general", text: `token ${key}` });
    expect((res.event.body as { text: string }).text).toBe("token [REDACTED:github_token]");
    const raw = await alex.client().post({ channel: "general", text: `token ${key}`, raw: true });
    expect((raw.event.body as { text: string }).text).toContain(key);
  });

  test("agent status replicates; dedupe within 2s; agent header must match", async () => {
    const cl = kira.client("builder");
    const first = await cl.status({ agent: "builder", state: "working", runtime: "claude-code", title: "core daemon", task: "ALE-5156" }, { title: "person", task: "person" });
    expect(first.event).not.toBeNull();
    const dup = await cl.status({ agent: "builder", state: "working", runtime: "claude-code", title: "core daemon", task: "ALE-5156" }, { title: "person", task: "person" });
    expect(dup.event).toBeNull();
    await expect(cl.status({ agent: "someone-else", state: "idle" })).rejects.toMatchObject({ status: 403 });
    const seen = await waitFor(async () => (await alex.client().agents()).agents.find((a) => a.agent === "builder"), { what: "status on alex" });
    expect(seen).toMatchObject({ id: "kira/kiras-mbp/builder", effective_state: "working", machine_online: true });
    expect(seen.status.title).toBe("core daemon");
  });

  test("artifact share on A, fetched on B from peers", async () => {
    const bytes = new TextEncoder().encode("hello artifact ".repeat(1000));
    const { event } = await alex.client().share(bytes, { name: "notes.txt", mime: "text/plain", note: "see this", channel: "general" });
    const hash = (event.body as { hash: string }).hash;
    await waitFor(() => kira.d.core.store.getRow(event.id));
    const got = await kira.client().fetchArtifact(hash);
    expect(new TextDecoder().decode(got)).toBe(new TextDecoder().decode(bytes));
    await expect(kira.client().fetchArtifact("0".repeat(64))).rejects.toMatchObject({ status: 404 });
  });

  test("team / peers views", async () => {
    const t = await kira2.client().team();
    expect(t.nodes.find((n) => n.self)?.hostname).toBe("kiras-studio");
    const online = await waitFor(async () => {
      const p = await alex.client().peers();
      return p.nodes.every((n) => n.online) ? p : null;
    }, { what: "all online" });
    expect(online.nodes.filter((n) => !n.self).every((n) => typeof n.rtt_ms === "number")).toBe(true);
  });
});

describe("re-pinning a moved node", () => {
  test("a node whose peer port changed re-joins and is reachable again", async () => {
    await kira.stop();
    const oldPort = kira.peerPort;
    kira.peerPort = 0; // new random port, as after a Tailscale IP / port change
    await kira.start();
    expect(kira.peerPort).not.toBe(oldPort);
    const res = await kira.client().join(alex.peerAddr);
    expect(res.admitted).toBe(true);
    await waitFor(() => alex.d.core.roster.nodes.get(kira.d.nodeId)?.port === kira.peerPort, { what: "re-pinned on alex" });
    const { event } = await alex.client().post({ channel: "general", text: "after move" });
    await waitFor(() => kira.d.core.store.getRow(event.id), { what: "delivery after re-pin" });
  });
});

describe("join with auto_admit off", () => {
  test("pending approval → owner admits → join succeeds", async () => {
    const c2 = new Cluster();
    try {
      const owner = await c2.add({ name: "own", login: "o@example.com", hostname: "own-mbp", autoAdmit: false });
      const mem = await c2.add({ name: "mem", login: "m@example.com", hostname: "mem-mbp" });
      await owner.client().init("strict", "own");
      await owner.client().invite("m@example.com", "mem", "member");
      const first = await mem.client().join(owner.peerAddr);
      expect(first).toMatchObject({ admitted: false, reason: "pending_approval" });
      const pend = await owner.client().request<{ requests: { node_id: string }[] }>("GET", "/v1/team/pending");
      expect(pend.requests.map((r) => r.node_id)).toEqual([mem.d.nodeId]);
      await owner.client().request("POST", "/v1/team/admit", { node_id: mem.d.nodeId, approve: true });
      const second = await mem.client().join(owner.peerAddr);
      expect(second).toMatchObject({ admitted: true, handle: "mem", role: "member" });
    } finally {
      await c2.close();
    }
  });
});
