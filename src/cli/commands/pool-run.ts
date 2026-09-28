// walkie pool share | run | stop | status | install (WALKIE-POOL-2): split a model across the team's machines.
// People only: under an agent runtime these refuse (the daemon also refuses an X-Walkie-Agent header).
import { homedir } from "node:os";
import { join } from "node:path";
import { adminCtx, auditLocal } from "../admin-gate.ts";
import { UsageError } from "../args.ts";
import { EXIT, type Ctx } from "../context.ts";
import { c, safeTerm } from "../format.ts";
import type { RunView } from "../../pool/run/runner.ts";
import type { PoolLocalView } from "../../pool/run/service.ts";
import type { ConnectionView, ServeView } from "../../protocol/pool.ts";
import { SHARE_WARNING } from "../../pool/format.ts";
import { TURN_SEATS_OFF } from "../../protocol/seats.ts";
import { installRuntime, LLAMA_BUILD, manualInstall, targetFor } from "../../pool/run/runtime.ts";
import { walkieHome } from "../../client/index.ts";
import { readAccel } from "../../daemon/machine-stats/accel.ts";

const GiB = 1024 ** 3;
const gbText = (b: number): string => `${Math.round((b / GiB) * 10) / 10} GB`;

// AGENT-ADMIN-1: sharing, runs and the runtime are admin: the person, or an agent of theirs (admin-gate.ts adminCtx).

export function runLines(r: RunView): string[] {
  const out = [`${c.bold(`Split run: ${r.model.name}${r.model.quant ? ` · ${r.model.quant === "q8" ? "8-bit" : "4-bit"}` : ""}`)} · ${stateText(r)}`];
  if (r.download && r.state === "downloading") out.push(`  downloading ${gbText(r.download.done)} of ${gbText(r.download.total)}`);
  for (const s of r.stages) out.push(`  ${c.gray("·")} ${safeTerm(s.hostname)}${s.self ? " (this machine, llama-server)" : ""} · ${gbText(s.bytes)} · ${s.state}`);
  if (r.error) out.push(`  ${c.red(safeTerm(r.error))}`);
  if (r.endpoint) {
    out.push(`  OpenAI-compatible endpoint on this machine only: ${r.endpoint} (API key in ${r.api_key_file})`);
    if (r.example) out.push(`  ${c.dim(r.example)}`);
  }
  if (r.tokens_per_s !== null) out.push(`  measured: ${r.tokens_per_s} tokens/s`);
  return out;
}

function stateText(r: RunView): string {
  const col = r.state === "serving" ? c.green : r.state === "failed" ? c.red : r.state === "stopped" ? c.dim : c.yellow;
  return col(r.state);
}

const quantText = (q: "q4" | "q8" | null): string => (q ? ` · ${q === "q8" ? "8-bit" : "4-bit"}` : "");

export function serveLines(s: ServeView): string[] {
  const col = s.state === "serving" ? c.green : s.state === "failed" ? c.red : s.state === "stopped" ? c.dim : c.yellow;
  const by = s.started_by ? ` · started from ${safeTerm(s.started_by.hostname)}` : "";
  const out = [`${c.bold(`Serving on this machine: ${safeTerm(s.model.name)}${quantText(s.model.quant)}`)} · ${col(s.state)}${by}`];
  if (s.download && s.state === "downloading") out.push(`  downloading ${gbText(s.download.done)} of ${gbText(s.download.total)}`);
  out.push(`  needs ${gbText(s.need)} of GPU memory${s.gpu_free !== null ? ` (${gbText(s.gpu_free)} was free)` : ""}, every layer on the GPU`);
  if (s.error) out.push(`  ${c.red(safeTerm(s.error))}`);
  if (s.endpoint) {
    out.push(`  OpenAI-compatible endpoint on this machine: ${s.endpoint} (API key in ${s.api_key_file})`);
    if (s.example) out.push(`  ${c.dim(s.example)}`);
  }
  for (const cl of s.clients) out.push(`  ${c.gray("·")} connected: ${safeTerm(cl.hostname)} · ${cl.requests} request(s)`);
  if (s.tokens_per_s !== null) out.push(`  measured: ${s.tokens_per_s} tokens/s`);
  if (s.idle_stop_at) out.push(c.dim(`  stops by itself if nobody uses it for 30 minutes (walkie pool stop ends it now)`));
  return out;
}

