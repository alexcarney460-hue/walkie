// The latest status of every agent this node knows, kept in memory (DAEMON-STALL-2). The roster views, the stream, the
// archive upkeep, discovery and the status checks all walk this table, some of them several times a second: reading it
// from SQLite each time re-allocated every row's text (a team's table is a few thousand rows, a megabyte or more of
// JSON) only to throw it away, and on a machine short of memory that garbage is what stalls the daemon. The table is
// loaded once, on the first read, and then only the rows a write touches are replaced, so a read is free and a row
// object stays the same object until its agent reports again (callers can tell an unchanged row by identity).
//
// The store owns `agents_latest`: every write goes through it (upsertAgent, deleteAgents, recomputeAgent), which keeps
// this table in step; a transaction that rolls back drops it, and the next read loads it again.
import type { BodyOf } from "../protocol/schemas.ts";
import type { AgentRow } from "./store.ts";

const keyOf = (node: string, agent: string): string => `${node}\u0000${agent}`;

/**
 * SQLite's order for `ORDER BY handle, node, agent` (BINARY collation). Handles, node ids and agent names are ASCII (the
 * schemas' patterns), where it is the same as comparing the strings.
 */
function inTableOrder(a: AgentRow, b: AgentRow): number {
  if (a.handle !== b.handle) return a.handle < b.handle ? -1 : 1;
  if (a.node !== b.node) return a.node < b.node ? -1 : 1;
  return a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0;
}

export class AgentTable {
  private rows: Map<string, AgentRow> | null = null;
  private sorted: readonly AgentRow[] | null = null;

  /** `load` reads the whole table from SQLite (ordered by handle, node, agent). */
  constructor(private readonly load: () => AgentRow[]) {}

  /** Whether the table is in memory (a write only has to be mirrored then: a load reads it). */
  get loaded(): boolean { return this.rows !== null; }

  /** Every row ordered by handle, node, agent: one array until a row changes. Callers never change it or its rows. */
  list(): readonly AgentRow[] {
    if (this.sorted) return this.sorted;
    this.sorted = [...this.ensure().values()].sort(inTableOrder);
    return this.sorted;
  }

  put(row: AgentRow): void {
    if (!this.rows) return;
    this.rows.set(keyOf(row.node, row.agent), row);
    this.sorted = null;
  }

  remove(node: string, agent: string): void {
    if (this.rows?.delete(keyOf(node, agent))) this.sorted = null;
  }

  /** Forgets what is in memory: the next read loads the table again (a rolled-back transaction, a write made behind the store's back). */
  reset(): void {
    this.rows = null;
    this.sorted = null;
  }

  private ensure(): Map<string, AgentRow> {
    this.rows ??= new Map(this.load().map((r) => [keyOf(r.node, r.agent), r]));
    return this.rows;
  }
}

const parsed = new WeakMap<AgentRow, Readonly<BodyOf<"agent.status">>>();

/**
 * A row's status, parsed once per row object (rows from `Store.agents()` are stable until their agent reports again).
 * Read only: the same object goes to every caller.
 */
export function agentStatus(row: AgentRow): Readonly<BodyOf<"agent.status">> {
  let s = parsed.get(row);
  if (s === undefined) {
    s = JSON.parse(row.body) as BodyOf<"agent.status">;
    parsed.set(row, s);
  }
  return s;
}
