import { expect, test } from "bun:test";
import { makeBind } from "../api/license/bind.ts";
import { makeRenew } from "../api/license/renew.ts";
import { signLicense, signingKeyFromPem } from "../api/_lib/license.ts";
import { renewHash } from "../api/_lib/metadata.ts";
import { deps, fullEnv, MockStripe, NOW, PERIOD_END_S, subscription, testKeypair } from "./helpers.ts";

const signing = testKeypair();
const team = "a1b2c3d4e5f60718";
const lic = "sub_ABC123";
const code = signLicense({ v: 2, kind: "activation", lic_id: lic, plan: "team", seats: 7,
  email: "lead@kestrel.test", interval: "month", issued_at: NOW,
  expires_at: PERIOD_END_S * 1000 + 5 * 86_400_000 }, signingKeyFromPem(signing.pem));
const env = fullEnv(signing.pem, { DATABASE_URL: "postgres://u:p@127.0.0.1:1/none" });
const request = (path: string, body: unknown) => new Request(`https://site.test/api/license/${path}`,
  { method: "POST", body: JSON.stringify(body) });

for (const proof of [undefined, { malformed: true }]) {
  test(`locked bind ignores ${proof ? "malformed" : "absent"} proof and dead database`, async () => {
    const stripe = new MockStripe();
    stripe.subs.set(lic, subscription({ id: lic }));
    let databaseCalls = 0;
    const bind = makeBind({ ...deps(stripe, env), previewCompute: false, computeStore: () => { databaseCalls++; throw Error("database touched"); } });
    const response = await bind(request("bind", { code, team_id: team, proof }));
    expect(response.status).toBe(200);
    expect(Object.keys(await response.json() as object).sort()).toEqual(["key", "renewal_token"]);
    expect(databaseCalls).toBe(0);
    expect(stripe.calls.metadata).toHaveLength(1);
    const write = stripe.calls.metadata[0]!.metadata;
    expect(Object.keys(write).sort()).toEqual(["walkie_renew_hash", "walkie_team"]);
    expect(write.walkie_team).toBe(team);
    expect(write.walkie_renew_hash).toMatch(/^[a-f0-9]{64}$/);
  });
}

test("locked renew ignores a dead database and returns the released key response", async () => {
  const stripe = new MockStripe();
  const token = "T".repeat(43);
  stripe.subs.set(lic, subscription({ id: lic, metadata: { walkie_team: team, walkie_renew_hash: renewHash(token) } }));
  let databaseCalls = 0;
  const renew = makeRenew({ ...deps(stripe, env), previewCompute: false, computeStore: () => { databaseCalls++; throw Error("database touched"); } });
  const response = await renew(request("renew", { lic_id: lic, renewal_token: token }));
  expect(response.status).toBe(200);
  expect(Object.keys(await response.json() as object)).toEqual(["key"]);
  expect(stripe.calls.metadata).toEqual([]);
  expect(databaseCalls).toBe(0);
});
