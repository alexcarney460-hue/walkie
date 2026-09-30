import { expect, test } from "bun:test";
import { previewInvite } from "../../src/cli/join-preview.ts";
import { Cluster } from "../helpers/cluster.ts";

test("the app preview reads team and inviter from the pinned authority over Direct", async () => {
  const cluster = new Cluster();
  try {
    const owner = await cluster.add({ name: "owner", login: "-", hostname: "owner-mac", direct: true });
    const me = await owner.client().init("acme", "alex");
    if (!me.team) throw new Error("owner did not create a team");
    const invite = await owner.client().inviteCode("kira", "member");
    const info = await previewInvite(invite.code, { preset: "minimal", bindAddr: "127.0.0.1:0", addressBook: cluster.addressBook });
    expect(info).toEqual({ team_id: me.team.id, team_name: "acme", inviter_handle: "alex", spent: false });
  } finally {
    await cluster.close();
  }
}, 30_000);
