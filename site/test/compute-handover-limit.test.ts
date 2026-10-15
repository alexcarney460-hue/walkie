// Lane D round 3 (lanes/REVIEW-pre17-codex.md P2-5): the handover status limiter is fair between teams and owners behind
// one IP. A signed status request is charged to its owner (team + verified owner key); a coarse per-IP ceiling, charged
// before any signature check, bounds unauthenticated floods without letting one noisy owner refuse the others.
import { expect, test } from 'bun:test';
import * as C from './rent6-fixtures.ts';
import { statusMessage } from '../api/_lib/compute/handover.ts';
import { HANDOVER_STATUS_PER_IP_HOUR, HANDOVER_STATUS_PER_OWNER_HOUR, makeHandover } from '../api/compute/handover.ts';

const HOUR = 3_600_000;

function setup() {
  const w = C.world();
  const handler = makeHandover({ env: {}, compute: () => w.d, stripe: () => null } as any);
  const status = (keys: any, team: string, ip = '198.51.100.7', signature?: string) => handler(new Request('https://site.test/api/compute/handover', {
    method: 'POST', headers: { 'x-real-ip': ip }, body: JSON.stringify({ team_id: team, action: 'status',
      proof: { key: keys.pubkey, expires_at: w.clock.now + 240_000, roster: {},
        signature: signature ?? keys.sign(statusMessage(team, w.clock.now + 240_000)) } }) })).then(r => r.status);
  return { w, status };
}

test('each owner behind one IP has its own status allowance: one at its limit does not refuse another team or owner', async () => {
  const { status } = setup();
  const a = C.mkTeam('limit-a'), b = C.mkTeam('limit-b'), second = C.generateKeys();
  expect(HANDOVER_STATUS_PER_OWNER_HOUR).toBeGreaterThanOrEqual(12); // a daemon checks at most every 10 minutes
  for (let i = 0; i < HANDOVER_STATUS_PER_OWNER_HOUR; i++) expect(await status(a.f, a.team)).toBe(404);
  expect(await status(a.f, a.team)).toBe(429);
  expect(await status(b.f, b.team)).toBe(404); // another team on the same IP
  expect(await status(second, a.team)).toBe(404); // another owner of the same team
});

test('unsigned or forged status requests are charged to the IP only, never to the owner whose key they name', async () => {
  const { status } = setup();
  const a = C.mkTeam('limit-forged');
  for (let i = 0; i < 50; i++) expect(await status(a.f, a.team, '198.51.100.7', 'A'.repeat(86) + '==')).toBe(403);
  for (let i = 0; i < HANDOVER_STATUS_PER_OWNER_HOUR; i++) expect(await status(a.f, a.team)).toBe(404);
});

test('the per-IP ceiling bounds a flood from one address and resets each hour; other addresses are unaffected', async () => {
  const { w, status } = setup();
  const a = C.mkTeam('limit-flood'), b = C.mkTeam('limit-other');
  for (let i = 0; i < HANDOVER_STATUS_PER_IP_HOUR; i++) expect(await status(C.generateKeys(), a.team, '203.0.113.5')).not.toBe(429);
  expect(await status(b.f, b.team, '203.0.113.5')).toBe(429);
  expect(await status(b.f, b.team, '203.0.113.6')).toBe(404);
  w.clock.now += HOUR;
  expect(await status(b.f, b.team, '203.0.113.5')).toBe(404);
});
