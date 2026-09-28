// Mission Control on the phone (WALKIE-PWA-1): who is working on which machine, the asks waiting for you (answer or
// decline), and a channel's posts with a reply box. Everything comes through the encrypted link (src/mobile/client.ts)
// and is refreshed from the live stream.
import type { AgentView, AskView, Event as WalkieEvent, MeView, NodeView, TeamView } from "../../protocol/schemas.ts";
import type { MobileLink } from "../client.ts";
import { h, relTime, replace } from "./dom.ts";

type Tab = "agents" | "asks" | "posts";

const STATE_ORDER: Record<string, number> = { working: 0, waiting: 1, blocked: 2, idle: 3, offline: 4 };
const STATE_LABEL: Record<string, string> = { working: "Working", waiting: "Waiting on you", blocked: "Blocked", idle: "Idle", offline: "Offline" };

export interface MissionHooks {
  settings(): void;
}

export class Mission {
  private me: MeView | null = null;
  private team: TeamView | null = null;
  private agents: AgentView[] = [];
  private nodes: NodeView[] = [];
  /** Open asks; null until they loaded once. */
  private asks: AskView[] | null = null;
  private asksError: string | null = null;
  private asksTruncated = false;
  /** Posts per channel (never one channel's under another's name), and each channel's load state. */
  private readonly postsBy = new Map<string, WalkieEvent[]>();
  private readonly postsError = new Map<string, string>();
  /** Bumped by every posts load: a slower, older load can't overwrite a newer one. */
  private postsGen = 0;
  private viewError: string | null = null;
  private channel = "general";
  private tab: Tab = "agents";
  private showIdle = false;
  private readonly drafts = new Map<string, string>();
  private askKeys: string | null = null;
  private cancelStream: (() => void) | null = null;
  private refetch: ReturnType<typeof setTimeout> | null = null;
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly title: HTMLElement;
  private readonly composer: HTMLElement;
  private readonly note: HTMLElement;
  private readonly dot: HTMLElement;
  private readonly fresh: HTMLElement;
  /** When data last arrived (a stream message or a successful load). */
  private updatedAt = 0;
  private streamLive = false;
  private streamAttempt = 0;
  private resubscribe: ReturnType<typeof setTimeout> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private loadedAt = Date.now();

  constructor(private readonly link: MobileLink, private readonly hooks: MissionHooks, banner: HTMLElement | null) {
    this.title = h("span", { class: "top-team" }, "Walkie");
    this.note = h("div", { class: "note", role: "status", "aria-live": "polite" });
    this.body = h("main", { class: "body", id: "main" });
    this.composer = h("div", { class: "composer-slot" });
    this.tabs = h("nav", { class: "tabs", "aria-label": "Sections" });
    this.dot = h("span", { class: "dot dot-off", role: "img", "aria-label": "Connecting" });
    this.fresh = h("span", { class: "fresh muted small", "aria-live": "off" });
    this.root = h("div", { class: "app" },
      h("header", { class: "top" },
        h("span", { class: "logo", "aria-hidden": "true" }),
        this.title,
        this.dot,
        this.fresh,
        h("span", { class: "spacer" }),
        h("button", { class: "btn-ghost", type: "button", onclick: () => this.hooks.settings(), "aria-label": "Settings" }, "Settings"),
      ),
      banner, this.note, this.body, this.composer, this.tabs);
  }

  get element(): HTMLElement { return this.root; }

  async start(): Promise<void> {
    await this.loadAll();
    if (this.stopped) return; // stopped while loading: nothing may be scheduled after stop()
    this.updatedAt = Date.now();
    this.subscribe();
    this.ticker = setInterval(() => {
      if (this.stopped) { if (this.ticker) clearInterval(this.ticker); return; }
      this.freshness();
      // A full reload every 5 minutes as well: the live stream says what changed, not everything that might have.
      if (Date.now() - this.loadedAt > 5 * 60_000) { this.loadedAt = Date.now(); void this.loadAll().then(() => this.render()).catch(() => undefined); }
    }, 5_000);
    this.render();
  }

