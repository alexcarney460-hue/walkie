import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as C from './rent6-fixtures.ts';
import * as originalIds from '../../src/protocol/ids.ts';
import * as siteIds from '../api/_lib/protocol/ids.ts';
import { canonicalJson as originalJson } from '../../src/protocol/canonical.ts';
import { canonicalJson as siteJson } from '../api/_lib/protocol/canonical.ts';
import { eventHeader as originalHeader } from '../../src/protocol/header.ts';
import { eventHeader as siteHeader } from '../api/_lib/protocol/header.ts';
import { Event as originalEvent, KINDS } from '../../src/protocol/schemas.ts';
import { Event as siteEvent } from '../api/_lib/protocol/schemas.ts';
import * as originalKeys from '../../src/daemon/keys.ts';
import * as siteKeys from '../api/_lib/protocol/keys.ts';
import { handoverNoticeText as originalNotice } from '../../src/daemon/compute/handover-notice.ts';
import { handoverNoticeText as siteNotice } from '../api/_lib/protocol/handover-notice.ts';
import { teamAuthority } from '../api/_lib/compute/team-proof.ts';

function withoutNetwork(run: () => void): void {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => { throw Error('unexpected network request'); }) as unknown as typeof fetch;
  try { run(); } finally { globalThis.fetch = previous; }
}

test('site event verifier agrees with daemon on signed and malformed vectors', () => {
  const t = C.mkTeam('site-protocol-parity');
  const msg = C.signEvent(t.f, { v: C.PROTOCOL_VERSION, team: t.team,
    id: `${t.f.nodeId}:2`, origin: t.f.nodeId, seq: 2, ts: C.T0 + 2,
    author: { handle: 'alex', node: t.f.nodeId }, kind: 'msg.post', channel: 'general', body: { text: 'hello' } });
  const vectors: unknown[] = [t.genesis, msg, ...KINDS.map(kind => ({ ...t.genesis, kind })),
    { ...t.genesis, seq: 0 },
    { ...t.genesis, kind: 'unknown' }, { ...t.genesis, body: null },
    { ...t.genesis, hsig: 3 }, { ...t.genesis, extra: true }];
  for (const value of vectors) {
    const original = originalEvent.safeParse(value), site = siteEvent.safeParse(value);
    expect(site.success).toBe(original.success);
    if (!site.success || !original.success) continue;
    expect(site.data).toEqual(original.data);
    expect(siteJson(site.data)).toBe(originalJson(original.data));
    expect(siteHeader(site.data)).toEqual(originalHeader(original.data));
    expect(siteKeys.verifyEvent(site.data, t.f.pubkey)).toBe(originalKeys.verifyEvent(original.data, t.f.pubkey));
    expect(siteKeys.verifyHeader(siteHeader(site.data), site.data.hsig, t.f.pubkey))
      .toBe(originalKeys.verifyHeader(originalHeader(original.data), original.data.hsig, t.f.pubkey));
  }
  for (const signature of [t.f.sign('payload'), t.genesis.sig, t.genesis.sig.slice(0, -1), '', '%%%']) {
    expect(siteKeys.verifySig(t.f.pubkey, 'payload', signature))
      .toBe(originalKeys.verifySig(t.f.pubkey, 'payload', signature));
  }
  expect(siteKeys.isValidPubkey(t.f.pubkey)).toBe(originalKeys.isValidPubkey(t.f.pubkey));
  expect(siteKeys.isValidPubkey('invalid')).toBe(originalKeys.isValidPubkey('invalid'));
  expect(siteIds.nodeIdFromPubkey(t.f.pubkey)).toBe(originalIds.nodeIdFromPubkey(t.f.pubkey));
  expect(siteIds.deriveTeamId(t.f.pubkey, 'site-protocol-parity', C.T0)).toBe(t.team);
  expect(teamAuthority(t.team, { genesis: t.genesis })?.chainId)
    .toBe(createHash('sha256').update(originalJson(t.genesis)).digest('hex'));
});

test('site handover notice text agrees with daemon for pending and timed notices', () => {
  const notice = { v: 1 as const, team: 'a'.repeat(16), proposed_by: 'a'.repeat(44),
    old_chain: 'a'.repeat(64), proposed_chain: 'b'.repeat(64), accounts: ['ca_0123456789abcdef'],
    proposed_at: C.T0, completes_at: null, objected: false };
  expect(siteNotice(notice)).toBe(originalNotice(notice));
  expect(siteNotice({ ...notice, completes_at: C.T0 + 90_000_000 }))
    .toBe(originalNotice({ ...notice, completes_at: C.T0 + 90_000_000 }));
});

