# Progress

Status at hand-off. Nothing is half-finished across two milestones: the whole
build order is done, and the last thing done was the polish pass.

## Working, verified end to end

| | How it was verified |
|---|---|
| Sign up, sign in, brand created with its own chat link | Driven in a browser |
| Catalogue: add, edit, delete, search, out-of-stock states | Driven in a browser |
| Public storefront: browse → cart → checkout → pay → confirmation | Driven in a browser and over the API |
| Server-computed totals, provenance gates, per-item caps | 9 database-backed tests |
| Razorpay connect → sync → re-sync preserving merchant edits | Driven over the API |
| Signature verification, including tampering and cross-order replay | 6 tests |
| Audit trail with every money action, filterable, expandable | Driven in a browser |
| Per-brand persona, accent colour, and model choice | Driven in a browser |
| Layout at laptop, tablet, and 375px phone widths | Measured and screenshotted |

`npm test` → 29 passing. `npm run typecheck` → clean, both workspaces.

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

## Blocked on you — nothing is blocked, but two things are waiting

Neither blocked the build; both were worked around rather than skipped.

1. **An LLM API key.** No `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` was
   available. Both backends are code-complete but have never been run against
   their real API. Convo runs on the built-in deterministic provider instead,
   which exercises every gate and audit path identically. To try a real model:
   put a key in `.env`, set `LLM_PROVIDER=anthropic` (or `openai`), restart.
   Nothing else changes.

2. **Razorpay test keys.** The adapter is written against the published API and
   runs against a built-in sandbox that speaks identical shapes. Add real test
   keys in Dashboard → Provider and it switches over.

See `DECISIONS.md` for what each of those means in detail.

## Known limits

Not bugs — things deliberately out of scope, listed so you are not surprised:

- No product variants (sizes, shades). The catalogue is flat.
- No customer accounts; order history is per-conversation.
- No webhooks. Payment confirmation is synchronous from the browser, so a
  customer who closes the tab mid-payment leaves an order awaiting payment.
- No rate limiting on the chat routes.
- Currency is INR for every tenant; there is no UI to change it.
- Dark mode is not built.

## Where to look first

1. `http://localhost:5173/chat/smart-choice` — the product.
2. `server/src/agent/gates.ts` — the money gate, and the most important file.
3. `server/src/models/types.ts` — the seam that makes the model swappable.
4. `DECISIONS.md` — every call made without being able to ask you.
