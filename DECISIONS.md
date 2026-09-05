# Decisions

Every choice made without being able to ask, and what to change if the call was
wrong. Ordered roughly by how much you might disagree.

## Things you may want to change

### The default model provider is `scripted`, not Claude

**No `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` was present in the environment**,
and there was no way to obtain one. Rather than ship a product that does
nothing until a key arrives, I implemented a third `ModelProvider` — a
deterministic, no-network one — and made it the default.

It is a real implementation of the interface, not a mock: it reads the same
conversation history, receives the same tool definitions, and emits the same
typed tool calls, so every gate, provenance check, server-side total, signature
verification, and audit entry downstream runs exactly as it would under a
hosted model. It handles the intents a storefront actually sees — browse,
filter, refer back ("the second one"), cart, checkout — and falls back to a
search for anything else. It does not generalise, and it is not meant to.

**Tested live:** the scripted provider, end to end, many times.
**Implemented but not tested live:** the Anthropic and OpenAI backends. Both
are code-complete with correctly shaped requests, responses, streaming, and
tool-call translation, and both are exercised for shape by the unit tests — but
neither has been run against its real API. Set a key and `LLM_PROVIDER` to try
them; if something is wrong it will be in the wire format, not the agent.

### Razorpay runs against a built-in sandbox, not a real test account

No Razorpay credentials either. `RazorpayAdapter` is written against the
published API — `GET /v1/items`, `POST /v1/orders`, `GET /v1/payments/:id`,
HTTP Basic auth, `HMAC-SHA256(order_id|payment_id)` verification — with the
field names taken from Razorpay's own documentation rather than guessed. When a
tenant's connection has no key secret, the adapter swaps in a mock that speaks
identical endpoints, parameters, and response objects, and signs with the same
HMAC construction. `RazorpayAdapter` cannot tell them apart.

Add real test keys in the dashboard and everything switches over; the only code
path that changes is which client the adapter constructs.

**Live keys are refused.** A key id beginning `rzp_live_` is rejected with a
message saying so. If you want live mode, that guard is in
`server/src/commerce/razorpay/adapter.ts`.

### Smart Choice is left on the manual catalogue, not on Razorpay

The build order says to convert the demo tenant to Razorpay once the sync
works. It works — connect, sync, re-sync, and payment all verified — but
**Razorpay's Items API carries no imagery, category, or inventory**. Converting
Smart Choice would replace a catalogue of sixteen photographed products with
ten unphotographed ones, which makes the storefront look worse for a reason
that has nothing to do with Convo.

So the demo is left on its own catalogue, and the Razorpay flow is left for you
to walk yourself (Dashboard → Provider → Connect, leave both fields blank). A
re-sync preserves any images and stock the merchant set in Convo, so the two
are not mutually exclusive in practice.

### No dark mode

Not asked for, and doing it properly means auditing every surface twice. One
polished light theme beats two rough ones. The tokens are structured so a dark
theme is a second `:root` block, not a refactor.

### `node:sqlite` instead of `better-sqlite3`

`better-sqlite3` has no prebuilt binary for Node 24 and failed to compile.
Node's built-in `node:sqlite` does the same job with no native build step. It
is marked experimental, so the warning is suppressed in the npm scripts.

The schema is deliberately Postgres-shaped — explicit foreign keys, no SQLite-only
affinities, application-generated text ids, ISO-8601 timestamps — and every
query is plain SQL in `server/src/db/repo.ts`. Moving to Postgres is a driver
swap in `server/src/db/index.ts` plus that one file.

### The `ScriptedModelProvider` reads intent with regexes

It is a rule-based parser, and it looks like one. It is honest about what it
is: the file says so at the top. It exists to prove the architecture works
without a key, not to be an NLU system. Point `LLM_PROVIDER` at a real model
and none of it runs.

## Interpretations of the brief

### "ML design skill"

Three of the four named design skills exist: `frontend-design`,
`emil-design-eng`, `apple-design`. All three were loaded and used. There is no
skill named "ML design" available in this environment — I took it as a
mishearing and used the animation guidance inside `emil-design-eng` and
`apple-design` in its place, which is what shaped the thinking-state work.

### Frappe

