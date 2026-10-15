// Go-live builder G, daemon side (REVIEW-merged-opus.md 5): a pending rent whose codes expired must not be replayed every
// minute forever. invalid_rental_invite is answered after the site's replay lookup (the rent was never recorded), so it
// drops the pending rent like the other permanent refusals; and a pending rent whose newest code expired more than 10
// minutes ago gets one final replay and is then dropped, whatever the site answers (a drain answers 503 for hours).
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ComputeService, type ComputeDeps } from '../../src/daemon/compute/service.ts';
import { ComputeSite } from '../../src/daemon/compute/site.ts';
import { loadPending, saveAccounts, savePending } from '../../src/daemon/compute/files.ts';
import { RENTAL_CODE_TTL_MS } from '../../src/protocol/compute.ts';
import { createInvite } from '../../src/daemon/invite.ts';
import { generateKeys, signEvent } from '../../src/daemon/keys.ts';
import { PROTOCOL_VERSION } from '../../src/protocol/schemas.ts';
import { deriveTeamId } from '../../src/protocol/ids.ts';
import type { Core } from '../../src/daemon/core.ts';
import type { Logger } from '../../src/daemon/logger.ts';

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const ACCOUNT = 'ca_0123456789abcdef';

function fixture(reply: (path: string) => Response) {
  const home = mkdtempSync(join(process.cwd(), '.rentops-golive-g-'));
  homes.push(home);
  const keys = generateKeys(), team = deriveTeamId(keys.pubkey, 'golive-g', 1000);
  const genesis = signEvent(keys, { v: PROTOCOL_VERSION, team, id: `${keys.nodeId}:1`, origin: keys.nodeId, seq: 1, ts: 1000,
    author: { handle: 'alex', node: keys.nodeId }, kind: 'team.create', body: { name: 'golive-g', owner_login: 'direct:alex',
      owner_handle: 'alex', node_hostname: 'fixture', node_pubkey: keys.pubkey, node_ip: '127.0.0.1' } });
  const clock = { now: 1_800_000_000_000 };
  const core = {
    paths: { home }, teamId: team, keys, clock: () => clock.now, isAuthority: () => true,
    me: () => ({ handle: 'alex', role: 'owner' }), myHandle: () => 'alex',
    roster: { license: null, channels: new Set(['general']), nodes: new Map() },
    store: { teamCreate: () => genesis, queryEvents: () => [], getMeta: () => null, setMeta: () => {} }, rosterEntries: () => [],
  } as unknown as Core;
  const calls: string[] = [];
  const site = new ComputeSite({ base: 'https://fixture.test', fetch: async (url) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path.endsWith('/state')) return Response.json({ account_id: ACCOUNT, team_id: team, status: 'active',
      balance_micros: 0, burn_per_hour_micros: 0, hours_left: null, rentals: [] });
    if (path.endsWith('/handover')) return Response.json({ error: 'handover_not_found' }, { status: 404 });
    return reply(path);
  } });
  saveAccounts(home, [{ account_id: ACCOUNT, token: 'T'.repeat(43), team }]);
  const warn: { event: string; fields: Record<string, unknown> }[] = [];
  const log = { info: () => {}, warn: (event: string, fields: Record<string, unknown>) => { warn.push({ event, fields }); } } as unknown as Logger;
  const service = new ComputeService({ core, log, transport: () => undefined } as ComputeDeps, { site, random: () => 0 });
  /** A pending rent with a real code minted now, for RENTAL_CODE_TTL_MS, as rent() mints it. */
  const pending = (key: string) => ({ account_id: ACCOUNT, invite_ids: ['a'.repeat(32)], body: { idempotency_key: key,
    machines: [{ tier: 'agent' as const, count: 1 }], walkie_version: 'v0.2.0-pre.16',
    codes: [createInvite(keys, { team, authority: keys.pubkey, handle: 'alex', role: 'member', now: clock.now, pos: 1, ttlMs: RENTAL_CODE_TTL_MS }).code] } });
  return { service, home, clock, calls, warn, pending };
}
const rentCalls = (calls: readonly string[]) => calls.filter(p => p.endsWith('/rent')).length;

test('PROBE H: invalid_rental_invite (then 429) drops the pending rent at once: 120 rounds do not make 120 rent calls', async () => {
  let rents = 0;
  const f = fixture(() => {
    rents++;
    return rents <= 30 ? Response.json({ error: 'invalid_rental_invite' }, { status: 400 }) : Response.json({ error: 'rate_limited' }, { status: 429 });
  });
  savePending(f.home, [f.pending('k'.repeat(20))]);
  for (let i = 0; i < 120; i++) { await f.service.pollOnce(); f.clock.now += 60_000; }
  expect(rentCalls(f.calls)).toBe(1);
  expect(loadPending(f.home)).toEqual([]);
  expect(f.warn.filter(w => w.event === 'compute_rent_dropped').map(w => w.fields.reason)).toEqual(['invalid_rental_invite']);
});

test('a pending rent answered 503 through a long drain is replayed until its codes are 10 minutes past expiry, once more, then dropped', async () => {
  const f = fixture(() => Response.json({ error: 'compute_not_configured' }, { status: 503 }));
  savePending(f.home, [f.pending('k'.repeat(20))]);
  const limit = (RENTAL_CODE_TTL_MS + 10 * 60_000) / 60_000;
  for (let i = 0; i < 120; i++) { await f.service.pollOnce(); f.clock.now += 60_000; }
  // Rounds at minutes 0..limit replay (the codes are not yet 10 minutes past expiry), then exactly one final replay.
  expect(rentCalls(f.calls)).toBe(limit + 2);
  expect(loadPending(f.home)).toEqual([]);
  expect(f.warn.filter(w => w.event === 'compute_rent_dropped').map(w => w.fields.reason)).toEqual(['codes_expired']);
});

test('the final replay still recovers a rent the site recorded (a lost answer), and records it', async () => {
  let rents = 0;
  const f = fixture(() => {
    rents++;
    if (rents === 1) return Response.json({ error: 'compute_not_configured' }, { status: 503 });
    return Response.json({ rentals: [], started: 0, queued: 0, code_index: {}, balance_micros: 0, replay: true });
  });
  savePending(f.home, [f.pending('k'.repeat(20))]);
  await f.service.pollOnce();
  expect(loadPending(f.home)).toHaveLength(1);
  f.clock.now += RENTAL_CODE_TTL_MS + 11 * 60_000;
  await f.service.pollOnce();
  expect(rents).toBe(2);
  expect(loadPending(f.home)).toEqual([]);
  expect(f.warn.filter(w => w.event === 'compute_rent_dropped')).toEqual([]);
});
