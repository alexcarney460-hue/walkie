// Loaded by bunfig.toml before root tests. An external request in a test must opt in by importing
// externalFetchForTest instead of using global fetch; accidental production calls fail locally.
const unrestrictedFetch = globalThis.fetch.bind(globalThis);

function localRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  const unix = (init as RequestInit & { unix?: unknown } | undefined)?.unix;
  if (typeof unix === "string" && unix.startsWith("/")) return true;
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  if (!localRequest(input, init)) return Promise.reject(new Error("test fetch blocked non-loopback URL"));
  return unrestrictedFetch(input, init);
}) as typeof fetch;

/** Explicit exception for a test that intentionally exercises a real external service. */
export function externalFetchForTest(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return unrestrictedFetch(input, init);
}
