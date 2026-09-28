// The daemon's read-only view of this machine's vault (ACCOUNTS-2): opened on first use, and only once vault.db exists
// (the daemon never creates a vault; `walkie accounts add` does).
import type { VaultSource } from "../service.ts";
import { Vault } from "./vault.ts";

export function lazyVault(walkieHome: string): VaultSource & { get(): Vault | null } {
  let vault: Vault | null = null;
  const get = (): Vault | null => {
    if (!vault && Vault.exists(walkieHome)) vault = Vault.open(walkieHome);
    return vault;
  };
  return {
    get,
    list: () => get()?.list() ?? [],
    claudeToken: async (id) => {
      const v = get();
      if (!v) throw new Error("no vault on this machine");
      return v.claudeToken(id);
    },
  };
}
