// Lane D round 3 (lanes/REVIEW-pre17-codex.md P1 and P2-5; REVIEW-pre17-opus.md P3-4): the daemon's handover status
// request carries the team's roster proof (genesis and owner admissions: identities, node hostnames, addresses and keys),
// so it is sent only while a handover notice is expected for this team, never just because the daemon runs; while one is
// expected it is sent at once and then at most every HANDOVER_CHECK_MS, and its failures (429 included) back off on
// their own.
import { afterEach, expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ComputeService, HANDOVER_CHECK_MS, HANDOVER_NOTICE_WINDOW_MS, type ComputeDeps } from '../../src/daemon/compute/service.ts';
import { ComputeSite } from '../../src/daemon/compute/site.ts';
import { saveAccounts } from '../../src/daemon/compute/files.ts';
import { handoverNoticeText, type HandoverNotice } from '../../src/daemon/compute/handover-notice.ts';
import { ADMIN_AGENT } from '../../src/daemon/admin/audit.ts';
import { generateKeys, signEvent } from '../../src/daemon/keys.ts';
import { deriveTeamId } from '../../src/protocol/ids.ts';
import { PROTOCOL_VERSION } from '../../src/protocol/schemas.ts';
import type { Core } from '../../src/daemon/core.ts';
import type { EventRow, EventFilter } from '../../src/daemon/store.ts';
import type { Logger } from '../../src/daemon/logger.ts';

const MIN = 60_000, HOUR = 60 * MIN;
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

const vendor = generateKeyPairSync('ed25519');
const VENDOR_PUB = (vendor.publicKey.export({ format: 'jwk' }) as { x: string }).x.replace(/-/g, '+').replace(/_/g, '/') + '=';
const CHAIN = 'c'.repeat(64);
function notice(team: string, over: Partial<HandoverNotice> = {}): { value: string; n: HandoverNotice } {
  const n: HandoverNotice = { v: 1, team, proposed_by: 'P'.repeat(43) + '=', old_chain: 'a'.repeat(64), proposed_chain: CHAIN,
    accounts: ['ca_0123456789abcdef'], proposed_at: 1_000, completes_at: null, objected: false, ...over };
  const payload = Buffer.from(JSON.stringify(n)).toString('base64url');
  return { value: `${payload}.${sign(null, Buffer.from(payload), vendor.privateKey).toString('base64url')}`, n };
}

interface Opts {
  account?: boolean;
  pendingUntil?: number;
  /** What the state poll carries (account holders). */
  stateNotice?: boolean;
  /** #general admin posts this daemon has received. */
  posts?: { origin: string; text: string; ts: number }[];
  /** The site's handover answer, per action ('status', 'ack'). */
  status?: (action: string) => Response;
  /** Another owner's daemon posted the notice text this machine received (what an acknowledgement cites). */
  peerNotice?: boolean;
}

