// Local API for v2 seats' repos (FO-2, FLEET-ORCH-1 §3.4): GET /v1/seats/repos, POST /v1/seats/repos. A repo id maps
// to this machine's own clone (config.json `fleet.repos`), where v2 seats get their worktree or copy. The machine's
// person sets it, or an agent of theirs while agent admin is on (AGENT-ADMIN-1's audited gate, pre.8 merge).
import { existsSync, realpathSync, statSync } from "node:fs";
import { adminGate } from "../admin/gate.ts";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { SeatRepoId } from "../../protocol/seats.ts";
import { HttpError, json, parseWith, readJson } from "../http.ts";
import { LOCAL_BODY_MAX, route } from "../local-routes.ts";
import { seatsFor } from "./host.ts";

const RepoReq = z.object({ id: SeatRepoId, path: z.string().min(2).max(1_000).nullable() }).strict();

function host(core: Parameters<typeof seatsFor>[0]) {
  const h = seatsFor(core);
  if (!h) throw new HttpError(503, "unavailable", "this daemon runs without seats");
  return h;
}

route("GET", "/v1/seats/repos", (c) => json({ repos: { ...host(c.core).repos } }));

route("POST", "/v1/seats/repos", async (c) => {
  const b = parseWith(RepoReq, await readJson(c.req, LOCAL_BODY_MAX));
  adminGate(c, b.path === null ? `removed the seats repo ${b.id}` : `set the seats repo ${b.id}`);
  let path: string | null = null;
  if (b.path !== null) {
    if (!isAbsolute(b.path)) throw new HttpError(400, "invalid", "path must be absolute");
    if (!existsSync(b.path) || !statSync(b.path).isDirectory()) throw new HttpError(400, "invalid", `${b.path} is not a directory`);
    if (!existsSync(join(b.path, ".git"))) throw new HttpError(400, "invalid", `${b.path} is not a git work tree (no .git)`);
    path = realpathSync(b.path);
  }
  try {
    return json({ repos: host(c.core).setRepo(b.id, path) });
  } catch (err) {
    throw new HttpError(500, "internal", `config.json could not be written: ${(err as Error).message.slice(0, 200)}`);
  }
});
