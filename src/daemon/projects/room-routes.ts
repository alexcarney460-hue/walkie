// Local API routes for the Data Room (DATA-ROOM-1, PROTOCOL §10 "Data Room"). Imported by the daemon for its side
// effect of registering routes; the same transport checks as every route. Visibility is the project's (404 for a
// project this member can't see, a private project of others included).
import { z } from "zod";
import { MAX_BLOB_BYTES } from "../blobs.ts";
import { HttpError, json, parseWith, readBytes, readJson } from "../http.ts";
import { blobFor, LOCAL_BODY_MAX, limitWrite, requireTeam, route, type RouteCtx } from "../local-routes.ts";
import type { ProjectsIndex } from "./index.ts";
import { addFile, changeFile, fileContent, fileDetail, listRoom, taskContext, type PeerBlob } from "./room.ts";
import type { WriteCtx } from "./service.ts";

function ctx(c: RouteCtx): WriteCtx {
  requireTeam(c);
  const idx: ProjectsIndex | undefined = c.projects;
  if (!idx) throw new HttpError(404, "not_found", "projects are not available on this daemon");
  return {
    core: c.core, idx, client: c.client, catchUp: c.sync.requestCatchUp, ...(c.agent ? { agent: c.agent } : {}),
    ...(c.underAgent ? { underAgent: true } : {}),
  };
}

const peerOf = (c: RouteCtx): PeerBlob => (hash, channel, maxBytes, budget) => blobFor(c, hash, channel, maxBytes, budget);

function header(c: RouteCtx, name: string): string | undefined {
  const v = c.req.headers.get(name);
  if (!v) return undefined;
  try { return decodeURIComponent(v); } catch { throw new HttpError(400, "invalid", `${name} is not URI-encoded`); }
}

/** A file id (its root event id, ":" possibly percent-encoded) or its name (URI-encoded; names never hold "/"). */
const FILE = "([^/]+)";
const ROOM = "^\\/v1\\/projects\\/(p-[0-9a-f]{8})\\/room";
const CardRef = z.string().min(1).max(80);
const ChangeReq = z.object({
  name: z.string().min(1).max(200).optional(), pin: z.boolean().optional(), state: z.enum(["active", "removed"]).optional(),
  attach: z.array(CardRef).min(1).max(20).optional(), detach: z.array(CardRef).min(1).max(20).optional(),
}).strict();

route("GET", new RegExp(`${ROOM}$`), (c, [channel]) => json(listRoom(ctx(c), channel as string, c.url.searchParams.get("all") === "1")));

/**
 * Upload: the raw bytes (≤ 25 MB); `X-Walkie-Name` (URI-encoded), `X-Walkie-Mime`, optional `X-Walkie-Card` (a card of
 * this project to attach it to), `X-Walkie-Pin: 1` (people), `X-Walkie-File` (add a version to this file id) and
 * `X-Walkie-Allow-Secrets: 1` (a person uploads what the secret scan flagged; ignored for agents).
 */
route("POST", new RegExp(`${ROOM}$`), async (c, [channel]) => {
  const w = ctx(c);
  limitWrite(c);
  const name = header(c, "x-walkie-name");
  if (!name || name.length > 200) throw new HttpError(400, "invalid", "X-Walkie-Name required (<=200 chars)");
  const mime = c.req.headers.get("x-walkie-mime") ?? "application/octet-stream";
  if (mime.length > 100) throw new HttpError(400, "invalid", "X-Walkie-Mime too long");
  const card = header(c, "x-walkie-card");
  const file = header(c, "x-walkie-file");
  if (file !== undefined && !/^[0-9a-f]{16}:[1-9][0-9]*$/.test(file)) throw new HttpError(400, "invalid", "X-Walkie-File is a file id");
  const bytes = await readBytes(c.req, MAX_BLOB_BYTES);
  c.noTimeout();
  const res = addFile(w, channel as string, bytes, {
    name, mime, ...(card ? { card } : {}), ...(file ? { file } : {}),
    pin: c.req.headers.get("x-walkie-pin") === "1", allowSecrets: c.req.headers.get("x-walkie-allow-secrets") === "1",
  });
  return json(res);
});

route("GET", new RegExp(`${ROOM}\\/${FILE}$`), (c, [channel, file]) => json(fileDetail(ctx(c), channel as string, file as string)));

route("POST", new RegExp(`${ROOM}\\/${FILE}$`), async (c, [channel, file]) => {
  const w = ctx(c);
  const b = parseWith(ChangeReq, await readJson(c.req, LOCAL_BODY_MAX));
  limitWrite(c);
  return json({ file: changeFile(w, channel as string, file as string, b) });
});

/** A version's bytes (`?v=N`, default the current one), as `/v1/artifacts/:hash` serves them. */
route("GET", new RegExp(`${ROOM}\\/${FILE}\\/content$`), async (c, [channel, file]) => {
  const w = ctx(c);
  const raw = c.url.searchParams.get("v");
  const v = raw === null ? undefined : Number(raw);
  if (v !== undefined && (!Number.isInteger(v) || v < 1)) throw new HttpError(400, "invalid", "v is a version number (1, 2, …)");
  c.noTimeout();
  const got = await fileContent(w, channel as string, file as string, v, peerOf(c));
  return new Response(got.bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${got.version.name.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      "X-Walkie-Mime": got.version.mime.replace(/[^\x20-\x7e]/g, "_"),
      "X-Walkie-Version": String(got.version.v),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
});

/**
 * What an agent starting a card gets from the Data Room: pinned documents (small text files inline, redacted copy) and
 * the card's files. `?fetch=1` also fetches pinned bytes this machine doesn't hold from peers (the hooks don't wait).
 */
route("GET", /^\/v1\/tasks\/([^/]+)\/context$/, async (c, [ref]) => {
  const w = ctx(c);
  c.noTimeout();
  return json(await taskContext(w, ref as string, { fetch: c.url.searchParams.get("fetch") === "1", peer: peerOf(c) }));
});