test('site verifier rejects noncanonical signatures, wrong keys, and changed event bodies', () => {
  const t = C.mkTeam('site-parity-rejections'), stranger = C.mkTeam('stranger');
  const signature = t.genesis.sig;
  const { sig: _signature, ...unsigned } = t.genesis;
  const signedText = originalJson(unsigned);
  const variants = [signature.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    signature.replace(/=+$/, ''), `${signature}=`, ` ${signature}`, `${signature}\n`];
  for (const variant of variants) {
    expect(originalKeys.verifySig(t.f.pubkey, signedText, variant)).toBe(false);
    expect(siteKeys.verifySig(t.f.pubkey, signedText, variant)).toBe(false);
    expect(siteKeys.verifyEvent({ ...t.genesis, sig: variant }, t.f.pubkey)).toBe(false);
    expect(teamAuthority(t.team, { genesis: { ...t.genesis, sig: variant } })).toBeNull();
  }
  expect(siteKeys.verifyEvent(t.genesis, stranger.f.pubkey)).toBe(false);
  expect(siteKeys.verifyEvent({ ...t.genesis, body: { ...t.genesis.body, name: 'changed' } }, t.f.pubkey)).toBe(false);
  expect(teamAuthority(t.team, { genesis: { ...t.genesis, body: { ...t.genesis.body, name: 'changed' } } })).toBeNull();
  for (const length of [31, 33]) {
    const key = Buffer.alloc(length).toString('base64');
    expect(originalKeys.isValidPubkey(key)).toBe(false);
    expect(siteKeys.isValidPubkey(key)).toBe(false);
  }
  const next = stranger.f;
  const event = (seq: number, kind: 'team.member' | 'team.node' | 'team.authority', body: Record<string, unknown>) =>
    C.signEvent(t.f, { v: C.PROTOCOL_VERSION, team: t.team, id: `${t.f.nodeId}:${seq}`,
      origin: t.f.nodeId, seq, ts: C.T0 + seq, author: { handle: 'alex', node: t.f.nodeId }, kind, body });
  const member = event(2, 'team.member', { login: 'direct:next', handle: 'next', role: 'owner' });
  const node = event(3, 'team.node', { node_id: next.nodeId, login: 'direct:next', hostname: 'next', pubkey: next.pubkey, ip: '127.0.0.1' });
  const transfer = event(4, 'team.authority', { node_id: next.nodeId });
  const proof = { genesis: t.genesis, authority_chain: [{ key: next.pubkey, event: transfer }],
    roster_events: [member, node, transfer] };
  expect(teamAuthority(t.team, proof)?.key).toBe(next.pubkey);
  expect(teamAuthority(t.team, { ...proof,
    authority_chain: [{ key: next.pubkey, event: { ...transfer, sig: transfer.sig.replace(/=+$/, '') } }],
    roster_events: [member, node, { ...transfer, sig: transfer.sig.replace(/=+$/, '') }],
  })).toBeNull();
});

test('site event parser rejects Handle and EventId boundaries exactly as source', () => {
  const t = C.mkTeam('site-parity-regex');
  const badHandles = ['', 'A', '-alex', 'a'.repeat(25), 'a_b', 'a b'];
  const badIds = ['', `${t.f.nodeId}:0`, `${t.f.nodeId}:-1`, `${t.f.nodeId}:01`,
    `${t.f.nodeId.toUpperCase()}:1`, `${t.f.nodeId}:1x`];
  for (const handle of badHandles) {
    const value = { ...t.genesis, author: { ...t.genesis.author, handle } };
    expect(originalEvent.safeParse(value).success).toBe(false);
    expect(siteEvent.safeParse(value).success).toBe(false);
  }
  for (const id of badIds) {
    const value = { ...t.genesis, id };
    expect(originalEvent.safeParse(value).success).toBe(false);
    expect(siteEvent.safeParse(value).success).toBe(false);
  }
});

