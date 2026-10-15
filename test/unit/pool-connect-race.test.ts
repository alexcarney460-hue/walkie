import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../src/daemon/logger.ts";
import { PoolConnections } from "../../src/pool/run/connect.ts";

test("disconnect does not remove a replacement connection made while closing the old one", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pool-connect-")));
  let conns!: PoolConnections;
  let reconnect: ReturnType<PoolConnections["connect"]> | null = null;
  let replace = false;
  let connects = 0;
  conns = new PoolConnections({
    home, log: createLogger({}), hostnameOf: (node) => node,
    changed: () => {
      if (replace) {
        replace = false;
        reconnect = conns.connect("peer1");
      }
    },
    serve: async (_node, body) => body.action === "connect"
      ? { ok: true, id: String(++connects).padStart(32, "0"), key: "k".repeat(48), model: { name: "M", id: "llama-3.2-3b", quant: "q4" }, lease_ms: 45_000 }
      : { ok: true },
    tunnel: async () => { throw new Error("fixture tunnel unavailable"); },
  });
  try {
    await conns.connect("peer1");
    replace = true;
    await conns.disconnect("peer1");
    expect(reconnect).not.toBeNull();
    const fresh = await reconnect!;
    expect(conns.view()).toEqual([fresh]);
    expect(existsSync(fresh.api_key_file)).toBe(true);
    expect((await fetch(fresh.endpoint)).status).toBe(502);
  } finally {
    await conns.stopAll();
    rmSync(home, { recursive: true, force: true });
  }
});
