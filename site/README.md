# Landing page

Static pages (`index.html`, `welcome.html`) with `assets/site.css`, `assets/site.js`, `assets/welcome.js`,
self-hosted fonts and WebP screenshots, plus the billing functions in `api/` (see "Billing functions" below).
The pages use no framework, no bundler and no external requests; the functions' only dependency is `stripe`.

```
site/
  brand.json            the product name (the only place it appears) + tagline, GitHub owner, site URL
  build.py              renders src/index.html into index.html (Python 3, standard library only)
  src/index.html        the page template, with {{placeholders}}
  index.html            GENERATED; do not edit by hand
  assets/site.css       styles (dark default, light via system setting or the toggle)
  assets/site.js        theme toggle, copy buttons, pricing controls, scroll reveals
  assets/fonts/         Archivo (display, OFL), Geist and Geist Mono (OFL)
  assets/img/           dashboard and phone screenshots (dark + light; mission-m-* are the hero's phone crops) and og.jpg,
                        captured from the web mock (fictional team Kestrel)
```

## Build and preview

```bash
python3 site/build.py                        # writes site/index.html
python3 -m http.server 8000 --directory site  # open http://127.0.0.1:8000
```

Commit the regenerated `index.html` with any template change; the site deploys as plain files.

## Renaming the product

Change one line in `site/brand.json` and rebuild:

```json
"name": "Sqwakie",
```

Everything else follows from it:

| Placeholder | Comes from | Used for |
|---|---|---|
| `{{name}}` | `name` | title, meta tags, nav, footer, body copy |
| `{{cli}}` | `name` lowercased (override with `"cli": "..."`) | every terminal snippet, MCP tool names (`{{cli}}_post`) |
| `{{repo}}` | `github_owner` + `/` + `{{cli}}` (override with `"repo": "owner/name"`) | install URL, GitHub links |
| `{{install}}` | `{{repo}}` | the `curl ... install.sh \| sh` one-liner and its copy button |
| `{{tagline}}` | `tagline` | the hero headline, page title, footer |

The tagline is a pun on the current name ("A walkie-talkie for..."), so update it in the same file when you rename.

`build.py` refuses to build if the name or CLI command appears as a word in `src/index.html`, `assets/*.css` or
`assets/*.js`, so it can't creep back into the templates. If a new name is also an ordinary word used in the copy,
reword that copy or narrow the guard in `build.py`.

Before deploying, set `"site_url"` (for example `"https://example.com"`) so `og:image`, `og:url` and the canonical
link are absolute; social previews need absolute image URLs.

## Pages

`src/index.html` renders `index.html` (landing page with `#pricing`) and `src/welcome.html` renders `welcome.html`
(the post-checkout page, `/welcome?session_id=…`, which fetches `/api/license` and shows the activation code, once,
and the `<cli> license activate <code>` command). `assets/welcome.js` drives its states: loading, processing (409,
retried 6 times), ready, already shown or link expired (410), billing not configured (503), inactive (402) and error.

## Billing functions (Vercel, Node runtime)

`api/*.ts` are Vercel functions using the Web-standard signature (`export async function GET(req: Request)`).
Shared code lives in `api/_lib/` (the underscore keeps Vercel from serving or deploying it as a function). Each
handler also exports a `make*` factory taking `{ env, stripe, now }`, which the tests in `test/` call with a mocked
Stripe client. Stripe is the only store, in the subscription's metadata: `walkie_code_revealed_at` (when the
welcome page showed the code), `walkie_team` (the bound team id) and `walkie_renew_hash` (sha256 of the renewal
token; the token itself is never stored). No license key is stored.

