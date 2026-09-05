# Convo

A conversational marketplace. A brand signs up, brings a catalogue — typed in,
or synced from a provider they already use — and lists it. One storefront then
sells for all of them: it searches every listed catalogue at once, keeps a
single cart that can span brands, and settles that cart as one order per brand
paid straight to that brand's own account. Every chargeable amount is computed
on Convo's side, and every money action is written to an audit trail the
selling brand can read.

Convo is multi-tenant, and the tenancy boundary is the brand, not the shopper.
A brand sees only its own catalogue, orders and ledger; the conversation and
its cart belong to the platform, because a shopper is not talking to any one
brand. **Smart Choice** (ethnic wear) and **Kalaa Studio** (jewellery) are the
seeded demo tenants — rows in the `tenants` table, not the product.

## Run it

Node 20+ (built and tested on Node 24). No database server and no API key are
needed to run the whole thing.

```bash
npm install
cp .env.example .env
npm run seed     # creates two demo brands, listed, with their catalogues
npm run dev      # API on :8787, web on :5173
```

| | |
|---|---|
| Shop | <http://localhost:5173/shop> |
| Dashboard | <http://localhost:5173/login> |
| Demo sign-in | `owner@smartchoice.demo` or `owner@kalaa.demo` / `convo-demo-2026` |

Try: *"show me sarees for a wedding"* → *"add the first one"* → *"and some
oxidised silver jhumkas"* → *"check out"*. The cart now spans both brands, so
checkout stages two orders and the card pays them one at a time, naming the
brand each time. Then open **Audit trail** in either dashboard: each brand sees
its own half and nothing of the other's.

Other scripts: `npm run typecheck`, `npm test`, `npm run build`.

## What it is made of

```
server/                     Node + TypeScript, Express, node:sqlite
  src/agent/                the shopping agent — skills, gates, tools, prompt, loop
  src/models/               the ModelProvider abstraction: Claude, GPT, scripted
  src/commerce/             the CommerceProviderAdapter: Razorpay, manual
  src/db/                   schema, repositories, seed
  src/routes/               the public shop (SSE), dashboard API, public /v1 API
web/                        React + Vite
  src/styles/tokens.css     the design tokens both surfaces share
  src/dashboard/            brand dashboard
  src/chat/                 the public shop
```

## The three ideas

### 1. The agent is built on Claude Commerce Agents

