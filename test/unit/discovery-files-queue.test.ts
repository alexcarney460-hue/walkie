import { expect, test } from "bun:test";
import { DiscoveryFiles } from "../../src/daemon/discovery-files.ts";

const fixture = new URL("../fixtures/discovery-files/serial-worker.ts", import.meta.url);

test("six healthy serial reads each get their own 500 ms of service", async () => {
  let constructed = 0;
  const files = new DiscoveryFiles(false, undefined, { spawn: () => { constructed++; return new Worker(fixture); } });
  try {
    const deadline = Date.now() + 5_000;
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => files.repoContext(`/repo-${i}`, deadline)));
    expect(results.map((row) => row?.repo)).toEqual(Array.from({ length: 6 }, (_, i) => `/repo-${i}`));
    expect(constructed).toBe(1);
  } finally { files.close(); }
}, 10_000);

test("one stuck read is replaced and queued reads run on its successor", async () => {
  let constructed = 0;
  const files = new DiscoveryFiles(false, undefined, { retryBaseMs: 20,
    spawn: () => { constructed++; return new Worker(fixture); } });
  try {
    const deadline = Date.now() + 5_000;
    const [stuck, next] = await Promise.all([
      files.repoContext("/stuck", deadline), files.repoContext("/next", deadline),
    ]);
    expect(stuck).toBeNull();
    expect(next?.repo).toBe("/next");
    expect(constructed).toBe(2);
  } finally { files.close(); }
}, 10_000);
