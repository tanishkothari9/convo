import type { ProductCard } from '../types'

/**
 * Product cards.
 *
 * Every value on a card — name, price, image, stock — is joined from the
 * catalogue on the server before the payload reaches this component. The model
 * chose which products to show and wrote the one-line reason; it supplied none
 * of the figures.
 */
export function ProductCards({
  title,
  layout,
  items,
  onAsk,
  disabled,
}: {
  title: string | null
  layout: string
  items: ProductCard[]
  onAsk(text: string): void
  disabled: boolean
}) {
  return (
    <div className="cards">
      {title && <p className="cards-title t-sm t-muted">{title}</p>}
      <div className={`cards-track cards-${layout}`}>
        {items.map((item, index) => (
          <article
            key={item.product_id}
            className="pcard"
            /* A short stagger so the set reads as arriving, not appearing. */
            style={{ animationDelay: `${Math.min(index, 5) * 45}ms` }}
          >
            <div className="pcard-image">
              {item.image_url ? (
                <img src={item.image_url} alt="" loading="lazy" />
              ) : (
                <span className="pcard-image-empty" aria-hidden="true" />
              )}
              {!item.in_stock && <span className="pcard-sold">Sold out</span>}
            </div>

            <div className="pcard-body">
              <p className="pcard-name">{item.name}</p>
              <p className="pcard-price t-num">{item.price_display}</p>
              {item.reason && <p className="pcard-reason t-sm">{item.reason}</p>}
              {!item.reason && item.description && (
                <p className="pcard-reason t-sm t-secondary">{truncate(item.description, 92)}</p>
              )}
            </div>

            <button
              className="btn btn-primary btn-sm pcard-add"
              disabled={disabled || !item.in_stock}
              onClick={() => onAsk(`Add "${item.name}" to my cart`)}
            >
              {item.in_stock ? 'Add to cart' : 'Sold out'}
            </button>
          </article>
        ))}
      </div>
    </div>
  )
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}
