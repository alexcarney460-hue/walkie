import type { AccountView } from "../../api/types.ts";
import { planTone } from "../../lib/plan.ts";
import type { useStore } from "../../state/store.tsx";
import { displayState } from "../../../../src/protocol/accounts-format.ts";

type Store = ReturnType<typeof useStore>;

export function loginNeeds(accounts: readonly AccountView[], handle: string | null, now: number): number {
  return accounts.reduce((total, account) => total + (Array.isArray(account.owners) && Array.isArray(account.machines)
    ? account.machines.filter((machine) => machine && machine.handle === handle && displayState(machine.usage, now) === "relogin").length
    : 0), 0);
}

export function settingsWarnings(store: Store, now: number, pending: number): Record<string, boolean> {
  const plan = store.team?.plan ?? store.me?.plan;
  return {
    team: store.me?.role === "owner" && pending > 0 || !!plan && planTone(plan) === "amber",
    agents: store.nodes.some((node) => !node.online),
    accounts: loginNeeds(store.accounts, store.me?.handle ?? null, now) > 0,
  };
}

export function settingsWarning(store: Store, now: number, pending = 0): boolean {
  return Object.values(settingsWarnings(store, now, pending)).some(Boolean);
}
