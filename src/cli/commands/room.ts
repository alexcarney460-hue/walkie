// `walkie room <project> …` (DATA-ROOM-1): a project's Data Room from the terminal. Under an agent (PROTOCOL §6) file
// names and text are wrapped for the model, and the CLI speaks for that agent, so the daemon applies the agent rules
// (add and read; no rename, remove, pin or detach; no new version of a pinned file; no upload the secret scan flags).
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { WalkieClient } from "../../client/index.ts";
import type { RoomFileView } from "../../protocol/projects/room.ts";
import { humanSize, ROOM_NOTE, roomFileForModel } from "../../protocol/projects/room-format.ts";
import { looksText } from "../../protocol/projects/room-scan.ts";
import { defang, wrapForModel } from "../../protocol/safety.ts";
import { bool, int, need, str, UsageError } from "../args.ts";
import { EXIT, type Ctx } from "../context.ts";
import { ago, c, pad, safeTerm } from "../format.ts";
import { channelOf, client, creatorClient } from "./projects.ts";

const MAX_BYTES = 25 * 1024 * 1024;

function by(f: Pick<RoomFileView, "updated_by">): string {
  return `@${f.updated_by.handle}${f.updated_by.agent ? `/${f.updated_by.agent}` : ""}`;
}

function line(f: RoomFileView, keys: ReadonlyMap<string, string>): string {
  const cards = f.cards.map((id) => keys.get(id) ?? id).join(",");
  return `${f.pinned ? c.yellow("★") : " "} ${pad(c.bold(safeTerm(f.name).slice(0, 60)), 42)} ${pad(`v${f.version}`, 5)} ${pad(humanSize(f.size), 9)} ${pad(c.dim(safeTerm(f.mime).slice(0, 24)), 26)} ${pad(safeTerm(by(f)), 22)} ${c.gray(`${ago(f.updated_at)} ago`)}${cards ? c.cyan(` ${safeTerm(cards)}`) : ""}${f.state === "removed" ? c.dim(" (removed)") : ""}${f.available ? "" : c.dim(" (not available here)")}`;
}

function fileOut(ctx: Ctx, verb: string, f: RoomFileView, extra = ""): string {
  if (ctx.forAgent) {
    return ctx.json
      ? JSON.stringify({ file: { id: f.id, version: f.version, pinned: f.pinned, state: f.state, cards: f.cards, text: roomFileForModel(f) }, trust: "team-member" })
      : `${verb}${extra}\n${roomFileForModel(f)}`;
  }
  return ctx.json ? JSON.stringify({ file: f }) : `${c.green(verb)} ${safeTerm(f.name)} ${c.dim(`v${f.version} · ${humanSize(f.size)}`)}${extra}`;
}

async function cardKeys(cl: WalkieClient, channel: string): Promise<Map<string, string>> {
  const { cards } = await cl.project(channel, { deleted: true }).catch(() => ({ cards: [] as { id: string; key: string }[] }));
  return new Map(cards.map((x) => [x.id, x.key]));
}

async function list(ctx: Ctx, cl: WalkieClient, channel: string): Promise<number> {
  const { files } = await cl.room(channel, bool(ctx.args, "all"));
  const keys = await cardKeys(cl, channel);
  if (ctx.json) {
    ctx.out(JSON.stringify(ctx.forAgent
      ? { files: files.map((f) => ({ id: f.id, version: f.version, pinned: f.pinned, state: f.state, size: f.size, cards: f.cards.map((id) => keys.get(id) ?? id), text: roomFileForModel(f), trust: "team-member" })) }
      : { files }));
    return EXIT.ok;
  }
  if (ctx.forAgent) {
    ctx.out(files.length ? files.map((f) => roomFileForModel(f, f.cards.map((id) => keys.get(id) ?? id))).join("\n") : "(the Data Room is empty)");
    return EXIT.ok;
  }
  if (!files.length) { ctx.out(c.dim("the Data Room is empty (walkie room <project> add <file>)")); return EXIT.ok; }
  for (const f of files) ctx.out(line(f, keys));
  return EXIT.ok;
}

async function add(ctx: Ctx, cl: WalkieClient, channel: string): Promise<number> {
  const paths = ctx.args.pos.slice(2);
  if (!paths.length) throw new UsageError("walkie room <project> add <file…> [--pin] [--card KEY] [--name n] [--allow-secrets]");
  const name = str(ctx.args, "name");
  if (name && paths.length > 1) throw new UsageError("--name names one file; add the others separately");
  for (const p of paths) {
    const path = resolve(p);
    const st = statSync(path);
    if (!st.isFile()) throw new UsageError(`${p} is not a file`);
    if (st.size > MAX_BYTES) throw new UsageError(`${p} is over 25 MB (the most a Data Room file holds)`);
    const res = await cl.roomAdd(channel, new Uint8Array(readFileSync(path)), {
      name: name ?? basename(path), mime: Bun.file(path).type.split(";")[0] || "application/octet-stream",
      ...(str(ctx.args, "card") ? { card: str(ctx.args, "card") } : {}), ...(bool(ctx.args, "pin") ? { pin: true } : {}),
      ...(bool(ctx.args, "allow-secrets") ? { allowSecrets: true } : {}),
    });
    const verb = res.unchanged ? "unchanged" : res.created ? "added" : `added v${res.version} of`;
    const warn = res.warnings?.length ? c.yellow(` (uploaded although it looks like it contains: ${res.warnings.join(", ")})`) : "";
    ctx.out(fileOut(ctx, verb, res.file, warn));
  }
  return EXIT.ok;
}