You mentioned Frappe API keys. No Frappe adapter was built: the brief's own
scope is Razorpay plus the manual path, and a fourth provider would have taken
time from the flows that had to work. It is three methods when you want it —
`fetchCatalog`, `createPaymentOrder`, `verifyPayment` — and nothing else in the
codebase would change.

### Design direction

Convo white-labels: every tenant carries its own accent colour and the
storefront runs on it. That is the constraint that drove the palette. Convo's
own chrome had to recede rather than compete, so the neutrals are shifted
slightly cool (a warm ground fights half the brand accents that will land on
it) and Convo's own accent — a deep bottle green, chosen for the ledger side of
the product — appears only in the dashboard.

The brief asks for no clashing between surfaces. They share every neutral, the
type scale, the spacing rhythm, and every component; what differs is which
accent is in force, and that difference is the product working as designed. The
dashboard shows the tenant's accent on the chat-link card and in a live button
preview in Settings, so the theming is demonstrated rather than described.

**The agent's replies are not chat bubbles.** They are text set in a reading
column; only the customer's messages get a bubble. This is the one structural
risk in the design. It reads better at length and it lets product cards belong
to what the shop is saying rather than hang off a message. If you dislike it,
it is `.reply` in `web/src/chat/chat.css`.

**Typography** is one family, Instrument Sans, with Inter behind it in the
stack so any glyph Instrument Sans lacks — the rupee sign above all — still
renders. Tracking is size-specific rather than one value everywhere. Monospace
appears only on identifiers people compare character by character.

## Choices inside the architecture

- **Money is integer minor units everywhere.** Nothing stores or arithmetics a
  currency amount as a float. `paise` in, `paise` out, formatted once at the
  edge — which also happens to be Razorpay's own convention.
- **Provenance lives in the database**, not in process memory, so it survives a
  restart and works if the server is ever run as more than one process.
- **Tool results name products by id, not by title.** Catalogue text stays
  inside the data fence; the model translates it for the customer.
- **`cart_state` and `cart` are different components.** A cart write updates the
  running cart panel; `present_cart` posts an inline card. Without the split, a
  write left a duplicate card in the transcript.
- **A `status` line is a real field on every non-presentation tool**, streamed
  out of the model's arguments before the rest have finished arriving. That is
  what makes "looking through the catalogue" appear while the call is still
  being built rather than after it finishes.
- **Cart writes reopen a checkout-locked cart.** `checkout` locks the cart so
  nothing moves while a payment is in flight; a customer who keeps shopping
  instead of paying was therefore silently started on a fresh empty cart. Now
  the write reopens the locked cart and cancels the order that locked it.
- **A newer checkout cancels older payable orders** for the same conversation.
  An order summary stays in the transcript, so scrolling back reached a live
  pay button against a cart that had since changed — a second charge waiting to
  happen.
- **`prefers-reduced-motion` removes travel, not feedback.** Opacity and colour
  transitions stay because they carry meaning.

## Assumptions I made without asking

- **Currency is INR** for every tenant. `Tenant.currency` exists and the
  formatter handles USD, EUR, and GBP, but nothing lets a brand change it in
  the UI yet.
- **One brand per user account.** The schema supports several users per tenant;
  there is no invite flow.
- **No product variants.** The blueprint models option families and variants;
  Convo's catalogue is flat. Adding them means a `variant_of` column and the
  options gate from `shopping_agent/gates.py`, which is why the fields are
  named the way they are.
- **Conversations are anonymous.** Identity is an unguessable session id in an
  httpOnly cookie, minted server-side and never accepted from a request body.
  There is no customer login, so order history is per-conversation.
- **Seed photography is from Unsplash's CDN**, hot-linked, and every image was
  checked against its product by eye. They are placeholders; a real brand
  replaces them in the dashboard.

## Added in the ship-ready pass

### The public API is addressed by *your* id, not ours

`POST /v1/products/bulk` takes an `external_id` — the merchant's own — and
upserts on it. That one choice is what makes an integration safe to leave
running: a cron job that fires twice, or a retry after a timeout, updates the
same rows instead of doubling the catalogue. Convo's own ids are still returned
and still work, so no mapping table is needed on either side.

