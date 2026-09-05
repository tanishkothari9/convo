import { useEffect } from "react";
import type { CartPayload } from "./types";

/**
 * The cart, as a sheet.
 *
 * A sheet rather than a persistent panel so the same thing happens at every
 * width — on a phone there is no room for a column beside the conversation,
 * and a layout that only exists on a laptop is a layout you have not designed.
 */
export function CartSheet({
  cart,
  onClose,
  onAsk,
  busy,
}: {
  cart: CartPayload;
  onClose(): void;
  onAsk(text: string): void;
  busy: boolean;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const empty = cart.lines.length === 0;

  return (
    <div
      className="cart-layer"
      role="dialog"
      aria-modal="true"
      aria-label="Your cart"
    >
      <button
        className="cart-scrim"
        onClick={onClose}
        aria-label="Close cart"
        tabIndex={-1}
      />
      <div className="cart-sheet">
        <header className="cart-sheet-head">
          <h2 className="t-heading">Your cart</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Close
          </button>
        </header>

        {empty ? (
          <div className="cart-sheet-body">
            <div className="empty">
              <p className="empty-title">Nothing in here yet</p>
              <p className="empty-body">
                Ask for something and it will show up here as you go.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="cart-sheet-body">
              <ul className="cart-lines">
                {cart.lines.map((line) => (
                  <li key={line.product_id} className="cart-line">
                    <div className="cart-thumb">
                      {line.image_url ? (
                        <img src={line.image_url} alt="" loading="lazy" />
                      ) : null}
                    </div>
                    <div className="cart-line-main">
                      <p className="cart-line-brand t-xs">{line.brand_name}</p>
                      <p className="cart-line-name">{line.name}</p>
                      <p className="t-sm t-muted t-num">
                        {line.quantity} × {line.unit_price_display}
                      </p>
                      {!line.in_stock && (
                        <p className="t-sm cart-line-flag">
                          {line.available_stock === 0
                            ? "Out of stock — checkout will stop until this is removed"
                            : `Only ${line.available_stock} left`}
                        </p>
                      )}
                      {line.price_changed && (
                        <p className="t-sm t-muted">
                          The price has changed since you added this.
                        </p>
                      )}
                    </div>
                    <div className="cart-line-end">
                      <p className="cart-line-total t-num">
                        {line.line_total_display}
                      </p>
                      <button
                        className="cart-line-remove t-sm"
                        disabled={busy}
                        onClick={() =>
                          onAsk(`Remove "${line.name}" from my cart`)
                        }
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            <footer className="cart-sheet-foot">
              <div className="cart-total">
                <span className="t-sm t-secondary">Subtotal</span>
                <span className="t-num cart-total-value">
                  {cart.subtotal_display}
                </span>
              </div>
              <button
                className="btn btn-primary btn-lg btn-block"
                disabled={busy}
                onClick={() => onAsk("Check out")}
              >
                Check out
              </button>
              <p className="t-xs t-muted cart-fineprint">
                The total is calculated from live catalogue prices when you
                check out.
                {cart.brands.length > 1 &&
                  ` You are buying from ${cart.brands.length} brands, so that is ${cart.brands.length} separate orders, each paid to that brand.`}
              </p>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
