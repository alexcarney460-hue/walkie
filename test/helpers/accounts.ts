// A fake user home with Claude / Codex / Kimi / Grok logins (fictional fixtures) and a fake fetch that serves the
// usage endpoints, records every URL and FAILS the test on anything else — a token or refresh endpoint above all.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAllowedUsageUrl, USAGE_URLS, type FetchLike } from "../../src/accounts/http.ts";

export const FIX = join(import.meta.dir, "..", "fixtures", "accounts");
export const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIX, name), "utf8"));
export const fixtureText = (name: string): string => readFileSync(join(FIX, name), "utf8");

/** Distinctive fake tokens: the search tests look for these strings everywhere Walkie writes. */
export const TOKENS = {
  claude: ("sk" + "-ant-oat01-FAKECLAUDEACCESSTOKEN0123456789abcdefFAKE"),
  codexSecret: "FAKECODEXSIGNATUREPART0123456789abcdef",
  kimi: "FAKEKIMIACCESSTOKEN0123456789abcdefghijklmnop",
};

function jwt(payload: Record<string, unknown>, sig: string): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "RS256" })}.${b(payload)}.${sig}`;
}

export function codexAccessToken(expMs: number): string {
  return jwt({ exp: Math.floor(expMs / 1000), scope: "fake" }, TOKENS.codexSecret);
}

export interface FakeHomeOptions {
  claudeExpiresAt?: number; claudeRefreshExpiresAt?: number; codexExpiresAt?: number; kimiExpiresAt?: number;
  grokLog?: string;
}

export function makeFakeHome(home: string, o: FakeHomeOptions = {}): string {
  const now = Date.now();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude.json"), fixtureText("claude.json"));
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({
    claudeAiOauth: {
      accessToken: TOKENS.claude, refreshToken: ("sk" + "-ant-ort01-FAKEREFRESHNEVERSENT"), expiresAt: o.claudeExpiresAt ?? now + 6 * 3600_000,
      refreshTokenExpiresAt: o.claudeRefreshExpiresAt ?? now + 20 * 86_400_000, scopes: ["user:inference"], subscriptionType: "max",
    },
  }));
  mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
  const auth = fixture("codex-auth.json") as { tokens: Record<string, string> };
  auth.tokens.access_token = codexAccessToken(o.codexExpiresAt ?? now + 5 * 86_400_000);
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify(auth));
  mkdirSync(join(home, ".kimi-code", "credentials"), { recursive: true });
  writeFileSync(join(home, ".kimi-code", "credentials", "kimi-code.json"), JSON.stringify({
    access_token: TOKENS.kimi, refresh_token: "FAKEKIMIREFRESHNEVERSENT", expires_at: o.kimiExpiresAt ?? now + 10 * 60_000, scope: "kimi-code", token_type: "Bearer", expires_in: 900,
  }));
  mkdirSync(join(home, ".grok", "logs"), { recursive: true });
  writeFileSync(join(home, ".grok", "auth.json"), fixtureText("grok-auth.json"));
  writeFileSync(join(home, ".grok", "logs", "unified.jsonl"), o.grokLog ?? fixtureText("grok-unified.jsonl"));
  return home;
}

export interface FakeFetch {
  fetch: FetchLike;
  calls: string[];
  /** Override the response for a URL (status + body). */
  respond: Map<string, () => Response>;
}

/** Serves the fixtures; throws (and records) on any URL that is not a usage endpoint. */
export function fakeFetch(): FakeFetch {
  const calls: string[] = [];
  const respond = new Map<string, () => Response>();
  const bodies: Record<string, unknown> = {
    [USAGE_URLS.claude]: fixture("claude-usage.json"),
    [USAGE_URLS.codex]: fixture("codex-usage.json"),
    [USAGE_URLS.kimi]: fixture("kimi-usages.json"),
    [USAGE_URLS.kimiMe]: fixture("kimi-me.json"),
  };
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    if (/token|refresh|\/oauth\/(?!usage)/i.test(url) || !isAllowedUsageUrl(url)) throw new Error(`TEST FAILURE: request to a non-usage URL ${url}`);
    if ((init.method ?? "GET") !== "GET") throw new Error(`TEST FAILURE: ${init.method} to ${url}`);
    if (init.redirect !== "error") throw new Error("TEST FAILURE: redirects must be refused");
    const custom = respond.get(url);
    if (custom) return custom();
    return new Response(JSON.stringify(bodies[url]), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { fetch, calls, respond };
}
