// A stand-in for the Hugging Face Hub that answers from the trimmed real responses in test/fixtures/pool-hf, with the
// Hub's own habits kept: a missing or gated repo answers 401, `resolve/main/<file>` answers 307 to a relative
// `/api/resolve-cache/...` and then 200 text/plain, the `ratelimit` header counts down per bucket. No test touches the
// network (test/helpers/fetch-guard.ts); they inject this fetch.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES } from "./pool-machines.ts";

export const HF_FIXTURES = join(FIXTURES, "pool-hf");
const slug = (repo: string): string => repo.replace("/", "__");

export interface HubCall { method: string; url: string; headers: Record<string, string> }

export interface FakeHub {
  fetch: typeof fetch;
  calls: HubCall[];
  /** Requests answered per bucket ("api", "resolvers"). */
  count(bucket: "api" | "resolvers"): number;
  /** Answer requests whose URL contains `part` with `res` instead (once, unless `times` says more). */
  inject(part: string, res: () => Response | Promise<Response>, times?: number): void;
}

export interface HubOptions {
  /** Starting values of the rate-limit windows (the Hub: 500 and 3000 per 300 s). */
  limits?: { api: number; resolvers: number };
  /** Drop a fixture (as if the Hub did not have it): `models/<owner>__<name>` style keys relative to the fixtures. */
  without?: readonly string[];
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

export function fakeHub(opts: HubOptions = {}): FakeHub {
  const calls: HubCall[] = [];
  const left = { api: opts.limits?.api ?? 500, resolvers: opts.limits?.resolvers ?? 3000 };
  const used = { api: 0, resolvers: 0 };
  const injected: { part: string; res: () => Response | Promise<Response>; times: number }[] = [];
  const read = (rel: string): string | null => {
    if (opts.without?.includes(rel)) return null;
    const p = join(HF_FIXTURES, rel);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  };
  const stamp = (bucket: "api" | "resolvers"): Record<string, string> => {
    used[bucket]++;
    left[bucket] = Math.max(0, left[bucket] - 1);
    return { ratelimit: `"${bucket}";r=${left[bucket]};t=200`, "ratelimit-policy": `"fixed window";"${bucket}";q=${bucket === "api" ? 500 : 3000};w=300` };
  };
  const unauthorized = (bucket: "api" | "resolvers"): Response => json({ error: "Invalid username or password." }, 401, stamp(bucket));

  const route = (url: URL): Response => {
    const path = url.pathname;
    const q = url.searchParams;
    if (path === "/api/models") {
      const filters = q.getAll("filter");
      const base = filters.find((f) => f.startsWith("base_model:quantized:"))?.slice("base_model:quantized:".length);
      const rel = base ? `quants/${slug(base)}.json` : `lists/${q.get("pipeline_tag")}.${q.get("sort")}.json`;
      const items = JSON.parse(read(rel) ?? "[]") as unknown[];
      return json(items.slice(0, Number(q.get("limit") ?? items.length)), 200, stamp("api"));
    }
    const model = /^\/api\/models\/([^/]+\/[^/]+)$/.exec(path);
    if (model) {
      const rel = q.get("blobs") === "true" ? `blobs/${slug(model[1]!)}.json` : `models/${slug(model[1]!)}.json`;
      const body = read(rel);
      return body === null ? unauthorized("api") : new Response(body, { status: 200, headers: { "content-type": "application/json", ...stamp("api") } });
    }
    const org = /^\/api\/organizations\/([^/]+)\/overview$/.exec(path);
    if (org) {
      const body = read(`orgs/${org[1]}.json`);
      return body === null ? json({ error: "Sorry, we can't find the page you are looking for." }, 404, stamp("api")) : new Response(body, { status: 200, headers: { "content-type": "application/json", ...stamp("api") } });
    }
    const resolve = /^\/([^/]+\/[^/]+)\/resolve\/main\/(config\.json|README\.md)$/.exec(path);
    if (resolve) {
      const dir = resolve[2] === "config.json" ? "configs" : "cards";
      const file = resolve[2] === "config.json" ? `${slug(resolve[1]!)}.json` : `${slug(resolve[1]!)}.md`;
      if (read(`${dir}/${file}`) === null) return unauthorized("resolvers");
      return new Response("Temporary Redirect. Redirecting to /api/resolve-cache/", {
        status: 307,
        headers: { "content-type": "text/plain; charset=utf-8", location: `/api/resolve-cache/models/${resolve[1]}/${"b".repeat(40)}/${resolve[2]}?etag=%22abc%22`, ...stamp("resolvers") },
      });
    }
    const cached = /^\/api\/resolve-cache\/models\/([^/]+\/[^/]+)\/[0-9a-f]{40}\/(config\.json|README\.md)$/.exec(path);
    if (cached) {
      const dir = cached[2] === "config.json" ? "configs" : "cards";
      const body = read(`${dir}/${slug(cached[1]!)}.${cached[2] === "config.json" ? "json" : "md"}`);
      return body === null ? unauthorized("resolvers") : new Response(body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8", ...stamp("resolvers") } });
    }
    return new Response("not found", { status: 404 });
  };

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    calls.push({ method: init?.method ?? "GET", url: url.href, headers });
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const hit = injected.find((i) => i.times > 0 && url.href.includes(i.part));
    if (hit) { hit.times--; return hit.res(); }
    if (url.origin !== "https://huggingface.co") return new Response("blocked", { status: 599 });
    return route(url);
  }) as typeof fetch;

  return {
    fetch: fakeFetch, calls,
    count: (b) => used[b],
    inject: (part, res, times = 1) => { injected.push({ part, res, times }); },
  };
}
