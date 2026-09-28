// UI-POLISH-2: the machine page's archive loader. A refresh replaces the snapshot (no stale titles or activity after
// a reprojection), "Show more" pages past 50, and only the newest request's answer lands.
import { expect, test } from "bun:test";
import type { AgentView } from "../src/api/types.ts";
import { createArchiveLoader, MACHINE_ARCHIVE_PAGE, mergeArchivePage, refreshLimit, type ArchiveSnapshot } from "../src/views/machine/machine-archive.ts";

const NOW = Date.now();
const ag = (n: number, title = `task ${n}`, activity?: string): AgentView => ({
  id: `alex/alex-mac/seat-${n}`, handle: "alex", node: "a1e0000000000001", hostname: "alex-mac", agent: `seat-${n}`,
  status: { agent: `seat-${n}`, state: "idle", runtime: "claude-code", title, ...(activity ? { activity } : {}) },
  updated_at: NOW - n * 60_000, machine_online: true, effective_state: "idle", archived: true,
});
const range = (from: number, to: number, title?: (n: number) => string) => Array.from({ length: to - from }, (_, i) => ag(from + i, title?.(from + i)));

/** A fake daemon: `rows` is the whole archive; pages come from it like /v1/agents?scope=archive. */
function daemon(rows: AgentView[]) {
  const calls: Array<{ offset: number; limit: number }> = [];
  const api = {
    rows,
    calls,
    fetch: async (p: { offset: number; limit: number }) => {
      calls.push(p);
      const page = api.rows.slice(p.offset, p.offset + p.limit);
      return { agents: page, total: api.rows.length, truncated: p.offset + page.length < api.rows.length };
    },
  };
  return api;
}

test("merge: a refresh replaces; a further page updates known agents in place and appends the rest", () => {
  const prev = [ag(1, "old one"), ag(2, "old two")];
  expect(mergeArchivePage(prev, [ag(1, "new one")], true).map((a) => a.status.title)).toEqual(["new one"]);
  expect(mergeArchivePage(prev, [ag(2, "new two"), ag(3)], false).map((a) => a.status.title)).toEqual(["old one", "new two", "task 3"]);
  expect(refreshLimit(0)).toBe(MACHINE_ARCHIVE_PAGE);
  expect(refreshLimit(120)).toBe(120);
  expect(refreshLimit(5_000)).toBe(1_000);
});

test("reopening after a reprojection shows the new title and drops activity that stopped being shared", async () => {
  const d = daemon([ag(1, "Fix the invoice cents", "Bash cat ~/.env"), ag(2)]);
  let seen: ArchiveSnapshot | null = null;
  const loader = createArchiveLoader(d.fetch, (s) => { seen = s; });
  await loader.refresh();
  expect(loader.snapshot.rows[0]?.status.activity).toBe("Bash cat ~/.env");
  d.rows = [ag(1, "Invoice cents"), ag(2)]; // share turned off: the daemon now sends no activity
  await loader.refresh();
  expect(loader.snapshot.rows[0]?.status.title).toBe("Invoice cents");
  expect(loader.snapshot.rows[0]?.status.activity).toBeUndefined();
  expect(seen!.loading).toBe(false);
});

test("pages past 50: partial count, Show more, and a refresh reloads everything shown", async () => {
  const d = daemon(range(1, 121));
  const loader = createArchiveLoader(d.fetch, () => {});
  await loader.refresh();
  expect(loader.snapshot.rows).toHaveLength(50);
  expect(loader.snapshot).toMatchObject({ total: 120, more: true });
  await loader.loadMore();
  await loader.loadMore();
  expect(loader.snapshot.rows).toHaveLength(120);
  expect(loader.snapshot.more).toBe(false);
  await loader.loadMore(); // nothing remains: no request
  expect(d.calls).toEqual([{ offset: 0, limit: 50 }, { offset: 50, limit: 50 }, { offset: 100, limit: 50 }]);
  d.rows = range(1, 121, (n) => `renamed ${n}`);
  await loader.refresh(); // the revision changed: one request for everything shown, replacing it
  expect(d.calls.at(-1)).toEqual({ offset: 0, limit: 120 });
  expect(loader.snapshot.rows.every((a) => a.status.title?.startsWith("renamed"))).toBe(true);
});

test("only the newest request lands; a cancelled one is dropped; an error keeps the rows", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let slow = true;
  const d = daemon([ag(1, "first")]);
  const loader = createArchiveLoader(async (p) => {
    if (slow) { slow = false; await gate; return { agents: [ag(1, "stale answer")], total: 1, truncated: false }; }
    return d.fetch(p);
  }, () => {});
  const first = loader.refresh();
  await loader.refresh();
  release();
  await first;
  expect(loader.snapshot.rows[0]?.status.title).toBe("first");
  const fail = createArchiveLoader(async () => { throw new Error("offline"); }, () => {});
  await fail.refresh();
  expect(fail.snapshot.error).toBeTruthy();
  expect(fail.snapshot.loading).toBe(false);
  const cancelled = createArchiveLoader(async () => ({ agents: [ag(9)], total: 1, truncated: false }), () => {});
  const p = cancelled.refresh();
  cancelled.cancel();
  await p;
  expect(cancelled.snapshot.rows).toHaveLength(0);
});
