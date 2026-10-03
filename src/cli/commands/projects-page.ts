// `walkie projects fact …` and `walkie projects screen …` (PROJECT-PAGES-1): what the people and agents of a project put on its
// status page by hand. Facts are a short label and a short value; screens are screenshots (PNG, JPEG or WebP) with a group, a
// title, a status and a plain sentence. Under an agent (PROTOCOL §6) what teammates wrote is wrapped for the model, and a write
// must name its agent (the daemon refuses an unnamed one). The page itself is written for non-technical teammates; this is the
// terminal's way to feed it.
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { SCREEN_MAX_BYTES, SCREEN_STATUSES } from "../../protocol/projects/schema.ts";
import type { ScreenView, SetFactView } from "../../protocol/projects/status-page.ts";
import { defang } from "../../protocol/safety.ts";
import type { WalkieClient } from "../../client/index.ts";
import { bool, need, str, UsageError } from "../args.ts";
import { EXIT, type Ctx } from "../context.ts";
import { c, pad, safeTerm } from "../format.ts";
import { channelOf, client, creatorClient } from "./projects.ts";

const MB = 1024 * 1024;
const SCREEN_USAGE = 'walkie projects screen <project> <image> --title <t> --group <g> --status works|partial|empty|not-built --about "<one plain sentence>" [--route /path] [--note "<text>"]' + "\n  (a route is the path of a page with no query string and no token in it: say what the page was filtered by in --note, and write /invite/:token, not a real invitation)";

const who = (b: { handle: string; agent?: string }) => `@${b.handle}${b.agent ? `/${b.agent}` : ""}`;

/** After a write: say so when the page is off (the facts and screens are kept, and shown once a creator or an owner turns it on). Never fails the command. */
async function offHint(ctx: Ctx, cl: WalkieClient, channel: string, ref: string): Promise<void> {
  try {
    if ((await cl.statusPage(channel)).mode === "hourly") return;
  } catch { return; }
  if (!ctx.json) ctx.out(c.dim(`the status page is off for this project, so nobody sees this yet; the project's creator or an owner turns it on with: walkie projects report ${safeTerm(ref)} on`));
}

// ---- facts --------------------------------------------------------------------------------------------------------------

function factLine(f: SetFactView): string {
  return `${pad(c.bold(safeTerm(f.label)), 26)} ${safeTerm(f.value)} ${c.dim(`${who(f.by)}`)}`;
}

/** `walkie projects fact <project> [<label> <value…> | <label> --remove]`. */
export async function factCmd(ctx: Ctx): Promise<number> {
  const ref = need(ctx.args, 1, "project");
  const label = ctx.args.pos[2];
  const remove = bool(ctx.args, "remove");
  const value = ctx.args.pos.slice(3).join(" ");
  if (label === undefined) {
    if (remove) throw new UsageError('walkie projects fact <project> "<label>" --remove');
    const cl = client(ctx);
    const { facts } = await cl.statusPage(await channelOf(cl, ref));
    const set = facts.set;
    if (ctx.json) {
      ctx.out(JSON.stringify(ctx.forAgent
        ? { facts: set.map((f) => ({ label: defang(f.label, 40), value: defang(f.value, 80), by: who(f.by) })), trust: "team-member" }
        : { facts: set }));
    } else if (ctx.forAgent) {
      ctx.out(set.length ? set.map((f) => `${defang(f.label, 40)}: ${defang(f.value, 80)} (${who(f.by)})`).join("\n") : "(no facts on the status page)");
    } else if (!set.length) {
      ctx.out(c.dim(`no facts yet: walkie projects fact ${safeTerm(ref)} "Live build" "ddee2f0bca"`));
    } else {
      for (const f of set) ctx.out(factLine(f));
    }
    return EXIT.ok;
  }
  if (remove && value) throw new UsageError('--remove takes a label alone: walkie projects fact <project> "<label>" --remove');
  if (!remove && !value) throw new UsageError('walkie projects fact <project> "<label>" "<value>"  (or: "<label>" --remove)');
  const cl = creatorClient(ctx); // a write under an agent must name it
  const channel = await channelOf(cl, ref);
  const res = await cl.setFact(channel, remove ? { label, remove: true } : { label, value });
  const text = (s: string, max: number) => (ctx.forAgent ? defang(s, max) : safeTerm(s));
  if (ctx.json) ctx.out(JSON.stringify(ctx.forAgent ? { unchanged: res.unchanged, facts: res.facts.length, trust: "team-member" } : res));
  else if (remove) ctx.out(res.unchanged ? `no fact called ${text(label, 40)}` : `${c.green("removed")} ${text(label, 40)}`);
  else ctx.out(res.unchanged ? `${c.dim("unchanged")} ${text(label, 40)} = ${text(value, 80)}` : `${c.green("set")} ${text(label, 40)} = ${text(value, 80)}`);
  await offHint(ctx, cl, channel, ref);
  return EXIT.ok;
}

