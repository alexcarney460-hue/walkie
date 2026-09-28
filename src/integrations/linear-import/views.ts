// Wire views of the Linear import (LINEAR-IMPORT-1): `/v1/import/linear/status`, the job, a sync pass. Types only (the
// dashboard imports them).
export type { Plan, PlanIssue, PlanOptions, PlanProject, Selection } from "./plan.ts";

export interface ImportError { project?: string; issue?: string; message: string }

export interface JobView {
  id: string;
  state: "running" | "waiting" | "done" | "failed" | "cancelled";
  started_at: number; finished_at: number | null;
  /** What it is doing now ("reading Linear", a project's name). */
  current: string;
  projects_total: number; projects_done: number;
  /** Issues read for the selected projects (known once each project is read). */
  issues_total: number;
  created: number; updated: number; unchanged: number; comments: number; skipped: number;
  /** Signed posts (the replication cost). */
  events: number;
  /** While waiting for the import budget: when it continues. */
  waiting_until: number | null;
  errors: ImportError[];
  /** Walkie projects this run created or wrote into. */
  projects: Array<{ key: string; channel: string; prefix: string; name: string; created: boolean }>;
}

export interface SyncResult {
  at: number; two_way: boolean;
  read: number; created: number; updated: number; conflicts: number; to_linear: number;
  errors: ImportError[];
}

export interface SyncView {
  enabled: boolean; two_way: boolean; interval_min: number;
  /** The key a scheduled sync uses: the integration's, or a key file (path only). */
  key: "integration" | "key_file" | "none";
  key_file?: string;
  last_run: number | null; last_result: string | null; last_error: string | null;
  running: boolean;
}

export interface ImportStatus {
  job: JobView | null;
  sync: SyncView;
  imported: { projects: number; cards: number };
  /** The Linear integration is on with a key (the import can use it). */
  integration: boolean;
}
