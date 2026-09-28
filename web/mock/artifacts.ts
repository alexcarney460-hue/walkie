// Fictional artifact contents for the mock blob store.

export interface ArtifactFile {
  name: string; mime: string; channel: string; who: string; at: number; note: string; content: () => string;
}

function repeat(n: number, line: (i: number) => string): string {
  return Array.from({ length: n }, (_, i) => line(i)).join("\n");
}

export const ARTIFACT_FILES: ArtifactFile[] = [
  {
    name: "plan-pg16.txt", mime: "text/plain", channel: "ops", who: "tobias-mbp/infra", at: 190,
    note: "terraform plan for the staging Postgres 16 upgrade (KST-377)",
    content: () => [
      "Terraform will perform the following actions:",
      "",
      "  # module.db.aws_db_parameter_group.pg16 will be created",
      "  + resource \"aws_db_parameter_group\" \"pg16\" {",
      "      + family = \"postgres16\"",
      "      + name   = \"stg-harbor-pg16\"",
      repeat(120, (i) => `      + parameter { name = \"param_${i}\" value = \"${(i * 37) % 997}\" }`),
      "    }",
      "",
      "Plan: 3 to add, 2 to change, 0 to destroy.",
    ].join("\n"),
  },
  {
    name: "search-p95-profile.json", mime: "application/json", channel: "build", who: "sol-x1/perf", at: 238,
    note: "k6 + pg_stat_statements capture before the trigram index",
    content: () => JSON.stringify({
      endpoint: "/v1/search", rps: 200, p50_ms: 131, p95_ms: 412, p99_ms: 690,
      statements: Array.from({ length: 400 }, (_, i) => ({ query_id: 90_000 + i, calls: 1000 + ((i * 7919) % 5000), mean_ms: Number(((i * 13) % 97 / 3.1).toFixed(2)) })),
    }, null, 2),
  },
  {
    name: "checkout-summary.patch", mime: "text/x-diff", channel: "design", who: "maren-mbp/ux-seat", at: 172,
    note: "SummaryPanel on tokens v2, for review before the PR",
    content: () => [
      "diff --git a/src/checkout/SummaryPanel.tsx b/src/checkout/SummaryPanel.tsx",
      "--- a/src/checkout/SummaryPanel.tsx",
      "+++ b/src/checkout/SummaryPanel.tsx",
      "@@ -1,40 +1,52 @@",
      repeat(90, (i) => (i % 3 === 0 ? `-  <Row dense label=\"line ${i}\" />` : `+  <Row size=\"sm\" label=\"line ${i}\" />`)),
    ].join("\n"),
  },
  {
    name: "e2e-nightly-0924.log", mime: "text/plain", channel: "build", who: "atlas/e2e", at: 211,
    note: "178 of 180 passed; refund timeout + sso flake",
    content: () => repeat(900, (i) => `[${String(i).padStart(4, "0")}] ${i % 97 === 0 ? "FAIL" : "ok  "} spec-${i % 180} ${(i * 31) % 4000} ms`),
  },
  {
    name: "empty-states-draft.md", mime: "text/markdown", channel: "design", who: "ines-studio/copy", at: 177,
    note: "Releases, Webhooks and API keys empty states, two headline options",
    content: () => [
      "# Empty states (draft)",
      "",
      "## Releases",
      "A: Nothing shipped yet",
      "B: Your first release lands here",
      "",
      "## Webhooks",
      "No endpoints yet. Add one to start receiving events.",
      "",
      "## API keys",
      "Create a key to call the API from your own code.",
    ].join("\n"),
  },
];
