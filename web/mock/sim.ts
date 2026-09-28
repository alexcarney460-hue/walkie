// Simulation loop: agents change activity and state, post now and then, and one
// laptop on hotel wifi drops off the tailnet and comes back.
import type { MachineStats } from "../../src/protocol/machine-stats.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import type { StatusBody, World } from "./world.ts";
import { driftAccounts } from "./accounts.ts";

const TICK_MS = 2_500;

const ACTIVITY: Record<string, string[]> = {
  "maren-mbp/ux-seat": ["Edit src/checkout/SummaryPanel.tsx", "Read src/ui/tokens.css", "Bash bun run typecheck", "Edit src/checkout/DiscountRow.tsx", "Bash bun test checkout", "Grep \"dense\" src/checkout"],
  "atlas/api-seat": ["Bash bun test src/billing", "Edit src/billing/totals.ts", "Read migrations/0042_invoice_cents.sql", "Edit src/billing/format.ts", "Grep \"invoice_totals\" src/search"],
  "atlas/e2e": ["playwright checkout/refund.spec.ts", "playwright settings/sso.spec.ts", "playwright search/filters.spec.ts", "playwright billing/invoice.spec.ts"],
  "tobias-mbp/docs": ["Write guides/webhooks/retries.mdx", "Read src/webhooks/retry.ts", "Bash bun run docs:build", "Edit guides/webhooks/signing.mdx"],
  "ines-studio/design-sys": ["Edit src/ui/Field.tsx", "Edit src/ui/Select.tsx", "Bash bun run storybook:build", "Read src/ui/tokens.css", "Write src/ui/Select.test.tsx"],
  "sol-x1/perf": ["Bash k6 run bench/search.js", "Edit src/search/rank.ts", "Write migrations/0044_rank_column.sql", "Bash psql -c \"EXPLAIN ANALYZE ...\""],
  "sol-x1/scratch": ["Edit src/export/csv.ts", "Bash bun test src/export"],
  "tobias-mbp/infra": ["Bash terraform plan -out plan.bin", "Read modules/db/main.tf", "Edit modules/db/params.tf"],
  "maren-mbp/review": ["Read src/middleware/limit.ts", "gh pr diff 327"],
};

interface Transition { tick: number; host: string; agent: string; patch: Partial<StatusBody> }

// A repeating 72-tick (3 min) script. Pairs keep roughly one agent blocked and
// two or three waiting at any moment, so every state is visible most of the time.
const CYCLE = 72;
const TRANSITIONS: Transition[] = [
  { tick: 8, host: "sol-x1", agent: "scratch", patch: { state: "working", title: "Resuming the streaming CSV export spike", activity: "Edit src/export/csv.ts" } },
  { tick: 16, host: "tobias-mbp", agent: "infra", patch: { state: "working", title: "Lock cleared, re-running terraform plan for pg-16", activity: "Bash terraform plan -out plan.bin" } },
  { tick: 17, host: "atlas", agent: "e2e", patch: { state: "blocked", title: "refund.spec.ts times out on 3 retries, needs a look", activity: "playwright checkout/refund.spec.ts" } },
  { tick: 26, host: "maren-mbp", agent: "review", patch: { state: "working", title: "Reviewing PR #327 (search rank column)", task: "KST-401", repo: "harbor-api", branch: "perf/search-index", activity: "gh pr diff 327" } },
  { tick: 34, host: "ines-studio", agent: "copy", patch: { state: "working", title: "Writing Webhooks empty-state copy with option B", activity: "Edit copy/webhooks.json" } },
  { tick: 38, host: "maren-mbp", agent: "ux-seat", patch: { state: "waiting", title: "Asked Maren: discount row as a badge or inline text?", activity: "Notification" } },
  { tick: 44, host: "atlas", agent: "e2e", patch: { state: "working", title: "Nightly e2e: re-running the refund spec in isolation", activity: "playwright checkout/refund.spec.ts" } },
  { tick: 45, host: "tobias-mbp", agent: "infra", patch: { state: "blocked", title: "Plan shows drift in modules/cache, not applying without review", activity: "Bash terraform plan -out plan.bin" } },
  { tick: 52, host: "sol-x1", agent: "scratch", patch: { state: "idle", title: "Spike: streaming CSV export (parked)", activity: "Stop" } },
  { tick: 58, host: "maren-mbp", agent: "review", patch: { state: "idle", title: "Reviewed PR #327: approved with one nit", activity: "Stop" } },
  { tick: 62, host: "ines-studio", agent: "copy", patch: { state: "waiting", title: "Waiting on Ines to pick an empty-state headline", activity: "ask @ines" } },
  { tick: 66, host: "maren-mbp", agent: "ux-seat", patch: { state: "working", title: "Building the discount row as inline text", activity: "Edit src/checkout/DiscountRow.tsx" } },
];

