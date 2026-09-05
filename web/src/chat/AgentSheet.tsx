import { useEffect, useState } from "react";
import { IconClose } from "../components/icons";
import { PaymentPanel } from "./cards/PaymentPanel";
import type { CheckoutOrder } from "./types";

/**
 * Authorising an agent to spend, and then watching it try.
 *
 * The mandate work is otherwise invisible: it lives entirely in `/v1/agent`,
 * and the only way to show it is a terminal. That is the weakest possible way
 * to demonstrate the most distinctive thing here, so this panel does it on
 * screen — set a budget, tick the brands, sign, then watch an agent shop
 * against it and watch the budget fall.
 *
 * The refusal is the half that matters. Untick a brand and run it again, and
 * the checkout comes back `merchant_not_allowed` with nothing charged. A gate
 * you can see refuse something is worth more than a paragraph saying it would.
 *
 * Honest about what it is: Convo calling its own agent API from the browser to
 * stand in for an outside agent. The endpoints, the signature check and the
 * constraint check are the real ones — only the caller is local.
 */

interface Brand {
  id: string;
  name: string;
}

interface Step {
  label: string;
  detail?: string;
  tone: "run" | "ok" | "refused";
}

const rupees = (minor: number) => `₹${(minor / 100).toLocaleString("en-IN")}`;

