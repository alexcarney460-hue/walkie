// LOCAL-MODELS-HF-1 item 7: where the model list comes from. Fetched when a person asks, by the machine that asks, cached
// on disk for about a day, never on a timer; when Hugging Face cannot be used the previous list (under 30 days old) or
// the built-in one, and the output says which and why. A fake Hub answers; nothing touches the network.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG } from "../../src/pool/catalog.ts";
import { ModelSource, cachePath, DAY_MS } from "../../src/pool/hf/source.ts";
import { fakeHub, type FakeHub } from "../helpers/hf-fixtures.ts";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "walkie-hf-source-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const T0 = Date.parse("2026-10-01T22:00:00Z");
function source(hub: FakeHub, clock: { t: number }, over: Partial<ConstructorParameters<typeof ModelSource>[0]> = {}) {
  const events: { event: string; fields: Record<string, unknown> }[] = [];
  const s = new ModelSource({ home, fetch: hub.fetch, now: () => clock.t, log: (event, fields) => events.push({ event, fields }), ...over });
  return { s, events };
}
const offline = (): FakeHub => {
  const hub = fakeHub();
  hub.inject("huggingface.co", () => { throw new TypeError("Unable to connect"); }, 10_000);
  return hub;
};
const requests = (hub: FakeHub): number => hub.calls.length;

describe("with nothing cached", () => {
  test("peek() is the built-in list, and says so, without any request", () => {
    const hub = fakeHub();
    const { s } = source(hub, { t: T0 });
    const v = s.peek();
    expect(v.source).toBe("built-in");
    expect(v.state).toBe("built-in");
    expect(v.catalog.models).toBe(CATALOG.models);
    expect(v.checkedAt).toBeNull();
    expect(v.note).toBeNull(); // nothing has failed; the list simply has not been read yet
    expect(requests(hub)).toBe(0);
  });

  test("load() reads Hugging Face, keeps the list on disk (0600 in a 0700 folder, no temp files) and returns it fresh", async () => {
    const hub = fakeHub();
    const clock = { t: T0 };
    const { s, events } = source(hub, clock);
    const v = await s.load();
    expect(v).toMatchObject({ source: "huggingface", state: "fresh", checkedAt: T0, note: null });
    expect(v.catalog.models.length).toBe(16);
    expect(v.catalog.origin).toEqual({ kind: "huggingface", at: new Date(T0).toISOString() });
    const file = cachePath(home);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "pool")).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(home, "pool")).filter((f) => f.includes("tmp"))).toEqual([]);
    expect(events.map((e) => e.event)).toEqual(["pool_models_refresh_ok"]);
    expect(events[0]!.fields).toMatchObject({ models: 16 });
    expect(JSON.stringify(events)).not.toContain("hostname"); // nothing about the team or its machines
  });

  test("a list read before is used by a new process (peek) and by load() while it is under a day old, with no request", async () => {
    const hub = fakeHub();
    const clock = { t: T0 };
    await source(hub, clock).s.load();
    const n = requests(hub);
    clock.t = T0 + 23 * 3600_000;
    const again = source(hub, clock).s;
    expect(again.peek()).toMatchObject({ source: "huggingface", state: "fresh", checkedAt: T0 });
    expect(await again.load()).toMatchObject({ state: "fresh", checkedAt: T0 });
    expect(requests(hub)).toBe(n);
  });

  test("past a day it is read again", async () => {
    const hub = fakeHub();
    const clock = { t: T0 };
    const { s } = source(hub, clock);
    await s.load();
    const n = requests(hub);
    clock.t = T0 + DAY_MS + 1000;
    expect(s.peek().state).toBe("stale"); // peek never fetches: it shows the old list, flagged
    const v = await s.load();
    expect(requests(hub)).toBeGreaterThan(n);
    expect(v).toMatchObject({ state: "fresh", checkedAt: T0 + DAY_MS + 1000 });
  });

  test("two people opening the suggestions at once cost one set of requests", async () => {
    const hub = fakeHub();
    const { s } = source(hub, { t: T0 });
    const [a, b] = await Promise.all([s.load(), s.load()]);
    expect(a).toBe(b);
    expect(hub.calls.filter((c) => c.url.includes("/api/models?filter=gguf&pipeline_tag=")).length).toBe(5);
  });
});

