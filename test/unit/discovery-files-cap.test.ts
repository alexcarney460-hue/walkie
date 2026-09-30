import { expect, test } from "bun:test";
import { DiscoveryFiles } from "../../src/daemon/discovery-files.ts";

const blocked = new URL("../fixtures/discovery-files/blocked-worker.ts", import.meta.url);
const serial = new URL("../fixtures/discovery-files/serial-worker.ts", import.meta.url);

test("eight timed-out scans keep one blocked worker at most", async () => {
  let constructed = 0;
  const warnings: string[] = [];
  const files = new DiscoveryFiles(false, { info: () => {}, warn: (message) => { warnings.push(message); } }, {
    retryBaseMs: 20,
    spawn: () => { constructed++; return new Worker(blocked); },
  });
  try {
    for (let i = 0; i < 8; i++) {
      expect(await files.repoContext("/blocked", Date.now() + 100)).toBeNull();
    }
    await Bun.sleep(500);
    expect(constructed).toBe(1);
    expect(warnings).toContain("agent_discovery_worker_unavailable");
  } finally { files.close(); }
}, 10_000);

test("operation timeout warns and honors retry backoff", async () => {
  let constructed = 0;
  const warnings: string[] = [];
  const files = new DiscoveryFiles(false, { info: () => {}, warn: (message) => { warnings.push(message); } }, {
    retryBaseMs: 200,
    spawn: () => { constructed++; return new Worker(serial); },
  });
  try {
    expect(await files.repoContext("/stuck", Date.now() + 2_000)).toBeNull();
    await Bun.sleep(50);
    expect(constructed).toBe(1);
    expect(warnings).toContain("agent_discovery_worker_unavailable");
    await Bun.sleep(250);
    expect(constructed).toBe(2);
  } finally { files.close(); }
}, 10_000);
