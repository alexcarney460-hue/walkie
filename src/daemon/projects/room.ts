// The Data Room (DATA-ROOM-1, ALE-5389): each project's files, next to its board. A file added here is two signed
// events in the project's channel: an ordinary `artifact.share` of the bytes (the unit the blob rules authorise, so
// access is exactly the channel's membership) and a room op (a board op `{op: "file"}`, room.ts in protocol has the
// fold). The checks here refuse early, with a clear error, what the fold would ignore for this caller (people-only
// changes, an agent's version of a pinned file), plus the soft caps and the secret warning.
import { redactSecrets } from "../../protocol/safety.ts";
import type { BodyOf, Event } from "../../protocol/schemas.ts";
import {
  currentVersion, PIN_FETCH, PIN_INLINE_FILE, PIN_INLINE_TOTAL, ROOM_LIMITS, versionCount, roomFileView, roomOpText, roomOrder,
  type ContextFile, type RoomFileDetail, type RoomFileState, type RoomFileView, type RoomVersion, type TaskContext,
} from "../../protocol/projects/room.ts";
import { binaryByType, looksText, scanUpload, textByType } from "../../protocol/projects/room-scan.ts";
import { boardBodyFits, FileName, FileOp, MAX_BOARD_OP_BYTES, MIME_RE, type ProjectView } from "../../protocol/projects/schema.ts";
import { readBlob, sha256Hex, writeBlob } from "../blobs.ts";
import { blobServable } from "../blob-auth.ts";
import { HttpError } from "../http.ts";
import { findCard, isAgentCaller, requirePerson, visibleProject, type WriteCtx } from "./service.ts";

/** Fetches a version's bytes from a peer that may serve them (the local API's blobFor); null = nobody could (or more than maxBytes). */
/** `budget.left` is charged for every peer attempt (bytes kept, or the attempt's cap when it failed), so it bounds bytes received. */
export type PeerBlob = (hash: string, channel: string, maxBytes?: number, budget?: { left: number }) => Promise<Uint8Array | null>;

const EVENT_ID = /^[0-9a-f]{16}:[1-9][0-9]*$/;

function clean(w: WriteCtx, s: string): string {
  return w.core.config.redact ? redactSecrets(s).text : s;
}

function namedAgent(w: WriteCtx): void {
  if (w.underAgent && !w.agent) {
    throw new HttpError(403, "agent_unnamed", "a Data Room change from an agent must name it (WALKIE_AGENT=<name>, or --agent)");
  }
}

/** The ids of the project's cards (attachments to anything else are not shown). */
function cardIds(w: WriteCtx, channel: string): Set<string> {
  return new Set(w.idx.db.cards(channel, { states: ["open", "archived", "deleted"], limit: 20_000 }).map((c) => c.id));
}

function available(w: WriteCtx, channel: string, v: RoomVersion): boolean {
  return w.idx.db.shareAccepted(v.share, v.hash, channel);
}

function view(w: WriteCtx, channel: string, f: RoomFileState, cards: ReadonlySet<string>): RoomFileView {
  return roomFileView(f, channel, { cards: f.cards.filter((id) => cards.has(id)), available: available(w, channel, currentVersion(f)) });
}

/** The room's files (active; `all` adds removed ones), pinned first, then by name. */
export function listRoom(w: WriteCtx, channel: string, all = false): { files: RoomFileView[]; limits: typeof ROOM_LIMITS } {
  const p = visibleProject(w, channel);
  const cards = cardIds(w, p.channel);
  const files = w.idx.room(p.channel).filter((f) => all || f.state === "active").map((f) => view(w, p.channel, f, cards)).sort(roomOrder);
  return { files, limits: { ...ROOM_LIMITS } };
}

/**
 * A file by id (its root event id), or by name among the live files (exact, then ignoring case). Two live files with
 * one name (added at the same time on two machines) are refused with both ids.
 */
