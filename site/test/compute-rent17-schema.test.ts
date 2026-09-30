import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { makeBind } from '../api/license/bind.ts';
import { createAccount } from '../api/_lib/compute/service.ts';
import type { ComputeStore } from '../api/_lib/compute/store.ts';
import { TEAM_META } from '../api/_lib/metadata.ts';

test('migration 4 store blocks bind and createAccount with a state alert', async () => {
  const w = C.world(), team = C.mkTeam('rent17-schema');
  const store: ComputeStore = { tx: fn => w.store.tx(fn), schemaVersion: async () => 4 };
  const signer = C.LH.testKeypair(), stripe = new C.LH.MockStripe(), lic = 'sub_RENT17M4';
  stripe.subs.set(lic, C.LH.subscription({ id: lic }));
  const code = C.signLicense({ v: 2, kind: 'activation', lic_id: lic, plan: 'team', seats: 7,
    email: 'fixture@example.test', interval: 'month', issued_at: C.LH.NOW,
    expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
  const bind = makeBind({ ...C.LH.deps(stripe, C.LH.fullEnv(signer.pem)), computeStore: () => store });
  const response = await bind(new Request('https://site.test/api/license/bind', { method: 'POST',
    body: JSON.stringify({ code, team_id: team.team }) }));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'compute_state_unavailable' });
  expect(stripe.subs.get(lic)!.metadata[TEAM_META]).toBeUndefined();
  expect(await C.err(createAccount({ ...w.d, store }, team.team,
    C.proof(team.f, team.team, w.clock.now, team.genesis)))).toBe('compute_state_unavailable');
  expect(w.logs).toContain('alert_compute_state_unavailable');
});

test('version zero permits proof-less legacy bind only when all compute tables are proven empty', async () => {
  for (const empty of [false, true]) {
    const w = C.world(), team = C.mkTeam(`rent18-schema-${empty}`);
    const signer = C.LH.testKeypair(), stripe = new C.LH.MockStripe(), lic = `sub_RENT18_${empty}`;
    stripe.subs.set(lic, C.LH.subscription({ id: lic }));
    const code = C.signLicense({ v: 2, kind: 'activation', lic_id: lic, plan: 'team', seats: 7,
      email: 'fixture@example.test', interval: 'month', issued_at: C.LH.NOW,
      expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
    const store: ComputeStore = { schemaVersion: async () => 0, legacyEmpty: async () => empty,
      bindClaim: id => w.store.bindClaim(id), saveBindClaim: (id, claim) => w.store.saveBindClaim(id, claim),
      clearBindClaim: (id, hash) => w.store.clearBindClaim(id, hash),
      tx: fn => w.store.tx(tx => fn({ ...tx, legacyEmpty: async () => empty })) };
    const bind = makeBind({ ...C.LH.deps(stripe, C.LH.fullEnv(signer.pem)), computeStore: () => store });
    const response = await bind(new Request('https://site.test/api/license/bind', { method: 'POST',
      body: JSON.stringify({ code, team_id: team.team }) }));
    expect(response.status).toBe(empty ? 200 : 503);
    expect(stripe.subs.get(lic)!.metadata[TEAM_META]).toBe(empty ? team.team : undefined);
  }
});
