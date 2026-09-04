import type { CartPayload } from '../types'

/** The cart as an inline card, when the agent chose to show it in the reply. */
export function CartCard({ cart, onAsk, disabled }: { cart: CartPayload; onAsk(text: string): void; disabled: boolean }) {
  if (cart.lines.length === 0) return null

  return (
    <div className="cart-card">
      <ul className="cart-lines">
        {cart.lines.map((line) => (
          <li key={line.product_id} className="cart-line">
            <div className="cart-thumb">
              {line.image_url ? <img src={line.image_url} alt="" loading="lazy" /> : null}
            </div>
            <div className="cart-line-main">
              <p className="cart-line-name">{line.name}</p>
              <p className="t-sm t-muted t-num">
                {line.quantity} × {line.unit_price_display}
                {!line.in_stock && (
                  <span className="cart-line-flag">
                    {line.available_stock === 0 ? ' · out of stock' : ` · only ${line.available_stock} left`}
                  </span>
                )}
              </p>
            </div>
            <p className="cart-line-total t-num">{line.line_total_display}</p>
          </li>
        ))}
      </ul>

      <div className="cart-total">
        <span className="t-sm t-secondary">Subtotal</span>
        <span className="t-num cart-total-value">{cart.subtotal_display}</span>
      </div>

      <button
        className="btn btn-primary btn-block"
        disabled={disabled}
        onClick={() => onAsk('Check out')}
      >
        Check out
      </button>
    </div>
  )
}
