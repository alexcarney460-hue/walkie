// Real run for WALKIE-PROJECTS-1: two isolated daemons in a MIXED team (alex: Tailscale via a fake tailnet identity +
// Walkie Direct; arvid: Walkie Direct only, joined with an invite code), the dashboard served by alex's daemon.
// Both sides create, move, assign and comment; the script checks the two boards converge, then keeps running so the
// dashboard can be screenshotted. Usage: bun scripts/projects-demo.ts <dir> <dashboard port>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WalkieClient } from "../src/client/index.ts";
import { FakeIdentity, type WhoisResult } from "../src/daemon/identity.ts";
import { startDaemon } from "../src/daemon/main.ts";
import { NoTailscale, TEST_LIMITS } from "../test/helpers/cluster.ts";

const dir = process.argv[2] ?? "/tmp/walkie-projects-demo";
const port = Number(process.argv[3] ?? "17457");
const identities = new Map<string, WhoisResult>();
const addressBook = new Map<string, string[]>();
const web = join(import.meta.dir, "../web/dist");
mkdirSync(dir, { recursive: true });

const alex = await startDaemon({
  home: join(dir, "alex"), socket: join(dir, "alex", "walkie.sock"), identity: new FakeIdentity({ ip: "127.0.0.1", login: "alex@example.com", nodeName: "alex-mbp" }, identities),
  peerHost: "127.0.0.1", peerPort: 0, localPort: port, hostname: "alex-mbp", webDir: web, env: false, limits: TEST_LIMITS,
  sync: { intervalMs: 1_000, livenessMs: 3_000, pushTimeoutMs: 1_000 }, integrations: { autoRun: false }, licenseRenew: false,
  discovery: false, machineStats: false, accounts: false,
  direct: { preset: "minimal", bindAddr: "127.0.0.1:0", addressBook },
  licenseService: { fetch: async () => { throw new Error("offline demo"); } },
});
identities.set(alex.nodeId, { login: "alex@example.com", nodeName: "alex-mbp" });
const arvid = await startDaemon({
  home: join(dir, "arvid"), socket: join(dir, "arvid", "walkie.sock"), identity: new NoTailscale(), peerPort: 0, localPort: false,
  hostname: "arvid-mbp", webDir: web, env: false, limits: TEST_LIMITS, sync: { intervalMs: 1_000, livenessMs: 3_000, pushTimeoutMs: 1_000 },
  integrations: { autoRun: false }, licenseRenew: false, discovery: false, machineStats: false, accounts: false,
  direct: { preset: "minimal", bindAddr: "127.0.0.1:0", addressBook }, peerLink: { retryBaseMs: 60_000, retryMaxMs: 60_000 },
  licenseService: { fetch: async () => { throw new Error("offline demo"); } },
});

const A = new WalkieClient({ socket: alex.socket, timeoutMs: 30_000 });
const R = new WalkieClient({ socket: arvid.socket, timeoutMs: 30_000 });
const wait = async (fn: () => Promise<boolean> | boolean, what: string) => {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { if (await Promise.resolve().then(fn).catch(() => false)) return; await Bun.sleep(100); }
  throw new Error(`timed out: ${what}`);
};

await A.init("Harbor", "alex");
await A.request("POST", "/v1/direct/enable", {});
const inv = await A.inviteCode("arvid", "member");
const joined = await R.join(inv.code);
console.log(`[run] arvid joined over Walkie Direct: admitted=${joined.admitted}; alex transports=${JSON.stringify((await A.me()).transport?.transports)}; arvid=${JSON.stringify((await R.me()).transport?.transports)}`);

const { project: web1 } = await A.createProject({ name: "Website relaunch", folder: "Acme", paths: [{ path: "~/work/site" }], description: "New marketing site, pricing and signup" });
await A.createProject({ name: "API v2", folder: "Acme", prefix: "API" });
await A.createProject({ name: "Q4 planning", folder: "Ops", prefix: "OPS" });
await wait(async () => (await R.projects()).projects.length === 3, "arvid sees 3 projects");