export function AgentSheet({ onClose }: { onClose(): void }) {
  const [brands, setBrands] = useState<Brand[]>([]);
  const [allowed, setAllowed] = useState<Set<string>>(new Set());
  const [budget, setBudget] = useState(8000);
  const [mandate, setMandate] = useState<{
    token: string;
    session: string;
  } | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [spent, setSpent] = useState(0);
  const [busy, setBusy] = useState(false);
  /* What the agent placed, so whoever authorised it can actually pay. */
  const [placed, setPlaced] = useState<CheckoutOrder[]>([]);
  const [paying, setPaying] = useState<CheckoutOrder | null>(null);
  const [paid, setPaid] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The brands come off the agent catalogue itself, so the list is exactly what
  // an outside agent would be able to see.
  useEffect(() => {
    fetch("/v1/agent/catalog?limit=50", {
      headers: { Authorization: "Bearer discover" },
    })
      .then((r) => r.json())
      .then(
        (data: {
          products: Array<{ brand_id: string; brand_name: string }>;
        }) => {
          const unique = new Map<string, string>();
          for (const product of data.products)
            unique.set(product.brand_id, product.brand_name);
          const list = [...unique].map(([id, name]) => ({ id, name }));
          setBrands(list);
          setAllowed(new Set(list.map((brand) => brand.id)));
        },
      )
      .catch(() => setError("Could not read the catalogue."));
  }, []);

  const say = (step: Step) => setSteps((current) => [...current, step]);

  async function authorise() {
    setBusy(true);
    setError(null);
    setSteps([]);
    setSpent(0);
    try {
      const response = await fetch("/v1/agent/mandates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: "demo-buyer",
          budgetMinor: budget * 100,
          allowedBrandIds: [...allowed],
          ttlSeconds: 3600,
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error ?? "Could not sign that mandate.");
      setMandate({ token: data.mandate, session: data.session_token });
      say({
        label: "Mandate signed",
        detail: `${rupees(budget * 100)} at ${[...allowed].length} brand${
          allowed.size === 1 ? "" : "s"
        }, ES256`,
        tone: "ok",
      });
    } catch (problem) {
      setError(
        problem instanceof Error ? problem.message : "Something went wrong.",
      );
    } finally {
      setBusy(false);
    }
  }

  /** One product from each brand on the shelf, then a checkout. */
  async function run() {
    if (!mandate) return;
    setBusy(true);
    setError(null);
    const auth = {
      Authorization: `Bearer ${mandate.session}`,
      "Content-Type": "application/json",
    };

    try {
      say({ label: "Searching the shelf", tone: "run" });
      const catalog = await fetch("/v1/agent/catalog?limit=50", {
        headers: auth,
      }).then((r) => r.json());

      // One from each brand that exists, whether or not the mandate allows it —
      // picking only allowed brands would hide the refusal this is here to show.
      const perBrand = new Map<
        string,
        { id: string; name: string; brand_name: string }
      >();
      for (const product of catalog.products as Array<{
        id: string;
        name: string;
        brand_id: string;
        brand_name: string;
        in_stock: boolean;
      }>) {
        if (product.in_stock && !perBrand.has(product.brand_id)) {
          perBrand.set(product.brand_id, product);
        }
      }

      for (const product of perBrand.values()) {
        const added = await fetch("/v1/agent/cart", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ productId: product.id, quantity: 1 }),
        }).then((r) => r.json());
        say({
          label: `Added ${product.name}`,
          detail: product.brand_name,
          tone: added.ok ? "run" : "refused",
        });
      }

      say({ label: "Checking out against the mandate", tone: "run" });
      const result = await fetch("/v1/agent/checkout", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ mandate: mandate.token }),
      }).then((r) => r.json());

      if (result.ok) {
        const orders = result.checkout.orders as CheckoutOrder[];
        setPlaced(orders);
        const total = (
          result.checkout.orders as Array<{ total_minor?: number }>
        ).reduce((sum, order) => sum + (order.total_minor ?? 0), 0);
        setSpent(total);
        for (const order of orders) {
          say({
            label: `Order placed · ${order.brand_name}`,
            detail: `${order.total_display} · awaiting payment`,
            tone: "ok",
          });
        }
      } else {
        say({
          label: "Refused",
          detail: String(result.reason ?? "").replace(/^\[held: \w+\]\s*/, ""),
          tone: "refused",
        });
      }
    } catch (problem) {
      setError(
        problem instanceof Error ? problem.message : "The agent run failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  const remaining = Math.max(0, budget * 100 - spent);
  const used = budget > 0 ? Math.min(100, (spent / (budget * 100)) * 100) : 0;

  return (
    <div
      className="agent-layer"
      role="dialog"
      aria-modal="true"
      aria-label="Authorise an agent"
    >
      <button
        className="cart-scrim"
        onClick={onClose}
        aria-label="Close"
        tabIndex={-1}
      />
      <div className="agent-sheet">
        <header className="cart-sheet-head">
          <h2 className="t-heading">Let an agent shop for you</h2>
          <button
            className="chat-head-btn"
            onClick={onClose}
            aria-label="Close"
          >
            <IconClose size={18} />
          </button>
        </header>

        <div className="agent-body">
          <p className="t-sm t-secondary">
            Sign a budget over to an AI agent and watch it spend against it. The
            signature and the limits are checked server-side; only the agent
            itself is standing in for an outside one.
          </p>

          <label className="agent-field">
            <span className="t-sm">Budget</span>
            <input
              type="number"
              min={100}
              step={500}
              value={budget}
              onChange={(event) =>
                setBudget(Math.max(0, Number(event.target.value)))
              }
              disabled={busy || Boolean(mandate)}
            />
          </label>

          <div className="agent-field">
            <span className="t-sm">It may buy from</span>
            <div className="agent-brands">
              {brands.map((brand) => (
                <label key={brand.id} className="agent-brand">
                  <input
                    type="checkbox"
                    checked={allowed.has(brand.id)}
                    disabled={busy || Boolean(mandate)}
                    onChange={(event) =>
                      setAllowed((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(brand.id);
                        else next.delete(brand.id);
                        return next;
                      })
                    }
                  />
                  {brand.name}
                </label>
              ))}
            </div>
            {allowed.size < brands.length && (
              <p className="t-xs t-muted">
                A cart touching an unticked brand is refused, even if the budget
                covers it.
              </p>
            )}
          </div>

          {mandate && (
            <div className="agent-budget">
              <div className="agent-budget-bar">
                <span style={{ width: `${used}%` }} />
              </div>
              <p className="t-xs t-muted t-num">
                {rupees(spent)} spent · {rupees(remaining)} left
              </p>
            </div>
          )}

          {steps.length > 0 && (
            <ol className="agent-steps">
              {steps.map((step, index) => (
                <li key={`${step.label}-${index}`} data-tone={step.tone}>
                  <span className="agent-step-label">{step.label}</span>
                  {step.detail && (
                    <span className="t-xs t-muted">{step.detail}</span>
                  )}
                </li>
              ))}
            </ol>
          )}

          {placed.length > 0 && (
            <div className="agent-pay">
              <p className="t-sm">
                {paid.size === placed.length
                  ? "All paid."
                  : "The agent placed these. Paying is still yours."}
              </p>
              {placed.map((order) => (
                <div key={order.order_id} className="agent-pay-row">
                  <span className="t-sm">
                    {order.brand_name}
                    <span className="t-xs t-muted">
                      {" "}
                      · {order.total_display}
                    </span>
                  </span>
                  {paid.has(order.order_id) ? (
                    <span className="t-xs t-muted">Paid</span>
                  ) : (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => setPaying(order)}
                    >
                      Pay
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {error && <p className="notice notice-danger">{error}</p>}
        </div>

        <div className="agent-actions">
          {!mandate ? (
            <button
              className="btn btn-primary btn-block"
              onClick={authorise}
              disabled={busy || allowed.size === 0}
            >
              {busy ? "Signing…" : "Sign the mandate"}
            </button>
          ) : (
            <>
              <button
                className="btn btn-primary btn-block"
                onClick={run}
                disabled={busy}
              >
                {busy ? "The agent is shopping…" : "Send the agent shopping"}
              </button>
              <button
                className="btn btn-ghost btn-block"
                onClick={() => {
                  setMandate(null);
                  setSteps([]);
                  setSpent(0);
                }}
                disabled={busy}
              >
                Change the limits
              </button>
            </>
          )}
        </div>
      </div>

      {/* The same panel the chat uses. It works here because the mandate was
          issued against this browser's own session, so the orders the agent
          placed are this shopper's orders. */}
      {paying && (
        <PaymentPanel
          payload={paying}
          onCancel={() => setPaying(null)}
          onResult={async (result) => {
            const order = paying;
            setPaying(null);
            if (!order) return;
            try {
              const outcome = await fetch(
                `/api/shop/orders/${order.order_id}/confirm`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  credentials: "same-origin",
                  body: JSON.stringify(result),
                },
              ).then((r) => r.json());
              if (outcome.paid) {
                setPaid((current) => new Set(current).add(order.order_id));
                say({
                  label: `Paid · ${order.brand_name}`,
                  detail: order.total_display,
                  tone: "ok",
                });
              } else {
                say({
                  label: `Payment failed · ${order.brand_name}`,
                  detail: outcome.reason,
                  tone: "refused",
                });
              }
            } catch {
              setError("Could not confirm that payment.");
            }
          }}
        />
      )}
    </div>
  );
}
