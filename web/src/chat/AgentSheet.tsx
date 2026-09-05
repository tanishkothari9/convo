import { useEffect, useState } from "react";
import { IconClose } from "../components/icons";

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
            Sign a budget over, then shop the way you always do. Every checkout
            in this chat is checked against what you signed, and one that falls
            outside it is refused before anything is charged.
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
              <button className="btn btn-primary btn-block" onClick={onClose}>
                Start shopping
              </button>
              <p className="t-xs t-muted agent-hint">
                Ask for what you want in the chat. Products, the cart and the
                payment all appear there as usual.
              </p>
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
    </div>
  );
}
