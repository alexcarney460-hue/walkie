// Person-only setup and review for Talkie's local, ephemeral browser.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { walkieHome } from "../../client/index.ts";
import { isSeatAgent, SEATS_AGENT } from "../../protocol/seats.ts";
import { UsageError } from "../args.ts";
import { EXIT, requirePerson, type Ctx } from "../context.ts";

interface BrowserConfig { enabled: boolean; allowed_agents: string[]; denylist: string[] }
const usage = "browser status|on|off|install|allow <seat-agent-id>|deny <seat-agent-id>|block <domain>|unblock <domain>|review <confirmation-id>";

function run(argv: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(argv[0]!, argv.slice(1), { cwd, env, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`browser install failed: ${argv.slice(1).join(" ")} (${result.error?.message ?? result.status})`);
}

async function install(ctx: Ctx): Promise<number> {
  await requirePerson(ctx, "install Playwright and Chromium for the browser", "yes");
  const bun = Bun.which("bun");
  const npm = Bun.which("npm");
  const node = Bun.which("node");
  if (!bun && !(npm && node)) throw new Error("bun or npm with node is required for walkie browser install");
  const dir = join(walkieHome(), "browser");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(join(dir, "package.json")))
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "walkie-browser-local", private: true, type: "module" }) + "\n", { mode: 0o600 });
  // The browser package and Chromium cache stay under this machine's Sqwakie data directory.
  if (bun) run([bun, "add", "playwright@1.57.0", "--exact"], dir);
  else run([npm!, "install", "playwright@1.57.0", "--save-exact", "--prefix", dir], dir);
  run([bun ?? node!, join(dir, "node_modules", "playwright", "cli.js"), "install", "chromium"], dir,
    { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(dir, "chromium") });
  ctx.out(`Playwright and Chromium installed in ${dir}; browser remains off until you run walkie browser on`);
  return EXIT.ok;
}

export async function browserCmd(ctx: Ctx): Promise<number> {
  const [action = "status", value] = ctx.args.pos;
  if (action === "install" && ctx.args.pos.length === 1) return install(ctx);
  if (action === "review" && value && ctx.args.pos.length === 2) {
    await requirePerson(ctx, "review a browser confirmation screenshot", "yes");
    const data = await ctx.client().request<{ summary: string; screenshot: string }>("GET", `/v1/browser/review/${encodeURIComponent(value)}`);
    const dir = join(tmpdir(), "walkie-browser-reviews");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${value}.png`);
    writeFileSync(path, Buffer.from(data.screenshot, "base64"), { mode: 0o600 });
    ctx.out(data.summary);
    ctx.out(`Screenshot: ${path}`);
    if (!ctx.json) {
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      spawnSync(opener, [path], { stdio: "ignore" });
    }
    return EXIT.ok;
  }
  const client = ctx.client();
  const current = await client.request<BrowserConfig>("GET", "/v1/browser/config");
  if (action === "status" && ctx.args.pos.length <= 1) {
    ctx.out(ctx.json ? JSON.stringify(current) : `browser ${current.enabled ? "on" : "off"}; allowed seats: ${current.allowed_agents.join(", ") || "none"}; extra blocked domains: ${current.denylist.join(", ") || "none"}`);
    return EXIT.ok;
  }
  if (!["on", "off", "allow", "deny", "block", "unblock"].includes(action)) throw new UsageError(usage);
  await requirePerson(ctx, "change this machine's browser access", "yes");
  let patch: Record<string, unknown>;
  if ((action === "on" || action === "off") && !value) patch = { enabled: action === "on" };
  else if ((action === "allow" || action === "deny") && value && ctx.args.pos.length === 2) {
    if (!isSeatAgent(value) || value === SEATS_AGENT) throw new UsageError("browser allow|deny needs an exact seat agent ID");
    patch = { allowed_agents: action === "allow"
      ? [...new Set([...current.allowed_agents, value])] : current.allowed_agents.filter((id) => id !== value) };
  } else if ((action === "block" || action === "unblock") && value && ctx.args.pos.length === 2) {
    const domain = value.toLowerCase().replace(/\.$/, "");
    if (!/^[a-z0-9.-]+$/.test(domain) || !domain.includes(".")) throw new UsageError("browser block|unblock needs a domain name");
    patch = { denylist: action === "block" ? [...new Set([...current.denylist, domain])]
      : current.denylist.filter((d) => d !== domain) };
  } else throw new UsageError(usage);
  const next = await client.request<BrowserConfig>("POST", "/v1/browser/config", patch);
  ctx.out(ctx.json ? JSON.stringify(next) : `browser ${next.enabled ? "on" : "off"}; allowed seats: ${next.allowed_agents.join(", ") || "none"}; extra blocked domains: ${next.denylist.join(", ") || "none"}`);
  return EXIT.ok;
}
