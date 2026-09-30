// The provider-neutral cloud driver the control plane launches rented machines through. A driver knows one
// provider's API; the control plane knows nothing about any provider. Every instance a driver makes carries the
// tags below, so the control plane can reconcile what the provider holds against its own rentals and terminate
// orphans. Drivers are configured only from the control plane's private config/env; none is on by default.
export const TAG_MANAGED = "walkie:managed";
export const TAG_RENTAL = "walkie:rental";
export const TAG_TEAM = "walkie:team";
export const TAG_ACCOUNT = "walkie:account";
export const TAG_PAID_UNTIL = 'walkie:paid_until';

export type InstanceState = "pending" | "running" | "stopping" | "terminated";

export interface ProvisionReq {
  /** Same key → same instance, however often it is sent (the rental id). */
  readonly idempotency_key: string;
  readonly instance_type: string;
  /** Provider region and image from the private config (a driver that needs them refuses without). */
  readonly region: string | null;
  readonly image: string | null;
  /** cloud-init user-data. Carries a one-time join code and the heartbeat token: never log it. */
  readonly user_data: string;
  readonly name: string;
  readonly tags: Readonly<Record<string, string>>;
}

export interface Instance {
  readonly instance_id: string;
  readonly state: InstanceState;
  readonly tags: Readonly<Record<string, string>>;
}

export interface CloudDriver {
  readonly name: string;
  /** Idempotent on `idempotency_key`. Throws CapacityError when the provider has no room (the rental is queued). */
  provision(req: ProvisionReq, signal?: AbortSignal): Promise<{ instance_id: string }>;
  /** Terminates and wipes (disks deleted with the instance). Idempotent: an unknown or gone instance is success. */
  terminate(instanceId: string, signal?: AbortSignal): Promise<void>;
  /** Move the provider's independent paid deadline forward after a successful tick. */
  setPaidUntil(instanceId: string, until: number, signal?: AbortSignal): Promise<void>;
  /** Every instance this driver made that still exists (tagged walkie:managed), any state but terminated. */
  list(signal?: AbortSignal): Promise<Instance[]>;
}

/** The provider is out of capacity or our account quota: queue and retry later, don't fail the rental. */
export class CapacityError extends Error {
  constructor(message = "no capacity") { super(message); this.name = "CapacityError"; }
}

/** Any other provider failure. The message must never contain user-data or credentials. */
export class DriverError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); this.name = "DriverError"; }
}

export function rentalTags(rentalId: string, teamId: string, accountId: string): Record<string, string> {
  return { [TAG_MANAGED]: "1", [TAG_RENTAL]: rentalId, [TAG_TEAM]: teamId, [TAG_ACCOUNT]: accountId };
}