test('site authority verifier rejects re-signed invalid roster and transfer proofs', () => withoutNetwork(() => {
  const founder = C.generateKeys(), next = C.generateKeys(), other = C.generateKeys();
  const sign = (key: typeof founder, value: Record<string, unknown>) => C.signEvent(key, value as any);
  const noHeader = (key: typeof founder, value: Record<string, unknown>) =>
    ({ ...value, sig: key.sign(originalJson(value)) });
  const genesis = (name: string, ts = C.T0, overrides: Record<string, unknown> = {},
    signer = sign) => {
    const team = C.deriveTeamId(founder.pubkey, name, ts);
    const body = { name, owner_login: 'direct:alex', owner_handle: 'alex', node_hostname: 'founder',
      node_pubkey: founder.pubkey, node_ip: '127.0.0.1', ...overrides.body as object };
    const event = { v: C.PROTOCOL_VERSION, team, id: `${founder.nodeId}:1`, origin: founder.nodeId,
      seq: 1, ts, author: { handle: 'alex', node: founder.nodeId }, kind: 'team.create', body,
      ...overrides.top as object };
    return { team, event: signer(founder, event) };
  };
  const base = genesis('parity-invalid');
  const event = (key: typeof founder, seq: number, kind: string, body: Record<string, unknown>,
    overrides: Record<string, unknown> = {}, signer = sign) => signer(key, { v: C.PROTOCOL_VERSION,
      team: base.team, id: `${key.nodeId}:${seq}`, origin: key.nodeId, seq, ts: C.T0 + seq,
      author: { handle: 'alex', node: key.nodeId }, kind, body, ...overrides });
  const member = (seq = 2, role = 'owner', signer = sign) =>
    event(founder, seq, 'team.member', { login: 'direct:next', handle: 'next', role }, {}, signer);
  const node = (key = next, extra: Record<string, unknown> = {}) => event(founder, 3, 'team.node',
    { node_id: key.nodeId, login: 'direct:next', hostname: 'next', pubkey: key.pubkey, ip: '127.0.0.1', ...extra });
  const transfer = (key = next, overrides: Record<string, unknown> = {}, signer = sign) =>
    event(founder, 4, 'team.authority', { node_id: key.nodeId }, overrides, signer);
  const validTransfer = transfer();
  const valid = { genesis: base.event, authority_chain: [{ key: next.pubkey, event: validTransfer }],
    roster_events: [member(), node(), validTransfer] };
  expect(teamAuthority(base.team, valid)?.key).toBe(next.pubkey);

  const cases: [string, string, unknown][] = [];
  const add = (name: string, team: string, proof: unknown) => cases.push([name, team, proof]);
  const noHeaderGenesis = genesis('parity-no-header', C.T0, {}, noHeader);
  add('genesis missing header signature', noHeaderGenesis.team, { genesis: noHeaderGenesis.event });
  add('roster member missing header signature', base.team,
    { genesis: base.event, roster_events: [member(2, 'owner', noHeader)] });
  const noHeaderTransfer = transfer(next, {}, noHeader);
  add('transfer missing header signature', base.team, { genesis: base.event,
    authority_chain: [{ key: next.pubkey, event: noHeaderTransfer }],
    roster_events: [member(), node(), noHeaderTransfer] });
  const wrongHandle = genesis('parity-handle', C.T0, { body: { owner_handle: 'mallory' } });
  add('genesis author differs from owner', wrongHandle.team, { genesis: wrongHandle.event });
  const wrongSequence = genesis('parity-genesis-seq', C.T0, { top: { seq: 2, id: `${founder.nodeId}:2` } });
  add('signed genesis sequence two', wrongSequence.team, { genesis: wrongSequence.event });
  const wrongAuthorNode = genesis('parity-genesis-author', C.T0,
    { top: { author: { handle: 'alex', node: other.nodeId } } });
  add('signed genesis author differs from origin', wrongAuthorNode.team, { genesis: wrongAuthorNode.event });
  const wrongGenesisId = genesis('parity-genesis-id', C.T0, { top: { id: `${founder.nodeId}:7` } });
  add('signed genesis id differs from sequence', wrongGenesisId.team, { genesis: wrongGenesisId.event });
  const versionTwo = genesis('parity-v2', C.T0, { top: { v: 2 } });
  add('signed v2 genesis', versionTwo.team, { genesis: versionTwo.event });
  const fractional = genesis('parity-fractional', C.T0 + 0.5);
  add('fractional genesis timestamp', fractional.team, { genesis: fractional.event });
  {
    const keys = Array.from({ length: 101 }, () => C.generateKeys());
    const roster: unknown[] = [], chain: unknown[] = [];
    let current = founder;
    for (const key of keys) {
      const login = `direct:${key.nodeId}`;
      roster.push(event(current, 2, 'team.member', { login, handle: 'x', role: 'owner' }));
      roster.push(event(current, 3, 'team.node', { node_id: key.nodeId, login, hostname: 'h',
        pubkey: key.pubkey, ip: '127.0.0.1' }));
      const step = event(current, 4, 'team.authority', { node_id: key.nodeId });
      roster.push(step);
      chain.push({ key: key.pubkey, event: step });
      current = key;
    }
    add('101 authority transfers', base.team, { genesis: base.event, authority_chain: chain, roster_events: roster });
  }
  add('501 roster events', base.team, { genesis: base.event, roster_events: Array.from({ length: 501 }, (_, i) =>
    event(founder, i + 2, 'team.member', { login: `direct:m${i}`, handle: 'm', role: 'member' })) });
  add('revoked authority target', base.team, { ...valid, roster_events: [member(), node(next, { revoked: true }), validTransfer] });
  add('non-owner authority target', base.team, { ...valid, roster_events: [member(2, 'member'), node(), validTransfer] });
  const selfTransfer = event(founder, 4, 'team.authority', { node_id: founder.nodeId });
  add('self transfer', base.team, { genesis: base.event,
    authority_chain: [{ key: founder.pubkey, event: selfTransfer }], roster_events: [selfTransfer] });
  add('descending roster sequence', base.team, { genesis: base.event, roster_events: [member(3),
    event(founder, 2, 'team.member', { login: 'direct:n2', handle: 'n2', role: 'owner' })] });
  add('transfer key differs from node', base.team, { ...valid, authority_chain: [{ key: other.pubkey, event: validTransfer }] });
  add('node id differs from pubkey', base.team, { ...valid,
    roster_events: [member(), node(next, { node_id: other.nodeId }), validTransfer] });
  add('non-roster event', base.team, { genesis: base.event, roster_events: [
    event(founder, 2, 'msg.post', { text: 'x' }, { channel: 'general' })] });
  const wrongIdTransfer = transfer(next, { id: `${founder.nodeId}:5` });
  add('transfer id differs from sequence', base.team, { ...valid,
    authority_chain: [{ key: next.pubkey, event: wrongIdTransfer }],
    roster_events: [member(), node(), wrongIdTransfer] });
  add('roster author differs from origin', base.team, { genesis: base.event, roster_events: [
    event(founder, 2, 'team.member', { login: 'direct:n', handle: 'n', role: 'owner' },
      { author: { handle: 'alex', node: next.nodeId } })] });
  const duplicate = member();
  add('duplicate roster event', base.team, { genesis: base.event, roster_events: [duplicate, duplicate] });
  add('transfer absent from roster', base.team, { ...valid, roster_events: [member(), node()] });
  const otherTransfer = transfer(next, { seq: 5, id: `${founder.nodeId}:5` });
  add('different transfer occupies roster position', base.team, { ...valid,
    roster_events: [member(), node(), otherTransfer] });
  add('unregistered member owns a roster node', base.team, { genesis: base.event,
    roster_events: [node()] });
  add('roster node id differs from its pubkey without transfer', base.team, { genesis: base.event,
    roster_events: [member(), node(next, { node_id: other.nodeId })] });
  add('uppercased team parameter', base.team.toUpperCase(), { genesis: base.event });
  add('different signed team id', 'a'.repeat(16), { genesis: base.event });
  add('genesis host changed with reused signatures', base.team, { genesis: { ...base.event,
    body: { ...base.event.body, node_hostname: 'forged' } } });
  add('roster body changed with reused signature', base.team, { genesis: base.event, roster_events: [
    { ...member(), body: { login: 'direct:other', handle: 'other', role: 'owner' } }] });
  for (const [name, team, proof] of cases) {
    expect(teamAuthority(team, proof as Parameters<typeof teamAuthority>[1])).toBeNull();
  }
  expect(cases).toHaveLength(29);
}));

