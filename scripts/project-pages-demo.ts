// A real two-machine, two-person Walkie (fake Tailscale identities, test/helpers/cluster.ts) with a project whose status page is full: cards
// across the board (some finished days ago, some today), agents working on both machines, facts set through the daemon's own
// route, ten real screenshots in four groups added through the CLI client's own upload, and a report delivered through the
// daemon's own delivery code from a canned reply (no model turn). The dashboard is served on the first machine; the browser
// shots are taken by scripts/project-pages-shots.ts. A second project has its report on and nothing else yet; a third has it
// off. No network beyond loopback. With PAGES_DEMO_EXTREMES=1 a fourth project holds the longest text every field takes (words
// that cannot wrap) and twelve groups of screens, to see that nothing widens the page.
//
//   bun run web:build && bun scripts/project-pages-demo.ts <dir> [port]
//
// Writes <dir>/ready.json (the one-time login URL, the projects' channels) and keeps running until SIGTERM.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareProjectReports } from "../src/daemon/projects/status-report.ts";
import { agentsView } from "../src/daemon/views.ts";
import { Cluster, waitFor } from "../test/helpers/cluster.ts";

const dir = process.argv[2] ?? "/tmp/walkie-project-pages";
const port = Number(process.argv[3] ?? "17459");
const root = join(import.meta.dir, "..");
const webDir = join(root, "web", "dist");
if (!existsSync(join(webDir, "index.html"))) throw new Error("build the dashboard first: bun run web:build");
mkdirSync(dir, { recursive: true });

const DAY = 24 * 3_600_000;
const real = Date.now();
/** Both machines' clock: the team starts nine days ago and time only moves forward (a daemon never signs an event older than its last), so some cards are older than others. */
let now = real - 9 * DAY;
const clock = () => now;
const c = new Cluster();
const mbp = await c.add({ name: "mbp", login: "alex@example.com", hostname: "alex-mbp", localPort: port, webDir, clock });
await mbp.client().init("acme", "alex");
await mbp.client().invite("maren@example.com", "maren", "member");
const studio = await c.add({ name: "studio", login: "maren@example.com", hostname: "marens-studio", clock });
const joined = await studio.client().join(mbp.peerAddr);
if (!joined.admitted) throw new Error(`the second machine could not join: ${JSON.stringify(joined)}`);

const A = mbp.client();
const dash = (await A.createProject({ name: "Walkie dashboard", prefix: "DASH", folder: "Product", description: "The dashboard every teammate and agent shares." })).project;
const billing = (await A.createProject({ name: "Billing portal", prefix: "BILL", folder: "Product", description: "Customers pay and see their invoices." })).project;
const archive = (await A.createProject({ name: "Archive cleanup", prefix: "ARC", folder: "Operations" })).project;
for (const p of [dash, billing]) await A.updateProject(p.channel, { status_report: "hourly" });

// ---- cards, over nine days -------------------------------------------------------------------------------------------
const card = (title: string, column: string, extra: Record<string, unknown> = {}) => A.createTask({ project: dash.channel, title, column, ...extra });
for (const t of ["Project list with progress bars", "Kanban board with drag and drop", "Card drawer with comments", "Agent roster in Mission Control"]) await card(t, "done");
now = real - 5 * DAY;
for (const t of ["Account usage and weekly resets", "Phone layout for the board"]) await card(t, "done");
now = real - 2 * DAY;
for (const t of ["Data Room tab with versions", "Keyboard shortcuts for the board"]) await card(t, "done");
now = real - 3 * 3_600_000;
for (const t of ["Dark and light themes", "Agent archive by machine"]) await card(t, "done");
now = real - 20 * 60_000;
const stuck = (await card("Offline banner on the phone", "doing")).task;
await card("Status page for each project", "doing");
await card("Screens for the status page", "doing");
await card("Reports by plain-English summary", "review");
await card("Link a card to its pull request", "todo");
await card("Export a project as a spreadsheet", "todo");
await card("Show who is on holiday", "backlog");
await A.taskAction(stuck.id, "block", "waiting on a design decision");
await A.createTask({ project: dash.channel, title: "Pick the partners' sign-in", column: "todo", labels: ["decision-needed"] });
await A.createTask({ project: dash.channel, title: "Merger planning (private)", column: "doing", labels: ["confidential"] });
for (const t of ["Invoices list", "Payment receipts"]) await A.createTask({ project: billing.channel, title: t, column: "todo" });
now = real;

