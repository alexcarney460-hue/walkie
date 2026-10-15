// What the rental-compute control plane runs on. Handlers build it from env (env.ts); tests pass MemoryStore +
// FakeCloud + a fixed clock.
import type { ChargeLookup } from "./credit.js";
import type { CloudDriver } from "./driver.js";
import type { PrivateConfig } from "./private-config.js";
import type { ComputeStore } from "./store.js";
import type { SubscriptionLite } from "../stripe.js";

export interface ComputeDeps {
  /** Request wall-clock deadline, leaving room for alert delivery inside maxDuration. */
  readonly deadline?: number;
  readonly spendAlertUsdPerDay?: number;
  readonly alertConfigInvalid?: boolean;
  readonly verifyLicense?: (team: string, license: string, token: string, authority: string) => Promise<boolean>;
  /**
   * The team's licences in the licence Stripe account (read-only metadata search), consulted at a team's FIRST compute
   * enrollment. The deployed control plane always sets it (rejecting when the licence key is unset, so enrollment fails
   * closed); only test fixtures omit it, and then a team has no licences.
   */
  readonly teamLicences?: (team: string, options: { readonly timeout: number }) => Promise<readonly SubscriptionLite[]>;
  /**
   * One licence subscription by id (strongly consistent), for the team's recorded bindings (licence-records.ts). The
   * deployed control plane always sets it with teamLicences; each call carries a real per-request timeout.
   */
  readonly licenceById?: (id: string, options: { readonly timeout: number }) => Promise<SubscriptionLite | null>;
  /** Upper bound on those reads, in ms (default LICENCE_READ_MS). */
  readonly licenceReadMs?: number;
  readonly enabled?: boolean;
  /** Stable private key material used only to encrypt pending handover token copies. */
  readonly handoverTokenKey?: string;
  /**
   * The compute Stripe key's charge reads, for the tick's retry of held freezes (tick.ts sweepFreezeHolds). Absent
   * without an allowed compute key, and then the tick does not retry (Stripe's redelivery still does).
   */
  readonly charges?: ChargeLookup;
  readonly store: ComputeStore;
  readonly config: PrivateConfig;
  /** The driver for a provider name from the private config; null when that provider isn't set up. */
  readonly driver: (provider: string) => CloudDriver | null;
  readonly now: () => number;
  /** Where rented machines fetch the installer and send heartbeats (https). */
  readonly siteOrigin: string;
  readonly log: (event: string, fields: Readonly<Record<string, string | number | boolean | null>>) => void;
}

/** Structured control-plane log line. Callers pass ids, states and reasons only: never a code or token. Provider-spend alerts may include private costs. */
export function stderrLog(event: string, fields: Readonly<Record<string, string | number | boolean | null>>): void {
  process.stderr.write(`compute ${event} ${JSON.stringify(fields)}\n`);
}
