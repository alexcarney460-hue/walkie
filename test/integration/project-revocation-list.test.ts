import { expect, test } from "bun:test";
import { Cluster, waitFor } from "../helpers/cluster.ts";
import type { StreamMessage } from "../../src/protocol/schemas.ts";

test("a member's lists after its revocation stream event never include the private project", async () => {
  const cluster = new Cluster();
  const streamAbort = new AbortController();
  let stream: Promise<void> | undefined;
  try {
    const owner = await cluster.add({ name: "owner", login: "owner@example.com" });
    const member = await cluster.add({ name: "member", login: "member@example.com" });
    await owner.client().init("revocation-list", "owner");
    await owner.client().invite("member@example.com", "member", "member");
    expect((await member.client().join(owner.peerAddr)).admitted).toBe(true);
    await owner.client().setRole("member", "owner");
    await waitFor(() => member.d.core.me()?.role === "owner", { what: "member receives owner role" });
    const { project } = await owner.client().createProject({ name: "Private roster proof", private: true });
    await waitFor(async () => {
      member.d.projects.flushAll();
      return (await member.client().projects()).projects.some((p) => p.channel === project.channel);
    }, { what: "member sees private project before revocation" });

    const received: StreamMessage[] = [];
    stream = (async () => {
      try {
        for await (const message of member.client().stream(undefined, streamAbort.signal)) received.push(message);
      } catch (error) {
        if (!streamAbort.signal.aborted) throw error;
      }
    })();
    await waitFor(() => member.d.core.hub.size > 0, { what: "member stream opens" });
    await owner.client().setRole("member", "member");
    await waitFor(() => received.some((message) => message.type === "event" && message.event.kind === "team.member"
      && message.event.body.handle === "member" && message.event.body.role === "member"),
    { timeoutMs: 15_000, what: "member stream receives revocation" });
    // The role event can arrive before the authority's restricted-channel fix. That interval supplied the RED result.
    await waitFor(() => received.some((message) => {
      if (message.type !== "event" || message.event.kind !== "channel.upsert") return false;
      const body = message.event.body as { name?: string; members?: string[] };
      return body.name === project.channel && Array.isArray(body.members) && !body.members.includes("member");
    }),
    { timeoutMs: 15_000, what: "member stream receives channel revocation" });

    for (let i = 0; i < 12; i++) {
      const list = await member.client().projects();
      expect(list.projects.some((p) => p.channel === project.channel)).toBe(false);
    }
    for (let batch = 0; batch < 8; batch++) {
      const lists = await Promise.all(Array.from({ length: 8 }, () => member.client().projects()));
      for (const list of lists) expect(list.projects.some((p) => p.channel === project.channel)).toBe(false);
    }
  } finally {
    streamAbort.abort();
    await stream;
    await cluster.close();
  }
}, 60_000);
