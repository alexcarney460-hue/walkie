// Mock Data Room (DATA-ROOM-1) for the fictional Kestrel project: files with versions, pins and card attachments,
// served like the daemon's /v1/projects/<ch>/room routes. In memory; no signatures; the secret scan is the real one.
import type { Author } from "../../src/protocol/schemas.ts";
import type { RoomFileDetail, RoomFileView, RoomVersion, TimelineEntry } from "../../src/protocol/projects/schema.ts";
import { scanUpload } from "../../src/protocol/projects/room-scan.ts";
import { currentVersion } from "../../src/protocol/projects/room.ts";
import { sha256Hex } from "./world.ts";

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const NODE = { maren: "a1b2c3d4e5f60718", tobias: "b2c3d4e5f6071829", ines: "c3d4e5f60718293a", sol: "d4e5f60718293a4b" } as const;
type Who = keyof typeof NODE;
const who = (h: Who, agent?: string): Author => ({ handle: h, node: NODE[h], ...(agent ? { agent } : {}) });
const enc = (s: string) => new TextEncoder().encode(s);
/** A binary-looking file of `n` bytes (a real header, then filler). */
function binary(header: string, n: number): Uint8Array {
  const b = new Uint8Array(n);
  b.set(enc(header));
  for (let i = header.length; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

interface MockFile {
  id: string; name: string; pinned: boolean; state: "active" | "removed"; cards: string[];
  versions: Array<RoomVersion & { bytes: Uint8Array }>;
  created_at: number; created_by: Author; timeline: TimelineEntry[];
}

export class MockRoom {
  private seq = 1100;
  private readonly files: MockFile[] = [];

  constructor(private readonly channel: string, cards: { pricing: string; hero: string }) {
    const brand = (v: number) => enc(`# Kestrel brand voice (v${v})\n\nPlain words, short sentences. Say what the product does, then why it matters.\n\n- Harbor blue #1D4E89 for links; never for body text.\n- Headlines: sentence case, no exclamation marks.\n- Say "teammates", not "users".\n${v > 2 ? "- Numbers: digits for 10 and up.\n" : ""}`);
    this.seed("kestrel-brand-voice.md", "text/markdown", [[brand(1), who("maren"), 5 * 24 * HOUR], [brand(2), who("tobias"), 2 * 24 * HOUR], [brand(3), who("maren"), 3 * HOUR]], { pinned: true });
    this.seed("launch-checklist.md", "text/markdown", [
      [enc("# Launch checklist\n\n1. Pricing page reviewed by legal\n2. Redirects from the old /plans URLs\n3. Status page linked in the footer\n"), who("tobias"), 26 * HOUR],
      // An agent's version signed before its machine saw the pin: kept, flagged, not what agents get.
      [enc("# Launch checklist\n\n1. Ship it\n"), who("sol", "cc-91d0"), 25 * HOUR, "person_pinned"],
    ], { pinned: true });
    this.seed("pricing-tiers-2026.csv", "text/csv", [
      [enc("tier,monthly,seats\nStarter,0,2\nTeam,12,10\n"), who("ines"), 30 * HOUR],
      [enc("tier,monthly,seats\nStarter,0,2\nTeam,15,10\nBusiness,29,50\n"), who("ines"), 50 * MIN],
    ], { cards: [cards.pricing] });
    this.seed("hero-video-storyboard.pdf", "application/pdf", [[binary("%PDF-1.7\n", 1_240_000), who("maren", "cc-4f2a"), 4 * HOUR]], { cards: [cards.hero] });
    this.seed("homepage-wireframe.png", "image/png", [[binary("\x89PNG\r\n\x1a\n", 412_000), who("sol"), 7 * HOUR]], { cards: [cards.hero] });
    this.seed("api-rate-limits.json", "application/json", [[enc('{"public": {"per_minute": 60}, "signed_in": {"per_minute": 600}}\n'), who("ines", "codex-7b1"), 20 * MIN]], {});
    this.seed("vendor-quote-harbor-av.pdf", "application/pdf", [[binary("%PDF-1.4\n", 96_000), who("tobias"), 3 * 24 * HOUR]], { state: "removed" });
  }

  private id(): string { return `a1b2c3d4e5f60718:${this.seq++}`; }

  private seed(name: string, mime: string, versions: Array<[Uint8Array, Author, number, "person_pinned"?]>, o: { pinned?: boolean; cards?: string[]; state?: "active" | "removed" }): void {
    const vs = versions.map(([bytes, by, ago, ignored], i) => ({ v: i + 1, id: this.id(), hash: sha256Hex(bytes), size: bytes.byteLength, mime, share: this.id(), name, ts: NOW - ago, by, available: true, bytes, ...(ignored ? { ignored } : {}) }));
    const first = vs[0] as MockFile["versions"][number];
    this.files.push({
      id: first.id, name, pinned: o.pinned ?? false, state: o.state ?? "active", cards: o.cards ?? [], versions: vs,
      created_at: first.ts, created_by: first.by, timeline: vs.map((v, i) => ({ id: v.id, ts: v.ts, author: v.by, kind: i ? "op" as const : "create" as const, changes: { hash: v.hash } })),
    });
  }

  private view(f: MockFile): RoomFileView {
    const cur = currentVersion(f) as MockFile["versions"][number];
    return {
      id: f.id, channel: this.channel, name: f.name, pinned: f.pinned, state: f.state, hash: cur.hash, size: cur.size, mime: cur.mime,
      version: cur.v, versions: f.versions.length, updated_at: cur.ts, updated_by: cur.by, created_at: f.created_at, created_by: f.created_by,
      cards: [...f.cards], available: true, rev: f.timeline.length,
    };
  }

  private find(ref: string): MockFile | undefined {
    return this.files.find((f) => f.id === ref) ?? this.files.find((f) => f.state === "active" && f.name === ref);
  }

  summary(): { files: number; pinned: number; bytes: number } {
    const live = this.files.filter((f) => f.state === "active");
    return { files: live.length, pinned: live.filter((f) => f.pinned).length, bytes: live.reduce((n, f) => n + currentVersion(f).size, 0) };
  }

  forCard(cardId: string): RoomFileView[] {
    return this.files.filter((f) => f.state === "active" && f.cards.includes(cardId)).map((f) => this.view(f));
  }

  private list(all: boolean): RoomFileView[] {
    return this.files.filter((f) => all || f.state === "active").map((f) => this.view(f))
      .sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : a.name.localeCompare(b.name)));
  }

  async handle(req: Request, path: string, cardId: (ref: string) => string | null, json: (d: unknown, s?: number) => Response, fail: (s: number, c: string, m: string) => Response): Promise<Response | null> {
    const base = `/v1/projects/${this.channel}/room`;
    if (!path.startsWith(base)) return null;
    const m = req.method;
    const url = new URL(req.url);
    if (path === base && m === "GET") return json({ files: this.list(url.searchParams.get("all") === "1"), limits: { files: 1000, versions: 100 } });
    if (path === base && m === "POST") {
      const name = decodeURIComponent(req.headers.get("x-walkie-name") ?? "");
      if (!name || name.includes("/")) return fail(400, "invalid", "not a file name");
      const mime = req.headers.get("x-walkie-mime") || "application/octet-stream";
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (!bytes.byteLength) return fail(400, "invalid", "empty file");
      const scan = scanUpload(bytes, mime, name);
      if (scan.findings.length && req.headers.get("x-walkie-allow-secrets") !== "1") {
        return json({ error: { code: "secret_detected", message: `${name} looks like it contains a secret (${scan.findings.join(", ")})`, findings: scan.findings } }, 409);
      }
      const cardRef = req.headers.get("x-walkie-card");
      const card = cardRef ? cardId(decodeURIComponent(cardRef)) : null;
      const author = who("maren");
      const hash = sha256Hex(bytes);
      const target = this.files.find((f) => f.state === "active" && f.name === name);
      if (target) {
        const cur = currentVersion(target) as MockFile["versions"][number];
        if (cur.hash !== hash) target.versions.push({ v: target.versions.length + 1, id: this.id(), hash, size: bytes.byteLength, mime, share: this.id(), name, ts: Date.now(), by: author, available: true, bytes });
        if (card && !target.cards.includes(card)) target.cards.push(card);
        return json({ file: this.view(target), version: target.versions.length, created: false, ...(cur.hash === hash ? { unchanged: true } : {}) });
      }
      this.seed(name, mime, [[bytes, author, 0]], { cards: card ? [card] : [], pinned: req.headers.get("x-walkie-pin") === "1" });
      return json({ file: this.view(this.files[this.files.length - 1] as MockFile), version: 1, created: true });
    }
    const r = /^\/room\/([^/]+?)(\/content)?$/.exec(path.slice(`/v1/projects/${this.channel}`.length));
    if (!r) return null;
    const f = this.find(r[1] as string);
    if (!f) return fail(404, "not_found", "no such file in this Data Room");
    if (r[2] && m === "GET") {
      const want = url.searchParams.get("v");
      const v = want ? f.versions.find((x) => x.v === Number(want)) : (currentVersion(f) as MockFile["versions"][number] | undefined);
      if (!v) return fail(404, "not_found", "no such version");
      return new Response(v.bytes, { headers: { "Content-Type": "application/octet-stream", "X-Walkie-Mime": v.mime, "X-Walkie-Version": String(v.v), "Content-Disposition": `attachment; filename="${v.name}"` } });
    }
    if (m === "GET") {
      const detail: RoomFileDetail = { file: this.view(f), versions: f.versions.map(({ bytes: _b, ...v }) => v), timeline: f.timeline };
      return json(detail);
    }
    if (m === "POST") {
      const b = (await req.json().catch(() => ({}))) as { name?: string; pin?: boolean; state?: "active" | "removed"; attach?: string[]; detach?: string[] };
      if (b.name) f.name = b.name;
      if (b.pin !== undefined) f.pinned = b.pin;
      if (b.state) f.state = b.state;
      for (const ref of b.attach ?? []) { const id = cardId(ref); if (id && !f.cards.includes(id)) f.cards.push(id); }
      for (const ref of b.detach ?? []) { const id = cardId(ref); f.cards = f.cards.filter((x) => x !== id); }
      return json({ file: this.view(f) });
    }
    return null;
  }
}
