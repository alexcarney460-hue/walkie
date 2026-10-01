// WALK-67 lane 8, round 2: what GET /v1/ssh/status calls the SSH server. On macOS that is Walkie's own service
// (dev.walkie.sshd, 127.0.0.1:22022, src/daemon/ssh/macos-service.ts): an SSH banner on that port, and nothing else.
// Remote Login (port 22, `systemsetup`) is never consulted or opened: Walkie does not need it. On Linux and WSL the
// server is the machine's own on 127.0.0.1:22, as before. Stubbed probes, plus real loopback sockets for the banner.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MACOS_SSH_PORT, realServerProbe, sshServerStatus, sshServicePort, type ServerProbeDeps } from "../../src/daemon/ssh/server.ts";

type Answer = Awaited<ReturnType<ServerProbeDeps["connect"]>>;
function probe(over: { platform?: NodeJS.Platform; answer?: Answer } = {}) {
  const calls = { connect: [] as Array<{ port: number; wantBanner: boolean }> };
  const deps: ServerProbeDeps = {
    platform: over.platform ?? "darwin",
    connect: async (port, wantBanner) => { calls.connect.push({ port, wantBanner }); return over.answer ?? { state: "connected", banner: "SSH-2.0-OpenSSH_10.2\r\n" }; },
  };
  return { deps, calls };
}

describe("which port is the SSH server on", () => {
  test("Walkie's own service on macOS (22022, never Remote Login's 22); the machine's own SSH server everywhere else", () => {
    expect(MACOS_SSH_PORT).toBe(22022);
    expect(sshServicePort("darwin")).toBe(22022);
    expect(sshServicePort("linux")).toBe(22);
    expect(sshServicePort("win32")).toBe(22);
    expect(sshServicePort()).toBe(process.platform === "darwin" ? 22022 : 22);
  });
});

describe("macOS: an SSH banner on 127.0.0.1:22022", () => {
  test("the status connects to 22022 and asks for the banner, and never to 22", async () => {
    const { deps, calls } = probe();
    const r = await sshServerStatus(undefined, deps);
    expect(r.enabled).toBe(true);
    expect(r.detail).toContain("127.0.0.1:22022");
    expect(calls.connect).toEqual([{ port: 22022, wantBanner: true }]);
  });
  test("it never consults or opens Remote Login: nothing in the probe's contract can", async () => {
    const hostile = { ...probe().deps, systemsetup: () => { throw new Error("systemsetup must never be run"); } } as ServerProbeDeps;
    expect((await sshServerStatus(undefined, hostile)).enabled).toBe(true);
    expect(Object.keys(probe().deps).sort()).toEqual(["connect", "platform"]);
  });
  test("nothing listening, a hung port, a listener that is not SSH, and a silent one are each NOT enabled, and say whose service it is", async () => {
    for (const answer of [
      { state: "refused", banner: "" }, { state: "timeout", banner: "" },
      { state: "connected", banner: "HTTP/1.1 400 Bad Request\r\n" }, { state: "connected", banner: "" },
    ] as Answer[]) {
      const r = await sshServerStatus(undefined, probe({ answer }).deps);
      expect([answer.state, answer.banner, r.enabled]).toEqual([answer.state, answer.banner, false]);
      expect(r.detail).toContain("Walkie's SSH service");
      expect(r.detail).not.toContain("Remote Login");
    }
  });
  test("an explicit port is honoured (the tests' stand-in sshd)", async () => {
    const { deps, calls } = probe();
    await sshServerStatus(54321, deps);
    expect(calls.connect[0]!.port).toBe(54321);
  });
});

describe("Linux and WSL: the server answers on 127.0.0.1:22, nothing else is asked", () => {
  test("connected is enabled, refused or hung is not", async () => {
    const on = probe({ platform: "linux", answer: { state: "connected", banner: "" } });
    expect((await sshServerStatus(undefined, on.deps)).enabled).toBe(true);
    expect(on.calls.connect).toEqual([{ port: 22, wantBanner: false }]);
    expect(await sshServerStatus(undefined, probe({ platform: "linux", answer: { state: "refused", banner: "" } }).deps)).toEqual({ enabled: false, detail: "no SSH server on 127.0.0.1" });
    expect(await sshServerStatus(undefined, probe({ platform: "linux", answer: { state: "timeout", banner: "" } }).deps)).toEqual({ enabled: false, detail: "SSH server probe timed out" });
  });
});

describe("the real loopback probe", () => {
  const servers: Array<{ stop(force?: boolean): void }> = [];
  afterEach(() => { for (const s of servers) s.stop(true); servers.length = 0; });
  const listen = (greeting: string | null) => {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(s) { if (greeting !== null) s.write(greeting); }, data() {}, close() {}, error() {} } });
    servers.push(server);
    return server.port;
  };
  const darwin: ServerProbeDeps = { ...realServerProbe, platform: "darwin" };

  test("a listener that sends an SSH banner is the SSH service; one that sends nothing or something else is not", async () => {
    expect((await sshServerStatus(listen("SSH-2.0-test\r\n"), darwin)).enabled).toBe(true);
    expect((await sshServerStatus(listen("HTTP/1.1 400 no\r\n"), darwin)).enabled).toBe(false);
    expect((await sshServerStatus(listen(null), darwin)).enabled).toBe(false);
  });
  test("a closed port is not enabled", async () => {
    const closed = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {}, close() {}, error() {} } });
    const port = closed.port;
    closed.stop(true);
    expect((await sshServerStatus(port, darwin)).enabled).toBe(false);
    expect((await sshServerStatus(port, { ...realServerProbe, platform: "linux" })).enabled).toBe(false);
  });
  test("on Linux any listener that accepts a connection is enough, as before", async () => {
    expect((await sshServerStatus(listen(null), { ...realServerProbe, platform: "linux" })).enabled).toBe(true);
  });
});

describe("review finding F10: the status never blocks the daemon's main thread", () => {
  test("while the probe waits for a silent listener the event loop keeps running", async () => {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() {}, data() {}, close() {}, error() {} } });
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 10);
    const started = Date.now();
    try {
      expect((await sshServerStatus(server.port, { ...realServerProbe, platform: "darwin" })).enabled).toBe(false);
    } finally { clearInterval(timer); server.stop(true); }
    expect(Date.now() - started).toBeGreaterThanOrEqual(300); // it really waited for a banner that never came
    expect(ticks).toBeGreaterThanOrEqual(15); // and the loop ran the whole time (a blocking probe leaves it at about 0)
  });
  test("nothing the status route runs spawns a process synchronously", () => {
    for (const file of ["routes.ts", "server.ts", "tunnel.ts", "state.ts", "authorized-keys.ts"]) {
      const text = readFileSync(join(import.meta.dir, "../../src/daemon/ssh", file), "utf8");
      expect(text, file).not.toMatch(/spawnSync|execSync|execFileSync/);
    }
  });
});
