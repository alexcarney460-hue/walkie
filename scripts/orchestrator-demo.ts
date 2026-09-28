// A real two-machine Walkie (fake Tailscale identities, test/helpers/cluster.ts) with alex-mbp's LOCAL orchestrator
// running the FAKE claude (test/fixtures/fake-claude), serving the built dashboard, for driving the Orchestrator tab in
// a browser (screenshots, manual QA). No model, no network beyond loopback. The conversation stays on alex-mbp
// (ORCH-FIX-11); alex-studio is there to show that nothing of it reaches another machine.
//
//   bun run web:build && bun scripts/orchestrator-demo.ts
//     DEMO_PORT=7491        dashboard port on alex-mbp (the machine the browser talks to)
//
// Prints a one-time login URL. Control files in the printed directory:
//   touch <dir>/nonce        → a fresh login URL is written to <dir>/url
//   touch <dir>/stop-orch    → alex-mbp's orchestrator stops (the tab shows how to start it)
//   touch <dir>/start-orch   → it starts again
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Cluster, waitFor } from "../test/helpers/cluster.ts";

const root = join(import.meta.dir, "..");
const port = Number(process.env.DEMO_PORT ?? 7491);
const fakeDir = join(root, "test", "fixtures", "fake-claude");
const webDir = join(root, "web", "dist");
if (!existsSync(join(webDir, "index.html"))) throw new Error("build the dashboard first: bun run web:build");

const c = new Cluster();
const ctl = join(c.root, "ctl");
mkdirSync(ctl, { recursive: true });
const state = join(c.root, "fake-state");
mkdirSync(state, { recursive: true });
const bunDir = dirname(process.execPath); // the fake claude is a bun script
const orchestrator = {
  env: { ...process.env, PATH: `${bunDir}:/usr/bin:/bin`, FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_DEMO_MS: process.env.FAKE_CLAUDE_DEMO_MS ?? "6000" },
};
const path = `${fakeDir}:${bunDir}:/usr/bin:/bin`;

const mbp = await c.add({ name: "mbp", login: "alex@example.com", hostname: "alex-mbp", localPort: port, webDir, orchestrator });
await mbp.client().init("acme", "alex");
const studio = await c.add({ name: "studio", login: "alex@example.com", hostname: "alex-studio", orchestrator });
const joined = await studio.client().join(mbp.peerAddr);
if (!joined.admitted) throw new Error(`alex-studio could not join: ${joined.reason}`);

// A couple of ordinary agents so the rest of the dashboard isn't empty.
await mbp.client("cc-ux").status({ agent: "cc-ux", state: "working", runtime: "claude-code", title: "Onboarding polish", activity: "Editing web/src/views/FirstRun.tsx" });
await studio.client("codex-api").status({ agent: "codex-api", state: "blocked", runtime: "codex", title: "Events index migration", activity: "Waiting on a failing migration" });

const start = () => mbp.client("").orchestratorStart({ cwd: c.root, path });
await start();
await waitFor(async () => (await mbp.client().orchestrator()).local.state === "idle", { what: "orchestrator idle on alex-mbp", timeoutMs: 20_000 });

async function loginUrl(): Promise<string> {
  const { nonce } = await mbp.client().authNonce();
  return `http://127.0.0.1:${port}/auth?nonce=${nonce}`;
}
const first = await loginUrl();
writeFileSync(join(ctl, "url"), first + "\n");
process.stdout.write(`orchestrator demo: local orchestrator and dashboard on alex-mbp\nlogin: ${first}\nctl: ${ctl}\nstudio home: ${studio.home}\n`);

const timer = setInterval(async () => {
  try {
    if (existsSync(join(ctl, "nonce"))) {
      rmSync(join(ctl, "nonce"));
      writeFileSync(join(ctl, "url"), (await loginUrl()) + "\n");
    }
    if (existsSync(join(ctl, "stop-orch"))) {
      rmSync(join(ctl, "stop-orch"));
      await mbp.client("").orchestratorStop();
      process.stdout.write("orchestrator stopped\n");
    }
    if (existsSync(join(ctl, "start-orch"))) {
      rmSync(join(ctl, "start-orch"));
      await start();
      process.stdout.write("orchestrator started\n");
    }
  } catch (err) {
    process.stderr.write(`demo control: ${(err as Error).message}\n`);
  }
}, 300);

const shutdown = async () => {
  clearInterval(timer);
  await c.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
