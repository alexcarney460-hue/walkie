// Lane H (Alex 2026-10-09: prepaid compute credit is non-refundable and expires 60 days after purchase), daemon side:
// the contract carries each credit lot (remaining, purchase and expiry, a 7-day flag) and the soonest expiry; the
// owner daemon merges them across its accounts; `walkie compute credit` lists them with the soonest expiry and flags a
// lot that expires within 7 days; the quotes footer and the stop message state the terms.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  ComputeState, CREDIT_LIFETIME_DAYS, expiryText, MAX_CREDIT_LOTS, type ComputeState as State,
} from '../../src/protocol/compute.ts';
import { compute, creditText, listText, quotesText } from '../../src/cli/commands/compute.ts';
import { ComputeService, messageFor, type ComputeDeps } from '../../src/daemon/compute/service.ts';
import { ComputeSite, ComputeSiteError } from '../../src/daemon/compute/site.ts';
import { saveAccounts } from '../../src/daemon/compute/files.ts';
import { generateKeys } from '../../src/daemon/keys.ts';
import { deriveTeamId } from '../../src/protocol/ids.ts';
import type { Core } from '../../src/daemon/core.ts';
import type { Logger } from '../../src/daemon/logger.ts';
import type { Ctx } from '../../src/cli/context.ts';
import { QUOTES, rental, state } from '../helpers/compute-fixtures.ts';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const lot = (remaining: number, expiresIn: number, purchased = 50_000_000) => ({ purchased_micros: purchased, remaining_micros: remaining,
  purchased_at: NOW + expiresIn - CREDIT_LIFETIME_DAYS * DAY, expires_at: NOW + expiresIn, expiring_soon: expiresIn <= 7 * DAY });

describe('the contract', () => {
  test('a state carries credit lots and the soonest expiry; a lot with an unknown field, or too many lots, is refused', () => {
    const lots = [lot(20_000_000, 3 * DAY), lot(200_000_000, 40 * DAY, 200_000_000)];
    expect(ComputeState.parse(state([rental()], { credit_lots: lots, next_expiry_at: NOW + 3 * DAY })).credit_lots).toEqual(lots);
    expect(ComputeState.safeParse(state([], { credit_lots: [{ ...lots[0]!, cost_micros: 1 } as never] })).success).toBe(false);
    expect(ComputeState.safeParse(state([], { credit_lots: Array.from({ length: MAX_CREDIT_LOTS + 1 }, () => lots[0]!) })).success).toBe(false);
    expect(CREDIT_LIFETIME_DAYS).toBe(60);
  });

  test('an expiry reads to the minute in UTC', () => {
    expect(expiryText(Date.UTC(2026, 11, 7, 14, 3, 59))).toBe('2026-12-07 14:03 UTC');
  });
});

describe('walkie compute', () => {
  test('credit lists each lot with what is left, of what, and its expiry; the soonest expiry; a lot within 7 days is flagged', () => {
    const s = state([rental()], { balance_micros: 220_000_000, credit_lots: [lot(20_000_000, 3 * DAY), lot(200_000_000, 40 * DAY, 200_000_000)],
      next_expiry_at: NOW + 3 * DAY });
    const text = creditText(s, NOW);
    expect(text).toContain('balance $220.00');
    expect(text).toContain(`$20.00 left of $50.00 · expires ${expiryText(NOW + 3 * DAY)} (in 3 days)`);
    expect(text).toContain(`$200.00 left of $200.00 · expires ${expiryText(NOW + 40 * DAY)}`);
    expect(text).not.toContain('(in 40 days)');
    expect(text).toContain(`soonest expiry ${expiryText(NOW + 3 * DAY)}`);
    expect(text).toContain('Credit is non-refundable and expires 60 days after purchase; the credit that expires soonest is used first.');
    // list points at it while something expires within a week.
    expect(listText(s, NOW)).toContain(`$20.00 of credit expires ${expiryText(NOW + 3 * DAY)} (in 3 days): walkie compute credit`);
    expect(listText(state([rental()], { credit_lots: [lot(200_000_000, 40 * DAY)] }), NOW)).not.toContain('of credit expires');
  });

  test('credit --json carries the lots; the quotes footer and the stop message state the terms', async () => {
    const s = state([rental()], { credit_lots: [lot(20_000_000, 3 * DAY)], next_expiry_at: NOW + 3 * DAY });
    const out: string[] = [];
    const ctx = { args: { pos: ['credit'], flags: new Map() }, json: true, forAgent: false, agentMarker: () => null,
      client: () => ({ computeState: async () => s }), out: (x: string) => out.push(x), err: (x: string) => out.push(x) } as unknown as Ctx;
    await compute(ctx);
    expect(JSON.parse(out[0]!)).toMatchObject({ credit_lots: s.credit_lots, next_expiry_at: NOW + 3 * DAY });
    expect(quotesText(QUOTES)).toContain('Credit is non-refundable and expires 60 days after purchase.');
    const stop: string[] = [];
    const stopCtx = { args: { pos: ['stop', 'all'], flags: new Map([['yes', true]]) }, json: false, forAgent: false,
      agentMarker: () => null, person: { interactive: () => true, ask: async () => 'yes', note: () => undefined },
      client: () => ({ computeStop: async () => ({ stopped: 1, rentals: [] }) }), out: (x: string) => stop.push(x),
      err: (x: string) => stop.push(x) } as unknown as Ctx;
    await compute(stopCtx);
    expect(stop.join('\n')).toContain('unused credit stays on the account until it expires');
  });
});