export function findFile(w: WriteCtx, channel: string, ref: string, opts: { removed?: boolean } = {}): RoomFileState {
  const files = w.idx.room(channel);
  if (EVENT_ID.test(ref)) {
    const f = files.find((x) => x.id === ref);
    if (f && (f.state === "active" || opts.removed)) return f;
    throw new HttpError(404, "not_found", `no file ${ref} in this Data Room`);
  }
  const byName = (pool: readonly RoomFileState[]) => {
    const exact = pool.filter((x) => x.name === ref);
    return exact.length ? exact : pool.filter((x) => x.name.toLowerCase() === ref.toLowerCase());
  };
  const live = byName(files.filter((x) => x.state === "active"));
  const hits = live.length || !opts.removed ? live : byName(files.filter((x) => x.state === "removed"));
  if (hits.length === 1) return hits[0] as RoomFileState;
  if (hits.length > 1) {
    throw new HttpError(409, "ambiguous", `${hits.length} files are named ${ref} (added at the same time on two machines): ${hits.map((x) => x.id).join(", ")}; use the id`);
  }
  throw new HttpError(404, "not_found", `no file named ${ref} in this Data Room`);
}

export function fileDetail(w: WriteCtx, channel: string, ref: string): RoomFileDetail {
  const p = visibleProject(w, channel);
  const f = findFile(w, p.channel, ref, { removed: true });
  return {
    file: view(w, p.channel, f, cardIds(w, p.channel)),
    versions: f.versions.map((v) => ({ ...v, available: available(w, p.channel, v) })),
    timeline: f.timeline,
  };
}

/** A card of THIS project by reference, key or id. */
function projectCard(w: WriteCtx, p: ProjectView, ref: string): string {
  const { card } = findCard(w, ref);
  if (card.channel !== p.channel) throw new HttpError(400, "invalid", `${card.key} is a card of another project; a file attaches to cards of its own project`);
  return card.id;
}

/** One room op, signed as a post in the project's channel (validated before anything is signed). */
function roomPost(w: WriteCtx, channel: string, text: string, board: Record<string, unknown>, thread?: string): Event {
  if (!FileOp.safeParse(board).success) throw new HttpError(400, "invalid", "this Data Room change is out of range");
  const make = (t: string) => ({ text: t, board, ...(thread ? { thread } : {}) } as BodyOf<"msg.post">);
  let body = make(text.slice(0, 1_000));
  if (!boardBodyFits(body)) body = make(text.slice(0, 120));
  if (!boardBodyFits(body)) throw new HttpError(413, "too_large", `a Data Room change is at most ${MAX_BOARD_OP_BYTES / 1024} KB`);
  return w.core.emit("msg.post", body, { channel, agent: w.agent });
}

export interface AddFile {
  name: string; mime: string;
  /** Card reference (key, reference or id) of this project to attach the file to. */
  card?: string;
  /** Pin it (people only). */
  pin?: boolean;
  /** Add a version to this file (its id) instead of finding it by name. */
  file?: string;
  /** A person uploads it although the secret scan found something (the bytes are never changed). */
  allowSecrets?: boolean;
}

export interface AddResult {
  file: RoomFileView;
  /** The version this upload is (an unchanged upload returns the current one). */
  version: number;
  created: boolean;
  /** The bytes were identical to the current version: no new version was added. */
  unchanged?: boolean;
  /** Secrets the scan found and a person uploaded anyway. */
  warnings?: string[];
}

/**
 * Adds a file to the room, or a new version of the live file with the same name (or of `file`). The secret scan runs
 * on text uploads: a finding refuses the upload (409 secret_detected, with the kinds found) unless a person passed
 * allowSecrets; an agent is always refused. The share is emitted first (its id is in the room op), both in the
 * project's channel.
 */