export function connectionLines(x: ConnectionView): string[] {
  const col = x.state === "connected" ? c.green : x.state === "lost" ? c.red : c.dim;
  const out = [`${c.bold(`Connected to ${safeTerm(x.model.name)}${quantText(x.model.quant)} on ${safeTerm(x.hostname)}`)} · ${col(x.state)}`];
  if (x.error) out.push(`  ${c.red(safeTerm(x.error))}`);
  if (x.state === "connected") {
    out.push(`  OpenAI-compatible endpoint on this machine, through Walkie: ${x.endpoint} (API key in ${x.api_key_file})`);
    out.push(`  ${c.dim(x.example)}`);
  }
  return out;
}

function shareLines(v: PoolLocalView): string[] {
  const out = [
    `Sharing this machine for split runs: ${v.share.on ? c.green("on") : "off"}${v.share.on ? ` · up to ${v.share.max_bytes === null ? "whatever is free when a run starts" : gbText(v.share.max_bytes)}` : ""}`,
    `llama.cpp runtime: ${v.runtime.installed ? `installed (${v.runtime.build ?? "unknown build"}) in ${v.runtime.dir}` : c.yellow("not installed (walkie pool install)")}`,
  ];
  if (v.prepared?.length) out.push(`Prepared for split runs (shares load from this disk): ${v.prepared.join(", ")}`);
  if (v.stage) out.push(`Serving a stage of @${safeTerm(v.stage.head_hostname)}'s run: ${safeTerm(v.stage.model)} · ${gbText(v.stage.bytes)} · ${v.stage.tunnels} connection(s)`);
  return out;
}

async function share(ctx: Ctx): Promise<number> {
  ctx = adminCtx(ctx, "share this machine for split runs");
  const which = ctx.args.pos[1];
  if (which !== "on" && which !== "off") throw new UsageError("usage: walkie pool share on|off [--max-gb N]");
  const raw = ctx.args.flags.get("max-gb");
  const maxGb = raw === undefined ? undefined : raw === "none" ? null : Number(raw);
  if (typeof maxGb === "number" && !(maxGb > 0)) throw new UsageError("--max-gb takes a number of GB (or none)");
  if (which === "on") {
    // Seats and compute sharing are never on together (the daemon refuses it too): say which to turn off first.
    const seats = await ctx.client().seats().then((r) => r.local, () => null);
    if (seats?.allow) { ctx.err(c.red(TURN_SEATS_OFF)); return EXIT.error; }
  }
  const v = await ctx.client().poolShare(which === "on", maxGb);
  if (ctx.json) ctx.out(JSON.stringify(v));
  else ctx.out([...shareLines(v), ...(which === "on" ? ["", c.yellow(SHARE_WARNING)] : [])].join("\n"));
  return EXIT.ok;
}