// ---- agents working on both machines ---------------------------------------------------------------------------------
const status = (n: typeof mbp, agent: string, task: string, title: string) =>
  n.client(agent).status({ agent, state: "working", runtime: "claude-code", title, task, repo: "dashboard", activity: "Editing" }, { title: "agent", task: "agent", activity: "phrase" });
await status(mbp, "cc-ui", "DASH-12", "Building the status page");
await status(mbp, "cc-shots", "DASH-13", "Capturing screens");
await status(mbp, "cc-copy", "DASH-11", "Writing the offline banner");
await status(studio, "codex-pages", "DASH-12", "Testing the page's phone layout");
await status(studio, "codex-api", "DASH-14", "Reviewing the report text");

// ---- facts and screens, through the daemon's own routes ---------------------------------------------------------------
const releases = mbp.client("cc-release");
await releases.setFact(dash.channel, { label: "Live build", value: "ddee2f0bca" });
await releases.setFact(dash.channel, { label: "Next release", value: "Friday 3 Oct" });
await A.setFact(dash.channel, { label: "Pilot checks", value: "12 of 38 pass" });
await studio.client("codex-pages").setFact(dash.channel, { label: "Phone layouts", value: "6 of 8 checked" });

const shots = join(root, "web", "screenshots");
const shot = (file: string, title: string, group: string, status: string, about: string, route: string, note?: string) => {
  const path = join(shots, file);
  if (!existsSync(path)) throw new Error(`missing screenshot ${file}`);
  return mbp.client("cc-shots").addScreen(dash.channel, new Uint8Array(readFileSync(path)), { title, group, status, about, route, ...(note ? { note } : {}) });
};
await shot("projects-list-desktop-light.png", "Project list", "Projects", "works", "Every project by folder, with how far along it is, who is working on it and when it last changed.", "#/projects");
await shot("projects-board-desktop-dark.png", "Board", "Projects", "works", "One project as a board of cards in columns, with who is on each card and how many are in progress.", "#/projects/<project>", "Drag a card, or use the keyboard.");
await shot("projects-drawer-desktop-dark.png", "Card details", "Projects", "partial", "A card opened to the side: its text, its comments and its history of changes.", "#/projects/<project>?card=<card>", "Files from the Data Room are listed but not previewed yet.");
await shot("polish-after-desktop-dark-mission.png", "Mission Control", "Mission Control", "works", "Every agent on the team and what it is working on right now, grouped by machine.", "#/mission");
await shot("accounts-desktop-light-mission.png", "Accounts", "Mission Control", "works", "How much of each provider account is left this week, and when it resets.", "#/accounts");
await shot("mission-archive-desktop-dark.png", "Agent archive", "Mission Control", "works", "Agents that went quiet, kept for a while so their work can be found again.", "#/mission?tab=archive");
await shot("projects-board-390-dark.png", "Board on a phone", "On a phone", "works", "The board one column at a time, with the columns as tabs along the top.", "#/projects/<project>");
await shot("projects-list-390-light.png", "Project list on a phone", "On a phone", "works", "The same list in one column, with the progress of each project.", "#/projects");
await shot("pwa-390-light-offline.png", "Offline", "On a phone", "empty", "What the phone app shows when it cannot reach the team: nothing new, and how to try again.", "/m/");
await shot("ui-polish-machine-desktop-light-not-found.png", "Unknown machine", "Planned", "not-built", "The page for a machine that is not on the team says it was not found; a friendlier page is planned.", "#/machines/<machine>", "Shown today as a plain message.");

// ---- the extremes: the longest text every field takes, in words that cannot wrap ------------------------------------------------
const word = (n: number, seed = "Supercalifragilistic") => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
let extremes: string | null = null;
if (process.env.PAGES_DEMO_EXTREMES === "1") {
  const ext = (await A.createProject({ name: "Extremes", prefix: "EXT", folder: "Product" })).project;
  await A.updateProject(ext.channel, { status_report: "hourly" });
  await A.createTask({ project: ext.channel, title: "Check the page with the longest text", column: "doing" }); // a project with something open is written up
  // Each write is under another agent's name: the daemon limits how fast one name may write.
  for (let i = 0; i < 6; i++) await mbp.client(`cc-fact-${i}`).setFact(ext.channel, { label: word(24, `Label${i}`), value: word(60, "ddee2f0bca") });
  const bytes = new Uint8Array(readFileSync(join(shots, "pwa-390-light-offline.png")));
  for (let g = 0; g < 12; g++) {
    const group = `${String.fromCharCode(65 + g)}${word(39, "roup")}`;
    await mbp.client(`cc-ext-${g}`).addScreen(ext.channel, bytes, {
      title: word(60, `Title${g}`), group, status: ["works", "partial", "empty", "not-built"][g % 4] as string, about: word(300, "AboutAboutAbout"),
      route: `/${word(119, "route")}`, note: word(200, "NoteNote"),
    });
  }
  extremes = ext.channel;
}

