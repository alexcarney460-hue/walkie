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
"name": "Walkie",
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

## Rental compute functions (RENT-2, off until configured)

`api/compute/*.ts` are the control plane for rented machines (docs/plans/RENT-1.md). The code is in
`api/_lib/compute/`: a provider-neutral driver interface (`driver.ts`) with FakeCloud (tests, demo) and DigitalOcean
(`digitalocean.ts`), a store interface with Neon Postgres (`pg-store.ts`, `migrations.ts`) and in-memory
implementations, the minute tick (`tick.ts`) and the cloud-init user-data (`cloud-init.ts`). **Customers only ever
see prices**: the public catalogue is `catalog.ts`; provider, size, region, image, our cost and our provider limits
come only from the private env var `COMPUTE_PRIVATE_CONFIG` (`private-config.ts` documents the shape).

**Pre.10 release gate:** every published `/api/compute/*` endpoint returns 503, and `COMPUTE_ENABLED=1` is a
configuration error. Leave that switch unset. Other compute variables, including `COMPUTE_PRIVATE_CONFIG` and
`DATABASE_URL`, may stay set but have no compute effect in pre.10; license bind and renew ignore the database and
roster proof. The routes, database setup, and activation steps below describe code under review for a later release.

| Route | Auth | Does |
|---|---|---|
| `GET /api/compute/quotes` | none | tiers with prices, credit blocks, billing terms |
| `POST /api/compute/account` `{team_id, proof}` | none (10/IP/h) | `201 {account_id, token}`; the token is shown once, only its sha256 is kept |
| `GET /api/compute/state` | `Bearer <token>` | balance, burn per hour, hours left, rentals |
| `POST /api/compute/credit` `{block: 50\|200\|1000}` | Bearer | `{url}`: Stripe Checkout (mode=payment) for prepaid credit |
| `POST /api/compute/rent` | Bearer, `COMPUTE_ENABLED=1` | `{idempotency_key, machines, codes, walkie_version, idle_minutes?}` → reserved for the tick or queued; `402 insufficient_credit` when credit doesn't cover every machine's first hour |
| `POST /api/compute/start` `{rental_id, code}` | Bearer, `COMPUTE_ENABLED=1` | a fresh join code for a rental waiting in `needs_code` |
| `POST /api/compute/stop` `{rental_id}\|{all:true}` | Bearer | terminate + wipe (works with launching switched off) |
| `POST /api/compute/heartbeat` | the rental's own token | liveness and load from the rented machine, once a minute |
| `GET /api/compute/tick` | `Bearer $CRON_SECRET` | the minute loop: metering, stops, queue, orphan reconcile |
| `POST /api/compute/webhook` | Stripe signature | credits a paid block once per session; a dispute or refund freezes the account |

Future release env vars (names only; setting them has no compute effect in pre.10):

- `COMPUTE_ENABLED=1` (launching on), `COMPUTE_PRIVATE_CONFIG` (JSON), `DATABASE_URL` (Neon, Vercel Marketplace)
- `COMPUTE_STRIPE_SECRET_KEY` (must be `sk_test_…`/`rk_test_…` unless `COMPUTE_STRIPE_LIVE=1`), `COMPUTE_STRIPE_WEBHOOK_SECRET`
- `CRON_SECRET` (Vercel sets it for cron calls), `DIGITALOCEAN_TOKEN` (the provider)
- demo/preview only: `COMPUTE_ALLOW_FAKE=1` (FakeCloud may back tiers)

In a future release, a cron can run every minute; its function stops taking new launch
claims after 40 seconds. Admissions require a successful tick in the last three minutes. A stale tick appears
in owner state as `tick_stale`, logs `alert_tick_stale`, and disables the advertised quotes capability.
The first healthy tick after an outage renews paid leases and processes cleanup; a subsequent healthy tick can launch.

