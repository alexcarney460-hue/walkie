// Team-wide integration entitlement (docs/BUSINESS.md "Plans"; LICENSE-FIX-2 F3): the count is decided
// at the roster authority. Enabling a connector on a machine is a roster change, `team.integration
// {connector, node, enabled}`, that the authority appends only within the plan's integration
// entitlement (402 `plan_limit` otherwise), counted team-wide from the chain: distinct connectors
// enabled on active machines. A daemon enables a connector locally only after the authority accepted.
// While the authority is offline the request is queued (202) and the connector waits, `pending_enable`
// in its settings, until the entry arrives. Disabling releases the slot: never limited, queued if the
// authority is offline, and never a reason for a disable to fail. Nothing already enabled is ever
// turned off on a downgrade. Connector settings and credentials stay on each machine.
import { CONNECTOR_IDS, type ConnectorId } from "../integrations/config.ts";
import type { Core } from "../daemon/core.ts";
import type { Logger } from "../daemon/logger.ts";
import type { PeerClient } from "../daemon/peer-client.ts";
import { submitRequest, type CatchUp, type SubmitResult } from "../daemon/requests.ts";

/** What a slot change needs: the core, and (off the authority) the peer client + catch-up for requests. */
export interface SlotDeps { readonly core: Core; readonly client?: PeerClient; readonly catchUp?: CatchUp }

/** The slice of the integrations manager the slot reconciler uses. */
export interface SlotSettings {
  settings(id: ConnectorId): { readonly enabled?: boolean; readonly pending_enable?: boolean };
  /** The authority accepted a queued enable: turn the connector on now (logs, never throws). */
  enablePending(id: ConnectorId): void;
}

/** Wait after the authority refused a slot for a connector enabled locally (a legacy install past the plan). */
const REFUSED_RETRY_MS = 60 * 60_000;

/** Whether the chain says `connector` is enabled on this node. */
export function slotHeld(core: Core, id: ConnectorId): boolean {
  return core.roster.integrations?.get(id)?.has(core.nodeId) === true;
}

/**
 * Sets this node's slot for `id` on the chain: appended here on the authority (402 `plan_limit` past
 * the plan), else a roster request (`{queued}` while the authority is unreachable; a relayed refusal
 * throws the same 402). A slot already as wanted is a no-op.
 */
export async function setIntegrationSlot(d: SlotDeps, id: ConnectorId, enabled: boolean): Promise<SubmitResult> {
  const core = d.core;
  if (slotHeld(core, id) === enabled) return { event: null };
  const body = { connector: id, node: core.nodeId, enabled };
  if (core.isAuthority()) return { event: core.emit("team.integration", body) };
  if (!d.client || !d.catchUp) throw new Error("no peer client: this node can't reach the roster authority");
  return submitRequest(core, d.client, d.catchUp, "team.integration", body);
}

/**
 * Keeps this node's chain slots in line with its settings: a connector enabled locally without a slot
 * (a pre-F3 install, or a slot lost with a re-init) asks for one; a disabled one still holding a slot
 * releases it; a `pending_enable` connector whose slot arrived is turned on. Runs at startup and once
 * a minute; a refusal is retried after an hour.
 */
export class IntegrationSlots {
  private readonly refusedUntil = new Map<ConnectorId, number>();

  constructor(private readonly d: SlotDeps, private readonly local: SlotSettings, private readonly log: Logger) {}

  async reconcile(): Promise<void> {
    const core = this.d.core;
    if (!core.teamId || !core.me()) return;
    for (const id of CONNECTOR_IDS) {
      const s = this.local.settings(id);
      const held = slotHeld(core, id);
      if (s.pending_enable) {
        if (held) this.local.enablePending(id);
        continue; // the queued request is retried by the sync rounds
      }
      const want = s.enabled === true;
      if (want === held || (want && (this.refusedUntil.get(id) ?? 0) > Date.now())) continue;
      try {
        await setIntegrationSlot(this.d, id, want);
        this.refusedUntil.delete(id);
      } catch (err) {
        this.refusedUntil.set(id, Date.now() + REFUSED_RETRY_MS);
        this.log.warn("integration_slot_refused", { connector: id, enabled: want, err: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}