// ---- the report, through the daemon's own delivery code ---------------------------------------------------------------------
const REPORT = "**On track:** the project pages work and the status page is next.\n\n**Done since the last report**\n- Dark and light themes.\n\n**In progress (and who is on it)**\n- The status page, by two agents.\n\n**Blocked or waiting on a decision**\n- The offline banner waits on a design decision.\n\n**Next**\n- Turn the page on for the projects partners follow.";
const PAGE = [
  "<page>",
  "<headline>The dashboard is on track: projects, agents and accounts work, and the status page is next</headline>",
  "<lede>This page shows what the Walkie dashboard does today, with a picture of each screen. It is written for teammates who do not use the terminal.</lede>",
  "<live-now>",
  "- See every project as a board of cards and who is working on each one.",
  "- See every agent on the team and what it is doing right now.",
  "- Check how much of each provider account is left this week.",
  "- Use all of it from a phone, one column at a time.",
  "</live-now>",
  "<landing-next>",
  "- A status page for each project, like this one.",
  "- Turning the page on for the projects partners want to follow.",
  "</landing-next>",
  "</page>",
].join("\n");
const deps = { core: mbp.d.core, idx: mbp.d.projects, client: mbp.d.client, catchUp: async () => {}, agents: () => agentsView(mbp.d.core, mbp.d.sync) };
mbp.d.projects.flushAll();
const turn = await prepareProjectReports(deps, () => true);
if ("skip" in turn) throw new Error(`no report turn: ${turn.skip}`);
writeFileSync(join(dir, "evidence.txt"), `${turn.evidence}\n`);
// The daemon's own WalkieTalkie host checks its lease before it signs under its name; no host runs here, so the lease is stood in for.
mbp.d.core.orchestratorCanAct = () => true;
const list = (n: number, seed: string, max: number) => Array.from({ length: n }, (_, i) => `- ${word(max, `${seed}${i}`)}`).join("\n");
const EXTREME_BLOCK = extremes
  ? `\n<status-report project="${extremes}">\n**On track:** ${word(200, "Report")}\n\n<page>\n<headline>${word(100)}</headline>\n<lede>${word(420)}</lede>\n<live-now>\n${list(8, "Live", 180)}\n</live-now>\n<landing-next>\n${list(6, "Next", 180)}\n</landing-next>\n</page>\n</status-report>`
  : "";
const out = turn.finish?.({ text: `<status-report project="${dash.channel}">\n${REPORT}\n\n${PAGE}\n</status-report>${EXTREME_BLOCK}`, ok: true }, Date.now());
delete mbp.d.core.orchestratorCanAct;
await waitFor(async () => (await studio.client().statusPage(dash.channel)).story !== null, { timeoutMs: 20_000, what: "the second machine has the story" });
mbp.d.projects.flushAll();

// A way for the capture to write while the page is open (a fact, a screen), so it can see the open page change by itself.
const poke = Bun.serve({
  port: port + 1, hostname: "127.0.0.1",
  async fetch(req) {
    const q = new URL(req.url).searchParams;
    try {
      if (new URL(req.url).pathname === "/fact") await releases.setFact(dash.channel, { label: q.get("label") ?? "Poked", value: q.get("value") ?? "now" });
      else if (new URL(req.url).pathname === "/screen") await shot("projects-list-390-light.png", q.get("title") ?? "Poked screen", "Projects", "works", "A screen added while the page was open.", "#/poked");
      else return new Response("not found", { status: 404 });
      return new Response("ok");
    } catch (err) { return new Response(String(err), { status: 500 }); }
  },
});

const { nonce } = await A.authNonce();
const ready = { url: `http://127.0.0.1:${port}/auth?nonce=${nonce}`, port, dash: dash.channel, billing: billing.channel, archive: archive.channel, extremes, poke: poke.port, run: out?.text ?? null, pid: process.pid };
writeFileSync(join(dir, "ready.json"), JSON.stringify(ready));
process.stdout.write(`[run] ${out?.text}\n[run] ready: ${JSON.stringify(ready)}\n`);
process.on("SIGTERM", async () => { poke.stop(true); await c.close(); process.exit(0); });
await new Promise(() => undefined);
