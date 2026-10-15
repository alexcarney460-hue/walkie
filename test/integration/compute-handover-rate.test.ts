// Lane D round 3 (lanes/REVIEW-pre17-codex.md P2-5, REVIEW-pre17-opus.md P3-4): several owner daemons behind one IP,
// each with a handover expected (so each keeps checking), run their real polling schedules against the REAL site
// handler and its limiter (makeHandover over MemoryStore, one shared clock) for three simulated hours: none is ever
// refused. A noisy client on the same IP asking every minute is refused on its own allowance, not the daemons'.
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ComputeService, HANDOVER_CHECK_MS, type ComputeDeps } from '../../src/daemon/compute/service.ts';
import { ComputeSite } from '../../src/daemon/compute/site.ts';
import { saveAccounts } from '../../src/daemon/compute/files.ts';
import { generateKeys, signEvent } from '../../src/daemon/keys.ts';
import { deriveTeamId } from '../../src/protocol/ids.ts';
import { PROTOCOL_VERSION } from '../../src/protocol/schemas.ts';
import { makeHandover } from '../../site/api/compute/handover.ts';
import { statusMessage } from '../../site/api/_lib/compute/handover.ts';
import { world } from '../../site/test/compute-helpers.ts';
import type { Core } from '../../src/daemon/core.ts';
import type { Logger } from '../../src/daemon/logger.ts';

const MIN = 60_000, HOUR = 60 * MIN, IP = '198.51.100.20';
const homes: string[] = [];
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

const w = world();
const handler = makeHandover({ env: {}, compute: () => w.d, stripe: () => null });
const answers: { who: string; status: number }[] = [];
const viaSite = (who: string) => new ComputeSite({ base: 'https://sqwakie.test', fetch: async (url, init) => {
  const res = await handler(new Request(String(url), { ...init, headers: { ...(init?.headers as Record<string, string>), 'x-real-ip': IP } }));
  answers.push({ who, status: res.status });
  return res;
} });

/** An owner daemon whose account handover is pending (it proposed one), so it checks status on its schedule. */
function daemon(teamName: string, owner: string, seed: number) {
  const home = mkdtempSync(join(process.cwd(), '.rentops-handover-rate-'));
  homes.push(home);
  const keys = generateKeys(), team = deriveTeamId(keys.pubkey, teamName, 1000);
  const genesis = signEvent(keys, { v: PROTOCOL_VERSION, team, id: `${keys.nodeId}:1`, origin: keys.nodeId, seq: 1, ts: 1000,
    author: { handle: owner, node: keys.nodeId }, kind: 'team.create', body: { name: teamName, owner_login: `direct:${owner}`,
      owner_handle: owner, node_hostname: owner, node_pubkey: keys.pubkey, node_ip: '127.0.0.1' } });
  const core = {
    paths: { home }, teamId: team, nodeId: keys.nodeId, keys, clock: () => w.clock.now, isAuthority: () => true,
    me: () => ({ handle: owner, role: 'owner' }), myHandle: () => owner,
    roster: { license: null, channels: new Set(['general']), nodes: new Map(), members: new Map() },
    store: { teamCreate: () => genesis, queryEvents: () => [], getMeta: () => null, setMeta: () => {}, peerNotice: () => null },
    rosterEntries: () => [], emit: () => ({}), log: { warn: () => {}, info: () => {} },
  } as unknown as Core;
  saveAccounts(home, [{ account_id: 'ca_0123456789abcdef', token: 'T'.repeat(43), team, handover_pending_until: w.clock.now + 24 * HOUR }]);
  let n = seed;
  const random = () => { n = (n * 9301 + 49297) % 233280; return n / 233280; };
  const warnings: string[] = [];
  const service = new ComputeService({ core, transport: () => undefined,
    log: { info: () => {}, warn: (e: string) => { warnings.push(e); } } as unknown as Logger } as ComputeDeps,
    { site: viaSite(`${teamName}/${owner}`), random });
  return { service, warnings, keys, team };
}

test('six owner daemons of three teams behind one IP, three hours of real schedules: no 429; a noisy client is refused alone', async () => {
  const daemons = ['harbor', 'quarry', 'meadow'].flatMap((t, i) => [daemon(t, 'ada', 7 + i), daemon(t, 'ben', 101 + i)]);
  const noisy = daemon('noisy', 'nia', 3);
  for (let minute = 0; minute < 3 * 60; minute++) {
    for (const d of daemons) await d.service.pollOnce();
    // Every minute, the noisy client signs and sends its own status request (an older daemon's schedule).
    const expires = w.clock.now + 240_000;
    await viaSite('noisy/nia').handoverStatus(noisy.team, { key: noisy.keys.pubkey, expires_at: expires, roster: {},
      signature: noisy.keys.sign(statusMessage(noisy.team, expires)) }).catch(() => undefined);
    w.clock.now += MIN;
  }
  const fromDaemons = answers.filter((a) => a.who !== 'noisy/nia');
  // At least one check per daemon per HANDOVER_CHECK_MS window (+ jitter), and every one of them answered (404: none pending).
  expect(fromDaemons.length).toBeGreaterThanOrEqual(daemons.length * Math.floor((3 * HOUR) / (HANDOVER_CHECK_MS + MIN)));
  expect(fromDaemons.filter((a) => a.status === 429)).toEqual([]);
  expect(new Set(fromDaemons.map((a) => a.status))).toEqual(new Set([404]));
  for (const d of daemons) expect(d.warnings).not.toContain('compute_handover_status_failed');
  const noisyAnswers = answers.filter((a) => a.who === 'noisy/nia');
  expect(noisyAnswers.filter((a) => a.status === 429).length).toBeGreaterThan(0);
});