function fixture(opts: Opts = {}) {
  const home = mkdtempSync(join(process.cwd(), '.rentops-handover-poll-'));
  homes.push(home);
  const keys = generateKeys(), team = deriveTeamId(keys.pubkey, 'poll', 1000);
  const genesis = signEvent(keys, { v: PROTOCOL_VERSION, team, id: `${keys.nodeId}:1`, origin: keys.nodeId, seq: 1, ts: 1000,
    author: { handle: 'alex', node: keys.nodeId }, kind: 'team.create', body: { name: 'poll', owner_login: 'direct:alex',
      owner_handle: 'alex', node_hostname: 'fixture', node_pubkey: keys.pubkey, node_ip: '127.0.0.1' } });
  const clock = { now: 10 * HOUR };
  const members = new Map([
    ['direct:alex', { login: 'direct:alex', handle: 'alex', role: 'owner' }],
    ['direct:bea', { login: 'direct:bea', handle: 'bea', role: 'owner' }],
    ['direct:max', { login: 'direct:max', handle: 'max', role: 'member' }],
  ]);
  const nodes = new Map([
    [keys.nodeId, { node_id: keys.nodeId, login: 'direct:alex', revoked: false }],
    ['b0b0b0b0b0b0b0b0', { node_id: 'b0b0b0b0b0b0b0b0', login: 'direct:bea', revoked: false }],
    ['d0d0d0d0d0d0d0d0', { node_id: 'd0d0d0d0d0d0d0d0', login: 'direct:max', revoked: false }],
  ]);
  const meta = new Map<string, string>();
  const queries: EventFilter[] = [];
  const queryEvents = (f: EventFilter): EventRow[] => {
    queries.push(f);
    return (opts.posts ?? []).map((p) => (p.origin === 'SELF' ? { ...p, origin: keys.nodeId } : p))
      .filter((p) => f.since_ts === undefined || p.ts > f.since_ts).map((p, i) => ({
      id: `${p.origin}:${i + 2}`, origin: p.origin, seq: i + 2, ts: p.ts, kind: 'msg.post', channel: 'general', thread: null, sig: 's',
      redacted: 0, status: 'ok', json: JSON.stringify({ kind: 'msg.post', origin: p.origin, ts: p.ts, channel: 'general',
        author: { handle: 'x', node: p.origin, agent: ADMIN_AGENT }, body: { text: p.text } }) }));
  };
  const core = {
    paths: { home }, teamId: team, nodeId: keys.nodeId, keys, clock: () => clock.now, isAuthority: () => true,
    me: () => ({ handle: 'alex', role: 'owner' }), myHandle: () => 'alex',
    roster: { license: null, channels: new Set(['general']), nodes, members },
    store: { teamCreate: () => genesis, queryEvents, getMeta: (k: string) => meta.get(k) ?? null, setMeta: (k: string, v: string) => { meta.set(k, v); },
      peerNotice: (text: string) => opts.peerNotice ? { v: 1, team, id: 'b0b0b0b0b0b0b0b0:9', origin: 'b0b0b0b0b0b0b0b0', seq: 9,
        ts: clock.now, kind: 'msg.post', channel: 'general', author: { handle: 'bea', node: 'b0b0b0b0b0b0b0b0', agent: ADMIN_AGENT },
        body: { text }, sig: 's' } : null },
    rosterEntries: () => [], emit: () => ({}), log: { warn: () => {}, info: () => {} },
  } as unknown as Core;
  const calls: string[] = [];
  const site = new ComputeSite({ base: 'https://fixture.test', fetch: async (url, init) => {
    const path = new URL(String(url)).pathname;
    const action = /"action":"([a-z_]+)"/.exec(String(init?.body ?? ''))?.[1];
    calls.push(action ? `handover ${action}` : path.replace('/api/compute/', ''));
    if (path.endsWith('/handover')) return opts.status?.(action ?? '') ?? Response.json({ error: 'handover_not_found' }, { status: 404 });
    if (path.endsWith('/state')) return Response.json({ account_id: 'ca_0123456789abcdef', team_id: team, status: 'active',
      balance_micros: 0, burn_per_hour_micros: 0, hours_left: null, rentals: [],
      ...(opts.stateNotice ? { handover_notice: notice(team).value } : {}) });
    return Response.json({ error: 'unexpected' }, { status: 500 });
  } });
  if (opts.account || opts.pendingUntil) saveAccounts(home, [{ account_id: 'ca_0123456789abcdef', token: 'T'.repeat(43), team,
    ...(opts.pendingUntil ? { handover_pending_until: opts.pendingUntil } : {}) }]);
  const warn: string[] = [];
  const log = { info: () => {}, warn: (event: string) => { warn.push(event); } } as unknown as Logger;
  const service = new ComputeService({ core, log, transport: () => undefined } as ComputeDeps,
    { site, random: () => 0, noticePublicKey: VENDOR_PUB });
  /** Runs one poll round per simulated minute for `minutes`, returning the minutes at which a status request went out. */
  const run = async (minutes: number): Promise<number[]> => {
    const at: number[] = [];
    for (let m = 0; m < minutes; m++) {
      const before = calls.filter((c) => c === 'handover status').length;
      await service.pollOnce();
      if (calls.filter((c) => c === 'handover status').length > before) at.push(m);
      clock.now += MIN;
    }
    return at;
  };
  return { service, calls, clock, warn, team, queries, meta, run };
}
const statusCalls = (calls: string[]) => calls.filter((c) => c === 'handover status').length;

test('a pre.17 owner daemon on a team that never used compute makes no site call: at start and over six hours', async () => {
  const f = fixture();
  expect(await f.run(6 * 60)).toEqual([]);
  expect(f.calls).toEqual([]);
});

test('an owner holding a compute account with no handover pending sends no team proof; its state poll (token only) continues', async () => {
  const f = fixture({ account: true });
  expect(await f.run(3 * 60)).toEqual([]);
  expect(f.calls.filter((c) => c === 'state')).toHaveLength(3 * 60);
});

test('a notice in the state poll: status at once (next round), then at most every 10 minutes, within 12 an hour', async () => {
  const f = fixture({ account: true, stateNotice: true, status: () => Response.json({ chain_id: CHAIN, accounts: [], completes_at: null,
    expires_at: 0, objected: false, notice: null }) });
  const at = await f.run(2 * 60);
  expect(at[0]).toBe(1);
  for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(HANDOVER_CHECK_MS / MIN);
  expect(at.length).toBeLessThanOrEqual(2 * 6 + 1);
  expect(HANDOVER_CHECK_MS).toBeGreaterThanOrEqual(10 * MIN);
});

