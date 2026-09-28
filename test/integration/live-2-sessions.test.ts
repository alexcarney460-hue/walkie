// WALKIE-LIVE-2: dashboard sessions survive a daemon restart (an upgrade used to sign every dashboard out); logout and
// token rotation still end them, including the saved copies. Only hashes are saved.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { SESSIONS_META } from "../../src/daemon/local-api.ts";
import { Cluster, type TestNode } from "../helpers/cluster.ts";

let c: Cluster;
let alex: TestNode;
const PORT = 20_000 + Math.floor(Math.random() * 20_000);

beforeAll(async () => {
  c = new Cluster();
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", localPort: PORT });
  await alex.client().init("acme", "alex");
});
afterAll(async () => { await c.close(); });

const url = (p: string) => `http://127.0.0.1:${PORT}${p}`;

async function session(): Promise<Record<string, string>> {
  const { nonce } = await alex.client().authNonce();
  const res = await fetch(url(`/auth?nonce=${nonce}`), { redirect: "manual" });
  const value = /#s=([0-9a-f]{64})$/.exec(res.headers.get("location") ?? "")?.[1] ?? "";
  expect(value).toMatch(/^[0-9a-f]{64}$/);
  return { "X-Walkie-Session": value };
}
const me = async (h: Record<string, string>) => (await fetch(url("/v1/me"), { headers: h })).status;

describe("dashboard sessions across daemon restarts", () => {
  test("a session keeps working after a restart; only its hash is on disk", async () => {
    const h = await session();
    expect(await me(h)).toBe(200);
    await alex.restart();
    expect(await me(h)).toBe(200);
    const db = new Database(alex.d.paths.db, { readonly: true });
    const saved = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(SESSIONS_META)?.value ?? "";
    db.close();
    expect(saved).not.toContain(h["X-Walkie-Session"] as string);
    expect(JSON.parse(saved).s).toHaveLength(1);
    expect(saved).not.toContain(alex.d.token); // the generation is a fingerprint, not the token
    expect(readFileSync(alex.d.paths.db).includes(Buffer.from(h["X-Walkie-Session"] as string))).toBe(false);
  }, 30_000);

  test("token rotation ends every session, and a restart doesn't bring them back", async () => {
    const h = await session();
    expect(await me(h)).toBe(200);
    await alex.client().request("POST", "/v1/auth/rotate", {});
    expect(await me(h)).toBe(401);
    await alex.restart();
    expect(await me(h)).toBe(401);
  }, 30_000);

  test("`walkie dashboard logout` ends every session, and a restart doesn't bring them back", async () => {
    const h = await session();
    await alex.client().request("POST", "/v1/auth/logout", {});
    expect(await me(h)).toBe(401);
    await alex.restart();
    expect(await me(h)).toBe(401);
  }, 30_000);
});
