import { useEffect, useRef, useState } from "react";

export interface MarqueeProduct {
  id: string;
  name: string;
  brand_name: string;
  price_display: string;
  image_url: string | null;
  in_stock: boolean;
}

/**
 * The shelf, drifting, before anything is typed.
 *
 * A chat that opens empty asks the customer to guess what is for sale. This
 * answers it in the first second with real catalogue photography rather than a
 * stock illustration, so the page is already doing the shop's job before the
 * conversation starts.
 *
 * One row of tall cards rather than two rows of small ones. The goods here are
 * sarees, lehengas and silver — vertical things, photographed as vertical
 * things — and a 44px thumbnail crops a handwoven border down to a smudge. Six
 * large photographs moving past reads as a shop window; twelve small ones read
 * as a contact sheet. The list is duplicated so the translation can loop at
 * exactly -50% with no visible seam.
 *
 * It pauses on hover, pauses when the tab is hidden, and stops entirely under
 * `prefers-reduced-motion`, where the same row becomes something the customer
 * scrolls themselves — the products are the content, and only the drifting is
 * decoration.
 */
export function ProductMarquee({
  products,
  onPick,
}: {
  products: MarqueeProduct[];
  onPick(product: MarqueeProduct): void;
}) {
  const [still, setStill] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setStill(motion.matches);
    sync();
    motion.addEventListener("change", sync);
    return () => motion.removeEventListener("change", sync);
  }, []);

  // A tab in the background should not be animating; it costs battery and
  // buys nothing, since nobody is looking at it.
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const sync = () => {
      node.dataset.paused = document.hidden ? "true" : "false";
    };
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  if (products.length === 0) return null;

  // Still: the real list once, scrolled by hand. Moving: twice, so -50% lands
  // exactly one copy along and the loop closes on itself.
  const rail = still ? products : [...products, ...products];

  return (
    <div
      className={still ? "marquee marquee-still" : "marquee"}
      ref={container}
    >
      <div className="marquee-row">
        <div className="marquee-track">
          {rail.map((product, index) => (
            <MarqueeCard
              key={`${product.id}-${index}`}
              product={product}
              onPick={onPick}
              duplicate={!still && index >= products.length}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function MarqueeCard({
  product,
  onPick,
  duplicate,
}: {
  product: MarqueeProduct;
  onPick(product: MarqueeProduct): void;
  /** The second copy exists to close the loop; screen readers skip it. */
  duplicate?: boolean;
}) {
  return (
    <button
      type="button"
      className="marquee-card"
      onClick={() => onPick(product)}
      aria-hidden={duplicate ? true : undefined}
      tabIndex={duplicate ? -1 : undefined}
      aria-label={`${product.name} from ${product.brand_name}, ${product.price_display}`}
    >
      <span className="marquee-art">
        {product.image_url ? (
          <img src={product.image_url} alt="" loading="lazy" />
        ) : (
          <span className="marquee-art-blank" aria-hidden="true">
            {product.brand_name.slice(0, 1)}
          </span>
        )}
      </span>
      {/* Merchant photography is whatever the merchant uploaded, so the text
          brings its own darkness rather than trusting the image to be dark. */}
      <span className="marquee-scrim" aria-hidden="true" />
      <span className="marquee-meta">
        <span className="marquee-brand">{product.brand_name}</span>
        <span className="marquee-name">{product.name}</span>
        <span className="marquee-price t-num">{product.price_display}</span>
      </span>
    </button>
  );
}
