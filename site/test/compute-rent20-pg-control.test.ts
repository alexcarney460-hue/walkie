import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { PgStore } from '../api/_lib/compute/pg-store.ts';
import { finishHandover, handoverKey, rejectHandover, type PendingHandover } from '../api/_lib/compute/handover.ts';
import * as C from './rent6-fixtures.ts';

const port = 20_000 + Math.floor(Math.random() * 20_000);
let dir = '';
let sql: ReturnType<typeof postgres>;
let store: PgStore;

beforeAll(async () => {
  dir = mkdtempSync(join(import.meta.dir, '.rent20-pg-'));
  const data = join(dir, 'data');
  const init = spawnSync('/opt/homebrew/bin/initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'],
    { encoding: 'utf8' });
  if (init.status !== 0) throw Error(`local initdb failed: ${init.stderr}`);
  const start = spawnSync('/opt/homebrew/bin/pg_ctl', ['-D', data, '-l', join(dir, 'log'), '-w',
    '-o', `-p ${port} -c unix_socket_directories='' -c listen_addresses='127.0.0.1'`, 'start'],
  { encoding: 'utf8' });
  if (start.status !== 0) throw Error(`local pg_ctl failed: ${start.stderr}`);
  sql = postgres({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres', max: 2, onnotice: () => {} });
  store = new PgStore(sql);
  await store.migrate();
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  if (dir) {
    spawnSync('/opt/homebrew/bin/pg_ctl', ['-D', join(dir, 'data'), '-m', 'immediate', 'stop']);
    rmSync(dir, { recursive: true, force: true });
  }
});

const pending = (team: ReturnType<typeof C.mkTeam>): PendingHandover => {
  const old = { depth: 0, chainId: 'a'.repeat(64), chain: ['a'.repeat(64)] };
  const proposed = { depth: 1, chainId: 'b'.repeat(64), chain: ['a'.repeat(64), 'b'.repeat(64)] };
  return { old_chain: old, proposed_chain: proposed, proposed_key: team.f.pubkey, accounts: [], owners: [team.f.pubkey],
    eligible_owners: [team.f.pubkey], proposed_roster: { genesis: team.genesis }, proposed_at: C.T0,
    expires_at: C.T0 + 3 * 86_400_000, completes_at: null, tokens: [], token_hashes: {} };
};

test('real Postgres clears the pending control for operator completion and rejection', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => { throw Error('unexpected network request'); }) as unknown as typeof fetch;
  try {
    const finishTeam = C.mkTeam('rent20-pg-finish');
    const finishPending = pending(finishTeam);
    const rejectTeam = C.mkTeam('rent20-pg-reject');
    const rejectPending = pending(rejectTeam);
    await store.tx(async t => {
      await t.setEnrollment({ team_id: finishTeam.team, key: finishTeam.f.pubkey, source: 'roster', updated_at: C.T0 });
      await t.setControl(`enrollment-chain:${finishTeam.team}`, finishPending.old_chain);
      await t.setControl(handoverKey(finishTeam.team), finishPending);
      await t.setControl(handoverKey(rejectTeam.team), rejectPending);
    });
    const d = { ...C.world().d, store, now: () => C.T0 + 86_400_001 };
    expect(await store.tx(t => finishHandover(d, t, finishTeam.team,
      { chainId: finishPending.proposed_chain.chainId, proposedKey: finishPending.proposed_key,
        overrideObjection: false }))).toBe(true);
    expect(await store.tx(t => rejectHandover(d, t, rejectTeam.team,
      rejectPending.proposed_chain.chainId, rejectPending.proposed_key))).toBe(true);
    const rows = await sql`SELECT key, value = 'null'::jsonb AS cleared FROM compute_control
      WHERE key IN (${handoverKey(finishTeam.team)}, ${handoverKey(rejectTeam.team)}) ORDER BY key`;
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.cleared === true)).toBe(true);
  } finally { globalThis.fetch = previous; }
});