describe("when Hugging Face cannot be used", () => {
  test("offline with nothing cached: the built-in list, with the reason and the date of that list", async () => {
    const hub = offline();
    const { s, events } = source(hub, { t: T0 });
    const v = await s.load();
    expect(v).toMatchObject({ source: "built-in", state: "built-in", checkedAt: null });
    expect(v.note).toBe(`Couldn't reach Hugging Face (no network), so this is the list built into Walkie (updated ${CATALOG.updated}).`);
    expect(events.map((e) => e.event)).toEqual(["pool_models_refresh_failed"]);
    expect(events[0]!.fields).toMatchObject({ kind: "offline" });
  });

  test("a failure is remembered for 15 minutes: no new requests until then, a manual refresh needs a minute", async () => {
    const hub = offline();
    const clock = { t: T0 };
    const { s } = source(hub, clock);
    await s.load();
    const n = requests(hub);
    clock.t = T0 + 14 * 60_000;
    const v = await source(hub, clock).s.load();
    expect(requests(hub)).toBe(n);
    expect(v.note).toContain("Couldn't reach Hugging Face");
    expect(v.note).toContain("will try again");
    clock.t = T0 + 16 * 60_000;
    await source(hub, clock).s.load();
    expect(requests(hub)).toBeGreaterThan(n);
    const n2 = requests(hub);
    clock.t += 30_000;
    await source(hub, clock).s.load({ refresh: true });
    expect(requests(hub)).toBe(n2); // refresh asked 30 s after the last attempt
    clock.t += 31_000;
    await source(hub, clock).s.load({ refresh: true });
    expect(requests(hub)).toBeGreaterThan(n2);
  });

  test("offline with an older list under 30 days: that list, flagged stale, and a failed refresh never replaces it", async () => {
    const good = fakeHub();
    const clock = { t: T0 };
    const first = await source(good, clock).s.load();
    clock.t = T0 + 3 * DAY_MS;
    const v = await source(offline(), clock).s.load();
    expect(v).toMatchObject({ source: "huggingface", state: "stale", checkedAt: T0 });
    expect(v.catalog.models.map((m) => m.id)).toEqual(first.catalog.models.map((m) => m.id));
    expect(v.note).toBe("Couldn't reach Hugging Face (no network); using the list read on 2026-10-01 22:00 UTC.");
    expect((JSON.parse(readFileSync(cachePath(home), "utf8")) as { fetched_at: number }).fetched_at).toBe(T0);
  });

  test("an older list over 30 days is not used: the built-in one", async () => {
    const clock = { t: T0 };
    await source(fakeHub(), clock).s.load();
    clock.t = T0 + 31 * DAY_MS;
    const v = await source(offline(), clock).s.load();
    expect(v.source).toBe("built-in");
    expect(source(fakeHub(), clock).s.peek().source).toBe("built-in"); // and peek agrees
  });

  test("rate limited, malformed and too few models each say what happened", async () => {
    const limited = fakeHub();
    limited.inject("/api/models?", () => new Response("slow", { status: 429 }), 100);
    expect((await source(limited, { t: T0 }).s.load()).note).toBe(`Hugging Face is limiting this machine's requests right now, so this is the list built into Walkie (updated ${CATALOG.updated}).`);
    rmSync(cachePath(home)); // each scenario starts without the previous one's remembered failure
    const junk = fakeHub();
    junk.inject("/api/models?", () => new Response(JSON.stringify({ x: 1 })), 100);
    expect((await source(junk, { t: T0 }).s.load()).note).toContain("answer wasn't usable");
    rmSync(cachePath(home));
    const hub = fakeHub();
    expect((await source(hub, { t: T0 }, { minModels: 99 }).s.load()).note).toContain("too few usable models");
  });

  test("offline mode makes no request: the cached list if there is one, else the built-in", async () => {
    const hub = fakeHub();
    const clock = { t: T0 };
    expect((await source(hub, clock).s.load({ offline: true })).source).toBe("built-in");
    expect(requests(hub)).toBe(0);
    await source(hub, clock).s.load();
    const n = requests(hub);
    clock.t = T0 + 5 * DAY_MS;
    const v = await source(hub, clock).s.load({ offline: true });
    expect(v).toMatchObject({ source: "huggingface", state: "stale" });
    expect(requests(hub)).toBe(n);
  });
});

describe("the file on disk", () => {
  test("garbage, a wrong shape or an invalid catalog is ignored as if absent", async () => {
    mkdirSync(join(home, "pool"), { recursive: true });
    for (const bad of ["not json", "{}", JSON.stringify({ v: 1, fetched_at: T0, catalog: { version: 1 } }), JSON.stringify({ v: 2, fetched_at: T0, catalog: CATALOG }), "x".repeat(3 << 20)]) {
      writeFileSync(cachePath(home), bad);
      expect(source(fakeHub(), { t: T0 }).s.peek().source).toBe("built-in");
    }
  });

  test("a refresh that works clears an earlier failure; the file holds the list and when it was read", async () => {
    const clock = { t: T0 };
    await source(offline(), clock).s.load();
    expect(JSON.parse(readFileSync(cachePath(home), "utf8"))).toMatchObject({ failed: { kind: "offline" } });
    clock.t = T0 + 20 * 60_000;
    await source(fakeHub(), clock).s.load();
    const file = JSON.parse(readFileSync(cachePath(home), "utf8")) as { v: number; fetched_at: number; failed?: unknown; stats: { requests: number } };
    expect(file.v).toBe(1);
    expect(file.fetched_at).toBe(clock.t);
    expect(file.failed).toBeUndefined();
    expect(file.stats.requests).toBeGreaterThan(50);
  });

  test("the file is never created by a peek, and never holds a token or anything about the team", async () => {
    const { s } = source(fakeHub(), { t: T0 });
    s.peek();
    expect(existsSync(cachePath(home))).toBe(false);
    await s.load();
    const text = readFileSync(cachePath(home), "utf8");
    for (const word of ["hostname", "handle", "node_id", "authorization", "bearer", "secret", "password"]) expect(text.toLowerCase()).not.toContain(word);
  });
});