export function addFile(w: WriteCtx, channel: string, bytes: Uint8Array, req: AddFile): AddResult {
  namedAgent(w);
  const agent = isAgentCaller(w);
  const p = visibleProject(w, channel);
  if (p.state !== "active") throw new HttpError(409, "conflict", `project ${p.name} is ${p.state}`);
  if (req.pin && agent) throw new HttpError(403, "forbidden", "pinning is for people only (pinned documents reach every agent's context; ask your person)");
  const name = clean(w, req.name.normalize("NFC").trim());
  if (!FileName.safeParse(name).success) throw new HttpError(400, "invalid", "not a file name (1-200 characters, no slashes or control characters)");
  if (!bytes.byteLength) throw new HttpError(400, "invalid", "empty file");
  // A type is printable ASCII (it goes back out in a header); anything else is generic bytes.
  const mime = MIME_RE.test(req.mime ?? "") ? (req.mime as string) : "application/octet-stream";
  const scan = scanUpload(bytes, mime, name);
  if (scan.findings.length && (agent || !req.allowSecrets)) {
    const kinds = scan.findings.join(", ");
    throw new HttpError(409, "secret_detected", agent
      ? `${name} looks like it contains a secret (${kinds}); an agent can't add it to the Data Room. Remove the secret, or ask your person to upload it.`
      : `${name} looks like it contains a secret (${kinds}). Remove it, or upload anyway (--allow-secrets / "Upload anyway"): the file is shared as is.`,
      { findings: scan.findings });
  }
  const cardId = req.card ? projectCard(w, p, req.card) : undefined;
  w.idx.flushAll();
  const target = req.file ? findFile(w, p.channel, req.file) : w.idx.room(p.channel).find((f) => f.state === "active" && f.name === name) ?? null;
  if (target && req.file === undefined) {
    const same = w.idx.room(p.channel).filter((f) => f.state === "active" && f.name === name);
    if (same.length > 1) throw new HttpError(409, "ambiguous", `${same.length} files are named ${name}: ${same.map((x) => x.id).join(", ")}; pass the file's id`);
  }
  const hash = sha256Hex(bytes);
  const cur = target ? currentVersion(target) : null;
  if (target && cur && cur.hash === hash) {
    // The same bytes again: no new version; an attach or pin asked for still applies. The bytes are kept here (their
    // hash matches a version this channel's share names, so this machine may serve them).
    writeBlob(w.core.paths.blobs, bytes);
    if (available(w, p.channel, cur)) w.core.store.addProvenance(p.channel, hash);
    const extra: Record<string, unknown> = {
      ...(cardId && !target.cards.includes(cardId) ? { attach: [cardId] } : {}), ...(req.pin && !target.pinned ? { pin: true } : {}),
    };
    if (Object.keys(extra).length) roomPost(w, p.channel, roomOpText(target.name, extra), { v: 1, rev: target.rev + 1, op: "file", after: target.head, ...extra }, target.id);
    const f = settle(w, p.channel, target.id);
    return { file: f, version: cur.v, created: false, unchanged: true, ...(scan.findings.length ? { warnings: scan.findings } : {}) };
  }
  if (!target && w.idx.room(p.channel).filter((f) => f.state === "active").length >= ROOM_LIMITS.files) {
    throw new HttpError(409, "room_limit", `a Data Room holds at most ${ROOM_LIMITS.files} files; remove some first`);
  }
  if (target && versionCount(target.versions)[agent ? "agent" : "person"] >= ROOM_LIMITS.versions) {
    throw new HttpError(409, "version_limit", `${target.name} already has ${ROOM_LIMITS.versions} versions by ${agent ? "agents" : "people"} (the most a file keeps); add it under another name`);
  }
  if (target && agent && target.pinned) {
    throw new HttpError(403, "forbidden", `${target.name} is pinned: only a person can add a new version (pinned documents reach every agent's context)`);
  }
  const size = bytes.byteLength;
  const version = (target?.versions.length ?? 0) + 1;
  const content = { hash, size, mime };
  const board = target
    ? { v: 1, rev: target.rev + 1, op: "file", after: target.head, ...content, ...(cardId && !target.cards.includes(cardId) ? { attach: [cardId] } : {}), ...(req.pin && !target.pinned ? { pin: true } : {}) }
    : { v: 1, rev: 0, op: "file", name, ...content, ...(req.pin ? { pin: true } : {}), ...(cardId ? { attach: [cardId] } : {}) };
  // Validated with a placeholder share before anything is signed: a refused op must leave no share behind.
  if (!FileOp.safeParse({ ...board, share: "0000000000000000:1" }).success) throw new HttpError(400, "invalid", "this file can't be added (a field is out of range)");
  writeBlob(w.core.paths.blobs, bytes);
  w.core.store.addBlob(hash, size, mime, name);
  const share = w.core.emit("artifact.share", { hash, name, size, mime, note: `Data Room: ${p.name}${version > 1 ? ` (v${version})` : ""}`.slice(0, 2000) }, { channel: p.channel, agent: w.agent });
  w.core.store.addProvenance(p.channel, hash);
  const op = roomPost(w, p.channel, roomOpText(target?.name ?? name, { ...board, share: share.id }, version), { ...board, share: share.id }, target?.id);
  const f = settle(w, p.channel, target?.id ?? op.id);
  return { file: f, version, created: !target, ...(scan.findings.length ? { warnings: scan.findings } : {}) };
}

