// Wire views of the integrations local API. No imports: the dashboard type-checks against this file.

/** Status of one connector as returned by GET /v1/integrations (never contains a secret). */
export interface IntegrationView {
  id: "fireflies" | "wispr" | "linear";
  name: string;
  enabled: boolean;
  /** A key is available (for keyless connectors: always true). */
  configured: boolean;
  needs_key: boolean;
  key_source: "secret" | "key_path" | null;
  key_path: string | null;
  channel: string;
  settings: Record<string, unknown>;
  last_run: number | null;
  last_ok: number | null;
  last_error: string | null;
  items_posted: number;
  next_run: number | null;
  running: boolean;
}

/** Linear issue enrichment (GET /v1/linear/issues). Local only, never replicated. */
export interface LinearIssueInfo {
  key: string;
  title: string;
  state: string;
  state_type: string;
  assignee: string | null;
  priority: number;
  priority_label: string;
  url: string;
}
