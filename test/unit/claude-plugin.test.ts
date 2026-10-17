// The Claude Code plugin must keep calling the same hook and MCP entrypoints
// `walkie hooks install claude` writes, and its version must stay the package version.
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_EVENTS } from "../../src/hooks/install.ts";

const root = join(import.meta.dir, "../..");
const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8")) as {
  name: string;
  version: string;
  license: string;
  homepage: string;
  repository: string;
  author: { name: string };
  skills: string;
  mcpServers: Record<string, { command: string; args: string[] }>;
};
const marketplace = JSON.parse(readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8")) as {
  name: string;
  owner: { name: string };
  plugins: { name: string; source: string }[];
};
const hooksFile = JSON.parse(readFileSync(join(root, "hooks/hooks.json"), "utf8")) as {
  hooks: Record<string, { matcher?: string; hooks: { type: string; command: string; args: string[]; timeout: number }[] }[]>;
};
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string; license: string };
const INSTALL_LINE = "Sqwakie needs the walkie binary on PATH. Install: curl -fsSL https://sqwakie.si/install.sh | sh";

test("plugin metadata matches package.json, the license and the marketplace entry", () => {
  expect(plugin.name).toBe("walkie");
  expect(plugin.version).toBe(pkg.version);
  expect(plugin.license).toBe(pkg.license);
  expect(plugin.license).toBe("FSL-1.1-ALv2");
  expect(plugin.homepage).toBe("https://sqwakie.si");
  expect(plugin.repository).toBe("https://github.com/alexcarney460-hue/walkie");
  expect(plugin.author.name).toBe("RC Studios");
  expect(plugin.skills).toBe("./skills/talkie/");
  expect(marketplace.name).toBe("walkie");
  expect(marketplace.owner.name).toBe("RC Studios");
  expect(marketplace.plugins).toEqual([{ name: "walkie", source: "./" }]);
});

test("hooks.json is the CLAUDE_EVENTS list, each running walkie hook claude with the CLI timeout", () => {
  expect(Object.keys(hooksFile.hooks)).toEqual(CLAUDE_EVENTS.map((e) => e.event));
  for (const spec of CLAUDE_EVENTS) {
    const entries = hooksFile.hooks[spec.event];
    expect(entries).toHaveLength(1);
    const entry = entries![0]!;
    expect(entry.matcher).toBe(spec.matcher);
    expect(entry.hooks).toEqual([{
      type: "command",
      command: "${CLAUDE_PLUGIN_ROOT}/scripts/claude-plugin/walkie.sh",
      args: ["hook", "claude"],
      timeout: 5,
    }]);
  }
});

test("the MCP server is walkie mcp, the command installClaude registers", () => {
  expect(plugin.mcpServers).toEqual({
    walkie: {
      command: "${CLAUDE_PLUGIN_ROOT}/scripts/claude-plugin/walkie.sh",
      args: ["mcp"],
    },
  });
});

async function runLauncher(args: string[], env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn(["sh", join(root, "scripts/claude-plugin/walkie.sh"), ...args], {
    stdout: "pipe", stderr: "pipe", stdin: new TextEncoder().encode("{\"hook_event_name\":\"Stop\"}"),
    env: { ...env, PATH: env.PATH ?? "/usr/bin:/bin" },
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}

test("a missing walkie binary exits 1 with the README install line and no stdout", async () => {
  const home = mkdtempSync(join(tmpdir(), "walkie-plugin-missing-"));
  try {
    const r = await runLauncher(["mcp"], { HOME: home, PATH: "/usr/bin:/bin" });
    expect(r.code).toBe(1);
    expect(r.err.trim()).toBe(INSTALL_LINE);
    expect(r.out).toBe("");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("walkie on PATH is exec'd with the plugin arguments and stdin intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "walkie-plugin-path-"));
  const home = join(dir, "home");
  mkdirSync(home);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "walkie"), "#!/bin/sh\nprintf '%s\\n' \"$*\"\ncat\n", { mode: 0o755 });
  chmodSync(join(bin, "walkie"), 0o755);
  try {
    const r = await runLauncher(["hook", "claude"], { HOME: home, PATH: `${bin}:/usr/bin:/bin` });
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(r.out).toBe("hook claude\n{\"hook_event_name\":\"Stop\"}");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("walkie in ~/.local/bin is used when it is not on PATH", async () => {
  const home = mkdtempSync(join(tmpdir(), "walkie-plugin-local-"));
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  writeFileSync(join(home, ".local/bin/walkie"), "#!/bin/sh\nprintf '%s\\n' \"$*\"\n", { mode: 0o755 });
  chmodSync(join(home, ".local/bin/walkie"), 0o755);
  try {
    const r = await runLauncher(["mcp"], { HOME: home, PATH: "/usr/bin:/bin" });
    expect(r.code).toBe(0);
    expect(r.out).toBe("mcp\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