test('site primitive verifier and parser preserve rejection boundaries', () => withoutNetwork(() => {
  const t = C.mkTeam('parity-primitive-boundaries');
  const invalidEvents = [
    { ...t.genesis, v: 2 },
    { ...t.genesis, ts: C.T0 + 0.5 },
    { ...t.genesis, kind: 'team.fork' },
    { ...t.genesis, hsig: 'x'.repeat(201) },
    { ...t.genesis, team: 'not-a-team' },
    { ...t.genesis, channel: 'Bad Channel' },
    { ...t.genesis, author: { ...t.genesis.author, agent: 'Bad Agent' } },
  ];
  for (const value of invalidEvents) {
    expect(originalEvent.safeParse(value).success).toBe(false);
    expect(siteEvent.safeParse(value).success).toBe(false);
  }
  const extraAuthor = { ...t.genesis, author: { ...t.genesis.author, extra: true } };
  expect(siteEvent.parse(extraAuthor)).toEqual(originalEvent.parse(extraAuthor));
  expect(siteJson([undefined, 'x'])).toBe(originalJson([undefined, 'x']));
  expect(() => originalJson(Number.POSITIVE_INFINITY)).toThrow();
  expect(() => siteJson(Number.POSITIVE_INFINITY)).toThrow();
  expect(siteKeys.verifySig('invalid', 'payload', t.f.sign('payload'))).toBe(false);
  expect(siteKeys.verifySig(t.f.pubkey, 'payload', 'x'.repeat(200))).toBe(false);
}));
