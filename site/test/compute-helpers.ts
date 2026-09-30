// Fixtures for the rental-compute tests: a private config on the fake provider (its costs are the plan's AWS figures,
// so the no-cost test has real numbers to look for), a fixed clock, a MemoryStore and a FakeCloud.
import { generateKeys, signEvent } from "../../src/daemon/keys.ts";
import { deriveTeamId } from '../../src/protocol/ids.ts';
import { PROTOCOL_VERSION } from '../../src/protocol/schemas.ts';
import { createInvite } from "../../src/daemon/invite.ts";
import { createAccount as account, rent as enqueue, start as enqueueStart } from "../api/_lib/compute/service.ts";
import { tick } from "../api/_lib/compute/tick.ts";
import { ownershipMessage } from "../api/_lib/compute/ownership.ts";
import { randomBytes } from "node:crypto";
import type { ComputeDeps } from "../api/_lib/compute/deps.ts";
import { FakeCloud, type FakeCloudOptions } from "../api/_lib/compute/fake-cloud.ts";
import { MemoryStore } from "../api/_lib/compute/memory-store.ts";
import { parsePrivateConfig, type PrivateConfig } from "../api/_lib/compute/private-config.ts";
import type { ComputeStore } from "../api/_lib/compute/store.ts";

export const fixtureKeys = generateKeys();
export const T0 = 1_790_000_000_000;
export const fixtureTeam = deriveTeamId(fixtureKeys.pubkey, 'fixture', T0);
export const fixtureGenesis = signEvent(fixtureKeys, { v: PROTOCOL_VERSION, team: fixtureTeam,
  id: `${fixtureKeys.nodeId}:1`, origin: fixtureKeys.nodeId, seq: 1, ts: T0,
  author: { handle: 'alex', node: fixtureKeys.nodeId }, kind: 'team.create',
  body: { name: 'fixture', owner_login: 'direct:alex', owner_handle: 'alex', node_hostname: 'fixture',
    node_pubkey: fixtureKeys.pubkey, node_ip: '127.0.0.1' } });
export const MIN = 60_000;

/** Our cost per hour in micros (plan §3A.4, DigitalOcean): these must never reach a customer. */
export const COSTS = { agent: 375_000, "agent-xl": 750_000, "gpu-20": 760_000, "gpu-48": 1_570_000, "gpu-80": 4_410_000 } as const;
/** The provider's size slugs (private). */
export const SIZES = {
  agent: "g-8vcpu-32gb", "agent-xl": "g-16vcpu-64gb", "gpu-20": "gpu-4000adax1-20gb", "gpu-48": "gpu-l40sx1-48gb", "gpu-80": "gpu-h100x1-80gb",
} as const;

export function configJson(quotas: Record<string, number> = { cpu: 100, gpu: 16 }, extra: Record<string, unknown> = {}, provider = "fake"): string {
  const t = (tier: keyof typeof COSTS, group: string, region: string) => ({
    provider, instance_type: SIZES[tier], cost_per_hour_micros: COSTS[tier], quota_group: group, region, image: "ubuntu-24-04-x64",
  });
  return JSON.stringify({
    tiers: {
      agent: t("agent", "cpu", "nyc3"), "agent-xl": t("agent-xl", "cpu", "nyc3"),
      "gpu-20": t("gpu-20", "gpu", "tor1"), "gpu-48": t("gpu-48", "gpu", "tor1"), "gpu-80": t("gpu-80", "gpu", "nyc2"),
    },
    customer_teams: [fixtureTeam], team_authorities: { [fixtureTeam]: fixtureKeys.pubkey },
    quotas, egress_cap_gb: 5000, egress_rate_mbit: 1000, ...extra,
  });
}

export interface World {
  readonly d: ComputeDeps;
  readonly cloud: FakeCloud;
  readonly store: ComputeStore;
  readonly clock: { now: number };
  readonly logs: { event: string; fields: Record<string, unknown> }[];
  advance(ms: number): void;
}

export function world(opts: { quotas?: Record<string, number>; cloud?: FakeCloudOptions; store?: ComputeStore; config?: PrivateConfig } = {}): World {
  const clock = { now: T0 };
  const cloud = new FakeCloud(opts.cloud ?? {});
  const store = opts.store ?? new MemoryStore();
  void store.tx(t => t.setControl('last_tick', T0));
  const logs: World["logs"] = [];
  const d: ComputeDeps = {
    store, config: opts.config ?? parsePrivateConfig(configJson(opts.quotas)), driver: (p) => (p === "fake" ? cloud : null),
    now: () => clock.now, siteOrigin: "https://site.test", handoverTokenKey: 'rent-fixture-handover-key-32-bytes',
    log: (event, fields) => { logs.push({ event, fields: { ...fields } }); },
  };
  return { d, cloud, store, clock, logs, advance: (ms) => { clock.now += ms; } };
}

export const joinCode = (now = T0): string => createInvite(fixtureKeys, { team: fixtureTeam, authority: fixtureKeys.pubkey, handle: 'alex', role: 'member', now, pos: 1, ttlMs: 3_600_000 }).code;
export const codes = (n: number, now = T0): string[] => Array.from({ length: n }, () => joinCode(now));
export const idem = (): string => randomBytes(12).toString("base64url");

/** Adds credit directly to the ledger (as the webhook would). */
export async function fund(store: ComputeStore, accountId: string, micros: number, key = idem()): Promise<void> {
  await store.tx((t) => t.addLedger({ account_id: accountId, kind: "purchase", amount_micros: micros, idem_key: `test:${key}`, created_at: T0 }));
}

export async function balance(store: ComputeStore, accountId: string): Promise<number> {
  return store.tx((t) => t.balance(accountId));
}

/** A Stripe-Signature header for a test webhook payload (Stripe's own test helper). */
export async function stripeTestHeader(payload: string, secret: string): Promise<string> {
  const { default: Stripe } = await import("stripe");
  return Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret });
}

export const proof = (now = T0, team = fixtureTeam) => ({ key: fixtureKeys.pubkey, expires_at: now + 300_000,
  signature: fixtureKeys.sign(ownershipMessage(team, now + 300_000)), genesis: fixtureGenesis });
export async function createAccount(d: ComputeDeps, team: string) { return account(d, team, proof(d.now(), team)); }
/** Legacy service scenarios explicitly complete the asynchronous worker step. */
export async function rent(...args: Parameters<typeof enqueue>) {
  const result = await enqueue(...args);
  await tick(args[0]);
  const { state } = await import('../api/_lib/compute/service.ts');
  const current = await state(args[0], args[1]);
  return { ...result, balance_micros: current.balance_micros, rentals: result.rentals.map(r => current.rentals.find(c => c.id === r.id)!) };
}
export async function start(...args: Parameters<typeof enqueueStart>) {
  await enqueueStart(...args);
  await tick(args[0]);
  const { state } = await import('../api/_lib/compute/service.ts');
  return (await state(args[0], args[1])).rentals.find(r => r.id === args[2])!;
}
