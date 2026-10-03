// LOCAL-MODELS-HF-1 item 7: the Hub client is bounded and plain: fixed origin, no credentials, timeouts, byte caps, a
// request budget, the Hub's rate-limit header, same-origin redirects only, zod validation at the boundary, offline and
// malformed answers as errors a refresh can report. No request leaves the machine: a fake Hub answers.
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { HfClient, HfError, isFatal, mapLimit, USER_AGENT } from "../../src/pool/hf/client.ts";
import { evalEntries, makerName, ModelRecord, parseItems, ListItem, OrgOverview } from "../../src/pool/hf/schemas.ts";
import { fakeHub } from "../helpers/hf-fixtures.ts";

const Org = z.object({ numFollowers: z.number() });
const kind = async (p: Promise<unknown>): Promise<string> => { try { await p; return "no error"; } catch (e) { return e instanceof HfError ? e.kind : `other: ${e}`; } };

describe("what a request carries", () => {
  test("a plain GET to huggingface.co: a fixed User-Agent and an Accept header, no credentials, no body, no team or machine names", async () => {
    const hub = fakeHub();
    const c = new HfClient({ fetch: hub.fetch });
    expect(await c.json("/api/organizations/Qwen/overview", OrgOverview)).toMatchObject({ name: "Qwen" });
    expect(await c.text("/Qwen/Qwen3-8B/resolve/main/config.json")).toContain("Qwen3ForCausalLM");
    for (const call of hub.calls) {
      expect(call.method).toBe("GET");
      expect(new URL(call.url).origin).toBe("https://huggingface.co");
      expect(Object.keys(call.headers).sort()).toEqual(["accept", "user-agent"]);
      expect(call.headers["user-agent"]).toBe(USER_AGENT);
    }
  });
});

describe("answers", () => {
  test("a repository the Hub does not show (401 for missing or gated, 404 for an account that is not an organisation) is null, not an error", async () => {
    const c = new HfClient({ fetch: fakeHub().fetch });
    expect(await c.json("/api/models/nobody/never-published?expand[]=safetensors", z.object({}))).toBeNull(); // no such repository: 401
    expect(await c.json("/api/organizations/some-person/overview", Org)).toBeNull();
    expect(await c.text("/google/gemma-3n-E4B-it/resolve/main/config.json")).toBeNull();
  });

  test("a same-origin redirect (the Hub's 307 to a relative path) is followed; a redirect to another origin is refused", async () => {
    const hub = fakeHub();
    const c = new HfClient({ fetch: hub.fetch });
    await c.text("/Qwen/Qwen3-8B/resolve/main/config.json");
    expect(hub.calls.map((x) => new URL(x.url).pathname)).toEqual(["/Qwen/Qwen3-8B/resolve/main/config.json", `/api/resolve-cache/models/Qwen/Qwen3-8B/${"b".repeat(40)}/config.json`]);
    const evil = fakeHub();
    evil.inject("/resolve/main/", () => new Response("", { status: 302, headers: { location: "https://evil.example/steal" } }));
    expect(await kind(new HfClient({ fetch: evil.fetch }).text("/Qwen/Qwen3-8B/resolve/main/config.json"))).toBe("redirect");
    expect(evil.calls.some((x) => x.url.includes("evil.example"))).toBe(false);
    const loop = fakeHub();
    loop.inject("/resolve/main/", () => new Response("", { status: 307, headers: { location: "/Qwen/Qwen3-8B/resolve/main/config.json" } }), 10);
    expect(await kind(new HfClient({ fetch: loop.fetch }).text("/Qwen/Qwen3-8B/resolve/main/config.json"))).toBe("redirect");
  });

  test("an answer that is not JSON, or not the shape asked for, is 'malformed'", async () => {
    const hub = fakeHub();
    hub.inject("/api/organizations/Qwen/", () => new Response("<html>oops</html>", { status: 200 }));
    expect(await kind(new HfClient({ fetch: hub.fetch }).json("/api/organizations/Qwen/overview", Org))).toBe("malformed");
    expect(await kind(new HfClient({ fetch: fakeHub().fetch }).json("/api/organizations/Qwen/overview", z.object({ nope: z.string() })))).toBe("malformed");
  });

  test("a server error is an http error naming the path and status", async () => {
    const hub = fakeHub();
    hub.inject("/api/organizations/", () => new Response("down", { status: 503 }));
    const err = await new HfClient({ fetch: hub.fetch }).json("/api/organizations/Qwen/overview", Org).catch((e) => e as HfError);
    expect(err).toBeInstanceOf(HfError);
    expect((err as HfError).kind).toBe("http");
    expect((err as HfError).message).toContain("503");
  });
});

