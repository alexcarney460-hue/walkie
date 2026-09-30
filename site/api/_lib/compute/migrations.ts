// Neon Postgres schema for rental compute, applied in order by `migrate()` (pg-store.ts) under an advisory lock and
// recorded in compute_migrations. Amounts are integer micro-dollars (bigint); times are unix ms (bigint). The ledger
// is append-only: balance = sum(amount_micros). Retention: ledger 7 years (tax); rentals/rent requests 1 year.
export const MIGRATIONS: readonly { readonly id: number; readonly sql: string }[] = [
  {
    id: 1,
    sql: `
CREATE TABLE compute_accounts (
  id          text PRIMARY KEY CHECK (id ~ '^ca_[0-9a-f]{16}$'),
  team_id     text NOT NULL CHECK (team_id ~ '^[0-9a-f]{16}$'),
  token_hash  text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen')),
  review      text,
  created_at  bigint NOT NULL
);
CREATE INDEX compute_accounts_team ON compute_accounts (team_id);

CREATE TABLE compute_ledger (
  id             bigserial PRIMARY KEY,
  account_id     text NOT NULL REFERENCES compute_accounts (id),
  kind           text NOT NULL CHECK (kind IN ('purchase', 'burn', 'refund', 'adjustment')),
  amount_micros  bigint NOT NULL,
  idem_key       text NOT NULL UNIQUE,
  rental_id      text,
  ref            text,
  live           boolean NOT NULL DEFAULT false,
  created_at     bigint NOT NULL
);
CREATE INDEX compute_ledger_account ON compute_ledger (account_id);
CREATE INDEX compute_ledger_ref ON compute_ledger (ref) WHERE ref IS NOT NULL;

CREATE TABLE compute_rentals (
  id                     text PRIMARY KEY CHECK (id ~ '^r_[0-9a-f]{16}$'),
  account_id             text NOT NULL REFERENCES compute_accounts (id),
  team_id                text NOT NULL,
  tier                   text NOT NULL,
  name                   text NOT NULL,
  state                  text NOT NULL CHECK (state IN ('queued', 'needs_code', 'starting', 'running', 'stopping', 'ended', 'failed')),
  price_per_hour_micros  bigint NOT NULL,
  idle_minutes           integer NOT NULL,
  created_at             bigint NOT NULL,
  ord                    integer NOT NULL DEFAULT 0,
  walkie_version         text NOT NULL,
  needs_code_at          bigint,
  started_at             bigint,
  ended_at               bigint,
  end_reason             text,
  instance_id            text,
  heartbeat_hash         text,
  last_heartbeat_at      bigint,
  last_busy_at           bigint,
  gpu_hot_since          bigint,
  egress_bytes           bigint NOT NULL DEFAULT 0,
  egress_billed_gib      bigint NOT NULL DEFAULT 0,
  node_id                text,
  charged_micros         bigint NOT NULL DEFAULT 0,
  billed_minutes         integer NOT NULL DEFAULT 0,
  launch_attempts        integer NOT NULL DEFAULT 0
);
CREATE INDEX compute_rentals_account ON compute_rentals (account_id, created_at);
CREATE INDEX compute_rentals_active ON compute_rentals (created_at, ord, id) WHERE state IN ('queued', 'needs_code', 'starting', 'running', 'stopping');

CREATE TABLE compute_rent_requests (
  account_id  text NOT NULL REFERENCES compute_accounts (id),
  idem_key    text NOT NULL,
  rental_ids  jsonb NOT NULL,
  code_index  jsonb NOT NULL,
  created_at  bigint NOT NULL,
  PRIMARY KEY (account_id, idem_key)
);

CREATE TABLE compute_rate_limits (
  key           text NOT NULL,
  window_start  bigint NOT NULL,
  hits          integer NOT NULL,
  PRIMARY KEY (key, window_start)
);
`,
  },
  { id: 2, sql: `
ALTER TABLE compute_accounts ADD COLUMN IF NOT EXISTS classification text NOT NULL DEFAULT 'unverified';
ALTER TABLE compute_accounts ADD COLUMN IF NOT EXISTS authority text;
ALTER TABLE compute_accounts ADD COLUMN IF NOT EXISTS owner_key text;
ALTER TABLE compute_rentals ADD COLUMN IF NOT EXISTS safety jsonb;
CREATE TABLE IF NOT EXISTS compute_control (key text PRIMARY KEY, value jsonb NOT NULL);
` },
  { id: 3, sql: `
CREATE TABLE compute_enrollments (
  team_id text PRIMARY KEY CHECK (team_id ~ '^[0-9a-f]{16}$'),
  owner_key text NOT NULL,
  source text NOT NULL CHECK (source IN ('tofu', 'license')),
  updated_at bigint NOT NULL
);
` },
  { id: 4, sql: `
ALTER TABLE compute_enrollments DROP CONSTRAINT compute_enrollments_source_check;
ALTER TABLE compute_enrollments ADD CONSTRAINT compute_enrollments_source_check CHECK (source IN ('tofu', 'license', 'roster'));
` },
  { id: 5, sql: `
ALTER TABLE compute_accounts ADD COLUMN IF NOT EXISTS first_funded_at bigint;
UPDATE compute_accounts AS a SET first_funded_at = p.first_funded_at
FROM (SELECT account_id, MIN(created_at) AS first_funded_at FROM compute_ledger
      WHERE kind = 'purchase' AND amount_micros > 0 GROUP BY account_id) AS p
WHERE a.id = p.account_id AND a.first_funded_at IS NULL;
` },
  { id: 6, sql: `
UPDATE compute_accounts AS a SET first_funded_at = LEAST(
  COALESCE(a.first_funded_at, p.first_funded_at), p.first_funded_at)
FROM (SELECT account_id, MIN(created_at) AS first_funded_at FROM compute_ledger
      WHERE kind IN ('purchase', 'adjustment') AND amount_micros > 0 GROUP BY account_id) AS p
WHERE a.id = p.account_id;
` },
];
export const LATEST_MIGRATION = MIGRATIONS[MIGRATIONS.length - 1]!.id;
