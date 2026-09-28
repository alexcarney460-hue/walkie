// In-memory fakes of the Fireflies, Linear and Wispr share HTTP APIs behind one FetchLike. All content
// is fictional. Every request is recorded (url, auth header, parsed GraphQL body) for assertions.
import type { FetchLike } from "../../src/integrations/types.ts";

export interface Recorded { url: string; method: string; auth: string | null; query?: string; variables?: Record<string, unknown> }

export interface FakeTranscript {
  id: string; title: string; date: number; duration: number; transcript_url: string; participants: string[];
  speakers: { name: string }[]; summary: { overview: string; action_items: string; keywords: string[] };
  sentences: { speaker_name: string; text: string; start_time: number }[];
}

export interface FakeIssue {
  id: string; identifier: string; title: string; url: string; priority: number; priorityLabel: string; updatedAt: string;
  state: { id: string; name: string; type: string }; assignee: { name: string; displayName: string } | null; team: { key: string };
  history: { nodes: { id: string; createdAt: string; fromState: { name: string } | null; toState: { id: string; name: string } | null; actor: { name: string } | null }[] };
}

export type FailMode = { kind: "http"; status: number } | { kind: "graphql" } | { kind: "network" } | { kind: "shape" };

export class FakeApis {
  readonly calls: Recorded[] = [];
  transcripts: FakeTranscript[] = [];
  issues: FakeIssue[] = [];
  created: { input: Record<string, unknown> }[] = [];
  pages = new Map<string, { status: number; type: string; body: string }>();
  /** When set, every Fireflies/Linear call answers with this HTTP status (and echoes the auth header in the error text). */
  failWith: number | null = null;
  /**
   * Finer failure modes, each echoing the request's Authorization header back: an HTTP error status
   * with a GraphQL error body, a 200 with `data: null` + a GraphQL error, a thrown network error, or a
   * wrong-shaped `data` payload.
   */
  failMode: FailMode | null = null;
  /** Remaining failures per share URL: 503s, 429s or thrown network errors before it answers normally. */
  pageFailures = new Map<string, { kind: "network" | 503 | 429; left: number }>();
  /** Requests whose URL contains this string hang until their AbortSignal fires. */
  hang: string | null = null;
  /** Called when a hanging request starts. */
  onHang: (() => void) | null = null;
  /** GraphQL requests whose query contains `gateQuery` wait for `gate` before they are answered (a barrier for races). */
  gateQuery: string | null = null;
  gate: Promise<void> | null = null;
  onGate: (() => void) | null = null;

  transcript(over: Partial<FakeTranscript> & { id: string; date: number }): FakeTranscript {
    const t: FakeTranscript = {
      title: "Weekly sync", duration: 31.4, transcript_url: `https://app.fireflies.ai/view/${over.id}`,
      participants: ["maren@kestrel.example", "kira@example.com"], speakers: [{ name: "Maren Okafor" }, { name: "Kira Moore" }],
      summary: { overview: "Discussed the invoice cents migration.", action_items: "**Kira Moore**\nShip the migration dry run (12:04)\n**Maren**\nReview PR #318", keywords: ["billing", "migration"] },
      sentences: [
        { speaker_name: "Maren Okafor", text: "Let's start with billing.", start_time: 1.2 },
        { speaker_name: "Kira Moore", text: "The dry run is green.", start_time: 65 },
      ],
      ...over,
    };
    this.transcripts.push(t);
    return t;
  }

  issue(key: string, state: string, over: Partial<FakeIssue> = {}): FakeIssue {
    const i: FakeIssue = {
      id: `uuid-${key}`, identifier: key, title: `Fictional issue ${key}`, url: `https://linear.app/kestrel/issue/${key.toLowerCase()}`,
      priority: 2, priorityLabel: "High", updatedAt: new Date().toISOString(),
      state: { id: `st-${state}`, name: state, type: "started" }, assignee: { name: "Kira", displayName: "kira" }, team: { key: key.split("-")[0] as string },
      history: { nodes: [] }, ...over,
    };
    this.issues = [...this.issues.filter((x) => x.identifier !== key), i];
    return i;
  }

  count(pred: (r: Recorded) => boolean): number { return this.calls.filter(pred).length; }

