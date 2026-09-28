// Split runs (WALKIE-POOL-2): this machine's sharing, runtime, run and stage (`/v1/pool`), same-origin with the
// dashboard session header like api/client.ts. Kept in its own file so the pool card owns its calls.
import { sessionHeaders } from "../lib/session.ts";
import { ApiError } from "./client.ts";
import type { PoolLocalView, RunView } from "../../../src/protocol/pool.ts";

export type { RunView, PoolLocalView };

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method, credentials: "omit", cache: "no-store",
      headers: sessionHeaders(body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ApiError("network", "daemon unreachable", 0);
  }
  const text = await res.text();
  let data: unknown = {};
  try { data = text ? JSON.parse(text) : {}; } catch { throw new ApiError("bad_response", `unexpected response from ${path}`, res.status); }
  if (!res.ok) {
    const e = ((data as { error?: unknown }).error ?? {}) as { code?: unknown; message?: unknown };
    throw new ApiError(typeof e.code === "string" ? e.code : `http_${res.status}`, typeof e.message === "string" ? e.message : res.statusText, res.status);
  }
  return data as T;
}

export const poolApi = {
  get: () => call<PoolLocalView>("GET", "/v1/pool"),
  share: (on: boolean, maxGb?: number | null) => call<PoolLocalView>("POST", "/v1/pool/share", { on, ...(maxGb !== undefined ? { max_gb: maxGb } : {}) }),
  run: (model: string, quant: "q4" | "q8") => call<{ run: RunView }>("POST", "/v1/pool/run", { model, quant }),
  stop: () => call<{ run: RunView | null }>("POST", "/v1/pool/stop", {}),
};
