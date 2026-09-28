// A real two-machine Walkie (fake Tailscale identities, test/helpers/cluster.ts) where arvid-mac takes remote seats
// running the FAKE claude and codex (test/fixtures/fake-claude, test/fixtures/fake-codex), for driving the CLI
// (`walkie seats`, `walkie seat run`) and the dashboard's Seats view by hand. No model, no network beyond loopback.
//
//   bun run web:build && bun scripts/seats-demo.ts
//     DEMO_PORT=7492       dashboard port on alex-mbp
//     DEMO_HOST_PORT=7493  dashboard port on arvid-mac (its "I'm using this computer" button)
//     DEMO_SEED=1          arvid opts in and alex starts two long codex seats there (busy / resume by hand)
//
// Prints each machine's socket (WALKIE_SOCKET=<it> walkie …) and a one-time dashboard login URL for each.
// Without DEMO_SEED, arvid has NOT opted in yet: run `walkie seats allow` against his socket. Stop with Ctrl-C.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Cluster } from "../test/helpers/cluster.ts";

const root = join(import.meta.dir, "..");
const port = Number(process.env.DEMO_PORT ?? 7492);
const hostPort = Number(process.env.DEMO_HOST_PORT ?? 7493);
const webDir = join(root, "web", "dist");
if (!existsSync(join(webDir, "index.html"))) throw new Error("build the dashboard first: bun run web:build");

const c = new Cluster();
const home = join(c.root, "arvid-home");
mkdirSync(home, { recursive: true });
const fixtures = join(root, "test", "fixtures");
const seats = {
  flushMs: 500,
  env: {
    PATH: `${join(fixtures, "fake-claude")}:${join(fixtures, "fake-codex")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home,
    FAKE_CLAUDE_STATE: join(c.root, "fake-state"), FAKE_CLAUDE_LOG: join(c.root, "claude.jsonl"), FAKE_CODEX_LOG: join(c.root, "codex.jsonl"),
  },
};

const alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", localPort: port, webDir });
const arvid = await c.add({ name: "arvid", login: "arvid@example.com", hostname: "arvid-mac", seats, localPort: hostPort, webDir });
// The seat env file (seat-env in the Walkie home): what the machine's seats start from.
writeFileSync(join(arvid.d.core.paths.home, "seat-env"), ('export CODEX_HOME="$HOME/.codex-seat"\nexport ANTHROPIC_API_KEY=sk' + '-ant-api03-dropped-before-any-seat\n'));
await alex.client().init("aka", "alex");
await alex.client().invite("arvid@example.com", "arvid", "member");
const joined = await arvid.client().join(alex.peerAddr);
if (!joined.admitted) throw new Error(`arvid-mac could not join: ${joined.reason}`);
const seed = process.env.DEMO_SEED === "1";
if (seed) {
  await arvid.client("").seatsConfig({ allow: true, same_user: true, env: ["FAKE_CODEX_LOG"] });
  for (let i = 0; i < 100 && !(await alex.client().seats()).hosts.some((h) => h.hostname === "arvid-mac" && h.allows && h.member); i++) await Bun.sleep(100);
  for (const prompt of ["ticker 36000", "ticker 36001"]) {
    await alex.client("").seatRun({ machine: "arvid-mac", runtime: "codex", prompt, timeout_s: 7_200 });
    await Bun.sleep(1_000);
  }
}
const { nonce } = await alex.client().authNonce();
const { nonce: hostNonce } = await arvid.client().authNonce();

process.stdout.write([
  `seats demo: alex-mbp (owner, authority) + arvid-mac (member${seed ? ", seats allowed, two seats running" : ", not opted in yet"})`,
  `alex-mbp  socket: ${alex.socket}`,
  `arvid-mac socket: ${arvid.socket}`,
  `arvid-mac seats dir: ${join(home, "walkie-seats")}`,
  `dashboard (alex-mbp): http://127.0.0.1:${port}/auth?nonce=${nonce}`,
  `dashboard (arvid-mac): http://127.0.0.1:${hostPort}/auth?nonce=${hostNonce}`,
  "",
].join("\n"));

const shutdown = async () => { await c.close(); process.exit(0); };
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
await new Promise(() => undefined);
