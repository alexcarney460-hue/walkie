// Seats options for a test node that must never see this machine's login Keychain or home (standing rule, enforced by
// test/helpers/keychain-guard.ts): the Keychain answers "no item", and the seats' environment is a temp HOME (a
// leading `~/` and the Claude and Codex logins resolve there, never in the developer's real home).
import { mkdirSync } from "node:fs";
import type { SeatsOptions } from "../../src/daemon/seats/host.ts";

export function noKeychainSeats(home: string, extra: SeatsOptions = {}): SeatsOptions {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return { keychain: async () => null, ...extra, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...extra.env, HOME: home } };
}