test('status failures (429 included) back off on their own, while the state poll keeps running', async () => {
  const f = fixture({ account: true, stateNotice: true, status: () => Response.json({ error: 'rate_limited' }, { status: 429 }) });
  const at = await f.run(4 * 60);
  expect(at).toEqual([1, 21, 61, 141]);
  expect(f.warn.filter((w) => w === 'compute_handover_status_failed')).toHaveLength(4);
  expect(f.calls.filter((c) => c === 'state')).toHaveLength(4 * 60);
});

test('a proposer whose account handover is pending checks at once, then every 10 minutes until it completes', async () => {
  const f = fixture({ pendingUntil: 10 * HOUR + 40 * MIN, status: () => Response.json({ chain_id: CHAIN, accounts: [], completes_at: null,
    expires_at: 0, objected: false, notice: null }) });
  const at = await f.run(60);
  expect(at.slice(0, 3)).toEqual([0, 10, 20]);
  expect(at.every((m) => m < 40)).toBe(true);
});

test('no account: another current owner\'s posted notice triggers one status at once; handover_not_found settles it for good', async () => {
  const text = handoverNoticeText(notice('0'.repeat(16)).n);
  const f = fixture({ posts: [{ origin: 'b0b0b0b0b0b0b0b0', text, ts: 10 * HOUR - HOUR }] });
  expect(await f.run(3 * 60)).toEqual([0]);
  expect(f.meta.get(`compute-handover-settled:${CHAIN}`)).toBe('1');
  expect(f.queries.every((q) => q.channel === 'general' && q.agents?.includes(ADMIN_AGENT))).toBe(true);
});

test('no account: posts that do not show an expected handover send nothing', async () => {
  const text = handoverNoticeText(notice('0'.repeat(16)).n);
  const cases = [
    [{ origin: 'd0d0d0d0d0d0d0d0', text, ts: 10 * HOUR - MIN }], // a member, not an owner
    [{ origin: 'e0e0e0e0e0e0e0e0', text, ts: 10 * HOUR - MIN }], // a node not on the roster
    [{ origin: 'b0b0b0b0b0b0b0b0', text: 'Compute handover pending: nothing to see', ts: 10 * HOUR - MIN }], // not the notice shape
    [{ origin: 'b0b0b0b0b0b0b0b0', text, ts: 10 * HOUR - HANDOVER_NOTICE_WINDOW_MS - MIN }], // older than the window
  ];
  for (const posts of cases) {
    const f = fixture({ posts });
    expect(await f.run(30)).toEqual([]);
  }
  const mine = fixture({ posts: [{ origin: 'SELF', text, ts: 10 * HOUR - MIN }] }); // this machine's own post
  expect(await mine.run(30)).toEqual([]);
});

// Round 4 (lanes/REVIEW-pre17b-opus.md P3): once this owner has acknowledged the handover, or the site has said there is
// nothing for it to act on, it stops asking: no further status call for hours, though the notice is still in view.
const pendingAnswer = (team: string) => (action: string) => action === 'ack' ? Response.json({ acknowledged: true })
  : Response.json({ chain_id: CHAIN, accounts: ['ca_0123456789abcdef'], completes_at: null, expires_at: 0, objected: false,
    notice: notice(team).value });

test('after acknowledging a posted notice (no account here), no further status call over six hours', async () => {
  const team = { id: '' };
  const f = fixture({ peerNotice: true, posts: [{ origin: 'b0b0b0b0b0b0b0b0', text: handoverNoticeText(notice('0'.repeat(16)).n), ts: 10 * HOUR - MIN }],
    status: (action) => pendingAnswer(team.id)(action) });
  team.id = f.team;
  expect(await f.run(6 * 60)).toEqual([0]);
  expect(f.calls).toEqual(['handover status', 'handover ack']);
  expect(f.meta.get(`compute-handover-settled:${CHAIN}`)).toBe('1');
});

test('after acknowledging a notice its state poll carries (account holder), only state polls follow over six hours', async () => {
  const team = { id: '' };
  const f = fixture({ account: true, stateNotice: true, peerNotice: true, status: (action) => pendingAnswer(team.id)(action) });
  team.id = f.team;
  expect(await f.run(6 * 60)).toEqual([1]);
  expect(f.calls.filter((c) => c.startsWith('handover'))).toEqual(['handover status', 'handover ack']);
  expect(f.calls.filter((c) => c === 'state')).toHaveLength(6 * 60);
});

test('handover_not_found for a notice its state poll carries settles it too: no further status call over six hours', async () => {
  const f = fixture({ account: true, stateNotice: true });
  expect(await f.run(6 * 60)).toEqual([1]);
  expect(f.meta.get(`compute-handover-settled:${CHAIN}`)).toBe('1');
});