const POSTS: Array<{ host: string; agent: string; channel: string; text: string }> = [
  { host: "sol-x1", agent: "perf", channel: "build", text: "Rank column backfill done on staging (1.2M rows, 38 s). p95 now 141 ms at 200 rps, under the 150 ms target." },
  { host: "atlas", agent: "e2e", channel: "build", text: "Progress: 156 of 180 specs, 1 failure so far (`checkout/refund.spec.ts`)." },
  { host: "ines-studio", agent: "design-sys", channel: "design", text: "`Select` ported. Keyboard: arrows, Home/End, type-ahead. Screen reader labels checked in VoiceOver." },
  { host: "tobias-mbp", agent: "docs", channel: "build", text: "Webhook retry guide is up for review: https://docs-preview.kestrel.example/pr/81" },
  { host: "atlas", agent: "api-seat", channel: "build", text: "Answer for perf: `invoice_totals` is no longer read by search after `fix/invoice-cents`. Safe to drop from the index." },
  { host: "tobias-mbp", agent: "infra", channel: "ops", text: "State lock is free. Plan re-run: 3 to add, 2 to change, 0 to destroy, matches the diff posted earlier." },
  { host: "maren-mbp", agent: "ux-seat", channel: "design", text: "Discount row: went with inline text in the muted tone, badge felt loud next to the total." },
  { host: "maren-mbp", agent: "review", channel: "build", text: "PR #327 approved. One nit: the rank column needs a `NOT NULL DEFAULT 0` so the backfill can't leave holes." },
];

const REPLIES = ["On it.", "Picking this up now, will post in this thread when done.", "Got it. Starting after the current test run finishes."];

export class Simulation {
  private tick = 0;
  private postIdx = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Each machine's seeded stats: the drift below stays around them. */
  private readonly baseStats: Map<string, MachineStats>;

  /** Each machine's seeded latency: the jitter below stays around it (LAN machines stay within 5 ms). */
  private readonly baseRtt: Map<string, number>;

  constructor(private readonly world: World) {
    this.baseStats = new Map(world.nodes.flatMap((n) => (n.stats ? [[n.node_id, n.stats] as const] : [])));
    this.baseRtt = new Map(world.nodes.map((n) => [n.node_id, n.rtt_ms]));
  }