| Route | Does |
|---|---|
| `GET /api/checkout?plan=team\|business&interval=month\|year&seats=N` | Stripe Checkout subscription, quantity = seats (Team 1..50, Business 1..10000), 303 to it |
| `POST /api/webhook` | verifies `Stripe-Signature` on the raw body; issues nothing; on subscription events clears license keys older versions stored in metadata |
| `GET /api/license?session_id=cs_…` | `{code, plan, seats, interval, expires_at}`: the activation code, once, within 24 h of checkout, `active` subscriptions only; then `410 already_revealed` / `reveal_expired` |
| `POST /api/license/bind` `{code, team_id}` | binds the code's subscription (`active`) to the team → `{key, renewal_token}` on the first bind, `{key}` for the same team again, `409 license_bound_elsewhere` for another team |
| `POST /api/license/renew` `{lic_id, renewal_token}` | token hash matches (constant time) and subscription `active` → `{key}` for the bound team; wrong token or unknown subscription `403 invalid_renewal`; not active `402` |
| `GET /api/portal` | 303 to `STRIPE_PORTAL_LOGIN_URL` (Stripe's email-verified login) whatever the query; `503 billing_not_configured` when unset |
| `POST /api/license/status` | `{lic_id, renewal_token, issued_at?}` → `{seats, plan, interval, expires_at, status, newer}`; the authority's daily check-in (`newer` = `walkie_refresh_at`, set by the webhook on a seat/price change, is later than `issued_at`); same 403 as renew for a wrong token or an unbound subscription |
| `GET /api/checkout?…&lic_id=sub_…` | with a `lic_id` whose subscription still bills (active, trialing, past_due, paused): `409 already_subscribed {portal, lic_id, status}` instead of a second subscription; fails closed (502) if Stripe can't be asked |

Plan and interval come from the price's lookup key (`walkie_<team|business>_<month|year>`), then the price's
`metadata.plan` and `recurring.interval`, then the subscription's `walkie_plan`/`walkie_interval` metadata, then the
configured price ids. A license expires at the Stripe period end plus 5 days (unix ms).

Env vars (names only; set them in Vercel). A handler whose vars are missing answers `503
{"error":"billing_not_configured"}`, and checkout shows a friendly page to browsers:

- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_TEAM_MONTH`, `STRIPE_PRICE_TEAM_YEAR`, `STRIPE_PRICE_BUSINESS_MONTH`, `STRIPE_PRICE_BUSINESS_YEAR`
- `WALKIE_LICENSE_SIGNING_KEY` (ed25519 PKCS8 PEM; `\n`-escaped newlines are accepted)
- `STRIPE_PORTAL_LOGIN_URL` (Stripe's hosted portal login link; it carries the portal configuration chosen in the
  Stripe dashboard; without it `/api/portal` is 503)
- optional: `SITE_URL` (redirect origin; defaults to the request's)

```bash
cd site && bun install && bunx tsc --noEmit -p .   # typecheck
bun test site                                       # from the repo root
```

## Rental compute functions (RENT-2)

`api/compute/*.ts` are the control plane for rented machines (docs/plans/RENT-1.md). The code is in
`api/_lib/compute/`: a provider-neutral driver interface (`driver.ts`) with FakeCloud (tests, demo) and DigitalOcean
(`digitalocean.ts`), a store interface with Neon Postgres (`pg-store.ts`, `migrations.ts`) and in-memory
implementations, the minute tick (`tick.ts`) and the cloud-init user-data (`cloud-init.ts`). **Customers only ever
see prices**: the public catalogue is `catalog.ts`; provider, size, region, image, our cost and our provider limits
come only from the private env var `COMPUTE_PRIVATE_CONFIG` (`private-config.ts` documents the shape).

**Modes.** Since v0.2.0-pre.17 the code lock is on (`release-gate.ts`; pre.10 to pre.16 shipped it off and every
route answered 503). The deployment's environment decides the mode (`handler.ts`):

- **Fully off:** no `COMPUTE_PRIVATE_CONFIG`, or no `DATABASE_URL`. Quotes show the catalogue as unavailable, the
  tick answers an empty report, every other route answers `503 compute_not_configured`, and nothing opens the store.
  This strands running machines, so use it only with no active rental. (A config that is set but does not parse is
  also fully off, but its tick answers `500 config_invalid` and pages.)
- **Drained** (the rollback lever): the config and the store are set and `COMPUTE_ENABLED` is unset (any value but
  `1`). New rentals, starts and credit purchases refuse, and quotes say `"available":false`. State, stop,
  heartbeats, the lease read, account and handover requests, the Stripe webhook, the watchdog heartbeat and the minute
  tick (metering, stops, deletes, reconcile, freeze-hold and alert retries) keep working.
- **Enabled:** `COMPUTE_ENABLED=1`.

**The switch-on and its order are in `docs/COMPUTE-GOLIVE.md`.**

**Licence binds need the store once lock-ON code runs, drained or enabled.** A missing store, or one behind the latest
migration, answers 503 `licence_store_required` and pages `licence_store_missing`. Never remove `DATABASE_URL` from
production after the lock-ON deploy, and never point it at an unmigrated database. Roll back by draining, or by
removing `COMPUTE_PRIVATE_CONFIG` only, and only when no rental is active.

| Route | Auth | Does |
|---|---|---|
| `GET /api/compute/quotes` | none | the tiers on sale with prices (a tier whose quota is 0 is left out), credit blocks, billing terms; `available` |
| `POST /api/compute/account` `{team_id, proof}` | none (10/IP/h) | `201 {account_id, token}`; the token is shown once, only its sha256 is kept |
| `GET /api/compute/state` | `Bearer <token>` | balance, burn per hour, hours left, rentals |
| `POST /api/compute/credit` `{block: 50\|200\|1000}` | Bearer, `COMPUTE_ENABLED=1` | `{url}`: Stripe Checkout (mode=payment) for prepaid credit; 403 for a frozen account or one under review |
| `POST /api/compute/rent` | Bearer, `COMPUTE_ENABLED=1` | `{idempotency_key, machines, codes, walkie_version, idle_minutes?}`: reserved for the tick or queued. `402 insufficient_credit` (with `expiring_micros`, the credit left out because it expires within the hour) when credit unexpired through the whole first hour doesn't cover every machine's first hour, checked again after the request's locks; `429 compute_busy` with `retry_after_s` 5 (nothing recorded, not kept by the daemon: send it again) when a lock wait passes 1.5 s; `409 tier_unavailable` for a tier off sale; `400 unsupported_walkie_version` for a release not in `releases.ts` |
| `POST /api/compute/start` `{rental_id, code}` | Bearer, `COMPUTE_ENABLED=1` | a fresh join code for a rental waiting in `needs_code` |
| `POST /api/compute/stop` `{rental_id}\|{all:true}` | Bearer | terminate and wipe, in every mode but fully off |
| `POST /api/compute/heartbeat` | the rental's own token | liveness and load from the rented machine, once a minute |
| `POST /api/compute/lease` `{rental_id}` | the rental's own token | the machine's paid lease (it powers itself off 15 minutes after the last one) |
| `GET /api/compute/tick` | `Bearer $CRON_SECRET` | the minute loop: metering, stops, queue, orphan reconcile, retries |
| `POST /api/compute/webhook` | Stripe signature | credits a paid block once per session; a dispute, refund or early fraud warning freezes the account |
| `POST /api/compute/watchdog-heartbeat` | HMAC (`x-walkie-signature`) | the independent watchdog's signed report |
| `POST /api/compute/handover` | owner proof, or `Bearer $COMPUTE_HANDOVER_OPERATOR_SECRET` for decisions (status: 12 per owner per hour under a 240/IP/h ceiling; other actions 10/IP/h) | authority handover status, acknowledgement, objection and the operator's decisions (docs/COMPUTE-HANDOVER.md) |
| `POST /api/compute/licence-backfill` `{restart?}` | `Bearer $COMPUTE_HANDOVER_OPERATOR_SECRET` (60/h) | the one-time licence backfill ("Licence record" below) |

Env vars (names only; values live in Vercel and in `~/keys`):

- **The mode:**
  - `COMPUTE_ENABLED=1` (admissions on);
  - `COMPUTE_PRIVATE_CONFIG` (JSON);
  - `DATABASE_URL` (Neon through the Vercel Marketplace, on a paid plan: the minute cron keeps it awake). Apply the
    migrations **before** the lock-ON site is deployed (`PgStore.connect(url).migrate()`, including migration 5's
    first-funded marker and backfill, and migration 7's credit lots: `compute_ledger.lot`, the `expire` kind and two
    indexes; the command is in docs/COMPUTE-GOLIVE.md step b). Without migration 7 the tick and the webhook fail
    closed on the missing `lot` column, and licence binds refuse the store.
- **The licence key:** `STRIPE_SECRET_KEY`, separate from compute's Stripe key. Wherever compute runs, preview
  included: without it every first compute enrollment answers 503 `license_verification_unavailable`.
- **The compute Stripe key:** `COMPUTE_STRIPE_SECRET_KEY`.
  - It must be `sk_test_…`/`rk_test_…` unless `COMPUTE_STRIPE_LIVE=1`.
  - A restricted key needs **Charges: read** (charge-only freezes and the tick's retry) and **Checkout Sessions:
    write**.
  - Also `COMPUTE_STRIPE_WEBHOOK_SECRET`, the signing secret of the compute webhook endpoint.
- **Handover:** `COMPUTE_HANDOVER_TOKEN_KEY` (at least 32 characters; set it first, and keep it while any hold is
  open: every compute route and every bind with a store needs it), then `COMPUTE_HANDOVER_OPERATOR_SECRET` (at least
  32 characters).
- **The cron and the provider:** `CRON_SECRET` (the cron's bearer), `DIGITALOCEAN_TOKEN` (the site's provider token;
  scopes in SECURITY.md).
- **The watchdog:** `COMPUTE_WATCHDOG_HMAC_SECRET`, the same value as on the watchdog host.
- **Alerts:** `COMPUTE_ALERT_TELEGRAM_TOKEN`, `COMPUTE_ALERT_TELEGRAM_CHAT` (a Telegram group), and
  `COMPUTE_ALERT_SPEND_USD_PER_DAY` (positive USD, default 50; production uses 20; an invalid value alerts and falls
  back to 50).
- `SITE_URL` (the origin machines install from and heartbeat to; default https://sqwakie.si).
- **Demo and preview only:** `COMPUTE_ALLOW_FAKE=1` (FakeCloud may back tiers). Never in production.
- **Previews:** with the config and a database but no handover key, previews answer 503
  `handover_token_key_unavailable`. A preview must not share production's database.

**The tick.** The minute cron is registered in `site/vercel.json`: `/api/compute/tick` every minute. The tick function
has `maxDuration` 60 (the webhook 15, every other function 10).
- The tick stops taking new launch claims after 40 seconds.
- Admissions require a successful tick in the last three minutes. A stale tick appears in owner state as
  `tick_stale`, logs `alert_tick_stale`, and makes quotes unavailable.
- The first healthy tick after an outage renews paid leases and processes cleanup; a later healthy tick can launch.
- An idle drained tick still records `last_tick`. Once any rental has existed, it also reconciles orphans and drains
  cleanup.
- **A busy account waits alone.** Every pass of the minute tick that needs an account's row waits at most 2 seconds for
  it (or one call budget, if shorter), with its statements bounded the same way. A busy account is skipped by every
  later pass of that tick without waiting again, so the tick, `last_tick` and every other team go on.
  - The log names it: `compute_account_busy` (billing), `credit_expiry_busy` (the expiry sweep).
  - While busy:
    - its machines are not billed that minute (they are metered from the minute count on the next free pass);
    - its expired leases are deferred (`lease_expiry_deferred`) and stopped on the next free pass. They are billed
      only to the lease's end, whichever path ends them first (the owner's stop or a watchdog deletion meanwhile); the
      provider time after it is operator-funded, booked on the rental, with an `operator_funded` alert when it ends;
    - its machines being stopped are still deleted at the provider (only the record waits);
    - its queued machines lose their turn to other teams, and its launches wait.
  - Three busy passes in a row raise the Telegram alert `account_busy`, and again every 60 passes while it lasts.
  - **All busy:** if two or more active accounts are all busy at once (a site-wide lock: an open
    `UPDATE compute_accounts`, a migration, a lock queue behind `ACCESS EXCLUSIVE`), the tick records no healthy pass
    and `tick_stale` fires.
  - **What holds a row:** one long transaction on that account (find it in `pg_stat_activity` and end it), or a flood
    of short requests from that account (heartbeats, rent, start, stop: look at the function log's request rate for
    that account). `GET /api/compute/state` takes no row lock.
  - **End a long transaction within about 15 minutes.** An account's paid lease is 15 minutes, and only a free pass
    renews it. After that the account's machines stop at their lease, power off and are deleted by the watchdog
    (20 minutes after their paid tag), billed only to the lease's end. The provider time after it is operator-funded:
    booked on the rental, with an `operator_funded` alert for each machine when it ends.
  - **A refused rent:** A rent that waits more than 1.5 s for a lock answers **429** `compute_busy` with `retry_after_s` 5 and records nothing; the daemon does not keep it, so the person (or agent) sends it again. A rent refused 503 `compute_tick_stale` or `compute_not_configured` recorded nothing either and is not kept. Any other failure (a 5xx without one of those codes, a timeout, a lost answer) is kept and sent again automatically with the same key, and so is a resend after a lost answer whatever it is refused with (the site may have recorded the first send); the answer then says only "the request is kept and will be sent again automatically; don't rent again".
  - At most 50 expired blocks are written off per account per tick; the rest are already unusable to every read and
    are written off on later ticks.
- An entirely stopped cron with no requests needs an external uptime check (docs/COMPUTE-GOLIVE.md step h).

**Changing `COMPUTE_PRIVATE_CONFIG`.** Validate the new value locally before saving it in Vercel. From `site/`:

```sh
bun -e 'import("./api/_lib/compute/private-config.ts").then(m => { m.parsePrivateConfig(require("fs").readFileSync(process.argv[1], "utf8")); console.log("ok") })' new-config.json
```

- A valid value prints `ok` and exits 0. An invalid one throws `ConfigError`, whose message never includes a value,
  and exits 1.
- A value that is set but invalid turns compute fully off: stop and state answer 503, and nothing is metered or
  deleted. The minute tick then answers `500 config_invalid` (Vercel's cron log shows failures), and Telegram
  receives `config_invalid`.
- Never remove the variable, or set it invalid, while any rental is active.
- Keep the GPU quota at 0 until DigitalOcean grants GPU capacity. Keep the CPU quota at most DigitalOcean's droplet
  limit minus the account's other droplets: above that, each rental costs up to 6 refused creates and about 31
  minutes before it ends unbilled.

**Enrollment.** Customers require no operator enrollment: the first account request includes the signed roster
genesis and its signed authority-transfer chain. The site derives the team ID from genesis and requires the account
key to be the chain's current authority. The key signs `walkie-compute-account-v1\n<team>\n<expiry-ms>` (at most five
minutes ahead). Enrolled teams automatically become customers; **real providers still require live paid compute
credit**. A team's roster authority must run pre.17 or later to rent: older daemons never offer Add compute.

**Licences and the first enrollment.**
- The authority daemon attaches `lic_id` and `renewal_token` when it holds the matching licence and renewal token.
  The site verifies an active subscription, token hash, bound `walkie_team` and bound roster authority using
  `STRIPE_SECRET_KEY`. Tokens are never persisted or logged by compute.
- A team's **first** compute enrollment is admitted only for its licence's authority when the team has a live
  licence: the presenter holds the licence's renewal credentials, or is the authority key the licence names. Anyone
  else is refused before any account token exists and raises `enrollment_licence_refused`. A Free team (no live
  licence) is enrolled by its first valid presenter (trust on first use).
- A newer signed authority chain changes the enrolled key automatically only for unfunded teams. For a funded or held
  compute account, or an open checkout, the new authority enters a 24-hour hold and needs explicit operator approval
  of its `chain_id` and `proposed_key` (docs/COMPUTE-HANDOVER.md).
- Owner acknowledgements inform the operator but cannot complete the change. An eligible owner's objection blocks
  approval unless the operator uses the logged and alerted `override_objection` action.
- Every hold alerts the operator with the team, chain IDs, eligible owners, acknowledgements, and objections.
- An unacknowledged hold expires after 72 hours and alerts the operator. A late approval cannot revive it, and its
  digest and proposed key cannot reopen it until the operator uses `clear_rejection` naming a new proposal's
  `chain_id` and `proposed_key` (or `lift_expired` for that one expired proposal).
- A valid genesis recovers a legacy trust-on-first-use squat automatically only while the account is unfunded. A
  funded, held or checkout-pending account whose enrollment has no stored chain (or whose chain a licence bind already
  advanced) is never adopted automatically: the site alerts the operator.
- A `team_authorities` pin lets the pinned key open a hold; the operator must then approve that exact proposal before
  the account moves.
- Concurrent enrollments are serialized. While an authority fork is open, that team's licence renewals and
  re-activations pause (409 `authority_fork_open`) until the operator's `resolve_fork`.

**Licence record.** The site keeps its own record of which licences are bound to each team
(`licence-bindings:<team>` in `compute_control`). Every licence bind writes it, and the one-time operator backfill
(`/api/compute/licence-backfill`) writes it once for licences bound before the store existed.
- **Until the backfill completes,** every first enrollment answers 503 `licence_backfill_pending`.
- **Running the backfill:** run exactly **one** loop, from one place. The loop and what each answer means are in
  docs/COMPUTE-GOLIVE.md step e. In short:
  - `409 licence_backfill_busy` or `"superseded": true`: wait 15 s and call once; busy again means another loop
    really runs.
  - A 504 or anything that is not JSON: the call was cut off. Wait 15 s, then call once.
  - `429 rate_limited`: 60 real calls were made this hour; busy answers are free. Wait out the hour.
  - `503 licence_backfill_unavailable`: safe to retry.
- **The completion marker** (`complete_at` in `licence-bindings-backfill`) is monotonic.
  - A `{"restart": true}` re-scan never closes the gate. Later plain calls continue it until it completes.
  - Only one call runs at a time: a lease that lasts 15 s after its last page write, on the application clock.
- **Re-scan after a rollback or a restore.** A Vercel rollback to (or a redeploy of) a locked build that served binds,
  or a Neon point-in-time or branch restore, leaves the marker set with records missing. Run the re-scan (the loop
  with `{"restart": true}` first). To keep first enrollments closed while it runs, remove the marker first, under its
  lock:

  ```sql
  BEGIN;
  SELECT pg_advisory_xact_lock(hashtextextended('licence-bindings-backfill', 0));
  UPDATE compute_control SET value = value - 'complete_at' WHERE key = 'licence-bindings-backfill';
  COMMIT;
  ```

- **Pruning.** A team whose record holds more than 50 ids is pruned in batches of 50 direct reads under the team lock.
  Only ids whose read shows a final status (`canceled`, `incomplete_expired`) are dropped. Each attempt answers a
  retryable 503 `licence_record_pruning` (the customer presses "Add compute" again; 150 ended ids take 3 attempts).
- **`enrollment_licence_refused`** (a foreign subscription carries the team's id, for example a griefer's proofless
  bind on a Free team):
  1. Open the `enrollment-licence-refused:<team>` row.
  2. Search Stripe for `metadata['walkie_team']:'<team>'`.
  3. Delete `walkie_team` from the foreign subscription.
  4. The founder retries.
- **`licence_bindings_overflow`** has three causes:
  - The record was marked overflowed (more than 200 ids). Have the customer reduce or merge subscriptions, then trim.
  - Pruning found more than 50 not-final licences after a full pass. Check the team's subscriptions in Stripe, remove
    `walkie_team` from foreign ones, then trim.
  - Stripe's search reports more than 50 live ones. Remove `walkie_team` from the foreign subscriptions.

  The trim keeps every other id, including one a concurrent bind just recorded. It must take the team lock:

  ```sql
  BEGIN;
  SELECT pg_advisory_xact_lock(hashtextextended('enrollment-chain:<team>', 0));
  UPDATE compute_control SET value = jsonb_build_object('subscriptions', (
    SELECT coalesce(jsonb_agg(DISTINCT id ORDER BY id), '[]'::jsonb) FROM (
      SELECT jsonb_array_elements_text(value->'subscriptions') AS id UNION SELECT unnest(ARRAY['sub_live1']::text[])) ids
    WHERE id <> ALL (ARRAY['sub_ended1','sub_ended2']::text[])))
  WHERE key = 'licence-bindings:<team>';
  COMMIT;
  ```

- **An accepted residual:** a team with more than 200 separate live paid subscriptions fails closed at its first
  enrollment until the operator reduces them and trims the record.

**Private config overrides.** Private JSON fields remain operator overrides:
- `team_authorities` pins team IDs to keys and takes precedence over durable enrollment;
- `customer_teams` explicitly classifies legacy verified customers;
- `internal_teams` always wins, including over automatic or explicit customer classification, and can never launch a
  real provider. Keep our own and all test teams in `internal_teams`; the live proof uses a team outside it.

Admission, queue promotion, tick and launch recheck current enrollment, so replaced keys lose real-provider
eligibility, including existing accounts. Unknown keys and unverified legacy accounts cannot launch real machines.

**Stripe.** Point the live compute webhook at `/api/compute/webhook`, on API version `2026-08-26.dahlia` (the client's
pinned version), for these 5 events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`charge.dispute.created`, `charge.refunded` and `radar.early_fraud_warning.created`.
- Freezes are persisted by payment intent even before a purchase arrives.
- An event without a payment intent is resolved through its charge.
- One that cannot be resolved is held in `compute-freeze-hold:<charge>`, alerted (`freeze_unresolved`) and refused
  with a 503, so Stripe redelivers it.
- A paid compute checkout that fails validation is held in `compute-credit-hold:<session>` and alerted
  (`credit_ignored`).
- The minute tick also retries pending holds: at most 5 Stripe charge reads per tick, oldest attempt first, through
  the same freeze path. This covers drain mode too, and continues after Stripe stops redelivering (about 3 days).
  Without an allowed `COMPUTE_STRIPE_SECRET_KEY` the tick does not retry. Each failed retry bumps `attempts` and
  re-raises `freeze_unresolved` at most every 30 minutes per charge, so a hold whose charge the key can never read
  re-alerts every 30 minutes until it is handled.

**Operator runbook (holds):**

```sql
-- Freezes not yet applied: pending = Stripe could not answer, or the event named no charge at all (key = event id);
-- unmatched = the charge has no PaymentIntent
SELECT key, value FROM compute_control WHERE key LIKE 'compute-freeze-hold:%' AND value->>'state' IN ('pending','unmatched');
-- Paid compute checkouts that were not credited and are not handled yet
SELECT key, value FROM compute_control WHERE key LIKE 'compute-credit-hold:%' AND value->>'state' = 'held';
```

- **A pending freeze.**
  - **Preferred:** fix the compute Stripe key, or wait for Stripe to recover. Stripe's redelivery or the tick's retry
    then applies the freeze through the normal path. The event can also be resent from the Stripe dashboard.
  - **Last resort, by hand (freeze direction only):**
    1. Find the charge's payment intent in the Stripe dashboard.
    2. Set `compute_accounts.status = 'frozen'` for the account whose ledger purchase has `ref = <pi>`.
    3. If that purchase has not arrived yet, also write `compute_control` key `payment:<pi>`, value
       `{"frozen": true, "event": "<event type>"}`.
    4. Mark the hold handled, or the tick keeps retrying it:
       `UPDATE compute_control SET value = value || jsonb_build_object('state', 'resolved', 'payment_intent', '<pi>') WHERE key = 'compute-freeze-hold:<charge>';`
  - A hold keyed by an event id (reason `no_reference`) cannot be resolved by redelivery: freeze it by hand as above.
  - A stderr line `compute freeze_retry_failed` means the tick's retry hit its deadline or a store error. The hold is
    unchanged and retried next tick.
  - **Before switching the compute key from test to live,** resolve or delete every pending test-mode hold
    (`value->>'livemode' = 'false'`). The live key would read their test charges forever.
- **A held checkout (state `held`):**
  - The only recovery is a refund in Stripe. **Do not insert a purchase row by hand.**
  - The refund's `charge.refunded` marks the hold `refunded`.
  - A dispute or early fraud warning on a held checkout keeps it `held` and still raises `account_frozen` with no
    account: respond in Stripe.

**Billing.** Each rental reserves its first hour under the account lock (covering the GPU minimum). Outstanding
reservations reduce every admission check. Only live paid credit pays real-provider charges; FakeCloud consumes other
credit first.
- **Shutdown and debt policy** (`billing.ts`):
  - A machine is metered for every started minute until the provider confirms its deletion, whatever stopped it.
  - The customer pays those minutes, and egress beyond the allowance, out of credit only: a balance never goes below
    zero.
  - Two parts are operator-funded and booked on the rental (`safety.unpaid_micros`, `safety.unpaid_egress_micros`)
    with an `operator_funded` alert. One is the time after a paid lease expired unrenewed (our tick outage). The other
    is whatever the covering credit cannot pay.
  - The bounds: at $0 the tick stops every machine of the account, and the watchdog deletes a droplet 20 minutes after
    its paid tag.
- **Prepaid credit is non-refundable and expires 60 days after purchase.**
  - Each purchase is a separate block (a credit lot: a positive `purchase` or `adjustment` ledger row, expiring at its
    `created_at` + 60 × 24 h). The block that expires soonest is spent first.
  - The minute tick writes an expired remainder off, one `expire` ledger row per block (`expire:<lot>:1`). Reads
    (state, rent, start, the queue, the lease) count only unexpired credit, even before the tick runs.
  - **The first-hour rule.** A rent (or a queued machine's start) needs its first hour covered by credit unexpired for
    that whole hour; otherwise 402 `insufficient_credit` with `expiring_micros`. Every billing pass reconciles waiting
    rentals: a queued or `needs_code` machine whose first hour is no longer covered by credit that lasts through it
    ends `no_credit`, which can happen up to an hour before the block it relied on expires.
  - A running machine whose credit expires with no other credit to cover it stops like out-of-credit (on the lease
    rules until the expiry itself).
  - Customers see remaining amounts and expiry dates with `walkie compute credit` or in the dashboard (Add compute);
    blocks expiring within 7 days are highlighted. While rentals are unavailable (drained, a stale tick, nothing on
    sale), owners with credit see it under **Compute credit** in the dashboard, with every block's expiry, read-only.
  - Credit keeps expiring while an account is frozen, and while rentals are drained or unavailable (the
    coordinator's default; Alex can change it). An operator who lifts a freeze after an expiry re-credits by hand.
  - **Re-crediting by hand** means inserting an `adjustment` row, under the account lock that every code writer
    holds (the credit reads are separate statements, so an unlocked insert could land between them). It is a new
    block that expires 60 days after its `created_at`. Set `live` true only to restore credit the customer paid for:
    the paid bucket (`live` rows) is the only credit real providers spend, and Alex's rule is that real machines run
    only on paid credit. Never insert a `purchase` row by hand.

    ```sql
    BEGIN;
    SELECT 1 FROM compute_accounts WHERE id = '<ca_…>' FOR UPDATE;
    INSERT INTO compute_ledger (account_id, kind, amount_micros, idem_key, live, created_at)
      VALUES ('<ca_…>', 'adjustment', <micros>, 'operator:<reason>:<date>', true, (extract(epoch FROM now()) * 1000)::bigint);
    COMMIT;
    ```

  - An account's blocks and what each has left:

    ```sql
    SELECT l.idem_key AS lot, l.live, l.amount_micros, l.created_at, l.created_at + 5184000000 AS expires_at,
      l.amount_micros + COALESCE((SELECT SUM(x.amount_micros) FROM compute_ledger x WHERE x.lot = l.idem_key), 0) AS left_micros
    FROM compute_ledger l WHERE l.account_id = '<ca_…>' AND l.kind IN ('purchase', 'adjustment') AND l.amount_micros > 0
    ORDER BY l.created_at;
    ```

- **Boot-failure credit** (`refundBoot`, `billing.ts`): only the charge for the **first 15 minutes** of a failed boot
  is credited back.
  - **What qualifies:** the rental ended `boot_timeout` (no heartbeat within 15 minutes of the provider start, or the
    machine's own `bootstrap_failed` report before any heartbeat), and it never heartbeated and never joined (no
    `node_id`).
  - **When:** once the provider confirms the deletion.
  - **The cap:** at most 3 per team in a rolling 24 hours. Later failures stay charged and log
    `alert_boot_refund_capped`.
  - **What stays billed:** minutes after the first 15, including the deletion time.
  - **Where it goes:** back to the blocks the rental's first-15-minute charges came from (soonest-expiring first),
    with their expiry. A refund into an already-expired block is written off.
- **Deletion correction (a billing correction, not a refund policy):** when the provider deleted a machine earlier than
  our metering (the watchdog reports the real deletion time), the minutes billed after it are credited back
  (`watchdog-refund:` rows, `reconcileDeletion`), latest-expiring block first, and the operator-funded amount is
  recomputed.
- Stopping machines remain metered until provider-confirmed deletion, with backoff and owner-visible escalation.

**Providers and cleanup.**
- Keep driver credentials for every recorded provider until all claims are resolved.
- Uncertain creates are reconciled using durable rental/provider claims and are never blindly retried. A capacity
  refusal is retried after 1, 2, 4, 8 and 16 minutes, then the rental ends unbilled.
- Unknown machines receive a two-minute observation grace before cleanup, and a failed orphan deletion does not block
  later orphans. The listing must be complete: a page without `meta.total`, or a total that disagrees, rejects the
  whole listing. A rental the listing omits ends only after a definite 404 for it.
- User-data contains a public 1000 Mbit/s fair-use rate, not the private provider limit.
- Metadata firewall prerequisites, installation and verification are mandatory before joining; the user manager
  requires restoration after reboot.
- A droplet the provider lost while its listing call fails keeps billing until the heartbeat-lost stop.

**The watchdog** (the independent expiry; setup in docs/COMPUTE-GOLIVE.md step g):
- `scripts/compute-watchdog.ts --apply` runs every five minutes on an operator Mac from
  `scripts/launchd/dev.walkie.compute-watchdog.plist`.
  - Placeholders: checkout, token file, site origin, HMAC secret, log directory.
  - `COMPUTE_WATCHDOG_TOKEN_FILE` is a 0600 file holding a **separate** DigitalOcean token (`droplet:read`,
    `droplet:delete` and the read dependencies in SECURITY.md).
  - `COMPUTE_WATCHDOG_HMAC_SECRET` is the same value as on Vercel, and `COMPUTE_SITE_ORIGIN=https://sqwakie.si`.
- The hourly backstop is `.github/workflows/compute-watchdog.yml`. It runs from the default branch only, with secrets
  `COMPUTE_WATCHDOG_TOKEN` and `COMPUTE_WATCHDOG_HMAC_SECRET` and variable `COMPUTE_SITE_ORIGIN`.
- Each run sends a signed heartbeat. The tick alerts `watchdog_stale` once per UTC day while the heartbeat is missing
  or more than 20 minutes old, and at once for a new stale episode. An idle drain (nothing active, no cleanup) skips
  that check.

**Operational alerts** go only to the operator's Telegram chat (a group) through Bot API `sendMessage`.
- **What they cover:**
  - stale and recovered ticks;
  - delayed stop/delete escalation (three failed attempts);
  - orphan discovery and termination or failure;
  - uncertain creates;
  - mining/abuse and egress-cap stops;
  - dispute, refund and fraud freezes, and held checkouts;
  - operator-funded time and capped boot refunds;
  - invalid configuration;
  - unavailable providers;
  - daily provider spend;
  - handover holds, forks and licence gates;
  - an account whose row stays busy (`account_busy`, after 3 busy passes in a row);
  - the CPU alerts.
- **Only allowlisted fields reach Telegram:** team/account/rental IDs, hashed instance references, fixed event names,
  timestamps and operational cost figures. No customer secrets, renewal tokens, team tokens or provider response text
  are sent.
- **Confirmed alerts** are queued until Telegram accepts them, including while the Telegram token or chat is not
  configured.
  - Money and abuse: `credit_ignored`, `operator_funded`, `boot_refund_capped`, `account_frozen`, `freeze_unresolved`,
    `lease_expired`, `mining_stop`, `egress_cap_stop`, `licence_read_failed`.
  - A team waiting on the operator: `authority_fork`, `handover_operator_review`, `handover_objection`,
    `handover_acknowledged`, `handover_no_independent_owner`, `handover_expired`, `licence_bindings_overflow`.
  - An undelivered one waits in its own dedupe claim row, `alert:<digest>`, as an object (a delivered one holds its
    delivery time, a number). Nothing is dropped and there is no cap.
  - **Retries per tick:** each tick sends up to 10 due alerts, money and abuse first and oldest first within each
    class. Team-waiting alerts fill any slots money leaves free, and up to 3 more team-waiting alerts go on top: at
    most 13 queued retries per tick. Each alert backs off 1, 2, 4 … up to 30 minutes. Once delivered, the same alert
    is not repeated within 30 minutes.
- **Every other alert** is sent at most once per 30 minutes, through a durable rolling claim per alert key across
  serverless instances. A failed send of those is not retried; the next raise after 30 minutes is. Without Telegram
  configured, those are not sent or kept.
- **In-memory alerts:** while compute is drained, the licence bind's `authority_fork`, `handover_rejected_refusal` and
  `handover_operator_review` alerts, and `compute_state_unavailable` and `licence_store_missing`, are deduplicated in
  the function instance's memory. A failed send is retried by the next raise, at least a minute later. This path is
  not durable; keep the Vercel log alerting as the backstop.
- **The held-checkout sweep:** a held checkout whose alert never went out is raised again by the tick 30 minutes
  after it was held (up to 5 per tick), and marked `alerted_at` once delivered.
- **The send picture per tick:**
  - up to 10 money-class retries plus 3 team-waiting retries;
  - up to 5 more from the held-credit sweep;
  - fresh incident alerts on top (a DigitalOcean outage raises `provider_unavailable` per rental).

  During an incident a Telegram group's limit of 20 messages per minute can be exceeded. Confirmed alerts are then
  delayed and retried, not lost; other alerts are suppressed for 30 minutes and raised again while their condition
  holds. A private chat's guidance is about one message a second, so use a group.
- **Long messages:** a handover alert whose owner list is too long for one Telegram message (4,096 characters, about
  90 owners) is sent with as many owners as fit and `+N more`. The stderr log line keeps the full list.
- **Undelivered alerts:**
  `SELECT key, value FROM compute_control WHERE starts_with(key, 'alert:') AND jsonb_typeof(value) = 'object'`.
  None means everything was delivered.
- Delivery runs after the operation's transactions, is awaited before returning, times out after three seconds,
  refuses redirects, and never throws into billing.

**The CPU alerts** (both alert only: nothing is stopped, put under review or billed differently; both carry
`{rental, team, account}`):

| Alert | Fires when | Repeats at most |
|---|---|---|
| `cpu_pegged` | CPU at or above 90% **and** no agent work (no busy seat, no pool job) on every heartbeat for **10 minutes** | every 30 minutes per rental |
| `cpu_pegged_long` | CPU at or above 90% on every heartbeat for **60 minutes, whatever the agent work** | every 6 hours per rental |

- **`cpu_pegged`:** nothing agent-run is using the machine, yet its CPU is pinned. If it looks like mining (the
  DigitalOcean AUP forbids it, and so do the terms), stop the rental, set the account's review by hand, and handle
  the account under the terms.
- **`cpu_pegged_long`:** a legitimate long job (a large build, a test suite, a model or data job) triggers it too.
  Check what the team's agents ran on that machine in the last hour. An unexplained hour, or one task running an
  unknown binary for its whole duration, is the mining pattern.
- **Limits:**
  - Both are guest-reported: a tampered guest can under-report `cpu_pct`.
  - A miner that throttles itself under 90% is not seen.
  - A miner started inside a seat task by a team agent is seen only by `cpu_pegged_long`, after 60 minutes.
  - Provider-side metrics would need a DigitalOcean token with `monitoring:read`, and would not tell a miner from a
    build either.
- The GPU mining rule is separate: a GPU at 95% or more with no busy seat and no pool job for 10 minutes stops the
  machine and puts the account under review.

**Daily spend alerts** estimate UTC-day accrued compute cost from all recorded real-provider rental lifetimes,
including ended and uncertain creates.
- New rentals snapshot the private hourly cost; older rentals use the configured rate.
- The estimate excludes FakeCloud, untracked orphan costs and provider invoice extras (tax, storage, **bandwidth**,
  minimum billing adjustments); it is not invoice reconciliation.
- The tick checks the threshold once each pass. A DigitalOcean billing alert is the only tripwire for bandwidth.

## Screenshots

The images are the real dashboard and phone view with the web mock's fictional team "Kestrel", light and dark,
encoded with `cwebp -q 80-82`. The Mission Control set (`mission-*.webp`, `mission-m-*.webp`) and `og.jpg` are
recaptured with `site/capture-mission.mjs` (the steps are at its top).

The hero video is `docs/launch/assets/launch-90s.mp4` without its 6 s end card (which shows the name and URL in
pixels), re-encoded without audio:

```bash
ffmpeg -i docs/launch/assets/launch-90s.mp4 -t 73.2 -an -vf "scale=1440:-2:flags=lanczos,fps=24" \
  -c:v libx264 -preset slow -crf 30 -tune stillimage -pix_fmt yuv420p -movflags +faststart site/assets/video/demo.mp4
ffmpeg -i docs/launch/assets/launch-90s.mp4 -t 73.2 -an -vf "crop=1040:900:200:0,scale=780:-2:flags=lanczos,fps=24" \
  -c:v libx264 -preset slow -crf 29 -tune stillimage -pix_fmt yuv420p -movflags +faststart site/assets/video/demo-m.mp4
```

Phones get the centre crop (`<source media="(max-width: 640px)">`). The poster is the frame at 3 s (`cwebp -q 80`).

# Compute authority safety

Once the lock-ON site is deployed, retain `DATABASE_URL` (migrated) for as long as compute or any licence binding is
live: licence binds and the authority checks for funded accounts depend on the store. Unsetting `COMPUTE_ENABLED` is
safe: it drains, and the drained site keeps the store, binding and recording licences and enforcing every authority
check. Removing `DATABASE_URL`, or rolling back to a locked build, is not (docs/COMPUTE-GOLIVE.md, "Rollback").
