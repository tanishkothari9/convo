import { useEffect, useRef, useState } from 'react'

export interface MarqueeProduct {
  id: string
  name: string
  price_display: string
  image_url: string | null
  in_stock: boolean
}

/**
 * The brand's products, drifting, before anything is typed.
 *
 * A chat that opens empty asks the customer to guess what the shop sells. This
 * answers that in the first second, with the brand's real catalogue rather than
 * a stock illustration — so the page is already doing the shop's job before the
 * conversation starts.
 *
 * Two rows moving in opposite directions at slightly different speeds: one row
 * reads as a filmstrip, two read as a shop. The list is duplicated so the
 * translation can loop at exactly -50% with no visible seam.
 *
 * It pauses on hover, pauses when the tab is hidden, and does not move at all
 * under `prefers-reduced-motion` — where it becomes a plain grid, because the
 * products are the content and only the drifting is decoration.
 */
export function ProductMarquee({
  products,
  onPick,
}: {
  products: MarqueeProduct[]
  onPick(product: MarqueeProduct): void
}) {
  const [still, setStill] = useState(false)
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setStill(motion.matches)
    sync()
    motion.addEventListener('change', sync)
    return () => motion.removeEventListener('change', sync)
  }, [])

  // A tab in the background should not be animating; it costs battery and
  // buys nothing, since nobody is looking at it.
  useEffect(() => {
    const node = container.current
    if (!node) return
    const sync = () => {
      node.dataset.paused = document.hidden ? 'true' : 'false'
    }
    document.addEventListener('visibilitychange', sync)
    sync()
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])

  if (products.length === 0) return null

  // Below four products two rows would repeat visibly, so it becomes one.
  const rows = products.length >= 4
    ? [products.filter((_, i) => i % 2 === 0), products.filter((_, i) => i % 2 === 1)]
    : [products]

  if (still) {
    return (
      <div className="marquee marquee-still">
        {products.slice(0, 6).map((product) => (
          <MarqueeCard key={product.id} product={product} onPick={onPick} />
        ))}
      </div>
    )
  }

  return (
    <div className="marquee" ref={container}>
      {rows.map((row, index) => (
        <div className="marquee-row" key={index} data-direction={index % 2 === 0 ? 'left' : 'right'}>
          <div className="marquee-track" style={{ animationDuration: `${38 + index * 9}s` }}>
            {/* Duplicated so the loop closes on itself; the copy is hidden
                from assistive technology so nothing is announced twice. */}
            {[...row, ...row].map((product, i) => (
              <MarqueeCard
                key={`${product.id}-${i}`}
                product={product}
                onPick={onPick}
                duplicate={i >= row.length}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function MarqueeCard({
  product,
  onPick,
  duplicate,
}: {
  product: MarqueeProduct
  onPick(product: MarqueeProduct): void
  duplicate?: boolean
}) {
  return (
    <button
      type="button"
      className="marquee-card"
      onClick={() => onPick(product)}
      aria-hidden={duplicate ? true : undefined}
      tabIndex={duplicate ? -1 : undefined}
      title={`${product.name} · ${product.price_display}`}
    >
      <span className="marquee-art">
        {product.image_url ? <img src={product.image_url} alt="" loading="lazy" /> : null}
      </span>
      <span className="marquee-meta">
        <span className="marquee-name">{product.name}</span>
        <span className="marquee-price t-num">{product.price_display}</span>
      </span>
    </button>
  )
}
