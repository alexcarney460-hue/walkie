// DIRECT-FIX-3 (Opus r3 LOW 3): a cached Walkie Direct connection that can't open a stream is closed before the
// client dials again. Left open, iroh reuses its path state and the redial went out direct-only (no relay copy):
// under a saturated direct lane the member got 0/10 instead of 15/15.
import { expect, test } from "bun:test";
import type * as Iroh from "@number0/iroh";
import { DirectNet, type DirectDeps } from "../../src/daemon/direct/net.ts";
import { generateKeys } from "../../src/daemon/keys.ts";
import { createLogger } from "../../src/daemon/logger.ts";

test("a stale cached connection is closed before the redial", async () => {
  const events: string[] = [];
  let dials = 0;
  const conn = (n: number, works: boolean) => ({
    paths: () => [],
    closed: () => new Promise<void>(() => undefined),
    openBi: async () => {
      if (!works) throw new Error("connection lost");
      events.push(`open#${n}`);
      return { send: {}, recv: {} };
    },
    close: () => { events.push(`close#${n}`); },
  });
  const ep = {
    close: async () => undefined,
    acceptNext: () => new Promise(() => undefined),
    connect: async () => {
      dials++;
      events.push(`dial#${dials}`);
      return conn(dials, dials > 1);
    },
  };
  const deps: DirectDeps = { keys: generateKeys(), log: createLogger({}), admitted: () => true, handler: async () => new Response("x") };
  const net = Reflect.construct(DirectNet as unknown as new (...a: unknown[]) => DirectNet, [ep, deps, {}]);
  const priv = net as unknown as { openStream(addr: { pubkey: string }, signal: AbortSignal): Promise<Iroh.BiStream> };
  await priv.openStream({ pubkey: generateKeys().pubkey }, AbortSignal.timeout(5_000));
  console.log(`[evidence] stale connection then redial: ${events.join(" -> ")}`);
  expect(events).toEqual(["dial#1", "close#1", "dial#2", "open#2"]);
});

// Opus round-5 MEDIUM (regression from the redial fix): a request whose own signal aborts while waiting for stream
// credit must not close the shared cached connection that other in-flight requests are using.
test("a request's own timeout leaves the shared connection open", async () => {
  const events: string[] = [];
  let dials = 0;
  const conn = (n: number) => ({
    paths: () => [],
    closed: () => new Promise<void>(() => undefined),
    openBi: () => new Promise(() => undefined), // no stream credit: waits until the caller gives up
    close: () => { events.push(`close#${n}`); },
  });
  const ep = {
    close: async () => undefined,
    acceptNext: () => new Promise(() => undefined),
    connect: async () => { dials++; events.push(`dial#${dials}`); return conn(dials); },
  };
  const deps: DirectDeps = { keys: generateKeys(), log: createLogger({}), admitted: () => true, handler: async () => new Response("x") };
  const net = Reflect.construct(DirectNet as unknown as new (...a: unknown[]) => DirectNet, [ep, deps, {}]);
  const priv = net as unknown as { openStream(addr: { pubkey: string }, signal: AbortSignal): Promise<Iroh.BiStream>; conns: Map<string, unknown> };
  const pubkey = generateKeys().pubkey;
  await expect(priv.openStream({ pubkey }, AbortSignal.timeout(50))).rejects.toBeDefined();
  console.log(`[evidence] own timeout: ${events.join(" -> ")}; cached=${priv.conns.size}`);
  expect(events).toEqual(["dial#1"]);
  expect(priv.conns.size).toBe(1);
});
