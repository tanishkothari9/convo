# Marketplace pivot

One Convo storefront that searches every listed brand. Brands keep a dashboard,
a catalogue, an API and their own orders — they lose their separate chat link.

## What changes underneath

The conversation stops belonging to a brand. Today every row carries a
`tenant_id` and every query filters on it; a shopper talking to Convo is not
talking to one brand, so the conversation, its messages, its cart and its
provenance all become platform-level.

| Table | Before | After |
|---|---|---|
| `conversations` | per tenant + session | per session |
| `messages` | tenant-scoped | conversation-scoped |
| `carts` | one brand | many brands |
| `cart_items` | tenant = the cart's brand | tenant = the product's brand |
| `seen_products` | tenant-scoped | conversation-scoped |
| `orders` | one per checkout | **one per brand per checkout**, grouped by `checkout_id` |
| `audit_log` | tenant-scoped | unchanged — each brand still sees only its own money |

Tenant isolation does not weaken; it moves. A brand still cannot read another
brand's catalogue, orders or ledger. What is now shared is the shopper's
conversation, which belongs to Convo.

## Money

A cart spanning three brands is three orders, because each brand has its own
payment account and Convo is not the merchant of record. Checkout computes a
per-brand total from live catalogue prices, stages one order per brand under a
single `checkout_id`, and the card pays them in turn — naming the brand each
time so nobody is surprised by two charges.

Razorpay Route would make that one charge, but it makes Convo hold other
people's money. Not before it is worth the liability.

## Listing is opt-in

A brand signed up for a storefront, not for a shelf beside a competitor.
`is_listed` defaults off; nothing appears in the marketplace until the brand
turns it on.

## Order of work

1. Schema v2 and the repository.
2. Marketplace search across listed brands, with brand attribution on every card.
3. Cart across brands; checkout split per brand.
4. The agent's own voice — Convo's, not a brand's — and brand-aware skills.
5. `/shop` replaces `/chat/:slug`; the per-brand surface is removed.
6. Dashboard: listing toggle in, chat link out.
7. Tests, sweep, docs.
