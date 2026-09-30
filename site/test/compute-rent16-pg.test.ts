import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { PgStore } from '../api/_lib/compute/pg-store.ts';
import { MIGRATIONS } from '../api/_lib/compute/migrations.ts';
import { heldAccounts } from '../api/_lib/compute/handover.ts';
import * as C from './rent6-fixtures.ts';

const PORT = 20_000 + Math.floor(Math.random() * 20_000);
let dir = '';
let sql: ReturnType<typeof postgres>;
let bare: ReturnType<typeof postgres>;

beforeAll(() => {
  dir = mkdtempSync(join(import.meta.dir, '.rent16-pg-'));
  const data = join(dir, 'data');
  const init = spawnSync('/opt/homebrew/bin/initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'],
    { encoding: 'utf8' });
  if (init.status !== 0) throw new Error(`local initdb failed: ${init.stderr}`);
  const start = spawnSync('/opt/homebrew/bin/pg_ctl', ['-D', data, '-l', join(dir, 'log'), '-w',
    '-o', `-p ${PORT} -c unix_socket_directories='' -c listen_addresses='127.0.0.1'`, 'start'],
  { encoding: 'utf8' });
  if (start.status !== 0) throw new Error(`local pg_ctl failed: ${start.stderr}`);
  sql = postgres({ host: '127.0.0.1', port: PORT, user: 'postgres', database: 'postgres', max: 4, onnotice: () => {} });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await bare?.end({ timeout: 5 });
  if (dir) {
    spawnSync('/opt/homebrew/bin/pg_ctl', ['-D', join(dir, 'data'), '-m', 'immediate', 'stop']);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P15-PG migration backfills spent positive adjustments and keeps earliest credit', async () => {
  await sql`CREATE TABLE compute_migrations (id integer PRIMARY KEY, applied_at bigint NOT NULL)`;
  for (const m of MIGRATIONS.filter(m => m.id <= 4)) {
    await sql.unsafe(m.sql);
    await sql`INSERT INTO compute_migrations VALUES (${m.id}, 1)`;
  }
  const team = '0123456789abcdef';
  const accountA = 'ca_000000000000000a', accountB = 'ca_000000000000000b';
  await sql`INSERT INTO compute_accounts (id, team_id, token_hash, created_at)
    VALUES (${accountA}, ${team}, ${'a'.repeat(64)}, 1), (${accountB}, ${team}, ${'b'.repeat(64)}, 1)`;
  await sql`INSERT INTO compute_ledger (account_id, kind, amount_micros, idem_key, created_at)
    VALUES (${accountA}, 'adjustment', 50000000, 'a-adjust', 50),
      (${accountA}, 'purchase', 50000000, 'a-purchase', 100),
      (${accountA}, 'burn', -100000000, 'a-spend', 200),
      (${accountB}, 'adjustment', 10000000, 'b-adjust', 70),
      (${accountB}, 'burn', -10000000, 'b-spend', 200)`;
  const store = new PgStore(sql);
  expect(await store.schemaVersion()).toBe(4);
  const owner = C.mkTeam('rent17-pg-m4'), w = C.world();
  expect(await C.err(C.createAccount({ ...w.d, store }, owner.team,
    C.proof(owner.f, owner.team, w.clock.now, owner.genesis)))).toBe('compute_state_unavailable');
  const signer = C.LH.testKeypair(), stripe = new C.LH.MockStripe(), lic = 'sub_RENT17PG';
  stripe.subs.set(lic, C.LH.subscription({ id: lic }));
  const code = C.signLicense({ v: 2, kind: 'activation', lic_id: lic, plan: 'team', seats: 7,
    email: 'fixture@example.test', interval: 'month', issued_at: C.LH.NOW,
    expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
  const bind = C.makeBind({ ...C.LH.deps(stripe, C.LH.fullEnv(signer.pem)), computeStore: () => store });
  const response = await bind(new Request('https://site.test/api/license/bind', { method: 'POST',
    body: JSON.stringify({ code, team_id: owner.team }) }));
  expect(response.status).toBe(503);
  expect(await store.migrate()).toEqual([5, 6]);
  const rows = await sql`SELECT id, first_funded_at FROM compute_accounts ORDER BY id`;
  expect(Number(rows[0]!.first_funded_at)).toBe(50);
  expect(Number(rows[1]!.first_funded_at)).toBe(70);
  expect(await store.tx(tx => heldAccounts(tx, team))).toEqual([accountA, accountB]);
  const inserted = await store.tx(tx => tx.addLedger({ account_id: accountB, kind: 'adjustment',
    amount_micros: 1, idem_key: 'b-second', created_at: 300 }));
  expect(inserted).toBe(true);
  expect(Number((await sql`SELECT first_funded_at FROM compute_accounts WHERE id = ${accountB}`)[0]!.first_funded_at)).toBe(70);
});

test('P15-PG2 disabled compute permits empty schema but blocks partial data', async () => {
  await sql`CREATE DATABASE bare`;
  bare = postgres({ host: '127.0.0.1', port: PORT, user: 'postgres', database: 'bare', max: 2, onnotice: () => {} });
  const team = C.mkTeam('rent16-pg-bare'), signer = C.LH.testKeypair(), stripe = new C.LH.MockStripe();
  const lic = ("sub_" + 'RENT16BARE');
  stripe.subs.set(lic, C.LH.subscription({ id: lic }));
  const code = C.signLicense({ v: 2, kind: 'activation', lic_id: lic, plan: 'team', seats: 7,
    email: 'fixture@example.test', interval: 'month', issued_at: C.LH.NOW,
    expires_at: C.LH.NOW + 30 * 86_400_000 }, C.signingKeyFromPem(signer.pem));
  const request = () => {
    const exp = C.LH.NOW + 240_000;
    return new Request('https://site.test/api/license/bind', { method: 'POST', body: JSON.stringify({
      code, team_id: team.team, proof: { genesis: team.genesis, authority_chain: [], roster_events: [],
        expires_at: exp, bind_signature: team.f.sign(C.bindMessage(team.team, lic, exp)) },
    }) });
  };
  const disabled = C.makeBind({ ...C.LH.deps(stripe, C.LH.fullEnv(signer.pem)),
    computeStore: () => new PgStore(bare) });
  expect(await new PgStore(bare).legacyEmpty()).toBe(true);
  await bare`CREATE TABLE compute_control (key text PRIMARY KEY, value jsonb NOT NULL)`;
  await bare`INSERT INTO compute_control VALUES ('enrollment-chain:0123456789abcdef', 'null'::jsonb)`;
  expect(await new PgStore(bare).legacyEmpty()).toBe(true);
  expect((await disabled(request())).status).toBe(200);
  expect((await bare`SELECT count(*)::int AS n FROM compute_control`)[0]!.n).toBe(1);
  const enabled = C.makeBind({ ...C.LH.deps(stripe, { ...C.LH.fullEnv(signer.pem), COMPUTE_ENABLED: '1' }),
    computeStore: () => new PgStore(bare) });
  expect((await enabled(request())).status).toBe(503);
  await bare`CREATE TABLE compute_accounts (id text PRIMARY KEY)`;
  await bare`INSERT INTO compute_accounts VALUES ('ca_0123456789abcdef')`;
  expect(await new PgStore(bare).legacyEmpty()).toBe(false);
  expect((await disabled(request())).status).toBe(503);
});
