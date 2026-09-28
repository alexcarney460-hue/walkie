// A stand-in local daemon on a unix socket: records every request and answers from a route table (tests of hooks and
// clients against a daemon of a given shape, e.g. one from before WALKIE-MISSION-1).
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface Recorded { method: string; path: string; body: unknown }

export interface FakeDaemon { socket: string; requests: Recorded[]; stop(): void }

export function fakeDaemon(routes: Record<string, unknown>): FakeDaemon {
  const dir = mkdtempSync("/tmp/walkie-fake-");
  const socket = join(dir, "walkie.sock");
  const requests: Recorded[] = [];
  const server = Bun.serve({
    unix: socket,
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      requests.push({ method: req.method, path: url.pathname + url.search, body: text ? JSON.parse(text) : undefined });
      const hit = routes[`${req.method} ${url.pathname}`];
      return hit === undefined ? Response.json({ error: { code: "not_found", message: url.pathname } }, { status: 404 }) : Response.json(hit);
    },
  });
  return { socket, requests, stop: () => { server.stop(true); rmSync(dir, { recursive: true, force: true }); } };
}
