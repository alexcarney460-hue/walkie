// Mock Projects (WALKIE-PROJECTS-1): a fictional project with cards, served like the daemon's /v1/projects and
// /v1/tasks routes (reads, create, update, comment). In memory; no fold, no signatures, no permissions.
import { DEFAULT_COLUMNS, type BoardView, type CardView, type Meter, type ProjectView, type TimelineEntry } from "../../src/protocol/projects/schema.ts";
import { keyBetween } from "../../src/protocol/projects/position.ts";
import { cardRef, shortId } from "../../src/protocol/projects/short.ts";
import { MockRoom } from "./room.ts";

const NOW = Date.now();
const MIN = 60_000;
const author = { handle: "maren", node: "a1b2c3d4e5f60718" };
const CH = "p-5eed0001";
const BOARD = "a1b2c3d4e5f60718:902";

function meterOf(cards: CardView[]): Meter {
  const role = (c: CardView) => DEFAULT_COLUMNS.find((x) => x.id === c.column)?.role ?? "todo";
  const by = { backlog: 0, todo: 0, active: 0, review: 0, done: 0, cancelled: 0 };
  for (const c of cards) if (c.state !== "deleted") by[role(c)] += 1;
  const counted = Object.values(by).reduce((a, b) => a + b, 0) - by.cancelled;
  return { mode: "count", done: by.done, counted, by_role: by };
}

export class MockProjects {
  private seq = 1000;
  private readonly cards: CardView[] = [];
  private readonly comments = new Map<string, TimelineEntry[]>();
  private readonly room: MockRoom;

  constructor() {
    const seed: Array<[string, string, string | null, string[]]> = [
      ["Pricing page copy", "review", "@maren", ["copy"]], ["Hero section with product video", "doing", "@maren/maren-mbp/cc-4f2a", ["design"]],
      ["Signup email verification", "doing", null, ["backend"]], ["Cookie banner", "done", null, ["legal"]],
      ["Footer links and sitemap", "todo", null, ["seo"]], ["Blog migration", "backlog", null, []],
    ];
    seed.forEach(([title, column, assignee, labels], i) => this.cards.push(this.card(i + 1, title, column, assignee, labels)));
    this.room = new MockRoom(CH, { pricing: (this.cards[0] as CardView).id, hero: (this.cards[1] as CardView).id });
  }

  private card(n: number, title: string, column: string, assignee: string | null, labels: string[]): CardView {
    const last = this.cards.filter((c) => c.column === column).map((c) => c.pos).sort().pop() ?? null;
    return {
      id: `a1b2c3d4e5f60718:${this.seq}`, channel: CH, board: BOARD, key: `WEB-${n}`, n, short: shortId(`a1b2c3d4e5f60718:${this.seq}`), ref: cardRef(`WEB-${n}`, `a1b2c3d4e5f60718:${this.seq++}`), title, body: "", column, pos: keyBetween(last, null),
      assignee, reviewer: null, labels, estimate: null, due: null, blocked: n === 3, blocked_reason: n === 3 ? "waiting on the mail vendor" : null,
      state: "open", created_at: NOW - (40 - n) * MIN, created_by: author, updated_at: NOW - n * MIN, updated_by: author, comments: 0, rev: 0,
    };
  }

  private project(): ProjectView {
    const board: BoardView = { id: BOARD, name: "Board", columns: [...DEFAULT_COLUMNS], state: "active", created_at: NOW - 3_600_000, created_by: author, meter: meterOf(this.cards), live_cards: this.cards.filter((c) => c.state === "open").length };
    return {
      channel: CH, id: "a1b2c3d4e5f60718:901", name: "Website relaunch", folder: "Harbor", description: "New marketing site", prefix: "WEB",
      paths: [{ path: "~/work/site" }], meter_mode: "count", automations: { pr_opened: true, pr_merged: false, agents_can_close: true },
      state: "active", private: false, admins: ["maren"], creator: "maren", created_at: NOW - 3_600_000, boards: [board], meter: board.meter,
      cards: this.cards.filter((c) => c.state !== "deleted").length, last_activity: Math.max(...this.cards.map((c) => c.updated_at)),
      room: this.room.summary(),
    };
  }

  private find(ref: string): CardView | undefined {
    return this.cards.find((c) => c.id === ref || c.ref === ref || c.key === ref.toUpperCase());
  }

  async handle(req: Request, path: string, json: (d: unknown, s?: number) => Response, fail: (s: number, c: string, m: string) => Response): Promise<Response | null> {
    const m = req.method;
    if (path === "/v1/projects" && m === "GET") return json({ projects: [this.project()], stubs: [] });
    if (path === "/v1/projects" && m === "POST") return fail(402, "plan_limit", "the mock has one project");
    if (path === `/v1/projects/${CH}` && m === "GET") return json({ project: this.project(), cards: this.cards.filter((c) => c.state !== "deleted"), timeline: [] });
    const room = await this.room.handle(req, path, (ref) => this.find(ref)?.id ?? null, json, fail);
    if (room) return room;
    if (path === "/v1/tasks" && m === "POST") {
      const b = (await req.json().catch(() => ({}))) as { title?: string; column?: string };
      if (!b.title) return fail(400, "invalid", "title required");
      const card = this.card(Math.max(...this.cards.map((c) => c.n)) + 1, b.title, b.column ?? "todo", null, []);
      this.cards.push(card);
      return json({ task: card });
    }
    const t = /^\/v1\/tasks\/([^/]+?)(\/comment)?$/.exec(path);
    if (!t) return null;
    const card = this.find(t[1] as string);
    if (!card) return fail(404, "not_found", "no such card");
    if (m === "GET") return json({ card, project: this.project(), timeline: [{ id: card.id, ts: card.created_at, author, kind: "create", changes: {} }, ...(this.comments.get(card.id) ?? [])], agents: [], files: this.room.forCard(card.id) });
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (t[2]) {
      const list = this.comments.get(card.id) ?? [];
      this.comments.set(card.id, [...list, { id: `a1b2c3d4e5f60718:${this.seq++}`, ts: Date.now(), author, kind: "comment", text: String(b.text ?? "") }]);
    }
    const { before: _b, after: _a, text: _t, ...fields } = b;
    const next: CardView = { ...card, ...(t[2] ? {} : fields), comments: (this.comments.get(card.id) ?? []).length, updated_at: Date.now(), rev: card.rev + 1 } as CardView;
    this.cards.splice(this.cards.indexOf(card), 1, next);
    return json({ task: next, ...(t[2] ? { event: null } : {}) });
  }
}
