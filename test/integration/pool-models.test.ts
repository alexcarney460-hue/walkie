// LOCAL-MODELS-HF-1: the dashboard asks its own daemon for the model list (`GET /v1/pool/models`). Opening the suggestions
// is what reads Hugging Face (when the list is missing or over a day old), the answer is the built-in list at once with
// `refreshing: true`, then the Hugging Face list; a read changes nothing else; the daemon fetches, not the browser.
// A fake Hub answers (test/helpers/hf-fixtures.ts); nothing touches the network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CATALOG } from "../../src/pool/catalog.ts";
import { cachePath } from "../../src/pool/hf/source.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { fakeHub, type FakeHub } from "../helpers/hf-fixtures.ts";

let c: Cluster;
let node: TestNode;
let hub: FakeHub;

beforeAll(async () => {
  c = new Cluster();
  hub = fakeHub();
  node = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", pool: { hfFetch: hub.fetch } });
}, 30_000);
afterAll(async () => { await c.close(); });

describe("GET /v1/pool/models", () => {
  test("opening the suggestions: the built-in list at once, refreshing; then the Hugging Face list, kept on disk, with no more requests", async () => {
    expect(hub.calls.length).toBe(0); // nothing is read until somebody asks (no timer)
    const first = await node.client().poolModels();
    expect(first).toMatchObject({ source: "built-in", state: "built-in", refreshing: true, checked_at: null });
    expect(first.catalog?.models.length).toBe(CATALOG.models.length);
    const done = await waitFor(async () => { const v = await node.client().poolModels(); return v.refreshing ? null : v; }, { what: "the refresh", timeoutMs: 20_000 });
    expect(done).toMatchObject({ source: "huggingface", state: "fresh", note: null, refreshing: false });
    expect(done.catalog?.models.length).toBe(16);
    expect(done.checked_at).toBeGreaterThan(0);
    const file = cachePath(node.home);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const n = hub.calls.length;
    expect(n).toBeGreaterThan(50);
    await node.client().poolModels();
    await node.client().poolModels();
    expect(hub.calls.length).toBe(n); // a fresh list is served without asking Hugging Face again
  });

  test("brief=1 leaves the catalog out (the dashboard polls with it while a refresh runs)", async () => {
    const v = await node.client().poolModels({ brief: true });
    expect(v.catalog).toBeUndefined();
    expect(v).toMatchObject({ source: "huggingface", state: "fresh" });
  });

  test("only the daemon talks to Hugging Face: plain GETs with no credentials, nothing about this machine or team", async () => {
    for (const call of hub.calls) {
      expect(new URL(call.url).origin).toBe("https://huggingface.co");
      expect(Object.keys(call.headers).sort()).toEqual(["accept", "user-agent"]);
      expect(call.url).not.toContain("alex");
    }
  });

  test("an agent may read it too (like GET /v1/pool); it carries no path of this machine", async () => {
    const v = await node.client("some-agent").poolModels();
    expect(v.source).toBe("huggingface");
    expect(JSON.stringify(v)).not.toContain(node.home);
  });
});

describe("POST /v1/pool/models/refresh", () => {
  test("asks again, but not within a minute of the last time; answers at once (the refresh runs on)", async () => {
    const n = hub.calls.length;
    const r = await node.client().poolModelsRefresh();
    expect(r.refreshing).toBe(false); // too soon after the read above: nothing started
    expect(hub.calls.length).toBe(n);
  });
});

describe("when Hugging Face cannot be reached", () => {
  test("the built-in list with the reason, once the attempt has failed; no retry for 15 minutes", async () => {
    const down = new Cluster();
    const dead = fakeHub();
    dead.inject("huggingface.co", () => { throw new TypeError("Unable to connect"); }, 10_000);
    try {
      const n2 = await down.add({ name: "kira", login: "kira@example.com", hostname: "kiras-mbp", pool: { hfFetch: dead.fetch } });
      const first = await n2.client().poolModels();
      expect(first.source).toBe("built-in");
      const after = await waitFor(async () => { const v = await n2.client().poolModels(); return v.refreshing ? null : v; }, { what: "the failed attempt", timeoutMs: 10_000 });
      expect(after.note).toBe(`Couldn't reach Hugging Face (no network), so this is the list built into Walkie (updated ${CATALOG.updated}).`);
      const n = dead.calls.length;
      await n2.client().poolModels();
      expect(dead.calls.length).toBe(n);
      expect(readFileSync(cachePath(n2.home), "utf8")).toContain('"failed"');
    } finally { await down.close(); }
  });
});

describe("the other pool routes are untouched", () => {
  test("GET /v1/pool still answers with this machine's sharing state", async () => {
    const v = await node.client().pool();
    expect(v.share.on).toBe(false);
    expect(existsSync(join(node.home, "pool"))).toBe(true);
  });
});
