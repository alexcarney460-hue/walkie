// A stand-in local daemon on a unix socket: records every request and answers from a route table (tests of hooks and
// clients against a daemon of a given shape, e.g. one from before WALKIE-MISSION-1).
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

/** `body`: the JSON a request sent (undefined for a raw one); `bytes`: a raw (non-JSON) body; `headers`: the request's, lower-cased. */
export interface Recorded { method: string; path: string; body: unknown; headers: Record<string, string>; bytes?: Uint8Array }

export interface FakeDaemon { socket: string; requests: Recorded[]; stop(): void }

export function fakeDaemon(routes: Record<string, unknown>): FakeDaemon {
  const dir = mkdtempSync("/tmp/walkie-fake-");
  const socket = join(dir, "walkie.sock");
  const requests: Recorded[] = [];
  const server = Bun.serve({
    unix: socket,
    async fetch(req) {
      const url = new URL(req.url);
      const raw = new Uint8Array(await req.arrayBuffer());
      const json = !(req.headers.get("content-type") ?? "").includes("octet-stream"); // anything else is JSON, as it always was
      const text = json ? new TextDecoder().decode(raw) : "";
      requests.push({
        method: req.method, path: url.pathname + url.search, body: text ? JSON.parse(text) : undefined, headers: Object.fromEntries(req.headers),
        ...(json ? {} : { bytes: raw }),
      });
      const hit = routes[`${req.method} ${url.pathname}`];
      return hit === undefined ? Response.json({ error: { code: "not_found", message: url.pathname } }, { status: 404 }) : Response.json(hit);
    },
  });
  return { socket, requests, stop: () => { server.stop(true); rmSync(dir, { recursive: true, force: true }); } };
}
