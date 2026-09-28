// AGENT-ADMIN-1 fix round 2: a remote admin run's walkie (the target daemon runs it with WALKIE_ADMIN_TOKEN and
// WALKIE_AGENT=remote-admin) takes both out of its environment at start, so nothing it spawns (sudo, codex, claude,
// llama.cpp, a seat) inherits them; the client and agent detection read them from here instead.
export const REMOTE_AGENT = "remote-admin";

let token: string | null = null;

/** Adopts (and removes from `env`) a remote run's token; a stray WALKIE_AGENT=remote-admin without one is left alone. */
export function adoptRemoteRun(env: NodeJS.ProcessEnv = process.env): void {
  const t = env.WALKIE_ADMIN_TOKEN;
  delete env.WALKIE_ADMIN_TOKEN;
  if (!t || !/^[0-9a-f]{48}$/.test(t) || env.WALKIE_AGENT !== REMOTE_AGENT) return;
  token = t;
  delete env.WALKIE_AGENT;
}

/** This process's remote run token, or null (not a remote admin run). */
export function remoteRunToken(): string | null {
  return token;
}

/** Tests only: forget an adopted token (the module is shared by every test in one bun process). */
export function resetRemoteRunForTests(): void {
  token = null;
}
