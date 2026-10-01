// Remove files from the retired hook-side ledger. Called only for a daemon's explicit home.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export function removeLegacyHermesFiles(home: string): void {
  const legacy = /^(?:hermes-sessions\.json|hermes-pending|hermes-sessions\.lock(?:\.recovery|\.stale-[a-f0-9-]{36})?)$/;
  for (const name of readdirSync(home)) {
    if (legacy.test(name)) rmSync(join(home, name), { recursive: true, force: true });
  }
}