  stop(): void {
    this.stopped = true;
    this.cancelStream?.();
    this.cancelStream = null;
    if (this.refetch) clearTimeout(this.refetch);
    if (this.resubscribe) clearTimeout(this.resubscribe);
    if (this.ticker) clearInterval(this.ticker);
  }

  /** The live stream. When it ends (refused, capacity, the daemon), say so and resubscribe with backoff, reloading. */
  private subscribe(): void {
    if (this.stopped) return;
    this.cancelStream = this.link.stream("/v1/stream", (type, data) => {
      if (!this.streamLive) { this.streamLive = true; this.streamAttempt = 0; }
      this.updatedAt = Date.now();
      this.onStream(type, data);
    }, (err) => {
      this.streamLive = false;
      this.cancelStream = null;
      if (this.stopped || !this.link.isOpen) return;
      const wait = Math.min(30, 2 ** this.streamAttempt++);
      this.say(`Live updates stopped${err ? ` (${err.message})` : ""}. Reconnecting in ${wait} s…`);
      this.freshness();
      this.resubscribe = setTimeout(() => {
        if (this.stopped) return;
        void this.loadAll().then(() => { this.updatedAt = Date.now(); this.render(); }).catch(() => undefined);
        this.subscribe();
      }, wait * 1000);
    });
  }

  /** The header says how fresh the data is; the dot is green only while the live stream runs. */
  private freshness(): void {
    const age = Math.max(0, Math.round((Date.now() - this.updatedAt) / 1000));
    const live = this.streamLive && this.link.isOpen;
    this.dot.className = `dot ${live ? "dot-on" : "dot-stale"}`;
    this.dot.setAttribute("aria-label", live ? "Live" : "Not live");
    // Live = the stream runs on a link the daemon's authenticated heartbeat keeps proving (client.ts watch()).
    this.fresh.textContent = live ? "live" : `updated ${age < 60 ? `${age} s` : `${Math.round(age / 60)} min`} ago`;
  }

  /** A view's data, or null (the caller keeps what it had and shows the error in that view: never an empty list). */
  private async get<T>(path: string): Promise<T | null> {
    const r = await this.link.request<T>("GET", path);
    if (r.status === 200) return r.body;
    const m = (r.body as { error?: { message?: unknown } } | null)?.error?.message;
    this.viewError = `Couldn't refresh (${typeof m === "string" ? m : `error ${r.status}`}); showing the last data.`;
    return null;
  }

  private async loadAll(): Promise<void> {
    const [me, team, agents, peers] = await Promise.all([
      this.get<MeView>("/v1/me"), this.get<TeamView>("/v1/team"), this.get<{ agents: AgentView[] }>("/v1/agents"), this.get<{ nodes: NodeView[] }>("/v1/peers"),
    ]);
    if (me) this.me = me;
    if (team) this.team = team;
    if (agents) this.agents = agents.agents;
    if (peers) this.nodes = peers.nodes;
    if (me && team && agents && peers) this.viewError = null;
    const names = (this.team?.channels ?? []).filter((c) => !c.archived).map((c) => c.name);
    if (names.length && !names.includes(this.channel)) this.channel = names[0] as string;
    await Promise.all([this.loadAsks(), this.loadPosts()]);
  }

  private async loadAsks(): Promise<void> {
    const r = await this.link.request<{ asks: AskView[]; truncated?: boolean }>("GET", "/v1/asks?state=open&to=me");
    if (r.status === 200) {
      this.asks = r.body.asks;
      this.asksTruncated = r.body.truncated === true;
      this.asksError = null;
      this.askKeys = null;
    } else {
      this.asksError = errorText(r.body, `error ${r.status}`);
    }
  }

