import { redactSecrets } from "../../protocol/safety.ts";
import type { BrowserResult } from "./service.ts";

/** URL queries and fragments are omitted; typed values in host labels and path segments are replaced. */
export function browserAuditLine(op: string, result: BrowserResult | undefined, rawUrl?: string,
  typedValues: readonly string[] = []): string {
  const parts = typedValues.filter(Boolean).flatMap((value) => [value, ...value.split(/[\\/]/).filter(Boolean)]);
  const normalized = (value: string) => value.normalize("NFKC").toLowerCase().replace(/ß/g, "ss").replace(/ς/g, "σ");
  const containsTyped = (value: string) => parts.some((part) => normalized(value).includes(normalized(part)));
  let page = "(no URL)";
  try {
    const url = new URL(result?.url ?? rawUrl ?? "");
    const path = url.pathname.split("/").map((segment) => {
      let decoded = segment;
      try { decoded = decodeURIComponent(segment); } catch { /* retain raw segment */ }
      return containsTyped(decoded) ? "[typed]" : segment;
    }).join("/");
    const crossesLabels = parts.some((value) => value.includes(".") && containsTyped(url.hostname));
    const host = crossesLabels ? "[typed]" : url.hostname.split(".").map((label) => {
      let decoded = label;
      try { decoded = decodeURIComponent(label); } catch { /* retain raw label */ }
      return containsTyped(decoded) ? "[typed]" : label;
    }).join(".");
    page = `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}${path}`;
  } catch { /* no page yet */ }
  const clean = (value: string) => containsTyped(value) ? "[typed]" : value;
  return redactSecrets(`browser ${op} ${page} ${clean(result?.role ?? "")} ${clean(result?.name ?? "")}`).text.slice(0, 500);
}
