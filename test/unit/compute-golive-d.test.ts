// Go-live lane D, daemon side (REVIEW-opus.md P2-6 and P3-16, REVIEW-codex.md P2-5): an owner daemon with no compute
// account must not call the site every minute, and an owner on a machine that is not the roster authority (where no
// compute account can be made) is told so instead of being offered an action that fails.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ComputeService, type ComputeDeps } from '../../src/daemon/compute/service.ts';
import { ComputeSite } from '../../src/daemon/compute/site.ts';
import { loadPending, saveAccounts, savePending } from '../../src/daemon/compute/files.ts';
import { quotesText } from '../../src/cli/commands/compute.ts';
import type { Quotes } from '../../src/protocol/compute.ts';
import { generateKeys, signEvent } from '../../src/daemon/keys.ts';
import { deriveTeamId } from '../../src/protocol/ids.ts';
import { PROTOCOL_VERSION } from '../../src/protocol/schemas.ts';
import { HttpError } from '../../src/daemon/http.ts';
import type { Core } from '../../src/daemon/core.ts';
import type { Logger } from '../../src/daemon/logger.ts';

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

function fixture(opts: { authority?: boolean; account?: boolean; reply?: (path: string) => Response } = {}) {
  const home = mkdtempSync(join(process.cwd(), '.rentops-golive-d-'));
  homes.push(home);
  const keys = generateKeys(), team = deriveTeamId(keys.pubkey, 'golive', 1000);
  const genesis = signEvent(keys, { v: PROTOCOL_VERSION, team, id: `${keys.nodeId}:1`, origin: keys.nodeId, seq: 1, ts: 1000,
    author: { handle: 'alex', node: keys.nodeId }, kind: 'team.create', body: { name: 'golive', owner_login: 'direct:alex',
      owner_handle: 'alex', node_hostname: 'fixture', node_pubkey: keys.pubkey, node_ip: '127.0.0.1' } });
  const clock = { now: 1_000_000 };
  const core = {
    paths: { home }, teamId: team, keys, clock: () => clock.now, isAuthority: () => opts.authority ?? true,
    me: () => ({ handle: 'alex', role: 'owner' }), myHandle: () => 'alex',
    roster: { license: null, channels: new Set(['general']), nodes: new Map() },
    store: { teamCreate: () => genesis, queryEvents: () => [], getMeta: () => null, setMeta: () => {} }, rosterEntries: () => [],
  } as unknown as Core;
  const calls: string[] = [];
  const site = new ComputeSite({ base: 'https://fixture.test', fetch: async (url, init) => {
    const path = new URL(String(url)).pathname;
    const action = /"action":"([a-z_]+)"/.exec(String(init?.body ?? ''))?.[1];
    calls.push(action ? `${path} ${action}` : path);
    if (opts.reply) return opts.reply(path);
    if (path.endsWith('/handover')) return Response.json({ error: 'handover_not_found' }, { status: 404 });
    if (path.endsWith('/state')) return Response.json({ account_id: 'ca_0123456789abcdef', team_id: team, status: 'active',
      balance_micros: 0, burn_per_hour_micros: 0, hours_left: null, rentals: [] });
    return Response.json({ error: 'unexpected' }, { status: 500 });
  } });
  if (opts.account) saveAccounts(home, [{ account_id: 'ca_0123456789abcdef', token: 'T'.repeat(43), team }]);
  const warn: string[] = [];
  const log = { info: () => {}, warn: (event: string) => { warn.push(event); } } as unknown as Logger;
  const service = new ComputeService({ core, log, transport: () => undefined } as ComputeDeps, { site, random: () => 0 });
  return { service, calls, clock, warn };
}

test('an owner daemon with no compute account and no handover in view makes no site call, however long it runs (PROBE-7, round 3)', async () => {
  const f = fixture();
  for (let i = 0; i < 8; i++) { await f.service.pollOnce(); f.clock.now += 60_000; }
  f.clock.now += 6 * 60 * 60_000;
  await f.service.pollOnce();
  expect(f.calls).toEqual([]);
});

test('with a compute account and no handover pending, the daemon polls state only (no roster proof sent)', async () => {
  const f = fixture({ account: true });
  await f.service.pollOnce();
  f.clock.now += 60_000;
  await f.service.pollOnce();
  expect(f.calls.filter((c) => c === '/api/compute/handover status')).toHaveLength(0);
  expect(f.calls.filter((c) => c === '/api/compute/state')).toHaveLength(2);
});

test('state on an owner machine that is not the roster authority says renting needs the authority', async () => {
  const away = fixture({ authority: false });
  expect(await away.service.state()).toMatchObject({ account_id: null, status: 'none', authority_required: true });
  const home = fixture({ authority: true });
  const s = await home.service.state();
  expect(s).toMatchObject({ account_id: null, status: 'none' });
  expect('authority_required' in s).toBe(false);
  expect(away.calls).toEqual([]);
});