Before enabling, apply migrations with `PgStore.connect(url).migrate()` (including migration 5's first-funded marker and backfill).
Customers require no operator enrollment: the first account request includes the signed roster genesis and its signed
authority-transfer chain. The site derives the team ID from genesis and requires the account key to be the chain's
current authority. The key signs `walkie-compute-account-v1\n<team>\n<expiry-ms>` (at most five minutes ahead).
Enrolled teams automatically become customers; **real providers still require live paid compute credit**.

The authority daemon attaches `lic_id` and `renewal_token` when it holds the matching license and renewal token.
The site verifies an active subscription, token hash, bound `walkie_team` and bound roster authority using
`STRIPE_SECRET_KEY` (separate from compute's Stripe key). License proof is only a recovery path; it cannot override
an invalid roster proof. Tokens are never persisted or logged by compute. A newer signed authority chain changes
the enrolled key automatically only for unfunded teams. For a funded or held compute account, or an open checkout,
the new authority enters a 24-hour hold and needs explicit operator approval of its `chain_id` and `proposed_key`.
Owner acknowledgements inform the operator but cannot complete the change. An eligible owner's objection blocks
approval unless the operator uses the logged and alerted `override_objection` action. An owner objection blocks completion unless the operator explicitly overrides it for that proposal. Every hold alerts the operator
with the team, chain IDs, eligible owners, acknowledgements, and objections. An unacknowledged hold expires after
72 hours and alerts the operator; a late approval cannot revive it, and its digest and proposed key cannot reopen it
until the operator uses `clear_rejection` naming a new proposal's `chain_id` and `proposed_key`. A valid genesis
recovers a legacy trust-on-first-use squat automatically only while the account is unfunded. A funded, held or
checkout-pending account whose enrollment has no stored chain (or whose chain a license bind already advanced) is never
adopted automatically: the site alerts the operator. A `team_authorities` pin lets the pinned key open a hold; the operator must then approve that exact proposal before the account moves.
Concurrent enrollments are serialized.

Private JSON fields remain operator overrides: `team_authorities` pins team IDs to keys and takes precedence over
durable enrollment; `customer_teams` explicitly classifies legacy verified customers; `internal_teams` always wins,
including over automatic or explicit customer classification, and can never launch a real provider. Keep our own
and all test teams in `internal_teams`. Admission, queue promotion, tick and launch recheck current enrollment,
so replaced keys lose real-provider eligibility, including existing accounts. Unknown keys and unverified legacy
accounts cannot launch real machines.

Point the Stripe webhook at `/api/compute/webhook` for `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `charge.dispute.created`, `charge.refunded`, and
`radar.early_fraud_warning.created`. Freezes are persisted by payment intent even before a purchase arrives.
Only live paid credit pays real-provider charges; FakeCloud consumes other credit first. Each rental reserves its
first hour under the account lock (covering the GPU minimum). Outstanding reservations reduce every admission check.

In a later release, set `COMPUTE_ENABLED=1` only after the cron is healthy. Quotes advertise `available`; new purchases, dashboard controls,
and dashboard recurring polling require it. State and stop remain accessible with launching disabled. Stopping
machines remain metered until provider-confirmed deletion, with backoff and owner-visible escalation. Boot-failure
refunds preserve the original credit buckets and wait for confirmed deletion.

Keep driver credentials for every recorded provider until all claims are resolved. Uncertain creates are reconciled
using durable rental/provider claims and are never blindly retried. Unknown machines receive a two-minute observation
grace before cleanup; a failed orphan deletion does not block later orphans. User-data contains a public 1000 Mbit/s
fair-use rate, not the private provider limit. Metadata firewall prerequisites, installation and verification are
mandatory before joining; the user manager requires restoration after reboot. Actual guest boot remains a deployment
validation step.

Operational alerts go only to Alex's Telegram chat through Bot API `sendMessage`. Set these env names in Vercel:
`COMPUTE_ALERT_TELEGRAM_TOKEN`, `COMPUTE_ALERT_TELEGRAM_CHAT`, and optionally
`COMPUTE_ALERT_SPEND_USD_PER_DAY` (positive USD threshold, default 50; an invalid value alerts and falls back to 50). Missing Telegram settings mean log only.
Alerts cover stale/recovered ticks, delayed stop/delete escalation (three failed attempts), orphan discovery and
termination/failure, uncertain creates, mining/abuse and egress-cap stops, dispute/refund/fraud freezes, invalid
configuration, unavailable providers and daily provider spend. Staleness is observed by quotes, state, admission
and resumed ticks; an entirely stopped cron with no requests needs external uptime monitoring.

A durable rolling 30-minute claim per alert key suppresses duplicates across serverless instances, including failed
send attempts. Delivery runs after the operation's transactions, is awaited before returning, times out after three
seconds, refuses redirects, and never throws into billing. Only allowlisted fields reach Telegram: team/account/
rental IDs, hashed instance references, fixed event names, timestamps and operational cost figures. No customer
secrets, renewal tokens, team tokens or provider response text are sent. Configuration alerts use the durable store
even when private config is invalid; without a usable store they remain log only.

Daily spend alerts estimate UTC-day accrued compute cost from all recorded real-provider rental lifetimes,
including ended and uncertain creates. New rentals snapshot the private hourly cost; older rentals use the configured
rate. The estimate excludes FakeCloud, untracked orphan costs and provider invoice extras (tax, storage, bandwidth,
minimum billing adjustments); it is not invoice reconciliation. The tick checks the threshold once each pass.

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

In a later release, once compute has been enabled, keep `COMPUTE_ENABLED` set and retain `DATABASE_URL` while any funded
compute accounts exist. Removing either setting can remove the license authority check for those accounts.
