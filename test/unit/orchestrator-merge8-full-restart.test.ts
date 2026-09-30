import { expect, test } from "bun:test";
import { liveMonitorPids, rig6, teardown, waitFor } from "./orchestrator-merge7-setup.ts";

for (const fails of [false, true]) {
  test(`full restart waits for old uid destroy (${fails ? "failed" : "verified"})`, async () => {
    const r = await rig6({ destroyMs: 4_000 });
    try {
      await r.alex.client("").orchestratorStart({ access: "full" });
      const host = r.host();
      await waitFor(() => host.child?.alive && host.shellUser.active, { what: "shell child" });
      const original = r.helper.fn;
      let destroyEnd = 0;
      let createStart = 0;
      const wrapped = async (verb: "talkie-create" | "talkie-destroy" | "talkie-reconcile", generation?: string, who?: string) => {
        if (verb === "talkie-create") createStart ||= Date.now();
        const result = await original(verb, generation, who);
        if (verb === "talkie-destroy" && who !== "monitor") destroyEnd ||= Date.now();
        return result;
      };
      r.helper.fn = wrapped;
      const deps = host.shellUser.deps;
      deps.admin = async (verb: "talkie-create" | "talkie-destroy" | "talkie-reconcile", generation?: string) => {
        const result = await wrapped(verb, generation);
        return result ?? { ok: true, name: "walkie-talkie", uid: 550_000, home: `${r.root}/walkie-talkie`,
          ...(generation ? { generation } : {}) };
      };
      r.timing.destroyFail = fails;
      await r.alex.client("").orchestratorStart({ access: "full", model: "sonnet" }).catch(() => undefined);
      expect(destroyEnd).toBeGreaterThan(0);
      if (createStart) expect(createStart).toBeGreaterThanOrEqual(destroyEnd);
    } finally {
      await teardown(r);
      expect(liveMonitorPids(r)).toEqual([]);
    }
  }, 30_000);
}
