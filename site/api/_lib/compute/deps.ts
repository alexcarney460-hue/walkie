// What the rental-compute control plane runs on. Handlers build it from env (env.ts); tests pass MemoryStore +
// FakeCloud + a fixed clock.
import type { CloudDriver } from "./driver.js";
import type { PrivateConfig } from "./private-config.js";
import type { ComputeStore } from "./store.js";

export interface ComputeDeps {
  /** Request wall-clock deadline, leaving room for alert delivery inside maxDuration. */
  readonly deadline?: number;
  readonly spendAlertUsdPerDay?: number;
  readonly alertConfigInvalid?: boolean;
  readonly verifyLicense?: (team: string, license: string, token: string, authority: string) => Promise<boolean>;
  readonly enabled?: boolean;
  /** Stable private key material used only to encrypt pending handover token copies. */
  readonly handoverTokenKey?: string;
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