The agent is adapted from [`anthropics/commerce-agents`](https://github.com/anthropics/commerce-agents)
(Apache-2.0), ported from Python to TypeScript. What came from the blueprint,
and where it lives here:

| From the blueprint | In Convo |
|---|---|
| `commerce_common/fencing.py` — sanitizing and fencing third-party text | [`server/src/agent/fencing.ts`](server/src/agent/fencing.ts), a direct port: invisible characters, forged turn markers, transcript markup, and the fence label itself are all removed to a fixpoint |
| `shopping_agent/backend.py` — the `StorefrontBackend` interface | [`server/src/agent/storefront.ts`](server/src/agent/storefront.ts) |
| `shopping_agent/gates.py` — cart provenance and quantity caps | [`server/src/agent/gates.ts`](server/src/agent/gates.ts) |
| `shopping_agent/tools/registry.py` — typed tool contracts and the `status` line | [`server/src/agent/tools.ts`](server/src/agent/tools.ts) |
| `commerce_common/presentation.py` — validate, then join every fact from server records | [`server/src/agent/presentation.ts`](server/src/agent/presentation.ts) |
| `commerce_common/execution.py` — one executor, the failure ladder, `status` splitting | [`server/src/agent/executor.ts`](server/src/agent/executor.ts) |
| `commerce_common/skills.py` and `shopping-agent/skills/` | [`server/src/agent/skills.ts`](server/src/agent/skills.ts), [`server/src/agent/skills/`](server/src/agent/skills/) |
| `shopping_agent/prompt.py` — a cached static half, a fenced dynamic half | [`server/src/agent/prompt.ts`](server/src/agent/prompt.ts) |
| the Messages-API turn loop | [`server/src/agent/loop.ts`](server/src/agent/loop.ts) |

One agent with modular skills, not a router over subagents: a shopping
conversation is one continuous state, and splitting it loses that state and
adds latency.

**What Convo adds.** Two things. The blueprint deliberately handles no payment
— its `checkout` renders the cart for the host to complete. Convo completes it,
so the money gate in `gates.ts` is Convo's own, and it is the point at which a
conversational storefront becomes a real one.

The second is the shelf. The blueprint's `StorefrontBackend` serves one
merchant; Convo's serves all of the listed ones from a single conversation, and
the gates grew a fourth rule to match: a cart spanning brands settles as one
order per brand, on each brand's own payment account. The provenance, caps and
money rules are unchanged by that — provenance is still per conversation, and
the total is still recomputed per brand from live catalogue prices — but the
unit of a checkout is now a group of orders rather than one.

### 2. The model is swappable; the rules are not

Everything above [`ModelProvider`](server/src/models/types.ts) — skills, gates,
tool contracts, presentation enrichment, audit logging — is provider-neutral.
No file under `server/src/agent/` imports a vendor SDK.

Three backends ship:

- **`anthropic`** — Claude on the Messages API, with a cache breakpoint between
  the static and dynamic halves of the system prompt.
- **`openai`** — GPT on Chat Completions with function tool calling. The same
  internal tool definitions are translated into each vendor's wire format.
- **`scripted`** — a deterministic, no-network provider. It is a real
  implementation of the interface, not a stub: it reads the same history, is
  handed the same tools, and answers with the same typed tool calls, so every
  gate and audit entry downstream runs identically. It is the default so that
  Convo is fully demonstrable with no API key.

Set `LLM_PROVIDER` (and the matching key) to switch, or pick a model per brand
in **Settings**. A provider configured without a key falls back to `scripted`
and says so in the logs.

### 3. The server decides what gets charged

The agent proposes. The server decides, in
[`gatedCheckout`](server/src/agent/gates.ts):

- **`checkout` takes no amount argument.** It cannot be told what to charge —
  there is [a test](server/test/invariants.test.ts) asserting the schema stays
  that way.
- The chargeable total is recomputed from **live catalogue prices** at the
  moment of checkout, so a price that moved while an item sat in the cart is
  charged at today's price, and no figure the model produced ever reaches a
  payment provider.
- **Stock is re-checked at that moment.** An item that sold out between the
  cart and the checkout stops the charge.
- **Payment is verified server-side.** The signature is checked against the
  order id Convo holds, not the one the browser reported, and the live path
  re-reads the payment from the provider before marking an order paid.
- **Cart writes need provenance.** Only product ids a catalogue or order tool
  returned in this conversation are accepted.
- Every cart lock, order, payment attempt, confirmation, and refusal is written
  to an append-only audit log with its tenant, amount, outcome, and the agent's
  own stated reasoning.

## The API

A brand whose inventory lives in its own system loads a catalogue with one
call. Full reference at **`/docs`** — signed in, it fills in your own key and
host, so the first example on the page is a request against your own catalogue.

```bash
curl -X POST https://your-convo-host/v1/products/bulk \
  -H "Authorization: Bearer cvo_live_…" \
  -H "Content-Type: application/json" \
  -d '{ "products": [
        { "external_id": "SKU-1001", "name": "Mysore Silk Saree — Emerald",
          "price": 8499, "stock": 5, "category": "Sarees",
          "attributes": { "Colour": "Emerald green", "Occasion": "Wedding" } }
      ] }'
```

| | |
|---|---|
| `POST /v1/products/bulk` | Upsert up to 500 by your own `external_id` |
| `GET/POST/PATCH/DELETE /v1/products` | One product at a time |
| `GET /v1/orders` | What the agent sold |
| `GET /v1/audit` | The ledger, for reconciliation |
| `GET /v1/me` | Which brand a key belongs to |

Bulk upsert is addressed by **your** id, so last night's sync is safe to re-run:
it updates what changed and creates what is new instead of growing a second
catalogue. The batch is one transaction, so a half-valid payload leaves the
catalogue untouched rather than half-updated.

Keys are minted in **Dashboard → Developers**, shown once, and stored only as a
SHA-256 digest — Convo cannot recover one, so a dump of that table is not a set
of credentials. They carry a `cvo_` prefix so a leaked key is findable by secret
scanners, and they are scoped (read or write), revocable, and rate-limited.

## Providers

A provider implements three methods
([`CommerceProviderAdapter`](server/src/commerce/adapter.ts)):

```ts
fetchCatalog(credentials)                  // → CatalogItem[]
createPaymentOrder(credentials, request)   // → PaymentOrderHandle
verifyPayment(credentials, payload)        // → PaymentResult
```

Adding Shopify, WooCommerce, or a generic REST catalogue is those three
methods. No agent code, no route, and no UI changes.

A brand takes its **catalogue** from one provider and its **payments** from
another — Shopify for products, Razorpay for money — and a provider is only
offered a role its adapter can actually fill.

**Shopify** is catalogue-only, deliberately: Shopify's checkout belongs to
Shopify, and a customer buying inside a Convo conversation is not in it. It
reads the Admin REST API, and the store name is restricted to a single label
under `myshopify.com` so a merchant-supplied host cannot become a request
forgery.

**Razorpay** is implemented against the published API: catalogue from
[`GET /v1/items`](https://razorpay.com/docs/api/payments/invoices/fetch-all-items/),
payment from [`POST /v1/orders`](https://razorpay.com/docs/api/orders/create/),
and signature verification as `HMAC-SHA256(order_id + "|" + payment_id)` keyed
with the account secret, compared in constant time. Amounts are in the smallest
currency sub-unit on both sides, so nothing is converted.

**Manual** is the brand's own Convo catalogue, with a self-contained test
processor for checkout. It signs and verifies with the same construction a live
processor uses — so the verification path a manual tenant exercises is the same
code a Razorpay tenant does — but it moves no money and is not a payment method
for production.

### Plugging in a real Razorpay test account

1. Get a **test-mode** key pair from the Razorpay dashboard (`rzp_test_…`).
   Live keys are refused.
2. Dashboard → **Provider** → paste both → **Test connection** → **Connect
   Razorpay**. Credentials are encrypted with AES-256-GCM before storage and
   are never returned to any client.
3. **Sync catalogue** pulls your Items across.
4. Checkout then opens Razorpay's own hosted widget, and Convo verifies the
   signature it returns.

Leaving both fields blank connects Convo's built-in Razorpay sandbox, which
answers with identical request and response shapes — so swapping in real keys
is a config change, not a rewrite.

Razorpay Items carry no imagery, category, or inventory, so a synced catalogue
starts without them and the merchant fills them in here. A re-sync preserves
what they filled in.

## Design

Both surfaces run on one set of tokens
([`web/src/styles/tokens.css`](web/src/styles/tokens.css)): one type scale with
size-specific tracking, one spacing rhythm, one set of shapes, and one gradient
ramp built out of the accent rather than beside it.

**Where the light changes.** Convo's own pages — the landing and sign-in — are
dark, lit by an animated WebGL field
([`ShaderField.tsx`](web/src/components/ShaderField.tsx), a Paper Design mesh
gradient with grain over it). The working surfaces are light, because a
merchant reading a ledger and a customer judging a fabric are both better
served by paper than by atmosphere. The dashboard puts that seam inside one
screen: a dark navigation rail against a light content area, so the change of
register is a deliberate edge rather than something you fall through between
pages.

The shader's palette is weighted toward green on purpose. An animated field
gives every colour the frame eventually, and a brand that reads violet for a
few seconds of each cycle is not a brand — so the indigo is one stop out of
eight, present as depth at the far end of the travel. It degrades honestly: the
CSS gradient underneath stands in when WebGL is missing, and
`prefers-reduced-motion` freezes the field rather than removing it.

**Icons** ([`icons.tsx`](web/src/components/icons.tsx)) are drawn for this
product on one rule: every icon is built from the three horizontal registers of
a ledger, bent, broken or beaded into its subject. The rule has an origin — the
rupee sign is already two horizontal rules over a stem, so the currency the
product mostly counts in is the set's seed glyph. The gate is three registers
stopped dead by a barred seal, which is the claim the whole product makes;
settings is the one deliberate exception, turned on its side because it sits
directly under provider in the rail and two icons of horizontal lines and beads
are not distinguishable at 17px.

**The shop** runs on Convo's own green rather than any one brand's palette.
Under the old per-brand storefront it took the tenant's accent for its ambient
field, its buttons and its thinking indicator; a shelf holding many brands
cannot do that without quietly picking a favourite, and would lurch in colour
every time the conversation moved between labels. Attribution moved from the
chrome into the content instead: the brand's name sits above the product name
on every card, in the cart, on the checkout card and on each receipt. The
agent's replies are set as text in a reading column rather than in bubbles —
only the customer's messages get one — so product cards read as part of what
the shop is saying.

The thinking state is the one place motion is the point, because it is the only
thing a customer has to look at while they wait. A small sphere lit from within
turns the instant the message is sent; a shimmering placeholder shows where the
reply will land; the agent's own status line replaces it ("looking through the
catalogue"), and successive statuses cross-fade through a blur so it reads as
one line changing rather than two swapping. That status is a real field on
every tool call, streamed out of the model's arguments before the rest of them
have arrived.

## Tests

```bash
npm test
```

66 tests over the rules that must hold whichever model is running: fencing
against forged turn markers and fence escapes, signature verification against
tampering and cross-order replay, the tool surface, and the money path against
a real database — the total recomputed after a price move, an item selling out
stopping the charge, stock leaving only on confirmation, and a superseded order
staying unpayable even with a valid signature.

The marketplace adds its own: a two-brand cart splits into one order per brand
with each charged only for its own goods, paying one brand leaves the other
owed and the cart open, and a half-paid checkout is never handed back as a live
cart. The security suite asserts both halves of the new boundary — brands still
cannot read each other's orders or ledgers, an unlisted brand never reaches the
shelf, and one shopper cannot read another's orders, addresses or provenance
even though the cart is now a platform-level object.

## Security

What is enforced, and where:

- **Rate limiting** ([`ratelimit.ts`](server/src/lib/ratelimit.ts)) on auth, the
  chat turn, the dashboard and the API. The shop's message route runs a model
  turn per request, so an unthrottled endpoint is an unbounded bill; it is
  budgeted per customer session rather than per IP, because customers share
  addresses behind carrier NAT.
- **No account enumeration.** Sign-in burns the same work whether or not the
  email exists, so neither the wording nor the timing answers the question.
- **No stored XSS through imagery.** SVG is refused in both URL and data form,
  in the dashboard and the API, because it carries script and these render in a
  customer's browser on merchant-controlled content.
- **No SSRF through a merchant-supplied host.** The Shopify store name resolves
  to one label under `myshopify.com` or is refused.
- **Credentials** are AES-256-GCM at rest and never returned to any client; API
  keys are digests, not recoverable secrets.
- **Security headers** on every response, with a CSP written for what the app
  actually loads.
- **Tenant isolation** is asserted, not assumed —
  [`security.test.ts`](server/test/security.test.ts) fails if one brand can
  reach another's products, orders, audit entries or keys, or if an unlisted
  brand's goods reach the shelf.
- **Shopper isolation** is the other half of that boundary, and the newer one.
  The conversation and its cart deliberately span brands, so they can no longer
  be fenced by tenant; they are fenced by the customer session cookie instead,
  and every order route proves ownership with the conversation rather than with
  a brand. The same suite fails if one shopper can read another's orders,
  addresses or provenance.

## What a deployment would add

Convo is complete as a working system, not as a production deployment. Before
real money moves: a shared rate-limit store once there is more than one
instance, a queue for provider calls, webhook handling for asynchronous payment
updates, key rotation for `CONVO_SECRET`, and Postgres in place of SQLite.

The marketplace adds two of its own. A customer paying three brands taps pay
three times, which is honest but not pleasant; Razorpay Route would make it one
charge, at the cost of Convo holding other people's money and becoming the
merchant of record — a liability worth taking on only when the volume justifies
it. And listing is currently a switch the brand flips, with no review; a real
marketplace needs someone deciding what belongs on the shelf. See
`DECISIONS.md`.
