globalThis.onmessage = (event: MessageEvent<{ id: number; op: string }>) => {
  const { id, op } = event.data;
  postMessage({ id, started: true });
  if (op === "policy") { postMessage({ id, value: null }); return; }
  if (op === "repoContext") {
    // A synchronous child models a worker blocked inside a filesystem syscall.
    Bun.spawnSync(["sleep", "3"]);
    postMessage({ id, value: { repo: "late" } });
  }
};
