// The Walkie Direct transport alone (src/daemon/direct/net.ts): HTTP framing over iroh bi-streams on loopback.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DirectNet } from "../../src/daemon/direct/net.ts";
import { generateKeys, type NodeKeys } from "../../src/daemon/keys.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { readCapped } from "../../src/daemon/peer-client.ts";

const dir = mkdtempSync("/tmp/walkie-net-");
const log = createLogger({ file: join(dir, "net.log") });
const book = new Map<string, string[]>();
const server = generateKeys();
const seen: { pubkey: string; method: string; path: string; header: string | null; bytes: number }[] = [];
let srv: DirectNet;
const clients: DirectNet[] = [];

async function client(keys: NodeKeys = generateKeys()): Promise<DirectNet> {
  const net = await DirectNet.start({ keys, log, admitted: () => false, handler: async () => new Response("unused") },
    { preset: "minimal", bindAddr: "127.0.0.1:0", addressBook: book });
  clients.push(net);
  return net;
}

const to = { ip: "", port: 0, pubkey: server.pubkey };
const req = (path: string, init: { method?: string; body?: string; headers?: Record<string, string>; ms?: number } = {}) => ({
  method: init.method ?? "GET", path, headers: init.headers ?? {}, ...(init.body !== undefined ? { body: init.body } : {}),
  signal: AbortSignal.timeout(init.ms ?? 5_000),
});

beforeAll(async () => {
  srv = await DirectNet.start({
    keys: server, log, admitted: (pk) => pk === admittedKey.pubkey,
    handler: async (r, pubkey) => {
      const body = r.method === "GET" ? new Uint8Array() : new Uint8Array(await r.arrayBuffer());
      const url = new URL(r.url);
      seen.push({ pubkey, method: r.method, path: url.pathname + url.search, header: r.headers.get("x-walkie-node"), bytes: body.byteLength });
      if (url.pathname === "/big") return new Response(new Uint8Array(Number(url.searchParams.get("n"))).fill(7));
      if (url.pathname === "/slow") { await Bun.sleep(2_000); return new Response("late"); }
      if (url.pathname === "/echo") return new Response(body, { status: 201, headers: { "x-echo": "1" } });
      return Response.json({ error: { code: "not_member", message: "no" } }, { status: 403 });
    },
  }, { preset: "minimal", bindAddr: "127.0.0.1:0", addressBook: book });
});
const admittedKey = generateKeys();

afterAll(async () => {
  for (const c of clients) await c.stop();
  await srv.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("DirectNet", () => {
  test("the endpoint id is the node key; the server sees the caller's authenticated key", async () => {
    expect(srv.endpoint).toBe(Buffer.from(server.pubkey, "base64").toString("hex"));
    const keys = generateKeys();
    const c = await client(keys);
    const res = await c.request(to, req("/echo?x=1", { method: "POST", body: "hi", headers: { "X-Walkie-Node": "spoofed" } }));
    expect(res.status).toBe(201);
    expect(res.headers.get("x-echo")).toBe("1");
    expect(await res.text()).toBe("hi");
    const last = seen.at(-1);
    expect(last).toMatchObject({ pubkey: keys.pubkey, method: "POST", path: "/echo?x=1", header: "spoofed", bytes: 2 });
  });

  test("a stranger's connection answers every request it is allowed to make", async () => {
    const c = await client();
    for (let i = 0; i < 9; i++) {
      const res = await c.request(to, req("/peer/v1/vv"));
      expect(res.status).toBe(403);
      expect((await res.json()) as unknown).toEqual({ error: { code: "not_member", message: "no" } });
    }
  });

  test("an admitted key keeps one connection for many requests", async () => {
    const c = await client(admittedKey);
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) expect((await c.request(to, req("/peer/v1/vv"))).status).toBe(403);
    console.log(`[metric] direct request round trip (loopback, warm): ${((performance.now() - t0) / 50).toFixed(2)} ms`);
  });

  test("bodies stream both ways: 1 MB up, 3 MB down, and a byte cap stops a read early", async () => {
    const c = await client();
    const up = "x".repeat(1024 * 1024);
    const echoed = await c.request(to, req("/echo", { method: "POST", body: up, ms: 20_000 }));
    expect((await echoed.text()).length).toBe(up.length);
    const down = await c.request(to, req("/big?n=3145728", { ms: 20_000 }));
    expect((await readCapped(down, 4 * 1024 * 1024)).byteLength).toBe(3 * 1024 * 1024);
    const capped = await c.request(to, req("/big?n=3145728", { ms: 20_000 }));
    await expect(readCapped(capped, 64 * 1024)).rejects.toMatchObject({ code: "too_large" });
  }, 30_000);

  test("a request past its deadline is aborted", async () => {
    const c = await client();
    await expect(c.request(to, req("/slow", { ms: 300 }))).rejects.toMatchObject({ name: "AbortError" });
  });

  test("an unknown or stopped endpoint fails fast instead of hanging", async () => {
    const c = await client();
    const gone = generateKeys();
    await expect(c.request({ ip: "", port: 0, pubkey: gone.pubkey }, req("/x", { ms: 3_000 }))).rejects.toBeDefined();
  });
});