describe("bounds", () => {
  test("a body over the cap is refused, declared or streamed", async () => {
    const hub = fakeHub();
    hub.inject("/api/organizations/Qwen/", () => new Response("x".repeat(5000), { status: 200, headers: { "content-length": "5000" } }));
    expect(await kind(new HfClient({ fetch: hub.fetch }).json("/api/organizations/Qwen/overview", Org, 1000))).toBe("too_large");
    const stream = fakeHub();
    stream.inject("/resolve/", () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 10; i++) c.enqueue(new Uint8Array(500)); c.close(); } }), { status: 200 }));
    expect(await kind(new HfClient({ fetch: stream.fetch }).text("/Qwen/Qwen3-8B/resolve/main/config.json", 2000))).toBe("too_large");
  });

  test("the request budget: the request after the last one allowed is refused without being sent", async () => {
    const hub = fakeHub();
    const c = new HfClient({ fetch: hub.fetch, maxRequests: 2 });
    await c.json("/api/organizations/Qwen/overview", Org);
    await c.json("/api/organizations/google/overview", Org);
    expect(await kind(c.json("/api/organizations/openai/overview", Org))).toBe("budget");
    expect(hub.calls).toHaveLength(2);
  });

  test("a request that gets no answer times out; so does the refresh when its deadline passes", async () => {
    const hang = (_: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("t", "TimeoutError"))));
    expect(await kind(new HfClient({ fetch: hang as typeof fetch, timeoutMs: 30 }).json("/api/organizations/Qwen/overview", Org))).toBe("timeout");
    let t = 1000;
    const c = new HfClient({ fetch: fakeHub().fetch, deadline: 1500, now: () => t });
    await c.json("/api/organizations/Qwen/overview", Org);
    t = 1600;
    expect(await kind(c.json("/api/organizations/google/overview", Org))).toBe("timeout");
  });

  test("offline: a network failure is 'offline' with the reason", async () => {
    const down = (async () => { throw new TypeError("Unable to connect. Is the computer able to access the url?"); }) as unknown as typeof fetch;
    const err = await new HfClient({ fetch: down }).json("/api/organizations/Qwen/overview", Org).catch((e) => e as HfError);
    expect((err as HfError).kind).toBe("offline");
    expect((err as HfError).message).toContain("could not be reached");
  });
});

describe("the Hub's rate limits", () => {
  test("a 429 stops the refresh", async () => {
    const hub = fakeHub();
    hub.inject("/api/organizations/", () => new Response("slow down", { status: 429 }));
    expect(await kind(new HfClient({ fetch: hub.fetch }).json("/api/organizations/Qwen/overview", Org))).toBe("rate_limited");
  });

  test("a bucket the Hub says is nearly used up (fewer than 30 requests left) is not asked again; the other bucket still works", async () => {
    const hub = fakeHub({ limits: { api: 30, resolvers: 3000 } });
    const c = new HfClient({ fetch: hub.fetch });
    await c.json("/api/organizations/Qwen/overview", Org); // the Hub says 29 are left after this one
    expect(await kind(c.json("/api/organizations/google/overview", Org))).toBe("rate_limited");
    expect(await c.text("/Qwen/Qwen3-8B/resolve/main/config.json")).toContain("Qwen3ForCausalLM"); // the resolver window is separate
    expect(hub.calls.filter((x) => x.url.includes("/api/organizations/"))).toHaveLength(1);
  });

  test("fatal errors end a refresh, the rest only skip an item", () => {
    for (const k of ["offline", "rate_limited", "budget", "timeout"] as const) expect(isFatal(new HfError(k, "x"))).toBe(true);
    for (const k of ["http", "malformed", "too_large", "redirect"] as const) expect(isFatal(new HfError(k, "x"))).toBe(false);
    expect(isFatal(new Error("x"))).toBe(false);
  });
});

