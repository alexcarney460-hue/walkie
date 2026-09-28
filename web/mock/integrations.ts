// Mock integrations for the dashboard: connector status, fictional meeting/issue posts from the
// Fireflies, Wispr Flow and Linear connectors, and Linear enrichment for the seeded task keys.
// Every name, meeting, issue and URL here is invented.
import type { IntegrationView, LinearIssueInfo } from "../../src/integrations/views.ts";
import { sha256Hex, type World } from "./world.ts";

const MIN = 60_000;

const ISSUES: Record<string, Omit<LinearIssueInfo, "key" | "url">> = {
  "KST-398": { title: "Store invoice totals as integer cents", state: "In Progress", state_type: "started", assignee: "Maren Okafor", priority: 1, priority_label: "Urgent" },
  "KST-412": { title: "Checkout summary panel on tokens v2", state: "In Progress", state_type: "started", assignee: "Maren Okafor", priority: 2, priority_label: "High" },
  "KST-388": { title: "Rate-limit middleware for the public API", state: "In Review", state_type: "started", assignee: "Maren Okafor", priority: 2, priority_label: "High" },
  "KST-377": { title: "Upgrade staging Postgres to 16", state: "Blocked", state_type: "started", assignee: "Tobias Lindqvist", priority: 2, priority_label: "High" },
  "KST-405": { title: "Webhook retry guide", state: "Todo", state_type: "unstarted", assignee: "Tobias Lindqvist", priority: 3, priority_label: "Medium" },
  "KST-409": { title: "Port Button and Field to tokens v2", state: "In Progress", state_type: "started", assignee: "Ines Achterberg", priority: 3, priority_label: "Medium" },
  "KST-411": { title: "Empty states for Releases, Webhooks, API keys", state: "In Review", state_type: "started", assignee: "Ines Achterberg", priority: 4, priority_label: "Low" },
  "KST-401": { title: "Search p95 under 150 ms", state: "In Progress", state_type: "started", assignee: "Sol Ferreira", priority: 1, priority_label: "Urgent" },
};

export function issueInfo(key: string): LinearIssueInfo | null {
  const i = ISSUES[key];
  return i ? { key, ...i, url: `https://linear.app/kestrel/issue/${key.toLowerCase()}` } : null;
}

const TRANSCRIPT = [
  "Kestrel weekly sync (2026-09-25 15:00 UTC)",
  "Source: Fireflies https://app.fireflies.ai/view/kestrel-weekly-sync-01",
  "",
  "[0:04] Maren Okafor: Let's start with billing. Where are we on the cents migration?",
  "[0:19] Tobias Lindqvist: The dry run of 0042 is clean against the staging snapshot. Lock estimate is under two seconds.",
  "[0:41] Maren Okafor: Good. I want a human OK in ops before it runs, same as always.",
  "[1:02] Sol Ferreira: Search is at 188 milliseconds p95 with the trigram index. The rank column is next.",
  "[1:30] Ines Achterberg: Tokens v2 slips to 2.15. Field is done, Select is in progress.",
  "[2:05] Tobias Lindqvist: pg-16 is blocked on the CI state lock. I'll cancel the stuck drift check.",
  "[2:40] Maren Okafor: Sol, can you post prod numbers for search next week before we publish anything?",
  "[2:52] Sol Ferreira: Yes, after the Tuesday deploy.",
].join("\n");

const WISPR_TRANSCRIPT = [
  "Wispr Flow meeting 7d1c2a90 (2026-09-25 13:10 UTC)",
  "",
  "[0:02] Ines Achterberg: Quick design check on the discount row.",
  "[0:15] Maren Okafor: It competes with the total. Can it be one step quieter?",
  "[0:31] Ines Achterberg: Text-2 instead of text, and no chip. I'll mock both.",
  "[1:12] Maren Okafor: Ship the quieter one to ux-seat when it's ready.",
].join("\n");

