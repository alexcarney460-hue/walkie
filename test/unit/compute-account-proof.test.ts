import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ComputeService, type ComputeDeps } from '../../src/daemon/compute/service.ts';
import { ComputeSite } from '../../src/daemon/compute/site.ts';
import { generateKeys, signEvent } from '../../src/daemon/keys.ts';
import { deriveTeamId } from '../../src/protocol/ids.ts';
import { PROTOCOL_VERSION } from '../../src/protocol/schemas.ts';
import { saveRenewToken } from '../../src/license/renew-token.ts';
import type { Core } from '../../src/daemon/core.ts';
import type { Logger } from '../../src/daemon/logger.ts';
import { loadAccounts } from '../../src/daemon/compute/files.ts';

for (const licensed of [false, true]) test(`ensureAccount sends ${licensed ? 'license renewal' : 'key'} proof`, async () => {
  const home = mkdtempSync(join(process.cwd(), '.rentops-proof-'));
  const keys = generateKeys(), team = deriveTeamId(keys.pubkey, 'fixture', 1000);
  const genesis = signEvent(keys, { v: PROTOCOL_VERSION, team, id: `${keys.nodeId}:1`, origin: keys.nodeId,
    seq: 1, ts: 1000, author: { handle: 'alex', node: keys.nodeId }, kind: 'team.create',
    body: { name: 'fixture', owner_login: 'direct:alex', owner_handle: 'alex', node_hostname: 'fixture',
      node_pubkey: keys.pubkey, node_ip: '127.0.0.1' } });
  const received: Record<string, unknown>[] = [];
  try {
    if (licensed) saveRenewToken(home, { team, lic_id: 'sub_fixture', token: 'R'.repeat(43) });
    const core = { paths: { home }, teamId: team, keys, clock: () => 1000, isAuthority: () => true,
      roster: { license: licensed ? { payload: { lic_id: 'sub_fixture' } } : null },
      store: { teamCreate: () => genesis }, rosterEntries: () => [] } as unknown as Core;
    const site = new ComputeSite({ base: 'https://fixture.test', fetch: async (_, init) => {
      received.push(JSON.parse(init!.body as string));
      return Response.json({ account_id: 'ca_0123456789abcdef', token: 'T'.repeat(43) });
    } });
    const service = new ComputeService({ core, log: { info: () => {} } as unknown as Logger, transport: () => undefined } as ComputeDeps, { site });
    await service.ensureAccount();
    const proof = received[0]!.proof as Record<string, unknown>;
    expect(proof.key).toBe(keys.pubkey);
    expect(proof.genesis).toEqual(genesis);
    expect(proof.authority_chain).toEqual([]);
    expect(proof.signature).toBe(keys.sign(`walkie-compute-account-v1\n${team}\n241000`));
    expect(proof.lic_id).toBe(licensed ? 'sub_fixture' : undefined);
    expect(proof.renewal_token).toBe(licensed ? 'R'.repeat(43) : undefined);
    await service.ensureAccount();
    expect(received).toHaveLength(1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('enrollment persists every adopted token and state exposes every account', async () => {
  const home = mkdtempSync(join(process.cwd(), '.rentops-adopt-'));
  const keys = generateKeys(), team = deriveTeamId(keys.pubkey, 'adopt', 1000);
  const genesis = signEvent(keys, { v: PROTOCOL_VERSION, team, id: `${keys.nodeId}:1`, origin: keys.nodeId, seq: 1, ts: 1000,
    author: { handle: 'alex', node: keys.nodeId }, kind: 'team.create', body: { name: 'adopt', owner_login: 'direct:alex',
      owner_handle: 'alex', node_hostname: 'fixture', node_pubkey: keys.pubkey, node_ip: '127.0.0.1' } });
  const a = { account_id: 'ca_0123456789abcdef', token: 'A'.repeat(43) };
  const b = { account_id: 'ca_fedcba9876543210', token: 'B'.repeat(43) };
  const used: string[] = [];
  try {
    const core = { paths: { home }, teamId: team, keys, clock: () => 1000, isAuthority: () => true,
      roster: { license: null }, store: { teamCreate: () => genesis, queryEvents: () => [] }, rosterEntries: () => [] } as unknown as Core;
    const site = new ComputeSite({ base: 'https://fixture.test', fetch: async (url, init) => {
      if (String(url).endsWith('/account')) return Response.json({ ...a, adopted_accounts: [a, b] });
      if (String(url).endsWith('/state')) {
        const auth = init?.headers && (init.headers as Record<string, string>).Authorization;
        used.push(auth ?? '');
        const id = auth === `Bearer ${b.token}` ? b.account_id : a.account_id;
        return Response.json({ account_id: id, team_id: team, status: 'active', balance_micros: id === b.account_id ? 5000000 : 0,
          burn_per_hour_micros: 0, hours_left: null, rentals: [] });
      }
      if (String(url).endsWith('/credit')) {
        used.push((init?.headers as Record<string, string>).Authorization ?? '');
        return Response.json({ url: 'https://checkout.test/fixture' });
      }
      if (String(url).endsWith('/stop')) {
        used.push((init?.headers as Record<string, string>).Authorization ?? '');
        return Response.json({ stopped: 0, rentals: [] });
      }
      throw new Error('unexpected site call');
    } });
    const service = new ComputeService({ core, log: { info: () => {} } as unknown as Logger, transport: () => undefined } as ComputeDeps, { site });
    await service.ensureAccount();
    expect(loadAccounts(home).map(x => x.account_id)).toEqual([a.account_id, b.account_id]);
    expect(service.pending()).toBe(true);
    await service.pollOnce();
    expect(service.pending()).toBe(false);
    const state = await service.state();
    expect('accounts' in state ? state.accounts?.map(x => x.account_id) : []).toEqual([a.account_id, b.account_id]);
    await service.credit(50, b.account_id);
    await service.stop({ all: true, account_id: b.account_id });
    expect(used.slice(-2)).toEqual([`Bearer ${b.token}`, `Bearer ${b.token}`]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
