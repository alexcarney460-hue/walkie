import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';

test('proof-less first bind holds team chain lock through Stripe metadata write', async () => {
  const w = C.world(), team = C.mkTeam('rent18-bind-race');
  const signer = C.LH.testKeypair(), stripe = new C.LH.MockStripe(), lic = ("sub_" + 'RENT18LOCK');
  stripe.subs.set(lic, C.LH.subscription({ id: lic }));
  const code = C.signLicense({ v: 2, kind: 'activation', lic_id: lic, plan: 'team', seats: 7,
    email: 'fixture@example.test', interval: 'month', issued_at: C.LH.NOW,
    expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
  let entered!: () => void, release!: () => void;
  const writing = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const originalWrite = stripe.setSubscriptionMetadata.bind(stripe);
  stripe.setSubscriptionMetadata = async (id, metadata) => {
    entered();
    await gate;
    await originalWrite(id, metadata);
  };
  const bind = C.makeBind({ ...C.LH.deps(stripe, C.LH.fullEnv(signer.pem)), computeStore: () => w.store });
  const binding = bind(new Request('https://site.test/api/license/bind', { method: 'POST',
    body: JSON.stringify({ code, team_id: team.team }) }));
  await writing;
  let accountSettled = false;
  const account = C.createAccount(w.d, team.team, C.proof(team.f, team.team, w.clock.now, team.genesis))
    .finally(() => { accountSettled = true; });
  await Bun.sleep(20);
  expect(accountSettled).toBe(false);
  release();
  expect((await binding).status).toBe(200);
  expect((await account).account_id).toBeString();
});
