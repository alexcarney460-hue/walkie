import { expect, test } from "bun:test";
import { join } from "node:path";

test("dashboard mock serves Mission Control and Seats GET routes", async () => {
  const child = Bun.spawn([process.execPath, "web/mock/server.ts"], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...process.env, WALKIE_MOCK_PORT: "0" },
    stdout: "pipe", stderr: "pipe",
  });
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    const output = new TextDecoder().decode(first.value);
    const port = /:(\d+)/.exec(output)?.[1];
    if (!port) throw new Error(`mock port missing: ${output}`);
    const expected: Record<string, (body: Record<string, any>) => void> = {
      "/v1/guests": (body) => { expect(body.guests).toEqual([]); expect(body.killed).toBe(false); },
      "/v1/orchestrator": (body) => { expect(body.local.running).toBe(false); expect(body.local.state).toBe("stopped"); },
      "/v1/pool/models": (body) => { expect(body.source).toBe("built-in"); expect(body.catalog.models.length).toBeGreaterThan(0); },
      "/v1/admin?limit=5": (body) => { expect(body.agent_admin).toBe(true); expect(body.remote_admin).toBe(true); expect(body.audit).toEqual([]); },
    };
    for (const [route, check] of Object.entries(expected)) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`);
      expect(response.status).toBe(200);
      check(await response.json());
    }
    reader.releaseLock();
  } finally {
    child.kill();
    await child.exited;
  }
});

test("capture-only mock reports the installer version and open seat hosts", async () => {
  const child = Bun.spawn([process.execPath, "web/mock/server.ts"], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...process.env, WALKIE_MOCK_PORT: "0", WALKIE_MOCK_CAPTURE: "1" },
    stdout: "pipe", stderr: "pipe",
  });
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    const output = new TextDecoder().decode(first.value);
    const port = /:(\d+)/.exec(output)?.[1];
    if (!port) throw new Error(`mock port missing: ${output}`);
    const base = `http://127.0.0.1:${port}`;
    const me = await (await fetch(`${base}/v1/me`)).json();
    const team = await (await fetch(`${base}/v1/team`)).json();
    const seats = await (await fetch(`${base}/v1/seats`)).json();
    expect(me.version).toBe("0.2.0-pre.15");
    expect(team.nodes.every((node: { stats?: { sys?: { version?: string } } }) => node.stats?.sys?.version === me.version)).toBe(true);
    expect(team.nodes.every((node: { online: boolean }) => node.online)).toBe(true);
    expect(seats.hosts.every((host: { allows: boolean; availability?: { max?: number } }) => host.allows && host.availability?.max === 4)).toBe(true);
    reader.releaseLock();
  } finally {
    child.kill();
    await child.exited;
  }
});