  /**
   * One channel's posts, asking for fewer when the answer is too big for the phone link (40 → 20 → 10 → 5 → 2 → 1).
   * Stored under that channel; an older load that finishes after a newer one (a quick channel switch) is dropped.
   */
  private async loadPosts(channel = this.channel): Promise<void> {
    const gen = ++this.postsGen;
    for (const limit of [40, 20, 10, 5, 2, 1]) {
      const r = await this.link.request<{ events: WalkieEvent[] }>("GET", `/v1/events?channel=${encodeURIComponent(channel)}&kinds=msg.post&limit=${limit}`);
      if (gen !== this.postsGen) return;
      if (r.status === 413) continue;
      if (r.status === 200) { this.postsBy.set(channel, r.body.events.slice().reverse()); this.postsError.delete(channel); return; }
      this.postsError.set(channel, errorText(r.body, `error ${r.status}`));
      return;
    }
    this.postsError.set(channel, "these posts are too big for the phone link");
  }

  private onStream(type: string, data: unknown): void {
    if (type === "agents") this.agents = (data as { agents?: AgentView[] }).agents ?? this.agents;
    else if (type === "nodes") this.nodes = (data as { nodes?: NodeView[] }).nodes ?? this.nodes;
    else if (type === "event") {
      const ev = (data as { event?: WalkieEvent }).event;
      if (!ev) return;
      const list = ev.kind === "msg.post" && ev.channel ? this.postsBy.get(ev.channel) : undefined;
      if (list && ev.channel && !list.some((p) => p.id === ev.id)) this.postsBy.set(ev.channel, [...list, ev].slice(-80));
      if (ev.kind === "ask" || ev.kind === "answer") this.soon(() => this.loadAsks());
    } else if (type === "refresh") {
      // Roster changes arrive as a bare notice (the phone never gets roster events): reload team and channels.
      this.soon(() => this.loadAll());
    } else if (type === "hidden") {
      const ids = new Set((data as { ids?: string[] }).ids ?? []);
      for (const [ch, list] of this.postsBy) this.postsBy.set(ch, list.filter((p) => !ids.has(p.id)));
    }
    this.render();
  }

  private soon(fn: () => Promise<void>): void {
    if (this.refetch) clearTimeout(this.refetch);
    if (this.stopped) return;
    this.refetch = setTimeout(() => { if (!this.stopped) void fn().then(() => this.render()); }, 250);
  }

  /** A one-line status under the header. */
  notice(text: string): void { this.say(text); }

  private say(text: string): void {
    replace(this.note, text ? h("p", {}, text) : null);
  }

  // ---- rendering --------------------------------------------------------------------------------------------------

  private render(): void {
    this.freshness();
    this.title.textContent = this.team?.name ?? this.me?.team?.name ?? "Walkie";
    const working = this.agents.filter((a) => a.effective_state === "working").length;
    const tabs: [Tab, string, number][] = [["agents", "Agents", working], ["asks", "Asks", this.asks?.length ?? 0], ["posts", "Posts", 0]];
    replace(this.tabs, ...tabs.map(([id, label, n]) => h("button", {
      type: "button", class: id === this.tab ? "tab is-active" : "tab", "aria-current": id === this.tab ? "page" : undefined,
      onclick: () => { this.tab = id; this.askKeys = null; this.render(); },
    }, label, n ? h("span", { class: id === "asks" ? "count count-amber" : "count" }, String(n)) : null)));
    if (this.tab === "agents") { this.renderAgents(); replace(this.composer); }
    if (this.tab === "asks") { this.renderAsks(); replace(this.composer); }
    if (this.tab === "posts") this.renderPosts();
  }

