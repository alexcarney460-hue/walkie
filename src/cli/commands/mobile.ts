// walkie mobile — Walkie on your phone (WALKIE-PWA-1): the phone app (a page on the Walkie site) reaches this daemon
// through an end-to-end encrypted relay link, paired by a one-time QR code. A person runs these, never an agent.
import { adminCtx } from "../admin-gate.ts";
import type { MobileStatus, PairView } from "../../daemon/mobile/manager.ts";
import type { DeviceView } from "../../daemon/mobile/devices.ts";
import { bool, UsageError } from "../args.ts";
import { EXIT, type Ctx } from "../context.ts";
import { ago, c, color, safeTerm } from "../format.ts";

const USAGE = "walkie mobile [status] | pair | devices | revoke <id> | revoke --all";

/** Two QR rows per line with ▀ (upper module = foreground, lower = background), black on white, 2-module quiet zone. */
export function renderQr(rows: readonly string[]): string {
  const n = rows.length;
  const quiet = 2;
  const size = n + quiet * 2;
  const dark = (r: number, col: number): boolean => {
    const rr = r - quiet;
    const cc = col - quiet;
    return rr >= 0 && rr < n && cc >= 0 && cc < n && rows[rr]?.[cc] === "1";
  };
  const lines: string[] = [];
  for (let r = 0; r < size; r += 2) {
    let line = "";
    for (let col = 0; col < size; col++) {
      const fg = dark(r, col) ? 30 : 97;
      const bg = r + 1 < size && dark(r + 1, col) ? 40 : 107;
      line += `\x1b[${fg};${bg}m▀`;
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines.join("\n");
}

function devicesText(list: readonly DeviceView[]): string {
  if (!list.length) return c.dim("no paired devices");
  return list.map((d) => `${c.bold(d.id)}  ${safeTerm(d.name)}  ${c.dim(`paired ${ago(d.created_at)} · last used ${ago(d.last_seen)}`)}`).join("\n");
}

function statusText(s: MobileStatus): string {
  const head = s.devices.length === 0 && s.pairing === 0
    ? `${c.dim("no phone paired")} — pair one with: walkie mobile pair`
    : `${s.linked ? c.green("linked") : c.yellow("connecting")} through ${safeTerm(s.relay)}${s.connected ? c.dim(` · ${s.connected} connected now`) : ""}${s.pairing ? c.dim(` · ${s.pairing} pairing link${s.pairing === 1 ? "" : "s"} open`) : ""}`;
  return `Walkie on your phone: ${head}${s.notice ? `\n${c.yellow(safeTerm(s.notice))}` : ""}\n${devicesText(s.devices)}`;
}

function pairText(p: PairView): string {
  const left = Math.max(0, Math.round((p.expires_at - Date.now()) / 60_000));
  const qr = color ? `${renderQr(p.qr)}\n\n` : "";
  return `${qr}Scan with your phone's camera, or open this on the phone:\n  ${p.url}\n` +
    `Installed the app first (iPhone: Share → Add to Home Screen)? Paste this code into it:\n  ${c.bold(p.code)}\n` +
    c.dim(`One use, ${left} min. The code is the key: don't share it.`);
}

export async function mobile(ctx: Ctx): Promise<number> {
  const sub = ctx.args.pos[0] ?? "status";
  // The pairing code is a credential shown in plain text (AGENT-ADMIN-1 §3): a person's. Status and revoking are admin.
  if (ctx.forAgent && sub === "pair") throw new UsageError("walkie mobile pair shows a pairing code (a credential): run it yourself in a terminal, not through an agent");
  // AGENT-ADMIN-1: signing phones out is admin (an agent or unattended caller is marked, the daemon gates and audits).
  const client = sub === "revoke" ? adminCtx(ctx, "sign out a paired phone").client() : ctx.client();
  const print = (v: unknown, text: string) => ctx.out(ctx.json ? JSON.stringify(v) : text);
  switch (sub) {
    case "status": {
      const s = await client.mobile();
      print(s, statusText(s));
      return EXIT.ok;
    }
    case "pair": {
      const p = await client.mobilePair();
      print(p, pairText(p));
      return EXIT.ok;
    }
    case "devices": {
      const s = await client.mobile();
      print({ devices: s.devices }, devicesText(s.devices));
      return EXIT.ok;
    }
    case "revoke": {
      if (bool(ctx.args, "all")) {
        const r = await client.mobileRevokeAll();
        print(r, `signed out ${r.revoked} device${r.revoked === 1 ? "" : "s"}`);
        return EXIT.ok;
      }
      const id = ctx.args.pos[1];
      if (!id || !/^[0-9a-f]{12}$/.test(id)) throw new UsageError("walkie mobile revoke <device id from: walkie mobile devices> | --all");
      const r = await client.mobileRevoke(id);
      print(r, `signed out device ${id}`);
      return EXIT.ok;
    }
    default:
      throw new UsageError(`unknown: walkie mobile ${sub} (${USAGE})`);
  }
}