describe("mapLimit", () => {
  test("never more than the limit in flight, results in order", async () => {
    let live = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5 + (n % 3)));
      live--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
    expect(peak).toBe(3);
  });

  test("a thrown error stops new items and is rethrown after the ones in flight finish", async () => {
    const started: number[] = [];
    const err = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => { started.push(n); await new Promise((r) => setTimeout(r, 5)); if (n === 2) throw new Error("boom"); return n; }).catch((e) => e as Error);
    expect((err as Error).message).toBe("boom");
    expect(started.length).toBeLessThan(6);
  });
});

describe("zod at the boundary", () => {
  test("list items that do not parse are skipped and counted; a body that is not a list fails", () => {
    const r = parseItems([{ id: "Qwen/Qwen3-8B-GGUF", downloads: 5 }, { id: "../../etc/passwd" }, { id: 5 }, "x", { id: "a/b", baseModels: "oops" }], ListItem, 100);
    expect(r.items.map((i) => i.id)).toEqual(["Qwen/Qwen3-8B-GGUF", "a/b"]);
    expect(r.items[1]!.baseModels).toBeUndefined(); // a malformed optional field is dropped alone
    expect(r.bad).toBe(3);
    expect(() => parseItems({ not: "a list" }, ListItem, 100)).toThrow();
    expect(parseItems(Array.from({ length: 500 }, () => ({ id: "a/b" })), ListItem, 100).items).toHaveLength(100);
  });

  test("repository ids are checked before they become a URL or a name", () => {
    for (const bad of ["a b/c", "a/b/c", "a/../b", "/etc/passwd", "a/", "<script>/x", "a/b?x=1", "-a/b"]) expect(ListItem.safeParse({ id: bad }).success).toBe(false);
    expect(ListItem.safeParse({ id: "unsloth/Qwen3.8-27B-GGUF" }).success).toBe(true);
  });

  test("a model record: evaluation entries are checked one by one (the Hub's own malformed ones, and hostile ones, are dropped)", () => {
    const rec = ModelRecord.parse({
      id: "LiquidAI/LFM2.5-1.2B-Instruct", createdAt: "2026-01-06T10:00:00.000Z",
      evalResults: [
        { filename: ".eval_results/gpqa.yaml", verified: false, data: { dataset: { id: "Idavidrein/gpqa", task_id: "diamond" }, value: 38.89 } },
        { filename: ".eval_results/mmlu-pro.yaml", error: "Invalid input: expected string, received undefined", pullRequest: 4 },
        { filename: "x", data: { dataset: { id: "a" }, value: "99" } },
        { data: { dataset: { id: "x".repeat(500) }, value: 1 } },
        null,
      ],
    });
    const { entries, bad } = evalEntries(rec);
    expect(entries.map((e) => e.data.dataset.id)).toEqual(["Idavidrein/gpqa"]);
    expect(bad).toBe(4);
    expect(ModelRecord.safeParse({ id: "a/b", createdAt: "yesterday" }).success).toBe(false);
  });

  test("a maker's name is printable ASCII from a small set, or its login", () => {
    expect(makerName("Z.ai", "zai-org")).toBe("Z.ai");
    expect(makerName("Mistral AI_", "mistralai")).toBe("Mistral AI");
    expect(makerName("Meta Inc.", "meta-models")).toBe("Meta Inc.");
    expect(makerName("<img src=x onerror=alert(1)>", "someone")).toBe("img src x onerror alert 1");
    expect(makerName("‮evil", "bad-login")).toBe("evil");
    expect(makerName("", "ornith-ai")).toBe("ornith-ai");
    expect(makerName("a", "b")).toBe("Unknown");
  });
});