/** Re-folds the room now (this node's own write) and returns the file's view. */
function settle(w: WriteCtx, channel: string, id: string): RoomFileView {
  w.idx.markRoom(channel);
  w.idx.flushAll();
  const f = w.idx.room(channel).find((x) => x.id === id);
  if (!f) throw new HttpError(500, "internal", "the Data Room change wasn't folded");
  return view(w, channel, f, cardIds(w, channel));
}

export interface ChangeFile {
  name?: string; pin?: boolean; state?: "active" | "removed";
  /** Card references (key, reference or id) of this project. */
  attach?: string[]; detach?: string[];
}

/** Rename, pin / unpin, remove / restore, detach: people only. Attach: anyone who can post in the project. */
export function changeFile(w: WriteCtx, channel: string, ref: string, req: ChangeFile): RoomFileView {
  namedAgent(w);
  if (req.name !== undefined || req.pin !== undefined || req.state !== undefined || req.detach !== undefined) {
    requirePerson(w, "renaming, pinning, removing a Data Room file or detaching it from a card");
  }
  const p = visibleProject(w, channel);
  if (p.state !== "active") throw new HttpError(409, "conflict", `project ${p.name} is ${p.state}`);
  w.idx.flushAll();
  const f = findFile(w, p.channel, ref, { removed: req.state === "active" });
  const fields: Record<string, unknown> = {};
  if (req.name !== undefined) {
    const name = clean(w, req.name.normalize("NFC").trim());
    if (!FileName.safeParse(name).success) throw new HttpError(400, "invalid", "not a file name (1-200 characters, no slashes or control characters)");
    if (name !== f.name) {
      if (w.idx.room(p.channel).some((x) => x.state === "active" && x.id !== f.id && x.name === name)) throw new HttpError(409, "conflict", `another file is already named ${name}`);
      fields.name = name;
    }
  }
  if (req.pin !== undefined && req.pin !== f.pinned) fields.pin = req.pin;
  if (req.state !== undefined && req.state !== f.state) {
    if (req.state === "active" && w.idx.room(p.channel).filter((x) => x.state === "active").length >= ROOM_LIMITS.files) {
      throw new HttpError(409, "room_limit", `a Data Room holds at most ${ROOM_LIMITS.files} files`);
    }
    const name = (fields.name as string | undefined) ?? f.name;
    if (req.state === "active" && w.idx.room(p.channel).some((x) => x.state === "active" && x.id !== f.id && x.name === name)) {
      throw new HttpError(409, "conflict", `another file is named ${name} now; restore this one with a new name (name + restore together)`);
    }
    fields.state = req.state;
  }
  const attach = [...new Set((req.attach ?? []).map((r) => projectCard(w, p, r)))].filter((id) => !f.cards.includes(id));
  const detach = [...new Set((req.detach ?? []).map((r) => projectCard(w, p, r)))].filter((id) => f.cards.includes(id));
  if (attach.length) fields.attach = attach.slice(0, 20);
  if (detach.length) fields.detach = detach.slice(0, 20);
  if (!Object.keys(fields).length) return view(w, p.channel, f, cardIds(w, p.channel));
  roomPost(w, p.channel, roomOpText(f.name, fields), { v: 1, rev: f.rev + 1, op: "file", after: f.head, ...fields }, f.id);
  return settle(w, p.channel, f.id);
}

/** A version's bytes (the current one by default), served only for a share accepted in this channel. */
export async function fileContent(w: WriteCtx, channel: string, ref: string, v: number | undefined, peer: PeerBlob): Promise<{ bytes: Uint8Array; version: RoomVersion; file: RoomFileState }> {
  const p = visibleProject(w, channel);
  const f = findFile(w, p.channel, ref, { removed: true });
  const version = v === undefined ? currentVersion(f) : f.versions.find((x) => x.v === v);
  if (!version) throw new HttpError(404, "not_found", `${f.name} has no version ${v} (it has ${f.versions.length})`);
  if (!available(w, p.channel, version)) throw new HttpError(404, "not_found", `version ${version.v} of ${f.name} isn't available (its share isn't accepted in this project)`);
  const bytes = localBytes(w, p.channel, version.hash) ?? await peer(version.hash, p.channel);
  if (!bytes) throw new HttpError(404, "not_found", `${f.name} v${version.v} isn't on this machine and no online teammate's machine has it right now`);
  return { bytes, version, file: f };
}