export function seedIntegrationPosts(world: World): void {
  const now = Date.now();
  for (const c of [
    { name: "meetings", topic: "Meeting notes from the Fireflies and Wispr Flow integrations." },
    { name: "linear", topic: "Issue state changes from the Linear integration." },
  ]) {
    world.channels.push(c);
    world.emit({ handle: "maren", hostname: "maren-mbp", kind: "channel.upsert", ts: now - 8 * 24 * 60 * MIN, silent: true, body: { ...c } });
  }

  const blob = (name: string, text: string) => {
    const bytes = new TextEncoder().encode(text);
    const hash = sha256Hex(bytes);
    world.blobs.set(hash, { bytes, mime: "text/plain; charset=utf-8", name });
    return { hash, size: bytes.byteLength };
  };

  const ff = blob("kestrel-weekly-sync-2026-09-25.txt", TRANSCRIPT);
  const ffText = [
    "**Meeting: Kestrel weekly sync**",
    "2026-09-25 15:00 UTC · 34 min · 4 participants",
    "Speakers: Maren Okafor, Tobias Lindqvist, Sol Ferreira, Ines Achterberg",
    "",
    "**Overview**",
    "Billing's cents migration is ready for its staging run pending a human OK in #ops. Search p95 is down to 188 ms; the rank column is next. Tokens v2 moves to 2.15. The pg-16 upgrade is blocked on a stuck CI state lock.",
    "",
    "**Action items**",
    "**Tobias Lindqvist** → @tobias",
    "Cancel CI run 5521 so the pg-16 plan can take the state lock (2:05)",
    "**Sol Ferreira** → @sol",
    "Post prod search numbers after the Tuesday deploy (2:52)",
    "",
    "Keywords: billing, cents migration, search, tokens v2, pg-16",
    "",
    "Transcript in Fireflies: https://app.fireflies.ai/view/kestrel-weekly-sync-01",
  ].join("\n");
  const post = world.emit({
    handle: "maren", hostname: "maren-mbp", agent: "fireflies", kind: "msg.post", channel: "meetings", ts: now - 22 * MIN, silent: true,
    body: { text: ffText, mentions: ["@tobias", "@sol"], artifacts: [ff.hash] },
  });
  world.emit({
    handle: "maren", hostname: "maren-mbp", agent: "fireflies", kind: "artifact.share", channel: "meetings", ts: now - 22 * MIN + 400, silent: true,
    body: { hash: ff.hash, name: "kestrel-weekly-sync-2026-09-25.txt", size: ff.size, mime: "text/plain; charset=utf-8", note: "Full transcript (Fireflies)", thread: post.id },
  });
  world.emit({
    handle: "tobias", hostname: "tobias-mbp", agent: "infra", kind: "msg.post", channel: "meetings", ts: now - 19 * MIN, silent: true,
    body: { text: "Picked up the action item: waiting for 5521 to be cancelled, then retrying the plan.", thread: post.id },
  });

  const wf = blob("wispr-meeting-2026-09-25-7d1c2a90.txt", WISPR_TRANSCRIPT);
  const wp = world.emit({
    handle: "ines", hostname: "ines-studio", agent: "wispr", kind: "msg.post", channel: "meetings", ts: now - 118 * MIN, silent: true,
    body: {
      text: "**Wispr Flow meeting**\n2026-09-25 13:10 UTC · 2 min · 4 lines\nSpeakers: Ines Achterberg, Maren Okafor\n\nExcerpt:\n> Ines Achterberg: Quick design check on the discount row.\n> Maren Okafor: It competes with the total. Can it be one step quieter?\n\nFull transcript attached.",
      artifacts: [wf.hash],
    },
  });
  world.emit({
    handle: "ines", hostname: "ines-studio", agent: "wispr", kind: "artifact.share", channel: "meetings", ts: now - 118 * MIN + 300, silent: true,
    body: { hash: wf.hash, name: "wispr-meeting-2026-09-25-7d1c2a90.txt", size: wf.size, mime: "text/plain; charset=utf-8", note: "Full transcript (Wispr Flow)", thread: wp.id },
  });

  const transitions: Array<[number, string, string, string, string]> = [
    [205, "KST-401", "Todo", "In Progress", "Sol Ferreira"],
    [140, "KST-388", "In Progress", "In Review", "Maren Okafor"],
    [26, "KST-377", "In Progress", "Blocked", "Tobias Lindqvist"],
  ];
  for (const [ago, key, from, to, actor] of transitions) {
    const info = issueInfo(key);
    world.emit({
      handle: "maren", hostname: "maren-mbp", agent: "linear", kind: "msg.post", channel: "linear", ts: now - ago * MIN, silent: true,
      body: { text: `**${key}** ${from} → ${to} (by ${actor})\n${info?.title ?? ""}\n${info?.url ?? ""}` },
    });
  }
}

