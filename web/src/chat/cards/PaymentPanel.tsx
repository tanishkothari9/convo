import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import type { CheckoutOrder } from "../types";

interface RazorpayInstance {
  open(): void;
  close(): void;
  /** Razorpay reports a declined payment here; there is no other route to it. */
  on(event: string, handler: (payload: RazorpayFailure) => void): void;
}

interface RazorpayFailure {
  error?: {
    description?: string;
    reason?: string;
    step?: string;
    source?: string;
    metadata?: { order_id?: string; payment_id?: string };
  };
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

interface Props {
  payload: CheckoutOrder;
  /** Who is paying, so Razorpay can pre-fill and offer the right methods. */
  customer?: { name: string; phone: string } | null;
  onCancel(declineReason?: string): void;
  onResult(result: Record<string, unknown>): void;
}

/**
 * Where the customer pays.
 *
 * With live Razorpay credentials this hands off to Razorpay's own hosted
 * checkout: Convo never sees a card number, and the three fields the widget
 * returns go straight back to the server to be verified.
 *
 * Without them it renders Convo's test panel, which produces the same three
 * fields, signed with the same HMAC construction — so the verification the
 * server runs afterwards is the production path either way.
 */
export function PaymentPanel({ payload, customer, onCancel, onResult }: Props) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  /** The provider's reason, when there was one, for the trip back to the server. */
  const declined = useRef<string | null>(null);
  const live = !payload.payment.is_mock && Boolean(payload.payment.public_key);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  // Live Razorpay: open the hosted widget rather than Convo's panel.
  useEffect(() => {
    if (!live) return;
    let cancelled = false;

    async function open() {
      await loadRazorpayScript();
      if (cancelled || !window.Razorpay) {
        setFailed(
          "The payment window could not be opened. Try again in a moment.",
        );
        return;
      }
      /*
       * A payment that failed is not a payment that was cancelled.
       *
       * Razorpay's widget reports a decline through `payment.failed` and
       * nothing else — the modal then closes, which fires `ondismiss`. Without
       * a listener the two are indistinguishable, so every declined card was
       * being recorded as "the customer closed the payment panel" and the
       * customer was told nothing about why. `dismissed` below keeps the
       * dismissal from overwriting a reason we already have.
       */
      let dismissed = false;

      const checkout = new window.Razorpay({
        key: payload.payment.public_key,
        order_id: payload.payment.provider_order_id,
        amount: payload.payment.amount_minor,
        currency: payload.payment.currency,
        // The brand's name, not Convo's: the customer is paying the shop
        // that made the thing, and the panel should say so.
        name: payload.brand_name,
        description: `Order ${payload.order_id}`,
        /*
         * Razorpay filters the methods it offers by what it knows about the
         * payer — a UPI flow with no contact number is one of the ways a
         * checkout ends up saying "use another payment method". Convo already
         * asked for both of these on the order card, so there is no reason to
         * make the customer type them again.
         */
        ...(customer
          ? {
              prefill: { name: customer.name, contact: `+91${customer.phone}` },
            }
          : {}),
        theme: { color: "#1b6b54" },
        handler: (response: Record<string, unknown>) => onResult(response),
        modal: {
          ondismiss: () => {
            if (dismissed) return;
            dismissed = true;
            onCancel();
          },
        },
      });

      checkout.on("payment.failed", (event) => {
        dismissed = true;
        const error = event?.error;
        // Kept for the Close button below, which is what tells the server. The
        // provider's own words go with it, so the brand's audit trail records a
        // decline rather than a shrug.
        declined.current =
          error?.description ?? "The payment provider declined it.";
        setFailed(
          error?.description ||
            "The payment did not go through. Nothing has been charged; try another method.",
        );
        checkout.close();
      });

      checkout.open();
    }

    void open();
    return () => {
      cancelled = true;
    };
  }, [live, payload, customer, onResult, onCancel]);

  async function settle(outcome: "success" | "failure") {
    setBusy(true);
    setFailed(null);
    try {
      const result = await api.post<{
        ok: boolean;
        payload: Record<string, unknown>;
      }>(`/shop/orders/${payload.order_id}/test-pay`, { outcome });
      if (!result.ok) {
        // The provider declined. The server still has to say so, not this page.
        onResult({ ...result.payload, declined: true });
        return;
      }
      onResult(result.payload);
    } catch {
      setBusy(false);
      setFailed("Could not reach the payment provider. Try again.");
    }
  }

  if (live) {
    return failed ? (
      <div className="pay-layer">
        <div className="pay-panel">
          <p className="notice notice-danger">{failed}</p>
          <button
            className="btn btn-secondary btn-block"
            onClick={() => onCancel(declined.current ?? undefined)}
          >
            Close
          </button>
        </div>
      </div>
    ) : null;
  }

  return (
    <div
      className="pay-layer"
      role="dialog"
      aria-modal="true"
      aria-label="Payment"
    >
      <button
        className="pay-scrim"
        onClick={busy ? undefined : () => onCancel()}
        aria-label="Cancel payment"
        tabIndex={-1}
      />
      <div className="pay-panel">
        <header className="pay-head">
          <p className="t-sm t-muted">
            {payload.brand_name} · {payload.payment.provider_label} · test mode
          </p>
          <p className="pay-amount t-num">{payload.total_display}</p>
          <p className="t-sm t-secondary">
            Order <span className="t-id">{payload.order_id}</span>
          </p>
        </header>

        <p className="notice">
          No money moves here. Convo signs the result the way a live provider
          does, and the server verifies that signature before the order is
          marked paid.
        </p>

        {failed && <p className="notice notice-danger">{failed}</p>}

        <div className="pay-actions">
          <button
            className="btn btn-primary btn-lg btn-block"
            onClick={() => settle("success")}
            disabled={busy}
          >
            {busy && <span className="spinner" />}
            Pay {payload.total_display}
          </button>
          <button
            className="btn btn-secondary btn-block"
            onClick={() => settle("failure")}
            disabled={busy}
          >
            Simulate a declined payment
          </button>
          <button
            className="btn btn-ghost btn-block"
            onClick={() => onCancel()}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

let scriptPromise: Promise<void> | null = null;

function loadRazorpayScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve();
    script.onerror = () => resolve();
    document.head.appendChild(script);
  });
  return scriptPromise;
}
