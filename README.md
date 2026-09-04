# Convo

A conversational commerce platform. A brand signs up, brings a catalogue —
typed in, or synced from a provider they already use — and gets a link. That
link opens an AI storefront in the brand's own voice: it searches the
catalogue, keeps a cart, and takes payment, with every chargeable amount
computed on Convo's side and every money action written to an audit trail the
brand can read.

Convo is multi-tenant. **Smart Choice**, an ethnic wear brand, is the seeded
demo tenant — one row in the `tenants` table, not the product.

## Run it

Node 20+ (built and tested on Node 24). No database server and no API key are
needed to run the whole thing.

```bash
npm install
cp .env.example .env
npm run seed     # creates the Smart Choice demo brand and its catalogue
npm run dev      # API on :8787, web on :5173
```

| | |
|---|---|
| Storefront | <http://localhost:5173/chat/smart-choice> |
| Dashboard | <http://localhost:5173/login> |
| Demo sign-in | `owner@smartchoice.demo` / `convo-demo-2026` |

Try: *"show me sarees for a wedding"* → *"add the first one"* → *"check out"* →
pay in the panel. Then open **Audit trail** in the dashboard to see what the
server recorded.

Other scripts: `npm run typecheck`, `npm test`, `npm run build`.

## What it is made of

```
server/                     Node + TypeScript, Express, node:sqlite
  src/agent/                the shopping agent — skills, gates, tools, prompt, loop
  src/models/               the ModelProvider abstraction: Claude, GPT, scripted
  src/commerce/             the CommerceProviderAdapter: Razorpay, manual
  src/db/                   schema, tenant-scoped repositories, seed
  src/routes/               public chat (SSE) and dashboard API
web/                        React + Vite
  src/styles/tokens.css     the design tokens both surfaces share
  src/dashboard/            brand dashboard
  src/chat/                 the public storefront
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

**What Convo adds.** The blueprint deliberately handles no payment — its
`checkout` renders the cart for the host to complete. Convo completes it, so
the money gate in `gates.ts` is Convo's own, and it is the point at which a
conversational storefront becomes a real one.

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
size-specific tracking, one spacing rhythm, one set of shapes.

Convo white-labels, so its own chrome recedes. The neutrals are shifted
slightly cool — a warm ground fights half the brand accents that will be
dropped onto it — and Convo's own accent, a deep bottle green, is used only in
the dashboard. The chat page runs entirely on the tenant's colour.

The storefront sets the agent's replies as **text in a reading column rather
than in bubbles**; only the customer's messages get a bubble. Product cards
then read as part of what the shop is saying.

The thinking state is the one place motion is the point, because it is the only
thing a customer has to look at while they wait: dots appear on the same frame
the message is sent, collapse to a single dot as the agent's own status line
arrives ("looking through the catalogue"), and successive statuses cross-fade
through a blur so it reads as one line changing rather than two swapping. That
status is a real field on every tool call, streamed out of the model's
arguments before the rest of them have arrived.

## Tests

```bash
npm test
```

29 tests over the rules that must hold whichever model is running: fencing
against forged turn markers and fence escapes, signature verification against
tampering and cross-order replay, the tool surface, and the money path against
a real database — the total recomputed after a price move, an item selling out
stopping the charge, stock leaving only on confirmation, and a superseded order
staying unpayable even with a valid signature.

## What a deployment would add

Convo is complete as a working system, not as a production deployment. Before
real money moves: rate limiting in front of the chat routes, a queue for
provider calls, webhook handling for asynchronous payment updates, key rotation
for `CONVO_SECRET`, and Postgres in place of SQLite. See `DECISIONS.md`.