  private renderAgents(): void {
    const byNode = new Map<string, AgentView[]>();
    for (const a of this.agents) byNode.set(a.node, [...(byNode.get(a.node) ?? []), a]);
    const machines = this.nodes.slice().sort((a, b) => Number(b.online) - Number(a.online) || a.hostname.localeCompare(b.hostname));
    const members = new Map((this.team?.members ?? []).map((m) => [m.handle, m.display_name ?? m.handle]));
    const active = this.agents.filter((a) => a.effective_state !== "idle" && a.effective_state !== "offline").length;
    const quiet = this.agents.length - active;
    const sections = machines.map((n) => {
      const list = (byNode.get(n.node_id) ?? []).slice().sort((a, b) => (STATE_ORDER[a.effective_state] ?? 9) - (STATE_ORDER[b.effective_state] ?? 9) || b.updated_at - a.updated_at);
      const shown = this.showIdle ? list : list.filter((a) => a.effective_state !== "idle" && a.effective_state !== "offline");
      const hidden = list.length - shown.length;
      return h("section", { class: "machine" },
        h("h2", { class: "machine-h" },
          h("span", { class: `dot ${n.online ? "dot-on" : "dot-off"}`, "aria-label": n.online ? "online" : "offline" }),
          h("span", { class: "mono" }, n.hostname),
          h("span", { class: "muted" }, ` · ${members.get(n.handle) ?? n.handle}`),
        ),
        shown.length ? h("ul", { class: "agents" }, ...shown.map((a) => this.agentRow(a))) : h("p", { class: "muted small" }, list.length ? "Nothing running right now." : "No agents on this machine."),
        hidden ? h("p", { class: "muted small" }, `${hidden} idle or offline`) : null,
      );
    });
    replace(this.body,
      this.viewError ? h("p", { class: "alert" }, this.viewError) : null,
      h("div", { class: "summary" },
        h("p", {}, h("strong", {}, String(active)), active === 1 ? " agent active" : " agents active", quiet ? h("span", { class: "muted" }, ` · ${quiet} idle or offline`) : null),
        quiet ? h("button", { type: "button", class: "btn-ghost small", onclick: () => { this.showIdle = !this.showIdle; this.render(); } }, this.showIdle ? "Hide idle" : "Show all") : null,
      ),
      ...(sections.length ? sections : [h("p", { class: "empty" }, "No machines yet.")]),
    );
  }

  private agentRow(a: AgentView): HTMLElement {
    const s = a.status;
    const detail = [s.task, s.title ?? s.activity].filter(Boolean).join(" · ");
    return h("li", { class: `agent state-${a.effective_state}` },
      h("div", { class: "agent-top" },
        h("span", { class: "agent-name mono" }, a.agent),
        h("span", { class: `chip chip-${a.effective_state}` }, STATE_LABEL[a.effective_state] ?? a.effective_state),
      ),
      detail ? h("p", { class: "agent-detail" }, detail) : null,
      h("p", { class: "muted small" }, `${s.runtime ?? "agent"} · ${relTime(a.updated_at)}`),
    );
  }

  private renderAsks(): void {
    if (this.asks === null) {
      this.askKeys = null;
      replace(this.body, h("p", { class: "empty" }, this.asksError ? `Couldn't load your asks (${this.asksError}). Retrying with the next update.` : "Loading asks…"));
      return;
    }
    const asks = this.asks;
    const keys = `${asks.map((a) => a.ask.id).join(",")}|${this.asksError ?? ""}|${this.asksTruncated}`;
    if (keys === this.askKeys) return; // typing in an answer box survives live updates
    this.askKeys = keys;
    const status = this.asksError ? h("p", { class: "alert" }, `Couldn't refresh (${this.asksError}); showing the last asks.`)
      : this.asksTruncated ? h("p", { class: "muted small" }, "More asks are waiting than fit here: answer these, or see them all on your computer.") : null;
    if (!asks.length) { replace(this.body, status, h("p", { class: "empty" }, "Nothing is waiting for you.")); return; }
    replace(this.body, status, ...asks.map((v) => this.askCard(v)));
  }

