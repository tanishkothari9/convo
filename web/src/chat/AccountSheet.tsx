import { useEffect, useState } from "react";
import { IconClose } from "../components/icons";

/**
 * Signing in as a shopper, and what they have bought.
 *
 * A shopper is an anonymous customer session until they make an account, which
 * is why there was nowhere to see an order after the transcript scrolled past
 * it. An account is really just a named, password-protected version of that
 * same session, so signing in brings the carts, chats and orders that belong to
 * it and every other screen keeps working unchanged.
 *
 * The orders list is deliberately the whole point of the panel rather than an
 * afterthought under a form: it is the thing that did not exist before.
 */

interface Order {
  order_id: string;
  brand_name: string | null;
  status: string;
  total_display: string;
  placed_at: string;
  by_agent: boolean;
  line_items: Array<{ name: string; quantity: number }>;
}

interface Shopper {
  email: string;
  name: string | null;
}

const STATUS: Record<string, string> = {
  paid: "Paid",
  awaiting_payment: "Awaiting payment",
  created: "Awaiting payment",
  cancelled: "Cancelled",
  failed: "Failed",
};

export function AccountSheet({
  onClose,
  onSignedIn,
}: {
  onClose(): void;
  onSignedIn(): void;
}) {
  const [shopper, setShopper] = useState<Shopper | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const load = async () => {
    const who = await fetch("/api/shop/account", { credentials: "same-origin" })
      .then((r) => r.json())
      .catch(() => ({ shopper: null }));
    setShopper(who.shopper);
    if (who.shopper) {
      const list = await fetch("/api/shop/orders", {
        credentials: "same-origin",
      })
        .then((r) => r.json())
        .catch(() => ({ orders: [] }));
      setOrders(list.orders ?? []);
    }
    setReady(true);
  };

  useEffect(() => {
    void load();
  }, []);

  async function submit(path: "login" | "signup") {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/shop/account/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email, password }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "That did not work.");
      setPassword("");
      await load();
      // The cookie now points at a different session, so the page's cart and
      // chat list are somebody else's until they are refetched.
      onSignedIn();
    } catch (problem) {
      setError(
        problem instanceof Error ? problem.message : "That did not work.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    await fetch("/api/shop/account/logout", {
      method: "POST",
      credentials: "same-origin",
    });
    setShopper(null);
    setOrders([]);
    setBusy(false);
    onSignedIn();
  }

  return (
    <div
      className="account-layer"
      role="dialog"
      aria-modal="true"
      aria-label="Your account"
    >
      <button
        className="cart-scrim"
        onClick={onClose}
        aria-label="Close"
        tabIndex={-1}
      />
      <div className="account-sheet">
        <header className="cart-sheet-head">
          <h2 className="t-heading">{shopper ? "Your orders" : "Sign in"}</h2>
          <button
            className="chat-head-btn"
            onClick={onClose}
            aria-label="Close"
          >
            <IconClose size={18} />
          </button>
        </header>

        <div className="account-body">
          {!ready ? null : shopper ? (
            <>
              <p className="t-sm t-secondary">
                Signed in as {shopper.name ?? shopper.email}.
              </p>

              {orders.length === 0 ? (
                <div className="empty">
                  <p className="empty-title">Nothing bought yet</p>
                  <p className="empty-body">
                    Ask for something in the chat, and what you buy shows up
                    here.
                  </p>
                </div>
              ) : (
                <ul className="account-orders">
                  {orders.map((order) => (
                    <li key={order.order_id} className="account-order">
                      <div className="account-order-top">
                        <span className="t-sm">{order.brand_name}</span>
                        <span className="t-sm t-num">
                          {order.total_display}
                        </span>
                      </div>
                      <p className="t-xs t-muted">
                        {order.line_items
                          .map((line) => `${line.quantity} × ${line.name}`)
                          .join(", ")}
                      </p>
                      <div className="account-order-foot">
                        <span
                          className="account-status"
                          data-status={order.status}
                        >
                          {STATUS[order.status] ?? order.status}
                        </span>
                        {/* Worth surfacing: a shopper should be able to tell
                            which purchases they made and which an agent made
                            on their behalf. */}
                        {order.by_agent && (
                          <span className="t-xs t-muted">
                            bought by an agent
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <>
              <p className="t-sm t-secondary">
                Sign in to keep your orders and your chats across devices.
              </p>
              <label className="account-field">
                <span className="t-sm">Email</span>
                <input
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={busy}
                />
              </label>
              <label className="account-field">
                <span className="t-sm">Password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={busy}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void submit("login");
                  }}
                />
              </label>
              {error && <p className="notice notice-danger">{error}</p>}
            </>
          )}
        </div>

        <div className="account-actions">
          {shopper ? (
            <button
              className="btn btn-ghost btn-block"
              onClick={signOut}
              disabled={busy}
            >
              Sign out
            </button>
          ) : (
            <>
              <button
                className="btn btn-primary btn-block"
                onClick={() => submit("login")}
                disabled={busy || !email || !password}
              >
                {busy ? "Signing in…" : "Sign in"}
              </button>
              <button
                className="btn btn-ghost btn-block"
                onClick={() => submit("signup")}
                disabled={busy || !email || password.length < 8}
              >
                Create an account
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
