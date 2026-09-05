import { useEffect, useRef } from "react";

/**
 * One stall, with nothing on the table.
 *
 * The empty catalogue screen is the one place in the dashboard where a picture
 * is the content rather than decoration: there is genuinely nothing to show, and
 * the screen's whole job is to say what belongs here and get the brand to put it
 * there. So this is the same market the shop opens onto — the same palette, the
 * same four-pixel grid — cropped to a single pitch with the awning up, the table
 * bare and the goods conspicuously missing. It is the brand's own stall, waiting.
 *
 * Drawn as an object, not a landscape — no sky, no horizon, nothing behind it
 * but the panel. The street on the shop side can afford a scene because it runs
 * the full width of the page and has somewhere to fade into; the same treatment
 * inside a dashboard panel is a rectangle of blue with a stall in it, which is
 * a sticker no matter how softly its edges are handled. Transparent ground and
 * a shadow is the whole trick.
 */

const PIXEL = 4;
const W = 54;
const H = 38;
const GROUND = 31;

const P = {
  canopy: "#2f5a49",
  postDark: "#6b5942",
  table: "#c9b596",
  tableDark: "#9c8a6e",
  cream: "#f2e7d0",
  stripe: "#c25539",
  shadow: "#d9d6cb",
  grass: "#679c48",
  grassSun: "#84b747",
} as const;

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function paint(canvas: HTMLCanvasElement) {
  const c = canvas.getContext("2d");
  if (!c) return;
  canvas.width = W;
  canvas.height = H;
  c.clearRect(0, 0, W, H);
  c.imageSmoothingEnabled = false;
  const px = (x: number, y: number, fill: string, dw = 1, dh = 1) => {
    c.fillStyle = fill;
    c.fillRect(x, y, dw, dh);
  };

  const sx = 10;
  const sw = 32;
  const roof = 6;
  const deck = GROUND - 8;

  /* The shadow the stall stands on. Dithered rather than solid, so it reads as
     shade on the panel instead of a grey shape lying under the drawing. */
  const mid = sx + sw / 2;
  for (let y = GROUND; y < GROUND + 3; y += 1) {
    const half = Math.round(
      (sw / 2 + 1) * Math.sqrt(Math.max(0, 1 - ((y - GROUND) / 3) ** 2)),
    );
    for (let x = mid - half; x < mid + half; x += 1) {
      // Dense under the middle of the stall, thinning to nothing at the rim —
      // a flat scatter at one density reads as grit dropped round the legs.
      const d = Math.abs(x - mid) / Math.max(1, half);
      if (1 - d * d > BAYER[(y % 4) * 4 + (Math.floor(x) % 4)]! / 16)
        px(Math.floor(x), y, P.shadow);
    }
  }

  // Grass at the foot of the posts — enough to say ground, not enough to be a field.
  for (const gx of [sx, sx + 5, sx + sw - 6, sx + sw - 1]) {
    px(gx, GROUND - 2, P.grass, 1, 2);
    px(gx + 1, GROUND - 1, P.grassSun, 1, 1);
  }

  // Posts.
  px(sx + 2, roof + 6, P.postDark, 2, GROUND - roof - 6);
  px(sx + sw - 4, roof + 6, P.postDark, 2, GROUND - roof - 6);

  // The table, with nothing on it. That emptiness is the message.
  px(sx + 3, deck, P.tableDark, sw - 6, GROUND - deck);
  px(sx + 3, deck, P.table, sw - 6, 2);
  px(sx + 4, deck + 3, P.table, sw - 8, 1); // a cross-brace, so it is a trestle

  // Awning: stripes, an overhanging lip, a scalloped fringe.
  for (let i = 0; i < 5; i += 1)
    px(sx - 1, roof + i, i % 2 === 0 ? P.stripe : P.cream, sw + 2, 1);
  px(sx - 2, roof + 5, P.cream, sw + 4, 1);
  for (let fx = sx - 2; fx < sx + sw + 2; fx += 3)
    px(fx, roof + 6, P.stripe, 2, 1);

  // A bird on the ridge. Nobody is buying anything today.
  px(sx + 24, roof - 2, P.canopy, 2, 2);
  px(sx + 26, roof - 3, P.canopy);
}

export function PixelStall() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) paint(ref.current);
  }, []);
  return (
    <canvas
      ref={ref}
      className="pixel-stall"
      style={{ width: W * PIXEL, height: H * PIXEL }}
      aria-hidden="true"
    />
  );
}