// ---- screens ------------------------------------------------------------------------------------------------------------

function screenLine(s: ScreenView): string {
  const where = s.route ? ` ${c.dim(safeTerm(s.route))}` : "";
  const gone = s.available ? "" : c.yellow("  Not on any online machine");
  return `  ${pad(c.bold(safeTerm(s.title)), 34)} ${pad(s.status, 10)} ${c.dim(`v${s.version}`)}${where}${gone}`;
}

/** `walkie projects screen <project> [<image> --title … --group … --status … --about …] | --remove --group g --title t`. */
export async function screenCmd(ctx: Ctx): Promise<number> {
  const ref = need(ctx.args, 1, "project");
  const image = ctx.args.pos[2];
  const group = str(ctx.args, "group");
  const title = str(ctx.args, "title");
  const text = (s: string, max: number) => (ctx.forAgent ? defang(s, max) : safeTerm(s));

  if (bool(ctx.args, "remove")) {
    if (image !== undefined || !group || !title) throw new UsageError("walkie projects screen <project> --remove --group <g> --title <t>");
    const cl = creatorClient(ctx);
    const res = await cl.removeScreen(await channelOf(cl, ref), { group, title });
    if (ctx.json) ctx.out(JSON.stringify(res));
    else ctx.out(res.removed ? `${c.green("removed")} ${text(group, 40)} / ${text(title, 60)} from the status page (it stays in the Data Room)` : `no screen ${text(group, 40)} / ${text(title, 60)}`);
    return EXIT.ok;
  }

  if (image === undefined) {
    const cl = client(ctx);
    const { screens } = await cl.statusPage(await channelOf(cl, ref));
    if (ctx.json) {
      ctx.out(JSON.stringify(ctx.forAgent
        ? { total: screens.total, groups: screens.groups.map((g) => ({ name: defang(g.name, 40), screens: g.screens.map((s) => ({ title: defang(s.title, 60), status: s.status, version: s.version })) })), trust: "team-member" }
        : screens));
    } else if (!screens.groups.length) {
      ctx.out(c.dim(`no screens yet: walkie projects screen ${safeTerm(ref)} ./shot.png --title "Home" --group "Site" --status works --about "The home page."`));
    } else if (ctx.forAgent) {
      ctx.out(screens.groups.map((g) => `${defang(g.name, 40)} (${g.screens.length}): ${g.screens.map((s) => `${defang(s.title, 60)} [${s.status}]`).join("; ")}`).join("\n"));
    } else {
      for (const g of screens.groups) {
        ctx.out(c.bold(`${safeTerm(g.name)} (${g.screens.length})`));
        for (const s of g.screens) ctx.out(screenLine(s));
      }
    }
    return EXIT.ok;
  }

  const status = str(ctx.args, "status");
  const about = str(ctx.args, "about");
  if (!title || !group || !status || !about) throw new UsageError(SCREEN_USAGE);
  if (!(SCREEN_STATUSES as readonly string[]).includes(status)) throw new UsageError(`--status is one of ${SCREEN_STATUSES.join(", ")}`);
  const path = resolve(image);
  if (!existsSync(path)) throw new UsageError(`no such file: ${image}`);
  const st = statSync(path);
  if (!st.isFile()) throw new UsageError(`${image} is not a file`);
  if (st.size > SCREEN_MAX_BYTES) throw new UsageError(`${image} is over ${SCREEN_MAX_BYTES / MB} MB (the most a screen holds)`);
  const route = str(ctx.args, "route");
  const note = str(ctx.args, "note");
  const cl = creatorClient(ctx);
  const channel = await channelOf(cl, ref);
  const res = await cl.addScreen(channel, new Uint8Array(readFileSync(path)), { title, group, status, about, ...(route ? { route } : {}), ...(note ? { note } : {}) });
  if (ctx.json) ctx.out(JSON.stringify(ctx.forAgent ? { screen: { title: defang(res.screen.title, 60), group: defang(res.screen.group, 40), version: res.version }, created: res.created, unchanged: res.unchanged, trust: "team-member" } : res));
  else {
    const verb = res.unchanged ? c.dim("unchanged") : res.created ? c.green("added") : c.green("replaced");
    const size = res.screen.w && res.screen.h ? `, ${res.screen.w}×${res.screen.h}` : "";
    ctx.out(`${verb} ${text(res.screen.group, 40)} / ${text(res.screen.title, 60)} ${c.dim(`(v${res.version}${size})`)}`);
  }
  await offHint(ctx, cl, channel, ref);
  return EXIT.ok;
}
