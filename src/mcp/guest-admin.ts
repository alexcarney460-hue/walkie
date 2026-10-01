import { GUEST_TOOLS, guestEligible, type GuestData } from "./guest-scope.ts";
import { GuestRegistry, type GuestInput } from "./guest-registry.ts";

export type GrantRequest = Omit<GuestInput, "owner" | "node">;

/** The person's grant can bind only to cards already assigned to this exact cloud address. */
export function grantGuest(registry: GuestRegistry, data: Pick<GuestData, "card" | "project">,
  owner: string, node: string, request: GrantRequest, ttlMs: number) {
  if (!request.tools.length || request.tools.some((name) => !GUEST_TOOLS.includes(name))) throw new Error("guest tools must be allowed guest tools");
  const address = `@${owner}/cloud/${request.family}-${request.name}`;
  if (!request.cardIds.length || request.cardIds.some((id) => {
    const card = data.card(id);
    return !card || !guestEligible({ address }, card, data.project(card.channel));
  })) throw new Error("every bound card must be assigned, public and safe for this guest");
  return registry.issue({ ...request, owner, node }, ttlMs);
}
