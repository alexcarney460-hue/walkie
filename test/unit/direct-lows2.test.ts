// DIRECT-FIX-2 LOWs (Codex r2 LOW 3 + 4): a non-authority names the roster authority only to a caller with a
// code the team's owner really signed; a cached darwin-x64 iroh module is embedded only when it matches its pin.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createInvite, inviteMintPos } from "../../src/daemon/invite.ts";
import { PeerApi } from "../../src/daemon/peer-api.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { checkBuilt, parsePins, reuseCached } from "../../scripts/iroh-cache.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { createTeam, memberEv, nodeEv, now, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

/** kira's daemon: a replica (not the authority) of alex's team. */
function replica() {
  const alex = tnode("alex");
  const kira = tnode("kira");
  const { team, create } = createTeam(alex);
  const log: Event[] = [create, nodeEv(team, alex, alex), memberEv(team, alex, kira, "member"), nodeEv(team, alex, kira)];
  const core = makeCore(kira, team, cleanups);
  feed(core, log);
  return { alex, kira, team, core, api: new PeerApi(core) };
}

async function joinVia(api: PeerApi, invite: string) {
  const stranger = tnode("mallory");
  const req = new Request("http://walkie.direct/peer/v1/join", {
    method: "POST", body: JSON.stringify({ pubkey: stranger.keys.pubkey, hostname: "evil", ip: "", invite }),
  });
  const res = await api.handle(req, { kind: "direct", pubkey: stranger.keys.pubkey });
  return { status: res.status, body: await res.json() as { reason?: string; authority?: { hostname?: string }; error?: { code?: string } } };
}

describe("authority disclosure (Codex r2 LOW 3)", () => {
  test("a garbage or forged code gets 403 from a non-authority, and no authority hostname/key", async () => {
    const w = replica();
    expect(w.core.isAuthority()).toBe(false);
    const garbage = await joinVia(w.api, "wk1" + "A".repeat(80));
    const forged = createInvite(tnode("mallory").keys, { team: w.team, authority: w.alex.keys.pubkey, handle: "x", role: "owner", now: now(), pos: 0 });
    const byStranger = await joinVia(w.api, forged.code);
    console.log(`[evidence] non-authority: garbage -> ${garbage.status} ${JSON.stringify(garbage.body).slice(0, 90)}; forged -> ${byStranger.status} ${byStranger.body.error?.code}`);
    for (const r of [garbage, byStranger]) {
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.body)).not.toContain(w.alex.hostname);
      expect(JSON.stringify(r.body)).not.toContain(w.alex.keys.pubkey);
    }
  });

  test("a code the owner signed is still redirected to the authority", async () => {
    const w = replica();
    const inv = createInvite(w.alex.keys, { team: w.team, authority: w.alex.keys.pubkey, handle: "riley", role: "member", now: now(), pos: inviteMintPos(w.core.roster) });
    const r = await joinVia(w.api, inv.code);
    expect(r.status).toBe(200);
    expect(r.body.reason).toBe("not_authority");
    expect(r.body.authority?.hostname).toBe(w.alex.hostname);
  });
});

describe("cached native module integrity (Codex r2 LOW 4)", () => {
  const dir = mkdtempSync("/tmp/walkie-irohcache-");
  cleanups.push(() => undefined);
  const path = join(dir, "iroh.darwin-x64.node");
  const hash = (b: string) => createHash("sha256").update(b).digest("hex");

  test("a cached module matching its pin is reused", () => {
    writeFileSync(path, "good");
    expect(reuseCached(path, hash("good"))).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  test("a modified cached module is deleted and rebuilt, not embedded", () => {
    writeFileSync(path, "tampered");
    expect(reuseCached(path, hash("good"))).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  test("an unpinned cached module is never reused", () => {
    writeFileSync(path, "whatever");
    expect(reuseCached(path, undefined)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  test("a fresh build that doesn't match a pin fails the build", () => {
    writeFileSync(path, "built");
    expect(() => checkBuilt(path, "iroh.darwin-x64.node", hash("other"))).toThrow(/does not match the pin/);
    expect(checkBuilt(path, "iroh.darwin-x64.node", undefined)).toBe(hash("built"));
    rmSync(dir, { recursive: true, force: true });
  });

  test("SHA256SUMS parsing keeps version/file keys and skips comments", () => {
    const pins = parsePins(`# c\n${"a".repeat(64)}  1.1.0/iroh.darwin-arm64.node\n`);
    expect(pins.get("1.1.0/iroh.darwin-arm64.node")).toBe("a".repeat(64));
    expect(pins.size).toBe(1);
  });
});
