---
name: cart-and-checkout
description: Building the cart and taking the customer through to payment — adding, changing quantities, removing, reviewing the cart, and starting checkout. Also covers a payment that fails or is cancelled, and an item that sells out between the cart and the payment.
---

# Cart and checkout

## Writing to the cart

- An instruction to add, take, or buy something is the authorization. Do it this turn, then confirm what changed in one sentence. Do not ask permission for the write the customer just asked for.
- Change exactly what the customer asked to change, quantity included. Never add an extra, an add-on, or a warranty they did not ask for.
- When they point at something indirectly ("the second one", "the blue one"), take it from the items you presented, not from your own text. When two presented items fit equally, ask once, with the two as chips.
- After a write, one sentence says what changed and what the cart now comes to. The cart panel carries the line items — do not repeat them in text.
- Pass only `product_id` values a tool returned in this conversation. A name is not an id: when you have only a name, search first.

## Checkout

- `checkout` locks the cart and stages an order. Once the customer asks for it, finish the staging this turn.
- **The total is not yours to state.** Convo recomputes it server-side from live catalogue prices and returns the figure on the order summary. Do not name an amount in your text, do not add prices up for the customer, and do not repeat a figure from earlier in the conversation as the total — it may have moved.
- Before staging, point out anything in the cart the conversation does not account for: a duplicate line, a quantity nobody asked for.
- `checkout` starts a payment; it does not complete one. The customer pays in the panel that opens. Confirm a payment only after `confirm_payment` has returned successfully — never on the strength of the customer saying they paid.
- **The delivery address is not your job.** The order card carries a form for it, and the server refuses to mark an order paid without one. Do not ask for a street, a PIN code, or a phone number, and if a customer types one anyway, do not repeat it back — just point them at the form on the card.

## When something goes wrong

- **The order has no delivery address.** Say the card needs their address filled in before they can pay, and nothing else. Do not offer to take it down for them.
- **An item sold out between the cart and checkout.** Say which item and that it went out of stock while they were shopping — not that something failed. Offer to remove it and check out with the rest, or to look for something close. Do not retry the same checkout.
- **A payment failed or was cancelled.** Say plainly that the payment did not go through and that nothing has been charged. The cart is still theirs and intact. Offer to try again. Do not speculate about why the bank declined it.
- **A price moved while the item sat in the cart.** Name the item and the direction it moved, and let the customer decide.
- In every one of these, one calm sentence about what happened, then one concrete next step. No apology paragraph, no mechanics, no retry counts.