describe('the owner daemon', () => {
  const homes: string[] = [];
  afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

  test('merges the lots of every account, soonest first, with the soonest expiry and hours left that stop at expiry', async () => {
    const home = mkdtempSync(join(process.cwd(), '.rentops-expiry-'));
    homes.push(home);
    const keys = generateKeys(), team = deriveTeamId(keys.pubkey, 'expiry', 1000);
    const core = { paths: { home }, teamId: team, keys, clock: () => NOW, isAuthority: () => true,
      me: () => ({ handle: 'alex', role: 'owner' }), myHandle: () => 'alex',
      roster: { license: null, channels: new Set(['general']), nodes: new Map() },
      store: { queryEvents: () => [], getMeta: () => null, setMeta: () => {} }, rosterEntries: () => [] } as unknown as Core;
    const A = 'ca_000000000000000a', B = 'ca_000000000000000b';
    const states: Record<string, State> = {
      [`Bearer ${'A'.repeat(43)}`]: state([rental()], { account_id: A, team_id: team, balance_micros: 30_000_000, burn_per_hour_micros: 750_000,
        credit_lots: [lot(30_000_000, 20 * DAY)], next_expiry_at: NOW + 20 * DAY, hours_left: 40 }),
      [`Bearer ${'B'.repeat(43)}`]: state([], { account_id: B, team_id: team, balance_micros: 5_000_000, burn_per_hour_micros: 0,
        credit_lots: [lot(5_000_000, 2 * 3_600_000)], next_expiry_at: NOW + 2 * 3_600_000, hours_left: null }),
    };
    const site = new ComputeSite({ base: 'https://fixture.test', fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/state')) return Response.json(states[new Headers(init?.headers).get('authorization') ?? '']);
      return Response.json({ error: 'not_found' }, { status: 404 });
    } });
    saveAccounts(home, [{ account_id: A, token: 'A'.repeat(43), team }, { account_id: B, token: 'B'.repeat(43), team }]);
    const log = { info: () => {}, warn: () => {} } as unknown as Logger;
    const service = new ComputeService({ core, log, transport: () => undefined } as ComputeDeps, { site, random: () => 0 });
    const s = await service.state();
    if (s.account_id === null) throw new Error('expected an account');
    expect(s.balance_micros).toBe(35_000_000);
    expect(s.credit_lots!.map(l => l.expires_at)).toEqual([NOW + 2 * 3_600_000, NOW + 20 * DAY]);
    expect(s.next_expiry_at).toBe(NOW + 2 * 3_600_000);
    // Round 2: an account's credit pays only its own machines, so the team's figure is when the first burning account
    // runs out (A: the site's 40 h; B burns nothing), not a forecast over every account's lots merged.
    expect(s.hours_left).toBe(40);
    expect(s.accounts!.map(a => [a.account_id, a.next_expiry_at, a.credit_lots!.length])).toEqual([
      [A, NOW + 20 * DAY, 1], [B, NOW + 2 * 3_600_000, 1]]);
    expect(ComputeState.safeParse(s).success).toBe(true);
  });
});

