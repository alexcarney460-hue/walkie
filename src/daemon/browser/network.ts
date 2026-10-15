import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { browserRequestAddress } from "./policy.ts";

const MAX_RESPONSE = 10 * 1024 * 1024;
type Resolver = typeof lookup;
export interface BrowserReply { status: number; headers: Record<string, string>; body: Buffer }

/** Chromium only receives fulfilled routes. Node connects to the exact public DNS answer checked here. */
export async function fetchBrowserRequest(raw: string, method: string, headers: Record<string, string>,
  body: Buffer | null, denylist: readonly string[], resolve: Resolver = lookup): Promise<BrowserReply> {
  const address = await browserRequestAddress(raw, denylist, resolve);
  const url = new URL(address.url);
  const run = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<BrowserReply>((resolveReply, reject) => {
    const req = run(url, {
      method, headers: { ...headers, host: url.host }, timeout: 20_000,
      lookup: (_host, _options, callback) => callback(null, address.address, address.family),
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE) { req.destroy(new Error("browser response too large")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        const output: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined && !["connection", "transfer-encoding"].includes(name))
            output[name] = Array.isArray(value) ? value.join("\n") : value;
        }
        resolveReply({ status: response.statusCode ?? 502, headers: output, body: Buffer.concat(chunks) });
      });
    });
    req.on("timeout", () => req.destroy(new Error("browser request timed out")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
