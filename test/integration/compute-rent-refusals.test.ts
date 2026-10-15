// Lane H round 4 (REVIEW-pre17c-opus.md P2-1): a rent the site refused before recording anything must not be kept
// pending by the daemon, or the person's retry (which the message asks for) and the poller's replay of the first request
// make two machines out of one. The real daemon against a fake site (Opus's probe zz-busy-dup2, on the harness of
// compute-daemon.test.ts). For each refusal: one refused rent, the person's retry, a poll: exactly one rental. A rent
// whose outcome is unknown (the site recorded it, then failed) stays pending and is recovered by the poll, never doubled.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import type { WalkieError } from '../../src/client/index.ts';
import { computeFor } from '../../src/daemon/compute/routes.ts';
import { accountPath, loadPending, loadRentals } from '../../src/daemon/compute/files.ts';
import { ComputeSite } from '../../src/daemon/compute/site.ts';
import { SiteRentReq, type RentalView, type RentResult, type TierId } from '../../src/protocol/compute.ts';
import { Cluster, type TestNode } from '../helpers/cluster.ts';
import { QUOTES } from '../helpers/compute-fixtures.ts';

setDefaultTimeout(60_000);

const TOKEN = randomBytes(32).toString('base64url');
const site = {
  rentals: new Map<string, RentalView>(),
  idem: new Map<string, RentResult>(),
  /** The next rent answers: a refusal before anything is recorded, or (`recordThen`) recorded and then a failure. */
  rentAnswers: [] as { status: number; error: string; recordThen?: boolean }[],
  accountAnswers: [] as { status: number; error: string }[],
  /** The next answers to a resend of a key the site already recorded (instead of its replay). */
  resendAnswers: [] as { status: number; error: string }[],
};
const priceOf = (t: TierId) => QUOTES.tiers.find((x) => x.id === t)?.price_per_hour_micros ?? 0;
const j = (body: unknown, status = 200) => Response.json(body, { status });
let teamId = '';
/** The next rent answers lost on the way back (the site acted on the request). */
let loseRentAnswers = 0;

function record(b: ReturnType<typeof SiteRentReq.parse>): RentResult {
  const created: RentalView[] = [];
  const codeIndex: Record<string, number> = {};
  let i = 0;
  for (const m of b.machines) for (let k = 0; k < m.count; k++, i++) {
    const id = `r_${randomBytes(8).toString('hex')}`;
    const r: RentalView = { id, tier: m.tier, name: `rent-${m.tier}-${randomBytes(2).toString('hex')}`, state: 'starting', queue_position: null,
      price_per_hour_micros: priceOf(m.tier), spent_micros: 0, created_at: Date.now(), started_at: Date.now(), ended_at: null, end_reason: null,
      node_id: null, idle_minutes: b.idle_minutes ?? 30 };
    site.rentals.set(id, r);
    codeIndex[id] = i;
    created.push(r);
  }
  const res: RentResult = { rentals: created, started: created.length, queued: 0, code_index: codeIndex, balance_micros: 50_000_000, replay: false };
  site.idem.set(b.idempotency_key, res);
  return res;
}

async function handle(req: Request): Promise<Response> {
  const p = new URL(req.url).pathname;
  if (p === '/api/compute/quotes') return j(QUOTES);
  if (p === '/api/compute/account') {
    const refuse = site.accountAnswers.shift();
    if (refuse) return j({ error: refuse.error }, refuse.status);
    return j({ account_id: 'ca_00000000000000c1', token: TOKEN }, 201);
  }
  if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) return j({ error: 'invalid_token' }, 401);
  if (p === '/api/compute/state') {
    const rentals = [...site.rentals.values()];
    return j({ account_id: 'ca_00000000000000c1', team_id: teamId, status: 'active', balance_micros: 50_000_000,
      burn_per_hour_micros: 0, hours_left: null, rentals, credit_lots: [], next_expiry_at: null });
  }
  if (p === '/api/compute/handover') return j({ error: 'handover_not_found' }, 404);
  if (p === '/api/compute/rent') {
    const b = SiteRentReq.parse(await req.json());
    const seen = site.idem.get(b.idempotency_key);
    const resend = seen ? site.resendAnswers.shift() : undefined;
    if (resend) return j({ error: resend.error }, resend.status);
    if (seen) return j({ ...seen, replay: true });
    const answer = site.rentAnswers.shift();
    if (answer?.recordThen) { record(b); return j({ error: answer.error }, answer.status); }
    if (answer) return j({ error: answer.error, retry_after_s: 5 }, answer.status);
    return j(record(b));
  }
  return j({ error: 'not_found' }, 404);
}

let server: ReturnType<typeof Bun.serve>;
let c: Cluster;
let alex: TestNode;
const refused = async (p: Promise<unknown>): Promise<WalkieError> => {
  try { await p; } catch (e) { return e as WalkieError; }
  throw new Error('expected a refusal');
};
const one = { machines: [{ tier: 'agent' as const, count: 1 }] };
/** What a rent kept pending (its outcome unknown) answers, and nothing else (REVIEW-pre17d-opus.md P3-1). */
const KEPT = "the request is kept and will be sent again automatically; don't rent again";

