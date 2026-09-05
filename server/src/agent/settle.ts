import { audit, carts, orders, products } from "../db/repo.js";
import { transaction } from "../db/index.js";
import type { Order, ProviderType } from "../domain/types.js";

/**
 * The one place an order becomes paid.
 *
 * Two things now reach this: the customer's browser handing back a signed
 * Razorpay result, and Razorpay's own webhook. They must not each carry their
 * own copy of the money rules — a webhook that skipped the amount check, or
 * reserved stock twice, would be a hole nobody notices until the ledger and the
 * warehouse disagree. So both callers verify the payment their own way, and
 * then both call this with the verified figures.
 *
 * It is idempotent by the order's own status. The browser and the webhook race
 * routinely — the customer's tab confirms while Razorpay is already calling —
 * and the second one through must be a no-op, not a second stock reservation.
 */

export type SettleSource = "browser" | "webhook";

export interface SettleResult {
  outcome: "paid" | "already_paid" | "amount_mismatch" | "not_settleable";
  order: Order;
}

export function settleOrder(input: {
  order: Order;
  providerType: ProviderType;
  providerPaymentId: string | null;
  /** What the provider says it actually took, when it says. */
  capturedAmountMinor: number | null;
  source: SettleSource;
  conversationId: string;
  reasoning?: string | null;
}): SettleResult {
  const {
    order,
    providerType,
    providerPaymentId,
    capturedAmountMinor,
    source,
  } = input;

  // Already settled: say so and change nothing. This is the common case for the
  // webhook, and it must not look like a failure.
  if (order.status === "paid") return { outcome: "already_paid", order };

  if (order.status !== "created" && order.status !== "awaiting_payment") {
    return { outcome: "not_settleable", order };
  }

  /*
   * The amount is checked here rather than trusted from either caller. The
   * browser's figure came through a page; the webhook's came from Razorpay but
   * for an order Convo priced. Either way the only number that may settle this
   * order is the one Convo recomputed from live catalogue prices.
   */
  if (
    capturedAmountMinor !== null &&
    capturedAmountMinor !== order.totalAmountMinor
  ) {
    transaction(() => {
      audit.record({
        tenantId: order.tenantId,
        conversationId: input.conversationId,
        cartId: order.cartId,
        orderId: order.id,
        actionType: "payment.failed",
        amountMinor: order.totalAmountMinor,
        currency: order.currency,
        outcome: "failed",
        reasoning: input.reasoning ?? null,
        detail: {
          provider: providerType,
          reason: "captured amount did not match the recorded order total",
          captured_minor: capturedAmountMinor,
          reported_by: source,
        },
      });
    });
    return { outcome: "amount_mismatch", order };
  }

  const paid = transaction(() => {
    // Stock comes off the shelf only once payment is confirmed.
    for (const line of order.lineItems) {
      products.reserveStock(order.tenantId, line.productId, line.quantity);
    }
    const updated = orders.setStatus(order.tenantId, order.id, "paid", {
      providerPaymentId,
      failureReason: null,
    });
    /*
     * The cart is only spent once every brand in the checkout has been paid.
     * With two brands, paying the first must not close the cart the second is
     * still waiting on. `inCheckout` rather than `byCheckout` because a webhook
     * has no customer session to authorise with — it is holding an order that
     * was already matched by provider order id on this brand's own account.
     */
    const siblings = orders.inCheckout(order.checkoutId);
    if (siblings.every((sibling) => sibling.status === "paid")) {
      carts.setStatus(order.cartId, "converted");
    }
    audit.record({
      tenantId: order.tenantId,
      conversationId: input.conversationId,
      cartId: order.cartId,
      orderId: order.id,
      actionType: "payment.confirmed",
      amountMinor: order.totalAmountMinor,
      currency: order.currency,
      outcome: "ok",
      reasoning: input.reasoning ?? null,
      detail: {
        provider: providerType,
        provider_payment_id: providerPaymentId,
        signature_verified: true,
        settled_by: source,
      },
    });
    return updated!;
  });

  return { outcome: "paid", order: paid };
}

/**
 * A payment the provider says failed, recorded against the order.
 *
 * Separate from the browser's decline path: that one is the customer's page
 * relaying what the widget said, and is marked as reported. This is Razorpay
 * telling Convo directly, over a signed channel, which is the difference
 * between hearsay and a fact.
 */
export function recordPaymentFailure(input: {
  order: Order;
  providerType: ProviderType;
  reason: string;
  conversationId: string;
}): void {
  const { order } = input;
  if (order.status === "paid") return; // a failed attempt after capture is noise

  transaction(() => {
    orders.setStatus(order.tenantId, order.id, "failed", {
      failureReason: input.reason,
    });
    audit.record({
      tenantId: order.tenantId,
      conversationId: input.conversationId,
      cartId: order.cartId,
      orderId: order.id,
      actionType: "payment.failed",
      amountMinor: order.totalAmountMinor,
      currency: order.currency,
      outcome: "failed",
      reasoning: null,
      detail: {
        provider: input.providerType,
        reason: input.reason,
        reported_by: "provider_webhook",
      },
    });
  });
}