function localBytes(w: WriteCtx, channel: string, hash: string): Uint8Array | null {
  const b = readBlob(w.core.paths.blobs, hash);
  return b && blobServable(w.core.roster, w.core.store, hash, channel, w.core.myHandle()) ? b : null;
}

/** The files attached to a card, as the API lists them (active files only). */
export function cardFiles(w: WriteCtx, channel: string, cardId: string): RoomFileView[] {
  const cards = new Set([cardId]);
  return w.idx.room(channel).filter((f) => f.state === "active" && f.cards.includes(cardId)).map((f) => view(w, channel, f, cards)).sort(roomOrder);
}

/**
 * What an agent that starts (or works on) a card gets from the project's Data Room: the pinned documents (small text
 * files inline, as a REDACTED copy; the bytes are never changed) and the card's attached files (names and how to
 * fetch). Bytes this machine doesn't hold are fetched from peers only with `fetch` (the hooks never wait for that).
 */
export async function taskContext(w: WriteCtx, ref: string, opts: { fetch: boolean; peer: PeerBlob }): Promise<TaskContext> {
  const { project: p, card } = findCard(w, ref);
  const room = w.idx.room(p.channel).filter((f) => f.state === "active");
  let budget = PIN_INLINE_TOTAL;
  const fetchBudget = { left: PIN_FETCH.bytes }; // charged per peer attempt, failed ones included (bounds bytes received)
  const entry = async (f: RoomFileState, inline: boolean): Promise<ContextFile> => {
    const cur = currentVersion(f);
    const base: ContextFile = { id: f.id, name: f.name, size: cur.size, mime: cur.mime, version: cur.v, hash: cur.hash, pinned: f.pinned, by: cur.by };
    if (!inline) return base;
    if (!available(w, p.channel, cur)) return { ...base, omitted: "unavailable" };
    if (budget <= 0) return { ...base, omitted: "budget" };
    if (binaryByType(cur.mime, f.name)) return { ...base, omitted: "binary" }; // never read or fetched to be skipped
    let bytes = localBytes(w, p.channel, cur.hash);
    // Not held here: a large file of no text type (a binary, or an extensionless README / Makefile) is not fetched
    // just to be sniffed; the agent is told to fetch it. Fetches share one byte budget per task start.
    if (!bytes && !textByType(cur.mime, f.name) && cur.size > PIN_INLINE_FILE) return { ...base, omitted: "large" };
    // An honest copy is exactly cur.size bytes, so no attempt reads more; a file that can't fit the rest isn't tried.
    if (!bytes && opts.fetch && cur.size <= fetchBudget.left) {
      bytes = await opts.peer(cur.hash, p.channel, cur.size, fetchBudget).catch(() => null);
    }
    if (!bytes) return { ...base, omitted: "unavailable" };
    if (!looksText(bytes, cur.mime, f.name)) return { ...base, omitted: "binary" };
    const cap = Math.min(PIN_INLINE_FILE, budget);
    const cut = bytes.byteLength > cap;
    const text = redactSecrets(new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, cap))).text;
    budget -= Math.min(bytes.byteLength, cap);
    return { ...base, text, ...(cut ? { truncated: true } : {}) };
  };
  const pinned: ContextFile[] = [];
  for (const f of room.filter((x) => x.pinned).sort((a, b) => a.name.localeCompare(b.name))) pinned.push(await entry(f, true));
  const files: ContextFile[] = [];
  for (const f of room.filter((x) => x.cards.includes(card.id))) files.push(await entry(f, false));
  return {
    card: { id: card.id, ref: card.ref, key: card.key, channel: card.channel, title: card.title },
    project: { channel: p.channel, name: p.name, prefix: p.prefix },
    pinned, files,
  };
}