export class MockIntegrations {
  private readonly items: IntegrationView[];

  constructor() {
    const now = Date.now();
    const base = { running: false, last_error: null } as const;
    this.items = [
      { ...base, id: "fireflies", name: "Fireflies", enabled: true, configured: true, needs_key: true, key_source: "key_path", key_path: "~/keys/fireflies-api.txt", channel: "meetings", settings: { interval_s: 300 }, last_run: now - 3 * MIN, last_ok: now - 3 * MIN, items_posted: 12, next_run: now + 2 * MIN },
      { ...base, id: "wispr", name: "Wispr Flow", enabled: true, configured: true, needs_key: false, key_source: null, key_path: null, channel: "meetings", settings: { summarize: "claude", unfurl: true }, last_run: now - 40_000, last_ok: now - 40_000, items_posted: 3, next_run: now + 20_000 },
      { ...base, id: "linear", name: "Linear", enabled: true, configured: true, needs_key: true, key_source: "secret", key_path: null, channel: "linear", settings: { teams: [], default_team: "KST" }, last_run: now - 70_000, last_ok: now - 70_000, items_posted: 27, next_run: now + 50_000 },
    ];
  }

  private find(id: string): IntegrationView | undefined { return this.items.find((i) => i.id === id); }

  /** Handles /v1/integrations*, /v1/linear/issues and /v1/meetings; null for other paths. */
  async handle(req: Request, path: string, url: URL, world: World): Promise<Response | null> {
    if (path === "/v1/integrations" && req.method === "GET") return Response.json({ integrations: this.items });
    const m = /^\/v1\/integrations\/([a-z]+)(\/run)?$/.exec(path);
    if (m) {
      const v = this.find(m[1] as string);
      if (!v) return Response.json({ error: { code: "not_found", message: "no such integration" } }, { status: 404 });
      if (m[2] && req.method === "POST") {
        Object.assign(v, { last_run: Date.now(), last_ok: Date.now(), last_error: null });
        return Response.json({ integration: v });
      }
      if (req.method === "DELETE") {
        Object.assign(v, { enabled: false, configured: !v.needs_key, key_source: null, key_path: null, items_posted: 0, last_run: null, last_ok: null, next_run: null });
        return Response.json({ integration: v });
      }
      if (req.method === "POST") {
        const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        if (typeof b.key === "string" && b.key) Object.assign(v, { key_source: "secret", key_path: null, configured: true });
        if (typeof b.key_path === "string" && b.key_path) Object.assign(v, { key_source: "key_path", key_path: b.key_path, configured: true });
        if (v.needs_key && !v.configured && b.enabled !== false) return Response.json({ error: { code: "invalid", message: `${v.name} needs an API key (key or key_path)` } }, { status: 400 });
        const target = typeof b.channel === "string" ? b.channel : v.channel;
        if (b.enabled !== false && !world.channels.some((c) => c.name === target)) {
          // Like the daemon: connectors never create channels (INTEGRATIONS-FIX-1 #12).
          const hint = `walkie channel create ${target}`;
          return Response.json({ error: { code: "unknown_channel", message: `#${target} doesn't exist yet. Create it first: ${hint}`, channel: target, hint } }, { status: 409 });
        }
        const { key: _k, key_path: _p, enabled, channel, ...settings } = b;
        Object.assign(v, { enabled: enabled !== false, ...(typeof channel === "string" ? { channel } : {}), settings: { ...v.settings, ...settings } });
        return Response.json({ integration: v });
      }
    }
    if (path === "/v1/linear/issues" && req.method === "GET") {
      const keys = (url.searchParams.get("keys") ?? "").split(",").filter(Boolean);
      return Response.json({ enabled: this.find("linear")?.enabled === true, issues: Object.fromEntries(keys.map((k) => [k, issueInfo(k)])) });
    }
    if (path === "/v1/meetings" && req.method === "GET") {
      const events = world.events.filter((e) => e.kind === "msg.post" && (e.author.agent === "fireflies" || e.author.agent === "wispr") && !(e.body as { thread?: string }).thread)
        .sort((a, b) => b.ts - a.ts);
      return Response.json({ events });
    }
    return null;
  }
}
