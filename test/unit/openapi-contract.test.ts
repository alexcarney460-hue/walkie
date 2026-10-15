// docs/openapi.json describes the daemon's local API; this test fails when the document and the code drift.
//
// The route table in src/daemon/local-routes.ts is private (registration is a side effect of importing a routes file), so
// the set of registered routes is extracted from the source: every `route("METHOD", <path>, handler)` /
// `integrationRoute(...)` call in a route module under src/. <path> is a string literal, a regex literal, or
// `new RegExp(`...`)` whose `${CONST}` parts are the file's own `const CONST = "..."` strings. Limits of the method: a
// registration written with a computed method or path fails the extraction; calls embedded in strings or comments are
// not seen. Two guards cover drift: (1) every src file that imports `route` from local-routes.ts must yield at least one
// extracted registration, and (2) every documented route must be found by the REAL table (`hasRoute`, after importing
// the routes files). The routes the local API answers before `dispatch` (src/daemon/local-api.ts: /v1/auth/*,
// /v1/desktop/*) are not in the table; they are listed in SPECIAL below and checked against that file's text.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { dashboardRoute } from "../../src/daemon/local-api.ts";
import { hasRoute } from "../../src/daemon/local-routes.ts";

const ROOT = resolve(import.meta.dir, "../..");
const SRC = join(ROOT, "src");

type Op = {
  summary?: unknown; responses?: Record<string, unknown>; security?: Record<string, unknown>[];
  parameters?: { name: string; in: string; example?: unknown }[]; [k: string]: unknown;
};
type Doc = { openapi: string; info: unknown; paths: Record<string, Record<string, Op>>; components?: { securitySchemes?: Record<string, unknown> } };

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const doc = JSON.parse(readFileSync(join(ROOT, "docs/openapi.json"), "utf8")) as Doc;

/** Routes answered by LocalApi itself, before dispatch (not in the route table), with a text probe in local-api.ts. */
const SPECIAL: readonly [string, string][] = [
  ["POST", "/v1/auth/nonce"], ["POST", "/v1/auth/logout"], ["POST", "/v1/auth/rotate"],
  ["GET", "/v1/desktop/identity"], ["POST", "/v1/desktop/challenge"], ["POST", "/v1/desktop/prove"],
];
const isSpecial = (m: string, p: string) => SPECIAL.some(([sm, sp]) => sm === m && sp === p);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [p] : [];
  });
}

interface Registration { file: string; method: string; re: RegExp; groups: number; where: string }