async function get(ctx: Ctx, cl: WalkieClient, channel: string): Promise<number> {
  const ref = need(ctx.args, 2, "file name or id");
  const got = await cl.roomContent(channel, ref, int(ctx.args, "version"));
  const out = str(ctx.args, "output");
  if (out === "-") { process.stdout.write(got.bytes); return EXIT.ok; }
  if (!out && ctx.forAgent && looksText(got.bytes, got.mime, ref)) {
    const { file } = await cl.roomFile(channel, ref);
    ctx.out(wrapForModel({ id: file.id, kind: "room.file", channel, author: file.updated_by }, new TextDecoder().decode(got.bytes), { note: ROOM_NOTE, maxLen: 100_000 }));
    return EXIT.ok;
  }
  const dest = resolve(out ?? basename((await cl.roomFile(channel, ref)).file.name.replace(/[\\/]/g, "_")));
  if (!out && existsSync(dest)) throw new UsageError(`${dest} already exists; pass -o <path> (or -o - for stdout)`);
  writeFileSync(dest, got.bytes);
  ctx.out(ctx.forAgent ? `saved ${humanSize(got.bytes.byteLength)} (v${got.version}) to ${dest}` : `${c.green("saved")} ${dest} ${c.dim(`v${got.version} · ${humanSize(got.bytes.byteLength)}`)}`);
  return EXIT.ok;
}

async function history(ctx: Ctx, cl: WalkieClient, channel: string): Promise<number> {
  const d = await cl.roomFile(channel, need(ctx.args, 2, "file name or id"));
  if (ctx.json) { ctx.out(JSON.stringify(ctx.forAgent ? { file: roomFileForModel(d.file), versions: d.versions.map((v) => ({ v: v.v, size: v.size, ts: v.ts, by: v.by })), trust: "team-member" } : d)); return EXIT.ok; }
  if (ctx.forAgent) {
    ctx.out(roomFileForModel(d.file));
    ctx.out(d.versions.map((v) => `v${v.v} · ${humanSize(v.size)} · @${defang(v.by.handle, 30)}${v.by.agent ? `/${defang(v.by.agent, 48)}` : ""} · ${new Date(v.ts).toISOString()}`).join("\n"));
    return EXIT.ok;
  }
  ctx.out(`${c.bold(safeTerm(d.file.name))}${d.file.pinned ? c.yellow(" ★ pinned") : ""}${d.file.state === "removed" ? c.dim(" (removed)") : ""} ${c.dim(d.file.id)}`);
  for (const v of [...d.versions].reverse()) {
    const who = `@${v.by.handle}${v.by.agent ? `/${v.by.agent}` : ""}`;
    ctx.out(`  ${pad(`v${v.v}`, 5)} ${pad(humanSize(v.size), 9)} ${pad(safeTerm(who), 26)} ${c.gray(new Date(v.ts).toISOString().replace("T", " ").slice(0, 16))}${v.name !== d.file.name ? c.dim(` as ${safeTerm(v.name)}`) : ""}${v.available === false ? c.dim(" (not available)") : ""}`);
  }
  for (const t of d.timeline.filter((x) => x.ignored)) {
    ctx.out(c.yellow(`  ignored: @${safeTerm(t.author.handle)}${t.author.agent ? `/${safeTerm(t.author.agent)}` : ""} ${Object.keys(t.changes ?? {}).join(", ")} (${t.ignored})`));
  }
  return EXIT.ok;
}

async function change(ctx: Ctx, cl: WalkieClient, channel: string, verb: string, body: Parameters<WalkieClient["roomChange"]>[2]): Promise<number> {
  const { file } = await cl.roomChange(channel, need(ctx.args, 2, "file name or id"), body);
  ctx.out(fileOut(ctx, verb, file));
  return EXIT.ok;
}

export async function roomCmd(ctx: Ctx): Promise<number> {
  const project = need(ctx.args, 0, "project");
  const sub = ctx.args.pos[1] ?? "ls";
  // Writes by an agent must name it (the daemon refuses an unnamed agent's change); reads use the agent-aware client.
  const cl = sub === "ls" || sub === "list" || sub === "get" || sub === "history" ? client(ctx) : creatorClient(ctx);
  const channel = await channelOf(cl, project);
  switch (sub) {
    case "ls": case "list": return list(ctx, cl, channel);
    case "add": return add(ctx, cl, channel);
    case "get": return get(ctx, cl, channel);
    case "history": return history(ctx, cl, channel);
    case "rm": case "remove": return change(ctx, cl, channel, "removed", { state: "removed" });
    case "restore": return change(ctx, cl, channel, "restored", { state: "active" });
    case "pin": return change(ctx, cl, channel, "pinned", { pin: true });
    case "unpin": return change(ctx, cl, channel, "unpinned", { pin: false });
    case "rename": return change(ctx, cl, channel, "renamed", { name: need(ctx.args, 3, "new name") });
    case "attach": return change(ctx, cl, channel, "attached", { attach: [need(ctx.args, 3, "card key")] });
    case "detach": return change(ctx, cl, channel, "detached", { detach: [need(ctx.args, 3, "card key")] });
    default: throw new UsageError(`unknown room command "${sub}" (ls|add|get|history|rm|restore|pin|unpin|rename|attach|detach)`);
  }
}
