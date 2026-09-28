// share / fetch / dashboard / token
import { adminCtx } from "../admin-gate.ts";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { loadConfig } from "../../daemon/config.ts";
import { defaultHome, pathsFor } from "../../daemon/paths.ts";
import { bool, channelArg, need, str, UsageError } from "../args.ts";
import { EXIT, requirePerson, type Ctx } from "../context.ts";
import { c } from "../format.ts";
import { writeOut } from "../stdio.ts";

const MAX = 25 * 1024 * 1024;

export async function share(ctx: Ctx): Promise<number> {
  const file = need(ctx.args, 0, "file");
  if (!existsSync(file) || !statSync(file).isFile()) throw new UsageError(`no such file: ${file}`);
  if (statSync(file).size > MAX) throw new UsageError("artifacts are limited to 25 MB");
  const chan = ctx.args.pos[1];
  const bytes = new Uint8Array(readFileSync(file));
  const mime = Bun.file(file).type.split(";")[0] || "application/octet-stream";
  const res = await ctx.client().share(bytes, {
    name: basename(file), mime, note: str(ctx.args, "note"), channel: chan ? channelArg(chan) : undefined, thread: str(ctx.args, "thread"),
  });
  const hash = (res.event.body as { hash: string }).hash;
  ctx.out(ctx.json ? JSON.stringify(res) : `${c.green("shared")} ${basename(file)} → ${hash}\nfetch with: walkie fetch ${hash}`);
  return EXIT.ok;
}

export async function fetchCmd(ctx: Ctx): Promise<number> {
  const hash = need(ctx.args, 0, "artifact hash");
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new UsageError("hash must be 64 hex chars");
  const bytes = await ctx.client().fetchArtifact(hash);
  const out = str(ctx.args, "output");
  if (out) {
    writeFileSync(out, bytes);
    ctx.err(`${c.green("saved")} ${bytes.byteLength} bytes to ${out}`);
  } else {
    writeOut(bytes);
  }
  return EXIT.ok;
}

/**
 * Opens the dashboard through a one-shot login link: a 60 s single-use nonce minted over the unix
 * socket (FINAL Fable 5). The dashboard token itself never appears in a URL or on a command line.
 */
export async function dashboard(ctx: Ctx): Promise<number> {
  const sub = ctx.args.pos[0];
  if (sub === "logout") {
    const { revoked } = await adminCtx(ctx, "sign out every dashboard").client().logoutDashboards();
    ctx.out(`signed out ${revoked} dashboard session${revoked === 1 ? "" : "s"} (sign in again with: walkie dashboard)`);
    return EXIT.ok;
  }
  if (sub !== undefined) throw new UsageError(`unknown: walkie dashboard ${sub} (try: walkie dashboard [--no-open] | walkie dashboard logout)`);
  // The session can mint invites and approve machines: a person at a terminal says yes (the desktop app asks the
  // daemon itself over the socket, SECURITY "Known limits").
  await requirePerson(ctx, "open a dashboard session (it can mint invites and approve machines)", "yes");
  const paths = pathsFor(defaultHome());
  const port = loadConfig(paths.config).local_port;
  const { nonce } = await ctx.client().authNonce();
  const url = `http://127.0.0.1:${port}/auth?nonce=${nonce}`;
  ctx.out(url);
  if (!bool(ctx.args, "no-open")) {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    if (Bun.which(opener)) Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
  }
  return EXIT.ok;
}

/**
 * `walkie token rotate`: the daemon writes a new local.token (the loopback API's bearer for scripts) and
 * signs out every dashboard. The new value is never printed: scripts read it from the file.
 */
export async function token(ctx: Ctx): Promise<number> {
  const sub = ctx.args.pos[0];
  if (sub !== "rotate") throw new UsageError("usage: walkie token rotate");
  const { path } = await adminCtx(ctx, "rotate the local API token").client().rotateToken();
  ctx.out(`${c.green("rotated")} ${path} · every dashboard session was signed out (sign in again with: walkie dashboard)`);
  return EXIT.ok;
}
