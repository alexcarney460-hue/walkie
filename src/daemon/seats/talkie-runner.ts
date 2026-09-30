// Fixed sudo target for the dedicated WalkieTalkie user. The daemon sends one bounded JSON header on stdin,
// then Claude's stream-json input. The runner never reads the person's Walkie home or credentials.
import { z } from "zod";
import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TALKIE_UID } from "./talkie-user.ts";

const Header = z.object({ argv: z.array(z.string()).min(1).max(100), cwd: z.string().min(1), env: z.record(z.string(), z.string()) }).strict();
const HEADER_MAX = 1024 * 1024;

export async function runTalkieRunner(input: ReadableStream<Uint8Array> = Bun.stdin.stream()): Promise<number> {
  if (process.getuid?.() !== TALKIE_UID) return 2;
  const reader = input.getReader();
  const decoder = new TextDecoder();
  let pending = new Uint8Array(0);
  let header: z.infer<typeof Header>;
  try {
    for (;;) {
      const line = pending.indexOf(10);
      if (line >= 0) {
        if (line > HEADER_MAX) return 2;
        header = Header.parse(JSON.parse(decoder.decode(pending.subarray(0, line))));
        pending = pending.subarray(line + 1);
        break;
      }
      if (pending.byteLength > HEADER_MAX) return 2;
      const next = await reader.read();
      if (next.done) return 2;
      const joined = new Uint8Array(pending.byteLength + next.value.byteLength);
      joined.set(pending); joined.set(next.value, pending.byteLength); pending = joined;
    }
  } catch { return 2; }
  let child: ReturnType<typeof Bun.spawn>;
  const env = { ...header!.env };
  const accessToken = env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const config = env.CLAUDE_CONFIG_DIR;
  const credentials = config ? join(config, ".credentials.json") : null;
  let projected = false;
  try {
    if (accessToken && credentials) {
      mkdirSync(config!, { recursive: true, mode: 0o700 });
      const st = lstatSync(config!);
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)
        throw new Error("Claude config directory is not private to the dedicated user");
      rmSync(credentials, { force: true });
      writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken } }), { mode: 0o600, flag: "wx" });
      projected = true;
    }
    child = Bun.spawn(header!.argv, { cwd: header!.cwd, env, stdin: "pipe", stdout: "inherit", stderr: "inherit", detached: true });
  } catch { if (projected && credentials) rmSync(credentials, { force: true }); return 2; }
  const terminate = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } } };
  process.on("SIGTERM", terminate);
  const feed = (async () => {
    const sink = child.stdin as import("bun").FileSink;
    try {
      if (pending.byteLength) sink.write(pending);
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        sink.write(next.value);
        await sink.flush();
      }
    } catch { /* the child ended */ }
    finally { try { sink.end(); } catch { /* ended */ } terminate(); }
  })();
  const code = await child.exited;
  terminate();
  if (projected && credentials) rmSync(credentials, { force: true });
  void feed;
  process.off("SIGTERM", terminate);
  return code ?? 1;
}
