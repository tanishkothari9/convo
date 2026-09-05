import type { CommerceProviderAdapter } from "../adapter.js";
import {
  ProviderApiError,
  ProviderConfigError,
  type CatalogItem,
  type PaymentCallbackPayload,
  type PaymentOrderHandle,
  type PaymentOrderRequest,
  type PaymentResult,
  type ProviderCredentials,
} from "../types.js";
import { hmacSha256Hex, safeEqualHex } from "../../lib/crypto.js";
import {
  LiveRazorpayApi,
  type RazorpayApi,
  type RazorpayItem,
} from "./client.js";
import { MOCK_KEY_ID, MOCK_KEY_SECRET, mockRazorpay } from "./mock.js";

export interface RazorpayCredentials extends ProviderCredentials {
  keyId?: string;
  keySecret?: string;
}

/**
 * Razorpay as both catalog source and payment processor.
 *
 * Catalog comes from the Items API; payment from the Orders API plus
 * server-side signature verification. A connection saved without a key secret
 * runs against the mock API, which speaks identical shapes.
 */
export class RazorpayAdapter implements CommerceProviderAdapter {
  readonly type = "razorpay";
  readonly displayName = "Razorpay";
  readonly capabilities = { catalog: true, payment: true };

  /** Live client when credentials are present, mock otherwise. */
  private api(credentials: RazorpayCredentials): {
    api: RazorpayApi;
    keyId: string;
    keySecret: string;
  } {
    const keyId = credentials.keyId?.trim();
    const keySecret = credentials.keySecret?.trim();
    if (keyId && keySecret) {
      if (keyId.startsWith("rzp_live_")) {
        throw new ProviderConfigError(
          "Convo accepts Razorpay test keys only. Use a key id beginning rzp_test_.",
        );
      }
      return { api: new LiveRazorpayApi(keyId, keySecret), keyId, keySecret };
    }
    return {
      api: mockRazorpay,
      keyId: MOCK_KEY_ID,
      keySecret: MOCK_KEY_SECRET,
    };
  }

  async verifyCredentials(
    credentials: RazorpayCredentials,
  ): Promise<{ ok: true; detail: string }> {
    const { api } = this.api(credentials);
    if (api.isMock) {
      return {
        ok: true,
        detail:
          "Connected to the Razorpay test sandbox built into Convo. Add test keys to use your own account.",
      };
    }
    // One cheap authenticated read tells us the key pair is valid.
    const collection = await api.fetchItems({ count: 1 });
    return {
      ok: true,
      detail: `Razorpay test account reachable. ${collection.count === 0 ? "No items published yet." : "Items API responding."}`,
    };
  }

  async fetchCatalog(credentials: RazorpayCredentials): Promise<CatalogItem[]> {
    const { api } = this.api(credentials);
    const collected: RazorpayItem[] = [];
    // The Items API caps a page at 100; page until it returns a short page.
    for (let skip = 0; skip < 1000; skip += 100) {
      const page = await api.fetchItems({ count: 100, skip, active: 1 });
      collected.push(...page.items);
      if (page.items.length < 100) break;
    }

    return collected
      .filter((item) => item.active)
      .map((item) => ({
        providerNativeId: item.id,
        name: item.name,
        description: item.description,
        // `unit_amount` is the per-unit price; `amount` matches it for a
        // single-unit item. Convo bills per unit, so unit_amount wins.
        priceMinor: item.unit_amount ?? item.amount,
        currency: item.currency,
        images: [],
        // Razorpay Items carry no inventory. Convo treats a synced item as
        // available and lets the merchant set real stock in the dashboard;
        // STOCK_UNTRACKED keeps it out of the out-of-stock path.
        stock: STOCK_UNTRACKED,
        category: null,
        attributes: {
          ...(item.hsn_code ? { "HSN code": item.hsn_code } : {}),
          ...(item.tax_inclusive ? { Tax: "inclusive" } : {}),
        },
      }));
  }

  async createPaymentOrder(
    credentials: RazorpayCredentials,
    request: PaymentOrderRequest,
  ): Promise<PaymentOrderHandle> {
    const { api, keyId } = this.api(credentials);
    // `amount` is passed through exactly as Convo computed it. Razorpay
    // amounts are already in the smallest currency sub-unit, as ours are.
    const order = await api.createOrder({
      amount: request.amountMinor,
      currency: request.currency,
      receipt: request.receipt.slice(0, 40),
      notes: {
        convo_order: request.receipt,
        line_count: String(request.lines.length),
        ...request.notes,
      },
    });

    if (order.amount !== request.amountMinor) {
      throw new ProviderApiError(
        "Razorpay acknowledged a different amount than Convo asked for; the payment was not started.",
      );
    }

    return {
      provider: this.type,
      providerOrderId: order.id,
      amountMinor: order.amount,
      currency: order.currency,
      publicKey: keyId,
      isMock: api.isMock,
      checkout: {
        // The field names Razorpay's checkout.js options object expects.
        order_id: order.id,
        amount: order.amount,
        currency: order.currency,
        receipt: order.receipt,
      },
    };
  }

  /**
   * Verifies a completed payment.
   *
   * Per Razorpay's guidance the order id signed here is the one Convo holds on
   * its own order record, never the `razorpay_order_id` the browser reported —
   * the caller passes it as `expectedOrderId`. The signature is
   * HMAC-SHA256(order_id + "|" + payment_id) keyed with the account secret,
   * compared in constant time. The live path then re-reads the payment from
   * Razorpay so a valid signature over an uncaptured payment is still refused.
   */
  async verifyPayment(
    credentials: RazorpayCredentials,
    payload: PaymentCallbackPayload,
  ): Promise<PaymentResult> {
    const { api, keySecret } = this.api(credentials);
    const paymentId = asString(payload.razorpay_payment_id);
    const reportedOrderId = asString(payload.razorpay_order_id);
    const signature = asString(payload.razorpay_signature);
    const expectedOrderId =
      asString(payload.expectedOrderId) ?? reportedOrderId;

    const refuse = (reason: string): PaymentResult => ({
      verified: false,
      providerPaymentId: paymentId,
      providerOrderId: expectedOrderId,
      capturedAmountMinor: null,
      failureReason: reason,
    });

    if (!paymentId || !signature || !expectedOrderId) {
      return refuse("The payment confirmation was incomplete.");
    }
    if (reportedOrderId && reportedOrderId !== expectedOrderId) {
      return refuse("The payment confirmation referenced a different order.");
    }

    const expected = hmacSha256Hex(
      keySecret,
      `${expectedOrderId}|${paymentId}`,
    );
    if (!safeEqualHex(expected, signature)) {
      return refuse("The payment signature did not verify.");
    }

    // Signature good. Confirm with Razorpay that the money actually moved.
    try {
      const payment = await api.fetchPayment(paymentId);
      if (payment.order_id !== expectedOrderId) {
        return refuse("The payment belongs to a different order.");
      }
      if (payment.status !== "captured" && payment.status !== "authorized") {
        return refuse(
          payment.error_description ?? "The payment did not complete.",
        );
      }
      return {
        verified: true,
        providerPaymentId: payment.id,
        providerOrderId: payment.order_id,
        capturedAmountMinor: payment.amount,
        failureReason: null,
      };
    } catch (error) {
      if (error instanceof ProviderApiError) {
        return refuse("Convo could not confirm the payment with Razorpay.");
      }
      throw error;
    }
  }
}

/**
 * Stock level meaning "this provider does not track inventory". Large enough
 * never to trip the out-of-stock path, and recognisable in the dashboard.
 */
export const STOCK_UNTRACKED = 999_999;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