async function run(ctx: Ctx): Promise<number> {
  ctx = adminCtx(ctx, "start a split run");
  const model = ctx.args.pos[1];
  const file = ctx.args.flags.get("file");
  const quant = ctx.args.flags.get("quant");
  const machines = ctx.args.flags.get("machines");
  if (!model === (typeof file !== "string")) throw new UsageError("usage: walkie pool run <model-id> [--quant q4|q8] [--machines a,b] | walkie pool run --file <model.gguf> [--machines a,b]");
  if (quant !== undefined && quant !== "q4" && quant !== "q8") throw new UsageError("--quant is q4 or q8");
  const body = {
    ...(model ? { model } : {}), ...(typeof file === "string" ? { file: file.startsWith("/") ? file : join(process.cwd(), file) } : {}),
    ...(quant ? { quant: quant as "q4" | "q8" } : {}),
    ...(typeof machines === "string" ? { machines: machines.split(",").map((x) => x.trim()).filter(Boolean) } : {}),
  };
  const client = ctx.client();
  let r = (await client.poolRun(body)).run;
  if (ctx.json) { ctx.out(JSON.stringify({ run: r })); return EXIT.ok; }
  let last = "";
  // Follows it until it serves or ends (Ctrl-C leaves it running; walkie pool status shows it, walkie pool stop ends it).
  for (;;) {
    const text = runLines(r).join("\n");
    const key = `${r.state}|${r.error}|${r.stages.map((s) => s.state).join(",")}|${r.download ? Math.floor(r.download.done / (256 * 1024 * 1024)) : ""}`;
    if (key !== last) { ctx.out(text); last = key; }
    if (r.state === "serving" || r.state === "failed" || r.state === "stopped") break;
    await Bun.sleep(1_000);
    r = (await client.pool()).run ?? r;
  }
  return r.state === "serving" ? EXIT.ok : EXIT.error;
}

async function stop(ctx: Ctx): Promise<number> {
  ctx = adminCtx(ctx, "stop a split run or a served model");
  const on = ctx.args.flags.get("on");
  if (typeof on === "string") {
    // A model this machine started on another one.
    const r = await ctx.client().poolServeStop(on);
    if (ctx.json) ctx.out(JSON.stringify(r)); else ctx.out(`Stopped the model on ${safeTerm(on)}.`);
    return EXIT.ok;
  }
  const client = ctx.client();
  const r = (await client.poolStop()).run;
  const s = (await client.poolServeStop()).serve ?? null;
  if (ctx.json) { ctx.out(JSON.stringify({ run: r, serve: s })); return EXIT.ok; }
  const out = [...(r ? runLines(r) : []), ...(s ? serveLines(s) : [])];
  ctx.out(out.length ? out.join("\n") : "No split run or served model on this machine.");
  return EXIT.ok;
}

async function status(ctx: Ctx): Promise<number> {
  const v = await ctx.client().pool();
  if (ctx.json) { ctx.out(JSON.stringify(v)); return EXIT.ok; }
  ctx.out([
    ...shareLines(v), ...(v.run ? ["", ...runLines(v.run)] : []), ...(v.serve ? ["", ...serveLines(v.serve)] : []),
    ...(v.connections ?? []).flatMap((x) => ["", ...connectionLines(x)]),
  ].join("\n"));
  return EXIT.ok;
}