  readonly fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const rec: Recorded = { url, method, auth: headers.get("authorization") };
    if (init?.body && typeof init.body === "string") {
      const b = JSON.parse(init.body) as { query: string; variables?: Record<string, unknown> };
      rec.query = b.query;
      rec.variables = b.variables;
    }
    this.calls.push(rec);
    if (this.hang && url.includes(this.hang)) {
      const signal = init?.signal ?? undefined;
      this.onHang?.();
      return new Promise<Response>((_resolve, reject) => {
        const fail = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
        if (signal?.aborted) { fail(); return; }
        signal?.addEventListener("abort", fail, { once: true });
      });
    }
    if (url === "https://api.fireflies.ai/graphql" || url === "https://api.linear.app/graphql") {
      if (this.gateQuery && this.gate && rec.query?.includes(this.gateQuery)) { this.onGate?.(); await this.gate; }
      if (this.failWith) return Response.json({ errors: [{ message: `denied for ${rec.auth}` }] }, { status: this.failWith });
      const fm = this.failMode;
      if (fm?.kind === "http") return Response.json({ errors: [{ message: `denied for ${rec.auth}` }] }, { status: fm.status });
      if (fm?.kind === "graphql") return Response.json({ data: null, errors: [{ message: `Authentication failed for token ${rec.auth}` }] });
      if (fm?.kind === "network") throw new Error(`connect ECONNRESET while sending Authorization: ${rec.auth}`);
      if (fm?.kind === "shape") {
        return Response.json({ data: { transcripts: [{ id: 7, title: rec.auth }], issues: { nodes: [{ id: rec.auth }] }, teams: { nodes: [{ id: 1, key: rec.auth }] } } });
      }
      return url.includes("fireflies") ? this.fireflies(rec) : this.linear(rec);
    }
    const pf = this.pageFailures.get(url);
    if (pf && pf.left > 0) {
      pf.left--;
      if (pf.kind === "network") throw new Error("getaddrinfo ENOTFOUND notes.wisprflow.ai");
      return new Response("unavailable", { status: pf.kind, headers: { "Content-Type": "text/plain" } });
    }
    const page = this.pages.get(url);
    if (page) return new Response(page.body, { status: page.status, headers: { "Content-Type": page.type } });
    return new Response("not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  };

  private fireflies(r: Recorded): Response {
    const q = r.query ?? "";
    if (q.includes("transcripts(")) {
      const from = Date.parse(String(r.variables?.fromDate ?? "1970-01-01"));
      const to = r.variables?.toDate ? Date.parse(String(r.variables.toDate)) : Number.POSITIVE_INFINITY;
      const skip = Number(r.variables?.skip ?? 0);
      const limit = Math.min(50, Number(r.variables?.limit ?? 50)); // the real API caps limit at 50
      const list = this.transcripts.filter((t) => t.date >= from && t.date <= to).sort((a, b) => b.date - a.date).slice(skip, skip + limit)
        .map(({ sentences: _s, ...meta }) => meta);
      return Response.json({ data: { transcripts: list } });
    }
    if (q.includes("transcript(id")) {
      const t = this.transcripts.find((x) => x.id === r.variables?.id);
      return Response.json({ data: { transcript: t ? { id: t.id, sentences: t.sentences } : null } });
    }
    return Response.json({ errors: [{ message: "unknown query" }] }, { status: 400 });
  }

  /** The first page of an issue's history as the real API serves it inside an issues query (with pageInfo). */
  private historyPage(i: FakeIssue, q: string): FakeIssue["history"] & { pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
    const first = Number(/history\(first: (\d+)/.exec(q)?.[1] ?? 25);
    const nodes = i.history.nodes.slice(0, first);
    return { nodes, pageInfo: { hasNextPage: i.history.nodes.length > first, endCursor: nodes.at(-1)?.id ?? null } };
  }

  private linear(r: Recorded): Response {
    const q = r.query ?? "";
    const v = r.variables ?? {};
    if (q.includes("issueCreate")) {
      const input = (v.input ?? {}) as Record<string, unknown>;
      this.created.push({ input });
      const n = 900 + this.created.length;
      return Response.json({ data: { issueCreate: { success: true, issue: { id: `new-${n}`, identifier: `KST-${n}`, title: input.title, url: `https://linear.app/kestrel/issue/kst-${n}` } } } });
    }
    if (q.includes("teams(")) {
      const teams = [{ id: "team-kst", key: "KST", name: "Kestrel" }];
      return Response.json({ data: { teams: { nodes: v.key ? teams.filter((t) => t.key === v.key) : teams } } });
    }
    if (q.includes("issue(id:")) {
      // One issue's history, paged like Linear does (`after` = the id of the previous page's last node).
      const issue = this.issues.find((i) => i.id === v.id);
      if (!issue) return Response.json({ data: { issue: null } });
      const first = Number(/history\(first: (\d+)/.exec(q)?.[1] ?? 50);
      const all = issue.history.nodes;
      const start = typeof v.after === "string" ? all.findIndex((h) => h.id === v.after) + 1 : 0;
      const nodes = all.slice(start, start + first);
      return Response.json({ data: { issue: { history: { nodes, pageInfo: { hasNextPage: start + first < all.length, endCursor: nodes.at(-1)?.id ?? null } } } } });
    }
    if (q.includes("issues(")) {
      const team = String(v.team ?? "");
      const numbers = Array.isArray(v.numbers) ? (v.numbers as number[]) : null;
      const since = v.since ? Date.parse(String(v.since)) : null;
      const until = v.until ? Date.parse(String(v.until)) : null;
      const first = Number(/issues\(first: (\d+)/.exec(q)?.[1] ?? 50);
      const all = this.issues
        .filter((i) => i.team.key === team)
        .filter((i) => !numbers || numbers.includes(Number(i.identifier.split("-")[1])))
        .filter((i) => since === null || Date.parse(i.updatedAt) > since)
        .filter((i) => until === null || Date.parse(i.updatedAt) <= until)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id))
        .map((i) => (q.includes("history(") ? { ...i, history: this.historyPage(i, q) } : { ...i, history: undefined }));
      // Cursor pagination: `after` is the id of the previous page's last node.
      const start = typeof v.after === "string" ? all.findIndex((i) => i.id === v.after) + 1 : 0;
      const nodes = all.slice(start, start + first);
      return Response.json({ data: { issues: { nodes, pageInfo: { hasNextPage: start + first < all.length, endCursor: nodes.at(-1)?.id ?? null } } } });
    }
    return Response.json({ errors: [{ message: "unknown query" }] }, { status: 400 });
  }
}
