# Ship-ready plan

Ordered by what stops this being shippable, not by what is fun. Each item says
what is wrong now and what "done" means.

---

## 1. Security — the things that would actually hurt

| # | Gap today | Fix |
|---|---|---|
| 1.1 | **No rate limiting anywhere.** The public chat route runs an LLM turn per request. One script = an unbounded bill. | Token-bucket limiter: per-IP on auth, per-conversation on chat, per-key on the public API. |
| 1.2 | **Login leaks which emails exist.** The "no such user" path returns before hashing, so it answers measurably faster. | Always run a dummy hash; equalise the path. Plus per-IP and per-email attempt throttling. |
| 1.3 | **`data:image/svg+xml` product images are stored and rendered.** An SVG data URL can carry script. | Allow `http(s)` and raster `data:image/*` only; reject SVG in both. |
| 1.4 | **No security headers.** No CSP, no `X-Content-Type-Options`, no framing policy, no referrer policy. | Header middleware on every response; CSP tuned for the app's real sources. |
| 1.5 | **New:** a public API means bearer tokens on the internet. | Keys hashed at rest (never recoverable), shown once, prefixed for scanning, revocable, scoped, rate-limited. |
| 1.6 | **New:** Shopify means fetching a merchant-supplied host. | Strict `*.myshopify.com` validation to close SSRF. |
| 1.7 | Tenant scoping is by convention. | Audit every query; add a test that fails if one tenant can read another's rows. |
| 1.8 | Errors may leak internals. | Confirm the handler never returns a stack or a driver message. |

## 2. Public API — how a brand actually loads a catalogue

Today the only ways in are typing into the dashboard or a Razorpay sync. A brand
with their own inventory system has no door.

- `POST /v1/products` — create one.
- `PATCH /v1/products/:id` — update.
- `DELETE /v1/products/:id`.
- `GET /v1/products` — list, paginated.
- **`POST /v1/products/bulk`** — upsert many by `external_id`. This is the one
  that matters: a nightly sync from any system is one call.
- `GET /v1/orders`, `GET /v1/conversations`, `GET /v1/audit` — read the results back.
- Auth: `Authorization: Bearer cvo_live_…`. Scoped, rate-limited, revocable.
- `external_id` is the merchant's own id, so re-syncing updates instead of duplicating.

## 3. API documentation

A real page in the product, not a README: every endpoint, every field, copyable
`curl`, live-looking request/response, error codes, rate limits, and a "your key
goes here" that fills in the merchant's actual key when signed in.

## 4. Shopify

A third `CommerceProviderAdapter`. Proves the abstraction was real: three
methods, no agent changes. Admin API for products; payments stay with the
tenant's payment provider. WooCommerce is the same shape when it is wanted.

## 5. Chat — the brand's storefront

- **A product carousel on the empty state**, drifting slowly, built from the
  brand's real catalogue. It answers "what does this shop sell" before a word
  is typed, and it is the single biggest thing missing from that screen.
- Tap a product in the carousel to start the conversation about it.
- Pause on hover, and no motion at all under `prefers-reduced-motion`.

## 6. Fixes

- **The model-swap panel** (screenshot): four rows repeating one icon, a stray
  connector line, and an "unchanged" tag too faint to read. Give each layer its
  own icon, make the tag a real badge, replace the line with a bracket that
  groups what does not change.
- Full sweep: typecheck, tests, production build, console clean, every screen at
  three widths.

## 7. Config

Anthropic, OpenAI and Razorpay keys drop into `.env` and everything switches
over. No code change. `LLM_PROVIDER=anthropic` and the agent runs on Claude.