async function serve(ctx: Ctx): Promise<number> {
  ctx = adminCtx(ctx, "serve a model");
  const model = ctx.args.pos[1];
  const quant = ctx.args.flags.get("quant");
  const on = ctx.args.flags.get("on");
  if (!model) throw new UsageError("usage: walkie pool serve <model-id> [--quant q4|q8] [--on <machine>]");
  if (quant !== undefined && quant !== "q4" && quant !== "q8") throw new UsageError("--quant is q4 or q8");
  const client = ctx.client();
  const r = await client.poolServe({ model, ...(quant ? { quant: quant as "q4" | "q8" } : {}), ...(typeof on === "string" ? { on } : {}) });
  if (ctx.json) { ctx.out(JSON.stringify(r)); return EXIT.ok; }
  ctx.out(`Serving ${model} on ${safeTerm(r.on.hostname)}${r.on.self ? " (this machine)" : ""}.`);
  if (r.connection) {
    // Another machine serves it: this one is connected; follow that machine's state until it serves.
    let last = "";
    const since = Date.now();
    for (;;) {
      const v = await client.pool();
      const conn = (v.connections ?? []).find((x) => x.node_id === r.on.node_id) ?? r.connection;
      const team = await client.team().catch(() => null);
      const node = team?.nodes.find((n) => n.node_id === r.on.node_id);
      const st = node?.pool?.serving?.id === conn.id ? node.pool.serving.state : null;
      const key = `${conn.state}|${st}`;
      if (key !== last) { ctx.out([...connectionLines(conn), ...(st && st !== "serving" ? [`  ${safeTerm(r.on.hostname)}: ${st}…`] : [])].join("\n")); last = key; }
      // The serving machine's state reaches this one with its next sync; give it a moment before leaving it at that.
      if (conn.state !== "connected" || st === "serving" || (st === null && Date.now() - since > 30_000)) return conn.state === "connected" ? EXIT.ok : EXIT.error;
      await Bun.sleep(2_000);
    }
  }
  let s = r.serve!;
  let last = "";
  for (;;) {
    const key = `${s.state}|${s.error}|${s.download ? Math.floor(s.download.done / (256 * 1024 * 1024)) : ""}`;
    if (key !== last) { ctx.out(serveLines(s).join("\n")); last = key; }
    if (s.state === "serving" || s.state === "failed" || s.state === "stopped") break;
    await Bun.sleep(1_000);
    s = (await client.pool()).serve ?? s;
  }
  return s.state === "serving" ? EXIT.ok : EXIT.error;
}

async function prepare(ctx: Ctx): Promise<number> {
  ctx = adminCtx(ctx, "prepare a model for split runs");
  const model = ctx.args.pos[1];
  const quant = ctx.args.flags.get("quant");
  if (!model) throw new UsageError("usage: walkie pool prepare <model-id> [--quant q4|q8]");
  if (quant !== undefined && quant !== "q4" && quant !== "q8") throw new UsageError("--quant is q4 or q8");
  const client = ctx.client();
  let p = (await client.poolPrepare(model, quant as "q4" | "q8" | undefined)).prepare;
  if (ctx.json) { ctx.out(JSON.stringify({ prepare: p })); return EXIT.ok; }
  let last = "";
  for (;;) {
    const line = `${p.name}${quantText(p.quant)}: ${p.state}${p.total ? ` ${gbText(p.done)} of ${gbText(p.total)}` : ""}${p.error ? ` · ${c.red(safeTerm(p.error))}` : ""}`;
    const key = `${p.state}|${Math.floor(p.done / (512 * 1024 * 1024))}`;
    if (key !== last) { ctx.out(line); last = key; }
    if (p.state === "done" || p.state === "failed") break;
    await Bun.sleep(1_000);
    p = (await client.pool()).prepare ?? p;
  }
  if (p.state === "done") ctx.out("Prepared: split runs of this model load this machine's share from its own disk, not over the network.");
  return p.state === "done" ? EXIT.ok : EXIT.error;
}

async function connect(ctx: Ctx): Promise<number> {
  ctx = adminCtx(ctx, "connect to a served model");
  const machine = ctx.args.pos[1];
  if (!machine) throw new UsageError("usage: walkie pool connect <machine>");
  const r = await ctx.client().poolConnect(machine);
  if (ctx.json) ctx.out(JSON.stringify(r)); else ctx.out(connectionLines(r.connection).join("\n"));
  return EXIT.ok;
}

async function disconnect(ctx: Ctx): Promise<number> {
  ctx = adminCtx(ctx, "disconnect from a served model");
  const machine = ctx.args.pos[1];
  if (!machine) throw new UsageError("usage: walkie pool disconnect <machine>");
  const r = await ctx.client().poolDisconnect(machine);
  if (ctx.json) ctx.out(JSON.stringify(r)); else ctx.out(r.connection ? `Disconnected from ${safeTerm(r.connection.hostname)}.` : "Not connected to that machine.");
  return EXIT.ok;
}