  private askCard(v: AskView): HTMLElement {
    const ev = v.ask;
    const from = `@${ev.author.handle}${ev.author.agent ? `/${ev.author.agent}` : ""}`;
    const text = String((ev.body as { text?: unknown }).text ?? "");
    const box = h("textarea", { class: "input", rows: "3", placeholder: "Your answer", "aria-label": `Answer ${from}` }) as HTMLTextAreaElement;
    box.value = this.drafts.get(ev.id) ?? "";
    box.addEventListener("input", () => this.drafts.set(ev.id, box.value));
    const send = async (declined: boolean) => {
      const answer = box.value.trim();
      if (!declined && !answer) { box.focus(); return; }
      const r = await this.link.request("POST", "/v1/answer", { ask: ev.id, text: declined ? (answer || "Declined") : answer, ...(declined ? { declined: true } : {}) });
      if (r.status !== 200) { this.say(errorText(r.body, "Couldn't send the answer.")); return; }
      this.drafts.delete(ev.id);
      this.say(declined ? "Declined." : "Answer sent.");
      await this.loadAsks();
      this.askKeys = null;
      this.render();
    };
    return h("article", { class: "ask" },
      h("p", { class: "ask-from" }, h("span", { class: "mono" }, from), h("span", { class: "muted" }, ` · ${ev.channel ? `#${ev.channel} · ` : ""}${relTime(ev.ts)}`)),
      h("p", { class: "ask-text" }, text),
      box,
      h("div", { class: "row" },
        h("button", { type: "button", class: "btn", onclick: () => void send(false) }, "Answer"),
        h("button", { type: "button", class: "btn-ghost", onclick: () => void send(true) }, "Decline"),
      ),
    );
  }

  private renderPosts(): void {
    const channels = (this.team?.channels ?? []).filter((c) => !c.archived);
    const picker = h("select", { class: "input select", "aria-label": "Channel" }, ...channels.map((c) => {
      const o = h("option", { value: c.name }, `#${c.name}`);
      if (c.name === this.channel) o.setAttribute("selected", "");
      return o;
    })) as HTMLSelectElement;
    picker.addEventListener("change", () => { this.channel = picker.value; this.render(); void this.loadPosts(picker.value).then(() => this.render()); });
    const names = new Map((this.team?.members ?? []).map((m) => [m.handle, m.display_name ?? m.handle]));
    const posts = this.postsBy.get(this.channel);
    const failed = this.postsError.get(this.channel);
    replace(this.body,
      h("div", { class: "picker" }, picker),
      failed ? h("p", { class: "alert" }, posts ? `Couldn't refresh #${this.channel} (${failed}); showing the last posts.` : `Couldn't load #${this.channel} (${failed}).`) : null,
      !posts ? (failed ? null : h("p", { class: "empty" }, `Loading #${this.channel}…`))
      : posts.length
        ? h("ol", { class: "posts" }, ...posts.map((p) => h("li", { class: "post" },
          h("p", { class: "post-meta" }, h("strong", {}, names.get(p.author.handle) ?? p.author.handle), p.author.agent ? h("span", { class: "mono muted" }, ` /${p.author.agent}`) : null, h("span", { class: "muted" }, ` · ${relTime(p.ts)}`)),
          h("p", { class: "post-text" }, String((p.body as { text?: unknown }).text ?? "")),
        )))
        : h("p", { class: "empty" }, `No posts in #${this.channel} yet.`),
    );
    this.body.scrollTop = this.body.scrollHeight;
    const existing = this.composer.querySelector("textarea");
    if (existing) { existing.placeholder = `Message #${this.channel}`; return; }
    const input = h("textarea", { class: "input", rows: "1", placeholder: `Message #${this.channel}`, "aria-label": "Message" }) as HTMLTextAreaElement;
    const send = async () => {
      const text = input.value.trim();
      if (!text) return;
      const r = await this.link.request("POST", "/v1/post", { channel: this.channel, text });
      if (r.status !== 200) { this.say(errorText(r.body, "Couldn't post.")); return; }
      input.value = "";
      this.say("");
    };
    replace(this.composer, h("form", { class: "composer", onsubmit: (e: Event) => { e.preventDefault(); void send(); } },
      input, h("button", { type: "submit", class: "btn" }, "Send")));
  }
}

function errorText(body: unknown, fallback: string): string {
  const m = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof m === "string" ? m : fallback;
}
