/**
 * A stand-in for the Razorpay REST API.
 *
 * It speaks the same endpoints, parameter names, and response objects as the
 * live client, so `RazorpayAdapter` cannot tell the two apart and swapping in
 * real test keys is a config change. It is selected only when a tenant's
 * Razorpay connection has no key secret; a connection with real credentials
 * always goes to the live API.
 *
 * Signatures are computed with the same HMAC-SHA256 construction Razorpay
 * uses, so the server-side verification path exercised here is the real one.
 */
import { createHmac, randomBytes } from "node:crypto";
import type {
  RazorpayApi,
  RazorpayItem,
  RazorpayItemCollection,
  RazorpayOrder,
  RazorpayPayment,
} from "./client.js";
import { ProviderApiError } from "../types.js";

export const MOCK_KEY_ID = "rzp_test_convomock000000";
export const MOCK_KEY_SECRET = "convo_mock_secret_do_not_use_in_production";

function rzpId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url").replace(/[-_]/g, "").slice(0, 14)}`;
}

const unix = () => Math.floor(Date.now() / 1000);

/**
 * The catalog the mock serves. Shaped exactly like `GET /v1/items` output.
 * A merchant who connects real Razorpay test keys gets their own items instead.
 */
const MOCK_ITEMS: RazorpayItem[] = [
  [
    "Banarasi Silk Saree — Deep Maroon",
    "Handwoven Banarasi silk with a real zari border and a matching blouse piece.",
    1249900,
  ],
  [
    "Chanderi Cotton-Silk Saree — Sage",
    "Feather-light Chanderi weave with fine gold-thread butti across the body.",
    689900,
  ],
  [
    "Kanjivaram Silk Saree — Violet and Gold",
    "Pure mulberry silk from Kanchipuram with a contrast temple border.",
    1899900,
  ],
  [
    "Linen Saree — Ivory",
    "Pure linen with a fine silver border. Softens with every wash.",
    349900,
  ],
  [
    "Anarkali Kurta Set — Ivory Chikankari",
    "Hand-embroidered Lucknowi chikankari on cotton mul, with churidar and dupatta.",
    549900,
  ],
  [
    "Sharara Set — Wine Georgette",
    "Thread-worked georgette kurta with a flared sharara and scalloped dupatta.",
    799900,
  ],
  [
    "Straight Kurta — Indigo Block Print",
    "Hand-block printed cotton in natural indigo. Gets softer with each wash.",
    189900,
  ],
  [
    "Cotton Silk Kurta — Olive",
    "Structured cotton-silk with a mandarin collar and side slits.",
    249900,
  ],
  [
    "Bandhani Dupatta — Ruby",
    "Kutch bandhani tied by hand, on a soft georgette base.",
    179900,
  ],
  [
    "Juttis — Teal Embroidered",
    "Hand-embroidered juttis with silver thread and a cushioned sole.",
    219900,
  ],
].map(([name, description, amount], index) => ({
  id: `item_convomock${String(index + 1).padStart(6, "0")}`,
  active: true,
  name: name as string,
  description: description as string,
  amount: amount as number,
  unit_amount: amount as number,
  currency: "INR",
  type: "invoice",
  unit: null,
  // Razorpay Items carry no imagery, no category, and no inventory. That is
  // exactly why a merchant still edits a synced catalogue in Convo, and why
  // `replaceSynced` preserves what they filled in.
  tax_inclusive: true,
  hsn_code: null,
  sac_code: null,
  tax_rate: null,
  tax_id: null,
  tax_group_id: null,
  created_at: unix(),
}));

/** Orders and payments the mock has issued, for the lifetime of the process. */
const orders = new Map<string, RazorpayOrder>();
const payments = new Map<string, RazorpayPayment>();

export class MockRazorpayApi implements RazorpayApi {
  readonly isMock = true;

  async fetchItems(
    params: { count?: number; skip?: number; active?: 1 | 0 } = {},
  ) {
    const skip = params.skip ?? 0;
    const count = Math.min(params.count ?? 100, 100);
    const filtered =
      params.active === undefined
        ? MOCK_ITEMS
        : MOCK_ITEMS.filter((i) => i.active === (params.active === 1));
    const items = filtered.slice(skip, skip + count);
    return {
      entity: "collection",
      count: items.length,
      items,
    } satisfies RazorpayItemCollection;
  }

  async createOrder(body: {
    amount: number;
    currency: string;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<RazorpayOrder> {
    if (!Number.isInteger(body.amount) || body.amount < 100) {
      // Razorpay's own minimum for INR is 100 paise.
      throw new ProviderApiError(
        "Order amount must be at least ₹1.",
        400,
        "BAD_REQUEST_ERROR",
      );
    }
    const order: RazorpayOrder = {
      id: rzpId("order"),
      entity: "order",
      amount: body.amount,
      amount_paid: 0,
      amount_due: body.amount,
      currency: body.currency,
      receipt: body.receipt,
      offer_id: null,
      status: "created",
      attempts: 0,
      notes: body.notes ?? {},
      created_at: unix(),
    };
    orders.set(order.id, order);
    return order;
  }

  async fetchOrder(orderId: string): Promise<RazorpayOrder> {
    const order = orders.get(orderId);
    if (!order)
      throw new ProviderApiError(
        "The id provided does not exist",
        400,
        "BAD_REQUEST_ERROR",
      );
    return order;
  }

  async fetchPayment(paymentId: string): Promise<RazorpayPayment> {
    const payment = payments.get(paymentId);
    if (!payment)
      throw new ProviderApiError(
        "The id provided does not exist",
        400,
        "BAD_REQUEST_ERROR",
      );
    return payment;
  }

  // ── Test-mode checkout ────────────────────────────────────────────────────
  // The live equivalent of this is Razorpay's hosted checkout widget. Convo's
  // mock checkout route calls it to produce the same three fields the real
  // widget hands back: razorpay_order_id, razorpay_payment_id, razorpay_signature.

  /** Simulates the customer completing (or failing) payment on the widget. */
  settle(
    orderId: string,
    outcome: "success" | "failure",
  ): { paymentId: string; signature: string } | { failure: string } {
    const order = orders.get(orderId);
    if (!order)
      throw new ProviderApiError(
        "The id provided does not exist",
        400,
        "BAD_REQUEST_ERROR",
      );
    order.attempts += 1;

    if (outcome === "failure") {
      const payment: RazorpayPayment = {
        id: rzpId("pay"),
        entity: "payment",
        amount: order.amount,
        currency: order.currency,
        status: "failed",
        order_id: order.id,
        method: "card",
        captured: false,
        error_code: "BAD_REQUEST_ERROR",
        error_description: "Payment was declined by the issuing bank.",
        created_at: unix(),
      };
      payments.set(payment.id, payment);
      return { failure: payment.error_description! };
    }

    const payment: RazorpayPayment = {
      id: rzpId("pay"),
      entity: "payment",
      amount: order.amount,
      currency: order.currency,
      status: "captured",
      order_id: order.id,
      method: "upi",
      captured: true,
      error_code: null,
      error_description: null,
      created_at: unix(),
    };
    payments.set(payment.id, payment);
    order.status = "paid";
    order.amount_paid = order.amount;
    order.amount_due = 0;

    // The same construction Razorpay signs with: order_id|payment_id.
    const signature = createHmac("sha256", MOCK_KEY_SECRET)
      .update(`${order.id}|${payment.id}`)
      .digest("hex");
    return { paymentId: payment.id, signature };
  }
}

export const mockRazorpay = new MockRazorpayApi();
