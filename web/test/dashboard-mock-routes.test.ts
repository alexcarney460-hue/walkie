import { expect, test } from "bun:test";
import { join } from "node:path";

/** Exercise the real mock handler in a child process; a sandbox may refuse even an ephemeral listener. */
async function routes(paths: string[], capture = false): Promise<Record<string, { status: number; body: Record<string, any> }>> {
  const script = `
    const { mockFetch } = await import("./web/mock/server.ts");
    const paths = JSON.parse(process.env.MOCK_TEST_PATHS ?? "[]");
    const rows = {};
    for (const path of paths) {
      const response = await mockFetch(new Request("http://127.0.0.1" + path));
      rows[path] = { status: response.status, body: await response.json() };
    }
    process.stdout.write(JSON.stringify(rows));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...process.env, MOCK_TEST_PATHS: JSON.stringify(paths), ...(capture ? { WALKIE_MOCK_CAPTURE: "1" } : {}) },
    stdout: "pipe", stderr: "pipe",
  });
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`mock handler exited ${code}: ${errors}`);
  return JSON.parse(output) as Record<string, { status: number; body: Record<string, any> }>;
}

test("dashboard mock handles Agents, Seats and Talkie conversation and schedule GET routes", async () => {
  const paths = ["/v1/guests", "/v1/orchestrator", "/v1/pool/models", "/v1/admin?limit=5",
    "/v1/orchestrator/messages", "/v1/orchestrator/schedules", "/v1/orchestrator/schedules/next?cron=0%20*%20*%20*%20*"];
  const result = await routes(paths);
  for (const path of paths) expect(result[path]?.status).toBe(200);
  expect(result["/v1/guests"]?.body.guests).toEqual([]);
  expect(result["/v1/orchestrator"]?.body.local.state).toBe("stopped");
  expect(result["/v1/orchestrator/messages"]?.body.messages).toHaveLength(2);
  expect(result["/v1/orchestrator/messages"]?.body.messages[0].role).toBe("person");
  expect(result["/v1/orchestrator/messages"]?.body.messages[1].role).toBe("orchestrator");
  expect(result["/v1/pool/models"]?.body.catalog.models.length).toBeGreaterThan(0);
  expect(result["/v1/admin?limit=5"]?.body.audit).toEqual([]);
  const schedule = result["/v1/orchestrator/schedules"]?.body;
  expect(schedule?.status).toBeNull();
  expect(schedule?.schedules).toHaveLength(1);
  expect(schedule?.schedules[0].name).toBe("Project check-in");
  expect(result["/v1/orchestrator/schedules/next?cron=0%20*%20*%20*%20*"]?.body.times).toHaveLength(3);
});

test("mock server starts on a socket and serves a dashboard route", async () => {
  const child = Bun.spawn([process.execPath, "mock/server.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, WALKIE_MOCK_PORT: "0" },
    stdout: "pipe", stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  try {
    const address = await Promise.race([
      (async () => {
        let output = "";
        while (!output.includes("\n")) {
          const part = await reader.read();
          if (part.done) {
            const errors = await new Response(child.stderr).text();
            throw new Error(`mock server exited before listening: ${errors || output}`);
          }
          output += new TextDecoder().decode(part.value);
        }
        const port = output.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[1];
        if (!port) throw new Error(`mock server did not print its address: ${output}`);
        return `http://127.0.0.1:${port}`;
      })(),
      Bun.sleep(5_000).then(() => { throw new Error("mock server did not listen within 5 seconds"); }),
    ]);
    const response = await fetch(`${address}/v1/orchestrator/schedules`);
    expect(response.status).toBe(200);
    expect((await response.json() as { schedules: unknown[] }).schedules).toHaveLength(1);
  } finally {
    child.kill();
    await child.exited;
    await reader.cancel().catch(() => undefined);
  }
});

test("dashboard mock accepts Talkie actions without a listening socket", async () => {
  const script = `
    const { mockFetch } = await import("./web/mock/server.ts");
    const call = async (path, value) => {
      const response = await mockFetch(new Request("http://127.0.0.1" + path, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
      }));
      return { status: response.status, body: await response.json() };
    };
    const start = await call("/v1/orchestrator/start", { access: "platform" });
    const say = await call("/v1/orchestrator/say", { text: "What needs review?" });
    const access = await call("/v1/orchestrator/access", { access: "full" });
    const schedule = await call("/v1/orchestrator/schedules", { name: "Morning review", cron: "0 9 * * *", task: { template: "project-reports" } });
    process.stdout.write(JSON.stringify({ start, say, access, schedule }));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" });
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`mock handler exited ${code}: ${errors}`);
  const result = JSON.parse(output) as Record<string, { status: number; body: Record<string, any> }>;
  for (const row of Object.values(result)) expect(row.status).toBe(200);
  expect(result.start?.body.local.running).toBe(true);
  expect(result.say?.body.message.text).toBe("What needs review?");
  expect(result.access?.body.local.access).toBe("full");
  expect(result.schedule?.body.schedule.name).toBe("Morning review");
});

test("capture-only mock reports the installer version and open seat hosts", async () => {
  const result = await routes(["/v1/me", "/v1/team", "/v1/seats"], true);
  const me = result["/v1/me"]?.body;
  const team = result["/v1/team"]?.body;
  const seats = result["/v1/seats"]?.body;
  expect(me?.version).toBe("0.2.0-pre.15");
  expect(team?.nodes.every((node: { stats?: { sys?: { version?: string } } }) => node.stats?.sys?.version === me.version)).toBe(true);
  expect(team?.nodes.every((node: { online: boolean }) => node.online)).toBe(true);
  expect(seats?.hosts.every((host: { allows: boolean; availability?: { max?: number } }) => host.allows && host.availability?.max === 4)).toBe(true);
});