The batch is one transaction. A 400-row payload with one bad price writes
nothing, which is the behaviour you want when the failure happens at 3am and
nobody reads the log until morning.

### Shopify is catalogue-only, and that forced a better model

Shopify's checkout belongs to Shopify, and a customer buying inside a Convo
conversation is not in it. Rather than fake it, the adapter declares
`payment: false` — which meant `provider_connections` had to stop assuming one
active provider per brand. It now has two roles: where the catalogue comes from,
and who takes the money. Shopify for products and Razorpay for payment is a
supported combination, and a provider is only offered a role its adapter can
fill.

WooCommerce is the same shape when you want it; nothing else changes.

### API keys are digests, not secrets

Stored as SHA-256, not scrypt — unlike a password this is 256 bits of random,
there is nothing to brute-force, and the lookup happens on every request. The
consequence to know about: **a lost key cannot be recovered, only replaced.**
The `cvo_` prefix is deliberate, so a key pasted into a repository is findable
by secret scanners.

### Rate limiting is in-process

Per instance, so running several behind a load balancer multiplies the
effective limit by the instance count. That is the right trade today — no Redis,
cannot fail open on a network blip — and the numbers are low enough that a few
multiples is still far from a problem. Moving to a shared store is
`lib/ratelimit.ts` and nothing else.

The chat limiter is keyed by **customer session, not IP**, on purpose: a shop's
customers share addresses behind carrier NAT, and throttling them as one caller
would break the storefront for a whole city.

### The landing and sign-in are dark; the working surfaces are light

Not indecision. Convo's own pages carry the brand and an animated field; the
dashboard and the storefront are full of figures and photographs, where paper
beats atmosphere. The dashboard's dark navigation rail puts that seam inside one
screen so the change of register is a deliberate edge rather than a jolt between
pages.

### Icons are drawn on one rule

Every icon is built from the three horizontal registers of a ledger, bent into
its subject — because the rupee sign is already two rules over a stem, so the
currency this product counts in seeds the set. Settings is the one exception,
turned vertical, because it sits under Provider in the rail and two icons of
horizontal lines and beads are not distinguishable at 17px.

### The delivery address is a form, not a conversation

Two reasons it is not collected by the agent. A model parsing free text into
`line1 / line2 / city / state / PIN` gets it subtly wrong in ways nobody
notices until a parcel is lost — and asking in chat puts a customer's home
address into the model's context and into the stored transcript, where it does
not need to be.

So it sits inside the order card, above the pay button, in the order a person
thinks: what am I buying, where is it going, then pay. **The gate enforces it,
not the form** — `gatedConfirmPayment` refuses to mark an order paid with no
address, because the form runs in a browser the customer controls and an order
that reaches "paid" with nowhere to send it is money taken for a parcel nobody
can post.

The address is frozen onto the order like its line items, so editing a later
one cannot rewrite where an earlier parcel went. It is pre-filled from the last
address used *in the same conversation* — not from an account, because there
are no customer accounts; the session cookie is the identity, so the memory
stops at one person's thread.

Validation is India-shaped: a six-digit PIN, a ten-digit mobile, states from a
list. `country` exists so widening it is a validation change rather than a
migration. `requires_shipping` is per brand, so a brand selling something
digital turns the whole step off.

## What a deployment still owns

Convo is complete as a working system, not as a production deployment. Before
real money moves:

- **A shared rate-limit store** once more than one instance runs. The limiter
  is in-process today; see above.
- **Webhooks.** Payment confirmation is synchronous, from the browser. Razorpay
  can also confirm out-of-band, and a real deployment needs that path so a
  customer who closes the tab mid-payment is not lost.
- **Key rotation.** Provider credentials are encrypted with a key derived from
  `CONVO_SECRET`; rotating it today would strand every stored credential.
- **Postgres**, and a connection pool.
- **A retry and timeout policy** around provider calls. There is a 20-second
  timeout and no retry.
- **Log hygiene review.** Credentials, session ids, API keys and cookies are
  never logged today; keep it that way.
- **A CSP report endpoint.** The policy is set but nothing collects violations.
- **Cursor pagination for the Shopify sync.** It reads four pages of 250; past
  a thousand products a merchant should push to `/v1/products` instead.
