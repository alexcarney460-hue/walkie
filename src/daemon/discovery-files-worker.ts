// Scan filesystem work runs here so a stalled local or network filesystem cannot block daemon timers.
import { repoContext } from "../agent/identity.ts";
import { readSmallFile } from "../agent/safe-read.ts";
import { join } from "node:path";
import { SessionFiles } from "./activity.ts";
import { containedWire, listKimiSessions, ScanBudget } from "./kimi-sessions.ts";
import type { HookState } from "./discovery-files.ts";
import { readClaudeSession } from "./procs.ts";

let files = new SessionFiles();

type Request = { id: number; op: string; args: unknown[] };

globalThis.onmessage = async (event: MessageEvent<Request>) => {
  const { id, op, args } = event.data;
  postMessage({ id, started: true });
  try {
    let value: unknown;
    switch (op) {
      case "policy": files = new SessionFiles({ detail: args[0] as boolean }); value = null; break;
      case "retain": files.retain(new Set(args[0] as string[])); value = null; break;
      case "repoContext": value = repoContext(args[0] as string); break;
      case "listKimiSessions": value = listKimiSessions(args[0] as string, args[1] as string,
        args[2] as number | null, new ScanBudget(args[3] as number, args[4] as number)); break;
      case "containedWire": value = containedWire(args[0] as Parameters<typeof containedWire>[0]); break;
      case "claudeTranscript": value = files.claudeTranscript(args[0] as string, args[1] as string | undefined, args[2] as string, args[3] as number); break;
      case "openFile": value = files.openFile(args[0] as string); break;
      case "kimiFile": value = files.kimiFile(args[0] as string, args[1] as string); break;
      case "read": value = files.read(args[0] as string, args[1] as Parameters<SessionFiles["read"]>[1], args[2] as string); break;
      case "subagentsMtime": value = files.subagentsMtime(args[0] as string); break;
      case "firstPrompt": value = files.firstPrompt(args[0] as string, args[1] as Parameters<SessionFiles["firstPrompt"]>[1]); break;
      case "hookStates": value = hookStates(args[0] as string, args[1] as string[]); break;
      case "claudeSession": {
        const [pid, configDir] = args;
        if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || typeof configDir !== "string" || !configDir.startsWith("/")) {
          throw new Error("invalid Claude session record target");
        }
        value = await readClaudeSession(pid as number, configDir);
        break;
      }
      default: throw new Error(`unknown discovery file operation: ${op}`);
    }
    postMessage({ id, value });
  } catch (error) {
    postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};

function hookStates(home: string, agents: readonly string[]): Record<string, HookState> {
  const states: Record<string, HookState> = {};
  for (const agent of agents) {
    if (!/^[a-z0-9][a-z0-9._-]{0,47}$/.test(agent) || agent.includes("..")) continue;
    const text = readSmallFile(join(home, "agents", `${agent}.json`), 64 * 1024);
    if (text === null) continue;
    try {
      const row = JSON.parse(text) as Record<string, unknown>;
      const str = (value: unknown) => typeof value === "string" ? value : undefined;
      states[agent] = { title: str(row.title), title_src: str(row.title_src), task: str(row.task), task_src: str(row.task_src) };
    } catch { /* malformed hook state does not supply provenance */ }
  }
  return states;
}