function pathToRegExp(expr: string, text: string, where: string): RegExp {
  const lit = /^(["'])(.*)\1$/.exec(expr);
  if (lit) return new RegExp(`^${lit[2]}$`);
  const rx = /^\/(.*)\/[a-z]*$/.exec(expr);
  if (rx) return new RegExp(rx[1]!);
  const tpl = /^new RegExp\(`(.*)`\)$/.exec(expr);
  if (tpl) {
    const src = tpl[1]!.replace(/\$\{(\w+)\}/g, (_, name: string) => {
      const def = new RegExp(`^const ${name} = (".*");`, "m").exec(text);
      if (!def) throw new Error(`${where}: cannot resolve \${${name}}`);
      return JSON.parse(def[1]!) as string;
    }).replace(/\\\\/g, "\\"); // the template literal's own escaping
    return new RegExp(src);
  }
  throw new Error(`${where}: unsupported path expression ${expr}`);
}

function extractSourceRegistrations(text: string, file: string): Registration[] {
  const out: Registration[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (/^\s*\/\//.test(line)) return;
    if (file === "src/integrations/routes.ts" && /^\s*route\(method, path, h\);$/.test(line)) return; // wrapper delegates to addRoute
    for (const call of line.matchAll(/(?<![.\w])(?:integrationRoute|route)\(\s*/g)) {
      if (/\bfunction\s+$/.test(line.slice(0, call.index))) continue;
      const where = `${file}:${i + 1}`;
      const rest = line.slice(call.index + call[0].length);
      const m = /^(["'])([A-Z]+)\1,\s*(.*)$/.exec(rest);
      if (!m) throw new Error(`${where}: unsupported route registration (computed method)`);
      // the path expression ends where the handler starts.
      const expr = m[3]!.replace(/,\s*(?:async\s*)?(?:\(|c\s*=>).*$/, "").replace(/,\s*$/, "");
      const re = pathToRegExp(expr.trim(), text, where);
      out.push({ file, method: m[2]!, re, groups: new RegExp(`${re.source}|`).exec("")!.length - 1, where });
    }
  });
  return out;
}

function extractRegistrations(): Registration[] {
  const out: Registration[] = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    if (!file.endsWith("/daemon/local-routes.ts") && !file.endsWith("/integrations/routes.ts")
      && !/import\s*\{[^}]*\b(?:route|integrationRoute)\b[^}]*\}\s*from/.test(text)) continue;
    out.push(...extractSourceRegistrations(text, relative(ROOT, file)));
  }
  return out;
}

interface DocOp { method: string; path: string; op: Op; sample: string; params: number; id: string }

function docOps(): DocOp[] {
  const out: DocOp[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [k, op] of Object.entries(item)) {
      if (!METHODS.includes(k)) continue;
      const params = (op.parameters ?? []).filter((p) => p.in === "path");
      let sample = path;
      for (const p of params) sample = sample.replace(`{${p.name}}`, String(p.example));
      out.push({ method: k.toUpperCase(), path, op, sample, params: params.length, id: `${k.toUpperCase()} ${path}` });
    }
  }
  return out;
}

const registrations = extractRegistrations();
const ops = docOps();
const matches = (r: Registration, o: DocOp) => r.method === o.method && r.re.test(o.sample) && r.groups === o.params;

describe("openapi document", () => {
  test("dashboard-only resets document only credentials their handlers accept", () => {
    for (const path of ["/v1/accounts/reset", "/v1/accounts/reset/prepare", "/v1/accounts/reset/resolve", "/v1/accounts/refresh"]) {
      expect(doc.paths[path]?.post?.security, path).toEqual([{ dashboardSession: [] }]);
    }
    expect(doc.paths["/v1/orchestrator/schedules/{id}/reset"]?.post?.security).toEqual([
      { unixSocket: [] }, { dashboardSession: [] },
    ]);
  });

  test("source references do not carry fragile line numbers", () => {
    expect([...JSON.stringify(doc).matchAll(/src\/[^\s"()]+\.ts:\d+/g)].map((m) => m[0]).slice(0, 5)).toEqual([]);
  });

  test("parses and declares OpenAPI 3.1.x", () => {
    expect(doc.openapi).toMatch(/^3\.1\.\d+$/);
    expect(doc.info).toBeTruthy();
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
    for (const p of Object.keys(doc.paths)) expect(p.startsWith("/v1/")).toBe(true);
  });

  test("every operation has a summary, a response and a security requirement", () => {
    const schemes = Object.keys(doc.components?.securitySchemes ?? {});
    expect(schemes.length).toBeGreaterThan(0);
    for (const o of ops) {
      expect(typeof o.op.summary === "string" && (o.op.summary as string).length > 0, `${o.id}: summary`).toBe(true);
      expect(Object.keys(o.op.responses ?? {}).length, `${o.id}: responses`).toBeGreaterThan(0);
      expect(Array.isArray(o.op.security), `${o.id}: security must be present (an explicit [] means unauthenticated)`).toBe(true);
      for (const req of o.op.security!) for (const name of Object.keys(req)) expect(schemes, `${o.id}: scheme ${name}`).toContain(name);
    }
  });

  test("path templates and path parameters agree, with an example for each", () => {
    for (const o of ops) {
      const inTemplate = [...o.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
      const declared = (o.op.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name).sort();
      expect(declared, o.id).toEqual(inTemplate);
      for (const p of o.op.parameters ?? []) if (p.in === "path") expect(typeof p.example, `${o.id}: ${p.name} example`).toBe("string");
    }
  });

  test("every $ref resolves inside the document", () => {
    const text = JSON.stringify(doc);
    for (const m of text.matchAll(/"\$ref":"(#[^"]*)"/g)) {
      let node: unknown = doc;
      for (const seg of m[1]!.slice(2).split("/")) node = (node as Record<string, unknown> | undefined)?.[seg.replace(/~1/g, "/").replace(/~0/g, "~")];
      expect(node, m[1]).toBeDefined();
    }
  });
});

describe("openapi document matches the registered routes", () => {
  test("local OSS operations document their code guards", () => {
    const consent = doc.paths["/v1/seats/codex-oss"]?.post;
    const preflight = doc.paths["/v1/seats/oss-preflight"]?.post;
    expect(consent?.["x-walkie-agent-policy"]).toContain("personOnly");
    expect(consent?.["x-walkie-guards"]).toContain("requireOssPerson");
    expect(preflight?.["x-walkie-guards"]).toContain("requireTeam");
  });
  test("the extractor sees indented registrations and rejects computed ones", () => {
    expect(extractSourceRegistrations('  route("GET", "/v1/zz-indented", () => {});', "fixture.ts")).toHaveLength(1);
    expect(() => extractSourceRegistrations('for (const m of ["GET"]) { route(m, "/v1/zz-loop", () => {}); }', "fixture.ts")).toThrow(/unsupported route registration/);
  });

  test("the extraction sees registrations, and every file that imports route() yields some", () => {
    expect(registrations.length).toBeGreaterThan(100);
    const extracted = new Set(registrations.map((r) => r.file));
    for (const file of walk(SRC)) {
      const text = readFileSync(file, "utf8");
      const importsRoute = /import\s*\{[^}]*\broute\b[^}]*\}\s*from\s*"[^"]*local-routes\.ts"/.test(text)
        || /import\s*\{[^}]*\bintegrationRoute\b[^}]*\}\s*from/.test(text);
      if (importsRoute) expect(extracted.has(relative(ROOT, file)), `${relative(ROOT, file)} imports route() but no registration was extracted`).toBe(true);
    }
  });

  test("every registered route is documented", () => {
    for (const r of registrations) {
      expect(ops.some((o) => matches(r, o)), `${r.method} ${r.re.source} (${r.where}) is registered but not in docs/openapi.json`).toBe(true);
    }
  });

  test("every documented route is registered", async () => {
    // Import the routes files so the REAL table is filled, then ask it.
    for (const f of new Set(registrations.map((r) => r.file))) await import(join(ROOT, f));
    for (const o of ops) {
      if (isSpecial(o.method, o.path)) continue;
      expect(registrations.some((r) => matches(r, o)), `${o.id} is documented but no registration matches it`).toBe(true);
      expect(hasRoute(o.method, o.sample), `${o.id} (${o.sample}) is not in the daemon's route table`).toBe(true);
    }
  });

  test("the routes answered by LocalApi itself are documented and still in local-api.ts", () => {
    const text = readFileSync(join(SRC, "daemon/local-api.ts"), "utf8");
    for (const [m, p] of SPECIAL) {
      expect(ops.some((o) => o.method === m && o.path === p), `${m} ${p} missing from the document`).toBe(true);
      expect(text.includes(`"${p}"`), `${p} no longer appears in local-api.ts`).toBe(true);
    }
  });

  test("a dashboard session is accepted exactly where the daemon's allow-list says", () => {
    for (const o of ops) {
      if (isSpecial(o.method, o.path)) continue;
      const names = o.op.security!.flatMap((r) => Object.keys(r));
      expect(names.includes("dashboardSession"), `${o.id}: dashboardSession must match dashboardRoute()`).toBe(dashboardRoute(o.method, o.sample));
    }
  });
});
