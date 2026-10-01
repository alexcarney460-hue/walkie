// Production adapter for the narrow guest projection. Writes are signed on the owner's real node.
import type { Core } from "../daemon/core.ts";
import type { ProjectsIndex } from "../daemon/projects/index.ts";
import type { PeerClient } from "../daemon/peer-client.ts";
import type { CatchUp } from "../daemon/requests.ts";
import { cardAction, comment, type WriteCtx } from "../daemon/projects/service.ts";
import type { Guest } from "./guest-registry.ts";
import type { GuestCard, GuestData, GuestProject } from "./guest-scope.ts";

export function guestData(core: Core, idx: ProjectsIndex, client: PeerClient, catchUp: CatchUp): GuestData {
  const ctx = (guest: Guest): WriteCtx => ({ core, idx, client, catchUp, agent: guest.agent });
  const project = (channel: string): GuestProject | null => {
    idx.flushProject(channel);
    if (!core.isProjectChannel(channel) || !core.visible({ channel })) return null;
    const value = idx.project(channel);
    return value ? { channel: value.channel, name: value.name, prefix: value.prefix, private: value.private, state: value.state } : null;
  };
  const card = (id: string): GuestCard | null => {
    const channel = idx.db.card(id)?.channel;
    if (!channel) return null;
    idx.flushProject(channel);
    const value = idx.db.card(id);
    return value ? { id: value.id, channel: value.channel, key: value.key, ref: value.ref, title: value.title,
      body: value.body, assignee: value.assignee, labels: value.labels, state: value.state, column: value.column, due: value.due, updated_at: value.updated_at,
      created_by: value.created_by } : null;
  };
  return {
    project, card,
    comments: (value) => (idx.foldCardNow(value.channel, value.id)?.state.timeline ?? [])
      .filter((entry) => entry.kind === "comment")
      .map((entry) => ({ id: entry.id, channel: value.channel, text: entry.text ?? "", author: entry.author })),
    comment: (guest, id, text) => comment(ctx(guest), id, text).id,
    move: (guest, id, action, reason) => {
      const next = cardAction(ctx(guest), id, action, reason);
      const timeline = idx.foldCardNow(next.channel, id)?.state.timeline ?? [];
      return timeline[timeline.length - 1]?.id ?? id;
    },
    status: (guest, id, title, state) => {
      const current = card(id);
      if (!current) return null;
      const event = core.statuses.submit(guest.agent, {
        agent: guest.agent, state, runtime: "other", runtime_name: guest.family,
        title, task: current.key, activity: "Guest self-report", ask_policy: "off",
      }, { title: "agent", task: "agent", activity: "phrase" });
      return event?.id ?? null;
    },
  };
}
