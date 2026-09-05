# Progress

Status at hand-off. Nothing is half-finished: the whole build order is done,
and the last thing done was the marketplace pivot — one shop across every
brand, replacing the per-brand chat pages.

## Working, verified end to end

| | How it was verified |
|---|---|
| Sign up, sign in, brand created and listed | Driven in a browser |
| Catalogue: add, edit, delete, search, out-of-stock states | Driven in a browser |
| The shop: browse → cart → checkout → pay → confirmation | Driven in a browser and over the API |
| Search across brands, with the brand named on every card | Driven in a browser and over the API |
| A cross-brand cart splitting into one order per brand, paid in turn | Driven in a browser and over the API, plus 3 tests |
| One address covering every brand in a checkout | Driven in a browser |
| Each brand seeing only its own half of a shared purchase | Driven over the API against both dashboards |
| Listing on, listing off, and the shelf changing immediately | Driven in a browser and over the API |
| Server-computed totals, provenance gates, per-item caps | 9 database-backed tests |
| Razorpay connect → sync → re-sync preserving merchant edits | Driven over the API |
| Signature verification, including tampering and cross-order replay | 6 tests |
| Audit trail with every money action, filterable, expandable | Driven in a browser |
| Layout at laptop, tablet, and 375px phone widths | Measured and screenshotted |

`npm test` → 66 passing. `npm run typecheck` → clean, both workspaces. Production
build → clean. Every page loads with no failed requests and no console errors.

## The graceful failure cases

All three are demonstrable live, not theoretical:

1. **An item sells out between the cart and the checkout.** Set any product's
   stock to 0 in the dashboard while it is in a cart, then ask to check out.
   The charge is stopped, nothing is staged, and the agent says which item went
   out of stock and offers to remove it and check out with the rest.
2. **A payment is declined.** The payment panel has a *Simulate a declined
   payment* button. The order fails, the cart stays intact, and the customer is
   told plainly that nothing was charged.
3. **A payment is cancelled.** Close the panel. Same outcome, different wording.

Two more that were found and closed during the build, both covered by tests:

4. **A superseded order cannot be paid**, even with a valid signature.
5. **A tampered or cross-order signature is refused**, and lands in the audit
   trail as `payment.signature_rejected`.

Three that arrived with the split checkout, all covered by tests:

6. **One brand in the cart cannot take payment.** Nothing is staged at all, and
   the customer is told which brand and offered the rest without it. A checkout
   that half-worked is worse than one that did not start.
7. **One brand declines after another was paid.** The paid order stands, the
   declined one can be retried, and the cart is *not* handed back — reopening
   it would put goods already bought back on the shopping list.
8. **A brand delists while its goods are in someone's cart.** The line drops
   out of the priced cart exactly as a deleted product does, so it cannot be
   charged for.

## Blocked on you — nothing is blocked, but two things are waiting

Neither blocked the build; both were worked around rather than skipped.

1. **~~An LLM API key~~ — supplied, and the OpenAI backend is now proven.**
   Running on `openai` / `gpt-5.6-luna`. One message — *"find me blue kurtis
   under 2000, add one to my cart and check out"* — chains search → add →
   checkout in a single turn, then the customer fills the address and pays.
   `gpt-5.6-terra` behaves equivalently and is a one-line change. The
   Anthropic backend is still code-complete but unrun: no key for it.

   Two things had to change to get there. The 5.6 models refuse function tools
   on Chat Completions unless `reasoning_effort` is `'none'`, and `.env` was
   never being read at all — see `DECISIONS.md`.

2. **Razorpay test keys.** The adapter is written against the published API and
   runs against a built-in sandbox that speaks identical shapes. Add real test
   keys in Dashboard → Provider and it switches over.

See `DECISIONS.md` for what each of those means in detail.

## Added since the first build

| | |
|---|---|
| **Public REST API** | `/v1` — bulk upsert by your own id, products CRUD, orders, audit, `/me`. Keys minted in Dashboard → Developers. |
| **API reference** | `/docs` — fills in your own key and host when signed in, so the first example is a live request. |
| **Shopify** | Catalogue source. Brands can now take products from one provider and payments from another. |
| **Storefront marquee** | The brand's real catalogue drifting on the opening screen, tappable to start a conversation. |
| **Delivery address** | Collected in the order card before payment, enforced at the gate, frozen onto the order, and exposed to the merchant and the API for fulfilment. |
| **Orders page** | What was sold and where it goes, with a copy-the-address button. |
| **Security** | Rate limiting, no account enumeration, no SVG image XSS, no SSRF through a shop name, security headers, tenant isolation under test. |

## Known limits

Not bugs — things deliberately out of scope, listed so you are not surprised:

- No product variants (sizes, shades). The catalogue is flat.
- No customer accounts; order history is per-conversation.
- A cart spanning brands is paid one brand at a time. Razorpay Route would make
  it one charge, at the cost of Convo holding other people's money.
- Listing has no review step. Any brand with a catalogue and a payment provider
  can put itself on the shelf.
- No webhooks. Payment confirmation is synchronous from the browser, so a
  customer who closes the tab mid-payment leaves an order awaiting payment.
- Rate limiting is per instance, not shared across a cluster.
- The Shopify sync reads four pages of 250 products; beyond that, push by API.
- Currency is INR for the whole marketplace; there is no UI to change it.
- Dark mode is not built.

## Two brands are seeded, on purpose

**Smart Choice** (`owner@smartchoice.demo`) sells ethnic wear: sixteen
products, each matched to its own photograph. **Kalaa Studio**
(`owner@kalaa.demo`) sells handcrafted jewellery: eight. Both use the password
`convo-demo-2026`, and both are listed.

Two rather than one because the marketplace only shows what it is for when a
cart can hold a saree from one shop and earrings from another. Ask for both,
check out, and you get two orders on one card, paid one at a time, each landing
in that brand's own dashboard and nowhere else.

They are also how tenant isolation is visible without reading a test: sign in
as either and you see your own catalogue, your own orders, your own ledger, and
no trace of the other's half of the same purchase.

## Where to look first

1. `http://localhost:5173/shop` — the product. Ask for a saree, then for
   jhumkas, then check out.
2. `server/src/agent/gates.ts` — the money gate, and the most important file.
   `gatedCheckout` is where a cart becomes one order per brand.
3. `server/src/db/repo.ts` — `products.listedAcrossBrands()` is the one
   accessor that crosses tenants on purpose; everything near it does not.
4. `server/src/models/types.ts` — the seam that makes the model swappable.
5. `DECISIONS.md` — every call made without being able to ask you, including
   what I would have pushed back on.
