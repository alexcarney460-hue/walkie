// `walkie claude [args…]` / `walkie codex [args…]` (ACCOUNTS-2): the real CLI on the vault account with the most
// room; when that account hits its limit, the session resumes on an account with room (src/switch/wrapper.ts). The arguments are the CLI's own,
// passed through unparsed by Walkie.
import { walkieHomeDir } from "../../accounts/vault/vault.ts";
import { SystemProcessProvider } from "../../daemon/procs.ts";
import { defaultSource } from "../../switch/accounts.ts";
import { rolloutsIn } from "../../switch/watch.ts";
import { spawnInherit } from "../../switch/launch.ts";
import { realCli } from "../../switch/shims.ts";
import { runWrapped, type Provider } from "../../switch/wrapper.ts";
import { thresholdPct } from "./vault.ts";

/** A tuning knob from the environment (ms), within bounds; null when unset or invalid. */
function ms(v: string | undefined, min: number, max: number): number | null {
  const n = Number(v);
  return v && Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/**
 * A switcher failure must never cost the user their CLI: if anything goes wrong before a session was started (an
 * unreadable vault, a locked key store…), the real CLI runs unchanged, with one line saying why.
 */
export async function wrap(provider: Provider, args: string[]): Promise<number> {
  const home = walkieHomeDir();
  let launched = 0;
  const spawn: typeof spawnInherit = (o) => { launched++; return spawnInherit(o); };
  try {
    return await wrapWith(provider, args, home, spawn);
  } catch (err) {
    if (launched > 0) throw err;
    const real = realCli(provider, home);
    if (!real) throw err;
    process.stderr.write(`walkie: account switching is off for this run (${(err as Error).message.slice(0, 200)}); running ${provider} directly\n`);
    const { WALKIE_SHIM_ACTIVE: _a, ...env } = process.env;
    const child = spawnInherit({ argv: [real, ...args], env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined)), cwd: process.cwd() });
    const ignore = () => undefined;
    process.on("SIGINT", ignore);
    try { return await child.exited; } finally { process.off("SIGINT", ignore); }
  }
}

async function wrapWith(provider: Provider, args: string[], home: string, spawn: typeof spawnInherit): Promise<number> {
  const procs = new SystemProcessProvider();
  return runWrapped({
    provider, args, walkieHome: home, env: process.env, cwd: process.cwd(), source: defaultSource(home), spawn,
    thresholdPct: thresholdPct(home),
    ...(ms(process.env.WALKIE_SWITCH_SETTLE_MS, 0, 60_000) !== null ? { settleMs: ms(process.env.WALKIE_SWITCH_SETTLE_MS, 0, 60_000) as number } : {}),
    openRollout: async (pid) => {
      const open = pid > 0 ? await procs.openFiles(pid) : null;
      return open ? rolloutsIn(open) : null;
    },
  });
}