test('site refusals for an off-sale tier or an unknown release read as plain sentences', async () => {
  for (const [code, status, words] of [['tier_unavailable', 409, /isn't offered right now/], ['unsupported_walkie_version', 400, /walkie update/]] as const) {
    const f = fixture({ reply: () => Response.json({ error: code }, { status }) });
    const err = await f.service.quotes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect({ code: (err as HttpError).code, status: (err as HttpError).status }).toEqual({ code, status });
    expect((err as HttpError).message).toMatch(words);
  }
});

// Integration (lanes/C-FINAL.md round 14 open item): the dashboard shows the daemon's message, so the site's retryable
// licence refusals read as plain sentences there too, not 'the Sqwakie site refused: <code>'.
test('retryable licence refusals and an overflowed team read as plain sentences in the daemon', async () => {
  for (const [code, status, words] of [
    ['licence_record_pruning', 503, /temporary: run the command again/],
    ['licence_backfill_pending', 503, /temporary: run the command again later/],
    ['license_verification_unavailable', 503, /temporary: run the command again in a minute/],
    ['compute_state_unavailable', 503, /temporary: run the command again in a minute/],
    ['licence_bindings_overflow', 503, /contact Sqwakie support/],
  ] as const) {
    const f = fixture({ reply: () => Response.json({ error: code }, { status }) });
    const err = await f.service.quotes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe(code);
    expect((err as HttpError).message).toMatch(words);
  }
});

// Round 2 (lanes/REVIEW-D-opus.md P3-7, P3-6).
const pendingRent = (key: string) => ({ account_id: 'ca_0123456789abcdef', invite_ids: ['a'.repeat(32)],
  body: { idempotency_key: key, machines: [{ tier: 'gpu-20' as const, count: 1 }], codes: ['wk1' + 'c'.repeat(40)], walkie_version: 'v0.2.0-pre.15' } });

for (const [code, status] of [['tier_unavailable', 409], ['unsupported_walkie_version', 400]] as const) {
  test(`a pending rent the site refuses for good (${code}) is dropped with one warning, not resent every round`, async () => {
    let rents = 0;
    const f = fixture({ account: true, reply: (path) => {
      if (path.endsWith('/rent')) { rents++; return Response.json({ error: code }, { status }); }
      if (path.endsWith('/state')) return Response.json({ account_id: 'ca_0123456789abcdef', team_id: '0123456789abcdef', status: 'active',
        balance_micros: 0, burn_per_hour_micros: 0, hours_left: null, rentals: [] });
      return Response.json({ error: 'handover_not_found' }, { status: 404 });
    } });
    const home = (f.service as unknown as { home: string }).home;
    savePending(home, [pendingRent('k'.repeat(20)), pendingRent('j'.repeat(20))]);
    await f.service.pollOnce();
    expect(rents).toBe(2);
    expect(loadPending(home)).toEqual([]);
    expect(f.warn.filter((e) => e === 'compute_rent_dropped')).toHaveLength(2);
    expect(f.warn).not.toContain('compute_recovery_pending');
    f.clock.now += 60_000;
    await f.service.pollOnce();
    expect(rents).toBe(2);
  });
}

test('a pending rent that fails for another reason is kept and tried again (a lost answer must be recovered)', async () => {
  let rents = 0;
  const f = fixture({ account: true, reply: (path) => {
    if (path.endsWith('/rent')) { rents++; return Response.json({ error: 'compute_error' }, { status: 500 }); }
    if (path.endsWith('/state')) return Response.json({ account_id: 'ca_0123456789abcdef', team_id: '0123456789abcdef', status: 'active',
      balance_micros: 0, burn_per_hour_micros: 0, hours_left: null, rentals: [] });
    return Response.json({ error: 'handover_not_found' }, { status: 404 });
  } });
  const home = (f.service as unknown as { home: string }).home;
  savePending(home, [pendingRent('k'.repeat(20))]);
  await f.service.pollOnce();
  await f.service.pollOnce();
  expect(rents).toBe(2);
  expect(loadPending(home)).toHaveLength(1);
  expect(f.warn).toContain('compute_recovery_pending');
});

const TIER = (id: 'agent' | 'agent-xl' | 'gpu-20', gpu: string | null) => ({ id, name: id, specs: 's', gpu, good_for: '', price_per_hour_micros: 750_000,
  price_per_month_micros: 547_500_000, min_minutes: gpu ? 5 : 1 });
const quotesOf = (tiers: ReturnType<typeof TIER>[], available = true): Quotes => ({ available, currency: 'usd', tiers, credit_blocks: [50, 200, 1000],
  min_hours_covered: 1, egress_included_gib: 1024, egress_price_per_gib_micros: 20_000 });

test('the CLI quotes footer suggests a tier that is on sale, never an off-sale GPU tier', () => {
  const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');
  const cpu = plain(quotesText(quotesOf([TIER('agent', null), TIER('agent-xl', null)])));
  expect(cpu).toContain('Rent: walkie compute rent agent=2');
  expect(cpu).not.toContain('gpu-20');
  expect(plain(quotesText(quotesOf([TIER('gpu-20', 'L4')])))).toContain('Rent: walkie compute rent gpu-20');
  expect(plain(quotesText(quotesOf([])))).toContain('No machines are for rent right now.');
  const off = plain(quotesText(quotesOf([TIER('agent', null)], false)));
  expect(off).toContain('Renting is not available right now.');
  expect(off).not.toContain('Rent: walkie compute rent');
});
