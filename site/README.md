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
