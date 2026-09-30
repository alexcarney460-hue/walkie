globalThis.onmessage = async (event: MessageEvent<{ id: number; op: string; args: unknown[] }>) => {
  const { id, op, args } = event.data;
  postMessage({ id, started: true });
  if (op === "repoContext" || op === "read") await Bun.sleep(120);
  const value = op === "repoContext" ? { repo: "walkie", cwd: args[0] }
    : op === "hookStates" ? {} : null;
  postMessage({ id, value });
};
