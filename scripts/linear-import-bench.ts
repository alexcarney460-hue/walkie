// LINEAR-IMPORT-1 bench: a 2 000-issue fictional Linear workspace (fake GraphQL over HTTP) imported by one daemon and
// replicated to a second, with production sync timings. Prints the import time, the time until the second daemon holds
// every post, events and bytes replicated (per card, and the per-post header overhead a one-post batch would save), and
// the interactive path's cost for comparison. Usage: bun scripts/linear-import-bench.ts [issues=2000]
import { selectionOf } from "../src/integrations/linear-import/plan.ts";
import { Cluster, waitFor } from "../test/helpers/cluster.ts";
import { FakeLinear } from "../test/helpers/fake-linear.ts";

const N = Number(process.argv[2] ?? 2_000);
const KEY = "bench-linear-key-5d1f0a";
const PROJECTS = 4;

function words(seed: number, n: number): string {
  const w = ["checkout", "webhooks", "billing", "migration", "search", "invoice", "retry", "queue", "SSO", "export", "audit", "sitemap", "pricing", "onboarding", "carrier", "dispatch"];
  return Array.from({ length: n }, (_, i) => w[(seed * 7 + i * 13) % w.length]).join(" ");
}

const lin = new FakeLinear("bench");
const url = lin.serve();
const team = lin.team("BEN", "Bench");
const ps = Array.from({ length: PROJECTS }, (_, i) => lin.project(team, `Bench project ${i + 1}`));
const STATES = ["Backlog", "Todo", "In Progress", "In Review"];
for (let i = 0; i < N; i++) {
  const withHistory = i % 5 < 3; // 60% carry comments / history, like a real workspace
  lin.issue(team, ps[i % PROJECTS]!, `${words(i, 4)} ${i}`, STATES[i % 4]!, {
    description: `${words(i, 20)}. `.repeat(1 + (i % 9)), // ~130 to ~1 200 characters (the real median was 778)
    labels: { nodes: i % 3 ? [{ name: ["backend", "frontend", "infra"][i % 3] as string }] : [] },
    estimate: i % 4 ? i % 8 : null,
    ...(withHistory ? {
      comments: { nodes: [{ body: `Update on ${words(i, 12)}.`, createdAt: lin.now(), user: { name: "Maren Okafor" } }] },
      history: { nodes: [{ createdAt: lin.now(), actor: { name: "Maren Okafor" }, fromState: { name: "Todo" }, toState: { name: STATES[i % 4] ?? "Todo" }, fromAssignee: null, toAssignee: null }] },
    } : {}),
  });
}

const c = new Cluster();
try {
  const prod = { intervalMs: 15_000, livenessMs: 45_000, pushTimeoutMs: 2_000 }; // the daemon's defaults
  const alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", sync: prod, linearImport: { url } });
  const bob = await c.add({ name: "bob", login: "bob@example.com", hostname: "bobs-mbp", sync: prod, linearImport: { url } });
  await alex.client().init("bench", "alex");
  await alex.client().invite("bob@example.com", "bob", "member");
  if (!(await bob.client().join(alex.peerAddr)).admitted) throw new Error("bob not admitted");
  const cl = alex.client();

  let t = Date.now();
  const { plan } = await cl.linearImportPlan({ options: {}, key: KEY });
  const planMs = Date.now() - t;

  t = Date.now();
  const { job } = await cl.linearImportRun({ selection: selectionOf(plan), key: KEY });
  const done = await waitFor(async () => { const s = await cl.linearImportStatus(); return s.job?.id === job.id && s.job.state === "done" ? s.job : null; }, { timeoutMs: 600_000, intervalMs: 100, what: "import" });
  const importMs = Date.now() - t;

  const channels = done.projects.map((p) => p.channel);
  const inList = channels.map(() => "?").join(",");
  const count = (n: typeof alex) => n.d.core.store.db.query<{ n: number }, string[]>(`SELECT COUNT(*) AS n FROM events WHERE channel IN (${inList}) AND status = 'ok'`).get(...channels)?.n ?? 0;
  const total = count(alex);
  await waitFor(() => count(bob) >= total, { timeoutMs: 600_000, intervalMs: 100, what: "bob holds every post" });
  const replicatedMs = Date.now() - t;
  bob.d.projects.flushAll();
  const bobCards = (await Promise.all(channels.map((ch) => bob.client().project(ch)))).reduce((n, p) => n + p.cards.length, 0);
  const convergedMs = Date.now() - t;

  const bytes = bob.d.core.store.db.query<{ json: number; body: number; n: number; cards: number }, string[]>(
    `SELECT SUM(length(CAST(json AS BLOB))) AS json, SUM(length(CAST(body AS BLOB))) AS body, COUNT(*) AS n,
       SUM(CASE WHEN thread IS NULL AND json_extract(body, '$.board.op') = 'card' THEN 1 ELSE 0 END) AS cards
     FROM events WHERE channel IN (${inList}) AND status = 'ok'`).get(...channels)!;

  // The interactive path for comparison: one card per request (its own fsync), the limiter aside.
  const probe = done.projects[0]!.channel;
  const k = 200;
  t = Date.now();
  for (let i = 0; i < k; i++) await cl.createTask({ project: probe, title: `interactive ${i}` });
  const perCardInteractive = (Date.now() - t) / k;

  const mb = (b: number) => `${(b / 1024 / 1024).toFixed(2)} MB`;
  console.log(JSON.stringify({
    issues: N, plan_ms: planMs, import_ms: importMs, cards_created: done.created, digest_comments: done.comments, signed_posts: done.events,
    replicated_ms: replicatedMs, bob_cards: bobCards, converged_ms: convergedMs,
    replicated: { events: bytes.n, cards: bytes.cards, total: mb(bytes.json), per_card: Math.round(bytes.json / Math.max(1, bytes.cards)), header_overhead_per_post: Math.round((bytes.json - bytes.body) / bytes.n), header_share: `${Math.round(((bytes.json - bytes.body) / bytes.json) * 100)}%` },
    interactive: { ms_per_card_without_limiter: Math.round(perCardInteractive * 10) / 10, person_limit_min_for_same_posts: Math.round(Math.max(0, done.events - 60) / 60), agent_limit_min: Math.round((Math.max(0, done.events - 20) * 3) / 60) },
    linear_requests: lin.calls.length,
  }, null, 1));
} finally {
  await c.close();
  lin.stop();
}