// Round 2 (pre.17 reviews: Codex P3-8, Opus P3-1).
describe('round 2', () => {
  const homes: string[] = [];
  afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
  function daemon(states: Record<string, State>) {
    const home = mkdtempSync(join(process.cwd(), '.rentops-expiry-r2-'));
    homes.push(home);
    const keys = generateKeys(), team = deriveTeamId(keys.pubkey, 'expiry-r2', 1000);
    const core = { paths: { home }, teamId: team, keys, clock: () => NOW, isAuthority: () => true,
      me: () => ({ handle: 'alex', role: 'owner' }), myHandle: () => 'alex',
      roster: { license: null, channels: new Set(['general']), nodes: new Map() },
      store: { queryEvents: () => [], getMeta: () => null, setMeta: () => {} }, rosterEntries: () => [] } as unknown as Core;
    const site = new ComputeSite({ base: 'https://fixture.test', fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/state')) return Response.json({ ...states[new Headers(init?.headers).get('authorization') ?? '']!, team_id: team });
      return Response.json({ error: 'not_found' }, { status: 404 });
    } });
    saveAccounts(home, Object.keys(states).map((auth, i) => ({ account_id: states[auth]!.account_id, token: auth.slice(7), team })));
    const log = { info: () => {}, warn: () => {} } as unknown as Logger;
    return new ComputeService({ core, log, transport: () => undefined } as ComputeDeps, { site, random: () => 0 });
  }

  test('one account with 101 lots: the daemon keeps the site\'s forecast (1 h), not one over the 100 lots listed', async () => {
    const lots = Array.from({ length: MAX_CREDIT_LOTS }, () => lot(50_000_000, 3_600_000));
    const s = await daemon({ [`Bearer ${'A'.repeat(43)}`]: state([rental()], { account_id: 'ca_000000000000000a', balance_micros: 101 * 50_000_000,
      burn_per_hour_micros: 750_000, hours_left: 1, credit_lots: lots, next_expiry_at: NOW + 3_600_000 }) }).state();
    if (s.account_id === null) throw new Error('expected an account');
    expect(s.hours_left).toBe(1);
    expect(s.credit_lots).toHaveLength(MAX_CREDIT_LOTS);
  });

  test('several accounts: hours left is the soonest any burning account runs out', async () => {
    const s = await daemon({
      [`Bearer ${'A'.repeat(43)}`]: state([rental()], { account_id: 'ca_000000000000000a', burn_per_hour_micros: 750_000, hours_left: 12.5, credit_lots: [] }),
      [`Bearer ${'B'.repeat(43)}`]: state([rental({ id: 'r_00000000000000b1' })], { account_id: 'ca_000000000000000b', burn_per_hour_micros: 750_000,
        hours_left: 3.25, credit_lots: [] }),
      [`Bearer ${'C'.repeat(43)}`]: state([], { account_id: 'ca_000000000000000c', burn_per_hour_micros: 0, hours_left: null, credit_lots: [] }),
    }).state();
    if (s.account_id === null) throw new Error('expected an account');
    expect(s.hours_left).toBe(3.25);
  });

  test('a 402 naming credit that expires within the first hour: the detail crosses, and the message says why', async () => {
    const site = new ComputeSite({ base: 'https://fixture.test', fetch: async () => Response.json({ error: 'insufficient_credit',
      needed_micros: 750_000, balance_micros: 0, expiring_micros: 50_000_000 }, { status: 402 }) });
    const e = await site.state('t'.repeat(43)).catch((x: unknown) => x) as ComputeSiteError;
    expect(e.details).toEqual({ needed_micros: 750_000, balance_micros: 0, expiring_micros: 50_000_000 });
    expect(messageFor(e)).toContain('$50.00 of the credit expires within the hour, so it can\'t cover a machine\'s first hour');
    expect(messageFor(new ComputeSiteError(402, 'insufficient_credit', 'x', { needed_micros: 750_000, balance_micros: 0 })))
      .not.toContain('expires');
  });
});

// Round 3 (pre.17 review P2-1): a rent that waited too long for the site's locks is refused 503 compute_busy, retryable.
test('a 503 compute_busy reads as a retryable refusal', () => {
  // Round 4: answered 429 (nothing recorded, nothing pending), so the person's retry is the only send.
  const e = new ComputeSiteError(429, 'compute_busy', 'x', { retry_after_s: 5 });
  expect(messageFor(e)).toBe('the Sqwakie site is busy with this compute account; nothing was rented: try again in a few seconds');
});