beforeAll(async () => {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handle });
  c = new Cluster();
  alex = await c.add({ name: 'alex', login: '-', hostname: 'alex-mbp', direct: true,
    compute: { site: new ComputeSite({ base: `http://127.0.0.1:${server.port}`, fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).endsWith('/rent') && loseRentAnswers > 0) { loseRentAnswers--; throw new Error('lost rent answer'); }
      return response;
    } }), intervalMs: 3_600_000 } });
  await alex.client().init('acme', 'alex');
  teamId = alex.d.core.teamId as string;
}, 30_000);
afterAll(async () => { await c.close(); server.stop(true); });

/** One refused rent, the person's retry, then a poll: how many rentals did the site make? */
async function refusedThenRetried(): Promise<{ error: WalkieError; pendingAfterRefusal: number; made: number }> {
  const before = site.rentals.size;
  const error = await refused(alex.client().computeRent(one));
  const pendingAfterRefusal = loadPending(alex.home).length;
  await alex.client().computeRent(one);
  await computeFor(alex.d.core)?.pollOnce();
  return { error, pendingAfterRefusal, made: site.rentals.size - before };
}

describe('a rent refused before anything was recorded is not kept pending: one machine per retry', () => {
  for (const [status, code] of [[429, 'compute_busy'], [503, 'compute_tick_stale'], [503, 'compute_not_configured']] as const) {
    test(`${status} ${code}`, async () => {
      site.rentAnswers.push({ status, error: code });
      const r = await refusedThenRetried();
      expect(r.error.code).toBe(code);
      expect(r.pendingAfterRefusal).toBe(0);
      expect(r.made).toBe(1);
      expect(loadPending(alex.home)).toEqual([]);
    });
  }

  for (const code of ['licence_record_pruning', 'licence_backfill_pending', 'license_verification_unavailable'] as const) {
    test(`503 ${code} (at the account's creation, before anything is pending)`, async () => {
      rmSync(accountPath(alex.home), { force: true });
      site.accountAnswers.push({ status: 503, error: code });
      const r = await refusedThenRetried();
      expect(r.error.code).toBe(code);
      expect(r.pendingAfterRefusal).toBe(0);
      expect(r.made).toBe(1);
    });
  }
});

describe('a rent whose outcome is unknown stays pending and is recovered, never doubled', () => {
  test('the site recorded the rent, then answered 500: the poll recovers it with the same key; one rental, recorded here', async () => {
    const before = site.rentals.size;
    site.rentAnswers.push({ status: 500, error: 'compute_error', recordThen: true });
    const e = await refused(alex.client().computeRent(one));
    expect(e.code).toBe('compute_error');
    expect(e.message).toBe(KEPT);
    expect(loadPending(alex.home)).toHaveLength(1);
    await computeFor(alex.d.core)?.pollOnce();
    expect(site.rentals.size - before).toBe(1);
    expect(loadPending(alex.home)).toEqual([]);
    const made = [...site.rentals.keys()].slice(-1)[0]!;
    expect(Object.keys(loadRentals(alex.home))).toContain(made);
  });

  test('a lost answer, then a 500 on the resend: still kept (and said so); the poll recovers the one rental', async () => {
    const before = site.rentals.size;
    loseRentAnswers = 1; // the first send is recorded and its answer lost; the resend (same key) is answered 500
    site.resendAnswers.push({ status: 500, error: 'compute_error' });
    const e = await refused(alex.client().computeRent(one));
    expect(e.message).toBe(KEPT);
    expect(loadPending(alex.home)).toHaveLength(1);
    await computeFor(alex.d.core)?.pollOnce();
    expect(site.rentals.size - before).toBe(1);
    expect(loadPending(alex.home)).toEqual([]);
  });

  // REVIEW-pre17d-opus.md P3-1: the site recorded the first send, so a refused resend proves nothing; the answer must not
  // say "nothing was rented: try again" (retrying and the poll made two rentals).
  test('a lost answer, then 429 compute_busy on the resend: still kept, said only so; the poll recovers the one rental', async () => {
    const before = site.rentals.size;
    loseRentAnswers = 1; // the first send is recorded and its answer lost; the resend (same key) is refused 429 compute_busy
    site.resendAnswers.push({ status: 429, error: 'compute_busy' });
    const e = await refused(alex.client().computeRent(one));
    expect(e.code).toBe('compute_busy');
    expect(e.message).toBe(KEPT);
    expect(loadPending(alex.home)).toHaveLength(1);
    await computeFor(alex.d.core)?.pollOnce();
    expect(site.rentals.size - before).toBe(1);
    expect(loadPending(alex.home)).toEqual([]);
  });

  test('a 503 the daemon cannot place (a gateway error, no known code) stays pending too', async () => {
    const before = site.rentals.size;
    site.rentAnswers.push({ status: 503, error: 'http_503', recordThen: true });
    await refused(alex.client().computeRent(one));
    expect(loadPending(alex.home)).toHaveLength(1);
    await computeFor(alex.d.core)?.pollOnce();
    expect(site.rentals.size - before).toBe(1);
    expect(loadPending(alex.home)).toEqual([]);
  });
});
