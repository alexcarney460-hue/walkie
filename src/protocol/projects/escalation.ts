// WALK-73: who a project asks to resolve a dispute. No imports: the dashboard can bundle this file as it is.

const HANDLE = /^[a-z][a-z0-9-]{0,23}$/;
const MACHINE = /^[a-z0-9][a-z0-9.-]{0,62}$/;

/** A person address (`@handle` or `@handle/machine`). An agent address is not one. */
export function isEscalationContact(v: string): boolean {
  if (!v.startsWith("@")) return false;
  const parts = v.slice(1).split("/");
  if (parts.length < 1 || parts.length > 2) return false;
  if (!HANDLE.test(parts[0] ?? "")) return false;
  if (parts.length === 2 && !MACHINE.test(parts[1] ?? "")) return false;
  return true;
}

/** The project's escalation contact, or "" when unset. A view from before the field existed has none. */
export function escalationContactOf(p: { escalation_contact?: unknown }): string {
  const v = p.escalation_contact;
  return typeof v === "string" && isEscalationContact(v) ? v : "";
}

/**
 * Why this person may not change a project's escalation contact, or null when they may: its creator (while still a
 * member) and the team's owners, as people. An agent is refused wherever the request arrives.
 */
export function escalationContactDenial(role: string | null | undefined, handle: string | null | undefined, creator: string): string | null {
  if (role === "observer") return "observers can't change a project's escalation contact";
  if (role === "owner" || (role === "member" && !!handle && handle === creator)) return null;
  return "only the project's creator or an owner can change its escalation contact";
}
