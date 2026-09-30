let queue = Promise.resolve();
globalThis.onmessage = (event: MessageEvent<{ id: number; op: string; args: unknown[] }>) => {
  const { id, op, args } = event.data;
  queue = queue.then(async () => {
    postMessage({ id, started: true });
    if (op === "policy") { postMessage({ id, value: null }); return; }
    if (op === "repoContext") {
      if (args[0] === "/stuck") await new Promise(() => {});
      await Bun.sleep(200);
      postMessage({ id, value: { repo: String(args[0]), cwd: String(args[0]) } });
      return;
    }
    postMessage({ id, value: null });
  });
};