async function install(ctx: Ctx): Promise<number> {
  // POOL-REAL-1: a chore, not a trust decision: a person or a NAMED agent (WALKIE_AGENT / --agent, AGENT-ADMIN-1's
  // agent admin on) installs the pinned, sha256-checked runtime through the daemon; an unnamed agent is refused there.
  ctx = adminCtx(ctx, "install the llama.cpp runtime");
  const nvidia = ((await readAccel().catch(() => null))?.gpus.length ?? 0) > 0;
  const t = targetFor({ nvidia });
  if (!t) { ctx.err(`No pinned llama.cpp ${LLAMA_BUILD} build for ${process.platform}/${process.arch}.`); return EXIT.error; }
  const dirFlag = ctx.args.flags.get("dir");
  if (ctx.args.flags.get("dry-run") === true) {
    const dir = typeof dirFlag === "string" ? dirFlag : join(process.env.WALKIE_HOME ? walkieHome() : join(homedir(), ".walkie"), "pool", "llama");
    ctx.out(`Would install llama.cpp ${LLAMA_BUILD} for ${t.label} into ${dir} (sha256-checked):\n  ${manualInstall(t, dir)}`);
    return EXIT.ok;
  }
  if (typeof dirFlag === "string") {
    // Another directory: installed by this process, for a person only (the daemon installs into its own).
    await auditLocal(ctx, `installed llama.cpp ${LLAMA_BUILD} (${t.label}) into ${dirFlag}`);
    ctx.out(`Installing llama.cpp ${LLAMA_BUILD} for ${t.label} into ${dirFlag} (sha256-checked)…`);
    let shown = 0;
    const rt = await installRuntime(t, dirFlag, (file, done, total) => {
      const pct = Math.floor((done / total) * 10);
      if (pct > shown) { shown = pct; ctx.err(`  ${file}: ${pct * 10}%`); }
    });
    ctx.out(`Installed: ${rt.server} and ${rt.rpc}. Nothing listens until a split run starts.`);
    return EXIT.ok;
  }
  const client = ctx.client();
  let v = (await client.poolInstall()).install;
  if (ctx.json) { ctx.out(JSON.stringify({ install: v })); return EXIT.ok; }
  ctx.out(`Installing llama.cpp ${v.build} for ${v.target} (sha256-checked, by this machine's Walkie)…`);
  let shown = -1;
  for (;;) {
    const pct = v.total ? Math.floor((v.done / v.total) * 10) : 0;
    if (pct > shown && v.state === "downloading") { shown = pct; ctx.err(`  ${pct * 10}%`); }
    if (v.state !== "downloading") break;
    await Bun.sleep(1_000);
    // The daemon keeps installing if one status call fails (a busy machine): ask again.
    v = (await client.pool().catch(() => null))?.install ?? v;
  }
  if (v.state === "failed") { ctx.err(c.red(`Install failed: ${safeTerm(v.error ?? "unknown error")}`)); return EXIT.error; }
  const after = await client.pool();
  ctx.out(`Installed llama.cpp ${after.runtime.build ?? v.build} in ${after.runtime.dir}. Nothing listens until a run or a served model starts.`);
  return EXIT.ok;
}

/** `walkie pool <sub>`: share | run | serve | connect | disconnect | stop | status | install; null = no subcommand (the suggestions). */
export function poolSub(ctx: Ctx): Promise<number> | null {
  switch (ctx.args.pos[0]) {
    case undefined: return null;
    case "share": return share(ctx);
    case "run": return run(ctx);
    case "stop": return stop(ctx);
    case "status": return status(ctx);
    case "install": return install(ctx);
    case "serve": return serve(ctx);
    case "connect": return connect(ctx);
    case "prepare": return prepare(ctx);
    case "disconnect": return disconnect(ctx);
    default: throw new UsageError("usage: walkie pool [share on|off | run <model> | serve <model> [--on m] | connect <m> | disconnect <m> | stop [--on m] | status | install]");
  }
}