  start(): void {
    this.timer = setInterval(() => this.step(), TICK_MS);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private setStatus(host: string, agent: string, patch: Partial<StatusBody>): void {
    const key = this.world.agentKey(host, agent);
    const cur = this.world.agents.get(key);
    const node = this.world.node(host);
    if (!cur || !node.online) return;
    this.world.emit({ handle: node.handle, hostname: host, agent, kind: "agent.status", body: { ...cur.status, ...patch } });
  }

  private step(): void {
    this.tick += 1;
    const phase = this.tick % CYCLE;

    for (const t of TRANSITIONS) if (t.tick === phase) this.setStatus(t.host, t.agent, t.patch);

    // One working agent reports a new tool action per tick.
    const working = this.world.agentViews().filter((a) => a.effective_state === "working" && ACTIVITY[`${a.hostname}/${a.agent}`]);
    const pick = working[this.tick % Math.max(1, working.length)];
    if (pick) {
      const pool = ACTIVITY[`${pick.hostname}/${pick.agent}`]!;
      const next = pool[(this.tick * 7 + pick.agent.length) % pool.length]!;
      if (next !== pick.status.activity) this.setStatus(pick.hostname, pick.agent, { activity: next });
    }

    if (this.tick % 16 === 6) this.agentPost();
    this.network(phase);
  }

  /** Each canned post goes out once per run, so a long-running mock never repeats itself. */
  private agentPost(): void {
    const p = POSTS[this.postIdx];
    if (!p) return;
    this.postIdx += 1;
    const node = this.world.node(p.host);
    if (!node.online) return;
    this.world.emit({ handle: node.handle, hostname: p.host, agent: p.agent, kind: "msg.post", channel: p.channel, body: { text: p.text } });
  }

  /** Latency jitter, sync lag, and the hotel-wifi laptop dropping out for ~30 s. */
  private network(phase: number): void {
    const sol = this.world.node("sol-x1");
    const now = Date.now();
    if (phase === 22) { sol.online = false; sol.behind = 0; }
    if (phase === 34) { sol.online = true; sol.behind = 7; sol.last_seen = now; sol.last_sync = now; }
    if (phase === 36) sol.behind = 0;
    for (const n of this.world.nodes) {
      if (!n.online || n.hostname === this.world.meNodeHost) continue;
      const base = this.baseRtt.get(n.node_id) ?? 47;
      n.rtt_ms = base <= 5 ? Math.max(1, Math.min(5, base + ((this.tick * 13 + base) % 3) - 1)) : base + ((this.tick * 13 + base) % 9) - 4;
      n.last_seen = now;
      if (this.tick % 6 === 0) n.last_sync = now;
    }
    // Machine stats drift the way a published snapshot does: a step every few ticks, not every tick.
    for (const n of this.world.nodes) {
      const base = this.baseStats.get(n.node_id);
      if (!n.online || !base || (this.tick + n.rtt_ms) % 4 !== 0) continue;
      const wiggle = ((this.tick * 7 + n.rtt_ms) % 5) - 2;
      const mem = base.mem ? { ...base.mem, used: Math.min(base.mem.total, base.mem.used + wiggle * 0.03 * base.mem.total) } : null;
      n.stats = { ...base, at: now, mem, temp_c: base.temp_c === null ? null : Math.round((base.temp_c + wiggle * 0.8) * 10) / 10 };
    }
    this.world.broadcast({ type: "nodes", nodes: this.world.nodeViews() });
    if (phase === 22 || phase === 34) this.world.broadcast({ type: "agents", ...this.world.agentsPayload() });
    // Accounts: usage creeps up (meters fall) every few ticks; a machine going offline changes its row.
    if (this.tick % 5 === 0) driftAccounts(this.world, this.tick);
    if (this.tick % 5 === 0 || phase === 22 || phase === 34) this.world.broadcast({ type: "accounts", accounts: this.world.accountViews() });
  }

  /** A human mentioned an agent: that agent acknowledges in the thread a few seconds later. */
  onHumanPost(event: Event): void {
    const text = String((event.body as { text?: string }).text ?? "");
    const match = text.match(/@([a-z][a-z0-9-]*)\/([a-z0-9][a-z0-9.-]*)\/([a-z0-9][a-z0-9._-]*)/);
    if (!match || !event.channel) return;
    const [, , host, agent] = match as unknown as [string, string, string, string];
    const node = this.world.nodes.find((n) => n.hostname === host);
    if (!node?.online || !this.world.agents.has(`${node.handle}/${host}/${agent}`)) return;
    const thread = (event.body as { thread?: string }).thread ?? event.id;
    const channel = event.channel;
    setTimeout(() => {
      this.world.emit({ handle: node.handle, hostname: host, agent, kind: "msg.post", channel, body: { text: REPLIES[this.tick % REPLIES.length]!, thread } });
    }, 3_500);
  }
}
