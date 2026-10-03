import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dashboardRoute } from "../../src/daemon/local-api.ts";

test("every path in the web API sources accepts a dashboard session", () => {
  const paths: { method: string; path: string }[] = [];
  const root = new URL("../../web/src/api/", import.meta.url);
  for (const file of readdirSync(root).filter((f) => f.endsWith(".ts"))) {
    const source = readFileSync(new URL(file, root), "utf8");
    for (const line of source.split("\n")) {
      for (const match of line.matchAll(/(["`])(\/v1\/.*?)\1/g)) {
        const prefix = line.slice(0, match.index);
        // A second path argument to parse(...) is a diagnostic label, not another request.
        if (/\),\s*$/.test(prefix)) continue;
        const method = prefix.match(/"(GET|POST|DELETE|PUT|PATCH)",\s*$/)?.[1]
          ?? (prefix.includes("const path =") ? "POST" : "GET");
        const path = match[2]!.split(/\?|\$\{qs\(|\$\{all |\$\{v |\$\{brief /)[0]!
          .replace(/\$\{([^}]+)\}/g, (_m, expr: string) => expr === "hash" ? "a".repeat(64) : expr === "decision" ? "approve"
            : expr.includes("channel") ? "p-12345678" : expr.includes("board") ? "a".repeat(16) + "%3A1"
            : match[2]!.includes("/devices/") ? "a".repeat(12) : "example");
        paths.push({ method, path });
      }
    }
  }
  expect(paths.length).toBeGreaterThan(60);
  expect(paths.filter(({ method, path }) => !dashboardRoute(method, path))).toEqual([]);
  expect(dashboardRoute("POST", "/v1/team/authority")).toBe(false);
  expect(dashboardRoute("POST", "/v1/seats/bundle")).toBe(false);
  // TALKIE-OPS-1: a person at the dashboard lists and answers recommendations; only WalkieTalkie's child records one.
  expect(dashboardRoute("POST", "/v1/talkie/recs/abcd1234/dismiss")).toBe(true);
  expect(dashboardRoute("POST", "/v1/talkie/recs")).toBe(false);
  expect(dashboardRoute("POST", "/v1/talkie/recs/abcd1234/anything")).toBe(false);
});