// At a person's pace: each card reaches the other machine before the next is created there (cards created on two
// machines within the same instant both propose the next number; the earlier keeps it, the other is renumbered).
const mk = async (c: WalkieClient, title: string, extra: Record<string, unknown> = {}) => {
  const { task } = await c.createTask({ project: "WR", title, ...extra });
  const other = c === A ? arvid : alex;
  await wait(() => { other.projects.flushAll(); return !!other.projects.db.card(task.id); }, `${task.key} replicated`);
  return task;
};
const t = [
  await mk(A, "Hero section with product video", { labels: ["design"], assignee: "@alex/alex-mbp/cc-4f2a", estimate: 3 }),
  await mk(R, "Pricing page copy", { labels: ["copy"], assignee: "@arvid" }),
  await mk(A, "Signup flow: email verification", { labels: ["backend"], estimate: 5 }),
  await mk(R, "Contact form spam protection", { labels: ["backend", "security"] }),
  await mk(A, "Lighthouse pass (perf > 90)", { labels: ["perf"] }),
  await mk(R, "Cookie banner", { labels: ["legal"] }),
  await mk(A, "Blog migration from Ghost", { column: "backlog" }),
  await mk(A, "Footer links and sitemap", { labels: ["seo"] }),
  await mk(R, "Customer logos strip", { labels: ["design"] }),
];
await A.updateTask(t[0]!.id, { column: "doing" });
await R.updateTask(t[1]!.id, { column: "review" });
await A.updateTask(t[2]!.id, { column: "doing", assignee: "@alex/alex-mbp/cc-9b1e" });
await R.taskAction(t[3]!.id, "block", "waiting on the captcha vendor key");
await R.updateTask(t[3]!.id, { column: "doing" });
await A.updateTask(t[4]!.id, { column: "done" });
await R.updateTask(t[5]!.id, { column: "done" });
await A.commentTask(t[1]!.id, "Legal signed off on the plan names.");
await R.commentTask(t[1]!.id, "Updated the annual discount line, ready for review.");
await A.createBoard(web1.channel, { name: "Bugs" });
for (const title of ["Design tokens for dark mode", "Rate limits per key"]) await A.createTask({ project: "API", title });
await A.createTask({ project: "OPS", title: "Hiring plan" });

// Agents on alex's machine report what they work on (the board shows them on their cards).
const agent = (name: string) => new WalkieClient({ socket: alex.socket, agent: name, timeoutMs: 30_000 });
await agent("cc-4f2a").status({ agent: "cc-4f2a", state: "working", runtime: "claude-code", title: "Building the hero section", task: t[0]!.key, repo: "site", activity: "Editing" }, { title: "agent", task: "agent", activity: "phrase" });
await agent("cc-9b1e").status({ agent: "cc-9b1e", state: "blocked", runtime: "claude-code", title: "Email verification", task: t[2]!.key, repo: "site", activity: "Stuck" }, { title: "agent", task: "agent", activity: "phrase" });
await agent("codex-2d").status({ agent: "codex-2d", state: "working", runtime: "codex", title: "API rate limits", task: "API-2", repo: "api", activity: "Running tests" }, { title: "agent", task: "agent", activity: "phrase" });

const snapshotOf = async (c: WalkieClient) => {
  const { cards, project } = await c.project(web1.channel, { deleted: true });
  return JSON.stringify({ meter: [project.meter.done, project.meter.counted], boards: project.boards.map((b) => b.name), cards: cards.map((x) => [x.key, x.title, x.column, x.pos, x.assignee, x.blocked, x.comments, x.state]).sort() });
};
let a = "", r = "";
await wait(async () => { alex.projects.flushAll(); arvid.projects.flushAll(); a = await snapshotOf(A); r = await snapshotOf(R); return a === r; }, "boards converge");
console.log(`[run] boards converged on both daemons: ${a === r}`);
console.log(`[run] ${a}`);
const { nonce } = await A.authNonce();
const url = `http://127.0.0.1:${port}/auth?nonce=${nonce}`;
writeFileSync(join(dir, "ready.json"), JSON.stringify({ url, channel: web1.channel, card: t[0]!.id, pid: process.pid }));
console.log(`[run] dashboard login (one-shot): ${url}`);
console.log(`[run] project board: http://127.0.0.1:${port}/#/projects/${web1.channel}`);
process.on("SIGTERM", async () => { await alex.stop(); await arvid.stop(); process.exit(0); });
await new Promise(() => undefined);
